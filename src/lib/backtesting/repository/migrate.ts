// ════════════════════════════════════════════════════════════════
//  Backtesting Engine — Full Database Schema (8 tables)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

let _migrated = false;

/** Ensure tables exist (idempotent, runs once per process) */
export async function ensureBacktestTables(): Promise<void> {
  if (_migrated) return;
  await migrateBacktestTables();
  _migrated = true;
}

export async function migrateBacktestTables(): Promise<void> {
  // 1. Backtest runs
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL UNIQUE,
      name            VARCHAR(255)  NOT NULL,
      description     TEXT,
      config_json     JSON          NOT NULL,
      status          VARCHAR(20)   NOT NULL DEFAULT 'queued',
      started_at      DATETIME      NOT NULL,
      completed_at    DATETIME      NULL,
      duration_ms     INT           NULL,
      error           TEXT          NULL,
      summary_json    JSON          NULL,
      strategy_breakdown_json JSON  NULL,
      regime_breakdown_json   JSON  NULL,
      signal_count    INT           DEFAULT 0,
      trade_count     INT           DEFAULT 0,
      created_by      VARCHAR(100)  NULL,
      tags_json       JSON          NULL,
      INDEX idx_br_status  (status),
      INDEX idx_br_started (started_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 2. Backtest signals
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_signals (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      signal_id       VARCHAR(64)   NOT NULL,
      symbol          VARCHAR(50)   NOT NULL,
      date            DATE          NOT NULL,
      bar_index       INT           NOT NULL,
      direction       VARCHAR(10)   NOT NULL,
      strategy        VARCHAR(50)   NOT NULL,
      regime          VARCHAR(30),
      confidence_score SMALLINT,
      confidence_band VARCHAR(30),
      risk_score      SMALLINT,
      sector          VARCHAR(50),
      entry_zone_low  DECIMAL(12,2),
      entry_zone_high DECIMAL(12,2),
      stop_loss       DECIMAL(12,2),
      target1         DECIMAL(12,2),
      target2         DECIMAL(12,2),
      target3         DECIMAL(12,2),
      risk_per_unit   DECIMAL(12,2),
      reward_risk     DECIMAL(6,2),
      status          VARCHAR(20)   DEFAULT 'pending',
      bars_waited     INT           DEFAULT 0,
      reasons_json    JSON,
      features_json   JSON,
      INDEX idx_bs_run    (run_id),
      INDEX idx_bs_symbol (symbol),
      INDEX idx_bs_strat  (strategy),
      INDEX idx_bs_date   (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 3. Backtest trades
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_trades (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      trade_id        VARCHAR(64)   NOT NULL,
      signal_id       VARCHAR(64),
      symbol          VARCHAR(50)   NOT NULL,
      sector          VARCHAR(50),
      direction       VARCHAR(10)   NOT NULL,
      strategy        VARCHAR(50)   NOT NULL,
      regime          VARCHAR(30),
      confidence_score SMALLINT,
      confidence_band VARCHAR(30),
      signal_date     DATE,
      entry_date      DATE,
      exit_date       DATE,
      bars_to_entry   INT DEFAULT 0,
      bars_in_trade   INT DEFAULT 0,
      entry_price     DECIMAL(12,2),
      exit_price      DECIMAL(12,2),
      stop_loss       DECIMAL(12,2),
      target1         DECIMAL(12,2),
      target2         DECIMAL(12,2),
      target3         DECIMAL(12,2),
      position_size   INT DEFAULT 0,
      position_value  DECIMAL(14,2) DEFAULT 0,
      risk_amount     DECIMAL(12,2) DEFAULT 0,
      slippage_cost   DECIMAL(10,2) DEFAULT 0,
      commission_cost DECIMAL(10,2) DEFAULT 0,
      gross_pnl       DECIMAL(14,2) DEFAULT 0,
      net_pnl         DECIMAL(14,2) DEFAULT 0,
      return_pct      DECIMAL(8,4)  DEFAULT 0,
      return_r        DECIMAL(8,4)  DEFAULT 0,
      outcome         VARCHAR(20),
      exit_reason     VARCHAR(30),
      mfe_pct         DECIMAL(8,4)  DEFAULT 0,
      mae_pct         DECIMAL(8,4)  DEFAULT 0,
      mfe_r           DECIMAL(8,4)  DEFAULT 0,
      mae_r           DECIMAL(8,4)  DEFAULT 0,
      target1_hit     TINYINT(1) DEFAULT 0,
      target2_hit     TINYINT(1) DEFAULT 0,
      target3_hit     TINYINT(1) DEFAULT 0,
      stop_hit        TINYINT(1) DEFAULT 0,
      target1_hit_bar INT NULL,
      target2_hit_bar INT NULL,
      target3_hit_bar INT NULL,
      stop_hit_bar    INT NULL,
      INDEX idx_bt_run     (run_id),
      INDEX idx_bt_symbol  (symbol),
      INDEX idx_bt_strat   (strategy),
      INDEX idx_bt_outcome (outcome),
      INDEX idx_bt_date    (signal_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 4. Signal outcomes
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_signal_outcomes (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      signal_id       VARCHAR(64)   NOT NULL,
      trade_id        VARCHAR(64)   NULL,
      entry_triggered TINYINT(1)    DEFAULT 0,
      bars_to_entry   INT           NULL,
      target1_hit     TINYINT(1)    DEFAULT 0,
      target2_hit     TINYINT(1)    DEFAULT 0,
      target3_hit     TINYINT(1)    DEFAULT 0,
      stop_hit        TINYINT(1)    DEFAULT 0,
      max_fav_excursion_pct DECIMAL(8,4) DEFAULT 0,
      max_adv_excursion_pct DECIMAL(8,4) DEFAULT 0,
      return_bar5_pct DECIMAL(8,4)  NULL,
      return_bar10_pct DECIMAL(8,4) NULL,
      outcome_label   VARCHAR(30)   NOT NULL,
      evaluated_at    DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bso_run    (run_id),
      INDEX idx_bso_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 5. Metrics key-value store
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_metrics (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      metric_key      VARCHAR(100)  NOT NULL,
      metric_value    DECIMAL(14,4) NOT NULL,
      metric_unit     VARCHAR(20)   DEFAULT '',
      category        VARCHAR(30)   NOT NULL,
      description     VARCHAR(255),
      UNIQUE KEY uq_bm (run_id, metric_key),
      INDEX idx_bm_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 6. Calibration snapshots
  await db.query(`
    CREATE TABLE IF NOT EXISTS calibration_snapshots (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      bucket          VARCHAR(20)   NOT NULL,
      strategy        VARCHAR(50)   DEFAULT 'all',
      regime          VARCHAR(30)   DEFAULT 'all',
      sample_size     INT           DEFAULT 0,
      expected_hit_rate DECIMAL(5,4) DEFAULT 0,
      actual_hit_rate DECIMAL(5,4)  DEFAULT 0,
      avg_mfe_pct     DECIMAL(8,4)  DEFAULT 0,
      avg_mae_pct     DECIMAL(8,4)  DEFAULT 0,
      calibration_state VARCHAR(30),
      modifier_suggestion DECIMAL(5,2) DEFAULT 0,
      computed_at     DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cs_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 7. Equity curve
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_equity_curve (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      date            DATE          NOT NULL,
      equity          DECIMAL(14,2) NOT NULL,
      cash            DECIMAL(14,2) NOT NULL,
      open_position_value DECIMAL(14,2) DEFAULT 0,
      drawdown_pct    DECIMAL(8,4)  DEFAULT 0,
      open_positions  INT           DEFAULT 0,
      day_pnl         DECIMAL(12,2) DEFAULT 0,
      UNIQUE KEY uq_ec (run_id, date),
      INDEX idx_ec_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 8. Audit logs
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_audit_logs (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      timestamp       DATETIME      NOT NULL,
      bar_index       INT           NOT NULL,
      action          VARCHAR(30)   NOT NULL,
      symbol          VARCHAR(50)   NULL,
      message         TEXT,
      payload_json    JSON,
      INDEX idx_bal_run    (run_id),
      INDEX idx_bal_action (action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}
