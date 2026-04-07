'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Loading } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, BarChart2, Activity, ArrowUpRight,
  ArrowDownRight, Minus, AlertTriangle, Shield, Zap, Globe,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────
interface IndexBar { name: string; last: number; percentChange: number; }
interface SectorItem { sector: string; change_percent: number; trend: 'up' | 'down' | 'flat'; }
interface MoverItem  { symbol: string; name?: string; ltp: number; change_percent: number; change_abs?: number; volume?: number; }
interface FiiRow     { date: string; fii_net: number; dii_net: number; fii_buy?: number; fii_sell?: number; dii_buy?: number; dii_sell?: number; }

// ── Small helpers ─────────────────────────────────────────────────
const IDX_PRIORITY = ['NIFTY 50','NIFTY BANK','NIFTY IT','NIFTY PHARMA','NIFTY MIDCAP 100','India VIX'];

function SentimentDot({ val }: { val: string }) {
  const map: Record<string, string> = {
    Bullish: '#16A34A', Bearish: '#DC2626', Mixed: '#D97706', Neutral: '#64748B',
  };
  return <span style={{ display:'inline-block', width:10, height:10, borderRadius:'50%', background: map[val] ?? '#64748B', marginRight:6, verticalAlign:'middle' }} />;
}

function TrendIcon({ pct }: { pct: number }) {
  if (pct > 0.15) return <ArrowUpRight size={14} color="#16A34A" />;
  if (pct < -0.15) return <ArrowDownRight size={14} color="#DC2626" />;
  return <Minus size={14} color="#94A3B8" />;
}

function PctBadge({ val }: { val: number }) {
  const col = val > 0 ? '#16A34A' : val < 0 ? '#DC2626' : '#94A3B8';
  const bg  = val > 0 ? '#F0FDF4' : val < 0 ? '#FEF2F2' : '#F8FAFC';
  return (
    <span style={{ fontSize:12, fontWeight:700, color:col, background:bg, padding:'2px 7px', borderRadius:20 }}>
      {val > 0 ? '+' : ''}{val.toFixed(2)}%
    </span>
  );
}

