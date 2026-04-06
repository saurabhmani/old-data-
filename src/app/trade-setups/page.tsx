'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Button } from '@/components/ui';
import { fmt } from '@/lib/utils';
import { Target, RefreshCw } from 'lucide-react';
import '@/styles/components/_intelligence.scss';

function SignalChip({ dir }: { dir: string }) {
  return <span className={`signal-chip signal-chip--${dir}`}>{dir}</span>;
}

export default function TradeSetupsPage() {
  const [setups,   setSetups]   = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [recomp,   setRecomp]   = useState(false);

  async function load() {
    setLoading(true);
    try { const d = await fetch('/api/trade-setups?action=active').then(r => r.json()); setSetups(d.setups || []); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const recompute = async () => {
    setRecomp(true);
    try { await fetch('/api/trade-setups', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); await load(); }
    finally { setRecomp(false); }
  };

  return (
    <AppShell title="Trade Setups">
      <div className="page">
        <div className="page__header">
          <div><h1>Trade Setups</h1><p>Rule-based actionable setups with entry, SL and targets</p></div>
          <Button variant="secondary" onClick={recompute} loading={recomp}><RefreshCw size={13} /> Recompute</Button>
        </div>

        {loading ? <Loading /> : setups.length === 0 ? (
          <Empty icon={Target} title="No active setups" description="Click Recompute to generate setups from top ranked stocks." action={<Button onClick={recompute} loading={recomp}><RefreshCw size={13} /> Generate Setups</Button>} />
        ) : (
          <div className="grid-3">
            {setups.map((s: any) => (
              <div key={s.id} className={`setup-card setup-card--${s.direction}`}>
                <div className="setup-card__header">
                  <div>
                    <div className="setup-card__symbol">{s.tradingsymbol}</div>
                    <div style={{ fontSize:12, color:'#64748B' }}>{s.exchange}</div>
                  </div>
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                    <SignalChip dir={s.direction} />
                    <Badge variant="gray">{s.timeframe || 'swing'}</Badge>
                  </div>
                </div>

                <div className="setup-card__levels">
                  <div className="setup-card__level setup-card__level--entry">
                    <div className="label">Entry</div>
                    <div className="value">{fmt.currency(s.entry_price)}</div>
                  </div>
                  <div className="setup-card__level setup-card__level--sl">
                    <div className="label">Stop Loss</div>
                    <div className="value">{fmt.currency(s.stop_loss)}</div>
                  </div>
                  <div className="setup-card__level setup-card__level--t1">
                    <div className="label">Target 1</div>
                    <div className="value">{fmt.currency(s.target1)}</div>
                  </div>
                </div>

                {s.target2 && (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#64748B', marginBottom:8 }}>
                    <span>Target 2: <strong>{fmt.currency(s.target2)}</strong></span>
                    {s.risk_reward && <span>R:R <strong>1:{s.risk_reward}</strong></span>}
                  </div>
                )}

                <div className="setup-card__meta">
                  <span>Confidence: <strong style={{ color: s.confidence >= 70 ? '#16A34A' : s.confidence >= 55 ? '#D97706' : '#DC2626' }}>{s.confidence}%</strong></span>
                  {s.expires_at && <span>Valid till {new Date(s.expires_at).toLocaleDateString('en-IN')}</span>}
                </div>

                {s.reason && <div className="setup-card__reason">{s.reason}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
