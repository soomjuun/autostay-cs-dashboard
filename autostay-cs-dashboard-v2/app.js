// [OPS] 채널톡 CS 대시보드 — app.js v4.1
// 추가: Hero 액션 박스, 탭 통합, FRT/반복문의, 컴플레인 세분화,
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
let currentDays = 7; // 초기값: HTML에서 7일 탭이 active 상태이므로 일치
let refreshTimer = null;
let lastSuccessTime = null;
let forceRefreshRequested = false; // 사용자가 새로고침 버튼 직접 클릭 시 true

// C-2: 필터 상태
const filterState = {
  managers: new Set(),  // assigneeId
  tags: new Set(),      // tag string
  sources: new Set(),   // 'native' | 'phone' | 'other'
};

// 장기 지연 모달 내 퀵 필터 상태
let lcModalFilter = { mgr: null, tag: null, src: null };

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
/* 담당자 표시명: 단일 문자·반복패턴("D D") → "D 담당자"로 정규화 */
function dispMgrName(name) {
  const d = (name || '').replace('오토스테이_', '').trim();
  // "D D", "M M" 등 짧은 파트가 반복되는 경우 첫 파트만 사용
  const parts = d.split(/\s+/);
  const simple = (parts.length > 1 && parts.every(p => p.length <= 2)) ? parts[0] : d;
  return simple.length <= 2 ? simple + ' 담당자' : simple;
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
function getCacheMeta(diag = {}) {
  const source = diag.cacheSource || (diag.kvEnabled ? 'kv' : 'memory');
  const isKv = source === 'kv';
  return {
    source,
    label: isKv ? 'Vercel KV' : '메모리 캐시',
    shortLabel: isKv ? 'KV 캐시' : '메모리 캐시',
    storageLabel: isKv ? 'Vercel KV (공유 캐시)' : '메모리 (인스턴스 한정)',
    note: isKv
      ? 'Vercel KV 공유 캐시 · 5분 TTL · 강제 갱신: 새로고침 버튼'
      : '메모리 캐시 · 서버 인스턴스별 5분 TTL · 인스턴스 변경 시 캐시가 달라질 수 있음',
  };
}
function getManagerNameById(d, id) {
  if (!id) return '담당자 없음';
  const mgr = (d.managers || []).find((m) => String(m.id) === String(id));
  return mgr ? dispMgrName(mgr.name) : String(id);
}
function getTopLongDelayContext(d) {
  const list = [...(d.longChats || [])].sort((a, b) => (b.resolutionMin || 0) - (a.resolutionMin || 0));
  const top = list[0];
  if (!top) return null;
  const firstTag = Array.isArray(top.tags) && top.tags.length ? `#${top.tags[0]}` : '태그 없음';
  return {
    duration: fmtMin(top.resolutionMin),
    manager: getManagerNameById(d, top.assigneeId),
    tag: firstTag,
    count: list.length,
  };
}
function getComplaintContext(d) {
  const tags = d.tags || { labels: [], values: [] };
  const topTag = (tags.labels || [])
    .map((label, i) => ({ label, count: tags.values[i] || 0 }))
    .filter((item) => item.label.includes('컴플레인'))
    .sort((a, b) => b.count - a.count)[0];
  const longComplaintCount = (d.longChats || []).filter((c) =>
    (Array.isArray(c.tags) ? c.tags : []).some((t) => t.includes('컴플레인'))
  ).length;
  return {
    topTag: topTag ? `#${topTag.label}` : '컴플레인 태그',
    topCount: topTag?.count || 0,
    longComplaintCount,
  };
}
function getManagerConcentration(d) {
  const totalChats = d.summary?.totalChats || 1;
  const managers = (d.managers || [])
    .filter((m) => !EXCLUDED_MANAGERS.includes(m.name))
    .filter((m) => (m.count || 0) > 0);
  const topMgr = managers[0] || null;
  const assignedTotal = managers.reduce((sum, m) => sum + (m.count || 0), 0) || 1;
  const assignedPct = topMgr ? Math.round((topMgr.count || 0) / assignedTotal * 100) : 0;
  const totalPct = topMgr ? Math.round((topMgr.count || 0) / totalChats * 100) : 0;
  return { managers, topMgr, assignedTotal, assignedPct, totalPct };
}
function getDataSpanDays(dataNote = {}) {
  return (dataNote.processedMinAt && dataNote.processedMaxAt)
    ? Math.max(1, Math.round((dataNote.processedMaxAt - dataNote.processedMinAt) / 86400000) + 1)
    : null;
}
function isSameAcrossMainPeriods(dataNote = {}) {
  const spanDays = getDataSpanDays(dataNote);
  const collected = Number(dataNote.collected || 0);
  const processed = Number(dataNote.processed || 0);
  const limit = Number(dataNote.limit || 1000);
  return Boolean(
    spanDays
    && spanDays <= 7
    && collected > 0
    && collected === processed
    && collected < limit
    && !dataNote.isSampled
    && dataNote.currentPeriodComplete !== false
    && !dataNote.paginationLoopDetected
  );
}
function getUnknownTagStats(d) {
  const total = d.summary?.totalChats || 0;
  const serverCount = Number(d.taggingQuality?.unknownCount);
  const count = Number.isFinite(serverCount)
    ? serverCount
    : 0;
  const pct = total ? Math.round(count / total * 100) : 0;
  const cls = pct >= 40 ? 'danger' : pct >= 20 ? 'warn' : 'good';
  return { count, pct, total, classified: Math.max(total - count, 0), cls, isHigh: pct >= 30 };
}
function getResolutionSampleStats(d) {
  const rb = d.resolutionBuckets || {};
  const n = Object.values(rb).reduce((a, b) => a + b, 0);
  const cls = n < 30 ? 'danger' : n < 80 ? 'warn' : 'good';
  const label = n < 30 ? '표본 작음' : n < 80 ? '참고용' : '표본 양호';
  return { n, cls, label };
}
function getDurableHistoryStatus(d) {
  const snap = d.snapshotStore || {};
  const spanDays = getDataSpanDays(d.dataNote || {});
  const snapshotDays = Number(snap.count || 0);
  const historyDays = Math.max(spanDays || 0, snapshotDays || 0);
  const enabled = Boolean(snap.enabled);
  const configured = enabled || snapshotDays > 0;
  return {
    enabled,
    configured,
    snapshotDays,
    historyDays,
    source: snap.source || (enabled ? 'kv' : 'none'),
    label: configured ? `스냅샷 ${snapshotDays}일` : '외부 스냅샷 미설정',
    message: snap.message || (configured ? '스냅샷 누적 중' : 'KV/DB 연결 필요'),
  };
}
function getSlaTargets() {
  const defaults = { sla30Min: 50, sla2Hour: 80, sla8Hour: 95 };
  try {
    const saved = JSON.parse(localStorage.getItem('cs_sla_targets') || '{}');
    return {
      sla30Min: Number(saved.sla30Min) || defaults.sla30Min,
      sla2Hour: Number(saved.sla2Hour) || defaults.sla2Hour,
      sla8Hour: Number(saved.sla8Hour) || defaults.sla8Hour,
    };
  } catch (_) {
    return defaults;
  }
}
function setSlaTargets(next) {
  localStorage.setItem('cs_sla_targets', JSON.stringify(next));
}
function hasPeriodBaseline(d) {
  const w = d.snapshotWow || d.wow || {};
  const history = getDurableHistoryStatus(d);
  const previousTotal = Number(w.previousTotal || 0);
  const currentTotal = Number(w.currentTotal || d.summary?.totalChats || 0);
  const hasSnapshotBaseline = Boolean(d.snapshotWow && history.historyDays >= 14);
  const baselineComplete = d.dataNote?.baselineComplete !== false && w.baselineComplete !== false;
  return Boolean(
    baselineComplete
    && history.historyDays >= 14
    && previousTotal >= 20
    && currentTotal >= 20
    && (hasSnapshotBaseline || !isSameAcrossMainPeriods(d.dataNote || {}))
  );
}
function getDataReliabilityBadges(d) {
  const badges = [];
  const unknown = getUnknownTagStats(d);
  const sample = getResolutionSampleStats(d);
  const spanDays = getDataSpanDays(d.dataNote || {});
  const history = getDurableHistoryStatus(d);
  if (unknown.isHigh) badges.push(`<span class="hds-chip ${unknown.cls}">VOC 미분류 ${unknown.pct}%</span>`);
  if (sample.n && sample.n < 80) badges.push(`<span class="hds-chip ${sample.cls}">해결시간 n=${sample.n} ${sample.label}</span>`);
  if (d.dataNote?.openChatsSampled) badges.push('<span class="hds-chip warn">오픈 큐 500건 상한</span>');
  if (!history.configured) badges.push('<span class="hds-chip danger">스냅샷 미설정</span>');
  else if (history.historyDays < 14) badges.push(`<span class="hds-chip warn">${history.label} · 누적 중</span>`);
  else if (spanDays && spanDays < 14) badges.push(`<span class="hds-chip good">${history.label}</span>`);
  return badges.join('');
}
function renderDataQualityNote(stats, areaLabel = 'VOC') {
  if (!stats || !stats.isHigh) return '';
  const usable = stats.classified > 0 ? `분류된 ${stats.classified}건 중심` : '분류 가능 데이터 부족';
  return `<div class="data-quality-note dq-${stats.cls}">
    <strong>${areaLabel} 신뢰도 주의</strong>
    <span>태그 미분류 ${stats.pct}% (${stats.count}/${stats.total || 0}건) · ${usable} 참고용입니다.</span>
    <em>현재 응답에는 상담 본문이 없어 실제 LLM 자동분류는 미실행 상태입니다. 메시지 본문 수집 후 자동 태깅 파이프라인 연결 필요</em>
  </div>`;
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

/* ─── Toast 알림 ──────────────────────────────────────────────────────── */
function showToast(msg, type = 'success', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  const icons = { success: '✓', error: '✕', info: 'ℹ', warn: '!' };
  const colors = { success: '#3182F6', error: '#BE123C', info: '#1B64DA', warn: '#B45309' };
  const toast = document.createElement('div');
  toast.className = `toast-msg ${type}`;
  toast.setAttribute('role', 'status');
  toast.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.22);opacity:0;transform:translateY(10px);transition:all .22s cubic-bezier(.4,0,.2,1);max-width:340px;display:flex;align-items:center;gap:8px;`;
  toast.innerHTML = `<span style="font-size:15px">${icons[type]||'ℹ'}</span><span>${msg}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 240);
  }, duration);
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
function chatTalkOpenUrl() {
  const cid = getChannelId();
  if (!cid) return 'https://desk.channel.io';
  // state=opened = 현재 진행 중(오픈) 상담 필터 (Channel Talk Desk 인박스 필터 파라미터)
  return `https://desk.channel.io/#/channels/${cid}/user_chats?state=opened`;
}
function chatTalkUnassignedUrl() {
  const cid = getChannelId();
  if (!cid) return 'https://desk.channel.io';
  // user_chats = 고객 상담 인박스 (team_chats는 내부 팀 채팅 — 오류 경로)
  // state=unassigned = 담당자 미배정 필터 (Channel Talk Desk 인박스 필터 파라미터)
  return `https://desk.channel.io/#/channels/${cid}/user_chats?state=unassigned`;
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

  // longChats 필터링 — manager ID는 String으로 정규화 (filterState는 문자열 Set)
  out.longChats = (data.longChats || []).filter((c) => {
    if (filterState.managers.size && !filterState.managers.has(String(c.assigneeId || '_unassigned'))) return false;
    if (filterState.tags.size && !c.tags.some((t) => filterState.tags.has(t))) return false;
    if (filterState.sources.size && !filterState.sources.has(c.source)) return false;
    return true;
  });

  // managers 필터링 (선택된 담당자만)
  if (filterState.managers.size) {
    out.managers = (data.managers || []).filter((m) =>
      filterState.managers.has(String(m.id)) || m.count === 0
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

function renderFilterDrawer(data, ids = {}) {
  const mgrEl = document.getElementById(ids.mgr || 'filterMgrList');
  const tagEl = document.getElementById(ids.tag || 'filterTagList');
  const srcEl = document.getElementById(ids.src || 'filterSrcList');
  const pfx   = ids.pfx || '';
  if (!mgrEl || !tagEl || !srcEl) return;

  // 담당자 칩: count>0 우선 표시, 0건은 토글 접기
  const allMgrs = (data.managers || []).filter((m) => !EXCLUDED_MANAGERS.some((ex) => m.name.includes(ex)));
  const activeMgrs = allMgrs.filter((m) => m.count > 0);
  const zeroMgrs = allMgrs.filter((m) => m.count === 0);
  if (allMgrs.length === 0) {
    mgrEl.innerHTML = '<span style="color:var(--muted);font-size:11px;padding:2px 4px">담당자 데이터 없음</span>';
  } else {
    // 항상 String(m.id)로 정규화 — HTML dataset은 항상 문자열 반환
    const chipHtml = (list) => list.map((m) => {
      const sid = String(m.id);
      const isActive = filterState.managers.has(sid);
      return `<button type="button" class="filter-chip${isActive ? ' active' : ''}" aria-pressed="${isActive}" data-fkind="mgr" data-fval="${sid}">${isActive ? '✓ ' : ''}${m.name.replace('오토스테이_', '')}<span class="filter-chip-cnt">${m.count}</span></button>`;
    }).join('');
    const zeroToggleId = pfx + 'mgrZeroToggle';
    const zeroHiddenId = pfx + 'mgrZeroList';
    const zeroSection = zeroMgrs.length > 0
      ? `<button type="button" id="${zeroToggleId}" style="font-size:10.5px;color:var(--muted);background:none;border:none;cursor:pointer;padding:2px 4px;text-decoration:underline dotted" aria-expanded="false">0건 담당자 보기 (+${zeroMgrs.length})</button><span id="${zeroHiddenId}" style="display:none">${chipHtml(zeroMgrs)}</span>`
      : '';
    mgrEl.innerHTML = chipHtml(activeMgrs) + zeroSection;
    // 0건 토글 핸들러
    const toggleBtn = mgrEl.querySelector(`#${zeroToggleId}`);
    const hiddenEl = mgrEl.querySelector(`#${zeroHiddenId}`);
    if (toggleBtn && hiddenEl) {
      toggleBtn.onclick = () => {
        const isOpen = hiddenEl.style.display !== 'none';
        hiddenEl.style.display = isOpen ? 'none' : 'inline';
        toggleBtn.textContent = isOpen ? `0건 담당자 보기 (+${zeroMgrs.length})` : `0건 담당자 숨기기`;
        toggleBtn.setAttribute('aria-expanded', String(!isOpen));
      };
    }
  }

  const tags = (data.tags?.labels || []).slice(0, 10);
  if (tags.length === 0) {
    tagEl.innerHTML = '<span style="color:var(--muted);font-size:11px;padding:2px 4px">태그 데이터 없음</span>';
  } else {
    tagEl.innerHTML = tags.map((t, i) => {
      const isActive = filterState.tags.has(t);
      return `<button type="button" class="filter-chip${isActive ? ' active' : ''}" aria-pressed="${isActive}" data-fkind="tag" data-fval="${t}">${isActive ? '✓ ' : ''}#${t}<span class="filter-chip-cnt">${data.tags.values[i] || 0}</span></button>`;
    }).join('');
  }

  const srcMap = { native: '인앱', phone: '전화', other: '기타' };
  const srcChips = ['native', 'phone', 'other'].map((s) => {
    const cnt = (data.sources || {})[s] || 0;
    if (cnt === 0) return '';
    const isActive = filterState.sources.has(s);
    return `<button type="button" class="filter-chip${isActive ? ' active' : ''}" aria-pressed="${isActive}" data-fkind="src" data-fval="${s}">${isActive ? '✓ ' : ''}${srcMap[s]}<span class="filter-chip-cnt">${cnt}</span></button>`;
  }).join('');
  srcEl.innerHTML = srcChips || '<span style="color:var(--muted);font-size:11px;padding:2px 4px">채널 데이터 없음</span>';
  // ※ 칩 클릭 이벤트는 initFilterDrawer의 위임 핸들러가 담당 (재렌더 후에도 동작)
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
  if (total === 0) { badgeEl.innerHTML = ''; badgeEl.style.display = 'none'; return; }
  badgeEl.style.display = 'flex';
  const mgrMap = {};
  (lastData?.managers || []).forEach((m) => { mgrMap[String(m.id)] = m.name.replace('오토스테이_',''); });
  const srcMap = { native: '인앱', phone: '전화', other: '기타' };
  const badges = [];
  filterState.managers.forEach((id) => badges.push({ kind: 'mgr', val: id, label: `담당: ${mgrMap[id] || id}` }));
  filterState.tags.forEach((t) => badges.push({ kind: 'tag', val: t, label: `#${t}` }));
  filterState.sources.forEach((s) => badges.push({ kind: 'src', val: s, label: `채널: ${srcMap[s] || s}` }));
  // 필터 적용 후 장기 지연 건수 카운트 (결과 안내)
  const filteredLc = lastFilteredData?.longChats?.length ?? (lastData?.longChats?.length ?? 0);
  const resultNote = lastFilteredData
    ? `<span style="font-size:10px;color:var(--muted);margin-left:8px">장기지연 ${filteredLc}건 반영 중</span>`
    : '';
  badgeEl.innerHTML = `<span style="font-size:10.5px;color:var(--muted);font-weight:700;margin-right:4px">활성 필터:</span>` +
    badges.map((b) => `<span class="filter-badge">${b.label}<span class="filter-badge-x" data-fkind="${b.kind}" data-fval="${b.val}">×</span></span>`).join('') +
    resultNote;
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
  lastFilteredData = activeFilterCount() > 0 ? filtered : null;
  const viewData = lastFilteredData || lastData;
  // 이 필터는 원시 대화 전체를 재집계하지 않으므로 전역 KPI는 변경하지 않는다.
  // 필터 적용이 가능한 목록/분석 모듈만 다시 그려 부분 필터가 전역 수치처럼 보이는 오류를 막는다.
  safeRender(() => renderVOC(viewData), 'filter.voc');
  safeRender(() => renderVocRiskSection(viewData), 'filter.vocRisk');
  safeRender(() => renderTagRes(viewData), 'filter.tagRes');
  safeRender(() => renderTagCooccur(viewData), 'filter.tagCooccur');
  safeRender(() => renderManagers(viewData), 'filter.managers');
  safeRender(() => renderMgrQuadrant(viewData), 'filter.mgrQuadrant');
  safeRender(() => renderMgrFrtTable(viewData), 'filter.mgrFrt');
  safeRender(() => renderLongDelayPanel(viewData), 'filter.longDelay');
  // 필터 적용 범위 안내 배너
  const count = activeFilterCount();
  let scopeEl = document.getElementById('filterScopeNote');
  if (!scopeEl) {
    scopeEl = document.createElement('div');
    scopeEl.id = 'filterScopeNote';
    scopeEl.style.cssText = 'font-size:11.5px;color:#b45309;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;padding:5px 12px;margin:4px 16px 0;display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const basis = document.getElementById('kpiBasisHeader');
    if (basis && basis.parentNode) basis.parentNode.insertBefore(scopeEl, basis.nextSibling);
  }
  if (count > 0) {
    scopeEl.style.display = 'block';
    // 적용된 필터 칩 목록
    const mgrMap = {};
    (lastData?.managers || []).forEach((m) => { mgrMap[String(m.id)] = m.name.replace('오토스테이_',''); });
    const srcMap = { native: '인앱', phone: '전화', other: '기타' };
    const filterLabels = [];
    filterState.managers.forEach((id) => filterLabels.push(`<span class="fsn-chip">담당: ${mgrMap[id] || id}</span>`));
    filterState.tags.forEach((t) => filterLabels.push(`<span class="fsn-chip">#${t}</span>`));
    filterState.sources.forEach((s) => filterLabels.push(`<span class="fsn-chip">채널: ${srcMap[s] || s}</span>`));
    const _scopeTip = '반영: 담당자 테이블 · 태그 VOC · 장기지연 목록&#10;미반영: 요약 KPI · 추이 차트 · SLA (전체 원천 데이터 기준)';
    scopeEl.innerHTML = `<span style="font-weight:700">필터 ${count}개 적용 중</span> ${filterLabels.join('')}`
      + ` · <span style="color:var(--teal)">적용: 담당자표·VOC·장기지연</span>`
      + ` · <span style="color:var(--muted)">미적용: KPI·차트·SLA</span>`
      + ` <span data-tip="${_scopeTip}" tabindex="0" style="cursor:help;color:var(--muted)">ⓘ</span>`;
  } else {
    scopeEl.style.display = 'none';
  }
}

/* ─── A-2: Hero 액션 박스 ─────────────────────────────────────────────── */
function renderHeroAction(d, scoreObj) {
  const hacBody = document.getElementById('hacBody');
  const hacGrade = document.getElementById('hacGrade');
  const hacFooter = document.getElementById('hacFooter');
  if (!hacBody) return;

  const score = scoreObj.score;
  const rb = d.resolutionBuckets || {};
  const mgrConc = getManagerConcentration(d);
  const activeManagerCount = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0).length;
  const unassigned = d.summary.unassignedChats || 0;
  const openChats = d.summary.openChats || 0;
  const slow8h = rb['8시간+'] || 0;
  const complaintPct = scoreObj.complaintPct || 0;
  const topMgr = mgrConc.topMgr;
  const topPct = mgrConc.assignedPct;
  const longDelayCtx = getTopLongDelayContext(d);
  const complaintCtx = getComplaintContext(d);

  // 우선순위 액션 모음
  const actions = [];

  const complaintCount = scoreObj.complaintCount || 0;

  if (unassigned > 0) {
    actions.push({
      type: 'danger',
      title: `미배정 상담 ${unassigned}건`,
      cta: '미배정 큐 보기',
      metric: unassigned + '건',
      rec: '오픈 큐 소유권 공백',
      target: '담당자 즉시 배정',
      url: chatTalkUnassignedUrl(),
    });
  }
  if (slow8h > 0) {
    actions.push({
      type: slow8h > 10 ? 'danger' : 'warn',
      title: `장기 지연 큐 우선 정리`,
      cta: '장기지연 보기',
      metric: slow8h + '건',
      rec: longDelayCtx
        ? `최장 ${longDelayCtx.duration} · ${longDelayCtx.manager} · ${longDelayCtx.tag}`
        : '오래 지연된 상담부터 확인하세요',
      target: '8시간+ 완료 건 기준',
      onclick: 'openLongChatsPanel(); return false;',
    });
  }
  if (complaintPct >= 15) {
    actions.push({
      type: 'danger',
      title: `컴플레인 원인 차단`,
      cta: '컴플레인 원인 보기',
      metric: complaintCount + '건',
      rec: `${complaintCtx.topTag} ${complaintCtx.topCount}건 · 장기지연 연계 ${complaintCtx.longComplaintCount}건`,
      target: `${complaintPct}% · 즉시 대응 권장`,
      onclick: 'openComplaintPanel(); return false;',
    });
  } else if (complaintPct >= 8) {
    actions.push({
      type: 'warn',
      title: `컴플레인 추이 점검`,
      cta: '컴플레인 추이 보기',
      metric: complaintCount + '건',
      rec: `${complaintCtx.topTag} 중심으로 추이 확인`,
      target: `${complaintPct}% · 모니터링`,
      onclick: 'openComplaintPanel(); return false;',
    });
  }
  if (topMgr && topPct > 60) {
    actions.push({
      type: topPct > 70 && activeManagerCount > 2 ? 'danger' : 'warn',
      title: activeManagerCount <= 2 ? `백업·분산 기준 점검` : `담당자 편중 완화`,
      cta: '담당자 현황 보기',
      metric: topPct + '%',
      rec: `${dispMgrName(topMgr.name)} ${topMgr.count}건 · 배정 기준 ${topPct}%`,
      target: activeManagerCount <= 2
        ? `활성 ${activeManagerCount}명 · 휴무/피크 백업 룰 점검`
        : `전체 기준 ${mgrConc.totalPct}% · 신규 문의 분산 권장`,
      onclick: "_gotoTab('mgr-conc'); return false;",
    });
  }
  if (openChats > 5) {
    actions.push({
      type: 'warn',
      title: `미해결 오픈 채팅 ${openChats}건`,
      cta: '오픈 상담 보기',
      metric: openChats + '건',
      rec: '진행 중 상담 상태 확인',
      target: '누락 응답 방지',
      url: chatTalkOpenUrl(),
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
    const urgentCount = actions.filter(a => a.type === 'danger').length;
    const warnCount   = actions.filter(a => a.type === 'warn').length;
    const totalCount = urgentCount + warnCount;
    const queueHeader = totalCount > 0
      ? `<div class="aq-header"><div class="aq-title-row">운영 작업 큐</div><div class="aq-chips-row"><span class="aq-total">${totalCount}개 이슈</span>${urgentCount > 0 ? '<span class="aq-urgent">즉시 ' + urgentCount + '</span>' : ''}${warnCount > 0 ? '<span class="aq-warn">점검 ' + warnCount + '</span>' : ''}</div></div>`
      : `<div class="aq-header aq-ok">즉시 조치 필요 항목 없음</div>`;
    hacBody.innerHTML = queueHeader + top3.map((a, i) => {
      const isClickable = !!(a.url || a.onclick);
      const inner = `
        <div class="hac-row-num">${i + 1}</div>
        <div class="hac-row-body">
          <div class="hac-row-title">${a.title}</div>
          ${a.rec ? `<div class="hac-row-rec">${a.rec}</div>` : ''}
          ${a.target ? `<div class="hac-row-target">${a.target}</div>` : ''}
          ${isClickable ? `<div class="hac-row-cta">${a.cta}</div>` : ''}
        </div>
        <div class="hac-row-metric">${a.metric}</div>
      `;
      if (a.url) {
        return `<a href="${a.url}" target="_blank" rel="noopener noreferrer" class="hac-row-link"><div class="hac-row ${a.type}">${inner}</div></a>`;
      } else if (a.onclick) {
        // button 래퍼: <a>와 동일한 hac-row-link 클래스로 커서·호버·키보드 접근성 보장
        return `<button class="hac-row-link hac-row-btn" type="button" onclick="${a.onclick}"><div class="hac-row ${a.type}">${inner}</div></button>`;
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
  let complaints, complaintBase;
  if (d.complaintTrend?.complaints?.length > 0) {
    complaints = d.complaintTrend.complaints.reduce((a, b) => a + b, 0);
    complaintBase = d.complaintTrend.total.reduce((a, b) => a + b, 0) || total;
  } else {
    complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
      if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
      return acc;
    }, 0);
    complaintBase = total;
  }
  const complaintRate = complaints / complaintBase;
  let deductComplaint = 0;
  if (complaintRate > 0.20) deductComplaint = 30;
  else if (complaintRate > 0.15) deductComplaint = 24;
  else if (complaintRate > 0.10) deductComplaint = 16;
  else if (complaintRate > 0.05) deductComplaint = 8;
  score -= deductComplaint;

  const slowRate = (rb['8시간+'] || 0) / resTotal;
  let deductSlow = 0;
  if (slowRate > 0.50) deductSlow = 28;
  else if (slowRate > 0.35) deductSlow = 22;
  else if (slowRate > 0.20) deductSlow = 14;
  if ((rb['2~8시간'] || 0) / resTotal > 0.30) deductSlow += 6;
  score -= deductSlow;

  let deductConc = 0;
  const mgrConc = getManagerConcentration(d);
  if (mgrConc.topMgr) {
    const topPct = mgrConc.assignedPct / 100;
    if (topPct > 0.85) deductConc = 18;
    else if (topPct > 0.70) deductConc = 12;
    else if (topPct > 0.55) deductConc = 6;
  }
  score -= deductConc;

  const quickRate = ((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal;
  if (quickRate > 0.50) score += 6;
  else if (quickRate > 0.30) score += 3;
  if (d.summary.openChats > 10) score -= 5;
  if (complaintRate > 0.15 && slowRate > 0.35) score = Math.min(score, 64);

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    deductComplaint, deductSlow, deductConc,
    complaintPct: Math.round(complaintRate * 100),
    complaintCount: complaints,
    slowPct: Math.round(slowRate * 100),
    topPct: mgrConc.assignedPct,
  };
}

function getGrade(score) {
  if (score >= 85) return { grade: 'A', label: '안정', color: '#15803d' };
  if (score >= 70) return { grade: 'B', label: '관리', color: '#b45309' };
  if (score >= 55) return { grade: 'C', label: '주의', color: '#ea580c' };
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
      ss.innerHTML = `<span title="컴플레인율·장기지연율·담당자 편중도를 기준으로 감점됩니다" style="cursor:help">감점 ${totalDeduct}점 <span style="color:var(--muted);font-size:10px;font-weight:400">ⓘ</span></span>`;
    }
  }
  // 감점 내역 버튼/상세
  const deductBtn = document.getElementById('healthDeductBtn');
  const deductDetail = document.getElementById('healthDeductDetail');
  if (deductBtn && deductDetail) {
    const totalDeduct2 = deductComplaint + deductSlow + deductConc;
    if (totalDeduct2 > 0) {
      deductBtn.style.display = 'block';
      const rows = [];
      if (deductComplaint > 0) rows.push(`<div class="hdd-row"><span class="hdd-label">컴플레인율 ${complaintPct}%</span><span class="hdd-val" style="color:var(--rose)">-${deductComplaint}점</span></div>`);
      if (deductSlow > 0) rows.push(`<div class="hdd-row"><span class="hdd-label">장기지연율 ${slowPct}%</span><span class="hdd-val" style="color:var(--amber)">-${deductSlow}점</span></div>`);
      if (deductConc > 0) rows.push(`<div class="hdd-row"><span class="hdd-label">담당자 편중 ${topPct}%</span><span class="hdd-val" style="color:var(--amber)">-${deductConc}점</span></div>`);
      rows.push(`<div class="hdd-row hdd-total"><span class="hdd-label">총 감점</span><span class="hdd-val" style="color:var(--rose)">-${totalDeduct2}점</span></div>`);
      deductDetail.innerHTML = rows.join('');
      deductDetail.style.display = 'none';
      deductBtn.setAttribute('aria-expanded', 'false');
    } else {
      deductBtn.style.display = 'none';
      deductDetail.style.display = 'none';
    }
  }
}

function toggleHealthDeduct() {
  const btn = document.getElementById('healthDeductBtn');
  const detail = document.getElementById('healthDeductDetail');
  if (!detail) return;
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'block';
  if (btn) {
    btn.textContent = isOpen ? '감점 내역 보기' : '감점 내역 닫기';
    btn.setAttribute('aria-expanded', String(!isOpen));
  }
}

/* ─── Insights / Alert (기존 유지) ──────────────────────────────────── */
function generateInsights(d, scoreObj) {
  const insights = [];
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const mgrConc = getManagerConcentration(d);
  const activeManagerCount = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0).length;
  const complaintPct = scoreObj.complaintPct;
  if (complaintPct >= 15) insights.push({ type: 'danger', icon: '위험', short: `컴플레인 ${complaintPct}%`, detail: `컴플레인 비율 ${complaintPct}% — 즉각 대응 필요 (기준: 15% 이상)` });
  else if (complaintPct >= 8) insights.push({ type: 'warn', icon: '주의', short: `컴플레인 ${complaintPct}%`, detail: `컴플레인 비율 ${complaintPct}% — 모니터링 권장 (기준: 8% 이상)` });
  if (mgrConc.topMgr) {
    const topPct = mgrConc.assignedPct;
    const topName = dispMgrName(mgrConc.topMgr.name);
    if (topPct > 80 && activeManagerCount <= 2) insights.push({ type: 'warn', icon: '점검', short: `${topName} ${topPct}%`, detail: `${topName} 처리 집중도 ${topPct}% · 활성 담당자 ${activeManagerCount}명 — 과부하 단정보다 백업·분산 기준 점검이 우선입니다` });
    else if (topPct > 80) insights.push({ type: 'danger', icon: '위험', short: `${topName} ${topPct}%`, detail: `${topName} 처리 집중도 ${topPct}% — 과부하 위험, 즉시 재배정 검토` });
    else if (topPct > 60) insights.push({ type: 'warn', icon: '주의', short: `${topName} ${topPct}%`, detail: `${topName} 처리 집중도 ${topPct}% — 편중 주의` });
  }
  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 30) insights.push({ type: 'warn', icon: '지연', short: `8h+ ${slowPct}%`, detail: `8시간 이상 해결 ${slowPct}% — 장기지연 비율 높음` });
  // FRT 인사이트
  if (d.frtStats && d.frtStats.median > 30) {
    insights.push({ type: 'warn', icon: 'FRT', short: `P50 ${fmtMin(d.frtStats.median)}`, detail: `첫 응답 중앙값 ${fmtMin(d.frtStats.median)} — 30분 초과, 응답 속도 개선 필요` });
  } else if (d.frtStats && d.frtStats.median <= 5) {
    insights.push({ type: 'good', icon: 'FRT', short: `P50 ${fmtMin(d.frtStats.median)}`, detail: `첫 응답 중앙값 ${fmtMin(d.frtStats.median)} — 신속 대응 양호` });
  }
  // FCR은 재오픈 이벤트가 실제로 수집될 때만 운영 인사이트에 사용
  if (d.fcrStats?.available && d.fcrStats.fcrRate != null && d.fcrStats.fcrRate < 80) {
    insights.push({ type: 'warn', icon: 'FCR', short: `FCR ${d.fcrStats.fcrRate}%`, detail: `1차 해결률 ${d.fcrStats.fcrRate}% — 재오픈 ${d.fcrStats.reopenedCount}건` });
  }
  return insights;
}

function renderInsights(insights) {
  const strip = document.getElementById('insightsStrip');
  if (!strip) return;
  if (!insights.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = `<div class="insights-label">자동 인사이트</div>` + insights.map((ins) => `
    <div class="insight-chip ${ins.type}" data-tip="${ins.detail || ins.short}" tabindex="0" role="status" aria-label="${ins.detail || ins.short}">
      <span class="insight-icon insight-label-badge">${ins.icon}</span>
      <span>${ins.short || ins.text}</span>
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
  const mgrConc = getManagerConcentration(d);
  const activeManagerCount = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0).length;
  if (mgrConc.topMgr) {
    const topPct = mgrConc.assignedPct;
    if (topPct > 70) alerts.push({
      level: activeManagerCount <= 2 ? 'warn' : 'danger',
      icon: '편중',
      title: activeManagerCount <= 2 ? '백업 기준 점검' : '담당자 과부하',
      body: `${dispMgrName(mgrConc.topMgr.name)} · 배정 기준 ${topPct}% · 활성 ${activeManagerCount}명`
    });
  }
  let complaintsAS, complaintBaseAS;
  if (d.complaintTrend?.complaints?.length > 0) {
    complaintsAS = d.complaintTrend.complaints.reduce((a, b) => a + b, 0);
    complaintBaseAS = d.complaintTrend.total.reduce((a, b) => a + b, 0) || total;
  } else {
    complaintsAS = (d.tags?.labels || []).reduce((acc, lbl, i) => lbl.includes('컴플레인') ? acc + (d.tags.values[i] || 0) : acc, 0);
    complaintBaseAS = total;
  }
  const complaints = complaintsAS;
  const complaintPct = Math.round(complaintsAS / complaintBaseAS * 100);
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

/* ─── Hero Inline Meta (v4.1) — 퀵스탯 박스 → 인라인 1줄 ─────────────── */
function renderHeroQuickStats(d, scoreObj) {
  const totalChats = d.summary?.totalChats || 0;
  const frtMedian = d.frtStats?.median;
  const fcrRate = d.fcrStats?.fcrRate;
  const rangeLabel = currentDays === 'all' ? '전체' : `최근 ${currentDays}일`;

  const elT = document.getElementById('himTotal');
  if (elT) elT.textContent = fmt(totalChats) + '건';

  const elFrt = document.getElementById('himFrt');
  if (elFrt) elFrt.textContent = frtMedian != null ? fmtMin(frtMedian) : '—';

  const elFcr = document.getElementById('himFcr');
  if (elFcr) {
    elFcr.textContent = fcrRate != null ? fcrRate + '%' : '측정 불가';
    elFcr.style.color = fcrRate == null ? '#8B95A1' : fcrRate >= 90 ? '#047857' : fcrRate >= 75 ? '#B45309' : '#BE123C';
  }

  const elRange = document.getElementById('himRange');
  if (elRange) elRange.textContent = rangeLabel;
}

function renderHeroDecisionSummary(d, scoreObj) {
  const el = document.getElementById('heroDecisionSummary');
  if (!el) return;
  const grade = getGrade(scoreObj.score);
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const slow8h = rb['8시간+'] || 0;
  const slowPct = Math.round(slow8h / resTotal * 100);
  const mgrConc = getManagerConcentration(d);
  const dataNote = d.dataNote || {};
  const sameAcrossPeriods = isSameAcrossMainPeriods(dataNote);
  const fcrRate = d.fcrStats?.fcrRate;
  const frtMedian = d.frtStats?.median;
  const activeManagerCount = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0).length;
  const slowTone = slowPct > 30 ? 'danger' : slowPct > 10 ? 'warn' : 'good';
  const complaintTone = scoreObj.complaintPct >= 15 ? 'danger' : scoreObj.complaintPct >= 8 ? 'warn' : 'good';
  const concentrationTone = mgrConc.assignedPct > 80
    ? (activeManagerCount <= 2 ? 'warn' : 'danger')
    : mgrConc.assignedPct > 60 ? 'warn' : 'good';
  const frtTone = frtMedian == null ? 'neutral' : frtMedian <= 5 ? 'good' : frtMedian <= 30 ? 'warn' : 'danger';
  const fcrTone = fcrRate == null ? 'neutral' : fcrRate >= 90 ? 'good' : fcrRate >= 75 ? 'warn' : 'danger';
  const statusTone = scoreObj.score >= 80 ? 'good' : scoreObj.score >= 60 ? 'warn' : 'danger';
  const reliabilityBadges = getDataReliabilityBadges(d);
  el.innerHTML = `
    <div class="hds-status hds-${statusTone}">
      <span class="hds-label">운영 판정</span>
      <strong>${scoreObj.score}점 · ${grade.label}</strong>
    </div>
    <div class="hds-grid">
      <span class="hds-chip ${slowTone}">장기지연 ${slowPct}%</span>
      <span class="hds-chip ${complaintTone}">컴플레인 ${scoreObj.complaintPct}%</span>
      <span class="hds-chip ${concentrationTone}">편중 ${mgrConc.assignedPct}%</span>
      <span class="hds-chip ${frtTone}">FRT ${frtMedian != null ? fmtMin(frtMedian) : '—'}</span>
      <span class="hds-chip ${fcrTone}" title="${fcrRate == null ? '재오픈 상태 이력 미수집' : ''}">FCR ${fcrRate != null ? fcrRate + '%' : '측정 불가'}</span>
      ${sameAcrossPeriods ? '<span class="hds-chip warn">기간별 동일</span>' : ''}
      ${reliabilityBadges}
    </div>`;
}

/* ─── KPI Grid ──────────────────────────────────────────────────────── */
function renderKPIs(d, scoreObj) {
  const { summary } = d;
  const mgrConc = getManagerConcentration(d);
  const activeManagerCount = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0).length;
  const topMgr = mgrConc.topMgr;
  const totalChats = summary.totalChats || 1;
  const openChats = summary.openChats || 0;
  const unassigned = summary.unassignedChats || 0;
  const longChatOpenCount = (d.longChats || []).length;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const slow8h = rb['8시간+'] || 0;
  const slow8hPct = Math.round(slow8h / resTotal * 100);
  const topPct = mgrConc.assignedPct;
  const complaintPct = scoreObj?.complaintPct || 0;
  const dataNote = d.dataNote || {};
  const isSampled = dataNote.isSampled || false;
  const limitVal = dataNote.limit || 1000;
  const sameAcrossPeriods = isSameAcrossMainPeriods(dataNote);
  const diagForCache = d.diagnostics || {};
  const cacheMeta = getCacheMeta(diagForCache);
  const unknownStats = getUnknownTagStats(d);
  const resSample = getResolutionSampleStats(d);
  const historyStatus = getDurableHistoryStatus(d);

  const cacheBadge = document.getElementById('cacheBadge');
  if (cacheBadge) {
    const diag = diagForCache;
    const isHit = diag.cacheHit;
    const cacheLabel = isHit ? cacheMeta.shortLabel : '최신 조회';
    cacheBadge.innerHTML = cacheLabel;
    cacheBadge.className = isHit ? 'hero-cache-badge cache-hit' : 'hero-cache-badge cache-miss';
    // TTL / 수집시간 / 갱신 방법을 tooltip에 통합
    const paginMs = diag.paginationMs ? `원본 수집 ${diag.paginationMs}ms` : '';
    cacheBadge.title = isHit
      ? `${cacheMeta.storageLabel}에서 응답 · 최대 5분 TTL${paginMs ? ' · ' + paginMs : ''}\n강제 갱신: 새로고침 버튼 클릭`
      : `Channel Talk API 직접 조회 — 최신 데이터 (지연 없음)\n캐시 방식: ${cacheMeta.storageLabel}`;
  }

  const kpiBasisHeaderEl = document.getElementById('kpiBasisHeader');
  if (kpiBasisHeaderEl) {
    kpiBasisHeaderEl.style.display = 'flex';
    const diagObj = diagForCache;
    const cacheTypeName = cacheMeta.shortLabel;
    const collectedTotal = dataNote.collected || totalChats;
    const sampledWarn = isSampled
      ? ` <span style="color:var(--amber);font-weight:700" data-tip="API 수집 한도(${limitVal}건)에 도달했습니다. 오래된 채팅은 집계에서 제외될 수 있습니다." tabindex="0" style="cursor:help">⚠ 수집 상한(${limitVal}건) 도달 — 최근 ${limitVal}건 기준 집계</span>`
      : (collectedTotal < limitVal
        ? ` <span style="color:var(--muted);font-size:10px" data-tip="전체 수집 ${collectedTotal}건 · API 한도(${limitVal}건) 미도달 → 기간을 늘려도 동일 건수가 표시될 수 있습니다" tabindex="0" style="cursor:help">전체 수집 ${collectedTotal}건</span>`
        : '');
    const paginMs = diagObj.paginationMs ? diagObj.paginationMs + 'ms' : '—';
    const cacheInfo = diagObj.cacheHit
      ? `<span data-tip="${cacheMeta.note} · 원본 수집시간 ${paginMs}" style="color:var(--amber);margin-left:6px;cursor:help" tabindex="0">${cacheTypeName}</span>`
      : (d.diagnostics ? `<span data-tip="Channel Talk API 직접 조회 결과 — 지연 없음 · 다음 요청부터 ${cacheMeta.shortLabel} 대기 중" style="color:var(--teal);margin-left:6px;cursor:help" tabindex="0">최신 조회</span>` : `<span style="color:var(--muted);margin-left:6px">캐시 없음</span>`);
    // ⓘ 툴팁에 상세 정보 압축 (Channel Talk API · 캐시 · KST · 전체 수집 · 범례)
    const _basisDetailLines = [
      `채널톡 API closed 상태 채팅 수 기준 (완료 처리된 건만 집계)`,
      `채널톡 Open API v5 실데이터. 해결시간·FRT는 종료 후 계산값`,
      `${cacheMeta.note}`,
      `기준 시간: KST (한국 표준시)`,
      (collectedTotal > 0 ? `전체 수집: ${collectedTotal}건 (API 한도 ${limitVal}건)` : ''),
      `실데이터=채널톡 API 원천값 / 계산값=서버 집계 / 캐시=5분 TTL`,
    ].filter(Boolean).join('&#10;');
    const _sampledNote = isSampled
      ? ` <span style="color:var(--amber);font-weight:700;font-size:10px" data-tip="API 수집 한도(${limitVal}건)에 도달했습니다. 오래된 채팅은 집계에서 제외될 수 있습니다." tabindex="0" style="cursor:help">⚠ 수집 상한</span>`
      : '';
    // 실제 데이터 날짜 범위 포매팅 (processedMinAt/processedMaxAt → YYYY-MM-DD KST)
    const _fmtDateFull = (ts) => {
      if (!ts) return null;
      const d2 = new Date(ts + 9 * 3600 * 1000); // KST
      const y = d2.getUTCFullYear();
      const m = String(d2.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d2.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const _minDate = _fmtDateFull(dataNote.processedMinAt);
    const _maxDate = _fmtDateFull(dataNote.processedMaxAt);
    const _dateRangeStr = (_minDate && _maxDate)
      ? (_minDate === _maxDate ? _minDate : `${_minDate} ~ ${_maxDate}`)
      : null;

    // 기간 필터 무관 — 수집 전체가 현재 기간 내에 포함된 경우 안내
    const _allInPeriod = !isSampled && dataNote.collected > 0 && dataNote.collected === dataNote.processed;
    const _dateRangeTip = _dateRangeStr ? `&#10;실제 포함 기간: ${_dateRangeStr}` : '';
    const _samePeriodsNote = _allInPeriod
      ? ` · <span style="color:var(--amber);font-size:10px;font-weight:800;cursor:help"
            data-tip="현재 수집된 closed 채팅 ${dataNote.collected}건이 선택 기간 안에 모두 포함됩니다.&#10;${sameAcrossPeriods ? '특히 실제 데이터 범위가 7일 이내라 7일·14일·30일·전체 핵심 지표가 동일하게 보이는 것이 정상입니다.' : '선택 기간보다 오래된 원천 데이터가 없으면 기간을 넓혀도 지표가 바뀌지 않습니다.'}&#10;API 수집 한도(${limitVal}건) 미도달${_dateRangeTip}&#10;현재 요청 파라미터: days=${currentDays}"
            tabindex="0">${sameAcrossPeriods ? '7/14/30/전체 동일 데이터 ⓘ' : '기간 확장 영향 없음 ⓘ'}</span>`
      : '';
    const _qualityNote = [
      unknownStats.isHigh ? `VOC 미분류 ${unknownStats.pct}% (${unknownStats.count}/${unknownStats.total})` : '',
      resSample.n && resSample.n < 80 ? `해결시간 n=${resSample.n} ${resSample.label}` : '',
      !historyStatus.configured ? '외부 스냅샷 미설정' : (historyStatus.historyDays < 14 ? `${historyStatus.label} 누적 중` : ''),
      !hasPeriodBaseline(d) ? '기간 비교 기준 부족' : '',
    ].filter(Boolean).join(' · ');
    const _qualityHtml = _qualityNote
      ? ` · <span class="kpi-quality-inline" data-tip="작은 표본·미분류 태그·짧은 수집 기간은 비율 지표를 흔들 수 있습니다.&#10;현재 표시: ${_qualityNote}" tabindex="0">신뢰도 점검: ${_qualityNote} ⓘ</span>`
      : '';
    const _dateRangeNote = _dateRangeStr
      ? ` <span style="color:var(--muted);font-size:10px" data-tip="수집된 채팅의 실제 날짜 범위 (KST 기준)" tabindex="0" style="cursor:help">실제 범위 ${_dateRangeStr}</span>`
      : '';
    // 기간 선택과 실제 데이터 범위 불일치 경고 (선택 기간 >> 실제 데이터 스팬)
    const _periodMismatchNote = (() => {
      if (currentDays === 'all' || !dataNote.processedMinAt || !dataNote.processedMaxAt) return '';
      const expectedStartMs = Date.now() - currentDays * 86400 * 1000;
      const actualStartMs = dataNote.processedMinAt;
      const missingDays = Math.round((actualStartMs - expectedStartMs) / (86400 * 1000));
      if (missingDays < 2) return ''; // 2일 미만 차이는 정상 범위
      const actualSpanDays = Math.max(1, Math.round((dataNote.processedMaxAt - dataNote.processedMinAt) / (86400 * 1000)) + 1);
      const completeness = dataNote.currentPeriodComplete === false
        ? '수집 상한 때문에 선택 기간 전체를 보장할 수 없음'
        : '해당 구간 완료 상담이 없거나 원천 데이터가 존재하지 않음';
      return ` · <span style="color:var(--amber);font-size:10px;font-weight:700;cursor:help"
        data-tip="최근 ${currentDays}일 선택 / 실제 포함 범위: ${_dateRangeStr || '?'} (${actualSpanDays}일치)&#10;${completeness}&#10;수집 완결: ${dataNote.currentPeriodComplete === false ? '미보장' : '확인'}"
        tabindex="0">실데이터 ${actualSpanDays}/${currentDays}일 ⓘ</span>`;
    })();
    kpiBasisHeaderEl.innerHTML = `
      <span>분석 기준</span>
      <span style="font-weight:400;color:#0d9488">
        ${currentDays === 'all' ? `최근 ${limitVal}건 한도` : `최근 ${currentDays}일`}
        · <strong>${totalChats}건</strong> 기준
        <span data-tip="${_basisDetailLines}" tabindex="0" style="cursor:help;color:var(--muted);font-weight:400"> ⓘ</span>
      </span>${_dateRangeNote}${_periodMismatchNote}${cacheInfo}${_sampledNote}${_samePeriodsNote}${_qualityHtml}`;
  }

  const grid = document.getElementById('kpiGrid');
  if (!grid) return;

  // KPI 카드 위험도 순 정렬 — rose(danger)=3 > amber(warn)=2 > green(good)=0
  const _kpiSev = (c) => c === 'rose' ? 3 : c === 'amber' ? 2 : 0;
  const _c1 = unassigned > 0 ? 'rose' : 'green';
  const _c2 = openChats > 5 ? 'rose' : openChats > 0 ? 'amber' : 'green';
  const _c3 = slow8h > 10 ? 'rose' : slow8h > 0 ? 'amber' : 'green';
  const _c4 = complaintPct >= 15 ? 'rose' : complaintPct >= 8 ? 'amber' : 'green';
  const _c5 = topPct > 80 ? 'rose' : topPct > 60 ? 'amber' : 'green';

  const kpiCards = [
    { sev: _kpiSev(_c1), html: unassigned === 0
      ? `<a class="kpi-card-ok" href="${chatTalkUnassignedUrl()}" target="_blank" rel="noopener noreferrer" title="미배정 상담 없음 — 클릭하여 채널톡 확인">
          <div class="kco-label">미배정</div>
          <div class="kco-body"><span class="kco-val">없음</span><span class="kco-badge">운영 정상</span></div>
        </a>`
      : `<a class="kpi-card a-${_c1}" href="${chatTalkUnassignedUrl()}" target="_blank" rel="noopener noreferrer"
          data-tip="【미배정 상담 (No Assignee)】&#10;출처: 채널톡 API 실시간 조회 (실데이터)&#10;정의: 현재 진행 중(opened) 상담 중 담당자(assigneeId)가 없는 건&#10;기준: 종결(closed) 상담 제외 · 현재 오픈 상담만&#10;※ Queue(자동배정 대기)와는 다른 개념: No assignee = 수동 배정 필요&#10;클릭 → 채널톡 인박스 미배정 목록으로 이동">
          <div class="kpi-label">미배정 <span class="kpi-src-icon" data-tip="채널톡 실데이터 · 현재 오픈 상담 기준 (No Assignee)" tabindex="0" style="cursor:help">ⓘ</span></div>
          <div class="kpi-value">${fmt(unassigned)}<span class="unit">건</span></div>
          <div class="kpi-meta">
            <span class="data-badge badge-real">실데이터</span>
            <span class="delta bad">즉시 배정 ↗</span>
          </div>
        </a>` },
    { sev: _kpiSev(_c2), html: `<a class="kpi-card a-${_c2}" href="${chatTalkOpenUrl()}" target="_blank" rel="noopener noreferrer"
      data-tip="【오픈 채팅】&#10;출처: 채널톡 API 실시간 조회 (실데이터)&#10;정의: 현재 진행 중인 미종결(open) 채팅 수&#10;계산: API status=opened 건수&#10;기준: 현재 실시간 상태 (기간 필터 무관)&#10;클릭 → 채널톡 인박스 오픈 채팅 목록으로 이동 (state=opened 필터)">
      <div class="kpi-label">오픈 채팅</div>
      <div class="kpi-value">${fmt(openChats)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${openChats === 0 ? 'good' : openChats > 5 ? 'bad' : 'neutral'}">${openChats === 0 ? '없음' : '진행중'}</span>
      </div>
      ${openChats > 0 ? `<div style="font-size:9px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap">
        ${unassigned > 0 ? `<span style="color:var(--rose)">미배정 ${unassigned}건</span>` : '<span style="color:var(--green)">전원 배정</span>'}
      </div>` : ''}
    </a>` },
    { sev: _kpiSev(_c3), html: `<div class="kpi-card a-${_c3}" onclick="openLongChatsPanel()"
      data-tip="【8시간+ 해결시간】&#10;출처: 서버 계산값&#10;정의: 종결 채팅 중 해결시간 ≥ 480분(8h) 케이스 수&#10;계산: closed 채팅의 resolutionMin ≥ 480 건수&#10;분모: 해결시간 집계 가능한 closed 채팅 전체(${resTotal}건)&#10;비율: ${slow8hPct}% (${slow8h}/${resTotal})&#10;※ 오픈 대기중인 건이 아닌 완료된 채팅 기준" tabindex="0">
      <div class="kpi-label">장기지연</div>
      <div class="kpi-value">${fmt(slow8h)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-calc">계산값</span>
        <span class="delta ${slow8h === 0 ? 'good' : slow8h > 10 ? 'bad' : 'neutral'}">${slow8h}/${resTotal}건 · ${slow8hPct}%</span>
      </div>
      <div style="font-size:9.5px;color:var(--muted);margin-top:auto;padding-top:6px">장기지연 보기</div>
    </div>` },
    { sev: _kpiSev(_c4), html: `<div class="kpi-card a-${_c4}" onclick="openComplaintPanel()"
      data-tip="【컴플레인율 — 채팅 단위】&#10;출처: 채널톡 태그 실데이터&#10;정의: 컴플레인 관련 태그가 붙은 고유 채팅 수 비율&#10;계산: 컴플레인 채팅 수 ÷ 전체 closed 채팅 수 × 100&#10;분모: summary.totalChats (${totalChats}건)&#10;★ 채팅 1건 = 1회 카운트 (태그 중복 집계 없음)&#10;※ VOC #컴플레인 수치는 태그 발생 횟수 기준이므로 수치 상이&#10;클릭 → 유형별 원인 분석" tabindex="0">
      <div class="kpi-label">컴플레인율</div>
      <div class="kpi-value">${complaintPct}<span class="unit">%</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${complaintPct >= 15 ? 'bad' : complaintPct >= 8 ? 'neutral' : 'good'}">${complaintPct >= 15 ? '즉시 대응' : complaintPct >= 8 ? '모니터링' : '양호'}</span>
      </div>
      <div style="font-size:9.5px;color:var(--muted);margin-top:auto;padding-top:6px">컴플레인 원인 보기</div>
    </div>` },
    { sev: _kpiSev(_c5), html: `<div class="kpi-card a-${_c5}" onclick="_gotoTab('mgr-conc')"
      data-tip="【담당자 편중 — 배정 처리 기준】&#10;출처: 서버 계산값&#10;계산: 최다 처리 담당자 수 ÷ 배정 담당자 처리 합계 × 100&#10;분모: 배정 담당자 합계 ${mgrConc.assignedTotal}건 (봇·미배정·제외 담당자 제외)&#10;최다 처리: ${topMgr ? dispMgrName(topMgr.name) + ' (' + topMgr.count + '건)' : '—'}&#10;전체 closed 기준 보조값: ${mgrConc.totalPct}% (${topMgr ? topMgr.count : 0}/${totalChats})&#10;클릭 → 담당자 집중도 탭" tabindex="0">
      <div class="kpi-label">담당자 편중 <span style="font-size:9px;font-weight:400;color:var(--muted)">(배정 기준)</span></div>
      <div class="kpi-value">${topPct}<span class="unit">%</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-calc">계산값</span>
        <span class="delta ${topPct > 80 && activeManagerCount > 2 ? 'bad' : topPct > 60 ? 'neutral' : 'good'}">${topPct > 80 ? (activeManagerCount <= 2 ? '구조 점검' : '과부하') : topPct > 60 ? '주의' : '분산 양호'}</span>
      </div>
      <div class="kpi-meta" style="margin-top:2px">
        <span style="font-size:10px;color:var(--muted)">${topMgr ? dispMgrName(topMgr.name) : '—'} · 전체 기준 ${mgrConc.totalPct}%</span>
        <span style="font-size:9.5px;color:var(--muted);margin-left:4px" data-tip="대표값은 배정 담당자 처리 합계를 분모로 사용합니다.&#10;전체 closed 기준은 ${mgrConc.totalPct}%로 보조 표시합니다." tabindex="0" style="cursor:help">ⓘ</span>
      </div>
    </div>` },
  ];
  // 상단 메인 KPI는 실제 위험 드라이버 3개만 유지하고, 실시간 운영 상태는 별도 레일로 분리
  const _secIdxSet = new Set([0, 1]);
  const primaryCards = kpiCards.filter((_, i) => !_secIdxSet.has(i));
  primaryCards.sort((a, b) => b.sev - a.sev);
  grid.innerHTML = primaryCards.map(c => c.html).join('');

  const kpiGridSec = document.getElementById('kpiGridSecondary');
  if (kpiGridSec) {
    kpiGridSec.className = 'ops-status-rail';
    const fmtDateShort = (ts) => {
      if (!ts) return null;
      const dt = new Date(ts + 9 * 3600 * 1000);
      return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
    };
    const minShort = fmtDateShort(dataNote.processedMinAt);
    const maxShort = fmtDateShort(dataNote.processedMaxAt);
    const rangeShort = minShort && maxShort
      ? (minShort === maxShort ? minShort : `${minShort}-${maxShort}`)
      : (currentDays === 'all' ? '전체' : `${currentDays}일`);
    const dataSpanDays = getDataSpanDays(dataNote);
    const cacheTone = cacheMeta.source === 'kv' ? 'good' : 'neutral';
    const statusItems = [
      {
        tone: unassigned > 0 ? 'danger' : 'good',
        label: '미배정',
        value: unassigned > 0 ? `${unassigned}건` : '없음',
        sub: unassigned > 0 ? '담당자 배정 필요' : '오픈 큐 정상',
        url: chatTalkUnassignedUrl(),
      },
      {
        tone: openChats > 5 ? 'danger' : openChats > 0 ? 'warn' : 'good',
        label: '오픈 채팅',
        value: `${openChats}건`,
        sub: unassigned > 0 ? `미배정 ${unassigned}건 포함` : '전원 배정',
        url: chatTalkOpenUrl(),
      },
      {
        tone: cacheTone,
        label: '캐시',
        value: cacheMeta.shortLabel,
        sub: cacheMeta.source === 'kv' ? '공유 캐시 사용' : '인스턴스 한정',
      },
      {
        tone: isSampled ? 'warn' : 'neutral',
        label: '데이터 범위',
        value: rangeShort,
        sub: sameAcrossPeriods ? `기간별 동일 · ${totalChats}건` : (dataSpanDays ? `실데이터 ${dataSpanDays}일 · ${totalChats}건` : `${totalChats}건 기준`),
      },
    ];
    kpiGridSec.innerHTML = statusItems.map((item) => {
      const content = `
        <span class="ops-status-dot"></span>
        <span class="ops-status-body">
          <span class="ops-status-label">${item.label}</span>
          <span class="ops-status-value">${item.value}</span>
          <span class="ops-status-sub">${item.sub}</span>
        </span>`;
      if (item.url) {
        return `<a class="ops-status-item osi-${item.tone}" href="${item.url}" target="_blank" rel="noopener noreferrer">${content}</a>`;
      }
      if (item.onclick) {
        return `<button class="ops-status-item osi-${item.tone}" type="button" onclick="${item.onclick}">${content}</button>`;
      }
      return `<div class="ops-status-item osi-${item.tone}">${content}</div>`;
    }).join('');
  }
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
  const _mob = window.innerWidth <= 430;
  charts.trend = new Chart(document.getElementById('trendChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: dailyTrend.labels,
      datasets: [
        { label: '종료 채팅', data: dailyTrend.values, backgroundColor: dailyTrend.values.map((v) => v >= peak * 0.8 ? '#be123c' : v >= peak * 0.45 ? '#0f766e' : '#14b8a6'), borderRadius: _mob ? 2 : 3, order: 2 },
        { label: '활성일 평균', data: Array(dailyTrend.labels.length).fill(avg), type: 'line', borderColor: '#f59e0b', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, fill: false, order: 1 },
        ...(_mob ? [] : [{ label: '7일 이동평균', data: ma7, type: 'line', borderColor: '#6d28d9', borderWidth: 2, pointRadius: 0, fill: false, tension: 0.35, order: 0 }]),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 7 } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: _mob ? 9 : 10 }, maxRotation: _mob ? 0 : 50, maxTicksLimit: _mob ? 7 : 12 } },
        y: { grid: { color: '#f1efe8' }, ticks: { font: { size: _mob ? 9 : 11 }, callback: (v) => v + '건' }, beginAtZero: true }
      }
    }
  });
  const trendEl = document.getElementById('trendChart');
  if (trendEl) {
    // aria-label: 합계는 summary.totalChats(=processed) 기준으로 화면 수치와 일치시킴
    const _ariaTotal = summary.totalChats || 0;
    const _dn = d.dataNote || {};
    const _ariaSpan = (_dn.processedMinAt && _dn.processedMaxAt)
      ? Math.max(1, Math.round((_dn.processedMaxAt - _dn.processedMinAt) / (86400 * 1000)) + 1)
      : activeVals.length;
    const _ariaMinD = _dn.processedMinAt ? (() => { const d2 = new Date(_dn.processedMinAt + 9*3600*1000); return `${d2.getUTCFullYear()}-${String(d2.getUTCMonth()+1).padStart(2,'0')}-${String(d2.getUTCDate()).padStart(2,'0')}`; })() : null;
    const _ariaMaxD = _dn.processedMaxAt ? (() => { const d2 = new Date(_dn.processedMaxAt + 9*3600*1000); return `${d2.getUTCFullYear()}-${String(d2.getUTCMonth()+1).padStart(2,'0')}-${String(d2.getUTCDate()).padStart(2,'0')}`; })() : null;
    const _ariaRange = (_ariaMinD && _ariaMaxD) ? `, 표시 구간 ${_ariaMinD}~${_ariaMaxD}` : '';
    const _ariaLabel = currentDays === 'all'
      ? `일별 채팅 추이 차트, 전체 수집 ${_ariaTotal}건 기준${_ariaRange}, 일평균 ${Math.round(avg)}건`
      : `일별 채팅 추이 차트, 최근 ${currentDays}일 기준${_ariaRange}, 합계 ${_ariaTotal}건, 일평균 ${Math.round(avg)}건`;
    trendEl.setAttribute('aria-label', _ariaLabel);
  }
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
  // 4시간 블록으로 그룹화: 6개 컬럼
  const blocks = [
    { label: '0-3시\n새벽', hours: [0,1,2,3] },
    { label: '4-7시\n이른아침', hours: [4,5,6,7] },
    { label: '8-11시\n오전', hours: [8,9,10,11] },
    { label: '12-15시\n오후', hours: [12,13,14,15] },
    { label: '16-19시\n저녁', hours: [16,17,18,19] },
    { label: '20-23시\n심야', hours: [20,21,22,23] },
  ];
  const hm = d.heatmap || {};
  // 블록별 집계
  const blockData = {}; // key: `${di}-${bi}` => sum
  for (let di = 0; di < 7; di++) {
    blocks.forEach((blk, bi) => {
      blockData[`${di}-${bi}`] = blk.hours.reduce((s, h) => s + (hm[`${di}-${h}`] || 0), 0);
    });
  }
  const allVals = Object.values(blockData);
  const maxVal = allVals.length ? Math.max(...allVals) : 1;

  const el = document.getElementById('heatmap');
  el.innerHTML = '';
  // 헤더 행: 빈 셀 + 블록 라벨
  el.appendChild(Object.assign(document.createElement('div'), { className: 'hm-head' }));
  blocks.forEach((blk) => {
    const div = document.createElement('div');
    div.className = 'hm-head'; div.innerHTML = blk.label.replace('\n', '<br>');
    el.appendChild(div);
  });
  days.forEach((day, di) => {
    const lbl = document.createElement('div');
    lbl.className = 'hm-row-label'; lbl.textContent = day;
    el.appendChild(lbl);
    blocks.forEach((blk, bi) => {
      const v = blockData[`${di}-${bi}`];
      const lvl = v === 0 ? 0 : Math.min(5, Math.ceil((v / maxVal) * 5));
      const cell = document.createElement('div');
      cell.className = `hm-cell hm-${lvl}`;
      cell.textContent = v || '';
      const rangeStr = `${blk.hours[0]}~${blk.hours[3]}시`;
      cell.setAttribute('data-tip', `${day}요일 ${rangeStr} · ${v}건`);
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
    const blockTotals = blocks.map((blk, bi) => {
      const total = days.reduce((s, _, di) => s + (blockData[`${di}-${bi}`] || 0), 0);
      const parts = blk.label.split('\n');
      return { timeRange: parts[0], timeLabel: parts[1] || '', total };
    });
    const top3 = [...blockTotals].sort((a, b) => b.total - a.total).slice(0, 3).filter(b => b.total > 0);
    const dayTotals = {};
    for (let di = 0; di < 7; di++) {
      dayTotals[di] = blocks.reduce((s, _, bi) => s + (blockData[`${di}-${bi}`] || 0), 0);
    }
    const peakDayIdx = Object.entries(dayTotals).sort((a, b) => b[1] - a[1])[0];
    const rankLabels = ['1위', '2위', '3위'];
    if (top3.length > 0) hmPeakEl.style.display = 'block';
    hmPeakEl.innerHTML = `
      <div class="hm-peak-cards">
        ${top3.map((blk, rank) => `
          <div class="hm-peak-card rank-${rank + 1}">
            <div class="hm-peak-card-rank">${rankLabels[rank]}</div>
            <div class="hm-peak-card-time">${blk.timeRange}</div>
            <div class="hm-peak-card-label">${blk.timeLabel}</div>
            <div class="hm-peak-card-count">${blk.total}건</div>
            <div class="hm-peak-card-bar"><div class="hm-peak-card-bar-fill" style="width:${Math.round(blk.total / (top3[0].total || 1) * 100)}%"></div></div>
          </div>`).join('')}
      </div>
      ${peakDayIdx ? `<div class="hm-peak-day-note">주간 최다 요일: <strong>${days[parseInt(peakDayIdx[0])]}요일</strong> (${peakDayIdx[1]}건)</div>` : ''}`;
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
  const tagLabels10 = tags.labels.slice(0, 10);
  const tagBarColors = tagLabels10.map((lbl) =>
    lbl.includes('컴플레인') ? '#f43f5e' : '#CBD5E1'
  );
  charts.cat = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: tagLabels10,
      datasets: [{ data: tags.values.slice(0, 10), backgroundColor: tagBarColors, borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 7, callbacks: { label: (ctx) => `${ctx.parsed.x}건 (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` } } },
      scales: { x: { grid: { color: '#f1efe8' }, ticks: { font: { size: 10 } } }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } }
    }
  });
  const topTag = tags.labels[0] || '-';
  el.setAttribute('aria-label', `태그별 분포 차트, 상위 ${Math.min(tags.labels.length, 10)}개 태그, 1위: ${topTag} ${tags.values[0] || 0}건`);
}

