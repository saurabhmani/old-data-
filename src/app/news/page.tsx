'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { newsApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Newspaper } from 'lucide-react';
import type { NewsArticle, NewsCategory } from '@/types';

export default function NewsPage() {
  const [articles,    setArticles]    = useState<NewsArticle[]>([]);
  const [categories,  setCategories]  = useState<NewsCategory[]>([]);
  const [activeCat,   setActiveCat]   = useState<number | null>(null);
  const [loading,     setLoading]     = useState(true);

  async function load(catId: number | null = null) {
    setLoading(true);
    try {
      const params = catId ? `category_id=${catId}` : '';
      const [nRes, cRes] = await Promise.all([newsApi.list(params), newsApi.categories()]) as any[];
      setArticles(nRes.news || []);
      setCategories(cRes.categories || []);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const filter = (id: number | null) => { setActiveCat(id); load(id); };

  return (
    <AppShell title="News & Insights">
      <div className="page">
        <div className="page__header"><div><h1>News & Insights</h1><p>Latest market updates and analysis</p></div></div>

        {/* Category filters */}
        {categories.length > 0 && (
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:20 }}>
            <button className={`btn btn--sm ${!activeCat ? 'btn--primary' : 'btn--secondary'}`} onClick={() => filter(null)}>All</button>
            {categories.map(c => (
              <button key={c.id} className={`btn btn--sm ${activeCat===c.id ? 'btn--primary' : 'btn--secondary'}`} onClick={() => filter(c.id)}>{c.name}</button>
            ))}
          </div>
        )}

        {loading ? <Loading /> : articles.length === 0 ? (
          <Empty icon={Newspaper} title="No articles yet" description="Admin can publish articles from the News Management panel." />
        ) : (
          <div className="grid-3">
            {articles.map(a => (
              <a key={a.id} href={`/news/${a.id}`} style={{ textDecoration:'none' }}>
                <Card className="card--hover" style={{ height:'100%', display:'flex', flexDirection:'column' } as any}>
                  {a.thumbnail && (
                    <img src={a.thumbnail} alt={a.title} style={{ width:'calc(100% + 40px)', margin:'-20px -20px 16px', height:160, objectFit:'cover', borderRadius:'12px 12px 0 0' }} />
                  )}
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8 }}>
                    {a.is_featured && <Badge variant="orange">Featured</Badge>}
                    {a.category_name && <Badge>{a.category_name}</Badge>}
                  </div>
                  <h3 style={{ fontSize:15, fontWeight:600, color:'#1E3A5F', marginBottom:8, lineHeight:1.4, flex:1 }}>{a.title}</h3>
                  {a.summary && <p style={{ fontSize:12, color:'#64748B', lineHeight:1.5, marginBottom:10 }}>{fmt.truncate(a.summary, 100)}</p>}
                  <div style={{ fontSize:11, color:'#94A3B8' }}>{fmt.date(a.published_at)}</div>
                </Card>
              </a>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
