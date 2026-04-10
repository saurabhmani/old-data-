// ════════════════════════════════════════════════════════════════
//  Manipulation Alert Persistence
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { ManipulationAlert, ManipulationSummary, ManipulationType, SeverityLevel, AlertStatus } from '../types';

let _migrated = false;

/** Ensure manipulation tables exist */
export async function ensureManipulationTables(): Promise<void> {
  if (_migrated) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS manipulation_alerts (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      alert_id        VARCHAR(64)   NOT NULL UNIQUE,
      symbol          VARCHAR(50)   NOT NULL,
      type            VARCHAR(30)   NOT NULL,
      severity        VARCHAR(15)   NOT NULL DEFAULT 'info',
      score           INT           NOT NULL DEFAULT 0,
      status          VARCHAR(20)   NOT NULL DEFAULT 'new',
      headline        VARCHAR(255)  NOT NULL,
      description     TEXT,
      evidence_json   JSON,
      related_symbols JSON,
      detected_at     DATETIME      NOT NULL,
      updated_at      DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ma_symbol  (symbol),
      INDEX idx_ma_type    (type),
      INDEX idx_ma_severity (severity),
      INDEX idx_ma_score   (score DESC),
      INDEX idx_ma_status  (status),
      INDEX idx_ma_detected (detected_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  _migrated = true;
}

/** Save manipulation alerts to database */
export async function saveAlerts(alerts: ManipulationAlert[]): Promise<void> {
  await ensureManipulationTables();

  for (const alert of alerts) {
    await db.query(
      `INSERT INTO manipulation_alerts
        (alert_id, symbol, type, severity, score, status, headline, description, evidence_json, related_symbols, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE score=VALUES(score), severity=VALUES(severity), evidence_json=VALUES(evidence_json)`,
      [
        alert.alertId, alert.symbol, alert.type, alert.severity,
        alert.score, alert.status, alert.headline, alert.description,
        JSON.stringify(alert.evidence),
        JSON.stringify(alert.relatedSymbols),
        alert.detectedAt,
      ],
    );
  }
}

/** Load recent alerts */
export async function loadAlerts(
  filters: { type?: ManipulationType; severity?: SeverityLevel; status?: AlertStatus; symbol?: string; limit?: number } = {},
): Promise<ManipulationAlert[]> {
  await ensureManipulationTables();

  let sql = `SELECT * FROM manipulation_alerts WHERE 1=1`;
  const params: any[] = [];

  if (filters.type) { sql += ` AND type = ?`; params.push(filters.type); }
  if (filters.severity) { sql += ` AND severity = ?`; params.push(filters.severity); }
  if (filters.status) { sql += ` AND status = ?`; params.push(filters.status); }
  if (filters.symbol) { sql += ` AND symbol = ?`; params.push(filters.symbol); }

  sql += ` ORDER BY detected_at DESC LIMIT ?`;
  params.push(filters.limit ?? 50);

  const { rows } = await db.query(sql, params);

  return rows.map((r: any) => ({
    alertId: r.alert_id,
    symbol: r.symbol,
    type: r.type,
    severity: r.severity,
    score: r.score,
    detectedAt: r.detected_at,
    status: r.status,
    headline: r.headline,
    description: r.description,
    evidence: typeof r.evidence_json === 'string' ? JSON.parse(r.evidence_json) : r.evidence_json ?? {},
    relatedSymbols: typeof r.related_symbols === 'string' ? JSON.parse(r.related_symbols) : r.related_symbols ?? [],
  }));
}

/** Update alert status */
export async function updateAlertStatus(alertId: string, status: AlertStatus): Promise<void> {
  await db.query(
    `UPDATE manipulation_alerts SET status = ? WHERE alert_id = ?`,
    [status, alertId],
  );
}

/** Get dashboard summary */
export async function getAlertSummary(): Promise<ManipulationSummary> {
  await ensureManipulationTables();

  const { rows: countRows } = await db.query(
    `SELECT type, severity, COUNT(*) as cnt
     FROM manipulation_alerts
     WHERE detected_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
     GROUP BY type, severity`,
  );

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let total = 0;

  for (const r of countRows as any[]) {
    byType[r.type] = (byType[r.type] ?? 0) + Number(r.cnt);
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + Number(r.cnt);
    total += Number(r.cnt);
  }

  const topAlerts = await loadAlerts({ limit: 10 });

  // Trend detection
  const { rows: trendRows } = await db.query(
    `SELECT
       SUM(CASE WHEN detected_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as recent,
       SUM(CASE WHEN detected_at BETWEEN DATE_SUB(NOW(), INTERVAL 14 DAY) AND DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as prior
     FROM manipulation_alerts
     WHERE detected_at > DATE_SUB(NOW(), INTERVAL 14 DAY)`,
  );

  const recent = Number((trendRows[0] as any)?.recent ?? 0);
  const prior = Number((trendRows[0] as any)?.prior ?? 0);
  const recentTrend = recent > prior * 1.3 ? 'increasing' as const : recent < prior * 0.7 ? 'decreasing' as const : 'stable' as const;

  return {
    totalAlerts: total,
    byType: byType as any,
    bySeverity: bySeverity as any,
    topAlerts,
    recentTrend,
  };
}
