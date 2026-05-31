import type {
  MotionSample,
  RecorderSettings,
  SessionMeta,
  TelemetrySample,
} from '@rowing/telemetry-types';
import {
  connectHeartRate,
  kickNativeAccelerometer,
  pollNativeAccelerometerReading,
  startGpsWatcher,
  startMotionWatcher,
  type HeartRateMonitor,
} from '@rowing/sensor-adapters';
import type { MotionReading } from '@rowing/sensor-adapters/types';
import {
  clearCapsizeAlertNotification,
  ensureCapsizeAlertReady,
  showCapsizeAlertNotification,
} from '../lib/capsize-notification';
import {
  getNativeRecordingPulse,
  setNativeEconomyMode,
  startNativeCapsizeMonitor,
  stopNativeCapsizeMonitor,
  syncNativeCapsizeUpright,
} from '../lib/native-capsize-monitor';
import { findBoatParkAt, type GeofenceConfig } from '../lib/geofence';
import { fetchGeofences } from '../lib/geofence-service';
import {
  createMotionAnalyzer,
  metricsFromAnalyzer,
  triggerCapsizeAlert,
} from '../sensors/motion-analysis';
import { countPendingOutbox, enqueueTelemetry, saveSession } from './store';

export type RecorderStats = {
  gpsCount: number;
  motionCount: number;
  hrCount: number;
  lastHr?: number;
  lastGps?: { t: number; lat: number; lon: number; spd?: number };
  /** Latest GPS speed (m/s) for pace display. */
  speedMps?: number;
  pendingOutbox: number;
  strokeRate?: number;
  tiltDeg?: number;
  capsize?: boolean;
  motionCalibrated?: boolean;
  /** True when inside a dashboard boat-park geofence. */
  inBoatPark?: boolean;
  /** Name of matched boat-park zone, if any. */
  boatParkName?: string | null;
};

export type RecorderController = {
  sessionId: string;
  stop: () => Promise<void>;
  getStats: () => RecorderStats;
  flush: () => Promise<void>;
  connectHr: () => Promise<void>;
};

export type RecorderHooks = {
  /** Throttled while screen off — flush queue + upload. */
  onBackgroundPulse?: () => void;
};

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';
const BG_UPLOAD_PULSE_MS = 12_000;

/** Cap in-memory batch before enqueue (avoids huge JSON + IDB stalls). */
const MAX_BATCH_SAMPLES = 40;
/** With GPS + motion, only GPS rows are queued — ~1 Hz × batch window. */
const MAX_BATCH_SAMPLES_GPS_AND_MOTION = 20;

function roundMotion(m: MotionSample): MotionSample {
  return {
    ax: Math.round(m.ax * 100) / 100,
    ay: Math.round(m.ay * 100) / 100,
    az: Math.round(m.az * 100) / 100,
  };
}

function telemetrySample(
  t: number,
  parts: Pick<TelemetrySample, 'gps' | 'motion' | 'hr' | 'derived'>,
): TelemetrySample {
  const sample: TelemetrySample = { t };
  if (parts.gps) sample.gps = parts.gps;
  if (parts.motion) sample.motion = roundMotion(parts.motion);
  if (parts.hr) sample.hr = parts.hr;
  if (parts.derived) sample.derived = parts.derived;
  return sample;
}

