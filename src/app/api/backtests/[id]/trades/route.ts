// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/trades — Trade list for a backtest run
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestTrades } from '@/lib/backtesting/repository/persistence';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const trades = await loadBacktestTrades(params.id);
    return NextResponse.json({ runId: params.id, trades, total: trades.length });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load trades', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
