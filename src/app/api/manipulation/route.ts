// ════════════════════════════════════════════════════════════════
//  POST /api/manipulation      — Run manipulation scan
//  GET  /api/manipulation      — Get alerts & summary
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { scanForManipulation, getManipulationDashboard, loadAlerts, updateAlertStatus } from '@/lib/manipulation-detection';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';

/** POST — Run manipulation scan */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const symbols = body.symbols ?? DEFAULT_PHASE1_CONFIG.universe;
    const config = {
      symbols,
      lookbackDays: body.lookbackDays ?? 60,
      volumeThresholdMultiple: body.volumeThreshold ?? 3.0,
      priceThresholdPct: body.priceThreshold ?? 5.0,
      atrThresholdMultiple: body.atrThreshold ?? 2.5,
      minScoreToAlert: body.minScore ?? 40,
    };

    const result = await scanForManipulation(config);

    return NextResponse.json(result);
  } catch (err) {
    console.error('[API manipulation] Scan error:', err);
    return NextResponse.json(
      { error: 'Scan failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** GET — Load alerts or summary */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const action = searchParams.get('action') ?? 'summary';

    if (action === 'summary') {
      const summary = await getManipulationDashboard();
      return NextResponse.json(summary);
    }

    if (action === 'alerts') {
      const alerts = await loadAlerts({
        type: (searchParams.get('type') as any) ?? undefined,
        severity: (searchParams.get('severity') as any) ?? undefined,
        status: (searchParams.get('status') as any) ?? undefined,
        symbol: searchParams.get('symbol') ?? undefined,
        limit: parseInt(searchParams.get('limit') ?? '50'),
      });
      return NextResponse.json({ alerts, total: alerts.length });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** PATCH — Update alert status */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.alertId || !body.status) {
      return NextResponse.json({ error: 'alertId and status required' }, { status: 400 });
    }
    await updateAlertStatus(body.alertId, body.status);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'Update failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
