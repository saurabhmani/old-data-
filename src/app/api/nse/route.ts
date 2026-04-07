import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { fetchNseIndices, fetchNseQuote, fetchGainersLosers } from '@/services/nse';

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const resource = searchParams.get('resource') || 'indices';

  if (resource === 'indices') {
    const indices = await fetchNseIndices();
    return NextResponse.json({ indices });
  }

  if (resource === 'quote') {
    const symbol = searchParams.get('symbol');
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const quote = await fetchNseQuote(symbol);
    if (!quote)  return NextResponse.json({ error: 'Quote not available' }, { status: 503 });
    return NextResponse.json({ quote });
  }

  if (resource === 'gainers') {
    const data = await fetchGainersLosers('gainers');
    return NextResponse.json({
      count: data.length,
      first_item: data[0] ?? null,   // raw first item so we can see the structure
      gainers: data.slice(0, 5),
    });
  }

  if (resource === 'losers') {
    const data = await fetchGainersLosers('losers');
    return NextResponse.json({
      count: data.length,
      first_item: data[0] ?? null,
      losers: data.slice(0, 5),
    });
  }

  // Raw NSE probe — fetch gainers/losers endpoint without any processing
  if (resource === 'raw-gainers') {
    try {
      const NSE_API = 'https://www.nseindia.com/api';
      const NSE_HEADERS = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.nseindia.com/',
      };
      // Get cookie first
      const homeRes = await fetch('https://www.nseindia.com/', { headers: NSE_HEADERS, signal: AbortSignal.timeout(8000) });
      const cookie  = homeRes.headers.get('set-cookie') ?? '';
      // Fetch gainers
      const res = await fetch(
        `${NSE_API}/live-analysis-variations?index=${encodeURIComponent('NIFTY 500')}`,
        { headers: { ...NSE_HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(10000) }
      );
      const status = res.status;
      if (!res.ok) return NextResponse.json({ status, error: 'NSE returned non-200', cookie_set: !!cookie });
      const raw = await res.json();
      return NextResponse.json({
        status,
        cookie_set: !!cookie,
        keys: Object.keys(raw ?? {}),
        gainers_count: raw?.gainers?.length ?? 0,
        losers_count:  raw?.losers?.length  ?? 0,
        first_gainer:  raw?.gainers?.[0]    ?? null,
      });
    } catch (e: any) {
      return NextResponse.json({ error: e.message });
    }
  }

  return NextResponse.json({ error: 'Invalid resource. Use: indices, quote, gainers, losers, raw-gainers' }, { status: 400 });
}
