'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, BarChart2, Zap, Target,
  RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
  Shield, Activity, AlertTriangle, CheckCircle,
} from 'lucide-react';
import ConvictionDistribution from '@/components/dashboard/ConvictionDistribution';
import styles from './dashboard.module.scss';

interface MarketIntel {
  marketTrend:    string;
  trendScore:     number;
  regime:         string;
  breadth:        { advancing: number; declining: number; unchanged: number; ratio: number | null };
  sectorStrength: Array<{ sector: string; change_percent: number; trend: string }>;
  topGainers:     Array<{ symbol: string; name: string; ltp: number; change_percent: number }>;
  topLosers:      Array<{ symbol: string; name: string; ltp: number; change_percent: number }>;
  fiiDii:         Array<{ date: string; fii_net: number; dii_net: number; fii_label: string; dii_label: string }>;
  volatility:     { nifty_vix: number | null; avg_range_pct: number; volatility_label: string };
  scenario:       { tag: string; confidence: number; stance_hint: string; allowed_strategies: string[] } | null;
  market_stance:  { stance: string; confidence: number; guidance: string; rationale: string; config: any } | null;
  meta:           { asOf: string; dataSource: string; cacheAgeSec: number | null };
}

interface RankingRow {
  symbol: string; name: string; exchange: string;
  score: number; ltp: number; pct_change: number;
  signal_type: string | null; confidence: number | null;
  confidence_score: number | null; conviction_band: string | null;
  portfolio_fit_score: number | null; market_stance: string | null;
}

interface OpportunityRow {
  tradingsymbol: string; exchange: string; direction: string;
  confidence: number; entry_price: number | null;
  stop_loss: number | null; target1: number | null;
  risk_reward: number | null; opportunity_score: number;
  conviction_band: string | null; scenario_tag: string | null;
}

const TREND_META: Record<string, { color: string; bg: string; Icon: React.ElementType }> = {
  'Strong Bull': { color: '#15803D', bg: '#DCFCE7', Icon: TrendingUp   },
  'Bull':        { color: '#16A34A', bg: '#F0FDF4', Icon: TrendingUp   },
  'Neutral':     { color: '#64748B', bg: '#F1F5F9', Icon: Minus        },
  'Bear':        { color: '#DC2626', bg: '#FEF2F2', Icon: TrendingDown },
  'Strong Bear': { color: '#B91C1C', bg: '#FEE2E2', Icon: TrendingDown },
};

const STANCE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  aggressive:          { bg: '#DCFCE7', color: '#15803D', label: 'Aggressive' },
  selective:           { bg: '#DBEAFE', color: '#1D4ED8', label: 'Selective' },
  defensive:           { bg: '#FEF3C7', color: '#D97706', label: 'Defensive' },
  capital_preservation:{ bg: '#FEE2E2', color: '#DC2626', label: 'Capital Preservation' },
};

