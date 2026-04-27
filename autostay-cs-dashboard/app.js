// Autostay CS Dashboard — app.js  v3.1
// 14개 항목 반영: 담당자별 해결시간, CS점수 감점 요인, 컴플레인 분리,
// 8시간+ drill-down, 피크 분석, 실패 상태, CSV 다운로드, VOC 표현 등

'use strict';

/* ─── Constants ─────────────────────────────────────────────────────────── */
const COLORS = [
  '#0f766e','#be123c','#14b8a6','#3b82f6','#8b5cf6',
  '#f59e0b','#0369a1','#e11d48','#6d28d9','#0d9488'
];
const AVATAR_COLORS = [
  '#0f766e,#14b8a6','#1d4ed8,#3b82f6','#b45309,#f59e0b',
  '#be123c,#f43f5e','#6d28d9,#8b5cf6','#0369a1,#0ea5e9','#059669,#34d399'
];
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

/* ─── Chart.js Defaults ─────────────────────────────────────────────────── */
Chart.defaults.font.family = "'Pretendard Variable', Pretendard, sans-serif";
Chart.defaults.color = '#78716c';
Chart.defaults.borderColor = '#f1efe8';

let charts = {};
let lastData = null;
let currentDays = 30;
let refreshTimer = null;
let lastSuccessTime = null; // 항목 #10: 마지막 성공 동기화 시각

/* ─── Loading Helpers ───────────────────────────────────────────────────── */
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

/* ─── Formatters ────────────────────────────────────────────────────────── */
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

/* ─── CS Health Score ───────────────────────────────────────────────────── */
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
  if (complaintRate > 0.20)      deductComplaint = 25;
  else if (complaintRate > 0.15) deductComplaint = 18;
  else if (complaintRate > 0.10) deductComplaint = 10;
  else if (complaintRate > 0.05) deductComplaint = 4;
  score -= deductComplaint;

  const slowRate = (rb['8시간+'] || 0) / resTotal;
  const medRate  = (rb['2~8시간'] || 0) / resTotal;
  let deductSlow = 0;
  if (slowRate > 0.50)      deductSlow = 20;
  else if (slowRate > 0.35) deductSlow = 14;
  else if (slowRate > 0.20) deductSlow = 8;
  if (medRate > 0.30)       deductSlow += 5;
  score -= deductSlow;

  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  let deductConc = 0;
  if (managers.length > 0) {
    const topPct = (managers[0].count || 0) / total;
    if (topPct > 0.85)      deductConc = 20;
    else if (topPct > 0.70) deductConc = 12;
    else if (topPct > 0.55) deductConc = 5;
  }
  score -= deductConc;

  const quickRate = ((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal;
  if (quickRate > 0.50)      score += 10;
  else if (quickRate > 0.30) score += 5;

  if (d.summary.openChats > 10) score -= 5;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    deductComplaint,
    deductSlow,
    deductConc,
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

/* ─── Auto-Insights ─────────────────────────────────────────────────────── */
function generateInsights(d, scoreObj) {
  const score = scoreObj.score;
  const insights = [];
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));

  const complaintPct = scoreObj.complaintPct;
  if (complaintPct >= 15) {
    insights.push({ type: 'danger', icon: '경고', text: `컴플레인 ${complaintPct}% — 즉각 대응 필요` });
  } else if (complaintPct >= 8) {
    insights.push({ type: 'warn', icon: '주의', text: `컴플레인 ${complaintPct}% — 주의 모니터링` });
  }

  if (managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    if (topPct > 80) {
      insights.push({ type: 'danger', icon: '집중', text: `${managers[0].name} 집중도 ${topPct}% — 번아웃 위험` });
    } else if (topPct > 60) {
      insights.push({ type: 'warn', icon: '분산', text: `${managers[0].name} 집중도 ${topPct}% — 분산 권장` });
    }
  }

  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 40) {
    insights.push({ type: 'warn', icon: '지연', text: `8시간+ 해결 ${slowPct}% — 비동기 정책 검토` });
  }

  const quickPct = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);
  if (quickPct >= 40) {
    insights.push({ type: 'good', icon: '양호', text: `30분 내 해결 ${quickPct}% — 신속 대응 양호` });
  }

  const subIdx = (d.tags?.labels || []).findIndex(l => l.includes('정기구독'));
  if (subIdx >= 0) {
    const subPct = Math.round((d.tags.values[subIdx] || 0) / total * 100);
    if (subPct >= 25) {
      insights.push({ type: 'info', icon: '자동화', text: `구독 관련 문의 ${subPct}% — 자동화 플로우 점검` });
    }
  }

  if (d.summary.openChats > 0) {
    insights.push({ type: 'warn', icon: '대기', text: `미해결 오픈 채팅 ${d.summary.openChats}건` });
  } else {
    insights.push({ type: 'good', icon: '완료', text: '현재 미해결 채팅 없음' });
  }

  const vals = (d.dailyTrend?.values || []).filter(v => v > 0);
  if (vals.length > 3) {
    const peak = Math.max(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (peak > avg * 3) {
      insights.push({ type: 'info', icon: '피크', text: `${d.summary.peakDay?.label} 피크 (${peak}건 · 평균 ${Math.round(avg)}건 대비)` });
    }
  }

  return insights;
}

/* ─── Render: Health Score + 감점 요인 (항목 #4) ───────────────────────── */
function renderHealthScore(scoreObj, d) {
  const { score, deductComplaint, deductSlow, deductConc, complaintPct, slowPct, topPct } = scoreObj;
  const { grade, label, color } = getGrade(score);

  const arcLen = 188.5;
  const fill = document.getElementById('gaugeFill');
  if (fill) {
    fill.style.stroke = color;
    fill.style.strokeDashoffset = arcLen;
    requestAnimationFrame(() => {
      setTimeout(() => {
        fill.style.strokeDashoffset = arcLen - (arcLen * score / 100);
      }, 200);
    });
  }

  const sv = document.getElementById('healthScore');
  if (sv) { sv.textContent = score; sv.setAttribute('fill', color); }

  const sg = document.getElementById('healthGrade');
  if (sg) { sg.textContent = `${grade} · ${label}`; sg.style.color = color; }

  // 감점 요인 표시
  const ss = document.getElementById('healthSub');
  if (ss) {
    const factors = [];
    if (deductComplaint > 0) factors.push(`컴플레인율 ${complaintPct}% (-${deductComplaint}점)`);
    if (deductSlow > 0)      factors.push(`8시간+ ${slowPct}% (-${deductSlow}점)`);
    if (deductConc > 0)      factors.push(`집중도 ${topPct}% (-${deductConc}점)`);
    ss.innerHTML = factors.length
      ? `<span class="health-factor-list">${factors.map(f => `<span class="hf">${f}</span>`).join('')}</span>`
      : '<span style="color:var(--green)">감점 요인 없음</span>';
  }
}

