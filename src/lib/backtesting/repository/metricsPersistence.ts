// ════════════════════════════════════════════════════════════════
//  Metrics + Calibration + Outcomes Persistence
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { BacktestMetric, CalibrationBucketResult, SimulatedSignal, SimulatedTrade } from '../types';

/** Persist flat metrics to backtest_metrics table */
export async function saveBacktestMetrics(
  runId: string,
  metrics: BacktestMetric[],
): Promise<void> {
  if (metrics.length === 0) return;

  for (const m of metrics) {
    await db.query(
      `INSERT INTO backtest_metrics (run_id, metric_key, metric_value, metric_unit, category, description)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE metric_value=VALUES(metric_value)`,
      [runId, m.metricKey, m.metricValue, m.metricUnit, m.category, m.description],
    );
  }
}

/** Persist calibration snapshots */
export async function saveCalibrationSnapshots(
  runId: string,
  buckets: CalibrationBucketResult[],
): Promise<void> {
  if (buckets.length === 0) return;

  for (const b of buckets) {
    await db.query(
      `INSERT INTO calibration_snapshots
        (run_id, bucket, strategy, regime, sample_size, expected_hit_rate,
         actual_hit_rate, avg_mfe_pct, avg_mae_pct, calibration_state, modifier_suggestion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId, b.bucket, b.strategy, b.regime, b.sampleSize,
        b.expectedHitRate, b.actualHitRate, b.avgMfePct, b.avgMaePct,
        b.calibrationState, b.confidenceModifierSuggestion,
      ],
    );
  }
}

/** Persist signal outcomes for all signals in a run */
export async function saveSignalOutcomes(
  runId: string,
  signals: SimulatedSignal[],
  trades: SimulatedTrade[],
): Promise<void> {
  // Build a trade map for fast lookup
  const tradeBySignal = new Map<string, SimulatedTrade>();
  for (const t of trades) tradeBySignal.set(t.signalId, t);

  for (const sig of signals) {
    const trade = tradeBySignal.get(sig.signalId);
    const triggered = sig.status === 'triggered' || !!trade;

    await db.query(
      `INSERT INTO backtest_signal_outcomes
        (run_id, signal_id, trade_id, entry_triggered, bars_to_entry,
         target1_hit, target2_hit, target3_hit, stop_hit,
         max_fav_excursion_pct, max_adv_excursion_pct,
         return_bar5_pct, return_bar10_pct, outcome_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        sig.signalId,
        trade?.tradeId ?? null,
        triggered ? 1 : 0,
        trade?.barsToEntry ?? sig.barsWaited,
        trade?.target1Hit ? 1 : 0,
        trade?.target2Hit ? 1 : 0,
        trade?.target3Hit ? 1 : 0,
        trade?.stopHit ? 1 : 0,
        trade?.mfePct ?? 0,
        trade?.maePct ?? 0,
        null, // returnAtBar5 — computed from bar-by-bar PnL if available
        null,
        trade ? trade.outcome
          : sig.status === 'expired' ? 'stale_no_trigger'
          : 'expired_no_resolution',
      ],
    );
  }
}

/** Persist all signals generated during a backtest */
export async function saveBacktestSignals(
  runId: string,
  signals: SimulatedSignal[],
): Promise<void> {
  for (const sig of signals) {
    await db.query(
      `INSERT INTO backtest_signals
        (run_id, signal_id, symbol, date, bar_index, direction, strategy, regime,
         confidence_score, confidence_band, risk_score, sector,
         entry_zone_low, entry_zone_high, stop_loss, target1, target2, target3,
         risk_per_unit, reward_risk, status, bars_waited, reasons_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId, sig.signalId, sig.symbol, sig.date, sig.barIndex,
        sig.direction, sig.strategy, sig.regime,
        sig.confidenceScore, sig.confidenceBand, sig.riskScore, sig.sector,
        sig.entryZoneLow, sig.entryZoneHigh, sig.stopLoss,
        sig.target1, sig.target2, sig.target3,
        sig.riskPerUnit, sig.rewardRiskApprox,
        sig.status, sig.barsWaited,
        JSON.stringify(sig.reasons),
      ],
    );
  }
}

/** Load metrics for a backtest run */
export async function loadBacktestMetrics(runId: string): Promise<BacktestMetric[]> {
  const result = await db.query(
    `SELECT metric_key, metric_value, metric_unit, category, description
     FROM backtest_metrics WHERE run_id = ? ORDER BY category, metric_key`,
    [runId],
  );
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return rows.map((r: any) => ({
    metricKey: r.metric_key, metricValue: Number(r.metric_value),
    metricUnit: r.metric_unit, category: r.category, description: r.description,
  }));
}

/** Load calibration for a backtest run */
export async function loadCalibrationSnapshots(runId: string): Promise<CalibrationBucketResult[]> {
  const result = await db.query(
    `SELECT * FROM calibration_snapshots WHERE run_id = ? ORDER BY bucket`,
    [runId],
  );
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return rows.map((r: any) => ({
    bucket: r.bucket, strategy: r.strategy, regime: r.regime,
    sampleSize: r.sample_size, expectedHitRate: Number(r.expected_hit_rate),
    actualHitRate: Number(r.actual_hit_rate), avgMfePct: Number(r.avg_mfe_pct),
    avgMaePct: Number(r.avg_mae_pct), calibrationState: r.calibration_state,
    confidenceModifierSuggestion: Number(r.modifier_suggestion),
  }));
}
