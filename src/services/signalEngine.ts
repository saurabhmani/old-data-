/**
 * Signal Engine — Quantorus365 Institutional Intelligence Stack
 *
 * Decision flow (in order):
 *   1. Ingest and normalize market data
 *   2. Feature engineering (36 features)
 *   3. Factor scoring (8 buckets, 0–100 each)
 *   4. Strategy selection (10 strategies)
 *   5. Scenario engine (which strategies allowed today)
 *   6. Market stance engine (threshold config for today)
 *   7. Portfolio fit scoring
 *   8. ATR-based price levels
 *   9. Confidence engine (9-component weighted)
 *  10. Hard rejection engine (all gates)
 *  11. Only then → signal emitted
 *
 * No signal bypasses step 10.
 */

import { db }                         from '@/lib/db';
import { cacheGet, cacheSet }         from '@/lib/redis';
import { getSnapshotSync }            from './dataAggregator';
import { fetchNseQuote }              from './nse';
import { computeAtr14, getMarketSnapshot } from './marketDataService';
import { getConfig, applyStanceOverrides } from './systemConfigService';
import type { MarketSnapshot }        from './marketDataService';
import { computeScenario }            from './scenarioEngine';
import { computeMarketStance,
         getCurrentStanceConfig }     from './marketStanceEngine';
import { getPortfolioContext,
         computePortfolioFit,
         persistPortfolioFitLog }     from './portfolioFitService';
import { computeConfidence,
         getConvictionBand,
         persistConfidenceLog,
         type ConfidenceResult }      from './confidenceEngine';
import { runRejectionEngine,
         persistRejectionLog,
         type RejectionResult }       from './rejectionEngine';

// ════════════════════════════════════════════════════════════════
//  TYPES — extended with all new intelligence fields
// ════════════════════════════════════════════════════════════════

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD';
export type Timeframe       = 'swing' | 'positional' | 'intraday';
export type RiskLevel       = 'Low' | 'Medium' | 'High' | 'Very High';
export type MarketRegime    = 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'CHOPPY' | 'BEAR' | 'STRONG_BEAR';

export type ScenarioTag =
  | 'TREND_CONTINUATION'    | 'BREAKOUT_CONTINUATION' | 'PULLBACK_IN_TREND'
  | 'MEAN_REVERSION'        | 'MOMENTUM_EXPANSION'    | 'RELATIVE_STRENGTH_LEADER'
  | 'VOLATILITY_COMPRESSION'| 'EVENT_DRIVEN'          | 'SECTOR_ROTATION'
  | 'WATCHLIST_OPPORTUNITY' | 'NO_STRATEGY';

export interface FactorScores {
  momentum:           number;
  trend_quality:      number;
  volatility:         number;
  liquidity:          number;
  participation:      number;
  relative_strength:  number;
  breakout_readiness: number;
  mean_reversion:     number;
}

export interface SignalReason {
  rank:         number;
  factor_key:   string | null;
  text:         string;
  contribution: number;
}

export interface Signal {
  // Identity
  instrument_key:    string;
  tradingsymbol:     string;
  exchange:          string;

  // Direction
  direction:         SignalDirection;
  timeframe:         Timeframe;

  // Core quality scores
  confidence:        number;   // from confidenceEngine (9-component)
  risk_score:        number;   // 0–100 higher = riskier
  opportunity_score: number;   // final display score
  portfolio_fit:     number;   // from portfolioFitService

  // Extended intelligence fields
  conviction_band:   string;   // high_conviction | actionable | watchlist | reject
  market_stance:     string;   // aggressive | selective | defensive | capital_preservation
  regime_alignment:  number;   // 0–100 from confidenceEngine

  // Rejection
  rejection_reasons: string[];
  rejection_codes:   string[];
  soft_warnings:     string[];
  blocked_by: {
    risk: boolean; portfolio: boolean; scenario: boolean;
    liquidity: boolean; data_quality: boolean; stance: boolean; regime: boolean;
  };

  // Labels
  risk:         RiskLevel;
  scenario_tag: ScenarioTag;
  regime:       MarketRegime;

  // Price levels
  entry_price: number;
  stop_loss:   number;
  target1:     number;
  target2:     number;
  risk_reward: number;

  // Details
  factor_scores:       FactorScores;
  confidence_components?: Record<string, number>;
  reasons:             SignalReason[];
  data_quality:        number;
  generated_at:        string;
  score_raw:           number;
}

// ════════════════════════════════════════════════════════════════
//  INTERNAL THRESHOLDS (before DB loads stance-adjusted ones)
// ════════════════════════════════════════════════════════════════

