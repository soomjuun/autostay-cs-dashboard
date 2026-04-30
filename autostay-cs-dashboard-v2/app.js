// [OPS] 채널톡 CS 대시보드 — app.js v4.0
// 추가: Hero 액션 박스, 탭 통합, FRT/FCR/반복문의, 컴플레인 세분화,
//       채널톡 딥링크, 필터 시스템, KV 캐시 표시
'use strict';

/* ─── Constants ─────────────────────────────────────────────────────────── */
const COLORS = ['#0f766e','#be123c','#14b8a6','#3b82f6','#8b5cf6','#f59e0b','#0369a1','#e11d48','#6d28d9','#0d9488'];
const AVATAR_COLORS = ['#0f766e,#14b8a6','#1d4ed8,#3b82f6','#b45309,#f59e0b','#be123c,#f43f5e','#6d28d9,#8b5cf6','#0369a1,#0ea5e9','#059669,#34d399'];
const EXCLUDED_MANAGERS = ['전수민'];
const VOC_CONTEXTS = {
  '정기구독/정기구독차량변경': '구독 차량 변경 요청 · 자동화 플로우 점검 권장',
  '컴플레인': '서비스 불만 직접 표시 · 즉시 대응 필요',
  '정기구독': '구독 신청·해지·변경 일반 문의',
  '단순이용문의': '사용 방법·이용 안내 일반 문의',
  '기타': '분류 외 기타 문의',
  '가맹상담문의': '파트너 매장 가맹 상담 · 영업팀 연결 권장',
  '컴플레인/이용불가': '서비스 이용 불가 상태 · 즉시 대응 필요',
  '회원/탈퇴': '회원 탈퇴 요청 · 탈퇴 그룹 연계',
};

Chart.defaults.font.family = "'Pretendard Variable', Pretendard, sans-serif";
Chart.defaults.color = '#78716c';
Chart.defaults.borderColor = '#f1efe8';

let charts = {};
let lastData = null;
let lastFilteredData = null;
let currentDays = 30;
let refreshTimer = null;
let lastSuccessTime = null;

// C-2: 필터 상태
const filterState = {
  managers: new Set(),  // assigneeId
  tags: new Set(),      // tag string
  sources: new Set(),   // 'native' | 'phone' | 'other'
};

/* ─── Helpers ───────────────────────────────────────────────────────────── */
function setStep(id, done = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('active', 'done');
  el.classList.add(done ? 'done' : 'active');
}
function setProgress(pct) {
  const bar = document.getElementById('loadProgressBar');
  if (bar) bar.style.width = pct + '%';
}
function fmt(n, unit = '') {
  if (n == null) return '—';
  return Number(n).toLocaleString('ko-KR') + unit;
}
function initials(name) {
  return (name || '?').replace(/오토스테이_/, '').replace(/[^A-Za-z가-힣]/g, '').slice(0, 2).toUpperCase() || '?';
}
function avatarStyle(idx) {
  const [a, b] = AVATAR_COLORS[idx % AVATAR_COLORS.length].split(',');
  return `background:linear-gradient(135deg,${a},${b})`;
}
function fmtMin(min) {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}분`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}일 ${h % 24}h`;
}
function deltaArrow(pct) {
  if (pct == null || isNaN(pct)) return '<span class="delta-arrow flat">—</span>';
  if (pct > 5)  return `<span class="delta-arrow up">▲ ${pct}%</span>`;
  if (pct < -5) return `<span class="delta-arrow down">▼ ${Math.abs(pct)}%</span>`;
  return `<span class="delta-arrow flat">→ ${pct}%</span>`;
}
function safeRender(fn, label) {
  try { fn(); } catch (e) { console.warn('[render] ' + label + ' failed:', e && e.message); }
}

/* ─── C-1: 채널톡 딥링크 ──────────────────────────────────────────────── */
function getChannelId() {
  return (lastData && lastData.channel && lastData.channel.id) || null;
}
function chatTalkUrl(chatId) {
  const cid = getChannelId();
  if (!cid || !chatId) return null;
  return `https://desk.channel.io/#/channels/${cid}/user_chats/${chatId}`;
}
function chatTalkChannel() {
  const cid = getChannelId();
  return cid ? `https://desk.channel.io/#/channels/${cid}` : 'https://desk.channel.io';
}
function chatTalkUnassignedUrl() {
  const cid = getChannelId();
  if (!cid) return 'https://desk.channel.io';
  return `https://desk.channel.io/#/channels/${cid}/team_chats?state=unassigned`;
}

/* ─── C-2: 필터 시스템 ────────────────────────────────────────────────── */
function activeFilterCount() {
  return filterState.managers.size + filterState.tags.size + filterState.sources.size;
}

// 데이터에 필터 적용 (클라이언트 측)
// longChats / openChatList / managers 등 필터링
function applyFilters(data) {
  if (activeFilterCount() === 0) return data;
  const out = JSON.parse(JSON.stringify(data));

  // longChats 필터링
  out.longChats = (data.longChats || []).filter((c) => {
    if (filterState.managers.size && !filterState.managers.has(c.assigneeId || '_unassigned')) return false;
    if (filterState.tags.size && !c.tags.some((t) => filterState.tags.has(t))) return false;
    if (filterState.sources.size && !filterState.sources.has(c.source)) return false;
    return true;
  });

  // managers 필터링 (선택된 담당자만)
  if (filterState.managers.size) {
    out.managers = (data.managers || []).filter((m) =>
      filterState.managers.has(m.id) || m.count === 0
    );
  }

  // tags 필터링
  if (filterState.tags.size) {
    const tagArr = (data.tags?.labels || []).map((lbl, i) => ({ lbl, val: data.tags.values[i] }));
    const filtered = tagArr.filter((t) => filterState.tags.has(t.lbl));
    out.tags = {
      labels: filtered.map((t) => t.lbl),
      values: filtered.map((t) => t.val),
    };
  }

  return out;
}

function renderFilterDrawer(data) {
  const mgrEl = document.getElementById('filterMgrList');
  const tagEl = document.getElementById('filterTagList');
  const srcEl = document.getElementById('filterSrcList');
  if (!mgrEl || !tagEl || !srcEl) return;

  const managers = (data.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0);
  mgrEl.innerHTML = managers.map((m) => `
    <span class="filter-chip ${filterState.managers.has(m.id) ? 'active' : ''}" data-fkind="mgr" data-fval="${m.id}">
      ${m.name.replace('오토스테이_','')}<span class="filter-chip-cnt">${m.count}</span>
    </span>
  `).join('');

  const tags = (data.tags?.labels || []).slice(0, 10);
  tagEl.innerHTML = tags.map((t, i) => `
    <span class="filter-chip ${filterState.tags.has(t) ? 'active' : ''}" data-fkind="tag" data-fval="${t}">
      #${t}<span class="filter-chip-cnt">${data.tags.values[i] || 0}</span>
    </span>
  `).join('');

  const srcMap = { native: '인앱', phone: '전화', other: '기타' };
  srcEl.innerHTML = ['native', 'phone', 'other'].map((s) => {
    const cnt = (data.sources || {})[s] || 0;
    if (cnt === 0) return '';
    return `<span class="filter-chip ${filterState.sources.has(s) ? 'active' : ''}" data-fkind="src" data-fval="${s}">
      ${srcMap[s]}<span class="filter-chip-cnt">${cnt}</span>
    </span>`;
  }).join('');

  // chip 클릭 핸들러
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.onclick = () => {
      const kind = chip.dataset.fkind;
      const val = chip.dataset.fval;
      const set = kind === 'mgr' ? filterState.managers : kind === 'tag' ? filterState.tags : filterState.sources;
      if (set.has(val)) set.delete(val); else set.add(val);
      chip.classList.toggle('active');
      updateFilterBadges();
      applyFilteredRender();
    };
  });
}

function updateFilterBadges() {
  const badgeEl = document.getElementById('filterBadgeRow');
  const countEl = document.getElementById('filterCount');
  const total = activeFilterCount();
  if (countEl) {
    countEl.style.display = total > 0 ? 'inline-flex' : 'none';
    countEl.textContent = total;
  }
  if (!badgeEl) return;
  if (total === 0) { badgeEl.style.display = 'none'; return; }
  badgeEl.style.display = 'flex';
  const mgrMap = {};
  (lastData?.managers || []).forEach((m) => { mgrMap[m.id] = m.name.replace('오토스테이_',''); });
  const srcMap = { native: '인앱', phone: '전화', other: '기타' };
  const badges = [];
  filterState.managers.forEach((id) => badges.push({ kind: 'mgr', val: id, label: `담당: ${mgrMap[id] || id}` }));
  filterState.tags.forEach((t) => badges.push({ kind: 'tag', val: t, label: `#${t}` }));
  filterState.sources.forEach((s) => badges.push({ kind: 'src', val: s, label: `채널: ${srcMap[s] || s}` }));
  badgeEl.innerHTML = `<span style="font-size:10.5px;color:var(--muted);font-weight:700;margin-right:4px">활성 필터:</span>` +
    badges.map((b) => `<span class="filter-badge">${b.label}<span class="filter-badge-x" data-fkind="${b.kind}" data-fval="${b.val}">×</span></span>`).join('');
  badgeEl.querySelectorAll('.filter-badge-x').forEach((x) => {
    x.onclick = () => {
      const set = x.dataset.fkind === 'mgr' ? filterState.managers : x.dataset.fkind === 'tag' ? filterState.tags : filterState.sources;
      set.delete(x.dataset.fval);
      updateFilterBadges();
      renderFilterDrawer(lastData);
      applyFilteredRender();
    };
  });
}

function applyFilteredRender() {
  if (!lastData) return;
  const filtered = applyFilters(lastData);
  lastFilteredData = filtered;
  fullRender(filtered);
}

/* ─── A-2: Hero 액션 박스 ─────────────────────────────────────────────── */
function renderHeroAction(d, scoreObj) {
  const hacBody = document.getElementById('hacBody');
  const hacGrade = document.getElementById('hacGrade');
  const hacFooter = document.getElementById('hacFooter');
  if (!hacBody) return;

  const score = scoreObj.score;
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  const unassigned = d.summary.unassignedChats || 0;
  const openChats = d.summary.openChats || 0;
  const slow8h = rb['8시간+'] || 0;
  const complaintPct = scoreObj.complaintPct || 0;
  const topMgr = managers[0];
  const topPct = topMgr ? Math.round((topMgr.count / total) * 100) : 0;

  // 우선순위 액션 모음
  const actions = [];

  if (unassigned > 0) {
    actions.push({
      type: 'danger', title: '미배정 채팅',
      sub: '채널톡 미배정 큐 즉시 확인',
      metric: unassigned + '건',
      url: chatTalkUnassignedUrl(),
    });
  }
  if (slow8h > 0) {
    actions.push({
      type: slow8h > 10 ? 'danger' : 'warn',
      title: '8시간+ 미해결',
      sub: '장기 지연 케이스 확인',
      metric: slow8h + '건',
      onclick: 'openLongChatsPanel(); return false;',
    });
  }
  if (complaintPct >= 15) {
    actions.push({
      type: 'danger', title: `컴플레인 급증 ${complaintPct}%`,
      sub: '위험 기준(15%) 초과 — 원인 점검',
      metric: complaintPct + '%',
      onclick: `document.querySelector('[data-tab="voc-complaint"]').click(); return false;`,
    });
  } else if (complaintPct >= 8) {
    actions.push({
      type: 'warn', title: `컴플레인 모니터링 ${complaintPct}%`,
      sub: '주의 기준(8%) 초과',
      metric: complaintPct + '%',
      onclick: `document.querySelector('[data-tab="voc-complaint"]').click(); return false;`,
    });
  }
  if (topPct > 70) {
    actions.push({
      type: 'warn', title: `${topMgr.name.replace('오토스테이_','')} 편중`,
      sub: '재배정 검토 필요',
      metric: topPct + '%',
      onclick: `document.querySelector('[data-tab="mgr-conc"]').click(); return false;`,
    });
  }
  if (openChats > 5) {
    actions.push({
      type: 'warn', title: '미해결 오픈 채팅',
      sub: '고객 대기 장기화 위험',
      metric: openChats + '건',
      url: chatTalkChannel(),
    });
  }

  // 상위 3개만
  const top3 = actions.slice(0, 3);
  if (top3.length === 0) {
    top3.push({
      type: 'good', title: '조치 필요 항목 없음',
      sub: '모든 지표 정상 범위',
      metric: '✓',
    });
  }

  if (hacBody) {
    hacBody.innerHTML = top3.map((a, i) => {
      const inner = `
        <div class="hac-row-num">${i + 1}</div>
        <div class="hac-row-body">
          <div class="hac-row-title">${a.title}</div>
          <div class="hac-row-sub">${a.sub}</div>
        </div>
        <div class="hac-row-metric">${a.metric}</div>
      `;
      if (a.url) {
        return `<a href="${a.url}" target="_blank" class="hac-row-link"><div class="hac-row ${a.type}">${inner}</div></a>`;
      } else if (a.onclick) {
        return `<div class="hac-row ${a.type}" onclick="${a.onclick}">${inner}</div>`;
      }
      return `<div class="hac-row ${a.type}">${inner}</div>`;
    }).join('');
  }

  if (hacGrade) {
    const cls = score >= 80 ? 'good' : score >= 60 ? 'warn' : 'danger';
    const lbl = score >= 80 ? '양호' : score >= 60 ? '주의' : '위험';
    hacGrade.textContent = `${score}점 · ${lbl}`;
    hacGrade.className = `hac-grade ${cls}`;
  }

  if (hacFooter) {
    const updated = lastSuccessTime ? lastSuccessTime.toLocaleTimeString('ko-KR') : '—';
    hacFooter.textContent = `마지막 갱신 ${updated} · 5분 자동 새로고침`;
  }
}

