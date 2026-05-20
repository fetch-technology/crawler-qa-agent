-- CreateTable
CREATE TABLE "test_runs" (
    "id" TEXT NOT NULL,
    "game_code" TEXT NOT NULL,
    "url" TEXT,
    "status" TEXT NOT NULL,
    "total_spins" INTEGER NOT NULL DEFAULT 0,
    "completed_spins" INTEGER NOT NULL DEFAULT 0,
    "bet_per_line" DOUBLE PRECISION,
    "lines" INTEGER,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary_md" TEXT,

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spin_results" (
    "id" TEXT NOT NULL,
    "test_run_id" TEXT NOT NULL,
    "round_index" INTEGER NOT NULL,
    "counter" INTEGER,
    "game_code" TEXT NOT NULL,
    "bet_per_line" DOUBLE PRECISION,
    "lines" INTEGER,
    "total_bet" DOUBLE PRECISION NOT NULL,
    "server_win" DOUBLE PRECISION,
    "total_win" DOUBLE PRECISION NOT NULL,
    "balance_before" DOUBLE PRECISION,
    "balance_after" DOUBLE PRECISION NOT NULL,
    "symbols" TEXT,
    "reels_json" TEXT,
    "raw_request" TEXT,
    "raw_response" TEXT,
    "is_free_spin" BOOLEAN NOT NULL DEFAULT false,
    "has_bonus" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spin_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_errors" (
    "id" TEXT NOT NULL,
    "test_run_id" TEXT NOT NULL,
    "spin_result_id" TEXT,
    "error_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'error',
    "expected_value" TEXT,
    "actual_value" TEXT,
    "message" TEXT NOT NULL,
    "screenshot_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stat_reports" (
    "id" TEXT NOT NULL,
    "test_run_id" TEXT NOT NULL,
    "total_spins" INTEGER NOT NULL,
    "total_bet" DOUBLE PRECISION NOT NULL,
    "total_win" DOUBLE PRECISION NOT NULL,
    "rtp" DOUBLE PRECISION,
    "hit_rate" DOUBLE PRECISION,
    "max_win" DOUBLE PRECISION,
    "average_win" DOUBLE PRECISION,
    "volatility" DOUBLE PRECISION,
    "volatility_band" TEXT,
    "rtp_confidence_95" DOUBLE PRECISION,
    "metrics_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stat_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_runs_game_code_created_at_idx" ON "test_runs"("game_code", "created_at");

-- CreateIndex
CREATE INDEX "test_runs_status_idx" ON "test_runs"("status");

-- CreateIndex
CREATE INDEX "spin_results_test_run_id_round_index_idx" ON "spin_results"("test_run_id", "round_index");

-- CreateIndex
CREATE INDEX "validation_errors_test_run_id_error_type_idx" ON "validation_errors"("test_run_id", "error_type");

-- CreateIndex
CREATE UNIQUE INDEX "stat_reports_test_run_id_key" ON "stat_reports"("test_run_id");

-- AddForeignKey
ALTER TABLE "spin_results" ADD CONSTRAINT "spin_results_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_errors" ADD CONSTRAINT "validation_errors_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_errors" ADD CONSTRAINT "validation_errors_spin_result_id_fkey" FOREIGN KEY ("spin_result_id") REFERENCES "spin_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stat_reports" ADD CONSTRAINT "stat_reports_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
