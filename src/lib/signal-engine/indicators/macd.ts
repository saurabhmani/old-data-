// ════════════════════════════════════════════════════════════════
//  MACD — Moving Average Convergence Divergence
// ════════════════════════════════════════════════════════════════

import { computeEma } from './ema';

export interface MacdResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export function computeMacd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const emaFast = computeEma(closes, fastPeriod);
  const emaSlow = computeEma(closes, slowPeriod);

  const macdLine: number[] = new Array(closes.length).fill(NaN);

  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }

  // Extract non-NaN MACD values for signal line computation
  const validMacd: number[] = macdLine.filter((v) => !isNaN(v));
  const signalEma = computeEma(validMacd, signalPeriod);

  const signalLine: number[] = new Array(closes.length).fill(NaN);
  const histogram: number[] = new Array(closes.length).fill(NaN);

  let validIdx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(macdLine[i])) {
      if (validIdx < signalEma.length && !isNaN(signalEma[validIdx])) {
        signalLine[i] = signalEma[validIdx];
        histogram[i] = macdLine[i] - signalEma[validIdx];
      }
      validIdx++;
    }
  }

  return { macdLine, signalLine, histogram };
}

export function latestMacd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macdLine: number; macdSignal: number; macdHistogram: number } {
  const result = computeMacd(closes, fastPeriod, slowPeriod, signalPeriod);
  return {
    macdLine: result.macdLine[result.macdLine.length - 1] ?? NaN,
    macdSignal: result.signalLine[result.signalLine.length - 1] ?? NaN,
    macdHistogram: result.histogram[result.histogram.length - 1] ?? NaN,
  };
}