/* ─── 건강 점수 계산 (기존) ────────────────────────────────────────────── */
function computeHealthScore(d) {
  let score = 100;
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintRate = complaints / total;
  let deductComplaint = 0;
  if (complaintRate > 0.20) deductComplaint = 25;
  else if (complaintRate > 0.15) deductComplaint = 18;
  else if (complaintRate > 0.10) deductComplaint = 10;
  else if (complaintRate > 0.05) deductComplaint = 4;
  score -= deductComplaint;

  const slowRate = (rb['8시간+'] || 0) / resTotal;
  let deductSlow = 0;
  if (slowRate > 0.50) deductSlow = 20;
  else if (slowRate > 0.35) deductSlow = 14;
  else if (slowRate > 0.20) deductSlow = 8;
  if ((rb['2~8시간'] || 0) / resTotal > 0.30) deductSlow += 5;
  score -= deductSlow;

  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  let deductConc = 0;
  if (managers.length > 0) {
    const topPct = (managers[0].count || 0) / total;
    if (topPct > 0.85) deductConc = 20;
    else if (topPct > 0.70) deductConc = 12;
    else if (topPct > 0.55) deductConc = 5;
  }
  score -= deductConc;

  const quickRate = ((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal;
  if (quickRate > 0.50) score += 10;
  else if (quickRate > 0.30) score += 5;
  if (d.summary.openChats > 10) score -= 5;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    deductComplaint, deductSlow, deductConc,
    complaintPct: Math.round(complaintRate * 100),
    slowPct: Math.round(slowRate * 100),
    topPct: managers.length > 0 ? Math.round((managers[0].count || 0) / total * 100) : 0,
  };
}

function getGrade(score) {
  if (score >= 80) return { grade: 'A', label: '양호', color: '#15803d' };
  if (score >= 65) return { grade: 'B', label: '보통', color: '#b45309' };
  if (score >= 50) return { grade: 'C', label: '주의', color: '#dc2626' };
  return { grade: 'D', label: '위험', color: '#be123c' };
}

const GRADE_STYLES = {
  A: { bg: '#f0fdf4', border: '#86efac', color: '#15803d', barColor: '#22c55e' },
  B: { bg: '#fef9ec', border: '#fcd34d', color: '#b45309', barColor: '#f59e0b' },
  C: { bg: '#fff7ed', border: '#fdba74', color: '#ea580c', barColor: '#f97316' },
  D: { bg: '#fff1f2', border: '#fda4af', color: '#be123c', barColor: '#f43f5e' },
};

function renderHealthScore(scoreObj, d) {
  const { score, deductComplaint, deductSlow, deductConc, complaintPct, slowPct, topPct } = scoreObj;
  const { grade, label } = getGrade(score);
  const gs = GRADE_STYLES[grade] || GRADE_STYLES.D;

  const arcLen = 188.5;
  const fill = document.getElementById('gaugeFill');
  if (fill) {
    fill.style.stroke = gs.barColor;
    fill.style.strokeDashoffset = arcLen;
    requestAnimationFrame(() => {
      setTimeout(() => { fill.style.strokeDashoffset = arcLen - (arcLen * score / 100); }, 200);
    });
  }
  const sv = document.getElementById('healthScore');
  if (sv) sv.textContent = score;
  const sg = document.getElementById('healthGrade');
  if (sg) {
    sg.textContent = `${grade} · ${label}`;
    sg.style.cssText = `background:${gs.bg};color:${gs.color};border:1px solid ${gs.border}`;
  }
  const ss = document.getElementById('healthSub');
  if (ss) {
    const totalDeduct = deductComplaint + deductSlow + deductConc;
    if (totalDeduct === 0) {
      ss.innerHTML = '<span style="color:var(--green);font-weight:700">✓ 감점 없음</span>';
    } else {
      ss.innerHTML = `총 -${totalDeduct}점 / 100점`;
    }
  }
}

/* ─── Insights / Alert (기존 유지) ──────────────────────────────────── */
function generateInsights(d, scoreObj) {
  const insights = [];
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  const complaintPct = scoreObj.complaintPct;
  if (complaintPct >= 15) insights.push({ type: 'danger', icon: '위험', text: `컴플레인 ${complaintPct}% — 즉각 대응 필요` });
  else if (complaintPct >= 8) insights.push({ type: 'warn', icon: '주의', text: `컴플레인 ${complaintPct}% — 모니터링` });
  if (managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    const topName = managers[0].name.replace('오토스테이_','');
    if (topPct > 80) insights.push({ type: 'danger', icon: '위험', text: `${topName} 집중도 ${topPct}%` });
    else if (topPct > 60) insights.push({ type: 'warn', icon: '주의', text: `${topName} 집중도 ${topPct}%` });
  }
  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 30) insights.push({ type: 'warn', icon: '지연', text: `8h+ 해결 ${slowPct}%` });
  // FRT 인사이트
  if (d.frtStats && d.frtStats.median > 30) {
    insights.push({ type: 'warn', icon: 'FRT', text: `첫 응답 P50 ${fmtMin(d.frtStats.median)} — 응답 속도 개선 필요` });
  } else if (d.frtStats && d.frtStats.median <= 5) {
    insights.push({ type: 'good', icon: 'FRT', text: `첫 응답 P50 ${fmtMin(d.frtStats.median)} — 신속 대응 양호` });
  }
  // FCR
  if (d.fcrStats && d.fcrStats.fcrRate < 80) {
    insights.push({ type: 'warn', icon: 'FCR', text: `1차 해결률 ${d.fcrStats.fcrRate}% — 재오픈 ${d.fcrStats.reopenedCount}건` });
  }
  return insights;
}

function renderInsights(insights) {
  const strip = document.getElementById('insightsStrip');
  if (!strip) return;
  if (!insights.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = `<div class="insights-label">자동 인사이트</div>` + insights.map((ins) => `
    <div class="insight-chip ${ins.type}">
      <span class="insight-icon insight-label-badge">${ins.icon}</span>
      <span>${ins.text}</span>
    </div>`).join('');
}

function renderAlertStrip(d, scoreObj) {
  const score = scoreObj.score;
  const strip = document.getElementById('alertStrip');
  if (!strip) return;
  const alerts = [];
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  if (managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    if (topPct > 70) alerts.push({ level: 'danger', icon: '과부하', title: '담당자 과부하', body: `${managers[0].name}이(가) 전체 ${topPct}%` });
  }
  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => lbl.includes('컴플레인') ? acc + (d.tags.values[i] || 0) : acc, 0);
  const complaintPct = Math.round(complaints / total * 100);
  if (complaintPct >= 15) alerts.push({ level: 'danger', icon: '긴급', title: '컴플레인 급증', body: `${complaintPct}% (${complaints}건)` });
  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 40) alerts.push({ level: 'warn', icon: '지연', title: '장시간 미해결', body: `${slowPct}%` });
  if (score < 50) alerts.push({ level: 'danger', icon: 'D등급', title: 'CS 건강 위험', body: `${score}점` });
  if (!alerts.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = alerts.map((a) => `
    <div class="alert-item ${a.level}">
      <div class="al-icon al-label-badge">${a.icon}</div>
      <div class="al-text">
        <div class="al-title">${a.title}</div>
        <div class="al-body">${a.body}</div>
      </div>
    </div>`).join('');
}

/* ─── Hero Quick Stats — FRT 추가 ───────────────────────────────────── */
function renderHeroQuickStats(d, scoreObj) {
  const totalChats = d.summary?.totalChats || 0;
  const openChats = d.summary?.openChats ?? '—';
  const complaintPct = scoreObj?.complaintPct || 0;
  const frtMedian = d.frtStats?.median;
  const complaintColor = complaintPct >= 15 ? 'var(--rose)' : complaintPct >= 8 ? 'var(--amber)' : 'var(--teal)';
  const frtText = frtMedian != null ? fmtMin(frtMedian) : '—';

  const elT = document.getElementById('hqsTotal'); if (elT) elT.textContent = fmt(totalChats) + '건';
  const elO = document.getElementById('hqsOpen'); if (elO) elO.textContent = openChats + '건';
  const elC = document.getElementById('hqsComplaint');
  if (elC) { elC.textContent = complaintPct + '%'; elC.style.color = complaintColor; }
  const elF = document.getElementById('hqsFrt'); if (elF) elF.textContent = frtText;
}

