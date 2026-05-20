/**
 * DB layer barrel. All callers go through this.
 *
 * Env: DATABASE_URL gates all writes — if absent, every function no-ops and
 * filesystem persistence (fixtures/) remains the single source of truth.
 */

export { getDb, disconnectDb, isDbEnabled } from "./client.js";
export * from "./repositories/test-run.js";
export * from "./repositories/spin-result.js";
export * from "./repositories/validation-error.js";
export * from "./repositories/stat-report.js";
