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

// ── Yahoo Finance headers ─────────────────────────────────────────
const YAHOO_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://finance.yahoo.com/',
  'Origin':          'https://finance.yahoo.com',
};

// Key symbols on Yahoo Finance for NSE indices
const YAHOO_SYMBOLS = [
  { name: 'NIFTY 50',   symbol: '^NSEI'  },
  { name: 'NIFTY BANK', symbol: '^NSEBANK' },
  { name: 'India VIX',  symbol: '^INDIAVIX' },
];

async function fetchYahooData(): Promise<void> {
  console.log('[Yahoo] ── Fetching key index data from Yahoo Finance ──');
  await Promise.all(YAHOO_SYMBOLS.map(async ({ name, symbol }) => {
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          console.warn(`[Yahoo] HTTP ${res.status} for ${symbol} (${url})`);
          continue;
        }
        const json   = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result) {
          console.warn(`[Yahoo] No data for ${symbol}:`, JSON.stringify(json?.chart?.error ?? ''));
          continue;
        }
        const meta = result.meta ?? {};
        const ltp  = meta.regularMarketPrice ?? meta.previousClose ?? 0;
        const pct  = meta.regularMarketChangePercent ?? 0;
        console.log(`[Yahoo] ${name} (${symbol}): LTP=${ltp}, Change=${Number(pct).toFixed(2)}%, 52W H=${meta.fiftyTwoWeekHigh ?? 'N/A'}, 52W L=${meta.fiftyTwoWeekLow ?? 'N/A'}`);
        return; // success — no need to try query2
      } catch (err) {
        console.error(`[Yahoo] Error fetching ${symbol} from ${url}:`, err);
      }
    }
  }));
}

const NSE_HEADERS = {
  'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':             'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':    'en-US,en;q=0.9',
  'Accept-Encoding':    'gzip, deflate, br',
  'Referer':            'https://www.nseindia.com/',
  'Connection':         'keep-alive',
  'Cache-Control':      'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua':          '"Not/A)Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"',
  'sec-ch-ua-mobile':   '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest':     'document',
  'sec-fetch-mode':     'navigate',
  'sec-fetch-site':     'none',
  'sec-fetch-user':     '?1',
};

// For XHR/API calls — different Accept + sec-fetch-* from page navigation
const { 'Upgrade-Insecure-Requests': _u, 'sec-fetch-user': _su, ...NSE_BASE_HEADERS } = NSE_HEADERS;
const NSE_API_HEADERS = {
  ...NSE_BASE_HEADERS,
  'Accept':         'application/json, text/plain, */*',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

// Akamai challenge cookies require JS execution — sending an invalid _abck
// makes NSE return {}. Strip them; only pass NSE session cookies to the API.
const AKAMAI_COOKIE_KEYS = new Set(['_abck', 'bm_sv', 'bm_sz', 'bm_mi', 'ak_bmsc']);

// ── Session management ────────────────────────────────────────────
// NSE uses Akamai bot protection. A single homepage request is not
// enough — we must simulate: homepage → option-chain page → API call.
// Cookies (nsit, nseappid, ak_bmsc, etc.) are merged across both steps
// and cached in the in-process store to avoid re-fetching every call.

const COOKIE_CACHE_KEY = 'nse:_session_cookie';
const COOKIE_TTL_SEC   = 3 * 60; // 3 minutes (Akamai cookies expire fast)

let _cookieRefreshing: Promise<Record<string, string>> | null = null;

/** Parse Set-Cookie headers → name=value map (strips attributes like Path/Expires) */
function extractSetCookies(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  // Node 18.14+ exposes getSetCookie(); fall back to splitting on get()
  const lines: string[] =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_-]+=)/);

  for (const line of lines) {
    const nameVal = line.split(';')[0]?.trim() ?? '';
    const eq      = nameVal.indexOf('=');
    if (eq > 0) {
      const k = nameVal.slice(0, eq).trim();
      const v = nameVal.slice(eq + 1).trim();
      if (k) jar[k] = v;
    }
  }
  return jar;
}

function buildCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** For API calls: strip Akamai challenge cookies (invalid without JS execution) */
function buildApiCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .filter(([k]) => !AKAMAI_COOKIE_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function refreshCookie(): Promise<Record<string, string>> {
  if (_cookieRefreshing) return _cookieRefreshing;

  _cookieRefreshing = (async () => {
    const jar: Record<string, string> = {};
    try {
      // Step 1 — homepage: seeds initial cookies
      const r1 = await fetch(`${NSE_BASE}/`, {
        headers:  NSE_HEADERS,
        signal:   AbortSignal.timeout(6000),
        redirect: 'follow',
      });
      Object.assign(jar, extractSetCookies(r1));
      console.log(`[NSE] Cookie step-1 keys: ${Object.keys(jar).join(', ') || '(none)'}`);

      // Step 2 — option-chain page: sets nsit + nseappid
      await new Promise(r => setTimeout(r, 1200));
      const r2 = await fetch(`${NSE_BASE}/option-chain`, {
        headers:  { ...NSE_HEADERS, Cookie: buildCookieHeader(jar), Referer: `${NSE_BASE}/` },
        signal:   AbortSignal.timeout(6000),
        redirect: 'follow',
      });
      Object.assign(jar, extractSetCookies(r2));
      console.log(`[NSE] Cookie step-2 keys: ${Object.keys(jar).join(', ') || '(none)'}`);

    } catch (err) {
      console.warn('[NSE] Cookie refresh error:', err);
    }

    // Store the full jar so API calls can strip Akamai cookies
    if (Object.keys(jar).length > 0) {
      await cacheSet(COOKIE_CACHE_KEY, jar, COOKIE_TTL_SEC);
    }
    console.log(`[NSE] Cookie jar ready: ${Object.keys(jar).join(', ') || '(empty)'}`);
    return jar;
  })().finally(() => { _cookieRefreshing = null; });

  return _cookieRefreshing;
}

async function getCookieJar(): Promise<Record<string, string>> {
  const cached = await cacheGet<Record<string, string>>(COOKIE_CACHE_KEY);
  if (cached && Object.keys(cached).length > 0) return cached;
  return refreshCookie();
}

function invalidateCookie(): Promise<void> {
  return cacheSet(COOKIE_CACHE_KEY, {}, 1);
}

// ── Core HTTP helper ──────────────────────────────────────────────

async function nseGet<T>(path: string, ttl = 60, retries = 1): Promise<T | null> {
  const cacheKey = `nse:${path}`;

  const cached = await cacheGet<T>(cacheKey);
  if (cached) {
    console.log(`[NSE] Cache HIT — ${path}`);
    return cached;
  }

  console.log(`[NSE] Fetching — ${NSE_API}${path}`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const jar    = await getCookieJar();
      const cookie = buildApiCookieHeader(jar);  // strips Akamai challenge cookies
      const res    = await fetch(`${NSE_API}${path}`, {
        headers: { ...NSE_API_HEADERS, Cookie: cookie, Referer: `${NSE_BASE}/option-chain` },
        signal:  AbortSignal.timeout(7_000),
      });

      // Auth failure → invalidate cookie and retry once
      if ((res.status === 401 || res.status === 403) && attempt < retries) {
        console.warn(`[NSE] Auth failed (${res.status}) — refreshing cookie, attempt ${attempt + 1}`);
        await invalidateCookie();
        await refreshCookie();
        continue;
      }

      if (!res.ok) {
        console.error(`[NSE] HTTP ${res.status} for ${path}`);
        return null;
      }

      let data: T;
      try {
        data = await res.json() as T;
      } catch {
        console.error(`[NSE] Non-JSON response for ${path}`);
        return null;
      }

      // NSE returns {} when Akamai blocks — treat as auth failure and refresh
      if (data && typeof data === 'object' && Object.keys(data as object).length === 0) {
        console.warn(`[NSE] Empty {} response for ${path} — cookie likely invalid`);
        await invalidateCookie();
        if (attempt < retries) {
          await refreshCookie();
          continue;
        }
        return null;
      }

      if (data) await cacheSet(cacheKey, data, ttl);
      return data;

    } catch (err) {
      console.error(`[NSE] Fetch error on attempt ${attempt + 1} for ${path}:`, err);
      if (attempt < retries) await new Promise(r => setTimeout(r, 400));
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
}

export async function fetchNseQuote(symbol: string): Promise<NseQuote | null> {
  console.log(`[NSE] fetchNseQuote — symbol: ${symbol.toUpperCase()}`);
  const data = await nseGet<any>(
    `/quote-equity?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    30
  );
  if (!data?.priceInfo) {
    console.warn(`[NSE] fetchNseQuote — no priceInfo for ${symbol}`);
    return null;
  }

  const p    = data.priceInfo;
  const md   = data.marketDeptOrderBook?.tradeInfo ?? {};
  const mi   = data.metadata ?? {};
  const pre  = data.preOpenMarket ?? {};

  // Volume: NSE places it in tradeInfo during market hours,
  // preOpenMarket before open, or sometimes directly in priceInfo.
  const totalTradedVolume = Number(
    md.totalTradedVolume  ??
    md.totalTradedQuantity ??
    p.totalTradedVolume   ??
    p.quantityTraded      ??
    pre.totalTradedVolume ??
    0
  ) || 0;

  const totalTradedValue = Number(
    md.totalTradedValue ?? p.totalTradedValue ?? 0
  ) || 0;

  const quote: NseQuote = {
    symbol:                   symbol.toUpperCase(),
    lastPrice:                Number(p.lastPrice)                          || 0,
    change:                   Number(p.change)                             || 0,
    pChange:                  Number(p.pChange)                            || 0,
    open:                     Number(p.open)                               || 0,
    dayHigh:                  Number(p.intraDayHighLow?.max ?? p.lastPrice) || 0,
    dayLow:                   Number(p.intraDayHighLow?.min ?? p.lastPrice) || 0,
    previousClose:            Number(p.previousClose)                      || 0,
    totalTradedVolume,
    totalTradedValue,
    fiftyTwoWeekHigh:         Number(p.weekHighLow?.max)                   || 0,
    fiftyTwoWeekLow:          Number(p.weekHighLow?.min)                   || 0,
    deliveryToTradedQuantity: md.deliveryToTradedQuantity != null ? Number(md.deliveryToTradedQuantity) : undefined,
    vwap:                     p.vwap != null ? Number(p.vwap) : undefined,
    series:                   mi.series,
  };
  console.log(`[NSE] Quote scraped:`, JSON.stringify(quote, null, 2));
  return quote;
}

/**
 * Returns the full raw NSE quote response alongside the processed quote.
 * Use this when you need metadata (company name, industry, P/E, circuits, etc.)
 * without depending on Redis being available.
 */
export async function fetchNseQuoteFull(
  symbol: string
): Promise<{ quote: NseQuote; raw: any } | null> {
  const sym  = symbol.toUpperCase();
  const data = await nseGet<any>(
    `/quote-equity?symbol=${encodeURIComponent(sym)}`,
    30
  );
  if (!data?.priceInfo) return null;

  const p    = data.priceInfo;
  const md   = data.marketDeptOrderBook?.tradeInfo ?? {};
  const mi   = data.metadata ?? {};
  const pre  = data.preOpenMarket ?? {};

  const totalTradedVolume = Number(
    md.totalTradedVolume ?? md.totalTradedQuantity ??
    p.totalTradedVolume  ?? p.quantityTraded ??
    pre.totalTradedVolume ?? 0
  ) || 0;

  const totalTradedValue = Number(md.totalTradedValue ?? p.totalTradedValue ?? 0) || 0;

  const quote: NseQuote = {
    symbol:                   sym,
    lastPrice:                Number(p.lastPrice)                           || 0,
    change:                   Number(p.change)                              || 0,
    pChange:                  Number(p.pChange)                             || 0,
    open:                     Number(p.open)                                || 0,
    dayHigh:                  Number(p.intraDayHighLow?.max ?? p.lastPrice) || 0,
    dayLow:                   Number(p.intraDayHighLow?.min ?? p.lastPrice) || 0,
    previousClose:            Number(p.previousClose)                       || 0,
    totalTradedVolume,
    totalTradedValue,
    fiftyTwoWeekHigh:         Number(p.weekHighLow?.max)                    || 0,
    fiftyTwoWeekLow:          Number(p.weekHighLow?.min)                    || 0,
    deliveryToTradedQuantity: md.deliveryToTradedQuantity != null ? Number(md.deliveryToTradedQuantity) : undefined,
    vwap:                     p.vwap != null ? Number(p.vwap) : undefined,
    series:                   mi.series,
  };

  return { quote, raw: data };
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
  console.log('[NSE] fetchNseIndices — fetching all indices');

  // Run NSE + Yahoo in parallel so both always print to terminal
  const [data] = await Promise.all([
    nseGet<any>('/allIndices', 30),
    fetchYahooData(),
  ]);

  if (!data?.data) {
    console.warn('[NSE] fetchNseIndices — no data returned');
    return [];
  }
  console.log(`[NSE] Indices scraped: ${(data.data as any[]).length} indices`);
  (data.data as any[]).slice(0, 5).forEach((d: any) =>
    console.log(`  [Index] ${d.index}: last=${d.last}, %chg=${d.percentChange}`)
  );
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
  console.log('[NSE] fetchMarketBreadth — computing breadth from indices');
  // Primary: /allIndices has advances/declines per index — use NIFTY 500 or NIFTY 50
  const indices = await fetchNseIndices();
  const n500 = indices.find(i => i.name === 'NIFTY 500');
  const n50  = indices.find(i => i.name === 'NIFTY 50');
  const src  = n500 ?? n50;

  if (src?.advances != null && src.advances > 0) {
    const adv   = src.advances;
    const dec   = src.declines ?? 0;
    const unch  = 0;
    const total = adv + dec;
    const breadth = {
      advancing:             adv,
      declining:             dec,
      unchanged:             unch,
      total,
      advance_decline_ratio: dec > 0 ? parseFloat((adv / dec).toFixed(2)) : null,
    };
    console.log('[NSE] Market Breadth scraped (from indices):', JSON.stringify(breadth));
    return breadth;
  }

  // Fallback: equity-stockIndices returns all constituents — count up/down stocks
  console.log('[NSE] fetchMarketBreadth — falling back to equity-stockIndices');
  const data = await nseGet<any>(
    `/equity-stockIndices?index=${encodeURIComponent('NIFTY 500')}`,
    60
  );

  const stocks   = (data?.data as any[]) ?? [];
  const adv      = stocks.filter(s => Number(s.pChange ?? 0) > 0).length;
  const dec      = stocks.filter(s => Number(s.pChange ?? 0) < 0).length;
  const unch     = stocks.filter(s => Number(s.pChange ?? 0) === 0).length;
  const total    = stocks.length;

  const breadth = {
    advancing:             adv,
    declining:             dec,
    unchanged:             unch,
    total,
    advance_decline_ratio: dec > 0 ? parseFloat((adv / dec).toFixed(2)) : null,
  };
  console.log('[NSE] Market Breadth scraped (from equity-stockIndices):', JSON.stringify(breadth));
  return breadth;
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
  console.log('[NSE] fetchSectorRegime — computing sector regimes');
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
  console.log(`[NSE] Sector regime scraped: ${result.length} sectors`);
  result.forEach(r =>
    console.log(`  [Sector] ${r.sector}: ${r.change_percent}% (${r.trend}, ${r.strength})`)
  );
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
  source?:          'nse' | 'synthetic';
}

// ── NSE option chain parser ────────────────────────────────────────

function parseNseOptionChain(sym: string, data: any): OptionChainResult | null {
  if (!data?.records) return null;
  console.log(`[NSE] Option chain for ${sym}: spot=${data.records.underlyingValue}, strikes=${(data.records.data ?? []).length}, expiries=${(data.records.expiryDates ?? []).slice(0, 3).join(', ')}`);
  return {
    underlyingValue: Number(data.records.underlyingValue) || 0,
    expiryDates:     data.records.expiryDates ?? [],
    source:          'nse',
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

// ── Synthetic option chain (fallback when NSE is blocked) ─────────
// Uses Yahoo Finance for the spot price + Black-Scholes approximation
// for realistic IV/LTP. OI distribution mimics typical NIFTY patterns.
// Labelled source='synthetic' so the UI can show an "Estimated" badge.

// Multiple candidate Yahoo tickers per symbol (tried in order)
const YAHOO_SPOT_CANDIDATES: Record<string, string[]> = {
  NIFTY:      ['%5ENSEI',    '%5ECNX200'],
  BANKNIFTY:  ['%5ENSEBANK', '%5ECNXBANK'],
  FINNIFTY:   ['%5ECNXFIN',  '%5ENSEFIN'],
  MIDCPNIFTY: ['%5ENSMIDCP', '%5ECNXMID', '%5ECNX500'],
};

// Last-resort approximate spot values (rough mid-2025 levels)
const FALLBACK_SPOTS: Record<string, number> = {
  NIFTY:      24500,
  BANKNIFTY:  52000,
  FINNIFTY:   23500,
  MIDCPNIFTY: 13000,
};

async function fetchYahooSpot(symbol: string): Promise<number | null> {
  const candidates = YAHOO_SPOT_CANDIDATES[symbol] ?? [`${symbol}.NS`];
  for (const ySym of candidates) {
    for (const host of ['query1', 'query2']) {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${ySym}?interval=1d&range=1d`;
      try {
        const res = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) continue;
        const json = await res.json();
        const ltp  = json?.chart?.result?.[0]?.meta?.regularMarketPrice
                  ?? json?.chart?.result?.[0]?.meta?.previousClose;
        if (ltp && Number(ltp) > 0) {
          console.log(`[Yahoo] Spot for ${symbol}: ${ltp} (${ySym})`);
          return Number(ltp);
        }
      } catch { /* try next */ }
    }
  }
  return null;
}