// Thresholds loaded dynamically from systemConfigService — see getConfig()

// ════════════════════════════════════════════════════════════════
//  FEATURE ENGINEERING
// ════════════════════════════════════════════════════════════════

interface Features {
  ltp:                number;
  change_pct_1d:      number;
  vwap_deviation:     number | null;
  sma20_deviation:    number | null;
  week52_position:    number | null;
  near_52w_high_pct:  number | null;
  volume_ratio_5d:    number | null;
  volume_ratio_20d:   number | null;
  delivery_pct:       number | null;
  atr14:              number | null;
  day_range_pct:      number;
  vol_compression:    number | null;
  rsi_14:             number | null;
  sma20:              number | null;
  sma50:              number | null;
  slope_sma20:        number | null;
  pcr:                number | null;
  oi_change_pct:      number | null;
  data_quality:       number;
}

async function computeHistoricalFeatures(instrumentKey: string) {
  try {
    const { rows } = await db.query(`
      SELECT close, volume FROM candles
      WHERE instrument_key=? AND interval_unit='1day'
      ORDER BY ts DESC LIMIT 55
    `, [instrumentKey]);
    if (rows.length < 5) return { sma20:null, sma50:null, rsi14:null, avgVol5:null, avgVol20:null, sma20Slope:null, volCompression:null };

    const closes  = (rows as any[]).map(r => Number(r.close)).reverse();
    const volumes = (rows as any[]).map(r => Number(r.volume)).reverse();
    const len     = closes.length;
    const avg     = (arr: number[], n: number) => arr.slice(Math.max(0, arr.length-n)).reduce((a,b)=>a+b,0)/Math.min(n,arr.length);

    const sma20 = len >= 20 ? avg(closes,20) : null;
    const sma50 = len >= 50 ? avg(closes,50) : null;

    let rsi14: number | null = null;
    if (len >= 15) {
      const gains: number[] = []; const losses: number[] = [];
      for (let i = len-14; i < len; i++) {
        const d = closes[i]-closes[i-1];
        gains.push(Math.max(d,0)); losses.push(Math.max(-d,0));
      }
      const ag = avg(gains,14); const al = avg(losses,14);
      rsi14 = al===0 ? 100 : parseFloat((100-100/(1+ag/al)).toFixed(1));
    }

    const avgVol5  = len >= 5  ? avg(volumes,5)  : null;
    const avgVol20 = len >= 20 ? avg(volumes,20) : null;

    let sma20Slope: number | null = null;
    if (len >= 25) {
      const smas = [];
      for (let i = len-5; i < len; i++) smas.push(avg(closes.slice(Math.max(0,i-19),i+1),20));
      sma20Slope = smas[4]-smas[0];
    }

    let volCompression: number | null = null;
    if (len >= 20) {
      const rets = closes.slice(-21).map((c,i,a)=>i>0?(c-a[i-1])/a[i-1]:0).slice(1);
      const std  = (arr: number[]) => { const m=arr.reduce((a,b)=>a+b,0)/arr.length; return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); };
      const v5  = std(rets.slice(-5)); const v20 = std(rets);
      volCompression = v20>0 ? v5/v20 : null;
    }

    return { sma20, sma50, rsi14, avgVol5, avgVol20, sma20Slope, volCompression };
  } catch {
    return { sma20:null, sma50:null, rsi14:null, avgVol5:null, avgVol20:null, sma20Slope:null, volCompression:null };
  }
}

async function buildFeatures(snap: MarketSnapshot): Promise<Features> {
  const hist = await computeHistoricalFeatures(snap.instrument_key);

  const vwapDev  = snap.vwap&&snap.ltp ? (snap.ltp-snap.vwap)/snap.vwap : null;
  const sma20Dev = hist.sma20&&snap.ltp ? (snap.ltp-hist.sma20)/hist.sma20 : null;
  const w52pos   = snap.week52_high>0&&snap.week52_low>=0&&snap.week52_high>snap.week52_low
    ? ((snap.ltp-snap.week52_low)/(snap.week52_high-snap.week52_low))*100 : null;
  const near52   = snap.week52_high>0 ? (snap.week52_high-snap.ltp)/snap.week52_high*100 : null;
  const vr5      = hist.avgVol5&&snap.volume  ? snap.volume/hist.avgVol5  : null;
  const vr20     = hist.avgVol20&&snap.volume ? snap.volume/hist.avgVol20 : null;
  const dayRange = snap.ltp>0 ? (snap.high-snap.low)/snap.ltp*100 : 0;

  return {
    ltp: snap.ltp, change_pct_1d: snap.change_percent,
    vwap_deviation: vwapDev, sma20_deviation: sma20Dev,
    week52_position: w52pos, near_52w_high_pct: near52,
    volume_ratio_5d: vr5, volume_ratio_20d: vr20,
    delivery_pct: snap.delivery_pct, atr14: snap.atr14,
    day_range_pct: dayRange, vol_compression: hist.volCompression,
    rsi_14: hist.rsi14, sma20: hist.sma20, sma50: hist.sma50,
    slope_sma20: hist.sma20Slope, pcr: null, oi_change_pct: null,
    data_quality: snap.data_quality,
  };
}

