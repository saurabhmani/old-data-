import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import type { WatchlistItem } from '@/types';

// GET /api/watchlist
export async function GET() {
  try {
    const user = await requireSession();
    // Auto-create default watchlist if needed
    let { rows: wl } = await db.query(`SELECT id FROM watchlists WHERE user_id=? LIMIT 1`, [user.id]);
    if (!wl.length) {
      const r = await db.query(`INSERT INTO watchlists (user_id, name) VALUES (?,'Default') `, [user.id]);
      wl = r.rows;
    }
    const watchlistId = wl[0].id;
    const { rows } = await db.query<WatchlistItem>(
      `SELECT wi.id, wi.watchlist_id, wi.instrument_key, wi.tradingsymbol, wi.exchange, wi.name, wi.added_at
       FROM watchlist_items wi WHERE wi.watchlist_id=? ORDER BY wi.added_at DESC`,
      [watchlistId]
    );
    return NextResponse.json({ items: rows, watchlist_id: watchlistId });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

// POST /api/watchlist
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const { instrument_key, tradingsymbol, exchange, name } = await req.json();
    if (!instrument_key) return NextResponse.json({ error: 'instrument_key required' }, { status: 400 });

    let { rows: wl } = await db.query(`SELECT id FROM watchlists WHERE user_id=? LIMIT 1`, [user.id]);
    if (!wl.length) {
      const r = await db.query(`INSERT INTO watchlists (user_id, name) VALUES (?,'Default') `, [user.id]);
      wl = r.rows;
    }

    // Lookup instrument details if not provided
    let sym = tradingsymbol, exch = exchange, nm = name;
    if (!sym) {
      const { rows: inst } = await db.query(
        `SELECT tradingsymbol, exchange, name FROM instruments WHERE instrument_key=?`, [instrument_key]
      );
      if (inst.length) { sym = inst[0].tradingsymbol; exch = inst[0].exchange; nm = inst[0].name; }
    }

    try {
      const { rows } = await db.query(
        `INSERT INTO watchlist_items (watchlist_id, instrument_key, tradingsymbol, exchange, name)
         VALUES (?,?,?,?,?) `,
        [wl[0].id, instrument_key, sym || instrument_key, exch, nm]
      );
      return NextResponse.json({ item: rows[0] }, { status: 201 });
    } catch (e: any) {
      if (e.code === '23505') return NextResponse.json({ error: 'Already in watchlist' }, { status: 409 });
      throw e;
    }
  } catch (e: any) {
    if (e.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// DELETE /api/watchlist?id=...
export async function DELETE(req: NextRequest) {
  try {
    const user = await requireSession();
    const id   = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    await db.query(
      `DELETE FROM watchlist_items wi
       USING watchlists w
       WHERE wi.id=? AND wi.watchlist_id=w.id AND w.user_id=?`,
      [id, user.id]
    );
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
