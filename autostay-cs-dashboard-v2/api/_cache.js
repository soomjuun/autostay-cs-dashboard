// Vercel KV 캐시 헬퍼. KV가 없으면 실행 인스턴스의 메모리 캐시만 사용한다.

const memCache = new Map();
const MEM_TTL_MS = 5 * 60 * 1000;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_ENABLED = Boolean(KV_URL && KV_TOKEN);

async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const response = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.result ? JSON.parse(body.result) : null;
  } catch (_) {
    return null;
  }
}

async function kvSet(key, value, ttlSec = 300) {
  if (!KV_ENABLED) return false;
  try {
    const ttlQuery = ttlSec ? `?EX=${ttlSec}` : '';
    const response = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}${ttlQuery}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value, ttlMs = MEM_TTL_MS) {
  memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function cacheGet(key) {
  const memHit = memGet(key);
  if (memHit) return { value: memHit, source: 'memory' };
  const kvHit = await kvGet(key);
  if (kvHit) {
    memSet(key, kvHit);
    return { value: kvHit, source: 'kv' };
  }
  return { value: null, source: null };
}

async function cacheSet(key, value, ttlSec = 300) {
  memSet(key, value, ttlSec * 1000);
  return kvSet(key, value, ttlSec);
}

// 영구 스냅샷은 여러 서버리스 인스턴스가 공유하므로 KV 값을 우선 읽는다.
async function persistentGet(key) {
  if (KV_ENABLED) {
    const kvHit = await kvGet(key);
    if (kvHit) {
      memSet(key, kvHit, 60 * 60 * 1000);
      return { value: kvHit, source: 'kv' };
    }
  }
  const memHit = memGet(key);
  return { value: memHit, source: memHit ? 'memory' : null };
}

async function persistentSet(key, value) {
  const saved = await kvSet(key, value, null);
  if (saved || !KV_ENABLED) memSet(key, value, 60 * 60 * 1000);
  return saved;
}

module.exports = { cacheGet, cacheSet, persistentGet, persistentSet, KV_ENABLED };
