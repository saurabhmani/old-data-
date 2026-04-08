// ════════════════════════════════════════════════════════════════
//  Phase 1 Signal Generation Pipeline (Multi-Strategy)
// ════════════════════════════════════════════════════════════════

import type {
  Candle, QuantSignal, Phase1Config, MarketRegime,
  StrategyName, SignalType, SignalSubtype, SignalAction,
  StrengthTag, MarketContextTag,
} from '../types/signalEngine.types';
import { defaultRelativeStrength, computeRelativeStrength } from '../context/relativeStrength';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { detectMarketRegime } from '../regime/detectMarketRegime';
import { buildSignalFeatures } from '../features/buildSignalFeatures';
import { runAllStrategies } from '../strategy-engine/runStrategies';
import { rankSignals } from './rankSignals';
import { saveSignals } from '../repository/saveSignals';
import { validateCandleSeries } from '../utils/candles';
import { validateFeatures } from '../utils/validation';

export interface CandleProvider {
  fetchDailyCandles(symbol: string): Promise<Candle[]>;
}

export interface PipelineResult {
  regime: MarketRegime;
  signals: QuantSignal[];
  scanned: number;
  matched: number;
  rejected: { symbol: string; reason: string }[];
}

// ── Strategy → Signal metadata mapping ─────────────────────
const STRATEGY_META: Record<StrategyName, {
  signalType: SignalType;
  signalSubtype: SignalSubtype;
  action: SignalAction;
}> = {
  bullish_breakout:       { signalType: 'bullish_breakout',       signalSubtype: 'fresh_breakout',    action: 'enter_on_strength' },
  bullish_pullback:       { signalType: 'bullish_pullback',       signalSubtype: 'pullback_entry',    action: 'enter_on_pullback' },
  bearish_breakdown:      { signalType: 'bearish_breakdown',      signalSubtype: 'breakdown',         action: 'enter_short' },
  mean_reversion_bounce:  { signalType: 'mean_reversion_bounce',  signalSubtype: 'reversal_bounce',   action: 'enter_on_bounce' },
  momentum_continuation:  { signalType: 'momentum_continuation',  signalSubtype: 'momentum_ride',     action: 'enter_on_momentum' },
  bullish_divergence:     { signalType: 'bullish_divergence',     signalSubtype: 'divergence_reversal', action: 'enter_on_divergence' },
  volume_climax_reversal: { signalType: 'volume_climax_reversal', signalSubtype: 'climax_reversal',   action: 'enter_on_climax' },
  gap_continuation:       { signalType: 'gap_continuation',       signalSubtype: 'gap_and_go',        action: 'enter_on_gap' },
};

function computeContextScore(regime: MarketRegime): number {
  switch (regime.label) {
    case 'Strong Bullish': return 85;
    case 'Bullish': return 70;
    case 'Sideways': return 45;
    case 'Weak': return 30;
    case 'Bearish': return 20;
    case 'High Volatility Risk': return 15;
    default: return 40;
  }
}

export async function generatePhase1Signals(
  provider: CandleProvider,
  config: Phase1Config = DEFAULT_PHASE1_CONFIG,
): Promise<PipelineResult> {
  const now = new Date().toISOString();
  const rejected: { symbol: string; reason: string }[] = [];

  // ── Step 1: Fetch benchmark and detect regime ──────────────
  const benchmarkCandles = await provider.fetchDailyCandles(config.benchmarkSymbol);
  const benchmarkValidation = validateCandleSeries(benchmarkCandles, config.minCandleCount);
  if (!benchmarkValidation.valid) {
    throw new Error(`Benchmark data invalid: ${benchmarkValidation.reason}`);
  }

  const regime = detectMarketRegime(benchmarkCandles);
  const contextScore = computeContextScore(regime);

  // ── Step 2: Process each symbol ────────────────────────────
  const signals: QuantSignal[] = [];

  for (const symbol of config.universe) {
    try {
      const candles = await provider.fetchDailyCandles(symbol);

      // Validate candle data
      const candleCheck = validateCandleSeries(candles, config.minCandleCount);
      if (!candleCheck.valid) {
        rejected.push({ symbol, reason: candleCheck.reason! });
        continue;
      }

      // Build features
      const features = buildSignalFeatures(
        candles,
        regime.label,
        config.minAvgVolume,
        config.minPrice,
      );

      // Validate computed features
      const featureCheck = validateFeatures(features);
      if (!featureCheck.valid) {
        rejected.push({ symbol, reason: featureCheck.reason! });
        continue;
      }

      // Compute relative strength vs benchmark
      const rs = computeRelativeStrength(candles, benchmarkCandles);

      // Run ALL strategies and get best candidates
      const strategyResult = runAllStrategies(features, rs);

      if (strategyResult.candidates.length === 0) {
        const topRejection = strategyResult.rejections[0];
        rejected.push({
          symbol,
          reason: topRejection
            ? `${topRejection.strategy}: ${topRejection.reason}`
            : 'No strategy matched',
        });
        continue;
      }

      // Take the best candidate (highest confidence)
      const best = strategyResult.candidates[0];

      if (best.confidence.finalScore < config.minConfidenceToSave) {
        rejected.push({ symbol, reason: `Confidence too low: ${best.confidence.finalScore}` });
        continue;
      }

      const meta = STRATEGY_META[best.strategy];
      const status = best.confidence.band === 'Watchlist' ? 'watchlist' as const : 'active' as const;
      const marketContextTag: MarketContextTag = regime.label.includes('Bull') ? 'Bullish'
        : regime.label === 'Sideways' ? 'Neutral' : 'Weak';

      const signal: QuantSignal = {
        symbol,
        timeframe: 'daily',
        signalType: meta.signalType,
        signalSubtype: meta.signalSubtype,
        action: meta.action,
        marketRegime: regime.label,
        marketContextTag,
        strengthTag: best.confidence.band as StrengthTag,
        strategyName: best.strategy.replace(/_/g, ' '),
        strategyConfidence: best.confidence.finalScore,
        contextScore,
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
        status,
        generatedAt: now,
      };

      signals.push(signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rejected.push({ symbol, reason: `Error: ${message}` });
    }
  }

  // ── Step 3: Rank signals ───────────────────────────────────
  const ranked = rankSignals(signals);

  // ── Step 4: Persist to database ────────────────────────────
  try {
    await saveSignals(ranked);
  } catch (err) {
    console.error('[SignalEngine] Failed to persist signals:', err);
  }

  return {
    regime,
    signals: ranked,
    scanned: config.universe.length,
    matched: ranked.length,
    rejected,
  };
}
