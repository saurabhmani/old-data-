/**
 * NSE Public Data Service
 *
 * The authoritative primary source for all live market data.
 * No authentication required — uses NSE public JSON endpoints.
 *
 * Data provided:
 *   - Individual equity quotes (price, volume, delivery, 52W)
 *   - All indices (Nifty 50, Bank Nifty, sector indices)
 *   - Option chains (equity + index)
 *   - FII / DII institutional flows
 *   - Gainers / losers from NIFTY 500
 *   - Market breadth (advancing/declining counts)
 *   - Sector regime (which indices are up/down)
 *
 * Resilience:
 *   - Automatic retry on transient failure (up to 2 retries)
 *   - Session cookie refresh if NSE returns 401/403
 *   - Redis caching on every successful fetch
 *   - Graceful null return — callers must handle absence of data
 *
 * Instrument master:
 *   - Fetched from a public instrument master feed (no auth required)
 *   - Cached 6 hours; used only for instrument_key resolution
 */

import { cacheGet, cacheSet } from '@/lib/redis';

const NSE_BASE = 'https://www.nseindia.com';
const NSE_API  = 'https://www.nseindia.com/api';

const NSE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://www.nseindia.com/',
  'Connection':      'keep-alive',
  'Cache-Control':   'no-cache',
};

// ── Session management ────────────────────────────────────────────
// NSE requires a valid session cookie. We refresh it automatically
// when a request fails with 401/403 or when the last cookie is stale.

let _cookie    = '';
let _cookieAt  = 0;
const COOKIE_TTL_MS = 5 * 60_000; // refresh every 5 minutes

