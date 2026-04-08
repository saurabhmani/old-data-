// ════════════════════════════════════════════════════════════════
//  Quantorus365 Signal Engine — Phase 1 Types
// ════════════════════════════════════════════════════════════════

// ── Candle ────────────────────────────────────────────────────
export interface Candle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Market Regime ────────────────────────────────────────────
export type MarketRegimeLabel =
  | 'Strong Bullish'
  | 'Bullish'
  | 'Sideways'
  | 'Weak'
  | 'Bearish'
  | 'High Volatility Risk';

export interface MarketRegime {
  label: MarketRegimeLabel;
  allowBullishSignals: boolean;
  details: {
    closeVsEma20: number;
    closeVsEma50: number;
    closeVsEma200: number;
    ema20VsEma50: number;
    ema50VsEma200: number;
    rsi: number;
    atrPct: number;
  };
}

// ── Feature Groups ───────────────────────────────────────────

export interface TrendFeatures {
  close: number;
  ema20: number;
  ema50: number;
  ema200: number;
  closeAbove20Ema: boolean;
  closeAbove50Ema: boolean;
  closeAbove200Ema: boolean;
  ema20Above50: boolean;
  ema50Above200: boolean;
  distanceFrom20EmaPct: number;
  distanceFrom50EmaPct: number;
}

export interface MomentumFeatures {
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  roc5: number;
  roc20: number;
}

export interface VolumeFeatures {
  volume: number;
  avgVolume20: number;
  volumeVs20dAvg: number;
  breakoutVolumeRatio: number;
}

export interface VolatilityFeatures {
  atr14: number;
  atrPct: number;
  dailyRangePct: number;
  gapPct: number;
}

export interface StructureFeatures {
  recentResistance20: number;
  recentSupport20: number;
  breakoutDistancePct: number;
  distanceToResistancePct: number;
  distanceToSupportPct: number;
  recentHigh20: number;
  recentLow20: number;
}

export interface ContextFeatures {
  marketRegime: MarketRegimeLabel;
  liquidityPass: boolean;
}

export interface SignalFeatures {
  trend: TrendFeatures;
  momentum: MomentumFeatures;
  volume: VolumeFeatures;
  volatility: VolatilityFeatures;
  structure: StructureFeatures;
  context: ContextFeatures;
}

// ── Confidence ───────────────────────────────────────────────

export type ConfidenceBand =
  | 'High Conviction'
  | 'Actionable'
  | 'Watchlist'
  | 'Avoid';

export interface ConfidenceBreakdown {
  trendScore: number;
  momentumScore: number;
  volumeScore: number;
  structureScore: number;
  contextScore: number;
  rawScore: number;
  penaltyScore: number;
  finalScore: number;
  band: ConfidenceBand;
}

// ── Risk ─────────────────────────────────────────────────────

export type RiskBand =
  | 'Low Risk'
  | 'Moderate Risk'
  | 'Elevated Risk'
  | 'High Risk';

export interface RiskBreakdown {
  atrRisk: number;
  gapRisk: number;
  stopDistanceRisk: number;
  overextensionRisk: number;
  liquidityRisk: number;
  candleVolatilityRisk: number;
  regimeRisk: number;
  totalScore: number;
  band: RiskBand;
}

// ── Trade Plan ───────────────────────────────────────────────

export type EntryType = 'breakout_confirmation';

export interface TradePlan {
  entry: {
    type: EntryType;
    zoneLow: number;
    zoneHigh: number;
  };
  stopLoss: number;
  targets: {
    target1: number;
    target2: number;
  };
  rewardRiskApprox: number;
}

// ── Signal Reasons / Warnings ────────────────────────────────

export interface SignalReason {
  type: 'reason' | 'warning';
  message: string;
}

// ── Final Signal Object ──────────────────────────────────────

// ── Relative Strength ───────────────────────────────────────

export interface RelativeStrengthFeatures {
  rsVsIndex: number;
  rsVsSector: number;
  sectorStrengthScore: number;
}

// ── Enhanced Market Regime (Phase 2) ────────────────────────

export interface EnhancedMarketRegime extends MarketRegime {
  strength: number;
  volatilityRegime: 'Low' | 'Normal' | 'Elevated' | 'Extreme';
  trendSlope: number;
  confidence: number;
}

// ── Strategy System ─────────────────────────────────────────

export type StrategyName =
  | 'bullish_breakout'
  | 'bullish_pullback'
  | 'bearish_breakdown'
  | 'mean_reversion_bounce';

export interface StrategyMatchResult {
  matched: boolean;
  rejectionReason?: string;
}

export interface StrategyCandidate {
  strategy: StrategyName;
  features: SignalFeatures;
  relativeStrength: RelativeStrengthFeatures;
  confidence: ConfidenceBreakdown;
  risk: RiskBreakdown;
  tradePlan: TradePlan;
  reasons: string[];
  warnings: string[];
}

// ── Signal Classification ───────────────────────────────────

export type SignalType = 'bullish_breakout' | 'bullish_pullback' | 'bearish_breakdown' | 'mean_reversion_bounce';
export type SignalSubtype = 'fresh_breakout' | 'continuation' | 'pullback_entry' | 'reversal_bounce' | 'breakdown';
export type SignalAction = 'enter_on_strength' | 'enter_on_pullback' | 'enter_short' | 'enter_on_bounce';
export type SignalStatus = 'active' | 'watchlist' | 'expired' | 'invalidated';
export type MarketContextTag = 'Bullish' | 'Neutral' | 'Weak';
export type StrengthTag = 'High Conviction' | 'Actionable' | 'Watchlist' | 'Avoid';

// ── Final Signal Object ─────────────────────────────────────

export interface QuantSignal {
  symbol: string;
  timeframe: 'daily';
  signalType: SignalType;
  signalSubtype: SignalSubtype;
  action: SignalAction;
  marketRegime: MarketRegimeLabel;
  marketContextTag: MarketContextTag;
  strengthTag: StrengthTag;
  strategyName: string;
  strategyConfidence: number;
  contextScore: number;

  confidenceScore: number;
  confidenceBand: ConfidenceBand;

  riskScore: number;
  riskBand: RiskBand;

  entry: {
    type: EntryType;
    zoneLow: number;
    zoneHigh: number;
  };
  stopLoss: number;
  targets: {
    target1: number;
    target2: number;
  };
  rewardRiskApprox: number;

  reasons: string[];
  warnings: string[];

  features: SignalFeatures;
  relativeStrength: RelativeStrengthFeatures;
  confidenceBreakdown: ConfidenceBreakdown;
  riskBreakdown: RiskBreakdown;

  status: SignalStatus;
  rank?: number;
  signalRank?: number;
  generatedAt: string;
}

// ── Pipeline Config ──────────────────────────────────────────

export interface Phase1Config {
  universe: string[];
  benchmarkSymbol: string;
  timeframe: 'daily';
  minCandleCount: number;
  breakoutBuffer: number;
  minAvgVolume: number;
  minPrice: number;
  minConfidenceToSave: number;
}
