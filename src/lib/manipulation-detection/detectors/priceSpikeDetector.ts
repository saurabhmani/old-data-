// ════════════════════════════════════════════════════════════════
//  Price Spike & Pump-and-Dump Detector
//
//  Detects: abnormal price movements, pump-and-dump patterns,
//  gap-and-fade patterns suggesting manipulation.
// ════════════════════════════════════════════════════════════════

import type { ManipulationAlert, ManipulationEvidence, SeverityLevel, ManipulationType } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface CandleData {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Detect abnormal price movements for a single symbol.
 */
export function detectPriceSpike(
  symbol: string,
  candles: CandleData[],
  priceThresholdPct: number = 5.0,
  atrThresholdMultiple: number = 2.5,
): ManipulationAlert | null {
  if (candles.length < 22) return null;

  const latest = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const historical = candles.slice(-21, -1);

  // Calculate ATR
  const trValues = historical.map((c, i) => {
    const prev = i > 0 ? historical[i - 1] : c;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const atr = trValues.reduce((s, v) => s + v, 0) / trValues.length;

  // Price change
  const priceChangePct = prevCandle.close > 0
    ? ((latest.close - prevCandle.close) / prevCandle.close) * 100
    : 0;
  const todayRange = latest.high - latest.low;
  const atrMultiple = atr > 0 ? todayRange / atr : 0;

  // Gap detection
  const gapPct = prevCandle.close > 0
    ? ((latest.open - prevCandle.close) / prevCandle.close) * 100
    : 0;

  // Not significant enough
  if (Math.abs(priceChangePct) < priceThresholdPct && atrMultiple < atrThresholdMultiple) {
    return null;
  }

  // Volume context
  const avgVol = historical.reduce((s, c) => s + c.volume, 0) / historical.length;
  const volumeRatio = avgVol > 0 ? latest.volume / avgVol : 1;

  // Composite score
  let score = 0;
  score += Math.min(25, Math.abs(priceChangePct) * 3);
  score += Math.min(25, atrMultiple * 8);
  score += Math.min(20, Math.abs(gapPct) * 5);
  score += Math.min(15, (volumeRatio - 1) * 5);
  // Penalty if volume confirms (real move) — reduce manipulation score
  if (volumeRatio > 2 && Math.abs(priceChangePct) > 3) score -= 10;
  score = Math.min(100, Math.max(0, Math.round(score)));

  if (score < 30) return null;

  const severity: SeverityLevel = score >= 70 ? 'critical' : score >= 45 ? 'warning' : 'info';

  const evidence: ManipulationEvidence = {
    volumeRatio: Math.round(volumeRatio * 100) / 100,
    volumeZScore: null,
    volumeSpikeMultiple: null,
    priceChangePct: Math.round(priceChangePct * 100) / 100,
    priceVelocity: Math.round(Math.abs(priceChangePct) / 1 * 100) / 100,
    atrMultiple: Math.round(atrMultiple * 100) / 100,
    gapPct: Math.round(gapPct * 100) / 100,
    reversalPct: null,
    priorDaysUp: null,
    spreadWidening: null,
    newsPresent: false,
    earningsNearby: false,
    sectorMoving: false,
    correlatedCount: 0,
  };

  return {
    alertId: uuidv4(),
    symbol,
    type: 'price_spike',
    severity,
    score,
    detectedAt: new Date().toISOString(),
    status: 'new',
    headline: `${symbol}: ${Math.abs(priceChangePct).toFixed(1)}% price spike (${atrMultiple.toFixed(1)}x ATR)`,
    description: `${symbol} moved ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}% with ${atrMultiple.toFixed(1)}x ATR range expansion. Gap: ${gapPct > 0 ? '+' : ''}${gapPct.toFixed(2)}%. Volume: ${volumeRatio.toFixed(1)}x average.`,
    evidence,
    relatedSymbols: [],
  };
}

/**
 * Detect pump-and-dump pattern: sharp multi-day run-up followed by reversal.
 */
export function detectPumpAndDump(
  symbol: string,
  candles: CandleData[],
): ManipulationAlert | null {
  if (candles.length < 15) return null;

  const recent = candles.slice(-10);
  const latest = recent[recent.length - 1];

  // Find peak in recent window
  let peakIdx = 0;
  let peakPrice = 0;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].high > peakPrice) { peakPrice = recent[i].high; peakIdx = i; }
  }

  // Need peak to be in the middle (not start or end)
  if (peakIdx < 3 || peakIdx > recent.length - 2) return null;

  // Calculate run-up
  const runUpStart = recent[0].close;
  const runUpPct = runUpStart > 0 ? ((peakPrice - runUpStart) / runUpStart) * 100 : 0;

  // Calculate reversal from peak
  const reversalPct = peakPrice > 0 ? ((latest.close - peakPrice) / peakPrice) * 100 : 0;

  // Count consecutive up days before peak
  let priorDaysUp = 0;
  for (let i = peakIdx - 1; i >= 0; i--) {
    if (recent[i].close > (i > 0 ? recent[i - 1].close : recent[i].open)) priorDaysUp++;
    else break;
  }

  // Pump-and-dump: >15% run-up + >8% reversal + 3+ consecutive up days
  if (runUpPct < 15 || Math.abs(reversalPct) < 8 || priorDaysUp < 3) return null;

  // Volume during run-up vs reversal
  const runUpVol = recent.slice(0, peakIdx + 1).reduce((s, c) => s + c.volume, 0);
  const revVol = recent.slice(peakIdx + 1).reduce((s, c) => s + c.volume, 0);
  const volRatio = revVol > 0 ? runUpVol / revVol : 1;

  let score = 0;
  score += Math.min(30, runUpPct * 1.5);
  score += Math.min(25, Math.abs(reversalPct) * 2);
  score += Math.min(20, priorDaysUp * 5);
  score += volRatio > 2 ? 15 : volRatio > 1.5 ? 10 : 5;
  score = Math.min(100, Math.round(score));

  const severity: SeverityLevel = score >= 70 ? 'critical' : score >= 45 ? 'warning' : 'info';

  const evidence: ManipulationEvidence = {
    volumeRatio: Math.round(volRatio * 100) / 100,
    volumeZScore: null,
    volumeSpikeMultiple: null,
    priceChangePct: Math.round(runUpPct * 100) / 100,
    priceVelocity: Math.round(runUpPct / peakIdx * 100) / 100,
    atrMultiple: null,
    gapPct: null,
    reversalPct: Math.round(reversalPct * 100) / 100,
    priorDaysUp,
    spreadWidening: null,
    newsPresent: false,
    earningsNearby: false,
    sectorMoving: false,
    correlatedCount: 0,
  };

  return {
    alertId: uuidv4(),
    symbol,
    type: 'pump_and_dump',
    severity,
    score,
    detectedAt: new Date().toISOString(),
    status: 'new',
    headline: `${symbol}: Pump-and-dump pattern detected (+${runUpPct.toFixed(0)}% then ${reversalPct.toFixed(0)}%)`,
    description: `${symbol} rose ${runUpPct.toFixed(1)}% over ${priorDaysUp} consecutive up days, then reversed ${Math.abs(reversalPct).toFixed(1)}% from peak. Classic pump-and-dump signature.`,
    evidence,
    relatedSymbols: [],
  };
}
