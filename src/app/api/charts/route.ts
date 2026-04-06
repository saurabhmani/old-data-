/**
 * GET /api/charts
 *
 * Legacy chart endpoint — delegates to chartService (MySQL + Yahoo).
 * No external broker dependency.
 */
import { NextRequest, NextResponse }         from 'next/server';
import { requireSession }                    from '@/lib/session';
import { getChartData, type ChartInterval }  from '@/services/chartService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const symbol      = searchParams.get('symbol')?.toUpperCase() ?? '';
  const rawInterval = (searchParams.get('interval') ?? '1day') as ChartInterval;
  const from        = searchParams.get('from') ?? undefined;
  const to          = searchParams.get('to')   ?? undefined;
  const limit       = Math.min(parseInt(searchParams.get('limit') ?? '200'), 1000);

  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const result = await getChartData(symbol, rawInterval, from, to, limit);

  return NextResponse.json({
    candles:        result.candles,
    instrument_key: result.instrument_key,
    symbol:         result.symbol,
    interval:       result.interval,
    count:          result.count,
    source:         result.source,
    cached:         result.cached,
  });
}
