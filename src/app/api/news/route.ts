import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try { await requireSession(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  const { searchParams } = req.nextUrl;
  const catId   = searchParams.get('category_id');
  const featured = searchParams.get('featured');
  const limit   = parseInt(searchParams.get('limit') || '20');

  let query = `
    SELECT n.*, nc.name as category_name
    FROM news n LEFT JOIN news_categories nc ON nc.id = n.category_id
    WHERE n.is_published = TRUE
  `;
  const params: any[] = [];
  if (catId) { params.push(catId); query += ` AND n.category_id=$${params.length}`; }
  if (featured === 'true') query += ` AND n.is_featured=TRUE`;
  params.push(limit);
  query += ` ORDER BY n.published_at DESC LIMIT $${params.length}`;

  const { rows } = await db.query(query, params);
  return NextResponse.json({ news: rows });
}

export async function POST(req: NextRequest) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  const body = await req.json();
  const { title, content, summary, thumbnail, category_id, is_published, is_featured } = body;
  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 200);
  const published_at = is_published ? new Date().toISOString() : null;
  const { rows } = await db.query(
    `INSERT INTO news (title, slug, content, summary, thumbnail, category_id, is_published, is_featured, published_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [title, slug, content, summary, thumbnail, category_id || null, !!is_published, !!is_featured, published_at]
  );
  return NextResponse.json({ article: rows[0] }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  const body = await req.json();
  const { id, title, content, summary, thumbnail, category_id, is_published, is_featured } = body;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const published_at = is_published ? new Date().toISOString() : null;
  await db.query(
    `UPDATE news SET title=?, content=?, summary=?, thumbnail=?, category_id=?,
     is_published=?, is_featured=?, published_at=?, updated_at=NOW() WHERE id=?`,
    [title, content, summary, thumbnail, category_id || null, !!is_published, !!is_featured, published_at, id]
  );
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await db.query(`DELETE FROM news WHERE id=?`, [id]);
  return NextResponse.json({ success: true });
}
