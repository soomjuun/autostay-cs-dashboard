// Autostay CS Dashboard — app.js
// Fetches from /api/data (Vercel serverless) and renders all charts + tables

const COLORS = ['#0f766e','#be123c','#14b8a6','#3b82f6','#8b5cf6','#f59e0b','#0369a1','#e11d48','#6d28d9','#0d9488'];
const AVATAR_COLORS = ['#0f766e,#14b8a6','#1d4ed8,#3b82f6','#b45309,#f59e0b','#be123c,#f43f5e','#6d28d9,#8b5cf6','#0369a1,#0ea5e9','#059669,#34d399'];

Chart.defaults.font.family = "'Pretendard Variable', Pretendard, sans-serif";
Chart.defaults.color = '#78716c';
Chart.defaults.borderColor = '#f1efe8';

let charts = {};
let lastData = null;

// ── Helpers ──
function setStep(id, done=false) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('active'); if(done) el.classList.add('done'); else el.classList.add('active'); }
}
function setProgress(pct) {
  const bar = document.getElementById('loadProgressBar');
  if (bar) bar.style.width = pct + '%';
}
function fmt(n, unit='') { return n?.toLocaleString('ko-KR') + unit; }
function initials(name) { return name?.replace(/오토스테이_/,'').replace(/[^A-Za-z가-힣]/g,'').slice(0,2).toUpperCase() || '?'; }
function avatarStyle(idx) { const [a,b] = AVATAR_COLORS[idx % AVATAR_COLORS.length].split(','); return `background:linear-gradient(135deg,${a},${b})`; }

