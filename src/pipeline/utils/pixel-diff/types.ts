export type Region = { x: number; y: number; width: number; height: number };

export type DiffOptions = {
  /** pixelmatch per-pixel threshold (0..1). Lower = stricter. Default 0.1. */
  pixelThreshold?: number;
};

export type DiffResult = {
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  ratio: number;
};

export type DetectOptions = DiffOptions & {
  region?: Region;
  /** Diff ratio above which the change is "significant". Default 0.05. */
  changeThreshold?: number;
};

export type StableOptions = DetectOptions & {
  intervalMs?: number;
  maxIterations?: number;
  /** Consecutive frames required to declare stable. Default 3. */
  consecutiveStable?: number;
};
