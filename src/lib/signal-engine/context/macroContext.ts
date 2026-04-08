// ════════════════════════════════════════════════════════════════
//  Macro + News + Event Risk Context — Phase 4
// ════════════════════════════════════════════════════════════════

import type { MacroContext, NewsContext, EventRiskSnapshot, EventTag, MarketTone, RiskMode } from '../types/phase4.types';
import type { EnhancedMarketRegime } from '../types/signalEngine.types';

// ── Macro Context from Regime ───────────────────────────────

export function buildMacroContext(regime: EnhancedMarketRegime, sectorLeadership: string[] = []): MacroContext {
  const toneMap: Record<string, MarketTone> = {
    'Strong Bullish': 'strongly_constructive',
    'Bullish': 'constructive',
    'Sideways': 'neutral',
    'Weak': 'cautious',
    'Bearish': 'hostile',
    'High Volatility Risk': 'cautious',
  };

  const riskMap: Record<string, RiskMode> = {
    'Strong Bullish': 'risk_on',
    'Bullish': 'moderate_risk_on',
    'Sideways': 'neutral',
    'Weak': 'risk_off',
    'Bearish': 'risk_off',
    'High Volatility Risk': 'risk_off',
  };

  return {
    marketTone: toneMap[regime.label] || 'neutral',
    riskMode: riskMap[regime.label] || 'neutral',
    volatilityState: regime.volatilityRegime,
    sectorLeadership,
    macroEventProximity: 'none',
  };
}

// ── Default News Context (no news) ──────────────────────────

export function defaultNewsContext(): NewsContext {
  return {
    bias: 'neutral',
    strength: 0,
    freshnessHours: 999,
    sourceConfidence: 0,
    eventTags: [],
    headline: null,
  };
}

// ── Event Risk from Context ─────────────────────────────────

export function computeEventRisk(
  eventTags: EventTag[] = [],
  newsStrength = 0,
): EventRiskSnapshot {
  if (eventTags.length === 0 || (eventTags.length === 1 && eventTags[0] === 'none')) {
    return { eventRiskScore: 5, eventRiskBand: 'low', eventRiskPenalty: 0, eventTags: ['none'], comment: 'No significant events detected' };
  }

  let score = 10;
  const comments: string[] = [];

  for (const tag of eventTags) {
    switch (tag) {
      case 'earnings_within_3_days': score += 25; comments.push('Earnings approaching'); break;
      case 'policy_decision_today': score += 30; comments.push('Policy decision today'); break;
      case 'macro_data_release_today': score += 20; comments.push('Macro data release'); break;
      case 'regulatory_decision': score += 20; comments.push('Regulatory event'); break;
      case 'corporate_action': score += 15; comments.push('Corporate action'); break;
      case 'management_event': score += 12; comments.push('Management event'); break;
      case 'sudden_news_spike': score += 18; comments.push('News spike'); break;
    }
  }

  score = Math.min(100, score);
  const band = score > 60 ? 'high' as const : score > 40 ? 'elevated' as const : score > 20 ? 'moderate' as const : 'low' as const;
  const penalty = Math.min(10, Math.round(score / 10));

  return { eventRiskScore: score, eventRiskBand: band, eventRiskPenalty: penalty, eventTags, comment: comments.join('; ') || 'Minor event context' };
}
