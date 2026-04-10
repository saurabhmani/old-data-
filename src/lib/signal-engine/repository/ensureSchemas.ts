// ════════════════════════════════════════════════════════════════
//  Idempotent schema ensure for the signal-engine layer.
//
//  Called once per process by any code path that needs the
//  Phase 3/4 audit tables to exist (signalPipeline, Phase4 pipeline,
//  validation tests, etc).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensurePhase4Tables } from './savePhase4Artifacts';

let _ensured = false;

export async function ensureSignalEngineSchemas(): Promise<void> {
  if (_ensured) return;

  // Phase 3 tables
  const phase3Ddl = [
    `CREATE TABLE IF NOT EXISTS q365_signal_trade_plans (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      entry_type VARCHAR(40) NOT NULL,
      entry_zone_low DECIMAL(12,2) NOT NULL,
      entry_zone_high DECIMAL(12,2) NOT NULL,
      stop_loss DECIMAL(12,2) NOT NULL,
      initial_risk_per_unit DECIMAL(12,4) NOT NULL,
      target1 DECIMAL(12,2) NOT NULL,
      target2 DECIMAL(12,2) NOT NULL,
      target3 DECIMAL(12,2) NOT NULL,
      rr_target1 DECIMAL(6,2) NOT NULL,
      rr_target2 DECIMAL(6,2) NOT NULL,
      rr_target3 DECIMAL(6,2) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tp_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_position_sizing (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      capital_model VARCHAR(30) NOT NULL,
      portfolio_capital DECIMAL(14,2) NOT NULL,
      risk_budget_pct DECIMAL(6,4) NOT NULL,
      risk_budget_amount DECIMAL(12,2) NOT NULL,
      initial_risk_per_unit DECIMAL(12,4) NOT NULL,
      position_size_units INT NOT NULL,
      gross_position_value DECIMAL(14,2) NOT NULL,
      validation_status VARCHAR(20) NOT NULL,
      warnings_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ps_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_portfolio_fit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      fit_score INT NOT NULL,
      sector_exposure_impact VARCHAR(20) NOT NULL,
      direction_impact VARCHAR(20) NOT NULL,
      capital_availability VARCHAR(20) NOT NULL,
      correlation_cluster VARCHAR(50),
      correlation_penalty DECIMAL(5,2) DEFAULT 0,
      portfolio_decision VARCHAR(30) NOT NULL,
      penalties_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pf_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_execution_readiness (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      status VARCHAR(40) NOT NULL,
      action_tag VARCHAR(30) NOT NULL,
      priority_rank INT,
      approval_decision VARCHAR(20) NOT NULL,
      reasons_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_er_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_lifecycle (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      state VARCHAR(20) NOT NULL,
      reason VARCHAR(255) NOT NULL,
      changed_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_lc_signal (signal_id),
      INDEX idx_lc_state (state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const ddl of phase3Ddl) {
    await db.query(ddl);
  }

  // Phase 4 tables (outcomes, explanations, decision memory, commentary)
  await ensurePhase4Tables();

  _ensured = true;
}
