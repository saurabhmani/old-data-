// ════════════════════════════════════════════════════════════════
//  Structure Feature Builder
// ════════════════════════════════════════════════════════════════

import type { StructureFeatures, Candle } from '../types/signalEngine.types';
import { highs, lows, lastCandle } from '../utils/candles';
import { round, pctChange } from '../utils/math';
import { STRUCTURE_LOOKBACK } from '../constants/signalEngine.constants';

export function buildStructureFeatures(candles: Candle[]): StructureFeatures {
  const current = lastCandle(candles);
  const len = candles.length;

  // Lookback excludes the current candle
  const lookbackStart = Math.max(0, len - STRUCTURE_LOOKBACK - 1);
  const lookbackEnd = len - 1;
  const lookbackCandles = candles.slice(lookbackStart, lookbackEnd);

  const lookbackHighs = highs(lookbackCandles);
  const lookbackLows = lows(lookbackCandles);

  const recentHigh20 = Math.max(...lookbackHighs);
  const recentLow20 = Math.min(...lookbackLows);

  // Resistance = highest high in lookback (excluding current candle)
  const recentResistance20 = recentHigh20;
  // Support = lowest low in lookback
  const recentSupport20 = recentLow20;

  const breakoutDistancePct = pctChange(current.close, recentResistance20);
  const distanceToResistancePct = pctChange(recentResistance20, current.close);
  const distanceToSupportPct = pctChange(current.close, recentSupport20);

  return {
    recentResistance20: round(recentResistance20),
    recentSupport20: round(recentSupport20),
    breakoutDistancePct: round(breakoutDistancePct),
    distanceToResistancePct: round(distanceToResistancePct),
    distanceToSupportPct: round(distanceToSupportPct),
    recentHigh20: round(recentHigh20),
    recentLow20: round(recentLow20),
  };
}
