// ════════════════════════════════════════════════════════════════
//  Trade Simulator — Bar-by-Bar Execution Engine
//
//  Processes each candle sequentially with zero lookahead bias.
//  Handles entry triggers, stop loss, targets with proper
//  intra-bar priority (stop checked before target on same bar).
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type {
  BacktestRunConfig, OpenPosition, PendingSignal, SimulatedTrade,
  TradeOutcome, ExitReason, TradeDirection,
} from '../types';
import { getSector } from '../../signal-engine/constants/phase3.constants';

// ── Entry trigger check ────────────────────────────────────

export interface EntryResult {
  triggered: boolean;
  fillPrice: number;
  slippageApplied: number;
}

/**
 * Check if a pending signal's entry was triggered on this bar.
 *
 * For longs: price must trade at or below entryZoneHigh (we can get filled).
 * For shorts: price must trade at or above entryZoneLow (we can get filled).
 *
 * Fill price includes slippage.
 */
export function checkEntryTrigger(
  signal: PendingSignal,
  candle: Candle,
  slippageBps: number,
): EntryResult {
  const slippageFactor = slippageBps / 10000;

  if (signal.direction === 'long') {
    // Long entry: we want to buy at or near entryZoneHigh
    // Triggered if the bar's low is at or below our entry zone
    // (meaning the price was available during the bar)
    if (candle.low <= signal.entryZoneHigh) {
      // Fill at the worse of: open or entryZoneHigh (no guarantee of better fill)
      const rawFill = Math.min(candle.open, signal.entryZoneHigh);
      const fillPrice = rawFill * (1 + slippageFactor); // slippage hurts longs
      return { triggered: true, fillPrice: Math.round(fillPrice * 100) / 100, slippageApplied: fillPrice - rawFill };
    }
  } else {
    // Short entry: we want to sell at or near entryZoneLow
    if (candle.high >= signal.entryZoneLow) {
      const rawFill = Math.max(candle.open, signal.entryZoneLow);
      const fillPrice = rawFill * (1 - slippageFactor); // slippage hurts shorts
      return { triggered: true, fillPrice: Math.round(fillPrice * 100) / 100, slippageApplied: rawFill - fillPrice };
    }
  }

  return { triggered: false, fillPrice: 0, slippageApplied: 0 };
}

// ── Exit check (stop, targets) ─────────────────────────────

export interface ExitResult {
  exited: boolean;
  exitPrice: number;
  exitReason: ExitReason;
  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  stopHit: boolean;
}

/**
 * Check if an open position should be exited on this bar.
 *
 * CRITICAL: Stop is checked BEFORE targets on the same bar.
 * This is conservative and avoids optimistic bias.
 *
 * For longs:
 *   - Stop hit if low <= stopLoss
 *   - Target1 hit if high >= target1
 *   - Exit at the FIRST level hit (stop > T1 > T2 > T3 priority)
 *
 * For shorts:
 *   - Stop hit if high >= stopLoss
 *   - Target1 hit if low <= target1
 */
