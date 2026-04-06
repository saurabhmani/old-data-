/**
 * Market Intelligence Service
 *
 * Computes market-wide intelligence purely from cached data.
 * RULE: Zero direct external API calls inside this file.
 *       All data comes from Redis → MySQL fallback only.
 *
 * Redis keys consumed:
 *   stock:{SYMBOL}            — MarketSnapshot per symbol (written by scheduler)
 *   nse:/allIndices           — Raw NSE index array (written by nse.ts)
 *   nse:/fiidiiTradeReact     — FII/DII raw array (written by nse.ts)
 *   nse:/live-analysis-variations?index=NIFTY 500 — gainers/losers
 *   market:explanation        — MarketExplanation object (written by marketExplanation.ts)
 *
 * MySQL fallback queries (only when Redis is cold):
 *   rankings  — for gainers/losers/trend when no Redis snapshots exist
 *   macro_data — for FII/DII when NSE cache is absent
 *   candles   — for volatility calculation
 */

import { cacheGet, cacheSet }  from '@/lib/redis';
import { db }                  from '@/lib/db';
import type { MarketSnapshot } from './marketDataService';

// ── Output types ─────────────────────────────────────────────────

export type MarketTrend = 'Strong Bull' | 'Bull' | 'Neutral' | 'Bear' | 'Strong Bear';

export interface SectorStrength {
  sector:         string;
  change_percent: number;
  trend:          'up' | 'down' | 'flat';
}

export interface MoverEntry {
  symbol:         string;
  name:           string;
  ltp:            number;
  change_percent: number;
  change_abs:     number;
  volume:         number;
}

export interface FiiDiiEntry {
  date:       string;
  fii_buy:    number;
  fii_sell:   number;
  fii_net:    number;
  dii_buy:    number;
  dii_sell:   number;
  dii_net:    number;
  fii_label:  string;  // human-readable
  dii_label:  string;
}

export interface VolatilityMetrics {
  nifty_vix:        number | null;
  avg_range_pct:    number;          // avg (high-low)/close across universe
  high_vol_count:   number;          // symbols with range > 3%
  low_vol_count:    number;          // symbols with range < 1%
  volatility_label: 'Very High' | 'High' | 'Normal' | 'Low';
}

export interface MarketIntelligenceResult {
  market_trend:    MarketTrend;
  trend_score:     number;           // -100 to +100
  advancing:       number;           // count of stocks up
  declining:       number;           // count of stocks down
  unchanged:       number;
  sector_strength: SectorStrength[];
  top_gainers:     MoverEntry[];
  top_losers:      MoverEntry[];
  fii_dii:         FiiDiiEntry[];
  volatility:      VolatilityMetrics;
  as_of:           string;           // ISO timestamp of most recent data
  data_source:     'redis' | 'mysql' | 'mixed';
  cache_age_sec:   number | null;    // how old the underlying stock data is
}

// ── Output cache ─────────────────────────────────────────────────
const INTEL_CACHE_KEY = 'market:intelligence';
const INTEL_CACHE_TTL = 60; // seconds — refreshed by scheduler anyway

// ── Sector index → Redis key mapping ─────────────────────────────
// These keys are written by nse.ts → nseGet('/allIndices')
const NSE_INDICES_KEY  = 'nse:/allIndices';
const NSE_FIIDII_KEY   = 'nse:/fiidiiTradeReact';
const NSE_GAINERS_KEY  = 'nse:/live-analysis-variations?index=NIFTY%20500';

const SECTOR_INDEX_NAMES: Record<string, string> = {
  'NIFTY BANK':        'Banking',
  'NIFTY IT':          'IT',
  'NIFTY PHARMA':      'Pharma',
  'NIFTY AUTO':        'Auto',
  'NIFTY FMCG':        'FMCG',
  'NIFTY REALTY':      'Realty',
  'NIFTY METAL':       'Metal',
  'NIFTY ENERGY':      'Energy',
  'NIFTY MIDCAP 100':  'Midcap',
  'NIFTY SMALLCAP 100':'Smallcap',
};

// ── Helpers ───────────────────────────────────────────────────────

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function trendFromScore(score: number): MarketTrend {
  if (score >= 50)  return 'Strong Bull';
  if (score >= 15)  return 'Bull';
  if (score <= -50) return 'Strong Bear';
  if (score <= -15) return 'Bear';
  return 'Neutral';
}

