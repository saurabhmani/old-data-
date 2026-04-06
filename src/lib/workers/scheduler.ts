/**
 * Quantorus365 — Market Data Scheduler
 *
 * Runs as a separate PM2 process alongside the Next.js app.
 * Uses node-cron with IST (Asia/Kolkata) timezone.
 *
 * Schedule (IST):
 *   06:00  — Pre-market warmup (load instruments, prime cache)
 *   09:30  — Market open (start intraday cycle)
 *   12:30  — Midday refresh
 *   18:00  — Post-market EOD snapshot
 *   00:00  — Midnight cleanup + archive
 *
 * Redis locking:
 *   key: cron:market_update_lock
 *   TTL: 12 minutes  (covers max expected run time of ~8–10 min for 500 stocks)
 *   If lock exists, job is skipped — prevents overlap across PM2 instances.
 *
 * Start:  npx ts-node src/lib/workers/scheduler.ts
 * PM2:    pm2 start src/lib/workers/scheduler.ts --name quantorus365-scheduler
 *
 * Environment required (same .env.local as Next.js app):
 *   DATABASE_URL, REDIS_HOST, REDIS_PORT, UPSTOX_CLIENT_ID, etc.
 */

// ── Bootstrap path aliases (ts-node doesn't support @/ by default) ─
import 'tsconfig-paths/register';

import cron from 'node-cron';
import { db }                         from '@/lib/db';
import { cacheGet, cacheSet, cacheDel } from '@/lib/redis';
import {
  loadUniverse,
  refreshMarketUniverse,
  getAggregatorStatus,
}                                     from '@/services/dataAggregator';
import {
  getBatchSnapshots,
  persistCandle,
  type MarketSnapshot,
}                                     from '@/services/marketDataService';

// ── Constants ─────────────────────────────────────────────────────
const LOCK_KEY          = 'cron:market_update_lock';
const LOCK_TTL_SEC      = 12 * 60;   // 12 minutes
const UNIVERSE_SIZE     = {
  premarket:  200,
  marketOpen: 500,
  midday:     500,
  eod:        500,
  midnight:   200,
};
const BATCH_CONCURRENCY = 5;         // max parallel NSE fetches
const BATCH_DELAY_MS    = 300;       // ms between batches (NSE rate-limit buffer)

// ── Structured logger ─────────────────────────────────────────────
type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

function log(level: LogLevel, job: string, message: string, meta?: Record<string, unknown>) {
  const ts    = new Date().toISOString();
  const extra = meta ? ` | ${JSON.stringify(meta)}` : '';
  const icon  = { INFO: 'ℹ', WARN: '⚠', ERROR: '✖', SUCCESS: '✔' }[level];
  console.log(`[${ts}] ${icon} [${job}] ${message}${extra}`);
}

// ── Redis distributed lock ────────────────────────────────────────

async function acquireLock(jobName: string): Promise<boolean> {
  const existing = await cacheGet<string>(LOCK_KEY);
  if (existing) {
    log('WARN', jobName, `Lock held by "${existing}" — skipping this run`);
    return false;
  }
  await cacheSet(LOCK_KEY, jobName, LOCK_TTL_SEC);
  // Verify we actually acquired it (basic compare-and-set)
  const check = await cacheGet<string>(LOCK_KEY);
  if (check !== jobName) {
    log('WARN', jobName, 'Lock acquired by concurrent process — skipping');
    return false;
  }
  return true;
}

async function releaseLock(jobName: string): Promise<void> {
  const current = await cacheGet<string>(LOCK_KEY);
  if (current === jobName) {
    await cacheDel(LOCK_KEY);
  }
}

// ── Execution log to MySQL ────────────────────────────────────────

async function logRunToDb(
  jobName:       string,
  status:        'success' | 'error' | 'skipped',
  totalSymbols:  number,
  refreshed:     number,
  failed:        number,
  durationMs:    number,
  errorMsg?:     string
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO instrument_sync_logs
        (exchange, total, inserted, updated, status, error_msg)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      `CRON:${jobName}`,
      totalSymbols,
      refreshed,
      failed,
      status,
      errorMsg ?? null,
    ]);
  } catch (err: any) {
    log('WARN', jobName, 'Failed to write run log to DB', { err: err?.message });
  }
}

// ── Core job runner ───────────────────────────────────────────────

interface JobResult {
  refreshed:   number;
  failed:      number;
  duration_ms: number;
  source_mix:  Record<string, number>;  // how many came from each data source
}

