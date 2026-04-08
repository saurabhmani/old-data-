// ════════════════════════════════════════════════════════════════
//  Signal Freshness & Decay Engine — Phase 4
// ════════════════════════════════════════════════════════════════

import type { SignalFreshness, DecayState, UrgencyTag } from '../types/phase4.types';

export function computeFreshness(
  generatedAt: string,
  currentPrice: number,
  signalEntryPrice: number,
  barsElapsed = 0,
): SignalFreshness {
  const ageMs = Date.now() - new Date(generatedAt).getTime();
  const ageHours = Math.round(ageMs / (1000 * 60 * 60));
  const ageBars = barsElapsed || Math.max(0, Math.floor(ageHours / 6.5)); // ~6.5h per trading day

  // Price drift since signal
  const priceDriftPct = signalEntryPrice > 0
    ? Math.round(((currentPrice - signalEntryPrice) / signalEntryPrice) * 10000) / 100
    : 0;

  // Freshness score (0-100): decays with age and drift
  let freshnessScore = 100;
  freshnessScore -= ageBars * 12;                        // -12 per bar
  freshnessScore -= Math.abs(priceDriftPct) * 5;         // -5 per 1% drift
  if (ageHours > 48) freshnessScore -= 15;               // weekend/multi-day penalty
  freshnessScore = Math.max(0, Math.min(100, Math.round(freshnessScore)));

  // Decay state
  let decayState: DecayState;
  if (freshnessScore >= 75) decayState = 'fresh';
  else if (freshnessScore >= 45) decayState = 'actionable_but_aging';
  else if (freshnessScore >= 15) decayState = 'stale';
  else decayState = 'expired';

  // Urgency
  let urgencyTag: UrgencyTag;
  if (decayState === 'fresh' && Math.abs(priceDriftPct) < 1) urgencyTag = 'high';
  else if (decayState === 'actionable_but_aging') urgencyTag = 'normal';
  else urgencyTag = 'low';

  return { ageBars, ageHours, freshnessScore, decayState, urgencyTag, priceDriftPct };
}
