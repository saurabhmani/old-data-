// ════════════════════════════════════════════════════════════════
//  Replay Clock — No-Lookahead Time Management
//
//  Controls the simulation timeline bar by bar. Ensures no
//  component can access data beyond the current replay date.
//  This is the central anti-lookahead enforcement layer.
// ════════════════════════════════════════════════════════════════

import type { ReplayContext, BacktestRunConfig } from '../types';

export interface ReplayClockState {
  /** Ordered trading dates for replay */
  tradingDates: string[];
  /** Current index into tradingDates */
  currentIndex: number;
  /** Index of the first date where warmup is complete */
  warmupCompleteIndex: number;
  /** Whether replay has started */
  started: boolean;
  /** Whether replay has ended */
  ended: boolean;
}

/**
 * Create a replay clock from trading dates and config.
 * The clock manages time progression and enforces the warmup period.
 */
export function createReplayClock(
  tradingDates: string[],
  config: BacktestRunConfig,
): ReplayClockState {
  // The first date we can generate signals is after warmupBars have passed.
  // We conservatively estimate 1 trading date ≈ 1 bar.
  const warmupCompleteIndex = Math.min(
    tradingDates.length - 1,
    Math.max(0, config.warmupBars - 200), // subtract EMA200 base
  );

  return {
    tradingDates,
    currentIndex: -1, // not started yet
    warmupCompleteIndex,
    started: false,
    ended: false,
  };
}

/** Advance the clock by one bar. Returns null if replay is over. */
export function advanceClock(clock: ReplayClockState): string | null {
  if (clock.ended) return null;

  clock.currentIndex++;
  clock.started = true;

  if (clock.currentIndex >= clock.tradingDates.length) {
    clock.ended = true;
    return null;
  }

  return clock.tradingDates[clock.currentIndex];
}

/** Get the current replay date. Returns null if not started or ended. */
export function getCurrentDate(clock: ReplayClockState): string | null {
  if (!clock.started || clock.ended) return null;
  if (clock.currentIndex < 0 || clock.currentIndex >= clock.tradingDates.length) return null;
  return clock.tradingDates[clock.currentIndex];
}

/** Check if warmup is complete (safe to generate signals) */
export function isWarmupComplete(clock: ReplayClockState): boolean {
  return clock.currentIndex >= clock.warmupCompleteIndex;
}

/** Get progress (0-1) through the replay */
export function getProgress(clock: ReplayClockState): number {
  if (clock.tradingDates.length === 0) return 0;
  return Math.max(0, Math.min(1, (clock.currentIndex + 1) / clock.tradingDates.length));
}

/** Get remaining bars */
export function getRemainingBars(clock: ReplayClockState): number {
  return Math.max(0, clock.tradingDates.length - clock.currentIndex - 1);
}

/**
 * CRITICAL: Assert no-lookahead. Throws if any date > current replay date.
 * Call this in debug/test mode to catch lookahead bugs.
 */
export function assertNoLookahead(clock: ReplayClockState, dateToCheck: string): void {
  const current = getCurrentDate(clock);
  if (!current) throw new Error('Lookahead check failed: clock not running');
  if (dateToCheck > current) {
    throw new Error(
      `LOOKAHEAD BIAS DETECTED: attempted to access date ${dateToCheck} but current replay date is ${current}`,
    );
  }
}
