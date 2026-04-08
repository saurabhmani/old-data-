// ════════════════════════════════════════════════════════════════
//  Signal Persistence — MySQL
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { QuantSignal } from '../types/signalEngine.types';

export async function saveSignals(signals: QuantSignal[]): Promise<void> {
  if (signals.length === 0) return;

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
      await saveOneSignal(signal);
    } catch (err) {
      console.error(`[SignalEngine] Failed to save signal for ${signal.symbol}:`, err);
    }
  }
}

async function saveOneSignal(s: QuantSignal): Promise<void> {
  // 1. Insert main signal record (MySQL uses insertId, not RETURNING)
  const result: any = await db.query(
    `INSERT INTO q365_signals
      (symbol, timeframe, signal_type, action_type, confidence_score, confidence_band,
       risk_score, risk_band, entry_zone_low, entry_zone_high, stop_loss, target1, target2,
       reward_risk_approx, market_regime, status, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.symbol, s.timeframe, s.signalType, s.action,
      s.confidenceScore, s.confidenceBand,
      s.riskScore, s.riskBand,
      s.entry.zoneLow, s.entry.zoneHigh,
      s.stopLoss, s.targets.target1, s.targets.target2,
      s.rewardRiskApprox, s.marketRegime,
      s.status, s.generatedAt,
    ],
  );

  // MySQL returns insertId directly; fallback to rows for compatibility
  const signalId = result.insertId ?? result.rows?.[0]?.id;
  if (!signalId) return;

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

  const rows: any[] = Array.isArray(result) ? result : (result.rows ?? []);
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
