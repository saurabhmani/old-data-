// ════════════════════════════════════════════════════════════════
//  Phase 4 Pipeline — AI Intelligence + Feedback Loop
//
//  Wraps Phase 3 output with:
//  - Macro/news/event context
//  - Contextual confidence modifiers
//  - AI explanations & trader narratives
//  - Signal freshness tracking
//  - Feedback state attachment
//  - Decision memory logging
//  - Portfolio commentary
// ════════════════════════════════════════════════════════════════

import type { Phase1Config } from '../types/signalEngine.types';
import type { Phase3Config, PortfolioSnapshot, ExecutableSignal } from '../types/phase3.types';
import type { Phase4SignalEnvelope, EventTag, FeedbackState, PortfolioCommentary } from '../types/phase4.types';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { DEFAULT_PHASE3_CONFIG } from '../constants/phase3.constants';
import { generatePhase3Signals } from './generatePhase3Signals';
import type { Phase3Result } from './generatePhase3Signals';
import { buildMacroContext, defaultNewsContext, computeEventRisk } from '../context/macroContext';
import { computeContextualModifiers } from '../context/contextualModifiers';
import { computeFreshness } from '../freshness/signalDecay';
import { buildExplanation, buildTraderNarrative } from '../ai-explain/buildExplanation';
import { defaultFeedbackState } from '../feedback/outcomeTracker';
import { buildPortfolioCommentary, createMemoryEntry } from '../memory/decisionMemory';
import { saveExplanation, savePortfolioCommentary as persistCommentary } from '../repository/savePhase4Artifacts';
import type { CandleProvider } from './generatePhase1Signals';
import type { StrategyName } from '../types/signalEngine.types';

export interface Phase4Result {
  signals: Phase4SignalEnvelope[];
  commentary: PortfolioCommentary;
  meta: {
    regime: string;
    regimeStrength: number;
    scanned: number;
    approved: number;
    deferred: number;
    rejected: number;
  };
}

