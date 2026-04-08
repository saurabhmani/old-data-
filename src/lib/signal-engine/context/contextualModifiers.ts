// ════════════════════════════════════════════════════════════════
//  Contextual Modifier Engine — Phase 4
//
//  Safely adjusts confidence using bounded modifiers.
//  Total adjustment capped at ±10. Fully auditable.
// ════════════════════════════════════════════════════════════════

import type { ContextualModifierBreakdown, MacroContext, NewsContext, EventRiskSnapshot, SignalFreshness, FeedbackState } from '../types/phase4.types';
import { clamp } from '../utils/math';

const MAX_ADAPTIVE_ADJUSTMENT = 10;

export function computeContextualModifiers(
  originalConfidence: number,
  macro: MacroContext,
  news: NewsContext,
  eventRisk: EventRiskSnapshot,
  freshness: SignalFreshness,
  feedback: FeedbackState,
  sectorInLeadership: boolean,
): ContextualModifierBreakdown {
  // ── News modifier (±5) ────────────────────────────────────
  let newsModifier = 0;
  if (news.bias === 'positive' && news.strength > 0.5 && news.freshnessHours < 24) {
    newsModifier = Math.round(news.strength * 5);
  } else if (news.bias === 'negative' && news.strength > 0.3) {
    newsModifier = -Math.round(news.strength * 5);
  }

  // ── Macro modifier (±4) ───────────────────────────────────
  let macroModifier = 0;
  if (macro.marketTone === 'strongly_constructive') macroModifier = 4;
  else if (macro.marketTone === 'constructive') macroModifier = 2;
  else if (macro.marketTone === 'cautious') macroModifier = -2;
  else if (macro.marketTone === 'hostile') macroModifier = -4;

  // ── Event risk penalty (0 to -6) ──────────────────────────
  const eventPenalty = -Math.min(6, eventRisk.eventRiskPenalty);

  // ── Sector narrative (±3) ─────────────────────────────────
  const sectorModifier = sectorInLeadership ? 3 : 0;

  // ── Strategy fit from feedback (±3) ───────────────────────
  let strategyFitModifier = 0;
  if (feedback.strategyEnvironmentFit === 'excellent') strategyFitModifier = 3;
  else if (feedback.strategyEnvironmentFit === 'good') strategyFitModifier = 1;
  else if (feedback.strategyEnvironmentFit === 'poor') strategyFitModifier = -3;

  // ── Freshness penalty (0 to -5) ───────────────────────────
  let freshnessPenalty = 0;
  if (freshness.decayState === 'stale') freshnessPenalty = -4;
  else if (freshness.decayState === 'actionable_but_aging') freshnessPenalty = -2;
  else if (freshness.decayState === 'expired') freshnessPenalty = -5;

  // ── Feedback calibration (±2) ─────────────────────────────
  let feedbackCalibrationModifier = 0;
  if (feedback.confidenceCalibrationState === 'overconfident') feedbackCalibrationModifier = -2;
  else if (feedback.confidenceCalibrationState === 'underconfident') feedbackCalibrationModifier = 2;

  // ── Total ─────────────────────────────────────────────────
  const rawTotal = newsModifier + macroModifier + eventPenalty + sectorModifier + strategyFitModifier + freshnessPenalty + feedbackCalibrationModifier;
  const cappedAdaptiveAdjustment = clamp(rawTotal, -MAX_ADAPTIVE_ADJUSTMENT, MAX_ADAPTIVE_ADJUSTMENT);
  const finalAdjustedConfidence = clamp(originalConfidence + cappedAdaptiveAdjustment, 0, 100);

  return {
    newsModifier,
    macroModifier,
    eventRiskPenalty: eventPenalty,
    sectorNarrativeModifier: sectorModifier,
    strategyFitModifier,
    freshnessPenalty,
    feedbackCalibrationModifier,
    rawTotal,
    cappedAdaptiveAdjustment,
    originalConfidence,
    finalAdjustedConfidence,
  };
}
