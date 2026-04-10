/**
 * Signal Pipeline — Centralized Signal Generation & Persistence
 *
 * This is the SINGLE place where signals are generated and stored.
 * All pages read from MySQL — no page computes signals independently.
 *
 * Flow:
 *   1. Load universe (rankings table → NSE fallback)
 *   2. Run generateSignal() for each instrument
 *   3. Persist approved signals → q365_signals
 *   4. Persist reasons → q365_signal_reasons
 *   5. Persist features → q365_signal_feature_snapshots
 *   6. Mark previous batch as 'replaced'
 */

import { db }                         from '@/lib/db';
import { cacheGet, cacheSet }         from '@/lib/redis';
import { generateSignal }             from './signalEngine';
import type { Signal }                from './signalEngine';
import { fetchGainersLosers }         from './nse';
import { savePhase3Artifacts }        from '@/lib/signal-engine/repository/savePhase3Signals';
import { saveDecisionMemory }         from '@/lib/signal-engine/repository/savePhase4Artifacts';
import { buildSignalTimeline }        from '@/lib/signal-engine/memory/decisionMemory';
import { ensureSignalEngineSchemas }  from '@/lib/signal-engine/repository/ensureSchemas';
import type { Phase3TradePlan, PositionSizingResult, PortfolioFitResult, ExecutionReadiness, SignalLifecycle } from '@/lib/signal-engine/types/phase3.types';

// ════════════════════════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════════════════════════

export interface PipelineResult {
  batch_id:       string;
  total_scanned:  number;
  total_approved: number;
  total_rejected: number;
  signals:        PipelineSignalSummary[];
  duration_ms:    number;
}

export interface PipelineSignalSummary {
  symbol:           string;
  direction:        string;
  confidence_score: number;
  opportunity_score:number;
  entry_price:      number;
  risk_reward:      number;
  scenario_tag:     string;
  conviction_band:  string;
}

// ════════════════════════════════════════════════════════════════
//  UNIVERSE LOADING
// ════════════════════════════════════════════════════════════════

interface UniverseItem {
  instrument_key: string;
  tradingsymbol:  string;
  exchange:       string;
}

async function seedNseCache(stocks: any[]): Promise<void> {
  await Promise.all(stocks.map(async (g: any) => {
    const sym = String(g.symbol ?? g.meta?.symbol ?? '').toUpperCase();
    if (!sym) return;
    await cacheSet(`stock:${sym}`, {
      symbol: sym, instrument_key: `NSE_EQ|${sym}`,
      ltp: Number(g.ltp ?? g.lastPrice ?? g.ltP ?? 0),
      open: Number(g.open ?? g.ltp ?? 0),
      high: Number(g.dayHigh ?? g.high ?? g.ltp ?? 0),
      low: Number(g.dayLow ?? g.low ?? g.ltp ?? 0),
      close: Number(g.previousClose ?? g.ltp ?? 0),
      volume: Number(g.tradedQuantity ?? g.totalTradedVolume ?? g.volume ?? 0),
      oi: 0,
      change_percent: Number(g.pChange ?? g.perChange ?? 0),
      change_abs: Number(g.netPrice ?? g.change ?? 0),
      vwap: null,
      week52_high: Number(g.yearHigh ?? g.week52High ?? 0),
      week52_low: Number(g.yearLow ?? g.week52Low ?? 0),
      atr14: null, delivery_pct: null,
      timestamp: Date.now(), source: 'nse' as const, data_quality: 0.9,
    }, 120);
  }));
}

