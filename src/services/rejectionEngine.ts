/**
 * Rejection Engine — Quantorus365
 *
 * 11 sequential hard gates. No signal reaches the user without passing all gates.
 * All thresholds loaded from systemConfigService (DB-backed, stance-adjusted).
 *
 * Rejection priority:
 *   HARD BLOCK — signal discarded, logged, never shown
 *   SOFT WARNING — signal passes but warning attached
 */

import { db }                            from '@/lib/db';
import { getConfig, applyStanceOverrides,
         type SystemConfig }             from './systemConfigService';
import type { ScenarioResult }           from './scenarioEngine';
import type { StanceResult }             from './marketStanceEngine';
import type { PortfolioFitResult }       from './portfolioFitService';
import type { ConfidenceResult }         from './confidenceEngine';

// ── Types ──────────────────────────────────────────────────────────

export type RejectionCode =
  | 'BELOW_MIN_RR' | 'LOW_CONFIDENCE' | 'POOR_RISK_SCORE'
  | 'LOW_LIQUIDITY' | 'SCENARIO_BLOCKED' | 'SECTOR_OVEREXPOSED'
  | 'HIGH_CORRELATION' | 'POOR_DATA_QUALITY' | 'UNREALISTIC_STOP'
  | 'PORTFOLIO_CAPACITY' | 'PORTFOLIO_FIT' | 'STANCE_BLOCKED'
  | 'REGIME_MISMATCH' | 'NO_STRATEGY';

export interface RejectionResult {
  approved:          boolean;
  rejection_reasons: string[];
  rejection_codes:   RejectionCode[];
  soft_warnings:     string[];
  rejection_score:   number;  // 0–100, higher = more reasons to reject
  blocked_by: {
    risk:         boolean;
    portfolio:    boolean;
    scenario:     boolean;
    liquidity:    boolean;
    data_quality: boolean;
    stance:       boolean;
    regime:       boolean;
  };
}

export interface RejectionInput {
  instrument_key:    string;
  tradingsymbol:     string;
  exchange:          string;
  direction:         string;
  confidence:        number;
  risk_score:        number;
  rr:                number;
  timeframe:         string;
  data_quality:      number;
  volume:            number;
  atr14:             number | null;
  ltp:               number;
  stop_distance:     number;
  strategy_tag:      string;
  regime:            string;
  scenario:          ScenarioResult;
  stance:            StanceResult;
  portfolio_fit:     PortfolioFitResult;
  confidence_result: ConfidenceResult;
  sector:            string;
}

// ── Gate implementations ───────────────────────────────────────────

function gateDataQuality(input: RejectionInput, cfg: SystemConfig) {
  if (input.data_quality < cfg.MIN_DATA_QUALITY)
    return { code: 'POOR_DATA_QUALITY' as RejectionCode,
             reason: `Data quality ${input.data_quality.toFixed(2)} below threshold ${cfg.MIN_DATA_QUALITY}` };
  return null;
}

function gateNoStrategy(input: RejectionInput) {
  if (!input.strategy_tag || input.strategy_tag === 'NO_STRATEGY')
    return { code: 'NO_STRATEGY' as RejectionCode,
             reason: 'No clear strategy pattern — no structural edge present' };
  return null;
}

function gateScenario(input: RejectionInput) {
  if (input.scenario.blocked_strategies.includes(input.strategy_tag))
    return { code: 'SCENARIO_BLOCKED' as RejectionCode,
             reason: `Strategy "${input.strategy_tag}" blocked in ${input.scenario.scenario_tag} scenario` };
  if (input.scenario.scenario_tag === 'no_trade_uncertain')
    return { code: 'SCENARIO_BLOCKED' as RejectionCode,
             reason: 'No-trade scenario — all strategies blocked pending market clarity' };
  return null;
}

