// ════════════════════════════════════════════════════════════════
//  Strategy Breakdown & Conflict Persistence — Phase 2
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { StrategyBreakdown, ConflictResolution } from '../types/signalEngine.types';

/**
 * Save strategy breakdowns for a signal (how each strategy scored).
 */
export async function saveStrategyBreakdowns(
  signalId: number | string,
  breakdowns: StrategyBreakdown[],
): Promise<void> {
  if (breakdowns.length === 0) return;

  const values = breakdowns.map((b) => [
    signalId,
    b.strategyName,
    b.matched ? 1 : 0,
    b.confidenceScore,
    b.riskScore,
    b.regimeFit,
    b.rsAlignment,
    b.sectorFit,
    b.structuralQuality,
    b.rejectionReason || null,
  ]);

  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');

  await db.query(
    `INSERT INTO q365_strategy_breakdowns
      (signal_id, strategy_name, matched, confidence_score, risk_score,
       regime_fit, rs_alignment, sector_fit, structural_quality, rejection_reason)
     VALUES ${placeholders}`,
    values.flat(),
  );
}

/**
 * Save conflict resolution audit trail.
 */
export async function saveConflictResolution(
  resolution: ConflictResolution,
  signalId?: number | string,
): Promise<void> {
  if (resolution.losingStrategies.length === 0) return;

  await db.query(
    `INSERT INTO q365_signal_conflicts
      (symbol, winning_signal_id, winning_strategy, winning_score,
       losing_strategies_json, had_direction_conflict, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      resolution.symbol,
      signalId || null,
      resolution.winningStrategy,
      resolution.winningScore,
      JSON.stringify(resolution.losingStrategies),
      resolution.hadDirectionConflict ? 1 : 0,
      resolution.resolvedAt,
    ],
  );
}

/**
 * Migration: Create Phase 2 persistence tables.
 */
export async function migratePhase2Tables(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_strategy_breakdowns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      strategy_name VARCHAR(50) NOT NULL,
      matched TINYINT(1) DEFAULT 0,
      confidence_score DECIMAL(5,2) DEFAULT 0,
      risk_score DECIMAL(5,2) DEFAULT 0,
      regime_fit DECIMAL(5,2) DEFAULT 0,
      rs_alignment DECIMAL(5,2) DEFAULT 0,
      sector_fit DECIMAL(5,2) DEFAULT 0,
      structural_quality DECIMAL(5,2) DEFAULT 0,
      rejection_reason VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signal_id (signal_id),
      INDEX idx_strategy (strategy_name)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_conflicts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      symbol VARCHAR(30) NOT NULL,
      winning_signal_id INT,
      winning_strategy VARCHAR(50) NOT NULL,
      winning_score DECIMAL(5,2) DEFAULT 0,
      losing_strategies_json JSON,
      had_direction_conflict TINYINT(1) DEFAULT 0,
      resolved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_symbol (symbol),
      INDEX idx_resolved (resolved_at)
    )
  `);
}
