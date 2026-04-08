// ════════════════════════════════════════════════════════════════
//  Trend Feature Builder
// ════════════════════════════════════════════════════════════════

import type { TrendFeatures, Candle } from '../types/signalEngine.types';
import { latestEma } from '../indicators/ema';
import { closes, lastCandle } from '../utils/candles';
import { pctChange, round } from '../utils/math';
import { EMA_FAST, EMA_MID, EMA_SLOW } from '../constants/signalEngine.constants';

export function buildTrendFeatures(candles: Candle[]): TrendFeatures {
  const closePrices = closes(candles);
  const current = lastCandle(candles);

  const ema20 = latestEma(closePrices, EMA_FAST);
  const ema50 = latestEma(closePrices, EMA_MID);
  const ema200 = latestEma(closePrices, EMA_SLOW);

  return {
    close: current.close,
    ema20: round(ema20),
    ema50: round(ema50),
    ema200: round(ema200),
    closeAbove20Ema: current.close > ema20,
    closeAbove50Ema: current.close > ema50,
    closeAbove200Ema: current.close > ema200,
    ema20Above50: ema20 > ema50,
    ema50Above200: ema50 > ema200,
    distanceFrom20EmaPct: pctChange(current.close, ema20),
    distanceFrom50EmaPct: pctChange(current.close, ema50),
  };
}
