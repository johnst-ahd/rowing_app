import * as motionPkg from '@rowing/motion-analysis';
import type { DerivedSample } from '@rowing/telemetry-types';

type MotionAnalyzerInstance = InstanceType<typeof motionPkg.MotionAnalyzer>;

export function createMotionAnalyzer(): MotionAnalyzerInstance {
  return new motionPkg.MotionAnalyzer();
}

export function triggerCapsizeAlert(): void {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate([400, 150, 400, 150, 400, 150, 600]);
  }
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      void ctx.close();
    }, 1200);
  } catch {
    /* optional */
  }
}

export type RowingMetrics = DerivedSample & {
  calibrated: boolean;
};

export function metricsFromAnalyzer(analyzer: MotionAnalyzerInstance): RowingMetrics {
  const m = analyzer.getMetrics();
  return {
    strokeRate: m.strokeRate ?? undefined,
    capsize: m.capsize || undefined,
    tiltDeg: m.tiltDeg ?? undefined,
    calibrated: m.calibrated,
  };
}