/* ─── Render: Insights Strip ────────────────────────────────────────────── */
function renderInsights(insights) {
  const strip = document.getElementById('insightsStrip');
  if (!strip) return;
  if (!insights.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = `
    <div class="insights-label">자동 인사이트</div>
    ${insights.map(ins => `
      <div class="insight-chip ${ins.type}">
        <span class="insight-icon insight-label-badge">${ins.icon}</span>
        <span>${ins.text}</span>
      </div>
    `).join('')}
  `;
}

/* ─── Render: Alert Strip ───────────────────────────────────────────────── */
function renderAlertStrip(d, scoreObj) {
  const score = scoreObj.score;
  const strip = document.getElementById('alertStrip');
  if (!strip) return;
  const alerts = [];
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));

  if (managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    if (topPct > 70) {
      alerts.push({
        level: 'danger', icon: '과부하',
        title: '담당자 과부하',
        body: `${managers[0].name}이(가) 전체 ${topPct}% (${managers[0].count}건) 단독 처리 중. 업무 분산 필요.`
      });
    }
  }

  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintPct = Math.round(complaints / total * 100);
  if (complaintPct >= 15) {
    alerts.push({
      level: 'danger', icon: '긴급',
      title: '컴플레인 급증',
      body: `컴플레인 태그 ${complaintPct}% (${complaints}건) — 서비스 품질 즉시 점검 권장.`
    });
  }

  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 40) {
    alerts.push({
      level: 'warn', icon: '지연',
      title: '장시간 미해결 다수',
      body: `전체의 ${slowPct}%가 8시간 이상 소요. 비동기 응답 정책 검토 권장.`
    });
  }

  if (score < 50) {
    alerts.push({
      level: 'danger', icon: 'D등급',
      title: 'CS 건강 위험 단계',
      body: `CS 건강 점수 ${score}점 — 복합 위험 상태. 긴급 CS 운영 개선 필요.`
    });
  }

  if (!alerts.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = alerts.map(a => `
    <div class="alert-item ${a.level}">
      <div class="al-icon al-label-badge">${a.icon}</div>
      <div class="al-text">
        <div class="al-title">${a.title}</div>
        <div class="al-body">${a.body}</div>
      </div>
    </div>
  `).join('');
}

