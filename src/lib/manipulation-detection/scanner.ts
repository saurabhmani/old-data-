// ════════════════════════════════════════════════════════════════
//  Manipulation Scanner — Orchestrates all detectors
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { ManipulationAlert, ManipulationScanConfig, ManipulationScanResult, ManipulationSummary } from './types';
import { DEFAULT_SCAN_CONFIG } from './types';
import { detectVolumeAnomaly } from './detectors/volumeAnomalyDetector';
import { detectPriceSpike, detectPumpAndDump } from './detectors/priceSpikeDetector';
import { saveAlerts, getAlertSummary } from './repository/alertRepository';

interface CandleRow {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch recent candles for a symbol from the database.
 */
async function fetchCandles(symbol: string, days: number): Promise<CandleRow[]> {
  const { rows } = await db.query<CandleRow>(
    `SELECT ts, open, high, low, close, volume
     FROM candles
     WHERE instrument_key LIKE ?
       AND candle_type = 'eod'
       AND interval_unit = '1day'
     ORDER BY ts DESC
     LIMIT ?`,
    [`%${symbol}%`, days + 10],
  );

  return rows.reverse().map(r => ({
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts as any).toISOString().split('T')[0],
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

/**
 * Run all manipulation detectors across the given universe.
 */
export async function scanForManipulation(
  config: Partial<ManipulationScanConfig> = {},
): Promise<ManipulationScanResult> {
  const cfg = { ...DEFAULT_SCAN_CONFIG, ...config };
  const startMs = Date.now();
  const allAlerts: ManipulationAlert[] = [];

  for (const symbol of cfg.symbols) {
    try {
      const candles = await fetchCandles(symbol, cfg.lookbackDays);
      if (candles.length < 22) continue;

      // Run all detectors
      const volumeAlert = detectVolumeAnomaly(symbol, candles, cfg.volumeThresholdMultiple);
      if (volumeAlert && volumeAlert.score >= cfg.minScoreToAlert) {
        allAlerts.push(volumeAlert);
      }

      const priceAlert = detectPriceSpike(symbol, candles, cfg.priceThresholdPct, cfg.atrThresholdMultiple);
      if (priceAlert && priceAlert.score >= cfg.minScoreToAlert) {
        allAlerts.push(priceAlert);
      }

      const pumpAlert = detectPumpAndDump(symbol, candles);
      if (pumpAlert && pumpAlert.score >= cfg.minScoreToAlert) {
        allAlerts.push(pumpAlert);
      }
    } catch (err) {
      console.error(`[ManipulationScan] Error scanning ${symbol}:`, err);
    }
  }

  // Sort by score descending
  allAlerts.sort((a, b) => b.score - a.score);

  // Persist alerts
  if (allAlerts.length > 0) {
    try {
      await saveAlerts(allAlerts);
    } catch (err) {
      console.error('[ManipulationScan] Failed to persist alerts:', err);
    }
  }

  const durationMs = Date.now() - startMs;
  console.log(`[ManipulationScan] Scanned ${cfg.symbols.length} symbols, ${allAlerts.length} alerts in ${durationMs}ms`);

  return {
    scannedSymbols: cfg.symbols.length,
    alertsGenerated: allAlerts.length,
    alerts: allAlerts,
    scanDuration: durationMs,
    scanDate: new Date().toISOString(),
  };
}

/**
 * Get manipulation alert summary for dashboard display.
 */
export async function getManipulationDashboard(): Promise<ManipulationSummary> {
  return getAlertSummary();
}
