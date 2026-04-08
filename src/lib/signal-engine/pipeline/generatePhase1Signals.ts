// ════════════════════════════════════════════════════════════════
//  Phase 1 Signal Generation Pipeline
// ════════════════════════════════════════════════════════════════

import type { Candle, QuantSignal, Phase1Config, MarketRegime, RelativeStrengthFeatures } from '../types/signalEngine.types';
import { defaultRelativeStrength } from '../context/relativeStrength';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { detectMarketRegime } from '../regime/detectMarketRegime';
import { buildSignalFeatures } from '../features/buildSignalFeatures';
import { evaluateBullishBreakout } from '../strategies/bullishBreakout';
import { scoreConfidence } from '../scoring/confidenceScorer';
import { scoreRisk } from '../scoring/riskScorer';
import { buildTradePlan } from '../trade-plan/buildTradePlan';
import { buildReasons } from '../explain/buildReasons';
import { buildWarnings } from '../explain/buildWarnings';
import { rankSignals } from './rankSignals';
import { saveSignals } from '../repository/saveSignals';
import { validateCandleSeries } from '../utils/candles';
import { validateFeatures } from '../utils/validation';
import { pctChange } from '../utils/math';

export interface CandleProvider {
  fetchDailyCandles(symbol: string): Promise<Candle[]>;
}

export interface PipelineResult {
  regime: MarketRegime;
  signals: QuantSignal[];
  scanned: number;
  matched: number;
  rejected: { symbol: string; reason: string }[];
}

export async function generatePhase1Signals(
  provider: CandleProvider,
  config: Phase1Config = DEFAULT_PHASE1_CONFIG,
): Promise<PipelineResult> {
  const now = new Date().toISOString();
  const rejected: { symbol: string; reason: string }[] = [];

  // ── Step 1: Fetch benchmark and detect regime ──────────────
  const benchmarkCandles = await provider.fetchDailyCandles(config.benchmarkSymbol);
  const benchmarkValidation = validateCandleSeries(benchmarkCandles, config.minCandleCount);
  if (!benchmarkValidation.valid) {
    throw new Error(`Benchmark data invalid: ${benchmarkValidation.reason}`);
  }

  const regime = detectMarketRegime(benchmarkCandles);

  // If regime doesn't allow bullish signals, return early
  if (!regime.allowBullishSignals) {
    return { regime, signals: [], scanned: 0, matched: 0, rejected: [] };
  }

  // ── Step 2: Process each symbol ────────────────────────────
  const signals: QuantSignal[] = [];

  for (const symbol of config.universe) {
    try {
      const candles = await provider.fetchDailyCandles(symbol);

      // Validate candle data
      const candleCheck = validateCandleSeries(candles, config.minCandleCount);
      if (!candleCheck.valid) {
        rejected.push({ symbol, reason: candleCheck.reason! });
        continue;
      }

      // Build features
      const features = buildSignalFeatures(
        candles,
        regime.label,
        config.minAvgVolume,
        config.minPrice,
      );

      // Validate computed features
      const featureCheck = validateFeatures(features);
      if (!featureCheck.valid) {
        rejected.push({ symbol, reason: featureCheck.reason! });
        continue;
      }

      // Run bullish breakout strategy
      const strategyResult = evaluateBullishBreakout(features, config.breakoutBuffer);
      if (!strategyResult.matched) {
        rejected.push({ symbol, reason: strategyResult.rejectionReason || 'Strategy not matched' });
        continue;
      }

      // Score confidence
      const confidence = scoreConfidence(features);
      if (confidence.finalScore < config.minConfidenceToSave) {
        rejected.push({ symbol, reason: `Confidence too low: ${confidence.finalScore}` });
        continue;
      }

      // Build trade plan
      const tradePlan = buildTradePlan(features);

      // Score risk
      const stopDistancePct = Math.abs(pctChange(tradePlan.stopLoss, features.trend.close));
      const risk = scoreRisk(features, stopDistancePct);

      // Generate explanations
      const reasons = buildReasons(features);
      const warnings = buildWarnings(features);

      // Determine status
      const status = confidence.band === 'Watchlist' ? 'watchlist' as const : 'active' as const;

      // Build final signal
      const signal: QuantSignal = {
        symbol,
        timeframe: 'daily',
        signalType: 'bullish_breakout',
        signalSubtype: 'fresh_breakout',
        action: 'enter_on_strength',
        marketRegime: regime.label,
        marketContextTag: regime.label.includes('Bull') ? 'Bullish' : 'Neutral',
        strengthTag: confidence.band === 'High Conviction' ? 'High Conviction'
          : confidence.band === 'Actionable' ? 'Actionable'
          : confidence.band === 'Watchlist' ? 'Watchlist' : 'Avoid',
        strategyName: 'bullish breakout',
        strategyConfidence: confidence.finalScore,
        contextScore: 50,
        confidenceScore: confidence.finalScore,
        confidenceBand: confidence.band,
        riskScore: risk.totalScore,
        riskBand: risk.band,
        entry: tradePlan.entry,
        stopLoss: tradePlan.stopLoss,
        targets: tradePlan.targets,
        rewardRiskApprox: tradePlan.rewardRiskApprox,
        reasons,
        warnings,
        features,
        relativeStrength: defaultRelativeStrength(),
        confidenceBreakdown: confidence,
        riskBreakdown: risk,
        status,
        generatedAt: now,
      };

      signals.push(signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rejected.push({ symbol, reason: `Error: ${message}` });
    }
  }

  // ── Step 3: Rank signals ───────────────────────────────────
  const ranked = rankSignals(signals);

  // ── Step 4: Persist to database ────────────────────────────
  try {
    await saveSignals(ranked);
  } catch (err) {
    console.error('[SignalEngine] Failed to persist signals:', err);
  }

  return {
    regime,
    signals: ranked,
    scanned: config.universe.length,
    matched: ranked.length,
    rejected,
  };
}
