// [OPS] 채널톡 CS 대시보드 — Channel.io API Proxy v4.0
// ─────────────────────────────────────────────────────────────────────────────
// v4.0 (2026-04): 고도화 9종 통합
//   B-1: FRT (First Response Time) — operationWaitingTime, firstAssigneeId 활용
//   B-2: 재오픈/FCR — state 전환 + reopened 추적
//   B-3: 컴플레인 세분화 — 서비스/시스템/가격/탈퇴 4 카테고리
//   B-7: 수집 한도 1000건 (10페이지 × 100)
//   D-1: Vercel KV 캐싱 (5분 TTL, KV 없으면 메모리 fallback)
//   고객 반복 문의 (repeat customer) 추적
//   메시지 카운트 분석
//   채널 ID 응답에 포함 (딥링크용)
// ─────────────────────────────────────────────────────────────────────────────

const { cacheGet, cacheSet, KV_ENABLED } = require('./_cache');

// ── 쿠키 파싱 ─────────────────────────────────────────────────────────────
function parseCookie(str) {
  const out = {};
  (str || '').split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
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
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return Math.round(sorted[idx]);
}

function detectAnomalies(values) {
  if (values.length < 5) return [];
  const nonZero = values.filter((v) => v > 0);
  if (nonZero.length < 5) return [];
  const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
  const variance = nonZero.reduce((a, b) => a + (b - mean) ** 2, 0) / nonZero.length;
  const sd = Math.sqrt(variance) || 1;
  return values.map((v, i) => ({
    idx: i, val: v, z: (v - mean) / sd,
    isHigh: v > 0 && (v - mean) / sd >= 1.8,
    isLow: v > 0 && (v - mean) / sd <= -1.8,
  })).filter((d) => d.isHigh || d.isLow);
}

// ── 컴플레인 세분화 분류 ────────────────────────────────────────────────
function classifyComplaint(tags) {
  const tagStr = (tags || []).join(' ');
  if (/이용불가|시스템|오류|버그|결제|앱|로그인|접속/.test(tagStr)) return 'system';
  if (/요금|가격|환불|취소|결제|할인|불만/.test(tagStr) && tagStr.includes('컴플레인')) return 'pricing';
  if (/탈퇴|해지/.test(tagStr)) return 'churn';
  if (/응대|직원|매장|세차|품질|불친절/.test(tagStr) && tagStr.includes('컴플레인')) return 'service';
  if (tagStr.includes('컴플레인')) return 'other';
  return null;
}