/* ─── KPI Grid ──────────────────────────────────────────────────────── */
function renderKPIs(d, scoreObj) {
  const { summary } = d;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  const topMgr = managers[0];
  const totalChats = summary.totalChats || 1;
  const openChats = summary.openChats || 0;
  const unassigned = summary.unassignedChats || 0;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const slow8h = rb['8시간+'] || 0;
  const slow8hPct = Math.round(slow8h / resTotal * 100);
  const topPct = topMgr ? Math.round((topMgr.count / totalChats) * 100) : 0;
  const complaintPct = scoreObj?.complaintPct || 0;
  const dataNote = d.dataNote || {};
  const isSampled = dataNote.isSampled || false;
  const limitVal = dataNote.limit || 1000;
  const cacheText = d.diagnostics?.cacheHit ? `<span class="hero-cache-badge cache-hit">⚡ 캐시</span>` : `<span class="hero-cache-badge cache-miss">🔄 새로고침</span>`;

  const cacheBadge = document.getElementById('cacheBadge');
  if (cacheBadge) cacheBadge.innerHTML = d.diagnostics?.cacheHit ? '⚡ KV 캐시' : '🔄 fresh';

  const kpiBasisHeaderEl = document.getElementById('kpiBasisHeader');
  if (kpiBasisHeaderEl) {
    kpiBasisHeaderEl.style.display = 'flex';
    const sampledWarn = isSampled ? ` <span style="color:var(--amber);font-weight:700">⚠ 수집 상한(${limitVal}건) 도달</span>` : '';
    kpiBasisHeaderEl.innerHTML = `<span>📊 분석 기준</span> <span style="font-weight:400;color:#0d9488">${currentDays === 'all' ? `최근 ${limitVal}건 한도` : `최근 ${currentDays}일`} · closed <strong>${totalChats}건</strong> · 5분 캐시 · KST</span>${sampledWarn}`;
  }

  const grid = document.getElementById('kpiGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="kpi-card a-${unassigned > 0 ? 'rose' : 'green'}" style="cursor:pointer" onclick="window.open('${chatTalkUnassignedUrl()}','_blank')">
      <div class="kpi-label">미배정</div>
      <div class="kpi-value">${fmt(unassigned)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${unassigned > 0 ? 'bad' : 'good'}">${unassigned > 0 ? '즉시 배정' : '없음'}</span>
      </div>
    </div>
    <div class="kpi-card a-${openChats > 5 ? 'rose' : openChats > 0 ? 'amber' : 'green'}">
      <div class="kpi-label">오픈 채팅</div>
      <div class="kpi-value">${fmt(openChats)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${openChats === 0 ? 'good' : openChats > 5 ? 'bad' : 'neutral'}">${openChats === 0 ? '없음' : '진행중'}</span>
      </div>
    </div>
    <div class="kpi-card a-${slow8h > 10 ? 'rose' : slow8h > 0 ? 'amber' : 'green'}" style="cursor:pointer" onclick="openLongChatsPanel()">
      <div class="kpi-label">8시간+ 미해결</div>
      <div class="kpi-value">${fmt(slow8h)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-calc">계산값</span>
        <span class="delta ${slow8h === 0 ? 'good' : slow8h > 10 ? 'bad' : 'neutral'}">${slow8hPct}%</span>
      </div>
    </div>
    <div class="kpi-card a-${complaintPct >= 15 ? 'rose' : complaintPct >= 8 ? 'amber' : 'green'}">
      <div class="kpi-label">컴플레인율</div>
      <div class="kpi-value">${complaintPct}<span class="unit">%</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${complaintPct >= 15 ? 'bad' : complaintPct >= 8 ? 'neutral' : 'good'}">${complaintPct >= 15 ? '즉시 대응' : complaintPct >= 8 ? '모니터링' : '양호'}</span>
      </div>
    </div>
    <div class="kpi-card a-${topPct > 80 ? 'rose' : topPct > 60 ? 'amber' : 'green'}">
      <div class="kpi-label">담당자 편중</div>
      <div class="kpi-value">${topPct}<span class="unit">%</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-calc">계산값</span>
        <span class="delta ${topPct > 80 ? 'bad' : topPct > 60 ? 'neutral' : 'good'}">${topPct > 80 ? '과부하' : topPct > 60 ? '주의' : '분산 양호'}</span>
      </div>
      <div class="kpi-meta" style="margin-top:2px"><span style="font-size:10px;color:var(--muted)">${topMgr?.name?.replace('오토스테이_','') || '—'}</span></div>
    </div>
  `;
}

/* ─── Trend ──────────────────────────────────────────────────────────── */
function computeMovingAvg(values, window = 7) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
  });
}

function renderTrend(d) {
  const { dailyTrend, summary } = d;
  const activeVals = dailyTrend.values.filter((v) => v > 0);
  const avg = activeVals.length ? Math.round(activeVals.reduce((a, b) => a + b, 0) / activeVals.length) : 0;
  const peak = Math.max(...dailyTrend.values, 0);
  const ma7 = computeMovingAvg(dailyTrend.values, 7);

  document.getElementById('trendTotal').textContent = fmt(summary.totalChats);
  document.getElementById('trendPeak').textContent = fmt(peak);
  document.getElementById('trendPeakDay').textContent = summary.peakDay?.label || '';
  document.getElementById('trendAvg').textContent = fmt(avg);
  document.getElementById('trendOpen').textContent = fmt(summary.openChats);

  const badge = document.getElementById('trendBadge');
  if (badge) badge.textContent = currentDays === 'all' ? '최근 1000건' : `${currentDays}일`;
  document.getElementById('trendLegend').innerHTML = `
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#0f766e;display:inline-block"></span>일반</span>
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#be123c;display:inline-block"></span>피크</span>
    <span class="trend-legend-item"><span style="width:22px;height:3px;border-top:1.5px dashed #f59e0b;display:inline-block"></span>활성일평균</span>
    <span class="trend-legend-item"><span style="width:22px;height:3px;border-top:2px solid #6d28d9;display:inline-block"></span>7일이동평균</span>`;

  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart(document.getElementById('trendChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: dailyTrend.labels,
      datasets: [
        { label: '종료 채팅', data: dailyTrend.values, backgroundColor: dailyTrend.values.map((v) => v >= peak * 0.8 ? '#be123c' : v >= peak * 0.45 ? '#0f766e' : '#14b8a6'), borderRadius: 3, order: 2 },
        { label: '활성일 평균', data: Array(dailyTrend.labels.length).fill(avg), type: 'line', borderColor: '#f59e0b', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, fill: false, order: 1 },
        { label: '7일 이동평균', data: ma7, type: 'line', borderColor: '#6d28d9', borderWidth: 2, pointRadius: 0, fill: false, tension: 0.35, order: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 7 } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 12 } }, y: { grid: { color: '#f1efe8' }, ticks: { font: { size: 11 }, callback: (v) => v + '건' }, beginAtZero: true } }
    }
  });
  renderPeakAnalysis(d.peakAnalysis, d.managers || []);
}

function renderPeakAnalysis(peakAnalysis, managers) {
  const el = document.getElementById('peakAnalysisPanel');
  if (!el) return;
  if (!peakAnalysis || peakAnalysis.count < 2) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const mgrMap = {};
  (managers || []).forEach((m) => { mgrMap[m.id] = m.name; });
  const topTagsHtml = (peakAnalysis.topTags || []).map((t) => `<span class="peak-tag">#${t.tag} <strong>${t.cnt}</strong>건</span>`).join('');
  const topMgrHtml = (peakAnalysis.topAssignees || []).map((a) => `<span class="peak-tag">${mgrMap[a.id] || a.id} <strong>${a.cnt}</strong>건</span>`).join('') || '—';
  const hourStr = peakAnalysis.peakHour ? `${peakAnalysis.peakHour.hour}시 (${peakAnalysis.peakHour.cnt}건)` : '—';
  el.innerHTML = `
    <div class="peak-panel-header">
      <span class="peak-date-badge">${peakAnalysis.date}</span>
      <span class="peak-count-badge">최고 ${peakAnalysis.count}건</span>
      <span class="peak-title">피크 일자 원인 분석</span>
    </div>
    <div class="peak-facts">
      <div class="peak-fact"><span class="peak-fact-lbl">집중 태그</span><div class="peak-fact-vals">${topTagsHtml}</div></div>
      <div class="peak-fact"><span class="peak-fact-lbl">처리 담당자</span><div class="peak-fact-vals">${topMgrHtml}</div></div>
      <div class="peak-fact"><span class="peak-fact-lbl">피크 시간대</span><div class="peak-fact-vals"><span class="peak-tag">${hourStr}</span></div></div>
    </div>`;
}

/* ─── Heatmap ─────────────────────────────────────────────────────────── */
function renderHeatmap(d) {
  const days = ['월', '화', '수', '목', '금', '토', '일'];
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const hm = d.heatmap || {};
  const allVals = Object.values(hm);
  const maxVal = allVals.length ? Math.max(...allVals) : 1;

  const el = document.getElementById('heatmap');
  el.innerHTML = '';
  el.appendChild(Object.assign(document.createElement('div'), { className: 'hm-head' }));
  hours.forEach((h) => {
    const div = document.createElement('div');
    div.className = 'hm-head'; div.textContent = h;
    el.appendChild(div);
  });
  days.forEach((day, di) => {
    const lbl = document.createElement('div');
    lbl.className = 'hm-row-label'; lbl.textContent = day;
    el.appendChild(lbl);
    hours.forEach((h) => {
      const v = hm[`${di}-${h}`] || 0;
      const lvl = v === 0 ? 0 : Math.min(5, Math.ceil((v / maxVal) * 5));
      const cell = document.createElement('div');
      cell.className = `hm-cell hm-${lvl}`;
      cell.textContent = v || '';
      cell.title = `${day}요일 ${h}시 · ${v}건`;
      el.appendChild(cell);
    });
  });
  const leg = document.getElementById('hmLegend');
  if (leg) {
    leg.innerHTML = '';
    [0, 1, 2, 3, 4, 5].forEach((i) => {
      const s = document.createElement('span');
      s.className = `hm-${i}`;
      s.style.cssText = 'width:12px;height:12px;border-radius:2px;display:block';
      leg.appendChild(s);
    });
  }

  const hmPeakEl = document.getElementById('hmPeakSummary');
  if (hmPeakEl) {
    const hourTotals = {};
    for (let di = 0; di < 7; di++) for (let h = 0; h < 24; h++) {
      hourTotals[h] = (hourTotals[h] || 0) + (hm[`${di}-${h}`] || 0);
    }
    const top3Hours = Object.entries(hourTotals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const dayTotals = {};
    for (let di = 0; di < 7; di++) {
      dayTotals[di] = 0;
      for (let h = 0; h < 24; h++) dayTotals[di] += hm[`${di}-${h}`] || 0;
    }
    const peakDayIdx = Object.entries(dayTotals).sort((a, b) => b[1] - a[1])[0];
    if (top3Hours.length > 0) hmPeakEl.style.display = 'block';
    hmPeakEl.innerHTML = `
      <div class="hm-peak-title">피크 집중 시간대</div>
      <div class="hm-peak-list">
        ${top3Hours.map(([h, v], rank) => `
          <div class="hm-peak-row rank-${rank + 1}">
            <span class="hm-peak-rank">${rank + 1}위</span>
            <span class="hm-peak-hour">${h}시</span>
            <div class="hm-peak-bar-wrap"><div class="hm-peak-bar" style="width:${Math.round(v / (top3Hours[0][1] || 1) * 100)}%"></div></div>
            <span class="hm-peak-val">${v}건</span>
          </div>`).join('')}
      </div>
      ${peakDayIdx ? `<div class="hm-peak-day-note">📅 주간 최다: <strong>${days[parseInt(peakDayIdx[0])]}요일</strong> (${peakDayIdx[1]}건)</div>` : ''}`;
  }
}

/* ─── Tag Bar ─────────────────────────────────────────────────────────── */
function renderTagBar(d) {
  const { tags, summary } = d;
  if (!tags?.labels?.length) return;
  const el = document.getElementById('tagBarChart');
  if (!el) return;
  if (charts.cat) charts.cat.destroy();
  const total = summary.totalChats || 1;
  charts.cat = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: tags.labels.slice(0, 10),
      datasets: [{ data: tags.values.slice(0, 10), backgroundColor: COLORS, borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 7, callbacks: { label: (ctx) => `${ctx.parsed.x}건 (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` } } },
      scales: { x: { grid: { color: '#f1efe8' }, ticks: { font: { size: 10 } } }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } }
    }
  });
}

function renderVOC(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocList');
  if (!el || !tags?.labels?.length) { if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px">태그 데이터 없음</div>'; return; }
  const totalForPct = summary.totalChats || 1;
  el.innerHTML = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt / totalForPct * 100);
    const cls = pct >= 15 ? 'rising' : pct >= 8 ? 'warn-r' : '';
    const ctx = VOC_CONTEXTS[lbl] || '관련 문의';
    const trendHtml = pct >= 15 ? '<span class="voc-trend up">비율 상위</span>' : pct >= 8 ? '<span class="voc-trend up" style="background:var(--amber-bg);color:var(--amber)">주목</span>' : '<span class="voc-trend flat">일반</span>';
    return `
      <div class="voc-item ${cls}">
        <div>
          <div class="voc-keyword">#${lbl} ${trendHtml}</div>
          <div class="voc-context">${ctx}</div>
        </div>
        <div class="voc-count">총 <strong>${cnt}</strong>건</div>
        <div class="voc-pct ${pct >= 15 ? 'pct-high' : pct >= 8 ? 'pct-mid' : 'pct-low'}">${pct}%</div>
      </div>`;
  }).join('');
}

function renderVocRiskSection(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocRiskCards');
  if (!el || !tags?.labels?.length) { if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px">태그 데이터 없음</div>'; return; }
  const total = summary.totalChats || 1;
  const items = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt = tags.values[i] || 0;
    const pct = Math.round(cnt / total * 100);
    const action = lbl.includes('컴플레인') ? { label: '즉시 대응', cls: 'action-urgent' }
      : pct >= 15 ? { label: '즉시 대응', cls: 'action-urgent' }
      : pct >= 8 ? { label: 'FAQ 개선', cls: 'action-faq' }
      : { label: '담당자 확인', cls: 'action-check' };
    const badge = lbl.includes('컴플레인') || pct >= 15 ? '<span class="vrc-risk-badge risk-high">HIGH</span>'
      : pct >= 8 ? '<span class="vrc-risk-badge risk-mid">MID</span>'
      : '<span class="vrc-risk-badge risk-low">LOW</span>';
    const ctx = VOC_CONTEXTS[lbl] || '관련 문의';
    return { lbl, cnt, pct, action, ctx, badge, riskScore: lbl.includes('컴플레인') ? 100 : pct };
  }).sort((a, b) => b.riskScore - a.riskScore);
  el.innerHTML = items.map((it) => `
    <div class="voc-risk-card ${it.pct >= 15 || it.lbl.includes('컴플레인') ? 'vrc-high' : it.pct >= 8 ? 'vrc-mid' : 'vrc-low'}">
      <div class="vrc-header"><span class="vrc-tag">#${it.lbl}</span>${it.badge}</div>
      <div class="vrc-meta">${it.ctx}</div>
      <div class="vrc-numbers"><span class="vrc-count">${it.cnt}건</span><span class="vrc-pct">${it.pct}%</span></div>
      <div class="vrc-action ${it.action.cls}">${it.action.label}</div>
    </div>`).join('');
}