async function loadUniverse(limit: number): Promise<UniverseItem[]> {
  const seen = new Set<string>();
  const result: UniverseItem[] = [];

  const addItem = (item: UniverseItem) => {
    if (!item.tradingsymbol || seen.has(item.tradingsymbol)) return;
    seen.add(item.tradingsymbol);
    result.push(item);
  };

  // ── Fetch NSE gainers + losers in parallel (always needed) ──
  const [gainersRaw, losersRaw] = await Promise.all([
    fetchGainersLosers('gainers').catch(() => []),
    fetchGainersLosers('losers').catch(() => []),
  ]);

  // Reserve half the slots for SELL candidates (losers)
  const sellSlots = Math.max(Math.ceil(limit * 0.4), 15);
  const buySlots  = limit - sellSlots;

  // ── BUY side: Rankings (top scores) + NSE gainers ──
  try {
    const { rows } = await db.query(
      `SELECT instrument_key, tradingsymbol, exchange, MAX(score) AS score
       FROM rankings
       GROUP BY tradingsymbol
       ORDER BY score DESC
       LIMIT ?`,
      [buySlots]
    );
    for (const r of rows as any[]) {
      addItem({
        instrument_key: r.instrument_key || `NSE_EQ|${r.tradingsymbol}`,
        tradingsymbol:  r.tradingsymbol,
        exchange:       r.exchange || 'NSE',
      });
    }
  } catch {}

  // Fill remaining BUY slots with NSE gainers
  if (result.length < buySlots && gainersRaw.length > 0) {
    const gainerSlice = gainersRaw.slice(0, buySlots - result.length);
    await seedNseCache(gainerSlice);
    for (const g of gainerSlice) {
      const sym = String(g.symbol ?? g.meta?.symbol ?? '').toUpperCase();
      addItem({ instrument_key: `NSE_EQ|${sym}`, tradingsymbol: sym, exchange: 'NSE' });
    }
  }

  const buyCount = result.length;

  // ── SELL side: NSE losers FIRST (stocks actually falling today) ──
  if (losersRaw.length > 0) {
    const loserSlice = losersRaw.slice(0, sellSlots);
    await seedNseCache(loserSlice);
    for (const g of loserSlice) {
      const sym = String(g.symbol ?? g.meta?.symbol ?? '').toUpperCase();
      addItem({ instrument_key: `NSE_EQ|${sym}`, tradingsymbol: sym, exchange: 'NSE' });
    }
  }

  // Fill remaining SELL slots with low-ranked stocks from rankings
  if (result.length < limit) {
    try {
      const { rows } = await db.query(
        `SELECT instrument_key, tradingsymbol, exchange, MIN(score) AS score
         FROM rankings
         GROUP BY tradingsymbol
         ORDER BY score ASC
         LIMIT ?`,
        [limit - result.length]
      );
      for (const r of rows as any[]) {
        addItem({
          instrument_key: r.instrument_key || `NSE_EQ|${r.tradingsymbol}`,
          tradingsymbol:  r.tradingsymbol,
          exchange:       r.exchange || 'NSE',
        });
      }
    } catch {}
  }

  const sellCount = result.length - buyCount;
  console.log(`[Pipeline] Universe: ${result.length} total — ${buyCount} buy-side, ${sellCount} sell-side`);
  return result.slice(0, limit);
}

// ════════════════════════════════════════════════════════════════
//  PERSISTENCE
// ════════════════════════════════════════════════════════════════

async function persistSignalFull(signal: Signal, batchId: string, status: string = 'active'): Promise<number | null> {
  try {
    const { rows } = await db.query(
      `INSERT INTO q365_signals
        (instrument_key, symbol, exchange, direction, timeframe, signal_type,
         confidence_score, confidence_band, risk_score, risk_band,
         opportunity_score, portfolio_fit_score, regime_alignment,
         entry_price, stop_loss, target1, target2, risk_reward,
         market_regime, market_stance, scenario_tag,
         factor_scores_json, ltp, pct_change,
         status, batch_id, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       RETURNING id`,
      [
        signal.instrument_key,
        signal.tradingsymbol,
        signal.exchange,
        signal.direction,
        signal.timeframe,
        signal.scenario_tag,
        signal.confidence,
        signal.conviction_band,
        signal.risk_score,
        signal.risk,
        signal.opportunity_score,
        signal.portfolio_fit,
        signal.regime_alignment,
        signal.entry_price,
        signal.stop_loss,
        signal.target1,
        signal.target2,
        signal.risk_reward,
        signal.regime,
        signal.market_stance,
        signal.scenario_tag,
        JSON.stringify(signal.factor_scores),
        signal.entry_price,
        0,
        status,
        batchId,
      ]
    );
    return (rows[0] as any)?.id ?? null;
  } catch (err) {
    console.error('[Pipeline] Failed to persist signal:', (err as Error).message);
    return null;
  }
}

async function persistReasons(signalId: number, signal: Signal): Promise<void> {
  // Insert reasons
  for (const reason of signal.reasons) {
    await db.query(
      `INSERT INTO q365_signal_reasons (signal_id, reason_type, message, factor_key, contribution)
       VALUES (?, 'reason', ?, ?, ?)`,
      [signalId, reason.text, reason.factor_key, reason.contribution]
    ).catch(() => {});
  }

  // Insert warnings
  for (const warning of signal.soft_warnings) {
    await db.query(
      `INSERT INTO q365_signal_reasons (signal_id, reason_type, message)
       VALUES (?, 'warning', ?)`,
      [signalId, warning]
    ).catch(() => {});
  }

  // Insert rejection reasons
  for (const rejection of signal.rejection_reasons) {
    await db.query(
      `INSERT INTO q365_signal_reasons (signal_id, reason_type, message)
       VALUES (?, 'rejection', ?)`,
      [signalId, rejection]
    ).catch(() => {});
  }
}

