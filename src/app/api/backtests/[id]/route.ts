// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id — Backtest run detail
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestRun } from '@/lib/backtesting/repository/persistence';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
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