function renderTagRes(d) {
  const el = document.getElementById('tagResTable');
  if (!el) return;
  const stats = d.tagResolutionStats || [];
  if (!stats.length) { el.innerHTML = '<div class="adv-empty">태그별 해결시간 데이터 없음</div>'; return; }
  const maxAvg = Math.max(...stats.map((s) => s.avg), 1);
  el.innerHTML = `
    <table class="tag-res-tbl">
      <thead><tr><th style="width:32px">#</th><th>태그</th><th class="num-r" style="width:60px">건수</th><th class="num-r" style="width:90px">평균</th><th>분포</th><th class="num-r" style="width:80px">P50</th><th class="num-r" style="width:80px">P90</th><th style="width:60px">평가</th></tr></thead>
      <tbody>${stats.map((s, i) => {
        const w = Math.round(s.avg / maxAvg * 100);
        const cls = s.avg <= 60 ? 'good' : s.avg <= 240 ? 'warn' : 'danger';
        return `<tr>
          <td class="tr-idx">${i + 1}</td>
          <td class="tr-tag">#${s.tag}</td>
          <td class="num-r">${s.count}</td>
          <td class="num-r tr-avg-${cls}">${fmtMin(s.avg)}</td>
          <td><div class="tr-dist-bar-wrap"><div class="tr-dist-bar tr-dist-${cls}" style="width:${w}%"></div></div></td>
          <td class="num-r">${fmtMin(s.median)}</td>
          <td class="num-r">${fmtMin(s.p90)}</td>
          <td><span class="tr-eval tr-eval-${cls}">${s.avg <= 60 ? '신속' : s.avg <= 240 ? '보통' : '지연'}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function renderTagCooccur(d) {
  const el = document.getElementById('tagCooccurPanel');
  if (!el) return;
  const co = d.tagCooccurrence || [];
  if (!co.length) { el.innerHTML = '<div class="adv-empty">공출현 패턴 없음</div>'; return; }
  const max = co[0].cnt || 1;
  el.innerHTML = co.map((c, i) => {
    const isComp = c.pair.some((p) => p.includes('컴플레인'));
    return `<div class="cooccur-row${isComp ? ' cooccur-complaint' : ''}">
      <span class="cooccur-rank">${i + 1}</span>
      <span class="cooccur-pair"><span class="cooccur-tag">#${c.pair[0]}</span><span class="cooccur-arrow">↔</span><span class="cooccur-tag">#${c.pair[1]}</span></span>
      <div class="cooccur-bar-wrap"><div class="cooccur-bar" style="width:${Math.round(c.cnt / max * 100)}%"></div></div>
      <span class="cooccur-cnt">${c.cnt}건</span>
    </div>`;
  }).join('');
}

/* ─── B-3: 컴플레인 세분화 ──────────────────────────────────────────── */
function renderComplaintCategory(d) {
  const cats = d.complaintCategories || {};
  const total = Object.values(cats).reduce((a, b) => a + b, 0) || 1;

  const summaryEl = document.getElementById('complaintCatSummary');
  if (summaryEl) {
    const items = [
      { key: 'service', label: '서비스 품질', icon: '🎯', cls: 'cat-service' },
      { key: 'system', label: '시스템 오류', icon: '⚙️', cls: 'cat-system' },
      { key: 'pricing', label: '가격/환불', icon: '💰', cls: 'cat-pricing' },
      { key: 'churn', label: '탈퇴/해지', icon: '🚪', cls: 'cat-churn' },
      { key: 'other', label: '기타', icon: '📌', cls: 'cat-other' },
    ];
    summaryEl.innerHTML = items.map((it) => {
      const cnt = cats[it.key] || 0;
      const pct = Math.round(cnt / total * 100);
      return `<div class="complaint-cat-row ${it.cls}">
        <div class="cc-icon">${it.icon}</div>
        <div class="cc-label">${it.label}</div>
        <div class="cc-cnt">${cnt}</div>
        <div class="cc-pct">${pct}%</div>
      </div>`;
    }).join('');
  }

  const trend = d.complaintCategoryTrend || { labels: [], service: [], system: [], pricing: [], churn: [], other: [] };
  const ctx = document.getElementById('complaintCatChart');
  if (ctx) {
    if (charts.complaintCat) charts.complaintCat.destroy();
    charts.complaintCat = new Chart(ctx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: trend.labels,
        datasets: [
          { label: '서비스', data: trend.service, backgroundColor: '#be123c' },
          { label: '시스템', data: trend.system, backgroundColor: '#f59e0b' },
          { label: '가격', data: trend.pricing, backgroundColor: '#6d28d9' },
          { label: '탈퇴', data: trend.churn, backgroundColor: '#1d4ed8' },
          { label: '기타', data: trend.other, backgroundColor: '#a8a29e' },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 9 }, maxTicksLimit: 12 } },
          y: { stacked: true, grid: { color: '#f1efe8' }, ticks: { font: { size: 10 }, callback: (v) => v + '건' }, beginAtZero: true }
        }
      }
    });
  }

  const note = document.getElementById('complaintCatNote');
  if (note) {
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 0) {
      const labelMap = { service: '서비스 품질', system: '시스템 오류', pricing: '가격/환불', churn: '탈퇴/해지', other: '기타' };
      note.innerHTML = `📌 가장 빈번한 컴플레인 유형: <strong>${labelMap[top[0]]}</strong> (${top[1]}건, 전체 컴플레인 중 ${Math.round(top[1] / total * 100)}%) — 우선 대응 권장`;
    } else {
      note.innerHTML = '컴플레인 케이스가 충분하지 않습니다';
    }
  }
}

/* ─── Category Bars ───────────────────────────────────────────────────── */
function renderCategoryBars(d) {
  const { tags, summary } = d;
  const total = summary.totalChats || 1;
  const groups = {
    '구독 관련': { count: 0, color: '#0f766e' },
    '컴플레인 (전체)': { count: 0, color: '#be123c' },
    '컴플레인/이용불가': { count: 0, color: '#e11d48' },
    '이용 문의': { count: 0, color: '#1d4ed8' },
    '기타/운영': { count: 0, color: '#6d28d9' },
  };
  (tags?.labels || []).forEach((lbl, i) => {
    const val = tags.values[i] || 0;
    if (lbl.includes('정기구독') || lbl === '구독') groups['구독 관련'].count += val;
    else if (lbl === '컴플레인/이용불가') groups['컴플레인/이용불가'].count += val;
    else if (lbl.includes('컴플레인')) groups['컴플레인 (전체)'].count += val;
    else if (lbl.includes('이용') || lbl.includes('단순')) groups['이용 문의'].count += val;
    else groups['기타/운영'].count += val;
  });
  groups['컴플레인 (전체)'].count += groups['컴플레인/이용불가'].count;
  const items = Object.entries(groups).map(([label, g]) => ({ label, count: g.count, color: g.color, pct: Math.round(g.count / total * 100) })).sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...items.map((i) => i.count), 1);
  const el = document.getElementById('categoryBars');
  el.innerHTML = items.map((item) => `
    <div class="cat-bar-row${item.label === '컴플레인 (전체)' ? ' cat-bar-row-complaint' : ''}">
      <div class="cat-bar-label">${item.label}</div>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${Math.max(item.count / maxCount * 100, item.count > 0 ? 3 : 0)}%;background:${item.color}"></div></div>
      <div class="cat-bar-val">${item.count}건<span class="cat-pct">${item.pct}%</span></div>
    </div>`).join('');
}

/* ─── Channel ─────────────────────────────────────────────────────────── */
function renderChannel(d) {
  const { sources, summary } = d;
  const total = summary.totalChats || 1;
  const labels = ['앱/웹', '전화'];
  const values = [sources.native || 0, sources.phone || 0];
  const bgColors = ['#0f766e', '#1d4ed8'];
  if ((sources.other || 0) > 0) { labels.push('기타'); values.push(sources.other); bgColors.push('#a8a29e'); }
  if (charts.ch) charts.ch.destroy();
  charts.ch = new Chart(document.getElementById('channelChart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderRadius: 4, barThickness: 22 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c1917', padding: 9, callbacks: { label: (ctx) => `${ctx.parsed.x}건 (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` } } },
      scales: { x: { ticks: { callback: (v) => v + '건', font: { size: 11 } }, grid: { color: '#f1efe8' }, beginAtZero: true }, y: { grid: { display: false } } }
    }
  });
  const items = [
    { label: '앱/웹', count: sources.native || 0, color: '#0f766e' },
    { label: '전화', count: sources.phone || 0, color: '#1d4ed8' },
    { label: '기타', count: sources.other || 0, color: '#a8a29e' },
  ];
  const cs = document.getElementById('channelStats');
  if (cs) cs.innerHTML = items.filter((s) => s.count > 0).map((s) => `
    <div class="ch-stat">
      <div class="ch-stat-dot" style="background:${s.color}"></div>
      <div class="ch-stat-label">${s.label}</div>
      <div class="ch-stat-count">${s.count}건</div>
      <div class="ch-stat-pct">${Math.round(s.count / total * 100)}%</div>
    </div>`).join('');
}

/* ─── Resolution ──────────────────────────────────────────────────────── */
function renderResolution(d) {
  const rb = d.resolutionBuckets;
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quick = (rb['0~5분'] || 0) + (rb['5~30분'] || 0);
  const quickPct = Math.round(quick / resTotal * 100);
  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  const resSummary = document.getElementById('resSummary');
  if (resSummary) {
    resSummary.innerHTML = `
      <div class="res-big ${quickPct >= 50 ? 'good' : quickPct >= 30 ? 'warn' : 'bad'}"><div class="res-big-val">${quickPct}%</div><div class="res-big-lbl">30분 내 해결률</div></div>
      <div class="res-big ${slowPct <= 20 ? 'good' : slowPct <= 40 ? 'warn' : 'bad'}"><div class="res-big-val">${slowPct}%</div><div class="res-big-lbl">8시간+ 장기</div></div>
      <div class="res-big"><div class="res-big-val">${d.summary.avgResolutionMin ?? '—'}</div><div class="res-big-lbl">평균(분)</div></div>`;
  }
  const buckets = [
    { label: '0~5분', val: rb['0~5분'] || 0, cls: 'ok', note: '즉시' },
    { label: '5~30분', val: rb['5~30분'] || 0, cls: 'ok', note: '신속' },
    { label: '30분~2시간', val: rb['30분~2시간'] || 0, cls: 'warn', note: '일반' },
    { label: '2~8시간', val: rb['2~8시간'] || 0, cls: 'warn', note: '지연' },
    { label: '8시간+', val: rb['8시간+'] || 0, cls: 'bad', note: '비동기' },
  ];
  const resList = document.getElementById('resList');
  if (resList) {
    resList.innerHTML = buckets.map((b) => {
      const pct = Math.round(b.val / resTotal * 100);
      return `<div class="rt-row">
        <span class="rt-label">${b.label}</span>
        <div class="rt-bar-wrap"><div class="rt-bar ${b.cls}" style="width:${Math.max(pct, b.val > 0 ? 3 : 0)}%"><span class="rt-bar-label${pct < 18 ? ' light' : ''}">${b.val}건 · ${pct}%</span></div></div>
        <span class="rt-value">${b.note}</span>
      </div>`;
    }).join('');
  }
  const note = document.getElementById('avgResNote');
  if (note) note.textContent = d.summary.avgResolutionMin != null ? `전체 평균 ${d.summary.avgResolutionMin}분 · 비동기 채팅 특성상 고객 미응답 시간 포함` : '데이터 없음';
}

