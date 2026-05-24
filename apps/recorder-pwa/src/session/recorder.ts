import type {
  RecorderSettings,
  SessionMeta,
  TelemetrySample,
} from '@rowing/telemetry-types';
import {
  connectHeartRate,
  startGpsWatcher,
  startMotionWatcher,
  type HeartRateMonitor,
} from '@rowing/sensor-adapters';
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
  lastGps?: { lat: number; lon: number };
  pendingOutbox: number;
  strokeRate?: number;
  tiltDeg?: number;
  capsize?: boolean;
  motionCalibrated?: boolean;
};

export type RecorderController = {
  sessionId: string;
  stop: () => Promise<void>;
  getStats: () => RecorderStats;
  flush: () => Promise<void>;
  connectHr: () => Promise<void>;
};

export async function startRecorder(
  settings: RecorderSettings,
  onStats: (s: RecorderStats) => void,
  onLog: (msg: string) => void,
  onPendingChange: (n: number) => void,
  onCapsize?: (active: boolean) => void,
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

  const stoppers: Array<() => void | Promise<void>> = [];
  let hrMonitor: HeartRateMonitor | null = null;
  let stopped = false;

  const emit = () => onStats({ ...stats });

  const pushBatch = async () => {
    if (batch.length === 0) return;
    const slice = batch.splice(0, batch.length);
    await enqueueTelemetry(sessionId, slice);
    stats.pendingOutbox = await countPendingOutbox();
    onPendingChange(pending);
    emit();
  };

  batchTimer = setInterval(() => void pushBatch(), settings.uploadBatchMs);

  if (settings.enableGps) {
    const gps = startGpsWatcher(
      (r) => {
        if (stopped) return;
        stats.gpsCount++;
        stats.lastGps = { lat: r.lat, lon: r.lon };
        batch.push({
          t: r.t,
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
        });
        emit();
      },
      settings.gpsIntervalMs,
      (m) => onLog(`GPS: ${m}`),
    );
    stoppers.push(async () => {
      await Promise.resolve(gps.stop());
    });
  }

  if (settings.enableMotion) {
    motionAnalyzer = createMotionAnalyzer();
    const motion = await startMotionWatcher(
      (r) => {
        if (stopped) return;
        stats.motionCount++;
        latestMotion = { ax: r.ax, ay: r.ay, az: r.az };
        motionAnalyzer!.process(r.t, r.ax, r.ay, r.az);
        const metrics = metricsFromAnalyzer(motionAnalyzer!);
        stats.strokeRate = metrics.strokeRate;
        stats.tiltDeg = metrics.tiltDeg;
        stats.capsize = metrics.capsize;
        stats.motionCalibrated = metrics.calibrated;

        latestDerived = {
          strokeRate: metrics.strokeRate,
          capsize: metrics.capsize,
          tiltDeg: metrics.tiltDeg,
        };

        if (metrics.capsize && !capsizeActive) {
          capsizeActive = true;
          triggerCapsizeAlert();
          onLog('CAPSIZE ALERT — boat tipped past horizontal');
          onCapsize?.(true);
        } else if (!metrics.capsize && capsizeActive) {
          capsizeActive = false;
          onLog('Capsize cleared — boat upright again');
          onCapsize?.(false);
        }

        batch.push({
          t: r.t,
          motion: latestMotion,
          hr: latestHr,
          derived: latestDerived,
        });
        emit();
      },
      settings.motionIntervalMs,
      (m) => onLog(`Motion: ${m}`),
    );
    stoppers.push(async () => {
      await Promise.resolve(motion.stop());
    });
  }

  emit();
  onLog(`Session started: ${sessionId.slice(0, 8)}…`);
  if (settings.enableMotion) {
    onLog('Hold boat steady for ~2s at start to calibrate upright orientation.');
  }

  return {
    sessionId,
    getStats: () => ({ ...stats }),
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
          batch.push({ t: r.t, hr: latestHr, derived: latestDerived });
          emit();
        },
        (m) => onLog(`HR: ${m}`),
      );
      if (hrMonitor) onLog(`Connected: ${hrMonitor.name}`);
    },
    async stop() {
      stopped = true;
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
