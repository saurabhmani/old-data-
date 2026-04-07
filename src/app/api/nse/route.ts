import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { fetchNseIndices, fetchNseQuoteFull, fetchGainersLosers } from '@/services/nse';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

// ── Yahoo Finance fundamentals ────────────────────────────────────
const YAHOO_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Module-level crumb cache (lives for the lifetime of the server process)
let _yahooCookie = '';
let _yahooCrumb  = '';
let _yahooCrumbAt = 0;
const CRUMB_TTL_MS = 55 * 60_000; // refresh every 55 minutes

async function getYahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  if (_yahooCrumb && Date.now() - _yahooCrumbAt < CRUMB_TTL_MS) {
    return { cookie: _yahooCookie, crumb: _yahooCrumb };
  }

  try {
    // Step 1: visit Yahoo Finance to obtain a session cookie
    const homeRes = await fetch('https://finance.yahoo.com/', {
      headers: YAHOO_HEADERS,
      redirect: 'follow',
      signal:   AbortSignal.timeout(12_000),
    });
    const setCookie = homeRes.headers.get('set-cookie') ?? '';
    // Collapse multiple Set-Cookie headers into one Cookie header value
    const cookie = setCookie.split(/,(?=[^ ])/).map(c => c.split(';')[0].trim()).join('; ');
    if (!cookie) { console.warn('[Yahoo] No cookie from home page'); return null; }

    // Step 2: fetch the crumb using that cookie
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...YAHOO_HEADERS, Cookie: cookie, Accept: '*/*' },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!crumbRes.ok) {
      console.warn(`[Yahoo] Crumb fetch failed: HTTP ${crumbRes.status}`);
      return null;
    }
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb === 'null') { console.warn('[Yahoo] Empty crumb'); return null; }

    _yahooCookie  = cookie;
    _yahooCrumb   = crumb;
    _yahooCrumbAt = Date.now();
    console.log(`[Yahoo] Crumb refreshed: ${crumb.slice(0, 8)}…`);
    return { cookie, crumb };
  } catch (err: any) {
    console.error('[Yahoo] Crumb error:', err?.message);
    return null;
  }
}