function TrendBar({ score }: { score: number }) {
  const pct   = Math.min(100, Math.max(0, (score + 100) / 2));
  const color = score > 25 ? '#16A34A' : score < -25 ? '#DC2626' : '#D97706';
  return (
    <div style={{ height: 6, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width 0.6s' }} />
    </div>
  );
}

function SignalPill({ type }: { type: string | null }) {
  if (!type) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const s = { BUY: ['#DCFCE7','#15803D'], SELL: ['#FEE2E2','#DC2626'], HOLD: ['#F1F5F9','#64748B'] }[type] ?? ['#F1F5F9','#64748B'];
  return <span style={{ background: s[0], color: s[1], fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 99 }}>{type}</span>;
}

function ConvictionBadge({ band }: { band: string | null }) {
  if (!band || band === 'reject') return null;
  const cfg = { high_conviction:['#D1FAE5','#065F46','●●●●'], actionable:['#DBEAFE','#1D4ED8','●●●○'], watchlist:['#FEF3C7','#92400E','●●○○'] }[band];
  if (!cfg) return null;
  return <span style={{ background:cfg[0], color:cfg[1], fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:99 }}>{cfg[2]}</span>;
}

function ConfBar({ val }: { val: number | null }) {
  if (val == null) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const c = val >= 75 ? '#065F46' : val >= 65 ? '#1D4ED8' : val >= 55 ? '#D97706' : '#DC2626';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
      <div style={{ width:44, height:4, background:'#E2E8F0', borderRadius:99, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${val}%`, background:c, borderRadius:99 }} />
      </div>
      <span style={{ fontSize:11, fontWeight:600, color:c }}>{val}%</span>
    </div>
  );
}

export default function DashboardPage() {
  const [intel,    setIntel]    = useState<MarketIntel | null>(null);
  const [rankings, setRankings] = useState<RankingRow[]>([]);
  const [opps,     setOpps]     = useState<OpportunityRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [lastAt,   setLastAt]   = useState<string | null>(null);

  const load = useCallback(async (spinner = true) => {
    if (spinner) setLoading(true);
    try {
      const [iRes, rRes, oRes] = await Promise.allSettled([
        fetch('/api/market-intelligence').then(r => r.json()),
        fetch('/api/rankings?limit=10').then(r => r.json()),
        fetch('/api/signals?action=top&limit=6').then(r => r.json()),
      ]);
      if (iRes.status === 'fulfilled') setIntel(iRes.value);
      if (rRes.status === 'fulfilled') setRankings(rRes.value.data ?? []);
      if (oRes.status === 'fulfilled') setOpps(oRes.value.signals ?? []);
      setLastAt(new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }));
    } finally {
      if (spinner) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const trend = intel?.marketTrend ?? 'Neutral';
  const tm    = TREND_META[trend] ?? TREND_META['Neutral'];
  const stanceKey = intel?.market_stance?.stance ?? 'selective';
  const stanceStyle = STANCE_STYLE[stanceKey] ?? STANCE_STYLE.selective;

  return (
    <AppShell title="Dashboard">
      <div className="page">

        <div className="page__header">
          <div>
            <h1>Dashboard</h1>
            <p>Quantorus365 — Institutional Intelligence{lastAt ? ` · ${lastAt}` : ''}</p>
          </div>
          <button className="btn btn--secondary btn--sm" onClick={() => load(true)} disabled={loading}>
            <RefreshCw size={13} className={loading ? styles.spin : ''} /> Refresh
          </button>
        </div>

        {/* ── MARKET STANCE BANNER ─────────────────────────────── */}
        {intel?.market_stance && (
          <div style={{
            background: stanceStyle.bg, borderRadius: 10, padding: '12px 18px',
            marginBottom: 20, border: `1px solid ${stanceStyle.color}33`,
            display: 'flex', alignItems: 'flex-start', gap: 14,
          }}>
            <Shield size={20} color={stanceStyle.color} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: stanceStyle.color }}>
                  Market Stance: {stanceStyle.label}
                </span>
                <span style={{ fontSize: 11, color: stanceStyle.color, background: 'white', padding: '1px 8px', borderRadius: 99, fontWeight: 600 }}>
                  {intel.market_stance.confidence}% confidence
                </span>
                {intel.scenario && (
                  <span style={{ fontSize: 11, color: '#64748B', background: '#F1F5F9', padding: '1px 8px', borderRadius: 99 }}>
                    {intel.scenario.tag.replace(/_/g,' ')}
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>
                {intel.market_stance.guidance}
              </p>
              {intel.market_stance.config && (
                <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                  {[
                    [`Min confidence: ${intel.market_stance.config.min_confidence}%`, ''],
                    [`Min R:R: ${intel.market_stance.config.min_rr}`, ''],
                    [`Max positions: ${intel.market_stance.config.max_positions}`, ''],
                    [`Risk multiplier: ${intel.market_stance.config.risk_multiplier}×`, ''],
                  ].map(([t]) => (
                    <span key={t} style={{ fontSize: 10, color: stanceStyle.color, fontWeight: 600 }}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SECTION 1: MARKET INTELLIGENCE ────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <BarChart2 size={14} />
            <span>Market Intelligence</span>
          </div>

          <div className={styles.intelRow}>
            {/* Trend */}
            <div className={styles.intelBox} style={{ borderColor: tm.color + '55', background: tm.bg }}>
              {loading ? <div className="skeleton" style={{ height:72 }} /> : (<>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                  <tm.Icon size={18} color={tm.color} />
                  <span style={{ fontSize:20, fontWeight:800, color:tm.color }}>{trend}</span>
                  <Badge variant={trend.includes('Bull')?'green':trend.includes('Bear')?'red':'gray'}>
                    {intel?.trendScore != null ? (intel.trendScore > 0 ? '+' : '') + intel.trendScore : '—'}
                  </Badge>
                </div>
                <TrendBar score={intel?.trendScore ?? 0} />
                <div style={{ fontSize:11, color:'#64748B', marginTop:4 }}>
                  Regime: {intel?.regime ?? '—'}
                </div>
              </>)}
            </div>

            {/* Breadth */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Market Breadth</div>
              {loading ? <div className="skeleton" style={{ height:60 }} /> : (<>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
                  <span style={{ color:'#16A34A', fontWeight:700 }}>▲ {intel?.breadth?.advancing ?? 0}</span>
                  <div style={{ flex:1, height:6, background:'#E2E8F0', borderRadius:99, overflow:'hidden' }}>
                    <div style={{ height:'100%', borderRadius:99, background:'linear-gradient(to right,#16A34A,#DC2626)', width:`${(intel?.breadth?.ratio ?? 0.5)*100}%` }} />
                  </div>
                  <span style={{ color:'#DC2626', fontWeight:700 }}>▼ {intel?.breadth?.declining ?? 0}</span>
                </div>
                <div style={{ fontSize:11, color:'#94A3B8', marginTop:4, textAlign:'center' }}>
                  {intel?.breadth?.unchanged ?? 0} unchanged
                  {intel?.breadth?.ratio != null && ` · ${(intel.breadth.ratio*100).toFixed(0)}% advancing`}
                </div>
              </>)}
            </div>

            {/* Volatility */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Volatility</div>
              {loading ? <div className="skeleton" style={{ height:60 }} /> : (<>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, marginTop:6 }}>
                  <span style={{ fontSize:20, fontWeight:700 }}>{intel?.volatility?.volatility_label ?? '—'}</span>
                  {intel?.volatility?.nifty_vix != null && (
                    <span style={{ fontSize:12, color:'#64748B' }}>VIX {intel.volatility.nifty_vix.toFixed(1)}</span>
                  )}
                </div>
                <div style={{ fontSize:11, color:'#64748B', marginTop:4 }}>
                  Avg range {intel?.volatility?.avg_range_pct?.toFixed(2) ?? '—'}%
                </div>
              </>)}
            </div>

            {/* FII / DII */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Institutional Flow</div>
              {loading ? <div className="skeleton" style={{ height:60 }} /> : (
                intel?.fiiDii?.length ? (<>
                  <div style={{ fontSize:13, fontWeight:700, color: intel.fiiDii[0].fii_net > 0 ? '#16A34A' : '#DC2626', marginTop:6 }}>
                    {intel.fiiDii[0].fii_label || `FII ${intel.fiiDii[0].fii_net > 0 ? '+' : ''}${fmt.number(intel.fiiDii[0].fii_net)} Cr`}
                  </div>
                  <div style={{ fontSize:12, color: '#64748B', marginTop:3 }}>
                    {intel.fiiDii[0].dii_label || `DII ${intel.fiiDii[0].dii_net > 0 ? '+' : ''}${fmt.number(intel.fiiDii[0].dii_net)} Cr`}
                  </div>
                </>) : <div style={{ color:'#94A3B8', fontSize:12, marginTop:8 }}>FII/DII data unavailable</div>
              )}
            </div>
          </div>

          {/* Sector chips */}
          <div className={styles.sectorGrid}>
            {(intel?.sectorStrength ?? []).map(s => (
              <div key={s.sector} className={styles.sectorChip}
                style={{ background: s.change_percent > 0 ? '#F0FDF4' : s.change_percent < 0 ? '#FFF1F2' : '#F8FAFC',
                         borderColor: s.change_percent > 0 ? '#BBF7D0' : s.change_percent < 0 ? '#FECACA' : '#E2E8F0' }}>
                <div className="sc-name" style={{ fontSize:10, color:'#64748B' }}>{s.sector}</div>
                <div style={{ fontSize:13, fontWeight:700, color: s.change_percent > 0 ? '#15803D' : s.change_percent < 0 ? '#DC2626' : '#64748B' }}>
                  {s.change_percent > 0 ? '+' : ''}{s.change_percent.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>

          {/* Gainers / Losers */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:4 }}>
            {(['topGainers','topLosers'] as const).map(key => (
              <Card key={key}>
                <div style={{ padding:'12px 16px', borderBottom:'1px solid #F1F5F9', fontWeight:700, fontSize:13 }}>
                  {key === 'topGainers' ? 'Top Gainers' : 'Top Losers'}
                </div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ background:'#F8FAFC' }}>
                      <th style={{ padding:'6px 12px', textAlign:'left', fontSize:10, color:'#94A3B8', fontWeight:700 }}>SYMBOL</th>
                      <th style={{ padding:'6px 12px', textAlign:'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>LTP</th>
                      <th style={{ padding:'6px 12px', textAlign:'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>CHG%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(intel?.[key] ?? []).slice(0,5).map(m => (
                      <tr key={m.symbol} style={{ borderTop:'1px solid #F8FAFC' }}>
                        <td style={{ padding:'7px 12px', fontWeight:600, fontSize:12 }}>{m.symbol}</td>
                        <td style={{ padding:'7px 12px', textAlign:'right', fontSize:12, fontVariantNumeric:'tabular-nums' }}>{fmt.currency(m.ltp)}</td>
                        <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:700, fontSize:12, color: m.change_percent >= 0 ? '#16A34A' : '#DC2626' }}>
                          {m.change_percent >= 0 ? '+' : ''}{m.change_percent.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
        </section>

        {/* ── SECTION 2: RANKINGS ───────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <TrendingUp size={14} />
            <span>Top Rankings</span>
          </div>
          <Card>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr style={{ background:'#F8FAFC' }}>
                  {['#','SYMBOL','SCORE','LTP','CHANGE','SIGNAL','CONVICTION','CONF'].map(h => (
                    <th key={h} style={{ padding:'8px 12px', textAlign: h==='#'||h==='SYMBOL'?'left':'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankings.map((r, i) => (
                  <tr key={r.symbol} style={{ borderTop:'1px solid #F8FAFC' }}>
                    <td style={{ padding:'8px 12px', color:'#CBD5E1', fontSize:12 }}>{i+1}</td>
                    <td style={{ padding:'8px 12px' }}>
                      <div style={{ fontWeight:700, fontSize:13 }}>{r.symbol}</div>
                      <div style={{ fontSize:10, color:'#94A3B8' }}>{r.exchange}</div>
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:700, fontSize:12 }}>{r.score.toFixed(1)}</td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontSize:12, fontVariantNumeric:'tabular-nums' }}>{fmt.currency(r.ltp)}</td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:700, fontSize:12, color: r.pct_change >= 0 ? '#16A34A' : '#DC2626' }}>
                      {r.pct_change >= 0 ? '+' : ''}{r.pct_change.toFixed(2)}%
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}><SignalPill type={r.signal_type} /></td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}><ConvictionBadge band={r.conviction_band} /></td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}><ConfBar val={r.confidence_score ?? r.confidence} /></td>
                  </tr>
                ))}
                {!rankings.length && !loading && (
                  <tr><td colSpan={8} style={{ padding:24, textAlign:'center', color:'#94A3B8', fontSize:12 }}>
                    No ranked instruments. Run Admin → Data → Sync Rankings.
                  </td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </section>

        {/* ── SECTION: CONVICTION DISTRIBUTION ──────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Target size={14} />
            <span>Conviction Distribution</span>
          </div>
          <ConvictionDistribution
            signals={[
              ...rankings.map(r => ({
                conviction_band: r.conviction_band,
                confidence_score: r.confidence_score ?? r.confidence,
              })),
              ...opps.map(o => ({
                conviction_band: o.conviction_band,
                confidence_score: o.confidence,
              })),
            ]}
            loading={loading}
            totalScanned={intel ? 50 : undefined}
          />
        </section>

        {/* ── SECTION 3: TOP OPPORTUNITIES ─────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Zap size={14} />
            <span>Top Opportunities</span>
          </div>
          <div className={styles.grid3}>
            {opps.map(o => {
              const isBuy = o.direction === 'BUY';
              const accentColor = isBuy ? '#15803D' : '#DC2626';
              const bg = isBuy ? '#F0FDF4' : '#FFF1F2';
              return (
                <div key={o.tradingsymbol} className={styles.oppCard} style={{ borderLeftColor: accentColor }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                    <div>
                      <div style={{ fontWeight:800, fontSize:16 }}>{o.tradingsymbol}</div>
                      <div style={{ fontSize:10, color:'#94A3B8' }}>{o.exchange}
                        {o.scenario_tag && <span style={{ marginLeft:5, color:'#3B82F6' }}>· {o.scenario_tag.replace(/_/g,' ')}</span>}
                      </div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:3 }}>
                      <span style={{ background: isBuy?'#DCFCE7':'#FEE2E2', color: accentColor, fontWeight:800, fontSize:11, padding:'3px 10px', borderRadius:99 }}>
                        {o.direction}
                      </span>
                      {o.conviction_band && <ConvictionBadge band={o.conviction_band} />}
                    </div>
                  </div>

                  {/* Confidence bar */}
                  <div style={{ marginBottom:10 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#64748B', marginBottom:3 }}>
                      <span>Confidence</span>
                      <strong style={{ color: o.confidence>=75?'#065F46':o.confidence>=60?'#1D4ED8':'#D97706' }}>
                        {o.confidence}%
                      </strong>
                    </div>
                    <div style={{ height:4, background:'#E2E8F0', borderRadius:99, overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${o.confidence}%`, background: o.confidence>=75?'#15803D':o.confidence>=60?'#1D4ED8':'#D97706', borderRadius:99 }} />
                    </div>
                  </div>

                  {/* Price levels */}
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:8 }}>
                    {[['Entry', o.entry_price,'#1E3A5F'],['SL',o.stop_loss,'#DC2626'],['Target',o.target1,'#15803D']].map(([l,v,c]) => (
                      <div key={String(l)} style={{ background:'#F8FAFC', borderRadius:7, padding:'6px 8px', textAlign:'center' }}>
                        <div style={{ fontSize:9, color:'#94A3B8', fontWeight:700, marginBottom:2 }}>{l}</div>
                        <div style={{ fontSize:12, fontWeight:700, color: c as string }}>{v ? fmt.currency(v as number) : '—'}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#64748B' }}>
                    <span>Score: <strong style={{ color:'#1E3A5F' }}>{o.opportunity_score}</strong></span>
                    {o.risk_reward && <span>R:R <strong>{o.risk_reward}</strong></span>}
                  </div>
                </div>
              );
            })}
            {!opps.length && !loading && (
              <div style={{ gridColumn:'1/-1', textAlign:'center', padding:32, color:'#94A3B8' }}>
                No approved signals. Run Admin → Recompute Signals.
              </div>
            )}
          </div>
        </section>

      </div>
    </AppShell>
  );
}
