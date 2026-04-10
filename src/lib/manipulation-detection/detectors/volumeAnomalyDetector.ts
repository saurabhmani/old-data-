// ════════════════════════════════════════════════════════════════
//  Volume Anomaly Detector
//
//  Flags unusual volume spikes that deviate significantly from
//  historical norms without corresponding news catalysts.
// ════════════════════════════════════════════════════════════════

import type { ManipulationAlert, ManipulationEvidence, SeverityLevel } from '../types';
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
 * Detect volume anomalies for a single symbol.
 * Returns alert if volume is abnormally high relative to recent history.
 */
export function detectVolumeAnomaly(
  symbol: string,
  candles: CandleData[],
  thresholdMultiple: number = 3.0,
  lookback: number = 20,
): ManipulationAlert | null {
  if (candles.length < lookback + 1) return null;

  const latest = candles[candles.length - 1];
  const historical = candles.slice(-lookback - 1, -1);

  // Calculate volume statistics
  const volumes = historical.map(c => c.volume);
  const avgVolume = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const stdDev = Math.sqrt(
    volumes.reduce((s, v) => s + Math.pow(v - avgVolume, 2), 0) / volumes.length,
  );

  if (avgVolume === 0) return null;

  const volumeRatio = latest.volume / avgVolume;
  const zScore = stdDev > 0 ? (latest.volume - avgVolume) / stdDev : 0;

  // Not anomalous
  if (volumeRatio < thresholdMultiple) return null;

  // Calculate price change
  const prevClose = candles[candles.length - 2]?.close ?? latest.open;
  const priceChangePct = prevClose > 0 ? ((latest.close - prevClose) / prevClose) * 100 : 0;

  // ATR for context
  const atrValues = historical.map(c => c.high - c.low);
  const avgAtr = atrValues.reduce((s, v) => s + v, 0) / atrValues.length;
  const todayRange = latest.high - latest.low;
  const atrMultiple = avgAtr > 0 ? todayRange / avgAtr : 0;

  // Composite score
  let score = 0;
  score += Math.min(30, (volumeRatio - thresholdMultiple) * 10);  // volume intensity
  score += Math.min(20, Math.abs(zScore) * 5);                    // statistical deviation
  score += Math.min(20, Math.abs(priceChangePct) * 4);            // price impact
  score += Math.min(15, atrMultiple * 5);                         // range expansion
  score += volumeRatio > 5 ? 15 : volumeRatio > 4 ? 10 : 0;     // extreme volume bonus
  score = Math.min(100, Math.round(score));

  const severity: SeverityLevel = score >= 70 ? 'critical' : score >= 45 ? 'warning' : 'info';

  const evidence: ManipulationEvidence = {
    volumeRatio: Math.round(volumeRatio * 100) / 100,
    volumeZScore: Math.round(zScore * 100) / 100,
    volumeSpikeMultiple: Math.round(volumeRatio * 10) / 10,
    priceChangePct: Math.round(priceChangePct * 100) / 100,
    priceVelocity: null,
    atrMultiple: Math.round(atrMultiple * 100) / 100,
    gapPct: null,
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
    type: 'volume_anomaly',
    severity,
    score,
    detectedAt: new Date().toISOString(),
    status: 'new',
    headline: `${symbol}: ${volumeRatio.toFixed(1)}x average volume spike`,
    description: `${symbol} traded ${volumeRatio.toFixed(1)}x its 20-day average volume (${zScore.toFixed(1)} std devs). Price moved ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}%. Range was ${atrMultiple.toFixed(1)}x ATR.`,
    evidence,
    relatedSymbols: [],
  };
}
