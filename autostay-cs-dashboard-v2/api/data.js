// [OPS] 채널톡 CS 대시보드 — Channel.io API Proxy v4.1
// ─────────────────────────────────────────────────────────────────────────────
// v4.1 (2026-07): 데이터 신뢰성·기간 집계·접근 제어 보강
//   B-1: FRT (First Response Time) — operationWaitingTime 활용
//   B-2: 재오픈/FCR — 목록 API만으로 산출하지 않고 이벤트 적재 필요 상태 표시
//   B-3: 컴플레인 세분화 — 서비스/시스템/가격/탈퇴 4 카테고리
//   B-7: 수집 한도 1000건 (2페이지 × 500, since 커서)
//   D-1: Vercel KV 캐싱 (5분 TTL, KV 없으면 메모리 fallback)
//   고객 반복 문의 (repeat customer) 추적
//   메시지 카운트 분석
//   채널 ID 응답에 포함 (딥링크용)
// ─────────────────────────────────────────────────────────────────────────────

const { cacheGet, cacheSet, persistentGet, persistentSet, KV_ENABLED } = require('./_cache');

const SNAPSHOT_KEY = 'cs:daily-snapshots:v1';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_TAG_PATTERNS = ['파악불가', '미분류', '태그없음', '태그 없음', 'unknown', 'uncategorized'];

function kstDateKey(ts = Date.now()) {
  const d = new Date(ts + KST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function kstDayStartMs(ts = Date.now()) {
  const d = new Date(ts + KST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - KST_OFFSET_MS;
}

function dateKeyFromKstDayOffset(offset, baseTs = Date.now()) {
  return kstDateKey(kstDayStartMs(baseTs) + offset * DAY_MS);
}

function shortDateLabel(dateKey) {
  const [, month, day] = String(dateKey).split('-');
  return `${Number(month)}/${Number(day)}`;
}

function formatTrendLabels(dateKeys) {
  const years = new Set(dateKeys.map((key) => String(key).slice(0, 4)));
  return dateKeys.map((key) => years.size > 1
    ? `${String(key).slice(2, 4)}.${Number(String(key).slice(5, 7))}.${Number(String(key).slice(8, 10))}`
    : shortDateLabel(key));
}

function isUnknownTag(tag) {
  const normalized = String(tag || '').trim().toLowerCase();
  return UNKNOWN_TAG_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function uniqueTags(tags) {
  return Array.from(new Set((Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean)));
}

function classifyVoc(tags) {
  const normalizedTags = uniqueTags(tags);
  const tagText = normalizedTags.join(' ');
  if (normalizedTags.some((tag) => tag.includes('컴플레인'))) return 'complaint';
  if (/정기구독|구독/.test(tagText)) return 'subscribe';
  if (/이용|단순문의|안내/.test(tagText)) return 'inquiry';
  const meaningfulTags = normalizedTags.filter((tag) => !isUnknownTag(tag));
  if (!meaningfulTags.length) return 'unknown';
  return 'other';
}

function compactSnapshot(result) {
  const today = kstDateKey();
  const todayLabel = shortDateLabel(today);
  const trendLabels = result.dailyTrend?.labels || [];
  const trendDateKeys = result.dailyTrend?.dateKeys || [];
  const trendValues = result.dailyTrend?.values || [];
  const complaintValues = result.complaintTrend?.complaints || [];
  const todayIdx = trendDateKeys.length
    ? trendDateKeys.lastIndexOf(today)
    : trendLabels.lastIndexOf(todayLabel);
  const dailyTotal = todayIdx >= 0 ? (trendValues[todayIdx] || 0) : 0;
  const dailyComplaints = todayIdx >= 0 ? (complaintValues[todayIdx] || 0) : 0;
  const windowTotal = result.summary?.totalChats || 0;
  const windowComplaints = (result.complaintTrend?.complaints || []).reduce((a, b) => a + b, 0);
  return {
    date: today,
    capturedAt: result.updatedAt,
    range: result.range,
    dailyTotal,
    dailyComplaints,
    dailyComplaintRate: dailyTotal ? Math.round((dailyComplaints / dailyTotal) * 100) : 0,
    windowTotal,
    windowComplaints,
    openChats: result.summary?.openChats || 0,
    unassignedChats: result.summary?.unassignedChats || 0,
    avgResolutionMin: result.summary?.avgResolutionMin || 0,
    fcrRate: result.fcrStats?.fcrRate ?? null,
    frtMedian: result.frtStats?.median ?? null,
    resolutionSampleN: Object.values(result.resolutionBuckets || {}).reduce((a, b) => a + b, 0),
    unknownTagCount: result.taggingQuality?.unknownCount || 0,
  };
}

async function recordDailySnapshot(result) {
  if (!KV_ENABLED) {
    return { enabled: false, source: 'none', count: 0, firstDate: null, lastDate: null, message: 'Vercel KV 미연결' };
  }
  try {
    const existing = (await persistentGet(SNAPSHOT_KEY)).value || {};
    const byDate = existing.byDate && typeof existing.byDate === 'object' ? existing.byDate : {};
    const snap = compactSnapshot(result);
    byDate[snap.date] = snap;
    const keys = Object.keys(byDate).sort();
    const trimmed = keys.slice(-120).reduce((acc, key) => {
      acc[key] = byDate[key];
      return acc;
    }, {});
    const stored = await persistentSet(SNAPSHOT_KEY, { updatedAt: new Date().toISOString(), byDate: trimmed });
    if (!stored) {
      return { enabled: false, source: 'error', count: 0, firstDate: null, lastDate: null, message: '스냅샷 저장 실패' };
    }
    const dates = Object.keys(trimmed).sort();
    const trend = {
      labels: dates,
      total: dates.map((date) => trimmed[date].dailyTotal || 0),
      complaints: dates.map((date) => trimmed[date].dailyComplaints || 0),
    };
    const compareDays = result.dataNote?.daysParam || 7;
    const currentSlice = trend.total.slice(-compareDays);
    const previousSlice = trend.total.slice(-compareDays * 2, -compareDays);
    const currentTotal = currentSlice.reduce((a, b) => a + b, 0);
    const previousTotal = previousSlice.reduce((a, b) => a + b, 0);
    const last7 = trend.total.slice(-7);
    const prev7 = trend.total.slice(-14, -7);
    const last7Avg = last7.length ? Math.round(last7.reduce((a, b) => a + b, 0) / last7.length) : 0;
    const prev7Avg = prev7.length ? Math.round(prev7.reduce((a, b) => a + b, 0) / prev7.length) : 0;
    return {
      enabled: true,
      source: 'kv',
      count: dates.length,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      message: dates.length >= 14 ? '스냅샷 기준 추세 비교 가능' : '스냅샷 누적 중',
      trend,
      snapshotWow: {
        currentTotal,
        previousTotal,
        delta: currentTotal - previousTotal,
        deltaPct: previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 100) : null,
      },
      snapshotForecast: {
        last7Avg,
        last14Avg: prev7Avg,
        momentum: prev7Avg > 0 ? Math.round(((last7Avg - prev7Avg) / prev7Avg) * 100) : 0,
        nextDayProjection: last7Avg,
      },
    };
  } catch (e) {
    return { enabled: false, source: 'error', count: 0, firstDate: null, lastDate: null, message: '스냅샷 저장 실패' };
  }
}

// ── 쿠키 파싱 ─────────────────────────────────────────────────────────────
function parseCookie(str) {
  const out = {};
  (str || '').split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    if (!k) return;
    try {
      out[k.trim()] = decodeURIComponent(v.join('='));
    } catch (_) {
      out[k.trim()] = v.join('=');
    }
  });
  return out;
}

// ── retry-aware fetch ────────────────────────────────────────────────────
async function safeFetch(url, opts, label) {
  const t0 = Date.now();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`${label}: HTTP ${r.status}`);
        await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
        continue;
      }
      const ms = Date.now() - t0;
      let data = null;
      try { data = await r.json(); } catch (e) {}
      return { ok: r.ok, status: r.status, ms, data, label };
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
    }
  }
  return { ok: false, status: 0, ms: Date.now() - t0, data: null, error: String(lastErr), label };
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return Math.round(sorted[idx]);
}