/* ─── Long Delay (C-1: 딥링크 추가) ──────────────────────────────────── */
function renderLongDelayPanel(d) {
  const el = document.getElementById('longDelayPanel');
  if (!el) return;
  const rb = d.resolutionBuckets || {};
  const slow8h = rb['8시간+'] || 0;
  if (slow8h === 0) {
    el.innerHTML = `<div class="long-delay-ok"><div class="ld-ok-icon">✓</div><div class="ld-ok-text">8시간+ 케이스 없음</div></div>`;
    return;
  }
  const longChats = d.longChats || [];
  const mgrMap = {};
  (d.managers || []).forEach((m) => { mgrMap[m.id] = m.name; });
  const top5Html = longChats.slice(0, 5).map((c) => {
    const hrs = Math.floor(c.resolutionMin / 60);
    const days = Math.floor(hrs / 24);
    const timeStr = days >= 1 ? `${days}일 ${hrs % 24}시간` : `${hrs}시간`;
    const mgrName = c.assigneeId ? (mgrMap[c.assigneeId] || c.assigneeId).replace('오토스테이_','') : '미배정';
    const timeColor = c.resolutionMin > 2880 ? 'var(--rose)' : 'var(--amber)';
    const tagsStr = c.tags.slice(0, 2).map((t) => `#${t}`).join(' ') || '태그없음';
    const url = chatTalkUrl(c.id);
    const linkAttr = url ? `onclick="window.open('${url}','_blank')" class="delay-row deeplink-row"` : 'class="delay-row"';
    return `<div ${linkAttr}>
      <span class="delay-time" style="color:${timeColor}">${timeStr}</span>
      <span class="delay-tags">${tagsStr}</span>
      <span class="delay-mgr">${mgrName}${url ? '<span class="deeplink-icon">↗</span>' : ''}</span>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="long-delay-summary">
      <span class="lds-count">${slow8h}건</span>
      <span class="lds-label">8시간+ 해결 케이스</span>
    </div>
    ${top5Html ? `<div class="long-delay-list-header">주요 케이스 TOP 5</div><div class="long-delay-list">${top5Html}</div><a href="#" class="ld-more-link" onclick="openLongChatsPanel();return false;">▸ 전체 목록 (${slow8h}건)</a>` : ''}`;
}

function openLongChatsPanel() {
  if (!lastData || !lastData.longChats) return;
  const modal = document.getElementById('longChatsModal');
  if (!modal) return;
  const mgrMap = {};
  (lastData.managers || []).forEach((m) => { mgrMap[m.id] = m.name; });
  const rows = lastData.longChats.map((c) => {
    const tagsHtml = c.tags.length ? c.tags.map((t) => `<span class="long-tag">#${t}</span>`).join(' ') : '<span style="color:var(--muted)">태그 없음</span>';
    const mgrName = c.assigneeId ? (mgrMap[c.assigneeId] || c.assigneeId) : '미배정';
    const totalMins = c.resolutionMin;
    const totalHrs = Math.floor(totalMins / 60);
    const daysCnt = Math.floor(totalHrs / 24);
    const remHrs = totalHrs % 24;
    const humanTime = daysCnt >= 1 ? `${daysCnt}일 ${remHrs}시간` : `${totalHrs}시간 ${totalMins % 60}분`;
    const timeColor = totalMins > 2880 ? 'var(--rose)' : totalMins > 480 ? 'var(--amber)' : 'var(--text)';
    const url = chatTalkUrl(c.id);
    const dateCell = url ? `<a href="${url}" target="_blank" class="cs-deeplink">${c.date} ↗</a>` : c.date;
    return `<tr>
      <td>${dateCell}</td>
      <td style="color:${timeColor};font-weight:700">${totalMins}분 <span style="color:var(--muted);font-size:10px;font-weight:400">(${humanTime})</span></td>
      <td>${tagsHtml}</td>
      <td style="color:var(--muted)">${mgrName}</td>
    </tr>`;
  }).join('');
  document.getElementById('longChatsBody').innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:2px solid var(--border-soft)"><th style="text-align:left;padding:8px">일자</th><th style="text-align:left;padding:8px">소요시간</th><th style="text-align:left;padding:8px">태그</th><th style="text-align:left;padding:8px">담당자</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--muted)">데이터 없음</td></tr>'}</tbody>
    </table>`;
  modal.style.display = 'flex';
}
function closeLongChatsPanel() {
  const m = document.getElementById('longChatsModal');
  if (m) m.style.display = 'none';
}

/* ─── Concentration / Manager Risk Strip ────────────────────────────── */
function renderConcRisk(d) {
  const el = document.getElementById('concRiskPanel');
  if (!el) return;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  const total = d.summary.totalChats || 1;
  const unassigned = d.summary?.unassignedChats || 0;
  const activeMgrs = managers.filter((m) => m.count > 0);
  const topMgr = activeMgrs[0];
  const topPct = topMgr ? Math.round(topMgr.count / total * 100) : 0;
  const topName = topMgr ? topMgr.name.replace('오토스테이_','') : '—';
  const uaCls = unassigned > 0 ? 'crr-danger' : 'crr-ok';
  const concCls = topPct > 70 ? 'crr-danger' : topPct > 50 ? 'crr-warn' : 'crr-ok';
  el.innerHTML = `
    <div class="conc-risk-row ${uaCls}">
      <div class="crr-left"><div class="crr-label">미배정 채팅</div><div class="crr-sub">즉시 담당자 배정 필요</div></div>
      <div class="crr-right">
        <div class="crr-value ${unassigned > 0 ? 'val-danger' : 'val-ok'}">${unassigned}건</div>
        <div class="crr-action-tag ${unassigned > 0 ? 'action-urgent' : 'action-ok'}">${unassigned > 0 ? '즉시' : '정상'}</div>
      </div>
    </div>
    <div class="conc-risk-row ${concCls}">
      <div class="crr-left"><div class="crr-label">업무 집중도</div><div class="crr-sub">${topName} 담당</div></div>
      <div class="crr-right"><div class="crr-value ${topPct > 70 ? 'val-danger' : topPct > 50 ? 'val-warn' : 'val-ok'}">${topPct}%</div><div class="crr-action-tag ${topPct > 70 ? 'action-urgent' : topPct > 50 ? 'action-check' : 'action-ok'}">${topPct > 70 ? '분산' : topPct > 50 ? '모니터링' : '정상'}</div></div>
    </div>
    <div class="conc-risk-row ${activeMgrs.length < 2 ? 'crr-warn' : 'crr-ok'}">
      <div class="crr-left"><div class="crr-label">활성 담당자</div><div class="crr-sub">처리건수 1건 이상</div></div>
      <div class="crr-right"><div class="crr-value">${activeMgrs.length}명</div><div class="crr-action-tag ${activeMgrs.length < 2 ? 'action-check' : 'action-ok'}">${activeMgrs.length < 2 ? '백업' : '정상'}</div></div>
    </div>`;
}

function renderMgrRiskStrip(d) {
  const el = document.getElementById('mgrRiskStrip');
  if (!el) return;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  const total = d.summary.totalChats || 1;
  const unassigned = d.summary?.unassignedChats || 0;
  const topMgr = managers[0];
  const topPct = topMgr ? Math.round((topMgr.count / total) * 100) : 0;
  const topName = topMgr ? topMgr.name.replace('오토스테이_','') : '—';
  const concStatus = topPct > 80 ? { cls: 'danger', label: '과부하' } : topPct > 60 ? { cls: 'warn', label: '주의' } : { cls: 'good', label: '양호' };
  const unaStatus = unassigned > 0 ? { cls: 'danger', label: '즉시 배정' } : { cls: 'good', label: '없음' };
  el.innerHTML = `
    <div class="mgr-risk-card mrc-${concStatus.cls}"><div class="mrc-icon">${topPct > 80 ? '🔴' : topPct > 60 ? '🟡' : '🟢'}</div><div class="mrc-body"><div class="mrc-label">담당자 편중률</div><div class="mrc-value">${topName} · ${topPct}%</div><div class="mrc-status ${concStatus.cls}">${concStatus.label}</div></div></div>
    <div class="mgr-risk-card mrc-${unaStatus.cls}"><div class="mrc-icon">${unassigned > 0 ? '🔴' : '🟢'}</div><div class="mrc-body"><div class="mrc-label">미배정 채팅</div><div class="mrc-value">${unassigned}건</div><div class="mrc-status ${unaStatus.cls}">${unaStatus.label}</div></div></div>`;
}

/* ─── Manager Table — FRT 컬럼 추가 ─────────────────────────────────── */
function agentComment(m, rank) {
  if (!m.count) return '<span class="agent-comment off">비활성</span>';
  if (rank === 0 && m.operatorScore > 30 && m.touchScore > 50) return '<span class="agent-comment top">TOP 퍼포머</span>';
  if (m.operatorScore < 10 && m.touchScore < 20) return '<span class="agent-comment warn">코칭 필요</span>';
  if (m.touchScore < 20) return '<span class="agent-comment warn">응대 보완</span>';
  if (m.operatorScore < 10) return '<span class="agent-comment warn">효율 점검</span>';
  return '<span class="agent-comment normal">정상</span>';
}

function renderManagers(d) {
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  const total = d.summary.totalChats || 1;
  const tbody = document.getElementById('managerTbody');
  if (!tbody) return;
  if (!managers.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">담당자 데이터 없음</td></tr>'; return; }

  tbody.innerHTML = managers.map((m, i) => {
    const isActive = m.count > 0;
    const opColor = m.operatorScore > 30 ? 'var(--teal)' : m.operatorScore > 10 ? '#b45309' : 'var(--muted)';
    const tcColor = m.touchScore > 50 ? 'var(--teal)' : m.touchScore > 20 ? '#b45309' : 'var(--muted)';
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : 'rn';
    const frtDisplay = isActive && m.medianFrtMin != null ? fmtMin(m.medianFrtMin) : '—';
    const resDisplay = isActive && m.avgResolutionMin != null ? `${m.avgResolutionMin}분` : (isActive ? '—' : '—');
    return `<tr style="${!isActive ? 'opacity:.55' : ''}">
      <td style="text-align:center"><span class="agent-rank ${rankClass}">${isActive ? i + 1 : '—'}</span></td>
      <td><div class="agent-name-cell"><div class="agent-avatar" style="${avatarStyle(i)}">${initials(m.name)}</div><span class="agent-name">${m.name.replace('오토스테이_','')}</span></div></td>
      <td class="num-r"><span style="font-weight:800">${isActive ? m.count + '건' : '—'}</span></td>
      <td class="num-r" style="font-size:11px;color:${m.medianFrtMin != null && m.medianFrtMin <= 5 ? 'var(--teal)' : m.medianFrtMin != null && m.medianFrtMin > 30 ? 'var(--amber)' : 'var(--text)'}">${frtDisplay}</td>
      <td class="num-r" style="font-size:11px">${resDisplay}</td>
      <td class="num-r"><div class="score-cell-fixed"><div class="score-bar-fixed"><div class="score-fill" style="width:${Math.min(m.operatorScore, 100)}%;background:${opColor}"></div></div><span class="score-num" style="color:${opColor}">${m.operatorScore}</span></div></td>
      <td>${agentComment(m, i)}</td>
    </tr>`;
  }).join('');

  // 사이드바
  const sidebar = document.getElementById('agentSidebar');
  if (sidebar) {
    const activeMgrs = managers.filter((m) => m.count > 0);
    const avgOp = activeMgrs.length ? Math.round(activeMgrs.reduce((s, m) => s + (m.operatorScore || 0), 0) / activeMgrs.length) : 0;
    const fastMgr = activeMgrs.filter((m) => m.medianFrtMin != null).sort((a, b) => a.medianFrtMin - b.medianFrtMin)[0];
    sidebar.innerHTML = `
      <div class="agent-stat-card">
        <div class="agent-stat-card-title">👥 인원</div>
        <div class="agent-stat-row"><span class="agent-stat-label">활성</span><span class="agent-stat-value" style="color:var(--teal)">${activeMgrs.length}명</span></div>
        <div class="agent-stat-row"><span class="agent-stat-label">총 처리</span><span class="agent-stat-value">${total.toLocaleString()}건</span></div>
      </div>
      <div class="agent-stat-card">
        <div class="agent-stat-card-title">📊 평균</div>
        <div class="agent-stat-row"><span class="agent-stat-label">운영 점수</span><span class="agent-stat-value">${avgOp}</span></div>
        ${fastMgr ? `<div class="agent-stat-row"><span class="agent-stat-label">최단 FRT</span><span class="agent-stat-value" style="font-size:10.5px;color:var(--teal)">${fastMgr.name.replace('오토스테이_','')} ${fmtMin(fastMgr.medianFrtMin)}</span></div>` : ''}
      </div>`;
  }

  const note = document.getElementById('agentTblNote');
  if (note) note.textContent = '※ FRT (P50): 첫 응답까지 걸린 시간의 중앙값 / 평균해결: 처리 건 실측값';
}

/* ─── B-1: Manager FRT 비교 테이블 ──────────────────────────────────── */
function renderMgrFrtTable(d) {
  const el = document.getElementById('mgrFrtTable');
  if (!el) return;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0);
  if (!managers.length) { el.innerHTML = '<div class="adv-empty">FRT 데이터 없음</div>'; return; }

  el.innerHTML = `<table class="mgr-frt-tbl">
    <thead><tr><th style="width:32px">#</th><th>담당자</th><th class="num-r" style="width:70px">처리</th><th class="num-r" style="width:90px">FRT 평균</th><th class="num-r" style="width:90px">FRT P50</th><th class="num-r" style="width:90px">해결 평균</th><th class="num-r" style="width:90px">컴플레인</th></tr></thead>
    <tbody>${managers.map((m, i) => `
      <tr>
        <td style="text-align:center"><span class="agent-rank rn">${i + 1}</span></td>
        <td><div class="mgr-frt-name"><div class="agent-avatar" style="${avatarStyle(i)};width:24px;height:24px;font-size:10px">${initials(m.name)}</div>${m.name.replace('오토스테이_','')}</div></td>
        <td class="num-r" style="font-weight:700">${m.count}</td>
        <td class="num-r" style="color:${m.avgFrtMin != null && m.avgFrtMin <= 10 ? 'var(--teal)' : 'var(--text)'}">${fmtMin(m.avgFrtMin)}</td>
        <td class="num-r" style="color:${m.medianFrtMin != null && m.medianFrtMin <= 5 ? 'var(--teal)' : m.medianFrtMin != null && m.medianFrtMin > 30 ? 'var(--rose)' : 'var(--text)'}">${fmtMin(m.medianFrtMin)}</td>
        <td class="num-r">${fmtMin(m.avgResolutionMin)}</td>
        <td class="num-r" style="color:${m.complaintHandled > 0 ? 'var(--rose)' : 'var(--muted)'}">${m.complaintHandled || 0}건</td>
      </tr>`).join('')}</tbody></table>`;
}

/* ─── Bots / Groups ──────────────────────────────────────────────────── */
function renderBotsGroups(d) {
  const { bots, summary, resolutionBuckets, tags, sources } = d;
  const rb = resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const botResCount = rb['0~5분'] || 0;
  const botResPct = Math.round((botResCount / resTotal) * 100);
  const selfResCount = rb['5~30분'] || 0;
  const selfResPct = Math.round((selfResCount / resTotal) * 100);
  const totalChats = summary.totalChats || 1;
  const top5Tags = (tags?.labels || []).slice(0, 5).map((lbl, i) => ({
    label: lbl, count: tags.values[i] || 0, pct: Math.round(((tags.values[i] || 0) / totalChats) * 100),
  }));
  const botNames = (bots || []).map((b) => b.name);
  const botPanel = document.getElementById('botPanel');
  if (botPanel) {
    botPanel.innerHTML = `
      <div class="panel-header"><div><div class="panel-title">자동화 효과</div><div class="panel-sub">챗봇 · FAQ · 셀프 해결</div></div><span class="data-badge badge-analyze">≈ 추정</span></div>
      <div class="auto-kpi-row">
        <div class="auto-kpi-card"><div class="auto-kpi-label">챗봇 빠른 해결률</div><div class="auto-kpi-val">${botResPct}<span class="auto-kpi-unit">%</span></div><div class="auto-kpi-sub">${botResCount.toLocaleString()}건 · 5분 내 종결</div><div class="auto-kpi-bar"><div class="auto-kpi-fill" style="width:${Math.min(botResPct,100)}%"></div></div></div>
        <div class="auto-kpi-card"><div class="auto-kpi-label">셀프 해결률</div><div class="auto-kpi-val">${selfResPct}<span class="auto-kpi-unit">%</span></div><div class="auto-kpi-sub">${selfResCount.toLocaleString()}건 · 5~30분</div><div class="auto-kpi-bar"><div class="auto-kpi-fill" style="width:${Math.min(selfResPct,100)}%"></div></div></div>
      </div>
      <div class="auto-faq-title">TOP 5 문의 유형</div>
      <div class="auto-faq-list">${top5Tags.map((t, i) => `<div class="auto-faq-row"><span class="auto-faq-rank rank-${i+1}">${i+1}</span><span class="auto-faq-label">${t.label}</span><span class="auto-faq-count">${t.count}회</span><span class="auto-faq-pct">${t.pct}%</span></div>`).join('')}</div>
      ${botNames.length ? `<div class="bot-names" style="margin-top:10px">${botNames.map((n) => `<span class="bot-name-tag">🤖 ${n}</span>`).join('')}</div>` : ''}`;
  }
  const openChats = summary.openChats || 0;
  const closedChats = totalChats;
  const avgRes = summary.avgResolutionMin || 0;
  const srcN = sources?.native || 0, srcP = sources?.phone || 0, srcO = sources?.other || 0;
  const srcTotal = (srcN + srcP + srcO) || 1;
  const groupPanel = document.getElementById('groupPanel');
  if (groupPanel) {
    groupPanel.innerHTML = `
      <div class="panel-header"><div><div class="panel-title">CS 운영 현황</div><div class="panel-sub">유입 채널 · 처리 지표</div></div><span class="data-badge badge-real">✓ 실데이터</span></div>
      <div class="ops-stat-row">
        <div class="ops-stat-cell"><div class="ops-stat-val" style="color:var(--rose)">${openChats}</div><div class="ops-stat-lbl">대기 중</div></div>
        <div class="ops-stat-cell"><div class="ops-stat-val" style="color:var(--teal)">${closedChats}</div><div class="ops-stat-lbl">처리 완료</div></div>
        <div class="ops-stat-cell"><div class="ops-stat-val" style="color:var(--amber)">${avgRes}<span style="font-size:12px">분</span></div><div class="ops-stat-lbl">평균 해결</div></div>
      </div>
      <div class="ops-section-title">유입 채널</div>
      <div class="ops-channel-list">
        <div class="ops-channel-row"><span class="ops-ch-icon">💬</span><span class="ops-ch-name">인앱</span><div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${Math.round(srcN/srcTotal*100)}%;background:var(--teal)"></div></div><span class="ops-ch-val">${srcN}</span><span class="ops-ch-pct">${Math.round(srcN/srcTotal*100)}%</span></div>
        <div class="ops-channel-row"><span class="ops-ch-icon">📞</span><span class="ops-ch-name">전화</span><div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${Math.round(srcP/srcTotal*100)}%;background:var(--blue)"></div></div><span class="ops-ch-val">${srcP}</span><span class="ops-ch-pct">${Math.round(srcP/srcTotal*100)}%</span></div>
      </div>`;
  }
}

/* ─── Update Banner ──────────────────────────────────────────────────── */
function updateBanner(d) {
  lastSuccessTime = new Date(d.updatedAt);
  const timeStr = lastSuccessTime.toLocaleString('ko-KR');
  const el = document.getElementById('updatedAt');
  if (el) el.textContent = timeStr;
  const cn = document.getElementById('channelName');
  if (cn) cn.textContent = d.channel?.name || '오토스테이 CS';
  const sampleNote = document.getElementById('sampleNoteBanner');
  if (sampleNote) {
    const note = d.dataNote || {};
    if (note.isSampled) {
      sampleNote.style.display = 'block';
      sampleNote.querySelector('.banner-msg').innerHTML = `<strong>수집 상한 도달</strong> — 최근 ${note.collected}건 기준 분석 (한도 ${note.limit}건)`;
    } else {
      sampleNote.style.display = 'none';
    }
  }
}

/* ─── Gauge Grid — FRT, FCR 추가 ────────────────────────────────────── */
function renderGaugeGrid(d) {
  const ARC = 131.9;
  function setG(id, pct, color) {
    const el = document.getElementById('gsvg-' + id);
    if (!el) return;
    el.setAttribute('stroke-dasharray', `${(Math.max(0, Math.min(1, pct / 100)) * ARC).toFixed(1)} ${ARC}`);
    el.className.baseVal = el.className.baseVal.replace(/gauge-fill--(good|warn|danger)/g, '') + ' ' + color;
  }
  function setB(id, text, cls) {
    const el = document.getElementById('gbadge-' + id);
    if (el) { el.textContent = text; el.className = 'gauge-panel-badge ' + cls; }
  }

  const rb = d.resolutionBuckets || {};
  const total = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quick = (rb['0~5분'] || 0) + (rb['5~30분'] || 0);
  const slow8h = rb['8시간+'] || 0;
  const quickPct = Math.round(quick / total * 100);
  const slowPct = Math.round(slow8h / total * 100);

  // 30분
  setG('quick', quickPct, quickPct >= 70 ? 'gauge-fill--good' : quickPct >= 50 ? 'gauge-fill--warn' : 'gauge-fill--danger');
  document.getElementById('gval-quick').textContent = quickPct + '%';
  document.getElementById('gsub-quick').textContent = `${quick}건 / ${total}건`;
  setB('quick', quickPct >= 70 ? '양호' : quickPct >= 50 ? '주의' : '위험', quickPct >= 70 ? 'good' : quickPct >= 50 ? 'warn' : 'danger');

  // 8h+
  setG('slow', slowPct, slowPct <= 10 ? 'gauge-fill--good' : slowPct <= 25 ? 'gauge-fill--warn' : 'gauge-fill--danger');
  document.getElementById('gval-slow').textContent = slowPct + '%';
  document.getElementById('gsub-slow').textContent = `${slow8h}건 장기`;
  setB('slow', slowPct <= 10 ? '양호' : slowPct <= 25 ? '주의' : '위험', slowPct <= 10 ? 'good' : slowPct <= 25 ? 'warn' : 'danger');

  // FRT (B-1)
  const frt = d.frtStats;
  if (frt && frt.median != null) {
    const frtMin = frt.median;
    const frtPct = Math.max(0, Math.min(100, Math.round((1 - frtMin / 60) * 100)));
    setG('frt', frtPct, frtMin <= 5 ? 'gauge-fill--good' : frtMin <= 30 ? 'gauge-fill--warn' : 'gauge-fill--danger');
    document.getElementById('gval-frt').textContent = fmtMin(frtMin);
    document.getElementById('gsub-frt').textContent = `5분 SLA ${frt.sla5min?.rate || 0}%`;
    setB('frt', frtMin <= 5 ? '양호' : frtMin <= 30 ? '주의' : '위험', frtMin <= 5 ? 'good' : frtMin <= 30 ? 'warn' : 'danger');
  } else {
    document.getElementById('gval-frt').textContent = '—';
    document.getElementById('gsub-frt').textContent = '데이터 없음';
  }

  // FCR (B-2)
  const fcr = d.fcrStats;
  if (fcr) {
    setG('fcr', fcr.fcrRate, fcr.fcrRate >= 90 ? 'gauge-fill--good' : fcr.fcrRate >= 75 ? 'gauge-fill--warn' : 'gauge-fill--danger');
    document.getElementById('gval-fcr').textContent = fcr.fcrRate + '%';
    document.getElementById('gsub-fcr').textContent = `재오픈 ${fcr.reopenedCount}건`;
    setB('fcr', fcr.fcrRate >= 90 ? '양호' : fcr.fcrRate >= 75 ? '주의' : '위험', fcr.fcrRate >= 90 ? 'good' : fcr.fcrRate >= 75 ? 'warn' : 'danger');
  }

  // 편중도
  const mgrs = (d.managers || []).filter((m) => m.count > 0);
  const mgrTotal = mgrs.reduce((s, m) => s + m.count, 0) || 1;
  const topMgr = mgrs[0];
  const topPct = topMgr ? Math.round(topMgr.count / mgrTotal * 100) : 0;
  setG('conc', topPct, topPct <= 40 ? 'gauge-fill--good' : topPct <= 60 ? 'gauge-fill--warn' : 'gauge-fill--danger');
  document.getElementById('gval-conc').textContent = topPct + '%';
  document.getElementById('gsub-conc').textContent = topMgr ? topMgr.name?.replace('오토스테이_','') : '—';
  setB('conc', topPct <= 40 ? '양호' : topPct <= 60 ? '주의' : '위험', topPct <= 40 ? 'good' : topPct <= 60 ? 'warn' : 'danger');
}

/* ─── Advanced sections (기존 + B-2 FCR 패널) ───────────────────────── */
function renderWow(d) {
  const el = document.getElementById('wowStrip');
  if (!el) return;
  const w = d.wow;
  const total = d.summary.totalChats || 0;
  if (!w) { el.innerHTML = `<div class="wow-card"><div class="wow-label">현 기간</div><div class="wow-val">${total}건</div><div class="wow-sub">비교 기준 없음</div></div>`; return; }
  const sign = w.delta > 0 ? '+' : '';
  const cls = w.delta > 0 ? 'wow-up' : w.delta < 0 ? 'wow-down' : 'wow-flat';
  el.innerHTML = `
    <div class="wow-card"><div class="wow-label">현 기간</div><div class="wow-val">${w.currentTotal}건</div></div>
    <div class="wow-card"><div class="wow-label">직전 동기간</div><div class="wow-val muted">${w.previousTotal}건</div></div>
    <div class="wow-card ${cls}"><div class="wow-label">증감</div><div class="wow-val">${sign}${w.delta}건</div><div class="wow-sub">${deltaArrow(w.deltaPct)}</div></div>`;
}

function renderSLA(d) {
  const el = document.getElementById('slaTracker');
  if (!el) return;
  const s = d.slaStats || {};
  const items = [
    { key: 'sla30Min', label: '30분 SLA', target: 50, icon: '⚡' },
    { key: 'sla2Hour', label: '2시간 SLA', target: 80, icon: '✅' },
    { key: 'sla8Hour', label: '8시간 SLA', target: 95, icon: '🎯' },
  ];
  el.innerHTML = items.map((it) => {
    const v = s[it.key] || { rate: 0, count: 0, total: 0 };
    const cls = v.rate >= it.target ? 'good' : v.rate >= it.target * 0.7 ? 'warn' : 'danger';
    return `<div class="sla-row sla-${cls}">
      <span class="sla-icon">${it.icon}</span>
      <div class="sla-meta"><div class="sla-label">${it.label}</div><div class="sla-target">목표 ${it.target}%</div></div>
      <div class="sla-bar-wrap"><div class="sla-bar-fill sla-${cls}" style="width:${Math.min(v.rate, 100)}%"></div><div class="sla-target-marker" style="left:${it.target}%"></div></div>
      <div class="sla-val sla-${cls}">${v.rate}%</div>
      <div class="sla-count">${v.count}/${v.total}</div>
      <span class="sla-status sla-${cls}">${v.rate >= it.target ? '준수' : v.rate >= it.target * 0.7 ? '근접' : '미달'}</span>
    </div>`;
  }).join('');
}

/* ─── B-2: FCR 패널 ──────────────────────────────────────────────────── */
function renderFcrPanel(d) {
  const el = document.getElementById('fcrPanel');
  if (!el) return;
  const frt = d.frtStats;
  const fcr = d.fcrStats || {};
  const repeat = d.repeatStats || {};

  const cards = [];
  if (frt) {
    const cls = frt.median <= 5 ? 'good' : frt.median <= 30 ? 'warn' : 'danger';
    cards.push({
      icon: '⚡', label: 'FRT (P50)', cls,
      value: fmtMin(frt.median),
      sub: `평균 ${fmtMin(frt.avg)} · P90 ${fmtMin(frt.p90)}`,
      bar: Math.max(0, Math.min(100, Math.round((1 - frt.median / 60) * 100))),
    });
  } else {
    cards.push({ icon: '⚡', label: 'FRT', cls: 'warn', value: '—', sub: '채널톡 데이터 부족', bar: 0 });
  }
  cards.push({
    icon: '🎯', label: 'FCR (1차 해결률)',
    cls: fcr.fcrRate >= 90 ? 'good' : fcr.fcrRate >= 75 ? 'warn' : 'danger',
    value: (fcr.fcrRate || 0) + '%',
    sub: `재오픈 ${fcr.reopenedCount || 0}건 · 재오픈율 ${fcr.reopenedRate || 0}%`,
    bar: fcr.fcrRate || 0,
  });
  cards.push({
    icon: '🔁', label: '반복 문의 고객',
    cls: repeat.repeatRate >= 30 ? 'danger' : repeat.repeatRate >= 15 ? 'warn' : 'good',
    value: (repeat.repeatRate || 0) + '%',
    sub: `전체 ${repeat.total || 0}명 · 반복 ${repeat.repeat || 0}명`,
    bar: repeat.repeatRate || 0,
  });
  cards.push({
    icon: '📊', label: '고객당 평균 채팅',
    cls: 'good',
    value: (repeat.avgChatsPerCustomer || 0) + '회',
    sub: `반복 비율 산출의 기준`,
    bar: Math.min(100, (repeat.avgChatsPerCustomer || 0) * 30),
  });

  el.innerHTML = cards.map((c) => `
    <div class="fcr-card fcr-${c.cls}">
      <div class="fcr-icon">${c.icon}</div>
      <div class="fcr-label">${c.label}</div>
      <div class="fcr-value">${c.value}</div>
      <div class="fcr-sub">${c.sub}</div>
      <div class="fcr-bar-wrap"><div class="fcr-bar ${c.cls}" style="width:${c.bar}%"></div></div>
    </div>`).join('');
}

function renderHourLoad(d) {
  const el = document.getElementById('hourLoadChart');
  if (!el) return;
  const data = d.hourLoad || Array(24).fill(0);
  const labels = Array.from({ length: 24 }, (_, i) => `${i}시`);
  const max = Math.max(...data, 1);
  if (charts.hourLoad) charts.hourLoad.destroy();
  charts.hourLoad = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: data.map((v) => v >= max * 0.8 ? '#be123c' : v >= max * 0.5 ? '#0f766e' : '#86b8b3'), borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c1917', callbacks: { label: (ctx) => `${ctx.parsed.y}건` } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } }, y: { grid: { color: '#f1efe8' }, ticks: { font: { size: 11 }, callback: (v) => v + '건' }, beginAtZero: true } } }
  });
  const peakHour = data.indexOf(max);
  const total = data.reduce((a, b) => a + b, 0);
  const morning = data.slice(6, 12).reduce((a, b) => a + b, 0);
  const afternoon = data.slice(12, 18).reduce((a, b) => a + b, 0);
  const evening = data.slice(18, 24).reduce((a, b) => a + b, 0);
  const night = data.slice(0, 6).reduce((a, b) => a + b, 0);
  const kvEl = document.getElementById('hourLoadKV');
  if (kvEl) kvEl.innerHTML = `
    <div class="hl-kv"><span class="hl-kv-lbl">피크</span><span class="hl-kv-val">${peakHour}시 (${max}건)</span></div>
    <div class="hl-kv"><span class="hl-kv-lbl">오전 06-12</span><span class="hl-kv-val">${morning}건 (${Math.round(morning/total*100||0)}%)</span></div>
    <div class="hl-kv"><span class="hl-kv-lbl">오후 12-18</span><span class="hl-kv-val">${afternoon}건 (${Math.round(afternoon/total*100||0)}%)</span></div>
    <div class="hl-kv"><span class="hl-kv-lbl">저녁 18-24</span><span class="hl-kv-val">${evening}건 (${Math.round(evening/total*100||0)}%)</span></div>
    <div class="hl-kv"><span class="hl-kv-lbl">새벽 00-06</span><span class="hl-kv-val muted">${night}건 (${Math.round(night/total*100||0)}%)</span></div>`;
}

function renderWeekdayLoad(d) {
  const el = document.getElementById('weekdayLoadPanel');
  if (!el) return;
  const data = d.weekdayLoad || Array(7).fill(0);
  const labels = ['월', '화', '수', '목', '금', '토', '일'];
  const max = Math.max(...data, 1);
  const total = data.reduce((a, b) => a + b, 0) || 1;
  const peakIdx = data.indexOf(max);
  el.innerHTML = labels.map((lbl, i) => {
    const v = data[i];
    const isPeak = i === peakIdx;
    const isWeekend = i >= 5;
    const color = isPeak ? '#be123c' : isWeekend ? '#a8a29e' : '#0f766e';
    return `<div class="wd-row${isPeak ? ' wd-peak' : ''}">
      <span class="wd-label${isWeekend ? ' wd-weekend' : ''}">${lbl}</span>
      <div class="wd-bar-wrap"><div class="wd-bar" style="width:${Math.round(v/max*100)}%;background:${color}"></div></div>
      <span class="wd-val">${v}건</span>
      <span class="wd-pct">${Math.round(v/total*100)}%</span>
      ${isPeak ? '<span class="wd-peak-tag">최다</span>' : ''}
    </div>`;
  }).join('');
  const bizEl = document.getElementById('bizHoursSplit');
  if (bizEl) {
    const b = d.workingHoursStats || { businessIn: 0, businessOut: 0 };
    const sum = b.businessIn + b.businessOut || 1;
    const inPct = Math.round(b.businessIn / sum * 100);
    bizEl.innerHTML = `
      <div class="biz-split-title">영업시간 vs 비영업 (평일 09-19 KST)</div>
      <div class="biz-bar-wrap"><div class="biz-bar biz-in" style="width:${inPct}%">${inPct}% 영업</div><div class="biz-bar biz-out" style="width:${100-inPct}%">${100-inPct}% 비영업</div></div>
      <div class="biz-stat-row"><span>영업 ${b.businessIn}건</span><span>비영업 ${b.businessOut}건</span></div>`;
  }
}

function renderPercentile(d) {
  const el = document.getElementById('percentilePanel');
  if (!el) return;
  const r = d.resolutionStats || {};
  const items = [
    { label: '평균', val: r.avg, color: '#0f766e' },
    { label: 'P50', val: r.median, color: '#14b8a6' },
    { label: 'P75', val: r.p75, color: '#f59e0b' },
    { label: 'P90', val: r.p90, color: '#ea580c' },
    { label: 'P95', val: r.p95, color: '#be123c' },
  ];
  const max = Math.max(...items.map((i) => i.val || 0), 1);
  el.innerHTML = `<div class="pct-grid">${items.map((it) => `
    <div class="pct-row"><span class="pct-lbl">${it.label}</span><div class="pct-bar-wrap"><div class="pct-bar" style="width:${Math.round((it.val||0)/max*100)}%;background:${it.color}"></div></div><span class="pct-val" style="color:${it.color}">${fmtMin(it.val)}</span></div>`).join('')}</div>
    ${r.avgEx8h != null ? `<div class="pct-extra">8h+ 제외 평균: <strong>${fmtMin(r.avgEx8h)}</strong></div>` : ''}`;
}

function renderAging(d) {
  const el = document.getElementById('agingPipeline');
  if (!el) return;
  const a = d.agingBuckets || {};
  const total = Object.values(a).reduce((x, y) => x + y, 0) || 1;
  const items = [
    { label: '< 8시간', val: a.lt8h || 0, icon: '✅', color: '#15803d' },
    { label: '8h ~ 24h', val: a.h8_24 || 0, icon: '⏰', color: '#f59e0b' },
    { label: '1일 ~ 3일', val: a.d1_3 || 0, icon: '⚠️', color: '#ea580c' },
    { label: '3일 ~ 7일', val: a.d3_7 || 0, icon: '🚨', color: '#dc2626' },
    { label: '7일+', val: a.d7plus || 0, icon: '🔥', color: '#be123c' },
  ];
  el.innerHTML = items.map((it) => {
    const pct = Math.round(it.val / total * 100);
    return `<div class="aging-row"><span class="aging-icon">${it.icon}</span><span class="aging-lbl">${it.label}</span><div class="aging-bar-wrap"><div class="aging-bar" style="width:${Math.max(pct, it.val>0?2:0)}%;background:${it.color}"></div></div><span class="aging-val" style="color:${it.color}">${it.val}건</span><span class="aging-pct">${pct}%</span></div>`;
  }).join('');
}

function renderSourcePerf(d) {
  const el = document.getElementById('sourcePerfPanel');
  if (!el) return;
  const stats = (d.sourceStats || []).filter((s) => s.count > 0);
  if (!stats.length) { el.innerHTML = '<div class="adv-empty">채널 데이터 없음</div>'; return; }
  const labelMap = { native: '인앱 (Web/App)', phone: '전화', other: '기타' };
  const colorMap = { native: '#0f766e', phone: '#1d4ed8', other: '#a8a29e' };
  el.innerHTML = stats.map((s) => `
    <div class="src-perf-card" style="border-left-color:${colorMap[s.source]}">
      <div class="sp-header"><span class="sp-name">${labelMap[s.source]}</span><span class="sp-count">${s.count}건</span></div>
      <div class="sp-metrics">
        <div class="sp-metric"><span class="sp-m-lbl">평균</span><span class="sp-m-val">${fmtMin(s.avgResolutionMin)}</span></div>
        <div class="sp-metric"><span class="sp-m-lbl">P50</span><span class="sp-m-val">${fmtMin(s.medianResolutionMin)}</span></div>
        <div class="sp-metric"><span class="sp-m-lbl">P90</span><span class="sp-m-val">${fmtMin(s.p90ResolutionMin)}</span></div>
      </div>
    </div>`).join('');
}

function renderAnomaly(d) {
  const el = document.getElementById('anomalyPanel');
  if (!el) return;
  const anom = d.anomalies || [];
  if (!anom.length) { el.innerHTML = `<div class="anom-ok"><div class="anom-ok-icon">✓</div><div class="anom-ok-text">유의미한 이상치 없음</div><div class="anom-ok-sub">±1.8σ 범위 내 정상</div></div>`; return; }
  el.innerHTML = anom.map((a) => {
    const cls = a.isHigh ? 'anom-high' : 'anom-low';
    const icon = a.isHigh ? '📈' : '📉';
    const dir = a.isHigh ? '급증' : '급감';
    return `<div class="anom-row ${cls}"><span class="anom-icon">${icon}</span><div class="anom-body"><div class="anom-date">${a.label}</div><div class="anom-detail">${a.val}건 · ${dir} (Z=${a.z.toFixed(1)}σ)</div></div><span class="anom-tag ${cls}">${dir}</span></div>`;
  }).join('');
}

function renderForecast(d) {
  const el = document.getElementById('forecastPanel');
  if (!el) return;
  const f = d.forecast || {};
  const m = f.momentum || 0;
  const cls = m > 10 ? 'fc-up' : m < -10 ? 'fc-down' : 'fc-flat';
  const icon = m > 10 ? '🔥' : m < -10 ? '❄️' : '➡️';
  el.innerHTML = `
    <div class="fc-header"><span class="fc-icon">${icon}</span><div class="fc-title-block"><div class="fc-title">${m > 10 ? '상승 모멘텀' : m < -10 ? '하락 모멘텀' : '평탄'}</div><div class="fc-sub">7일 평균 vs 14일 전 7일 평균</div></div></div>
    <div class="fc-grid">
      <div class="fc-cell"><div class="fc-cell-lbl">최근 7일</div><div class="fc-cell-val">${f.last7Avg}건/일</div></div>
      <div class="fc-cell"><div class="fc-cell-lbl">직전 7일</div><div class="fc-cell-val muted">${f.last14Avg}건/일</div></div>
      <div class="fc-cell ${cls}"><div class="fc-cell-lbl">모멘텀</div><div class="fc-cell-val">${m > 0 ? '+' : ''}${m}%</div></div>
      <div class="fc-cell fc-projection"><div class="fc-cell-lbl">다음 영업일 투영</div><div class="fc-cell-val">≈ ${f.nextDayProjection}건</div></div>
    </div>`;
}

function renderComplaintTrend(d) {
  const el = document.getElementById('complaintTrendChart');
  if (!el) return;
  const t = d.complaintTrend || { labels: [], total: [], complaints: [] };
  const rates = t.labels.map((_, i) => t.total[i] > 0 ? Math.round((t.complaints[i] || 0) / t.total[i] * 100) : 0);
  if (charts.complaintTrend) charts.complaintTrend.destroy();
  charts.complaintTrend = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: t.labels,
      datasets: [
        { label: '컴플레인 건수', data: t.complaints, backgroundColor: '#fecaca', borderColor: '#be123c', borderWidth: 1, yAxisID: 'y' },
        { label: '컴플레인율 (%)', data: rates, type: 'line', borderColor: '#be123c', borderWidth: 2, tension: 0.3, pointRadius: 2, fill: false, yAxisID: 'y1' },
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 } } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 }, maxTicksLimit: 12 } }, y: { position: 'left', grid: { color: '#f1efe8' }, ticks: { callback: (v) => v + '건' }, beginAtZero: true }, y1: { position: 'right', grid: { display: false }, ticks: { callback: (v) => v + '%' }, beginAtZero: true, max: 100 } } }
  });
  const totalCom = t.complaints.reduce((a, b) => a + b, 0);
  const totalAll = t.total.reduce((a, b) => a + b, 0) || 1;
  const overallRate = Math.round(totalCom / totalAll * 100);
  const kvEl = document.getElementById('complaintTrendKV');
  if (kvEl) kvEl.innerHTML = `
    <div class="ct-kv"><span class="ct-lbl">총 컴플레인</span><span class="ct-val">${totalCom}건</span></div>
    <div class="ct-kv"><span class="ct-lbl">전체 비율</span><span class="ct-val ${overallRate >= 15 ? 'danger' : overallRate >= 8 ? 'warn' : 'good'}">${overallRate}%</span></div>`;
}

function renderMgrQuadrant(d) {
  const el = document.getElementById('mgrQuadrantChart');
  if (!el) return;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0 && m.avgResolutionMin != null);
  if (!managers.length) { return; }
  const points = managers.map((m, i) => ({
    x: m.avgResolutionMin, y: m.count,
    label: m.name.replace('오토스테이_',''),
    backgroundColor: AVATAR_COLORS[i % AVATAR_COLORS.length].split(',')[1],
  }));
  const avgX = points.reduce((a, p) => a + p.x, 0) / points.length;
  const avgY = points.reduce((a, p) => a + p.y, 0) / points.length;
  if (charts.mgrQuad) charts.mgrQuad.destroy();
  charts.mgrQuad = new Chart(el.getContext('2d'), {
    type: 'scatter',
    data: { datasets: points.map((p) => ({ label: p.label, data: [{ x: p.x, y: p.y }], backgroundColor: p.backgroundColor, borderColor: '#fff', borderWidth: 2, pointRadius: 12, pointHoverRadius: 14 })) },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'right', labels: { font: { size: 10 }, boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMin(ctx.parsed.x)} · ${ctx.parsed.y}건` } }, annotation: { annotations: { xAvg: { type: 'line', xMin: avgX, xMax: avgX, borderColor: '#a8a29e', borderWidth: 1, borderDash: [4, 4] }, yAvg: { type: 'line', yMin: avgY, yMax: avgY, borderColor: '#a8a29e', borderWidth: 1, borderDash: [4, 4] } } } },
      scales: { x: { title: { display: true, text: '평균 해결시간(분)' }, beginAtZero: true }, y: { title: { display: true, text: '처리 건수' }, beginAtZero: true } }
    }
  });
  const legend = document.getElementById('mgrQuadrantLegend');
  if (legend) legend.innerHTML = `
    <div class="mq-legend-item"><span class="mq-quad mq-q1">처리량高/빠름</span><span>스타 퍼포머</span></div>
    <div class="mq-legend-item"><span class="mq-quad mq-q2">처리량高/느림</span><span>과부하 — 분산 검토</span></div>
    <div class="mq-legend-item"><span class="mq-quad mq-q3">처리량低/빠름</span><span>경량 처리/보조</span></div>
    <div class="mq-legend-item"><span class="mq-quad mq-q4">처리량低/느림</span><span>코칭 권장</span></div>`;
}

