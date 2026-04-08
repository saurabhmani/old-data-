// ════════════════════════════════════════════════════════════════
//  Confidence Scorer — Phase 1
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, ConfidenceBreakdown, ConfidenceBand } from '../types/signalEngine.types';
import { clamp, round } from '../utils/math';
import {
  CONFIDENCE_HIGH_CONVICTION,
  CONFIDENCE_ACTIONABLE,
  CONFIDENCE_WATCHLIST,
  RSI_UPPER_BOUND,
  MAX_ATR_PCT,
  MAX_GAP_PCT,
} from '../constants/signalEngine.constants';

export function scoreConfidence(features: SignalFeatures): ConfidenceBreakdown {
  const trendScore = scoreTrend(features);
  const momentumScore = scoreMomentum(features);
  const volumeScore = scoreVolume(features);
  const structureScore = scoreStructure(features);
  const contextScore = scoreContext(features);

  const rawScore = trendScore + momentumScore + volumeScore + structureScore + contextScore;
  const penaltyScore = computePenalties(features);
  const finalScore = clamp(Math.round(rawScore - penaltyScore), 0, 100);

  return {
    trendScore: round(trendScore),
    momentumScore: round(momentumScore),
    volumeScore: round(volumeScore),
    structureScore: round(structureScore),
    contextScore: round(contextScore),
    rawScore: round(rawScore),
    penaltyScore: round(penaltyScore),
    finalScore,
    band: classifyConfidence(finalScore),
  };
}

// ── Trend (max 25) ───────────────────────────────────────────
function scoreTrend(f: SignalFeatures): number {
  let score = 0;
  if (f.trend.closeAbove20Ema) score += 8;
  if (f.trend.closeAbove50Ema) score += 8;
  if (f.trend.ema20Above50) score += 6;
  if (f.trend.closeAbove200Ema) score += 2;
  if (f.trend.ema50Above200) score += 1;
  return Math.min(score, 25);
}

// ── Momentum (max 20) ────────────────────────────────────────
function scoreMomentum(f: SignalFeatures): number {
  let score = 0;
  // RSI in ideal breakout range (55-72)
  if (f.momentum.rsi14 >= 55 && f.momentum.rsi14 <= 72) score += 10;
  else if (f.momentum.rsi14 >= 50 && f.momentum.rsi14 <= 75) score += 5;

  if (f.momentum.macdHistogram > 0) score += 7;
  if (f.momentum.roc5 > 0) score += 3;
  return Math.min(score, 20);
}

// ── Volume (max 20) ──────────────────────────────────────────
function scoreVolume(f: SignalFeatures): number {
  let score = 0;
  const ratio = f.volume.volumeVs20dAvg;
  if (ratio >= 2.5) score += 14;
  else if (ratio >= 2.0) score += 12;
  else if (ratio >= 1.5) score += 10;
  else if (ratio >= 1.2) score += 5;

  // Breakout volume relative to recent max
  if (f.volume.breakoutVolumeRatio >= 1.0) score += 6;
  else if (f.volume.breakoutVolumeRatio >= 0.7) score += 3;

  return Math.min(score, 20);
}

// ── Structure (max 20) ───────────────────────────────────────
function scoreStructure(f: SignalFeatures): number {
  let score = 0;
  // Clean break above resistance
  if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 3) score += 12;
  else if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 5) score += 8;

  // Not too stretched above resistance
  if (f.structure.breakoutDistancePct <= 2) score += 8;
  else if (f.structure.breakoutDistancePct <= 3.5) score += 5;

  return Math.min(score, 20);
}

// ── Context (max 15) ─────────────────────────────────────────
function scoreContext(f: SignalFeatures): number {
  let score = 0;
  if (f.context.marketRegime === 'Strong Bullish') score += 12;
  else if (f.context.marketRegime === 'Bullish') score += 9;
  else if (f.context.marketRegime === 'Sideways') score += 4;

  if (f.context.liquidityPass) score += 3;
  return Math.min(score, 15);
}

