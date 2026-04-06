'use client';
import { useParams }    from 'next/navigation';
import AppShell         from '@/components/layout/AppShell';
import StockDetail      from '@/components/stock/StockDetail';
import { watchlistApi } from '@/lib/apiClient';
import { useState }     from 'react';
import { Star }         from 'lucide-react';

export default function StockPage() {
  const { symbol }       = useParams<{ symbol: string }>();
  const sym              = decodeURIComponent(symbol).toUpperCase();
  const [added, setAdded]= useState(false);

  const addWatch = async () => {
    try {
      await watchlistApi.add({ instrument_key: `NSE_EQ|${sym}` });
      setAdded(true);
    } catch { /* silent */ }
  };

  return (
    <AppShell title={sym}>
      <div className="page">
        {/* Watchlist button — floats top-right on all tabs */}
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:0 }}>
          <button
            className={`btn btn--${added?'success':'secondary'} btn--sm`}
            onClick={addWatch}
            disabled={added}
          >
            <Star size={13} fill={added?'currentColor':'none'} />
            {added ? 'In Watchlist' : 'Add to Watchlist'}
          </button>
        </div>

        <StockDetail symbol={sym} />
      </div>
    </AppShell>
  );
}
