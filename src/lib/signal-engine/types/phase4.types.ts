// ════════════════════════════════════════════════════════════════
//  Phase 4 Types — AI Intelligence Layer + Feedback Loop
// ════════════════════════════════════════════════════════════════

// ── AI Explanation ──────────────────────────────────────────
export interface AIExplanation {
  summary: string;
  whyNow: string;
  decisionNarrative: string;
  traderGuidance: string[];
  riskHighlights: string[];
  whatWouldInvalidate: string[];
  whyNotOversize: string;
}

// ── Trader Narrative ────────────────────────────────────────
export interface TraderNarrative {
  shortSummary: string;
  fullNarrative: string;
  guidanceBullets: string[];
  invalidationSummary: string;
}

// ── News Context ────────────────────────────────────────────
export type NewsBias = 'positive' | 'neutral' | 'negative';

export interface NewsContext {
  bias: NewsBias;
  strength: number;           // 0-1
  freshnessHours: number;
  sourceConfidence: number;   // 0-1
  eventTags: string[];
  headline: string | null;
}

// ── Macro Context ───────────────────────────────────────────
export type MarketTone = 'strongly_constructive' | 'constructive' | 'neutral' | 'cautious' | 'hostile';
export type RiskMode = 'risk_on' | 'moderate_risk_on' | 'neutral' | 'risk_off';

export interface MacroContext {
  marketTone: MarketTone;
  riskMode: RiskMode;
  volatilityState: string;
  sectorLeadership: string[];
  macroEventProximity: 'none' | 'low' | 'moderate' | 'high';
}

// ── Event Risk ──────────────────────────────────────────────
export type EventTag =
  | 'earnings_within_3_days'
  | 'management_event'
  | 'policy_decision_today'
  | 'macro_data_release_today'
  | 'regulatory_decision'
  | 'corporate_action'
  | 'sudden_news_spike'
  | 'none';

export interface EventRiskSnapshot {
  eventRiskScore: number;     // 0-100
  eventRiskBand: 'low' | 'moderate' | 'elevated' | 'high';
  eventRiskPenalty: number;
  eventTags: EventTag[];
  comment: string;
}

// ── Contextual Modifiers ────────────────────────────────────
export interface ContextualModifierBreakdown {
  newsModifier: number;
  macroModifier: number;
  eventRiskPenalty: number;
  sectorNarrativeModifier: number;
  strategyFitModifier: number;
  freshnessPenalty: number;
  feedbackCalibrationModifier: number;
  rawTotal: number;
  cappedAdaptiveAdjustment: number;   // bounded ±10
  originalConfidence: number;
  finalAdjustedConfidence: number;
}

// ── Signal Freshness ────────────────────────────────────────
export type DecayState = 'fresh' | 'actionable_but_aging' | 'stale' | 'expired';
export type UrgencyTag = 'high' | 'normal' | 'low';

export interface SignalFreshness {
  ageBars: number;
  ageHours: number;
  freshnessScore: number;     // 0-100
  decayState: DecayState;
  urgencyTag: UrgencyTag;
  priceDriftPct: number;      // how far price moved since signal
}

// ── Signal Outcome ──────────────────────────────────────────
export type OutcomeLabel =
  | 'good_followthrough'
  | 'partial_success'
  | 'stopped_out'
  | 'stale_no_trigger'
  | 'expired'
  | 'ambiguous';

export interface SignalOutcome {
  signalId: number;
  entryTriggered: boolean;
  barsToEntry: number | null;
  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  stopHit: boolean;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  returnAtBar5Pct: number | null;
  returnAtBar10Pct: number | null;
  outcomeLabel: OutcomeLabel;
  evaluatedAt: string;
}

// ── Strategy Performance ────────────────────────────────────
export type EnvironmentFit = 'excellent' | 'good' | 'moderate' | 'poor' | 'insufficient_data';

export interface StrategyPerformanceSnapshot {
  strategyName: string;
  regime: string;
  volatilityState: string;
  sector: string | null;
  sampleSize: number;
  winRate: number;
  target1HitRate: number;
  avgMFE: number;
  avgMAE: number;
  environmentFit: EnvironmentFit;
}

// ── Confidence Calibration ──────────────────────────────────
export type CalibrationState = 'well_calibrated' | 'slightly_overconfident' | 'overconfident' | 'underconfident' | 'insufficient_data';

export interface ConfidenceCalibrationSnapshot {
  bucket: string;             // e.g. '70_79'
  sampleSize: number;
  target1HitRate: number;
  avgMFE: number;
  calibrationState: CalibrationState;
}

// ── Adaptive Recommendation ─────────────────────────────────
export interface AdaptiveRecommendation {
  strategyEnvironmentFit: EnvironmentFit;
  recommendedConfidenceModifier: number;
  reason: string;
  sampleSize: number;
  evidenceStrength: 'strong' | 'moderate' | 'weak';
}

// ── Decision Memory ─────────────────────────────────────────
export interface DecisionMemoryEntry {
  signalId: number;
  stage: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Portfolio Commentary ────────────────────────────────────
export interface PortfolioCommentary {
  marketToneSummary: string;
  clusterRiskSummary: string;
  capitalDeploymentNote: string;
  watchlistNote: string;
  topOpportunitiesNote: string;
}

// ── Feedback State (attached to signal) ─────────────────────
export interface FeedbackState {
  strategyRecentWinRate: number | null;
  strategyEnvironmentFit: EnvironmentFit;
  confidenceCalibrationState: CalibrationState;
}

// ── Phase 4 Signal Envelope ─────────────────────────────────
export interface Phase4SignalEnvelope {
  // Base signal fields
  symbol: string;
  signalType: string;
  signalSubtype: string;
  marketRegime: string;

  confidenceScore: number;
  adjustedConfidenceScore: number;
  confidenceBand: string;

  riskScore: number;

  // Phase 3 components
  tradePlan: any;
  positionSizing: any;
  portfolioFit: any;
  executionReadiness: any;

  // Phase 4 intelligence
  macroContext: MacroContext;
  newsContext: NewsContext;
  eventRisk: EventRiskSnapshot;
  contextualModifiers: ContextualModifierBreakdown;
  aiExplanation: AIExplanation;
  traderNarrative: TraderNarrative;
  freshness: SignalFreshness;
  feedbackState: FeedbackState;

  // Lifecycle
  lifecycleStatus: string;

  // Standard
  reasons: string[];
  warnings: string[];
  generatedAt: string;
}