function renderDiagnostics(d) {
  const el = document.getElementById('diagPanel');
  const footerEl = document.getElementById('footerDiag');
  const diag = d.diagnostics || {};
  const calls = diag.callTiming || [];
  const warns = diag.warnings || [];
  if (footerEl) {
    const okCount = calls.filter((c) => c.ok).length;
    const cacheStr = diag.cacheHit ? `⚡ KV 캐시 HIT` : `🔄 fresh fetch`;
    const status = warns.length === 0 ? '✓ 정상' : `⚠ 부분실패 (${warns.length})`;
    footerEl.innerHTML = `${cacheStr} · ${diag.totalMs}ms · ${status} · API ${okCount}/${calls.length}`;
  }
  if (!el) return;
  const totalRows = calls.map((c) => `<tr><td>${c.label}</td><td><span class="diag-status ${c.ok ? 'ok' : 'fail'}">${c.ok ? 'OK' : 'FAIL'}</span></td><td class="num-r">${c.status}</td><td class="num-r">${c.ms}ms</td></tr>`).join('');
  const warnHtml = warns.length ? `<div class="diag-warns">${warns.map((w) => `<span class="diag-warn-tag">⚠ ${w}</span>`).join('')}</div>` : `<div class="diag-ok">✓ 모든 호출 성공</div>`;
  const kvBadge = diag.kvEnabled ? '<span style="color:var(--teal);font-weight:700">✓ KV 활성</span>' : '<span style="color:var(--muted)">KV 미설정 (메모리 캐시만)</span>';
  el.innerHTML = `
    <div class="diag-summary">
      <div class="diag-stat"><span class="diag-stat-lbl">총 응답시간</span><span class="diag-stat-val">${diag.totalMs}ms</span></div>
      <div class="diag-stat"><span class="diag-stat-lbl">캐시 상태</span><span class="diag-stat-val ${diag.cacheHit ? 'good' : ''}">${diag.cacheHit ? 'HIT (' + (diag.cacheSource || 'mem') + ')' : 'MISS'}</span></div>
      <div class="diag-stat"><span class="diag-stat-lbl">페이지네이션</span><span class="diag-stat-val">${diag.pages || 0}p · ${diag.paginationMs || 0}ms</span></div>
      <div class="diag-stat"><span class="diag-stat-lbl">실패 호출</span><span class="diag-stat-val ${warns.length > 0 ? 'danger' : 'good'}">${warns.length}건</span></div>
    </div>
    ${warnHtml}
    <table class="diag-tbl">
      <thead><tr><th>API 엔드포인트</th><th>상태</th><th class="num-r">HTTP</th><th class="num-r">응답시간</th></tr></thead>
      <tbody>${totalRows || '<tr><td colspan="4" class="diag-empty">호출 정보 없음</td></tr>'}</tbody>
    </table>
    <div class="diag-note">v4.0 — KV 캐싱 (5분 TTL) · 부분 실패 허용 · 1000건 한도. ${kvBadge}</div>`;
}