function StanceCard({ stance }: { stance: any }) {
  if (!stance) return null;
  const map: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
    aggressive:          { color:'#16A34A', bg:'#F0FDF4', icon: <TrendingUp size={16}/> },
    selective:           { color:'#D97706', bg:'#FFFBEB', icon: <Zap size={16}/> },
    defensive:           { color:'#DC2626', bg:'#FEF2F2', icon: <Shield size={16}/> },
    capital_preservation:{ color:'#7C3AED', bg:'#F5F3FF', icon: <Shield size={16}/> },
  };
  const style = map[stance.stance] ?? map.selective;
  return (
    <div style={{ background:style.bg, border:`1.5px solid ${style.color}20`, borderRadius:10, padding:'14px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
        <span style={{ color:style.color }}>{style.icon}</span>
        <strong style={{ fontSize:15, color:style.color, textTransform:'capitalize' }}>
          {stance.stance?.replace(/_/g,' ')} Mode
        </strong>
        <span style={{ marginLeft:'auto', fontSize:11, color:'#94A3B8' }}>{stance.confidence}% confidence</span>
      </div>
      {stance.guidance && <p style={{ fontSize:13, color:'#334155', margin:0, lineHeight:1.5 }}>{stance.guidance}</p>}
      {stance.rationale && <p style={{ fontSize:12, color:'#64748B', marginTop:6, marginBottom:0, lineHeight:1.5 }}>{stance.rationale}</p>}
      {stance.config && (
        <div style={{ display:'flex', gap:16, marginTop:10, flexWrap:'wrap' }}>
          {[
            { label:'Min Confidence', val:`${stance.config.min_confidence}%` },
            { label:'Min R:R', val:`1:${stance.config.min_rr}` },
            { label:'Max Positions', val:stance.config.max_positions },
            { label:'Risk ×', val:stance.config.risk_multiplier },
          ].map(({ label, val }) => (
            <div key={label} style={{ textAlign:'center' }}>
              <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600 }}>{label}</div>
              <div style={{ fontSize:14, fontWeight:700, color:style.color }}>{val}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
export default function IntelligencePage() {
  const [indices,     setIndices]     = useState<IndexBar[]>([]);
  const [explanation, setExplanation] = useState<any>(null);
  const [intel,       setIntel]       = useState<any>(null);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [idxRes, explRes, intelRes] = await Promise.allSettled([
          fetch('/api/nse?resource=indices').then(r => r.json()),
          fetch('/api/explanations').then(r => r.json()),
          fetch('/api/market-intelligence').then(r => r.json()),
        ]);

        if (idxRes.status   === 'fulfilled') setIndices(idxRes.value.indices ?? []);
        if (explRes.status  === 'fulfilled') setExplanation(explRes.value.explanation ?? null);
        if (intelRes.status === 'fulfilled') setIntel(intelRes.value ?? null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const ex      = explanation;
  const breadth = intel?.breadth ?? null;
  const sectors: SectorItem[] = intel?.sectorStrength ?? [];
  const gainers: MoverItem[]  = (intel?.topGainers ?? []).slice(0, 8).map((g: any) => ({
    symbol: g.symbol ?? g.tradingsymbol ?? '',
    ltp: g.ltp ?? g.lastPrice ?? 0,
    change_percent: g.change_percent ?? g.pChange ?? 0,
    volume: g.volume ?? g.totalTradedVolume ?? 0,
  }));
  const losers: MoverItem[] = (intel?.topLosers ?? []).slice(0, 8).map((g: any) => ({
    symbol: g.symbol ?? g.tradingsymbol ?? '',
    ltp: g.ltp ?? g.lastPrice ?? 0,
    change_percent: g.change_percent ?? g.pChange ?? 0,
    volume: g.volume ?? g.totalTradedVolume ?? 0,
  }));
  const fiiRows: FiiRow[] = intel?.fiiDii ?? [];
  const scenario   = intel?.scenario ?? null;
  const stance     = intel?.market_stance ?? null;
  const vol        = intel?.volatility ?? null;

  // prioritised index bar
  const barIndices = [
    ...IDX_PRIORITY.flatMap(n => indices.filter(i => i.name === n)),
    ...indices.filter(i => !IDX_PRIORITY.includes(i.name)),
  ].slice(0, 8);

  const advTotal = (breadth?.advancing ?? 0) + (breadth?.declining ?? 0);
  const advPct   = advTotal > 0 ? Math.round((breadth.advancing / advTotal) * 100) : 0;

  return (
    <AppShell title="Intelligence Hub">
      <div className="page">
        {/* ── Header ── */}
        <div className="page__header" style={{ marginBottom: 20 }}>
          <div>
            <h1 style={{ display:'flex', alignItems:'center', gap:10 }}>
              <Globe size={22} style={{ color:'#2E75B6' }} /> Intelligence Hub
            </h1>
            <p style={{ color:'#64748B', fontSize:14, marginTop:4 }}>
              Live market intelligence · Sector analysis · FII/DII flows · Market stance
            </p>
          </div>
          {ex?.sentiment && (
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:11, color:'#94A3B8', marginBottom:3 }}>Market Sentiment</div>
              <div style={{ display:'flex', alignItems:'center', gap:6, justifyContent:'flex-end' }}>
                <SentimentDot val={ex.sentiment} />
                <span style={{ fontSize:16, fontWeight:700, color:'#0F172A' }}>{ex.sentiment}</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Index bar ── */}
        {barIndices.length > 0 && (
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:24 }}>
            {barIndices.map((idx) => (
              <div key={idx.name} className="card card--compact"
                style={{ flexShrink:0, minWidth:140, background: idx.name === 'India VIX' ? '#FFFBEB' : '#fff' }}>
                <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600, marginBottom:2 }}>
                  {idx.name.replace('NIFTY ','').replace('India ','')}
                </div>
                <div style={{ fontSize:17, fontWeight:700, color:'#0F172A' }}>
                  {idx.last?.toLocaleString('en-IN')}
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:4, marginTop:2 }}>
                  <TrendIcon pct={idx.percentChange} />
                  <span style={{ fontSize:12, fontWeight:600 }} className={changeClass(idx.percentChange)}>
                    {Math.abs(idx.percentChange).toFixed(2)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {loading ? <Loading text="Loading market intelligence…" /> : (
          <div style={{ display:'grid', gap:20 }}>

            {/* ── Row 1: Market Explanation + Breadth ── */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>

              {/* Market Explanation */}
              <Card title="Market Summary">
                {ex ? (
                  <div>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                      <SentimentDot val={ex.sentiment} />
                      <span style={{ fontSize:13, fontWeight:700, color:'#0F172A' }}>{ex.headline}</span>
                    </div>
                    {ex.fullExplanation && (
                      <p style={{ fontSize:13, color:'#334155', lineHeight:1.7, marginBottom:12 }}>
                        {ex.fullExplanation}
                      </p>
                    )}
                    {ex.drivers?.length > 0 && (
                      <div style={{ marginBottom:10 }}>
                        <div style={{ fontSize:11, fontWeight:700, color:'#16A34A', marginBottom:4 }}>DRIVERS</div>
                        {ex.drivers.map((d: string, i: number) => (
                          <div key={i} style={{ display:'flex', gap:6, fontSize:12, color:'#334155', marginBottom:3 }}>
                            <span style={{ color:'#16A34A', fontWeight:700 }}>↑</span> {d}
                          </div>
                        ))}
                      </div>
                    )}
                    {ex.cautions?.length > 0 && (
                      <div style={{ marginBottom:10 }}>
                        <div style={{ fontSize:11, fontWeight:700, color:'#DC2626', marginBottom:4 }}>CAUTIONS</div>
                        {ex.cautions.map((c: string, i: number) => (
                          <div key={i} style={{ display:'flex', gap:6, fontSize:12, color:'#334155', marginBottom:3 }}>
                            <AlertTriangle size={12} color="#DC2626" style={{ flexShrink:0, marginTop:1 }} /> {c}
                          </div>
                        ))}
                      </div>
                    )}
                    {ex.confidence_note && (
                      <div style={{ fontSize:11, color:'#94A3B8', borderTop:'1px solid #F1F5F9', paddingTop:8, marginTop:4 }}>
                        {ex.confidence_note}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ color:'#94A3B8', fontSize:13 }}>Market data loading…</div>
                )}
              </Card>

              {/* Breadth + Volatility */}
              <div style={{ display:'grid', gap:16 }}>
                {/* Market Breadth */}
                <Card title="Market Breadth">
                  {breadth ? (
                    <div>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                        <div style={{ textAlign:'center' }}>
                          <div style={{ fontSize:24, fontWeight:800, color:'#16A34A' }}>{breadth.advancing}</div>
                          <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600 }}>ADVANCING</div>
                        </div>
                        <div style={{ textAlign:'center' }}>
                          <div style={{ fontSize:24, fontWeight:800, color:'#DC2626' }}>{breadth.declining}</div>
                          <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600 }}>DECLINING</div>
                        </div>
                        {breadth.unchanged > 0 && (
                          <div style={{ textAlign:'center' }}>
                            <div style={{ fontSize:24, fontWeight:800, color:'#94A3B8' }}>{breadth.unchanged}</div>
                            <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600 }}>UNCHANGED</div>
                          </div>
                        )}
                      </div>
                      {/* Breadth bar */}
                      <div style={{ height:8, borderRadius:99, background:'#FEE2E2', overflow:'hidden', marginBottom:8 }}>
                        <div style={{ height:'100%', width:`${advPct}%`, background:'linear-gradient(90deg,#16A34A,#22C55E)', borderRadius:99, transition:'width 0.8s ease' }} />
                      </div>
                      <div style={{ fontSize:12, color:'#64748B', textAlign:'center' }}>
                        {advPct}% stocks advancing
                        {breadth.ratio != null && <span style={{ marginLeft:8, color:'#94A3B8' }}>· A/D ratio: {breadth.ratio}</span>}
                      </div>
                    </div>
                  ) : (
                    <div style={{ color:'#94A3B8', fontSize:13 }}>Breadth data loading…</div>
                  )}
                </Card>

                {/* Volatility */}
                {vol && (
                  <Card title="Volatility">
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                      <div style={{ textAlign:'center', background:'#FFFBEB', borderRadius:8, padding:'10px 8px' }}>
                        <div style={{ fontSize:22, fontWeight:800, color:'#D97706' }}>
                          {vol.nifty_vix != null ? vol.nifty_vix.toFixed(2) : '—'}
                        </div>
                        <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600 }}>INDIA VIX</div>
                      </div>
                      <div style={{ textAlign:'center', background:'#F0F9FF', borderRadius:8, padding:'10px 8px' }}>
                        <div style={{ fontSize:22, fontWeight:800, color:'#0369A1' }}>
                          {vol.volatility_label}
                        </div>
                        <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600 }}>VOL REGIME</div>
                      </div>
                      {vol.high_vol_count > 0 && (
                        <div style={{ gridColumn:'1/-1', fontSize:12, color:'#64748B', textAlign:'center' }}>
                          {vol.high_vol_count} stocks with intraday range &gt; 3%
                        </div>
                      )}
                    </div>
                  </Card>
                )}
              </div>
            </div>

            {/* ── Row 2: Sector Heatmap ── */}
            {sectors.length > 0 && (
              <Card title="Sector Performance">
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10 }}>
                  {sectors.sort((a, b) => b.change_percent - a.change_percent).map((s) => {
                    const col = s.change_percent > 0.2 ? '#16A34A' : s.change_percent < -0.2 ? '#DC2626' : '#94A3B8';
                    const bg  = s.change_percent > 0.2 ? '#F0FDF4' : s.change_percent < -0.2 ? '#FEF2F2' : '#F8FAFC';
                    return (
                      <div key={s.sector} style={{ background:bg, borderRadius:8, padding:'10px 12px', border:`1px solid ${col}20` }}>
                        <div style={{ fontSize:11, color:'#64748B', fontWeight:600, marginBottom:3 }}>{s.sector}</div>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <TrendIcon pct={s.change_percent} />
                          <span style={{ fontSize:16, fontWeight:700, color:col }}>
                            {s.change_percent > 0 ? '+' : ''}{s.change_percent.toFixed(2)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* ── Row 3: Gainers + Losers ── */}
            {(gainers.length > 0 || losers.length > 0) && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>

                {/* Top Gainers */}
                <Card title="Top Gainers" flush>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <thead>
                      <tr style={{ background:'#F8FAFC' }}>
                        <th style={{ padding:'8px 16px', textAlign:'left', fontSize:11, color:'#94A3B8', fontWeight:600 }}>SYMBOL</th>
                        <th style={{ padding:'8px 16px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>LTP</th>
                        <th style={{ padding:'8px 16px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>CHG%</th>
                        <th style={{ padding:'8px 16px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>VOL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gainers.map((g, i) => (
                        <tr key={g.symbol + i} style={{ borderTop:'1px solid #F1F5F9' }}>
                          <td style={{ padding:'8px 16px', fontWeight:700, color:'#0F172A' }}>{g.symbol}</td>
                          <td style={{ padding:'8px 16px', textAlign:'right', color:'#0F172A' }}>{fmt.currency(g.ltp)}</td>
                          <td style={{ padding:'8px 16px', textAlign:'right' }}>
                            <PctBadge val={g.change_percent} />
                          </td>
                          <td style={{ padding:'8px 16px', textAlign:'right', color:'#64748B', fontSize:12 }}>
                            {g.volume ? fmt.volume(g.volume) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {gainers.length === 0 && (
                    <div style={{ padding:16, color:'#94A3B8', fontSize:13, textAlign:'center' }}>No data available</div>
                  )}
                </Card>

                {/* Top Losers */}
                <Card title="Top Losers" flush>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <thead>
                      <tr style={{ background:'#F8FAFC' }}>
                        <th style={{ padding:'8px 16px', textAlign:'left', fontSize:11, color:'#94A3B8', fontWeight:600 }}>SYMBOL</th>
                        <th style={{ padding:'8px 16px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>LTP</th>
                        <th style={{ padding:'8px 16px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>CHG%</th>
                        <th style={{ padding:'8px 16px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>VOL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {losers.map((g, i) => (
                        <tr key={g.symbol + i} style={{ borderTop:'1px solid #F1F5F9' }}>
                          <td style={{ padding:'8px 16px', fontWeight:700, color:'#0F172A' }}>{g.symbol}</td>
                          <td style={{ padding:'8px 16px', textAlign:'right', color:'#0F172A' }}>{fmt.currency(g.ltp)}</td>
                          <td style={{ padding:'8px 16px', textAlign:'right' }}>
                            <PctBadge val={g.change_percent} />
                          </td>
                          <td style={{ padding:'8px 16px', textAlign:'right', color:'#64748B', fontSize:12 }}>
                            {g.volume ? fmt.volume(g.volume) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {losers.length === 0 && (
                    <div style={{ padding:16, color:'#94A3B8', fontSize:13, textAlign:'center' }}>No data available</div>
                  )}
                </Card>
              </div>
            )}

            {/* ── Row 4: FII/DII + Scenario + Stance ── */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>

              {/* FII/DII Flows */}
              <Card title="FII / DII Institutional Flows">
                {fiiRows.length > 0 ? (
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <thead>
                      <tr style={{ background:'#F8FAFC' }}>
                        <th style={{ padding:'6px 12px', textAlign:'left', fontSize:11, color:'#94A3B8', fontWeight:600 }}>DATE</th>
                        <th style={{ padding:'6px 12px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>FII NET</th>
                        <th style={{ padding:'6px 12px', textAlign:'right', fontSize:11, color:'#94A3B8', fontWeight:600 }}>DII NET</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fiiRows.slice(0, 5).map((r, i) => (
                        <tr key={i} style={{ borderTop:'1px solid #F1F5F9' }}>
                          <td style={{ padding:'6px 12px', color:'#64748B', fontSize:12 }}>{r.date}</td>
                          <td style={{ padding:'6px 12px', textAlign:'right', fontWeight:700, color: r.fii_net >= 0 ? '#16A34A' : '#DC2626' }}>
                            {r.fii_net >= 0 ? '+' : ''}₹{Math.abs(r.fii_net).toFixed(0)} Cr
                          </td>
                          <td style={{ padding:'6px 12px', textAlign:'right', fontWeight:700, color: r.dii_net >= 0 ? '#16A34A' : '#DC2626' }}>
                            {r.dii_net >= 0 ? '+' : ''}₹{Math.abs(r.dii_net).toFixed(0)} Cr
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ color:'#94A3B8', fontSize:13, textAlign:'center', padding:'16px 0' }}>
                    FII/DII data not yet available for today
                  </div>
                )}
              </Card>

              {/* Scenario + Stance */}
              <Card title="Market Scenario & Stance">
                {scenario ? (
                  <div>
                    <div style={{ background:'#F8FAFC', borderRadius:8, padding:'10px 14px', marginBottom:12 }}>
                      <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600, marginBottom:4 }}>SCENARIO</div>
                      <div style={{ fontSize:14, fontWeight:700, color:'#0F172A', marginBottom:4 }}>
                        {scenario.tag?.replace(/_/g,' ')}
                      </div>
                      <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                        <span style={{ fontSize:11, background:'#EFF6FF', color:'#1D4ED8', padding:'2px 8px', borderRadius:12, fontWeight:600 }}>
                          {scenario.direction_bias?.toUpperCase()}
                        </span>
                        <span style={{ fontSize:11, background:'#F0FDF4', color:'#166534', padding:'2px 8px', borderRadius:12, fontWeight:600 }}>
                          {scenario.confidence}% conf
                        </span>
                        {scenario.volatility_mode && (
                          <span style={{ fontSize:11, background:'#FFFBEB', color:'#92400E', padding:'2px 8px', borderRadius:12, fontWeight:600 }}>
                            {scenario.volatility_mode}
                          </span>
                        )}
                      </div>
                      {scenario.allowed_strategies?.length > 0 && (
                        <div style={{ marginTop:8, fontSize:12, color:'#64748B' }}>
                          <strong>Allowed:</strong> {scenario.allowed_strategies.join(', ')}
                        </div>
                      )}
                    </div>
                    {stance && <StanceCard stance={stance} />}
                  </div>
                ) : (
                  <div style={{ color:'#94A3B8', fontSize:13, textAlign:'center', padding:'16px 0' }}>
                    Scenario data loading…
                  </div>
                )}
              </Card>
            </div>

            {/* ── Row 5: Regime + Risk posture ── */}
            {(intel?.regime || ex?.risk_posture) && (
              <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', gap:16, alignItems:'center',
                background:'#F8FAFC', borderRadius:10, padding:'14px 20px', border:'1px solid #E2E8F0' }}>
                {intel?.regime && (
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <Activity size={18} color="#2E75B6" />
                    <div>
                      <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600 }}>MARKET REGIME</div>
                      <div style={{ fontSize:16, fontWeight:800, color:'#0F172A' }}>{intel.regime}</div>
                    </div>
                  </div>
                )}
                {ex?.risk_posture && (
                  <div style={{ borderLeft:'2px solid #E2E8F0', paddingLeft:16, marginLeft:4 }}>
                    <div style={{ fontSize:11, color:'#94A3B8', fontWeight:600, marginBottom:2 }}>RISK POSTURE</div>
                    <div style={{ fontSize:13, fontWeight:600, color:'#334155' }}>{ex.risk_posture}</div>
                  </div>
                )}
              </div>
            )}

          </div>
        )}
      </div>
    </AppShell>
  );
}