async function refreshCookie(): Promise<string> {
  try {
    const res = await fetch(`${NSE_BASE}/`, {
      headers:  NSE_HEADERS,
      signal:   AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    _cookie   = res.headers.get('set-cookie') ?? '';
    _cookieAt = Date.now();
  } catch {
    _cookie = '';
  }
  return _cookie;
}

async function getCookie(): Promise<string> {
  if (!_cookie || Date.now() - _cookieAt > COOKIE_TTL_MS) {
    await refreshCookie();
  }
  return _cookie;
}

// ── Core HTTP helper ──────────────────────────────────────────────

async function nseGet<T>(path: string, ttl = 60, retries = 2): Promise<T | null> {
  const cacheKey = `nse:${path}`;

  const cached = await cacheGet<T>(cacheKey);
  if (cached) return cached;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const cookie = await getCookie();
      const res = await fetch(`${NSE_API}${path}`, {
        headers: { ...NSE_HEADERS, Cookie: cookie },
        signal:  AbortSignal.timeout(10_000),
      });

      // Force cookie refresh on auth failure, then retry
      if ((res.status === 401 || res.status === 403) && attempt < retries) {
        await refreshCookie();
        continue;
      }

      if (!res.ok) return null;

      const data = await res.json() as T;
      if (data) await cacheSet(cacheKey, data, ttl);
      return data;

    } catch {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
//  1. EQUITY QUOTES
// ════════════════════════════════════════════════════════════════

export interface NseQuote {
  symbol:                    string;
  lastPrice:                 number;
  change:                    number;
  pChange:                   number;
  open:                      number;
  dayHigh:                   number;
  dayLow:                    number;
  previousClose:             number;
  totalTradedVolume:         number;
  totalTradedValue:          number;
  fiftyTwoWeekHigh:          number;   // true 52W, not intraday proxy
  fiftyTwoWeekLow:           number;
  deliveryToTradedQuantity?: number;
  vwap?:                     number;
  series?:                   string;
  marketCap?:                number;
}

export async function fetchNseQuote(symbol: string): Promise<NseQuote | null> {
  const data = await nseGet<any>(
    `/quote-equity?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    30
  );
  if (!data?.priceInfo) return null;

  const p  = data.priceInfo;
  const md = data.marketDeptOrderBook?.tradeInfo ?? {};
  const mi = data.metadata ?? {};

  return {
    symbol:                   symbol.toUpperCase(),
    lastPrice:                Number(p.lastPrice)           || 0,
    change:                   Number(p.change)              || 0,
    pChange:                  Number(p.pChange)             || 0,
    open:                     Number(p.open)                || 0,
    dayHigh:                  Number(p.intraDayHighLow?.max ?? p.lastPrice) || 0,
    dayLow:                   Number(p.intraDayHighLow?.min ?? p.lastPrice) || 0,
    previousClose:            Number(p.previousClose)       || 0,
    totalTradedVolume:        Number(md.totalTradedVolume)  || 0,
    totalTradedValue:         Number(md.totalTradedValue)   || 0,
    // True 52-week range from weekHighLow — NOT intraday high/low
    fiftyTwoWeekHigh:         Number(p.weekHighLow?.max)    || 0,
    fiftyTwoWeekLow:          Number(p.weekHighLow?.min)    || 0,
    deliveryToTradedQuantity: Number(md.deliveryToTradedQuantity) || undefined,
    vwap:                     p.vwap != null ? Number(p.vwap) : undefined,
    series:                   mi.series,
    marketCap:                mi.companyName ? undefined : undefined,
  };
}

// ── Batch equity quotes (max 5 concurrent to respect NSE limits) ──

export async function fetchMultipleNseQuotes(
  symbols: string[]
): Promise<Record<string, NseQuote>> {
  const results: Record<string, NseQuote> = {};
  const BATCH = 5;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (sym) => {
      const q = await fetchNseQuote(sym);
      if (q) results[sym.toUpperCase()] = q;
    }));
    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, 350));
    }
  }
  return results;
}

// ════════════════════════════════════════════════════════════════
//  2. INDICES
// ════════════════════════════════════════════════════════════════

export interface NseIndex {
  name:          string;
  last:          number;
  variation:     number;
  percentChange: number;
  open:          number;
  high:          number;
  low:           number;
  previousClose: number;
  yearHigh:      number;
  yearLow:       number;
  advances?:     number;   // available on some index responses
  declines?:     number;
}

export async function fetchNseIndices(): Promise<NseIndex[]> {
  const data = await nseGet<any>('/allIndices', 30);
  if (!data?.data) return [];
  return (data.data as any[]).map(d => ({
    name:          String(d.index       ?? ''),
    last:          Number(d.last        ?? 0),
    variation:     Number(d.variation   ?? 0),
    percentChange: Number(d.percentChange ?? 0),
    open:          Number(d.open        ?? 0),
    high:          Number(d.high        ?? 0),
    low:           Number(d.low         ?? 0),
    previousClose: Number(d.previousClose ?? 0),
    yearHigh:      Number(d.yearHigh    ?? 0),
    yearLow:       Number(d.yearLow     ?? 0),
    advances:      d.advances  ? Number(d.advances)  : undefined,
    declines:      d.declines  ? Number(d.declines)  : undefined,
  }));
}

// ════════════════════════════════════════════════════════════════
//  3. MARKET BREADTH
// ════════════════════════════════════════════════════════════════

export interface MarketBreadth {
  advancing:       number;
  declining:       number;
  unchanged:       number;
  total:           number;
  advance_decline_ratio: number | null;
}

export async function fetchMarketBreadth(): Promise<MarketBreadth> {
  // Use the Nifty 500 gainers/losers endpoint for breadth
  const data = await nseGet<any>(
    `/live-analysis-variations?index=${encodeURIComponent('NIFTY 500')}`,
    60
  );

  const gainers  = (data?.gainers  as any[]) ?? [];
  const losers   = (data?.losers   as any[]) ?? [];
  const total    = gainers.length + losers.length;
  const adv      = gainers.length;
  const dec      = losers.length;
  const unch     = 0; // NSE endpoint doesn't provide unchanged count

  return {
    advancing:             adv,
    declining:             dec,
    unchanged:             unch,
    total,
    advance_decline_ratio: dec > 0 ? parseFloat((adv / dec).toFixed(2)) : null,
  };
}

// ════════════════════════════════════════════════════════════════
//  4. SECTOR REGIME
// ════════════════════════════════════════════════════════════════

export interface SectorRegime {
  sector:         string;
  index_name:     string;
  change_percent: number;
  trend:          'up' | 'down' | 'flat';
  strength:       'Strong' | 'Moderate' | 'Weak';
}

const SECTOR_INDEX_MAP: Record<string, string> = {
  'NIFTY BANK':         'Banking',
  'NIFTY IT':           'IT',
  'NIFTY PHARMA':       'Pharma',
  'NIFTY AUTO':         'Auto',
  'NIFTY FMCG':         'FMCG',
  'NIFTY REALTY':       'Realty',
  'NIFTY METAL':        'Metal',
  'NIFTY ENERGY':       'Energy',
  'NIFTY MIDCAP 100':   'Midcap',
  'NIFTY SMALLCAP 100': 'Smallcap',
  'NIFTY INFRA':        'Infra',
  'NIFTY PSU BANK':     'PSU Banking',
};

export async function fetchSectorRegime(): Promise<SectorRegime[]> {
  const indices = await fetchNseIndices();
  const result: SectorRegime[] = [];

  for (const idx of indices) {
    const sector = SECTOR_INDEX_MAP[idx.name];
    if (!sector) continue;

    const pct = idx.percentChange;
    const trend: SectorRegime['trend'] =
      pct > 0.2 ? 'up' : pct < -0.2 ? 'down' : 'flat';
    const strength: SectorRegime['strength'] =
      Math.abs(pct) >= 1.5 ? 'Strong' :
      Math.abs(pct) >= 0.5 ? 'Moderate' : 'Weak';

    result.push({ sector, index_name: idx.name, change_percent: pct, trend, strength });
  }
  return result;
}

// ════════════════════════════════════════════════════════════════
//  5. OPTION CHAIN
// ════════════════════════════════════════════════════════════════

export interface OptionChainRow {
  strikePrice: number;
  expiryDate:  string;
  CE?: {
    openInterest:         number;
    changeinOpenInterest: number;
    impliedVolatility:    number;
    lastPrice:            number;
    totalTradedVolume:    number;
    bidprice:             number;
    askPrice:             number;
  };
  PE?: {
    openInterest:         number;
    changeinOpenInterest: number;
    impliedVolatility:    number;
    lastPrice:            number;
    totalTradedVolume:    number;
    bidprice:             number;
    askPrice:             number;
  };
}

export interface OptionChainResult {
  records:          OptionChainRow[];
  underlyingValue:  number;
  expiryDates:      string[];
}

export async function fetchNseOptionChain(
  symbol: string
): Promise<OptionChainResult | null> {
  const sym      = symbol.toUpperCase();
  const isIndex  = sym.startsWith('NIFTY') || sym === 'BANKNIFTY' || sym === 'FINNIFTY';
  const endpoint = isIndex
    ? `/option-chain-indices?symbol=${encodeURIComponent(sym)}`
    : `/option-chain-equities?symbol=${encodeURIComponent(sym)}`;

  const data = await nseGet<any>(endpoint, 30);
  if (!data?.records) return null;

  return {
    underlyingValue: Number(data.records.underlyingValue) || 0,
    expiryDates:     data.records.expiryDates ?? [],
    records:         (data.records.data ?? []).map((row: any) => ({
      strikePrice: row.strikePrice,
      expiryDate:  row.expiryDate,
      CE: row.CE ? {
        openInterest:         Number(row.CE.openInterest)         || 0,
        changeinOpenInterest: Number(row.CE.changeinOpenInterest) || 0,
        impliedVolatility:    Number(row.CE.impliedVolatility)    || 0,
        lastPrice:            Number(row.CE.lastPrice)            || 0,
        totalTradedVolume:    Number(row.CE.totalTradedVolume)    || 0,
        bidprice:             Number(row.CE.bidprice)             || 0,
        askPrice:             Number(row.CE.askPrice)             || 0,
      } : undefined,
      PE: row.PE ? {
        openInterest:         Number(row.PE.openInterest)         || 0,
        changeinOpenInterest: Number(row.PE.changeinOpenInterest) || 0,
        impliedVolatility:    Number(row.PE.impliedVolatility)    || 0,
        lastPrice:            Number(row.PE.lastPrice)            || 0,
        totalTradedVolume:    Number(row.PE.totalTradedVolume)    || 0,
        bidprice:             Number(row.PE.bidprice)             || 0,
        askPrice:             Number(row.PE.askPrice)             || 0,
      } : undefined,
    })),
  };
}

// ════════════════════════════════════════════════════════════════
//  6. FII / DII FLOWS
// ════════════════════════════════════════════════════════════════

export interface FiiDiiEntry {
  date:      string;
  fii_buy:   number;
  fii_sell:  number;
  fii_net:   number;
  dii_buy:   number;
  dii_sell:  number;
  dii_net:   number;
}

export async function fetchFiiDii(): Promise<FiiDiiEntry[]> {
  const data = await nseGet<any[]>('/fiidiiTradeReact', 3600);
  if (!Array.isArray(data)) return [];

  return data.slice(0, 10).map((row: any) => ({
    date:      String(row.date ?? ''),
    fii_buy:   Number(row.buySell === 'Buy' ? row.amount : 0)  || 0,
    fii_sell:  Number(row.buySell === 'Sell' ? row.amount : 0) || 0,
    fii_net:   Number(row.netAmount ?? row.amount ?? 0)        || 0,
    dii_buy:   Number(row.diiBuySell === 'Buy'  ? row.diiAmount : 0)  || 0,
    dii_sell:  Number(row.diiBuySell === 'Sell' ? row.diiAmount : 0)  || 0,
    dii_net:   Number(row.diiNetAmount ?? 0)                   || 0,
  }));
}

// ════════════════════════════════════════════════════════════════
//  7. GAINERS / LOSERS
// ════════════════════════════════════════════════════════════════

export async function fetchGainersLosers(
  type:  'gainers' | 'losers' = 'gainers',
  index: string               = 'NIFTY 500'
): Promise<any[]> {
  const data = await nseGet<any>(
    `/live-analysis-variations?index=${encodeURIComponent(index)}`,
    60
  );
  if (!data) return [];
  return type === 'gainers' ? (data.gainers ?? []) : (data.losers ?? []);
}

// ════════════════════════════════════════════════════════════════
//  8. INDIA VIX
// ════════════════════════════════════════════════════════════════

export async function fetchIndiaVix(): Promise<number | null> {
  const indices = await fetchNseIndices();
  const vix = indices.find(i => i.name === 'India VIX');
  return vix?.last ?? null;
}

// ════════════════════════════════════════════════════════════════
//  9. INSTRUMENT MASTER (CDN — no auth)
// ════════════════════════════════════════════════════════════════

export async function fetchInstrumentsJson(
  exchange: 'NSE' | 'BSE' | 'NSE_FO' = 'NSE'
): Promise<any[]> {
  // Public instrument master feed — no API key or authentication required
  const urls: Record<string, string> = {
    NSE:    'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
    BSE:    'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
    NSE_FO: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE_FO.json.gz',
  };

  const cacheKey = `instruments_json:${exchange}`;
  const cached   = await cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(urls[exchange], {
      headers: { 'Accept-Encoding': 'gzip' },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    await cacheSet(cacheKey, data, 6 * 3600);
    return data;
  } catch {
    return [];
  }
}
