/**
 * Quantorus365 — Unified DB Migration
 * Creates all base tables: Auth, User Data, Market Data, Intelligence.
 *
 * MySQL-native. No PostgreSQL syntax.
 * Run: npx ts-node -r tsconfig-paths/register src/lib/db/migrate.ts
 * Safe to re-run (IF NOT EXISTS on all tables).
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

// Load .env.local without dotenv dependency
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

async function migrate() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const parsed = new URL(url);

  const conn = await mysql.createConnection({
    host:     parsed.hostname,
    port:     parsed.port ? parseInt(parsed.port) : 3306,
    user:     parsed.username,
    password: parsed.password,
    database: parsed.pathname?.slice(1) || 'quantorus365',
  });

  console.log('Running Quantorus365 migrations...\n');

  try {
    // ── Users & Auth ───────────────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        email                 VARCHAR(255) UNIQUE NOT NULL,
        name                  VARCHAR(255),
        password_hash         VARCHAR(255) NOT NULL,
        role                  VARCHAR(20)  DEFAULT 'user',
        is_active             TINYINT(1)   DEFAULT 1,
        totp_secret           VARCHAR(255),
        totp_enabled          TINYINT(1)   DEFAULT 0,
        failed_login_attempts INT          DEFAULT 0,
        locked_until          DATETIME,
        last_login_at         DATETIME,
        created_at            DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at            DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_users_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ users');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        token      VARCHAR(255) UNIQUE NOT NULL,
        device     VARCHAR(255),
        ip_address VARCHAR(50),
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sessions_token (token),
        INDEX idx_sessions_user  (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ user_sessions');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        used       TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ password_resets');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        user_id       INT,
        action        VARCHAR(100) NOT NULL,
        resource_type VARCHAR(100),
        resource_id   INT,
        metadata      JSON,
        ip_address    VARCHAR(50),
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_user   (user_id),
        INDEX idx_audit_action (action),
        INDEX idx_audit_time   (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ audit_logs');

    // ── Market Data ────────────────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS instruments (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key  VARCHAR(150) UNIQUE NOT NULL,
        exchange        VARCHAR(20)  NOT NULL,
        tradingsymbol   VARCHAR(50)  NOT NULL,
        name            VARCHAR(255),
        expiry          DATE,
        strike          DECIMAL(12,2),
        tick_size       DECIMAL(10,4),
        lot_size        INT,
        instrument_type VARCHAR(30),
        option_type     VARCHAR(5),
        isin            VARCHAR(20),
        sector          VARCHAR(100),
        raw_json        JSON,
        is_active       TINYINT(1)   DEFAULT 1,
        last_synced_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
        created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_instruments_symbol   (tradingsymbol),
        INDEX idx_instruments_exchange (exchange),
        INDEX idx_instruments_type     (instrument_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ instruments');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS watchlists (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        name       VARCHAR(100) DEFAULT 'Default',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_wl_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS watchlist_items (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        watchlist_id   INT NOT NULL,
        instrument_key VARCHAR(150) NOT NULL,
        tradingsymbol  VARCHAR(50),
        exchange       VARCHAR(20),
        name           VARCHAR(255),
        added_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_wi (watchlist_id, instrument_key),
        INDEX idx_wi_wl (watchlist_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ watchlists + watchlist_items');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        name       VARCHAR(100) DEFAULT 'My Portfolio',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_portfolios_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_positions (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_id   INT NOT NULL,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50) NOT NULL,
        exchange       VARCHAR(20),
        quantity       INT NOT NULL,
        buy_price      DECIMAL(12,2) NOT NULL,
        current_price  DECIMAL(12,2),
        added_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_pp_portfolio (portfolio_id),
        INDEX idx_pp_symbol    (tradingsymbol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ portfolios + portfolio_positions');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS news_categories (
        id   INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS news (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        title        VARCHAR(500) NOT NULL,
        slug         VARCHAR(500) UNIQUE,
        content      TEXT,
        summary      TEXT,
        thumbnail    VARCHAR(500),
        category_id  INT,
        author_id    INT,
        is_published TINYINT(1) DEFAULT 0,
        is_featured  TINYINT(1) DEFAULT 0,
        published_at DATETIME,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_news_published (is_published, published_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ news + news_categories');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        message    TEXT NOT NULL,
        type       VARCHAR(50) DEFAULT 'info',
        is_read    TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_notif_user (user_id, is_read)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ notifications');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS alerts (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        user_id        INT NOT NULL,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50),
        condition_type VARCHAR(20) DEFAULT 'above',
        target_price   DECIMAL(12,2),
        is_active      TINYINT(1) DEFAULT 1,
        triggered_at   DATETIME,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_alerts_user (user_id),
        INDEX idx_alerts_sym  (tradingsymbol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ alerts');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS reports (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_id     INT NOT NULL,
        name        VARCHAR(255),
        report_type VARCHAR(50),
        format      VARCHAR(10) DEFAULT 'csv',
        status      VARCHAR(20) DEFAULT 'pending',
        file_path   VARCHAR(500),
        metadata    JSON,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reports_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ reports');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS rankings (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50),
        exchange       VARCHAR(20),
        name           VARCHAR(255),
        score          DECIMAL(8,4),
        rank_position  INT,
        pct_change     DECIMAL(8,4),
        ltp            DECIMAL(12,2),
        volume         BIGINT,
        confidence_score SMALLINT,
        portfolio_fit_score SMALLINT,
        conviction_band  VARCHAR(30),
        market_stance    VARCHAR(30),
        scenario_tag     VARCHAR(100),
        updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_rankings_sym   (tradingsymbol),
        INDEX idx_rankings_score (score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ rankings');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS strategies (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        description TEXT,
        category    VARCHAR(100),
        is_active   TINYINT(1) DEFAULT 1,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS strategy_picks (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        strategy_id    INT,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50),
        exchange       VARCHAR(20),
        rationale      TEXT,
        entry_price    DECIMAL(12,2),
        target_price   DECIMAL(12,2),
        stop_loss      DECIMAL(12,2),
        added_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sp_strategy (strategy_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ strategies + strategy_picks');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS signals (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key   VARCHAR(150),
        tradingsymbol    VARCHAR(50),
        signal_type      VARCHAR(50),
        strength         VARCHAR(20),
        description      TEXT,
        confidence       SMALLINT,
        confidence_score SMALLINT,
        risk_score       SMALLINT,
        scenario_tag     VARCHAR(100),
        market_stance    VARCHAR(30),
        regime           VARCHAR(30),
        conviction_band  VARCHAR(30),
        portfolio_fit_score SMALLINT,
        generated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_signals_sym  (tradingsymbol),
        INDEX idx_signals_time (generated_at),
        INDEX idx_signals_conf (confidence_score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ signals');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS macro_data (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        indicator  VARCHAR(100) NOT NULL,
        value      DECIMAL(14,4),
        unit       VARCHAR(50),
        period     VARCHAR(50),
        source     VARCHAR(100),
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_macro_indicator (indicator)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ macro_data');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        user_id           INT UNIQUE NOT NULL,
        default_dashboard VARCHAR(50) DEFAULT 'overview',
        timezone          VARCHAR(100) DEFAULT 'Asia/Kolkata',
        alert_email       TINYINT(1) DEFAULT 1,
        preferred_segments JSON,
        preferences       JSON,
        updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ user_preferences');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100) UNIQUE NOT NULL,
        enabled    TINYINT(1) DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      INSERT IGNORE INTO feature_flags (name, enabled) VALUES
        ('live_feed', 0),('options_chain', 0),('ai_signals', 0)
    `);
    console.log('✓ feature_flags');

    // ── Market data cache tables ───────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tokens_cache (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        scope        VARCHAR(50) UNIQUE DEFAULT 'system',
        access_token TEXT NOT NULL,
        expires_at   DATETIME NOT NULL,
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS candles (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key VARCHAR(150) NOT NULL,
        candle_type    VARCHAR(15)  NOT NULL,
        interval_unit  VARCHAR(20)  NOT NULL,
        ts             DATETIME     NOT NULL,
        open           DECIMAL(12,2),
        high           DECIMAL(12,2),
        low            DECIMAL(12,2),
        close          DECIMAL(12,2),
        volume         BIGINT,
        oi             BIGINT,
        UNIQUE KEY uq_candle (instrument_key, candle_type, interval_unit, ts),
        INDEX idx_candles_key_ts (instrument_key, ts)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS options_chain_cache (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        underlying_key VARCHAR(150) NOT NULL,
        expiry         DATE NOT NULL,
        payload        JSON NOT NULL,
        fetched_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_occ (underlying_key, expiry)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS instrument_sync_logs (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        exchange  VARCHAR(20),
        total     INT,
        inserted  INT,
        updated   INT,
        status    VARCHAR(20) DEFAULT 'success',
        error_msg TEXT,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_isl_exchange (exchange)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ tokens_cache, candles, options_chain_cache, instrument_sync_logs');

    // ── Seed admin user ────────────────────────────────────────────
    try {
      const bcrypt = require('bcryptjs');
      const hash   = await bcrypt.hash('Admin@1234', 12);
      await conn.execute(
        `INSERT IGNORE INTO users (email, name, password_hash, role, is_active)
         VALUES ('admin@quantorus365.in', 'Admin', ?, 'admin', 1)`,
        [hash]
      );
      console.log('✓ Admin user: admin@quantorus365.in / Admin@1234');
    } catch (e) {
      console.log('  (admin user seed skipped — bcryptjs not available)');
    }

    console.log('\n✅ All base migrations complete.');
    console.log('   Next: npm run db:migrate-intel && npm run db:migrate-market && npm run db:migrate-q365');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

migrate();
