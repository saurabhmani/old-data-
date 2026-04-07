'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import { Card, StatCard, Badge, Button, Loading, Empty } from '@/components/ui';
import { chartsApi, watchlistApi } from '@/lib/apiClient';
import { useLiveTick } from '@/hooks/useLiveTick';
import { fmt, changeClass } from '@/lib/utils';
import { Activity, Star, TrendingUp, TrendingDown } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { Candle } from '@/types';

function DetailItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600, marginBottom:2 }}>{label}</div>
      <div style={{ fontWeight:700, fontSize:14, color: color ?? '#0F172A' }}>{value}</div>
    </div>
  );
}

export default function InstrumentDetailPage() {
  const { key }              = useParams<{ key: string }>();
  const decoded              = decodeURIComponent(key);
  const sym                  = decoded.includes('|') ? decoded.split('|')[1].toUpperCase() : decoded.toUpperCase();
  const exch                 = decoded.includes('|') ? decoded.split('|')[0].replace('_EQ','').replace('_FO','') : 'NSE';

  const [inst,    setInst]   = useState<any>(null);
  const [quote,   setQuote]  = useState<any>(null);   // NSE quote — initial data
  const [meta,    setMeta]   = useState<any>(null);   // NSE metadata (company, sector, circuit)
  const [candles, setCand]   = useState<Candle[]>([]);
  const [loading, setLoad]   = useState(true);
  const [added,   setAdded]  = useState(false);

  const { ticks } = useLiveTick([decoded], 'full');
  const tick = ticks[decoded] ?? null;

  // Merge live tick over initial quote — tick wins when present
  const lastCandle = candles[candles.length - 1] as any ?? null;
  const ltp     = tick?.ltp        ?? quote?.lastPrice          ?? lastCandle?.close  ?? null;
  const open    = tick?.open       ?? quote?.open               ?? lastCandle?.open   ?? null;
  const high    = tick?.high       ?? quote?.dayHigh            ?? lastCandle?.high   ?? null;
  const low     = tick?.low        ?? quote?.dayLow             ?? lastCandle?.low    ?? null;
  const volume  = tick?.volume     ?? quote?.totalTradedVolume  ?? lastCandle?.volume ?? null;
  const oi      = tick?.oi         ?? null;
  const pctChg  = tick?.pct_change ?? quote?.pChange            ?? null;
  const netChg  = tick?.net_change ?? quote?.change             ?? null;
  const prevCls = quote?.previousClose    ?? null;
  const week52H    = quote?.fiftyTwoWeekHigh   ?? null;
  const week52L    = quote?.fiftyTwoWeekLow    ?? null;
  const vwap       = quote?.vwap               ?? null;
  const tradedVal  = quote?.totalTradedValue   ?? null;
  const isFO       = meta?.isFNO || decoded.includes('_FO') ||
                     inst?.instrument_type === 'CE' || inst?.instrument_type === 'PE' || inst?.instrument_type === 'FUT';
  const pe          = meta?.pe          ?? null;
  const forwardPe   = meta?.forwardPe  ?? null;
  const sectorPe    = meta?.sectorPe   ?? null;
  const eps         = meta?.eps        ?? null;
  const beta        = meta?.beta       ?? null;
  const pbRatio     = meta?.pbRatio    ?? null;
  const dividendYield = meta?.dividendYield ?? null;
  const roe         = meta?.roe        ?? null;
  const marketCap   = meta?.marketCap  ?? null;
  const avgVolume   = meta?.avgVolume  ?? null;
  const week52High  = meta?.week52High ?? week52H;
  const week52Low   = meta?.week52Low  ?? week52L;

  useEffect(() => {
    async function load() {
      setLoad(true);
      try {
        // Fetch instrument meta, chart candles, and NSE quote in parallel
        const [iRes, cRes, qRes] = await Promise.allSettled([
          fetch(`/api/instruments?key=${encodeURIComponent(decoded)}`).then(r => r.json()),
          chartsApi.intraday(decoded, '1minute'),
          fetch(`/api/nse?resource=quote&symbol=${encodeURIComponent(sym)}`).then(r => r.json()),
        ]);

        if (iRes.status === 'fulfilled' && iRes.value?.instrument) {
          setInst(iRes.value.instrument);
        } else {
          // Build minimal instrument from key
          setInst({ tradingsymbol: sym, exchange: exch, instrument_type: 'EQ', name: sym });
        }

        if (cRes.status === 'fulfilled') {
          setCand((cRes.value as any).candles || []);
        }

        if (qRes.status === 'fulfilled' && qRes.value?.quote) {
          setQuote(qRes.value.quote);
          if (qRes.value.meta) setMeta(qRes.value.meta);
        } else {
          // Fallback: try the NSE 500 cache via market-intelligence
          const miRes = await fetch(`/api/market-intelligence`).then(r => r.json()).catch(() => null);
          const all = [...(miRes?.topGainers ?? []), ...(miRes?.topLosers ?? [])];
          const found = all.find((s: any) => String(s.symbol ?? '').toUpperCase() === sym);
          if (found) {
            setQuote({
              lastPrice:          found.ltp,
              change:             found.change_abs,
              pChange:            found.change_percent,
              open:               null,
              dayHigh:            null,
              dayLow:             null,
              totalTradedVolume:  found.volume,
              previousClose:      null,
            });
          }
        }
      } finally { setLoad(false); }
    }
    load();
  }, [decoded]);

  const addWatch = async () => {
    try {
      await watchlistApi.add({ instrument_key: decoded, tradingsymbol: sym, exchange: exch, name: inst?.name || sym });
      setAdded(true);
    } catch (e: any) { alert(e.data?.error || 'Failed'); }
  };

  if (loading) return <AppShell><Loading text="Loading instrument…" /></AppShell>;

  return (
    <AppShell title={inst?.tradingsymbol ?? sym}>
      <div className="page">
        {/* ── Header ── */}
        <div className="page__header">
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:4 }}>
              <h1 style={{ fontSize:28 }}>{inst?.tradingsymbol ?? sym}</h1>
              <Badge>{inst?.exchange ?? exch}</Badge>
              {inst?.instrument_type && <Badge variant="gray">{inst.instrument_type}</Badge>}
              {pctChg != null && (
                <Badge variant={pctChg >= 0 ? 'green' : 'red'}>
                  {pctChg >= 0 ? '▲' : '▼'} {fmt.percent(Math.abs(pctChg))}
                </Badge>
              )}
            </div>
            <p style={{ color:'#64748B', fontSize:14 }}>
              {meta?.companyName ?? inst?.name ?? sym}
              {meta?.sector && <span style={{ marginLeft:8, fontSize:12, color:'#94A3B8' }}>· {meta.sector}</span>}
              {meta?.industry && <span style={{ marginLeft:4, fontSize:12, color:'#94A3B8' }}>· {meta.industry}</span>}
            </p>
            {ltp != null && (
              <div style={{ display:'flex', alignItems:'baseline', gap:8, marginTop:6 }}>
                <span style={{ fontSize:28, fontWeight:700, color:'#0F172A' }}>{fmt.currency(ltp)}</span>
                {netChg != null && (
                  <span style={{ fontSize:14, fontWeight:600 }} className={changeClass(netChg)}>
                    {netChg >= 0 ? '+' : ''}{fmt.currency(netChg)} ({fmt.percent(pctChg)})
                  </span>
                )}
              </div>
            )}
          </div>
          <Button variant="secondary" onClick={addWatch} disabled={added}>
            <Star size={14} fill={added ? 'currentColor' : 'none'} />
            {added ? 'Added' : 'Add to Watchlist'}
          </Button>
        </div>

        {/* ── Stats grid ── */}
        <div className="grid-stats" style={{ marginBottom:24 }}>
          <StatCard label="LTP"    value={fmt.currency(ltp)}   icon={TrendingUp}  iconVariant="blue"   />
          <StatCard label="Open"   value={fmt.currency(open)}  icon={Activity}    iconVariant="green"  />
          <StatCard label="High"   value={fmt.currency(high)}  icon={TrendingUp}  iconVariant="green"  />
          <StatCard label="Low"    value={fmt.currency(low)}   icon={TrendingDown} iconVariant="red"   />
          <StatCard label="Volume" value={fmt.volume(volume)}  icon={Activity}    iconVariant="orange" />
          {isFO
            ? <StatCard label="OI" value={fmt.volume(oi)}      icon={Activity}    iconVariant="blue"   />
            : <StatCard label="P/E" value={pe != null ? Number(pe).toFixed(2) : '—'} icon={Activity} iconVariant="blue" />
          }
        </div>

        {/* ── Extra details ── */}
        <Card style={{ marginBottom:24 }}>
          {meta?.surveillance && (
            <div style={{ marginBottom:16, padding:'8px 12px', background:'#FEF3C7', borderRadius:6, fontSize:12, color:'#92400E' }}>
              ⚠ <strong>Surveillance:</strong> {meta.survDesc ?? meta.surveillance}
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:16 }}>
            {prevCls   != null && <DetailItem label="Prev Close"     value={fmt.currency(prevCls)} />}
            {vwap      != null && <DetailItem label="VWAP"           value={fmt.currency(vwap)} />}
            {tradedVal != null && tradedVal > 0 && <DetailItem label="Traded Value"  value={fmt.volume(tradedVal)} />}
            {avgVolume != null && <DetailItem label="Avg Volume"     value={fmt.volume(avgVolume)} />}
            {marketCap != null && <DetailItem label="Market Cap"     value={fmt.volume(marketCap)} />}
            {pe        != null && <DetailItem label="P/E (Trailing)" value={Number(pe).toFixed(2)} />}
            {forwardPe != null && <DetailItem label="P/E (Forward)"  value={Number(forwardPe).toFixed(2)} />}
            {sectorPe  != null && <DetailItem label="P/E (Sector)"   value={Number(sectorPe).toFixed(2)} />}
            {eps       != null && <DetailItem label="EPS"            value={fmt.currency(eps)} />}
            {beta      != null && <DetailItem label="Beta"           value={Number(beta).toFixed(2)} />}
            {pbRatio   != null && <DetailItem label="P/B Ratio"      value={Number(pbRatio).toFixed(2)} />}
            {roe       != null && <DetailItem label="ROE"            value={`${Number(roe).toFixed(1)}%`} />}
            {dividendYield != null && <DetailItem label="Div Yield"  value={`${Number(dividendYield).toFixed(2)}%`} />}
            {week52High!= null && <DetailItem label="52W High"       value={fmt.currency(week52High)} color="#16A34A" />}
            {week52Low != null && <DetailItem label="52W Low"        value={fmt.currency(week52Low)}  color="#DC2626" />}
            {meta?.upperCP   != null && <DetailItem label="Upper Circuit" value={fmt.currency(Number(meta.upperCP))}  color="#16A34A" />}
            {meta?.lowerCP   != null && <DetailItem label="Lower Circuit" value={fmt.currency(Number(meta.lowerCP))}  color="#DC2626" />}
            {meta?.faceValue != null && <DetailItem label="Face Value"    value={`₹${meta.faceValue}`} />}
            {meta?.issuedSize!= null && <DetailItem label="Shares Out."   value={fmt.volume(meta.issuedSize)} />}
            {meta?.listingDate && <DetailItem label="Listed"              value={fmt.date(meta.listingDate)} />}
            {meta?.isin && (
              <div>
                <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600, marginBottom:2 }}>ISIN</div>
                <div style={{ fontWeight:600, fontSize:12, fontFamily:'monospace', color:'#334155' }}>{meta.isin}</div>
              </div>
            )}
            {meta?.slb         && <DetailItem label="SLB"         value={meta.slb} />}
            {meta?.derivatives && <DetailItem label="Derivatives" value={meta.derivatives} />}
          </div>
        </Card>

        {/* ── Intraday chart ── */}
        <Card title="Intraday Chart — 1 Minute">
          {candles.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={candles}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={v => new Date(v).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })}
                  tick={{ fontSize:11, fill:'#64748B' }}
                />
                <YAxis
                  domain={['auto','auto']}
                  tickFormatter={v => `₹${Number(v).toLocaleString('en-IN')}`}
                  tick={{ fontSize:11, fill:'#64748B' }}
                  width={80}
                />
                <Tooltip
                  formatter={(v: any) => [fmt.currency(v), 'Close']}
                  labelFormatter={v => new Date(v).toLocaleTimeString('en-IN')}
                  contentStyle={{ borderRadius:8, border:'1px solid #E2E8F0', fontSize:12 }}
                />
                <Line type="monotone" dataKey="close" stroke="#2E75B6" strokeWidth={2} dot={false} activeDot={{ r:4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Empty icon={Activity} title="Chart data unavailable" description="Market may be closed or data not yet available for this instrument." />
          )}
        </Card>
      </div>
    </AppShell>
  );
}
