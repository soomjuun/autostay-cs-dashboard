module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const ACCESS_KEY = process.env.CHANNEL_ACCESS_KEY || '69eece38928df5646de2';
  const ACCESS_SECRET = process.env.CHANNEL_ACCESS_SECRET || '830397bafe9ac97388edc8fa6af913c5';
  const BASE = 'https://api.channel.io/open/v5';
  const epoch = Date.now().toString();

  const headers = {
    'x-access-key': ACCESS_KEY,
    'x-access-secret': ACCESS_SECRET,
    'x-request-at': epoch,
    'Content-Type': 'application/json',
  };

  try {
    const [channelRes, managersRes, openRes, groupsRes, botsRes] = await Promise.all([
      fetch(`${BASE}/channel`, { headers }),
      fetch(`${BASE}/managers?limit=30&sortField=name`, { headers }),
      fetch(`${BASE}/user-chats?limit=50&state=opened&sortOrder=desc`, { headers }),
      fetch(`${BASE}/groups`, { headers }),
      fetch(`${BASE}/bots`, { headers }),
    ]);

    const [channelData, managersData, openData, groupsData, botsData] = await Promise.all([
      channelRes.json(),
      managersRes.json(),
      openRes.json(),
      groupsRes.json(),
      botsRes.json(),
    ]);

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

    const dayCounts = {};
    const heatmapData = {};
    const tagCounts = {};
    const sourceCounts = { native: 0, phone: 0, other: 0 };
    const resBuckets = { '0~5분': 0, '5~30분': 0, '30분~2시간': 0, '2~8시간': 0, '8시간+': 0 };
    const mgrCounts = {};
    const resTimes = [];

    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = `${d.getMonth()+1}/${d.getDate()}`;
      dayCounts[key] = 0;
    }

    for (const c of allChats) {
      const dt = new Date(c.createdAt);
      const dayKey = `${dt.getMonth()+1}/${dt.getDate()}`;
      if (dayKey in dayCounts) dayCounts[dayKey]++;

      const wd = dt.getDay() === 0 ? 6 : dt.getDay() - 1;
      const hr = dt.getHours();
      const hmKey = `${wd}-${hr}`;
      heatmapData[hmKey] = (heatmapData[hmKey] || 0) + 1;

      for (const tag of (c.tags || [])) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }

      const medium = c.source && c.source.medium ? c.source.medium.mediumType : 'other';
      if (medium === 'native') sourceCounts.native++;
      else if (medium === 'phone') sourceCounts.phone++;
      else sourceCounts.other++;

      const resTime = c.resolutionTime;
      if (resTime && resTime > 0) {
        const mins = resTime / 1000 / 60;
        resTimes.push(mins);
        if (mins < 5) resBuckets['0~5분']++;
        else if (mins < 30) resBuckets['5~30분']++;
        else if (mins < 120) resBuckets['30분~2시간']++;
        else if (mins < 480) resBuckets['2~8시간']++;
        else resBuckets['8시간+']++;
      }

      if (c.assigneeId) mgrCounts[c.assigneeId] = (mgrCounts[c.assigneeId] || 0) + 1;
    }

    const managers = (managersData.managers || [])
      .filter(function(m) { return !m.removed; })
      .map(function(m) {
        return {
          id: m.id,
          name: m.name,
          operatorScore: Math.round((m.operatorScore || 0) * 10) / 10,
          touchScore: Math.round((m.touchScore || 0) * 10) / 10,
          count: mgrCounts[m.id] || 0,
        };
      })
      .sort(function(a, b) { return b.count - a.count; });

    const topTags = Object.entries(tagCounts)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 10);

    const avgRes = resTimes.length
      ? Math.round(resTimes.reduce(function(a, b) { return a + b; }, 0) / resTimes.length)
      : 0;
    const openChats = openData.userChats || [];
    const peakEntry = Object.entries(dayCounts).sort(function(a, b) { return b[1] - a[1]; })[0];

    return res.json({
      updatedAt: new Date().toISOString(),
      channel: channelData.channel || {},
      summary: {
        totalChats: allChats.length,
        openChats: openChats.length,
        avgResolutionMin: avgRes,
        peakDay: peakEntry ? { label: peakEntry[0], count: peakEntry[1] } : null,
      },
      dailyTrend: {
        labels: Object.keys(dayCounts),
        values: Object.values(dayCounts),
      },
      tags: {
        labels: topTags.map(function(t) { return t[0]; }),
        values: topTags.map(function(t) { return t[1]; }),
      },
      sources: sourceCounts,
      resolutionBuckets: resBuckets,
      heatmap: heatmapData,
      managers: managers,
      groups: groupsData.groups || [],
      bots: botsData.bots || [],
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
