'use client';
import { useState, useCallback, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, Empty, Loading } from '@/components/ui';
import { marketApi, watchlistApi } from '@/lib/apiClient';
import { fmt, changeClass, debounce } from '@/lib/utils';
import { Search, Star, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { Instrument, Tick } from '@/types';

export default function MarketPage() {
  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState<Instrument[]>([]);
  const [quotes,   setQuotes]   = useState<Record<string, Tick>>({});
  const [loading,  setLoading]  = useState(false);
  const [added,    setAdded]    = useState<Set<string>>(new Set());

  const doSearch = useCallback(debounce(async (q: string) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const data = await marketApi.search(q) as any;
      const rows: Instrument[] = data.results || [];
      setResults(rows);
      const keys = rows.slice(0, 20).map(r => r.instrument_key).filter(Boolean);
      if (keys.length) {
        const qData = await marketApi.ltp(keys) as any;
        setQuotes(qData.data || {});
      }
    } finally { setLoading(false); }
  }, 350), []);

  const addWatch = async (key: string) => {
    try { await watchlistApi.add({ instrument_key: key }); setAdded(s => new Set(s).add(key)); }
    catch (e: any) { alert(e.data?.error || 'Failed to add'); }
  };

  return (
    <AppShell title="Market Search">
      <div className="page">
        <div className="page__header">
          <div><h1>Market Search</h1><p>Search across NSE, BSE and F&O instruments</p></div>
        </div>

        <Card style={{ marginBottom: 20 }}>
          <div style={{ position: 'relative' }}>
            <Search size={16} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'#94A3B8' }} />
            <input
              className="input" style={{ paddingLeft: 40, height: 48, fontSize: 15 }}
              placeholder="Search by symbol or company name…  e.g. RELIANCE, Infosys, NIFTY"
              value={query}
              onChange={e => { setQuery(e.target.value); doSearch(e.target.value); }}
              autoFocus
            />
          </div>
        </Card>

        {loading && <Loading text="Searching…" />}

        {!loading && results.length > 0 && (
          <Card flush>
            <div style={{ padding:'10px 20px', borderBottom:'1px solid #E2E8F0', fontSize:13, color:'#64748B', fontWeight:500 }}>
              {results.length} results for "{query}"
            </div>
            <div style={{ overflowX:'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th><th>Name</th><th>Exchange</th><th>Type</th>
                    <th style={{ textAlign:'right' }}>LTP</th>
                    <th style={{ textAlign:'right' }}>Change %</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    const q = quotes[r.instrument_key];
                    const isAdded = added.has(r.instrument_key);
                    return (
                      <tr key={i}>
                        <td><strong style={{ color:'#1E3A5F' }}>{r.tradingsymbol}</strong></td>
                        <td style={{ color:'#64748B', fontSize:12 }}>{fmt.truncate(r.name, 28)}</td>
                        <td><Badge>{r.exchange}</Badge></td>
                        <td><Badge variant="gray">{r.instrument_type}</Badge></td>
                        <td style={{ textAlign:'right', fontWeight:600 }}>{q?.ltp ? fmt.currency(q.ltp) : '—'}</td>
                        <td style={{ textAlign:'right' }} className={changeClass(q?.pct_change)}>{fmt.percent(q?.pct_change)}</td>
                        <td>
                          <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                            <button
                              className="btn btn--ghost btn--sm"
                              onClick={() => addWatch(r.instrument_key)}
                              disabled={isAdded}
                              title={isAdded ? 'Added' : 'Add to watchlist'}
                              style={isAdded ? { color:'#16A34A' } : {}}
                            >
                              <Star size={13} fill={isAdded ? '#16A34A' : 'none'} />
                            </button>
                            <Link href={`/market/${encodeURIComponent(r.instrument_key)}`} className="btn btn--ghost btn--sm">
                              <ChevronRight size={13} />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {!loading && !results.length && (
          <Empty
            icon={Search}
            title={query.length >= 2 ? 'No results found' : 'Search for any stock'}
            description={query.length >= 2 ? 'Try a different symbol or company name' : 'Type a symbol like RELIANCE or a company name'}
          />
        )}
      </div>
    </AppShell>
  );
}