function gateStance(input: RejectionInput) {
  const allowed = input.stance.stance_config.allowed_strategy_types;
  if (allowed.length > 0 && !allowed.includes(input.strategy_tag)) {
    if (['capital_preservation','defensive'].includes(input.stance.market_stance))
      return { code: 'STANCE_BLOCKED' as RejectionCode,
               reason: `${input.stance.market_stance} stance: "${input.strategy_tag}" not permitted` };
  }
  return null;
}

function gateRegime(input: RejectionInput) {
  const isBuy  = input.direction === 'BUY';
  const isBear = ['BEAR','STRONG_BEAR'].includes(input.regime);
  const isBull = ['BULL','STRONG_BULL'].includes(input.regime);
  const isMR   = ['mean_reversion','MEAN_REVERSION','event_driven','EVENT_DRIVEN','short_covering_rally'].includes(input.strategy_tag);

  if (isBuy && isBear && !isMR)
    return { code: 'REGIME_MISMATCH' as RejectionCode,
             reason: `BUY blocked in ${input.regime} — only mean-reversion / event setups allowed` };
  if (!isBuy && isBull && input.regime === 'STRONG_BULL' && !isMR)
    return { code: 'REGIME_MISMATCH' as RejectionCode,
             reason: 'SELL blocked in STRONG_BULL — counter-trend without clear catalyst' };
  return null;
}

function gateRR(input: RejectionInput, cfg: SystemConfig) {
  const minRR = input.timeframe === 'positional' ? cfg.MIN_RR_POSITIONAL : cfg.MIN_RR_SWING;
  if (input.rr < minRR)
    return { code: 'BELOW_MIN_RR' as RejectionCode,
             reason: `R:R ${input.rr.toFixed(1)} below minimum ${minRR} for ${input.timeframe}` };
  return null;
}

function gateConfidence(input: RejectionInput, cfg: SystemConfig) {
  if (input.confidence < cfg.MIN_CONFIDENCE)
    return { code: 'LOW_CONFIDENCE' as RejectionCode,
             reason: `Confidence ${input.confidence} below stance-adjusted minimum ${cfg.MIN_CONFIDENCE}` };
  return null;
}

function gateRiskScore(input: RejectionInput, cfg: SystemConfig) {
  if (input.risk_score > cfg.MAX_RISK_SCORE)
    return { code: 'POOR_RISK_SCORE' as RejectionCode,
             reason: `Risk score ${input.risk_score} exceeds maximum ${cfg.MAX_RISK_SCORE}` };
  return null;
}

function gateLiquidity(input: RejectionInput, cfg: SystemConfig) {
  if (input.volume < cfg.MIN_VOLUME_INTRADAY)
    return { code: 'LOW_LIQUIDITY' as RejectionCode,
             reason: `Volume ${input.volume.toLocaleString()} below liquidity threshold ${cfg.MIN_VOLUME_INTRADAY}` };
  return null;
}

function gateStop(input: RejectionInput, cfg: SystemConfig) {
  if (!input.atr14 || input.atr14 <= 0) return null;
  const ratio = input.stop_distance / input.atr14;
  if (ratio > cfg.MAX_STOP_ATR_MULTIPLE)
    return { code: 'UNREALISTIC_STOP' as RejectionCode,
             reason: `Stop is ${ratio.toFixed(1)}× ATR — too wide for current volatility` };
  if (ratio < cfg.MIN_STOP_ATR_MULTIPLE)
    return { code: 'UNREALISTIC_STOP' as RejectionCode,
             reason: `Stop is ${ratio.toFixed(2)}× ATR — too tight, likely noise-triggered` };
  return null;
}

