// ════════════════════════════════════════════════════════════════
//  Phase 2 Signal Generation Pipeline
//
//  Multi-strategy pipeline with context-aware scoring,
//  relative strength, and enhanced regime classification.
// ════════════════════════════════════════════════════════════════

import type {
  Candle, QuantSignal, Phase1Config, EnhancedMarketRegime,
  StrategyName, SignalAction, SignalSubtype, MarketContextTag, StrengthTag,
} from '../types/signalEngine.types';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { detectEnhancedRegime } from '../regime/detectMarketRegime';
import { buildSignalFeatures } from '../features/buildSignalFeatures';
import { runAllStrategies } from '../strategy-engine/runStrategies';
import { computeRelativeStrength, defaultRelativeStrength } from '../context/relativeStrength';
import { rankSignals } from './rankSignals';
import { saveSignals } from '../repository/saveSignals';
import { validateCandleSeries } from '../utils/candles';
import { validateFeatures } from '../utils/validation';
import type { CandleProvider } from './generatePhase1Signals';

export interface Phase2Result {
  regime: EnhancedMarketRegime;
  signals: QuantSignal[];
  scanned: number;
  matched: number;
  rejected: { symbol: string; strategy?: string; reason: string }[];
}

const ACTION_MAP: Record<StrategyName, SignalAction> = {
  bullish_breakout:      'enter_on_strength',
  bullish_pullback:      'enter_on_pullback',
  bearish_breakdown:     'enter_short',
  mean_reversion_bounce: 'enter_on_bounce',
};

const SUBTYPE_MAP: Record<StrategyName, SignalSubtype> = {
  bullish_breakout:      'fresh_breakout',
  bullish_pullback:      'pullback_entry',
  bearish_breakdown:     'breakdown',
  mean_reversion_bounce: 'reversal_bounce',
};

function contextTag(regime: string): MarketContextTag {
  if (regime === 'Strong Bullish' || regime === 'Bullish') return 'Bullish';
  if (regime === 'Bearish' || regime === 'Weak') return 'Weak';
  return 'Neutral';
}

function strengthTag(confidence: number): StrengthTag {
  if (confidence >= 85) return 'High Conviction';
  if (confidence >= 70) return 'Actionable';
  if (confidence >= 55) return 'Watchlist';
  return 'Avoid';
}

export async function generatePhase2Signals(
  provider: CandleProvider,
  config: Phase1Config = DEFAULT_PHASE1_CONFIG,
): Promise<Phase2Result> {
  const now = new Date().toISOString();
  const rejected: Phase2Result['rejected'] = [];

  // ── Step 1: Detect enhanced regime ────────────────────────
  const benchmarkCandles = await provider.fetchDailyCandles(config.benchmarkSymbol);
  const benchValid = validateCandleSeries(benchmarkCandles, config.minCandleCount);
  if (!benchValid.valid) {
    throw new Error(`Benchmark data invalid: ${benchValid.reason}`);
  }
  const regime = detectEnhancedRegime(benchmarkCandles);

  console.log(`[Phase2] Regime: ${regime.label} (strength=${regime.strength}, vol=${regime.volatilityRegime}, conf=${regime.confidence})`);

  // ── Step 2: Process each symbol ───────────────────────────
  const signals: QuantSignal[] = [];

  for (const symbol of config.universe) {
    try {
      const candles = await provider.fetchDailyCandles(symbol);
      const candleCheck = validateCandleSeries(candles, config.minCandleCount);
      if (!candleCheck.valid) {
        rejected.push({ symbol, reason: candleCheck.reason! });
        continue;
      }

      // Build features
      const features = buildSignalFeatures(candles, regime.label, config.minAvgVolume, config.minPrice);
      const featureCheck = validateFeatures(features);
      if (!featureCheck.valid) {
        rejected.push({ symbol, reason: featureCheck.reason! });
        continue;
      }

      // Compute relative strength
      let rs = defaultRelativeStrength();
      try {
        rs = computeRelativeStrength(candles, benchmarkCandles);
      } catch {}

      // Run all strategies
      const { candidates, rejections: stratRejections } = runAllStrategies(features, rs);

      // Log strategy rejections
      for (const r of stratRejections) {
        rejected.push({ symbol, strategy: r.strategy, reason: r.reason });
      }

      // No strategy matched
      if (candidates.length === 0) continue;

      // Take the best candidate (highest confidence)
      const best = candidates[0];

      // Apply minimum confidence filter
      if (best.confidence.finalScore < config.minConfidenceToSave) {
        rejected.push({ symbol, strategy: best.strategy, reason: `Confidence too low: ${best.confidence.finalScore}` });
        continue;
      }

      // Build final signal
      const signal: QuantSignal = {
        symbol,
        timeframe: 'daily',
        signalType: best.strategy,
        signalSubtype: SUBTYPE_MAP[best.strategy],
        action: ACTION_MAP[best.strategy],
        marketRegime: regime.label,
        marketContextTag: contextTag(regime.label),
        strengthTag: strengthTag(best.confidence.finalScore),
        strategyName: best.strategy.replace(/_/g, ' '),
        strategyConfidence: best.confidence.finalScore,
        contextScore: Math.round(
          (regime.strength * 0.4 + rs.sectorStrengthScore * 0.3 + (50 + rs.rsVsIndex) * 0.3)
        ),

        confidenceScore: best.confidence.finalScore,
        confidenceBand: best.confidence.band,
        riskScore: best.risk.totalScore,
        riskBand: best.risk.band,

        entry: best.tradePlan.entry,
        stopLoss: best.tradePlan.stopLoss,
        targets: best.tradePlan.targets,
        rewardRiskApprox: best.tradePlan.rewardRiskApprox,

        reasons: best.reasons,
        warnings: best.warnings,

        features,
        relativeStrength: rs,
        confidenceBreakdown: best.confidence,
        riskBreakdown: best.risk,

        status: best.confidence.band === 'Watchlist' ? 'watchlist' : 'active',
        generatedAt: now,
      };

      signals.push(signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejected.push({ symbol, reason: `Error: ${msg}` });
    }
  }

  // ── Step 3: Rank ──────────────────────────────────────────
  const ranked = rankSignals(signals);

  // ── Step 4: Persist ───────────────────────────────────────
  try {
    await saveSignals(ranked);
  } catch (err) {
    console.error('[Phase2] Failed to persist signals:', err);
  }

  const buyCount = ranked.filter(s => s.signalType === 'bullish_breakout' || s.signalType === 'bullish_pullback').length;
  const sellCount = ranked.filter(s => s.signalType === 'bearish_breakdown').length;
  const bounceCount = ranked.filter(s => s.signalType === 'mean_reversion_bounce').length;
  console.log(`[Phase2] Complete — ${ranked.length} signals (${buyCount} buy, ${sellCount} sell, ${bounceCount} bounce), ${rejected.length} rejected`);

  return {
    regime,
    signals: ranked,
    scanned: config.universe.length,
    matched: ranked.length,
    rejected,
  };
}
