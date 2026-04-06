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
    return NextResponse.json({ gainers: data });
  }

  if (resource === 'losers') {
    const data = await fetchGainersLosers('losers');
    return NextResponse.json({ losers: data });
  }

  return NextResponse.json({ error: 'Invalid resource. Use: indices, quote, gainers, losers' }, { status: 400 });
}
