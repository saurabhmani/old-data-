// ════════════════════════════════════════════════════════════════
//  Historical Candle Provider — Zero Lookahead Bias
//
//  Implements the CandleProvider interface from the signal engine
//  but serves only candles up to a specific "as-of" date. This is
//  the critical anti-lookahead layer: the signal engine sees
//  EXACTLY what it would have seen on that historical date.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { CandleProvider } from '../../signal-engine/pipeline/generatePhase1Signals';

/**
 * Creates a CandleProvider that returns candles up to (and including) the given date.
 * This ensures no future data leaks into the signal engine during backtesting.
 *
 * @param asOfDate - The simulation date (inclusive). No candles after this date will be returned.
 * @param minBars - Minimum number of candles to return (for warmup/indicator calculation).
 */
export function createHistoricalCandleProvider(
  asOfDate: string,
  minBars: number = 220,
): CandleProvider {
  // Pre-loaded cache to avoid repeated DB hits within the same simulation day
  const cache = new Map<string, Candle[]>();

  return {
    async fetchDailyCandles(symbol: string): Promise<Candle[]> {
      // Check cache first
      const cacheKey = `${symbol}:${asOfDate}`;
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey)!;
      }

      // Fetch from database: only candles on or before asOfDate
      const result = await db.query<{
        ts: string; open: number; high: number; low: number; close: number; volume: number;
      }>(
        `SELECT ts, open, high, low, close, volume
         FROM candles
         WHERE instrument_key LIKE ?
           AND candle_type = 'eod'
           AND interval_unit = '1day'
           AND ts <= ?
         ORDER BY ts ASC
         LIMIT ?`,
        [`%${symbol}%`, asOfDate, minBars + 50],
      );

      const candles: Candle[] = (result.rows ?? []).map((r) => ({
        ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }));

      cache.set(cacheKey, candles);
      return candles;
    },
  };
}

/**
 * Pre-load all candles for a date range into memory for fast replay.
 * Returns a function that creates providers for any date within the range.
 *
 * This is the high-performance path for full backtests: loads data once,
 * then slices it per-day without hitting the database again.
 */
export async function preloadCandleData(
  symbols: string[],
  startDate: string,
  endDate: string,
): Promise<{
  getProviderForDate: (asOfDate: string) => CandleProvider;
  tradingDates: string[];
  symbolsLoaded: number;
  candlesLoaded: number;
}> {
  // Load ALL candles for all symbols in date range (with warmup buffer)
  const fullData = new Map<string, Candle[]>();
  let totalCandles = 0;

  for (const symbol of symbols) {
    const result = await db.query<{
      ts: string; open: number; high: number; low: number; close: number; volume: number;
    }>(
      `SELECT ts, open, high, low, close, volume
       FROM candles
       WHERE instrument_key LIKE ?
         AND candle_type = 'eod'
         AND interval_unit = '1day'
         AND ts <= ?
       ORDER BY ts ASC`,
      [`%${symbol}%`, endDate],
    );

    const candles: Candle[] = (result.rows ?? []).map((r) => ({
      ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));

    fullData.set(symbol, candles);
    totalCandles += candles.length;
  }

  // Extract unique trading dates within the simulation range
  const dateSet = new Set<string>();
  for (const candles of Array.from(fullData.values())) {
    for (const c of candles) {
      const d = c.ts.split('T')[0];
      if (d >= startDate && d <= endDate) {
        dateSet.add(d);
      }
    }
  }
  const tradingDates = Array.from(dateSet).sort();

  // Provider factory: slices candles up to the given date
  function getProviderForDate(asOfDate: string): CandleProvider {
    return {
      async fetchDailyCandles(symbol: string): Promise<Candle[]> {
        const allCandles = fullData.get(symbol) ?? [];
        // Binary search for the cutoff point (inclusive)
        const cutoffDate = asOfDate.split('T')[0];
        let end = allCandles.length;
        for (let i = allCandles.length - 1; i >= 0; i--) {
          if (allCandles[i].ts.split('T')[0] <= cutoffDate) {
            end = i + 1;
            break;
          }
        }
        return allCandles.slice(0, end);
      },
    };
  }

  return {
    getProviderForDate,
    tradingDates,
    symbolsLoaded: fullData.size,
    candlesLoaded: totalCandles,
  };
}

/**
 * Get candles AFTER a signal date for outcome evaluation.
 * Used to replay what happened after a signal was generated.
 */
export async function getPostSignalCandles(
  symbol: string,
  signalDate: string,
  barsForward: number,
): Promise<Candle[]> {
  const result = await db.query<{
    ts: string; open: number; high: number; low: number; close: number; volume: number;
  }>(
    `SELECT ts, open, high, low, close, volume
     FROM candles
     WHERE instrument_key LIKE ?
       AND candle_type = 'eod'
       AND interval_unit = '1day'
       AND ts > ?
     ORDER BY ts ASC
     LIMIT ?`,
    [`%${symbol}%`, signalDate, barsForward],
  );

  return (result.rows ?? []).map((r) => ({
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}
