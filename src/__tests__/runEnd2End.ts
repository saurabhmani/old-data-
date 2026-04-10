import './loadEnv';
// ════════════════════════════════════════════════════════════════
//  Quantorus365 — Full Pipeline Exercise
//
//  Actually invokes the production code paths (no API HTTP calls):
//    1. runSignalPipeline → persists signals + Phase 3 + Phase 4 memory
//    2. runBacktest      → produces signals/trades/audit
//    3. scanForManipulation → produces alerts
//
//  Then verifies that the audit tables now contain rows.
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';

async function countRows(table: string): Promise<number> {
  try {
    const { rows } = await db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
    return Number((rows[0] as any)?.cnt ?? 0);
  } catch {
    return -1;
  }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Full Pipeline Exercise');
  console.log('══════════════════════════════════════════════════\n');

  // ── Step 1: Signal pipeline ────────────────────────────
  console.log('▶ Running signal pipeline (limit=20)...');
  const beforeSignals = await countRows('q365_signals');
  const beforePhase3 = await countRows('q365_signal_trade_plans');
  const beforeMemory = await countRows('q365_decision_memory');

  try {
    const { runSignalPipeline } = await import('../services/signalPipeline');
    const result = await runSignalPipeline(20);
    console.log(`  ✓ Pipeline: scanned=${result.total_scanned}, approved=${result.total_approved}, rejected=${result.total_rejected}, duration=${result.duration_ms}ms`);
  } catch (err) {
    console.log(`  ✗ Pipeline failed: ${(err as Error).message}`);
  }

  const afterSignals = await countRows('q365_signals');
  const afterPhase3 = await countRows('q365_signal_trade_plans');
  const afterMemory = await countRows('q365_decision_memory');

  console.log(`  Δ q365_signals:              ${beforeSignals} → ${afterSignals}  (${afterSignals - beforeSignals >= 0 ? '+' : ''}${afterSignals - beforeSignals})`);
  console.log(`  Δ q365_signal_trade_plans:   ${beforePhase3} → ${afterPhase3}  (${afterPhase3 - beforePhase3 >= 0 ? '+' : ''}${afterPhase3 - beforePhase3})`);
  console.log(`  Δ q365_decision_memory:      ${beforeMemory} → ${afterMemory}  (${afterMemory - beforeMemory >= 0 ? '+' : ''}${afterMemory - beforeMemory})`);

  // ── Step 2: Manipulation scan ──────────────────────────
  console.log('\n▶ Running manipulation scan (universe of 50)...');
  const beforeAlerts = await countRows('manipulation_alerts');

  try {
    const { scanForManipulation } = await import('../lib/manipulation-detection');
    const { DEFAULT_PHASE1_CONFIG } = await import('../lib/signal-engine/constants/signalEngine.constants');
    const result = await scanForManipulation({
      symbols: DEFAULT_PHASE1_CONFIG.universe,
      lookbackDays: 60,
      minScoreToAlert: 30,
    });
    console.log(`  ✓ Scan: scanned=${result.scannedSymbols}, alerts=${result.alertsGenerated}, duration=${result.scanDuration}ms`);
  } catch (err) {
    console.log(`  ✗ Scan failed: ${(err as Error).message}`);
  }

  const afterAlerts = await countRows('manipulation_alerts');
  console.log(`  Δ manipulation_alerts:       ${beforeAlerts} → ${afterAlerts}  (${afterAlerts - beforeAlerts >= 0 ? '+' : ''}${afterAlerts - beforeAlerts})`);

  // ── Step 3: Backtest ───────────────────────────────────
  console.log('\n▶ Running backtest (1y range, 5 symbols)...');
  const beforeRuns = await countRows('backtest_runs');
  const beforeBtSignals = await countRows('backtest_signals');
  const beforeAudit = await countRows('backtest_audit_logs');

  try {
    const { runBacktest } = await import('../lib/backtesting/runner/backtestRunner');
    const { persistFullRun } = await import('../lib/backtesting/runner/runOrchestrator');
    const { DEFAULT_BACKTEST_CONFIG } = await import('../lib/backtesting/config/defaults');

    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      name: 'E2E Verification Run',
      universe: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'],
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      warmupBars: 50,
    };

    const result = await runBacktest(config);
    console.log(`  ✓ Backtest: status=${result.status}, signals=${result.signalCount}, trades=${result.tradeCount}, duration=${result.durationMs}ms`);

    if (result.status === 'completed') {
      const orchestrated = await persistFullRun(result);
      const ps = orchestrated.persistenceSummary;
      console.log(`  ✓ Persisted: run=${ps.run} signals=${ps.signals} trades=${ps.trades} outcomes=${ps.signalOutcomes} metrics=${ps.metrics} calib=${ps.calibrationBuckets} equity=${ps.equityCurve} audit=${ps.auditEvents}`);
      if (ps.errors.length > 0) console.log(`    errors: ${ps.errors.join(' | ')}`);
    }
  } catch (err) {
    console.log(`  ✗ Backtest failed: ${(err as Error).message}`);
  }

  const afterRuns = await countRows('backtest_runs');
  const afterBtSignals = await countRows('backtest_signals');
  const afterAudit = await countRows('backtest_audit_logs');

  console.log(`  Δ backtest_runs:             ${beforeRuns} → ${afterRuns}`);
  console.log(`  Δ backtest_signals:          ${beforeBtSignals} → ${afterBtSignals}`);
  console.log(`  Δ backtest_audit_logs:       ${beforeAudit} → ${afterAudit}`);

  console.log('\n══════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
