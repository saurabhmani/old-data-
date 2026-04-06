/**
 * GET /api/rankings
 *
 * Returns top-ranked instruments with signal data.
 *
 * Query params:
 *   limit    — number of results, 1–500 (default 50)
 *   page     — page number (default 1)
 *   exchange — filter by exchange: NSE | BSE (optional)
 *
 * Response:
 * {
 *   data: [{
 *     symbol, name, exchange, instrument_key,
 *     score, rank_position, ltp, pct_change, volume,
 *     signal_type, confidence, signal_age_min, data_source
 *   }],
 *   count, total, page, limit, has_more,
 *   data_source, as_of
 * }
 *
 * Data source priority:
 *   1. Redis  key: rankings:top:{limit}:{exchange}  (TTL 60s)
 *   2. MySQL  JOIN rankings + latest signal per instrument
 *   Redis signal cache (signal:{instrument_key}) used to enrich
 *   confidence values when fresher than MySQL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { getTopRankings }            from '@/services/rankingsService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;

  const limitRaw    = parseInt(searchParams.get('limit')    ?? '50', 10);
  const pageRaw     = parseInt(searchParams.get('page')     ?? '1',  10);
  const exchangeRaw = searchParams.get('exchange')?.trim().toUpperCase();

  const limit    = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50;
  const page     = Number.isFinite(pageRaw)  ? Math.max(pageRaw, 1) : 1;
  const exchange = exchangeRaw && ['NSE', 'BSE'].includes(exchangeRaw)
    ? exchangeRaw : undefined;

  try {
    const result = await getTopRankings(limit, page, exchange);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[/api/rankings] Error:', err?.message);
    return NextResponse.json(
      { error: 'Failed to fetch rankings', details: err?.message },
      { status: 500 }
    );
  }
}
