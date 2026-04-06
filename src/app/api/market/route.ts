








/**
 * GET /api/market
 *
 * Actions: search | suggest | ltp | quotes
 *
 * LTP and quotes now served from Redis stock cache (written by scheduler
 * from NSE). Falls back to direct NSE fetch if cache is cold.
 * LTP and quotes served from Redis cache + NSE direct fetch.
 */
import { NextRequest, NextResponse }  from 'next/server';
import { requireSession }             from '@/lib/session';
import { db }                         from '@/lib/db';
import { cacheGet }                   from '@/lib/redis';
import { fetchNseQuote,
         fetchMultipleNseQuotes }     from '@/services/nse';
import type { MarketSnapshot }        from '@/services/marketDataService';
import type { Tick }                  from '@/types';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const action = searchParams.get('action') || 'search';

  // ── Search / Suggest ──────────────────────────────────────────
  if (action === 'search' || action === 'suggest') {
    const q        = searchParams.get('q')        || '';
    const exchange = searchParams.get('exchange') || null;
    const limit    = action === 'suggest' ? 8 : parseInt(searchParams.get('limit') || '20');

    if (q.length < 2) return NextResponse.json({ results: [] });

    let query = `
      SELECT instrument_key, exchange, tradingsymbol, name,
             instrument_type, expiry, strike, option_type
      FROM instruments
      WHERE is_active = TRUE
        AND (tradingsymbol LIKE ? OR name LIKE ?)
    `;
    const params: any[] = [`${q.toUpperCase()}%`, `%${q}%`];
    if (exchange) { query += ` AND exchange = ?`; params.push(exchange); }
    query += ` ORDER BY CASE WHEN tradingsymbol LIKE ? THEN 0 ELSE 1 END, tradingsymbol LIMIT ?`;
    params.push(`${q.toUpperCase()}%`, limit);

    const { rows } = await db.query(query, params);
    return NextResponse.json({ results: rows, count: rows.length });
  }

  // ── LTP — read from Redis stock cache, NSE fallback ──────────
  if (action === 'ltp') {
    const keysParam = searchParams.get('keys') || '';
    const keys      = keysParam.split(',').map(k => k.trim()).filter(Boolean);
    if (!keys.length) return NextResponse.json({ error: 'keys required' }, { status: 400 });
    if (keys.length > 500) return NextResponse.json({ error: 'Max 500 keys' }, { status: 400 });

    const result: Record<string, Tick> = {};
    const missingSymbols: string[] = [];

    for (const key of keys) {
      const sym = key.split('|')[1] ?? key;
      // Check Redis stock cache first
      const snap = await cacheGet<MarketSnapshot>(`stock:${sym.toUpperCase()}`);
      if (snap?.ltp) {
        result[key] = {
          instrument_key: key,
          ltp:        snap.ltp,
          net_change: snap.change_abs,
          pct_change: snap.change_percent,
          volume:     snap.volume,
          oi:         snap.oi,
          ts:         new Date(snap.timestamp).toISOString(),
        };
      } else {
        missingSymbols.push(sym);
      }
    }

    // NSE fetch for cache misses (batched)
    if (missingSymbols.length > 0) {
      const quotes = await fetchMultipleNseQuotes(missingSymbols);
      for (const [sym, q] of Object.entries(quotes)) {
        const key = `NSE_EQ|${sym}`;
        result[key] = {
          instrument_key: key,
          ltp:        q.lastPrice,
          net_change: q.change,
          pct_change: q.pChange,
          volume:     q.totalTradedVolume,
          oi:         0,
          ts:         new Date().toISOString(),
        };
      }
    }

    return NextResponse.json({ data: result, count: Object.keys(result).length });
  }

  // ── Quotes (full snapshot) ─────────────────────────────────────
  if (action === 'quotes') {
    const symbolsParam = searchParams.get('symbols') || '';
    const symbols      = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) return NextResponse.json({ error: 'symbols required' }, { status: 400 });

    const result: Record<string, any> = {};

    for (const sym of symbols.slice(0, 50)) {
      // Try Redis first
      const snap = await cacheGet<MarketSnapshot>(`stock:${sym}`);
      if (snap) {
        result[sym] = snap;
        continue;
      }
      // NSE fallback
      const q = await fetchNseQuote(sym);
      if (q) {
        result[sym] = {
          symbol:         q.symbol,
          ltp:            q.lastPrice,
          change_percent: q.pChange,
          change_abs:     q.change,
          open:           q.open,
          high:           q.dayHigh,
          low:            q.dayLow,
          close:          q.previousClose,
          volume:         q.totalTradedVolume,
          week52_high:    q.fiftyTwoWeekHigh,
          week52_low:     q.fiftyTwoWeekLow,
          vwap:           q.vwap,
          source:         'nse',
        };
      }
    }

    return NextResponse.json({ data: result });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
