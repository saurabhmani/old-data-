/**
 * GET /api/signals
 *
 * All signals pass through the complete Quantorus365 decision chain:
 *   1. Market data ingestion
 *   2. Scenario detection
 *   3. Market stance (threshold config)
 *   4. Factor scoring
 *   5. Portfolio fit
 *   6. Confidence scoring
 *   7. Rejection engine (all gates)
 *   Only then → emitted to user
 *
 * Response includes: confidence_score, risk_score, portfolio_fit_score,
 * scenario_tag, market_stance, rejection_reasons, approved,
 * conviction_band, regime_alignment_score
 */
import { NextRequest, NextResponse }  from 'next/server';
import { requireSession }             from '@/lib/session';
import { db }                         from '@/lib/db';
import {
  generateSignal,
  generateSignalsForWatchlist,
  opportunityScore,
  persistSignal,
  logRejection,
}                                     from '@/services/signalEngine';
import { getRejectionAnalysis }       from '@/services/performanceTracker';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const action   = searchParams.get('action') || 'top';
  const symParam = searchParams.get('symbol');
  const keyParam = searchParams.get('key');
  const limit    = Math.min(parseInt(searchParams.get('limit') || '20'), 100);

  // ── Single instrument signal ────────────────────────────────
  if (action === 'instrument' && (symParam || keyParam)) {
    const identifier = symParam ?? keyParam!;
    const { rows }   = await db.query(
      `SELECT tradingsymbol, exchange, instrument_key FROM instruments
       WHERE tradingsymbol=? OR instrument_key=? LIMIT 1`,
      [identifier, identifier]
    );
    const inst = rows[0] as any;
    if (!inst) return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });

    const signal = await generateSignal(inst.instrument_key, inst.tradingsymbol, inst.exchange);
    if (!signal) {
      return NextResponse.json({ error: 'No data available' }, { status: 503 });
    }

    if (signal.rejection_reasons.length > 0) {
      await logRejection(inst.instrument_key, inst.tradingsymbol, signal.rejection_reasons);
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

    await persistSignal(signal);
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

  // ── Top opportunities ──────────────────────────────────────
  if (action === 'top') {
    let rows: any[] = [];
    try {
      const r = await db.query(
        `SELECT instrument_key, tradingsymbol, exchange FROM rankings
         ORDER BY score DESC LIMIT ?`,
        [limit * 4] // over-fetch to account for rejections
      );
      rows = r.rows || [];
    } catch {}

    if (!rows.length) {
      return NextResponse.json({
        signals: [],
        note: 'No ranked instruments. Run Admin → Data Management → Sync Rankings first.',
      });
    }

    const items = rows
      .map(r => ({
        instrument_key: r.instrument_key || `NSE_EQ|${r.tradingsymbol}`,
        tradingsymbol:  r.tradingsymbol  || '',
        exchange:       r.exchange       || 'NSE',
      }))
      .filter(r => r.tradingsymbol);

    const signals = await generateSignalsForWatchlist(items);
    for (const s of signals) { await persistSignal(s); }

    return NextResponse.json({
      signals: signals.slice(0, limit).map(s => ({
        ...s,
        opportunity_score:  opportunityScore(s),
        conviction_band:    s.conviction_band,
        confidence_score:   s.confidence,
        risk_score:         s.risk_score,
        portfolio_fit_score:s.portfolio_fit,
        scenario_tag:       s.scenario_tag,
        market_stance:      s.market_stance,
        regime_alignment:   s.regime_alignment,
      })),
      count:           signals.length,
      total_evaluated: items.length,
      approval_rate:   items.length > 0
        ? parseFloat((signals.length / items.length * 100).toFixed(1))
        : 0,
    });
  }

  // ── Rejection analysis ─────────────────────────────────────
  if (action === 'rejections') {
    const analysis = await getRejectionAnalysis();
    return NextResponse.json({ rejections: analysis });
  }

  // ── History ─────────────────────────────────────────────────
  if (action === 'history') {
    const sym = symParam ?? keyParam ?? '';
    if (!sym) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const { rows } = await db.query(`
      SELECT signal_type, strength, confidence, confidence_score,
             risk_score, scenario_tag, market_stance, regime,
             conviction_band, description, generated_at
      FROM signals
      WHERE tradingsymbol=? OR instrument_key=?
      ORDER BY generated_at DESC LIMIT 20
    `, [sym, sym]);
    return NextResponse.json({ history: rows, symbol: sym });
  }

  // ── Stats ───────────────────────────────────────────────────
  if (action === 'stats') {
    const [overview, byConviction, byScenario] = await Promise.allSettled([
      db.query(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN approved=1 THEN 1 ELSE 0 END) AS approved,
          AVG(CASE WHEN approved=1 THEN confidence_score ELSE NULL END) AS avg_confidence
        FROM signal_rejections
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      `),
      db.query(`
        SELECT conviction_band, COUNT(*) AS count
        FROM signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY conviction_band
      `),
      db.query(`
        SELECT scenario_tag, COUNT(*) AS count, AVG(confidence) AS avg_conf
        FROM signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY scenario_tag ORDER BY count DESC
      `),
    ]);

    return NextResponse.json({
      overview:      overview.status === 'fulfilled'     ? overview.value.rows[0]     : null,
      by_conviction: byConviction.status === 'fulfilled' ? byConviction.value.rows    : [],
      by_scenario:   byScenario.status === 'fulfilled'   ? byScenario.value.rows      : [],
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