function gatePortfolio(input: RejectionInput, cfg: SystemConfig) {
  if (input.portfolio_fit.portfolio_fit_score < cfg.MIN_PORTFOLIO_FIT) {
    const reason = input.portfolio_fit.warnings[0] ??
      `Portfolio fit ${input.portfolio_fit.portfolio_fit_score} below minimum ${cfg.MIN_PORTFOLIO_FIT}`;
    return { code: 'PORTFOLIO_FIT' as RejectionCode, reason };
  }
  if (input.portfolio_fit.sector_penalty >= 50)
    return { code: 'SECTOR_OVEREXPOSED' as RejectionCode,
             reason: input.portfolio_fit.warnings.find(w => w.includes('Sector')) ?? 'Sector overexposed' };
  return null;
}

// ── Main engine ────────────────────────────────────────────────────

export async function runRejectionEngine(input: RejectionInput): Promise<RejectionResult> {
  // Load stance-adjusted thresholds
  const baseCfg = await getConfig();
  const cfg     = applyStanceOverrides(baseCfg, input.stance.market_stance);

  const rejection_reasons: string[] = [];
  const rejection_codes:   RejectionCode[] = [];
  const soft_warnings:     string[] = [];

  const blocked_by = {
    risk: false, portfolio: false, scenario: false,
    liquidity: false, data_quality: false, stance: false, regime: false,
  };

  // Run gates in order (data quality first, portfolio last)
  const gates = [
    { fn: () => gateDataQuality(input, cfg), category: 'data_quality' },
    { fn: () => gateNoStrategy(input),        category: 'scenario' },
    { fn: () => gateScenario(input),          category: 'scenario' },
    { fn: () => gateStance(input),            category: 'stance' },
    { fn: () => gateRegime(input),            category: 'regime' },
    { fn: () => gateRR(input, cfg),           category: 'risk' },
    { fn: () => gateConfidence(input, cfg),   category: 'risk' },
    { fn: () => gateRiskScore(input, cfg),    category: 'risk' },
    { fn: () => gateLiquidity(input, cfg),    category: 'liquidity' },
    { fn: () => gateStop(input, cfg),         category: 'risk' },
    { fn: () => gatePortfolio(input, cfg),    category: 'portfolio' },
  ] as const;

  for (const { fn, category } of gates) {
    const result = fn();
    if (!result) continue;
    rejection_reasons.push(result.reason);
    rejection_codes.push(result.code);
    (blocked_by as any)[category] = true;
  }

  // Soft warnings for approved signals
  if (rejection_reasons.length === 0) {
    if (input.portfolio_fit.warnings.length) soft_warnings.push(...input.portfolio_fit.warnings.slice(0, 2));
    if (input.confidence_result.penalized_by.length) soft_warnings.push(`Low confidence factors: ${input.confidence_result.penalized_by.slice(0,2).join(', ')}`);
  }

  const rejection_score = Math.min(100,
    rejection_reasons.length * 15 +
    (input.confidence_result.conviction_band === 'reject' ? 30 : 0) +
    (blocked_by.risk ? 20 : 0) + (blocked_by.portfolio ? 15 : 0)
  );

  return {
    approved: rejection_reasons.length === 0,
    rejection_reasons,
    rejection_codes,
    soft_warnings,
    rejection_score,
    blocked_by,
  };
}

// ── DB persistence ─────────────────────────────────────────────────

export async function persistRejectionLog(
  signalId: number | null,
  symbol:   string,
  input:    Partial<RejectionInput>,
  result:   RejectionResult
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO signal_rejections
        (signal_id, symbol, strategy_code, regime_code,
         confidence_score, risk_score, rr_ratio,
         liquidity_score, portfolio_fit_score,
         approved, rejection_reason_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      signalId, symbol,
      input.strategy_tag ?? null, input.regime ?? null,
      input.confidence ?? null, input.risk_score ?? null,
      input.rr ?? null,
      input.volume ? Math.min(100, Math.round((input.volume ?? 0) / 10_000)) : null,
      input.portfolio_fit?.portfolio_fit_score ?? null,
      result.approved ? 1 : 0,
      JSON.stringify({ codes: result.rejection_codes, reasons: result.rejection_reasons }),
    ]);
  } catch {}
}
