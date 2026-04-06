# Quantorus365 — Institutional Intelligence Architecture

## Philosophy

This is an **Institutional Decision Engine**, not a retail signal app.

Five non-negotiable principles:
1. **Risk-first** — Risk is a gatekeeper, not a display number
2. **Portfolio awareness** — Trade quality = stock quality × portfolio fit
3. **Scenario-driven** — Market conditions control which strategies are allowed
4. **Confidence scoring** — Confidence measures decision quality, not prediction certainty
5. **Rejection discipline** — The system earns trust by filtering, not by volume

---

## Engine Architecture

```
NSE Public API (live quotes, breadth, options, FII/DII)
        │
        ▼ scheduler writes every 60s
Redis Cache (keyed by instrument, scenario, regime, stance)
        │
        ▼ cache miss
MySQL (candles, instruments, signals, rankings, rejections)
        │
        ▼ no candles
Yahoo Finance (auto-persisted to MySQL)
```

### 5-Engine Intelligence Stack

```
Market Data → Features → Factor Scores
                                │
                    ┌───────────▼───────────┐
                    │   Scenario Engine      │  What type of market?
                    │   scenarioEngine.ts    │  Controls strategy access
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Market Stance Engine  │  How aggressive today?
                    │  marketStanceEngine.ts │  Adjusts all thresholds
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Portfolio Fit Service │  Does this fit the book?
                    │  portfolioFitService.ts│  Real correlation from DB
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Confidence Engine     │  9-component decision quality
                    │  confidenceEngine.ts   │  Weights from systemConfig
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Rejection Engine      │  11 sequential hard gates
                    │  rejectionEngine.ts    │  No bypass path
                    └───────────┬───────────┘
                                │
                      APPROVED  │  REJECTED
                         ▼      │      ▼
                    To user      │  signal_rejections
                                 │  + quality_events log
```

---

## System Config Service (`systemConfigService.ts`)

**Single source of truth for all 25 operational thresholds.**

- Loads from `system_thresholds` MySQL table
- Caches in Redis (TTL 300s) + in-memory (300s)
- `applyStanceOverrides(cfg, stance)` merges stance adjustments on top
- `invalidateConfig()` flushes all caches after admin update
- No service hardcodes threshold values

Threshold keys:
```
MIN_RR_SWING, MIN_RR_POSITIONAL
MIN_CONFIDENCE, MIN_COMPOSITE_SCORE, MAX_RISK_SCORE
MIN_DATA_QUALITY, MIN_LIQUIDITY_VOLUME, MIN_VOLUME_INTRADAY
MAX_SECTOR_EXPOSURE, MAX_POSITIONS, MAX_STRATEGY_CONCENTRATION
MAX_CORRELATION, MIN_PORTFOLIO_FIT
MAX_DRAWDOWN_BLOCK, CAPITAL_AT_RISK_CAP
MAX_STOP_ATR_MULTIPLE, MIN_STOP_ATR_MULTIPLE
WEIGHT_* (×9 confidence weights)
CORRELATION_LOOKBACK_DAYS
```

---

## Rejection Engine — 11 Gates

All gates run in order. A signal is blocked if ANY gate fails.

| # | Gate | Blocks when |
|---|------|-------------|
| 1 | Data Quality | quality < MIN_DATA_QUALITY |
| 2 | No Strategy | no strategy pattern matched |
| 3 | Scenario | strategy blocked in current scenario |
| 4 | Market Stance | strategy not in stance's allowed list |
| 5 | Regime | BUY in BEAR without MR/event justification |
| 6 | Risk-Reward | R:R < MIN_RR (swing or positional) |
| 7 | Confidence | confidence < stance-adjusted MIN_CONFIDENCE |
| 8 | Risk Score | risk_score > MAX_RISK_SCORE |
| 9 | Liquidity | volume < MIN_VOLUME_INTRADAY |
| 10 | Stop Distance | stop < MIN_STOP_ATR or > MAX_STOP_ATR |
| 11 | Portfolio Fit | portfolio_fit_score < MIN_PORTFOLIO_FIT |

All rejection outcomes logged to `signal_rejections` table.

---

## Confidence Formula

