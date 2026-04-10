// ════════════════════════════════════════════════════════════════
//  GET /api/signal-engine/insights?signalId=123
//
//  Returns the full Phase 3 + Phase 4 enrichment for a given signal:
//    - trade plan
//    - position sizing
//    - portfolio fit
//    - execution readiness
//    - lifecycle history
//    - decision memory timeline
//    - explanation (if available)
//
//  This is the audit/debug endpoint for the signals detail view.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSignalEngineSchemas } from '@/lib/signal-engine/repository/ensureSchemas';

export async function GET(req: NextRequest) {
  try {
    await ensureSignalEngineSchemas();

    const signalId = parseInt(req.nextUrl.searchParams.get('signalId') ?? '0', 10);
    if (!signalId || Number.isNaN(signalId)) {
      return NextResponse.json({ error: 'signalId required' }, { status: 400 });
    }

    // Fetch base signal
    const { rows: signalRows } = await db.query(
      `SELECT * FROM q365_signals WHERE id = ?`, [signalId],
    );
    if (signalRows.length === 0) {
      return NextResponse.json({ error: 'signal not found' }, { status: 404 });
    }
    const signal = signalRows[0];

    // Phase 3 artifacts
    const [tradePlan, sizing, fit, readiness, lifecycle] = await Promise.all([
      db.query(`SELECT * FROM q365_signal_trade_plans WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [signalId]),
      db.query(`SELECT * FROM q365_signal_position_sizing WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [signalId]),
      db.query(`SELECT * FROM q365_signal_portfolio_fit WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [signalId]),
      db.query(`SELECT * FROM q365_signal_execution_readiness WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [signalId]),
      db.query(`SELECT * FROM q365_signal_lifecycle WHERE signal_id = ? ORDER BY changed_at`, [signalId]),
    ]);

    // Phase 4 artifacts
    const [explanation, decisionMemory, outcomes] = await Promise.all([
      db.query(`SELECT * FROM q365_signal_explanations WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [signalId]).catch(() => ({ rows: [] })),
      db.query(`SELECT * FROM q365_decision_memory WHERE signal_id = ? ORDER BY created_at`, [signalId]).catch(() => ({ rows: [] })),
      db.query(`SELECT * FROM q365_signal_outcomes WHERE signal_id = ? ORDER BY evaluated_at DESC LIMIT 1`, [signalId]).catch(() => ({ rows: [] })),
    ]);

    // Reasons + features
    const [reasons, features] = await Promise.all([
      db.query(`SELECT reason_type, message FROM q365_signal_reasons WHERE signal_id = ?`, [signalId]).catch(() => ({ rows: [] })),
      db.query(`SELECT features_json FROM q365_signal_feature_snapshots WHERE signal_id = ? LIMIT 1`, [signalId]).catch(() => ({ rows: [] })),
    ]);

    return NextResponse.json({
      signal: {
        id: signal.id,
        symbol: signal.symbol,
        direction: signal.direction,
        signal_type: signal.signal_type,
        confidence_score: signal.confidence_score,
        risk_score: signal.risk_score,
        opportunity_score: signal.opportunity_score,
        portfolio_fit_score: signal.portfolio_fit_score,
        market_regime: signal.market_regime,
        market_stance: signal.market_stance,
        scenario_tag: signal.scenario_tag,
        entry_price: signal.entry_price,
        stop_loss: signal.stop_loss,
        target1: signal.target1,
        target2: signal.target2,
        risk_reward: signal.risk_reward,
        status: signal.status,
        generated_at: signal.generated_at,
      },
      phase3: {
        tradePlan: tradePlan.rows[0] ?? null,
        sizing: sizing.rows[0] ?? null,
        portfolioFit: fit.rows[0] ?? null,
        executionReadiness: readiness.rows[0] ?? null,
        lifecycle: lifecycle.rows,
      },
      phase4: {
        explanation: explanation.rows[0] ?? null,
        decisionMemory: decisionMemory.rows,
        outcome: outcomes.rows[0] ?? null,
      },
      reasons: reasons.rows,
      features: (features.rows[0] as any)?.features_json ?? null,
    });
  } catch (err) {
    console.error('[insights] error:', err);
    return NextResponse.json(
      { error: 'Failed to load insights', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