// ── Layer 1: Read all stock:* snapshots from Redis ───────────────

async function readStockSnapshotsFromRedis(
  symbols: string[]
): Promise<{ snaps: MarketSnapshot[]; hitCount: number }> {
  const snaps: MarketSnapshot[] = [];
  let hitCount = 0;

  await Promise.all(symbols.map(async sym => {
    const snap = await cacheGet<MarketSnapshot>(`stock:${sym.toUpperCase()}`);
    if (snap) { snaps.push(snap); hitCount++; }
  }));

  return { snaps, hitCount };
}

// ── Layer 2: MySQL fallback for movers ───────────────────────────

async function getMoversMysql(
  type: 'gainers' | 'losers',
  limit = 10
): Promise<MoverEntry[]> {
  try {
    const order = type === 'gainers' ? 'DESC' : 'ASC';
    const { rows } = await db.query(`
      SELECT r.tradingsymbol AS symbol,
             COALESCE(r.name, r.tradingsymbol) AS name,
             COALESCE(r.ltp, 0)        AS ltp,
             COALESCE(r.pct_change, 0) AS change_percent,
             0                          AS change_abs,
             COALESCE(r.volume, 0)     AS volume
      FROM rankings r
      INNER JOIN (
        SELECT tradingsymbol, MAX(score) AS max_score
        FROM rankings
        GROUP BY tradingsymbol
      ) best ON r.tradingsymbol = best.tradingsymbol AND r.score = best.max_score
      WHERE r.pct_change IS NOT NULL
      GROUP BY r.tradingsymbol
      ORDER BY r.pct_change ${order}
      LIMIT ?
    `, [limit]);

    return (rows as any[]).map(r => ({
      symbol:         String(r.symbol || ''),
      name:           String(r.name   || r.symbol || ''),
      ltp:            toNum(r.ltp),
      change_percent: toNum(r.change_percent),
      change_abs:     toNum(r.change_abs),
      volume:         toNum(r.volume),
    }));
  } catch {
    return [];
  }
}

// ── Layer 2: MySQL fallback for trend score ───────────────────────

async function getTrendScoreMysql(): Promise<{
  score: number; advancing: number; declining: number; unchanged: number;
}> {
  try {
    const { rows } = await db.query(`
      SELECT
        SUM(CASE WHEN pct_change > 0 THEN 1 ELSE 0 END) AS advancing,
        SUM(CASE WHEN pct_change < 0 THEN 1 ELSE 0 END) AS declining,
        SUM(CASE WHEN pct_change = 0 OR pct_change IS NULL THEN 1 ELSE 0 END) AS unchanged,
        AVG(pct_change) AS avg_change
      FROM (
        SELECT r.tradingsymbol, r.pct_change
        FROM rankings r
        INNER JOIN (
          SELECT tradingsymbol, MAX(score) AS max_score
          FROM rankings
          GROUP BY tradingsymbol
        ) best ON r.tradingsymbol = best.tradingsymbol AND r.score = best.max_score
        GROUP BY r.tradingsymbol
      ) deduped
    `);
    const row        = (rows as any[])[0] ?? {};
    const advancing  = toNum(row.advancing);
    const declining  = toNum(row.declining);
    const unchanged  = toNum(row.unchanged);
    const total      = advancing + declining + unchanged || 1;
    const breadthPct = ((advancing - declining) / total) * 100;
    const avgChg     = toNum(row.avg_change);
    const score      = Math.round((breadthPct * 0.7) + (avgChg * 0.3 * 10));
    return { score: Math.max(-100, Math.min(100, score)), advancing, declining, unchanged };
  } catch {
    return { score: 0, advancing: 0, declining: 0, unchanged: 0 };
  }
}

// ── Layer 2: MySQL fallback for volatility ───────────────────────

