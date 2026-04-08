// ════════════════════════════════════════════════════════════════
//  Volatility Feature Builder
// ════════════════════════════════════════════════════════════════

import type { VolatilityFeatures, Candle } from '../types/signalEngine.types';
import { latestAtr } from '../indicators/atr';
import { lastCandle, previousCandle } from '../utils/candles';
import { round, safeDivide, pctChange } from '../utils/math';
import { ATR_PERIOD } from '../constants/signalEngine.constants';

export function buildVolatilityFeatures(candles: Candle[]): VolatilityFeatures {
  const current = lastCandle(candles);
  const prev = previousCandle(candles);
  const atr14 = latestAtr(candles, ATR_PERIOD);

  const atrPct = round(safeDivide(atr14, current.close) * 100);
  const dailyRangePct = round(safeDivide(current.high - current.low, current.close) * 100);
  const gapPct = round(pctChange(current.open, prev.close));

  return {
    atr14: round(atr14),
    atrPct,
    dailyRangePct,
    gapPct,
  };
}
