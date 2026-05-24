export declare class MotionAnalyzer {
  constructor(opts?: Record<string, unknown>);
  reset(): void;
  process(t: number, ax: number, ay: number, az: number): void;
  getMetrics(): {
    strokeRate: number | null;
    capsize: boolean;
    tiltDeg: number | null;
    calibrated: boolean;
  };
}

export function analyzeMotionWindow(
  samples: { t: number; motion?: { ax: number; ay: number; az: number } }[],
): {
  strokeRate: number | null;
  capsize: boolean;
  tiltDeg: number | null;
  calibrated: boolean;
};

export const MIN_SPM: number;
export const MAX_SPM: number;