function renderVOC(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocList');
  if (!el || !tags?.labels?.length) { if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px">태그 데이터 없음</div>'; return; }
  const totalForPct = summary.totalChats || 1;
  const unknownStats = getUnknownTagStats(d);
  const qualityNote = renderDataQualityNote(unknownStats, 'VOC');
  const rows = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt / totalForPct * 100);
    const cls = pct >= 15 ? 'rising' : pct >= 8 ? 'warn-r' : '';
    const ctx = VOC_CONTEXTS[lbl] || '관련 문의';
    const trendHtml = pct >= 15 ? '<span class="voc-trend up">비율 상위</span>' : pct >= 8 ? '<span class="voc-trend up" style="background:var(--amber-bg);color:var(--amber)">주목</span>' : '<span class="voc-trend flat">일반</span>';
    // 컴플레인 태그: 태그 발생 횟수 기준임을 안내 (KPI 카드는 채팅 단위 기준이라 수치 상이)
    const isComplaintTag = lbl.includes('컴플레인');
    const basisNote = isComplaintTag
      ? `<span style="font-size:9px;color:var(--muted);margin-left:4px" data-tip="태그 발생 횟수 기준 (동일 채팅에 복수 태그 가능)&#10;상단 컴플레인율 KPI는 채팅 단위 기준이므로 수치 다를 수 있음" tabindex="0" style="cursor:help">태그 횟수 기준</span>`
      : '';
    return `
      <div class="voc-item ${cls}">
        <div>
          <div class="voc-keyword">#${lbl} ${trendHtml}${basisNote}</div>
          <div class="voc-context">${ctx}</div>
        </div>
        <div class="voc-count">총 <strong>${cnt}</strong>건</div>
        <div class="voc-pct ${pct >= 15 ? 'pct-high' : pct >= 8 ? 'pct-mid' : 'pct-low'}">${pct}%</div>
      </div>`;
  }).join('');
  el.innerHTML = qualityNote + rows;
}

