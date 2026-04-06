import Redis from 'ioredis';

let redis: Redis | null = null;
let redisFailed = false;

function getRedis(): Redis | null {
  if (redisFailed) return null;
  if (!redis) {
    try {
      redis = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        retryStrategy: (times) => (times > 3 ? null : 1000),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      redis.on('error', () => {
        if (!redisFailed) {
          redisFailed = true;
          console.warn('[Redis] Unavailable — using database only. Install Redis for caching: brew install redis');
        }
      });
    } catch {
      redisFailed = true;
      return null;
    }
  }
  return redis;
}

// ── Typed helpers (graceful fallback when Redis unavailable) ───────
export async function cacheSet(key: string, data: unknown, ttl?: number) {
  const r = getRedis();
  if (!r) return;
  try {
    const val = JSON.stringify(data);
    if (ttl) await r.setex(key, ttl, val);
    else await r.set(key, val);
  } catch {
    redisFailed = true;
  }
}

export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const val = await r.get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    redisFailed = true;
    return null;
  }
}

export async function cacheDel(key: string) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    redisFailed = true;
  }
}

export async function setTick(instrumentKey: string, data: unknown, ttl = 60) {
  await cacheSet(`tick:${instrumentKey}`, data, ttl);
}

export async function getTick<T = unknown>(instrumentKey: string): Promise<T | null> {
  return cacheGet<T>(`tick:${instrumentKey}`);
}

export async function setQuote(instrumentKey: string, data: unknown, ttl = 15) {
  await cacheSet(`quote:${instrumentKey}`, data, ttl);
}

export async function getQuote<T = unknown>(instrumentKey: string): Promise<T | null> {
  return cacheGet<T>(`quote:${instrumentKey}`);
}