// ── Fetch Data ──
async function fetchData() {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ── Render KPI Cards ──
function renderKPIs(d) {
  const { summary, managers } = d;
  const topMgr = managers?.[0];
  const grid = document.getElementById('kpiGrid');
  const totalChats = summary.totalChats;
  const openChats = summary.openChats;
  const avgRes = summary.avgResolutionMin;
  const peakCount = summary.peakDay?.count || 0;
  const peakLabel = summary.peakDay?.label || '—';
  const topPct = topMgr ? Math.round((topMgr.count / totalChats) * 100) : 0;

  grid.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">분석 채팅 수</div>
      <div class="kpi-value">${fmt(totalChats)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="delta neutral">최근 종료</span><span class="delta-lbl">closed 기준</span></div>
    </div>
    <div class="kpi-card a-${openChats > 5 ? 'rose' : openChats > 0 ? 'amber' : 'green'}">
      <div class="kpi-label">현재 오픈 채팅</div>
      <div class="kpi-value">${fmt(openChats)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="delta ${openChats===0?'good':'neutral'}">${openChats===0?'✓ 없음':'진행 중'}</span><span class="delta-lbl">실시간</span></div>
    </div>
    <div class="kpi-card a-amber">
      <div class="kpi-label">평균 해결 시간</div>
      <div class="kpi-value">${fmt(avgRes)}<span class="unit">분</span></div>
      <div class="kpi-meta"><span class="delta neutral">~${Math.round(avgRes/60*10)/10}시간</span><span class="delta-lbl">비동기 포함</span></div>
    </div>
    <div class="kpi-card a-green">
      <div class="kpi-label">주담당자 비중</div>
      <div class="kpi-value">${topPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="delta neutral">${topMgr?.name || '—'}</span><span class="delta-lbl">${fmt(topMgr?.count,'건')}</span></div>
    </div>
    <div class="kpi-card a-green">
      <div class="kpi-label">주담당자 운영점수</div>
      <div class="kpi-value">${topMgr?.operatorScore ?? '—'}<span class="unit">점</span></div>
      <div class="kpi-meta"><span class="delta neutral">touch ${topMgr?.touchScore ?? '—'}</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">일 최고 인입 피크</div>
      <div class="kpi-value">${fmt(peakCount)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="delta bad">${peakLabel}</span><span class="delta-lbl">최고 인입일</span></div>
    </div>
  `;
}

// ── Render Action Center ──
function renderActionCenter(d) {
  const { summary, tags, sources, groups } = d;
  const topTag = tags?.labels?.[0] || '—';
  const topTagCount = tags?.values?.[0] || 0;
  const totalChats = summary.totalChats;

  document.getElementById('acOpen').textContent = summary.openChats;
  document.getElementById('acOpenClass').className = `ac-count ${summary.openChats > 5 ? 'red' : summary.openChats > 0 ? 'amber' : 'green'}`;

  const acTagList = document.getElementById('acTagList');
  acTagList.innerHTML = (tags?.labels || []).slice(0,3).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt/totalChats*100);
    const dotColor = i===0?'amber':i===1?'red':'teal';
    return `<div class="ac-item"><span class="ac-dot ${dotColor}"></span><div class="ac-item-text"><div>#${lbl} — ${cnt}건 (${pct}%)</div></div><span class="ac-meta">${i+1}위</span></div>`;
  }).join('');

  document.getElementById('acNative').textContent = `${sources?.native||0}건 (${Math.round((sources?.native||0)/totalChats*100)}%)`;
  document.getElementById('acPhone').textContent = `${sources?.phone||0}건 (${Math.round((sources?.phone||0)/totalChats*100)}%)`;
  document.getElementById('acGroupCount').textContent = (groups||[]).length + '개';
}

// ── Render Alert ──
function renderAlert(d) {
  const { tags } = d;
  if (!tags?.labels?.length) return;
  const strip = document.getElementById('alertStrip');
  const topTags = tags.labels.slice(0,3).map((l,i) => `<div class="alert-tag">#${l} <strong>${tags.values[i]}건</strong></div>`).join('');
  strip.innerHTML = `
    <div class="alert-icon">!</div>
    <div>
      <div class="alert-title">실데이터 기준 주요 태그 집중 현황</div>
      <div class="alert-desc">상위 3개 태그가 전체의 ${Math.round((tags.values.slice(0,3).reduce((a,b)=>a+b,0)/d.summary.totalChats)*100)}%를 차지합니다</div>
    </div>
    <div class="alert-tags">${topTags}</div>
  `;
  strip.style.display = 'flex';
}

// ── Render Trend Chart ──
function renderTrend(d) {
  const { dailyTrend, summary } = d;
  const activeValues = dailyTrend.values.filter(v=>v>0);
  const avg = activeValues.length ? Math.round(activeValues.reduce((a,b)=>a+b,0)/activeValues.length) : 0;
  const peak = Math.max(...dailyTrend.values);

  document.getElementById('trendTotal').textContent = fmt(summary.totalChats);
  document.getElementById('trendPeak').textContent = fmt(peak);
  document.getElementById('trendPeakDay').textContent = summary.peakDay?.label || '—';
  document.getElementById('trendAvg').textContent = fmt(avg);
  document.getElementById('trendOpen').textContent = fmt(summary.openChats);

  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart(document.getElementById('trendChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: dailyTrend.labels,
      datasets: [
        {
          label: '종료 채팅',
          data: dailyTrend.values,
          backgroundColor: dailyTrend.values.map(v => v >= peak*0.8 ? '#be123c' : v >= peak*0.4 ? '#0f766e' : '#14b8a6'),
          borderRadius: 3,
        },
        {
          label: '일 평균',
          data: Array(dailyTrend.labels.length).fill(avg),
          type: 'line',
          borderColor: '#f59e0b',
          borderWidth: 1.5,
          borderDash: [4,3],
          pointRadius: 0,
          fill: false,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'rect', font: { size: 11 }, padding: 14 } },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 6 }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, maxTicksLimit: 10 } },
        y: { grid: { color: '#f1efe8' }, ticks: { font: { size: 11 }, callback: v => v + '건' } }
      }
    }
  });
}

