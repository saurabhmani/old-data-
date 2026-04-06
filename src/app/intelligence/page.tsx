'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, Zap, Target, Eye, AlertTriangle, BarChart2, Brain,
} from 'lucide-react';
import '@/styles/components/_intelligence.scss';
import '@/styles/components/_ui.scss';

// ── Helpers ───────────────────────────────────────────────────────
function SignalChip({ dir }: { dir: string }) {
  return <span className={`signal-chip signal-chip--${dir}`}>{dir}</span>;
}

function ConfBar({ value, label }: { value: number; label: string }) {
  const tier = value >= 70 ? 'high' : value >= 50 ? 'medium' : 'low';
  return (
    <div className="confidence-bar">
      <div className="confidence-bar__label">
        <span>{label}</span>
        <strong>{value}%</strong>
      </div>
      <div className="confidence-bar__track">
        <div className={`confidence-bar__fill confidence-bar__fill--${tier}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const tier = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
  return <div className={`opportunity-row__score opportunity-row__score--${tier}`}>{score}</div>;
}

function PlanGate({ children, feature, plan }: { children: React.ReactNode; feature: string; plan: string }) {
  const locked = plan === 'free' && !['market_explanation', 'signals_basic'].includes(feature);
  if (!locked) return <>{children}</>;
  return (
    <div className="plan-gate">
      {children}
      <div className="plan-gate__overlay">
        <div className="plan-gate__icon">🔒</div>
        <div className="plan-gate__title">Pro Feature</div>
        <div className="plan-gate__desc">Upgrade to Pro to unlock {feature.replace(/_/g,' ')}</div>
        <a href="/settings?upgrade=1" className="btn btn--primary btn--sm">Upgrade to Pro</a>
      </div>
    </div>
  );
}

export default function IntelligencePage() {
  const [explanation, setExplanation] = useState<any>(null);
  const [signals,     setSignals]     = useState<any[]>([]);
  const [setups,      setSetups]      = useState<any[]>([]);
  const [watchItems,  setWatchItems]  = useState<any[]>([]);
  const [indices,     setIndices]     = useState<any[]>([]);
  const [features,    setFeatures]    = useState<Record<string,boolean>>({});
  const [plan,        setPlan]        = useState('free');
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [explRes, sigRes, setupRes, watchRes, idxRes, featRes] = await Promise.allSettled([
          fetch('/api/explanations').then(r => r.json()),
          fetch('/api/signals?action=top&limit=10').then(r => r.json()),
          fetch('/api/trade-setups?action=top').then(r => r.json()),
          fetch('/api/watchlist/intelligence').then(r => r.json()),
          fetch('/api/nse?resource=indices').then(r => r.json()),
          fetch('/api/user/features').then(r => r.json()),
        ]);
        if (explRes.status  === 'fulfilled') setExplanation(explRes.value.explanation);
        if (sigRes.status   === 'fulfilled') setSignals(sigRes.value.signals || []);
        if (setupRes.status === 'fulfilled') setSetups(setupRes.value.setups || []);
        if (watchRes.status === 'fulfilled') setWatchItems(watchRes.value.items || []);
        if (idxRes.status   === 'fulfilled') setIndices(idxRes.value.indices?.slice(0,6) || []);
        if (featRes.status  === 'fulfilled') { setFeatures(featRes.value.features || {}); setPlan(featRes.value.plan || 'free'); }
      } finally { setLoading(false); }
    }
    load();
  }, []);

  const ex = explanation;

  return (
    <AppShell title="Intelligence Hub">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>Intelligence Hub</h1>
            <p>Signals · Trade Ideas · Market Explanation · Option Intelligence</p>
          </div>
          <span className={`badge ${plan === 'elite' ? 'badge--dark' : plan === 'pro' ? 'badge--green' : 'badge--gray'}`} style={{ fontSize:11, padding:'3px 10px' }}>
            {plan.toUpperCase()} Plan
          </span>
        </div>

        {/* ── Index bar ── */}
        {indices.length > 0 && (
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:20 }}>
            {indices.filter(i => ['NIFTY 50','NIFTY BANK','NIFTY MIDCAP 100','NIFTY IT','NIFTY PHARMA','INDIA VIX'].includes(i.name)).map((idx: any) => (
              <div key={idx.name} className="card card--compact" style={{ flexShrink:0, minWidth:130 }}>
                <div style={{ fontSize:11, color:'#64748B', fontWeight:600, marginBottom:2 }}>{idx.name.replace('NIFTY ','')}</div>
                <div style={{ fontSize:16, fontWeight:700, color:'#0F172A' }}>{idx.last?.toLocaleString('en-IN')}</div>
                <div style={{ fontSize:11, fontWeight:600 }} className={changeClass(idx.percentChange)}>
                  {idx.percentChange >= 0 ? '▲' : '▼'} {Math.abs(idx.percentChange).toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        )}

        {loading ? <Loading text="Loading intelligence data…" /> : (
          <div style={{ display:'grid', gap:20 }}>

            {/* ── Row 1: Market Explanation + Watchlist Opportunities ── */}
            <div className="grid-2">
              {/* Market Explanation */}
              <div className="market-card">
                <div className={`market-card__sentiment market-card__sentiment--${ex?.sentiment}`}>
                  {ex?.sentiment === 'Bullish' ? <TrendingUp size={13}/> : ex?.sentiment === 'Bearish' ? <TrendingDown size={13}/> : <BarChart2 size={13}/>}
                  {ex?.sentiment ?? 'Loading'}
                </div>
                <div className="market-card__headline">{ex?.headline ?? 'Market data loading…'}</div>
                {ex?.fullExplanation && (
                  <div className="market-card__explanation">{ex.fullExplanation}</div>
                )}
                {(ex?.sectorLeaders?.length || ex?.sectorLaggards?.length) && (
                  <div className="market-card__sections">
                    <div>
                      <div className="market-card__section-title">Leading</div>
                      {ex.sectorLeaders?.map((s: string) => <span key={s} className="market-card__pill market-card__pill--leader">{s}</span>)}
                    </div>
                    <div>
                      <div className="market-card__section-title">Lagging</div>
                      {ex.sectorLaggards?.map((s: string) => <span key={s} className="market-card__pill market-card__pill--lagger">{s}</span>)}
                    </div>
                  </div>
                )}
              </div>

              {/* Smart Watchlist */}
              <PlanGate feature="smart_watchlist" plan={plan}>
                <Card title="Smart Watchlist" flush action={<span style={{ fontSize:11, color:'#94A3B8' }}>Ranked by opportunity</span>}>
                  {watchItems.length === 0 ? (
                    <Empty icon={Eye} title="Add stocks to your watchlist" description="Intelligence scores will appear here." />
                  ) : watchItems.slice(0,8).map((item: any) => (
                    <div key={item.instrument_key} className="opportunity-row">
                      <div className="opportunity-row__left">
                        <ScoreBadge score={item.opportunity_score} />
                        <div>
                          <div className="opportunity-row__symbol">{item.tradingsymbol}</div>
                          <div className="opportunity-row__name">{item.name}</div>
                        </div>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        {item.has_alert && <AlertTriangle size={14} color="#D97706" />}
                        <SignalChip dir={item.signal_direction} />
                        <span style={{ fontSize:11, color:'#94A3B8' }}>{item.signal_confidence}%</span>
                      </div>
                    </div>
                  ))}
                </Card>
              </PlanGate>
            </div>

            {/* ── Row 2: Top Signals + Trade Setups ── */}
            <div className="grid-2">
              {/* Top Signals */}
              <PlanGate feature="signals_basic" plan={plan}>
                <Card title="Top Signals" flush action={<a href="/signals" className="btn btn--ghost btn--sm">View all →</a>}>
                  {signals.length === 0 ? (
                    <Empty icon={Zap} title="No signals yet" description="Run rankings sync in Admin → Data Management." />
                  ) : signals.slice(0,6).map((s: any) => (
                    <div key={s.instrument_key} className="opportunity-row">
                      <div className="opportunity-row__left">
                        <div>
                          <div className="opportunity-row__symbol">{s.tradingsymbol}</div>
                          <div className="opportunity-row__name" style={{ fontSize:11 }}>{s.reasons?.[0]?.description?.slice(0,50)}</div>
                        </div>
                      </div>
                      <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, minWidth:90 }}>
                        <SignalChip dir={s.direction} />
                        <ConfBar value={s.confidence} label="" />
                      </div>
                    </div>
                  ))}
                </Card>
              </PlanGate>

              {/* Trade Setups */}
              <PlanGate feature="trade_setups" plan={plan}>
                <Card title="Trade Setups" flush action={<a href="/trade-setups" className="btn btn--ghost btn--sm">View all →</a>}>
                  {setups.length === 0 ? (
                    <Empty icon={Target} title="No setups generated" description="Admin can trigger recompute from the panel." />
                  ) : setups.slice(0,4).map((setup: any) => (
                    <div key={setup.id} className={`setup-card setup-card--${setup.direction}`} style={{ margin:'12px 16px' }}>
                      <div className="setup-card__header">
                        <span className="setup-card__symbol">{setup.tradingsymbol}</span>
                        <div style={{ display:'flex', gap:6 }}>
                          <SignalChip dir={setup.direction} />
                          <Badge variant="gray">{setup.timeframe}</Badge>
                        </div>
                      </div>
                      <div className="setup-card__levels">
                        <div className="setup-card__level setup-card__level--entry">
                          <div className="label">Entry</div>
                          <div className="value">{fmt.currency(setup.entry_price)}</div>
                        </div>
                        <div className="setup-card__level setup-card__level--sl">
                          <div className="label">Stop Loss</div>
                          <div className="value">{fmt.currency(setup.stop_loss)}</div>
                        </div>
                        <div className="setup-card__level setup-card__level--t1">
                          <div className="label">Target</div>
                          <div className="value">{fmt.currency(setup.target1)}</div>
                        </div>
                      </div>
                      <div className="setup-card__meta">
                        <span>Confidence: <strong>{setup.confidence}%</strong></span>
                        {setup.risk_reward && <span>R:R <strong>1:{setup.risk_reward}</strong></span>}
                      </div>
                    </div>
                  ))}
                </Card>
              </PlanGate>
            </div>

          </div>
        )}
      </div>
    </AppShell>
  );
}