function renderVocRiskSection(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocRiskCards');
  if (!el || !tags?.labels?.length) { if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px">태그 데이터 없음</div>'; return; }
  const total = summary.totalChats || 1;
  const unknownStats = getUnknownTagStats(d);
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
  const legendHtml = `<div class="vrc-legend"><span class="vrc-l-item"><span class="vrc-l-dot" style="background:var(--rose)"></span>HIGH ≥15%·컴플레인</span><span class="vrc-l-item"><span class="vrc-l-dot" style="background:var(--amber)"></span>MID ≥8%</span><span class="vrc-l-item"><span class="vrc-l-dot" style="background:var(--teal)"></span>LOW 정상</span></div>`;
  el.innerHTML = renderDataQualityNote(unknownStats, 'VOC 리스크') + legendHtml + items.map((it) => `
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
  if (!co.length) { el.innerHTML = '<div class="adv-empty">동반 이슈 패턴 없음</div>'; return; }
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
      { key: 'service', label: '서비스 품질', icon: '', cls: 'cat-service' },
      { key: 'system', label: '시스템 오류', icon: '', cls: 'cat-system' },
      { key: 'pricing', label: '가격/환불', icon: '', cls: 'cat-pricing' },
      { key: 'churn', label: '탈퇴/해지', icon: '', cls: 'cat-churn' },
      { key: 'other', label: '기타', icon: '', cls: 'cat-other' },
    ];
    const maxCat = Math.max(...items.map(it => cats[it.key] || 0), 1);
    summaryEl.innerHTML = items.map((it) => {
      const cnt = cats[it.key] || 0;
      const pct = Math.round(cnt / total * 100);
      const barW = Math.round(cnt / maxCat * 100);
      return `<div class="complaint-cat-row ${it.cls}">
        <div class="cc-icon">${it.icon}</div>
        <div class="cc-label">${it.label}</div>
        <div class="cc-bar-wrap"><div class="cc-bar" style="width:${barW}%;background:var(--rose-light,#fecaca)"></div></div>
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
      note.innerHTML = `가장 빈번한 컴플레인 유형: <strong>${labelMap[top[0]]}</strong> (${top[1]}건, 전체 컴플레인 중 ${Math.round(top[1] / total * 100)}%) — 우선 대응 권장`;
    } else {
      note.innerHTML = '컴플레인 케이스가 충분하지 않습니다';
    }
  }
}

/* ─── Category Bars ───────────────────────────────────────────────────── */
function renderCategoryBars(d) {
  const { summary } = d;
  const total = summary.totalChats || 1;
  const unknownStats = getUnknownTagStats(d);
  const raw = d.vocCategories || {};
  const cats = [
    { key: 'complaint', label: '컴플레인', color: '#be123c', count: Number(raw.complaint || 0), desc: '컴플레인 태그 포함' },
    { key: 'subscribe', label: '구독 관련', color: '#0f766e', count: Number(raw.subscribe || 0), desc: '구독·정기구독 태그' },
    { key: 'inquiry', label: '이용 문의', color: '#1d4ed8', count: Number(raw.inquiry || 0), desc: '이용·안내 태그' },
    { key: 'unknown', label: '미분류', color: '#64748b', count: Number(raw.unknown || 0), desc: '유효 분류 태그 없음' },
    { key: 'other', label: '기타/운영', color: '#6d28d9', count: Number(raw.other || 0), desc: '그 외 유효 태그' },
  ].filter((cat) => cat.count > 0).sort((a, b) => b.count - a.count);
  const hasServerCategories = Object.keys(raw).length > 0;
  const categoryTotal = cats.reduce((sum, cat) => sum + cat.count, 0);
  const el = document.getElementById('categoryBars');
  if (!el) return;

  if (!hasServerCategories) {
    el.innerHTML = `<div class="analysis-hold-card">
      <div class="hold-label">카테고리 집계 보류</div>
      <div class="hold-title">채팅 단위 분류 데이터 없음</div>
      <div class="hold-foot">태그 발생 횟수를 채팅 수처럼 표시하지 않기 위해 구형 응답의 카테고리 추정치는 숨깁니다.</div>
    </div>`;
    return;
  }

  const maxCount = Math.max(...cats.map((cat) => cat.count), 1);
  el.innerHTML = renderDataQualityNote(unknownStats, '카테고리') + cats.map((cat) => `
    <div class="cat-parent-row">
      <div class="cat-parent-label">${cat.label}</div>
      <div class="cat-parent-bar-wrap"><div class="cat-parent-bar" style="width:${Math.max(cat.count / maxCount * 100, 3)}%;background:${cat.color}"></div></div>
      <div class="cat-parent-count">${cat.count}건<span class="cat-parent-pct"> ${Math.round(cat.count / total * 100)}%</span></div>
      <span class="sr-only">${cat.desc}</span>
    </div>`).join('') + `
    <div class="cat-hierarchy-note">ⓘ 채팅 1건을 하나의 카테고리에만 배정한 배타 집계입니다. 합계 ${categoryTotal}건 / 분석 대상 ${summary.totalChats || 0}건.
    분류 우선순위: 컴플레인 → 구독 → 이용 → 미분류 → 기타. VOC 미분류율은 미분류 태그가 하나라도 붙은 채팅 기준이라 카테고리의 ‘미분류’와 다를 수 있습니다.</div>`;
}

