'use client';
import { useEffect, useState, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import { Zap, Search, TrendingUp, TrendingDown, Activity, Target, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import '@/styles/components/_intelligence.scss';

// ── Signal classifier ─────────────────────────────────────────────
interface LiveSignal {
  symbol:      string;
  ltp:         number;
  change_pct:  number;
  volume:      number;
  week52_high: number;
  week52_low:  number;
  direction:   'BUY' | 'SELL' | 'WATCH';
  strategy:    string;
  confidence:  number;
  reasons:     string[];
  entry:       number;
  stop:        number;
  target:      number;
  rr:          string;
}

function classifySignal(g: any, side: 'gainers' | 'losers'): LiveSignal {
  const ltp  = Number(g.ltp ?? g.lastPrice ?? g.ltP ?? 0);
  const pct  = Number(g.pChange ?? g.perChange ?? 0);
  const vol  = Number(g.tradedQuantity ?? g.totalTradedVolume ?? g.volume ?? 0);
  const y52h = Number(g.yearHigh  ?? g.week52High ?? 0);
  const y52l = Number(g.yearLow   ?? g.week52Low  ?? 0);
  const sym  = String(g.symbol ?? '').toUpperCase();

  const w52pos   = y52h > y52l ? ((ltp - y52l) / (y52h - y52l)) * 100 : 50;
  const atrProxy = ltp * 0.015;

  const reasons: string[] = [];
  let strategy  = 'MOMENTUM';
  let confidence = 55;

  if (side === 'gainers') {
    if (pct >= 5)       { strategy = 'MOMENTUM_EXPANSION'; confidence = 72; reasons.push(`Strong up move: +${pct.toFixed(2)}%`); }
    else if (pct >= 3)  { strategy = 'MOMENTUM_BUY';       confidence = 65; reasons.push(`Solid momentum: +${pct.toFixed(2)}%`); }
    else                { strategy = 'TREND_CONTINUATION'; confidence = 58; reasons.push(`Positive move: +${pct.toFixed(2)}%`); }

    if      (w52pos >= 90) { strategy = 'BREAKOUT'; confidence = Math.min(82, confidence + 10); reasons.push(`Near 52W high (${w52pos.toFixed(0)}th pct) — breakout zone`); }
    else if (w52pos >= 75) { reasons.push(`Upper quartile of 52W range — bullish`); confidence += 5; }
    else if (w52pos <= 40) { reasons.push(`Rising from lower half — accumulation`); }

    if      (vol >= 1_000_000) { reasons.push(`High volume: ${fmt.volume(vol)} — institutional`); confidence += 5; }
    else if (vol >= 100_000)   { reasons.push(`Above-avg volume confirms move`); confidence += 2; }
    else if (vol < 50_000)     { reasons.push(`Light volume — may lack conviction`); confidence -= 5; }

    const slDist = atrProxy * 1.5;
    const t1Dist = slDist * 2.0;
    return {
      symbol: sym, ltp, change_pct: pct, volume: vol, week52_high: y52h, week52_low: y52l,
      direction: 'BUY', strategy, confidence: Math.min(85, Math.max(50, confidence)),
      reasons: reasons.slice(0, 3),
      entry:  parseFloat(ltp.toFixed(2)),
      stop:   parseFloat((ltp - slDist).toFixed(2)),
      target: parseFloat((ltp + t1Dist).toFixed(2)),
      rr: '1:2.0',
    };
  } else {
    if      (Math.abs(pct) >= 5) { strategy = 'MOMENTUM_SELL'; confidence = 70; reasons.push(`Sharp decline: ${pct.toFixed(2)}%`); }
    else if (Math.abs(pct) >= 3) { strategy = 'DOWNTREND';     confidence = 63; reasons.push(`Down move: ${pct.toFixed(2)}%`); }
    else                         { strategy = 'WEAKNESS';      confidence = 56; reasons.push(`Negative: ${pct.toFixed(2)}%`); }

    if      (w52pos <= 15) { strategy = 'OVERSOLD_WATCH'; confidence = Math.min(78, confidence + 8); reasons.push(`Near 52W low (${w52pos.toFixed(0)}th pct) — watch reversal`); }
    else if (w52pos <= 30) { reasons.push(`Lower range — selling pressure`); }
    else if (w52pos >= 70) { reasons.push(`Falling from highs — distribution`); confidence += 5; }

    if      (vol >= 1_000_000) { reasons.push(`Heavy volume confirms selling`); confidence += 5; }
    else if (vol < 50_000)     { reasons.push(`Low volume — may be noise`); confidence -= 5; }

    const slDist = atrProxy * 1.5;
    const t1Dist = slDist * 2.0;
    return {
      symbol: sym, ltp, change_pct: pct, volume: vol, week52_high: y52h, week52_low: y52l,
      direction: strategy === 'OVERSOLD_WATCH' ? 'WATCH' : 'SELL',
      strategy, confidence: Math.min(80, Math.max(50, confidence)),
      reasons: reasons.slice(0, 3),
      entry:  parseFloat(ltp.toFixed(2)),
      stop:   parseFloat((ltp + slDist).toFixed(2)),
      target: parseFloat((ltp - t1Dist).toFixed(2)),
      rr: '1:2.0',
    };
  }
}

// ── UI helpers ────────────────────────────────────────────────────
const DIR_STYLE: Record<string, { bg: string; color: string }> = {
  BUY:   { bg: '#F0FDF4', color: '#16A34A' },
  SELL:  { bg: '#FEF2F2', color: '#DC2626' },
  WATCH: { bg: '#FFFBEB', color: '#D97706' },
};

function SignalChip({ dir }: { dir: string }) {
  const s = DIR_STYLE[dir] ?? DIR_STYLE.WATCH;
  return (
    <span style={{ fontSize: 11, fontWeight: 800, background: s.bg, color: s.color,
      padding: '3px 10px', borderRadius: 20, letterSpacing: 0.5 }}>{dir}</span>
  );
}

function ConfBar({ value }: { value: number }) {
  const col = value >= 70 ? '#16A34A' : value >= 58 ? '#D97706' : '#DC2626';
  return (
    <div style={{ width: 70 }}>
      <div style={{ height: 5, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value}%`, background: col, borderRadius: 99, transition: 'width 0.5s' }} />
      </div>
      <div style={{ fontSize: 10, color: '#64748B', marginTop: 2, textAlign: 'right' }}>{value}%</div>
    </div>
  );
}

function W52Bar({ pos }: { pos: number }) {
  const col = pos >= 75 ? '#16A34A' : pos <= 25 ? '#DC2626' : '#94A3B8';
  return (
    <div style={{ width: 60 }}>
      <div style={{ height: 4, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pos}%`, background: col, borderRadius: 99 }} />
      </div>
      <div style={{ fontSize: 9, color: '#94A3B8', marginTop: 1 }}>{pos.toFixed(0)}th pct</div>
    </div>
  );
}

// ── Deep search panel ─────────────────────────────────────────────
function SearchResult({ data, symbol }: { data: any; symbol: string }) {
  if (!data) return null;
  const approved = data.approved ?? false;
  const sig = data.signal;

  return (
    <div style={{ marginTop: 16, padding: 16, background: '#F8FAFC', borderRadius: 10, border: '1px solid #E2E8F0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: '#1E3A5F' }}>{symbol}</span>
        {sig && <SignalChip dir={sig.direction} />}
        {sig?.risk && (
          <Badge variant={sig.risk === 'High' ? 'red' : sig.risk === 'Low' ? 'green' : 'orange'}>
            {sig.risk} Risk
          </Badge>
        )}
        {approved
          ? <span style={{ marginLeft: 'auto', fontSize: 12, color: '#16A34A', fontWeight: 700 }}>✓ Signal Approved</span>
          : <span style={{ marginLeft: 'auto', fontSize: 12, color: '#DC2626', fontWeight: 700 }}>✗ Rejected</span>
        }
      </div>

      {approved && sig && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 12 }}>
            {[['Entry', sig.entry_price], ['Stop Loss', sig.stop_loss], ['Target', sig.target1]].map(([l, v]) => (
              <div key={String(l)} style={{ background: '#fff', borderRadius: 8, padding: '10px 14px', border: '1px solid #E2E8F0', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{fmt.currency(v as number)}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12, color: '#64748B', flexWrap: 'wrap' }}>
            {sig.confidence   && <span>Confidence: <strong style={{ color: '#0F172A' }}>{sig.confidence}%</strong></span>}
            {sig.risk_reward  && <span>R:R <strong>1:{sig.risk_reward}</strong></span>}
            {sig.scenario_tag && <span>Scenario: <strong>{sig.scenario_tag?.replace(/_/g, ' ')}</strong></span>}
          </div>
        </>
      )}

      {!approved && data.rejection_reasons?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#DC2626', marginBottom: 6 }}>REJECTION REASONS</div>
          {data.rejection_reasons.map((r: string, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 6, fontSize: 12, color: '#334155', marginBottom: 4 }}>
              <span style={{ color: '#DC2626', fontWeight: 700, flexShrink: 0 }}>✗</span> {r}
            </div>
          ))}
        </div>
      )}

      {(sig?.factor_scores || data.factor_scores) && (() => {
        const fs = sig?.factor_scores ?? data.factor_scores;
        return (
          <div style={{ marginTop: 10, borderTop: '1px solid #E2E8F0', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 6 }}>FACTOR SCORES</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
              {Object.entries(fs).map(([k, v]) => (
                <div key={k} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: '#94A3B8', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase' }}>
                    {k.replace(/_/g, ' ').slice(0, 10)}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700,
                    color: Number(v) >= 65 ? '#16A34A' : Number(v) >= 45 ? '#D97706' : '#DC2626' }}>
                    {Number(v).toFixed(0)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {data.soft_warnings?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#D97706' }}>
          ⚠ {data.soft_warnings.join(' · ')}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
export default function SignalsPage() {
  const [gainers,   setGainers]  = useState<LiveSignal[]>([]);
  const [losers,    setLosers]   = useState<LiveSignal[]>([]);
  const [loading,   setLoading]  = useState(true);
  const [tab,       setTab]      = useState<'BUY' | 'SELL'>('BUY');
  const [query,     setQuery]    = useState('');
  const [srResult,  setSrResult] = useState<any>(null);
  const [srLoading, setSrLoad]   = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      fetch('/api/nse?resource=gainers').then(r => r.json()),
      fetch('/api/nse?resource=losers').then(r => r.json()),
    ]).then(([gRes, lRes]) => {
      if (gRes.status === 'fulfilled') {
        const raw = gRes.value.gainers ?? [];
        setGainers(raw.map((g: any) => classifySignal(g, 'gainers')).filter((s: LiveSignal) => s.symbol));
      }
      if (lRes.status === 'fulfilled') {
        const raw = lRes.value.losers ?? [];
        setLosers(raw.map((g: any) => classifySignal(g, 'losers')).filter((s: LiveSignal) => s.symbol));
      }
    }).finally(() => setLoading(false));
  }, []);

  const handleSearch = (q: string) => {
    setQuery(q);
    clearTimeout(timerRef.current);
    if (q.length < 2) { setSrResult(null); return; }
    timerRef.current = setTimeout(async () => {
      setSrLoad(true);
      try {
        const clean = q.trim().replace(/\s+/g, '').toUpperCase();
        const res = await fetch(`/api/signals?action=instrument&symbol=${encodeURIComponent(clean)}`);
        setSrResult(res.ok ? await res.json() : null);
      } catch { setSrResult(null); }
      finally { setSrLoad(false); }
    }, 600);
  };

  const shown = tab === 'BUY' ? gainers : losers;

  return (
    <AppShell title="Signal Engine">
      <div className="page">
        <div className="page__header" style={{ marginBottom: 20 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Zap size={22} color="#2E75B6" /> Signal Engine
            </h1>
            <p style={{ color: '#64748B', fontSize: 14, marginTop: 4 }}>
              Live momentum · Breakout · Mean-reversion signals from NSE
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ textAlign: 'center', background: '#F0FDF4', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#16A34A' }}>{gainers.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>BUY</div>
            </div>
            <div style={{ textAlign: 'center', background: '#FEF2F2', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#DC2626' }}>{losers.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>SELL/WATCH</div>
            </div>
          </div>
        </div>

        {/* ── Deep signal lookup ── */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
            <Search size={16} color="#94A3B8" style={{ flexShrink: 0 }} />
            <input
              className="input"
              placeholder="Deep analysis: type any NSE symbol (e.g. RELIANCE, TCS, HDFC)…"
              value={query}
              onChange={e => handleSearch(e.target.value)}
              style={{ height: 44 }}
            />
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', paddingLeft: 26 }}>
            Runs full signal engine — factor scoring, confidence, R:R levels, rejection analysis
          </div>
          {srLoading && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Activity size={13} /> Analysing {query.toUpperCase()}…
            </div>
          )}
          {srResult && !srLoading && <SearchResult data={srResult} symbol={query.toUpperCase()} />}
        </Card>

        {/* ── Tab selector ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <button
            className={`btn btn--sm ${tab === 'BUY' ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => setTab('BUY')}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <TrendingUp size={13} /> BUY Signals ({gainers.length})
          </button>
          <button
            className={`btn btn--sm ${tab === 'SELL' ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => setTab('SELL')}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <TrendingDown size={13} /> SELL / WATCH ({losers.length})
          </button>
        </div>

        {/* ── Signal table ── */}
        <Card flush>
          {loading ? (
            <div style={{ padding: 32 }}><Loading text="Fetching live NSE signals…" /></div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8' }}>
              <Zap size={32} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No signals</div>
              <div style={{ fontSize: 13 }}>Markets may be closed or NSE data is unavailable</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    {['#', 'Symbol', 'Signal', 'Strategy', 'Conf', 'LTP', 'Change', 'Entry', 'Stop', 'Target', 'R:R', '52W Pos', 'Volume', ''].map(h => (
                      <th key={h} style={{
                        padding: '9px 12px',
                        textAlign: h === 'LTP' || h === 'Entry' || h === 'Stop' || h === 'Target' ? 'right' : 'left',
                        fontSize: 10, color: '#94A3B8', fontWeight: 700, letterSpacing: 0.3, whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s, i) => {
                    const w52pos = s.week52_high > s.week52_low
                      ? ((s.ltp - s.week52_low) / (s.week52_high - s.week52_low)) * 100 : 50;
                    return (
                      <tr key={s.symbol + i} style={{ borderTop: '1px solid #F1F5F9' }}>
                        <td style={{ padding: '10px 12px', fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>
                          {i + 1}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <Link href={`/market/NSE_EQ|${s.symbol}`}
                            style={{ fontWeight: 800, color: '#1E3A5F', textDecoration: 'none' }}>
                            {s.symbol}
                          </Link>
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <SignalChip dir={s.direction} />
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 11, color: '#64748B', maxWidth: 120 }}>
                          {s.strategy.replace(/_/g, ' ')}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <ConfBar value={s.confidence} />
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#0F172A' }}>
                          {fmt.currency(s.ltp)}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ fontSize: 12, fontWeight: 700 }} className={changeClass(s.change_pct)}>
                            {s.change_pct >= 0 ? '+' : ''}{s.change_pct.toFixed(2)}%
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#0F172A' }}>
                          {fmt.currency(s.entry)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#DC2626' }}>
                          {fmt.currency(s.stop)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16A34A' }}>
                          {fmt.currency(s.target)}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#64748B' }}>{s.rr}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <W52Bar pos={w52pos} />
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#64748B' }}>
                          {fmt.volume(s.volume)}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <Link href={`/market/NSE_EQ|${s.symbol}`}
                            style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#2E75B6', textDecoration: 'none' }}>
                            <Target size={11} /> Chart <ChevronRight size={10} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ── Disclaimer ── */}
        <div style={{ marginTop: 16, fontSize: 11, color: '#94A3B8', textAlign: 'center' }}>
          Signals based on live NSE data (price momentum, volume, 52-week positioning).
          Stop/Target computed using 1.5% ATR proxy. Not investment advice.
        </div>
      </div>
    </AppShell>
  );
}
