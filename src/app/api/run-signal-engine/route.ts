/**
 * POST /api/run-signal-engine
 *
 * Centralized pipeline entry point.
 * Runs the full signal engine, persists all results to MySQL.
 * All GET endpoints read from the same database.
 *
 * Query params:
 *   limit — max instruments to scan (default 60)
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession }           from '@/lib/session';
import { runSignalPipeline }         from '@/services/signalPipeline';
import { migrateSignalEngine }       from '@/lib/db/migrateSignalEngine';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

// Ensure tables exist on first call
let migrated = false;

export async function POST(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // Auto-migrate on first call
  if (!migrated) {
    await migrateSignalEngine().catch(err =>
      console.warn('[RunSignalEngine] Migration warning:', err.message)
    );
    migrated = true;
  }

  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get('limit') || '60', 10),
    120
  );

  try {
    const result = await runSignalPipeline(limit);

    return NextResponse.json({
      success:        true,
      batch_id:       result.batch_id,
      total_scanned:  result.total_scanned,
      total_approved: result.total_approved,
      total_rejected: result.total_rejected,
      signals:        result.signals,
      duration_ms:    result.duration_ms,
    });
  } catch (err: any) {
    console.error('[RunSignalEngine]', err);
    return NextResponse.json(
      { error: 'Pipeline failed', details: err?.message },
      { status: 500 }
    );
  }
}