/* ─── Category Toggle ──────────────────────────────────────────────────── */
function toggleCatChildren(id) {
  const wrap = document.getElementById(id);
  const chev = document.getElementById(id + '-chev');
  const row  = wrap ? wrap.previousElementSibling : null;
  if (!wrap) return;
  const isOpen = wrap.style.display !== 'none';
  wrap.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.textContent = isOpen ? ' ›' : ' ∨';
  if (row) row.setAttribute('aria-expanded', String(!isOpen));
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
  const chCanvasEl = document.getElementById('channelChart');
  charts.ch = new Chart(chCanvasEl.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderRadius: 4, barThickness: 22 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c1917', padding: 9, callbacks: { label: (ctx) => `${ctx.parsed.x}건 (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` } } },
      scales: { x: { ticks: { callback: (v) => v + '건', font: { size: 11 } }, grid: { color: '#f1efe8' }, beginAtZero: true }, y: { grid: { display: false } } }
    }
  });
  if (chCanvasEl) {
    const chLabels = labels.map((l, i) => `${l}: ${values[i]}건 (${((values[i]/total)*100).toFixed(1)}%)`).join(', ');
    chCanvasEl.setAttribute('aria-label', `채널별 분포 차트 — ${chLabels}`);
  }
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
  const rStats = d.resolutionStats || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const sampleStats = getResolutionSampleStats(d);
  const quick = (rb['0~5분'] || 0) + (rb['5~30분'] || 0);
  const quickPct = Math.round(quick / resTotal * 100);
  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  const resSummary = document.getElementById('resSummary');
  if (resSummary) {
    resSummary.innerHTML = `
      <div class="res-big ${quickPct >= 50 ? 'good' : quickPct >= 30 ? 'warn' : 'bad'}"><div class="res-big-val">${quickPct}%</div><div class="res-big-lbl">30분 내 해결률</div></div>
      <div class="res-big ${slowPct <= 20 ? 'good' : slowPct <= 40 ? 'warn' : 'bad'}"><div class="res-big-val">${slowPct}%</div><div class="res-big-lbl">8시간+ 장기</div></div>
      <div class="res-big"><div class="res-big-val" style="font-size:18px">${fmtMin(d.summary.avgResolutionMin)}</div><div class="res-big-lbl">평균 해결<br><span style="font-size:9px;color:var(--muted);font-weight:400">고객 미응답 포함</span></div></div>`;
  }
  const buckets = [
    { label: '0~5분', val: rb['0~5분'] || 0, cls: 'ok', note: '즉시' },
    { label: '5~30분', val: rb['5~30분'] || 0, cls: 'ok', note: '신속' },
    { label: '30분~2시간', val: rb['30분~2시간'] || 0, cls: 'warn', note: '일반' },
    { label: '2~8시간', val: rb['2~8시간'] || 0, cls: 'warn', note: '지연' },
    { label: '8시간+', val: rb['8시간+'] || 0, cls: 'bad', note: '8시간 이상' },
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
  if (note) {
    note.innerHTML = d.summary.avgResolutionMin != null
      ? `전체 평균 <strong>${fmtMin(d.summary.avgResolutionMin)}</strong> · 고객 미응답 포함 · <span class="sample-badge sample-${sampleStats.cls}">n=${sampleStats.n} ${sampleStats.label}</span> <span class="sample-badge sample-warn">순처리시간 미수집</span> <span data-tip="${rStats.agentHandleTimeNote || '현재 해결시간은 closed 채팅의 created~closed 기준입니다. 고객 미응답·야간 대기 시간이 포함되어 실제 상담원 순처리시간보다 길게 보일 수 있습니다. 상담원 처리시간은 별도 이벤트/메시지 기준 산출이 필요합니다.'}" tabindex="0" style="cursor:help;color:var(--muted)">ⓘ</span>`
      : '데이터 없음';
  }

  // P2.12 자동 해석 — 해결시간 분포
  const resInterpEl = document.getElementById('resInterpNote');
  if (resInterpEl) {
    const quickMsg = quickPct >= 60
      ? `30분 내 해결 <strong>${quickPct}%</strong> — 신속 처리 우수`
      : quickPct >= 40
      ? `30분 내 해결 <strong>${quickPct}%</strong> — 개선 여지 있음`
      : `30분 내 해결 <strong style="color:var(--rose)">${quickPct}%</strong> — 해결 속도 개선 필요`;
    const slowMsg = slowPct > 30
      ? ` · 8시간+ <strong style="color:var(--rose)">${slowPct}%</strong> 비중 과다`
      : slowPct > 10
      ? ` · 8시간+ <strong style="color:var(--amber)">${slowPct}%</strong> 모니터링`
      : '';
    const sampleMsg = sampleStats.n < 80
      ? ` · <span class="sample-badge sample-${sampleStats.cls}">n=${sampleStats.n} ${sampleStats.label}</span>`
      : '';
    resInterpEl.innerHTML = `<div class="auto-interp"><span class="ai-text">${quickMsg}${slowMsg}${sampleMsg}</span></div>`;
  }
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
  const longChats = [...(d.longChats || [])].sort((a, b) => (b.resolutionMin || 0) - (a.resolutionMin || 0));
  const mgrMap = {};
  (d.managers || []).forEach((m) => { mgrMap[m.id] = m.name; });
  const top5Html = longChats.slice(0, 5).map((c) => {
    const hrs = Math.floor((c.resolutionMin || 0) / 60);
    const days = Math.floor(hrs / 24);
    const timeStr = days >= 1 ? `${days}일 ${hrs % 24}시간` : `${hrs}시간`;
    const rawMgr4 = c.assigneeId ? (mgrMap[c.assigneeId] || c.assigneeId) : null;
    const mgrName = rawMgr4 ? dispMgrName(rawMgr4) : '미배정';
    const timeColor = (c.resolutionMin || 0) >= 2880 ? 'var(--rose)' : 'var(--amber)';
    const safeTags4 = Array.isArray(c.tags) ? c.tags : [];
    const tagsStr = safeTags4.slice(0, 2).map((t) => `#${t}`).join(' ') || '태그없음';
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
    ${top5Html ? `<div class="long-delay-list-header">주요 케이스 TOP 5</div><div class="long-delay-list">${top5Html}</div>` : ''}
    <button class="ld-more-link" type="button" data-action="open-long-chats" onclick="openLongChatsPanel()">▸ 전체 목록 (${slow8h}건) 보기</button>`;
}

function openLongChatsPanel(keepFilter) {
  closeComplaintPanel(); // 다른 모달이 열려 있으면 먼저 닫음
  const modal = document.getElementById('longChatsModal');
  if (!modal) return;
  // 필터 데이터에 longChats가 없거나 비어 있으면 원본 데이터로 폴백
  const src = (lastFilteredData && lastFilteredData.longChats && lastFilteredData.longChats.length)
    ? lastFilteredData
    : lastData;
  const rawList = (src && src.longChats) ? src.longChats : [];
  // 해결시간 기준 내림차순 정렬
  const longChatsList = [...rawList].sort((a, b) => (b.resolutionMin || 0) - (a.resolutionMin || 0));
  const mgrMap = {};
  ((src && src.managers) || []).forEach((m) => { mgrMap[m.id] = m.name; });

  // 모달 제목에 필터 적용 여부 표시
  const titleEl = modal.querySelector('.modal-header span');
  if (titleEl) {
    const filterNote = activeFilterCount() > 0 ? ` (필터 적용 중 · ${longChatsList.length}건)` : ` (${longChatsList.length}건)`;
    titleEl.textContent = `장기지연 상담${filterNote}`;
  }

  // 모달 열 때 퀵 필터 초기화 (keepFilter=true 시 유지)
  if (!keepFilter) lcModalFilter = { mgr: null, tag: null, src: null };

  const isMobile = window.innerWidth <= 430;
  const srcMap = { native: '앱/웹', phone: '전화', other: '기타' };
  const statusMap = { closed: '종결', opened: '열림', 'bot-resolved': '봇처리' };

  // 퀵 필터에서 사용할 고유값 수집
  const uniqueMgrs = [...new Set(longChatsList.map(c => c.assigneeId).filter(Boolean))].slice(0, 6);
  const uniqueTags = [...new Set(longChatsList.flatMap(c => Array.isArray(c.tags) ? c.tags : []))].slice(0, 6);
  const uniqueSrcs = [...new Set(longChatsList.map(c => c.source).filter(Boolean))];

  // 퀵 필터 칩 HTML 생성 헬퍼
  function lcChip(kind, val, label, isActive) {
    return `<button class="lc-qf-chip${isActive ? ' active' : ''}" data-lckind="${kind}" data-lcval="${val}" type="button" aria-pressed="${isActive ? 'true' : 'false'}">${label}</button>`;
  }
  const mgrChips = uniqueMgrs.map(id => lcChip('mgr', id, dispMgrName(mgrMap[id] || id), lcModalFilter.mgr === id)).join('');
  const tagChips = uniqueTags.map(t => lcChip('tag', t, '#' + t, lcModalFilter.tag === t)).join('');
  const srcChips = uniqueSrcs.map(s => lcChip('src', s, srcMap[s] || s, lcModalFilter.src === s)).join('');
  const hasQfOptions = mgrChips || tagChips || srcChips;

  // 용어 정의 안내 (미배정·미해결·장기지연 혼동 방지)
  const termNote = `<div style="font-size:10.5px;color:var(--muted);background:var(--bg2);border-radius:6px;padding:6px 10px;margin-bottom:8px;line-height:1.6">
    <strong>용어 안내</strong> · <span style="color:var(--rose)">장기지연</span>: 종결(closed) 채팅 중 해결시간 8시간 이상 건 &nbsp;·&nbsp; <span style="color:var(--amber)">미해결</span>: 현재 진행 중(open) 채팅 &nbsp;·&nbsp; <span style="color:var(--text)">담당자 없음</span>: 해당 채팅 종결 시 배정 기록 없음 (KPI 미배정과 다름)
  </div>`;
  const sortLabel = `<div class="lc-sort-label">가장 오래 지연된 상담부터 확인하세요</div>`;
  const filterBar = hasQfOptions ? `
    <div class="lc-qf-bar" id="lcQuickFilters">
      ${mgrChips ? `<div class="lc-qf-group"><span class="lc-qf-label">담당자</span>${mgrChips}</div>` : ''}
      ${tagChips ? `<div class="lc-qf-group"><span class="lc-qf-label">태그</span>${tagChips}</div>` : ''}
      ${srcChips ? `<div class="lc-qf-group"><span class="lc-qf-label">채널</span>${srcChips}</div>` : ''}
    </div>` : '';

  // 현재 퀵 필터 조건에 맞게 목록 필터링
  const filteredList = longChatsList.filter(c => {
    if (lcModalFilter.mgr && c.assigneeId !== lcModalFilter.mgr) return false;
    if (lcModalFilter.tag && !(Array.isArray(c.tags) ? c.tags : []).includes(lcModalFilter.tag)) return false;
    if (lcModalFilter.src && c.source !== lcModalFilter.src) return false;
    return true;
  });

  if (isMobile) {
    // ─── 모바일: 카드 레이아웃 ─────────────────────────────────────────
    const cards = filteredList.length === 0
      ? '<p style="text-align:center;padding:20px;color:var(--muted)">데이터 없음</p>'
      : filteredList.map((c) => {
        const safeTags = Array.isArray(c.tags) ? c.tags : [];
        const mgrName = c.assigneeId ? dispMgrName(mgrMap[c.assigneeId] || c.assigneeId) : '<span style="color:var(--muted);font-style:italic" title="종결 시 담당자 미배정">담당자 없음</span>';
        const totalMins = c.resolutionMin || 0;
        const totalHrs = Math.floor(totalMins / 60);
        const daysCnt = Math.floor(totalHrs / 24);
        const remHrs = totalHrs % 24;
        const humanTime = daysCnt >= 1 ? `${daysCnt}일 ${remHrs}시간` : `${totalHrs}시간 ${totalMins % 60}분`;
        const timeColor = totalMins > 2880 ? 'var(--rose)' : totalMins > 480 ? 'var(--amber)' : 'var(--text)';
        const url = chatTalkUrl(c.id);
        const channelTxt = srcMap[c.source] || c.source || '—';
        const statusTxt = statusMap[c.status] || c.status || '—';
        const statusColor = c.status === 'closed' ? 'var(--teal-d)' : 'var(--amber)';
        const tagsHtml = safeTags.length
          ? safeTags.slice(0,3).map((t) => `<span class="long-tag">#${t}</span>`).join(' ')
          : '<span style="color:var(--muted);font-size:10px">태그 없음</span>';
        const linkHtml = url
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="lc-card-link">채팅 보기 ↗</a>`
          : '';
        return `<div class="lc-mobile-card">
          <div class="lc-card-top">
            <div>
              <div class="lc-card-time" style="color:${timeColor}">${totalMins}분</div>
              <div class="lc-card-time-sub">${humanTime} · ${c.date || '—'}</div>
            </div>
            ${linkHtml}
          </div>
          <div class="lc-card-meta">
            <span class="lc-card-meta-item"><span class="lc-card-meta-label">담당자</span> ${mgrName}</span>
            <span class="lc-card-meta-item"><span class="lc-card-meta-label">채널</span> ${channelTxt}</span>
            <span class="lc-card-meta-item"><span class="lc-card-meta-label" style="color:${statusColor}">${statusTxt}</span></span>
          </div>
          <div class="lc-card-tags">${tagsHtml}</div>
        </div>`;
      }).join('');
    document.getElementById('longChatsBody').innerHTML = termNote + sortLabel + filterBar + cards;
  } else {
    // ─── 데스크톱: 테이블 레이아웃 ─────────────────────────────────────
    const rows = filteredList.map((c) => {
      const safeTags = Array.isArray(c.tags) ? c.tags : [];
      const tagsHtml = safeTags.length ? safeTags.slice(0,3).map((t) => `<span class="long-tag">#${t}</span>`).join(' ') : '<span style="color:var(--muted)">태그 없음</span>';
      const mgrName = c.assigneeId ? dispMgrName(mgrMap[c.assigneeId] || c.assigneeId) : '<span style="color:var(--muted);font-style:italic" title="종결 시 담당자 미배정">담당자 없음</span>';
      const totalMins = c.resolutionMin || 0;
      const totalHrs = Math.floor(totalMins / 60);
      const daysCnt = Math.floor(totalHrs / 24);
      const remHrs = totalHrs % 24;
      const humanTime = daysCnt >= 1 ? `${daysCnt}일 ${remHrs}시간` : `${totalHrs}시간 ${totalMins % 60}분`;
      const timeColor = totalMins > 2880 ? 'var(--rose)' : totalMins > 480 ? 'var(--amber)' : 'var(--text)';
      const url = chatTalkUrl(c.id);
      const dateCell = url ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="cs-deeplink">${c.date || '—'} ↗</a>` : (c.date || '—');
      const channelTxt = srcMap[c.source] || c.source || '—';
      const statusTxt = statusMap[c.status] || c.status || '—';
      const statusStyle = c.status === 'closed' ? 'color:var(--teal-d)' : 'color:var(--amber)';
      const linkCell = url ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="cs-deeplink" style="font-size:10.5px">채팅 보기 ↗</a>` : '—';
      return `<tr style="border-bottom:1px solid var(--border-soft)">
        <td style="padding:7px 8px;white-space:nowrap">${dateCell}</td>
        <td style="padding:7px 8px;color:${timeColor};font-weight:700;white-space:nowrap">${totalMins}분 <span style="color:var(--muted);font-size:10px;font-weight:400">(${humanTime})</span></td>
        <td style="padding:7px 8px">${mgrName}</td>
        <td style="padding:7px 8px">${tagsHtml}</td>
        <td style="padding:7px 8px;font-size:10.5px">${channelTxt}</td>
        <td style="padding:7px 8px;font-size:10.5px;${statusStyle}">${statusTxt}</td>
        <td style="padding:7px 8px">${linkCell}</td>
      </tr>`;
    }).join('');
    const tbody = rows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">데이터 없음</td></tr>';
    document.getElementById('longChatsBody').innerHTML = termNote + sortLabel + filterBar + `
      <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;min-width:640px">
        <thead><tr style="border-bottom:2px solid var(--border-soft);background:var(--bg2)">
          <th style="text-align:left;padding:8px;font-size:11px;color:var(--muted);font-weight:700">일자</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:var(--muted);font-weight:700">해결시간</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:var(--muted);font-weight:700">담당자</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:var(--muted);font-weight:700">태그</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:var(--muted);font-weight:700">채널</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:var(--muted);font-weight:700">상태</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:var(--muted);font-weight:700">바로가기</th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
      </div>`;
  }
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');

  // 퀵 필터 칩 클릭 핸들러 — 클릭 시 필터 상태 토글 후 모달 재렌더
  const qfBar = document.getElementById('lcQuickFilters');
  if (qfBar) {
    qfBar.querySelectorAll('.lc-qf-chip').forEach((chip) => {
      chip.onclick = () => {
        const kind = chip.dataset.lckind;
        const val  = chip.dataset.lcval;
        // 같은 값 클릭 시 해제 (토글), 다른 값 클릭 시 교체
        if (lcModalFilter[kind] === val) {
          lcModalFilter[kind] = null;
        } else {
          lcModalFilter[kind] = val;
        }
        openLongChatsPanel(true); // keepFilter=true
      };
    });
  }
}