async function fetchYahooFundamentals(symbol: string): Promise<Record<string, any> | null> {
  const yahooSym = `${symbol.toUpperCase()}.NS`;
  const modules  = 'summaryDetail,defaultKeyStatistics,financialData,price';

  const auth = await getYahooCrumb();
  if (!auth) {
    console.warn(`[Yahoo] No crumb — skipping fundamentals for ${yahooSym}`);
    return null;
  }

  const { cookie, crumb } = auth;
  const reqHeaders = {
    'User-Agent':      YAHOO_HEADERS['User-Agent'],
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://finance.yahoo.com/',
    Cookie:            cookie,
  };

  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  for (const host of hosts) {
    const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(yahooSym)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    try {
      const res = await fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(10_000) });

      if (res.status === 401 || res.status === 403) {
        // Crumb expired — force refresh and retry once
        console.warn(`[Yahoo] Auth error ${res.status} — forcing crumb refresh`);
        _yahooCrumb = '';
        const newAuth = await getYahooCrumb();
        if (!newAuth) return null;
        const retryUrl = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(yahooSym)}?modules=${modules}&crumb=${encodeURIComponent(newAuth.crumb)}`;
        const retryRes = await fetch(retryUrl, {
          headers: { ...reqHeaders, Cookie: newAuth.cookie },
          signal:  AbortSignal.timeout(10_000),
        });
        if (!retryRes.ok) { console.warn(`[Yahoo] Retry HTTP ${retryRes.status}`); continue; }
        return parseYahooResult(await retryRes.json(), yahooSym);
      }

      if (!res.ok) { console.warn(`[Yahoo] HTTP ${res.status} for ${yahooSym}`); continue; }

      return parseYahooResult(await res.json(), yahooSym);
    } catch (err: any) {
      console.error(`[Yahoo] Fetch error for ${yahooSym} (${host}):`, err?.message);
    }
  }

  console.warn(`[Yahoo] All hosts failed for ${yahooSym}`);
  return null;
}

function parseYahooResult(json: any, yahooSym: string): Record<string, any> | null {
  const error  = json?.quoteSummary?.error;
  if (error) { console.warn(`[Yahoo] API error for ${yahooSym}:`, error); return null; }

  const result = json?.quoteSummary?.result?.[0];
  if (!result)  { console.warn(`[Yahoo] No result for ${yahooSym}`); return null; }

  const sd  = result.summaryDetail        ?? {};
  const ks  = result.defaultKeyStatistics ?? {};
  const fd  = result.financialData        ?? {};
  const pr  = result.price                ?? {};

  const trailingEps = ks.trailingEps?.raw ?? null;
  const price       = pr.regularMarketPrice?.raw ?? 0;
  const pe = sd.trailingPE?.raw
    ?? (trailingEps && price ? parseFloat((price / trailingEps).toFixed(2)) : null);

  const out = {
    pe,
    forwardPe:        sd.forwardPE?.raw             ?? null,
    eps:              trailingEps,
    beta:             sd.beta?.raw                  ?? ks.beta?.raw ?? null,
    marketCap:        pr.marketCap?.raw             ?? sd.marketCap?.raw ?? null,
    dividendYield:    sd.dividendYield?.raw != null ? parseFloat((sd.dividendYield.raw * 100).toFixed(2)) : null,
    pbRatio:          ks.priceToBook?.raw           ?? null,
    debtToEquity:     fd.debtToEquity?.raw          ?? null,
    roe:              fd.returnOnEquity?.raw != null ? parseFloat((fd.returnOnEquity.raw * 100).toFixed(2)) : null,
    fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw      ?? null,
    fiftyTwoWeekLow:  sd.fiftyTwoWeekLow?.raw       ?? null,
    avgVolume:        sd.averageVolume?.raw          ?? null,
    sharesOutstanding: ks.sharesOutstanding?.raw    ?? null,
  };

  console.log(`[Yahoo] Fundamentals for ${yahooSym}: PE=${out.pe}, EPS=${out.eps}, Beta=${out.beta}, MarketCap=${out.marketCap}`);
  return out;
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const resource = searchParams.get('resource') || 'indices';

  // ── Indices ───────────────────────────────────────────────────
  if (resource === 'indices') {
    const indices = await fetchNseIndices();
    return NextResponse.json({ indices });
  }

  // ── Full quote with metadata ──────────────────────────────────
  if (resource === 'quote') {
    const symbol = searchParams.get('symbol');
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const symUp = symbol.toUpperCase();

    // fetchNseQuoteFull returns quote + full raw NSE response — no Redis dependency
    const [nseResult, yahoo] = await Promise.all([
      fetchNseQuoteFull(symUp),
      fetchYahooFundamentals(symUp),
    ]);

    if (!nseResult) return NextResponse.json({ error: 'Quote not available' }, { status: 503 });

    const { quote, raw } = nseResult;

    // Fix totalTradedValue = 0 → compute from volume × price
    if (!quote.totalTradedValue && quote.totalTradedVolume && quote.lastPrice) {
      quote.totalTradedValue = parseFloat((quote.totalTradedVolume * quote.lastPrice).toFixed(2));
    }

    // P/E: NSE metadata first, Yahoo fallback
    const nse_pe    = raw?.metadata?.pdSymbolPe  ?? null;
    const nse_secPe = raw?.metadata?.pdSectorPe  ?? null;
    const pe        = nse_pe ?? yahoo?.pe         ?? null;

    // Market cap: Yahoo live → NSE issuedSize × price
    const issuedSize = raw?.securityInfo?.issuedSize ?? yahoo?.sharesOutstanding ?? null;
    const marketCap  = yahoo?.marketCap
      ?? (issuedSize && quote.lastPrice ? parseFloat((issuedSize * quote.lastPrice).toFixed(0)) : null);

    const meta = {
      // Company / classification
      companyName:   raw?.info?.companyName              ?? raw?.metadata?.symbol ?? symUp,
      industry:      raw?.industryInfo?.basicIndustry    ?? raw?.metadata?.industry ?? null,
      sector:        raw?.industryInfo?.sector           ?? null,
      macro:         raw?.industryInfo?.macro            ?? null,
      isin:          raw?.info?.isin                     ?? raw?.metadata?.isin   ?? null,
      listingDate:   raw?.info?.listingDate              ?? null,
      faceValue:     raw?.securityInfo?.faceValue        ?? null,
      issuedSize,
      // Circuit limits
      lowerCP:       raw?.priceInfo?.lowerCP             ?? null,
      upperCP:       raw?.priceInfo?.upperCP             ?? null,
      priceBand:     raw?.priceInfo?.pPriceBand          ?? null,
      // Surveillance
      surveillance:  raw?.securityInfo?.surveillance?.surv ?? null,
      survDesc:      raw?.securityInfo?.surveillance?.desc ?? null,
      // Flags
      isFNO:         raw?.info?.isFNOSec                 ?? false,
      derivatives:   raw?.securityInfo?.derivatives      ?? null,
      slb:           raw?.securityInfo?.slb              ?? null,
      lastUpdateTime: raw?.metadata?.lastUpdateTime      ?? null,
      // Valuation — NSE + Yahoo
      pe,
      sectorPe:      nse_secPe,
      forwardPe:     yahoo?.forwardPe                    ?? null,
      eps:           yahoo?.eps                          ?? null,
      beta:          yahoo?.beta                         ?? null,
      pbRatio:       yahoo?.pbRatio                      ?? null,
      dividendYield: yahoo?.dividendYield                ?? null,
      roe:           yahoo?.roe                          ?? null,
      debtToEquity:  yahoo?.debtToEquity                 ?? null,
      // Size / volume
      marketCap,
      avgVolume:     yahoo?.avgVolume                    ?? null,
      // 52W (Yahoo is more reliable for extended-hours accuracy)
      week52High:    yahoo?.fiftyTwoWeekHigh             ?? quote.fiftyTwoWeekHigh ?? null,
      week52Low:     yahoo?.fiftyTwoWeekLow              ?? quote.fiftyTwoWeekLow  ?? null,
    };

    return NextResponse.json({ quote, meta });
  }

  // ── Gainers / Losers ──────────────────────────────────────────
  if (resource === 'gainers') {
    const data = await fetchGainersLosers('gainers');
    return NextResponse.json({ count: data.length, gainers: data.slice(0, 30), first_item: data[0] ?? null });
  }

  if (resource === 'losers') {
    const data = await fetchGainersLosers('losers');
    return NextResponse.json({ count: data.length, losers: data.slice(0, 30), first_item: data[0] ?? null });
  }

  return NextResponse.json({ error: 'Invalid resource. Use: indices, quote, gainers, losers' }, { status: 400 });
}
