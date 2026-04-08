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

  // ── Build macro context from regime ───────────────────────
  const macro = buildMacroContext(phase3.regime);
  const news = defaultNewsContext(); // Placeholder — wire to real news API later
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

    // Sector in leadership?
    const sectorInLeadership = macro.sectorLeadership.length > 0; // Will improve when sector data is wired

    // Contextual modifiers
    const modifiers = computeContextualModifiers(
      sig.confidenceScore, macro, news, eventRisk, freshness, feedback, sectorInLeadership,
    );

    // AI explanation
    const explanation = buildExplanation({
      symbol: sig.symbol,
      strategy,
      features: (sig as any).features || {} as any,
      confidence: (sig as any).confidenceBreakdown || { finalScore: sig.confidenceScore, band: sig.confidenceBand } as any,
      risk: (sig as any).riskBreakdown || { totalScore: sig.riskBreakdown.totalRiskScore, band: sig.riskBreakdown.riskBand } as any,
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
