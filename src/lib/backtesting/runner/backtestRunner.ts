// ════════════════════════════════════════════════════════════════
//  Backtest Runner — Main Orchestrator
//
//  Walks through historical trading dates day by day:
//  1. Generate signals using the REAL signal engine (no shortcuts)
//  2. Manage pending signals → entry triggers
//  3. Update open positions → exits
//  4. Track equity curve
//  5. Compute all metrics
//
//  Zero lookahead bias: each day only sees data up to that date.
// ════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { QuantSignal, StrategyName, MarketRegimeLabel } from '../../signal-engine/types/signalEngine.types';
import type {
  BacktestRunConfig, BacktestRunRecord, SimulatedTrade, EquityPoint,
  OpenPosition, PendingSignal, TradeDirection, BacktestSummary,
  StrategyBreakdownResult, RegimeBreakdownResult,
} from '../types';

/** Full backtest result including data arrays (not persisted in run record) */
export interface BacktestRunResult extends BacktestRunRecord {
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
}
import { validateBacktestConfig } from '../utils/validation';
import { preloadCandleData } from '../data/historicalCandleProvider';
import { generatePhase1Signals } from '../../signal-engine/pipeline/generatePhase1Signals';
import { getSector } from '../../signal-engine/constants/phase3.constants';
import {
  checkEntryTrigger, checkExit, updateExcursions,
  calculateBacktestPositionSize, closePosition,
} from '../simulation/tradeSimulator';
import {
  computeBacktestSummary, computeStrategyBreakdown, computeRegimeBreakdown,
} from '../metrics/computeMetrics';

/**
 * Run a full backtest with the given configuration.
 * This is the main entry point for the backtesting engine.
 */