/* ─── Tabs ──────────────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.cg-tabs').forEach((group) => {
    const tabs = group.querySelectorAll('.cg-tab');
    tabs.forEach((tab) => {
      tab.onclick = () => {
        const target = tab.dataset.tab;
        const parent = group.closest('.cg-panel');
        if (!parent) return;
        parent.querySelectorAll('.cg-tab').forEach((t) => t.classList.remove('active'));
        parent.querySelectorAll('.cg-tab-pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const pane = parent.querySelector('#' + target);
        if (pane) pane.classList.add('active');
      };
    });
  });
}

/* ─── Filter Drawer Init ────────────────────────────────────────────── */
function initFilterDrawer() {
  const filterBtn = document.getElementById('filterBtn');
  const drawer = document.getElementById('filterDrawer');
  const closeBtn = document.getElementById('filterCloseBtn');
  const clearBtn = document.getElementById('filterClearBtn');
  if (filterBtn) filterBtn.onclick = () => {
    if (drawer.style.display === 'block') drawer.style.display = 'none';
    else { drawer.style.display = 'block'; renderFilterDrawer(lastData); }
  };
  if (closeBtn) closeBtn.onclick = () => { drawer.style.display = 'none'; };
  if (clearBtn) clearBtn.onclick = () => {
    filterState.managers.clear(); filterState.tags.clear(); filterState.sources.clear();
    renderFilterDrawer(lastData);
    updateFilterBadges();
    applyFilteredRender();
  };
}

