'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import { Card, StatCard, Badge, Button, Loading, Empty } from '@/components/ui';
import { instrumentApi, chartsApi, watchlistApi } from '@/lib/apiClient';
import { useLiveTick } from '@/hooks/useLiveTick';
import { fmt, changeClass } from '@/lib/utils';
import { Activity, Star, TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { Instrument, Candle } from '@/types';

export default function InstrumentDetailPage() {
  const { key }            = useParams<{ key: string }>();
  const decoded            = decodeURIComponent(key);
  const [inst,    setInst] = useState<Instrument | null>(null);
  const [candles, setCand] = useState<Candle[]>([]);
  const [loading, setLoad] = useState(true);
  const [added,   setAdded]= useState(false);

  const { ticks } = useLiveTick(inst ? [decoded] : [], 'full');
  const tick = ticks[decoded] ?? null;

  useEffect(() => {
    async function load() {
      setLoad(true);
      try {
        const [iRes, cRes] = await Promise.allSettled([
          instrumentApi.get(decoded),
          chartsApi.intraday(decoded, '1minute'),
        ]);
        if (iRes.status === 'fulfilled') setInst((iRes.value as any).instrument);
        if (cRes.status === 'fulfilled') setCand((cRes.value as any).candles || []);
      } finally { setLoad(false); }
    }
    load();
  }, [decoded]);

  const addWatch = async () => {
    try { await watchlistApi.add({ instrument_key: decoded }); setAdded(true); }
    catch (e: any) { alert(e.data?.error || 'Failed'); }
  };

  if (loading) return <AppShell><Loading text="Loading instrument…" /></AppShell>;

  return (
    <AppShell title={inst?.tradingsymbol ?? 'Instrument'}>
      <div className="page">
        <div className="page__header">
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:4 }}>
              <h1 style={{ fontSize:28 }}>{inst?.tradingsymbol}</h1>
              {inst?.exchange && <Badge>{inst.exchange}</Badge>}
              {inst?.instrument_type && <Badge variant="gray">{inst.instrument_type}</Badge>}
              {tick && <Badge variant={tick.pct_change != null && tick.pct_change >= 0 ? 'green' : 'red'}>
                {fmt.percent(tick.pct_change)}
              </Badge>}
            </div>
            <p>{inst?.name}</p>
          </div>
          <Button variant="secondary" onClick={addWatch} disabled={added}>
            <Star size={14} fill={added ? 'currentColor' : 'none'} />
            {added ? 'Added' : 'Watchlist'}
          </Button>
        </div>

        {/* Stats */}
        <div className="grid-stats" style={{ marginBottom:24 }}>
          <StatCard label="LTP"    value={fmt.currency(tick?.ltp)}    icon={TrendingUp} iconVariant="blue" />
          <StatCard label="Open"   value={fmt.currency(tick?.open)}   icon={Activity}   iconVariant="green" />
          <StatCard label="High"   value={fmt.currency(tick?.high)}   icon={TrendingUp} iconVariant="green" />
          <StatCard label="Low"    value={fmt.currency(tick?.low)}    icon={TrendingUp} iconVariant="red" />
          <StatCard label="Volume" value={fmt.volume(tick?.volume)}   icon={Activity}   iconVariant="orange" />
          <StatCard label="OI"     value={fmt.volume(tick?.oi)}       icon={Activity}   iconVariant="blue" />
        </div>

        {/* Chart */}
        <Card title="Intraday Chart — 1 Minute">
          {candles.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={candles}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={v => new Date(v).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })}
                  tick={{ fontSize:11, fill:'#64748B' }}
                />
                <YAxis domain={['auto','auto']} tickFormatter={v => `₹${v}`} tick={{ fontSize:11, fill:'#64748B' }} width={72} />
                <Tooltip
                  formatter={(v: any) => fmt.currency(v)}
                  labelFormatter={v => new Date(v).toLocaleTimeString()}
                  contentStyle={{ borderRadius:8, border:'1px solid #E2E8F0', fontSize:12 }}
                />
                <Line type="monotone" dataKey="close" stroke="#2E75B6" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Empty icon={Activity} title="Chart data unavailable" description="Market may be closed or instrument not subscribed." />
          )}
        </Card>
      </div>
    </AppShell>
  );
}
