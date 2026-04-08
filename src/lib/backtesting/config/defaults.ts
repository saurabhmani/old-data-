// ════════════════════════════════════════════════════════════════
//  Backtesting Engine — Default Configuration
// ════════════════════════════════════════════════════════════════

import type { BacktestRunConfig } from '../types';
import { DEFAULT_PHASE1_CONFIG } from '../../signal-engine/constants/signalEngine.constants';

export const DEFAULT_BACKTEST_CONFIG: BacktestRunConfig = {
  name: 'Default Backtest',
  universe: DEFAULT_PHASE1_CONFIG.universe,
  benchmarkSymbol: DEFAULT_PHASE1_CONFIG.benchmarkSymbol,
  startDate: '2024-01-01',
  endDate: '2025-12-31',
  warmupBars: 220,
  evaluationHorizon: 15,
  initialCapital: 1_000_000,
  riskPerTradePct: 0.5,
  maxGrossExposurePct: 60,
  maxSectorExposurePct: 25,
  minConfidence: 55,
  minRewardRisk: 1.2,
  maxStopWidthPct: 8,
  maxOpenPositions: 10,
  slippageBps: 10,
  commissionPerTrade: 20,
  strategies: null,
  signalExpiryBars: 5,
  fillModel: 'conservative',
};