async function getVolatilityMysql(): Promise<VolatilityMetrics> {
  try {
    const { rows } = await db.query(`
      SELECT
        AVG((c.high - c.low) / NULLIF(c.close, 0) * 100) AS avg_range_pct,
        SUM(CASE WHEN (c.high - c.low) / NULLIF(c.close, 0) * 100 > 3 THEN 1 ELSE 0 END) AS high_vol,
        SUM(CASE WHEN (c.high - c.low) / NULLIF(c.close, 0) * 100 < 1 THEN 1 ELSE 0 END) AS low_vol
      FROM candles c
      INNER JOIN (
        SELECT instrument_key, MAX(ts) AS max_ts
        FROM candles
        WHERE candle_type = 'eod'
        GROUP BY instrument_key
      ) latest ON c.instrument_key = latest.instrument_key AND c.ts = latest.max_ts
      WHERE c.candle_type = 'eod'
        AND c.close > 0
    `);
    const row        = (rows as any[])[0] ?? {};
    const avgRange   = toNum(row.avg_range_pct, 2);
    const highVol    = toNum(row.high_vol);
    const lowVol     = toNum(row.low_vol);
    const label: VolatilityMetrics['volatility_label'] =
      avgRange > 4   ? 'Very High' :
      avgRange > 2.5 ? 'High' :
      avgRange > 1   ? 'Normal'    : 'Low';

    return { nifty_vix: null, avg_range_pct: avgRange, high_vol_count: highVol, low_vol_count: lowVol, volatility_label: label };
  } catch {
    return { nifty_vix: null, avg_range_pct: 0, high_vol_count: 0, low_vol_count: 0, volatility_label: 'Normal' };
  }
}

// ── FII/DII normaliser ────────────────────────────────────────────

function normaliseFiiDii(raw: any[]): FiiDiiEntry[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.slice(0, 5).map(row => {
    // NSE FII/DII field names vary — handle both formats
    const fiiBuy  = toNum(row.fiiBuyValue  ?? row.buyValue  ?? row.FII_BUY  ?? 0);
    const fiiSell = toNum(row.fiiSellValue ?? row.sellValue ?? row.FII_SELL ?? 0);
    const diiBuy  = toNum(row.diiBuyValue  ?? row.DIIbuyValue ?? row.DII_BUY ?? 0);
    const diiSell = toNum(row.diiSellValue ?? row.DIIsellValue ?? row.DII_SELL ?? 0);
    const fiiNet  = fiiBuy - fiiSell;
    const diiNet  = diiBuy - diiSell;
    const date    = String(row.date ?? row.tradeDate ?? row.Date ?? '');

    return {
      date,
      fii_buy:   fiiBuy,
      fii_sell:  fiiSell,
      fii_net:   fiiNet,
      dii_buy:   diiBuy,
      dii_sell:  diiSell,
      dii_net:   diiNet,
      fii_label: fiiNet > 0
        ? `FII net bought ₹${(Math.abs(fiiNet) / 100).toFixed(0)} Cr`
        : `FII net sold ₹${(Math.abs(fiiNet) / 100).toFixed(0)} Cr`,
      dii_label: diiNet > 0
        ? `DII net bought ₹${(Math.abs(diiNet) / 100).toFixed(0)} Cr`
        : `DII net sold ₹${(Math.abs(diiNet) / 100).toFixed(0)} Cr`,
    };
  });
}

// ── Main compute function ─────────────────────────────────────────

