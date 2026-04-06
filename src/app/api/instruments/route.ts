import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const key = req.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });

  const { rows } = await db.query(
    `SELECT * FROM instruments WHERE instrument_key=?`, [key]
  );
  if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ instrument: rows[0] });
}
