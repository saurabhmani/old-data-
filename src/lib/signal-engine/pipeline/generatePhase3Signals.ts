// ════════════════════════════════════════════════════════════════
//  Phase 3 Pipeline — Trade Engine + Risk Engine + Portfolio-Aware
//
//  Signal → Trade Plan → Position Size → Portfolio Fit →
//  Risk Integration → Execution Readiness → Lifecycle → Rank
// ════════════════════════════════════════════════════════════════

import type {
  Candle, QuantSignal, Phase1Config, EnhancedMarketRegime,
  StrategyName, SignalAction, SignalSubtype, MarketContextTag, StrengthTag,
} from '../types/signalEngine.types';
import type {
  ExecutableSignal, Phase3TradePlan, Phase3Config,
  PortfolioSnapshot, PortfolioPosition,
} from '../types/phase3.types';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { DEFAULT_PHASE3_CONFIG, getSector } from '../constants/phase3.constants';
import { detectEnhancedRegime } from '../regime/detectMarketRegime';
import { buildSignalFeatures } from '../features/buildSignalFeatures';
import { runAllStrategies } from '../strategy-engine/runStrategies';
import { computeRelativeStrength, defaultRelativeStrength } from '../context/relativeStrength';
import { calculatePositionSize } from '../position-sizing/positionSizer';
import { evaluatePortfolioFit } from '../portfolio-fit/evaluatePortfolioFit';
import { evaluateExecutionReadiness } from '../execution/executionReadiness';
import { computePhase3Risk } from '../risk/phase3Risk';
import { createLifecycle, resolveInitialState } from '../lifecycle/signalLifecycle';
import { buildPhase3TradePlanForStrategy } from '../trade-plan/buildTradePlan';
import { evaluateCorrelationPenalty, buildCorrelationMatrix, type CorrelationMatrix } from '../correlation/correlationEngine';
import { validateCandleSeries } from '../utils/candles';
import { validateFeatures } from '../utils/validation';
import type { CandleProvider } from './generatePhase1Signals';

export interface Phase3Result {
  regime: EnhancedMarketRegime;
  signals: ExecutableSignal[];
  scanned: number;
  approved: number;
  deferred: number;
  rejected: number;
  rejectionLog: { symbol: string; reason: string }[];
}

const ACTION_MAP: Record<StrategyName, SignalAction> = {
  bullish_breakout:       'enter_on_strength',
  bullish_pullback:       'enter_on_pullback',
  bearish_breakdown:      'enter_short',
  mean_reversion_bounce:  'enter_on_bounce',
  momentum_continuation:  'enter_on_momentum',
  bullish_divergence:     'enter_on_divergence',
  volume_climax_reversal: 'enter_on_climax',
  gap_continuation:       'enter_on_gap',
};

const SUBTYPE_MAP: Record<StrategyName, SignalSubtype> = {
  bullish_breakout:       'fresh_breakout',
  bullish_pullback:       'pullback_entry',
  bearish_breakdown:      'breakdown',
  mean_reversion_bounce:  'reversal_bounce',
  momentum_continuation:  'momentum_ride',
  bullish_divergence:     'divergence_reversal',
  volume_climax_reversal: 'climax_reversal',
  gap_continuation:       'gap_and_go',
};

type Phase3EntryType = 'breakout_confirmation' | 'pullback_retest' | 'momentum_followthrough' | 'mean_reversion_confirmation';
const ENTRY_TYPE_MAP: Record<StrategyName, Phase3EntryType> = {
  bullish_breakout:       'breakout_confirmation',
  bullish_pullback:       'pullback_retest',
  bearish_breakdown:      'momentum_followthrough',
  mean_reversion_bounce:  'mean_reversion_confirmation',
  momentum_continuation:  'momentum_followthrough',
  bullish_divergence:     'mean_reversion_confirmation',
  volume_climax_reversal: 'mean_reversion_confirmation',
  gap_continuation:       'breakout_confirmation',
};

function contextTag(regime: string): MarketContextTag {
  if (regime === 'Strong Bullish' || regime === 'Bullish') return 'Bullish';
  if (regime === 'Bearish' || regime === 'Weak') return 'Weak';
  return 'Neutral';
}

function strengthTag(confidence: number): StrengthTag {
  if (confidence >= 85) return 'High Conviction';
  if (confidence >= 70) return 'Actionable';
  if (confidence >= 55) return 'Watchlist';
  return 'Avoid';
}