/* ─── Complaint Analysis Panel ─────────────────────────────────────────── */
function openComplaintPanel() {
  closeLongChatsPanel(); // 다른 모달이 열려 있으면 먼저 닫음
  const modal = document.getElementById('complaintModal');
  if (!modal) return;
  const src = lastFilteredData || lastData;
  if (!src) return;
  const total = src.summary?.totalChats || 1;
  const tags  = src.tags || { labels: [], values: [] };
  const ct    = src.complaintTrend || { labels: [], total: [], complaints: [] };

  // 컴플레인 태그 필터링 (유형별 막대 표시용 — 태그 기반)
  const complaintItems = (tags.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) {
      acc.push({ label: lbl, count: tags.values[i] || 0 });
    }
    return acc;
  }, []).sort((a, b) => b.count - a.count);

  // 총 컴플레인 건수/비율: complaintTrend 기반(= computeHealthScore와 동일 기준)
  // → 태그 합산이 아닌 "컴플레인 태그 보유 채팅 수" 기준이므로 KPI 카드 수치와 일치
  let totalComplaints, complaintBase;
  if (ct.complaints && ct.complaints.length > 0) {
    totalComplaints = ct.complaints.reduce((a, b) => a + b, 0);
    complaintBase = ct.total.reduce((a, b) => a + b, 0) || total;
  } else {
    totalComplaints = complaintItems.reduce((s, x) => s + x.count, 0);
    complaintBase = total;
  }
  const complaintPct = Math.round(totalComplaints / complaintBase * 100);
  const maxCount = complaintItems[0]?.count || 1;

  // 트렌드 방향
  const trendArr = ct.complaints || [];
  const lastTwo = trendArr.slice(-2);
  const trendDir = lastTwo.length === 2
    ? (lastTwo[1] > lastTwo[0] ? '↑ 증가' : lastTwo[1] < lastTwo[0] ? '↓ 감소' : '→ 유지')
    : '—';
  const trendCls = trendDir.startsWith('↑') ? 'color:var(--rose)' : trendDir.startsWith('↓') ? 'color:var(--teal-d)' : 'color:var(--muted)';

  // 장기지연 채팅 중 컴플레인 태그 보유 건
  const longChatsList = src.longChats || [];
  const longComplaint = longChatsList.filter(c => (Array.isArray(c.tags) ? c.tags : []).some(t => t.includes('컴플레인')));
  const mgrMap = {};
  ((src.managers) || []).forEach(m => { mgrMap[m.id] = m.name; });

  const tagsHtml = complaintItems.length
    ? complaintItems.map(item => {
        const barW = Math.round(item.count / maxCount * 100);
        const pct  = Math.round(item.count / total * 100);
        return `<div class="cp-tag-row">
          <div class="cp-tag-label">${item.label} 태그</div>
          <div class="cp-tag-bar-wrap"><div class="cp-tag-bar" style="width:${barW}%"></div></div>
          <div class="cp-tag-count">${item.count}건</div>
          <div class="cp-tag-pct">${pct}%</div>
        </div>`;
      }).join('')
    : '<div style="color:var(--muted);text-align:center;padding:16px">컴플레인 태그 데이터 없음</div>';

  const longHtml = longComplaint.length
    ? `<div class="cp-section-title">장기 지연 컴플레인 채팅 (${longComplaint.length}건)</div>
       <div class="cp-long-list">${longComplaint.slice(0, 5).map(c => {
         const mgr = c.assigneeId ? dispMgrName(mgrMap[c.assigneeId] || c.assigneeId) : '<span style="color:var(--muted);font-style:italic">담당자 없음</span>';
         const safeTags = (Array.isArray(c.tags) ? c.tags : []).filter(t => t.includes('컴플레인'));
         const url = chatTalkUrl(c.id);
         return `<div class="cp-long-row">
           <span class="cp-long-date">${c.date || '—'}</span>
           <span class="cp-long-mgr">${mgr}</span>
           <span class="cp-long-tags">${safeTags.map(t => '#'+t).join(' ') || '—'}</span>
           ${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="cs-deeplink" style="font-size:10px">보기 ↗</a>` : ''}
         </div>`;
       }).join('')}
       ${longComplaint.length > 5 ? '<div style="text-align:center;margin-top:8px"><button class="ld-more-link" onclick="openLongChatsPanel()">▸ 전체 장기 지연 목록 보기</button></div>' : ''}
       </div>`
    : '';

  document.getElementById('complaintBody').innerHTML = `
    <div class="cp-summary-row">
      <div class="cp-kpi"><div class="cp-kpi-val" style="color:var(--rose)">${totalComplaints}건</div><div class="cp-kpi-lbl">총 컴플레인</div></div>
      <div class="cp-kpi"><div class="cp-kpi-val" style="color:${complaintPct >= 15 ? 'var(--rose)' : 'var(--amber)'}">${complaintPct}%</div><div class="cp-kpi-lbl">전체 대비</div></div>
      <div class="cp-kpi"><div class="cp-kpi-val" style="${trendCls}">${trendDir}</div><div class="cp-kpi-lbl">최근 추이</div></div>
      <div class="cp-kpi"><div class="cp-kpi-val" style="color:var(--amber)">${longComplaint.length}건</div><div class="cp-kpi-lbl">장기지연 포함</div></div>
    </div>
    <div class="cp-section-title">컴플레인 유형별 분석</div>
    <div class="cp-tag-rows">${tagsHtml}</div>
    ${longHtml}
    <div style="margin-top:16px;text-align:center">
      <button class="ld-more-link" onclick="closeComplaintPanel(); setTimeout(() => _gotoTab('voc-complaint'), 100)">▸ VOC 트렌드 탭에서 상세 분석 보기</button>
    </div>`;

  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}
function closeComplaintPanel() {
  const m = document.getElementById('complaintModal');
  if (m) { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); }
}

function closeLongChatsPanel() {
  const m = document.getElementById('longChatsModal');
  if (m) { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); }
}

/* ─── Concentration / Manager Risk Strip ────────────────────────────── */
function renderConcRisk(d) {
  const el = document.getElementById('concRiskPanel');
  if (!el) return;
  const managers = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name));
  const mgrConc = getManagerConcentration(d);
  const unassigned = d.summary?.unassignedChats || 0;
  const activeMgrs = managers.filter((m) => m.count > 0);
  const topMgr = mgrConc.topMgr;
  const topPct = mgrConc.assignedPct;
  const topName = topMgr ? dispMgrName(topMgr.name) : '—';
  const uaCls = unassigned > 0 ? 'crr-danger' : 'crr-ok';
  const concCls = topPct > 70 ? 'crr-danger' : topPct > 50 ? 'crr-warn' : 'crr-ok';
  const concInterpEl = document.getElementById('concRiskInterp');
  if (concInterpEl) {
    const staffingContext = activeMgrs.length <= 2
      ? `활성 담당자 ${activeMgrs.length}명 구조라 과부하 단정보다 백업/분산 기준 점검이 우선입니다.`
      : '신규 문의 분산 배정 기준 점검 권장';
    const concMsg = topPct > 80
      ? `<strong>${topName}</strong> 배정 처리 집중도 <strong style="color:var(--rose)">${topPct}%</strong> — ${staffingContext}`
      : topPct > 60
      ? `<strong>${topName}</strong> 배정 처리 집중도 <strong style="color:var(--amber)">${topPct}%</strong> — ${staffingContext}`
      : `담당자 간 처리 분산 양호 (최다 <strong>${topName}</strong> ${topPct}%, 배정 기준)`;
    const uaMsg = unassigned > 0 ? ` · 미배정 <strong style="color:var(--rose)">${unassigned}건</strong> 즉시 배정 필요` : '';
    concInterpEl.innerHTML = `<div class="auto-interp"><span class="ai-text">${concMsg}${uaMsg}</span></div>`;
  }
  el.innerHTML = `
    <div class="conc-risk-row ${uaCls}">
      <div class="crr-left"><div class="crr-label">미배정 채팅</div><div class="crr-sub">즉시 담당자 배정 필요</div></div>
      <div class="crr-right">
        <div class="crr-value ${unassigned > 0 ? 'val-danger' : 'val-ok'}">${unassigned}건</div>
        <div class="crr-action-tag ${unassigned > 0 ? 'action-urgent' : 'action-ok'}">${unassigned > 0 ? '즉시' : '정상'}</div>
      </div>
    </div>
    <div class="conc-risk-row ${concCls}">
      <div class="crr-left">
        <div class="crr-label">업무 집중도 <span data-tip="분모: 배정 담당자 처리 합계 ${mgrConc.assignedTotal}건&#10;계산: ${topMgr ? topMgr.count : 0}건 ÷ ${mgrConc.assignedTotal}건 × 100&#10;전체 closed 기준 보조값: ${mgrConc.totalPct}%" tabindex="0" style="cursor:help;font-size:9px;color:var(--muted)">분모ⓘ</span></div>
        <div class="crr-sub">${topName} · 배정 기준 대표값 · 전체 기준 ${mgrConc.totalPct}% 보조</div>
      </div>
      <div class="crr-right"><div class="crr-value ${topPct > 70 ? 'val-danger' : topPct > 50 ? 'val-warn' : 'val-ok'}">${topPct}%</div><div class="crr-action-tag ${topPct > 70 ? 'action-urgent' : topPct > 50 ? 'action-check' : 'action-ok'}">${topPct > 70 ? '분산' : topPct > 50 ? '모니터링' : '정상'}</div></div>
    </div>
    <div class="conc-risk-row ${activeMgrs.length < 2 ? 'crr-warn' : 'crr-ok'}">
      <div class="crr-left"><div class="crr-label">활성 담당자</div><div class="crr-sub">처리건수 1건 이상</div></div>
      <div class="crr-right"><div class="crr-value">${activeMgrs.length}명</div><div class="crr-action-tag ${activeMgrs.length < 2 ? 'action-check' : 'action-ok'}">${activeMgrs.length < 2 ? '백업' : '정상'}</div></div>
    </div>
    ${topPct >= 75 ? `<div class="conc-redistrib-tip">
      <span class="crt-icon"></span>
      <div class="crt-body">
        <div class="crt-title">${topName} 배정 처리 비중 ${topPct}% — 백업/분산 기준 검토</div>
        <div class="crt-sub">활성 담당자 ${activeMgrs.length}명 · ${activeMgrs.length <= 2 ? '인력 구조 영향 가능성이 큽니다. 신규 문의 라우팅과 휴무/피크 백업 룰을 먼저 점검하세요.' : `${activeMgrs.slice(1, 3).map(m => dispMgrName(m.name)).join('·') || '다른 담당자'}에게 신규 채팅 우선 배정하세요.`}</div>
      </div>
    </div>` : ''}`;
}

function renderMgrRiskStrip(d) {
  const el = document.getElementById('mgrRiskStrip');
  if (!el) return;
  const mgrConc = getManagerConcentration(d);
  const unassigned = d.summary?.unassignedChats || 0;
  const topMgr = mgrConc.topMgr;
  const topPct = mgrConc.assignedPct;
  const topName = topMgr ? dispMgrName(topMgr.name) : '—';
  const activeManagerCount = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0).length;
  const concStatus = topPct > 80
    ? { cls: activeManagerCount <= 2 ? 'warn' : 'danger', label: activeManagerCount <= 2 ? '구조 점검' : '과부하' }
    : topPct > 60 ? { cls: 'warn', label: '주의' } : { cls: 'good', label: '양호' };
  const unaStatus = unassigned > 0 ? { cls: 'danger', label: '즉시 배정' } : { cls: 'good', label: '없음' };
  el.innerHTML = `
    <div class="mgr-risk-card mrc-${concStatus.cls}"><div class="mrc-icon"><span style="color:${topPct > 80 ? 'var(--rose)' : topPct > 60 ? 'var(--amber)' : 'var(--green)'}">●</span></div><div class="mrc-body"><div class="mrc-label">담당자 편중률 (배정 기준)</div><div class="mrc-value">${topName}${topMgr ? ' · ' + topMgr.count + '건' : ''} · ${topPct}% <span style="color:var(--muted);font-size:10px">전체 ${mgrConc.totalPct}%</span></div><div class="mrc-status ${concStatus.cls}">${concStatus.label}</div></div></div>
    <div class="mgr-risk-card mrc-${unaStatus.cls}"><div class="mrc-icon"><span style="color:${unassigned > 0 ? 'var(--rose)' : 'var(--green)'}">●</span></div><div class="mrc-body"><div class="mrc-label">미배정 채팅</div><div class="mrc-value">${unassigned}건</div><div class="mrc-status ${unaStatus.cls}">${unaStatus.label}</div></div></div>`;
}

/* ─── Manager Table — FRT 컬럼 추가 ─────────────────────────────────── */
function agentComment(m, rank) {
  if (!m.count) return '<span class="agent-comment off">비활성</span>';
  if (m.avgResolutionMin != null && m.avgResolutionMin > 600)
    return '<span class="agent-comment warn" data-tip="평균 해결시간 ' + fmtMin(m.avgResolutionMin) + ' — 10시간 초과">해결 지연</span>';
  const cRatio = m.count > 0 ? (m.complaintHandled || 0) / m.count : 0;
  if (cRatio > 0.20)
    return '<span class="agent-comment warn" data-tip="처리 건 중 컴플레인 ' + Math.round(cRatio*100) + '%">컴플레인 多</span>';
  if (m.medianFrtMin != null && m.medianFrtMin > 60)
    return '<span class="agent-comment warn" data-tip="첫 응답 중앙값 ' + m.medianFrtMin + '분 초과">FRT 지연</span>';
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

  const activeMgrs = managers.filter(m => m.count > 0);
  const inactiveMgrs = managers.filter(m => !m.count);

  function buildMgrRows(list, rankOffset) {
    return list.map((m, idx) => {
      const i = rankOffset + idx;
      const isActive = m.count > 0;
      const rank = isActive ? rankOffset + idx : -1;
      const opColor = m.operatorScore > 30 ? 'var(--teal)' : m.operatorScore > 10 ? '#b45309' : 'var(--muted)';
      const tcColor = m.touchScore > 50 ? 'var(--teal)' : m.touchScore > 20 ? '#b45309' : 'var(--muted)';
      const rankClass = rank === 0 ? 'r1' : rank === 1 ? 'r2' : rank === 2 ? 'r3' : 'rn';
      const frtDisplay = isActive && m.medianFrtMin != null ? fmtMin(m.medianFrtMin) : '—';
      const resDisplay = isActive && m.avgResolutionMin != null ? fmtMin(m.avgResolutionMin) : '—';
      const comment = agentComment(m, rank);
      return `<tr style="${!isActive ? 'opacity:.45' : ''}">
        <td style="text-align:center"><span class="agent-rank ${rankClass}">${isActive ? rank + 1 : '—'}</span></td>
        <td><div class="agent-name-cell"><div class="agent-avatar" style="${avatarStyle(i)}">${initials(m.name)}</div><span class="agent-name">${dispMgrName(m.name)}</span></div></td>
      <td class="num-r"><span style="font-weight:800">${isActive ? m.count + '건' : '—'}</span></td>
      <td class="num-r" style="font-size:11px;color:${m.medianFrtMin != null && m.medianFrtMin <= 5 ? 'var(--teal)' : m.medianFrtMin != null && m.medianFrtMin > 30 ? 'var(--amber)' : 'var(--text)'}">${frtDisplay}</td>
      <td class="num-r" style="font-size:11px">${resDisplay}</td>
      <td class="num-r"><div class="score-cell-fixed"><div class="score-bar-fixed"><div class="score-fill" style="width:${Math.min(m.operatorScore, 100)}%;background:${opColor}"></div></div><span class="score-num" style="color:${opColor}">${m.operatorScore}</span></div></td>
      <td>${agentComment(m, rank)}</td>
    </tr>`;
    }).join('');
  }

  // 활성 담당자만 우선 표시
  tbody.innerHTML = buildMgrRows(activeMgrs, 0);

  // 비활성 담당자 토글
  if (inactiveMgrs.length > 0) {
    const toggleTr = document.createElement('tr');
    toggleTr.innerHTML = `<td colspan="8" style="text-align:center;padding:5px 0;border-top:1px solid var(--border)">
      <button id="inactiveToggleBtn" type="button" aria-expanded="false" aria-controls="inactiveRowsGroup" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 14px;font-size:11px;color:var(--muted);cursor:pointer">
        ▾ 비활성 담당자 ${inactiveMgrs.length}명 보기
      </button></td>`;
    tbody.appendChild(toggleTr);
    const inactiveTbody = document.createElement('tbody');
    inactiveTbody.id = 'inactiveRowsGroup';
    inactiveTbody.style.display = 'none';
    inactiveTbody.innerHTML = buildMgrRows(inactiveMgrs, activeMgrs.length);
    tbody.parentElement.appendChild(inactiveTbody);
    document.getElementById('inactiveToggleBtn')?.addEventListener('click', function() {
      const hidden = inactiveTbody.style.display === 'none';
      inactiveTbody.style.display = hidden ? '' : 'none';
      this.textContent = hidden
        ? `▴ 비활성 담당자 ${inactiveMgrs.length}명 숨기기`
        : `▾ 비활성 담당자 ${inactiveMgrs.length}명 보기`;
      this.setAttribute('aria-expanded', String(hidden));
    });
  }

  // 사이드바
  const sidebar = document.getElementById('agentSidebar');
  if (sidebar) {
    const activeMgrsForSidebar = managers.filter((m) => m.count > 0);
    const avgOp = activeMgrsForSidebar.length ? Math.round(activeMgrsForSidebar.reduce((s, m) => s + (m.operatorScore || 0), 0) / activeMgrsForSidebar.length) : 0;
    const fastMgr = activeMgrsForSidebar.filter((m) => m.medianFrtMin != null).sort((a, b) => a.medianFrtMin - b.medianFrtMin)[0];
    sidebar.innerHTML = `
      <div class="agent-stat-card">
        <div class="agent-stat-card-title">인원</div>
        <div class="agent-stat-row"><span class="agent-stat-label">활성</span><span class="agent-stat-value" style="color:var(--teal)">${activeMgrsForSidebar.length}명</span></div>
        <div class="agent-stat-row"><span class="agent-stat-label">총 처리</span><span class="agent-stat-value">${total.toLocaleString()}건</span></div>
      </div>
      <div class="agent-stat-card">
        <div class="agent-stat-card-title">평균</div>
        <div class="agent-stat-row"><span class="agent-stat-label">운영 점수</span><span class="agent-stat-value">${avgOp}</span></div>
        ${fastMgr ? `<div class="agent-stat-row"><span class="agent-stat-label">최단 FRT</span><span class="agent-stat-value" style="font-size:10.5px;color:var(--teal)">${dispMgrName(fastMgr.name)} ${fmtMin(fastMgr.medianFrtMin)}</span></div>` : ''}
      </div>`;
  }

  const note = document.getElementById('agentTblNote');
  if (note) note.textContent = '※ FRT (P50): 첫 응답까지 걸린 시간의 중앙값 / 평균해결: 처리 건 실측값, 고객 미응답 시간 포함 / 운영점수: 처리량·FRT·해결시간·컴플레인을 반영한 내부 운영 점수';
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
        <td><div class="mgr-frt-name"><div class="agent-avatar" style="${avatarStyle(i)};width:24px;height:24px;font-size:10px">${initials(m.name)}</div>${dispMgrName(m.name)}</div></td>
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
  const under5Count = rb['0~5분'] || 0;
  const under5Pct = Math.round((under5Count / resTotal) * 100);
  const min5to30Count = rb['5~30분'] || 0;
  const min5to30Pct = Math.round((min5to30Count / resTotal) * 100);
  const totalChats = summary.totalChats || 1;
  const top5Tags = (tags?.labels || []).slice(0, 5).map((lbl, i) => ({
    label: lbl, count: tags.values[i] || 0, pct: Math.round(((tags.values[i] || 0) / totalChats) * 100),
  }));
  const botNames = (bots || []).map((b) => b.name);
  const botPanel = document.getElementById('botPanel');
  if (botPanel) {
    botPanel.innerHTML = `
      <div class="panel-header"><div><div class="panel-title">해결 속도 참고</div><div class="panel-sub">자동화 기여도와 구분된 종결 속도</div></div><span class="data-badge badge-calc">계산값</span></div>
      <div class="auto-kpi-row">
        <div class="auto-kpi-card"><div class="auto-kpi-label">5분 내 해결</div><div class="auto-kpi-val">${under5Pct}<span class="auto-kpi-unit">%</span></div><div class="auto-kpi-sub">${under5Count.toLocaleString()}건 · 자동화 여부 미구분</div><div class="auto-kpi-bar"><div class="auto-kpi-fill" style="width:${Math.min(under5Pct,100)}%"></div></div></div>
        <div class="auto-kpi-card"><div class="auto-kpi-label">5~30분 해결</div><div class="auto-kpi-val">${min5to30Pct}<span class="auto-kpi-unit">%</span></div><div class="auto-kpi-sub">${min5to30Count.toLocaleString()}건 · 자동화 여부 미구분</div><div class="auto-kpi-bar"><div class="auto-kpi-fill" style="width:${Math.min(min5to30Pct,100)}%"></div></div></div>
      </div>
      <div class="auto-faq-title">TOP 5 문의 유형</div>
      <div class="auto-faq-list">${top5Tags.map((t, i) => `<div class="auto-faq-row"><span class="auto-faq-rank rank-${i+1}">${i+1}</span><span class="auto-faq-label">${t.label}</span><span class="auto-faq-count">${t.count}회</span><span class="auto-faq-pct">${t.pct}%</span></div>`).join('')}</div>
      ${botNames.length ? `<div class="bot-names" style="margin-top:10px"><span class="bot-name-tag">연결 봇</span>${botNames.map((n) => `<span class="bot-name-tag">${n}</span>`).join('')}</div>` : ''}`;
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
        <div class="ops-stat-cell"><div class="ops-stat-val" style="color:var(--amber)">${fmtMin(avgRes)}</div><div class="ops-stat-lbl">평균 해결</div></div>
      </div>
      <div class="ops-section-title">유입 채널</div>
      <div class="ops-channel-list">
        <div class="ops-channel-row"><span class="ops-ch-name">인앱</span><div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${Math.round(srcN/srcTotal*100)}%;background:var(--teal)"></div></div><span class="ops-ch-val">${srcN}</span><span class="ops-ch-pct">${Math.round(srcN/srcTotal*100)}%</span></div>
        <div class="ops-channel-row"><span class="ops-ch-name">전화</span><div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${Math.round(srcP/srcTotal*100)}%;background:var(--blue)"></div></div><span class="ops-ch-val">${srcP}</span><span class="ops-ch-pct">${Math.round(srcP/srcTotal*100)}%</span></div>
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
  document.getElementById('gsub-quick').setAttribute('data-tip', `분모: 해결시간 집계 가능한 closed 상담 ${total}건 기준&#10;(봇 자동처리·미응답·해결시간 미집계 건 제외)&#10;※ 전체 closed ${d.summary?.totalChats || ''}건과 다를 수 있음`);
  setB('quick', quickPct >= 70 ? '양호' : quickPct >= 50 ? '주의' : '위험', quickPct >= 70 ? 'good' : quickPct >= 50 ? 'warn' : 'danger');

  // 8h+
  setG('slow', slowPct, slowPct <= 10 ? 'gauge-fill--good' : slowPct <= 25 ? 'gauge-fill--warn' : 'gauge-fill--danger');
  document.getElementById('gval-slow').textContent = slowPct + '%';
  document.getElementById('gsub-slow').textContent = `${slow8h}건 / ${total}건`;
  document.getElementById('gsub-slow').setAttribute('data-tip', `분모: 해결시간 집계 가능한 closed 상담 ${total}건 기준&#10;(봇 자동처리·미응답·해결시간 미집계 건 제외)&#10;현재 오픈 대기 중인 건과는 별개`);
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
  if (fcr?.available && fcr.fcrRate != null) {
    setG('fcr', fcr.fcrRate, fcr.fcrRate >= 90 ? 'gauge-fill--good' : fcr.fcrRate >= 75 ? 'gauge-fill--warn' : 'gauge-fill--danger');
    document.getElementById('gval-fcr').textContent = fcr.fcrRate + '%';
    document.getElementById('gsub-fcr').textContent = `재오픈 ${fcr.reopenedCount}건`;
    document.getElementById('gsub-fcr').setAttribute('data-tip', '재오픈 상태 이벤트 기준 실측값');
    setB('fcr', fcr.fcrRate >= 90 ? '양호' : fcr.fcrRate >= 75 ? '주의' : '위험', fcr.fcrRate >= 90 ? 'good' : fcr.fcrRate >= 75 ? 'warn' : 'danger');
  } else {
    setG('fcr', 0, 'gauge-fill--warn');
    document.getElementById('gval-fcr').textContent = '측정 불가';
    document.getElementById('gsub-fcr').textContent = '재오픈 이력 필요';
    document.getElementById('gsub-fcr').setAttribute('data-tip', fcr?.note || '상태 전환 이력이 수집되지 않았습니다.');
    setB('fcr', '미수집', 'warn');
  }

  // 편중도
  const mgrs = (d.managers || []).filter((m) => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0);
  const mgrTotal = mgrs.reduce((s, m) => s + m.count, 0) || 1;
  const topMgr = mgrs[0];
  const topPct = topMgr ? Math.round(topMgr.count / mgrTotal * 100) : 0;
  setG('conc', topPct, topPct <= 40 ? 'gauge-fill--good' : topPct <= 60 ? 'gauge-fill--warn' : 'gauge-fill--danger');
  document.getElementById('gval-conc').textContent = topPct + '%';
  const gsubConc = document.getElementById('gsub-conc');
  if (gsubConc) {
    gsubConc.innerHTML = topMgr
      ? `<span data-tip="【배정 처리 기준】&#10;${topMgr.count}건 ÷ ${mgrTotal}건(배정 담당자 합계) × 100 = ${topPct}%&#10;봇·미배정·제외 담당자 제외 후 집계&#10;상단 KPI와 동일한 대표 기준입니다." tabindex="0" style="cursor:help">${dispMgrName(topMgr.name)} ${topMgr.count}건 · <strong>${topPct}%</strong> <span style="font-size:9.5px;color:var(--muted)">(배정 기준)</span> · ${topPct > 70 ? '편중 주의' : topPct > 50 ? '모니터링' : '분산 양호'}</span>`
      : '—';
  }
  setB('conc', topPct <= 40 ? '양호' : topPct <= 60 ? '주의' : '위험', topPct <= 40 ? 'good' : topPct <= 60 ? 'warn' : 'danger');
}

/* ─── Advanced sections (기존 + B-2 FCR 패널) ───────────────────────── */
function renderWow(d) {
  const el = document.getElementById('wowStrip');
  if (!el) return;
  const w = d.snapshotWow || d.wow;
  const total = d.summary.totalChats || 0;
  if (!w) { el.innerHTML = `<div class="wow-card"><div class="wow-label">현 기간</div><div class="wow-val">${total}건</div><div class="wow-sub">비교 기준 없음</div></div>`; return; }
  const spanDays = getDataSpanDays(d.dataNote || {});
  const history = getDurableHistoryStatus(d);
  const basisLabel = d.snapshotWow ? '스냅샷 기준' : 'API 기간 기준';
  const baselineOk = hasPeriodBaseline(d);
  if (!baselineOk) {
    const holdTitle = history.configured ? '데이터 누적 중' : '외부 스냅샷 미설정';
    const holdFoot = history.configured
      ? '직전 동기간 20건 이상과 14일 이상 누적 후 증감률을 표시합니다.'
      : 'Vercel KV/DB 일별 스냅샷이 연결되어야 서버리스 재시작 후에도 추세 기준이 유지됩니다.';
    el.innerHTML = `
      <div class="analysis-hold-card">
        <div class="hold-label">기간 비교 보류</div>
        <div class="hold-title">${holdTitle}</div>
        <div class="hold-sub">실데이터 ${spanDays || '—'}일 · ${history.label} · 현 기간 ${w.currentTotal || total}건 · 직전 동기간 ${w.previousTotal || 0}건</div>
        <div class="hold-foot">${holdFoot}</div>
      </div>`;
    return;
  }
  const sign = w.delta > 0 ? '+' : '';
  const cls = w.delta > 0 ? 'wow-up' : w.delta < 0 ? 'wow-down' : 'wow-flat';
  const deltaCard = w.previousTotal === 0
    ? `<div class="wow-card wow-flat"><div class="wow-label">증감</div><div class="wow-val" style="color:var(--muted);font-size:16px">비교 불가</div><div class="wow-sub" style="font-size:9px;color:var(--muted)">직전 기간 데이터 없음</div></div>`
    : `<div class="wow-card ${cls}"><div class="wow-label">증감</div><div class="wow-val">${sign}${w.delta}건</div><div class="wow-sub">${deltaArrow(w.deltaPct)}</div></div>`;
  el.innerHTML = `
    <div class="wow-card"><div class="wow-label">현 기간</div><div class="wow-val">${w.currentTotal}건</div><div class="wow-sub" style="font-size:9.5px;color:var(--muted)">${basisLabel}</div></div>
    <div class="wow-card"><div class="wow-label">직전 동기간</div><div class="wow-val muted">${w.previousTotal === 0 ? '—' : w.previousTotal + '건'}</div>${w.previousTotal === 0 ? '<div class="wow-sub" style="color:var(--amber);font-size:9.5px">⚠ 직전 데이터 없음</div>' : `<div class="wow-sub" style="font-size:9.5px;color:var(--muted)">${basisLabel}</div>`}</div>
    ${deltaCard}`;
}