function detectAnomalies(values) {
  if (values.length < 14) return [];
  const sorted = values.slice().sort((a, b) => a - b);
  const q1 = pct(sorted, 0.25);
  const q3 = pct(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) return [];
  const lower = Math.max(0, q1 - 1.5 * iqr);
  const upper = q3 + 1.5 * iqr;
  return values.map((v, i) => ({
    idx: i,
    val: v,
    lower: Math.round(lower * 10) / 10,
    upper: Math.round(upper * 10) / 10,
    isHigh: v > upper,
    isLow: v < lower,
  })).filter((d) => d.isHigh || d.isLow);
}

// ── 컴플레인 세분화 분류 ────────────────────────────────────────────────
function classifyComplaint(tags) {
  const tagStr = (tags || []).join(' ');
  if (/요금|가격|환불|취소|결제|할인|불만/.test(tagStr) && tagStr.includes('컴플레인')) return 'pricing';
  if (/이용불가|시스템|오류|버그|앱|로그인|접속/.test(tagStr)) return 'system';
  if (/탈퇴|해지/.test(tagStr)) return 'churn';
  if (/응대|직원|매장|세차|품질|불친절/.test(tagStr) && tagStr.includes('컴플레인')) return 'service';
  if (tagStr.includes('컴플레인')) return 'other';
  return null;
}

