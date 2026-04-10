// ════════════════════════════════════════════════════════════════
//  Manipulation Detection Engine — Public API
// ════════════════════════════════════════════════════════════════

export { scanForManipulation, getManipulationDashboard } from './scanner';
export { detectVolumeAnomaly } from './detectors/volumeAnomalyDetector';
export { detectPriceSpike, detectPumpAndDump } from './detectors/priceSpikeDetector';
export { loadAlerts, updateAlertStatus, ensureManipulationTables } from './repository/alertRepository';
export type {
  ManipulationAlert, ManipulationEvidence, ManipulationType,
  SeverityLevel, AlertStatus, ManipulationScanConfig,
  ManipulationScanResult, ManipulationSummary,
} from './types';
export { DEFAULT_SCAN_CONFIG } from './types';