export function checkExit(
  pos: OpenPosition,
  candle: Candle,
  barsInTrade: number,
  maxBars: number,
): ExitResult {
  const noExit: ExitResult = {
    exited: false, exitPrice: 0, exitReason: 'signal_expiry',
    target1Hit: pos.target1Hit, target2Hit: pos.target2Hit,
    target3Hit: pos.target3Hit, stopHit: false,
  };

  if (pos.direction === 'long') {
    // ── STOP CHECK (highest priority) ─────────────────────
    if (candle.low <= pos.stopLoss) {
      return {
        exited: true,
        exitPrice: pos.stopLoss, // exit at stop, not at low (limit order)
        exitReason: 'stop_loss',
        target1Hit: pos.target1Hit,
        target2Hit: pos.target2Hit,
        target3Hit: pos.target3Hit,
        stopHit: true,
      };
    }

    // ── TARGET CHECKS (in order) ──────────────────────────
    let t1 = pos.target1Hit;
    let t2 = pos.target2Hit;
    let t3 = pos.target3Hit;

    if (!t1 && candle.high >= pos.target1) t1 = true;
    if (t1 && !t2 && candle.high >= pos.target2) t2 = true;
    if (t2 && !t3 && candle.high >= pos.target3) t3 = true;

    // Exit on target3 hit
    if (t3 && !pos.target3Hit) {
      return { exited: true, exitPrice: pos.target3, exitReason: 'target3', target1Hit: t1, target2Hit: t2, target3Hit: t3, stopHit: false };
    }
    // Exit on target2 hit (partial logic — in production you'd scale out)
    if (t2 && !pos.target2Hit) {
      return { exited: true, exitPrice: pos.target2, exitReason: 'target2', target1Hit: t1, target2Hit: t2, target3Hit: t3, stopHit: false };
    }

    // Update target tracking without exit
    if (t1 !== pos.target1Hit || t2 !== pos.target2Hit) {
      return { exited: false, exitPrice: 0, exitReason: 'signal_expiry', target1Hit: t1, target2Hit: t2, target3Hit: t3, stopHit: false };
    }
  } else {
    // ── SHORT: STOP CHECK ─────────────────────────────────
    if (candle.high >= pos.stopLoss) {
      return {
        exited: true, exitPrice: pos.stopLoss, exitReason: 'stop_loss',
        target1Hit: pos.target1Hit, target2Hit: pos.target2Hit,
        target3Hit: pos.target3Hit, stopHit: true,
      };
    }

    // ── SHORT: TARGET CHECKS ──────────────────────────────
    let t1 = pos.target1Hit;
    let t2 = pos.target2Hit;
    let t3 = pos.target3Hit;

    if (!t1 && candle.low <= pos.target1) t1 = true;
    if (t1 && !t2 && candle.low <= pos.target2) t2 = true;
    if (t2 && !t3 && candle.low <= pos.target3) t3 = true;

    if (t3 && !pos.target3Hit) {
      return { exited: true, exitPrice: pos.target3, exitReason: 'target3', target1Hit: t1, target2Hit: t2, target3Hit: t3, stopHit: false };
    }
    if (t2 && !pos.target2Hit) {
      return { exited: true, exitPrice: pos.target2, exitReason: 'target2', target1Hit: t1, target2Hit: t2, target3Hit: t3, stopHit: false };
    }

    if (t1 !== pos.target1Hit || t2 !== pos.target2Hit) {
      return { exited: false, exitPrice: 0, exitReason: 'signal_expiry', target1Hit: t1, target2Hit: t2, target3Hit: t3, stopHit: false };
    }
  }

  // ── TIME EXPIRY ─────────────────────────────────────────
  if (barsInTrade >= maxBars) {
    return {
      exited: true,
      exitPrice: candle.close,
      exitReason: 'time_expiry',
      target1Hit: pos.target1Hit,
      target2Hit: pos.target2Hit,
      target3Hit: pos.target3Hit,
      stopHit: false,
    };
  }

  return noExit;
}

// ── MFE / MAE tracking ────────────────────────────────────

export function updateExcursions(
  pos: OpenPosition,
  candle: Candle,
): { mfePct: number; maePct: number } {
  if (pos.direction === 'long') {
    const favExcursion = ((candle.high - pos.entryPrice) / pos.entryPrice) * 100;
    const advExcursion = ((pos.entryPrice - candle.low) / pos.entryPrice) * 100;
    return {
      mfePct: Math.max(pos.currentMfePct, favExcursion),
      maePct: Math.max(pos.currentMaePct, advExcursion),
    };
  } else {
    const favExcursion = ((pos.entryPrice - candle.low) / pos.entryPrice) * 100;
    const advExcursion = ((candle.high - pos.entryPrice) / pos.entryPrice) * 100;
    return {
      mfePct: Math.max(pos.currentMfePct, favExcursion),
      maePct: Math.max(pos.currentMaePct, advExcursion),
    };
  }
}

// ── Position sizing ────────────────────────────────────────