/** Next N weekly expiry Thursdays in NSE date format (e.g. "25-Apr-2024") */
function nextThursdays(count: number): string[] {
  const dates: string[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // advance to next Thursday
  const DAY = 24 * 60 * 60 * 1000;
  while (d.getDay() !== 4) d.setTime(d.getTime() + DAY);
  for (let i = 0; i < count; i++) {
    dates.push(d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-'));
    d.setTime(d.getTime() + 7 * DAY);
  }
  return dates;
}

/** Very simple Black-Scholes call/put LTP approximation (no dividend) */
function bsApprox(spot: number, strike: number, iv: number, daysLeft: number, type: 'CE' | 'PE'): number {
  const t   = daysLeft / 365;
  const d1  = (Math.log(spot / strike) + 0.5 * iv * iv * t) / (iv * Math.sqrt(t));
  const d2  = d1 - iv * Math.sqrt(t);
  const Nd1 = 0.5 * (1 + erf(d1 / Math.SQRT2));
  const Nd2 = 0.5 * (1 + erf(d2 / Math.SQRT2));
  return type === 'CE'
    ? Math.max(0.05, spot * Nd1 - strike * Nd2)
    : Math.max(0.05, strike * (1 - Nd2) - spot * (1 - Nd1));
}

function erf(x: number): number {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign * y;
}

async function generateSyntheticOptionChain(symbol: string): Promise<OptionChainResult | null> {
  const yahooSpot = await fetchYahooSpot(symbol);
  const spot      = yahooSpot ?? FALLBACK_SPOTS[symbol] ?? 10000;
  console.log(`[Synthetic] Generating option chain for ${symbol} @ spot=${spot}${yahooSpot ? '' : ' (fallback)'}`);

  const step        = symbol === 'BANKNIFTY' ? 100 : symbol === 'MIDCPNIFTY' ? 25 : 50;
  const atm         = Math.round(spot / step) * step;
  const expiryDates = nextThursdays(4);
  const expiry      = expiryDates[0];
  const daysLeft    = 7;
  const atmIv       = 0.155; // ~15.5% typical NIFTY IV

  const records: OptionChainRow[] = [];

  for (let i = -20; i <= 20; i++) {
    const strike   = atm + i * step;
    const moneyness = (strike - spot) / spot;

    // Bell-curve OI distribution — peak at ATM
    const oiBase   = 800_000 * Math.exp(-0.5 * Math.pow(moneyness / 0.015, 2));
    // IV smile: put skew (OTM puts have higher IV)
    const ceIv = atmIv * (1 + 0.08 * moneyness);
    const peIv = atmIv * (1 - 0.20 * moneyness);

    const ceLtp = bsApprox(spot, strike, Math.max(0.05, ceIv), daysLeft, 'CE');
    const peLtp = bsApprox(spot, strike, Math.max(0.05, peIv), daysLeft, 'PE');

    const ceOi = Math.round(oiBase * (0.7 + 0.3 * Math.random()));
    const peOi = Math.round(oiBase * (0.7 + 0.3 * Math.random()));

    records.push({
      strikePrice: strike,
      expiryDate:  expiry,
      CE: {
        openInterest:         ceOi,
        changeinOpenInterest: Math.round((Math.random() - 0.5) * ceOi * 0.08),
        impliedVolatility:    parseFloat((Math.max(0.05, ceIv) * 100).toFixed(2)),
        lastPrice:            parseFloat(ceLtp.toFixed(2)),
        totalTradedVolume:    Math.round(ceOi * 0.25),
        bidprice:             parseFloat((ceLtp * 0.98).toFixed(2)),
        askPrice:             parseFloat((ceLtp * 1.02).toFixed(2)),
      },
      PE: {
        openInterest:         peOi,
        changeinOpenInterest: Math.round((Math.random() - 0.5) * peOi * 0.08),
        impliedVolatility:    parseFloat((Math.max(0.05, peIv) * 100).toFixed(2)),
        lastPrice:            parseFloat(peLtp.toFixed(2)),
        totalTradedVolume:    Math.round(peOi * 0.25),
        bidprice:             parseFloat((peLtp * 0.98).toFixed(2)),
        askPrice:             parseFloat((peLtp * 1.02).toFixed(2)),
      },
    });
  }

  return { records, underlyingValue: spot, expiryDates, source: 'synthetic' as any };
}

export async function fetchNseOptionChain(
  symbol: string
): Promise<OptionChainResult | null> {
  const sym      = symbol.toUpperCase();
  const isIndex  = sym.startsWith('NIFTY') || sym === 'BANKNIFTY' || sym === 'FINNIFTY' || sym === 'MIDCPNIFTY';
  const endpoint = isIndex
    ? `/option-chain-indices?symbol=${encodeURIComponent(sym)}`
    : `/option-chain-equities?symbol=${encodeURIComponent(sym)}`;

  console.log(`[NSE] fetchNseOptionChain — symbol: ${sym}`);
  const data   = await nseGet<any>(endpoint, 30);
  const result = parseNseOptionChain(sym, data);
  if (result && result.records.length > 0) return result;

  // NSE blocked (Akamai) — generate synthetic chain from Yahoo Finance spot
  console.warn(`[NSE] Live data unavailable for ${sym}, generating synthetic chain`);
  return generateSyntheticOptionChain(sym);
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
  if (!Array.isArray(data) || !data.length) return [];

  // NSE returns rows per category (FII/DII) per date.
  // Group by date to produce one FiiDiiEntry per date.
  const byDate: Record<string, { fii_buy: number; fii_sell: number; fii_net: number; dii_buy: number; dii_sell: number; dii_net: number }> = {};

  for (const row of data) {
    const date = String(row.date ?? row.tradeDate ?? '');
    if (!date) continue;
    if (!byDate[date]) byDate[date] = { fii_buy: 0, fii_sell: 0, fii_net: 0, dii_buy: 0, dii_sell: 0, dii_net: 0 };

    const cat    = String(row.category ?? row.clientType ?? '').toLowerCase();
    // NSE field variants: buyValue / buy / purchaseValue / grossPurchase
    const buy    = Number(row.buyValue  ?? row.buy  ?? row.purchaseValue  ?? row.grossPurchase ?? 0) || 0;
    const sell   = Number(row.sellValue ?? row.sell ?? row.salesValue     ?? row.grossSales    ?? 0) || 0;
  const net = Number(row.netValue ?? row.net ?? row.netPurchase ?? (buy - sell)) || (buy - sell);

    if (cat.includes('fii') || cat.includes('fpi') || cat.includes('foreign')) {
      byDate[date].fii_buy  = buy;
      byDate[date].fii_sell = sell;
      byDate[date].fii_net  = net;
    } else if (cat.includes('dii') || cat.includes('domestic')) {
      byDate[date].dii_buy  = buy;
      byDate[date].dii_sell = sell;
      byDate[date].dii_net  = net;
    }
  }

  const result = Object.entries(byDate)
    .slice(0, 5)
    .map(([date, v]) => ({ date, ...v }));
  console.log(`[NSE] FII/DII scraped: ${result.length} days`);
  result.forEach(r =>
    console.log(`  [FII/DII] ${r.date} | FII net: ${r.fii_net} | DII net: ${r.dii_net}`)
  );
  return result;
}

// ════════════════════════════════════════════════════════════════
//  7. GAINERS / LOSERS
// ════════════════════════════════════════════════════════════════

export async function fetchGainersLosers(
  type:  'gainers' | 'losers' = 'gainers',
  index: string               = 'NIFTY 500'
): Promise<any[]> {
  console.log(`[NSE] fetchGainersLosers — type: ${type}, index: ${index}`);

  // /live-analysis-variations is broken (returns "Missing index or key").
  // Use /equity-stockIndices instead — returns all constituents, sort by pChange.
  const data = await nseGet<any>(
    `/equity-stockIndices?index=${encodeURIComponent(index)}`,
    60
  );

  if (!data?.data) {
    console.warn(`[NSE] fetchGainersLosers — no data for ${index}`);
    return [];
  }

  const stocks: any[] = data.data;
  const sorted = [...stocks].sort((a, b) => {
    const pa = Number(a.pChange ?? 0);
    const pb = Number(b.pChange ?? 0);
    return type === 'gainers' ? pb - pa : pa - pb;
  });

  // Mirror the old shape: keep only stocks moving in the right direction
  const list = type === 'gainers'
    ? sorted.filter(s => Number(s.pChange ?? 0) > 0)
    : sorted.filter(s => Number(s.pChange ?? 0) < 0);

  console.log(`[NSE] ${type} scraped: ${list.length} stocks`);
  list.slice(0, 5).forEach((s: any) =>
    console.log(`  [${type}] ${s.symbol ?? s.sym}: ${s.pChange ?? s.perChange}%`)
  );
  return list;
}

// ════════════════════════════════════════════════════════════════
//  8. INDIA VIX
// ════════════════════════════════════════════════════════════════

export async function fetchIndiaVix(): Promise<number | null> {
  console.log('[NSE] fetchIndiaVix — looking up India VIX');
  const indices = await fetchNseIndices();
  const vix = indices.find(i => i.name === 'India VIX');
  console.log(`[NSE] India VIX scraped: ${vix?.last ?? 'N/A'}`);
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

  console.log(`[NSE] fetchInstrumentsJson — exchange: ${exchange}`);
  const cacheKey = `instruments_json:${exchange}`;
  const cached   = await cacheGet<any[]>(cacheKey);
  if (cached) {
    console.log(`[NSE] Instruments cache HIT — ${exchange}: ${cached.length} instruments`);
    return cached;
  }

  console.log(`[NSE] Fetching instrument master from CDN: ${urls[exchange]}`);
  try {
    const res = await fetch(urls[exchange], {
      headers: { 'Accept-Encoding': 'gzip' },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[NSE] Instrument master fetch failed: HTTP ${res.status}`);
      return [];
    }
    const data = JSON.parse(await res.text());
    console.log(`[NSE] Instruments scraped — ${exchange}: ${data.length} instruments`);
    await cacheSet(cacheKey, data, 6 * 3600);
    return data;
  } catch (err) {
    console.error(`[NSE] Instrument master fetch error:`, err);
    return [];
  }
}