async function persistFeatures(signalId: number, signal: Signal): Promise<void> {
  const snapshot = {
    factor_scores:          signal.factor_scores,
    confidence_components:  signal.confidence_components,
    data_quality:           signal.data_quality,
    risk_reward:            signal.risk_reward,
    regime:                 signal.regime,
    market_stance:          signal.market_stance,
  };
  await db.query(
    `INSERT INTO q365_signal_feature_snapshots (signal_id, features_json)
     VALUES (?, ?)`,
    [signalId, JSON.stringify(snapshot)]
  ).catch(() => {});
}

// ════════════════════════════════════════════════════════════════
//  PHASE 3 + 4 ENRICHMENT
//  Translates the production Signal into Phase 3/4 typed artifacts
//  and persists them so the new audit tables stay populated even
//  while the old engine produces the actual signal.
// ════════════════════════════════════════════════════════════════

async function persistPhase3Enrichment(signalId: number, signal: Signal): Promise<void> {
  const isShort = signal.direction === 'SELL';
  const initialRiskPerUnit = Math.abs(signal.entry_price - signal.stop_loss);
  if (initialRiskPerUnit <= 0) return;

  const target3 = isShort
    ? signal.entry_price - 3.5 * initialRiskPerUnit
    : signal.entry_price + 3.5 * initialRiskPerUnit;

  const tradePlan: Phase3TradePlan = {
    entryType: 'breakout_confirmation',
    entryZoneLow: Math.round((signal.entry_price * 0.998) * 100) / 100,
    entryZoneHigh: Math.round(signal.entry_price * 100) / 100,
    stopLoss: signal.stop_loss,
    initialRiskPerUnit: Math.round(initialRiskPerUnit * 100) / 100,
    target1: signal.target1,
    target2: signal.target2,
    target3: Math.round(target3 * 100) / 100,
    rrTarget1: signal.risk_reward,
    rrTarget2: Math.round(((Math.abs(signal.target2 - signal.entry_price) / initialRiskPerUnit) || 0) * 10) / 10,
    rrTarget3: 3.5,
  };

  // Position sizing — derived from confidence + risk score
  const portfolioCapital = 1_000_000; // canonical default
  const riskBudgetPct = signal.confidence >= 75 ? 1.0 : signal.confidence >= 60 ? 0.75 : 0.5;
  const riskBudgetAmount = portfolioCapital * (riskBudgetPct / 100);
  const positionSizeUnits = initialRiskPerUnit > 0 ? Math.floor(riskBudgetAmount / initialRiskPerUnit) : 0;

  const sizing: PositionSizingResult = {
    capitalModel: 'fixed_fractional',
    portfolioCapital,
    riskBudgetPct,
    riskBudgetAmount: Math.round(riskBudgetAmount * 100) / 100,
    initialRiskPerUnit: tradePlan.initialRiskPerUnit,
    positionSizeUnits,
    grossPositionValue: Math.round(positionSizeUnits * signal.entry_price * 100) / 100,
    validationStatus: positionSizeUnits > 0 ? 'valid' : 'invalid',
    warnings: [],
  };

  // Portfolio fit — translated from production portfolio_fit score
  const fit: PortfolioFitResult = {
    fitScore: signal.portfolio_fit ?? 50,
    sectorExposureImpact: signal.portfolio_fit >= 70 ? 'acceptable' : signal.portfolio_fit >= 50 ? 'moderate' : 'high',
    directionImpact: 'acceptable',
    capitalAvailability: 'sufficient',
    correlationCluster: null,
    correlationPenalty: 0,
    portfolioDecision: signal.rejection_reasons.length === 0 ? 'approved' : 'rejected',
    penalties: signal.soft_warnings ?? [],
  };

  // Execution readiness — translated from rejection state + conviction band
  const approval: ExecutionReadiness['approvalDecision'] =
    signal.rejection_reasons.length > 0 ? 'rejected'
    : signal.conviction_band === 'reject' ? 'rejected'
    : signal.conviction_band === 'watchlist' ? 'deferred'
    : 'approved';

  const status: ExecutionReadiness['status'] =
    approval === 'approved' ? 'ready'
    : approval === 'deferred' ? 'watchlist_only'
    : signal.blocked_by?.risk ? 'rejected_due_to_risk'
    : signal.blocked_by?.portfolio ? 'deferred_due_to_portfolio'
    : 'rejected_due_to_reward_risk';

  const actionTag: ExecutionReadiness['actionTag'] =
    approval === 'approved' && signal.conviction_band === 'high_conviction' ? 'enter_now'
    : approval === 'approved' ? 'enter_on_confirmation'
    : approval === 'deferred' ? 'watch_only'
    : 'avoid';

  const readiness: ExecutionReadiness = {
    status, actionTag, priorityRank: null,
    approvalDecision: approval,
    reasons: [...(signal.rejection_reasons ?? []), ...(signal.soft_warnings ?? [])],
  };

  // Lifecycle — initial state
  const lifecycle: SignalLifecycle = {
    state: approval === 'approved' ? 'approved' : approval === 'deferred' ? 'generated' : 'rejected',
    reason: approval === 'approved' ? 'all_gates_passed' : (signal.rejection_reasons[0] ?? 'deferred_to_watchlist'),
    changedAt: signal.generated_at,
  };

  await savePhase3Artifacts(signalId, tradePlan, sizing, fit, readiness, lifecycle);
}

