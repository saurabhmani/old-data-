// ════════════════════════════════════════════════════════════════
//  POST /api/backtests     — Start a backtest (full orchestration)
//  GET  /api/backtests     — List all backtest runs
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { runBacktest } from '@/lib/backtesting/runner/backtestRunner';
import { persistFullRun } from '@/lib/backtesting/runner/runOrchestrator';
import { listBacktestRuns } from '@/lib/backtesting/repository/persistence';
import { validateBacktestConfig } from '@/lib/backtesting/utils/validation';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtesting/config/defaults';
import type { BacktestRunConfig } from '@/lib/backtesting/types';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config: BacktestRunConfig = { ...DEFAULT_BACKTEST_CONFIG, ...body.config };

    const validation = validateBacktestConfig(config);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid configuration', details: validation.errors },
        { status: 400 },
      );
    }

    const result = await runBacktest(config);

    // Full orchestration: compute all metrics + persist everything
    let orchestrated;
    try {
      orchestrated = await persistFullRun(result);
    } catch (err) {
      console.error('[API] Orchestration failed:', err);
    }

    return NextResponse.json({
      runId: result.runId,
      status: result.status,
      tradeCount: result.tradeCount,
      signalCount: result.signalCount,
      durationMs: result.durationMs,
      message: result.status === 'completed'
        ? `Completed: ${result.tradeCount} trades, ${((result.summary?.winRate ?? 0) * 100).toFixed(0)}% win rate, ${result.summary?.totalReturnPct ?? 0}% return`
        : `${result.status}: ${result.error ?? ''}`,
      persisted: orchestrated ? {
        metrics: orchestrated.persistedMetrics,
        calibration: orchestrated.persistedCalibrationBuckets,
        signals: orchestrated.persistedSignals,
      } : null,
      verdict: orchestrated?.dexterOutput?.verdict ?? null,
    });
  } catch (err) {
    console.error('[API] Backtest error:', err);
    return NextResponse.json(
      { error: 'Backtest failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const runs = await listBacktestRuns();
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list backtests', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
