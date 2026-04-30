// _cache.js — Vercel KV 캐싱 헬퍼 (KV 없으면 메모리 fallback)
// 환경변수: KV_REST_API_URL, KV_REST_API_TOKEN (Vercel KV 자동 주입)

const memCache = new Map();
const MEM_TTL_MS = 5 * 60 * 1000; // 5분

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_ENABLED = Boolean(KV_URL && KV_TOKEN);

// Vercel KV REST API 호출
async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : null;
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value, ttlSec = 300) {
  if (!KV_ENABLED) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// 메모리 캐시 (Lambda 동안 유효, 콜드 스타트 시 사라짐)
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

// 통합 인터페이스 — KV 우선, 없으면 메모리
async function cacheGet(key) {
  const memHit = memGet(key);
  if (memHit) return { value: memHit, source: 'memory' };
  const kvHit = await kvGet(key);
  if (kvHit) {
    memSet(key, kvHit); // 메모리에도 백업
    return { value: kvHit, source: 'kv' };
  }
  return { value: null, source: null };
}

async function cacheSet(key, value, ttlSec = 300) {
  memSet(key, value, ttlSec * 1000);
  await kvSet(key, value, ttlSec);
}

module.exports = { cacheGet, cacheSet, KV_ENABLED };