async function persistPhase4DecisionMemory(signalId: number, signal: Signal): Promise<void> {
  const timeline = buildSignalTimeline(signalId, [
    {
      stage: 'phase1_scan',
      message: `Scanned ${signal.tradingsymbol}: direction=${signal.direction}, raw_score=${signal.score_raw ?? 0}`,
      payload: { instrument_key: signal.instrument_key, ltp: signal.entry_price },
    },
    {
      stage: 'phase2_strategy',
      message: `Strategy=${signal.scenario_tag}, confidence=${signal.confidence}, regime=${signal.regime}`,
      payload: { factor_scores: signal.factor_scores, conviction_band: signal.conviction_band },
    },
    {
      stage: 'phase3_execution',
      message: `Approval=${signal.rejection_reasons.length === 0 ? 'approved' : 'rejected'}, fit=${signal.portfolio_fit}, risk=${signal.risk_score}`,
      payload: { rejection_reasons: signal.rejection_reasons, soft_warnings: signal.soft_warnings, blocked_by: signal.blocked_by },
    },
    {
      stage: 'phase4_enrichment',
      message: `Stance=${signal.market_stance}, regime_alignment=${signal.regime_alignment}, opportunity=${signal.opportunity_score}`,
      payload: { confidence_components: signal.confidence_components ?? {} },
    },
  ]);
  await saveDecisionMemory(timeline);
}

// ════════════════════════════════════════════════════════════════
//  MAIN PIPELINE
// ════════════════════════════════════════════════════════════════