// ── Render Heatmap ──
function renderHeatmap(d) {
  const days = ['월','화','수','목','금','토','일'];
  const hours = [8,9,10,11,12,13,14,15,16,17,18,19,20,21];
  const hm = d.heatmap || {};
  const allVals = Object.values(hm);
  const maxVal = allVals.length ? Math.max(...allVals) : 1;

  const el = document.getElementById('heatmap');
  el.innerHTML = '';
  el.appendChild(document.createElement('div'));
  hours.forEach(h => {
    const div = document.createElement('div');
    div.className = 'hm-head'; div.textContent = h + '시';
    el.appendChild(div);
  });
  days.forEach((day, di) => {
    const lbl = document.createElement('div');
    lbl.className = 'hm-row-label'; lbl.textContent = day;
    el.appendChild(lbl);
    hours.forEach((h) => {
      const v = hm[`${di}-${h}`] || 0;
      const lvl = v === 0 ? 0 : Math.ceil((v / maxVal) * 5);
      const cell = document.createElement('div');
      cell.className = `hm-cell hm-${lvl}`;
      cell.textContent = v;
      cell.title = `${day}요일 ${h}시 · ${v}건`;
      el.appendChild(cell);
    });
  });

  const leg = document.getElementById('hmLegend');
  leg.innerHTML = '';
  [0,1,2,3,4,5].forEach(i => {
    const s = document.createElement('span');
    s.className = `hm-cell hm-${i}`;
    s.style.cssText = 'width:12px;height:12px;border-radius:2px;display:block';
    leg.appendChild(s);
  });
}

