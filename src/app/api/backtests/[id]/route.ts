// ════════════════════════════════════════════════════════════════
//  GET    /api/backtests/:id — Backtest run detail
//  DELETE /api/backtests/:id — Delete a run + all child rows
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestRun } from '@/lib/backtesting/repository/persistence';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { db } from '@/lib/db';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await ensureBacktestTables();
    const run = await loadBacktestRun(params.id);
    if (!run) {
      return NextResponse.json({ error: 'Backtest run not found' }, { status: 404 });
    }

    // Parse JSON fields
    const parsed = {
      ...run,
      config: typeof run.config_json === 'string' ? JSON.parse(run.config_json) : run.config_json,
      summary: run.summary_json ? (typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json) : null,
      strategyBreakdown: run.strategy_breakdown_json ? (typeof run.strategy_breakdown_json === 'string' ? JSON.parse(run.strategy_breakdown_json) : run.strategy_breakdown_json) : [],
      regimeBreakdown: run.regime_breakdown_json ? (typeof run.regime_breakdown_json === 'string' ? JSON.parse(run.regime_breakdown_json) : run.regime_breakdown_json) : [],
    };

    return NextResponse.json({ run: parsed });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load backtest', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await ensureBacktestTables();
    const runId = params.id;

    // Delete from all related tables (no cascade defined, so do it manually)
    const tables = [
      'backtest_trades',
      'backtest_signals',
      'backtest_signal_outcomes',
      'backtest_metrics',
      'backtest_equity_curve',
      'backtest_audit_logs',
      'calibration_snapshots',
    ];

    for (const t of tables) {
      await db.query(`DELETE FROM ${t} WHERE run_id = ?`, [runId]).catch(() => {});
    }

    const result = await db.query(`DELETE FROM backtest_runs WHERE run_id = ?`, [runId]);

    return NextResponse.json({
      success: true,
      runId,
      deleted: result.affectedRows ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to delete backtest', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