export async function runSignalPipeline(limit = 60): Promise<PipelineResult> {
  const start   = Date.now();
  const batchId = `batch_${Date.now()}`;

  console.log(`[Pipeline] Starting batch ${batchId} — limit ${limit}`);

  // Ensure all Phase 3/4 audit tables exist before persisting enriched artifacts
  await ensureSignalEngineSchemas().catch(err =>
    console.error('[Pipeline] Schema ensure failed (non-blocking):', (err as Error).message),
  );

  // Step 1: Load universe
  const universe = await loadUniverse(limit);
  if (universe.length === 0) {
    return {
      batch_id: batchId, total_scanned: 0, total_approved: 0,
      total_rejected: 0, signals: [], duration_ms: Date.now() - start,
    };
  }

  console.log(`[Pipeline] Universe loaded: ${universe.length} instruments`);

  // Step 2: Mark previous signals as 'replaced'
  await db.query(
    `UPDATE q365_signals SET status = 'replaced' WHERE status IN ('active', 'flagged')`
  ).catch(() => {});

  // Step 3: Generate signals in batches of 5
  const BATCH    = 5;
  let approved   = 0;
  let rejected   = 0;

  const allSignals: Array<{ signal: Signal; isApproved: boolean }> = [];

  for (let i = 0; i < universe.length; i += BATCH) {
    const chunk = universe.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(item =>
        generateSignal(item.instrument_key, item.tradingsymbol, item.exchange)
          .catch(() => null)
      )
    );

    for (const sig of results) {
      if (!sig) { rejected++; continue; }

      const isApproved = sig.rejection_reasons.length === 0;
      if (!isApproved) {
        rejected++;
        console.log(`[Pipeline] REJECTED ${sig.tradingsymbol} [${sig.direction}]: ${sig.rejection_reasons.join(' | ')}`);
      } else {
        approved++;
        console.log(`[Pipeline] APPROVED ${sig.tradingsymbol} [${sig.direction}] conf=${sig.confidence} opp=${sig.opportunity_score} strategy=${sig.scenario_tag}`);
      }

      // Persist ALL signals that have a valid direction and price
      if (sig.direction !== 'HOLD' && sig.entry_price > 0) {
        allSignals.push({ signal: sig, isApproved });
      } else {
        console.log(`[Pipeline] SKIPPED ${sig.tradingsymbol} [${sig.direction}] — direction=HOLD or entry=0`);
      }
    }
  }

  // Deduplicate by symbol (keep highest opportunity_score)
  const bySymbol = new Map<string, typeof allSignals[0]>();
  for (const item of allSignals) {
    const existing = bySymbol.get(item.signal.tradingsymbol);
    if (!existing || item.signal.opportunity_score > existing.signal.opportunity_score) {
      bySymbol.set(item.signal.tradingsymbol, item);
    }
  }
  const dedupedSignals = Array.from(bySymbol.values())
    .sort((a, b) => b.signal.opportunity_score - a.signal.opportunity_score);

  // Step 4: Persist all signals (approved as 'active', rejected as 'flagged')
  // Phase 3+4 enrichment is also persisted alongside the base signal record.
  for (const { signal, isApproved } of dedupedSignals) {
    const signalId = await persistSignalFull(signal, batchId, isApproved ? 'active' : 'flagged');
    if (signalId) {
      await Promise.all([
        persistReasons(signalId, signal),
        persistFeatures(signalId, signal),
        persistPhase3Enrichment(signalId, signal).catch(err => console.error('[Pipeline] Phase3 persist failed:', (err as Error).message)),
        persistPhase4DecisionMemory(signalId, signal).catch(err => console.error('[Pipeline] Phase4 memory persist failed:', (err as Error).message)),
      ]);
    }
  }

  // Step 5: Cache batch metadata
  await cacheSet('pipeline:last_batch', {
    batch_id:  batchId,
    count:     dedupedSignals.length,
    scanned:   universe.length,
    timestamp: new Date().toISOString(),
  }, 3600);

  const duration = Date.now() - start;
  const buyCount  = dedupedSignals.filter(a => a.signal.direction === 'BUY').length;
  const sellCount = dedupedSignals.filter(a => a.signal.direction === 'SELL').length;
  const holdCount = dedupedSignals.filter(a => a.signal.direction === 'HOLD').length;
  console.log(`[Pipeline] Batch ${batchId} complete — ${approved} approved, ${rejected} rejected, ${dedupedSignals.length} persisted (${buyCount} BUY, ${sellCount} SELL, ${holdCount} HOLD) in ${duration}ms`);

  return {
    batch_id:       batchId,
    total_scanned:  universe.length,
    total_approved: approved,
    total_rejected: rejected,
    signals:        dedupedSignals.map(a => ({
      symbol:           a.signal.tradingsymbol,
      direction:        a.signal.direction,
      confidence_score: a.signal.confidence,
      opportunity_score:a.signal.opportunity_score,
      entry_price:      a.signal.entry_price,
      risk_reward:      a.signal.risk_reward,
      scenario_tag:     a.signal.scenario_tag,
      conviction_band:  a.signal.conviction_band,
    })),
    duration_ms:    duration,
  };
}

// ════════════════════════════════════════════════════════════════
//  DB READERS — used by all GET APIs
// ════════════════════════════════════════════════════════════════

