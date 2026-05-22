import type {
  RecorderSettings,
  SessionMeta,
  TelemetrySample,
} from '@rowing/telemetry-types';
import { startGpsWatcher } from '../sensors/gps';
import {
  connectHeartRate,
  type HeartRateMonitor,
} from '../sensors/heart-rate';
import { startMotionWatcher } from '../sensors/motion';
import { buildOsmAndUrl, sendOsmAndPosition } from '../upload/traccar';
import {
  enqueueTelemetry,
  enqueueTraccar,
  saveSession,
} from './store';

export type RecorderStats = {
  gpsCount: number;
  motionCount: number;
  hrCount: number;
  lastHr?: number;
  lastGps?: { lat: number; lon: number };
  pendingOutbox: number;
};

export type RecorderController = {
  stop: () => Promise<void>;
  getStats: () => RecorderStats;
  flush: () => void;
  connectHr: () => Promise<void>;
};

export async function startRecorder(
  settings: RecorderSettings,
  onStats: (s: RecorderStats) => void,
  onLog: (msg: string) => void,
  onPendingChange: (n: number) => void,
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
  const batch: TelemetrySample[] = [];
  let batchTimer: ReturnType<typeof setInterval> | null = null;

  const stoppers: Array<() => void | Promise<void>> = [];
  let hrMonitor: HeartRateMonitor | null = null;
  let stopped = false;

  const emit = () => onStats({ ...stats });

  const pushBatch = async () => {
    if (batch.length === 0) return;
    const slice = batch.splice(0, batch.length);
    await enqueueTelemetry(sessionId, slice);
    stats.pendingOutbox += 1;
    onPendingChange(stats.pendingOutbox);
    emit();
  };

  batchTimer = setInterval(() => void pushBatch(), settings.uploadBatchMs);

  if (settings.enableGps) {
    const gps = startGpsWatcher(
      async (r) => {
        if (stopped) return;
        stats.gpsCount++;
        stats.lastGps = { lat: r.lat, lon: r.lon };
        const sample: TelemetrySample = {
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
        };
        batch.push(sample);

        if (settings.traccarUrl) {
          const url = buildOsmAndUrl(
            settings.traccarUrl,
            settings.deviceId,
            sample.gps!,
            r.t,
            { hr: latestHr, motion: latestMotion },
          );
          const ok = await sendOsmAndPosition(url);
          if (!ok) {
            await enqueueTraccar(sessionId, url);
            stats.pendingOutbox += 1;
            onPendingChange(stats.pendingOutbox);
          }
        }
        emit();
      },
      settings.gpsIntervalMs,
      (m) => onLog(`GPS: ${m}`),
    );
    stoppers.push(() => gps.stop());
  }

  if (settings.enableMotion) {
    const motion = await startMotionWatcher(
      (r) => {
        if (stopped) return;
        stats.motionCount++;
        latestMotion = { ax: r.ax, ay: r.ay, az: r.az };
        batch.push({ t: r.t, motion: latestMotion, hr: latestHr });
        emit();
      },
      settings.motionIntervalMs,
      (m) => onLog(`Motion: ${m}`),
    );
    stoppers.push(() => motion.stop());
  }

  emit();
  onLog(`Session started: ${sessionId.slice(0, 8)}…`);

  return {
    getStats: () => ({ ...stats }),
    flush: () => void pushBatch(),
    async connectHr() {
      if (!settings.enableHr) return;
      if (hrMonitor) await hrMonitor.disconnect();
      hrMonitor = await connectHeartRate(
        (r) => {
          if (stopped) return;
          stats.hrCount++;
          stats.lastHr = r.bpm;
          latestHr = { bpm: r.bpm, contact: r.contact };
          batch.push({ t: r.t, hr: latestHr });
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
