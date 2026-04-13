// ════════════════════════════════════════════════════════════════
//  Signal Persistence — MySQL
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { QuantSignal } from '../types/signalEngine.types';

function toMysqlDateTime(value: string | Date | undefined): string {
  const d = value ? new Date(value) : new Date();
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Save signals and return map of symbol → inserted DB ID.
 * This enables downstream saves (breakdowns, explanations) to reference real IDs.
 */
export async function saveSignals(signals: QuantSignal[]): Promise<Map<string, number>> {
  const idMap = new Map<string, number>();
  if (signals.length === 0) return idMap;

  // Expire old active/watchlist signals for symbols we're about to insert
  const symbols = signals.map((s) => s.symbol);
  const placeholders = symbols.map(() => '?').join(',');
  await db.query(
    `UPDATE q365_signals SET status = 'expired'
     WHERE symbol IN (${placeholders}) AND status IN ('active', 'watchlist')`,
    symbols,
  );

  for (const signal of signals) {
    try {
      const signalId = await saveOneSignal(signal);
      if (signalId) idMap.set(signal.symbol, signalId);
    } catch (err) {
      console.error(`[SignalEngine] Failed to save signal for ${signal.symbol}:`, err);
    }
  }
  return idMap;
}

async function saveOneSignal(s: QuantSignal): Promise<number | null> {
  // 1. Insert main signal record — matches actual q365_signals schema
  const direction = s.action === 'enter_short' ? 'SELL' : 'BUY';
  const entryPrice = s.entry.zoneHigh; // conservative entry price
  const riskReward = Math.round(s.rewardRiskApprox * 10) / 10;

  const result: any = await db.query(
    `INSERT INTO q365_signals
      (symbol, instrument_key, exchange, direction, timeframe, signal_type,
       confidence_score, confidence_band, risk_score, risk_band,
       entry_price, stop_loss, target1, target2, risk_reward,
       market_regime, status, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.symbol, `NSE_EQ|${s.symbol}`, 'NSE', direction,
      s.timeframe, s.signalType,
      s.confidenceScore, s.confidenceBand,
      s.riskScore, s.riskBand,
      entryPrice, s.stopLoss, s.targets.target1, s.targets.target2,
      riskReward, s.marketRegime,
      s.status === 'active' ? 'active' : s.status === 'watchlist' ? 'watchlist' : 'active',
      toMysqlDateTime(s.generatedAt),
    ],
  );

  // db.query now exposes insertId directly for INSERT statements
  const signalId = result.insertId;
  if (!signalId) return null;

  // 2. Batch insert reasons and warnings
  const allReasons = [
    ...s.reasons.map((msg) => [signalId, 'reason', msg]),
    ...s.warnings.map((msg) => [signalId, 'warning', msg]),
  ];
  if (allReasons.length > 0) {
    const valuesPlaceholder = allReasons.map(() => '(?, ?, ?)').join(', ');
    await db.query(
      `INSERT INTO q365_signal_reasons (signal_id, reason_type, message) VALUES ${valuesPlaceholder}`,
      allReasons.flat(),
    );
  }

  // 3. Insert feature snapshot (safely serialize, replacing NaN with null)
  const featuresJson = JSON.stringify(s.features, (_key, value) =>
    typeof value === 'number' && !isFinite(value) ? null : value,
  );
  await db.query(
    `INSERT INTO q365_signal_feature_snapshots (signal_id, features_json) VALUES (?, ?)`,
    [signalId, featuresJson],
  );

  return signalId;
}

export async function getLatestSignals(limit = 20): Promise<any[]> {
  const result = await db.query(
    `SELECT s.*,
            GROUP_CONCAT(CASE WHEN r.reason_type = 'reason' THEN r.message END SEPARATOR '||') AS reasons_raw,
            GROUP_CONCAT(CASE WHEN r.reason_type = 'warning' THEN r.message END SEPARATOR '||') AS warnings_raw
     FROM q365_signals s
     LEFT JOIN q365_signal_reasons r ON r.signal_id = s.id
     WHERE s.status IN ('active', 'watchlist')
     GROUP BY s.id
     ORDER BY s.confidence_score DESC, s.risk_score ASC
     LIMIT ?`,
    [limit],
  );

  const rows: any[] = result.rows ?? [];
  return rows.map((row: any) => ({
    symbol: row.symbol,
    timeframe: row.timeframe,
    signalType: row.signal_type,
    action: row.action_type,
    confidenceScore: row.confidence_score,
    confidenceBand: row.confidence_band,
    riskScore: row.risk_score,
    riskBand: row.risk_band,
    marketRegime: row.market_regime,
    entry: {
      type: 'breakout_confirmation' as const,
      zoneLow: row.entry_zone_low,
      zoneHigh: row.entry_zone_high,
    },
    stopLoss: row.stop_loss,
    targets: {
      target1: row.target1,
      target2: row.target2,
    },
    rewardRiskApprox: row.reward_risk_approx,
    reasons: row.reasons_raw ? row.reasons_raw.split('||') : [],
    warnings: row.warnings_raw ? row.warnings_raw.split('||') : [],
    status: row.status,
    generatedAt: row.generated_at,
  }));
}