/** Get all active signals (for /signals page) */
export async function getActiveSignals(limit = 50): Promise<any[]> {
  const { rows } = await db.query(`
    SELECT
      s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
      s.signal_type, s.confidence_score, s.confidence_band,
      s.risk_score, s.risk_band, s.opportunity_score,
      s.portfolio_fit_score, s.regime_alignment,
      s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
      s.market_regime, s.market_stance, s.scenario_tag,
      s.factor_scores_json, s.ltp, s.pct_change,
      s.status, s.batch_id, s.generated_at
    FROM q365_signals s
    WHERE s.status IN ('active', 'flagged')
    ORDER BY s.opportunity_score DESC
    LIMIT ?
  `, [limit]);

  return (rows as any[]).map(r => ({
    id:                r.id,
    instrument_key:    r.instrument_key,
    tradingsymbol:     r.symbol,
    exchange:          r.exchange,
    direction:         r.direction,
    timeframe:         r.timeframe,
    signal_type:       r.signal_type,
    confidence:        r.confidence_score,
    confidence_score:  r.confidence_score,
    conviction_band:   r.confidence_band,
    risk_score:        r.risk_score,
    risk:              r.risk_band,
    opportunity_score: r.opportunity_score,
    portfolio_fit:     r.portfolio_fit_score,
    regime_alignment:  r.regime_alignment,
    entry_price:       Number(r.entry_price),
    stop_loss:         Number(r.stop_loss),
    target1:           Number(r.target1),
    target2:           r.target2 ? Number(r.target2) : null,
    risk_reward:       Number(r.risk_reward),
    regime:            r.market_regime,
    market_stance:     r.market_stance,
    scenario_tag:      r.scenario_tag,
    factor_scores:     typeof r.factor_scores_json === 'string'
      ? JSON.parse(r.factor_scores_json) : r.factor_scores_json,
    ltp:               r.ltp ? Number(r.ltp) : null,
    pct_change:        r.pct_change ? Number(r.pct_change) : null,
    status:            r.status,
    approved:          r.status === 'active',
    batch_id:          r.batch_id,
    generated_at:      r.generated_at,
  }));
}

/** Get top N signals for dashboard */
export async function getTopSignals(limit = 10): Promise<any[]> {
  return getActiveSignals(limit);
}

// ── Strategy group mapping ────────────────────────────────────────
// Maps scenario_tag + direction to human-readable strategy groups
const STRATEGY_GROUP_MAP: Record<string, { buy: string; sell: string }> = {
  TREND_CONTINUATION:        { buy: 'bullish_trend',       sell: 'bearish_trend' },
  BREAKOUT_CONTINUATION:     { buy: 'bullish_breakout',    sell: 'bearish_breakdown' },
  PULLBACK_IN_TREND:         { buy: 'bullish_pullback',    sell: 'bearish_pullback' },
  MEAN_REVERSION:            { buy: 'mean_reversion_bounce', sell: 'mean_reversion_fade' },
  MOMENTUM_EXPANSION:        { buy: 'bullish_momentum',    sell: 'bearish_momentum' },
  RELATIVE_STRENGTH_LEADER:  { buy: 'relative_strength',   sell: 'relative_weakness' },
  VOLATILITY_COMPRESSION:    { buy: 'volatility_breakout', sell: 'volatility_breakdown' },
  EVENT_DRIVEN:              { buy: 'event_driven_long',   sell: 'event_driven_short' },
  SECTOR_ROTATION:           { buy: 'sector_rotation',     sell: 'sector_rotation' },
  WATCHLIST_OPPORTUNITY:     { buy: 'watchlist_long',      sell: 'watchlist_short' },
  NO_STRATEGY:               { buy: 'unclassified',        sell: 'unclassified' },
};

const STRATEGY_DISPLAY: Record<string, string> = {
  bullish_trend:        'Bullish Trend',
  bearish_trend:        'Bearish Trend',
  bullish_breakout:     'Bullish Breakout',
  bearish_breakdown:    'Bearish Breakdown',
  bullish_pullback:     'Bullish Pullback',
  bearish_pullback:     'Bearish Pullback',
  mean_reversion_bounce:'Mean Reversion Bounce',
  mean_reversion_fade:  'Mean Reversion Fade',
  bullish_momentum:     'Bullish Momentum',
  bearish_momentum:     'Bearish Momentum',
  relative_strength:    'Relative Strength',
  relative_weakness:    'Relative Weakness',
  volatility_breakout:  'Volatility Breakout',
  volatility_breakdown: 'Volatility Breakdown',
  event_driven_long:    'Event Driven Long',
  event_driven_short:   'Event Driven Short',
  sector_rotation:      'Sector Rotation',
  watchlist_long:       'Watchlist Long',
  watchlist_short:      'Watchlist Short',
  unclassified:         'Unclassified',
};

function resolveStrategyGroup(scenarioTag: string, direction: string): string {
  const mapping = STRATEGY_GROUP_MAP[scenarioTag];
  if (!mapping) return direction === 'SELL' ? 'bearish_trend' : 'bullish_trend';
  return direction === 'SELL' ? mapping.sell : mapping.buy;
}

function resolveStrengthTag(confidence: number): string {
  if (confidence >= 85) return 'High Conviction';
  if (confidence >= 70) return 'Actionable';
  if (confidence >= 55) return 'Watchlist';
  return 'Ignore';
}

