export { appendHistory, loadHistory, recentHistory } from "./store.js";
export { detectFlaky, maybePromoteToFlaky } from "./flaky-detector.js";
export { computeStats, flakyTier } from "./stats.js";
export type { HistoryEntry } from "./types.js";
export type { FlakyVerdict } from "./flaky-detector.js";
export type { CaseStats } from "./stats.js";
export { MAX_HISTORY_ENTRIES, FLAKY_WINDOW, FLAKY_MIN_HISTORY } from "./types.js";
