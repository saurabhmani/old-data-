'use client';
import { useEffect, useState, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  Zap, Search, TrendingUp, TrendingDown, Activity, Target,
  ChevronRight, RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
  Shield, AlertTriangle,
} from 'lucide-react';
import Link from 'next/link';

// ── Types ─────────────────────────────────────────────────────────
interface SignalRow {
  id:                number;
  tradingsymbol:     string;
  exchange:          string;
  direction:         string;
  timeframe:         string;
  confidence:        number;
  confidence_score:  number;
  conviction_band:   string | null;
  risk_score:        number;
  risk:              string;
  opportunity_score: number;
  entry_price:       number;
  stop_loss:         number;
  target1:           number;
  target2:           number | null;
  risk_reward:       number;
  regime:            string;
  market_stance:     string;
  scenario_tag:      string;
  factor_scores:     Record<string, number> | null;
  ltp:               number | null;
  pct_change:        number | null;
  generated_at:      string;
}

// ── UI helpers ────────────────────────────────────────────────────
const DIR_STYLE: Record<string, { bg: string; color: string }> = {
  BUY:  { bg: '#F0FDF4', color: '#16A34A' },
  SELL: { bg: '#FEF2F2', color: '#DC2626' },
  HOLD: { bg: '#FFFBEB', color: '#D97706' },
};

function SignalChip({ dir }: { dir: string }) {
  const s = DIR_STYLE[dir] ?? DIR_STYLE.HOLD;
  const Icon = dir === 'BUY' ? ArrowUpRight : dir === 'SELL' ? ArrowDownRight : Minus;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 800, background: s.bg, color: s.color,
      padding: '3px 10px', borderRadius: 20 }}>
      <Icon size={12} /> {dir}
    </span>
  );
}

