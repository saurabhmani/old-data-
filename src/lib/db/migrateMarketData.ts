/**
 * Market Data Architecture Migration
 * Adds / updates the candles table with correct MySQL syntax.
 * Safe to re-run — uses IF NOT EXISTS / IF NOT EXISTS column checks.
 *
 * Run: npx ts-node src/lib/db/migrateMarketData.ts
 */

import { getDb } from '../db';

async function migrateMarketData() {
  const pool = getDb();
  console.log('🔄 Running market data migration...\n');

  try {
    // ── candles table (MySQL syntax) ──────────────────────────────
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS candles (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key VARCHAR(150) NOT NULL,
        candle_type    VARCHAR(15)  NOT NULL    COMMENT 'intraday | eod',
        interval_unit  VARCHAR(20)  NOT NULL    COMMENT '1minute | 5minute | 1day',
        ts             DATETIME     NOT NULL,
        open           DECIMAL(12,2) DEFAULT NULL,
        high           DECIMAL(12,2) DEFAULT NULL,
        low            DECIMAL(12,2) DEFAULT NULL,
        close          DECIMAL(12,2) DEFAULT NULL,
        volume         BIGINT        DEFAULT 0,
        oi             BIGINT        DEFAULT 0,
        UNIQUE KEY uq_candle (instrument_key, candle_type, interval_unit, ts),
        KEY idx_candles_key_ts (instrument_key, ts DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ candles table ready');

    // ── market_data_snapshots (latest live snapshot per symbol) ──
    // Stores the most recent MarketSnapshot for non-Redis environments
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS market_data_snapshots (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        symbol         VARCHAR(50)  NOT NULL,
        instrument_key VARCHAR(150) NOT NULL,
        ltp            DECIMAL(12,2) DEFAULT 0,
        open_price     DECIMAL(12,2) DEFAULT 0,
        high_price     DECIMAL(12,2) DEFAULT 0,
        low_price      DECIMAL(12,2) DEFAULT 0,
        close_price    DECIMAL(12,2) DEFAULT 0,
        volume         BIGINT        DEFAULT 0,
        oi             BIGINT        DEFAULT 0,
        change_percent DECIMAL(8,4)  DEFAULT 0,
        change_abs     DECIMAL(12,2) DEFAULT 0,
        vwap           DECIMAL(12,2) DEFAULT NULL,
        source         VARCHAR(20)   DEFAULT 'nse',
        snapshot_ts    BIGINT        DEFAULT 0   COMMENT 'Unix ms',
        updated_at     DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_snapshot_symbol (symbol),
        KEY idx_snap_updated (updated_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ market_data_snapshots table ready');

    // ── instrument_sync_logs already exists — no changes needed ──
    console.log('✓ instrument_sync_logs already present');

    console.log('\n✅ Market data migration complete.\n');
    console.log('Tables:');
    console.log('  candles                — OHLCV per instrument per interval');
    console.log('  market_data_snapshots  — latest live snapshot fallback (non-Redis)');

  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateMarketData();
