// ════════════════════════════════════════════════════════════════
//  Strategy Engine — Phase 2
//
//  Runs all strategies against a stock's features and returns
//  the best matching candidate (or none).
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures, RelativeStrengthFeatures, StrategyName,
  StrategyCandidate, StrategyMatchResult,
} from '../types/signalEngine.types';
import { evaluateBullishBreakout } from '../strategies/bullishBreakout';
import { evaluateBullishPullback } from '../strategies/bullishPullback';
import { evaluateBearishBreakdown } from '../strategies/bearishBreakdown';
import { evaluateMeanReversionBounce } from '../strategies/meanReversionBounce';
import { evaluateMomentumContinuation } from '../strategies/momentumContinuation';
import { evaluateBullishDivergence } from '../strategies/bullishDivergence';
import { evaluateVolumeClimaxReversal } from '../strategies/volumeClimaxReversal';
import { evaluateGapContinuation } from '../strategies/gapContinuation';
import { scoreConfidenceForStrategy } from '../scoring/confidenceScorer';
import { scoreRisk } from '../scoring/riskScorer';
import { buildTradePlanForStrategy } from '../trade-plan/buildTradePlan';
import { buildReasons } from '../explain/buildReasons';
import { buildWarnings } from '../explain/buildWarnings';

interface StrategyEntry {
  name: StrategyName;
  evaluate: (f: SignalFeatures) => StrategyMatchResult;
}

const STRATEGIES: StrategyEntry[] = [
  { name: 'bullish_breakout',       evaluate: (f) => evaluateBullishBreakout(f) },
  { name: 'momentum_continuation',  evaluate: evaluateMomentumContinuation },
  { name: 'gap_continuation',       evaluate: evaluateGapContinuation },
  { name: 'bullish_pullback',       evaluate: evaluateBullishPullback },
  { name: 'bearish_breakdown',      evaluate: evaluateBearishBreakdown },
  { name: 'mean_reversion_bounce',  evaluate: evaluateMeanReversionBounce },
  { name: 'bullish_divergence',     evaluate: evaluateBullishDivergence },
  { name: 'volume_climax_reversal', evaluate: evaluateVolumeClimaxReversal },
];

export interface StrategyResult {
  candidates: StrategyCandidate[];
  rejections: { strategy: StrategyName; reason: string }[];
}

export function runAllStrategies(
  features: SignalFeatures,
  relativeStrength: RelativeStrengthFeatures,
): StrategyResult {
  const candidates: StrategyCandidate[] = [];
  const rejections: { strategy: StrategyName; reason: string }[] = [];

  for (const { name, evaluate } of STRATEGIES) {
    const result = evaluate(features);
    if (!result.matched) {
      rejections.push({ strategy: name, reason: result.rejectionReason || 'Not matched' });
      continue;
    }

    // Strategy matched — score it
    const confidence = scoreConfidenceForStrategy(features, name, relativeStrength);
    const tradePlan = buildTradePlanForStrategy(features, name);
    const stopDistPct = features.trend.close > 0
      ? Math.abs((features.trend.close - tradePlan.stopLoss) / features.trend.close) * 100
      : 0;
    const risk = scoreRisk(features, stopDistPct);
    const reasons = buildReasons(features, name);
    const warnings = buildWarnings(features, name);

    // Apply relative strength rejection for bullish strategies
    const bullishStrategies: StrategyName[] = [
      'bullish_breakout', 'bullish_pullback', 'momentum_continuation', 'gap_continuation',
    ];
    if (bullishStrategies.includes(name) && relativeStrength.rsVsIndex < -5) {
      rejections.push({ strategy: name, reason: `Weak relative strength vs index: ${relativeStrength.rsVsIndex}%` });
      continue;
    }
    if (name === 'bearish_breakdown' && relativeStrength.rsVsIndex > 3) {
      rejections.push({ strategy: name, reason: `Stock outperforming index — breakdown unlikely` });
      continue;
    }

    // Sector weakness rejection for longs
    if (bullishStrategies.includes(name) && relativeStrength.sectorStrengthScore < 30) {
      rejections.push({ strategy: name, reason: `Weak sector: score ${relativeStrength.sectorStrengthScore}` });
      continue;
    }

    candidates.push({
      strategy: name,
      features,
      relativeStrength,
      confidence,
      risk,
      tradePlan,
      reasons,
      warnings,
    });
  }

  // Sort candidates by confidence (highest first)
  candidates.sort((a, b) => b.confidence.finalScore - a.confidence.finalScore);

  return { candidates, rejections };
}