function ConfBar({ value }: { value: number }) {
  const col = value >= 75 ? '#065F46' : value >= 65 ? '#1D4ED8' : value >= 55 ? '#D97706' : '#DC2626';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 50, height: 5, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value}%`, background: col, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: col }}>{value}%</span>
    </div>
  );
}

function ConvictionBadge({ band }: { band: string | null }) {
  if (!band || band === 'reject') return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const map: Record<string, [string, string, string]> = {
    high_conviction: ['#D1FAE5', '#065F46', '●●●●'],
    actionable:      ['#DBEAFE', '#1D4ED8', '●●●○'],
    watchlist:       ['#FEF3C7', '#92400E', '●●○○'],
  };
  const cfg = map[band];
  if (!cfg) return null;
  return <span style={{ background: cfg[0], color: cfg[1], fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99 }}>{cfg[2]} {band.replace(/_/g, ' ')}</span>;
}

function ScenarioTag({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return (
    <span style={{ fontSize: 10, background: '#EFF6FF', color: '#1D4ED8',
      padding: '1px 7px', borderRadius: 99, fontWeight: 600 }}>
      {tag.replace(/_/g, ' ')}
    </span>
  );
}

// ── Deep search result ────────────────────────────────────────────
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
          <Badge variant={sig.risk === 'High' || sig.risk === 'Very High' ? 'red' : sig.risk === 'Low' ? 'green' : 'orange'}>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
            {[['Entry', sig.entry_price], ['Stop Loss', sig.stop_loss], ['Target', sig.target1], ['R:R', `1:${sig.risk_reward}`]].map(([l, v]) => (
              <div key={String(l)} style={{ background: '#fff', borderRadius: 8, padding: '10px 14px', border: '1px solid #E2E8F0', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{typeof v === 'number' ? fmt.currency(v) : v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12, color: '#64748B', flexWrap: 'wrap' }}>
            {sig.confidence != null && <span>Confidence: <strong style={{ color: '#0F172A' }}>{sig.confidence}%</strong></span>}
            {sig.scenario_tag && <span>Strategy: <strong>{sig.scenario_tag.replace(/_/g, ' ')}</strong></span>}
            {sig.regime && <span>Regime: <strong>{sig.regime}</strong></span>}
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
                    {k.replace(/_/g, ' ').slice(0, 12)}
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
  const [signals,  setSignals]  = useState<SignalRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [query,    setQuery]    = useState('');
  const [srResult, setSrResult] = useState<any>(null);
  const [srLoading, setSrLoad]  = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const load = async (spinner = true) => {
    if (spinner) setLoading(true);
    try {
      const res = await fetch('/api/signals?action=all&limit=50');
      const data = await res.json();
      setSignals(data.signals ?? []);
    } catch {}
    finally { if (spinner) setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const runPipeline = async () => {
    setPipelineRunning(true);
    try {
      await fetch('/api/run-signal-engine', { method: 'POST' });
      await load(false);
    } catch {}
    finally { setPipelineRunning(false); }
  };

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

  const buySignals  = signals.filter(s => s.direction === 'BUY');
  const sellSignals = signals.filter(s => s.direction === 'SELL');
  const shown = tab === 'BUY' ? buySignals : tab === 'SELL' ? sellSignals : signals;

  return (
    <AppShell title="Signal Engine">
      <div className="page">
        <div className="page__header" style={{ marginBottom: 20 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Zap size={22} color="#2E75B6" /> Signal Engine
            </h1>
            <p style={{ color: '#64748B', fontSize: 14, marginTop: 4 }}>
              All signals from centralized pipeline — BUY/SELL with full analysis
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ textAlign: 'center', background: '#F0FDF4', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#16A34A' }}>{buySignals.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>BUY</div>
            </div>
            <div style={{ textAlign: 'center', background: '#FEF2F2', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#DC2626' }}>{sellSignals.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>SELL</div>
            </div>
            <button
              className="btn btn--primary btn--sm"
              onClick={runPipeline}
              disabled={pipelineRunning}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <RefreshCw size={13} className={pipelineRunning ? 'spin' : ''} />
              {pipelineRunning ? 'Running…' : 'Run Pipeline'}
            </button>
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
            Runs full signal engine live — factor scoring, confidence, R:R levels, rejection analysis
          </div>
          {srLoading && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Activity size={13} /> Analysing {query.toUpperCase()}…
            </div>
          )}
          {srResult && !srLoading && <SearchResult data={srResult} symbol={query.toUpperCase()} />}
        </Card>

        {/* ── Tab selector ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['ALL', 'BUY', 'SELL'] as const).map(t => (
            <button key={t}
              className={`btn btn--sm ${tab === t ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setTab(t)}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {t === 'BUY' && <TrendingUp size={13} />}
              {t === 'SELL' && <TrendingDown size={13} />}
              {t} ({t === 'ALL' ? signals.length : t === 'BUY' ? buySignals.length : sellSignals.length})
            </button>
          ))}
        </div>

        {/* ── Signal table ── */}
        <Card flush>
          {loading ? (
            <div style={{ padding: 32 }}><Loading text="Loading signals from database…" /></div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8' }}>
              <Zap size={32} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No signals in database</div>
              <div style={{ fontSize: 13, marginBottom: 12 }}>Click "Run Pipeline" to generate fresh signals</div>
              <button className="btn btn--primary btn--sm" onClick={runPipeline} disabled={pipelineRunning}>
                <Zap size={13} /> Generate Signals
              </button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    {['#', 'Symbol', 'Direction', 'Strategy', 'Confidence', 'Entry', 'Stop Loss', 'Target', 'R:R', 'Opp Score', 'Conviction', ''].map(h => (
                      <th key={h} style={{
                        padding: '9px 12px',
                        textAlign: ['Entry', 'Stop Loss', 'Target', 'R:R', 'Opp Score'].includes(h) ? 'right' : 'left',
                        fontSize: 10, color: '#94A3B8', fontWeight: 700, whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s, i) => (
                    <tr key={s.id ?? `${s.tradingsymbol}-${i}`}
                      style={{ borderTop: '1px solid #F1F5F9',
                        background: s.direction === 'BUY' ? '#FAFFFE' : s.direction === 'SELL' ? '#FFFAFA' : '#fff' }}>
                      <td style={{ padding: '10px 12px', fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>{i + 1}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <Link href={`/market/NSE_EQ|${s.tradingsymbol}`}
                          style={{ fontWeight: 800, color: '#1E3A5F', textDecoration: 'none' }}>
                          {s.tradingsymbol}
                        </Link>
                        <div style={{ fontSize: 10, color: '#94A3B8' }}>{s.exchange}</div>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <SignalChip dir={s.direction} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ScenarioTag tag={s.scenario_tag} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ConfBar value={s.confidence_score ?? s.confidence} />
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>
                        {s.entry_price ? fmt.currency(s.entry_price) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>
                        {s.stop_loss ? fmt.currency(s.stop_loss) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#15803D', fontWeight: 600 }}>
                        {s.target1 ? fmt.currency(s.target1) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600 }}>
                        {s.risk_reward ? `1:${s.risk_reward}` : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        <span style={{ fontWeight: 700, fontSize: 13,
                          color: s.opportunity_score >= 80 ? '#065F46' : s.opportunity_score >= 60 ? '#1D4ED8' : '#D97706' }}>
                          {s.opportunity_score}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ConvictionBadge band={s.conviction_band} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <Link href={`/market/NSE_EQ|${s.tradingsymbol}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#2E75B6', textDecoration: 'none' }}>
                          <Target size={11} /> Chart <ChevronRight size={10} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div style={{ marginTop: 16, fontSize: 11, color: '#94A3B8', textAlign: 'center' }}>
          Signals generated by centralized pipeline. Run Pipeline to refresh.
          Not investment advice.
        </div>
      </div>
    </AppShell>
  );
}
