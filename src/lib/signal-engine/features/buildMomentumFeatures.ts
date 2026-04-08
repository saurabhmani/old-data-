// ════════════════════════════════════════════════════════════════
//  Momentum Feature Builder
// ════════════════════════════════════════════════════════════════

import type { MomentumFeatures, Candle } from '../types/signalEngine.types';
import { latestRsi } from '../indicators/rsi';
import { latestMacd } from '../indicators/macd';
import { closes } from '../utils/candles';
import { pctChange, round } from '../utils/math';
import {
  RSI_PERIOD,
  MACD_FAST,
  MACD_SLOW,
  MACD_SIGNAL,
  ROC_SHORT,
  ROC_LONG,
} from '../constants/signalEngine.constants';

export function buildMomentumFeatures(candles: Candle[]): MomentumFeatures {
  const closePrices = closes(candles);
  const len = closePrices.length;

  const rsi14 = latestRsi(closePrices, RSI_PERIOD);
  const macd = latestMacd(closePrices, MACD_FAST, MACD_SLOW, MACD_SIGNAL);

  const roc5 = len > ROC_SHORT ? pctChange(closePrices[len - 1], closePrices[len - 1 - ROC_SHORT]) : 0;
  const roc20 = len > ROC_LONG ? pctChange(closePrices[len - 1], closePrices[len - 1 - ROC_LONG]) : 0;

  return {
    rsi14: round(rsi14),
    macdLine: round(macd.macdLine, 4),
    macdSignal: round(macd.macdSignal, 4),
    macdHistogram: round(macd.macdHistogram, 4),
    roc5: round(roc5),
    roc20: round(roc20),
  };
}
