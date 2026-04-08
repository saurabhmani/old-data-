// ════════════════════════════════════════════════════════════════
//  Trade Plan Builder — Phase 1
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, TradePlan } from '../types/signalEngine.types';
import { round, safeDivide } from '../utils/math';
import { STOP_ATR_MULTIPLIER, TARGET1_R_MULTIPLE, TARGET2_R_MULTIPLE } from '../constants/signalEngine.constants';

import type { StrategyName } from '../types/signalEngine.types';

export function buildTradePlanForStrategy(features: SignalFeatures, strategy: StrategyName): TradePlan {
  switch (strategy) {
    case 'bullish_pullback':
      return buildPullbackPlan(features);
    case 'bearish_breakdown':
      return buildBreakdownPlan(features);
    case 'mean_reversion_bounce':
      return buildBouncePlan(features);
    default:
      return buildTradePlan(features);
  }
}

function buildPullbackPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  const entryZoneLow = round(f.trend.ema20);
  const entryZoneHigh = round(close);
  const stopLoss = round(Math.min(f.structure.recentSupport20, close - STOP_ATR_MULTIPLIER * atr));
  const risk = close - stopLoss;
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + TARGET1_R_MULTIPLE * risk), target2: round(close + TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

function buildBreakdownPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  const entryZoneLow = round(close);
  const entryZoneHigh = round(f.structure.recentSupport20);
  const stopLoss = round(Math.max(f.structure.recentResistance20, close + STOP_ATR_MULTIPLIER * atr));
  const risk = stopLoss - close;
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close - TARGET1_R_MULTIPLE * risk), target2: round(close - TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

function buildBouncePlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  const entryZoneLow = round(f.structure.recentLow20);
  const entryZoneHigh = round(close);
  const stopLoss = round(f.structure.recentLow20 - 0.5 * atr);
  const risk = close - stopLoss;
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + TARGET1_R_MULTIPLE * risk), target2: round(close + TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

export function buildTradePlan(features: SignalFeatures): TradePlan {
  const { trend, volatility, structure } = features;
  const close = trend.close;
  const atr = volatility.atr14;

  // Entry zone: tight band around the breakout level
  const entryZoneLow = round(structure.recentResistance20);
  const entryZoneHigh = round(close);

  // Stop loss: lower of (recent support, close - 1.5 * ATR)
  const atrStop = close - STOP_ATR_MULTIPLIER * atr;
  const stopLoss = round(Math.min(structure.recentSupport20, atrStop));

  // Risk per share
  const riskPerShare = close - stopLoss;

  // Targets based on R multiples
  const target1 = round(close + TARGET1_R_MULTIPLE * riskPerShare);
  const target2 = round(close + TARGET2_R_MULTIPLE * riskPerShare);

  // Reward/Risk ratio (using target1 for conservative estimate)
  const rewardRiskApprox = round(safeDivide(target1 - close, riskPerShare), 1);

  return {
    entry: {
      type: 'breakout_confirmation',
      zoneLow: entryZoneLow,
      zoneHigh: entryZoneHigh,
    },
    stopLoss,
    targets: { target1, target2 },
    rewardRiskApprox,
  };
}
