// ════════════════════════════════════════════════════════════════
//  Warnings Generator — Phase 1
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures } from '../types/signalEngine.types';
import { round } from '../utils/math';

export function buildWarnings(features: SignalFeatures): string[] {
  const { trend, momentum, volatility, structure } = features;
  const warnings: string[] = [];

  // Overextension
  if (trend.distanceFrom20EmaPct > 3) {
    warnings.push(
      `Stock is ${round(trend.distanceFrom20EmaPct, 1)}% extended from the 20 EMA`,
    );
  }

  // Gap risk
  if (Math.abs(volatility.gapPct) > 1.5) {
    warnings.push(
      `Opening gap of ${round(volatility.gapPct, 1)}% is higher than normal`,
    );
  }

  // ATR elevated
  if (volatility.atrPct > 3) {
    warnings.push(
      `Daily volatility (ATR) is elevated at ${round(volatility.atrPct, 1)}% of price`,
    );
  }

  // RSI approaching overbought
  if (momentum.rsi14 > 68) {
    warnings.push('Momentum is approaching overbought territory');
  }

  // Breakout extension
  if (structure.breakoutDistancePct > 2.5) {
    warnings.push(
      `Breakout is ${round(structure.breakoutDistancePct, 1)}% above resistance — late entry risk`,
    );
  }

  // High daily range
  if (volatility.dailyRangePct > 3.5) {
    warnings.push('Intraday range is wider than typical, suggesting elevated volatility');
  }

  // Distance from 50 EMA
  if (trend.distanceFrom50EmaPct > 6) {
    warnings.push(
      `Price is ${round(trend.distanceFrom50EmaPct, 1)}% above the 50 EMA — mean reversion risk`,
    );
  }

  return warnings;
}
