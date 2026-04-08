// ════════════════════════════════════════════════════════════════
//  Relative Strength Engine — Phase 2
//
//  Measures stock performance vs benchmark index and sector.
//  Higher RS = stock outperforming its context.
// ════════════════════════════════════════════════════════════════

import type { Candle, RelativeStrengthFeatures } from '../types/signalEngine.types';
import { closes } from '../utils/candles';
import { round, safeDivide } from '../utils/math';
import { ROC_SHORT } from '../constants/signalEngine.constants';

export function computeRelativeStrength(
  stockCandles: Candle[],
  indexCandles: Candle[],
  sectorCandles?: Candle[],
): RelativeStrengthFeatures {
  const stockCloses = closes(stockCandles);
  const indexCloses = closes(indexCandles);
  const sectorCloses = sectorCandles ? closes(sectorCandles) : null;

  const period = ROC_SHORT; // 5-day comparison

  const stockReturn = computeReturn(stockCloses, period);
  const indexReturn = computeReturn(indexCloses, period);
  const sectorReturn = sectorCloses ? computeReturn(sectorCloses, period) : indexReturn;

  // RS vs Index: positive = outperforming, negative = underperforming
  const rsVsIndex = round(stockReturn - indexReturn);
  const rsVsSector = round(stockReturn - sectorReturn);

  // Sector strength score (0-100): sector's own return mapped to a score
  const sectorStrengthScore = round(mapReturnToScore(sectorReturn));

  return { rsVsIndex, rsVsSector, sectorStrengthScore };
}

function computeReturn(closes: number[], period: number): number {
  const len = closes.length;
  if (len <= period) return 0;
  return safeDivide(closes[len - 1] - closes[len - 1 - period], closes[len - 1 - period]) * 100;
}

// Map a 5-day return to a 0-100 score
// -5% → 0, 0% → 50, +5% → 100
function mapReturnToScore(returnPct: number): number {
  return Math.max(0, Math.min(100, 50 + returnPct * 10));
}

// Default RS when no index/sector candles available
export function defaultRelativeStrength(): RelativeStrengthFeatures {
  return { rsVsIndex: 0, rsVsSector: 0, sectorStrengthScore: 50 };
}
