/**
 * GET /api/signals
 *
 * All signals come from the centralized q365_signals table.
 * Pipeline writes once → all pages read from here.
 *
 * Actions:
 *   ?action=top     — top N signals by opportunity score (default)
 *   ?action=all     — all active signals
 *   ?action=stats   — 7-day signal statistics
 *   ?action=instrument&symbol=TCS — live per-instrument deep analysis (keeps real-time search)
 *   ?action=history&symbol=TCS    — signal history for a symbol
 */
import { NextRequest, NextResponse }  from 'next/server';
import { requireSession }             from '@/lib/session';
import { db }                         from '@/lib/db';
import {
  getActiveSignals,
  getTopSignals,
  getSignalStats,
}                                     from '@/services/signalPipeline';
import {
  generateSignal,
  opportunityScore,
}                                     from '@/services/signalEngine';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const action   = searchParams.get('action') || 'top';
  const symParam = searchParams.get('symbol')?.trim().replace(/\s+/g, '') || null;
  const keyParam = searchParams.get('key')?.trim().replace(/\s+/g, '') || null;
  const limit    = Math.min(parseInt(searchParams.get('limit') || '20'), 100);

  try {
    // ── Single instrument — live analysis (keep for deep search) ──
    if (action === 'instrument' && (symParam || keyParam)) {
      const identifier = symParam ?? keyParam!;
      const sym  = identifier.includes('|') ? identifier.split('|')[1].toUpperCase() : identifier.toUpperCase();
      const ikey = identifier.includes('|') ? identifier : `NSE_EQ|${sym}`;

      const dbResult = await db.query(
        `SELECT tradingsymbol, exchange, instrument_key FROM instruments
         WHERE tradingsymbol=? OR instrument_key=? LIMIT 1`,
        [sym, ikey]
      ).catch(() => ({ rows: [] }));

      const inst = (dbResult.rows[0] as any) ?? {
        tradingsymbol: sym, exchange: 'NSE', instrument_key: ikey,
      };
      if (!inst.tradingsymbol) {
        return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
      }

      const signal = await generateSignal(inst.instrument_key, inst.tradingsymbol, inst.exchange);
      if (!signal) {
        return NextResponse.json({ error: 'No data available' }, { status: 503 });
      }

      if (signal.rejection_reasons.length > 0) {
        return NextResponse.json({
          signal:            null,
          approved:          false,
          rejection_reasons: signal.rejection_reasons,
          rejection_codes:   signal.rejection_codes,
          soft_warnings:     signal.soft_warnings,
          factor_scores:     signal.factor_scores,
          confidence_score:  signal.confidence,
          composite_score:   Math.round(signal.score_raw * 100),
          portfolio_fit:     signal.portfolio_fit,
          conviction_band:   signal.conviction_band,
          regime:            signal.regime,
          scenario_tag:      signal.scenario_tag,
          market_stance:     signal.market_stance,
        });
      }

      return NextResponse.json({
        signal,
        approved:           true,
        opportunity_score:  opportunityScore(signal),
        conviction_band:    signal.conviction_band,
        confidence_score:   signal.confidence,
        risk_score:         signal.risk_score,
        portfolio_fit_score:signal.portfolio_fit,
        scenario_tag:       signal.scenario_tag,
        market_stance:      signal.market_stance,
        regime_alignment:   signal.regime_alignment,
      });
    }

    // ── Top signals from DB ──────────────────────────────────────
    if (action === 'top') {
      const signals = await getTopSignals(limit);
      return NextResponse.json({
        signals,
        count:  signals.length,
        source: 'database',
      });
    }

    // ── All active signals from DB ───────────────────────────────
    if (action === 'all') {
      const signals = await getActiveSignals(limit);
      return NextResponse.json({
        signals,
        count:  signals.length,
        source: 'database',
      });
    }

    // ── Signal stats (7-day) ─────────────────────────────────────
    if (action === 'stats') {
      const stats = await getSignalStats();
      return NextResponse.json(stats);
    }

    // ── Signal history for a symbol ──────────────────────────────
    if (action === 'history') {
      const sym = symParam ?? keyParam ?? '';
      if (!sym) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
      const { rows } = await db.query(`
        SELECT direction, signal_type, confidence_score, confidence_band,
               risk_score, risk_band, opportunity_score,
               entry_price, stop_loss, target1, risk_reward,
               market_regime, market_stance, scenario_tag,
               generated_at
        FROM q365_signals
        WHERE symbol=?
        ORDER BY generated_at DESC LIMIT 20
      `, [sym.toUpperCase()]);
      return NextResponse.json({ history: rows, symbol: sym });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    console.error('[/api/signals]', err?.message);
    return NextResponse.json({ error: 'Server error', details: err?.message }, { status: 500 });
  }
}
