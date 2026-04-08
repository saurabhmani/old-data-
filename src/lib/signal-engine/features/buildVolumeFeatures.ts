// ════════════════════════════════════════════════════════════════
//  Volume Feature Builder
// ════════════════════════════════════════════════════════════════

import type { VolumeFeatures, Candle } from '../types/signalEngine.types';
import { volumes, lastCandle } from '../utils/candles';
import { mean, round, safeDivide } from '../utils/math';
import { VOLUME_AVG_PERIOD } from '../constants/signalEngine.constants';

export function buildVolumeFeatures(candles: Candle[]): VolumeFeatures {
  const current = lastCandle(candles);
  const volSeries = volumes(candles);
  const len = volSeries.length;

  // Average volume of the 20 candles before the current one
  const lookbackVols = volSeries.slice(Math.max(0, len - VOLUME_AVG_PERIOD - 1), len - 1);
  const avgVolume20 = round(mean(lookbackVols), 0);

  const volumeVs20dAvg = round(safeDivide(current.volume, avgVolume20), 2);

  // Breakout volume ratio: current volume vs max volume in lookback
  const maxLookbackVol = Math.max(...lookbackVols, 1);
  const breakoutVolumeRatio = round(safeDivide(current.volume, maxLookbackVol), 2);

  return {
    volume: current.volume,
    avgVolume20,
    volumeVs20dAvg,
    breakoutVolumeRatio,
  };
}