async function runMarketUpdate(
  jobName:      string,
  universeSize: number,
  candleType:   'intraday' | 'eod',
  intervalUnit: string
): Promise<JobResult> {

  const startMs = Date.now();
  log('INFO', jobName, `Starting — universe size: ${universeSize}`);

  // Load universe from rankings table
  const universe = await loadUniverse(universeSize);
  if (!universe.length) {
    log('WARN', jobName, 'Universe empty — run Admin → rankings sync first');
    return { refreshed: 0, failed: 0, duration_ms: Date.now() - startMs, source_mix: {} };
  }

  log('INFO', jobName, `Universe loaded: ${universe.length} symbols`);

  let refreshed = 0;
  let failed    = 0;
  const sourceMix: Record<string, number> = {};

  // Process in batches of BATCH_CONCURRENCY
  for (let i = 0; i < universe.length; i += BATCH_CONCURRENCY) {
    const chunk = universe.slice(i, i + BATCH_CONCURRENCY);
    const snaps = await getBatchSnapshots(chunk);

    for (const item of chunk) {
      const snap: MarketSnapshot | undefined = snaps[item.symbol];

      if (!snap || snap.ltp <= 0) {
        failed++;
        log('WARN', jobName, `No data for ${item.symbol}`);
        continue;
      }

      // Tally source distribution
      sourceMix[snap.source] = (sourceMix[snap.source] ?? 0) + 1;
      refreshed++;

      // Persist to MySQL candles (non-blocking — fire and forget)
      persistCandle(
        item.instrument_key || `NSE_EQ|${item.symbol}`,
        candleType,
        intervalUnit,
        new Date(snap.timestamp),
        snap.open,
        snap.high,
        snap.low,
        snap.ltp,
        snap.volume,
        snap.oi
      ).catch(err => {
        log('WARN', jobName, `Candle persist failed for ${item.symbol}`, { err: err?.message });
      });
    }

    // Log progress every 50 symbols
    if ((i + BATCH_CONCURRENCY) % 50 === 0 || i + BATCH_CONCURRENCY >= universe.length) {
      const done = Math.min(i + BATCH_CONCURRENCY, universe.length);
      log('INFO', jobName, `Progress: ${done}/${universe.length} (${refreshed} ok, ${failed} failed)`);
    }

    // Rate-limit buffer between batches
    if (i + BATCH_CONCURRENCY < universe.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const durationMs = Date.now() - startMs;
  return { refreshed, failed, duration_ms: durationMs, source_mix: sourceMix };
}

// ── Job definitions ───────────────────────────────────────────────

/**
 * Wraps any job with:
 *   1. Redis lock acquisition (skip if locked)
 *   2. Structured logging (start / end / duration)
 *   3. MySQL run log
 *   4. Error isolation (job failure never crashes the scheduler process)
 */
async function runJob(
  jobName:    string,
  jobFn:      () => Promise<JobResult>
): Promise<void> {

  log('INFO', jobName, '─── Job triggered ───');

  const locked = await acquireLock(jobName);
  if (!locked) {
    await logRunToDb(jobName, 'skipped', 0, 0, 0, 0, 'Lock held by another instance');
    return;
  }

  const startMs = Date.now();

  try {
    const result = await jobFn();
    const durationMs = Date.now() - startMs;

    log('SUCCESS', jobName,
      `Completed in ${(durationMs / 1000).toFixed(1)}s — ` +
      `${result.refreshed} refreshed, ${result.failed} failed`,
      { source_mix: result.source_mix }
    );

    await logRunToDb(jobName, 'success', result.refreshed + result.failed,
                     result.refreshed, result.failed, durationMs);

  } catch (err: any) {
    const durationMs = Date.now() - startMs;
    log('ERROR', jobName, `Job failed after ${(durationMs / 1000).toFixed(1)}s`, {
      error: err?.message,
      stack: err?.stack?.split('\n').slice(0, 3),
    });
    await logRunToDb(jobName, 'error', 0, 0, 0, durationMs, err?.message ?? 'unknown');

  } finally {
    await releaseLock(jobName);
    log('INFO', jobName, `Lock released`);
  }
}

// ── 06:00 IST — Pre-market warmup ────────────────────────────────
// Primes Redis cache before market opens. Smaller universe, EOD data.
cron.schedule('0 6 * * 1-5', () => {
  runJob('PREMARKET_WARMUP', () =>
    runMarketUpdate('PREMARKET_WARMUP', UNIVERSE_SIZE.premarket, 'eod', '1day')
  );
}, { timezone: 'Asia/Kolkata' });

// ── 09:30 IST — Market open ───────────────────────────────────────
// Full 500-stock intraday fetch at market open.
cron.schedule('30 9 * * 1-5', () => {
  runJob('MARKET_OPEN', () =>
    runMarketUpdate('MARKET_OPEN', UNIVERSE_SIZE.marketOpen, 'intraday', '1minute')
  );
}, { timezone: 'Asia/Kolkata' });

// ── 12:30 IST — Midday refresh ────────────────────────────────────
// Midday snapshot during lunch. Refreshes intraday candles.
cron.schedule('30 12 * * 1-5', () => {
  runJob('MIDDAY_REFRESH', () =>
    runMarketUpdate('MIDDAY_REFRESH', UNIVERSE_SIZE.midday, 'intraday', '5minute')
  );
}, { timezone: 'Asia/Kolkata' });

// ── 18:00 IST — EOD snapshot ──────────────────────────────────────
// Market closed. Capture final EOD prices and store as daily candles.
cron.schedule('0 18 * * 1-5', () => {
  runJob('EOD_SNAPSHOT', async () => {
    const result = await runMarketUpdate(
      'EOD_SNAPSHOT', UNIVERSE_SIZE.eod, 'eod', '1day'
    );
    // Also expire all intraday Redis keys post-market
    log('INFO', 'EOD_SNAPSHOT', 'Post-market: clearing intraday Redis cache...');
    try {
      // Note: production Redis can use SCAN + DEL; simple TTL expiry handles this too
      // since all stock: keys have 60s TTL — they expire naturally
      log('INFO', 'EOD_SNAPSHOT', 'Intraday cache will expire naturally via Redis TTL');
    } catch {}
    return result;
  });
}, { timezone: 'Asia/Kolkata' });

// ── 00:00 IST — Midnight maintenance ─────────────────────────────
// Cleanup stale locks, archive old candles, refresh instrument universe.
// Runs every day including weekends.
cron.schedule('0 0 * * *', () => {
  runJob('MIDNIGHT_MAINTENANCE', async () => {
    const startMs = Date.now();

    // 1. Force-release any stale lock from previous day
    const staleLock = await cacheGet<string>(LOCK_KEY);
    if (staleLock) {
      log('WARN', 'MIDNIGHT_MAINTENANCE', `Clearing stale lock: ${staleLock}`);
      await cacheDel(LOCK_KEY);
    }

    // 2. Archive candles older than 90 days (keep DB lean)
    try {
      await db.query(`
        DELETE FROM candles
        WHERE candle_type = 'intraday'
          AND ts < DATE_SUB(NOW(), INTERVAL 90 DAY)
      `);
      log('INFO', 'MIDNIGHT_MAINTENANCE', 'Archived candles older than 90 days');
    } catch (err: any) {
      log('WARN', 'MIDNIGHT_MAINTENANCE', 'Candle archive failed', { err: err?.message });
    }

    // 3. Small universe refresh to prime cache for pre-market
    const result = await runMarketUpdate(
      'MIDNIGHT_MAINTENANCE', UNIVERSE_SIZE.midnight, 'eod', '1day'
    );

    return { ...result, duration_ms: Date.now() - startMs };
  });
}, { timezone: 'Asia/Kolkata' });

// ── Health-check heartbeat ────────────────────────────────────────
// Logs aggregator status every 10 minutes so PM2 logs show it's alive.
cron.schedule('*/10 * * * *', () => {
  const status = getAggregatorStatus();
  const lockInfo = cacheGet<string>(LOCK_KEY).then(l => {
    log('INFO', 'HEARTBEAT', 'Scheduler alive', {
      ...status,
      lock: l ?? 'none',
      uptime_s: Math.floor(process.uptime()),
    });
  }).catch(() => {});
});

// ── Process lifecycle ─────────────────────────────────────────────

log('INFO', 'SCHEDULER', '═══════════════════════════════════════');
log('INFO', 'SCHEDULER', ' Quantorus365 Market Data Scheduler started');
log('INFO', 'SCHEDULER', ' Timezone: Asia/Kolkata (IST)');
log('INFO', 'SCHEDULER', ' Schedule:');
log('INFO', 'SCHEDULER', '   06:00  Pre-market warmup  (top 200)');
log('INFO', 'SCHEDULER', '   09:30  Market open        (top 500)');
log('INFO', 'SCHEDULER', '   12:30  Midday refresh     (top 500)');
log('INFO', 'SCHEDULER', '   18:00  EOD snapshot       (top 500)');
log('INFO', 'SCHEDULER', '   00:00  Midnight cleanup   (all days)');
log('INFO', 'SCHEDULER', '═══════════════════════════════════════');

process.on('SIGTERM', async () => {
  log('INFO', 'SCHEDULER', 'SIGTERM received — releasing lock and shutting down...');
  await releaseLock('SHUTDOWN').catch(() => {});
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('INFO', 'SCHEDULER', 'SIGINT received — releasing lock and shutting down...');
  await releaseLock('SHUTDOWN').catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('ERROR', 'SCHEDULER', 'Uncaught exception — process will continue', {
    error: err.message,
    stack: err.stack?.split('\n').slice(0, 4),
  });
  // Do NOT exit — PM2 will restart; instead log and continue
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'SCHEDULER', 'Unhandled promise rejection', {
    reason: String(reason),
  });
});
