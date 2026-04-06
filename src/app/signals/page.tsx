'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { fmt, changeClass, debounce } from '@/lib/utils';
import { Zap, Search, ChevronDown, ChevronUp } from 'lucide-react';
import '@/styles/components/_intelligence.scss';
import '@/styles/components/_ui.scss';

function SignalChip({ dir }: { dir: string }) {
  return <span className={`signal-chip signal-chip--${dir}`}>{dir}</span>;
}

function ConfBar({ value }: { value: number }) {
  const tier = value >= 70 ? 'high' : value >= 50 ? 'medium' : 'low';
  return (
    <div style={{ width: 80 }}>
      <div className="confidence-bar__track">
        <div className={`confidence-bar__fill confidence-bar__fill--${tier}`} style={{ width: `${value}%` }} />
      </div>
      <div style={{ fontSize: 10, color: '#64748B', textAlign: 'right', marginTop: 2 }}>{value}%</div>
    </div>
  );
}

function ReasonExpander({ reasons }: { reasons: any[] }) {
  const [open, setOpen] = useState(false);
  if (!reasons?.length) return null;
  const shown = reasons.filter(r => r.score !== 0).slice(0, open ? 99 : 3);
  return (
    <div>
      {shown.map((r: any) => (
        <div key={r.key} className="reason-item">
          <div className={`reason-item__dot reason-item__dot--${r.score > 0 ? 'positive' : r.score < 0 ? 'negative' : 'neutral'}`} />
          <div>
            <div className="reason-item__label">{r.label}</div>
            <div className="reason-item__desc">{r.description}</div>
          </div>
        </div>
      ))}
      {reasons.filter(r => r.score !== 0).length > 3 && (
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(o => !o)} style={{ marginTop: 4, fontSize: 11 }}>
          {open ? <><ChevronUp size={11} /> Less</> : <><ChevronDown size={11} /> {reasons.length - 3} more reasons</>}
        </button>
      )}
    </div>
  );
}

export default function SignalsPage() {
  const [signals,  setSignals]  = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [filter,   setFilter]   = useState<'all' | 'BUY' | 'SELL' | 'HOLD'>('all');
  const [query,    setQuery]    = useState('');
  const [single,   setSingle]   = useState<any>(null);
  const [sLoading, setSLoad]    = useState(false);

  useEffect(() => {
    fetch('/api/signals?action=top&limit=30')
      .then(r => (r.ok ? r.json() : { signals: [] }))
      .then(d => setSignals(d.signals || []))
      .catch(() => setSignals([]))
      .finally(() => setLoading(false));
  }, []);

  const lookupSignal = useCallback(debounce(async (sym: string) => {
    if (sym.length < 2) { setSingle(null); return; }
    setSLoad(true);
    try {
      const res = await fetch(`/api/signals?action=instrument&symbol=${encodeURIComponent(sym.toUpperCase())}`);
      const d = res.ok ? await res.json() : {};
      setSingle(d.signal || null);
    } catch { setSingle(null); }
    finally { setSLoad(false); }
  }, 600), []);

  const displayed = signals.filter(s =>
    (filter === 'all' || s.direction === filter) &&
    (!query || s.tradingsymbol?.includes(query.toUpperCase()))
  );

  return (
    <AppShell title="Signals">
      <div className="page">
        <div className="page__header">
          <div><h1>Signal Engine</h1><p>Rule-based BUY / SELL / HOLD with confidence scoring</p></div>
        </div>

        {/* Live lookup */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Search size={16} style={{ color: '#94A3B8', flexShrink: 0 }} />
            <input
              className="input"
              placeholder="Type any NSE symbol to get live signal…  e.g. RELIANCE, HDFC, TCS"
              onChange={e => { setQuery(e.target.value); lookupSignal(e.target.value); }}
              style={{ height: 44 }}
            />
          </div>
          {sLoading && <div style={{ marginTop: 12, fontSize: 13, color: '#64748B' }}>Analysing {query.toUpperCase()}…</div>}
          {single && !sLoading && (
            <div style={{ marginTop: 16, padding: '16px', background: '#F8FAFC', borderRadius: 10, border: '1px solid #E2E8F0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span style={{ fontSize: 18, fontWeight: 800, color: '#1E3A5F' }}>{single.tradingsymbol}</span>
                <SignalChip dir={single.direction} />
                <Badge variant="gray">{single.risk} Risk</Badge>
                <span style={{ marginLeft: 'auto', fontSize: 13, color: '#64748B' }}>Confidence: <strong style={{ color: '#0F172A' }}>{single.confidence}%</strong></span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 12 }}>
                {[['Entry', single.entry_price], ['Stop Loss', single.stop_loss], ['Target 1', single.target1]].map(([l, v]) => (
                  <div key={String(l)} style={{ background: '#fff', borderRadius: 8, padding: '10px 14px', border: '1px solid #E2E8F0' }}>
                    <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 4 }}>{l}</div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{fmt.currency(v as number)}</div>
                  </div>
                ))}
              </div>
              {single.risk_reward && (
                <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>Risk/Reward: <strong>1:{single.risk_reward}</strong></div>
              )}
              <ReasonExpander reasons={single.reasons} />
            </div>
          )}
        </Card>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['all', 'BUY', 'SELL', 'HOLD'] as const).map(f => (
            <button key={f} className={`btn btn--sm ${filter === f ? 'btn--primary' : 'btn--secondary'}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#64748B', alignSelf: 'center' }}>{displayed.length} signals</span>
        </div>

        {/* Signals table */}
        <Card flush>
          {loading ? <Loading /> : displayed.length === 0 ? (
            <Empty icon={Zap} title="No signals" description="Add stocks to rankings via Admin panel to generate signals." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th><th>Signal</th><th>Confidence</th>
                    <th>Risk</th><th style={{ textAlign: 'right' }}>Entry</th>
                    <th style={{ textAlign: 'right' }}>SL</th><th style={{ textAlign: 'right' }}>T1</th>
                    <th style={{ textAlign: 'right' }}>R:R</th><th>Top Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((s: any) => (
                    <tr key={s.instrument_key}>
                      <td><strong style={{ color: '#1E3A5F' }}>{s.tradingsymbol}</strong></td>
                      <td><SignalChip dir={s.direction} /></td>
                      <td><ConfBar value={s.confidence} /></td>
                      <td>
                        <Badge variant={s.risk === 'High' ? 'red' : s.risk === 'Low' ? 'green' : 'orange'}>
                          {s.risk}
                        </Badge>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt.currency(s.entry_price)}</td>
                      <td style={{ textAlign: 'right', color: '#DC2626' }}>{fmt.currency(s.stop_loss)}</td>
                      <td style={{ textAlign: 'right', color: '#16A34A' }}>{fmt.currency(s.target1)}</td>
                      <td style={{ textAlign: 'right' }}>{s.risk_reward ? `1:${s.risk_reward}` : '—'}</td>
                      <td style={{ fontSize: 12, color: '#64748B', maxWidth: 200 }}>{s.reasons?.[0]?.description?.slice(0, 60) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
