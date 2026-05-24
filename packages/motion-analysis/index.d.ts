export declare const MotionAnalyzer: new (opts?: Record<string, unknown>) => {
  reset(): void;
  process(t: number, ax: number, ay: number, az: number): void;
  getMetrics(): {
    strokeRate: number | null;
    capsize: boolean;
    tiltDeg: number | null;
    calibrated: boolean;
  };
};

declare const motionAnalysis: {
  MotionAnalyzer: typeof MotionAnalyzer;
  analyzeMotionWindow: (
    samples: { t: number; motion?: { ax: number; ay: number; az: number } }[],
  ) => {
    strokeRate: number | null;
    capsize: boolean;
    tiltDeg: number | null;
    calibrated: boolean;
  };
  MIN_SPM: number;
  MAX_SPM: number;
};

export default motionAnalysis;
