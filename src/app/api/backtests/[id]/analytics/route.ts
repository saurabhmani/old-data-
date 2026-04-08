// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/analytics — Full analytics + equity curve
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestRun, loadEquityCurve } from '@/lib/backtesting/repository/persistence';
import { db } from '@/lib/db';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const run = await loadBacktestRun(params.id);
    if (!run) {
      return NextResponse.json({ error: 'Backtest run not found' }, { status: 404 });
    }

    const equityCurve = await loadEquityCurve(params.id);

    // Load metrics
    const metricsResult = await db.query(
      `SELECT metric_key, metric_value, metric_unit, category, description FROM backtest_metrics WHERE run_id = ?`,
      [params.id],
    );
    const metrics = Array.isArray(metricsResult) ? metricsResult : (metricsResult.rows ?? []);

    const summary = run.summary_json
      ? (typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json)
      : null;
    const strategyBreakdown = run.strategy_breakdown_json
      ? (typeof run.strategy_breakdown_json === 'string' ? JSON.parse(run.strategy_breakdown_json) : run.strategy_breakdown_json)
      : [];
    const regimeBreakdown = run.regime_breakdown_json
      ? (typeof run.regime_breakdown_json === 'string' ? JSON.parse(run.regime_breakdown_json) : run.regime_breakdown_json)
      : [];

    return NextResponse.json({
      runId: params.id,
      summary,
      strategyBreakdown,
      regimeBreakdown,
      equityCurve,
      metrics,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load analytics', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