function renderSLA(d) {
  const el = document.getElementById('slaTracker');
  if (!el) return;
  const s = d.slaStats || {};
  const targets = getSlaTargets();
  const items = [
    { key: 'sla30Min', label: '30분 SLA', target: targets.sla30Min, icon: '' },
    { key: 'sla2Hour', label: '2시간 SLA', target: targets.sla2Hour, icon: '' },
    { key: 'sla8Hour', label: '8시간 SLA', target: targets.sla8Hour, icon: '' },
  ];
  el.innerHTML = items.map((it) => {
    const v = s[it.key] || { rate: 0, count: 0, total: 0 };
    const cls = v.rate >= it.target ? 'good' : v.rate >= it.target * 0.7 ? 'warn' : 'danger';
    const sampleCls = v.total < 30 ? 'danger' : v.total < 80 ? 'warn' : 'good';
    const sampleText = v.total < 80 ? ` · n=${v.total} 참고용` : '';
    return `<div class="sla-row sla-${cls}">
      <span class="sla-icon">${it.icon}</span>
      <div class="sla-meta"><div class="sla-label">${it.label}</div><div class="sla-target">목표 ${it.target}%${sampleText ? `<span class="sample-badge sample-${sampleCls}">${sampleText.replace(' · ', '')}</span>` : ''}</div></div>
      <div class="sla-bar-wrap"><div class="sla-bar-fill sla-${cls}" style="width:${Math.min(v.rate, 100)}%"></div><div class="sla-target-marker" style="left:${it.target}%"></div></div>
      <div class="sla-val sla-${cls}">${v.rate}%</div>
      <div class="sla-count" tabindex="0" data-tip="【SLA 분모 설명】&#10;기준: closed 채팅 ${v.total}건&#10;제외 항목: ① 진행 중(open) 채팅 ② 해결시간 측정 불가(봇 자동종결·시스템 메시지만 있는 채팅) ③ 해결시간 데이터 누락 건&#10;→ 총 채팅 수와 SLA 분모가 다를 수 있음&#10;${it.label} 내 완료: ${v.count}건 / ${v.total}건 기준" style="cursor:help">${v.count}/${v.total} ⓘ</div>
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
      icon: '', label: 'FRT (P50)', cls,
      value: fmtMin(frt.median),
      sub: `평균 ${fmtMin(frt.avg)} · P90 ${fmtMin(frt.p90)}`,
      bar: Math.max(0, Math.min(100, Math.round((1 - frt.median / 60) * 100))),
    });
  } else {
    cards.push({ icon: '', label: 'FRT', cls: 'warn', value: '—', sub: '채널톡 데이터 부족', bar: 0 });
  }
  cards.push(fcr.available && fcr.fcrRate != null ? {
    icon: '', label: 'FCR (1차 해결률)',
    cls: fcr.fcrRate >= 90 ? 'good' : fcr.fcrRate >= 75 ? 'warn' : 'danger',
    value: fcr.fcrRate + '%',
    sub: `재오픈 ${fcr.reopenedCount}건 · 재오픈율 ${fcr.reopenedRate}%`,
    bar: fcr.fcrRate,
  } : {
    icon: '', label: 'FCR (1차 해결률)',
    cls: 'warn',
    value: '측정 불가',
    sub: '재오픈 상태 이벤트 적재 필요',
    bar: 0,
  });
  cards.push({
    icon: '', label: '반복 문의 고객',
    cls: repeat.repeatRate >= 30 ? 'danger' : repeat.repeatRate >= 15 ? 'warn' : 'good',
    value: (repeat.repeatRate || 0) + '%',
    sub: `전체 ${repeat.total || 0}명 · 반복 ${repeat.repeat || 0}명`,
    bar: repeat.repeatRate || 0,
  });
  cards.push({
    icon: '', label: '고객당 평균 채팅',
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
  el.setAttribute('aria-label', `시간대별 부하 차트, 피크: ${peakHour}시 ${max}건`);
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
    { label: '< 8시간', val: a.lt8h || 0, icon: '', color: '#15803d' },
    { label: '8h ~ 24h', val: a.h8_24 || 0, icon: '', color: '#f59e0b' },
    { label: '1일 ~ 3일', val: a.d1_3 || 0, icon: '', color: '#ea580c' },
    { label: '3일 ~ 7일', val: a.d3_7 || 0, icon: '', color: '#dc2626' },
    { label: '7일+', val: a.d7plus || 0, icon: '', color: '#be123c' },
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
  const spanDays = getDataSpanDays(d.dataNote || {});
  const total = d.summary?.totalChats || 0;
  const history = getDurableHistoryStatus(d);
  if ((history.historyDays || spanDays) && (history.historyDays < 14 || total < 30)) {
    const holdTitle = history.configured ? '표본 부족' : '외부 스냅샷 미설정';
    const holdFoot = history.configured
      ? 'IQR 이상치 탐지는 최소 14일 이상, 30건 이상 누적 후 표시합니다.'
      : 'IQR 기준선 유지를 위해 KV/DB 일별 스냅샷 연결이 필요합니다.';
    el.innerHTML = `<div class="analysis-hold-card">
      <div class="hold-label">이상치 탐지 보류</div>
      <div class="hold-title">${holdTitle}</div>
      <div class="hold-sub">실데이터 ${spanDays || '—'}일 · ${history.label} · ${total}건</div>
      <div class="hold-foot">${holdFoot}</div>
    </div>`;
    return;
  }
  if (!anom.length) { el.innerHTML = `<div class="anom-ok"><div class="anom-ok-icon">✓</div><div class="anom-ok-text">유의미한 이상치 없음</div><div class="anom-ok-sub">IQR 1.5배 기준 범위 내</div></div>`; return; }
  el.innerHTML = anom.map((a) => {
    const cls = a.isHigh ? 'anom-high' : 'anom-low';
    const icon = a.isHigh ? '↑' : '↓';
    const dir = a.isHigh ? '급증' : '급감';
    const threshold = a.isHigh ? `상한 ${a.upper}건` : `하한 ${a.lower}건`;
    return `<div class="anom-row ${cls}"><span class="anom-icon">${icon}</span><div class="anom-body"><div class="anom-date">${a.label}</div><div class="anom-detail">${a.val}건 · ${dir} (IQR ${threshold})</div></div><span class="anom-tag ${cls}">${dir}</span></div>`;
  }).join('');
}

function renderForecast(d) {
  const el = document.getElementById('forecastPanel');
  if (!el) return;
  const f = d.snapshotForecast || d.forecast || {};
  const spanDays = getDataSpanDays(d.dataNote || {});
  const history = getDurableHistoryStatus(d);
  const basisLabel = d.snapshotForecast ? '스냅샷 기준' : 'API 기간 기준';
  if (!hasPeriodBaseline(d)) {
    const holdTitle = history.configured ? '베이스라인 부족' : '외부 스냅샷 미설정';
    const holdFoot = history.configured
      ? '직전 구간이 0건이거나 수집 기간이 짧으면 모멘텀/다음날 투영을 숨깁니다.'
      : '볼륨 모멘텀은 서버리스 메모리 캐시가 아니라 KV/DB 일별 스냅샷 누적이 필요합니다.';
    el.innerHTML = `<div class="analysis-hold-card">
      <div class="hold-label">예측 보류</div>
      <div class="hold-title">${holdTitle}</div>
      <div class="hold-sub">실데이터 ${spanDays || '—'}일 · ${history.label} · 최근 7일 ${f.last7Avg ?? '—'}건/일 · 직전 7일 ${f.last14Avg ?? 0}건/일</div>
      <div class="hold-foot">${holdFoot}</div>
    </div>`;
    return;
  }
  const m = f.momentum || 0;
  const cls = m > 10 ? 'fc-up' : m < -10 ? 'fc-down' : 'fc-flat';
  const icon = m > 10 ? '↑' : m < -10 ? '↓' : '→';
  el.innerHTML = `
    <div class="fc-header"><span class="fc-icon">${icon}</span><div class="fc-title-block"><div class="fc-title">${m > 10 ? '상승 모멘텀' : m < -10 ? '하락 모멘텀' : '평탄'}</div><div class="fc-sub">7일 평균 vs 직전 7일 평균 · ${basisLabel}</div></div></div>
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
  const historyForTrend = getDurableHistoryStatus(d);
  const useSnapshotTrend = Boolean(d.snapshotTrend?.labels?.length >= 14);
  const t = useSnapshotTrend ? d.snapshotTrend : (d.complaintTrend || { labels: [], total: [], complaints: [] });
  const rates = t.labels.map((_, i) => t.total[i] > 0 ? Math.round((t.complaints[i] || 0) / t.total[i] * 100) : 0);
  if (charts.complaintTrend) charts.complaintTrend.destroy();
  charts.complaintTrend = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: t.labels,
      datasets: [
        {
          label: '컴플레인 건수 (좌축)',
          data: t.complaints,
          backgroundColor: 'rgba(252,165,165,0.45)',
          borderColor: 'rgba(190,18,60,0.3)',
          borderWidth: 1,
          borderRadius: 3,
          yAxisID: 'y',
          order: 2,
        },
        {
          label: '컴플레인율 % (우축)',
          data: rates,
          type: 'line',
          borderColor: '#991b1b',
          borderWidth: 2.5,
          tension: 0.35,
          pointRadius: 4,
          pointBackgroundColor: '#991b1b',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointHoverRadius: 6,
          fill: false,
          yAxisID: 'y1',
          order: 1,
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { font: { size: 10 }, usePointStyle: true, pointStyleWidth: 12, padding: 12 },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#1c1917',
          padding: 10,
          cornerRadius: 7,
          callbacks: {
            label: (ctx) => ctx.dataset.yAxisID === 'y'
              ? `건수: ${ctx.parsed.y}건`
              : `비율: ${ctx.parsed.y}%`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 9 }, maxTicksLimit: 12 },
        },
        y: {
          position: 'left',
          grid: { color: '#f1efe8' },
          ticks: { callback: (v) => v + '건', font: { size: 9 } },
          beginAtZero: true,
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: { callback: (v) => v + '%', font: { size: 9 } },
          beginAtZero: true,
          max: 100,
        },
      },
    },
  });
  const totalCom = t.complaints.reduce((a, b) => a + b, 0);
  const _avgRate = t.total.reduce((a,b)=>a+b,0) > 0 ? Math.round(totalCom / t.total.reduce((a,b)=>a+b,0) * 100) : 0;
  el.setAttribute('aria-label', `컴플레인 추이 차트, ${t.labels.length}개 기간, 총 ${totalCom}건, 평균 컴플레인율 ${_avgRate}%`);
  const totalAll = t.total.reduce((a, b) => a + b, 0) || 1;
  const overallRate = Math.round(totalCom / totalAll * 100);

  // 전반부 vs 후반부 비교 (추이 방향)
  const half = Math.floor(t.complaints.length / 2);
  const firstHalfSum = t.complaints.slice(0, half).reduce((a, b) => a + b, 0);
  const lastHalfSum  = t.complaints.slice(half).reduce((a, b) => a + b, 0);
  const trendPct = firstHalfSum > 0 ? Math.round((lastHalfSum - firstHalfSum) / firstHalfSum * 100) : 0;
  const trendIcon = trendPct > 5 ? '↑' : trendPct < -5 ? '↓' : '→';
  const trendStyle = trendPct > 5 ? 'color:var(--rose);font-weight:700' : trendPct < -5 ? 'color:var(--teal-d);font-weight:700' : 'color:var(--muted)';

  // 피크 날짜 탐색
  const peakIdx = t.complaints.indexOf(Math.max(...t.complaints));
  const peakLabel = t.labels[peakIdx] || '—';
  const peakCnt   = t.complaints[peakIdx] || 0;

  // 최근 7일 평균율 및 직전 7일 비교
  const recentN = Math.min(7, t.complaints.length);
  const recentCom = t.complaints.slice(-recentN).reduce((a, b) => a + b, 0);
  const recentAll = t.total.slice(-recentN).reduce((a, b) => a + b, 0) || 1;
  const recentRate = Math.round(recentCom / recentAll * 100);
  const prevN = Math.min(7, Math.max(0, t.complaints.length - recentN));
  const prevCom = prevN > 0 ? t.complaints.slice(-recentN - prevN, -recentN).reduce((a, b) => a + b, 0) : 0;
  const prevAll = prevN > 0 ? (t.total.slice(-recentN - prevN, -recentN).reduce((a, b) => a + b, 0) || 1) : 1;
  const prevRate = prevN > 0 ? Math.round(prevCom / prevAll * 100) : null;
  const rateDiff = prevRate !== null ? recentRate - prevRate : null;
  const rateDiffSign = rateDiff !== null ? (rateDiff > 0 ? '+' : '') : '';
  const rateDiffStyle = rateDiff === null ? 'color:var(--muted)' : rateDiff > 2 ? 'color:var(--rose);font-weight:700' : rateDiff < -2 ? 'color:var(--teal-d);font-weight:700' : 'color:var(--muted)';
  const rateDiffLabel = rateDiff !== null ? `${rateDiffSign}${rateDiff}%p` : '—';
  const history = historyForTrend;
  const trendBaselineOk = Boolean(history.historyDays >= 14 && prevN >= 7 && prevAll >= 20 && recentAll >= 20 && (useSnapshotTrend || !isSameAcrossMainPeriods(d.dataNote || {})));
  const trendHoldReason = !history.configured
    ? '외부 스냅샷 미설정'
    : history.historyDays < 14
    ? `${history.label} · 누적 중`
    : '직전 7일 표본 부족';

  const kvEl = document.getElementById('complaintTrendKV');
  if (kvEl) kvEl.innerHTML = `
    <div class="ct-kv"><span class="ct-lbl">총 컴플레인</span><span class="ct-val">${totalCom}건</span></div>
    <div class="ct-kv"><span class="ct-lbl">전체 비율</span><span class="ct-val ${overallRate >= 15 ? 'danger' : overallRate >= 8 ? 'warn' : 'good'}">${overallRate}%</span></div>
    <div class="ct-kv"><span class="ct-lbl">최근 ${recentN}일 평균</span><span class="ct-val ${recentRate >= 15 ? 'danger' : recentRate >= 8 ? 'warn' : 'good'}">${recentRate}%</span></div>
    <div class="ct-kv"><span class="ct-lbl">직전 ${recentN}일 대비</span><span class="ct-val" style="${trendBaselineOk ? rateDiffStyle : 'color:var(--muted)'}">${trendBaselineOk ? rateDiffLabel : '판단 보류'}</span></div>
    <div class="ct-kv"><span class="ct-lbl">피크 날짜</span><span class="ct-val">${peakLabel} (${peakCnt}건)</span></div>`;

  // P2.12 자동 해석 요약
  const interpEl = document.getElementById('complaintTrendInterp');
  if (interpEl) {
    const direction = !trendBaselineOk
      ? `<span class="sample-badge sample-warn">추세 판단 보류</span> <span style="color:var(--muted)">${trendHoldReason}</span>`
      : trendPct > 5 ? `<span style="color:var(--rose);font-weight:700">증가 추세 (${trendPct > 0 ? '+' : ''}${trendPct}%)</span>` : trendPct < -5 ? `<span style="color:var(--teal-d);font-weight:700">감소 추세 (${trendPct}%)</span>` : `<span style="color:var(--muted)">안정적</span>`;
    const urgency = recentRate >= 15 ? '즉각 대응 필요' : recentRate >= 8 ? '지속 모니터링' : '정상 범위';
    interpEl.innerHTML = `
      <div class="auto-interp">
        <span class="ai-text">최근 ${recentN}일 컴플레인율 <strong>${recentRate}%</strong> — ${direction} · 피크: ${peakLabel}(${peakCnt}건) · ${urgency}</span>
      </div>`;
  }
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
  el.setAttribute('aria-label', `담당자 성과 사분면 차트, ${points.length}명, X축: 평균 해결시간, Y축: 처리 건수`);
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
  const cacheMeta = getCacheMeta(diag);

  if (footerEl) {
    const okCount = calls.filter((c) => c.ok).length;
    const cacheStr = diag.cacheHit ? `캐시 응답` : `최신 조회`;
    const status = warns.length === 0 ? '✓ 정상' : `⚠ 부분실패 (${warns.length})`;
    const displayMs = diag.cacheHit ? (diag.paginationMs ? `원본 ${diag.paginationMs}ms` : '—') : `${diag.totalMs}ms`;
    footerEl.innerHTML = `${cacheStr} · ${displayMs} · ${status} · API ${okCount}/${calls.length}`;
  }

  // ── API 상태 탭 ──
  if (el) {
    const totalRows = calls.map((c) => `<tr><td>${c.label}</td><td><span class="diag-status ${c.ok ? 'ok' : 'fail'}">${c.ok ? 'OK' : 'FAIL'}</span></td><td class="num-r">${c.status}</td><td class="num-r">${c.ms}ms</td></tr>`).join('');
    const warnHtml = warns.length ? `<div class="diag-warns">${warns.map((w) => `<span class="diag-warn-tag">⚠ ${w}</span>`).join('')}</div>` : `<div class="diag-ok">✓ 모든 호출 성공</div>`;
    const responseTimeLabel = diag.cacheHit
      ? `<span style="color:var(--teal)">캐시 응답</span> <span style="font-size:10px;color:var(--muted)">(원본 수집 ${diag.paginationMs || 0}ms)</span>`
      : `${diag.totalMs}ms`;
    el.innerHTML = `
      <div class="diag-summary">
        <div class="diag-stat"><span class="diag-stat-lbl">서버 응답시간</span><span class="diag-stat-val">${responseTimeLabel}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">캐시 상태</span><span class="diag-stat-val ${diag.cacheHit ? 'good' : ''}">${diag.cacheHit ? cacheMeta.shortLabel : '최신 조회'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">원본 수집</span><span class="diag-stat-val">${diag.pages || 0}p · ${diag.paginationMs || 0}ms</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">실패 호출</span><span class="diag-stat-val ${warns.length > 0 ? 'danger' : 'good'}">${warns.length}건</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">일별 스냅샷</span><span class="diag-stat-val ${d.snapshotStore?.enabled ? 'good' : 'danger'}">${d.snapshotStore?.enabled ? `${d.snapshotStore.count}일` : '미설정'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">자동 태깅</span><span class="diag-stat-val ${d.taggingQuality?.autoTaggingAvailable ? 'good' : 'danger'}">${d.taggingQuality?.autoTaggingAvailable ? '활성' : '본문 미수집'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">순처리시간</span><span class="diag-stat-val ${d.resolutionStats?.agentHandleTimeAvailable ? 'good' : 'danger'}">${d.resolutionStats?.agentHandleTimeAvailable ? '활성' : '미수집'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">FCR</span><span class="diag-stat-val ${d.fcrStats?.available ? 'good' : 'danger'}">${d.fcrStats?.available ? '활성' : '재오픈 이력 미수집'}</span></div>
      </div>
      ${warnHtml}
      <table class="diag-tbl">
        <thead><tr><th>API 엔드포인트</th><th>상태</th><th class="num-r">HTTP</th><th class="num-r">응답시간</th></tr></thead>
        <tbody>${totalRows || '<tr><td colspan="4" class="diag-empty">호출 정보 없음</td></tr>'}</tbody>
      </table>
      <div class="diag-note">v4.1 — ${cacheMeta.storageLabel} · since 커서 페이지네이션 · 1000건 한도</div>
      <div class="diag-note" style="margin-top:8px">${d.snapshotStore?.message || '스냅샷 상태 없음'} · ${d.taggingQuality?.blocker || '자동 태깅 상태 없음'} · ${d.resolutionStats?.agentHandleTimeNote || '순처리시간 상태 없음'} · ${d.fcrStats?.note || 'FCR 상태 없음'}</div>`;
  }

  // ── 캐시 탭 ──
  const cacheEl = document.getElementById('diagCachePanel');
  if (cacheEl) {
    const cacheStatus = diag.cacheHit ? `<span class="diag-stat-val good">캐시 HIT (${cacheMeta.shortLabel})</span>` : `<span class="diag-stat-val">캐시 MISS — 최신 조회</span>`;
    const paginMs = diag.paginationMs || 0;
    const totalMs = diag.totalMs || 0;
    cacheEl.innerHTML = `
      <div class="diag-summary">
        <div class="diag-stat"><span class="diag-stat-lbl">캐시 종류</span><span class="diag-stat-val">${cacheMeta.storageLabel}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">이번 응답</span>${cacheStatus}</div>
        <div class="diag-stat"><span class="diag-stat-lbl">TTL</span><span class="diag-stat-val">5분</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">원본 API 시간</span><span class="diag-stat-val">${paginMs}ms</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">서버 응답시간</span><span class="diag-stat-val">${diag.cacheHit ? '≈0ms (캐시)' : totalMs + 'ms'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">영구 스냅샷</span><span class="diag-stat-val ${d.snapshotStore?.enabled ? 'good' : 'danger'}">${d.snapshotStore?.enabled ? `${d.snapshotStore.count}일 · ${d.snapshotStore.source}` : 'KV/DB 필요'}</span></div>
      </div>
      <div class="diag-note">${cacheMeta.note}. 캐시 적중 시 서버 응답이 즉시 반환됩니다.</div>
      <div class="diag-note" style="margin-top:8px">기간 비교·예측·이상치 기준선은 5분 캐시가 아니라 일별 스냅샷이 필요합니다. ${d.snapshotStore?.message || 'Vercel KV 연결 필요'}</div>`;
  }

  // ── 수집 한도 탭 ──
  const limitEl = document.getElementById('diagLimitPanel');
  if (limitEl) {
    // dataNote 정정 — 이전에 d.diagnostics.collectedTotal 로 잘못 참조하던 것 수정
    const dn = d.dataNote || {};
    const collected = dn.collected ?? '—';
    const processedCnt = dn.processed ?? '—';
    const limitValDiag = dn.limit ?? 1000;
    const pages = diag.pages || 0;
    const isSampledDiag = dn.isSampled || false;
    const sampledBadge = isSampledDiag
      ? `<span style="color:var(--amber);font-weight:700">⚠ 추가 데이터 존재 — 1000건 이후 제외</span>`
      : `<span style="color:var(--teal)">원천 목록 끝까지 수집</span>`;

    // 날짜 범위 — processedMinAt/processedMaxAt (서버 응답) 또는 dailyTrend fallback
    const _fmtTs = (ts) => {
      if (!ts) return null;
      const d2 = new Date(ts + 9 * 3600 * 1000); // KST
      const y = d2.getUTCFullYear();
      const mo = String(d2.getUTCMonth() + 1).padStart(2, '0');
      const dy = String(d2.getUTCDate()).padStart(2, '0');
      return `${y}-${mo}-${dy}`;
    };
    let dateRangeStr = '—';
    if (dn.processedMinAt && dn.processedMaxAt) {
      const minD = _fmtTs(dn.processedMinAt);
      const maxD = _fmtTs(dn.processedMaxAt);
      dateRangeStr = minD === maxD ? minD : `${minD} ~ ${maxD}`;
    } else {
      // fallback: dailyTrend 레이블에서 추출
      const tLabels = d.dailyTrend?.labels || [];
      const tVals = d.dailyTrend?.values || [];
      const activeL = tLabels.filter((_, i) => tVals[i] > 0);
      if (activeL.length >= 2) dateRangeStr = `${activeL[0]} ~ ${activeL[activeL.length - 1]}`;
      else if (activeL.length === 1) dateRangeStr = activeL[0];
    }

    // 기간별 동일 결과 여부
    const _allInPeriodDiag = !isSampledDiag && typeof collected === 'number' && typeof processedCnt === 'number' && collected === processedCnt;
    const _sameAcrossMainDiag = isSameAcrossMainPeriods(dn);
    const sameNote = _allInPeriodDiag
      ? `<div class="diag-note" style="background:rgba(13,148,136,.08);border-left:3px solid var(--teal);padding:10px 12px;margin-top:10px;border-radius:6px">
          <strong>기간별 동일 결과 — 정상 동작입니다</strong><br>
          전체 수집 ${collected}건이 선택 기간 내에 모두 포함되어 ${_sameAcrossMainDiag ? '7일·14일·30일·전체' : '더 긴 기간'} 탭에서 동일한 수치가 표시됩니다.<br>
          현재 요청: <code>days=${currentDays}</code> · 기간 필터 후 처리: ${processedCnt}건 / 수집: ${collected}건<br>
          <em>원인: 기간 기준 원천 데이터가 ${dateRangeStr} 범위에 있고 API 한도(${limitValDiag}건)에 도달하지 않음</em>
        </div>`
      : '';

    limitEl.innerHTML = `
      <div class="diag-summary">
        <div class="diag-stat"><span class="diag-stat-lbl">API 수집 한도</span><span class="diag-stat-val">${limitValDiag}건</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">수집 건수 (기간 필터 전)</span><span class="diag-stat-val">${collected}건</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">원시 응답 / 중복 제거</span><span class="diag-stat-val">${dn.rawFetched ?? diag.rawFetched ?? collected}건 / ${dn.duplicatesRemoved ?? diag.duplicatesRemoved ?? 0}건</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">처리 건수 (기간 필터 후)</span><span class="diag-stat-val">${processedCnt}건</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">페이지 수</span><span class="diag-stat-val">${pages}p · 페이지당 ${diag.pageSize || 500}건</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">데이터 날짜 범위</span><span class="diag-stat-val">${dateRangeStr}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">기간 기준</span><span class="diag-stat-val">${dn.periodBasis || 'closedAt/updatedAt/createdAt'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">현재 기간 완결</span><span class="diag-stat-val ${dn.currentPeriodComplete === false ? 'danger' : 'good'}">${dn.currentPeriodComplete === false ? '미보장' : '확인'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">직전 동기간 완결</span><span class="diag-stat-val ${dn.baselineComplete === false ? 'danger' : 'good'}">${dn.baselineComplete === false ? '미보장' : '확인'}</span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">요청 파라미터</span><span class="diag-stat-val"><code>days=${currentDays}</code></span></div>
        <div class="diag-stat"><span class="diag-stat-lbl">상한 도달 여부</span>${sampledBadge}</div>
      </div>
      ${sameNote}
      <div class="diag-note" style="margin-top:8px">Channel Talk Open API v5의 next 커서는 다음 요청의 since 파라미터로 전달합니다. 추가 데이터가 남은 상태에서 ${limitValDiag}건에 도달하면 현재 기간·직전 동기간 완결 여부를 각각 확인해야 합니다.</div>`;
  }

  // ── CSV 기준 탭 ──
  const csvEl = document.getElementById('diagCsvPanel');
  if (csvEl) {
    const btnHtml = `<button onclick="downloadCSV()" style="margin-top:12px;padding:8px 18px;border:none;border-radius:8px;background:var(--teal);color:#fff;font-size:13px;font-weight:600;cursor:pointer">CSV 내보내기</button>`;
    csvEl.innerHTML = `
      <div class="diag-note" style="margin-bottom:10px">현재 기간의 집계표를 CSV로 내보냅니다 (BOM 포함, UTF-8). 원시 채팅 행 단위 파일이 아니며, 활성 필터는 담당자·VOC 목록에만 적용됩니다.</div>
      <table class="diag-tbl">
        <thead><tr><th>섹션</th><th>내용</th><th>집계 단위</th></tr></thead>
        <tbody>
          <tr><td>SLA</td><td>30분·2시간·8시간 준수율</td><td>해결시간 표본</td></tr>
          <tr><td>담당자</td><td>처리량·FRT·해결시간·컴플레인</td><td>담당자 집계</td></tr>
          <tr><td>해결시간</td><td>구간·에이징·백분위</td><td>측정 가능 closed 상담</td></tr>
          <tr><td>VOC</td><td>태그·태그별 해결시간</td><td>태그 발생/채팅 표본</td></tr>
          <tr><td>채널/컴플레인</td><td>채널 성능·일별 추이</td><td>기간 집계</td></tr>
        </tbody>
      </table>
      ${btnHtml}`;
  }
}