module.exports = async function handler(req, res) {
  // ── 인증 게이트 ─────────────────────────────────────────────────────
  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
  if (!DASHBOARD_TOKEN) {
    return res.status(503).json({ error: 'Dashboard authentication is not configured' });
  }
  const cookieKey = process.env.COOKIE_KEY || 'ds_auth';
  const cookie = parseCookie(req.headers.cookie);
  if (cookie[cookieKey] !== DASHBOARD_TOKEN) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(401).json({ error: 'Unauthorized', redirect: '/api/auth' });
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const ACCESS_KEY = process.env.CHANNEL_ACCESS_KEY;
  const ACCESS_SECRET = process.env.CHANNEL_ACCESS_SECRET;
  if (!ACCESS_KEY || !ACCESS_SECRET) {
    return res.status(500).json({
      error: 'Channel Talk credentials not configured',
      hint: 'Vercel 환경변수에 CHANNEL_ACCESS_KEY, CHANNEL_ACCESS_SECRET 설정 필요',
    });
  }
  const BASE = 'https://api.channel.io/open/v5';

  const daysParam = req.query && req.query.days;
  const allowedDays = new Set(['7', '14', '30', 'all']);
  const normalizedDaysParam = !daysParam ? '7' : String(daysParam);
  if (!allowedDays.has(normalizedDaysParam)) {
    return res.status(400).json({ error: 'Invalid days parameter', allowed: Array.from(allowedDays) });
  }
  const days = normalizedDaysParam === 'all' ? null : Number(normalizedDaysParam);
  const skipCache = req.query && req.query.fresh === '1';

  const getKstParts = (ts) => {
    const d = new Date(ts + KST_OFFSET_MS);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      weekday: d.getUTCDay(),
      hour: d.getUTCHours(),
    };
  };

  const startedAt = Date.now();
  const diagnostics = { calls: [], warnings: [], cacheHit: false, kvEnabled: KV_ENABLED };

  // ── KV 캐싱 — 동일 days 파라미터로 5분 캐시 ──────────────────────────
  const cacheKey = `cs-dashboard:${days || 'all'}`;
  if (!skipCache) {
    const hit = await cacheGet(cacheKey);
    if (hit.value) {
      diagnostics.cacheHit = true;
      diagnostics.cacheSource = hit.source;
      // 캐시 응답에 진단 업데이트
      const cached = hit.value;
      cached.diagnostics = { ...cached.diagnostics, cacheHit: true, cacheSource: hit.source, totalMs: Date.now() - startedAt };
      return res.json(cached);
    }
  }

  const epoch = Date.now().toString();
  const headers = {
    'x-access-key': ACCESS_KEY,
    'x-access-secret': ACCESS_SECRET,
    'x-request-at': epoch,
    'Content-Type': 'application/json',
  };

  try {
    // ── 메타 데이터 병렬 조회 ────────────────────────────────────────
    const [channelR, managersR, openR, groupsR, botsR] = await Promise.all([
      safeFetch(`${BASE}/channel`, { headers }, 'channel'),
      safeFetch(`${BASE}/managers?limit=500&sortField=name`, { headers }, 'managers'),
      safeFetch(`${BASE}/user-chats?limit=500&state=opened&sortOrder=desc`, { headers }, 'open-chats'),
      safeFetch(`${BASE}/groups`, { headers }, 'groups'),
      safeFetch(`${BASE}/bots`, { headers }, 'bots'),
    ]);

    [channelR, managersR, openR, groupsR, botsR].forEach((r) => {
      diagnostics.calls.push({ label: r.label, ok: r.ok, status: r.status, ms: r.ms });
      if (!r.ok) diagnostics.warnings.push(`${r.label} 실패 (${r.status})`);
    });

    const channelData = channelR.data || {};
    const managersData = managersR.data || {};
    const openData = openR.data || {};
    const groupsData = groupsR.data || {};
    const botsData = botsR.data || {};

    // Channel Open API v5: limit 최대 500, 응답 next 값은 since로 전달
    const PAGE_SIZE = 500;
    const MAX_PAGES = 2;
    const HARD_LIMIT = PAGE_SIZE * MAX_PAGES;
    let allChats = [];
    let nextCursor = null;
    let pageCount = 0;
    let rawFetched = 0;
    let paginationLoopDetected = false;
    const seenCursors = new Set();
    const pageT0 = Date.now();

    for (let page = 0; page < MAX_PAGES && allChats.length < HARD_LIMIT; page++) {
      if (Date.now() - startedAt > 25000) {
        diagnostics.warnings.push(`pagination timeout at page ${page}`);
        break;
      }
      const url = nextCursor
        ? `${BASE}/user-chats?limit=${PAGE_SIZE}&state=closed&sortOrder=desc&since=${encodeURIComponent(nextCursor)}`
        : `${BASE}/user-chats?limit=${PAGE_SIZE}&state=closed&sortOrder=desc`;
      const r = await safeFetch(url, { headers }, `closed-page-${page + 1}`);
      diagnostics.calls.push({ label: r.label, ok: r.ok, status: r.status, ms: r.ms });
      if (!r.ok) {
        diagnostics.warnings.push(`closed page ${page + 1} 실패 (${r.status})`);
        break;
      }
      const chats = (r.data && r.data.userChats) || [];
      if (!chats.length) break;
      rawFetched += chats.length;
      allChats = allChats.concat(chats);
      pageCount = page + 1;
      const next = r.data.next || null;
      if (next && seenCursors.has(next)) {
        paginationLoopDetected = true;
        diagnostics.warnings.push(`pagination cursor repeated at page ${page + 1}`);
        nextCursor = next;
        break;
      }
      if (next) seenCursors.add(next);
      nextCursor = next;
      if (!nextCursor) break;
    }
    diagnostics.paginationMs = Date.now() - pageT0;
    diagnostics.pages = pageCount;

    // dedup
    const seenIds = new Set();
    const beforeDedupCount = allChats.length;
    allChats = allChats.filter((c) => {
      const key = c.id || (c.createdAt + '-' + (c.assigneeId || 'X'));
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });
    const duplicatesRemoved = beforeDedupCount - allChats.length;

    const currentPeriodStartMs = days ? kstDayStartMs() - (days - 1) * DAY_MS : null;
    const previousPeriodStartMs = days ? currentPeriodStartMs - days * DAY_MS : null;
    const cutoffMs = currentPeriodStartMs;
    const periodTimestamp = (c) => c.closedAt || c.updatedAt || c.createdAt || null;
    const collectedTimes = allChats.map(periodTimestamp).filter(Number.isFinite);
    const oldestCollectedAt = collectedTimes.length ? Math.min(...collectedTimes) : null;
    const newestCollectedAt = collectedTimes.length ? Math.max(...collectedTimes) : null;
    const hitHardLimit = allChats.length >= HARD_LIMIT;
    const hasMore = Boolean(nextCursor) && (hitHardLimit || paginationLoopDetected);
    const currentPeriodComplete = !days || !hasMore || (oldestCollectedAt != null && oldestCollectedAt <= currentPeriodStartMs);
    const baselineComplete = !days || !hasMore || (oldestCollectedAt != null && oldestCollectedAt <= previousPeriodStartMs);

    // ── 컨테이너 ───────────────────────────────────────────────────
    const dayCounts = {};
    const dayCountsPrev = {};
    if (days) {
      for (let i = days - 1; i >= 0; i--) {
        dayCounts[dateKeyFromKstDayOffset(-i)] = 0;
      }
      for (let i = days * 2 - 1; i >= days; i--) {
        dayCountsPrev[dateKeyFromKstDayOffset(-i)] = 0;
      }
    }

    const heatmapData = {};
    const tagCounts = {};
    const sourceCounts = { native: 0, phone: 0, other: 0 };
    const resBuckets = { '0~5분': 0, '5~30분': 0, '30분~2시간': 0, '2~8시간': 0, '8시간+': 0 };
    const mgrCounts = {};
    const mgrResTimes = {};
    const mgrFrtTimes = {};            // B-1: 담당자별 FRT
    const mgrTagCounts = {};
    const mgrComplaintCounts = {};
    const resTimes = [];
    const frtTimes = [];               // B-1: 전체 FRT 배열
    const longChats = [];
    const longChatSeenIds = new Set();
    const peakDayData = {};
    let processed = 0;
    let unassigned = 0;
    let processedMinAt = Infinity;
    let processedMaxAt = -Infinity;

    const hourLoad = Array(24).fill(0);
    const weekdayLoad = Array(7).fill(0);
    const workingHoursStats = { businessIn: 0, businessOut: 0 };
    const tagResolutions = {};
    const tagCooccur = {};
    const sourceResolutions = { native: [], phone: [], other: [] };
    const sourceTagCounts = { native: {}, phone: {}, other: {} };
    const dailyComplaints = {};
    const dailySources = {};
    const agingBuckets = { lt8h: 0, h8_24: 0, d1_3: 0, d3_7: 0, d7plus: 0 };

    // B-2 재오픈 추적
    const userChatCount = {};          // userId → 채팅 수 (반복 문의)
    let unknownChatCount = 0;
    let noTagChatCount = 0;
    const vocCategories = { unknown: 0, complaint: 0, subscribe: 0, inquiry: 0, other: 0 };

    // B-3 컴플레인 세분화
    const complaintCategories = {
      service: 0, system: 0, pricing: 0, churn: 0, other: 0
    };
    const complaintCategoryDaily = {}; // {dayKey: {service, system, ...}}
    const getPeriodTs = periodTimestamp;

    // ── 채팅 처리 ──────────────────────────────────────────────────
    for (const c of allChats) {
      const periodTs = getPeriodTs(c);
      if (!periodTs) continue;
      if (cutoffMs && periodTs < cutoffMs) {
        if (days && periodTs >= previousPeriodStartMs) {
          const k = kstDateKey(periodTs);
          if (k in dayCountsPrev) dayCountsPrev[k]++;
        }
        continue;
      }
      processed++;
      if (periodTs < processedMinAt) processedMinAt = periodTs;
      if (periodTs > processedMaxAt) processedMaxAt = periodTs;

      if (!c.assigneeId) unassigned++;

      // B-2: 반복 문의
      if (c.userId) {
        userChatCount[c.userId] = (userChatCount[c.userId] || 0) + 1;
      }

      const dateParts = getKstParts(periodTs);
      const dayKey = kstDateKey(periodTs);
      if (!(dayKey in dayCounts)) dayCounts[dayKey] = 0;
      dayCounts[dayKey]++;

      const rawDay = dateParts.weekday;
      const wd = rawDay === 0 ? 6 : rawDay - 1;
      const hr = dateParts.hour;
      heatmapData[`${wd}-${hr}`] = (heatmapData[`${wd}-${hr}`] || 0) + 1;
      hourLoad[hr]++;
      weekdayLoad[wd]++;

      if (wd <= 4 && hr >= 9 && hr < 19) workingHoursStats.businessIn++;
      else workingHoursStats.businessOut++;

      if (!peakDayData[dayKey]) peakDayData[dayKey] = {
        tags: {}, assignees: {}, hours: {}, sources: { native: 0, phone: 0, other: 0 }, longCount: 0,
      };
      peakDayData[dayKey].hours[hr] = (peakDayData[dayKey].hours[hr] || 0) + 1;
      if (c.assigneeId) peakDayData[dayKey].assignees[c.assigneeId] = (peakDayData[dayKey].assignees[c.assigneeId] || 0) + 1;

      const rawTags = uniqueTags(c.tags);
      const hasComplaint = rawTags.some((tag) => tag.includes('컴플레인'));
      const hasUnknownTag = rawTags.some(isUnknownTag);
      if (hasUnknownTag) unknownChatCount++;
      if (!rawTags.length) noTagChatCount++;
      vocCategories[classifyVoc(rawTags)]++;
      for (const tag of rawTags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        peakDayData[dayKey].tags[tag] = (peakDayData[dayKey].tags[tag] || 0) + 1;
      }
      if (hasComplaint) {
        const exactExists = rawTags.some((t) => t === '컴플레인');
        if (!exactExists) tagCounts['컴플레인(전체)'] = (tagCounts['컴플레인(전체)'] || 0) + 1;
      }
      if (hasComplaint) {
        dailyComplaints[dayKey] = (dailyComplaints[dayKey] || 0) + 1;

        // B-3: 컴플레인 세분화
        const cat = classifyComplaint(rawTags);
        if (cat) {
          complaintCategories[cat]++;
          if (!complaintCategoryDaily[dayKey]) complaintCategoryDaily[dayKey] = { service: 0, system: 0, pricing: 0, churn: 0, other: 0 };
          complaintCategoryDaily[dayKey][cat]++;
        }
        if (c.assigneeId) {
          mgrComplaintCounts[c.assigneeId] = (mgrComplaintCounts[c.assigneeId] || 0) + 1;
        }
      }

      for (let i = 0; i < rawTags.length; i++) {
        for (let j = i + 1; j < rawTags.length; j++) {
          const key = [rawTags[i], rawTags[j]].sort().join('||');
          tagCooccur[key] = (tagCooccur[key] || 0) + 1;
        }
      }

      const medium = c.contactMediumType
        || c.source?.medium?.mediumType
        || c.source?.medium
        || c.source?.type
        || 'other';
      let srcKey = 'other';
      if (medium === 'native') { sourceCounts.native++; peakDayData[dayKey].sources.native++; srcKey = 'native'; }
      else if (medium === 'phone') { sourceCounts.phone++; peakDayData[dayKey].sources.phone++; srcKey = 'phone'; }
      else { sourceCounts.other++; peakDayData[dayKey].sources.other++; srcKey = 'other'; }
      if (!dailySources[dayKey]) dailySources[dayKey] = { native: 0, phone: 0, other: 0 };
      dailySources[dayKey][srcKey]++;
      for (const tag of rawTags) {
        sourceTagCounts[srcKey][tag] = (sourceTagCounts[srcKey][tag] || 0) + 1;
      }

      // B-1: FRT 측정 (operationWaitingTime이 있으면 사용 — 채널톡 제공 필드)
      const frtMs = Number(c.operationWaitingTime);
      if (Number.isFinite(frtMs) && frtMs >= 0) {
        const frtMin = frtMs / 1000 / 60;
        frtTimes.push(frtMin);
        if (c.assigneeId) {
          if (!mgrFrtTimes[c.assigneeId]) mgrFrtTimes[c.assigneeId] = [];
          mgrFrtTimes[c.assigneeId].push(frtMin);
        }
      }

      const resTime = Number(c.resolutionTime);
      if (Number.isFinite(resTime) && resTime >= 0) {
        const mins = resTime / 1000 / 60;
        resTimes.push(mins);
        if (mins < 5) resBuckets['0~5분']++;
        else if (mins < 30) resBuckets['5~30분']++;
        else if (mins < 120) resBuckets['30분~2시간']++;
        else if (mins < 480) resBuckets['2~8시간']++;
        else {
          resBuckets['8시간+']++;
          peakDayData[dayKey].longCount = (peakDayData[dayKey].longCount || 0) + 1;
          const chatKey = c.id || `${dayKey}-${c.assigneeId || 'X'}-${Math.round(mins)}`;
          if (!longChatSeenIds.has(chatKey) && longChats.length < 100) {
            longChatSeenIds.add(chatKey);
            longChats.push({
              id: c.id || null,         // C-1: 딥링크용
              date: dayKey,
              tags: rawTags,
              assigneeId: c.assigneeId || null,
              resolutionMin: Math.round(mins),
              source: srcKey,
              createdAt: c.createdAt,
              periodAt: periodTs,
            });
          }
        }

        if (mins < 480) agingBuckets.lt8h++;
        else if (mins < 1440) agingBuckets.h8_24++;
        else if (mins < 4320) agingBuckets.d1_3++;
        else if (mins < 10080) agingBuckets.d3_7++;
        else agingBuckets.d7plus++;

        if (c.assigneeId) {
          if (!mgrResTimes[c.assigneeId]) mgrResTimes[c.assigneeId] = [];
          mgrResTimes[c.assigneeId].push(mins);
        }
        for (const tag of rawTags) {
          if (!tagResolutions[tag]) tagResolutions[tag] = [];
          tagResolutions[tag].push(mins);
        }
        sourceResolutions[srcKey].push(mins);
      }

      if (c.assigneeId) {
        mgrCounts[c.assigneeId] = (mgrCounts[c.assigneeId] || 0) + 1;
        if (!mgrTagCounts[c.assigneeId]) mgrTagCounts[c.assigneeId] = {};
        for (const tag of rawTags) mgrTagCounts[c.assigneeId][tag] = (mgrTagCounts[c.assigneeId][tag] || 0) + 1;
      }
    }

    // 전체 기간도 상담이 없었던 날짜를 0건으로 채워 추세 축이 연속되도록 함.
    if (!days && Number.isFinite(processedMinAt) && Number.isFinite(processedMaxAt)) {
      const firstDayMs = kstDayStartMs(processedMinAt);
      const lastDayMs = kstDayStartMs(processedMaxAt);
      for (let dayMs = firstDayMs; dayMs <= lastDayMs; dayMs += DAY_MS) {
        const key = kstDateKey(dayMs);
        if (!(key in dayCounts)) dayCounts[key] = 0;
      }
    }

    // ── trim & 분석 ────────────────────────────────────────────────
    const trendDateKeys = Object.keys(dayCounts).sort();
    const trendDayCounts = Object.fromEntries(trendDateKeys.map((key) => [key, dayCounts[key]]));
    const trendLabels = formatTrendLabels(trendDateKeys);

    const peakEntry = Object.entries(trendDayCounts).sort((a, b) => b[1] - a[1])[0];
    let peakAnalysis = null;
    if (peakEntry && peakEntry[1] > 0) {
      const pk = peakDayData[peakEntry[0]];
      if (pk) {
        const topTags3 = Object.entries(pk.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => ({ tag: e[0], cnt: e[1] }));
        const topAssignees3 = Object.entries(pk.assignees || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => ({ id: e[0], cnt: e[1] }));
        const peakHourEntry = Object.entries(pk.hours || {}).sort((a, b) => b[1] - a[1])[0];
        const pkTotal = peakEntry[1] || 1;
        const pkSrc = pk.sources || {};
        peakAnalysis = {
          date: shortDateLabel(peakEntry[0]), count: peakEntry[1],
          topTags: topTags3, topAssignees: topAssignees3,
          peakHour: peakHourEntry ? { hour: parseInt(peakHourEntry[0]), cnt: peakHourEntry[1] } : null,
          sources: { native: pkSrc.native || 0, phone: pkSrc.phone || 0, other: pkSrc.other || 0 },
          longChatRate: pkTotal > 0 ? Math.round(((pk.longCount || 0) / pkTotal) * 100) : 0,
        };
      }
    }

    // 담당자 통계 (FRT 포함)
    const managers = (managersData.managers || [])
      .filter((m) => !m.removed)
      .map((m) => {
        const mTimes = mgrResTimes[m.id] || [];
        const mFrt = mgrFrtTimes[m.id] || [];
        const mAvgRes = mTimes.length ? Math.round(mTimes.reduce((a, b) => a + b, 0) / mTimes.length) : null;
        const mAvgFrt = mFrt.length ? Math.round(mFrt.reduce((a, b) => a + b, 0) / mFrt.length) : null;
        const mTags = mgrTagCounts[m.id] || {};
        const topTags = Object.entries(mTags).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag, cnt]) => ({ tag, cnt }));
        return {
          id: m.id, name: m.name,
          operatorScore: Math.round((m.operatorScore || 0) * 10) / 10,
          touchScore: Math.round((m.touchScore || 0) * 10) / 10,
          count: mgrCounts[m.id] || 0,
          avgResolutionMin: mAvgRes,
          medianResolutionMin: pct(mTimes, 0.5),
          p90ResolutionMin: pct(mTimes, 0.9),
          avgFrtMin: mAvgFrt,                             // B-1
          medianFrtMin: pct(mFrt, 0.5),                   // B-1
          topTags, complaintHandled: mgrComplaintCounts[m.id] || 0,
        };
      })
      .sort((a, b) => b.count - a.count);

    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const tagResStats = Object.entries(tagResolutions)
      .filter(([, arr]) => arr.length >= 2)
      .map(([tag, arr]) => ({
        tag, count: arr.length,
        avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
        median: pct(arr, 0.5), p90: pct(arr, 0.9),
      }))
      .sort((a, b) => b.count - a.count).slice(0, 10);
    const tagCooccurTop = Object.entries(tagCooccur)
      .map(([k, v]) => ({ pair: k.split('||'), cnt: v }))
      .sort((a, b) => b.cnt - a.cnt).slice(0, 8);
    const sourceStats = ['native', 'phone', 'other'].map((src) => {
      const arr = sourceResolutions[src];
      const tags = Object.entries(sourceTagCounts[src] || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => ({ tag: t, cnt: c }));
      return {
        source: src, count: sourceCounts[src],
        avgResolutionMin: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null,
        medianResolutionMin: pct(arr, 0.5), p90ResolutionMin: pct(arr, 0.9), topTags: tags,
      };
    });

    const avgRes = resTimes.length ? Math.round(resTimes.reduce((a, b) => a + b, 0) / resTimes.length) : 0;
    const medianRes = pct(resTimes, 0.5);
    const p75Res = pct(resTimes, 0.75);
    const p90Res = pct(resTimes, 0.9);
    const p95Res = pct(resTimes, 0.95);
    const timesEx8h = resTimes.filter((t) => t < 480);
    const avgEx8h = timesEx8h.length ? Math.round(timesEx8h.reduce((a, b) => a + b, 0) / timesEx8h.length) : null;
    // B-1: FRT 통계
    const frtStats = frtTimes.length ? {
      avg: Math.round(frtTimes.reduce((a, b) => a + b, 0) / frtTimes.length),
      median: pct(frtTimes, 0.5),
      p90: pct(frtTimes, 0.9),
      sla5min: { count: frtTimes.filter((t) => t <= 5).length, total: frtTimes.length },
      sla30min: { count: frtTimes.filter((t) => t <= 30).length, total: frtTimes.length },
    } : null;
    if (frtStats) {
      frtStats.sla5min.rate = frtStats.sla5min.total > 0 ? Math.round((frtStats.sla5min.count / frtStats.sla5min.total) * 100) : 0;
      frtStats.sla30min.rate = frtStats.sla30min.total > 0 ? Math.round((frtStats.sla30min.count / frtStats.sla30min.total) * 100) : 0;
    }

    // 목록 API에는 상태 전환 이력이 없어 재오픈/FCR을 신뢰성 있게 계산할 수 없음
    const fcrStats = {
      available: false,
      reopenedCount: null,
      reopenedRate: null,
      fcrRate: null,
      note: 'UserChat 목록 응답에는 종결 후 재오픈 상태 전환 이력이 없어 FCR을 산출하지 않습니다. 웹훅 또는 상태 이벤트 적재가 필요합니다.',
    };

    // B-2: 반복 문의 고객
    const repeatCustomers = Object.values(userChatCount).filter((c) => c >= 2).length;
    const totalCustomers = Object.keys(userChatCount).length;
    const repeatStats = {
      total: totalCustomers,
      repeat: repeatCustomers,
      repeatRate: totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 100) : 0,
      avgChatsPerCustomer: totalCustomers > 0 ? Math.round((processed / totalCustomers) * 10) / 10 : 0,
    };

    const slaStats = {
      sla30Min: { count: resTimes.filter((t) => t <= 30).length, total: resTimes.length },
      sla2Hour: { count: resTimes.filter((t) => t <= 120).length, total: resTimes.length },
      sla8Hour: { count: resTimes.filter((t) => t <= 480).length, total: resTimes.length },
    };
    Object.keys(slaStats).forEach((k) => {
      const s = slaStats[k];
      s.rate = s.total > 0 ? Math.round((s.count / s.total) * 100) : 0;
    });

    const totalCurr = processed;
    const totalPrev = days ? Object.values(dayCountsPrev).reduce((a, b) => a + b, 0) : null;
    const wow = (days && totalPrev != null) ? {
      currentTotal: totalCurr, previousTotal: totalPrev,
      delta: totalCurr - totalPrev,
      deltaPct: totalPrev > 0 ? Math.round(((totalCurr - totalPrev) / totalPrev) * 100) : null,
      baselineComplete,
    } : null;

    const complaintTrend = {
      labels: trendLabels,
      total: Object.values(trendDayCounts),
      complaints: trendDateKeys.map((k) => dailyComplaints[k] || 0),
    };

    // B-3: 컴플레인 세분화 일별
    const complaintCategoryTrend = {
      labels: trendLabels,
      service: trendDateKeys.map((k) => (complaintCategoryDaily[k] || {}).service || 0),
      system: trendDateKeys.map((k) => (complaintCategoryDaily[k] || {}).system || 0),
      pricing: trendDateKeys.map((k) => (complaintCategoryDaily[k] || {}).pricing || 0),
      churn: trendDateKeys.map((k) => (complaintCategoryDaily[k] || {}).churn || 0),
      other: trendDateKeys.map((k) => (complaintCategoryDaily[k] || {}).other || 0),
    };

    const anomalies = detectAnomalies(Object.values(trendDayCounts)).map((a) => ({
      ...a, label: trendLabels[a.idx],
    }));

    const trendVals = Object.values(trendDayCounts);
    const last7 = trendVals.slice(-7);
    const last7Avg = last7.length ? Math.round(last7.reduce((a, b) => a + b, 0) / last7.length) : 0;
    const last14 = trendVals.slice(-14, -7);
    const last14Avg = last14.length ? Math.round(last14.reduce((a, b) => a + b, 0) / last14.length) : 0;
    const forecast = {
      last7Avg, last14Avg,
      momentum: last14Avg > 0 ? Math.round(((last7Avg - last14Avg) / last14Avg) * 100) : 0,
      nextDayProjection: last7Avg,
    };

    const openChats = openData.userChats || [];
    // 미배정 집계 기준: 현재 오픈(진행 중) 상담 중 담당자(assigneeId)가 없는 건
    // → Channel Talk 인박스 "미배정" 필터와 동일한 기준 (종결 채팅 제외)
    // unassigned(구 변수): 종결 채팅 기준 집계이므로 사용하지 않음
    const openUnassigned = openChats.filter((c) => !c.assigneeId).length;
    const channelInfo = channelData.channel || {};

    const result = {
      updatedAt: new Date().toISOString(),
      range: days ? `${days}d` : 'all',
      diagnostics: {
        totalMs: Date.now() - startedAt,
        paginationMs: diagnostics.paginationMs,
        pages: diagnostics.pages,
        pageSize: PAGE_SIZE,
        rawFetched,
        duplicatesRemoved,
        paginationLoopDetected,
        warnings: diagnostics.warnings,
        callTiming: diagnostics.calls,
        anyFailure: diagnostics.warnings.length > 0,
        cacheHit: false,
        kvEnabled: KV_ENABLED,
      },
      dataNote: {
        collected: allChats.length,
        rawFetched,
        duplicatesRemoved,
        processed,
        limit: HARD_LIMIT,
        isSampled: hasMore,
        hasMore,
        paginationLoopDetected,
        currentPeriodComplete,
        baselineComplete,
        oldestCollectedAt,
        newestCollectedAt,
        processedMinAt: processedMinAt === Infinity ? null : processedMinAt,
        processedMaxAt: processedMaxAt === -Infinity ? null : processedMaxAt,
        daysParam: days,
        periodBasis: 'closedAt 우선 (없으면 updatedAt, createdAt)',
        periodTimezone: 'Asia/Seoul',
        periodWindow: days ? `KST calendar days (${days})` : 'latest chats up to limit',
        openChatsSampled: Boolean(openData.next),
      },
      channel: { name: channelInfo.name || '오토스테이 CS', id: channelInfo.id || null },
      summary: {
        totalChats: processed,
        openChats: openChats.length,
        unassignedChats: openUnassigned,
        avgResolutionMin: avgRes,
        peakDay: peakEntry ? { label: shortDateLabel(peakEntry[0]), count: peakEntry[1] } : null,
      },
      resolutionStats: {
        avg: avgRes, median: medianRes, p75: p75Res, p90: p90Res, p95: p95Res, avgEx8h,
        agentHandleTimeAvailable: false,
        agentHandleTimeNote: 'Channel Talk chat list 응답에는 고객 미응답 구간을 제거할 이벤트/메시지 타임라인이 포함되지 않아 순수 상담원 처리시간은 별도 메시지 수집 API가 필요합니다.',
      },
      taggingQuality: {
        unknownCount: unknownChatCount,
        unknownRate: processed > 0 ? Math.round((unknownChatCount / processed) * 100) : 0,
        noTagCount: noTagChatCount,
        unit: 'unique chats',
        autoTaggingAvailable: false,
        blocker: '현재 API 응답에는 상담 본문 텍스트가 없어 LLM 본문 자동분류를 실행할 수 없습니다. user-chat 메시지 본문 수집 후 서버 분류 파이프라인이 필요합니다.',
      },
      frtStats,                                  // B-1: FRT 통계
      fcrStats,                                  // B-2: FCR
      repeatStats,                               // B-2: 반복 문의
      vocCategories,                             // 채팅 단위 배타 분류
      complaintCategories,                       // B-3: 컴플레인 세분화 합계
      complaintCategoryTrend,                    // B-3: 일별 추이
      slaStats,
      dailyTrend: { labels: trendLabels, dateKeys: trendDateKeys, values: Object.values(trendDayCounts) },
      complaintTrend, anomalies, forecast, wow,
      tags: { labels: topTags.map((t) => t[0]), values: topTags.map((t) => t[1]) },
      tagResolutionStats: tagResStats,
      tagCooccurrence: tagCooccurTop,
      sources: sourceCounts, sourceStats,
      resolutionBuckets: resBuckets, agingBuckets,
      heatmap: heatmapData, hourLoad, weekdayLoad, workingHoursStats,
      managers,
      groupCount: (groupsData.groups || []).length,
      bots: (botsData.bots || []).map((b) => ({ name: b.name })),
      longChats, peakAnalysis,
      openChatList: openChats.slice(0, 50).map((c) => ({  // C-1: 미배정 딥링크용
        id: c.id || null,
        userId: c.userId || null,
        assigneeId: c.assigneeId || null,
        tags: c.tags || [],
        createdAt: c.createdAt,
      })),
    };

    result.snapshotStore = await recordDailySnapshot(result);
    if (result.snapshotStore.trend) result.snapshotTrend = result.snapshotStore.trend;
    if (result.snapshotStore.snapshotWow) result.snapshotWow = result.snapshotStore.snapshotWow;
    if (result.snapshotStore.snapshotForecast) result.snapshotForecast = result.snapshotStore.snapshotForecast;

    // ── 캐시 저장 (5분 TTL) ──────────────────────────────────────
    // 강제 갱신도 최신 응답을 저장해야 이후 일반 조회가 과거 캐시로 되돌아가지 않는다.
    await cacheSet(cacheKey, result, 300);

    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'Dashboard data request failed',
      diagnostics, elapsedMs: Date.now() - startedAt,
    });
  }
};