export async function startRecorder(
  settings: RecorderSettings,
  onStats: (s: RecorderStats) => void,
  onLog: (msg: string) => void,
  onPendingChange: (n: number) => void,
  onCapsize?: (active: boolean) => void,
  hooks?: RecorderHooks,
): Promise<RecorderController | null> {
  if (!settings.deviceId.trim()) {
    onLog('Set a Device ID in Settings before recording.');
    return null;
  }

  const sessionId = newSessionId();
  const meta: SessionMeta = {
    sessionId,
    deviceId: settings.deviceId,
    athleteId: settings.athleteId,
    startedAt: Date.now(),
  };
  await saveSession(meta);

  const stats: RecorderStats = {
    gpsCount: 0,
    motionCount: 0,
    hrCount: 0,
    pendingOutbox: 0,
  };

  let latestHr: TelemetrySample['hr'];
  let latestMotion: TelemetrySample['motion'];
  let latestDerived: TelemetrySample['derived'];
  const batch: TelemetrySample[] = [];
  let batchTimer: ReturnType<typeof setInterval> | null = null;
  let motionAnalyzer: ReturnType<typeof createMotionAnalyzer> | null = null;
  let capsizeActive = false;
  let pushInFlight = false;
  let lastMotionUploadAt = 0;
  let lastBackgroundPulseAt = 0;
  let bgMotionPollTimer: ReturnType<typeof setInterval> | null = null;
  let nativeCapsizeMonitorOn = false;
  let motionWasCalibrated = false;

  const motionUploadMs = Math.max(
    200,
    settings.motionUploadIntervalMs ?? 500,
  );
  const batchCap =
    settings.enableMotion && settings.enableGps
      ? MAX_BATCH_SAMPLES_GPS_AND_MOTION
      : settings.enableMotion
        ? Math.min(
            MAX_BATCH_SAMPLES,
            Math.ceil(
              Math.max(settings.uploadBatchMs, 8000) / motionUploadMs,
            ) + 4,
          )
        : MAX_BATCH_SAMPLES;
  const batchIntervalMs = settings.enableMotion
    ? Math.max(settings.uploadBatchMs, 8000)
    : settings.uploadBatchMs;

  let geofences: GeofenceConfig[] = [];
  let inBoatPark = false;
  let activeBoatPark: GeofenceConfig | null = null;
  let capsizeAllowed = true;
  let effectiveGpsIntervalMs = settings.gpsIntervalMs;
  let effectiveUploadIntervalMs = batchIntervalMs;
  let lastGpsQueuedAt = 0;
  let geofenceRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const applyEconomyMode = (match: GeofenceConfig | null) => {
    const was = inBoatPark;
    inBoatPark = match != null;
    activeBoatPark = match;
    if (match) {
      effectiveGpsIntervalMs = Math.max(5000, match.economyGpsIntervalSec * 1000);
      effectiveUploadIntervalMs = Math.max(5000, match.economyUploadIntervalSec * 1000);
      capsizeAllowed = !match.disableCapsize;
    } else {
      effectiveGpsIntervalMs = settings.gpsIntervalMs;
      effectiveUploadIntervalMs = batchIntervalMs;
      capsizeAllowed = true;
    }
    if (was !== inBoatPark) {
      onLog(
        inBoatPark
          ? `Boat park (${match!.name}): reduced GPS/data${capsizeAllowed ? '' : ', capsize off'}.`
          : 'Left boat park — full recording restored.',
      );
      if (nativeCapsizeMonitorOn) {
        void setNativeEconomyMode({
          active: inBoatPark,
          gpsIntervalMs: effectiveGpsIntervalMs,
          uploadIntervalMs: effectiveUploadIntervalMs,
          enableCapsize: capsizeAllowed,
        });
      }
      if (!capsizeAllowed && capsizeActive) {
        capsizeActive = false;
        if (IS_NATIVE) void clearCapsizeAlertNotification();
        onCapsize?.(false);
      }
    }
    emit();
  };

  const checkGeofenceAt = (lat: number, lon: number) => {
    if (!geofences.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    applyEconomyMode(findBoatParkAt(lat, lon, geofences));
  };

  void fetchGeofences(settings.ingestUrl, settings.ingestToken).then((list) => {
    geofences = list;
    if (list.length) onLog(`${list.length} geofence(s) loaded from dashboard.`);
  });

  const stoppers: Array<() => void | Promise<void>> = [];
  let hrMonitor: HeartRateMonitor | null = null;
  let stopped = false;

  geofenceRefreshTimer = setInterval(() => {
    void fetchGeofences(settings.ingestUrl, settings.ingestToken, true).then((list) => {
      geofences = list;
    });
  }, 5 * 60 * 1000);
  stoppers.push(() => {
    if (geofenceRefreshTimer) clearInterval(geofenceRefreshTimer);
  });

  const emit = () => onStats({ ...stats });

  const pushBatch = async () => {
    if (batch.length === 0 || pushInFlight) return;
    pushInFlight = true;
    try {
      const slice = batch.splice(0, batch.length);
      await enqueueTelemetry(sessionId, slice);
      stats.pendingOutbox = await countPendingOutbox();
      onPendingChange(stats.pendingOutbox);
      emit();
    } finally {
      pushInFlight = false;
    }
  };

  const pulseBackgroundUpload = () => {
    if (
      !IS_NATIVE ||
      typeof document === 'undefined' ||
      document.visibilityState !== 'hidden'
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastBackgroundPulseAt < BG_UPLOAD_PULSE_MS) return;
    lastBackgroundPulseAt = now;
    void pushBatch();
    hooks?.onBackgroundPulse?.();
  };

  const queueSample = (sample: TelemetrySample) => {
    batch.push(sample);
    const cap =
      inBoatPark && effectiveUploadIntervalMs > settings.uploadBatchMs
        ? Math.max(2, Math.ceil(effectiveUploadIntervalMs / 3000))
        : batchCap;
    if (batch.length >= cap) void pushBatch();
    else pulseBackgroundUpload();
  };

  const queueGpsSample = (sample: TelemetrySample) => {
    const now = Date.now();
    if (inBoatPark && now - lastGpsQueuedAt < effectiveGpsIntervalMs) return;
    lastGpsQueuedAt = now;
    if (inBoatPark) {
      sample.derived = { ...sample.derived, inBoatPark: true };
    }
    queueSample(sample);
  };

  batchTimer = setInterval(() => void pushBatch(), batchIntervalMs);

  if (IS_NATIVE && (settings.enableGps || settings.enableMotion)) {
    const started = await startNativeCapsizeMonitor({
      sessionId,
      deviceId: settings.deviceId,
      ingestUrl: settings.ingestUrl,
      ingestToken: settings.ingestToken,
      athleteId: settings.athleteId,
      enableGps: settings.enableGps,
      enableMotion: settings.enableMotion,
      gpsIntervalMs: settings.gpsIntervalMs,
    });
    nativeCapsizeMonitorOn = started;
    if (started) {
      if (settings.enableGps) {
        onLog(
          'Native GPS on — posts to dashboard with screen off (Android foreground service).',
        );
      }
      if (settings.enableMotion) {
        onLog('Native capsize on — accelerometer runs outside the WebView.');
      }
    } else {
      onLog(
        'Native session service failed — allow notifications, location Always, and retry.',
      );
    }
  }

  const pollMotionWhileBackgrounded = () => {
    if (stopped || !motionAnalyzer || !IS_NATIVE) return;
    void pollNativeAccelerometerReading().then((reading) => {
      if (reading) handleMotionReading(reading);
    });
  };

  const handleMotionReading = (r: MotionReading) => {
    if (stopped || !motionAnalyzer) return;
    stats.motionCount++;
    latestMotion = { ax: r.ax, ay: r.ay, az: r.az };
    motionAnalyzer.process(r.t, r.ax, r.ay, r.az);
    const metrics = metricsFromAnalyzer(motionAnalyzer);
    stats.strokeRate = metrics.strokeRate;
    stats.tiltDeg = metrics.tiltDeg;
    stats.capsize = metrics.capsize;
    stats.motionCalibrated = metrics.calibrated;

    if (
      metrics.calibrated &&
      !motionWasCalibrated &&
      nativeCapsizeMonitorOn &&
      motionAnalyzer
    ) {
      motionWasCalibrated = true;
      const grav = motionAnalyzer as typeof motionAnalyzer & {
        gx: number;
        gy: number;
        gz: number;
      };
      void syncNativeCapsizeUpright(grav.gx, grav.gy, grav.gz);
    }

    latestDerived = {
      strokeRate: metrics.strokeRate,
      capsize: metrics.capsize,
      tiltDeg: metrics.tiltDeg,
    };

    const backgrounded =
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    if (capsizeAllowed && metrics.capsize && !capsizeActive) {
      capsizeActive = true;
      triggerCapsizeAlert();
      if (IS_NATIVE) void showCapsizeAlertNotification(true);
      queueSample(
        telemetrySample(r.t, {
          motion: latestMotion,
          hr: latestHr,
          derived: latestDerived,
        }),
      );
      void pushBatch();
      onLog('CAPSIZE ALERT — boat tipped past horizontal');
      onCapsize?.(true);
    } else if (capsizeAllowed && metrics.capsize && capsizeActive && backgrounded && IS_NATIVE) {
      void showCapsizeAlertNotification();
    } else if (!metrics.capsize && capsizeActive) {
      capsizeActive = false;
      if (IS_NATIVE) void clearCapsizeAlertNotification();
      onLog('Capsize cleared — boat upright again');
      onCapsize?.(false);
    }

    if (!settings.enableGps) {
      const now = Date.now();
      if (now - lastMotionUploadAt >= motionUploadMs) {
        lastMotionUploadAt = now;
        queueSample(
          telemetrySample(r.t, {
            motion: latestMotion,
            hr: latestHr,
            derived: latestDerived,
          }),
        );
      }
    }
    emit();
  };

  if (settings.enableMotion) {
    if (IS_NATIVE) {
      void ensureCapsizeAlertReady().then((ok) => {
        if (ok) onLog('Capsize alerts: phone notifications enabled (screen off / minimized).');
        else onLog('Allow notifications for capsize alarms when the screen is off.');
      });
    }
    motionAnalyzer = createMotionAnalyzer();

    const handleMotionFromStream = (r: MotionReading) => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      handleMotionReading(r);
    };

    const syncBackgroundMotionPoll = () => {
      if (bgMotionPollTimer) {
        clearInterval(bgMotionPollTimer);
        bgMotionPollTimer = null;
      }
      if (
        stopped ||
        !IS_NATIVE ||
        typeof document === 'undefined' ||
        document.visibilityState !== 'hidden'
      ) {
        return;
      }
      void kickNativeAccelerometer();
      const pollMs = Math.max(200, settings.motionIntervalMs);
      bgMotionPollTimer = setInterval(pollMotionWhileBackgrounded, pollMs);
      pollMotionWhileBackgrounded();
      onLog(`Screen off — capsize uses accelerometer poll every ${pollMs}ms`);
    };

    const onVisibilityForMotion = () => {
      if (document.visibilityState === 'hidden') {
        syncBackgroundMotionPoll();
      } else if (bgMotionPollTimer) {
        clearInterval(bgMotionPollTimer);
        bgMotionPollTimer = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibilityForMotion);
    stoppers.push(() => {
      document.removeEventListener('visibilitychange', onVisibilityForMotion);
      if (bgMotionPollTimer) clearInterval(bgMotionPollTimer);
      bgMotionPollTimer = null;
    });
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      syncBackgroundMotionPoll();
    }

    const motion = await startMotionWatcher(
      handleMotionFromStream,
      settings.motionIntervalMs,
      (m) => onLog(`Motion: ${m}`),
      { enableBackground: IS_NATIVE },
    );
    stoppers.push(async () => {
      await Promise.resolve(motion.stop());
    });
  }

  if (settings.enableGps) {
    if (IS_NATIVE && nativeCapsizeMonitorOn) {
      // Native foreground service owns motion/GPS ingest — avoid duplicate WebView uploads.
      const pulseMs = Math.max(500, settings.gpsIntervalMs);
      const nativeGpsUiTimer = setInterval(() => {
        if (stopped) return;
        void getNativeRecordingPulse().then((pulse) => {
          if (!pulse?.lastGps) return;
          const g = pulse.lastGps;
          checkGeofenceAt(g.lat, g.lon);
          if (pulse.nativeGpsCount != null) {
            stats.gpsCount = pulse.nativeGpsCount;
          }
          stats.lastGps = {
            t: g.t,
            lat: g.lat,
            lon: g.lon,
            spd: g.spd,
          };
          if (g.spd != null && g.spd >= 0) stats.speedMps = g.spd;
          emit();
        });
      }, pulseMs);
      stoppers.push(() => clearInterval(nativeGpsUiTimer));
    } else {
      const gps = startGpsWatcher(
        (r) => {
          if (stopped) return;
          stats.gpsCount++;
          stats.lastGps = { t: r.t, lat: r.lat, lon: r.lon, spd: r.spd };
          if (r.spd != null && r.spd >= 0) stats.speedMps = r.spd;
          checkGeofenceAt(r.lat, r.lon);

          if (
            IS_NATIVE &&
            settings.enableMotion &&
            motionAnalyzer &&
            typeof document !== 'undefined' &&
            document.visibilityState === 'hidden'
          ) {
            pollMotionWhileBackgrounded();
          }

          queueGpsSample(
            telemetrySample(r.t, {
              gps: {
                lat: r.lat,
                lon: r.lon,
                acc: r.acc,
                spd: r.spd,
                hdg: r.hdg,
                alt: r.alt,
              },
              hr: latestHr,
              motion: latestMotion,
              derived: latestDerived,
            }),
          );
          emit();
        },
        settings.gpsIntervalMs,
        (m) => onLog(`GPS: ${m}`),
        {
          enableBackground: IS_NATIVE || settings.enableBackgroundRecording,
        },
      );
      stoppers.push(async () => {
        await Promise.resolve(gps.stop());
      });
    }
  }

  emit();
  onLog(`Session started: ${sessionId.slice(0, 8)}…`);
  if (settings.enableMotion) {
    onLog('Hold boat steady for ~2s at start to calibrate upright orientation.');
    if (settings.enableGps) {
      onLog(
        'Motion: fast analysis on device; uploads ride on GPS (~1/s) to keep queue small.',
      );
    } else {
      onLog(`Motion uploads throttled to ~${Math.round(1000 / motionUploadMs)}/s.`);
    }
    if (IS_NATIVE && settings.enableGps && !nativeCapsizeMonitorOn) {
      onLog(
        'Screen off: capsize polled on GPS + timer (hold boat still ~3s at start to calibrate).',
      );
    }
  }

  if (IS_NATIVE && (settings.enableGps || settings.enableMotion)) {
    onLog(
      'For screen-off recording: Location → Always, Notifications on, Battery → Unrestricted.',
    );
  }

  return {
    sessionId,
    getStats: () => ({
      ...stats,
      inBoatPark,
      boatParkName: activeBoatPark?.name ?? null,
    }),
    flush: () => pushBatch(),
    async connectHr() {
      if (!settings.enableHr) return;
      if (hrMonitor) await hrMonitor.disconnect();
      hrMonitor = await connectHeartRate(
        (r) => {
          if (stopped) return;
          stats.hrCount++;
          stats.lastHr = r.bpm;
          latestHr = { bpm: r.bpm, contact: r.contact };
          if (!settings.enableGps) {
            queueSample(
              telemetrySample(r.t, {
                hr: latestHr,
                motion: latestMotion,
                derived: latestDerived,
              }),
            );
          }
          emit();
        },
        (m) => onLog(`HR: ${m}`),
      );
      if (hrMonitor) onLog(`Connected: ${hrMonitor.name}`);
    },
    async stop() {
      stopped = true;
      if (nativeCapsizeMonitorOn) {
        await stopNativeCapsizeMonitor();
        nativeCapsizeMonitorOn = false;
      }
      if (batchTimer) clearInterval(batchTimer);
      await pushBatch();
      for (const s of stoppers) await s();
      if (hrMonitor) await hrMonitor.disconnect();
      meta.endedAt = Date.now();
      await saveSession(meta);
      onLog('Session stopped.');
    },
  };
}

function newSessionId(): string {
  return crypto.randomUUID();
}