// ════════════════════════════════════════════════════════════════
//  FACTOR SCORING (8 buckets)
// ════════════════════════════════════════════════════════════════

function computeFactors(f: Features): FactorScores {
  // Momentum
  let mom = 50;
  if (f.rsi_14!=null) mom += f.rsi_14>=70?25:f.rsi_14>=50?15:f.rsi_14<=30?-25:(f.rsi_14-50)*0.75;
  if (f.change_pct_1d!==0) mom += Math.max(-3,Math.min(3,f.change_pct_1d))*5;
  if (f.sma20_deviation!=null) mom += Math.max(-15,Math.min(15,f.sma20_deviation*100*1.5));
  if (f.slope_sma20!=null) mom += f.slope_sma20>0?10:f.slope_sma20<0?-10:0;
  const momentum = Math.round(Math.max(0,Math.min(100,mom)));

  // Trend quality
  let tq = 50;
  if (f.week52_position!=null) tq += f.week52_position>=75?20:f.week52_position>=50?10:f.week52_position<=25?-20:-5;
  if (f.sma20!=null&&f.ltp) tq += f.ltp>f.sma20?15:-15;
  if (f.sma50!=null&&f.ltp) tq += f.ltp>f.sma50?10:-10;
  if (f.slope_sma20!=null)  tq += f.slope_sma20>0?5:-5;
  const trend_quality = Math.round(Math.max(0,Math.min(100,tq)));

  // Volatility
  let vol = 50;
  if (f.vol_compression!=null) vol += f.vol_compression<0.7?25:f.vol_compression>1.3?-10:0;
  if (f.atr14&&f.ltp>0) { const atrPct=(f.atr14/f.ltp)*100; vol += f.day_range_pct>atrPct*1.2?15:f.day_range_pct<atrPct*0.5?-10:0; }
  const volatility = Math.round(Math.max(0,Math.min(100,vol)));

  // Liquidity
  let liq = 40;
  if (f.volume_ratio_20d!=null) liq += f.volume_ratio_20d>=2.0?40:f.volume_ratio_20d>=1.3?20:f.volume_ratio_20d<0.5?-20:0;
  if (f.delivery_pct!=null) liq += f.delivery_pct>=60?20:f.delivery_pct>=40?8:f.delivery_pct<20?-10:0;
  const liquidity = Math.round(Math.max(0,Math.min(100,liq)));

  // Participation
  let par = 40;
  if (f.volume_ratio_5d!=null) par += f.volume_ratio_5d>=1.5?30:f.volume_ratio_5d>=1.1?15:f.volume_ratio_5d<0.7?-15:0;
  if (f.oi_change_pct!=null) par += f.oi_change_pct>5?15:f.oi_change_pct<-5?-10:0;
  if (f.pcr!=null) par += f.pcr<0.7?15:f.pcr>1.5?-10:0;
  const participation = Math.round(Math.max(0,Math.min(100,par)));

  // Relative strength
  let rs = 50;
  if (f.week52_position!=null) rs = f.week52_position;
  if (f.change_pct_1d>1) rs = Math.min(100,rs+10); else if (f.change_pct_1d<-1) rs = Math.max(0,rs-10);
  const relative_strength = Math.round(rs);

  // Breakout readiness
  let br = 30;
  if (f.near_52w_high_pct!=null) br += f.near_52w_high_pct<=3?40:f.near_52w_high_pct<=8?20:f.near_52w_high_pct>=25?-10:0;
  if (f.vol_compression!=null&&f.vol_compression<0.7) br += 20;
  if (f.volume_ratio_5d!=null&&f.volume_ratio_5d>=1.5) br += 10;
  const breakout_readiness = Math.round(Math.max(0,Math.min(100,br)));

  // Mean reversion
  let mr = 30;
  if (f.rsi_14!=null) mr += f.rsi_14<=25?50:f.rsi_14<=35?30:f.rsi_14>=70?10:0;
  if (f.sma20_deviation!=null&&f.sma20_deviation<-0.05) mr += 20;
  const mean_reversion = Math.round(Math.max(0,Math.min(100,mr)));

  return { momentum, trend_quality, volatility, liquidity, participation, relative_strength, breakout_readiness, mean_reversion };
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY SELECTION
// ════════════════════════════════════════════════════════════════

function selectStrategy(f: FactorScores, feat: Features, regime: string) {
  const candidates: Array<{tag: ScenarioTag; score: number; direction: SignalDirection}> = [];

  // ── BUY candidates ──
  if (f.trend_quality>=65&&f.momentum>=60&&regime!=='BEAR'&&regime!=='STRONG_BEAR')
    candidates.push({tag:'TREND_CONTINUATION',score:(f.trend_quality+f.momentum)/2,direction:'BUY'});
  if (f.breakout_readiness>=65&&f.liquidity>=55)
    candidates.push({tag:'BREAKOUT_CONTINUATION',score:(f.breakout_readiness+f.participation)/2,direction:'BUY'});
  if (f.trend_quality>=70&&feat.rsi_14!=null&&feat.rsi_14>=40&&feat.rsi_14<=55)
    candidates.push({tag:'PULLBACK_IN_TREND',score:f.trend_quality*0.6+f.momentum*0.4,direction:'BUY'});
  if (f.mean_reversion>=65&&regime!=='STRONG_BEAR')
    candidates.push({tag:'MEAN_REVERSION',score:f.mean_reversion,direction:'BUY'});
  if (f.momentum>=75&&f.participation>=65)
    candidates.push({tag:'MOMENTUM_EXPANSION',score:(f.momentum+f.participation)/2,direction:'BUY'});
  if (f.relative_strength>=70&&(regime==='BULL'||regime==='STRONG_BULL'))
    candidates.push({tag:'RELATIVE_STRENGTH_LEADER',score:f.relative_strength*0.7+f.trend_quality*0.3,direction:'BUY'});
  if (f.volatility>=65&&feat.vol_compression!=null&&feat.vol_compression<0.7)
    candidates.push({tag:'VOLATILITY_COMPRESSION',score:f.volatility,direction:'BUY'});

  // ── SELL candidates ──
  // Price-action bearish: stock is falling today — strongest SELL signal
  if (feat.change_pct_1d <= -0.5)
    candidates.push({tag:'TREND_CONTINUATION',score:Math.round(Math.min(100, 50 + Math.abs(feat.change_pct_1d)*10 + (100-f.momentum)*0.3)),direction:'SELL'});
  // Bearish trend: weak momentum OR weak trend in any non-bull regime
  if ((f.momentum<=45||f.trend_quality<=45)&&regime!=='BULL'&&regime!=='STRONG_BULL')
    candidates.push({tag:'TREND_CONTINUATION',score:(100-f.momentum+100-f.trend_quality)/2,direction:'SELL'});
  // Overbought mean reversion: RSI stretched high
  if (feat.rsi_14!=null&&feat.rsi_14>=65)
    candidates.push({tag:'MEAN_REVERSION',score:Math.round(feat.rsi_14*0.6+(100-f.momentum)*0.4),direction:'SELL'});
  // Breakdown: near 52-week low with weak relative strength
  if (f.relative_strength<=35&&feat.week52_position!=null&&feat.week52_position<=30)
    candidates.push({tag:'BREAKOUT_CONTINUATION',score:(100-f.relative_strength+100-f.trend_quality)/2,direction:'SELL'});
  // Momentum collapse: dropping momentum with low participation
  if (f.momentum<=40&&f.participation<=50)
    candidates.push({tag:'MOMENTUM_EXPANSION',score:(100-f.momentum+100-f.participation)/2,direction:'SELL'});
  // Weak relative strength in non-bull regime
  if (f.relative_strength<=40&&regime!=='BULL'&&regime!=='STRONG_BULL')
    candidates.push({tag:'RELATIVE_STRENGTH_LEADER',score:(100-f.relative_strength)*0.7+(100-f.trend_quality)*0.3,direction:'SELL'});

  // When price is falling, always prefer SELL candidates over BUY
  if (candidates.length > 0 && feat.change_pct_1d <= -0.3) {
    const sellCandidates = candidates.filter(c => c.direction === 'SELL');
    if (sellCandidates.length > 0) {
      return sellCandidates.sort((a, b) => b.score - a.score)[0];
    }
  }

  if (!candidates.length) {
    // Fallback: infer direction from live price action when historical data is insufficient
    if (feat.change_pct_1d >= 2 && f.momentum >= 50)
      return {tag:'MOMENTUM_EXPANSION' as ScenarioTag, score: f.momentum, direction:'BUY' as SignalDirection};
    if (feat.change_pct_1d >= 0.5 && f.momentum >= 45)
      return {tag:'WATCHLIST_OPPORTUNITY' as ScenarioTag, score: Math.max(f.momentum, f.relative_strength), direction:'BUY' as SignalDirection};
    if (feat.change_pct_1d <= -2 && f.momentum <= 45)
      return {tag:'TREND_CONTINUATION' as ScenarioTag, score: 100 - f.momentum, direction:'SELL' as SignalDirection};
    if (feat.change_pct_1d <= -0.5)
      return {tag:'WATCHLIST_OPPORTUNITY' as ScenarioTag, score: Math.max(100 - f.momentum, f.mean_reversion), direction:'SELL' as SignalDirection};
    // Overbought/weak stocks even on green days
    if (feat.rsi_14 != null && feat.rsi_14 >= 70)
      return {tag:'MEAN_REVERSION' as ScenarioTag, score: Math.round(feat.rsi_14 * 0.6 + (100 - f.momentum) * 0.4), direction:'SELL' as SignalDirection};
    if (f.momentum <= 35 && f.trend_quality <= 40)
      return {tag:'TREND_CONTINUATION' as ScenarioTag, score: (100 - f.momentum + 100 - f.trend_quality) / 2, direction:'SELL' as SignalDirection};
    // Assign direction based on overall factor weakness
    if (f.momentum <= 45)
      return {tag:'WATCHLIST_OPPORTUNITY' as ScenarioTag, score: 100 - f.momentum, direction:'SELL' as SignalDirection};
    return {tag:'NO_STRATEGY' as ScenarioTag, score:0, direction:'HOLD' as SignalDirection};
  }
  return candidates.sort((a,b)=>b.score-a.score)[0];
}

function computeComposite(f: FactorScores, regime: string): number {
  const rm = regime==='STRONG_BULL'?1.10:regime==='BULL'?1.05:regime==='CHOPPY'?0.85:regime==='BEAR'?0.80:regime==='STRONG_BEAR'?0.70:1.0;
  const w  = f.momentum*0.25+f.trend_quality*0.20+f.liquidity*0.15+f.participation*0.15+f.relative_strength*0.15+f.breakout_readiness*0.10;
  return Math.round(Math.max(0,Math.min(100,w*rm)));
}

function computeRiskScore(feat: Features, f: FactorScores, snap: MarketSnapshot): number {
  let risk = 30;
  if (feat.day_range_pct>3) risk+=20; else if (feat.day_range_pct>2) risk+=10;
  if (feat.volume_ratio_20d!=null&&feat.volume_ratio_20d<0.5) risk+=15;
  if (snap.data_quality<0.50) risk+=20; else if (snap.data_quality<0.75) risk+=10;
  if (snap.volume<1000) risk+=10;
  if (f.momentum>=85||f.momentum<=15) risk+=10;
  return Math.round(Math.max(0,Math.min(100,risk)));
}

function computePriceLevels(
  snap: MarketSnapshot,
  feat: Features,
  dir:  SignalDirection,
  tf:   Timeframe,
  cfg:  { MIN_RR_SWING: number; MIN_RR_POSITIONAL: number }
) {
  const entry = snap.ltp;
  const atr   = feat.atr14 && feat.atr14 > 0 ? feat.atr14 : snap.ltp * 0.015;

  // ATR multiplier for stop distance: wider for positional, tighter for swing
  const slMul = tf === 'positional' ? 2.0 : 1.5;

  // Target distance uses centralized R:R minimum from systemConfigService
  const minRR  = tf === 'positional' ? cfg.MIN_RR_POSITIONAL : cfg.MIN_RR_SWING;
  const slDist = atr * slMul;
  const t1Dist = slDist * minRR;
  const t2Dist = slDist * (minRR * 1.5);

  if (dir === 'BUY') return {
    stop_loss:   parseFloat((entry - slDist).toFixed(2)),
    target1:     parseFloat((entry + t1Dist).toFixed(2)),
    target2:     parseFloat((entry + t2Dist).toFixed(2)),
    risk_reward: parseFloat((t1Dist / slDist).toFixed(1)),
  };
  return {
    stop_loss:   parseFloat((entry + slDist).toFixed(2)),
    target1:     parseFloat((entry - t1Dist).toFixed(2)),
    target2:     parseFloat((entry - t2Dist).toFixed(2)),
    risk_reward: parseFloat((t1Dist / slDist).toFixed(1)),
  };
}

async function readMarketRegime(): Promise<string> {
  try { const c=await cacheGet<{regime:string}>('market:regime'); if(c?.regime) return c.regime; } catch {}
  return 'NEUTRAL';
}

function buildReasons(f: FactorScores, feat: Features, strategy: {tag:ScenarioTag}, dir: SignalDirection): SignalReason[] {
  const pairs: Array<[string,number,string]> = [
    ['momentum',f.momentum,'momentum'],['trend_quality',f.trend_quality,'trend'],
    ['liquidity',f.liquidity,'liquidity'],['participation',f.participation,'participation'],
    ['relative_strength',f.relative_strength,'relative_strength'],['breakout_readiness',f.breakout_readiness,'breakout'],
    ['mean_reversion',f.mean_reversion,'mean_reversion'],
  ];
  const sorted = [...pairs].sort((a,b) => dir==='BUY' ? b[1]-a[1] : a[1]-b[1]).slice(0,5);
  return sorted.map(([name,score,key],i) => {
    let text = '';
    if (name==='momentum') text = feat.rsi_14!=null ? `RSI ${feat.rsi_14} — ${score>=60?'momentum expanding':'momentum contracting'}` : `Momentum ${score}/100`;
    else if (name==='trend_quality') text = feat.sma20_deviation!=null ? `Price ${feat.sma20_deviation>0?'above':'below'} 20-day SMA by ${Math.abs(feat.sma20_deviation*100).toFixed(1)}%` : `Trend quality ${score}/100`;
    else if (name==='liquidity') text = feat.volume_ratio_20d!=null ? `Volume ${feat.volume_ratio_20d.toFixed(1)}x 20-day average` : `Liquidity ${score}/100`;
    else if (name==='breakout_readiness') text = feat.near_52w_high_pct!=null ? `${feat.near_52w_high_pct.toFixed(1)}% from 52-week high` : `Breakout readiness ${score}/100`;
    else if (name==='relative_strength') text = feat.week52_position!=null ? `At ${feat.week52_position.toFixed(0)}th percentile of 52-week range` : `Relative strength ${score}/100`;
    else if (name==='mean_reversion') text = feat.rsi_14!=null ? `RSI ${feat.rsi_14} — ${feat.rsi_14<=35?'oversold, mean reversion potential':'reversion context'}` : `Mean reversion ${score}/100`;
    else text = `${name.replace(/_/g,' ')}: ${score}/100`;
    return { rank:i+1, factor_key:key, text, contribution:(score-50)/50 };
  });
}

// ════════════════════════════════════════════════════════════════
//  MAIN — generateSignal (full decision chain)
// ════════════════════════════════════════════════════════════════

export async function generateSignal(
  instrumentKey: string,
  tradingsymbol: string,
  exchange:      string
): Promise<Signal | null> {

  const cacheKey = `signal:${instrumentKey}`;
  const cached   = await cacheGet<Signal>(cacheKey);
  if (cached) return cached;

  // ── Step 1: Market data (Redis → NSE → MySQL → Yahoo) ──────────
  const snap = await getSnapshotSync(tradingsymbol, instrumentKey)
    ?? await getMarketSnapshot(tradingsymbol, instrumentKey);

  if (!snap || snap.ltp <= 0) return null;

  // ── Step 2: Features ───────────────────────────────────────────
  const features = await buildFeatures(snap);

  // ── Step 3: Factor scoring ────────────────────────────────────
  const factors = computeFactors(features);

  // ── Step 4: Regime ────────────────────────────────────────────
  const regime = await readMarketRegime() as MarketRegime;

  // ── Step 5: Strategy selection ────────────────────────────────
  const strategy = selectStrategy(factors, features, regime);

  // ── Step 5a: Composite ─────────────────────────────────────────
  const composite = computeComposite(factors, regime);

  // ── Step 5b: Scenario + Stance ────────────────────────────────
  const [scenario, stanceConfig] = await Promise.all([
    computeScenario().catch(() => null),
    getCurrentStanceConfig(),
  ]);

  // ── Step 6: Price levels ──────────────────────────────────────
  const timeframe: Timeframe =
    strategy.tag === 'PULLBACK_IN_TREND' || strategy.tag === 'SECTOR_ROTATION'
      ? 'positional' : 'swing';
  // Load centralized config for RR thresholds — required by computePriceLevels and confidenceEngine
  const sysCfg  = await getConfig();
  const levels  = computePriceLevels(snap, features, strategy.direction, timeframe, sysCfg);

  // ── Step 7: Portfolio fit ─────────────────────────────────────
  const riskScore = computeRiskScore(features, factors, snap);

  // Get sector for this symbol
  let sector = 'Other';
  try {
    const { rows } = await db.query(
      `SELECT sector FROM instruments WHERE tradingsymbol=? AND is_active=TRUE LIMIT 1`,
      [tradingsymbol]
    );
    if ((rows[0] as any)?.sector) sector = (rows[0] as any).sector;
  } catch {}

  // Use first found portfolio context (system-level — user-agnostic for scheduler)
  // For user-specific signals, portfolioId is resolved in the API layer
  const portfolioCtx = {
    total_positions: 0, open_longs: 0, open_shorts: 0,
    sector_counts: {}, sector_exposure_pct: {}, strategy_counts: {},
    capital_at_risk_pct: 0, unrealized_pnl_pct: 0, largest_sector_pct: 0,
    most_crowded_strategy: '', correlation_avg: 0, drawdown_pct: 0,
  };
  const portfolioFitResult = computePortfolioFit(portfolioCtx, sector, strategy.tag, strategy.direction);

  // ── Step 8: Confidence (9 components) ────────────────────────
  const confidenceResult: ConfidenceResult = await computeConfidence({
    factors,
    direction:        strategy.direction,
    compositeScore:   composite,
    strategyTag:      strategy.tag,
    regime,
    scenarioTag:      scenario?.scenario_tag ?? 'no_trade_uncertain',
    snap,
    portfolioFit:     portfolioFitResult.portfolio_fit_score,
    rr:               levels.risk_reward,
    timeframe,
    volumeRatio20d:   features.volume_ratio_20d,
  });

  // Use stance-adjusted confidence minimum
  const effectiveConf = Math.max(confidenceResult.confidence_score, 0);

  // ── Step 9: Build conviction band + market stance ─────────────
  const convictionBand  = getConvictionBand(effectiveConf);
  const marketStance    = scenario
    ? await computeMarketStance(scenario).then(s => s.market_stance).catch(() => 'selective')
    : 'selective';

  // ── Step 10: Hard rejection engine ───────────────────────────
  const rejectionResult: RejectionResult = await runRejectionEngine({
    instrument_key:    instrumentKey,
    tradingsymbol,
    exchange,
    direction:         strategy.direction,
    confidence:        effectiveConf,
    risk_score:        riskScore,
    rr:                levels.risk_reward,
    timeframe,
    data_quality:      snap.data_quality,
    volume:            snap.volume,
    atr14:             snap.atr14,
    ltp:               snap.ltp,
    stop_distance:     Math.abs(snap.ltp - levels.stop_loss),
    strategy_tag:      strategy.tag,
    regime,
    scenario:          scenario ?? {
      scenario_tag: 'no_trade_uncertain', scenario_confidence: 0,
      market_stance_hint: '', allowed_strategies: [], blocked_strategies: [],
      volatility_mode: 'normal', breadth_state: 'neutral',
      direction_bias: 'neutral', regime_alignment: 50, computed_at: new Date().toISOString(),
    },
    stance: {
      market_stance: marketStance as any, stance_confidence: 70,
      stance_config: stanceConfig, rationale: '', scenario_tag: '',
      breadth_score: 50, volatility_score: 50, rejection_rate: 0.5,
      avg_top_confidence: 60, guidance_message: '', computed_at: new Date().toISOString(),
    },
    portfolio_fit:      portfolioFitResult,
    confidence_result:  confidenceResult,
    sector,
  });

  // ── Build signal ───────────────────────────────────────────────
  const risk: RiskLevel =
    riskScore>=80 ? 'Very High' : riskScore>=60 ? 'High' : riskScore>=35 ? 'Medium' : 'Low';

  const riskDiscount = risk==='Very High'?0.6:risk==='High'?0.8:risk==='Low'?1.1:1.0;
  const opportunityScore = Math.min(100, Math.round(effectiveConf * riskDiscount));

  const signal: Signal = {
    instrument_key:    instrumentKey,
    tradingsymbol,
    exchange,
    direction:         strategy.direction,
    timeframe,
    confidence:        effectiveConf,
    risk_score:        riskScore,
    opportunity_score: opportunityScore,
    portfolio_fit:     portfolioFitResult.portfolio_fit_score,
    conviction_band:   convictionBand,
    market_stance:     marketStance,
    regime_alignment:  confidenceResult.components.regime_alignment,
    rejection_reasons: rejectionResult.rejection_reasons,
    rejection_codes:   rejectionResult.rejection_codes,
    soft_warnings:     rejectionResult.soft_warnings,
    blocked_by:        rejectionResult.blocked_by,
    risk,
    scenario_tag:      strategy.tag,
    regime,
    entry_price:       snap.ltp,
    stop_loss:         levels.stop_loss,
    target1:           levels.target1,
    target2:           levels.target2,
    risk_reward:       levels.risk_reward,
    factor_scores:     factors,
    confidence_components: {
      factor_alignment:  confidenceResult.components.factor_alignment,
      strategy_clarity:  confidenceResult.components.strategy_clarity,
      regime_alignment:  confidenceResult.components.regime_alignment,
      liquidity_quality: confidenceResult.components.liquidity_quality,
      data_quality:      confidenceResult.components.data_quality,
      portfolio_fit:     confidenceResult.components.portfolio_fit,
      participation:     confidenceResult.components.participation,
      rr_quality:        confidenceResult.components.rr_quality,
      volatility_fit:    confidenceResult.components.volatility_fit,
    },
    reasons:           buildReasons(factors, features, strategy, strategy.direction),
    data_quality:      snap.data_quality,
    generated_at:      new Date().toISOString(),
    score_raw:         parseFloat((composite/100).toFixed(3)),
  };

  // ── Persist rejection log (always) ───────────────────────────
  await persistRejectionLog(null, tradingsymbol, {
    instrument_key: instrumentKey, tradingsymbol, exchange,
    direction: strategy.direction, confidence: effectiveConf,
    risk_score: riskScore, rr: levels.risk_reward, timeframe,
    data_quality: snap.data_quality, volume: snap.volume, atr14: snap.atr14,
    ltp: snap.ltp, stop_distance: Math.abs(snap.ltp-levels.stop_loss),
    strategy_tag: strategy.tag, regime, scenario: signal.scenario_tag as any,
    stance: signal.market_stance as any, portfolio_fit: portfolioFitResult,
    confidence_result: confidenceResult, sector,
  } as any, rejectionResult);

  // ── Only cache approved signals ───────────────────────────────
  if (rejectionResult.approved) {
    await cacheSet(cacheKey, signal, 300);
  }

  return signal;
}

// ════════════════════════════════════════════════════════════════
//  BATCH + HELPERS
// ════════════════════════════════════════════════════════════════

export async function generateSignalsForWatchlist(
  items: Array<{instrument_key: string; tradingsymbol: string; exchange: string}>
): Promise<Signal[]> {
  // Process in concurrent batches of 5 to be faster while not hammering NSE
  const BATCH = 5;
  const results: Signal[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const sigs = await Promise.all(
      chunk.map(item => generateSignal(item.instrument_key, item.tradingsymbol, item.exchange).catch(() => null))
    );
    for (const sig of sigs) { if (sig) results.push(sig); }
  }
  // Deduplicate by tradingsymbol — keep the highest opportunity score
  const bySymbol = new Map<string, Signal>();
  for (const s of results) {
    if (s.rejection_reasons.length > 0) continue;
    const existing = bySymbol.get(s.tradingsymbol);
    if (!existing || s.opportunity_score > existing.opportunity_score) {
      bySymbol.set(s.tradingsymbol, s);
    }
  }
  return Array.from(bySymbol.values())
    .sort((a,b) => b.opportunity_score - a.opportunity_score);
}

export function opportunityScore(signal: Signal): number {
  return signal.opportunity_score;
}

export async function persistSignal(signal: Signal): Promise<void> {
  try {
    await db.query(`
      INSERT INTO signals
        (instrument_key, tradingsymbol, signal_type, strength, description,
         confidence, risk_score, scenario_tag, regime,
         confidence_score, market_stance, conviction_band,
         portfolio_fit_score, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      signal.instrument_key, signal.tradingsymbol, signal.direction,
      signal.confidence>=75?'Strong':signal.confidence>=55?'Moderate':'Weak',
      signal.reasons.slice(0,3).map(r=>r.text).join('; '),
      signal.confidence, signal.risk_score, signal.scenario_tag, signal.regime,
      signal.confidence, signal.market_stance, signal.conviction_band,
      signal.portfolio_fit,
    ]);
  } catch {}
}

export async function logRejection(
  instrumentKey: string,
  tradingsymbol: string,
  reasons:       string[]
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO signal_quality_events
        (instrument_key, tradingsymbol, event_type, details, created_at)
      VALUES (?, ?, 'REJECTED', ?, NOW())
    `, [instrumentKey, tradingsymbol, reasons.join(' | ')]);
  } catch {}
}