/* ─── Render: Action Command Center ────────────────────────────────────── */
function renderActionCenter(d, scoreObj, insights) {
  const score = scoreObj.score;
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));

  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintPct = Math.round(complaints / total * 100);
  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  const quickPct = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);

  // ── 카드 1: 오늘 조치할 항목 ──
  const todayItems = [];

  if (d.summary.openChats > 0) {
    todayItems.push({
      type: 'danger', label: '즉시',
      title: `미해결 오픈 채팅 ${d.summary.openChats}건`,
      desc: '즉시 확인 및 응답 필요 — 고객 대기 중'
    });
  }
  if (complaintPct >= 15) {
    todayItems.push({
      type: 'danger', label: '긴급',
      title: `컴플레인 ${complaintPct}% (${complaints}건)`,
      desc: '서비스 불만 급증 — 원인 파악 및 즉시 대응'
    });
  } else if (complaintPct >= 8) {
    todayItems.push({
      type: 'warn', label: '주의',
      title: `컴플레인 ${complaintPct}% (${complaints}건)`,
      desc: '지속 모니터링 — 추이 관찰 권장'
    });
  }
  if (managers.length > 0) {
    const topPct2 = Math.round((managers[0].count || 0) / total * 100);
    if (topPct2 > 70) {
      todayItems.push({
        type: 'danger', label: '분산필요',
        title: `${managers[0].name} 집중도 ${topPct2}%`,
        desc: '단독 처리 과부하 — 담당자 추가 배정 검토 · 재배정 큐 확인'
      });
    }
  }
  // 8시간+ 건이 많으면 drill-down 안내 (항목 #7 연계)
  if ((rb['8시간+'] || 0) > 0) {
    todayItems.push({
      type: 'info', label: '확인',
      title: `8시간+ 미해결 ${rb['8시간+'] || 0}건`,
      desc: `<a class="ac-drill-link" href="#" onclick="openLongChatsPanel();return false;">▸ 상세 목록 보기 (날짜·태그·담당자)</a>`
    });
  }

  if (todayItems.length === 0) {
    todayItems.push({ type: 'good', label: '정상', title: '조치 필요 항목 없음', desc: 'CS 상태 양호 — 정기 모니터링 유지' });
  }

  const countEl = document.getElementById('acTodayCount');
  const urgentCount = todayItems.filter(i => i.type === 'danger').length;
  if (countEl) {
    if (urgentCount > 0) { countEl.textContent = urgentCount; countEl.style.display = 'inline-flex'; }
    else                 { countEl.style.display = 'none'; }
  }

  const todayBody = document.getElementById('acTodayBody');
  if (todayBody) {
    todayBody.innerHTML = todayItems.map(item => `
      <div class="ac-item ${item.type}">
        <div class="ac-item-icon ac-label-badge">${item.label}</div>
        <div class="ac-item-text">
          <div class="ac-item-title">${item.title}</div>
          <div class="ac-item-desc">${item.desc}</div>
        </div>
      </div>
    `).join('');
  }

  // ── 카드 2: 주요 리스크 TOP 3 ──
  const riskItems = [];
  if (score < 50) riskItems.push({ type: 'danger', label: 'D등급', title: `CS 건강 D등급 (${score}점)`, desc: '복합 위험 상태 — 긴급 CS 운영 점검 필요' });
  if (complaintPct >= 10) riskItems.push({ type: 'danger', label: '불만', title: `컴플레인율 ${complaintPct}%`, desc: '서비스 품질 하락 신호 — 즉시 대응' });
  if (slowPct > 30) riskItems.push({ type: 'warn', label: '지연', title: `8시간+ 해결 ${slowPct}%`, desc: '비동기 채팅 관리 정책 점검 필요' });
  if (managers.length > 0) {
    const topRisk = Math.round((managers[0].count || 0) / total * 100);
    if (topRisk > 60) riskItems.push({ type: 'warn', label: '집중', title: `${managers[0].name} 집중 ${topRisk}%`, desc: '업무 분산 및 백업 담당자 지정 권장' });
  }
  if (d.summary.openChats > 5) riskItems.push({ type: 'warn', label: '대기', title: `미응답 오픈 ${d.summary.openChats}건`, desc: '고객 대기 장기화 — 우선 처리 필요' });
  if (quickPct < 20) riskItems.push({ type: 'warn', label: '속도', title: `30분 내 해결 ${quickPct}%`, desc: '응답 속도 개선 필요 — SLA 기준 수립 권장' });

  const topRisks = riskItems.slice(0, 3);
  if (topRisks.length === 0) topRisks.push({ type: 'good', label: '정상', title: '주요 리스크 없음', desc: 'CS 지표 정상 범위 유지 중' });

  const riskBody = document.getElementById('acRiskBody');
  if (riskBody) {
    riskBody.innerHTML = topRisks.map(item => `
      <div class="ac-item ${item.type}">
        <div class="ac-item-icon ac-label-badge">${item.label}</div>
        <div class="ac-item-text">
          <div class="ac-item-title">${item.title}</div>
          <div class="ac-item-desc">${item.desc}</div>
        </div>
      </div>
    `).join('');
  }

  // ── 카드 3: VOC 알림 ──
  const { tags } = d;
  const vocBadge = document.getElementById('acVocBadge');
  const vocBody  = document.getElementById('acVocBody');

  const risingTags = (tags?.labels || [])
    .map((lbl, i) => ({ lbl, cnt: tags.values[i] || 0, pct: Math.round((tags.values[i] || 0) / total * 100) }))
    .filter(t => t.pct >= 10)
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 4);

  if (vocBadge) {
    const urgentVoc = risingTags.filter(t => t.pct >= 15).length;
    vocBadge.textContent = urgentVoc > 0 ? `${urgentVoc}건 긴급` : `${risingTags.length}건 주목`;
    vocBadge.className = urgentVoc > 0 ? 'ac-count' : 'ac-badge';
  }

  if (vocBody) {
    if (!risingTags.length) {
      vocBody.innerHTML = '<div class="ac-empty">10% 이상 VOC 없음 — 분산 분포 양호</div>';
    } else {
      vocBody.innerHTML = risingTags.map(t => {
        const ctx  = VOC_CONTEXTS[t.lbl] || '관련 문의';
        const type = t.pct >= 15 ? 'danger' : 'warn';
        const lbl  = t.lbl.includes('컴플레인') ? '불만' : t.lbl.includes('구독') ? '구독' : t.lbl.includes('탈퇴') ? '탈퇴' : '문의';
        return `
          <div class="ac-item ${type}">
            <div class="ac-item-icon ac-label-badge">${lbl}</div>
            <div class="ac-item-text">
              <div class="ac-item-title">#${t.lbl} · ${t.pct}% (${t.cnt}건)</div>
              <div class="ac-item-desc">${ctx}</div>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

/* ─── Render: KPI Grid (항목 #2 — 데이터 수집 기준 명시) ──────────────── */
function renderKPIs(d) {
  const { summary } = d;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const topMgr   = managers[0];
  const totalChats  = summary.totalChats;
  const openChats   = summary.openChats;
  const avgRes      = summary.avgResolutionMin;
  const peakCount   = summary.peakDay?.count || 0;
  const peakLabel   = summary.peakDay?.label || '—';
  const topPct      = topMgr ? Math.round((topMgr.count / totalChats) * 100) : 0;
  const rb          = d.resolutionBuckets || {};
  const resTotal    = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quickPct    = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);

  const TARGET_AVG_MIN  = 120;
  const TARGET_QUICK_PCT = 60;
  const avgResFill  = avgRes != null ? Math.min(Math.round((TARGET_AVG_MIN / Math.max(avgRes, 1)) * 100), 100) : 0;
  const avgResClass = avgRes != null && avgRes <= TARGET_AVG_MIN ? '' : avgRes <= TARGET_AVG_MIN * 1.5 ? 'warn' : 'danger';
  const quickFill   = Math.min(quickPct, 100);
  const quickClass  = quickPct >= TARGET_QUICK_PCT ? '' : quickPct >= TARGET_QUICK_PCT * 0.7 ? 'warn' : 'danger';

  // 수집 기준 문구 (항목 #1 — 탭 명칭, #2 — 기준 명시)
  const rangeLabel = currentDays === 'all' ? `최근 ${d.totalCollected || '500'}건` : `${currentDays}일`;
  const basisNote  = currentDays === 'all'
    ? `수집 ${d.totalCollected || 0}건 중 ${totalChats}건 집계 · closed 채팅 · KST · Vercel API`
    : `최근 ${currentDays}일 · closed 채팅 기준 · ${totalChats}건 집계 · KST 기준`;

  const grid = document.getElementById('kpiGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">분석 채팅 수</div>
      <div class="kpi-value">${fmt(totalChats)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="data-badge badge-real">실데이터</span><span class="delta neutral">${rangeLabel}</span></div>
    </div>
    <div class="kpi-card a-${openChats > 5 ? 'rose' : openChats > 0 ? 'amber' : 'green'}">
      <div class="kpi-label">현재 오픈</div>
      <div class="kpi-value">${fmt(openChats)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="data-badge badge-real">실데이터</span><span class="delta ${openChats === 0 ? 'good' : 'bad'}">${openChats === 0 ? '없음' : '진행중'}</span><span class="delta-lbl">실시간</span></div>
    </div>
    <div class="kpi-card a-${avgResClass === 'danger' ? 'rose' : avgResClass === 'warn' ? 'amber' : 'green'}">
      <div class="kpi-label">평균 해결시간</div>
      <div class="kpi-value">${fmt(avgRes)}<span class="unit">분</span></div>
      <div class="kpi-meta"><span class="data-badge badge-calc">계산값</span><span class="delta neutral">목표 ${TARGET_AVG_MIN}분</span></div>
      <div class="kpi-target-wrap">
        <div class="kpi-target-label"><span>달성률</span><span>${avgResFill}%</span></div>
        <div class="kpi-target"><div class="kpi-target-fill ${avgResClass}" style="width:${avgResFill}%"></div></div>
      </div>
    </div>
    <div class="kpi-card a-${quickPct >= TARGET_QUICK_PCT ? 'green' : quickPct >= 30 ? 'amber' : 'rose'}">
      <div class="kpi-label">30분 내 해결률</div>
      <div class="kpi-value">${quickPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="data-badge badge-calc">계산값</span><span class="delta ${quickPct >= TARGET_QUICK_PCT ? 'good' : 'bad'}">${quickPct >= TARGET_QUICK_PCT ? '목표 달성' : '개선 필요'}</span></div>
      <div class="kpi-target-wrap">
        <div class="kpi-target-label"><span>목표 ${TARGET_QUICK_PCT}%</span><span>${quickFill}%</span></div>
        <div class="kpi-target"><div class="kpi-target-fill ${quickClass}" style="width:${quickFill}%"></div></div>
      </div>
    </div>
    <div class="kpi-card a-${topPct > 80 ? 'rose' : topPct > 60 ? 'amber' : 'green'}">
      <div class="kpi-label">주담당자 집중도</div>
      <div class="kpi-value">${topPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="data-badge badge-calc">계산값</span><span class="delta neutral">${topMgr?.name || '—'}</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">일 최고 피크</div>
      <div class="kpi-value">${fmt(peakCount)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="data-badge badge-real">실데이터</span><span class="delta bad">${peakLabel}</span></div>
    </div>
    <div class="kpi-basis-note" id="kpiBasisNote">${basisNote}</div>
  `;
}

/* ─── Render: Trend Chart ───────────────────────────────────────────────── */
function renderTrend(d) {
  const { dailyTrend, summary } = d;
  const activeVals = dailyTrend.values.filter(v => v > 0);
  const avg = activeVals.length ? Math.round(activeVals.reduce((a, b) => a + b, 0) / activeVals.length) : 0;
  const peak = Math.max(...dailyTrend.values, 0);

  document.getElementById('trendTotal').textContent = fmt(summary.totalChats);
  document.getElementById('trendPeak').textContent = fmt(peak);
  document.getElementById('trendPeakDay').textContent = summary.peakDay?.label || '';
  document.getElementById('trendAvg').textContent = fmt(avg);
  document.getElementById('trendOpen').textContent = fmt(summary.openChats);

  const badge = document.getElementById('trendBadge');
  if (badge) badge.textContent = currentDays === 'all' ? '최근 500건' : `${currentDays}일`;

  document.getElementById('trendLegend').innerHTML = `
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#0f766e;display:inline-block"></span>일반</span>
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#be123c;display:inline-block"></span>피크</span>
    <span class="trend-legend-item"><span style="width:22px;height:3px;background:none;border-top:1.5px dashed #f59e0b;display:inline-block"></span>평균선</span>
  `;

  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart(document.getElementById('trendChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: dailyTrend.labels,
      datasets: [
        {
          label: '종료 채팅',
          data: dailyTrend.values,
          backgroundColor: dailyTrend.values.map(v =>
            v >= peak * 0.8 ? '#be123c' : v >= peak * 0.45 ? '#0f766e' : '#14b8a6'
          ),
          borderRadius: 3, borderSkipped: false,
        },
        {
          label: '일 평균',
          data: Array(dailyTrend.labels.length).fill(avg),
          type: 'line', borderColor: '#f59e0b', borderWidth: 1.5,
          borderDash: [5, 4], pointRadius: 0, fill: false, tension: 0,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 7,
          callbacks: { label: ctx => ctx.dataset.type === 'line' ? `평균: ${ctx.parsed.y}건` : `${ctx.parsed.y}건` }
        },
        annotation: {
          annotations: peak > avg * 2 ? {
            peakLine: {
              type: 'line', yMin: peak, yMax: peak,
              borderColor: '#be123c', borderWidth: 1.5, borderDash: [4, 3],
              label: {
                content: `피크 ${peak}건`, display: true, position: 'end',
                backgroundColor: '#be123c', color: '#fff',
                font: { size: 10, weight: 'bold' }, padding: { x: 6, y: 3 }, borderRadius: 4,
              }
            }
          } : {}
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, maxTicksLimit: 12 } },
        y: { grid: { color: '#f1efe8' }, ticks: { font: { size: 11 }, callback: v => v + '건' }, beginAtZero: true }
      }
    }
  });

  // 피크 분석 패널 렌더링 (항목 #9)
  renderPeakAnalysis(d.peakAnalysis, d.managers || []);
}

/* ─── Render: Peak Analysis Panel (항목 #9) ─────────────────────────────── */
function renderPeakAnalysis(peakAnalysis, managers) {
  const el = document.getElementById('peakAnalysisPanel');
  if (!el) return;
  if (!peakAnalysis || peakAnalysis.count < 2) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  const mgrMap = {};
  (managers || []).forEach(m => { mgrMap[m.id] = m.name; });

  const topTagsHtml = (peakAnalysis.topTags || []).map(t =>
    `<span class="peak-tag">#${t.tag} <strong>${t.cnt}</strong>건</span>`
  ).join('');

  const topMgrHtml = (peakAnalysis.topAssignees || []).map(a =>
    `<span class="peak-tag">${mgrMap[a.id] || a.id} <strong>${a.cnt}</strong>건</span>`
  ).join('') || '<span style="color:var(--muted);font-size:11px">담당자 정보 없음</span>';

  const hourStr = peakAnalysis.peakHour
    ? `${peakAnalysis.peakHour.hour}시 (${peakAnalysis.peakHour.cnt}건 집중)`
    : '—';

  el.innerHTML = `
    <div class="peak-panel-header">
      <span class="peak-date-badge">${peakAnalysis.date}</span>
      <span class="peak-count-badge">최고 ${peakAnalysis.count}건</span>
      <span class="peak-title">피크 일자 원인 분석</span>
      <span class="data-badge badge-analyze">분석값</span>
    </div>
    <div class="peak-facts">
      <div class="peak-fact"><span class="peak-fact-lbl">집중 태그</span><div class="peak-fact-vals">${topTagsHtml || '<span style="color:var(--muted);font-size:11px">태그 없음</span>'}</div></div>
      <div class="peak-fact"><span class="peak-fact-lbl">처리 담당자</span><div class="peak-fact-vals">${topMgrHtml}</div></div>
      <div class="peak-fact"><span class="peak-fact-lbl">피크 시간대</span><div class="peak-fact-vals"><span class="peak-tag">${hourStr}</span></div></div>
    </div>
  `;
}

/* ─── Render: Heatmap ───────────────────────────────────────────────────── */
function renderHeatmap(d) {
  const days = ['월', '화', '수', '목', '금', '토', '일'];
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const hm = d.heatmap || {};
  const allVals = Object.values(hm);
  const maxVal = allVals.length ? Math.max(...allVals) : 1;

  const el = document.getElementById('heatmap');
  el.innerHTML = '';
  el.appendChild(Object.assign(document.createElement('div'), { className: 'hm-head' }));
  hours.forEach(h => {
    const div = document.createElement('div');
    div.className = 'hm-head'; div.textContent = h;
    el.appendChild(div);
  });
  days.forEach((day, di) => {
    const lbl = document.createElement('div');
    lbl.className = 'hm-row-label'; lbl.textContent = day;
    el.appendChild(lbl);
    hours.forEach(h => {
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
    [0, 1, 2, 3, 4, 5].forEach(i => {
      const s = document.createElement('span');
      s.className = `hm-${i}`;
      s.style.cssText = 'width:12px;height:12px;border-radius:2px;display:block';
      leg.appendChild(s);
    });
  }
}

/* ─── Render: Category Doughnut ─────────────────────────────────────────── */
function renderCategory(d) {
  const { tags, summary } = d;
  if (!tags?.labels?.length) return;
  if (charts.cat) charts.cat.destroy();
  charts.cat = new Chart(document.getElementById('categoryChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: tags.labels,
      datasets: [{ data: tags.values, backgroundColor: COLORS, borderColor: '#fff', borderWidth: 2, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '56%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 7, boxHeight: 7, padding: 9, usePointStyle: true, pointStyle: 'rect', font: { size: 10 } } },
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 7,
          callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}건 (${((ctx.parsed / summary.totalChats) * 100).toFixed(1)}%)` }
        }
      }
    }
  });
}

/* ─── Render: Category Bars (항목 #5 — 컴플레인 분리) ──────────────────── */
function renderCategoryBars(d) {
  const { tags, summary } = d;
  const total = summary.totalChats || 1;

  // 컴플레인 분리: "컴플레인" 전체, "컴플레인/이용불가" 별도 표시
  const groups = {
    '구독 관련':         { count: 0, color: '#0f766e',  badge: '실데이터' },
    '컴플레인 (전체)':   { count: 0, color: '#be123c',  badge: '실데이터' },
    '컴플레인/이용불가': { count: 0, color: '#e11d48',  badge: '실데이터' },
    '이용 문의':         { count: 0, color: '#1d4ed8',  badge: '실데이터' },
    '기타/운영':         { count: 0, color: '#6d28d9',  badge: '실데이터' },
  };

  (tags?.labels || []).forEach((lbl, i) => {
    const val = tags.values[i] || 0;
    if (lbl.includes('정기구독') || lbl === '구독')   groups['구독 관련'].count += val;
    else if (lbl === '컴플레인/이용불가')              groups['컴플레인/이용불가'].count += val;
    else if (lbl.includes('컴플레인'))                 groups['컴플레인 (전체)'].count += val;
    else if (lbl.includes('이용') || lbl.includes('단순')) groups['이용 문의'].count += val;
    else                                               groups['기타/운영'].count += val;
  });

  // 컴플레인 전체 = 일반 컴플레인 + 이용불가 (중복 카운트 없이 표시)
  groups['컴플레인 (전체)'].count += groups['컴플레인/이용불가'].count;

  const items = Object.entries(groups)
    .map(([label, g]) => ({ label, count: g.count, color: g.color, pct: Math.round(g.count / total * 100) }))
    .sort((a, b) => b.count - a.count);

  const maxCount = Math.max(...items.map(i => i.count), 1);
  const el = document.getElementById('categoryBars');
  el.innerHTML = items.map(item => `
    <div class="cat-bar-row">
      <div class="cat-bar-label">${item.label}</div>
      <div class="cat-bar-track">
        <div class="cat-bar-fill" style="width:${Math.max(item.count / maxCount * 100, item.count > 0 ? 3 : 0)}%;background:${item.color}"></div>
      </div>
      <div class="cat-bar-val">${item.count}건<span class="cat-pct">${item.pct}%</span></div>
    </div>
  `).join('');
}

/* ─── Render: Channel Chart ─────────────────────────────────────────────── */
function renderChannel(d) {
  const { sources, summary } = d;
  const total = summary.totalChats || 1;
  const labels = ['자사 앱/웹', '전화'];
  const values = [sources.native || 0, sources.phone || 0];
  const bgColors = ['#0f766e', '#1d4ed8'];
  if ((sources.other || 0) > 0) { labels.push('기타'); values.push(sources.other); bgColors.push('#a8a29e'); }

  if (charts.ch) charts.ch.destroy();
  charts.ch = new Chart(document.getElementById('channelChart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderRadius: 4, barThickness: 22 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 9, cornerRadius: 7, callbacks: { label: ctx => `${ctx.parsed.x.toLocaleString()}건 (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` } }
      },
      scales: {
        x: { ticks: { callback: v => v + '건', font: { size: 11 } }, grid: { color: '#f1efe8' }, beginAtZero: true },
        y: { grid: { display: false }, ticks: { font: { size: 11.5 } } }
      }
    }
  });
}

/* ─── Render: Channel Stats ─────────────────────────────────────────────── */
function renderChannelStats(d) {
  const { sources, summary } = d;
  const total = summary.totalChats || 1;
  const items = [
    { label: '자사 앱/웹 (native)', count: sources.native || 0, color: '#0f766e' },
    { label: '전화 (phone)',        count: sources.phone || 0,  color: '#1d4ed8' },
    { label: '기타',                count: sources.other || 0,  color: '#a8a29e' },
  ];
  const el = document.getElementById('channelStats');
  el.innerHTML = items.filter(s => s.count > 0).map(s => `
    <div class="ch-stat">
      <div class="ch-stat-dot" style="background:${s.color}"></div>
      <div class="ch-stat-label">${s.label}</div>
      <div class="ch-stat-count">${s.count.toLocaleString()}건</div>
      <div class="ch-stat-pct">${Math.round(s.count / total * 100)}%</div>
    </div>
  `).join('');
}

/* ─── Render: Resolution Time ───────────────────────────────────────────── */
function renderResolution(d) {
  const rb = d.resolutionBuckets;
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quick = (rb['0~5분'] || 0) + (rb['5~30분'] || 0);
  const quickPct = Math.round(quick / resTotal * 100);
  const slowPct  = Math.round((rb['8시간+'] || 0) / resTotal * 100);

  const resSummary = document.getElementById('resSummary');
  if (resSummary) {
    resSummary.innerHTML = `
      <div class="res-big ${quickPct >= 50 ? 'good' : quickPct >= 30 ? 'warn' : 'bad'}">
        <div class="res-big-val">${quickPct}%</div>
        <div class="res-big-lbl">30분 내 해결률</div>
      </div>
      <div class="res-big ${slowPct <= 20 ? 'good' : slowPct <= 40 ? 'warn' : 'bad'}">
        <div class="res-big-val">${slowPct}%</div>
        <div class="res-big-lbl">8시간+ 장기</div>
        ${(rb['8시간+'] || 0) > 0 ? `<a href="#" class="drill-link" onclick="openLongChatsPanel();return false;">▸ 상세보기</a>` : ''}
      </div>
      <div class="res-big">
        <div class="res-big-val">${d.summary.avgResolutionMin ?? '—'}</div>
        <div class="res-big-lbl">평균(분)</div>
      </div>
    `;
  }

  const buckets = [
    { label: '0~5분',      val: rb['0~5분'] || 0,      cls: 'ok',   note: '즉시 해결' },
    { label: '5~30분',     val: rb['5~30분'] || 0,     cls: 'ok',   note: '신속 처리' },
    { label: '30분~2시간', val: rb['30분~2시간'] || 0, cls: 'warn', note: '일반' },
    { label: '2~8시간',    val: rb['2~8시간'] || 0,    cls: 'warn', note: '지연' },
    { label: '8시간+',     val: rb['8시간+'] || 0,     cls: 'bad',  note: '비동기·익일' },
  ];
  const resList = document.getElementById('resList');
  if (resList) {
    resList.innerHTML = buckets.map(b => {
      const pct = Math.round(b.val / resTotal * 100);
      const barW = Math.max(pct, b.val > 0 ? 3 : 0);
      const noteColor = b.cls === 'ok' ? 'var(--teal)' : b.cls === 'warn' ? '#b45309' : 'var(--rose)';
      return `
        <div class="rt-row">
          <span class="rt-label">${b.label}</span>
          <div class="rt-bar-wrap">
            <div class="rt-bar ${b.cls}" style="width:${barW}%">
              <span class="rt-bar-label${pct < 18 ? ' light' : ''}">${b.val}건 · ${pct}%</span>
            </div>
          </div>
          <span class="rt-value" style="color:${noteColor}">${b.note}</span>
        </div>
      `;
    }).join('');
  }

  const note = document.getElementById('avgResNote');
  if (note) {
    const avg = d.summary.avgResolutionMin;
    note.textContent = avg != null
      ? `전체 평균 ${avg}분 (≈${Math.round(avg / 60 * 10) / 10}시간) · 비동기 채팅 특성상 고객 미응답 시간 포함`
      : '평균 해결시간 데이터 없음';
  }
}

/* ─── Render: VOC (항목 #8 — 비율 기반임을 명확히) ─────────────────────── */
function renderVOC(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocList');
  if (!tags?.labels?.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px">태그 데이터 없음</div>';
    return;
  }
  const totalForPct = summary.totalChats || 1;
  el.innerHTML = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt / totalForPct * 100);
    const cls = pct >= 15 ? 'rising' : pct >= 8 ? 'warn-r' : '';
    const ctx = VOC_CONTEXTS[lbl] || '관련 문의';
    // 항목 #8: 전주 대비 비교 없이 "비율 기반" 표시임을 명확히
    const trendHtml = pct >= 15
      ? '<span class="voc-trend up">비율 상위</span>'
      : pct >= 8
        ? '<span class="voc-trend up" style="background:var(--amber-bg);color:var(--amber)">주목 필요</span>'
        : '<span class="voc-trend flat">일반</span>';
    return `
      <div class="voc-item ${cls}">
        <div>
          <div class="voc-keyword">#${lbl} ${trendHtml}</div>
          <div class="voc-context">${ctx}</div>
        </div>
        <div class="voc-count">총 <strong>${cnt}</strong>건</div>
        <div class="voc-pct ${pct >= 15 ? 'pct-high' : pct >= 8 ? 'pct-mid' : 'pct-low'}">${pct}%</div>
      </div>
    `;
  }).join('');
}

/* ─── Manager Sort State ────────────────────────────────────────────────── */
let agentSortKey = 'count';
let lastManagerData = null;

// 항목 #12: 이모지 → 텍스트 라벨 기반 코멘트
function agentComment(m, rank) {
  if (!m.count) return '<span class="agent-comment off">비활성</span>';
  if (rank === 0 && m.operatorScore > 30 && m.touchScore > 50)
    return '<span class="agent-comment top">TOP 퍼포머</span>';
  if (m.operatorScore < 10 && m.touchScore < 20)
    return '<span class="agent-comment warn">코칭 필요</span>';
  if (m.touchScore < 20)
    return '<span class="agent-comment warn">응대 보완</span>';
  if (m.operatorScore < 10)
    return '<span class="agent-comment warn">효율 점검</span>';
  return '<span class="agent-comment normal">정상</span>';
}

/* ─── Render: Manager Rows (항목 #3 — 담당자별 개별 해결시간) ─────────── */
function renderManagerRows(managers, total, _avgRes) {
  const tbody = document.getElementById('managerTbody');
  if (!managers.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="tbl-loading">담당자 데이터 없음</td></tr>';
    return;
  }
  const sorted = [...managers].sort((a, b) => (b[agentSortKey] || 0) - (a[agentSortKey] || 0));

  tbody.innerHTML = sorted.map((m, i) => {
    const origRank    = managers.indexOf(m);
    const displayRank = origRank + 1;
    const rankClass   = displayRank === 1 ? 'r1' : displayRank === 2 ? 'r2' : displayRank === 3 ? 'r3' : 'rn';
    const topPct      = total > 0 ? Math.round(m.count / total * 100) : 0;
    const touchPct    = Math.min(m.touchScore, 100);
    const isActive    = m.count > 0;
    const badge       = origRank === 0 && isActive ? '<span class="badge-top">주담당</span>'
                      : !isActive ? '<span class="badge-off">비활성</span>' : '—';
    const opColor  = m.operatorScore > 30 ? 'var(--teal)' : m.operatorScore > 10 ? '#b45309' : 'var(--muted)';
    const tcColor  = m.touchScore > 50 ? 'var(--teal)' : m.touchScore > 20 ? '#b45309' : 'var(--muted)';
    const comment  = agentComment(m, origRank);
    const rowStyle = !isActive ? 'opacity:.55' : '';

    // 담당자별 실제 avgResolutionMin 사용 (없으면 — 표시)
    const resDisplay = isActive && m.avgResolutionMin != null
      ? `${m.avgResolutionMin}분`
      : isActive
        ? '<span style="font-size:10px;color:var(--subtle)">해결 완료건 없음</span>'
        : '—';

    return `
      <tr style="${rowStyle}">
        <td style="text-align:center;padding:11px 6px">
          <span class="agent-rank ${rankClass}">${isActive ? displayRank : '—'}</span>
        </td>
        <td>
          <div class="agent-name-cell">
            <div class="agent-avatar" style="${avatarStyle(origRank)}">${initials(m.name)}</div>
            <span class="agent-name">${m.name}</span>
          </div>
        </td>
        <td><span style="font-weight:800;font-variant-numeric:tabular-nums">${isActive ? m.count + '건' : '—'}</span></td>
        <td>
          ${isActive ? `
            <div class="score-cell">
              <div class="score-bar" style="width:54px;flex-shrink:0"><div class="score-fill" style="width:${topPct}%"></div></div>
              <span style="font-size:10.5px;color:var(--muted);width:30px;text-align:right;flex-shrink:0">${topPct}%</span>
            </div>` : '—'}
        </td>
        <td class="num-r">
          <div class="score-cell-fixed">
            <div class="score-bar-fixed"><div class="score-fill" style="width:${Math.min(m.operatorScore, 100)}%;background:${opColor}"></div></div>
            <span class="score-num" style="color:${opColor}">${m.operatorScore}</span>
          </div>
        </td>
        <td class="num-r">
          <div class="score-cell-fixed">
            <div class="score-bar-fixed"><div class="score-fill" style="width:${touchPct}%;background:${tcColor}"></div></div>
            <span class="score-num" style="color:${tcColor}">${m.touchScore}</span>
          </div>
        </td>
        <td class="num-r" style="font-size:11px">${resDisplay}</td>
        <td>${badge}</td>
        <td>${comment}</td>
      </tr>
    `;
  }).join('');
}

/* ─── Render: Manager Table ─────────────────────────────────────────────── */
function renderManagers(d) {
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total = d.summary.totalChats || 1;
  lastManagerData = { managers, total };

  const concAlert = document.getElementById('concAlert');
  if (concAlert && managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    if (topPct > 70) {
      concAlert.style.display = 'flex';
      concAlert.innerHTML = `<span class="data-badge badge-warn" style="font-size:11px">집중도 경고</span> ${managers[0].name} ${topPct}%`;
    } else {
      concAlert.style.display = 'none';
    }
  }

  renderManagerRows(managers, total, null);

  const tabs = document.querySelectorAll('#agentSortTabs .tbl-sort-tab');
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      agentSortKey = tab.dataset.sort;
      if (lastManagerData) {
        renderManagerRows(lastManagerData.managers, lastManagerData.total, null);
      }
    };
  });

  // 담당자 노트 업데이트
  const note = document.getElementById('agentTblNote');
  if (note) note.textContent = '※ Operator Score · Touch Score: 채널톡 API 실데이터 / 평균 해결시간: 해당 담당자 처리 건 실측값';
}

/* ─── 8시간+ Drill-Down Panel (항목 #6) ────────────────────────────────── */
function openLongChatsPanel() {
  if (!lastData || !lastData.longChats) return;
  const modal = document.getElementById('longChatsModal');
  if (!modal) return;

  const mgrMap = {};
  (lastData.managers || []).forEach(m => { mgrMap[m.id] = m.name; });

  const rows = lastData.longChats.map(c => {
    const tagsHtml = c.tags.length ? c.tags.map(t => `<span class="long-tag">#${t}</span>`).join(' ') : '<span style="color:var(--muted)">태그 없음</span>';
    const mgrName = c.assigneeId ? (mgrMap[c.assigneeId] || c.assigneeId) : '미배정';
    const hrs = (c.resolutionMin / 60).toFixed(1);
    return `
      <tr>
        <td>${c.date}</td>
        <td>${c.resolutionMin}분 <span style="color:var(--muted);font-size:10px">(${hrs}h)</span></td>
        <td>${tagsHtml}</td>
        <td style="color:var(--muted)">${mgrName}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('longChatsBody').innerHTML = rows ||
    '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">8시간+ 채팅 없음</td></tr>';

  modal.style.display = 'flex';
}

function closeLongChatsPanel() {
  const modal = document.getElementById('longChatsModal');
  if (modal) modal.style.display = 'none';
}

/* ─── CSV Download (항목 #14) ───────────────────────────────────────────── */
function downloadCSV() {
  if (!lastData) return;
  const managers = (lastData.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total = lastData.summary.totalChats || 1;

  // 담당자 성과 CSV
  const mgrRows = managers.map(m => {
    const topPct = Math.round(m.count / total * 100);
    return [m.name, m.count, topPct + '%', m.operatorScore, m.touchScore, m.avgResolutionMin ?? '', agentComment(m, managers.indexOf(m)).replace(/<[^>]*>/g, '')].join(',');
  });

  const header = ['담당자명', '처리건수', '비중', 'OperatorScore', 'TouchScore', '평균해결시간(분)', '코멘트'];
  const csvLines = [
    `# 오토스테이 CS 대시보드 내보내기 — ${new Date().toLocaleString('ko-KR')}`,
    `# 기간: ${currentDays === 'all' ? '전체 수집 최대 500건' : '최근 ' + currentDays + '일'} · 분석 채팅: ${total}건`,
    '',
    '=== 담당자 성과 ===',
    header.join(','),
    ...mgrRows,
    '',
    '=== 해결시간 분포 ===',
    '구간,건수,비율',
    ...Object.entries(lastData.resolutionBuckets || {}).map(([k, v]) => `${k},${v},${Math.round(v / Object.values(lastData.resolutionBuckets).reduce((a, b) => a + b, 1) * 100)}%`),
    '',
    '=== 태그 TOP 10 ===',
    '태그,건수',
    ...(lastData.tags?.labels || []).map((lbl, i) => `${lbl},${lastData.tags.values[i]}`),
  ].join('\n');

  const BOM = '﻿';
  const blob = new Blob([BOM + csvLines], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `autostay-cs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ─── Render: Bots & Groups → 자동화 효과 ───────────────────────────────── */
function renderBotsGroups(d) {
  const { bots, groups, summary, resolutionBuckets } = d;
  const botCount   = (bots   || []).length;
  const groupCount = (groups || []).length;
  const rb         = resolutionBuckets || {};
  const resTotal   = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quick5Pct  = Math.round(((rb['0~5분'] || 0) / resTotal) * 100);
  const quick30Pct = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);

  const botPanel = document.getElementById('botPanel');
  botPanel.innerHTML = `
    <div class="panel-header">
      <div>
        <div class="panel-title">자동화 효과</div>
        <div class="panel-sub">봇 운영 현황 · 빠른 해결 비율</div>
      </div>
      <span class="real-badge data-badge badge-real">실데이터</span>
    </div>
    <div class="auto-stat-grid" style="margin-top:14px">
      <div class="auto-stat-card">
        <div class="auto-stat-icon auto-stat-label">Bot</div>
        <div class="auto-stat-title">활성 봇</div>
        <div class="auto-stat-value">${botCount}</div>
        <div class="auto-stat-sub">채널톡 연동 챗봇</div>
        <div class="auto-progress"><div class="auto-progress-fill" style="width:${Math.min(botCount * 25, 100)}%"></div></div>
      </div>
      <div class="auto-stat-card">
        <div class="auto-stat-icon auto-stat-label" style="background:#0f766e;color:#fff">5분</div>
        <div class="auto-stat-title">5분 내 해결률</div>
        <div class="auto-stat-value">${quick5Pct}<span style="font-size:16px;font-weight:700">%</span></div>
        <div class="auto-stat-sub">즉시 응대 비율</div>
        <div class="auto-progress"><div class="auto-progress-fill ${quick5Pct >= 30 ? '' : quick5Pct >= 15 ? 'warn' : 'danger'}" style="width:${quick5Pct}%"></div></div>
      </div>
      <div class="auto-stat-card">
        <div class="auto-stat-icon auto-stat-label" style="background:#1d4ed8;color:#fff">30분</div>
        <div class="auto-stat-title">30분 내 해결률</div>
        <div class="auto-stat-value">${quick30Pct}<span style="font-size:16px;font-weight:700">%</span></div>
        <div class="auto-stat-sub">빠른 해결 채팅</div>
        <div class="auto-progress"><div class="auto-progress-fill ${quick30Pct >= 50 ? '' : quick30Pct >= 30 ? 'warn' : 'danger'}" style="width:${quick30Pct}%"></div></div>
      </div>
    </div>
    <div class="bot-names" style="margin-top:4px">
      ${(bots || []).map(b => `<span class="bot-name-tag">${b.name}</span>`).join('') || '<span style="color:var(--muted);font-size:12px">연동 봇 없음</span>'}
    </div>
  `;

  const groupPanel = document.getElementById('groupPanel');
  groupPanel.innerHTML = `
    <div class="panel-header">
      <div>
        <div class="panel-title">운영 그룹 현황</div>
        <div class="panel-sub">담당자 배정 그룹 · ${groupCount}개</div>
      </div>
      <span class="real-badge data-badge badge-real">실데이터</span>
    </div>
    <div class="group-list">
      ${(groups || []).map((g, i) => `
        <div class="group-row">
          <span class="group-rank">${i + 1}</span>
          <span class="group-name">${g.name}</span>
          <span class="group-id">ID: ${g.id}</span>
        </div>
      `).join('') || '<div style="color:var(--muted);font-size:12px;padding:8px 0">그룹 없음</div>'}
    </div>
  `;
}

/* ─── Update Topbar & Hero Meta (항목 #10 — 마지막 성공 시각) ─────────── */
function updateBanner(d) {
  lastSuccessTime = new Date(d.updatedAt);
  const timeStr = lastSuccessTime.toLocaleString('ko-KR');
  const el = document.getElementById('updatedAt');
  if (el) el.textContent = timeStr;
  const heroEl = document.getElementById('heroUpdatedAt');
  if (heroEl) heroEl.textContent = timeStr;
  const cn = document.getElementById('channelName');
  if (cn) cn.textContent = d.channel?.name || '오토스테이 CS';
}

/* ─── Collapsible Sections ──────────────────────────────────────────────── */
function initCollapsibles() {
  document.querySelectorAll('.collapse-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const content = document.getElementById(targetId);
      if (!content) return;
      const isHidden = content.classList.toggle('hidden');
      btn.classList.toggle('collapsed', isHidden);
      btn.textContent = isHidden ? '▸' : '▾';
    });
  });
}

/* ─── Fetch ─────────────────────────────────────────────────────────────── */
async function fetchData() {
  const qs = currentDays === 'all' ? 'days=all' : `days=${currentDays}`;
  const ts = Date.now();
  const res = await fetch(`/api/data?${qs}&_t=${ts}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

/* ─── Schedule Refresh ──────────────────────────────────────────────────── */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(silentRefresh, 5 * 60 * 1000);
}

/* ─── Full Render ───────────────────────────────────────────────────────── */
async function render() {
  try {
    setStep('lstep-api'); setProgress(20);
    const data = await fetchData();
    lastData = data;

    setStep('lstep-api', true); setStep('lstep-charts'); setProgress(45);

    updateBanner(data);
    const scoreObj = computeHealthScore(data);
    const insights = generateInsights(data, scoreObj);

    renderHealthScore(scoreObj, data);
    renderKPIs(data);
    renderAlertStrip(data, scoreObj);
    renderInsights(insights);
    renderActionCenter(data, scoreObj, insights);

    setProgress(60);

    renderTrend(data);
    renderHeatmap(data);

    setProgress(72);

    renderCategory(data);
    renderCategoryBars(data);

    setProgress(82);

    renderChannel(data);
    renderChannelStats(data);
    renderResolution(data);
    renderVOC(data);

    setProgress(92);

    renderManagers(data);
    renderBotsGroups(data);

    setStep('lstep-charts', true); setStep('lstep-done', true); setProgress(100);
    setTimeout(() => {
      const ov = document.getElementById('loadingOverlay');
      if (ov) ov.style.opacity = '0';
      setTimeout(() => { if (ov) ov.style.display = 'none'; }, 350);
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
      const lastOk = lastSuccessTime
        ? ` — 마지막 성공: ${lastSuccessTime.toLocaleString('ko-KR')}`
        : '';
      eb.innerHTML = `<strong>데이터 로드 실패</strong>: ${err.message}${lastOk} · 5분 후 자동 재시도`;
      eb.style.display = 'block';
    }
    scheduleRefresh();
  }
}

/* ─── Silent Refresh ────────────────────────────────────────────────────── */
async function silentRefresh() {
  try {
    const data = await fetchData();
    lastData = data;
    updateBanner(data);
    const scoreObj = computeHealthScore(data);
    const insights = generateInsights(data, scoreObj);
    renderHealthScore(scoreObj, data);
    renderKPIs(data);
    renderAlertStrip(data, scoreObj);
    renderInsights(insights);
    renderActionCenter(data, scoreObj, insights);
    renderTrend(data);
    renderHeatmap(data);
    renderCategory(data);
    renderCategoryBars(data);
    renderChannel(data);
    renderChannelStats(data);
    renderResolution(data);
    renderVOC(data);
    renderManagers(data);
    renderBotsGroups(data);
    const eb = document.getElementById('errBanner');
    if (eb) eb.style.display = 'none';
  } catch (e) {
    console.warn('Silent refresh failed:', e);
  }
  scheduleRefresh();
}

/* ─── Events ─────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.addEventListener('click', () => triggerFullReload());

  document.querySelectorAll('.range-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const range = tabBtn.dataset.range;
      document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
      tabBtn.classList.add('active');
      currentDays = range === 'all' ? 'all' : parseInt(range);
      triggerFullReload();
    });
  });

  // CSV 다운로드 버튼
  const csvBtn = document.getElementById('csvDownloadBtn');
  if (csvBtn) csvBtn.addEventListener('click', downloadCSV);

  // 롱챗 모달 배경 클릭 닫기
  const modal = document.getElementById('longChatsModal');
  if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeLongChatsPanel(); });

  initCollapsibles();
});

function triggerFullReload() {
  const ov = document.getElementById('loadingOverlay');
  if (ov) { ov.style.opacity = '1'; ov.style.display = 'flex'; }
  const loadText = document.getElementById('loadText');
  if (loadText) loadText.textContent = '채널톡 데이터 수집 중…';
  ['lstep-conn','lstep-api','lstep-charts','lstep-done'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active','done');
  });
  const connStep = document.getElementById('lstep-conn');
  if (connStep) connStep.classList.add('done');
  setProgress(5);
  render();
}

/* ─── Boot ───────────────────────────────────────────────────────────────── */
render();