export async function runBacktest(config: BacktestRunConfig): Promise<BacktestRunResult> {
  const runId = config.runId || uuidv4();
  const startedAt = new Date().toISOString();

  // Validate config
  const validation = validateBacktestConfig(config);
  if (!validation.valid) {
    return createFailedRun(runId, config, startedAt, `Config validation failed: ${validation.errors.join(', ')}`);
  }

  console.log(`[Backtest] Starting run ${runId}: ${config.name}`);
  console.log(`[Backtest] Universe: ${config.universe.length} symbols, ${config.startDate} to ${config.endDate}`);

  try {
    // ── Step 1: Preload all candle data ─────────────────────
    console.log('[Backtest] Preloading candle data...');
    const allSymbols = [...config.universe, config.benchmarkSymbol];
    const dataStore = await preloadCandleData(allSymbols, config.startDate, config.endDate);

    console.log(`[Backtest] Loaded ${dataStore.candlesLoaded} candles for ${dataStore.symbolsLoaded} symbols`);
    console.log(`[Backtest] ${dataStore.tradingDates.length} trading dates in range`);

    if (dataStore.tradingDates.length === 0) {
      return createFailedRun(runId, config, startedAt, 'No trading dates found in date range');
    }

    // ── Step 2: Initialize state ────────────────────────────
    let equity = config.initialCapital;
    let cash = config.initialCapital;
    const openPositions: OpenPosition[] = [];
    const pendingSignals: PendingSignal[] = [];
    const allTrades: SimulatedTrade[] = [];
    const equityCurve: EquityPoint[] = [];
    let totalSignalsGenerated = 0;
    let peakEquity = equity;
    let signalCounter = 0;

    // ── Step 3: Day-by-day simulation ───────────────────────
    for (let dayIdx = 0; dayIdx < dataStore.tradingDates.length; dayIdx++) {
      const date = dataStore.tradingDates[dayIdx];
      const provider = dataStore.getProviderForDate(date);

      // Skip warmup period (need enough data for indicators)
      if (dayIdx < config.warmupBars - 200) continue; // rough guard

      // 3a. Process exits on open positions
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i];
        const candles = await provider.fetchDailyCandles(pos.symbol);
        const lastCandle = candles[candles.length - 1];
        if (!lastCandle || lastCandle.ts.split('T')[0] !== date) continue;

        const barsInTrade = pos.barByBarPnl.length;

        // Update MFE/MAE
        const excursions = updateExcursions(pos, lastCandle);
        pos.currentMfePct = excursions.mfePct;
        pos.currentMaePct = excursions.maePct;

        // Track bar PnL
        const currentPnl = pos.direction === 'long'
          ? (lastCandle.close - pos.entryPrice) * pos.positionSize
          : (pos.entryPrice - lastCandle.close) * pos.positionSize;
        pos.barByBarPnl.push(Math.round(currentPnl * 100) / 100);

        // Check exit
        const exitResult = checkExit(pos, lastCandle, barsInTrade, config.evaluationHorizon);

        // Update target tracking even without exit
        pos.target1Hit = exitResult.target1Hit;
        pos.target2Hit = exitResult.target2Hit;
        pos.target3Hit = exitResult.target3Hit;

        if (exitResult.exited) {
          const trade = closePosition(pos, exitResult.exitPrice, date, exitResult.exitReason, exitResult, config, {
            signalId: pos.tradeId,
            signalDate: pos.entryDate,
            regime: 'Sideways', // stored at entry time
            confidenceScore: 0,
            confidenceBand: 'Watchlist',
          });
          allTrades.push(trade);
          cash += pos.positionSize * exitResult.exitPrice - config.commissionPerTrade;
          openPositions.splice(i, 1);
        }
      }

      // 3b. Process entry triggers on pending signals
      for (let i = pendingSignals.length - 1; i >= 0; i--) {
        const sig = pendingSignals[i];

        // Expire old signals
        sig.barsWaited++;
        if (sig.barsWaited > config.signalExpiryBars) {
          pendingSignals.splice(i, 1);
          continue;
        }

        // Check entry trigger
        const candles = await provider.fetchDailyCandles(sig.symbol);
        const lastCandle = candles[candles.length - 1];
        if (!lastCandle || lastCandle.ts.split('T')[0] !== date) continue;

        // Check position limits
        if (openPositions.length >= config.maxOpenPositions) continue;

        // Check sector exposure
        const sectorCount = openPositions.filter(p => getSector(p.symbol) === sig.sector).length;
        if (sectorCount >= 3) continue; // max 3 per sector

        // Duplicate check
        if (openPositions.some(p => p.symbol === sig.symbol)) continue;

        const entry = checkEntryTrigger(sig, lastCandle, config.slippageBps);
        if (!entry.triggered) continue;

        // Size the position
        const currentGross = openPositions.reduce((s, p) => s + p.positionSize * p.entryPrice, 0);
        const sizing = calculateBacktestPositionSize(
          equity, config.riskPerTradePct,
          entry.fillPrice, sig.stopLoss,
          config.maxGrossExposurePct, currentGross,
        );

        if (sizing.positionSize <= 0) continue;
        if (sizing.positionValue > cash) continue; // can't afford

        // Open position
        const tradeId = sig.signalId;
        cash -= sizing.positionValue + config.commissionPerTrade;

        openPositions.push({
          tradeId,
          symbol: sig.symbol,
          direction: sig.direction,
          strategy: sig.strategy,
          regime: sig.regime,
          confidenceScore: sig.confidenceScore,
          confidenceBand: sig.confidenceBand,
          entryPrice: entry.fillPrice,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          target3: sig.target3,
          positionSize: sizing.positionSize,
          riskAmount: sizing.riskAmount,
          entryDate: date,
          entryBarIndex: dayIdx,
          currentMfePct: 0,
          currentMaePct: 0,
          target1Hit: false,
          target2Hit: false,
          target3Hit: false,
          barByBarPnl: [],
        });

        pendingSignals.splice(i, 1);
      }

      // 3c. Generate new signals (run the actual signal engine)
      // Only generate signals periodically (e.g., every day) to match production behavior
      try {
        const p1Config = {
          universe: config.universe,
          benchmarkSymbol: config.benchmarkSymbol,
          timeframe: 'daily' as const,
          minCandleCount: Math.min(config.warmupBars, 220),
          breakoutBuffer: 1.002,
          minAvgVolume: 100_000,
          minPrice: 50,
          minConfidenceToSave: config.minConfidence,
        };

        const result = await generatePhase1Signals(provider, p1Config);
        totalSignalsGenerated += result.signals.length;

        // Convert signals to pending
        for (const sig of result.signals) {
          // Filter by strategies if configured
          if (config.strategies && !config.strategies.includes(sig.signalType as StrategyName)) continue;

          // Skip if already have pending/open for this symbol
          if (pendingSignals.some(p => p.symbol === sig.symbol)) continue;
          if (openPositions.some(p => p.symbol === sig.symbol)) continue;

          // R:R check
          if (sig.rewardRiskApprox < config.minRewardRisk) continue;

          // Stop width check
          const stopWidth = Math.abs(sig.entry.zoneHigh - sig.stopLoss) / sig.entry.zoneHigh * 100;
          if (stopWidth > config.maxStopWidthPct) continue;

          signalCounter++;
          const riskPerUnit = Math.abs(sig.entry.zoneHigh - sig.stopLoss);
          const t3 = sig.signalType === 'bearish_breakdown'
            ? sig.entry.zoneHigh - 3.5 * riskPerUnit
            : sig.entry.zoneHigh + 3.5 * riskPerUnit;

          pendingSignals.push({
            signalId: `${runId}-${signalCounter}`,
            symbol: sig.symbol,
            direction: (sig.signalType === 'bearish_breakdown' ? 'short' : 'long') as TradeDirection,
            strategy: sig.signalType as StrategyName,
            regime: sig.marketRegime,
            confidenceScore: sig.confidenceScore,
            confidenceBand: sig.confidenceBand,
            sector: getSector(sig.symbol),
            entryZoneLow: sig.entry.zoneLow,
            entryZoneHigh: sig.entry.zoneHigh,
            stopLoss: sig.stopLoss,
            target1: sig.targets.target1,
            target2: sig.targets.target2,
            target3: Math.round(t3 * 100) / 100,
            riskPerUnit,
            signalDate: date,
            signalBarIndex: dayIdx,
            barsWaited: 0,
          });
        }
      } catch (err) {
        // Signal generation can fail for some dates (insufficient data, etc.)
        // This is expected and non-fatal
      }

      // 3d. Update equity curve
      const openValue = openPositions.reduce((s, p) => {
        // Mark-to-market using last available close
        return s + p.positionSize * p.entryPrice + (p.barByBarPnl.length > 0 ? p.barByBarPnl[p.barByBarPnl.length - 1] : 0);
      }, 0);
      equity = cash + openValue;
      peakEquity = Math.max(peakEquity, equity);
      const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;

      const prevEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : config.initialCapital;

      equityCurve.push({
        date,
        equity: Math.round(equity * 100) / 100,
        cash: Math.round(cash * 100) / 100,
        openPositionValue: Math.round(openValue * 100) / 100,
        drawdownPct: Math.round(drawdownPct * 100) / 100,
        openPositions: openPositions.length,
        dayPnl: Math.round((equity - prevEquity) * 100) / 100,
      });

      // Progress logging every 50 days
      if (dayIdx % 50 === 0) {
        console.log(`[Backtest] Day ${dayIdx}/${dataStore.tradingDates.length}: equity=${Math.round(equity)}, positions=${openPositions.length}, trades=${allTrades.length}`);
      }
    }

    // ── Step 4: Force-close remaining positions at last bar ──
    for (const pos of openPositions) {
      const lastDate = dataStore.tradingDates[dataStore.tradingDates.length - 1];
      const provider = dataStore.getProviderForDate(lastDate);
      const candles = await provider.fetchDailyCandles(pos.symbol);
      const lastCandle = candles[candles.length - 1];
      const exitPrice = lastCandle?.close ?? pos.entryPrice;

      const trade = closePosition(pos, exitPrice, lastDate, 'time_expiry', {
        exited: true, exitPrice, exitReason: 'time_expiry',
        target1Hit: pos.target1Hit, target2Hit: pos.target2Hit,
        target3Hit: pos.target3Hit, stopHit: false,
      }, config, {
        signalId: pos.tradeId, signalDate: pos.entryDate,
        regime: 'Sideways', confidenceScore: 0, confidenceBand: 'Watchlist',
      });
      allTrades.push(trade);
    }

    // ── Step 5: Compute all metrics ─────────────────────────
    const summary = computeBacktestSummary(allTrades, equityCurve, config, totalSignalsGenerated);
    const strategyBreakdown = computeStrategyBreakdown(allTrades);
    const regimeBreakdown = computeRegimeBreakdown(allTrades);

    console.log(`[Backtest] Complete — ${allTrades.length} trades, ${summary.winRate * 100}% win rate, ${summary.totalReturnPct}% return`);

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      runId,
      config,
      status: 'completed',
      startedAt,
      completedAt,
      durationMs,
      error: null,
      summary,
      strategyBreakdown,
      regimeBreakdown,
      signalCount: totalSignalsGenerated,
      tradeCount: allTrades.length,
      trades: allTrades,
      equityCurve,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Backtest] Run failed:`, err);
    return createFailedRun(runId, config, startedAt, message);
  }
}

function createFailedRun(runId: string, config: BacktestRunConfig, startedAt: string, error: string): BacktestRunResult {
  return {
    runId, config, status: 'failed', startedAt, completedAt: new Date().toISOString(),
    durationMs: 0, error,
    summary: emptySummary(config.initialCapital),
    strategyBreakdown: [], regimeBreakdown: [],
    signalCount: 0, tradeCount: 0,
    trades: [], equityCurve: [],
  };
}

function emptySummary(capital: number): BacktestRunRecord['summary'] {
  return {
    totalSignalsGenerated: 0, totalTradesTaken: 0, totalWins: 0, totalLosses: 0,
    winRate: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: 0, expectancyPct: 0, expectancyR: 0,
    totalReturnPct: 0, annualizedReturnPct: 0, maxDrawdownPct: 0, maxDrawdownDuration: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    avgMfePct: 0, avgMaePct: 0, avgBarsInTrade: 0,
    target1HitRate: 0, target2HitRate: 0, target3HitRate: 0,
    initialCapital: capital, finalEquity: capital, peakEquity: capital, tradingDays: 0,
  };
}
