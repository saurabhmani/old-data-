// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/dexter — Dexter AI integration output
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestRun, loadBacktestTrades } from '@/lib/backtesting/repository/persistence';
import { loadBacktestMetrics, loadCalibrationSnapshots } from '@/lib/backtesting/repository/metricsPersistence';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const run = await loadBacktestRun(params.id);
    if (!run) {
      return NextResponse.json({ error: 'Backtest run not found' }, { status: 404 });
    }

    const [trades, metrics, calibration] = await Promise.all([
      loadBacktestTrades(params.id),
      loadBacktestMetrics(params.id),
      loadCalibrationSnapshots(params.id),
    ]);

    const summary = run.summary_json
      ? (typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json)
      : null;

    // Build a Dexter-consumable response from persisted data
    const keyMetrics: Record<string, number> = {};
    for (const m of metrics) {
      keyMetrics[m.metricKey] = m.metricValue;
    }

    const calibrationWarnings = calibration
      .filter((c: any) => c.calibration_state && c.calibration_state !== 'well_calibrated' && c.calibration_state !== 'insufficient_data')
      .map((c: any) => ({
        bucket: c.bucket,
        strategy: c.strategy,
        regime: c.regime,
        state: c.calibration_state,
        expectedRate: Number(c.expected_hit_rate),
        actualRate: Number(c.actual_hit_rate),
        suggestedModifier: Number(c.modifier_suggestion),
        sampleSize: c.sample_size,
      }));

    // Strategy performance from trades
    const strategyMap: Record<string, { wins: number; total: number; pnl: number }> = {};
    for (const t of trades) {
      const s = t.strategy;
      if (!strategyMap[s]) strategyMap[s] = { wins: 0, total: 0, pnl: 0 };
      strategyMap[s].total++;
      if (t.outcome === 'win') strategyMap[s].wins++;
      strategyMap[s].pnl += Number(t.net_pnl ?? 0);
    }

    const strategyPerformance = Object.entries(strategyMap).map(([strategy, data]) => ({
      strategy,
      trades: data.total,
      winRate: data.total > 0 ? Math.round((data.wins / data.total) * 100) / 100 : 0,
      totalPnl: Math.round(data.pnl * 100) / 100,
      verdict: data.total > 0 && data.wins / data.total >= 0.55 ? 'strong' : data.wins / data.total >= 0.45 ? 'acceptable' : 'weak',
    }));

    return NextResponse.json({
      runId: params.id,
      runName: run.name,
      status: run.status,
      summary,
      keyMetrics,
      calibrationWarnings,
      strategyPerformance,
      tradeCount: trades.length,
      dataRange: {
        start: run.started_at,
        completed: run.completed_at,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load Dexter output', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
