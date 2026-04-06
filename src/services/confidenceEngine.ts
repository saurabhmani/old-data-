/**
 * Confidence Engine — Quantorus365
 *
 * Confidence is NOT prediction certainty.
 * Confidence is DECISION QUALITY confidence.
 *
 * It represents how strongly multiple independent decision layers agree
 * that a given setup is worth acting on.
 *
 * Formula:
 *   confidence_score =
 *     factor_alignment     * 0.22 +
 *     strategy_clarity     * 0.14 +
 *     regime_alignment     * 0.14 +
 *     liquidity_quality    * 0.10 +
 *     data_quality         * 0.08 +
 *     portfolio_fit        * 0.12 +
 *     participation        * 0.06 +
 *     rr_quality           * 0.08 +
 *     volatility_fit       * 0.06
 *
 * Bands:
 *   85–100 = high conviction
 *   70–84  = actionable
 *   55–69  = watchlist / conditional
 *   below 55 = reject or hold for review
 */

import { db }                            from '@/lib/db';
import { getConfig, getConfidenceWeights, scoreRRAgainstConfig } from './systemConfigService';
import type { FactorScores }     from './signalEngine';
import type { ScenarioResult }   from './scenarioEngine';
import type { MarketSnapshot }   from './marketDataService';

// ════════════════════════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════════════════════════

export type ConvictionBand =
  | 'high_conviction'
  | 'actionable'
  | 'watchlist'
  | 'reject';

export interface ConfidenceComponents {
  factor_alignment:    number;   // 0–100
  strategy_clarity:    number;
  regime_alignment:    number;
  liquidity_quality:   number;
  data_quality:        number;
  portfolio_fit:       number;
  participation:       number;
  rr_quality:          number;
  volatility_fit:      number;
}

export interface ConfidenceResult {
  confidence_score:    number;         // 0–100 final weighted score
  conviction_band:     ConvictionBand;
  components:          ConfidenceComponents;
  confidence_note:     string;         // explanation of why it is this level
  penalized_by:        string[];       // list of factors that dragged it down
  supported_by:        string[];       // list of factors that boosted it
}

// ════════════════════════════════════════════════════════════════
//  COMPONENT WEIGHTS (can be overridden from system_thresholds DB)
// ════════════════════════════════════════════════════════════════

// Weights are loaded from systemConfigService (DB-configurable)
// Fallback handled inside computeConfidence via getConfig()

// ════════════════════════════════════════════════════════════════
//  COMPONENT SCORING FUNCTIONS
// ════════════════════════════════════════════════════════════════

/** How well do all 8 factor scores agree directionally? */
function scoreFactorAlignment(factors: FactorScores, direction: string): number {
  const vals = Object.values(factors);
  const isBuy = direction === 'BUY';

  // Count factors above/below threshold
  const supporting  = vals.filter(v => isBuy ? v >= 55 : v <= 45).length;
  const conflicting = vals.filter(v => isBuy ? v <= 35 : v >= 65).length;
  const total       = vals.length;

  // Agreement ratio (penalize conflicts more than absent support)
  const alignScore = ((supporting / total) * 70) - ((conflicting / total) * 40);

  // Bonus for high standard deviation (strong clarity vs scattered)
  const mean   = vals.reduce((a, b) => a + b, 0) / total;
  const spread = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / total);
  const bonus  = spread > 20 ? 20 : spread > 10 ? 10 : 0; // high spread = clear signal

  return Math.max(0, Math.min(100, alignScore + bonus));
}

/** How clearly does a strategy pattern emerge vs noise? */
function scoreStrategyClarity(
  compositeScore:  number,
  factorScores:    FactorScores,
  strategyTag:     string
): number {
  // Base on composite and whether the leading factors match strategy
  let score = compositeScore * 0.5;

  const isTrendStrategy   = ['trend_continuation','breakout_continuation','momentum_expansion'].includes(strategyTag);
  const isMRStrategy      = ['mean_reversion'].includes(strategyTag);
  const isBreakout        = strategyTag === 'breakout_continuation';

  if (isTrendStrategy) {
    score += (factorScores.momentum + factorScores.trend_quality) / 2 * 0.3;
    score += (factorScores.participation + factorScores.liquidity) / 2 * 0.2;
  } else if (isMRStrategy) {
    score += factorScores.mean_reversion * 0.4;
    score += factorScores.volatility * 0.1;
  } else if (isBreakout) {
    score += factorScores.breakout_readiness * 0.4;
    score += (factorScores.participation + factorScores.liquidity) / 2 * 0.1;
  } else {
    score += (factorScores.momentum + factorScores.relative_strength) / 2 * 0.3;
    score += factorScores.trend_quality * 0.2;
  }

  // Penalty if NO_STRATEGY
  if (strategyTag === 'NO_STRATEGY') return 10;

  return Math.max(0, Math.min(100, score));
}

