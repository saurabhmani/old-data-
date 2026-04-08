// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/calibration — Confidence calibration
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const result = await db.query(
      `SELECT bucket, strategy, regime, sample_size, expected_hit_rate,
              actual_hit_rate, avg_mfe_pct, avg_mae_pct,
              calibration_state, modifier_suggestion, computed_at
       FROM calibration_snapshots
       WHERE run_id = ?
       ORDER BY bucket, strategy`,
      [params.id],
    );

    const buckets = Array.isArray(result) ? result : (result.rows ?? []);

    return NextResponse.json({ runId: params.id, buckets });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load calibration', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
