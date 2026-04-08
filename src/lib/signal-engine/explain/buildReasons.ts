// ════════════════════════════════════════════════════════════════
//  Reasons Generator — Phase 1
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures } from '../types/signalEngine.types';
import { round } from '../utils/math';

export function buildReasons(features: SignalFeatures): string[] {
  const { trend, momentum, volume, structure, context } = features;
  const reasons: string[] = [];

  // Breakout
  if (structure.breakoutDistancePct > 0) {
    reasons.push(
      `Price closed ${round(structure.breakoutDistancePct, 1)}% above 20-day resistance at ${structure.recentResistance20}`,
    );
  }

  // Volume expansion
  if (volume.volumeVs20dAvg >= 1.5) {
    reasons.push(
      `Volume expanded to ${round(volume.volumeVs20dAvg, 1)}x the 20-day average`,
    );
  }

  // Trend alignment
  if (trend.closeAbove20Ema && trend.closeAbove50Ema) {
    reasons.push('Stock is trading above both 20 EMA and 50 EMA');
  }
  if (trend.closeAbove200Ema) {
    reasons.push('Price remains above the 200-day moving average');
  }
  if (trend.ema20Above50 && trend.ema50Above200) {
    reasons.push('All key moving averages are positively aligned');
  }

  // Momentum
  if (momentum.macdHistogram > 0) {
    reasons.push('Momentum remains supportive with positive MACD histogram');
  }
  if (momentum.roc5 > 0 && momentum.roc20 > 0) {
    reasons.push('Short-term and medium-term rate of change are both positive');
  }

  // Regime
  if (context.marketRegime === 'Strong Bullish') {
    reasons.push('Broader market regime is strongly bullish');
  } else if (context.marketRegime === 'Bullish') {
    reasons.push('Broader market regime is bullish');
  }

  // Volume quality
  if (volume.breakoutVolumeRatio >= 1.0) {
    reasons.push('Breakout candle volume exceeds the recent 20-day peak');
  }

  return reasons;
}
