// ════════════════════════════════════════════════════════════════
//  Candle Utilities
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';
import { isValidNumber } from './math';

export function validateCandle(c: Candle): boolean {
  return (
    isValidNumber(c.open) &&
    isValidNumber(c.high) &&
    isValidNumber(c.low) &&
    isValidNumber(c.close) &&
    isValidNumber(c.volume) &&
    c.open > 0 &&
    c.high >= c.low &&
    c.close > 0 &&
    c.volume >= 0
  );
}

export function validateCandleSeries(candles: Candle[], minCount: number): { valid: boolean; reason?: string } {
  if (!candles || candles.length < minCount) {
    return { valid: false, reason: `Insufficient candles: ${candles?.length ?? 0} < ${minCount}` };
  }

  const invalidIdx = candles.findIndex((c) => !validateCandle(c));
  if (invalidIdx !== -1) {
    return { valid: false, reason: `Invalid candle at index ${invalidIdx}` };
  }

  return { valid: true };
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function highs(candles: Candle[]): number[] {
  return candles.map((c) => c.high);
}

export function lows(candles: Candle[]): number[] {
  return candles.map((c) => c.low);
}

export function volumes(candles: Candle[]): number[] {
  return candles.map((c) => c.volume);
}

export function lastCandle(candles: Candle[]): Candle {
  return candles[candles.length - 1];
}

export function previousCandle(candles: Candle[]): Candle {
  return candles[candles.length - 2];
}
