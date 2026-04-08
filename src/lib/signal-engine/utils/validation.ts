// ════════════════════════════════════════════════════════════════
//  Validation Utilities
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures } from '../types/signalEngine.types';
import { isValidNumber } from './math';

export function validateFeatures(f: SignalFeatures): { valid: boolean; reason?: string } {
  const checks: [string, unknown][] = [
    ['ema20', f.trend.ema20],
    ['ema50', f.trend.ema50],
    ['ema200', f.trend.ema200],
    ['rsi14', f.momentum.rsi14],
    ['macdLine', f.momentum.macdLine],
    ['atr14', f.volatility.atr14],
    ['avgVolume20', f.volume.avgVolume20],
    ['recentResistance20', f.structure.recentResistance20],
  ];

  for (const [name, value] of checks) {
    if (!isValidNumber(value)) {
      return { valid: false, reason: `Invalid feature value: ${name} = ${value}` };
    }
  }

  return { valid: true };
}

export function isLiquid(avgVolume: number, price: number, minVolume: number, minPrice: number): boolean {
  return avgVolume >= minVolume && price >= minPrice;
}