export async function generatePhase3Signals(
  provider: CandleProvider,
  portfolio: PortfolioSnapshot,
  p1Config: Phase1Config = DEFAULT_PHASE1_CONFIG,
  p3Config: Phase3Config = DEFAULT_PHASE3_CONFIG,
): Promise<Phase3Result> {
  const now = new Date().toISOString();
  const rejectionLog: Phase3Result['rejectionLog'] = [];
  let approved = 0, deferred = 0, rejected = 0;

  // ── Step 1: Detect regime ─────────────────────────────────
  const benchmarkCandles = await provider.fetchDailyCandles(p1Config.benchmarkSymbol);
  const benchValid = validateCandleSeries(benchmarkCandles, p1Config.minCandleCount);
  if (!benchValid.valid) throw new Error(`Benchmark invalid: ${benchValid.reason}`);
  const regime = detectEnhancedRegime(benchmarkCandles);

  console.log(`[Phase3] Regime: ${regime.label} (strength=${regime.strength}, vol=${regime.volatilityRegime})`);

  // ── Build correlation matrix from available candle data ────
  const candleCache = new Map<string, Candle[]>();
  for (const sym of p1Config.universe) {
    try {
      const c = await provider.fetchDailyCandles(sym);
      if (c.length >= 30) candleCache.set(sym, c);
    } catch {}
  }
  const correlationMatrix = candleCache.size > 1
    ? buildCorrelationMatrix(candleCache) : undefined;

  // Mutable portfolio for tracking allocations within this run
  const runPortfolio: PortfolioSnapshot = {
    capital: portfolio.capital,
    cashAvailable: portfolio.cashAvailable,
    openPositions: [...portfolio.openPositions],
    pendingSignals: [...portfolio.pendingSignals],
  };

  const signals: ExecutableSignal[] = [];

  // ── Step 2: Process each symbol ───────────────────────────
  for (const symbol of p1Config.universe) {
    try {
      const candles = await provider.fetchDailyCandles(symbol);
      const candleCheck = validateCandleSeries(candles, p1Config.minCandleCount);
      if (!candleCheck.valid) { rejectionLog.push({ symbol, reason: candleCheck.reason! }); continue; }

      const features = buildSignalFeatures(candles, regime.label, p1Config.minAvgVolume, p1Config.minPrice);
      const featureCheck = validateFeatures(features);
      if (!featureCheck.valid) { rejectionLog.push({ symbol, reason: featureCheck.reason! }); continue; }

      let rs = defaultRelativeStrength();
      try { rs = computeRelativeStrength(candles, benchmarkCandles); } catch {}

      // ── Step 3: Strategy evaluation ─────────────────────────
      const { candidates, rejections } = runAllStrategies(features, rs);
      for (const r of rejections) rejectionLog.push({ symbol, reason: `[${r.strategy}] ${r.reason}` });
      if (candidates.length === 0) continue;

      const best = candidates[0];
      if (best.confidence.finalScore < p1Config.minConfidenceToSave) {
        rejectionLog.push({ symbol, reason: `Confidence ${best.confidence.finalScore} below min` });
        continue;
      }

      // ── Step 4: Build Phase 3 trade plan (strategy-aware target3) ─
      const tradePlan = buildPhase3TradePlanForStrategy(features, best.strategy);

      // ── Step 5: Stop width check ────────────────────────────
      const stopWidthPct = tradePlan.entryZoneHigh > 0
        ? (tradePlan.initialRiskPerUnit / tradePlan.entryZoneHigh) * 100
        : 0;
      if (stopWidthPct > p3Config.stopMaxWidthPct) {
        rejectionLog.push({ symbol, reason: `Stop too wide: ${stopWidthPct.toFixed(1)}% > ${p3Config.stopMaxWidthPct}%` });
        rejected++;
        continue;
      }

      // ── Step 6: R:R check ───────────────────────────────────
      if (tradePlan.rrTarget1 < p3Config.minRewardRisk) {
        rejectionLog.push({ symbol, reason: `R:R ${tradePlan.rrTarget1} below min ${p3Config.minRewardRisk}` });
        rejected++;
        continue;
      }

      // ── Step 7: Position sizing ─────────────────────────────
      const currentGross = runPortfolio.openPositions.reduce((s, p) => s + p.grossValue, 0);
      const sizing = calculatePositionSize({
        portfolioCapital: runPortfolio.capital,
        riskPerTradePct: p3Config.riskPerTradePct,
        maxGrossExposurePct: p3Config.maxGrossExposurePct,
        entryPrice: tradePlan.entryZoneHigh,
        stopLoss: tradePlan.stopLoss,
        atrPct: features.volatility.atrPct,
        model: features.volatility.atrPct > 3 ? 'volatility_adjusted' : 'fixed_fractional',
        currentGrossExposure: currentGross,
      });

      // ── Step 8: Portfolio fit ───────────────────────────────
      const direction = (best.strategy === 'bearish_breakdown') ? 'short' as const : 'long' as const;
      const portfolioFit = evaluatePortfolioFit(
        symbol, direction, sizing.grossPositionValue, runPortfolio, p3Config,
      );

      // ── Step 8b: Real correlation penalty (upgrades sector proxy) ─
      if (correlationMatrix) {
        const corrResult = evaluateCorrelationPenalty(
          symbol, runPortfolio.openPositions, correlationMatrix, p3Config,
        );
        // Replace sector-proxy correlation with real correlation data
        if (corrResult.correlationPenalty > portfolioFit.correlationPenalty) {
          portfolioFit.fitScore = Math.max(0, portfolioFit.fitScore -
            (corrResult.correlationPenalty - portfolioFit.correlationPenalty));
          portfolioFit.correlationPenalty = corrResult.correlationPenalty;
          portfolioFit.correlationCluster = corrResult.correlationCluster;
          if (corrResult.correlationPenalty > 10) {
            portfolioFit.penalties.push(
              `Correlation cluster "${corrResult.correlationCluster}": ${corrResult.clusterExposureCount} correlated positions`,
            );
          }
          // Re-evaluate decision based on updated fit score
          if (portfolioFit.fitScore < 30) portfolioFit.portfolioDecision = 'rejected';
          else if (portfolioFit.fitScore < 50) portfolioFit.portfolioDecision = 'deferred';
          else if (portfolioFit.fitScore < 70) portfolioFit.portfolioDecision = 'approved_with_penalty';
        }
      }

      // ── Step 9: Phase 3 risk ────────────────────────────────
      const riskBreakdown = computePhase3Risk(best.risk, portfolioFit);

      // ── Step 10: Execution readiness ────────────────────────
      const execution = evaluateExecutionReadiness(
        best.confidence.finalScore, best.confidence.band,
        tradePlan.rrTarget1, portfolioFit, sizing, riskBreakdown, p3Config,
      );

      // ── Step 11: Lifecycle ──────────────────────────────────
      const { state, reason } = resolveInitialState(execution.approvalDecision, execution.status);
      const lifecycle = createLifecycle(state, reason);

      // ── Step 12: Track allocation ───────────────────────────
      if (execution.approvalDecision === 'approved') {
        approved++;
        runPortfolio.openPositions.push({
          symbol, side: direction, sector: getSector(symbol),
          grossValue: sizing.grossPositionValue,
          riskAllocated: sizing.riskBudgetAmount,
        });
        runPortfolio.cashAvailable -= sizing.grossPositionValue;
      } else if (execution.approvalDecision === 'deferred') {
        deferred++;
      } else {
        rejected++;
      }

      // Max approved per run
      if (approved >= p3Config.maxApprovedPerRun && execution.approvalDecision === 'approved') {
        // Don't add more, but still push the signal
      }

      signals.push({
        symbol,
        signalType: best.strategy,
        signalSubtype: SUBTYPE_MAP[best.strategy],
        marketRegime: regime.label,
        confidenceScore: best.confidence.finalScore,
        confidenceBand: best.confidence.band,
        tradePlan,
        positionSizing: sizing,
        portfolioFit,
        executionReadiness: execution,
        riskBreakdown,
        lifecycle,
        // Carry forward for Phase 4 explanation engine
        features,
        confidenceBreakdown: best.confidence,
        standaloneRisk: best.risk,
        reasons: best.reasons,
        warnings: [...best.warnings, ...sizing.warnings, ...portfolioFit.penalties],
        generatedAt: now,
      });
    } catch (err) {
      rejectionLog.push({ symbol, reason: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // ── Step 13: Rank by execution priority ───────────────────
  signals.sort((a, b) => {
    // Approved first, then deferred, then rejected
    const orderMap = { approved: 0, deferred: 1, rejected: 2 };
    const aOrder = orderMap[a.executionReadiness.approvalDecision] ?? 2;
    const bOrder = orderMap[b.executionReadiness.approvalDecision] ?? 2;
    if (aOrder !== bOrder) return aOrder - bOrder;

    // Within same approval: higher confidence first
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;

    // Then lower risk
    return a.riskBreakdown.totalRiskScore - b.riskBreakdown.totalRiskScore;
  });

  // Assign priority ranks
  signals.forEach((s, i) => { s.executionReadiness.priorityRank = i + 1; });

  console.log(`[Phase3] Complete — ${signals.length} signals: ${approved} approved, ${deferred} deferred, ${rejected} rejected`);

  return { regime, signals, scanned: p1Config.universe.length, approved, deferred, rejected, rejectionLog };
}
