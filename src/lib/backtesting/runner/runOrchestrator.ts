// ════════════════════════════════════════════════════════════════
//  Run Orchestrator — Full Persistence + Metrics Pipeline
//
//  After a backtest completes, this module:
//  1. Computes full performance report (Part 3 metrics)
//  2. Runs all analytics slices
//  3. Persists everything to the database
//  4. Generates Dexter AI output
// ════════════════════════════════════════════════════════════════

import type { BacktestRunResult } from './backtestRunner';
import type { SimulatedSignal } from '../types';
import { computeFullPerformanceReport } from '../metrics/performanceMetrics';
import { analyzeByStrategy } from '../analytics/byStrategy';
import { analyzeByRegime } from '../analytics/byRegime';
import { analyzeBySector } from '../analytics/bySector';
import { analyzeByConfidenceBucket } from '../analytics/byConfidenceBucket';
import { analyzeByRiskBand } from '../analytics/byRiskBand';
import { analyzeByHoldingPeriod } from '../analytics/byHoldingPeriod';
import { saveBacktestRun } from '../repository/persistence';
import {
  saveBacktestMetrics, saveCalibrationSnapshots,
  saveSignalOutcomes, saveBacktestSignals,
} from '../repository/metricsPersistence';
import { buildDexterOutput, type DexterOutput } from '../api/dexterOutput';

export interface OrchestratedResult {
  runId: string;
  persistedMetrics: number;
  persistedCalibrationBuckets: number;
  persistedSignals: number;
  persistedTrades: number;
  dexterOutput: DexterOutput;
}

/**
 * Persist a full backtest run with all artifacts.
 * Called after runBacktest() completes.
 */
export async function persistFullRun(
  result: BacktestRunResult,
  signals: SimulatedSignal[] = [],
): Promise<OrchestratedResult> {
  const runId = result.runId;

  // 1. Compute full performance report
  const report = computeFullPerformanceReport(result.trades, signals, result.equityCurve);

  // 2. Run all analytics slices
  const strategyAnalytics = analyzeByStrategy(result.trades);
  const regimeAnalytics = analyzeByRegime(result.trades);
  const sectorAnalytics = analyzeBySector(result.trades);
  const confidenceAnalytics = analyzeByConfidenceBucket(result.trades);
  const riskAnalytics = analyzeByRiskBand(result.trades);
  const holdingAnalytics = analyzeByHoldingPeriod(result.trades);

  // 3. Build Dexter AI output
  const dexterOutput = buildDexterOutput(
    result, report, strategyAnalytics, regimeAnalytics,
    sectorAnalytics, confidenceAnalytics,
  );

  // 4. Persist run record + trades + equity curve
  try {
    await saveBacktestRun(result, result.trades, result.equityCurve);
  } catch (err) {
    console.error(`[Orchestrator] Failed to save run ${runId}:`, err);
  }

  // 5. Persist metrics
  let persistedMetrics = 0;
  try {
    await saveBacktestMetrics(runId, report.flatMetrics);
    persistedMetrics = report.flatMetrics.length;
  } catch (err) {
    console.error(`[Orchestrator] Failed to save metrics:`, err);
  }

  // 6. Persist calibration
  let persistedCalibration = 0;
  try {
    await saveCalibrationSnapshots(runId, report.calibration);
    persistedCalibration = report.calibration.length;
  } catch (err) {
    console.error(`[Orchestrator] Failed to save calibration:`, err);
  }

  // 7. Persist signals
  let persistedSignals = 0;
  try {
    if (signals.length > 0) {
      await saveBacktestSignals(runId, signals);
      persistedSignals = signals.length;
    }
  } catch (err) {
    console.error(`[Orchestrator] Failed to save signals:`, err);
  }

  // 8. Persist signal outcomes
  try {
    if (signals.length > 0) {
      await saveSignalOutcomes(runId, signals, result.trades);
    }
  } catch (err) {
    console.error(`[Orchestrator] Failed to save outcomes:`, err);
  }

  console.log(`[Orchestrator] ${runId}: ${persistedMetrics} metrics, ${persistedCalibration} calibration, ${persistedSignals} signals persisted`);

  return {
    runId,
    persistedMetrics,
    persistedCalibrationBuckets: persistedCalibration,
    persistedSignals,
    persistedTrades: result.trades.length,
    dexterOutput,
  };
}