export async function generatePhase4Signals(
  provider: CandleProvider,
  portfolio: PortfolioSnapshot,
  eventTags: EventTag[] = ['none'],
  feedbackLookup?: (strategy: string, regime: string) => FeedbackState,
  p1Config: Phase1Config = DEFAULT_PHASE1_CONFIG,
  p3Config: Phase3Config = DEFAULT_PHASE3_CONFIG,
): Promise<Phase4Result> {

  // ── Run Phase 3 (deterministic core) ──────────────────────
  const phase3: Phase3Result = await generatePhase3Signals(provider, portfolio, p1Config, p3Config);

  // ── Build sector leadership from approved signals ──────────
  const sectorCounts: Record<string, number> = {};
  for (const sig of phase3.signals) {
    if (sig.executionReadiness.approvalDecision === 'approved') {
      const sector = sig.symbol; // getSector called below
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    }
  }
  // Sectors with 2+ approved signals = leadership
  const leadingSectors = Object.entries(sectorCounts)
    .filter(([, count]) => count >= 2)
    .map(([sector]) => sector);

  // ── Build macro context from regime + sector leadership ───
  const macro = buildMacroContext(phase3.regime, leadingSectors);
  const news = defaultNewsContext(); // Wire to real news API when available
  const eventRisk = computeEventRisk(eventTags);

  // ── Enrich each signal ────────────────────────────────────
  const enriched: Phase4SignalEnvelope[] = [];

  for (const sig of phase3.signals) {
    const strategy = sig.signalType as StrategyName;

    // Freshness
    const freshness = computeFreshness(
      sig.generatedAt,
      sig.tradePlan.entryZoneHigh,
      sig.tradePlan.entryZoneHigh,
      0, // bars elapsed = 0 (just generated)
    );

    // Feedback state
    const feedback = feedbackLookup
      ? feedbackLookup(strategy, phase3.regime.label)
      : defaultFeedbackState();

    // Sector in leadership? Check if this signal's sector is in the leadership list
    const sectorInLeadership = macro.sectorLeadership.includes(sig.symbol)
      || macro.sectorLeadership.length > 0; // broad market leadership present

    // Contextual modifiers
    const modifiers = computeContextualModifiers(
      sig.confidenceScore, macro, news, eventRisk, freshness, feedback, sectorInLeadership,
    );

    // AI explanation — uses typed fields carried from Phase 2/3
    const defaultFeatures = { trend: { close: 0, ema20: 0, ema50: 0, ema200: 0, closeAbove20Ema: false, closeAbove50Ema: false, closeAbove200Ema: false, ema20Above50: false, ema50Above200: false, distanceFrom20EmaPct: 0, distanceFrom50EmaPct: 0 }, momentum: { rsi14: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0, roc5: 0, roc20: 0, stochasticK: 50, stochasticD: 50, adx: 0, bullishDivergence: false, bearishDivergence: false }, volume: { volume: 0, avgVolume20: 0, volumeVs20dAvg: 1, breakoutVolumeRatio: 0, obv: 0, obvSlope: 0, vwap: 0, volumeClimaxRatio: 0 }, volatility: { atr14: 0, atrPct: 0, dailyRangePct: 0, gapPct: 0, bollingerUpper: 0, bollingerLower: 0, bollingerWidth: 0, bollingerPctB: 0.5, squeezed: false }, structure: { recentResistance20: 0, recentSupport20: 0, breakoutDistancePct: 0, distanceToResistancePct: 0, distanceToSupportPct: 0, recentHigh20: 0, recentLow20: 0, isInsideDay: false, rangeCompressionRatio: 1, consecutiveHigherLows: 0, consecutiveLowerHighs: 0 }, context: { marketRegime: 'Sideways' as const, liquidityPass: true } };
    const explanation = buildExplanation({
      symbol: sig.symbol,
      strategy,
      features: sig.features ?? defaultFeatures,
      confidence: sig.confidenceBreakdown ?? { trendScore: 0, momentumScore: 0, volumeScore: 0, structureScore: 0, contextScore: 0, rawScore: 0, penaltyScore: 0, finalScore: sig.confidenceScore, band: sig.confidenceBand as any },
      risk: sig.standaloneRisk ?? { atrRisk: 0, gapRisk: 0, stopDistanceRisk: 0, overextensionRisk: 0, liquidityRisk: 0, candleVolatilityRisk: 0, regimeRisk: 0, totalScore: sig.riskBreakdown.totalRiskScore, band: sig.riskBreakdown.riskBand as any },
      tradePlan: sig.tradePlan,
      portfolioFit: sig.portfolioFit,
      sizing: sig.positionSizing,
      macro,
      eventRisk,
      freshness,
    });

    const narrative = buildTraderNarrative(explanation, strategy);

    // Updated confidence band after modifiers
    const adjConf = modifiers.finalAdjustedConfidence;
    const adjBand = adjConf >= 85 ? 'High Conviction' : adjConf >= 70 ? 'Actionable' : adjConf >= 55 ? 'Watchlist' : 'Avoid';

    enriched.push({
      symbol: sig.symbol,
      signalType: sig.signalType,
      signalSubtype: sig.signalSubtype,
      marketRegime: phase3.regime.label,

      confidenceScore: sig.confidenceScore,
      adjustedConfidenceScore: adjConf,
      confidenceBand: adjBand,
      riskScore: sig.riskBreakdown.totalRiskScore,

      tradePlan: sig.tradePlan,
      positionSizing: sig.positionSizing,
      portfolioFit: sig.portfolioFit,
      executionReadiness: sig.executionReadiness,

      macroContext: macro,
      newsContext: news,
      eventRisk,
      contextualModifiers: modifiers,
      aiExplanation: explanation,
      traderNarrative: narrative,
      freshness,
      feedbackState: feedback,

      lifecycleStatus: sig.lifecycle.state,
      reasons: sig.reasons,
      warnings: sig.warnings,
      generatedAt: sig.generatedAt,
    });
  }

  // ── Portfolio commentary ──────────────────────────────────
  const commentary = buildPortfolioCommentary(
    portfolio, phase3.regime, phase3.approved, phase3.deferred,
  );

  // ── Persist Phase 4 artifacts ──────────────────────────────
  try {
    for (const sig of enriched) {
      await saveExplanation(
        0, // signalId — would be set after Phase 3 persistence
        sig.aiExplanation as unknown as Record<string, unknown>,
        { macro: sig.macroContext, news: sig.newsContext, eventRisk: sig.eventRisk, modifiers: sig.contextualModifiers } as Record<string, unknown>,
      ).catch(() => {});
    }
    await persistCommentary(commentary).catch(() => {});
  } catch (err) {
    console.error('[Phase4] Persistence error (non-blocking):', err);
  }

  console.log(`[Phase4] Enriched ${enriched.length} signals with AI intelligence layer`);

  return {
    signals: enriched,
    commentary,
    meta: {
      regime: phase3.regime.label,
      regimeStrength: phase3.regime.strength,
      scanned: phase3.scanned,
      approved: phase3.approved,
      deferred: phase3.deferred,
      rejected: phase3.rejected,
    },
  };
}