function resolveMarketContextTag(regime: string): string {
  if (['STRONG_BULL', 'BULL'].includes(regime)) return 'Bullish';
  if (['STRONG_BEAR', 'BEAR'].includes(regime)) return 'Weak';
  return 'Neutral';
}

export interface IntelligenceSignal {
  id:                number;
  tradingsymbol:     string;
  exchange:          string;
  direction:         string;
  timeframe:         string;
  signal_type:       string;
  signal_subtype:    string;
  strategy_group:    string;
  strategy_display:  string;
  confidence_score:  number;
  conviction_band:   string;
  strength_tag:      string;
  market_context_tag:string;
  risk_score:        number;
  risk:              string;
  opportunity_score: number;
  entry_price:       number;
  stop_loss:         number;
  target1:           number;
  target2:           number | null;
  risk_reward:       number;
  regime:            string;
  market_stance:     string;
  scenario_tag:      string;
  factor_scores:     Record<string, number> | null;
  ltp:               number | null;
  pct_change:        number | null;
  status:            string;
  approved:          boolean;
  reasons:           Array<{ type: string; message: string; factor_key?: string; contribution?: number }>;
  warnings:          string[];
  generated_at:      string;
}

/** Get signals grouped by strategy/category for intelligence page */
export async function getIntelligenceSignals(): Promise<{
  buySignals:    Record<string, IntelligenceSignal[]>;
  sellSignals:   Record<string, IntelligenceSignal[]>;
  by_direction:  Record<string, IntelligenceSignal[]>;
  by_strategy:   Record<string, IntelligenceSignal[]>;
  by_conviction: Record<string, IntelligenceSignal[]>;
  summary:       {
    total: number; buy: number; sell: number; hold: number;
    avg_confidence: number; avg_rr: number;
    buy_avg_confidence: number; sell_avg_confidence: number;
    conviction_distribution: Record<string, number>;
  };
}> {
  const signals = await getActiveSignals(100);

  // Batch-fetch reasons for all signals
  const signalIds = signals.map((s: any) => s.id).filter(Boolean);
  const reasonsMap = new Map<number, Array<{ type: string; message: string; factor_key?: string; contribution?: number }>>();
  const warningsMap = new Map<number, string[]>();

  if (signalIds.length > 0) {
    try {
      const placeholders = signalIds.map(() => '?').join(',');
      const { rows } = await db.query(
        `SELECT signal_id, reason_type, message, factor_key, contribution
         FROM q365_signal_reasons WHERE signal_id IN (${placeholders}) ORDER BY id`,
        signalIds
      );
      for (const r of rows as any[]) {
        const sid = r.signal_id;
        if (r.reason_type === 'warning') {
          if (!warningsMap.has(sid)) warningsMap.set(sid, []);
          warningsMap.get(sid)!.push(r.message);
        } else {
          if (!reasonsMap.has(sid)) reasonsMap.set(sid, []);
          reasonsMap.get(sid)!.push({
            type: r.reason_type, message: r.message,
            factor_key: r.factor_key ?? undefined,
            contribution: r.contribution != null ? Number(r.contribution) : undefined,
          });
        }
      }
    } catch {}
  }

  const buySignals:    Record<string, IntelligenceSignal[]> = {};
  const sellSignals:   Record<string, IntelligenceSignal[]> = {};
  const by_direction:  Record<string, IntelligenceSignal[]> = {};
  const by_strategy:   Record<string, IntelligenceSignal[]> = {};
  const by_conviction: Record<string, IntelligenceSignal[]> = {};
  const convictionDist: Record<string, number> = { high_conviction: 0, actionable: 0, watchlist: 0, reject: 0 };

  let totalConf = 0, totalRR = 0;
  let buy = 0, sell = 0, hold = 0;
  let buyConfTotal = 0, sellConfTotal = 0;

  for (const s of signals) {
    const dir       = s.direction || 'HOLD';
    const regime    = s.regime || 'NEUTRAL';
    const scenario  = s.scenario_tag || 'NO_STRATEGY';
    const conf      = s.confidence_score || 0;
    const band      = s.conviction_band || 'watchlist';

    const stratGroup   = resolveStrategyGroup(scenario, dir);
    const stratDisplay = STRATEGY_DISPLAY[stratGroup] || stratGroup.replace(/_/g, ' ');
    const strengthTag  = resolveStrengthTag(conf);
    const contextTag   = resolveMarketContextTag(regime);

    const enriched: IntelligenceSignal = {
      ...s,
      signal_type:        dir === 'BUY' ? 'LONG' : dir === 'SELL' ? 'SHORT' : 'NEUTRAL',
      signal_subtype:     scenario.toLowerCase(),
      strategy_group:     stratGroup,
      strategy_display:   stratDisplay,
      strength_tag:       strengthTag,
      market_context_tag: contextTag,
      conviction_band:    band,
      reasons:            reasonsMap.get(s.id) ?? [],
      warnings:           warningsMap.get(s.id) ?? [],
    };

    // By direction
    if (!by_direction[dir]) by_direction[dir] = [];
    by_direction[dir].push(enriched);

    // BUY/SELL strategy groups
    if (dir === 'BUY') {
      buy++;
      buyConfTotal += conf;
      if (!buySignals[stratGroup]) buySignals[stratGroup] = [];
      buySignals[stratGroup].push(enriched);
    } else if (dir === 'SELL') {
      sell++;
      sellConfTotal += conf;
      if (!sellSignals[stratGroup]) sellSignals[stratGroup] = [];
      sellSignals[stratGroup].push(enriched);
    } else {
      hold++;
    }

    // By strategy (full tag)
    if (!by_strategy[stratGroup]) by_strategy[stratGroup] = [];
    by_strategy[stratGroup].push(enriched);

    // By conviction
    if (!by_conviction[band]) by_conviction[band] = [];
    by_conviction[band].push(enriched);
    if (convictionDist[band] != null) convictionDist[band]++;

    totalConf += conf;
    totalRR   += s.risk_reward || 0;
  }

  // Sort each group by opportunity score descending
  const sortGroup = (group: Record<string, IntelligenceSignal[]>) => {
    for (const key of Object.keys(group)) {
      group[key].sort((a, b) => b.opportunity_score - a.opportunity_score);
    }
  };
  sortGroup(buySignals);
  sortGroup(sellSignals);
  sortGroup(by_strategy);

  return {
    buySignals,
    sellSignals,
    by_direction,
    by_strategy,
    by_conviction,
    summary: {
      total:          signals.length,
      buy, sell, hold,
      avg_confidence:      signals.length > 0 ? Math.round(totalConf / signals.length) : 0,
      avg_rr:              signals.length > 0 ? parseFloat((totalRR / signals.length).toFixed(1)) : 0,
      buy_avg_confidence:  buy > 0 ? Math.round(buyConfTotal / buy) : 0,
      sell_avg_confidence: sell > 0 ? Math.round(sellConfTotal / sell) : 0,
      conviction_distribution: convictionDist,
    },
  };
}