/* ─── Tabs ──────────────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.cg-tabs').forEach((group) => {
    const tabs = Array.from(group.querySelectorAll('.cg-tab'));
    const activate = (tab, moveFocus = false) => {
      const target = tab.dataset.tab;
      const parent = group.closest('.cg-panel');
      if (!parent) return;
      tabs.forEach((item) => {
        const isActive = item === tab;
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', String(isActive));
        item.setAttribute('tabindex', isActive ? '0' : '-1');
      });
      parent.querySelectorAll('.cg-tab-pane').forEach((pane) => pane.classList.remove('active'));
      const pane = parent.querySelector('#' + target);
      if (pane) pane.classList.add('active');
      if (moveFocus) tab.focus();
      // Re-render charts/content for the newly visible tab pane
      const d = lastFilteredData || lastData;
      if (d) setTimeout(() => _rerenderTab(target, d), 30);
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        activate(tabs[nextIndex], true);
      });
    });
  });
}

/* ─── 모달 ESC 닫기 + 포커스 트랩 ───────────────────────────────────── */
function initModalAccessibility() {
  // ESC 키로 열린 모달 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openModal = document.querySelector('.modal-overlay[aria-hidden="false"], #filterBottomSheet.is-open');
    if (!openModal) return;
    if (openModal.id === 'complaintModal') closeComplaintPanel();
    else if (openModal.id === 'longChatsModal') closeLongChatsPanel();
  });

  // 포커스 트랩: Tab/Shift+Tab이 모달 내부에서만 순환
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const openModal = document.querySelector('.modal-overlay[aria-hidden="false"], #filterBottomSheet.is-open');
    if (!openModal) return;
    const focusables = [...openModal.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )].filter(el => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { last.focus(); e.preventDefault(); }
    } else {
      if (document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  });
}

/* 탭 전환 시 해당 탭의 차트/콘텐츠 재렌더링 */
function _rerenderTab(tabId, d) {
  switch (tabId) {
    case 'voc-distribution': safeRender(() => renderTagBar(d), 'tagBar.tab'); break;
    case 'voc-risk':         safeRender(() => renderVocRiskSection(d), 'vocRisk.tab'); break;
    case 'voc-resolution':   safeRender(() => renderTagRes(d), 'tagRes.tab'); break;
    case 'voc-cooccur':      safeRender(() => renderTagCooccur(d), 'tagCooccur.tab'); break;
    case 'voc-complaint':    safeRender(() => renderComplaintCategory(d), 'complaintCat.tab'); break;
    case 'mgr-table':
      safeRender(() => renderManagers(d), 'managers.tab');
      safeRender(() => renderMgrRiskStrip(d), 'mgrRisk.tab');
      break;
    case 'mgr-quadrant':     safeRender(() => renderMgrQuadrant(d), 'mgrQuad.tab'); break;
    case 'mgr-conc':         safeRender(() => renderConcRisk(d), 'concRisk.tab'); break;
    case 'mgr-frt':          safeRender(() => renderMgrFrtTable(d), 'mgrFrt.tab'); break;
    // 해결시간 탭
    case 'res-dist':         safeRender(() => renderResolution(d), 'resolution.tab'); break;
    case 'res-longdelay':    safeRender(() => renderLongDelayPanel(d), 'longDelay.tab'); break;
    case 'res-percentile':   safeRender(() => renderPercentile(d), 'percentile.tab'); break;
    // 진단 탭
    case 'diag-api':
    case 'diag-cache':
    case 'diag-limit':
    case 'diag-csv':         safeRender(() => renderDiagnostics(d), 'diagnostics.tab'); break;
    default: break;
  }
  // Chart.js 캔버스 크기 강제 재조정 (숨겨진 상태에서 렌더 시 0px 방지)
  const pane = document.getElementById(tabId);
  if (pane) pane.querySelectorAll('canvas').forEach((c) => {
    const ch = Chart.getChart(c); if (ch) ch.resize();
  });
}

/* 액션 아이템 → 해당 탭 이동 + 패널 스크롤 */
/* 탭 이동: 탭 ID("mgr-conc") 또는 CSS 선택자("[data-tab='mgr-conc']") 모두 허용 */
function _gotoTab(tabIdOrSel) {
  const sel = (typeof tabIdOrSel === 'string' && tabIdOrSel.startsWith('['))
    ? tabIdOrSel
    : '[data-tab="' + tabIdOrSel + '"]';
  const btn = document.querySelector(sel);
  if (!btn) return;
  btn.click();
  const panel = btn.closest('.cg-panel');
  if (panel) setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

/* ─── 모바일 섹션 아코디언 (≤430px) ─────────────────────────────────── */
function initMobileAccordions() {
  if (window.innerWidth > 430) return;

  // chart-master-grid 내 모든 cg-panel 기본 접힘
  document.querySelectorAll('.chart-master-grid .cg-panel').forEach(panel => {
    const header = panel.querySelector('.cg-panel-header');
    if (!header) return;
    // 접근성: 헤더가 탭/버튼을 포함할 경우 직접 role 부여하지 않음
    const hasTabs = !!header.querySelector('.cg-tabs');
    if (!hasTabs) {
      header.setAttribute('role', 'button');
      header.setAttribute('tabindex', '0');
      header.setAttribute('aria-expanded', 'false');
    }
    panel.classList.add('mob-collapsed');
    // 캔버스(차트)가 있는 패널에 "차트 보기" 버튼 추가
    const hasCanvas = !!panel.querySelector('canvas');
    if (hasCanvas) {
      const chartBtn = document.createElement('button');
      chartBtn.className = 'mob-chart-btn';
      chartBtn.textContent = '차트 보기';
      chartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.remove('mob-collapsed');
        if (!hasTabs) header.setAttribute('aria-expanded', 'true');
        chartBtn.remove();
      });
      header.appendChild(chartBtn);
    }
    const togglePanel = (e) => {
      // 탭 버튼 등 내부 button 클릭은 아코디언 토글에서 제외
      if (e.target.closest('button') || e.target.closest('.cg-tabs')) return;
      const collapsed = panel.classList.toggle('mob-collapsed');
      if (!hasTabs) header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    header.addEventListener('click', togglePanel);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(e); }
    });
  });

  // section-wrap (핵심 지표 게이지 섹션) 기본 접힘
  document.querySelectorAll('section.section-wrap').forEach(sec => {
    const header = sec.querySelector('.section-header');
    if (!header) return;
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'false');
    sec.classList.add('mob-collapsed');
    const toggleSec = () => {
      const collapsed = sec.classList.toggle('mob-collapsed');
      header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    header.addEventListener('click', toggleSec);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSec(); }
    });
  });

  // 고도화 분석 #advContent 내 adv-panel 기본 접힘 (모바일 약 6800px 세로 방지)
  _initAdvPanelAccordions();
}

// advContent 패널 아코디언 — init 시 + advContent 열릴 때 모두 호출
function _initAdvPanelAccordions() {
  if (window.innerWidth > 430) return;
  document.querySelectorAll('#advContent .cg-panel').forEach(panel => {
    if (panel.dataset.mobAccordion) return; // 중복 등록 방지
    panel.dataset.mobAccordion = '1';
    const header = panel.querySelector('.cg-panel-header');
    if (!header) return;
    const hasTabs = !!header.querySelector('.cg-tabs');
    if (!hasTabs) {
      header.setAttribute('role', 'button');
      header.setAttribute('tabindex', '0');
      header.setAttribute('aria-expanded', 'false');
    }
    panel.classList.add('mob-collapsed');
    const togglePanel = (e) => {
      if (e.target.closest('button') || e.target.closest('.cg-tabs')) return;
      const collapsed = panel.classList.toggle('mob-collapsed');
      if (!hasTabs) header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    header.addEventListener('click', togglePanel);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(e); }
    });
  });
}

/* ─── Filter Drawer Init ────────────────────────────────────────────── */
function initFilterDrawer() {
  const filterBtn = document.getElementById('filterBtn');
  const drawer = document.getElementById('filterDrawer');
  const closeBtn = document.getElementById('filterCloseBtn');
  const clearBtn = document.getElementById('filterClearBtn');

  // ── PC 드로어 ──────────────────────────────────────────────────────────
  function openDrawer() {
    if (!lastData) return;
    drawer.style.removeProperty('display');
    drawer.style.display = 'block';
    requestAnimationFrame(() => {
      drawer.classList.add('is-open');
      renderFilterDrawer(lastData);
      if (filterBtn) filterBtn.setAttribute('aria-expanded', 'true');
    });
  }
  function closeDrawer() {
    drawer.classList.remove('is-open');
    if (filterBtn) filterBtn.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (!drawer.classList.contains('is-open')) drawer.style.display = '';
    }, 360);
  }
  // PC에서만 드로어 초기 표시 (모바일은 바텀시트 단독 사용)
  if (window.innerWidth > 430) drawer.style.display = 'block';

  // ── 모바일 바텀시트 ───────────────────────────────────────────────────
  const fbsOverlay = document.getElementById('filterBottomSheet');
  const fbsCloseBtn = document.getElementById('fbsCloseBtn');
  const fbsClearBtn = document.getElementById('fbsClearBtn');
  const fbsApplyBtn = document.getElementById('fbsApplyBtn');

  function _isMobile() { return window.innerWidth <= 430; }

  function _fbsUpdateApplyBtn() {
    const n = activeFilterCount();
    if (fbsApplyBtn) fbsApplyBtn.textContent = n > 0 ? `${n}개 필터 적용` : '적용';
  }
  function openBottomSheet() {
    if (!lastData || !fbsOverlay) return;
    renderFilterDrawer(lastData, { mgr: 'bsMgrList', tag: 'bsTagList', src: 'bsSrcList', pfx: 'bs' });
    _fbsUpdateApplyBtn();
    fbsOverlay.classList.add('is-open');
    fbsOverlay.setAttribute('aria-hidden', 'false');
    if (filterBtn) filterBtn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => fbsCloseBtn?.focus());
  }
  function closeBottomSheet() {
    if (!fbsOverlay) return;
    fbsOverlay.classList.remove('is-open');
    fbsOverlay.setAttribute('aria-hidden', 'true');
    if (filterBtn) filterBtn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (fbsOverlay.contains(document.activeElement)) filterBtn?.focus();
  }

  // 필터 버튼: 모바일→바텀시트, PC→드로어
  if (filterBtn) filterBtn.onclick = () => {
    if (_isMobile()) {
      if (fbsOverlay && fbsOverlay.classList.contains('is-open')) closeBottomSheet();
      else openBottomSheet();
    } else {
      if (drawer.classList.contains('is-open')) closeDrawer();
      else openDrawer();
    }
  };

  // PC 드로어 버튼
  if (closeBtn) closeBtn.onclick = closeDrawer;
  if (clearBtn) clearBtn.onclick = () => {
    filterState.managers.clear(); filterState.tags.clear(); filterState.sources.clear();
    renderFilterDrawer(lastData);
    updateFilterBadges();
    applyFilteredRender();
  };

  // 바텀시트 버튼
  if (fbsCloseBtn) fbsCloseBtn.onclick = closeBottomSheet;
  if (fbsClearBtn) fbsClearBtn.onclick = () => {
    filterState.managers.clear(); filterState.tags.clear(); filterState.sources.clear();
    renderFilterDrawer(lastData, { mgr: 'bsMgrList', tag: 'bsTagList', src: 'bsSrcList', pfx: 'bs' });
    _fbsUpdateApplyBtn();
    updateFilterBadges();
    // 필터 전체 해제 즉시 scope 노트·lastFilteredData 초기화
    const scopeEl = document.getElementById('filterScopeNote');
    if (scopeEl) scopeEl.style.display = 'none';
    lastFilteredData = null;
    // 즉시 필터 적용 대상 모듈만 원본 데이터로 복원
    if (lastData) applyFilteredRender();
  };
  if (fbsApplyBtn) fbsApplyBtn.onclick = () => {
    applyFilteredRender();
    closeBottomSheet();
  };

  // 바텀시트 오버레이 탭 → 닫기
  if (fbsOverlay) fbsOverlay.addEventListener('click', (e) => {
    if (e.target === fbsOverlay) closeBottomSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fbsOverlay?.classList.contains('is-open')) closeBottomSheet();
  });

  // ── 필터 칩 이벤트 위임 (PC 드로어) ────────────────────────────────
  drawer.addEventListener('click', (e) => {
    const chip = e.target.closest('button.filter-chip[data-fkind]');
    if (!chip) return;
    e.stopPropagation();
    const kind = chip.dataset.fkind;
    const val  = chip.dataset.fval;
    const set  = kind === 'mgr' ? filterState.managers : kind === 'tag' ? filterState.tags : filterState.sources;
    if (set.has(val)) { set.delete(val); } else { set.add(val); }
    const nowActive = set.has(val);
    chip.classList.toggle('active', nowActive);
    chip.setAttribute('aria-pressed', String(nowActive));
    updateFilterBadges();
    applyFilteredRender();
  });

  // ── 필터 칩 이벤트 위임 (모바일 바텀시트) ──────────────────────────
  if (fbsOverlay) fbsOverlay.addEventListener('click', (e) => {
    const chip = e.target.closest('button.filter-chip[data-fkind]');
    if (!chip) return;
    e.stopPropagation();
    const kind = chip.dataset.fkind;
    const val  = chip.dataset.fval;
    const set  = kind === 'mgr' ? filterState.managers : kind === 'tag' ? filterState.tags : filterState.sources;
    if (set.has(val)) { set.delete(val); } else { set.add(val); }
    const nowActive = set.has(val);
    chip.classList.toggle('active', nowActive);
    chip.setAttribute('aria-pressed', String(nowActive));
    _fbsUpdateApplyBtn();
    updateFilterBadges();
  });

  // PC: 필터 외부 클릭 시 닫기
  document.addEventListener('click', (e) => {
    if (!drawer.classList.contains('is-open')) return;
    if (!drawer.contains(e.target) && e.target !== filterBtn && !filterBtn.contains(e.target)) {
      closeDrawer();
    }
  });
}

function initSlaTargetControls() {
  const ids = {
    sla30Min: document.getElementById('slaTarget30'),
    sla2Hour: document.getElementById('slaTarget2h'),
    sla8Hour: document.getElementById('slaTarget8h'),
  };
  const resetBtn = document.getElementById('slaTargetReset');
  const applyToInputs = (targets) => {
    if (ids.sla30Min) ids.sla30Min.value = targets.sla30Min;
    if (ids.sla2Hour) ids.sla2Hour.value = targets.sla2Hour;
    if (ids.sla8Hour) ids.sla8Hour.value = targets.sla8Hour;
  };
  const readInputs = () => ({
    sla30Min: Math.max(1, Math.min(100, Number(ids.sla30Min?.value || 50))),
    sla2Hour: Math.max(1, Math.min(100, Number(ids.sla2Hour?.value || 80))),
    sla8Hour: Math.max(1, Math.min(100, Number(ids.sla8Hour?.value || 95))),
  });
  const rerender = () => {
    const targets = readInputs();
    setSlaTargets(targets);
    if (lastData) renderSLA(lastFilteredData || lastData);
  };
  applyToInputs(getSlaTargets());
  Object.values(ids).forEach((input) => {
    if (!input) return;
    input.addEventListener('change', rerender);
    input.addEventListener('blur', rerender);
  });
  if (resetBtn) resetBtn.addEventListener('click', () => {
    const defaults = { sla30Min: 50, sla2Hour: 80, sla8Hour: 95 };
    setSlaTargets(defaults);
    applyToInputs(defaults);
    if (lastData) renderSLA(lastFilteredData || lastData);
  });
}