// ── Render Category Chart ──
function renderCategory(d) {
  const { tags, summary } = d;
  if (!tags?.labels?.length) return;
  if (charts.cat) charts.cat.destroy();
  charts.cat = new Chart(document.getElementById('categoryChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: tags.labels,
      datasets: [{ data: tags.values, backgroundColor: COLORS, borderColor: '#fff', borderWidth: 2, hoverOffset: 5 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '54%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 7, boxHeight: 7, padding: 8, usePointStyle: true, pointStyle: 'rect', font: { size: 10 } } },
        tooltip: { backgroundColor: '#1c1917', padding: 9, cornerRadius: 6,
          callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}건 (${((ctx.parsed/summary.totalChats)*100).toFixed(1)}%)` }
        }
      }
    }
  });
}

// ── Render Channel Chart ──
function renderChannel(d) {
  const { sources } = d;
  const labels = ['자사 웹/앱 (native)','전화 (phone)'];
  const values = [sources.native || 0, sources.phone || 0];
  if (sources.other > 0) { labels.push('기타'); values.push(sources.other); }

  if (charts.ch) charts.ch.destroy();
  charts.ch = new Chart(document.getElementById('channelChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: ['#0f766e','#0369a1','#a8a29e'], borderRadius: 4, barThickness: 30 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 9, cornerRadius: 6,
          callbacks: { label: ctx => `${ctx.parsed.x.toLocaleString()}건 (${((ctx.parsed.x/d.summary.totalChats)*100).toFixed(1)}%)` }
        }
      },
      scales: {
        x: { ticks: { callback: v => v + '건', font: { size: 11 } }, grid: { color: '#f1efe8' } },
        y: { grid: { display: false }, ticks: { font: { size: 12 } } }
      }
    }
  });
}

// ── Render Resolution Time ──
function renderResolution(d) {
  const rb = d.resolutionBuckets;
  const total = Object.values(rb).reduce((a,b)=>a+b,0) || 1;
  const buckets = [
    { label: '0~5분',     val: rb['0~5분']||0,     cls: 'ok',   note: '즉시 해결' },
    { label: '5~30분',    val: rb['5~30분']||0,    cls: 'ok',   note: '신속 처리' },
    { label: '30분~2시간', val: rb['30분~2시간']||0, cls: 'warn', note: '일반' },
    { label: '2~8시간',   val: rb['2~8시간']||0,   cls: 'warn', note: '지연' },
    { label: '8시간+',    val: rb['8시간+']||0,    cls: 'bad',  note: '비동기·익일' },
  ];
  const el = document.getElementById('resList');
  el.innerHTML = buckets.map(b => {
    const pct = Math.round(b.val/total*100);
    const barW = Math.max(pct, b.val > 0 ? 3 : 0);
    const noteColor = b.cls==='ok'?'var(--teal)':b.cls==='warn'?'#b45309':'var(--rose)';
    return `
      <div class="rt-row">
        <span class="rt-label">${b.label}</span>
        <div class="rt-bar-wrap">
          <div class="rt-bar ${b.cls}" style="width:${barW}%">
            <span class="rt-bar-label${pct<15?' light':''}">${b.val}건·${pct}%</span>
          </div>
        </div>
        <span class="rt-value" style="color:${noteColor}">${b.note}</span>
      </div>`;
  }).join('');
  document.getElementById('avgResNote').textContent = `평균 ${d.summary.avgResolutionMin}분 (~${Math.round(d.summary.avgResolutionMin/60*10)/10}시간) · 비동기 채팅 특성상 고객 미응답 포함`;
}

// ── Render Manager Table ──
function renderManagers(d) {
  // 전수민 영구 제외
  const EXCLUDED = ['전수민'];
  const managers = (d.managers || []).filter(m => !EXCLUDED.includes(m.name));
  const tbody = document.getElementById('managerTbody');
  if (!managers.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px">담당자 데이터 없음</td></tr>'; return; }

  tbody.innerHTML = managers.map((m, i) => {
    const opMax = 100, touchMax = 100;
    const opPct = Math.min(m.operatorScore / opMax * 100, 100);
    const touchPct = Math.min(m.touchScore / touchMax * 100, 100);
    const isActive = m.count > 0;
    const badge = i === 0 && m.count > 0 ? '<span class="badge-top">★ 주담당</span>' :
                  !isActive ? '<span class="badge-off">비활성</span>' : '—';
    const opColor = m.operatorScore > 30 ? 'var(--teal)' : m.operatorScore > 10 ? '#b45309' : 'var(--muted)';
    const touchColor = m.touchScore > 50 ? 'var(--teal)' : m.touchScore > 20 ? '#b45309' : 'var(--muted)';

    return `
      <tr>
        <td><div class="agent-name-cell">
          <div class="agent-avatar" style="${avatarStyle(i)}">${initials(m.name)}</div>
          <span class="agent-name">${m.name}</span>
        </div></td>
        <td>
          <div class="score-cell">
            <span style="font-weight:800;font-variant-numeric:tabular-nums">${m.count > 0 ? m.count + '건' : '—'}</span>
            ${m.count > 0 ? `<div class="score-bar"><div class="score-fill" style="width:${Math.round(m.count/d.summary.totalChats*100)}%"></div></div>
            <span style="font-size:10.5px;color:var(--muted)">${Math.round(m.count/d.summary.totalChats*100)}%</span>` : ''}
          </div>
        </td>
        <td class="num-r"><span style="font-weight:700;color:${opColor}">${m.operatorScore}</span></td>
        <td class="num-r">
          <div class="score-cell" style="justify-content:flex-end">
            <span style="font-weight:700;color:${touchColor}">${m.touchScore}</span>
            <div class="score-bar"><div class="score-fill" style="width:${touchPct}%;background:${touchColor}"></div></div>
          </div>
        </td>
        <td class="num-r" style="color:var(--muted);font-size:11px">${m.count > 0 ? Math.round(d.summary.avgResolutionMin) + '분' : '—'}</td>
        <td>${badge}</td>
      </tr>`;
  }).join('');
}

// ── Render VOC ──
function renderVOC(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocList');
  if (!tags?.labels?.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px">태그 데이터 없음</div>'; return; }

  const contexts = {
    '정기구독/정기구독차량변경': '구독 차량 변경 요청 · 자동화 플로우 점검 권장',
    '컴플레인': '서비스 불만 직접 표시 · 이용 불가 포함',
    '정기구독': '구독 신청·해지·변경 일반 문의',
    '단순이용문의': '사용 방법·이용 안내 일반 문의',
    '기타': '분류 외 기타 문의',
    '가맹상담문의': '파트너 매장 가맹 상담 · 영업팀 연결 권장',
    '컴플레인/이용불가': '서비스 이용 불가 상태 · 즉시 대응 필요',
    '회원/탈퇴': '회원 탈퇴 요청 · 탈퇴 그룹 연계',
  };
  el.innerHTML = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt/summary.totalChats*100);
    const cls = pct >= 15 ? 'rising' : pct >= 8 ? 'warn-r' : '';
    const pctClass = pct >= 15 ? 'pct-high' : pct >= 8 ? 'pct-mid' : 'pct-low';
    const ctx = contexts[lbl] || '관련 문의';
    return `
      <div class="voc-item ${cls}">
        <div>
          <div class="voc-keyword">#${lbl}</div>
          <div class="voc-context">${ctx}</div>
        </div>
        <div class="voc-count">총 <strong>${cnt}</strong>건</div>
        <div class="voc-pct ${pctClass}">${pct}%</div>
      </div>`;
  }).join('');
}

// ── Render Bots & Groups ──
function renderBots(d) {
  const { bots, groups } = d;
  document.getElementById('botCount').textContent = (bots||[]).length;
  document.getElementById('botNames').textContent = (bots||[]).map(b=>b.name).join(' · ') || '—';
  document.getElementById('groupCount').textContent = (groups||[]).length;

  const gl = document.getElementById('groupList');
  gl.innerHTML = (groups||[]).map((g, i) => `
    <div class="group-row">
      <span class="group-rank">${i+1}</span>
      <span class="group-name">${g.name}</span>
      <span class="group-id">ID: ${g.id}</span>
    </div>`).join('');
}

// ── Update banner ──
function updateBanner(d) {
  const el = document.getElementById('updatedAt');
  const dt = new Date(d.updatedAt);
  el.textContent = dt.toLocaleString('ko-KR');
  document.getElementById('channelName').textContent = d.channel?.name || '오토스테이 CS';
  document.getElementById('channelId').textContent = d.channel?.id || '177015';
}

// ── Main render ──
async function render() {
  try {
    setStep('lstep-api', false); setProgress(20);
    const data = await fetchData();
    lastData = data;

    setStep('lstep-api', true); setStep('lstep-charts', false); setProgress(50);

    updateBanner(data);
    renderKPIs(data);
    renderActionCenter(data);
    renderAlert(data);

    setProgress(65);
    renderTrend(data);
    renderHeatmap(data);
    renderCategory(data);

    setProgress(80);
    renderChannel(data);
    renderResolution(data);
    renderManagers(data);

    setProgress(95);
    renderVOC(data);
    renderBots(data);

    setStep('lstep-charts', true); setStep('lstep-done', true); setProgress(100);

    setTimeout(() => { document.getElementById('loadingOverlay').style.display = 'none'; }, 400);
    document.getElementById('errBanner').style.display = 'none';

    // Auto refresh every 5 min
    setTimeout(silentRefresh, 5 * 60 * 1000);

  } catch (err) {
    console.error(err);
    document.getElementById('loadingOverlay').style.display = 'none';
    const eb = document.getElementById('errBanner');
    eb.textContent = `⚠ 데이터 로드 실패: ${err.message} — 5분 후 자동 재시도`;
    eb.style.display = 'block';
    setTimeout(silentRefresh, 5 * 60 * 1000);
  }
}

async function silentRefresh() {
  try {
    const data = await fetchData();
    lastData = data;
    updateBanner(data);
    renderKPIs(data);
    renderActionCenter(data);
    renderAlert(data);
    renderTrend(data);
    renderHeatmap(data);
    renderCategory(data);
    renderChannel(data);
    renderResolution(data);
    renderManagers(data);
    renderVOC(data);
    renderBots(data);
    document.getElementById('errBanner').style.display = 'none';
  } catch (e) { console.warn('Refresh failed', e); }
  setTimeout(silentRefresh, 5 * 60 * 1000);
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  document.getElementById('loadingOverlay').style.display = 'flex';
  render();
});

render();
