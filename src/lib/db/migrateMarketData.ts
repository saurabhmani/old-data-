/**
 * Market Data Architecture Migration
 * Adds / updates the candles and market_data_snapshots tables.
 * Safe to re-run — uses IF NOT EXISTS.
 *
 * Run: npx ts-node -P tsconfig.node.json -r tsconfig-paths/register src/lib/db/migrateMarketData.ts
 */
import mysql from 'mysql2/promise';
import fs    from 'fs';
import path  from 'path';

// Load .env.local without dotenv dependency (same pattern as all other migration files)
try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

async function migrateMarketData() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set — check .env.local');
  const parsed = new URL(url);

  const conn = await mysql.createConnection({
    host:     parsed.hostname,
    port:     parsed.port ? parseInt(parsed.port, 10) : 3306,
    user:     decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname?.slice(1) || 'quantorus365',
    multipleStatements: true,
  });

  console.log('Running market data migration...\n');

  try {
    // ── candles table ─────────────────────────────────────────────
    await conn.execute(`
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
    console.log('✓ candles');

    // ── market_data_snapshots (latest live snapshot per symbol) ──
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS market_data_snapshots (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        symbol         VARCHAR(50)   NOT NULL,
        instrument_key VARCHAR(150)  NOT NULL,
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
    console.log('✓ market_data_snapshots');

    console.log('\n✅ Market data migration complete.');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

migrateMarketData();