/* ─── Full Render ────────────────────────────────────────────────────── */
function fullRender(data) {
  // 기간 전환 시 적용된 stale dimming / opacity 초기화
  document.querySelectorAll('[data-period-loading]').forEach(el => el.removeAttribute('data-period-loading'));
  const heroMeta = document.getElementById('heroInlineMeta');
  if (heroMeta) heroMeta.style.opacity = '';
  // clearPeriodUI 에서 dim된 섹션 복원
  [
    document.querySelector('.health-gauge-row'),
    document.querySelector('.chart-master-grid'),
    document.getElementById('insightsStrip'),
    document.getElementById('kpiBasisHeader'),
  ].forEach(el => {
    if (el) { el.style.opacity = ''; el.style.pointerEvents = ''; }
  });
  const scoreObj = computeHealthScore(data);
  const insights = generateInsights(data, scoreObj);
  safeRender(() => renderHealthScore(scoreObj, data), 'healthScore');
  safeRender(() => renderHeroQuickStats(data, scoreObj), 'heroQuickStats');
  safeRender(() => renderHeroDecisionSummary(data, scoreObj), 'heroDecisionSummary');
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
  const freshQs = forceRefreshRequested ? '&fresh=1' : '';
  const ts = Date.now();
  const res = await fetch(`/api/data?${qs}${freshQs}&_t=${ts}`, { cache: 'no-store' });
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

/* ─── 새로고침 상태 표시 ──────────────────────────────────────────── */
function _setRefreshStatus(text, cls) {
  const el = document.getElementById('refreshStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'refresh-status rs-' + (cls || 'idle');
}
function _nowHHMM() {
  const n = new Date();
  return n.getHours().toString().padStart(2, '0') + ':' + n.getMinutes().toString().padStart(2, '0');
}

async function ensureAuthenticated() {
  try {
    const res = await fetch('/api/check?_t=' + Date.now(), { cache: 'no-store' });
    if (res.status === 401) {
      let body = null;
      try { body = await res.json(); } catch (_) {}
      window.location.href = body?.redirect || '/api/auth';
      return false;
    }
    return res.ok;
  } catch (_) {
    return true;
  }
}

function render() {
  return (async () => { try {
    _setRefreshStatus(forceRefreshRequested ? '강제 갱신 중…' : '조회 중…', 'loading');
    setStep('lstep-api'); setProgress(20);
    const data = await fetchData();
    if (!data) return;
    lastData = data;
    // 캐시/직접조회 여부에 따라 오버레이 텍스트 분리 (혼란 방지)
    const loadText2 = document.getElementById('loadText');
    if (loadText2) {
      if (forceRefreshRequested && data.diagnostics?.cacheHit) {
        loadText2.textContent = '서버 캐시 응답 · 화면 구성 중…';
      } else if (data.diagnostics?.cacheHit) {
        loadText2.textContent = '캐시 데이터 적용 중…';
      } else {
        loadText2.textContent = 'API 조회 완료 · 화면 구성 중…';
      }
    }
    setStep('lstep-api', true); setStep('lstep-charts'); setProgress(45);
    safeRender(() => updateBanner(data), 'banner');
    setProgress(60);
    fullRender(data);
    setProgress(100);
    setStep('lstep-charts', true); setStep('lstep-done', true);
    const hhmm = _nowHHMM();
    const wasForced = forceRefreshRequested;
    forceRefreshRequested = false; // 플래그 리셋
    if (wasForced && data.diagnostics?.cacheHit) {
      // 사용자가 새로고침 눌렀지만 서버가 캐시 응답한 경우
      _setRefreshStatus('서버 캐시 응답 · TTL 내 동일 데이터 · ' + hhmm, 'cache');
    } else if (wasForced) {
      _setRefreshStatus('강제 갱신 완료 · ' + hhmm, 'ok');
    } else if (data.diagnostics?.cacheHit) {
      _setRefreshStatus('기간 내 동일 집계 (캐시) · ' + hhmm, 'cache');
    } else {
      _setRefreshStatus('갱신 완료 · ' + hhmm, 'ok');
    }
    setTimeout(() => {
      const ov = document.getElementById('loadingOverlay');
      if (ov) {
        ov.style.opacity = '0';
        // display:none after transition completes (matches .35s CSS transition)
        setTimeout(() => { ov.style.display = 'none'; }, 380);
      }
    }, 600); // 600ms: Chart.js canvas 초기 렌더링 완료 후 전환
    const eb = document.getElementById('errBanner');
    if (eb) eb.style.display = 'none';
    scheduleRefresh();
  } catch (e) {
    console.error('Render error:', e);
    const wasForced2 = forceRefreshRequested;
    forceRefreshRequested = false; // 오류 시에도 플래그 리셋
    _setRefreshStatus(wasForced2 ? '강제 갱신 실패 ⚠' : 'API 실패 ⚠', 'error');
    const eb2 = document.getElementById('errBanner');
    if (eb2) { eb2.style.display = 'flex'; eb2.innerHTML = `<span class="banner-icon"></span><span class="banner-msg">데이터 로드 실패: ${e.message}</span><button onclick="triggerFullReload()" style="margin-left:auto;background:#fff;border:1px solid #be123c;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;color:#be123c;font-weight:700;flex-shrink:0">재시도</button>`; }
    const ov2 = document.getElementById('loadingOverlay');
    if (ov2) { ov2.style.opacity = '0'; setTimeout(() => { ov2.style.display = 'none'; }, 350); }
  }})();
}

/* ─── Silent Refresh (백그라운드 갱신) ──────────────────────────────── */
async function silentRefresh() {
  try {
    _setRefreshStatus('백그라운드 갱신 중…', 'loading');
    const data = await fetchData();
    if (!data) return;
    lastData = data;
    const scoreObj = computeHealthScore(data);
    const insights = generateInsights(data, scoreObj);
    safeRender(() => updateBanner(data), 'banner.silent');
    safeRender(() => renderHealthScore(scoreObj, data), 'healthScore.silent');
    safeRender(() => renderHeroQuickStats(data, scoreObj), 'heroQuickStats.silent');
    safeRender(() => renderHeroDecisionSummary(data, scoreObj), 'heroDecisionSummary.silent');
    safeRender(() => renderHeroAction(data, scoreObj), 'heroAction.silent');
    safeRender(() => renderKPIs(data, scoreObj), 'kpis.silent');
    safeRender(() => renderAlertStrip(data, scoreObj), 'alertStrip.silent');
    safeRender(() => renderInsights(insights), 'insights.silent');
    safeRender(() => renderGaugeGrid(data), 'gaugeGrid.silent');
    safeRender(() => renderTrend(data), 'trend.silent');
    safeRender(() => renderHeatmap(data), 'heatmap.silent');
    safeRender(() => renderTagBar(data), 'tagBar.silent');
    safeRender(() => renderVOC(data), 'voc.silent');
    safeRender(() => renderVocRiskSection(data), 'vocRisk.silent');
    safeRender(() => renderTagRes(data), 'tagRes.silent');
    safeRender(() => renderTagCooccur(data), 'tagCooccur.silent');
    safeRender(() => renderComplaintCategory(data), 'complaintCat.silent');
    safeRender(() => renderCategoryBars(data), 'categoryBars.silent');
    safeRender(() => renderConcRisk(data), 'concRisk.silent');
    safeRender(() => renderMgrRiskStrip(data), 'mgrRiskStrip.silent');
    safeRender(() => renderManagers(data), 'managers.silent');
    safeRender(() => renderMgrQuadrant(data), 'mgrQuad.silent');
    safeRender(() => renderMgrFrtTable(data), 'mgrFrt.silent');
    safeRender(() => renderChannel(data), 'channel.silent');
    safeRender(() => renderResolution(data), 'resolution.silent');
    safeRender(() => renderLongDelayPanel(data), 'longDelay.silent');
    safeRender(() => renderBotsGroups(data), 'botsGroups.silent');
    safeRender(() => renderWow(data), 'wow.silent');
    safeRender(() => renderSLA(data), 'sla.silent');
    safeRender(() => renderFcrPanel(data), 'fcrPanel.silent');
    safeRender(() => renderHourLoad(data), 'hourLoad.silent');
    safeRender(() => renderWeekdayLoad(data), 'weekdayLoad.silent');
    safeRender(() => renderPercentile(data), 'percentile.silent');
    safeRender(() => renderAging(data), 'aging.silent');
    safeRender(() => renderSourcePerf(data), 'sourcePerf.silent');
    safeRender(() => renderAnomaly(data), 'anomaly.silent');
    safeRender(() => renderForecast(data), 'forecast.silent');
    safeRender(() => renderComplaintTrend(data), 'complaintTrend.silent');
    safeRender(() => renderDiagnostics(data), 'diagnostics.silent');
    const hhmm = _nowHHMM();
    if (data.diagnostics?.cacheHit) {
      _setRefreshStatus('기간 내 동일 집계 (캐시) · ' + hhmm, 'cache');
    } else {
      _setRefreshStatus('갱신 완료 · ' + hhmm, 'ok');
    }
    const eb = document.getElementById('errBanner');
    if (eb) eb.style.display = 'none';
  } catch (e) {
    console.warn('Silent refresh failed:', e);
    _setRefreshStatus('갱신 실패 ⚠', 'error');
  }
  scheduleRefresh();
}

/* ─── CSV Helpers ───────────────────────────────────────────────────── */
function _csvEsc(v) {
  // Quote the value if it contains comma, double-quote, or newline
  const s = String(v == null ? '' : v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}
function _csvRow(...cells) { return cells.map(_csvEsc).join(','); }

function _triggerCSV(csvLines, filename) {
  const BOM = '﻿';
  const blob = new Blob([BOM + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  // 다운로드 핸드오프 전에 URL을 해제하면 일부 브라우저에서 파일 생성이 누락될 수 있음.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _csvHeader() {
  const dateStr  = new Date().toLocaleString('ko-KR');
  const rangeStr = currentDays === 'all' ? '전체(최대 1000건)' : `최근 ${currentDays}일`;
  const total    = lastData?.summary?.totalChats ?? '?';
  // 활성 필터 목록 문자열 생성
  let filterInfo = '';
  if (activeFilterCount() > 0) {
    const mgrMap = {};
    (lastData?.managers || []).forEach((m) => { mgrMap[String(m.id)] = m.name.replace('오토스테이_',''); });
    const srcMap = { native: '인앱', phone: '전화', other: '기타' };
    const parts = [];
    filterState.managers.forEach((id) => parts.push(`담당:${mgrMap[id] || id}`));
    filterState.tags.forEach((t) => parts.push(`#${t}`));
    filterState.sources.forEach((s) => parts.push(`채널:${srcMap[s] || s}`));
    filterInfo = ` · 필터(${parts.join(' ')})`;
  }
  return [
    `# 오토스테이 CS 대시보드 내보내기 — ${dateStr}`,
    `# 기간: ${rangeStr} · 분석 채팅: ${total}건${filterInfo}`,
    '',
  ];
}

/* ─── CSV Download ──────────────────────────────────────────────────── */
function downloadCSV() {
  if (!lastData) { showToast('데이터 없음 — 먼저 대시보드를 로드하세요', 'warn'); return; }
  const exportData = lastFilteredData || lastData;
  const managers  = (exportData.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total     = exportData.summary.totalChats || 1;
  const rb        = exportData.resolutionBuckets || {};
  const rbTotal   = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const tags      = exportData.tags || {};
  const tagResStats  = exportData.tagResolutionStats || [];
  const sourceStats  = exportData.sourceStats || [];
  const aging        = exportData.agingBuckets || {};
  const slaStats     = exportData.slaStats || {};

  const mgrRows = managers.map((m, i) => {
    const pct     = Math.round(m.count / total * 100);
    const comment = agentComment(m, i).replace(/<[^>]*>/g, '');
    return _csvRow(
      m.name.replace('오토스테이_',''), m.count, `${pct}%`,
      m.operatorScore ?? '', m.touchScore ?? '',
      m.avgFrtMin ?? '', m.medianFrtMin ?? '',
      m.avgResolutionMin ?? '', m.medianResolutionMin ?? '', m.p90ResolutionMin ?? '',
      m.complaintHandled ?? '', comment
    );
  });

  const rbRows  = Object.entries(rb).map(([k, v]) => _csvRow(k, v, `${Math.round(v / rbTotal * 100)}%`));
  const tagRows = (tags.labels || []).map((lbl, i) => {
    const cnt = tags.values[i]; const pct = Math.round(cnt / total * 100);
    return _csvRow(lbl, cnt, `${pct}%`, pct >= 15 ? '위험' : pct >= 8 ? '주의' : '정상');
  });
  const tagResRows = tagResStats.map(s => _csvRow(s.tag, s.count, s.avg ?? '', s.median ?? '', s.p90 ?? ''));
  const srcRows    = sourceStats.filter(s => s.count > 0)
    .map(s => _csvRow(s.source, s.count, s.avgResolutionMin ?? '', s.medianResolutionMin ?? '', s.p90ResolutionMin ?? ''));
  const agingRows = [
    _csvRow('<8h', aging.lt8h || 0), _csvRow('8-24h', aging.h8_24 || 0),
    _csvRow('1-3d', aging.d1_3 || 0), _csvRow('3-7d', aging.d3_7 || 0), _csvRow('7d+', aging.d7plus || 0),
  ];
  const slaRows = [
    _csvRow('30분 SLA', `${slaStats.sla30Min?.rate || 0}%`, `${slaStats.sla30Min?.count || 0}/${slaStats.sla30Min?.total || 0}`),
    _csvRow('2시간 SLA', `${slaStats.sla2Hour?.rate || 0}%`, `${slaStats.sla2Hour?.count || 0}/${slaStats.sla2Hour?.total || 0}`),
    _csvRow('8시간 SLA', `${slaStats.sla8Hour?.rate || 0}%`, `${slaStats.sla8Hour?.count || 0}/${slaStats.sla8Hour?.total || 0}`),
  ];

  // 컴플레인 추이 (있으면)
  const ct = exportData.complaintTrend;
  const ctRows = ct?.labels?.length
    ? ct.labels.map((lbl, i) => _csvRow(
      lbl,
      ct.complaints[i] || 0,
      ct.total[i] || 0,
      `${Math.round((ct.complaints[i] || 0) / (ct.total[i] || 1) * 100)}%`,
    ))
    : [];

  const lines = [
    ..._csvHeader(),
    '=== SLA 준수율 ===',
    'SLA,준수율,건수',
    ...slaRows,
    '',
    '=== 담당자 성과 ===',
    '담당자명,처리,비중,운영점수,응대점수,FRT평균(분),FRT중앙값(분),해결평균(분),해결중앙값(분),해결P90(분),컴플레인,코멘트',
    ...mgrRows,
    '',
    '=== 해결시간 분포 ===',
    '구간,건수,비율',
    ...rbRows,
    '',
    '=== 에이징 파이프라인 ===',
    '구간,건수',
    ...agingRows,
    '',
    '=== VOC 태그 ===',
    '태그,건수,비율,리스크',
    ...tagRows,
    '',
    '=== 태그별 해결시간 ===',
    '태그,건수,평균(분),P50(분),P90(분)',
    ...tagResRows,
    '',
    '=== 채널별 성능 ===',
    '채널,건수,평균(분),P50(분),P90(분)',
    ...srcRows,
    ...(ctRows.length ? ['', '=== 일별 컴플레인 추이 ===', '날짜,컴플레인,전체,비율', ...ctRows] : []),
  ];

  const rangeStr = currentDays === 'all' ? 'all' : `${currentDays}d`;
  const filterSuffix = activeFilterCount() > 0 ? `-filtered` : '';
  // 파일명: 기간·필터·생성시각(YYYYMMDD-HHMM) 포함
  const _now = new Date();
  const _dateStr = _now.toISOString().slice(0, 10).replace(/-/g, '');
  const _hhmm = String(_now.getHours()).padStart(2, '0') + String(_now.getMinutes()).padStart(2, '0');
  const csvFilename = `OPS-channeltalk-${rangeStr}${filterSuffix}-${_dateStr}-${_hhmm}.csv`;
  _triggerCSV(lines, csvFilename);
  const dlRangeLabel = currentDays === 'all' ? '전체 기간' : `최근 ${currentDays}일`;
  const dlFilterLabel = activeFilterCount() > 0 ? ` · 필터 ${activeFilterCount()}개` : '';
  const dlRowCount = exportData.summary?.totalChats ?? '?';
  showToast(`CSV 내보내기 완료 · 전체 기준 ${dlRowCount}건${dlFilterLabel} · ${dlRangeLabel}`, 'success', 5000);
}

async function copyOpsReport() {
  const d = lastData;
  if (!d) { showToast('복사할 데이터가 아직 없습니다', 'info'); return; }
  const scoreObj = computeHealthScore(d);
  const unknown = getUnknownTagStats(d);
  const sample = getResolutionSampleStats(d);
  const history = getDurableHistoryStatus(d);
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const slow8h = rb['8시간+'] || 0;
  const complaints = (d.complaintTrend?.complaints || []).reduce((a, b) => a + b, 0);
  const total = d.summary?.totalChats || 0;
  const complaintRate = total ? Math.round(complaints / total * 100) : 0;
  const report = [
    `[OPS] 채널톡 CS 대시보드 요약`,
    `기간: ${currentDays === 'all' ? '전체' : `최근 ${currentDays}일`} · 총 ${total}건 · 건강점수 ${scoreObj.score}점`,
    `오픈 ${d.summary?.openChats || 0}건 · 미배정 ${d.summary?.unassignedChats || 0}건 · 장기지연 ${slow8h}/${resTotal}건(${Math.round(slow8h / resTotal * 100)}%)`,
    `컴플레인 ${complaints}건(${complaintRate}%) · FRT ${d.frtStats?.median != null ? fmtMin(d.frtStats.median) : '—'} · FCR ${d.fcrStats?.fcrRate != null ? `${d.fcrStats.fcrRate}%` : '측정 불가(재오픈 이력 미수집)'}`,
    `데이터 신뢰도: VOC 미분류 ${unknown.pct}%(${unknown.count}/${unknown.total}) · 해결시간 n=${sample.n} ${sample.label} · ${history.label}`,
    `주의: 자동 태깅 ${d.taggingQuality?.autoTaggingAvailable ? '활성' : '미구현/본문 미수집'} · 순수 상담원 처리시간 ${d.resolutionStats?.agentHandleTimeAvailable ? '활성' : '미수집'}`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(report);
    showToast('운영 리포트를 클립보드에 복사했습니다', 'success');
  } catch (_) {
    showToast('브라우저 권한 문제로 복사하지 못했습니다', 'error');
  }
}

/* ─── Collapsibles ──────────────────────────────────────────────────── */
function initCollapsibles() {
  document.querySelectorAll('.collapse-toggle').forEach(btn => {
    const toggle = () => {
      const content = document.getElementById(btn.dataset.target);
      if (!content) return;
      const isHidden = content.classList.toggle('hidden');
      btn.classList.toggle('collapsed', isHidden);
      btn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
      // If there's a dedicated toggle arrow child, update only that
      const arrowEl = btn.querySelector('.adv-toggle');
      if (arrowEl) {
        arrowEl.textContent = isHidden ? '▸' : '▾';
      } else {
        btn.textContent = isHidden ? '▸' : '▾';
      }
      // 모바일: 고도화 섹션 열릴 때 내부 패널 아코디언 초기화
      if (!isHidden && btn.dataset.target === 'advContent') {
        _initAdvPanelAccordions();
      }
    };
    btn.addEventListener('click', toggle);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

function initSectionNavigation() {
  const nav = document.querySelector('.section-anchor-nav');
  if (!nav) return;

  const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
  const entries = links.map((link) => ({
    link,
    section: document.querySelector(link.getAttribute('href'))
  })).filter((entry) => entry.section);

  const setActive = (activeLink) => {
    entries.forEach(({ link }) => {
      const isActive = link === activeLink;
      link.classList.toggle('active', isActive);
      if (isActive) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };

  const revealAdvancedSection = (section) => {
    const advancedContent = section.closest('#advContent');
    if (!advancedContent || !advancedContent.classList.contains('hidden')) return;
    advancedContent.classList.remove('hidden');
    const toggle = document.querySelector('[data-target="advContent"]');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'true');
      const arrow = toggle.querySelector('.adv-toggle');
      if (arrow) arrow.textContent = '▾';
    }
    _initAdvPanelAccordions();
  };

  entries.forEach(({ link, section }) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      revealAdvancedSection(section);
      setActive(link);
      requestAnimationFrame(() => {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', link.getAttribute('href'));
        setTimeout(() => setActive(link), 900);
      });
    });
  });

  if (!('IntersectionObserver' in window)) {
    setActive(entries[0]?.link);
    return;
  }

  const observer = new IntersectionObserver((observed) => {
    const visible = observed
      .filter((item) => item.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const match = entries.find(({ section }) => section === visible.target);
    if (match) setActive(match.link);
  }, { rootMargin: '-132px 0px -60% 0px', threshold: [0, 0.15, 0.4] });

  entries.forEach(({ section }) => observer.observe(section));
  setActive(entries[0]?.link);
}

/* ─── Events / DOMContentLoaded ─────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // 새로고침 버튼
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.addEventListener('click', () => triggerFullReload());

  // 기간 탭
  document.querySelectorAll('.range-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const range = tabBtn.dataset.days || tabBtn.dataset.range;
      document.querySelectorAll('.range-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-pressed', 'false'); });
      tabBtn.classList.add('active');
      tabBtn.setAttribute('aria-pressed', 'true');
      currentDays = range === 'all' ? 'all' : parseInt(range);
      // 기간이 바뀌면 이전 기간에서 선택한 목록 필터를 제거해 범위 혼선을 방지한다.
      filterState.managers.clear();
      filterState.tags.clear();
      filterState.sources.clear();
      lastFilteredData = null;
      updateFilterBadges();
      // 기간 변경 시 집계 기준 안내 toast
      const rangeLabel = range === 'all' ? '전체 기간 (최대 1000건)' : `최근 ${range}일`;
      showToast(`${rangeLabel} 기준 조회 · 실제 데이터 범위가 같으면 핵심 지표도 동일합니다`, 'info', 3600);
      // 기간 전환 즉시 basis header + hero inline meta를 업데이트하여 버튼 상태와 표시 기간이 일치하도록 함
      const newRangeText = range === 'all' ? '전체 기간' : `최근 ${range}일`;
      const kpiHeaderEl = document.getElementById('kpiBasisHeader');
      if (kpiHeaderEl) {
        kpiHeaderEl.innerHTML = `<span>분석 기준</span><span style="font-weight:400;color:var(--muted)"><em>${newRangeText} · 조회 중…</em></span>`;
      }
      // hero inline meta 기간 텍스트도 즉시 업데이트 (이전 기간 텍스트가 남지 않도록)
      const himRangeEl = document.getElementById('himRange');
      if (himRangeEl) himRangeEl.textContent = newRangeText;
      // 이전 기간 데이터 즉시 클리어 — 스켈레톤/빈 상태로 교체
      clearPeriodUI(range);
      triggerFullReload(false);
    });
  });

  // 모달 접근성 (ESC 닫기, 포커스 트랩)
  initModalAccessibility();

  // CSV 다운로드
  const csvBtn = document.getElementById('csvDownloadBtn');
  if (csvBtn) csvBtn.addEventListener('click', downloadCSV);
  const reportBtn = document.getElementById('reportCopyBtn');
  if (reportBtn) reportBtn.addEventListener('click', copyOpsReport);

  // 롱챗 모달 배경 클릭 닫기
  const modal = document.getElementById('longChatsModal');
  if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeLongChatsPanel(); });

  // data-action 이벤트 위임
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'open-long-chats') { openLongChatsPanel(); return; }
    if (action === 'trigger-reload') { triggerFullReload(); return; }
  });

  initCollapsibles();
  initSectionNavigation();
  initFilterDrawer();
  initSlaTargetControls();
  initMobileAccordions();
  initTooltips();
  initTabs();
});

/* ─── Custom Tooltip System (data-tip) ──────────────────── */
function initTooltips() {
  let tipEl = document.getElementById('__ctip');
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = '__ctip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.setAttribute('aria-live', 'polite');
    tipEl.style.cssText = 'position:fixed;z-index:99990;background:#1e293b;color:#f8fafc;font-size:11.5px;line-height:1.45;padding:6px 10px;border-radius:6px;max-width:280px;pointer-events:none;opacity:0;transition:opacity .15s;box-shadow:0 4px 14px rgba(0,0,0,.3);white-space:pre-wrap;display:none';
    document.body.appendChild(tipEl);
  }
  let activeTarget = null;
  /* data-tip 또는 title 속성 중 사용 가능한 툴팁 텍스트 반환 */
  function getTipMsg(el) {
    return el.getAttribute('data-tip') || el.getAttribute('title') || null;
  }
  /* title 속성을 가진 요소: 네이티브 툴팁 억제 후 커스텀 처리 */
  function suppressNativeTitle(el) {
    if (el.hasAttribute('title') && !el.hasAttribute('data-tip')) {
      el.setAttribute('data-tip', el.getAttribute('title'));
      el.removeAttribute('title');
    }
  }
  let _hideTimer = null;
  function showTip(el) {
    suppressNativeTitle(el);
    const msg = getTipMsg(el);
    if (!msg) return;
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    activeTarget = el;
    tipEl.textContent = msg;
    tipEl.style.display = 'block';
    tipEl.style.opacity = '0';
    // double rAF ensures layout is complete before measuring offsetWidth
    requestAnimationFrame(() => requestAnimationFrame(() => {
      posTip(el);
      tipEl.style.opacity = '1';
    }));
  }
  function hideTip() {
    _hideTimer = setTimeout(() => {
      tipEl.style.opacity = '0';
      setTimeout(() => { if (tipEl.style.opacity === '0') tipEl.style.display = 'none'; }, 160);
      activeTarget = null;
      _hideTimer = null;
    }, 80); // 80ms debounce prevents flicker on element boundary
  }
  function posTip(el) {
    const r = el.getBoundingClientRect();
    const tw = tipEl.offsetWidth || 200, th = tipEl.offsetHeight || 30;
    let top = r.top - th - 8, left = r.left + r.width / 2 - tw / 2;
    if (top < 8) top = r.bottom + 8;
    if (left < 8) left = 8;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    tipEl.style.top = top + 'px';
    tipEl.style.left = left + 'px';
  }
  /* title 속성을 가진 요소를 미리 변환 (DOM 로드 후 + 렌더링 후 자동 적용) */
  function convertTitleAttrs(root) {
    (root || document).querySelectorAll('[title]:not([data-tip])').forEach(suppressNativeTitle);
  }
  // 초기 변환 + MutationObserver로 동적 렌더링 후에도 변환
  convertTitleAttrs(document);
  const mo = new MutationObserver((muts) => {
    muts.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType === 1) {
        suppressNativeTitle(n);
        convertTitleAttrs(n);
      }
    }));
  });
  mo.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]') || e.target.closest('[title]');
    if (el) { suppressNativeTitle(el); showTip(el); }
  });
  document.addEventListener('mouseout', (e) => {
    const stillOn = e.relatedTarget && (e.relatedTarget.closest('[data-tip]') || e.relatedTarget.closest('[title]'));
    if (!stillOn) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]') || e.target.closest('[title]');
    if (el) { suppressNativeTitle(el); showTip(el); }
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el !== activeTarget) { showTip(el); return; }
    if (!el) hideTip();
  });
}

/* ─── Full Reload ───────────────────────────────────────────────────────────────── */
/* ─── 기간 전환 시 이전 데이터 즉시 클리어 (P0) ──────────────────────── */
function clearPeriodUI(range) {
  // KPI 그리드: 스켈레톤 카드로 교체 (이전 기간 수치가 보이지 않도록)
  const _skCard = `
    <div class="kpi-card skeleton-card" style="pointer-events:none">
      <div style="background:var(--border);border-radius:4px;height:9px;width:55%;margin-bottom:11px"></div>
      <div style="background:#e8eaed;border-radius:6px;height:26px;width:45%;margin-bottom:9px"></div>
      <div style="background:var(--border);border-radius:3px;height:8px;width:65%"></div>
    </div>`;
  const kpiGrid = document.getElementById('kpiGrid');
  if (kpiGrid) kpiGrid.innerHTML = _skCard.repeat(3);
  const kpiGridSec = document.getElementById('kpiGridSecondary');
  if (kpiGridSec) {
    kpiGridSec.className = 'ops-status-rail is-loading';
    kpiGridSec.innerHTML = `
      <div class="ops-status-skeleton"></div>
      <div class="ops-status-skeleton"></div>
      <div class="ops-status-skeleton"></div>
      <div class="ops-status-skeleton"></div>`;
  }
  // 오늘 처리할 일: 로딩 메시지로 교체
  const hacBody = document.getElementById('hacBody');
  if (hacBody) {
    const rl = range === 'all' ? '전체 기간' : `최근 ${range}일`;
    hacBody.innerHTML = `<div style="padding:14px 16px;text-align:center;color:var(--muted);font-size:12px">${rl} 데이터 불러오는 중…</div>`;
  }
  // hero 인라인 메타 수치 초기화 (이전 기간 숫자 제거 → 새 기간 데이터로 오인 방지)
  ['himTotal', 'himFrt', 'himFcr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  const heroMeta = document.getElementById('heroInlineMeta');
  if (heroMeta) heroMeta.style.opacity = '0.5';
  // 게이지·차트·인사이트 섹션 dim (이전 기간 수치가 눈에 띄지 않도록)
  [
    document.querySelector('.health-gauge-row'),
    document.querySelector('.chart-master-grid'),
    document.getElementById('insightsStrip'),
    document.getElementById('kpiBasisHeader'),
  ].forEach(el => {
    if (el) { el.style.opacity = '0.2'; el.style.pointerEvents = 'none'; }
  });
  // filterScopeNote 숨김 (기간 전환 시 이전 필터 안내 불일치 방지)
  const scopeNote = document.getElementById('filterScopeNote');
  if (scopeNote) scopeNote.style.display = 'none';

  // 게이지 수치 텍스트 즉시 '—'로 초기화 (이전 기간 수치가 dim 아래 잔존하지 않도록)
  ['gval-quick','gval-slow','gval-frt','gval-fcr','gval-conc'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  ['gsub-quick','gsub-slow','gsub-frt','gsub-fcr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  const gsubConc = document.getElementById('gsubConc');
  if (gsubConc) gsubConc.textContent = '—';
}

function triggerFullReload(force = true) {
  forceRefreshRequested = force;
  const ov = document.getElementById('loadingOverlay');
  if (ov) { ov.style.opacity = '1'; ov.style.display = 'flex'; }
  const loadText = document.getElementById('loadText');
  if (loadText) loadText.textContent = force ? '강제 갱신 중…' : '기간 데이터 조회 중…';
  ['lstep-conn','lstep-api','lstep-charts','lstep-done'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active','done');
  });
  const connStep = document.getElementById('lstep-conn');
  if (connStep) connStep.classList.add('done');
  setProgress(5);
  render();
}

(async function boot() {
  const ok = await ensureAuthenticated();
  if (ok) render();
})();