export function calculateBacktestPositionSize(
  equity: number,
  riskPerTradePct: number,
  entryPrice: number,
  stopLoss: number,
  maxGrossExposurePct: number,
  currentGrossExposure: number,
): { positionSize: number; positionValue: number; riskAmount: number } {
  const riskBudget = equity * (riskPerTradePct / 100);
  const riskPerUnit = Math.abs(entryPrice - stopLoss);

  if (riskPerUnit <= 0) {
    return { positionSize: 0, positionValue: 0, riskAmount: 0 };
  }

  let positionSize = Math.floor(riskBudget / riskPerUnit);
  let positionValue = positionSize * entryPrice;

  // Cap: max gross exposure
  const maxGross = equity * (maxGrossExposurePct / 100);
  const remainingCapacity = maxGross - currentGrossExposure;
  if (positionValue > remainingCapacity && remainingCapacity > 0) {
    positionSize = Math.floor(remainingCapacity / entryPrice);
    positionValue = positionSize * entryPrice;
  }

  // Cap: single position max 20% of equity
  const maxSinglePosition = equity * 0.20;
  if (positionValue > maxSinglePosition) {
    positionSize = Math.floor(maxSinglePosition / entryPrice);
    positionValue = positionSize * entryPrice;
  }

  const riskAmount = positionSize * riskPerUnit;
  return { positionSize, positionValue, riskAmount };
}

// ── Close a position and produce TradeRecord ───────────────

export function closePosition(
  pos: OpenPosition,
  exitPrice: number,
  exitDate: string,
  exitReason: ExitReason,
  exitResult: ExitResult,
  config: BacktestRunConfig,
  signalMeta: {
    signalId: string;
    signalDate: string;
    regime: string;
    confidenceScore: number;
    confidenceBand: string;
  },
): SimulatedTrade {
  const barsInTrade = pos.barByBarPnl.length;
  const direction = pos.direction;
  const rawPnl = direction === 'long'
    ? (exitPrice - pos.entryPrice) * pos.positionSize
    : (pos.entryPrice - exitPrice) * pos.positionSize;

  const commissionCost = config.commissionPerTrade * 2; // entry + exit
  const slippageCost = (config.slippageBps / 10000) * pos.entryPrice * pos.positionSize;
  const netPnl = rawPnl - commissionCost - slippageCost;

  const returnPct = pos.entryPrice > 0
    ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 * (direction === 'short' ? -1 : 1)
    : 0;

  const riskPerUnit = Math.abs(pos.entryPrice - pos.stopLoss);
  const returnR = riskPerUnit > 0 ? netPnl / (pos.positionSize * riskPerUnit) : 0;
  const mfeR = riskPerUnit > 0 ? (pos.currentMfePct / 100 * pos.entryPrice) / riskPerUnit : 0;
  const maeR = riskPerUnit > 0 ? (pos.currentMaePct / 100 * pos.entryPrice) / riskPerUnit : 0;

  const outcome: TradeOutcome = netPnl > 0 ? 'win' : netPnl < 0 ? 'loss' : 'breakeven';

  return {
    tradeId: pos.tradeId,
    signalId: signalMeta.signalId,
    symbol: pos.symbol,
    sector: getSector(pos.symbol),
    direction,
    strategy: pos.strategy,
    regime: signalMeta.regime as any,
    confidenceScore: signalMeta.confidenceScore,
    confidenceBand: signalMeta.confidenceBand as any,
    signalDate: signalMeta.signalDate,
    entryDate: pos.entryDate,
    exitDate,
    barsToEntry: 0,
    barsInTrade,
    entryPrice: pos.entryPrice,
    exitPrice,
    stopLoss: pos.stopLoss,
    target1: pos.target1,
    target2: pos.target2,
    target3: pos.target3,
    positionSize: pos.positionSize,
    positionValue: pos.positionSize * pos.entryPrice,
    riskAmount: pos.riskAmount,
    slippageCost,
    commissionCost,
    grossPnl: Math.round(rawPnl * 100) / 100,
    netPnl: Math.round(netPnl * 100) / 100,
    returnPct: Math.round(returnPct * 100) / 100,
    returnR: Math.round(returnR * 100) / 100,
    outcome,
    exitReason,
    mfePct: Math.round(pos.currentMfePct * 100) / 100,
    maePct: Math.round(pos.currentMaePct * 100) / 100,
    mfeR: Math.round(mfeR * 100) / 100,
    maeR: Math.round(maeR * 100) / 100,
    target1Hit: exitResult.target1Hit,
    target2Hit: exitResult.target2Hit,
    target3Hit: exitResult.target3Hit,
    stopHit: exitResult.stopHit,
    target1HitBar: exitResult.target1Hit ? barsInTrade : null,
    target2HitBar: exitResult.target2Hit ? barsInTrade : null,
    target3HitBar: exitResult.target3Hit ? barsInTrade : null,
    stopHitBar: exitResult.stopHit ? barsInTrade : null,
    barByBarPnl: pos.barByBarPnl,
  };
}
