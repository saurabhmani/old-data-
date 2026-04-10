// ════════════════════════════════════════════════════════════════
//  Phase 3 Persistence — Trade Plan, Sizing, Portfolio Fit,
//  Execution Readiness, Lifecycle
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  Phase3TradePlan, PositionSizingResult, PortfolioFitResult,
  ExecutionReadiness, SignalLifecycle,
} from '../types/phase3.types';

/**
 * Persist all Phase 3 artifacts for a given signal.
 * Call this AFTER saveSignals() has returned the real signal ID.
 */
export async function savePhase3Artifacts(
  signalId: number,
  tradePlan: Phase3TradePlan,
  sizing: PositionSizingResult,
  fit: PortfolioFitResult,
  readiness: ExecutionReadiness,
  lifecycle: SignalLifecycle,
): Promise<void> {
  await Promise.all([
    saveTradePlan(signalId, tradePlan),
    savePositionSizing(signalId, sizing),
    savePortfolioFit(signalId, fit),
    saveExecutionReadiness(signalId, readiness),
    saveLifecycle(signalId, lifecycle),
  ]);
}

async function saveTradePlan(signalId: number, tp: Phase3TradePlan): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_trade_plans
      (signal_id, entry_type, entry_zone_low, entry_zone_high, stop_loss,
       initial_risk_per_unit, target1, target2, target3,
       rr_target1, rr_target2, rr_target3)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId, tp.entryType, tp.entryZoneLow, tp.entryZoneHigh,
      tp.stopLoss, tp.initialRiskPerUnit,
      tp.target1, tp.target2, tp.target3,
      tp.rrTarget1, tp.rrTarget2, tp.rrTarget3,
    ],
  );
}

async function savePositionSizing(signalId: number, s: PositionSizingResult): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_position_sizing
      (signal_id, capital_model, portfolio_capital, risk_budget_pct,
       risk_budget_amount, initial_risk_per_unit, position_size_units,
       gross_position_value, validation_status, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId, s.capitalModel, s.portfolioCapital, s.riskBudgetPct,
      s.riskBudgetAmount, s.initialRiskPerUnit, s.positionSizeUnits,
      s.grossPositionValue, s.validationStatus,
      JSON.stringify(s.warnings),
    ],
  );
}

async function savePortfolioFit(signalId: number, f: PortfolioFitResult): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_portfolio_fit
      (signal_id, fit_score, sector_exposure_impact, direction_impact,
       capital_availability, correlation_cluster, correlation_penalty,
       portfolio_decision, penalties_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId, f.fitScore, f.sectorExposureImpact, f.directionImpact,
      f.capitalAvailability, f.correlationCluster, f.correlationPenalty,
      f.portfolioDecision, JSON.stringify(f.penalties),
    ],
  );
}

async function saveExecutionReadiness(signalId: number, r: ExecutionReadiness): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_execution_readiness
      (signal_id, status, action_tag, priority_rank, approval_decision, reasons_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      signalId, r.status, r.actionTag, r.priorityRank,
      r.approvalDecision, JSON.stringify(r.reasons),
    ],
  );
}

async function saveLifecycle(signalId: number, lc: SignalLifecycle): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_lifecycle
      (signal_id, state, reason, changed_at)
     VALUES (?, ?, ?, ?)`,
    [signalId, lc.state, lc.reason, lc.changedAt],
  );
}

/**
 * Load Phase 3 artifacts for a signal.
 */
export async function loadPhase3Artifacts(signalId: number): Promise<{
  tradePlan: any;
  sizing: any;
  fit: any;
  readiness: any;
  lifecycle: any[];
} | null> {
  const [tp, sz, ft, er, lc] = await Promise.all([
    db.query(`SELECT * FROM q365_signal_trade_plans WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_position_sizing WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_portfolio_fit WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_execution_readiness WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_lifecycle WHERE signal_id = ? ORDER BY changed_at`, [signalId]),
  ]);

  return {
    tradePlan: tp.rows[0] ?? null,
    sizing: sz.rows[0] ?? null,
    fit: ft.rows[0] ?? null,
    readiness: er.rows[0] ?? null,
    lifecycle: lc.rows,
  };
}
