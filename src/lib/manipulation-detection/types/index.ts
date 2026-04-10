// ════════════════════════════════════════════════════════════════
//  Manipulation Detection Engine — Type System
// ════════════════════════════════════════════════════════════════

export type ManipulationType =
  | 'volume_anomaly'       // unusual volume spike without news catalyst
  | 'price_spike'          // abnormal price movement in short window
  | 'pump_and_dump'        // sharp run-up followed by crash
  | 'wash_trading'         // circular volume patterns
  | 'spoofing_pattern'     // order book stuffing signals
  | 'insider_pattern'      // pre-event unusual activity
  | 'front_running'        // trades ahead of large block orders
  | 'coordinated_move';    // multiple correlated stocks move together unusually

export type SeverityLevel = 'info' | 'warning' | 'critical';

export type AlertStatus = 'new' | 'acknowledged' | 'investigating' | 'confirmed' | 'dismissed';

export interface ManipulationAlert {
  alertId: string;
  symbol: string;
  type: ManipulationType;
  severity: SeverityLevel;
  score: number;              // 0-100 composite manipulation score
  detectedAt: string;
  status: AlertStatus;
  headline: string;
  description: string;
  evidence: ManipulationEvidence;
  relatedSymbols: string[];
}

export interface ManipulationEvidence {
  // Volume metrics
  volumeRatio: number | null;           // current vs avg volume
  volumeZScore: number | null;          // standard deviations from mean
  volumeSpikeMultiple: number | null;   // multiple of 20-day avg

  // Price metrics
  priceChangePct: number | null;        // price change triggering alert
  priceVelocity: number | null;         // rate of price change
  atrMultiple: number | null;           // move as multiple of ATR
  gapPct: number | null;               // opening gap percentage

  // Pattern metrics
  reversalPct: number | null;           // for pump-and-dump: % reversal
  priorDaysUp: number | null;           // consecutive up days before crash
  spreadWidening: number | null;        // bid-ask spread anomaly

  // Context
  newsPresent: boolean;                 // was there a catalyst?
  earningsNearby: boolean;              // near earnings date?
  sectorMoving: boolean;                // is the whole sector moving?
  correlatedCount: number;              // how many correlated stocks moved
}

export interface ManipulationScanConfig {
  symbols: string[];
  lookbackDays: number;
  volumeThresholdMultiple: number;      // volume spike threshold (e.g., 3x)
  priceThresholdPct: number;            // min % move to flag
  atrThresholdMultiple: number;         // min ATR multiple to flag
  minScoreToAlert: number;              // minimum composite score
}

export interface ManipulationScanResult {
  scannedSymbols: number;
  alertsGenerated: number;
  alerts: ManipulationAlert[];
  scanDuration: number;
  scanDate: string;
}

export interface ManipulationSummary {
  totalAlerts: number;
  byType: Record<ManipulationType, number>;
  bySeverity: Record<SeverityLevel, number>;
  topAlerts: ManipulationAlert[];
  recentTrend: 'increasing' | 'stable' | 'decreasing';
}

export const DEFAULT_SCAN_CONFIG: ManipulationScanConfig = {
  symbols: [],          // filled from universe
  lookbackDays: 60,
  volumeThresholdMultiple: 3.0,
  priceThresholdPct: 5.0,
  atrThresholdMultiple: 2.5,
  minScoreToAlert: 40,
};