/** Get signal reasons for a specific signal */
export async function getSignalReasons(signalId: number): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT reason_type, message, factor_key, contribution
     FROM q365_signal_reasons WHERE signal_id = ? ORDER BY id`,
    [signalId]
  );
  return rows as any[];
}

/** Get market regime from the latest batch */
export async function getLatestRegime(): Promise<string> {
  try {
    const cached = await cacheGet<{ regime: string }>('market:regime');
    if (cached?.regime) return cached.regime;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT market_regime FROM q365_signals WHERE status IN ('active','flagged') ORDER BY created_at DESC LIMIT 1`
    );
    return (rows[0] as any)?.market_regime ?? 'NEUTRAL';
  } catch {}

  return 'NEUTRAL';
}

/** Get signal stats for the last 7 days */
export async function getSignalStats(): Promise<any> {
  try {
    const [overviewRes, convictionRes, scenarioRes] = await Promise.allSettled([
      db.query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
               AVG(confidence_score) AS avg_confidence,
               AVG(risk_reward) AS avg_rr
        FROM q365_signals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      `),
      db.query(`
        SELECT confidence_band, COUNT(*) AS count
        FROM q365_signals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY confidence_band
      `),
      db.query(`
        SELECT scenario_tag, COUNT(*) AS count, AVG(confidence_score) AS avg_conf
        FROM q365_signals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY scenario_tag ORDER BY count DESC
      `),
    ]);

    return {
      overview:      overviewRes.status === 'fulfilled'  ? overviewRes.value.rows[0]  : null,
      by_conviction: convictionRes.status === 'fulfilled' ? convictionRes.value.rows   : [],
      by_scenario:   scenarioRes.status === 'fulfilled'   ? scenarioRes.value.rows     : [],
    };
  } catch {
    return { overview: null, by_conviction: [], by_scenario: [] };
  }
}