export async function computeMarketIntelligence(): Promise<MarketIntelligenceResult> {

  // ── Step 0: Check intelligence cache (pre-computed result) ──────
  const cached = await cacheGet<MarketIntelligenceResult>(INTEL_CACHE_KEY);
  if (cached) return cached;

  let dataSource: MarketIntelligenceResult['data_source'] = 'redis';
  let oldestSnapshotMs: number | null = null;

  // ── Step 1: Load universe symbols from rankings ──────────────────
  const { rows: universeRows } = await db.query(`
    SELECT DISTINCT r.tradingsymbol AS symbol,
           COALESCE(r.name, r.tradingsymbol) AS name,
           COALESCE(r.instrument_key, CONCAT('NSE_EQ|', r.tradingsymbol)) AS instrument_key
    FROM rankings r
    INNER JOIN (
      SELECT tradingsymbol, MAX(score) AS max_score
      FROM rankings
      GROUP BY tradingsymbol
    ) best ON r.tradingsymbol = best.tradingsymbol AND r.score = best.max_score
    ORDER BY r.score DESC
    LIMIT 500
  `).catch(() => ({ rows: [] }));

  const symbols = (universeRows as any[]).map(r => String(r.symbol || '')).filter(Boolean);
  const nameMap: Record<string, string> = {};
  (universeRows as any[]).forEach((r: any) => { nameMap[String(r.symbol).toUpperCase()] = String(r.name || r.symbol); });

  // ── Step 2: Read stock snapshots from Redis ──────────────────────
  const { snaps, hitCount } = symbols.length
    ? await readStockSnapshotsFromRedis(symbols)
    : { snaps: [], hitCount: 0 };

  if (hitCount < symbols.length * 0.5) {
    // Less than 50% Redis hit rate — flag as mixed/mysql
    dataSource = hitCount === 0 ? 'mysql' : 'mixed';
  }

  // ── Step 3: Compute trend + breadth ─────────────────────────────
  let advancing = 0, declining = 0, unchanged = 0, trendScore = 0;
  let allChangePcts: number[] = [];
  let allRangePcts:  number[] = [];

  if (snaps.length > 0) {
    for (const s of snaps) {
      const pct = toNum(s.change_percent);
      if (pct > 0.1)       advancing++;
      else if (pct < -0.1) declining++;
      else                 unchanged++;
      allChangePcts.push(pct);
      if (s.high > 0 && s.close > 0) {
        allRangePcts.push(((s.high - s.low) / s.close) * 100);
      }
      if (s.timestamp && (oldestSnapshotMs === null || s.timestamp < oldestSnapshotMs)) {
        oldestSnapshotMs = s.timestamp;
      }
    }
    const total      = snaps.length || 1;
    const breadthPct = ((advancing - declining) / total) * 100;
    const avgChg     = allChangePcts.reduce((a, b) => a + b, 0) / total;
    trendScore       = Math.max(-100, Math.min(100, Math.round((breadthPct * 0.7) + (avgChg * 10 * 0.3))));
  } else {
    // Redis cold — use MySQL
    const mysql = await getTrendScoreMysql();
    trendScore  = mysql.score;
    advancing   = mysql.advancing;
    declining   = mysql.declining;
    unchanged   = mysql.unchanged;
    dataSource  = 'mysql';
  }

  // ── Step 4: Top gainers + losers ────────────────────────────────
  let topGainers: MoverEntry[] = [];
  let topLosers:  MoverEntry[] = [];

  if (snaps.length > 0) {
    // Derive from Redis snapshots — no DB call needed
    const sorted = [...snaps].sort((a, b) => b.change_percent - a.change_percent);
    topGainers = sorted.slice(0, 10).map(s => ({
      symbol:         s.symbol,
      name:           nameMap[s.symbol] ?? s.symbol,
      ltp:            s.ltp,
      change_percent: s.change_percent,
      change_abs:     s.change_abs,
      volume:         s.volume,
    }));
    topLosers = sorted.slice(-10).reverse().map(s => ({
      symbol:         s.symbol,
      name:           nameMap[s.symbol] ?? s.symbol,
      ltp:            s.ltp,
      change_percent: s.change_percent,
      change_abs:     s.change_abs,
      volume:         s.volume,
    }));
  } else {
    // MySQL fallback
    [topGainers, topLosers] = await Promise.all([
      getMoversMysql('gainers', 10),
      getMoversMysql('losers',  10),
    ]);
  }

  // ── Step 5: Sector strength from NSE indices cache ───────────────
  // These keys are written by nse.ts fetchNseIndices() — no direct call here
  const sectorStrength: SectorStrength[] = [];
  const cachedIndices = await cacheGet<any>(NSE_INDICES_KEY);
  const indicesData: any[] = cachedIndices?.data ?? [];

  if (indicesData.length) {
    for (const [indexName, sectorLabel] of Object.entries(SECTOR_INDEX_NAMES)) {
      const idx = indicesData.find((d: any) => d.index === indexName || d.name === indexName);
      if (!idx) continue;
      const chg = toNum(idx.percentChange ?? idx.variation ?? 0);
      sectorStrength.push({
        sector:         sectorLabel,
        change_percent: chg,
        trend:          chg > 0.1 ? 'up' : chg < -0.1 ? 'down' : 'flat',
      });
    }
  }
  // Sort: leaders first, then laggards
  sectorStrength.sort((a, b) => b.change_percent - a.change_percent);

  // ── Step 6: FII/DII ─────────────────────────────────────────────
  // Key nse:/fiidiiTradeReact written by nse.ts
  const cachedFii = await cacheGet<any>(NSE_FIIDII_KEY);
  let fiiDii: FiiDiiEntry[] = [];
  if (Array.isArray(cachedFii) && cachedFii.length) {
    fiiDii = normaliseFiiDii(cachedFii);
  } else {
    // MySQL fallback — macro_data table
    try {
      const { rows: macroRows } = await db.query(`
        SELECT indicator, value, period, updated_at
        FROM macro_data
        WHERE indicator IN ('FII_NET', 'DII_NET', 'FII_BUY', 'FII_SELL', 'DII_BUY', 'DII_SELL')
        ORDER BY updated_at DESC
        LIMIT 12
      `);
      if ((macroRows as any[]).length) {
        const m: Record<string, number> = {};
        (macroRows as any[]).forEach((r: any) => { m[r.indicator] = toNum(r.value); });
        const fiiNet = toNum(m.FII_NET ?? (m.FII_BUY ?? 0) - (m.FII_SELL ?? 0));
        const diiNet = toNum(m.DII_NET ?? (m.DII_BUY ?? 0) - (m.DII_SELL ?? 0));
        fiiDii = [{
          date:      '',
          fii_buy:   toNum(m.FII_BUY),
          fii_sell:  toNum(m.FII_SELL),
          fii_net:   fiiNet,
          dii_buy:   toNum(m.DII_BUY),
          dii_sell:  toNum(m.DII_SELL),
          dii_net:   diiNet,
          fii_label: fiiNet > 0 ? `FII net bought ₹${(Math.abs(fiiNet)/100).toFixed(0)} Cr` : `FII net sold ₹${(Math.abs(fiiNet)/100).toFixed(0)} Cr`,
          dii_label: diiNet > 0 ? `DII net bought ₹${(Math.abs(diiNet)/100).toFixed(0)} Cr` : `DII net sold ₹${(Math.abs(diiNet)/100).toFixed(0)} Cr`,
        }];
      }
    } catch { /* FII data unavailable */ }
  }

  // ── Step 7: Volatility ───────────────────────────────────────────
  let volatility: VolatilityMetrics;
  if (allRangePcts.length > 10) {
    // Derive from Redis snapshot ranges
    const avgRange   = allRangePcts.reduce((a, b) => a + b, 0) / allRangePcts.length;
    const highVolCnt = allRangePcts.filter(r => r > 3).length;
    const lowVolCnt  = allRangePcts.filter(r => r < 1).length;
    const label: VolatilityMetrics['volatility_label'] =
      avgRange > 4   ? 'Very High' :
      avgRange > 2.5 ? 'High'      :
      avgRange > 1   ? 'Normal'    : 'Low';

    // Try to get India VIX from cached indices
    const vixIdx = indicesData.find((d: any) => d.index === 'INDIA VIX' || d.name === 'INDIA VIX');
    const niftyVix = vixIdx ? toNum(vixIdx.last ?? vixIdx.lastPrice ?? null) : null;

    volatility = {
      nifty_vix:        niftyVix,
      avg_range_pct:    parseFloat(avgRange.toFixed(2)),
      high_vol_count:   highVolCnt,
      low_vol_count:    lowVolCnt,
      volatility_label: label,
    };
  } else {
    // MySQL fallback
    volatility = await getVolatilityMysql();
    // Still try VIX from cached indices if available
    if (indicesData.length) {
      const vixIdx = indicesData.find((d: any) => d.index === 'INDIA VIX' || d.name === 'INDIA VIX');
      if (vixIdx) volatility.nifty_vix = toNum(vixIdx.last ?? vixIdx.lastPrice ?? null);
    }
  }

  // ── Step 8: Assemble result ──────────────────────────────────────
  const cacheAgeSec = oldestSnapshotMs
    ? Math.round((Date.now() - oldestSnapshotMs) / 1000)
    : null;

  const result: MarketIntelligenceResult = {
    market_trend:    trendFromScore(trendScore),
    trend_score:     trendScore,
    advancing,
    declining,
    unchanged,
    sector_strength: sectorStrength,
    top_gainers:     topGainers,
    top_losers:      topLosers,
    fii_dii:         fiiDii,
    volatility,
    as_of:           new Date().toISOString(),
    data_source:     dataSource,
    cache_age_sec:   cacheAgeSec,
  };

  // Cache the computed result for 60s — reduces repeated DB/Redis fan-out
  await cacheSet(INTEL_CACHE_KEY, result, INTEL_CACHE_TTL);

  return result;
}
