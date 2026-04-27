// Vercel Serverless Function — Channel.io API Proxy
// Fetches real CS data and returns processed JSON for the dashboard

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate'); // 5min cache

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
    // Fetch all data in parallel
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

    // Paginated closed chats (up to 500)
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

    // ── Process daily trend ──
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

      // Heatmap: weekday × hour
      const wd = dt.getDay() === 0 ? 6 : dt.getDay() - 1; // Mon=0
      const hr = dt.getHours();
      const hmKey = `${wd}-${hr}`;
      heatmapData[hmKey] = (heatmapData[hmKey] || 0) + 1;

      // Tags
      for (const tag of (c.tags || [])) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }

      // Source
      const medium = c.source?.medium?.mediumType || 'other';
      if (medium === 'native') sourceCounts.native++;
      else if (medium === 'phone') sourceCounts.phone++;
      else sourceCounts.other++;

      // Resolution time (ms → min)
      const res = c.resolutionTime;
      if (res && res > 0) {
        const mins = res / 1000 / 60;
        resTimes.push(mins);
        if (mins < 5) resBuckets['0~5분']++;
        else if (mins < 30) resBuckets['5~30분']++;
        else if (mins < 120) resBuckets['30분~2시간']++;
        else if (mins < 480) resBuckets['2~8시간']++;
        else resBuckets['8시간+']++;
      }

      // Manager counts
      if (c.assigneeId) mgrCounts[c.assigneeId] = (mgrCounts[c.assigneeId] || 0) + 1;
    }

    // Build manager stats
    const managers = (managersData.managers || [])
      .filter(m => !m.removed)
      .map(m => ({
        id: m.id,
        name: m.name,
        operatorScore: Math.round(m.operatorScore * 10) / 10,
        touchScore: Math.round(m.touchScore * 10) / 10,
        count: mgrCounts[m.id] || 0,
      }))
      .sort((a, b) => b.count - a.count);

    // Top tags
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const avgRes = resTimes.length ? Math.round(resTimes.reduce((a,b)=>a+b,0)/resTimes.length) : 0;
    const openChats = openData.userChats || [];

    // Peak day
    const peakEntry = Object.entries(dayCounts).sort((a,b) => b[1]-a[1])[0];

    res.json({
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
        labels: topTags.map(t => t[0]),
        values: topTags.map(t => t[1]),
      },
      sources: sourceCounts,
      resolutionBuckets: resBuckets,
      heatmap: heatmapData,
      managers,
      groups: groupsData.groups || [],
      bots: botsData.bots || [],
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
