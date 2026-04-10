// ════════════════════════════════════════════════════════════════
//  Phase 4 Persistence — Explanations, Outcomes, Feedback, Memory
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { SignalOutcome, DecisionMemoryEntry, PortfolioCommentary } from '../types/phase4.types';

// ── Save signal outcome ────────────────────────────────────
export async function saveOutcome(outcome: SignalOutcome): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_outcomes
      (signal_id, entry_triggered, bars_to_entry,
       target1_hit, target2_hit, target3_hit, stop_hit,
       max_fav_excursion_pct, max_adv_excursion_pct,
       return_bar5_pct, return_bar10_pct,
       outcome_label, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      outcome.signalId,
      outcome.entryTriggered ? 1 : 0,
      outcome.barsToEntry,
      outcome.target1Hit ? 1 : 0,
      outcome.target2Hit ? 1 : 0,
      outcome.target3Hit ? 1 : 0,
      outcome.stopHit ? 1 : 0,
      outcome.maxFavorableExcursionPct,
      outcome.maxAdverseExcursionPct,
      outcome.returnAtBar5Pct,
      outcome.returnAtBar10Pct,
      outcome.outcomeLabel,
      outcome.evaluatedAt,
    ],
  );
}

// ── Save AI explanation ────────────────────────────────────
export async function saveExplanation(
  signalId: number | string,
  explanation: Record<string, unknown>,
  contextSnapshot: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_explanations (signal_id, explanation_json, context_json, created_at)
     VALUES (?, ?, ?, NOW())`,
    [
      signalId,
      JSON.stringify(explanation, (_k, v) => typeof v === 'number' && !isFinite(v) ? null : v),
      JSON.stringify(contextSnapshot, (_k, v) => typeof v === 'number' && !isFinite(v) ? null : v),
    ],
  );
}

// ── Save decision memory entries ───────────────────────────
export async function saveDecisionMemory(entries: DecisionMemoryEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const values = entries.map((e) => [
    e.signalId,
    e.stage,
    e.message,
    JSON.stringify(e.payload),
    e.createdAt,
  ]);
  const placeholders = values.map(() => '(?, ?, ?, ?, ?)').join(', ');

  await db.query(
    `INSERT INTO q365_decision_memory (signal_id, stage, message, payload_json, created_at)
     VALUES ${placeholders}`,
    values.flat(),
  );
}

// ── Save portfolio commentary ──────────────────────────────
export async function savePortfolioCommentary(commentary: PortfolioCommentary): Promise<void> {
  await db.query(
    `INSERT INTO q365_portfolio_commentary
      (market_tone, cluster_risk, capital_deployment, watchlist_note, opportunities_note, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      commentary.marketToneSummary,
      commentary.clusterRiskSummary,
      commentary.capitalDeploymentNote,
      commentary.watchlistNote,
      commentary.topOpportunitiesNote,
    ],
  );
}

// ── Load feedback state from historical outcomes ───────────
export async function loadFeedbackState(
  strategyName: string,
  regime: string,
): Promise<{ winRate: number | null; sampleSize: number }> {
  try {
    const result: any = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN target1_hit = 1 THEN 1 ELSE 0 END) AS wins
       FROM q365_signal_outcomes o
       JOIN q365_signals s ON s.id = o.signal_id
       WHERE s.signal_type = ? AND s.market_regime = ?
       AND o.evaluated_at > DATE_SUB(NOW(), INTERVAL 90 DAY)`,
      [strategyName, regime],
    );

    const rows = result.rows ?? [];
    const row = rows[0];
    if (!row || row.total < 5) return { winRate: null, sampleSize: row?.total ?? 0 };

    return {
      winRate: Math.round((row.wins / row.total) * 100) / 100,
      sampleSize: row.total,
    };
  } catch {
    return { winRate: null, sampleSize: 0 };
  }
}

// ── Idempotent ensure (runs once per process) ─────────────
let _phase4Migrated = false;
export async function ensurePhase4Tables(): Promise<void> {
  if (_phase4Migrated) return;
  await migratePhase4Tables();
  _phase4Migrated = true;
}

// ── Migration: Phase 4 tables ──────────────────────────────
export async function migratePhase4Tables(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_outcomes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      entry_triggered TINYINT(1) DEFAULT 0,
      bars_to_entry INT,
      target1_hit TINYINT(1) DEFAULT 0,
      target2_hit TINYINT(1) DEFAULT 0,
      target3_hit TINYINT(1) DEFAULT 0,
      stop_hit TINYINT(1) DEFAULT 0,
      max_fav_excursion_pct DECIMAL(8,4) DEFAULT 0,
      max_adv_excursion_pct DECIMAL(8,4) DEFAULT 0,
      return_bar5_pct DECIMAL(8,4),
      return_bar10_pct DECIMAL(8,4),
      outcome_label VARCHAR(30) NOT NULL,
      evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signal_id (signal_id),
      INDEX idx_outcome (outcome_label),
      INDEX idx_evaluated (evaluated_at)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_explanations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      explanation_json JSON,
      context_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signal_id (signal_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_decision_memory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      stage VARCHAR(50) NOT NULL,
      message TEXT,
      payload_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signal_id (signal_id),
      INDEX idx_stage (stage)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_portfolio_commentary (
      id INT AUTO_INCREMENT PRIMARY KEY,
      market_tone TEXT,
      cluster_risk TEXT,
      capital_deployment TEXT,
      watchlist_note TEXT,
      opportunities_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_confidence_calibration (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bucket VARCHAR(10) NOT NULL,
      strategy_name VARCHAR(50),
      regime VARCHAR(30),
      sample_size INT DEFAULT 0,
      target1_hit_rate DECIMAL(5,4) DEFAULT 0,
      avg_mfe DECIMAL(8,4) DEFAULT 0,
      calibration_state VARCHAR(30),
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bucket (bucket),
      INDEX idx_strategy (strategy_name)
    )
  `);
}
