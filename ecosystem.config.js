/**
 * PM2 Ecosystem — Quantorus365
 *
 * Starts two processes:
 *   1. quantorus365-app        — Next.js server (2 cluster instances)
 *   2. quantorus365-scheduler  — Market data cron scheduler (1 fork)
 *
 * Usage:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [
    // ── Next.js App ──────────────────────────────────────────────
    {
      name:         'quantorus365-app',
      script:       'node_modules/.bin/next',
      args:         'start',
      instances:    2,
      exec_mode:    'cluster',
      watch:        false,
      max_memory_restart: '512M',
      env_production: {
        NODE_ENV:  'production',
        PORT:      3000,
      },
      error_file:  './logs/app-error.log',
      out_file:    './logs/app-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── Market Data Scheduler ────────────────────────────────────
    {
      name:         'quantorus365-scheduler',
      script:       'node_modules/.bin/ts-node',
      args:         '--project tsconfig.json src/lib/workers/scheduler.ts',
      instances:    1,           // MUST be 1 — Redis lock prevents multi-instance overlap
      exec_mode:    'fork',      // not cluster — single process owns the lock
      watch:        false,
      restart_delay: 5000,       // wait 5s before restart to avoid rapid crash loops
      max_restarts:  10,
      max_memory_restart: '256M',
      env_production: {
        NODE_ENV: 'production',
      },
      error_file:  './logs/scheduler-error.log',
      out_file:    './logs/scheduler-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