/* ─── Full Render ────────────────────────────────────────────────────── */
function fullRender(data) {
  const scoreObj = computeHealthScore(data);
  const insights = generateInsights(data, scoreObj);
  safeRender(() => renderHealthScore(scoreObj, data), 'healthScore');
  safeRender(() => renderHeroQuickStats(data, scoreObj), 'heroQuickStats');
  safeRender(() => renderHeroAction(data, scoreObj), 'heroAction');
  safeRender(() => renderKPIs(data, scoreObj), 'kpis');
  safeRender(() => renderAlertStrip(data, scoreObj), 'alertStrip');
  safeRender(() => renderInsights(insights), 'insights');
  safeRender(() => renderGaugeGrid(data), 'gaugeGrid');
  safeRender(() => renderTrend(data), 'trend');
  safeRender(() => renderHeatmap(data), 'heatmap');
  safeRender(() => renderTagBar(data), 'tagBar');
  safeRender(() => renderVOC(data), 'voc');
  safeRender(() => renderVocRiskSection(data), 'vocRisk');
  safeRender(() => renderTagRes(data), 'tagRes');
  safeRender(() => renderTagCooccur(data), 'tagCooccur');
  safeRender(() => renderComplaintCategory(data), 'complaintCat');
  safeRender(() => renderCategoryBars(data), 'categoryBars');
  safeRender(() => renderConcRisk(data), 'concRisk');
  safeRender(() => renderMgrRiskStrip(data), 'mgrRiskStrip');
  safeRender(() => renderManagers(data), 'managers');
  safeRender(() => renderMgrQuadrant(data), 'mgrQuad');
  safeRender(() => renderMgrFrtTable(data), 'mgrFrt');
  safeRender(() => renderChannel(data), 'channel');
  safeRender(() => renderResolution(data), 'resolution');
  safeRender(() => renderLongDelayPanel(data), 'longDelay');
  safeRender(() => renderBotsGroups(data), 'botsGroups');
  safeRender(() => renderWow(data), 'wow');
  safeRender(() => renderSLA(data), 'sla');
  safeRender(() => renderFcrPanel(data), 'fcrPanel');
  safeRender(() => renderHourLoad(data), 'hourLoad');
  safeRender(() => renderWeekdayLoad(data), 'weekdayLoad');
  safeRender(() => renderPercentile(data), 'percentile');
  safeRender(() => renderAging(data), 'aging');
  safeRender(() => renderSourcePerf(data), 'sourcePerf');
  safeRender(() => renderAnomaly(data), 'anomaly');
  safeRender(() => renderForecast(data), 'forecast');
  safeRender(() => renderComplaintTrend(data), 'complaintTrend');
  safeRender(() => renderDiagnostics(data), 'diagnostics');
}

/* ─── Fetch ─────────────────────────────────────────────────────────── */
async function fetchData() {
  const qs = currentDays === 'all' ? 'days=all' : `days=${currentDays}`;
  const ts = Date.now();
  const res = await fetch(`/api/data?${qs}&_t=${ts}`, { cache: 'no-store' });
  if (res.status === 401) {
    try { const body = await res.json(); if (body && body.redirect) { window.location.href = body.redirect; return; } } catch (_) {}
    window.location.href = '/api/auth';
    return;
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(silentRefresh, 5 * 60 * 1000);
}

async function render() {
  try {
    setStep('lstep-api'); setProgress(20);
    const data = await fetchData();
    if (!data) return;
    lastData = data;
    setStep('lstep-api', true); setStep('lstep-charts'); setProgress(45);
    safeRender(() => updateBanner(data), 'banner');
    setProgress(60);
    fullRender(data);
    setProgress(100);
    setStep('lstep-charts', true); setStep('lstep-done', true);
    setTimeout(() => {
      const ov = document.getElementById('loadingOverlay');
      if (ov) { ov.style.opacity = '0'; setTimeout(() => { ov.style.display = 'none'; }, 350); }
    }, 400);
    const eb = document.getElementById('errBanner');
    if (eb) eb.style.display = 'none';
    scheduleRefresh();
  } catch (err) {
    console.error('Render error:', err);
    const ov = document.getElementById('loadingOverlay');
    if (ov) ov.style.display = 'none';
    const eb = document.getElementById('errBanner');
    if (eb) {
      const lastOk = lastSuccessTime ? ` — 마지막 성공: ${lastSuccessTime.toLocaleString('ko-KR')}` : '';
      eb.innerHTML = `<strong>데이터 로드 실패</strong>: ${err.message}${lastOk}`;
      eb.style.display = 'block';
    }
    scheduleRefresh();
  }
}

async function silentRefresh() {
  try {
    const data = await fetchData();
    if (!data) return;
    lastData = data;
    safeRender(() => updateBanner(data), 'banner.silent');
    fullRender(data);
    const eb = document.getElementById('errBanner');
    if (eb) eb.style.display = 'none';
  } catch (e) { console.warn('Silent refresh failed:', e); }
  scheduleRefresh();
}

/* ─── CSV Download ──────────────────────────────────────────────────── */
function _triggerCSV(csvLines, filename) {
  const BOM = '﻿';
  const blob = new Blob([BOM + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function downloadCSV() {
  if (!lastData) return;
  const dateStr = new Date().toLocaleString('ko-KR');
  const lines = [`# [OPS] 채널톡 CS 대시보드 v4.0 — ${dateStr}`, ''];
  // 담당자
  const managers = (lastData.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  lines.push('=== 담당자 성과 ===', '담당자명,처리건수,FRT평균,FRT P50,평균해결,P50,P90,컴플레인처리');
  managers.forEach((m) => {
    lines.push(`${m.name},${m.count},${m.avgFrtMin ?? ''},${m.medianFrtMin ?? ''},${m.avgResolutionMin ?? ''},${m.medianResolutionMin ?? ''},${m.p90ResolutionMin ?? ''},${m.complaintHandled ?? 0}`);
  });
  lines.push('');
  // SLA
  const s = lastData.slaStats || {};
  lines.push('=== SLA 준수율 ===', 'SLA,준수율,건수');
  lines.push(`30분,${s.sla30Min?.rate || 0}%,${s.sla30Min?.count || 0}/${s.sla30Min?.total || 0}`);
  lines.push(`2시간,${s.sla2Hour?.rate || 0}%,${s.sla2Hour?.count || 0}/${s.sla2Hour?.total || 0}`);
  lines.push(`8시간,${s.sla8Hour?.rate || 0}%,${s.sla8Hour?.count || 0}/${s.sla8Hour?.total || 0}`);
  lines.push('');
  // FCR
  const f = lastData.fcrStats || {};
  lines.push('=== FCR / 재오픈 ===', `1차해결률,${f.fcrRate || 0}%`, `재오픈건수,${f.reopenedCount || 0}`, `재오픈율,${f.reopenedRate || 0}%`);
  lines.push('');
  // 컴플레인 세분화
  const c = lastData.complaintCategories || {};
  lines.push('=== 컴플레인 세분화 ===', '카테고리,건수');
  Object.entries(c).forEach(([k, v]) => lines.push(`${k},${v}`));
  _triggerCSV(lines, `OPS-channeltalk-cs-v4-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* ─── Events ────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.addEventListener('click', () => triggerFullReload());
  document.querySelectorAll('.range-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const range = tabBtn.dataset.days;
      document.querySelectorAll('.range-tab').forEach((t) => t.classList.remove('active'));
      tabBtn.classList.add('active');
      currentDays = range === 'all' ? 'all' : parseInt(range);
      triggerFullReload();
    });
  });
  const csvBtn = document.getElementById('csvDownloadBtn');
  if (csvBtn) csvBtn.addEventListener('click', downloadCSV);
  const modal = document.getElementById('longChatsModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeLongChatsPanel(); });
  initTabs();
  initFilterDrawer();
});

function triggerFullReload() {
  const ov = document.getElementById('loadingOverlay');
  if (ov) { ov.style.opacity = '1'; ov.style.display = 'flex'; }
  ['lstep-conn', 'lstep-api', 'lstep-charts', 'lstep-done'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active', 'done');
  });
  const c = document.getElementById('lstep-conn');
  if (c) c.classList.add('done');
  setProgress(5);
  // 필터 초기화
  filterState.managers.clear(); filterState.tags.clear(); filterState.sources.clear();
  updateFilterBadges();
  render();
}

render();