```
confidence_score =
  factor_alignment     × WEIGHT_FACTOR_ALIGNMENT  (default 0.22)
  strategy_clarity     × WEIGHT_STRATEGY_CLARITY  (default 0.14)
  regime_alignment     × WEIGHT_REGIME_ALIGNMENT  (default 0.14)
  liquidity_quality    × WEIGHT_LIQUIDITY         (default 0.10)
  data_quality         × WEIGHT_DATA_QUALITY      (default 0.08)
  portfolio_fit        × WEIGHT_PORTFOLIO_FIT     (default 0.12)
  participation        × WEIGHT_PARTICIPATION     (default 0.06)
  rr_quality           × WEIGHT_RR_QUALITY        (default 0.08)
  volatility_fit       × WEIGHT_VOLATILITY_FIT    (default 0.06)
```

Weights are DB-configurable via `system_thresholds` table.

Conviction bands:
- `high_conviction` — score ≥ 85
- `actionable`      — score 70–84
- `watchlist`       — score 55–69
- `reject`          — score < 55

---

## Market Stance Effects

| Stance | MIN_CONFIDENCE | MIN_RR | MAX_POSITIONS | Alert volume |
|--------|---------------|--------|---------------|--------------|
| aggressive | –10 | –0.3 | +3 | 100% |
| selective | (base) | (base) | (base) | 60% |
| defensive | +8 | +0.3 | –4 | 30% |
| capital_preservation | +20 | +0.8 | –8 | 10% |

Adjustments applied on top of DB base values via `applyStanceOverrides()`.

---

## Portfolio Fit Scoring

Portfolio fit score (0–100) deducts for:

| Factor | Max deduction |
|--------|--------------|
| Sector overexposure (≥30%) | 50 pts |
| Portfolio at capacity (12 pos) | 40 pts |
| Strategy concentration (≥50%) | 20 pts |
| Active drawdown (≥15%) | 25 pts |
| Capital at risk (≥20%) | 15 pts |
| High correlation (avg >0.75) | 20 pts |

Correlation is computed from **rolling 60-day returns in `candles` table** — not approximated.

---

## Data Sources

| Source | Used for | Auth |
|--------|----------|------|
| NSE public API | Live quotes, breadth, indices, options | None |
| MySQL candles | Historical OHLCV, SMA, ATR, correlation | Internal |
| Yahoo Finance | Historical fallback (auto-persists to MySQL) | None |
| Redis | Hot cache for all reads | Internal |

**No broker API. No OAuth tokens. No external broker dependency.**

---

## MySQL Tables

### New in this release
| Table | Purpose |
|-------|---------|
| `system_thresholds` | All 25 configurable gate values |
| `signal_rejections` | Every candidate logged with gate outcome |
| `market_scenarios` | Historical scenario log |
| `market_stance_logs` | Historical stance log |
| `confidence_logs` | Per-signal 9-component breakdown |
| `portfolio_exposure_snapshots` | Daily sector/strategy exposure history |
| `portfolio_position_correlations` | Rolling correlation cache |
| `portfolio_fit_logs` | Per-signal fit audit trail |
| `strategy_performance` | Win rate by strategy × regime × conviction |
| `signal_quality_events` | Rejection event log |

---

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in DB credentials
npm run db:migrate                  # base tables (users, sessions, instruments...)
npm run db:migrate-intel            # intelligence tables
npm run db:migrate-market           # candle tables
npm run db:migrate-q365             # new Quantorus365 tables + threshold seed
npm run build
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

### First-run after deploy
```bash
# 1. Seed thresholds (if db:migrate-q365 ran, already done)
POST /api/admin  body: { action: "seed_thresholds" }

# 2. Sync instrument master
POST /api/admin  body: { action: "sync_instruments_nse" }

# 3. Sync rankings
POST /api/admin  body: { action: "sync_rankings" }

# 4. Recompute signals
POST /api/admin  body: { action: "recompute_signals", limit: 100 }

# 5. Check quality
GET /api/admin?action=rejection_analysis
GET /api/admin?action=get_stance
```

---

## Final Validation Checklist

- [ ] No external broker references in src/ — instrument master CDN URL is a public unauthenticated feed
- [ ] `grep -r "Quant200" src/` → zero results
- [ ] `grep -r "const MIN_RR\|const MAX_RISK\|const MIN_CONF\|const MIN_DATA" src/services/` → only in systemConfigService.DEFAULTS
- [ ] `system_thresholds` table has 25 rows after migration
- [ ] All engines import from `systemConfigService`, not hardcoding values
- [ ] `signal_rejections.approved=0` rows accumulate during market hours
- [ ] Dashboard shows `market_stance`, `scenario_tag`, `conviction_band`

