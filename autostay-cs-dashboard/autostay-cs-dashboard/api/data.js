// Vercel Serverless Function — Channel.io API Proxy  v2.4
// 추가: 담당자별 avgResolutionMin, 8시간+ longChats 리스트, peakAnalysis
// v2.3: pagination 중복 dedup, percentile 통계 (중앙값·p90·8h+제외평균)
// v2.4: 쿠키 기반 인증 게이트 (DASHBOARD_TOKEN)

// ── 쿠키 파싱 헬퍼 ─────────────────────────────────────────────────────────────
function parseCookie(str) {
  const out = {};
  (str || '').split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}

module.exports = async function handler(req, res) {
  // ── 인증 게이트 ─────────────────────────────────────────────────────────────
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const ACCESS_KEY    = process.env.CHANNEL_ACCESS_KEY    || '69eece38928df5646de2';
  const ACCESS_SECRET = process.env.CHANNEL_ACCESS_SECRET || '830397bafe9ac97388edc8fa6af913c5';
  const BASE = 'https://api.channel.io/open/v5';
  const epoch = Date.now().toString();

  const headers = {
    'x-access-key':    ACCESS_KEY,
    'x-access-secret': ACCESS_SECRET,
    'x-request-at':    epoch,
    'Content-Type':    'application/json',
  };

  // ── Parse query params ──────────────────────────────────────────────────────
  const daysParam = req.query && req.query.days;
  const days = (!daysParam || daysParam === 'all') ? null : parseInt(daysParam) || 30;

  // ── KST helper (+9h shift) ──────────────────────────────────────────────────
  const KST_MS = 9 * 3600 * 1000;
  const toKST  = (ts) => new Date(ts + KST_MS);

  try {
    const [channelRes, managersRes, openRes, groupsRes, botsRes] = await Promise.all([
      fetch(`${BASE}/channel`,                                          { headers }),
      fetch(`${BASE}/managers?limit=30&sortField=name`,                { headers }),
      fetch(`${BASE}/user-chats?limit=50&state=opened&sortOrder=desc`, { headers }),
      fetch(`${BASE}/groups`,                                           { headers }),
      fetch(`${BASE}/bots`,                                             { headers }),
    ]);

    const [channelData, managersData, openData, groupsData, botsData] = await Promise.all([
      channelRes.json(),
      managersRes.json(),
      openRes.json(),
      groupsRes.json(),
      botsRes.json(),
    ]);

    // ── Paginated closed chats (up to 500) ──────────────────────────────────
    let allChats = [];
    let nextCursor = null;
    for (let page = 0; page < 10 && allChats.length < 500; page++) {
      const url = nextCursor
        ? `${BASE}/user-chats?limit=50&state=closed&sortOrder=desc&next=${nextCursor}`
        : `${BASE}/user-chats?limit=50&state=closed&sortOrder=desc`;
      const r = await fetch(url, { headers });
      const d = await r.json();
      const chats = d.userChats || [];
      if (!chats.length) break;
      allChats = allChats.concat(chats);
      nextCursor = d.next;
      if (!nextCursor) break;
    }

    // ── Pagination dedup (동일 채팅이 페이지 경계에서 중복 수집되는 경우 방지) ──
    {
      const seenIds = new Set();
      allChats = allChats.filter(function(c) {
        const key = c.id || (c.createdAt + '-' + (c.assigneeId || 'X'));
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });
    }

    // ── Date cutoff ──────────────────────────────────────────────────────────
    const cutoffMs = days ? (Date.now() - days * 24 * 3600 * 1000) : null;

    // ── Pre-build dayCounts window ───────────────────────────────────────────
    const dayCounts = {};
    const windowDays = days || 90;
    const nowKST = toKST(Date.now());
    for (let i = windowDays - 1; i >= 0; i--) {
      const d2 = new Date(nowKST.getTime() - i * 24 * 3600 * 1000);
      const key = `${d2.getMonth() + 1}/${d2.getDate()}`;
      dayCounts[key] = 0;
    }

    // ── Process chats ────────────────────────────────────────────────────────
    const heatmapData  = {};
    const tagCounts    = {};
    const sourceCounts = { native: 0, phone: 0, other: 0 };
    const resBuckets   = { '0~5분': 0, '5~30분': 0, '30분~2시간': 0, '2~8시간': 0, '8시간+': 0 };
    const mgrCounts    = {};
    const mgrResTimes  = {}; // 담당자별 해결시간 배열
    const resTimes     = [];
    const longChats    = []; // 8시간+ 채팅 리스트
    const longChatSeenIds = new Set(); // 중복 제거용
    const peakDayData  = {}; // 피크 분석용
    let   processed    = 0;
    let   unassigned   = 0; // 미배정 건수

    for (const c of allChats) {
      if (cutoffMs && c.createdAt < cutoffMs) continue;
      processed++;

      // 미배정 집계
      if (!c.assigneeId) unassigned++;

      const dt     = toKST(c.createdAt);
      const dayKey = `${dt.getMonth() + 1}/${dt.getDate()}`;
      if (dayKey in dayCounts) dayCounts[dayKey]++;

      // Heatmap
      const rawDay = dt.getDay();
      const wd     = rawDay === 0 ? 6 : rawDay - 1;
      const hr     = dt.getHours();
      heatmapData[`${wd}-${hr}`] = (heatmapData[`${wd}-${hr}`] || 0) + 1;

      // 피크 분석용 per-day 집계
      if (!peakDayData[dayKey]) peakDayData[dayKey] = {
        tags: {}, assignees: {}, hours: {}, sources: { native: 0, phone: 0, other: 0 }, longCount: 0
      };
      peakDayData[dayKey].hours[hr] = (peakDayData[dayKey].hours[hr] || 0) + 1;
      if (c.assigneeId) {
        peakDayData[dayKey].assignees[c.assigneeId] = (peakDayData[dayKey].assignees[c.assigneeId] || 0) + 1;
      }

      // Tags (컴플레인 계열 통합: "컴플레인" 상위 태그로도 집계)
      const rawTags = c.tags || [];
      let hasComplaint = false;
      for (const tag of rawTags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        peakDayData[dayKey].tags[tag] = (peakDayData[dayKey].tags[tag] || 0) + 1;
        if (tag.includes('컴플레인') && !hasComplaint) hasComplaint = true;
      }
      // 컴플레인 계열이 하나라도 있으면 상위 집계
      if (hasComplaint && rawTags.filter(t => t.includes('컴플레인')).length > 0) {
        // 이미 "컴플레인" 정확 태그가 없는 경우에만 상위 태그 가산 (중복 방지)
        const exactExists = rawTags.some(t => t === '컴플레인');
        if (!exactExists) {
          tagCounts['컴플레인(전체)'] = (tagCounts['컴플레인(전체)'] || 0) + 1;
        }
      }

      // Source (피크 분석에도 포함)
      const medium = c.source && c.source.medium ? c.source.medium.mediumType : 'other';
      if      (medium === 'native') { sourceCounts.native++; peakDayData[dayKey].sources.native++; }
      else if (medium === 'phone')  { sourceCounts.phone++;  peakDayData[dayKey].sources.phone++;  }
      else                          { sourceCounts.other++;  peakDayData[dayKey].sources.other++;  }

      // Resolution time
      const resTime = c.resolutionTime;
      if (resTime && resTime > 0) {
        const mins = resTime / 1000 / 60;
        resTimes.push(mins);
        if      (mins < 5)   resBuckets['0~5분']++;
        else if (mins < 30)  resBuckets['5~30분']++;
        else if (mins < 120) resBuckets['30분~2시간']++;
        else if (mins < 480) resBuckets['2~8시간']++;
        else {
          resBuckets['8시간+']++;
          peakDayData[dayKey].longCount = (peakDayData[dayKey].longCount || 0) + 1;
          // 8시간+ 리스트 — ID 기반 중복 제거
          const chatKey = c.id || `${dayKey}-${c.assigneeId || 'X'}-${Math.round(mins)}`;
          if (!longChatSeenIds.has(chatKey) && longChats.length < 50) {
            longChatSeenIds.add(chatKey);
            longChats.push({
              date:          dayKey,
              tags:          rawTags,
              assigneeId:    c.assigneeId || null,
              resolutionMin: Math.round(mins),
            });
          }
        }
        // 담당자별 해결시간 집계
        if (c.assigneeId) {
          if (!mgrResTimes[c.assigneeId]) mgrResTimes[c.assigneeId] = [];
          mgrResTimes[c.assigneeId].push(mins);
        }
      }

      // Manager attribution
      if (c.assigneeId) mgrCounts[c.assigneeId] = (mgrCounts[c.assigneeId] || 0) + 1;
    }

    // 'all' 모드: 앞뒤 0-day 트림
    let trendDayCounts = dayCounts;
    if (!days) {
      const entries = Object.entries(dayCounts);
      const firstNonZero = entries.findIndex(([, v]) => v > 0);
      if (firstNonZero > 0) {
        trendDayCounts = Object.fromEntries(entries.slice(Math.max(0, firstNonZero - 1)));
      }
    }

    // ── Peak analysis (항목 #9) ──────────────────────────────────────────────
    const peakEntry = Object.entries(trendDayCounts)
      .sort(function(a, b) { return b[1] - a[1]; })[0];

    let peakAnalysis = null;
    if (peakEntry && peakEntry[1] > 0) {
      const pk = peakDayData[peakEntry[0]];
      if (pk) {
        const topTags3 = Object.entries(pk.tags || {})
          .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3)
          .map(function(e) { return { tag: e[0], cnt: e[1] }; });
        const topAssignees3 = Object.entries(pk.assignees || {})
          .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3)
          .map(function(e) { return { id: e[0], cnt: e[1] }; });
        const peakHourEntry = Object.entries(pk.hours || {})
          .sort(function(a, b) { return b[1] - a[1]; })[0];
        const pkTotal = peakEntry[1] || 1;
        const pkSrc = pk.sources || {};
        peakAnalysis = {
          date:          peakEntry[0],
          count:         peakEntry[1],
          topTags:       topTags3,
          topAssignees:  topAssignees3,
          peakHour:      peakHourEntry
            ? { hour: parseInt(peakHourEntry[0]), cnt: peakHourEntry[1] }
            : null,
          // 확장: 유입 채널 + 장기채팅 전환율
          sources: {
            native: pkSrc.native || 0,
            phone:  pkSrc.phone  || 0,
            other:  pkSrc.other  || 0,
          },
          longChatRate: pkTotal > 0 ? Math.round(((pk.longCount || 0) / pkTotal) * 100) : 0,
        };
      }
    }

    // ── Build manager stats (담당자별 avgResolutionMin 포함 — 항목 #3) ────────
    const managers = (managersData.managers || [])
      .filter(function(m) { return !m.removed; })
      .map(function(m) {
        const mTimes  = mgrResTimes[m.id] || [];
        const mAvgRes = mTimes.length
          ? Math.round(mTimes.reduce(function(a, b) { return a + b; }, 0) / mTimes.length)
          : null;
        return {
          id:               m.id,
          name:             m.name,
          operatorScore:    Math.round((m.operatorScore || 0) * 10) / 10,
          touchScore:       Math.round((m.touchScore    || 0) * 10) / 10,
          count:            mgrCounts[m.id] || 0,
          avgResolutionMin: mAvgRes, // 담당자별 실제 평균
        };
      })
      .sort(function(a, b) { return b.count - a.count; });

    // ── Top 10 tags ──────────────────────────────────────────────────────────
    const topTags = Object.entries(tagCounts)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 10);

    // ── Averages & Percentile Stats ──────────────────────────────────────────
    const avgRes = resTimes.length
      ? Math.round(resTimes.reduce(function(a, b) { return a + b; }, 0) / resTimes.length)
      : 0;

    // 중앙값 (median)
    const sortedTimes = resTimes.slice().sort(function(a, b) { return a - b; });
    const medianRes = sortedTimes.length
      ? Math.round(sortedTimes[Math.floor((sortedTimes.length - 1) / 2)])
      : 0;

    // 90퍼센타일 (p90)
    const p90Res = sortedTimes.length
      ? Math.round(sortedTimes[Math.min(Math.floor(sortedTimes.length * 0.9), sortedTimes.length - 1)])
      : 0;

    // 8시간+ 제외 평균
    const timesEx8h = resTimes.filter(function(t) { return t < 480; });
    const avgEx8h = timesEx8h.length
      ? Math.round(timesEx8h.reduce(function(a, b) { return a + b; }, 0) / timesEx8h.length)
      : null;

    const openChats = openData.userChats || [];

    // ── 채널 정보 슬림화 (내부 메타 제거, 집계 결과만 노출) ─────────────────
    const channelInfo = channelData.channel || {};

    return res.json({
      updatedAt: new Date().toISOString(),
      range:     days ? `${days}d` : 'all',
      // 수집 현황 — 데이터 기준 명확화용
      dataNote: {
        collected:  allChats.length,         // API에서 가져온 원본 건수
        processed:  processed,               // 기간 필터 적용 후 처리 건수
        limit:      500,                     // 수집 상한
        isSampled:  allChats.length >= 500,  // 상한 도달 여부
      },
      // 채널 식별용 최소 정보만
      channel: {
        name: channelInfo.name || '오토스테이 CS',
        id:   channelInfo.id   || null,
      },
      summary: {
        totalChats:       processed,
        openChats:        openChats.length,
        unassignedChats:  unassigned,        // 미배정 건수
        avgResolutionMin: avgRes,
        peakDay: peakEntry ? { label: peakEntry[0], count: peakEntry[1] } : null,
      },
      resolutionStats: {
        avg:      avgRes,
        median:   medianRes,
        p90:      p90Res,
        avgEx8h:  avgEx8h,   // 8시간+ 제외 평균 (비동기 대기 제거)
      },
      dailyTrend: {
        labels: Object.keys(trendDayCounts),
        values: Object.values(trendDayCounts),
      },
      tags: {
        labels: topTags.map(function(t) { return t[0]; }),
        values: topTags.map(function(t) { return t[1]; }),
      },
      sources:           sourceCounts,
      resolutionBuckets: resBuckets,
      heatmap:           heatmapData,
      managers:          managers,
      // groups 원본 제거 — 집계 결과만 유지
      groupCount:        (groupsData.groups || []).length,
      // bots: 이름만 노출 (ID 등 내부 메타 제거)
      bots:              (botsData.bots || []).map(function(b) { return { name: b.name }; }),
      longChats:         longChats,         // 8시간+ drill-down
      peakAnalysis:      peakAnalysis,      // 피크 분석 (채널·장기전환율 포함)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
