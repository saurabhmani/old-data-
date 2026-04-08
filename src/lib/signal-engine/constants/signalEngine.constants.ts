// ════════════════════════════════════════════════════════════════
//  Quantorus365 Signal Engine — Phase 1 Constants
// ════════════════════════════════════════════════════════════════

import type { Phase1Config } from '../types/signalEngine.types';

// ── Indicator Periods ────────────────────────────────────────
export const EMA_FAST = 20;
export const EMA_MID = 50;
export const EMA_SLOW = 200;
export const RSI_PERIOD = 14;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const ATR_PERIOD = 14;
export const ROC_SHORT = 5;
export const ROC_LONG = 20;
export const VOLUME_AVG_PERIOD = 20;
export const STRUCTURE_LOOKBACK = 20;

// ── Breakout ─────────────────────────────────────────────────
export const BREAKOUT_BUFFER = 1.002;
export const MAX_BREAKOUT_EXTENSION_PCT = 5.0;
export const MAX_GAP_PCT = 4.0;
export const MAX_ATR_PCT = 6.0;

// ── Strategy Thresholds ──────────────────────────────────────
export const MIN_VOLUME_EXPANSION = 1.5;
export const RSI_LOWER_BOUND = 55;
export const RSI_UPPER_BOUND = 72;
export const MAX_DISTANCE_FROM_EMA20_PCT = 8.0;

// ── Liquidity Filters ────────────────────────────────────────
export const MIN_AVG_VOLUME = 100_000;
export const MIN_PRICE = 50;

// ── Confidence Scoring Weights ───────────────────────────────
export const CONFIDENCE_WEIGHTS = {
  trend: 25,
  momentum: 20,
  volume: 20,
  structure: 20,
  context: 15,
} as const;

// ── Confidence Bands ─────────────────────────────────────────
export const CONFIDENCE_HIGH_CONVICTION = 85;
export const CONFIDENCE_ACTIONABLE = 70;
export const CONFIDENCE_WATCHLIST = 55;

// ── Risk Bands ───────────────────────────────────────────────
export const RISK_LOW = 30;
export const RISK_MODERATE = 55;
export const RISK_ELEVATED = 75;

// ── Pipeline Defaults ────────────────────────────────────────
export const MIN_CANDLE_COUNT = 220;
export const MIN_CONFIDENCE_TO_SAVE = 55;

export const STOP_ATR_MULTIPLIER = 1.5;
export const TARGET1_R_MULTIPLE = 1.5;
export const TARGET2_R_MULTIPLE = 2.5;

// ── Allowed Regimes for Bullish Breakout ─────────────────────
export const BULLISH_ALLOWED_REGIMES = ['Strong Bullish', 'Bullish'] as const;

// ── Default Phase 1 Config ───────────────────────────────────
export const DEFAULT_PHASE1_CONFIG: Phase1Config = {
  universe: [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
    'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'SUNPHARMA',
    'TITAN', 'ULTRACEMCO', 'NESTLEIND', 'WIPRO', 'HCLTECH',
    'BAJFINANCE', 'BAJAJFINSV', 'TECHM', 'NTPC', 'POWERGRID',
    'TATAMOTORS', 'TATASTEEL', 'ONGC', 'COALINDIA', 'ADANIENT',
    'ADANIPORTS', 'JSWSTEEL', 'M&M', 'GRASIM', 'DIVISLAB',
    'DRREDDY', 'CIPLA', 'EICHERMOT', 'HEROMOTOCO', 'BPCL',
    'BRITANNIA', 'APOLLOHOSP', 'INDUSINDBK', 'SBILIFE', 'HDFCLIFE',
    'DABUR', 'GODREJCP', 'PIDILITIND', 'BERGEPAINT', 'HAVELLS',
  ],
  benchmarkSymbol: 'NIFTY 50',
  timeframe: 'daily',
  minCandleCount: MIN_CANDLE_COUNT,
  breakoutBuffer: BREAKOUT_BUFFER,
  minAvgVolume: MIN_AVG_VOLUME,
  minPrice: MIN_PRICE,
  minConfidenceToSave: MIN_CONFIDENCE_TO_SAVE,
};