/** How well does the signal align with current regime? */
function scoreRegimeAlignment(
  regime:      string,
  direction:   string,
  scenarioTag: string
): number {
  const isBuy    = direction === 'BUY';
  const isBull   = ['BULL','STRONG_BULL'].includes(regime);
  const isBear   = ['BEAR','STRONG_BEAR'].includes(regime);
  const isNeutral= regime === 'NEUTRAL';
  const isChoppy = regime === 'CHOPPY';

  if (isBull  && isBuy)                                          return 90;
  if (isBear  && !isBuy && scenarioTag !== 'no_trade_uncertain') return 85;
  if (isBull  && !isBuy && scenarioTag !== 'defensive_risk_off') return 35; // counter-trend in bull = low
  if (isBear  && isBuy  && scenarioTag === 'mean_reversion')     return 60; // MR buy in bear = ok
  if (isBear  && isBuy)                                          return 25;
  if (isNeutral)                                                 return 60;
  if (isChoppy)                                                  return 45;

  return 55; // default
}

/** Liquidity quality beyond just volume ratio */
function scoreLiquidityQuality(
  volumeRatio20d: number | null,
  deliveryPct:    number | null,
  ltp:            number
): number {
  let score = 40;

  // Volume ratio
  if (volumeRatio20d !== null) {
    if      (volumeRatio20d >= 2.5) score += 35;
    else if (volumeRatio20d >= 1.5) score += 25;
    else if (volumeRatio20d >= 1.1) score += 12;
    else if (volumeRatio20d < 0.5)  score -= 20;
  }

  // Delivery quality (institutional vs speculative)
  if (deliveryPct !== null) {
    if      (deliveryPct >= 70) score += 20;
    else if (deliveryPct >= 45) score += 10;
    else if (deliveryPct <  20) score -= 10;
  }

  // Price range (very low price = liquidity risk)
  if (ltp < 50) score -= 15;

  return Math.max(0, Math.min(100, score));
}

/** Scoring based on risk-reward quality.
 * Delegates to systemConfigService.scoreRRAgainstConfig — no hardcoded RR thresholds here.
 */
async function scoreRRQuality(rr: number, timeframe: string): Promise<number> {
  return scoreRRAgainstConfig(rr, timeframe);
}

/** Is current volatility appropriate for this strategy? */
function scoreVolatilityFit(
  dayRangePct: number,
  atr14:       number | null,
  ltp:         number,
  strategyTag: string
): number {
  const atrPct = atr14 && ltp > 0 ? (atr14 / ltp) * 100 : dayRangePct;
  const isMR   = strategyTag === 'mean_reversion';
  const isVol  = strategyTag === 'volatility_compression';

  // Mean reversion needs moderate vol (not extremes)
  if (isMR) {
    if (atrPct >= 1 && atrPct <= 3.5) return 80;
    if (atrPct > 3.5)                  return 40; // too choppy
    return 60;
  }

  // Volatility compression needs low vol before the move
  if (isVol) {
    if (atrPct < 1.2) return 90;
    if (atrPct < 2.0) return 70;
    return 40;
  }

  // Trend/breakout strategies need expanding vol
  if (dayRangePct > atrPct * 1.3) return 85; // range expanding above ATR
  if (dayRangePct > atrPct * 0.8) return 65;
  if (dayRangePct < atrPct * 0.4) return 35; // very compressed — unclear
  return 50;
}

// ════════════════════════════════════════════════════════════════
//  CONVICTION BAND
// ════════════════════════════════════════════════════════════════

export function getConvictionBand(score: number): ConvictionBand {
  if (score >= 85) return 'high_conviction';
  if (score >= 70) return 'actionable';
  if (score >= 55) return 'watchlist';
  return 'reject';
}

