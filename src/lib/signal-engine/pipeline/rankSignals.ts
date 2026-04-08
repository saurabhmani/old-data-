// ════════════════════════════════════════════════════════════════
//  Signal Ranking — Phase 1
// ════════════════════════════════════════════════════════════════

import type { QuantSignal } from '../types/signalEngine.types';

export function rankSignals(signals: QuantSignal[]): QuantSignal[] {
  const scored = signals.map((s) => ({
    signal: s,
    compositeScore: computeRankScore(s),
  }));

  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  return scored.map((item, index) => ({
    ...item.signal,
    rank: index + 1,
  }));
}

function computeRankScore(s: QuantSignal): number {
  // Weighted composite: confidence (40%), inverse risk (25%), volume (20%), structure (15%)
  const confidenceComponent = s.confidenceScore * 0.40;
  const riskComponent = (100 - s.riskScore) * 0.25;
  const volumeComponent = Math.min(s.features.volume.volumeVs20dAvg * 20, 100) * 0.20;
  const structureComponent = Math.min(
    s.features.structure.breakoutDistancePct > 0 && s.features.structure.breakoutDistancePct <= 3
      ? 80
      : s.features.structure.breakoutDistancePct <= 5
        ? 50
        : 20,
    100,
  ) * 0.15;

  return confidenceComponent + riskComponent + volumeComponent + structureComponent;
}