// ── Penalties ────────────────────────────────────────────────
function computePenalties(f: SignalFeatures): number {
  let penalty = 0;

  // Overextension from EMA20
  if (f.trend.distanceFrom20EmaPct > 5) penalty += 8;
  else if (f.trend.distanceFrom20EmaPct > 3) penalty += 4;

  // Excessive ATR
  if (f.volatility.atrPct > MAX_ATR_PCT * 0.75) penalty += 6;
  else if (f.volatility.atrPct > MAX_ATR_PCT * 0.5) penalty += 3;

  // Excessive gap
  if (Math.abs(f.volatility.gapPct) > MAX_GAP_PCT * 0.5) penalty += 5;
  else if (Math.abs(f.volatility.gapPct) > MAX_GAP_PCT * 0.25) penalty += 2;

  // RSI approaching exhaustion
  if (f.momentum.rsi14 > RSI_UPPER_BOUND - 3) penalty += 4;

  // Weaker regime context
  if (f.context.marketRegime === 'Sideways') penalty += 5;

  return penalty;
}

// ── Confidence Band ──────────────────────────────────────────
function classifyConfidence(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_HIGH_CONVICTION) return 'High Conviction';
  if (score >= CONFIDENCE_ACTIONABLE) return 'Actionable';
  if (score >= CONFIDENCE_WATCHLIST) return 'Watchlist';
  return 'Avoid';
}

// ════════════════════════════════════════════════════════════════
//  Strategy-Specific Confidence — Phase 2
// ════════════════════════════════════════════════════════════════

import type { StrategyName, RelativeStrengthFeatures } from '../types/signalEngine.types';

export function scoreConfidenceForStrategy(
  features: SignalFeatures,
  strategy: StrategyName,
  rs: RelativeStrengthFeatures,
): ConfidenceBreakdown {
  // Start with base scoring
  const base = scoreConfidence(features);

  // Apply strategy-specific adjustments
  let adjustment = 0;

  switch (strategy) {
    case 'bullish_breakout':
      // Breakout rewards: volume expansion + clean break
      if (features.volume.volumeVs20dAvg >= 2.0) adjustment += 3;
      if (features.structure.breakoutDistancePct > 0 && features.structure.breakoutDistancePct <= 1.5) adjustment += 4;
      if (rs.rsVsIndex > 2) adjustment += 3;
      break;

    case 'bullish_pullback':
      // Pullback rewards: trend intact + RSI cooled + volume dried up
      if (features.trend.ema20Above50 && features.trend.ema50Above200) adjustment += 5;
      if (features.momentum.rsi14 >= 42 && features.momentum.rsi14 <= 55) adjustment += 4;
      if (features.volume.volumeVs20dAvg < 1.0) adjustment += 3; // contraction = good
      if (rs.rsVsIndex > 0) adjustment += 2;
      break;

    case 'bearish_breakdown':
      // Breakdown rewards: volume on breakdown + weak RS
      if (features.volume.volumeVs20dAvg >= 1.5) adjustment += 4;
      if (!features.trend.closeAbove20Ema && !features.trend.closeAbove50Ema) adjustment += 4;
      if (rs.rsVsIndex < -2) adjustment += 3;
      if (rs.sectorStrengthScore < 40) adjustment += 2;
      break;

    case 'mean_reversion_bounce':
      // Bounce rewards: deep RSI oversold + near support + volume on bounce
      if (features.momentum.rsi14 <= 30) adjustment += 5;
      if (features.volume.volumeVs20dAvg >= 1.3) adjustment += 3;
      if (features.trend.closeAbove200Ema) adjustment += 3; // long-term structure intact
      break;
  }

  // RS context bonus/penalty
  if (rs.sectorStrengthScore >= 65 && strategy !== 'bearish_breakdown') adjustment += 2;
  if (rs.sectorStrengthScore <= 35 && strategy !== 'bearish_breakdown') adjustment -= 3;

  const adjusted = clamp(base.finalScore + adjustment, 0, 100);

  return {
    ...base,
    finalScore: adjusted,
    band: classifyConfidence(adjusted),
  };
}
