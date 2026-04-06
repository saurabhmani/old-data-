/**
 * GET /api/ticker
 *
 * Returns lightweight ticker data for the moving strip.
 * Read priority:
 *   1. Redis  stock:{SYMBOL}  — MarketSnapshot written by scheduler (TTL 60s)
 *   2. MySQL  rankings        — pct_change + ltp columns (written by dataSync)
 *
 * Returns top 30 ranked symbols with symbol, price, change%.
 * Response is itself cached at Redis key 'ticker:strip' for 30s
 * so repeated browser polls don't fan out to 30 Redis reads each time.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { cacheGet, cacheSet }        from '@/lib/redis';
import { db }                        from '@/lib/db';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export interface TickerItem {
  symbol:         string;
  name:           string;
  ltp:            number;
  change_percent: number;
  change_abs:     number;
}

const STRIP_KEY = 'ticker:strip';
const STRIP_TTL = 30;   // seconds — matches component's 30s refresh
const LIMIT     = 30;

export async function GET(_req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // ── Step 1: Assembled strip cache (fastest path) ───────────────
  const stripped = await cacheGet<TickerItem[]>(STRIP_KEY);
  if (stripped?.length) {
    return NextResponse.json({ items: stripped, source: 'redis', count: stripped.length });
  }

  // ── Step 2: Load universe from rankings ────────────────────────
  let items: TickerItem[] = [];
  let source = 'redis';

  try {
    const { rows: universe } = await db.query(`
      SELECT r.tradingsymbol                       AS symbol,
             COALESCE(r.name, r.tradingsymbol)     AS name,
             COALESCE(r.instrument_key,
               CONCAT('NSE_EQ|', r.tradingsymbol)) AS instrument_key,
             COALESCE(r.ltp,       0)              AS db_ltp,
             COALESCE(r.pct_change, 0)             AS db_pct
      FROM rankings r
      INNER JOIN (
        SELECT tradingsymbol, MAX(score) AS max_score
        FROM rankings
        GROUP BY tradingsymbol
      ) best ON r.tradingsymbol = best.tradingsymbol
             AND r.score        = best.max_score
      GROUP BY r.tradingsymbol
      ORDER BY r.score DESC
      LIMIT ?
    `, [LIMIT]);

    // ── Step 3: Enrich each symbol from Redis stock:{SYMBOL} ──────
    const enriched = await Promise.all((universe as any[]).map(async (row) => {
      const sym  = String(row.symbol || '').toUpperCase();
      const snap = await cacheGet<any>(`stock:${sym}`);

      if (snap && snap.ltp) {
        return {
          symbol:         sym,
          name:           String(row.name || sym),
          ltp:            Number(snap.ltp)            || 0,
          change_percent: Number(snap.change_percent) || 0,
          change_abs:     Number(snap.change_abs)     || 0,
        } satisfies TickerItem;
      }

      // Redis miss — use MySQL rankings values
      source = 'mixed';
      return {
        symbol:         sym,
        name:           String(row.name || sym),
        ltp:            Number(row.db_ltp) || 0,
        change_percent: Number(row.db_pct) || 0,
        change_abs:     0,
      } satisfies TickerItem;
    }));

    items = enriched.filter(i => i.ltp > 0 || i.change_percent !== 0);

    if (!items.length) source = 'mysql';

  } catch (err: any) {
    console.error('[/api/ticker] DB error:', err?.message);
    return NextResponse.json({ error: 'Failed to load ticker data' }, { status: 500 });
  }

  // ── Step 4: Cache assembled strip ─────────────────────────────
  if (items.length) {
    await cacheSet(STRIP_KEY, items, STRIP_TTL);
  }

  return NextResponse.json({ items, source, count: items.length });
}