// ════════════════════════════════════════════════════════════════
//  MAIN CONFIDENCE COMPUTATION
// ════════════════════════════════════════════════════════════════

export async function computeConfidence(opts: {
  factors:         FactorScores;
  direction:       string;
  compositeScore:  number;
  strategyTag:     string;
  regime:          string;
  scenarioTag:     string;
  snap:            MarketSnapshot;
  portfolioFit:    number;
  rr:              number;
  timeframe:       string;
  volumeRatio20d:  number | null;
}): Promise<ConfidenceResult> {

  const components: ConfidenceComponents = {
    factor_alignment:  Math.round(scoreFactorAlignment(opts.factors, opts.direction)),
    strategy_clarity:  Math.round(scoreStrategyClarity(opts.compositeScore, opts.factors, opts.strategyTag)),
    regime_alignment:  Math.round(scoreRegimeAlignment(opts.regime, opts.direction, opts.scenarioTag)),
    liquidity_quality: Math.round(scoreLiquidityQuality(opts.volumeRatio20d, opts.snap.delivery_pct, opts.snap.ltp)),
    data_quality:      Math.round(opts.snap.data_quality * 100),
    portfolio_fit:     Math.round(Math.max(0, Math.min(100, opts.portfolioFit))),
    participation:     Math.round(opts.factors.participation),
    rr_quality:        Math.round(await scoreRRQuality(opts.rr, opts.timeframe)),
    volatility_fit:    Math.round(scoreVolatilityFit(
      opts.snap.high > 0 && opts.snap.ltp > 0
        ? ((opts.snap.high - opts.snap.low) / opts.snap.ltp) * 100
        : 2,
      opts.snap.atr14,
      opts.snap.ltp,
      opts.strategyTag
    )),
  };

  // Weighted composite (weights from systemConfigService — DB-configurable)
  const sysCfg = await getConfig().catch(() => null);
  const dynamicWeights = sysCfg
    ? getConfidenceWeights(sysCfg)
    : { factor_alignment:0.22, strategy_clarity:0.14, regime_alignment:0.14,
        liquidity_quality:0.10, data_quality:0.08, portfolio_fit:0.12,
        participation:0.06, rr_quality:0.08, volatility_fit:0.06 };
  const raw = Object.entries(components).reduce((sum, [key, val]) => {
    return sum + val * ((dynamicWeights as any)[key] || 0);
  }, 0);

  const confidence_score = Math.round(Math.max(0, Math.min(100, raw)));
  const conviction_band  = getConvictionBand(confidence_score);

  // Identify boosters and penalizers
  const supported_by: string[] = [];
  const penalized_by: string[] = [];

  Object.entries(components).forEach(([key, val]) => {
    const label = key.replace(/_/g, ' ');
    if (val >= 75) supported_by.push(`${label} (${val})`);
    if (val <= 40) penalized_by.push(`${label} (${val})`);
  });

  // Confidence note
  const confidence_note =
    conviction_band === 'high_conviction' ? `Strong agreement across ${supported_by.length} factors — high decision quality` :
    conviction_band === 'actionable'      ? `Solid setup quality${penalized_by.length ? `; watch: ${penalized_by[0]}` : ''}` :
    conviction_band === 'watchlist'       ? `Conditional opportunity — ${penalized_by.slice(0,2).join(', ')} dragging score` :
    `Below actionable threshold — ${penalized_by.slice(0,2).join(', ')} require improvement`;

  return { confidence_score, conviction_band, components, confidence_note, penalized_by, supported_by };
}

// ════════════════════════════════════════════════════════════════
//  PERSIST TO DB
// ════════════════════════════════════════════════════════════════

export async function persistConfidenceLog(
  signalId: number | null,
  symbol:   string,
  result:   ConfidenceResult
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO confidence_logs
        (signal_id, symbol, confidence_score,
         factor_alignment_score, strategy_clarity_score, regime_alignment_score,
         liquidity_score, data_quality_score, portfolio_fit_score,
         participation_score, rr_quality_score, volatility_fit_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      signalId,
      symbol,
      result.confidence_score,
      result.components.factor_alignment,
      result.components.strategy_clarity,
      result.components.regime_alignment,
      result.components.liquidity_quality,
      result.components.data_quality,
      result.components.portfolio_fit,
      result.components.participation,
      result.components.rr_quality,
      result.components.volatility_fit,
    ]);
  } catch {}
}