module.exports = async function handler(req, res) {
  // ── 인증 게이트 ─────────────────────────────────────────────────────
  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
  if (DASHBOARD_TOKEN) {
    const cookie = parseCookie(req.headers.cookie);
    if (cookie.ds_auth !== DASHBOARD_TOKEN) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(401).json({ error: 'Unauthorized', redirect: '/api/auth' });
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

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
  const days = (!daysParam || daysParam === 'all') ? null : parseInt(daysParam) || 30;
  const skipCache = req.query && req.query.fresh === '1';

  const KST_MS = 9 * 3600 * 1000;
  const toKST = (ts) => new Date(ts + KST_MS);

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
      safeFetch(`${BASE}/managers?limit=30&sortField=name`, { headers }, 'managers'),
      safeFetch(`${BASE}/user-chats?limit=50&state=opened&sortOrder=desc`, { headers }, 'open-chats'),
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

    // ── B-7: 수집 한도 1000건 (10 × 100) ───────────────────────────
    const PAGE_SIZE = 100;
    const MAX_PAGES = 10;
    const HARD_LIMIT = PAGE_SIZE * MAX_PAGES;
    let allChats = [];
    let nextCursor = null;
    let pageCount = 0;
    const pageT0 = Date.now();

    for (let page = 0; page < MAX_PAGES && allChats.length < HARD_LIMIT; page++) {
      if (Date.now() - startedAt > 25000) {
        diagnostics.warnings.push(`pagination timeout at page ${page}`);
        break;
      }
      const url = nextCursor
        ? `${BASE}/user-chats?limit=${PAGE_SIZE}&state=closed&sortOrder=desc&next=${nextCursor}`
        : `${BASE}/user-chats?limit=${PAGE_SIZE}&state=closed&sortOrder=desc`;
      const r = await safeFetch(url, { headers }, `closed-page-${page + 1}`);
      diagnostics.calls.push({ label: r.label, ok: r.ok, status: r.status, ms: r.ms });
      if (!r.ok) {
        diagnostics.warnings.push(`closed page ${page + 1} 실패 (${r.status})`);
        break;
      }
      const chats = (r.data && r.data.userChats) || [];
      if (!chats.length) break;
      allChats = allChats.concat(chats);
      nextCursor = r.data.next;
      pageCount = page + 1;
      if (!nextCursor) break;
    }
    diagnostics.paginationMs = Date.now() - pageT0;
    diagnostics.pages = pageCount;

    // dedup
    const seenIds = new Set();
    allChats = allChats.filter((c) => {
      const key = c.id || (c.createdAt + '-' + (c.assigneeId || 'X'));
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });

    const cutoffMs = days ? (Date.now() - days * 24 * 3600 * 1000) : null;

    // ── 컨테이너 ───────────────────────────────────────────────────
    const dayCounts = {};
    const dayCountsPrev = {};
    const windowDays = days || 90;
    const nowKST = toKST(Date.now());
    for (let i = windowDays - 1; i >= 0; i--) {
      const d2 = new Date(nowKST.getTime() - i * 24 * 3600 * 1000);
      dayCounts[`${d2.getMonth() + 1}/${d2.getDate()}`] = 0;
    }
    if (days) {
      for (let i = days * 2 - 1; i >= days; i--) {
        const d2 = new Date(nowKST.getTime() - i * 24 * 3600 * 1000);
        dayCountsPrev[`${d2.getMonth() + 1}/${d2.getDate()}`] = 0;
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
    const resTimes = [];
    const frtTimes = [];               // B-1: 전체 FRT 배열
    const longChats = [];
    const longChatSeenIds = new Set();
    const peakDayData = {};
    let processed = 0;
    let unassigned = 0;

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
    let reopenedCount = 0;
    const userChatCount = {};          // userId → 채팅 수 (반복 문의)

    // B-3 컴플레인 세분화
    const complaintCategories = {
      service: 0, system: 0, pricing: 0, churn: 0, other: 0
    };
    const complaintCategoryDaily = {}; // {dayKey: {service, system, ...}}

    // ── 채팅 처리 ──────────────────────────────────────────────────
    for (const c of allChats) {
      if (cutoffMs && c.createdAt < cutoffMs) {
        if (days && c.createdAt >= cutoffMs - days * 24 * 3600 * 1000) {
          const dt = toKST(c.createdAt);
          const k = `${dt.getMonth() + 1}/${dt.getDate()}`;
          if (k in dayCountsPrev) dayCountsPrev[k]++;
        }
        continue;
      }
      processed++;

      if (!c.assigneeId) unassigned++;

      // B-2: 재오픈 추적 — openedAt이 createdAt + 1h 이상 차이나면 재오픈
      if (c.openedAt && c.createdAt && c.openedAt > c.createdAt + 3600000) {
        reopenedCount++;
      }
      // B-2: 반복 문의
      if (c.userId) {
        userChatCount[c.userId] = (userChatCount[c.userId] || 0) + 1;
      }

      const dt = toKST(c.createdAt);
      const dayKey = `${dt.getMonth() + 1}/${dt.getDate()}`;
      if (dayKey in dayCounts) dayCounts[dayKey]++;

      const rawDay = dt.getDay();
      const wd = rawDay === 0 ? 6 : rawDay - 1;
      const hr = dt.getHours();
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

      const rawTags = (c.tags || []).slice();
      let hasComplaint = false;
      for (const tag of rawTags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        peakDayData[dayKey].tags[tag] = (peakDayData[dayKey].tags[tag] || 0) + 1;
        if (tag.includes('컴플레인') && !hasComplaint) hasComplaint = true;
      }
      if (hasComplaint && rawTags.filter((t) => t.includes('컴플레인')).length > 0) {
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
      }

      const uniqTags = Array.from(new Set(rawTags));
      for (let i = 0; i < uniqTags.length; i++) {
        for (let j = i + 1; j < uniqTags.length; j++) {
          const key = [uniqTags[i], uniqTags[j]].sort().join('||');
          tagCooccur[key] = (tagCooccur[key] || 0) + 1;
        }
      }

      const medium = c.source && c.source.medium ? c.source.medium.mediumType : 'other';
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
      const frtMs = c.operationWaitingTime;
      if (frtMs && frtMs > 0) {
        const frtMin = frtMs / 1000 / 60;
        frtTimes.push(frtMin);
        if (c.assigneeId) {
          if (!mgrFrtTimes[c.assigneeId]) mgrFrtTimes[c.assigneeId] = [];
          mgrFrtTimes[c.assigneeId].push(frtMin);
        }
      }

      const resTime = c.resolutionTime;
      if (resTime && resTime > 0) {
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

    // ── trim & 분석 ────────────────────────────────────────────────
    let trendDayCounts = dayCounts;
    if (!days) {
      const entries = Object.entries(dayCounts);
      const firstNonZero = entries.findIndex(([, v]) => v > 0);
      if (firstNonZero > 0) {
        trendDayCounts = Object.fromEntries(entries.slice(Math.max(0, firstNonZero - 1)));
      }
    }

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
          date: peakEntry[0], count: peakEntry[1],
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
        const complaintHandled = Object.entries(mTags).filter(([t]) => t.includes('컴플레인')).reduce((a, [, c]) => a + c, 0);
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
          topTags, complaintHandled,
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

    // B-2: 재오픈/FCR
    const fcrStats = {
      reopenedCount,
      reopenedRate: processed > 0 ? Math.round((reopenedCount / processed) * 100 * 10) / 10 : 0,
      fcrRate: processed > 0 ? Math.round(((processed - reopenedCount) / processed) * 100 * 10) / 10 : 100,
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
    } : null;

    const complaintTrend = {
      labels: Object.keys(trendDayCounts),
      total: Object.values(trendDayCounts),
      complaints: Object.keys(trendDayCounts).map((k) => dailyComplaints[k] || 0),
    };

    // B-3: 컴플레인 세분화 일별
    const complaintCategoryTrend = {
      labels: Object.keys(trendDayCounts),
      service: Object.keys(trendDayCounts).map((k) => (complaintCategoryDaily[k] || {}).service || 0),
      system: Object.keys(trendDayCounts).map((k) => (complaintCategoryDaily[k] || {}).system || 0),
      pricing: Object.keys(trendDayCounts).map((k) => (complaintCategoryDaily[k] || {}).pricing || 0),
      churn: Object.keys(trendDayCounts).map((k) => (complaintCategoryDaily[k] || {}).churn || 0),
      other: Object.keys(trendDayCounts).map((k) => (complaintCategoryDaily[k] || {}).other || 0),
    };

    const anomalies = detectAnomalies(Object.values(trendDayCounts)).map((a) => ({
      ...a, label: Object.keys(trendDayCounts)[a.idx],
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
    const channelInfo = channelData.channel || {};

    const result = {
      updatedAt: new Date().toISOString(),
      range: days ? `${days}d` : 'all',
      diagnostics: {
        totalMs: Date.now() - startedAt,
        paginationMs: diagnostics.paginationMs,
        pages: diagnostics.pages,
        warnings: diagnostics.warnings,
        callTiming: diagnostics.calls,
        anyFailure: diagnostics.warnings.length > 0,
        cacheHit: false,
        kvEnabled: KV_ENABLED,
      },
      dataNote: {
        collected: allChats.length, processed, limit: HARD_LIMIT,
        isSampled: allChats.length >= HARD_LIMIT,
      },
      channel: { name: channelInfo.name || '오토스테이 CS', id: channelInfo.id || null },
      summary: {
        totalChats: processed,
        openChats: openChats.length,
        unassignedChats: unassigned,
        avgResolutionMin: avgRes,
        peakDay: peakEntry ? { label: peakEntry[0], count: peakEntry[1] } : null,
      },
      resolutionStats: { avg: avgRes, median: medianRes, p75: p75Res, p90: p90Res, p95: p95Res, avgEx8h },
      frtStats,                                  // B-1: FRT 통계
      fcrStats,                                  // B-2: FCR
      repeatStats,                               // B-2: 반복 문의
      complaintCategories,                       // B-3: 컴플레인 세분화 합계
      complaintCategoryTrend,                    // B-3: 일별 추이
      slaStats,
      dailyTrend: { labels: Object.keys(trendDayCounts), values: Object.values(trendDayCounts) },
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

    // ── 캐시 저장 (5분 TTL) ──────────────────────────────────────
    if (!skipCache) {
      cacheSet(cacheKey, result, 300).catch(() => {}); // fire-and-forget
    }

    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: err.message, stack: err.stack,
      diagnostics, elapsedMs: Date.now() - startedAt,
    });
  }
};
