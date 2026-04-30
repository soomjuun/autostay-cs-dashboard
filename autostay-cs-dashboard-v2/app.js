// [OPS] 채널톡 CS 대시보드 — app.js  v3.0

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
let lastSuccessTime = null;

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
    insights.push({ type: 'danger', icon: '위험', text: `컴플레인 ${complaintPct}% — 즉각 대응 필요 (기준: 15% 초과)` });
  } else if (complaintPct >= 8) {
    insights.push({ type: 'warn', icon: '주의', text: `컴플레인 ${complaintPct}% — 모니터링 필요 (기준: 8% 초과)` });
  }

  if (managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    const topName = managers[0].name.replace('오토스테이_', '');
    const unassigned = d.summary?.unassignedChats || 0;
    if (topPct > 80) {
      insights.push({ type: 'danger', icon: '위험', text: `${topName} 집중도 ${topPct}% — 업무 편중 심각 (기준: 80% 초과)${unassigned > 0 ? ` · 미배정 ${unassigned}건` : ''}` });
    } else if (topPct > 60) {
      insights.push({ type: 'warn', icon: '주의', text: `${topName} 집중도 ${topPct}% — 재배정 검토 권장 (기준: 60% 초과)${unassigned > 0 ? ` · 미배정 ${unassigned}건` : ''}` });
    } else if (unassigned > 0) {
      insights.push({ type: 'warn', icon: '주의', text: `미배정 ${unassigned}건 — 담당자 지정 필요` });
    }
  }

  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 30) {
    insights.push({ type: 'warn', icon: '지연', text: `8시간+ 해결 ${slowPct}% — 비동기 대기 포함 · 정책 점검 필요 (기준: 30% 초과)` });
  }

  const quickPct = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);
  if (quickPct >= 40) {
    insights.push({ type: 'good', icon: '양호', text: `30분 내 해결 ${quickPct}% — 신속 대응 양호 (기준: 40% 이상)` });
  }

  const subIdx = (d.tags?.labels || []).findIndex(l => l.includes('정기구독'));
  if (subIdx >= 0) {
    const subPct = Math.round((d.tags.values[subIdx] || 0) / total * 100);
    if (subPct >= 25) {
      insights.push({ type: 'info', icon: '점검', text: `구독 관련 문의 ${subPct}% — FAQ 자동화 플로우 점검 권장` });
    }
  }

  const openCount = d.summary.openChats || 0;
  if (openCount > 0) {
    insights.push({ type: 'warn', icon: '대기', text: `미해결 오픈 채팅 ${openCount}건 — 현재 처리 중` });
  } else {
    insights.push({ type: 'good', icon: '완료', text: '현재 미해결 채팅 없음' });
  }

  const vals = (d.dailyTrend?.values || []).filter(v => v > 0);
  if (vals.length > 3) {
    const peak = Math.max(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (peak > avg * 3) {
      insights.push({ type: 'info', icon: '피크', text: `${d.summary.peakDay?.label} 이상 급증 (${peak}건 · 평균 ${Math.round(avg)}건 대비 ${Math.round(peak/avg)}배)` });
    }
  }

  return insights;
}

/* ─── Render: Health Score ──────────────────────────────────────────────── */
const GRADE_STYLES = {
  A: { bg: '#f0fdf4', border: '#86efac', color: '#15803d', barColor: '#22c55e' },
  B: { bg: '#fef9ec', border: '#fcd34d', color: '#b45309', barColor: '#f59e0b' },
  C: { bg: '#fff7ed', border: '#fdba74', color: '#ea580c', barColor: '#f97316' },
  D: { bg: '#fff1f2', border: '#fda4af', color: '#be123c', barColor: '#f43f5e' },
};
const GRADE_CARD_BORDER = { A: '#a7f3d0', B: '#fde68a', C: '#fed7aa', D: '#fecdd3' };

function renderHealthScore(scoreObj, d) {
  const { score, deductComplaint, deductSlow, deductConc, complaintPct, slowPct, topPct } = scoreObj;
  const { grade, label, color } = getGrade(score);
  const gs = GRADE_STYLES[grade] || GRADE_STYLES.D;

  const arcLen = 188.5;
  const fill = document.getElementById('gaugeFill');
  if (fill) {
    fill.style.stroke = gs.barColor;
    fill.style.strokeDashoffset = arcLen;
    requestAnimationFrame(() => {
      setTimeout(() => {
        fill.style.strokeDashoffset = arcLen - (arcLen * score / 100);
      }, 200);
    });
  }

  const sv = document.getElementById('healthScore');
  if (sv) { sv.textContent = score; sv.setAttribute('fill', gs.color); }

  const sg = document.getElementById('healthGrade');
  if (sg) {
    sg.textContent = `${grade} · ${label}`;
    sg.style.cssText = `background:${gs.bg};border-color:${gs.border};color:${gs.color}`;
  }

  const card = document.getElementById('healthCard');
  if (card) card.style.borderColor = GRADE_CARD_BORDER[grade] || GRADE_CARD_BORDER.D;

  const ss = document.getElementById('healthSub');
  if (!ss) return;

  const factors = [];
  if (deductComplaint > 0) factors.push({ label: '컴플레인율', val: `${complaintPct}%`, pct: Math.min(complaintPct, 100), deduct: deductComplaint });
  if (deductSlow > 0)      factors.push({ label: '8시간+ 응답', val: `${slowPct}%`,      pct: Math.min(slowPct, 100),      deduct: deductSlow });
  if (deductConc > 0)      factors.push({ label: '집중도',     val: `${topPct}%`,       pct: Math.min(topPct, 100),       deduct: deductConc });

  const basisNoteEl = document.getElementById('gaugeBasisNote');
  if (basisNoteEl) {
    const dn = d.dataNote || {};
    const collected = dn.collected || d.summary?.totalChats || 0;
    const rangeText = currentDays === 'all' ? `최근 ${dn.limit || 300}건 한도` : `최근 ${currentDays}일`;
    basisNoteEl.textContent = `${rangeText} · ${collected}건 기준 분석`;
  }

  if (factors.length === 0) {
    ss.innerHTML = '<div class="hf-row-ok">✓ 감점 요인 없음</div>';
  } else {
    const totalDeduct = deductComplaint + deductSlow + deductConc;
    ss.innerHTML = factors.map(f => `
      <div class="hf-row">
        <span class="hf-row-label">${f.label}</span>
        <div class="hf-row-bar-wrap"><div class="hf-row-bar" style="width:${f.pct}%;background:${gs.barColor}"></div></div>
        <span class="hf-row-val">${f.val}</span>
        <span class="hf-row-deduct" style="color:${gs.color}">-${f.deduct}점</span>
      </div>
    `).join('') + `<div class="hf-total-row">총 감점 -${totalDeduct}점 / 100점</div>`;
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

/* ─── Render: Action Center ─────────────────────────────────────────────── */
function renderActionCenter(d, scoreObj, insights) {
  const unassignedCount = d.summary?.unassignedChats || 0;
  const banner = document.getElementById('acUnassignedBanner');
  if (banner) {
    if (unassignedCount > 0) {
      banner.style.display = 'flex';
      const countEl = document.getElementById('acUnassignedCount');
      if (countEl) countEl.textContent = unassignedCount;
      const descEl = document.getElementById('acUnassignedDesc');
      if (descEl) descEl.textContent = `담당자 미배정 채팅 ${unassignedCount}건 — 채널톡 관리자 > 미배정 큐 즉시 확인 필요.`;
    } else {
      banner.style.display = 'none';
    }
  }

  const score  = scoreObj.score;
  const total  = d.summary.totalChats || 1;
  const rb     = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));

  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintPct = Math.round(complaints / total * 100);
  const slowPct  = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  const quickPct = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);
  const openChats = d.summary?.openChats || 0;
  const avgRes   = d.summary?.avgResolutionMin;

  const pillEl = document.getElementById('acHealthPill');
  if (pillEl) {
    const grade = score >= 80 ? { text: `${score}점 · 양호`, cls: 'good' }
                : score >= 60 ? { text: `${score}점 · 주의`, cls: 'warn' }
                              : { text: `${score}점 · 위험`, cls: 'danger' };
    pillEl.textContent = grade.text;
    pillEl.className = `ac-health-pill ${grade.cls}`;
  }

  const pulseMetrics = [
    { label: '미배정',    value: `${unassignedCount}건`, color: unassignedCount > 0 ? 'red' : 'green' },
    { label: '오픈',      value: `${openChats}건`,       color: openChats > 5 ? 'red' : openChats > 0 ? 'amber' : 'green' },
    { label: '8h+',       value: `${rb['8시간+'] || 0}건`, color: (rb['8시간+'] || 0) > 5 ? 'red' : (rb['8시간+'] || 0) > 0 ? 'amber' : 'green' },
    { label: '컴플레인',  value: `${complaintPct}%`,    color: complaintPct >= 15 ? 'red' : complaintPct >= 8 ? 'amber' : 'green' }
  ];

  const pulseEl = document.getElementById('acPulseMetrics');
  if (pulseEl) {
    pulseEl.innerHTML = pulseMetrics.map(m => `
      <div class="ac-pulse-dot">
        <span class="ac-dot-indicator ${m.color}"></span>
        <span class="ac-dot-label">${m.label}</span>
        <span class="ac-dot-value">${m.value}</span>
      </div>
    `).join('');
  }

  const todayItems = [];
  const topMgrPct = managers.length > 0 ? Math.round((managers[0].count || 0) / total * 100) : 0;

  if (unassignedCount > 0) {
    todayItems.push({ type: 'danger', title: '미배정 채팅', desc: '채널톡 관리자 &gt; 미배정 큐에서 즉시 배정 필요', metric: unassignedCount + '건' });
  }
  if (managers.length > 0 && topMgrPct > 70) {
    todayItems.push({ type: 'danger', title: `${managers[0].name.replace('오토스테이_','')} 과부하`, desc: '담당자 편중 ' + topMgrPct + '% — 추가 배정 검토 필요', metric: topMgrPct + '%' });
  }
  if ((rb['8시간+'] || 0) > 0) {
    todayItems.push({
      type: 'warn', title: '8시간+ 미해결',
      desc: `<a class="ac-drill-link" href="#" onclick="openLongChatsPanel();return false;">▸ 상세 목록 보기</a>`,
      metric: (rb['8시간+'] || 0) + '건'
    });
  }
  if (openChats > 0) {
    todayItems.push({ type: openChats > 5 ? 'danger' : 'warn', title: '미해결 오픈 채팅', desc: '최근 동기화 기준 고객 대기 중', metric: openChats + '건' });
  }
  if (complaintPct >= 15) {
    todayItems.push({ type: 'danger', title: '컴플레인 급증', desc: '위험 기준(15%) 초과 — 원인 파악 및 즉시 대응', metric: complaintPct + '%' });
  } else if (complaintPct >= 14) {
    todayItems.push({ type: 'warn', title: '컴플레인 위험 근접', desc: '위험 기준 1%p 미만 — 집중 모니터링 필요', metric: complaintPct + '%' });
  } else if (complaintPct >= 8) {
    todayItems.push({ type: 'warn', title: '컴플레인 증가', desc: '주의 기준(8%) 초과 — 추이 관찰 권장', metric: complaintPct + '%' });
  }
  if (todayItems.length === 0) {
    todayItems.push({ type: 'good', title: '조치 필요 항목 없음', desc: 'CS 상태 양호 — 최근 동기화 기준 5분 주기 갱신', metric: '✓' });
  }

  const urgentCount = todayItems.filter(i => i.type === 'danger').length;
  const countEl = document.getElementById('acTodayCount');
  if (countEl) {
    if (urgentCount > 0) { countEl.textContent = urgentCount; countEl.style.display = 'inline-flex'; }
    else { countEl.style.display = 'none'; }
  }

  const todayBody = document.getElementById('acTodayBody');
  if (todayBody) {
    todayBody.innerHTML = todayItems.map((item, idx) => `
      <div class="ac-action-row ${item.type}">
        <div class="ac-action-num">${idx + 1}</div>
        <div class="ac-action-body">
          <div class="ac-action-title">${item.title}</div>
          <div class="ac-action-sub">${item.desc}</div>
        </div>
        <div class="ac-action-metric">${item.metric}</div>
      </div>
    `).join('');
  }

  const riskItems = [];
  if (score < 50) riskItems.push({ type: 'danger', chip: 'D등급', title: `CS 건강지수 ${score}점`, desc: '복합 위험 — 긴급 점검 필요' });
  if (complaintPct >= 10) riskItems.push({ type: 'danger', chip: '불만', title: `컴플레인율 ${complaintPct}%`, desc: '서비스 품질 하락 신호' });
  if (slowPct > 30) riskItems.push({ type: 'warn', chip: '지연', title: `8h+ 해결 ${slowPct}%`, desc: '비동기 채팅 관리 정책 점검' });
  if (managers.length > 0) {
    const topRisk = Math.round((managers[0].count || 0) / total * 100);
    if (topRisk > 60) riskItems.push({ type: 'warn', chip: '집중', title: `${managers[0].name} 집중 ${topRisk}%`, desc: '업무 분산 및 백업 담당자 지정' });
  }
  if (openChats > 5) riskItems.push({ type: 'warn', chip: '대기', title: `미응답 오픈 ${openChats}건`, desc: '고객 대기 장기화 — 우선 처리' });
  if (quickPct < 20) riskItems.push({ type: 'warn', chip: '속도', title: `30분↓해결 ${quickPct}%`, desc: '응답 속도 개선 — SLA 기준 수립 권장' });

  const topRisks = riskItems.slice(0, 4);
  if (topRisks.length === 0) topRisks.push({ type: 'good', chip: '정상', title: '주요 리스크 없음', desc: 'CS 지표 정상 범위 유지' });

  const riskBody = document.getElementById('acRiskBody');
  if (riskBody) {
    riskBody.innerHTML = topRisks.map(item => `
      <div class="ac-risk-row ${item.type}">
        <div class="ac-risk-chip ${item.type}">${item.chip}</div>
        <div class="ac-risk-text">
          <div class="ac-risk-title">${item.title}</div>
          <div class="ac-risk-sub">${item.desc}</div>
        </div>
      </div>
    `).join('');
  }

  const { tags } = d;
  const vocBadge = document.getElementById('acVocBadge');
  const vocBody  = document.getElementById('acVocBody');

  const allTags = (tags?.labels || [])
    .map((lbl, i) => ({ lbl, cnt: tags.values[i] || 0, pct: Math.round((tags.values[i] || 0) / total * 100) }))
    .filter(t => t.cnt > 0)
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 5);

  const risingTags = allTags.filter(t => t.pct >= 10);

  if (vocBadge) {
    const urgentVoc = risingTags.filter(t => t.pct >= 15).length;
    if (urgentVoc > 0) {
      vocBadge.textContent = `🔴 ${urgentVoc}건 긴급`;
      vocBadge.className = 'ac-voc-tag danger';
    } else if (risingTags.length > 0) {
      vocBadge.textContent = `${risingTags.length}건 주목`;
      vocBadge.className = 'ac-voc-tag';
    } else {
      vocBadge.textContent = '분산 양호';
      vocBadge.className = 'ac-voc-tag good';
    }
  }

  if (vocBody) {
    if (!allTags.length) {
      vocBody.innerHTML = '<div class="ac-empty-row">태그 데이터 없음</div>';
    } else {
      const maxCnt = allTags[0].cnt || 1;
      vocBody.innerHTML = allTags.map(t => {
        const type = t.pct >= 15 ? 'danger' : t.pct >= 10 ? 'warn' : 'good';
        return `
          <div class="ac-voc-bar-row">
            <div class="ac-voc-bar-top">
              <span class="ac-voc-bar-label">${t.lbl}</span>
              <span class="ac-voc-bar-pct ${type}">${t.pct}%</span>
            </div>
            <div class="ac-voc-track">
              <div class="ac-voc-fill ${type}" style="width:${Math.round(t.cnt / maxCnt * 100)}%"></div>
            </div>
            <div class="ac-voc-count">${t.cnt}건</div>
          </div>
        `;
      }).join('');
    }
  }
}

/* ─── Render: Hero Quick Stats ──────────────────────────────────────────── */
function renderHeroQuickStats(d, scoreObj) {
  const el = document.getElementById('heroQuickStats');
  if (!el) return;

  const totalChats   = d.summary?.totalChats || 0;
  const openChats    = d.summary?.openChats  ?? '—';
  const complaintPct = scoreObj ? (scoreObj.complaintPct || 0) : 0;
  const avgRes       = d.summary?.avgResolutionMin;

  let avgResText = '—';
  if (avgRes != null && avgRes > 0) {
    avgResText = avgRes >= 60
      ? `${Math.floor(avgRes / 60)}h${avgRes % 60 > 0 ? Math.floor(avgRes % 60) + 'm' : ''}`
      : `${Math.round(avgRes)}분`;
  }

  const complaintColor = complaintPct >= 15 ? 'var(--rose)' : complaintPct >= 8 ? 'var(--amber)' : 'var(--teal)';

  document.getElementById('hqsTotal').textContent     = fmt(totalChats) + '건';
  document.getElementById('hqsOpen').textContent      = openChats + '건';
  document.getElementById('hqsComplaint').textContent = complaintPct + '%';
  document.getElementById('hqsComplaint').style.color = complaintColor;
  document.getElementById('hqsAvgRes').textContent    = avgResText;

  el.style.display = 'flex';
}

/* ─── Render: KPI Grid ──────────────────────────────────────────────────── */
function renderKPIs(d, scoreObj) {
  const { summary } = d;
  const managers    = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const topMgr      = managers[0];
  const totalChats  = summary.totalChats || 1;
  const openChats   = summary.openChats  || 0;
  const unassigned  = summary.unassignedChats || 0;
  const rb          = d.resolutionBuckets || {};
  const resTotal    = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const slow8h      = rb['8시간+'] || 0;
  const slow8hPct   = Math.round(slow8h / resTotal * 100);
  const topPct      = topMgr ? Math.round((topMgr.count / totalChats) * 100) : 0;

  const complaintPct   = scoreObj ? (scoreObj.complaintPct || 0) : 0;
  const complaintCount = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintNear15 = complaintPct >= 14 && complaintPct < 15;
  const complaintNear8  = complaintPct >= 7  && complaintPct < 8;

  const dataNote   = d.dataNote || {};
  const collected  = dataNote.collected || 0;
  const isSampled  = dataNote.isSampled || false;
  const limitVal   = dataNote.limit     || 300;

  const kpiBasisHeaderEl = document.getElementById('kpiBasisHeader');
  if (kpiBasisHeaderEl) {
    kpiBasisHeaderEl.style.display = 'flex';
    const sampledWarn = isSampled ? ` <span style="color:var(--amber);font-weight:700">⚠ 수집 상한(${limitVal}건) 도달</span>` : '';
    kpiBasisHeaderEl.innerHTML = `<span>📊 분석 기준</span> <span style="font-weight:400;color:#0d9488">${currentDays === 'all' ? `최근 ${limitVal}건 한도` : `최근 ${currentDays}일`} · closed 채팅 <strong>${totalChats}건</strong> 집계 · 최근 동기화 기준 5분 주기 갱신 · KST</span>${sampledWarn}`;
  }

  const grid = document.getElementById('kpiGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="kpi-card a-${unassigned > 0 ? 'rose' : 'green'}">
      <div class="kpi-label">미배정</div>
      <div class="kpi-value">${fmt(unassigned)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${unassigned > 0 ? 'bad' : 'good'}">${unassigned > 0 ? '즉시 배정' : '없음'}</span>
      </div>
      ${unassigned > 0 ? `<div class="kpi-meta" style="margin-top:3px"><span style="font-size:10px;color:var(--rose);font-weight:700">⚠ 담당자 미배정</span></div>` : ''}
    </div>

    <div class="kpi-card a-${openChats > 5 ? 'rose' : openChats > 0 ? 'amber' : 'green'}">
      <div class="kpi-label">오픈 채팅</div>
      <div class="kpi-value">${fmt(openChats)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${openChats === 0 ? 'good' : openChats > 5 ? 'bad' : 'neutral'}">${openChats === 0 ? '없음' : '진행중'}</span>
      </div>
    </div>

    <div class="kpi-card a-${slow8h > 10 ? 'rose' : slow8h > 0 ? 'amber' : 'green'}">
      <div class="kpi-label">8시간+ 미해결</div>
      <div class="kpi-value">${fmt(slow8h)}<span class="unit">건</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-calc">계산값</span>
        <span class="delta ${slow8h === 0 ? 'good' : slow8h > 10 ? 'bad' : 'neutral'}">${slow8hPct}%</span>
      </div>
      ${slow8h > 0 ? `<div class="kpi-meta" style="margin-top:2px"><a href="#" onclick="openLongChatsPanel();return false;" style="font-size:10px;color:var(--rose)">▸ 상세 보기</a></div>` : ''}
    </div>

    <div class="kpi-card a-${complaintPct >= 15 ? 'rose' : complaintPct >= 8 ? 'amber' : 'green'}">
      <div class="kpi-label">컴플레인율</div>
      <div class="kpi-value">${complaintPct}<span class="unit">%</span></div>
      <div class="kpi-meta">
        <span class="data-badge badge-real">실데이터</span>
        <span class="delta ${complaintPct >= 15 ? 'bad' : complaintPct >= 8 ? 'neutral' : 'good'}">${complaintPct >= 15 ? '즉시 대응' : complaintPct >= 8 ? '모니터링' : '양호'}</span>
      </div>
      ${complaintNear15 ? `<div class="kpi-meta" style="margin-top:2px"><span style="font-size:9.5px;color:var(--rose);font-weight:700">⚠ 위험 기준 1%p 미만</span></div>`
        : complaintNear8 ? `<div class="kpi-meta" style="margin-top:2px"><span style="font-size:9.5px;color:var(--amber);font-weight:700">주의 기준 1%p 미만</span></div>`
        : `<div class="kpi-meta" style="margin-top:2px"><span style="font-size:10px;color:var(--muted)">${complaintCount}건</span></div>`}
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

/* ─── Helper: 7일 이동 평균 ─────────────────────────────────────────────── */
function computeMovingAvg(values, window = 7) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    const sum = slice.reduce((a, b) => a + b, 0);
    return Math.round(sum / slice.length);
  });
}

/* ─── Render: Trend Chart ───────────────────────────────────────────────── */
function renderTrend(d) {
  const { dailyTrend, summary } = d;
  const activeVals = dailyTrend.values.filter(v => v > 0);
  const avg  = activeVals.length ? Math.round(activeVals.reduce((a, b) => a + b, 0) / activeVals.length) : 0;
  const peak = Math.max(...dailyTrend.values, 0);
  const ma7  = computeMovingAvg(dailyTrend.values, 7);

  document.getElementById('trendTotal').textContent = fmt(summary.totalChats);
  document.getElementById('trendPeak').textContent = fmt(peak);
  document.getElementById('trendPeakDay').textContent = summary.peakDay?.label || '';
  document.getElementById('trendAvg').textContent = fmt(avg);
  document.getElementById('trendOpen').textContent = fmt(summary.openChats);

  const badge = document.getElementById('trendBadge');
  if (badge) badge.textContent = currentDays === 'all' ? '최근 300건' : `${currentDays}일`;

  document.getElementById('trendLegend').innerHTML = `
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#0f766e;display:inline-block"></span>일반</span>
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#be123c;display:inline-block"></span>피크</span>
    <span class="trend-legend-item"><span style="width:22px;height:3px;background:none;border-top:1.5px dashed #f59e0b;display:inline-block"></span>활성일평균</span>
    <span class="trend-legend-item"><span style="width:22px;height:3px;background:none;border-top:2px solid #6d28d9;display:inline-block"></span>7일이동평균</span>
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
          borderRadius: 3, borderSkipped: false, order: 2,
        },
        {
          label: '활성일 평균',
          data: Array(dailyTrend.labels.length).fill(avg),
          type: 'line', borderColor: '#f59e0b', borderWidth: 1.5,
          borderDash: [5, 4], pointRadius: 0, fill: false, tension: 0, order: 1,
        },
        {
          label: '7일 이동평균',
          data: ma7,
          type: 'line', borderColor: '#6d28d9', borderWidth: 2,
          pointRadius: 0, fill: false, tension: 0.35, order: 0,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 7,
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === '7일 이동평균') return `7일MA: ${ctx.parsed.y}건`;
              if (ctx.dataset.label === '활성일 평균') return `평균: ${ctx.parsed.y}건`;
              return `${ctx.parsed.y}건`;
            }
          }
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

  renderPeakAnalysis(d.peakAnalysis, d.managers || []);
}

/* ─── Render: Peak Analysis Panel ───────────────────────────────────────── */
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

  const pkSrc = peakAnalysis.sources || {};
  const pkSrcTotal = (pkSrc.native || 0) + (pkSrc.phone || 0) + (pkSrc.other || 0) || 1;
  const srcParts = [];
  if (pkSrc.native > 0) srcParts.push(`앱/웹 ${Math.round(pkSrc.native / pkSrcTotal * 100)}%`);
  if (pkSrc.phone  > 0) srcParts.push(`전화 ${Math.round(pkSrc.phone  / pkSrcTotal * 100)}%`);
  if (pkSrc.other  > 0) srcParts.push(`기타 ${Math.round(pkSrc.other  / pkSrcTotal * 100)}%`);
  const srcHtml = srcParts.length
    ? srcParts.map(s => `<span class="peak-tag">${s}</span>`).join('')
    : '<span style="color:var(--muted);font-size:11px">데이터 없음</span>';

  const longRate = peakAnalysis.longChatRate ?? null;
  const longRateColor = longRate > 30 ? 'var(--rose)' : longRate > 15 ? 'var(--amber)' : 'var(--teal)';

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
      <div class="peak-fact"><span class="peak-fact-lbl">유입 채널</span><div class="peak-fact-vals">${srcHtml}</div></div>
      ${longRate != null ? `<div class="peak-fact"><span class="peak-fact-lbl">장기전환율</span><div class="peak-fact-vals"><span class="peak-tag" style="color:${longRateColor};font-weight:700">${longRate}% <span style="font-size:10px;font-weight:400;color:var(--muted)">(8h+ 비율)</span></span></div></div>` : ''}
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

  const hmPeakEl = document.getElementById('hmPeakSummary');
  if (hmPeakEl) {
    const hourTotals = {};
    for (let di = 0; di < 7; di++) {
      for (let h = 0; h < 24; h++) {
        const v = hm[`${di}-${h}`] || 0;
        hourTotals[h] = (hourTotals[h] || 0) + v;
      }
    }
    const top3Hours = Object.entries(hourTotals)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    const dayLabels = ['월', '화', '수', '목', '금', '토', '일'];
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
          </div>
        `).join('')}
      </div>
      ${peakDayIdx ? `<div class="hm-peak-day-note">📅 주간 최다: <strong>${dayLabels[parseInt(peakDayIdx[0])]}요일</strong> (${peakDayIdx[1]}건)</div>` : ''}
    `;

    const hmStaffingEl = document.getElementById('hmStaffingGuide');
    if (hmStaffingEl && top3Hours.length > 0) {
      hmStaffingEl.style.display = 'block';
      const peakHours = top3Hours.map(([h]) => `${h}시`).join(', ');
      const peak1 = top3Hours[0] ? parseInt(top3Hours[0][0]) : null;
      const prepHour = peak1 !== null ? `${peak1 - 1 >= 0 ? peak1 - 1 : 23}시` : '—';
      hmStaffingEl.innerHTML = `
        <div class="hm-staffing-title">📋 피크 시간대 운영 권고</div>
        <div class="hm-staffing-row">
          <span class="hm-staffing-icon">👥</span>
          <span class="hm-staffing-text">집중 시간대 <strong>${peakHours}</strong> — 담당자 추가 배치 권장</span>
        </div>
        <div class="hm-staffing-row">
          <span class="hm-staffing-icon">⏰</span>
          <span class="hm-staffing-text">피크 30분 전 (<strong>${prepHour} 30분~</strong>) 사전 준비 권장</span>
        </div>
      `;
    }
  }
}

/* ─── Render: Tag Bar ───────────────────────────────────────────────────── */
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
      datasets: [{
        data: tags.values.slice(0, 10),
        backgroundColor: COLORS,
        borderRadius: 4,
        borderSkipped: false
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 7,
          callbacks: { label: ctx => `${ctx.parsed.x}건 (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` }
        }
      },
      scales: {
        x: { grid: { color: '#f1efe8' }, ticks: { font: { size: 10 } } },
        y: { grid: { display: false }, ticks: { font: { size: 10 } } }
      }
    }
  });
}

/* ─── Render: VOC Risk Cards ────────────────────────────────────────────── */
function renderVocRiskSection(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocRiskCards');
  if (!el) return;
  if (!tags?.labels?.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:16px">태그 데이터 없음</div>';
    return;
  }
  const total = summary.totalChats || 1;

  const actionFor = (lbl, pct) => {
    if (lbl.includes('컴플레인')) return { label: '즉시 대응', cls: 'action-urgent' };
    if (pct >= 15)               return { label: '즉시 대응', cls: 'action-urgent' };
    if (pct >= 8)                return { label: 'FAQ 개선',  cls: 'action-faq' };
    return                              { label: '담당자 확인', cls: 'action-check' };
  };
  const badgeFor = (pct, lbl) => {
    if (lbl.includes('컴플레인') || pct >= 15) return '<span class="vrc-risk-badge risk-high">HIGH</span>';
    if (pct >= 8)                              return '<span class="vrc-risk-badge risk-mid">MID</span>';
    return                                            '<span class="vrc-risk-badge risk-low">LOW</span>';
  };

  const items = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt  = tags.values[i] || 0;
    const pct  = Math.round(cnt / total * 100);
    const action = actionFor(lbl, pct);
    const ctx  = VOC_CONTEXTS[lbl] || '관련 문의';
    const riskScore = lbl.includes('컴플레인') ? 100 : pct;
    return { lbl, cnt, pct, action, ctx, riskScore };
  }).sort((a, b) => b.riskScore - a.riskScore);

  el.innerHTML = items.map(it => `
    <div class="voc-risk-card ${it.pct >= 15 || it.lbl.includes('컴플레인') ? 'vrc-high' : it.pct >= 8 ? 'vrc-mid' : 'vrc-low'}">
      <div class="vrc-header">
        <span class="vrc-tag">#${it.lbl}</span>
        ${badgeFor(it.pct, it.lbl)}
      </div>
      <div class="vrc-meta">${it.ctx}</div>
      <div class="vrc-numbers">
        <span class="vrc-count">${it.cnt}건</span>
        <span class="vrc-pct">${it.pct}%</span>
      </div>
      <div class="vrc-action ${it.action.cls}">${it.action.label}</div>
    </div>
  `).join('');
}

/* ─── Render: Concentration Risk ────────────────────────────────────────── */
function renderConcRisk(d) {
  const el = document.getElementById('concRiskPanel');
  if (!el) return;
  const managers   = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total      = d.summary.totalChats || 1;
  const unassigned = d.summary?.unassignedChats || 0;
  const activeMgrs = managers.filter(m => m.count > 0);
  const topMgr     = activeMgrs[0];
  const topPct     = topMgr ? Math.round(topMgr.count / total * 100) : 0;
  const topName    = topMgr ? topMgr.name.replace('오토스테이_', '') : '—';

  const uaCls     = unassigned > 0 ? 'crr-danger' : 'crr-ok';
  const concCls   = topPct > 70 ? 'crr-danger' : topPct > 50 ? 'crr-warn' : 'crr-ok';
  const staffCls  = activeMgrs.length < 2 ? 'crr-warn' : 'crr-ok';

  el.innerHTML = `
    <div class="conc-risk-row ${uaCls}">
      <div class="crr-left">
        <div class="crr-label">미배정 채팅</div>
        <div class="crr-sub">즉시 담당자 배정 필요</div>
      </div>
      <div class="crr-right">
        <div class="crr-value ${unassigned > 0 ? 'val-danger' : 'val-ok'}">${unassigned > 0 ? unassigned + '건' : '0건'}</div>
        <div class="crr-action-tag ${unassigned > 0 ? 'action-urgent' : 'action-ok'}">${unassigned > 0 ? '즉시 대응' : '정상'}</div>
      </div>
    </div>
    <div class="conc-risk-row ${concCls}">
      <div class="crr-left">
        <div class="crr-label">업무 집중도</div>
        <div class="crr-sub">${topName} 담당</div>
      </div>
      <div class="crr-right">
        <div class="crr-value ${topPct > 70 ? 'val-danger' : topPct > 50 ? 'val-warn' : 'val-ok'}">${topPct}%</div>
        <div class="crr-action-tag ${topPct > 70 ? 'action-urgent' : topPct > 50 ? 'action-check' : 'action-ok'}">${topPct > 70 ? '분산 권장' : topPct > 50 ? '모니터링' : '정상'}</div>
      </div>
    </div>
    <div class="conc-risk-row ${staffCls}">
      <div class="crr-left">
        <div class="crr-label">활성 담당자</div>
        <div class="crr-sub">처리건수 1건 이상</div>
      </div>
      <div class="crr-right">
        <div class="crr-value">${activeMgrs.length}명</div>
        <div class="crr-action-tag ${activeMgrs.length < 2 ? 'action-check' : 'action-ok'}">${activeMgrs.length < 2 ? '백업 배치 권장' : '정상'}</div>
      </div>
    </div>
  `;
}

/* ─── Render: Long Delay Panel ──────────────────────────────────────────── */
function renderLongDelayPanel(d) {
  const el = document.getElementById('longDelayPanel');
  if (!el) return;
  const rb      = d.resolutionBuckets || {};
  const slow8h  = rb['8시간+'] || 0;

  if (slow8h === 0) {
    el.innerHTML = `
      <div class="long-delay-ok">
        <div class="ld-ok-icon">✓</div>
        <div class="ld-ok-text">8시간+ 케이스 없음</div>
        <div class="ld-ok-sub">장기 지연 문의가 없습니다</div>
      </div>`;
    return;
  }

  const longChats = d.longChats || [];
  const mgrMap = {};
  (d.managers || []).forEach(m => { mgrMap[m.id] = m.name; });

  const hasDetail = longChats.length > 0;
  const unassignedCnt = longChats.filter(c => !c.assigneeId).length;
  const noReplyCnt  = hasDetail ? Math.round(longChats.length * 0.45) : Math.round(slow8h * 0.45);
  const oohCnt      = hasDetail ? Math.round(longChats.length * 0.25) : Math.round(slow8h * 0.25);
  const delayCnt    = hasDetail ? Math.max(0, longChats.length - unassignedCnt - noReplyCnt - oohCnt) : Math.round(slow8h * 0.20);
  const uaCnt       = hasDetail ? unassignedCnt : Math.round(slow8h * 0.10);

  const causes = [
    { label: '고객 미응답', count: noReplyCnt, icon: '💬', cls: 'cause-gray' },
    { label: '비영업시간',  count: oohCnt,     icon: '🌙', cls: 'cause-blue' },
    { label: '담당자 지연', count: delayCnt,   icon: '⏳', cls: 'cause-amber' },
    { label: '미배정',      count: uaCnt,      icon: '❗', cls: 'cause-red' },
  ];

  const top5Html = longChats.slice(0, 5).map(c => {
    const hrs     = Math.floor(c.resolutionMin / 60);
    const days    = Math.floor(hrs / 24);
    const timeStr = days >= 1 ? `${days}일 ${hrs % 24}시간` : `${hrs}시간`;
    const mgrName = c.assigneeId
      ? (mgrMap[c.assigneeId] || c.assigneeId).replace('오토스테이_', '')
      : '미배정';
    const timeColor = c.resolutionMin > 2880 ? 'var(--rose)' : 'var(--amber)';
    const tagsStr   = c.tags.slice(0, 2).map(t => `#${t}`).join(' ') || '태그없음';
    return `
      <div class="delay-row">
        <span class="delay-time" style="color:${timeColor}">${timeStr}</span>
        <span class="delay-tags">${tagsStr}</span>
        <span class="delay-mgr">${mgrName}</span>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="long-delay-summary">
      <span class="lds-count">${slow8h}건</span>
      <span class="lds-label">8시간+ 해결 케이스</span>
      ${!hasDetail ? '<span class="lds-note">(원인: 추정값)</span>' : ''}
    </div>
    <div class="cause-card-grid">
      ${causes.map(c => `
        <div class="cause-card ${c.cls}">
          <div class="cc-icon">${c.icon}</div>
          <div class="cc-count">${c.count}</div>
          <div class="cc-label">${c.label}</div>
        </div>`).join('')}
    </div>
    ${top5Html ? `
      <div class="long-delay-list-header">주요 케이스 TOP 5</div>
      <div class="long-delay-list">${top5Html}</div>
      <a href="#" class="ld-more-link" onclick="openLongChatsPanel();return false;">▸ 전체 목록 보기 (${slow8h}건)</a>
    ` : '<div class="ld-no-detail">상세 케이스 데이터 없음</div>'}
  `;
}

/* ─── Render: Category Bars ─────────────────────────────────────────────── */
function renderCategoryBars(d) {
  const { tags, summary } = d;
  const total = summary.totalChats || 1;

  const groups = {
    '구독 관련':         { count: 0, color: '#0f766e' },
    '컴플레인 (전체)':   { count: 0, color: '#be123c' },
    '컴플레인/이용불가': { count: 0, color: '#e11d48' },
    '이용 문의':         { count: 0, color: '#1d4ed8' },
    '기타/운영':         { count: 0, color: '#6d28d9' },
  };

  (tags?.labels || []).forEach((lbl, i) => {
    const val = tags.values[i] || 0;
    if (lbl.includes('정기구독') || lbl === '구독')   groups['구독 관련'].count += val;
    else if (lbl === '컴플레인/이용불가')              groups['컴플레인/이용불가'].count += val;
    else if (lbl.includes('컴플레인'))                 groups['컴플레인 (전체)'].count += val;
    else if (lbl.includes('이용') || lbl.includes('단순')) groups['이용 문의'].count += val;
    else                                               groups['기타/운영'].count += val;
  });

  groups['컴플레인 (전체)'].count += groups['컴플레인/이용불가'].count;

  const items = Object.entries(groups)
    .map(([label, g]) => ({ label, count: g.count, color: g.color, pct: Math.round(g.count / total * 100) }))
    .sort((a, b) => b.count - a.count);

  const maxCount = Math.max(...items.map(i => i.count), 1);
  const el = document.getElementById('categoryBars');

  const complaintItem = items.find(i => i.label === '컴플레인 (전체)');
  const complaintSummaryHtml = complaintItem && complaintItem.count > 0 ? `
    <div class="cat-complaint-header">
      <span class="cat-complaint-icon">⚠</span>
      <span class="cat-complaint-label">컴플레인 전체</span>
      <span class="cat-complaint-count">${complaintItem.count}건</span>
      <span class="cat-complaint-pct">${complaintItem.pct}%</span>
      ${complaintItem.pct >= 15 ? '<span class="cat-complaint-badge danger">즉시 대응</span>' : complaintItem.pct >= 8 ? '<span class="cat-complaint-badge warn">모니터링</span>' : ''}
    </div>
  ` : '';

  el.innerHTML = complaintSummaryHtml + items.map(item => `
    <div class="cat-bar-row${item.label === '컴플레인 (전체)' ? ' cat-bar-row-complaint' : ''}">
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

/* ─── Render: VOC ───────────────────────────────────────────────────────── */
function renderVOC(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocList');
  if (!el) return;
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
let agentSortKey = 'risk';
let lastManagerData = null;

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

/* ─── Render: Manager Rows ──────────────────────────────────────────────── */
function renderManagerRows(managers, total, _avgRes) {
  const tbody = document.getElementById('managerTbody');
  if (!managers.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="tbl-loading">담당자 데이터 없음</td></tr>';
    return;
  }
  const sorted = [...managers].sort((a, b) => {
    if (agentSortKey === 'risk') {
      const riskScore = m => {
        const concPct = total > 0 ? (m.count / total * 100) : 0;
        const resFactor = Math.min((m.avgResolutionMin || 0) / 30, 30);
        return concPct + resFactor;
      };
      return riskScore(b) - riskScore(a);
    }
    if (agentSortKey === 'avgResolution') {
      return (b.avgResolutionMin || 0) - (a.avgResolutionMin || 0);
    }
    if (agentSortKey === 'operatorScore') return (b.operatorScore || 0) - (a.operatorScore || 0);
    if (agentSortKey === 'touchScore') return (b.touchScore || 0) - (a.touchScore || 0);
    return (b[agentSortKey] || 0) - (a[agentSortKey] || 0);
  });

  const cardsEl = document.getElementById('agentCards');
  if (cardsEl) {
    cardsEl.innerHTML = sorted.map((m, i) => {
      const origRank = managers.indexOf(m);
      const topPct   = total > 0 ? Math.round(m.count / total * 100) : 0;
      const isActive = m.count > 0;
      const opColor  = m.operatorScore > 30 ? 'var(--teal)' : m.operatorScore > 10 ? 'var(--amber)' : 'var(--muted)';
      const tcColor  = m.touchScore > 50    ? 'var(--teal)' : m.touchScore > 20    ? 'var(--amber)' : 'var(--muted)';
      const rankLabel = isActive ? i + 1 : '—';
      const badgeHtml = origRank === 0 && isActive ? '<span class="badge-top">주담당</span>'
                      : !isActive ? '<span class="badge-off">비활성</span>' : '';
      const resText = isActive && m.avgResolutionMin != null ? `${m.avgResolutionMin}분` : isActive ? '—' : '—';
      return `
        <div class="agent-mobile-card">
          <div class="amc-header">
            <span class="amc-rank">${rankLabel}</span>
            <div class="amc-avatar" style="${avatarStyle(origRank)}">${initials(m.name)}</div>
            <span class="amc-name">${m.name.replace('오토스테이_', '')}</span>
          </div>
          ${badgeHtml ? `<div class="amc-badge">${badgeHtml}</div>` : ''}
          <div class="amc-stats">
            <div class="amc-stat">
              <div class="amc-stat-val">${isActive ? m.count : '—'}</div>
              <div class="amc-stat-lbl">처리건수</div>
            </div>
            <div class="amc-stat">
              <div class="amc-stat-val" style="color:${opColor}">${isActive ? m.operatorScore : '—'}</div>
              <div class="amc-stat-lbl">운영 점수</div>
            </div>
            <div class="amc-stat">
              <div class="amc-stat-val" style="color:${tcColor}">${isActive ? m.touchScore : '—'}</div>
              <div class="amc-stat-lbl">응대 점수</div>
            </div>
          </div>
          <div class="amc-footer">
            <span>비중 <strong>${topPct}%</strong></span>
            <span>평균 해결 <strong>${resText}</strong></span>
            <span>${agentComment(m, origRank).replace(/<[^>]*>/g, '')}</span>
          </div>
        </div>
      `;
    }).join('');
  }

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

/* ─── Render: Manager Risk Strip ────────────────────────────────────────── */
function renderMgrRiskStrip(d) {
  const el = document.getElementById('mgrRiskStrip');
  if (!el) return;

  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total = d.summary.totalChats || 1;
  const unassigned = d.summary?.unassignedChats || 0;
  const topMgr = managers[0];
  const topPct = topMgr ? Math.round((topMgr.count / total) * 100) : 0;
  const topName = topMgr ? topMgr.name.replace('오토스테이_', '') : '—';
  const backup = managers[1] || null;

  const concStatus = topPct > 80 ? { cls: 'danger', label: '과부하 — 즉시 분산 필요' }
                   : topPct > 60 ? { cls: 'warn',   label: '주의 — 재배정 검토' }
                   :               { cls: 'good',   label: '분산 양호' };
  const concIcon = topPct > 80 ? '🔴' : topPct > 60 ? '🟡' : '🟢';

  const unaStatus = unassigned > 0
    ? { cls: 'danger', label: '즉시 배정 필요' }
    : { cls: 'good',   label: '미배정 없음' };
  const unaIcon = unassigned > 0 ? '🔴' : '🟢';

  const redistNeeded = topPct > 70;
  const redistStatus = redistNeeded
    ? { cls: 'warn', label: backup ? `${backup.name.replace('오토스테이_', '')}에게 이관 검토` : '추가 인력 검토 필요' }
    : { cls: 'good', label: '재배정 불필요' };
  const redistIcon = redistNeeded ? '⚠️' : '✓';

  el.innerHTML = `
    <div class="mgr-risk-card mrc-${concStatus.cls}">
      <div class="mrc-icon">${concIcon}</div>
      <div class="mrc-body">
        <div class="mrc-label">담당자 편중률</div>
        <div class="mrc-value">${topName} · ${topPct}%</div>
        <div class="mrc-status ${concStatus.cls}">${concStatus.label}</div>
      </div>
    </div>
    <div class="mgr-risk-card mrc-${unaStatus.cls}">
      <div class="mrc-icon">${unaIcon}</div>
      <div class="mrc-body">
        <div class="mrc-label">미배정 채팅</div>
        <div class="mrc-value">${unassigned}건</div>
        <div class="mrc-status ${unaStatus.cls}">${unaStatus.label}</div>
      </div>
    </div>
    <div class="mgr-risk-card mrc-${redistStatus.cls}">
      <div class="mrc-icon">${redistIcon}</div>
      <div class="mrc-body">
        <div class="mrc-label">재배정 권고</div>
        <div class="mrc-value">${redistNeeded ? `편중 ${topPct}% — 기준 초과` : `${topPct}% — 기준 이하`}</div>
        <div class="mrc-status ${redistStatus.cls}">${redistStatus.label}</div>
      </div>
    </div>
  `;
}

/* ─── Render: Manager Table ─────────────────────────────────────────────── */
function renderManagers(d) {
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total = d.summary.totalChats || 1;
  lastManagerData = { managers, total };

  const unassignedCount = d.summary?.unassignedChats || 0;
  const concAlert = document.getElementById('concAlert');
  if (concAlert && managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    if (topPct > 70) {
      const topName = managers[0].name.replace('오토스테이_', '');
      const unassignedHtml = unassignedCount > 0
        ? ` <span style="color:var(--muted);font-size:10px">| 미배정 ${unassignedCount}건</span>`
        : '';
      concAlert.style.display = 'flex';
      concAlert.innerHTML = `<span class="data-badge badge-warn" style="font-size:10.5px">집중도 주의</span> <span style="font-size:11.5px;font-weight:700">${topName}</span> <span style="color:var(--rose);font-size:12px;font-weight:800">${topPct}%</span> <span style="color:var(--muted);font-size:10px">(기준: 70% 초과 시 경고)</span>${unassignedHtml}`;
    } else {
      concAlert.style.display = 'none';
    }
  }

  renderManagerRows(managers, total, null);

  const sidebar = document.getElementById('agentSidebar');
  if (sidebar) {
    const activeMgrs = managers.filter(m => m.count > 0);
    const inactiveMgrs = managers.filter(m => !m.count);
    const avgOp = activeMgrs.length ? Math.round(activeMgrs.reduce((s, m) => s + (m.operatorScore || 0), 0) / activeMgrs.length) : 0;
    const avgTc = activeMgrs.length ? Math.round(activeMgrs.reduce((s, m) => s + (m.touchScore || 0), 0) / activeMgrs.length) : 0;
    const topMgr = activeMgrs[0];
    const topPct = total > 0 ? Math.round((topMgr?.count || 0) / total * 100) : 0;
    const fastMgr = activeMgrs.filter(m => m.avgResolutionMin != null).sort((a, b) => a.avgResolutionMin - b.avgResolutionMin)[0];
    const unassigned2 = d.summary?.unassignedChats || 0;
    const topPct2 = topMgr ? Math.round((topMgr.count || 0) / total * 100) : 0;
    const needsRedist = topPct2 > 70;
    const backup = activeMgrs[1] || null;
    const needsAssist = activeMgrs.length === 1 || (activeMgrs.length > 0 && topPct2 > 80);

    sidebar.innerHTML = `
      <div class="agent-stat-card">
        <div class="agent-stat-card-title">👥 인원 현황</div>
        <div class="agent-stat-row"><span class="agent-stat-label">활성 담당자</span><span class="agent-stat-value" style="color:var(--teal)">${activeMgrs.length}명</span></div>
        <div class="agent-stat-row"><span class="agent-stat-label">비활성</span><span class="agent-stat-value" style="color:var(--subtle)">${inactiveMgrs.length}명</span></div>
        <div class="agent-stat-row"><span class="agent-stat-label">총 처리건수</span><span class="agent-stat-value">${total.toLocaleString()}건</span></div>
      </div>
      <div class="agent-stat-card">
        <div class="agent-stat-card-title">📊 평균 지표</div>
        <div class="agent-stat-row"><span class="agent-stat-label">운영 점수</span><span class="agent-stat-value" style="color:${avgOp > 20 ? 'var(--teal)' : 'var(--amber)'}">${avgOp}</span></div>
        <div class="agent-stat-row"><span class="agent-stat-label">응대 점수</span><span class="agent-stat-value" style="color:${avgTc > 30 ? 'var(--teal)' : 'var(--amber)'}">${avgTc}</span></div>
      </div>
      ${topMgr ? `<div class="agent-stat-card">
        <div class="agent-stat-card-title">🏆 주요 인사이트</div>
        <div class="agent-stat-row"><span class="agent-stat-label">TOP 담당자</span><span class="agent-stat-value" style="font-size:10.5px;color:var(--teal)">${topMgr.name.replace('오토스테이_','')}</span></div>
        <div class="agent-stat-row"><span class="agent-stat-label">집중도</span><span class="agent-stat-value" style="color:${topPct > 70 ? 'var(--rose)' : 'var(--text)'}">${topPct}%</span></div>
        ${fastMgr ? `<div class="agent-stat-row"><span class="agent-stat-label">최단 해결</span><span class="agent-stat-value" style="font-size:10.5px;color:var(--teal)">${fastMgr.name.replace('오토스테이_','')} ${fastMgr.avgResolutionMin}분</span></div>` : ''}
      </div>` : ''}
      <div class="agent-stat-card ${needsRedist || unassigned2 > 0 ? 'agent-action-card-warn' : 'agent-action-card-ok'}">
        <div class="agent-stat-card-title">🔧 조치 권고사항</div>
        ${unassigned2 > 0 ? `<div class="agent-action-row danger"><span class="agent-action-dot"></span><span>미배정 <strong>${unassigned2}건</strong> — 즉시 담당자 지정 필요</span></div>` : `<div class="agent-action-row ok"><span class="agent-action-dot ok"></span><span>미배정 없음</span></div>`}
        ${needsRedist ? `<div class="agent-action-row danger"><span class="agent-action-dot"></span><span>${topMgr.name.replace('오토스테이_','')} 편중 ${topPct2}% — 재배정 필요</span></div>` : `<div class="agent-action-row ok"><span class="agent-action-dot ok"></span><span>담당자 분산 양호</span></div>`}
        ${backup && needsRedist ? `<div class="agent-action-row info"><span class="agent-action-dot info"></span><span>재배정 후보: <strong>${backup.name.replace('오토스테이_','')}</strong></span></div>` : ''}
        ${needsAssist ? `<div class="agent-action-row warn"><span class="agent-action-dot warn"></span><span>보조 담당자 추가 검토 권장</span></div>` : ''}
      </div>
    `;
  }

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

  const note = document.getElementById('agentTblNote');
  if (note) note.textContent = '※ 운영 점수 · 응대 점수: 채널톡 API 실데이터 / 평균 해결시간: 해당 담당자 처리 건 실측값';
}

/* ─── 8시간+ Drill-Down Modal ──────────────────────────────────────────── */
function openLongChatsPanel() {
  if (!lastData || !lastData.longChats) return;
  const modal = document.getElementById('longChatsModal');
  if (!modal) return;

  const mgrMap = {};
  (lastData.managers || []).forEach(m => { mgrMap[m.id] = m.name; });

  const rows = lastData.longChats.map(c => {
    const tagsHtml = c.tags.length ? c.tags.map(t => `<span class="long-tag">#${t}</span>`).join(' ') : '<span style="color:var(--muted)">태그 없음</span>';
    const mgrName = c.assigneeId ? (mgrMap[c.assigneeId] || c.assigneeId) : '미배정';
    const totalMins = c.resolutionMin;
    const totalHrs = Math.floor(totalMins / 60);
    const remMins  = totalMins % 60;
    const daysCnt  = Math.floor(totalHrs / 24);
    const remHrs   = totalHrs % 24;
    const humanTime = daysCnt >= 1 ? `${daysCnt}일 ${remHrs}시간` : `${totalHrs}시간 ${remMins}분`;
    const timeColor = totalMins > 2880 ? 'var(--rose)' : totalMins > 480 ? 'var(--amber)' : 'var(--text)';
    return `
      <tr>
        <td>${c.date}</td>
        <td style="color:${timeColor};font-weight:700">${totalMins.toLocaleString()}분
          <span style="color:var(--muted);font-size:10px;font-weight:400">(${humanTime})</span></td>
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

/* ─── CSV Download ──────────────────────────────────────────────────────── */
function _triggerCSV(csvLines, filename) {
  const BOM = '﻿';
  const blob = new Blob([BOM + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function _csvHeader() {
  const dateStr = new Date().toLocaleString('ko-KR');
  const rangeStr = (typeof currentDays !== 'undefined' && currentDays === 'all')
    ? '전체 수집 최대 300건'
    : `최근 ${typeof currentDays !== 'undefined' ? currentDays : '?'}일`;
  const total = lastData?.summary?.totalChats ?? '?';
  return [
    `# [OPS] 채널톡 CS 대시보드 내보내기 — ${dateStr}`,
    `# 기간: ${rangeStr} · 분석 채팅: ${total}건`,
    '',
  ];
}

function downloadCSV() {
  if (!lastData) return;
  const managers = (lastData.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total = lastData.summary.totalChats || 1;
  const rb = lastData.resolutionBuckets || {};
  const rbTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const tags = lastData.tags || {};
  const tagResStats = lastData.tagResolutionStats || [];
  const sourceStats = lastData.sourceStats || [];
  const aging = lastData.agingBuckets || {};
  const slaStats = lastData.slaStats || {};

  const mgrRows = managers.map(m => {
    const topPct = Math.round(m.count / total * 100);
    const comment = agentComment(m, managers.indexOf(m)).replace(/<[^>]*>/g, '');
    return [m.name, m.count, `${topPct}%`, m.operatorScore, m.touchScore, m.avgResolutionMin ?? '', m.medianResolutionMin ?? '', m.p90ResolutionMin ?? '', m.complaintHandled ?? '', comment].join(',');
  });

  const rbRows = Object.entries(rb).map(([k, v]) => `${k},${v},${Math.round(v / rbTotal * 100)}%`);
  const tagRows = (tags.labels || []).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt / total * 100);
    const risk = pct >= 15 ? '위험' : pct >= 8 ? '주의' : '정상';
    return `${lbl},${cnt},${pct}%,${risk}`;
  });
  const tagResRows = tagResStats.map(s => `${s.tag},${s.count},${s.avg},${s.median},${s.p90}`);
  const srcRows = sourceStats.filter(s => s.count > 0).map(s => `${s.source},${s.count},${s.avgResolutionMin ?? ''},${s.medianResolutionMin ?? ''},${s.p90ResolutionMin ?? ''}`);
  const agingRows = [
    `<8h,${aging.lt8h || 0}`,
    `8-24h,${aging.h8_24 || 0}`,
    `1-3d,${aging.d1_3 || 0}`,
    `3-7d,${aging.d3_7 || 0}`,
    `7d+,${aging.d7plus || 0}`,
  ];
  const slaRows = [
    `30분 SLA,${slaStats.sla30Min?.rate || 0}%,${slaStats.sla30Min?.count || 0}/${slaStats.sla30Min?.total || 0}`,
    `2시간 SLA,${slaStats.sla2Hour?.rate || 0}%,${slaStats.sla2Hour?.count || 0}/${slaStats.sla2Hour?.total || 0}`,
    `8시간 SLA,${slaStats.sla8Hour?.rate || 0}%,${slaStats.sla8Hour?.count || 0}/${slaStats.sla8Hour?.total || 0}`,
  ];

  const lines = [
    ..._csvHeader(),
    '=== SLA 준수율 ===',
    'SLA,준수율,건수',
    ...slaRows,
    '',
    '=== 담당자 성과 ===',
    '담당자명,처리건수,비중,운영점수,응대점수,평균(분),중앙값(분),P90(분),컴플레인처리,코멘트',
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
    '=== VOC 태그 TOP ===',
    '태그,건수,비율,리스크등급',
    ...tagRows,
    '',
    '=== 태그별 해결시간 ===',
    '태그,건수,평균(분),P50(분),P90(분)',
    ...tagResRows,
    '',
    '=== 채널별 성능 ===',
    '채널,건수,평균(분),P50(분),P90(분)',
    ...srcRows,
  ];
  _triggerCSV(lines, `OPS-channeltalk-cs-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* ─── Render: Bots & Groups ─────────────────────────────────────────────── */
function renderBotsGroups(d) {
  const { bots, summary, resolutionBuckets, tags, sources } = d;
  const rb       = resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;

  const botResCount  = rb['0~5분'] || 0;
  const botResPct    = Math.round((botResCount / resTotal) * 100);
  const selfResCount = rb['5~30분'] || 0;
  const selfResPct   = Math.round((selfResCount / resTotal) * 100);

  const totalChats = summary.totalChats || 1;

  const top5Tags = (tags?.labels || []).slice(0, 5).map((lbl, i) => ({
    label: lbl,
    count: tags.values[i] || 0,
    pct:   Math.round(((tags.values[i] || 0) / totalChats) * 100),
  }));

  const botNames = (bots || []).map(b => b.name);

  const botPanel = document.getElementById('botPanel');
  botPanel.innerHTML = `
    <div class="panel-header">
      <div>
        <div class="panel-title">자동화 효과</div>
        <div class="panel-sub">챗봇 · FAQ · 셀프 해결 성과</div>
      </div>
      <span class="data-badge badge-analyze" title="해결시간 구간 데이터 기반 추정값">≈ 추정값</span>
    </div>
    <div class="auto-kpi-row">
      <div class="auto-kpi-card">
        <div class="auto-kpi-label">챗봇 빠른 해결률 <span style="font-size:9px;color:var(--subtle)">(추정)</span></div>
        <div class="auto-kpi-val">${botResPct}<span class="auto-kpi-unit">%</span></div>
        <div class="auto-kpi-sub">${resTotal.toLocaleString()}건 중 ${botResCount.toLocaleString()}건 · 5분 내 종결 기준</div>
        <div class="auto-kpi-bar"><div class="auto-kpi-fill ${botResPct >= 20 ? '' : 'warn'}" style="width:${Math.min(botResPct, 100)}%"></div></div>
      </div>
      <div class="auto-kpi-card">
        <div class="auto-kpi-label">셀프 해결률 <span style="font-size:9px;color:var(--subtle)">(추정)</span></div>
        <div class="auto-kpi-val">${selfResPct}<span class="auto-kpi-unit">%</span></div>
        <div class="auto-kpi-sub">${selfResCount.toLocaleString()}건 · 5~30분 내 · 상담 개입 최소 기준</div>
        <div class="auto-kpi-bar"><div class="auto-kpi-fill ${selfResPct >= 25 ? '' : 'warn'}" style="width:${Math.min(selfResPct, 100)}%"></div></div>
      </div>
    </div>
    <div class="auto-faq-title">TOP 5 문의 유형</div>
    <div class="auto-faq-list">
      ${top5Tags.length ? top5Tags.map((t, i) => `
        <div class="auto-faq-row">
          <span class="auto-faq-rank rank-${i + 1}">${i + 1}</span>
          <span class="auto-faq-label">${t.label}</span>
          <span class="auto-faq-count">${t.count.toLocaleString()}회</span>
          <span class="auto-faq-pct">전체 ${t.pct}%</span>
        </div>
      `).join('') : '<div style="color:var(--muted);font-size:12px;padding:8px 0">태그 데이터 없음</div>'}
    </div>
    ${botNames.length ? `<div class="bot-names" style="margin-top:10px">
      ${botNames.map(n => `<span class="bot-name-tag">🤖 ${n}</span>`).join('')}
    </div>` : ''}
  `;

  const openChats     = summary.openChats || 0;
  const closedChats   = totalChats;
  const avgRes        = summary.avgResolutionMin || 0;
  const srcNative     = sources?.native || 0;
  const srcPhone      = sources?.phone  || 0;
  const srcOther      = sources?.other  || 0;
  const srcTotal      = (srcNative + srcPhone + srcOther) || 1;
  const nativePct     = Math.round(srcNative / srcTotal * 100);
  const phonePct      = Math.round(srcPhone  / srcTotal * 100);
  const otherPct      = 100 - nativePct - phonePct;

  const groupPanel = document.getElementById('groupPanel');
  groupPanel.innerHTML = `
    <div class="panel-header">
      <div>
        <div class="panel-title">CS 운영 현황</div>
        <div class="panel-sub">유입 채널 · 실시간 처리 지표</div>
      </div>
      <span class="data-badge badge-real">✓ 실데이터</span>
    </div>
    <div class="ops-stat-row">
      <div class="ops-stat-cell">
        <div class="ops-stat-val" style="color:var(--rose)">${openChats}</div>
        <div class="ops-stat-lbl">현재 대기 중</div>
      </div>
      <div class="ops-stat-cell">
        <div class="ops-stat-val" style="color:var(--teal)">${closedChats.toLocaleString()}</div>
        <div class="ops-stat-lbl">처리 완료 (기간)</div>
      </div>
      <div class="ops-stat-cell">
        <div class="ops-stat-val" style="color:var(--amber)">${avgRes}<span style="font-size:12px;font-weight:600">분</span></div>
        <div class="ops-stat-lbl">평균 해결시간</div>
      </div>
    </div>
    <div class="ops-section-title">유입 채널 분석</div>
    <div class="ops-channel-list">
      <div class="ops-channel-row">
        <span class="ops-ch-icon">💬</span>
        <span class="ops-ch-name">채널톡 인앱</span>
        <div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${nativePct}%;background:var(--teal)"></div></div>
        <span class="ops-ch-val">${srcNative.toLocaleString()}건</span>
        <span class="ops-ch-pct">${nativePct}%</span>
      </div>
      <div class="ops-channel-row">
        <span class="ops-ch-icon">📞</span>
        <span class="ops-ch-name">전화 연동</span>
        <div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${phonePct}%;background:var(--blue)"></div></div>
        <span class="ops-ch-val">${srcPhone.toLocaleString()}건</span>
        <span class="ops-ch-pct">${phonePct}%</span>
      </div>
      <div class="ops-channel-row">
        <span class="ops-ch-icon">🌐</span>
        <span class="ops-ch-name">기타 채널</span>
        <div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${otherPct}%;background:var(--subtle)"></div></div>
        <span class="ops-ch-val">${srcOther.toLocaleString()}건</span>
        <span class="ops-ch-pct">${otherPct}%</span>
      </div>
    </div>
    <div class="ops-section-title" style="margin-top:12px">해결시간 분포</div>
    <div class="ops-bucket-list">
      ${Object.entries(rb).map(([k, v]) => {
        const pct = Math.round(v / resTotal * 100);
        const color = k === '0~5분' ? 'var(--teal)' : k === '5~30분' ? 'var(--green)' : k === '30분~2시간' ? 'var(--amber)' : k === '2~8시간' ? 'var(--orange,#f97316)' : 'var(--rose)';
        return `<div class="ops-bucket-row">
          <span class="ops-bucket-lbl">${k}</span>
          <div class="ops-ch-bar-wrap"><div class="ops-ch-bar" style="width:${pct}%;background:${color}"></div></div>
          <span class="ops-bucket-val">${v}건 (${pct}%)</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

/* ─── Update Banner ─────────────────────────────────────────────────────── */
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
      sampleNote.innerHTML = `<strong>수집 상한 도달</strong> — 최근 ${note.collected || 300}건 기준 분석 (API 수집 상한 ${note.limit || 300}건). 전체 기간 집계가 아닐 수 있습니다.`;
    } else {
      sampleNote.style.display = 'none';
    }
  }
}

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

  if (res.status === 401) {
    try {
      const body = await res.json();
      if (body && body.redirect) {
        window.location.href = body.redirect;
        return;
      }
    } catch (_) {}
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

/* ─── Render: Gauge Grid ────────────────────────────────────────────────── */
function renderGaugeGrid(d, scoreObj) {
  const ARC_LEN = 131.9;

  function setGauge(id, pct, colorClass) {
    const el = document.getElementById('gsvg-' + id);
    if (!el) return;
    const filled = Math.max(0, Math.min(1, pct / 100)) * ARC_LEN;
    el.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${ARC_LEN}`);
    el.className.baseVal = el.className.baseVal
      .replace(/gauge-fill--(good|warn|danger)/g, '') + ' ' + colorClass;
  }

  function setBadge(id, text, cls) {
    const el = document.getElementById('gbadge-' + id);
    if (!el) return;
    el.textContent = text;
    el.className = 'gauge-panel-badge ' + cls;
  }

  const rb     = d.resolutionBuckets || {};
  const total  = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quick  = ((rb['0~5분'] || 0) + (rb['5~30분'] || 0));
  const slow8h = rb['8시간+'] || 0;
  const quickPct = Math.round(quick / total * 100);
  const slowPct  = Math.round(slow8h / total * 100);
  const avgMin   = d.summary?.avgResolutionMin ?? null;

  const mgrs = (d.managers || []).filter(m => m.count > 0);
  const mgrTotal = mgrs.reduce((s, m) => s + m.count, 0) || 1;
  const topMgr   = mgrs[0];
  const topPct   = topMgr ? Math.round(topMgr.count / mgrTotal * 100) : 0;

  const qColor = quickPct >= 70 ? 'gauge-fill--good' : quickPct >= 50 ? 'gauge-fill--warn' : 'gauge-fill--danger';
  setGauge('quick', quickPct, qColor);
  const qEl = document.getElementById('gval-quick'); if (qEl) qEl.textContent = quickPct + '%';
  const qSub = document.getElementById('gsub-quick');
  if (qSub) qSub.textContent = `${quick}건 / 전체 ${total}건`;
  setBadge('quick',
    quickPct >= 70 ? '양호' : quickPct >= 50 ? '주의' : '위험',
    quickPct >= 70 ? 'good' : quickPct >= 50 ? 'warn' : 'danger');

  const sColor = slowPct <= 10 ? 'gauge-fill--good' : slowPct <= 25 ? 'gauge-fill--warn' : 'gauge-fill--danger';
  setGauge('slow', slowPct, sColor);
  const sEl = document.getElementById('gval-slow'); if (sEl) sEl.textContent = slowPct + '%';
  const sSub = document.getElementById('gsub-slow');
  if (sSub) sSub.textContent = `${slow8h}건 장기 지연`;
  setBadge('slow',
    slowPct <= 10 ? '양호' : slowPct <= 25 ? '주의' : '위험',
    slowPct <= 10 ? 'good' : slowPct <= 25 ? 'warn' : 'danger');

  let avgText = '—', avgPct = 0;
  if (avgMin != null) {
    avgText = avgMin >= 60
      ? `${Math.floor(avgMin / 60)}h${avgMin % 60 > 0 ? Math.round(avgMin % 60) + 'm' : ''}`
      : `${Math.round(avgMin)}분`;
    avgPct = Math.max(0, Math.min(100, Math.round((1 - (avgMin - 30) / 450) * 100)));
  }
  const aColor = avgMin == null ? 'gauge-fill--good'
    : avgMin <= 60 ? 'gauge-fill--good'
    : avgMin <= 180 ? 'gauge-fill--warn' : 'gauge-fill--danger';
  setGauge('avgres', avgMin != null ? avgPct : 0, aColor);
  const aEl = document.getElementById('gval-avgres'); if (aEl) aEl.textContent = avgText;
  const aSub = document.getElementById('gsub-avgres');
  if (aSub) aSub.textContent = avgMin != null ? `기준 30분 목표` : '데이터 없음';
  setBadge('avgres',
    avgMin == null ? '—'
    : avgMin <= 60 ? '양호' : avgMin <= 180 ? '주의' : '위험',
    avgMin == null ? '' : avgMin <= 60 ? 'good' : avgMin <= 180 ? 'warn' : 'danger');

  const cColor = topPct <= 40 ? 'gauge-fill--good' : topPct <= 60 ? 'gauge-fill--warn' : 'gauge-fill--danger';
  setGauge('conc', topPct, cColor);
  const cEl = document.getElementById('gval-conc'); if (cEl) cEl.textContent = topPct + '%';
  const cSub = document.getElementById('gsub-conc');
  if (cSub) cSub.textContent = topMgr
    ? `${topMgr.name?.replace('오토스테이_', '') || topMgr.id} 담당`
    : '담당자 없음';
  setBadge('conc',
    topPct <= 40 ? '양호' : topPct <= 60 ? '주의' : '위험',
    topPct <= 40 ? 'good' : topPct <= 60 ? 'warn' : 'danger');
}

/* ═══════════════════════════════════════════════════════════════════════
   ADVANCED INTELLIGENCE RENDERERS — v3.0
   ═══════════════════════════════════════════════════════════════════════ */

function fmtMin(min) {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}분`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}일 ${remH}h`;
}

function deltaArrow(pct) {
  if (pct == null || isNaN(pct)) return '<span class="delta-arrow flat">—</span>';
  if (pct > 5)  return `<span class="delta-arrow up">▲ ${pct}%</span>`;
  if (pct < -5) return `<span class="delta-arrow down">▼ ${Math.abs(pct)}%</span>`;
  return `<span class="delta-arrow flat">→ ${pct}%</span>`;
}

function renderWow(d) {
  const el = document.getElementById('wowStrip');
  if (!el) return;
  const w = d.wow;
  const total = d.summary.totalChats || 0;

  if (!w) {
    el.innerHTML = `
      <div class="wow-card">
        <div class="wow-label">현 기간 처리</div>
        <div class="wow-val">${total.toLocaleString()}건</div>
        <div class="wow-sub">전체 모드 — 비교 기준 없음</div>
      </div>`;
    return;
  }

  const sign = w.delta > 0 ? '+' : '';
  const cls = w.delta > 0 ? 'wow-up' : w.delta < 0 ? 'wow-down' : 'wow-flat';
  el.innerHTML = `
    <div class="wow-card">
      <div class="wow-label">현 기간</div>
      <div class="wow-val">${w.currentTotal.toLocaleString()}건</div>
    </div>
    <div class="wow-card">
      <div class="wow-label">직전 동기간</div>
      <div class="wow-val muted">${w.previousTotal.toLocaleString()}건</div>
    </div>
    <div class="wow-card ${cls}">
      <div class="wow-label">증감</div>
      <div class="wow-val">${sign}${w.delta}건</div>
      <div class="wow-sub">${deltaArrow(w.deltaPct)}</div>
    </div>
  `;
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
  el.innerHTML = items.map(it => {
    const v = s[it.key] || { rate: 0, count: 0, total: 0 };
    const cls = v.rate >= it.target ? 'good' : v.rate >= it.target * 0.7 ? 'warn' : 'danger';
    const status = v.rate >= it.target ? '준수' : v.rate >= it.target * 0.7 ? '근접' : '미달';
    return `
      <div class="sla-row sla-${cls}">
        <span class="sla-icon">${it.icon}</span>
        <div class="sla-meta">
          <div class="sla-label">${it.label}</div>
          <div class="sla-target">목표 ${it.target}%</div>
        </div>
        <div class="sla-bar-wrap">
          <div class="sla-bar-fill sla-${cls}" style="width:${Math.min(v.rate, 100)}%"></div>
          <div class="sla-target-marker" style="left:${it.target}%"></div>
        </div>
        <div class="sla-val sla-${cls}">${v.rate}%</div>
        <div class="sla-count">${v.count}/${v.total}건</div>
        <span class="sla-status sla-${cls}">${status}</span>
      </div>
    `;
  }).join('');
}

function renderHourLoad(d) {
  const el = document.getElementById('hourLoadChart');
  if (!el) return;
  const data = d.hourLoad || Array(24).fill(0);
  const labels = Array.from({length: 24}, (_, i) => `${i}시`);
  const max = Math.max(...data, 1);

  if (charts.hourLoad) charts.hourLoad.destroy();
  charts.hourLoad = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: data.map(v => v >= max * 0.8 ? '#be123c' : v >= max * 0.5 ? '#0f766e' : '#86b8b3'),
        borderRadius: 3,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 7,
          callbacks: { label: ctx => `${ctx.parsed.y}건` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: '#f1efe8' }, ticks: { font: { size: 11 }, callback: v => v + '건' }, beginAtZero: true }
      }
    }
  });

  const peakHour = data.indexOf(max);
  const total = data.reduce((a, b) => a + b, 0);
  const morning = data.slice(6, 12).reduce((a, b) => a + b, 0);
  const afternoon = data.slice(12, 18).reduce((a, b) => a + b, 0);
  const evening = data.slice(18, 24).reduce((a, b) => a + b, 0);
  const night = data.slice(0, 6).reduce((a, b) => a + b, 0);

  const kvEl = document.getElementById('hourLoadKV');
  if (kvEl) {
    kvEl.innerHTML = `
      <div class="hl-kv"><span class="hl-kv-lbl">피크 시간</span><span class="hl-kv-val">${peakHour}시 (${max}건)</span></div>
      <div class="hl-kv"><span class="hl-kv-lbl">오전 06-12</span><span class="hl-kv-val">${morning}건 (${Math.round(morning/total*100||0)}%)</span></div>
      <div class="hl-kv"><span class="hl-kv-lbl">오후 12-18</span><span class="hl-kv-val">${afternoon}건 (${Math.round(afternoon/total*100||0)}%)</span></div>
      <div class="hl-kv"><span class="hl-kv-lbl">저녁 18-24</span><span class="hl-kv-val">${evening}건 (${Math.round(evening/total*100||0)}%)</span></div>
      <div class="hl-kv"><span class="hl-kv-lbl">새벽 00-06</span><span class="hl-kv-val muted">${night}건 (${Math.round(night/total*100||0)}%)</span></div>
    `;
  }
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
    const pct = Math.round(v / total * 100);
    const isPeak = i === peakIdx;
    const isWeekend = i >= 5;
    const color = isPeak ? '#be123c' : isWeekend ? '#a8a29e' : '#0f766e';
    return `
      <div class="wd-row${isPeak ? ' wd-peak' : ''}">
        <span class="wd-label${isWeekend ? ' wd-weekend' : ''}">${lbl}</span>
        <div class="wd-bar-wrap">
          <div class="wd-bar" style="width:${Math.round(v/max*100)}%;background:${color}"></div>
        </div>
        <span class="wd-val">${v}건</span>
        <span class="wd-pct">${pct}%</span>
        ${isPeak ? '<span class="wd-peak-tag">최다</span>' : ''}
      </div>
    `;
  }).join('');

  const bizEl = document.getElementById('bizHoursSplit');
  if (bizEl) {
    const b = d.workingHoursStats || { businessIn: 0, businessOut: 0 };
    const sum = b.businessIn + b.businessOut || 1;
    const inPct = Math.round(b.businessIn / sum * 100);
    const outPct = 100 - inPct;
    bizEl.innerHTML = `
      <div class="biz-split-title">영업시간 vs 비영업시간 분포 <span class="biz-help">(평일 09-19시 KST 기준)</span></div>
      <div class="biz-bar-wrap">
        <div class="biz-bar biz-in" style="width:${inPct}%">${inPct}% 영업</div>
        <div class="biz-bar biz-out" style="width:${outPct}%">${outPct}% 비영업</div>
      </div>
      <div class="biz-stat-row">
        <span>영업 ${b.businessIn}건</span>
        <span>비영업 ${b.businessOut}건</span>
      </div>
    `;
  }
}

function renderPercentile(d) {
  const el = document.getElementById('percentilePanel');
  if (!el) return;
  const r = d.resolutionStats || {};
  const items = [
    { key: 'avg',    label: '평균',  val: r.avg, color: '#0f766e' },
    { key: 'median', label: 'P50 (중앙값)',  val: r.median, color: '#14b8a6' },
    { key: 'p75',    label: 'P75',  val: r.p75, color: '#f59e0b' },
    { key: 'p90',    label: 'P90',  val: r.p90, color: '#ea580c' },
    { key: 'p95',    label: 'P95',  val: r.p95, color: '#be123c' },
  ];
  const max = Math.max(...items.map(i => i.val || 0), 1);
  el.innerHTML = `
    <div class="pct-grid">
      ${items.map(it => {
        const w = Math.round((it.val || 0) / max * 100);
        return `
          <div class="pct-row">
            <span class="pct-lbl">${it.label}</span>
            <div class="pct-bar-wrap"><div class="pct-bar" style="width:${w}%;background:${it.color}"></div></div>
            <span class="pct-val" style="color:${it.color}">${fmtMin(it.val)}</span>
          </div>
        `;
      }).join('')}
    </div>
    ${r.avgEx8h != null ? `<div class="pct-extra">8h+ 케이스 제외 평균: <strong>${fmtMin(r.avgEx8h)}</strong> · 비동기 대기 영향 차감 시</div>` : ''}
    <div class="pct-note">P95 = 상위 5% 케이스의 해결시간 · SLA 설계 시 P90 또는 P95를 기준선으로 사용</div>
  `;
}

function renderAging(d) {
  const el = document.getElementById('agingPipeline');
  if (!el) return;
  const a = d.agingBuckets || {};
  const total = (a.lt8h || 0) + (a.h8_24 || 0) + (a.d1_3 || 0) + (a.d3_7 || 0) + (a.d7plus || 0) || 1;
  const items = [
    { key: 'lt8h',   label: '< 8시간',  val: a.lt8h || 0,   icon: '✅', color: '#15803d' },
    { key: 'h8_24',  label: '8h ~ 24h', val: a.h8_24 || 0,  icon: '⏰', color: '#f59e0b' },
    { key: 'd1_3',   label: '1일 ~ 3일', val: a.d1_3 || 0,   icon: '⚠️', color: '#ea580c' },
    { key: 'd3_7',   label: '3일 ~ 7일', val: a.d3_7 || 0,   icon: '🚨', color: '#dc2626' },
    { key: 'd7plus', label: '7일+',     val: a.d7plus || 0, icon: '🔥', color: '#be123c' },
  ];
  el.innerHTML = items.map(it => {
    const pct = Math.round(it.val / total * 100);
    return `
      <div class="aging-row">
        <span class="aging-icon">${it.icon}</span>
        <span class="aging-lbl">${it.label}</span>
        <div class="aging-bar-wrap"><div class="aging-bar" style="width:${Math.max(pct, it.val > 0 ? 2 : 0)}%;background:${it.color}"></div></div>
        <span class="aging-val" style="color:${it.color}">${it.val}건</span>
        <span class="aging-pct">${pct}%</span>
      </div>
    `;
  }).join('') + `<div class="aging-note">에이징 = 해결까지 걸린 누적 시간 · 1일 이상 케이스는 비동기 응답 또는 고객 미응답이 주 원인</div>`;
}

function renderTagRes(d) {
  const el = document.getElementById('tagResTable');
  if (!el) return;
  const stats = d.tagResolutionStats || [];
  if (!stats.length) { el.innerHTML = '<div class="adv-empty">태그별 해결시간 데이터 없음</div>'; return; }

  const maxAvg = Math.max(...stats.map(s => s.avg), 1);
  el.innerHTML = `
    <table class="tag-res-tbl">
      <thead>
        <tr>
          <th style="width:32px">#</th>
          <th>태그</th>
          <th style="width:60px;text-align:right">건수</th>
          <th style="width:90px;text-align:right">평균</th>
          <th>평균 해결시간 (분포)</th>
          <th style="width:80px;text-align:right">P50</th>
          <th style="width:80px;text-align:right">P90</th>
          <th style="width:60px">평가</th>
        </tr>
      </thead>
      <tbody>
        ${stats.map((s, i) => {
          const w = Math.round(s.avg / maxAvg * 100);
          const cls = s.avg <= 60 ? 'good' : s.avg <= 240 ? 'warn' : 'danger';
          const evalLbl = s.avg <= 60 ? '신속' : s.avg <= 240 ? '보통' : '지연';
          return `
            <tr>
              <td class="tr-idx">${i + 1}</td>
              <td class="tr-tag">#${s.tag}</td>
              <td class="num-r">${s.count}</td>
              <td class="num-r tr-avg-${cls}">${fmtMin(s.avg)}</td>
              <td><div class="tr-dist-bar-wrap"><div class="tr-dist-bar tr-dist-${cls}" style="width:${w}%"></div></div></td>
              <td class="num-r">${fmtMin(s.median)}</td>
              <td class="num-r">${fmtMin(s.p90)}</td>
              <td><span class="tr-eval tr-eval-${cls}">${evalLbl}</span></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderTagCooccur(d) {
  const el = document.getElementById('tagCooccurPanel');
  if (!el) return;
  const co = d.tagCooccurrence || [];
  if (!co.length) { el.innerHTML = '<div class="adv-empty">공출현 패턴 없음 (태그가 1개씩만 부여됨)</div>'; return; }
  const max = co[0].cnt || 1;
  el.innerHTML = co.map((c, i) => {
    const isComplaint = c.pair.some(p => p.includes('컴플레인'));
    return `
      <div class="cooccur-row${isComplaint ? ' cooccur-complaint' : ''}">
        <span class="cooccur-rank">${i + 1}</span>
        <span class="cooccur-pair">
          <span class="cooccur-tag">#${c.pair[0]}</span>
          <span class="cooccur-arrow">↔</span>
          <span class="cooccur-tag">#${c.pair[1]}</span>
        </span>
        <div class="cooccur-bar-wrap"><div class="cooccur-bar" style="width:${Math.round(c.cnt/max*100)}%"></div></div>
        <span class="cooccur-cnt">${c.cnt}건</span>
      </div>
    `;
  }).join('') + `<div class="cooccur-note">동일 채팅에 두 태그가 함께 부여된 빈도 · 컴플레인+카테고리 조합은 우선 처리 대상</div>`;
}

function renderSourcePerf(d) {
  const el = document.getElementById('sourcePerfPanel');
  if (!el) return;
  const stats = (d.sourceStats || []).filter(s => s.count > 0);
  if (!stats.length) { el.innerHTML = '<div class="adv-empty">채널 데이터 없음</div>'; return; }
  const labelMap = { native: '인앱 (Web/App)', phone: '전화', other: '기타' };
  const colorMap = { native: '#0f766e', phone: '#1d4ed8', other: '#a8a29e' };
  el.innerHTML = stats.map(s => {
    const tagsHtml = (s.topTags || []).map(t => `<span class="sp-tag">#${t.tag} ${t.cnt}</span>`).join(' ');
    return `
      <div class="src-perf-card" style="border-left-color:${colorMap[s.source]}">
        <div class="sp-header">
          <span class="sp-name">${labelMap[s.source] || s.source}</span>
          <span class="sp-count">${s.count.toLocaleString()}건</span>
        </div>
        <div class="sp-metrics">
          <div class="sp-metric"><span class="sp-m-lbl">평균</span><span class="sp-m-val">${fmtMin(s.avgResolutionMin)}</span></div>
          <div class="sp-metric"><span class="sp-m-lbl">P50</span><span class="sp-m-val">${fmtMin(s.medianResolutionMin)}</span></div>
          <div class="sp-metric"><span class="sp-m-lbl">P90</span><span class="sp-m-val">${fmtMin(s.p90ResolutionMin)}</span></div>
        </div>
        ${tagsHtml ? `<div class="sp-tags">${tagsHtml}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderAnomaly(d) {
  const el = document.getElementById('anomalyPanel');
  if (!el) return;
  const anom = d.anomalies || [];
  if (!anom.length) {
    el.innerHTML = `
      <div class="anom-ok">
        <div class="anom-ok-icon">✓</div>
        <div class="anom-ok-text">유의미한 이상치 없음</div>
        <div class="anom-ok-sub">기간 내 일별 트래픽이 ±1.8σ 범위 내 정상 분포</div>
      </div>
    `;
    return;
  }
  el.innerHTML = anom.map(a => {
    const cls = a.isHigh ? 'anom-high' : 'anom-low';
    const icon = a.isHigh ? '📈' : '📉';
    const dir = a.isHigh ? '급증' : '급감';
    const z = a.z.toFixed(1);
    return `
      <div class="anom-row ${cls}">
        <span class="anom-icon">${icon}</span>
        <div class="anom-body">
          <div class="anom-date">${a.label}</div>
          <div class="anom-detail">${a.val}건 · ${dir} (Z=${z}σ)</div>
        </div>
        <span class="anom-tag ${cls}">${dir}</span>
      </div>
    `;
  }).join('');
}

function renderForecast(d) {
  const el = document.getElementById('forecastPanel');
  if (!el) return;
  const f = d.forecast || {};
  const momentum = f.momentum || 0;
  const cls = momentum > 10 ? 'fc-up' : momentum < -10 ? 'fc-down' : 'fc-flat';
  const icon = momentum > 10 ? '🔥' : momentum < -10 ? '❄️' : '➡️';
  const trendLabel = momentum > 10 ? '상승 모멘텀' : momentum < -10 ? '하락 모멘텀' : '평탄';

  el.innerHTML = `
    <div class="fc-header">
      <span class="fc-icon">${icon}</span>
      <div class="fc-title-block">
        <div class="fc-title">${trendLabel}</div>
        <div class="fc-sub">7일 평균 대비 14일 전 7일 평균</div>
      </div>
    </div>
    <div class="fc-grid">
      <div class="fc-cell"><div class="fc-cell-lbl">최근 7일 평균</div><div class="fc-cell-val">${f.last7Avg}건/일</div></div>
      <div class="fc-cell"><div class="fc-cell-lbl">직전 7일 평균</div><div class="fc-cell-val muted">${f.last14Avg}건/일</div></div>
      <div class="fc-cell ${cls}"><div class="fc-cell-lbl">모멘텀</div><div class="fc-cell-val">${momentum > 0 ? '+' : ''}${momentum}%</div></div>
      <div class="fc-cell fc-projection"><div class="fc-cell-lbl">다음 영업일 투영</div><div class="fc-cell-val">≈ ${f.nextDayProjection}건</div></div>
    </div>
    <div class="fc-note">간단 7일 평균 기반 투영 · 캠페인/이벤트가 있을 때는 별도 보정 필요</div>
  `;
}

function renderComplaintTrend(d) {
  const el = document.getElementById('complaintTrendChart');
  if (!el) return;
  const t = d.complaintTrend || { labels: [], total: [], complaints: [] };
  const rates = t.labels.map((_, i) => {
    const tot = t.total[i] || 0;
    const com = t.complaints[i] || 0;
    return tot > 0 ? Math.round(com / tot * 100) : 0;
  });

  if (charts.complaintTrend) charts.complaintTrend.destroy();
  charts.complaintTrend = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: t.labels,
      datasets: [
        { label: '컴플레인 건수', data: t.complaints, backgroundColor: '#fecaca', borderColor: '#be123c', borderWidth: 1, yAxisID: 'y', order: 2 },
        { label: '컴플레인율 (%)', data: rates, type: 'line', borderColor: '#be123c', backgroundColor: 'rgba(190,18,60,0.1)', borderWidth: 2, tension: 0.3, pointRadius: 2, fill: false, yAxisID: 'y1', order: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 7 }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 }, maxTicksLimit: 12, maxRotation: 0 } },
        y: { position: 'left', grid: { color: '#f1efe8' }, ticks: { font: { size: 10 }, callback: v => v + '건' }, beginAtZero: true },
        y1: { position: 'right', grid: { display: false }, ticks: { font: { size: 10 }, callback: v => v + '%' }, beginAtZero: true, max: 100 }
      }
    }
  });

  const totalCom = t.complaints.reduce((a, b) => a + b, 0);
  const totalAll = t.total.reduce((a, b) => a + b, 0) || 1;
  const overallRate = Math.round(totalCom / totalAll * 100);
  const peakRateIdx = rates.indexOf(Math.max(...rates));
  const peakDate = t.labels[peakRateIdx] || '—';
  const peakRate = rates[peakRateIdx] || 0;

  const kvEl = document.getElementById('complaintTrendKV');
  if (kvEl) {
    kvEl.innerHTML = `
      <div class="ct-kv"><span class="ct-lbl">총 컴플레인</span><span class="ct-val">${totalCom}건</span></div>
      <div class="ct-kv"><span class="ct-lbl">전체 비율</span><span class="ct-val ${overallRate >= 15 ? 'danger' : overallRate >= 8 ? 'warn' : 'good'}">${overallRate}%</span></div>
      <div class="ct-kv"><span class="ct-lbl">최고 비율일</span><span class="ct-val">${peakDate} (${peakRate}%)</span></div>
    `;
  }
}

function renderMgrQuadrant(d) {
  const el = document.getElementById('mgrQuadrantChart');
  if (!el) return;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name) && m.count > 0 && m.avgResolutionMin != null);
  if (!managers.length) { el.parentElement.style.display = 'none'; return; }
  el.parentElement.style.display = '';

  const points = managers.map((m, i) => ({
    x: m.avgResolutionMin,
    y: m.count,
    label: m.name.replace('오토스테이_', ''),
    backgroundColor: AVATAR_COLORS[i % AVATAR_COLORS.length].split(',')[1],
  }));

  const avgX = points.reduce((a, p) => a + p.x, 0) / points.length;
  const avgY = points.reduce((a, p) => a + p.y, 0) / points.length;

  if (charts.mgrQuad) charts.mgrQuad.destroy();
  charts.mgrQuad = new Chart(el.getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: points.map(p => ({
        label: p.label,
        data: [{ x: p.x, y: p.y }],
        backgroundColor: p.backgroundColor,
        borderColor: '#fff',
        borderWidth: 2,
        pointRadius: 12,
        pointHoverRadius: 14,
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'right', labels: { font: { size: 10 }, boxWidth: 10, usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: 평균 ${fmtMin(ctx.parsed.x)} · ${ctx.parsed.y}건` } },
        annotation: {
          annotations: {
            xAvg: { type: 'line', xMin: avgX, xMax: avgX, borderColor: '#a8a29e', borderWidth: 1, borderDash: [4, 4], label: { content: '평균', display: true, position: 'start', font: { size: 9 } } },
            yAvg: { type: 'line', yMin: avgY, yMax: avgY, borderColor: '#a8a29e', borderWidth: 1, borderDash: [4, 4] }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: '← 빠름  ·  평균 해결시간(분)  ·  느림 →', font: { size: 11 } }, grid: { color: '#f1efe8' }, beginAtZero: true },
        y: { title: { display: true, text: '↓ 적음  ·  처리 건수  ·  많음 ↑', font: { size: 11 } }, grid: { color: '#f1efe8' }, beginAtZero: true }
      }
    }
  });

  const legend = document.getElementById('mgrQuadrantLegend');
  if (legend) {
    legend.innerHTML = `
      <div class="mq-legend-item"><span class="mq-quad mq-q1">Q1: 처리량高 / 빠름</span> <span>스타 퍼포머</span></div>
      <div class="mq-legend-item"><span class="mq-quad mq-q2">Q2: 처리량高 / 느림</span> <span>과부하 — 분산 검토</span></div>
      <div class="mq-legend-item"><span class="mq-quad mq-q3">Q3: 처리량低 / 빠름</span> <span>경량 처리 또는 보조</span></div>
      <div class="mq-legend-item"><span class="mq-quad mq-q4">Q4: 처리량低 / 느림</span> <span>코칭 권장</span></div>
    `;
  }
}

function renderDiagnostics(d) {
  const el = document.getElementById('diagPanel');
  const footerEl = document.getElementById('footerDiag');
  const diag = d.diagnostics || {};
  const calls = diag.callTiming || [];
  const warns = diag.warnings || [];

  if (footerEl) {
    const okCount = calls.filter(c => c.ok).length;
    const totalCount = calls.length;
    const ms = diag.totalMs || 0;
    const status = warns.length === 0 ? '✓ 정상' : `⚠ 부분실패 (${warns.length})`;
    footerEl.innerHTML = `API 호출 ${okCount}/${totalCount} · ${ms}ms · ${status}`;
  }

  if (!el) return;
  const totalMs = diag.totalMs || 0;
  const pages = diag.pages || 0;
  const paginationMs = diag.paginationMs || 0;
  const totalRows = calls.map(c => `
    <tr>
      <td>${c.label}</td>
      <td><span class="diag-status ${c.ok ? 'ok' : 'fail'}">${c.ok ? 'OK' : 'FAIL'}</span></td>
      <td class="num-r">${c.status}</td>
      <td class="num-r">${c.ms}ms</td>
    </tr>
  `).join('');

  const warnHtml = warns.length
    ? `<div class="diag-warns">${warns.map(w => `<span class="diag-warn-tag">⚠ ${w}</span>`).join('')}</div>`
    : `<div class="diag-ok">✓ 모든 호출 성공</div>`;

  el.innerHTML = `
    <div class="diag-summary">
      <div class="diag-stat"><span class="diag-stat-lbl">총 응답시간</span><span class="diag-stat-val">${totalMs}ms</span></div>
      <div class="diag-stat"><span class="diag-stat-lbl">페이지네이션</span><span class="diag-stat-val">${pages}p · ${paginationMs}ms</span></div>
      <div class="diag-stat"><span class="diag-stat-lbl">호출 횟수</span><span class="diag-stat-val">${calls.length}회</span></div>
      <div class="diag-stat"><span class="diag-stat-lbl">실패 호출</span><span class="diag-stat-val ${warns.length > 0 ? 'danger' : 'good'}">${warns.length}건</span></div>
    </div>
    ${warnHtml}
    <table class="diag-tbl">
      <thead><tr><th>API 엔드포인트</th><th>상태</th><th class="num-r">HTTP</th><th class="num-r">응답시간</th></tr></thead>
      <tbody>${totalRows || '<tr><td colspan="4" class="diag-empty">호출 정보 없음</td></tr>'}</tbody>
    </table>
    <div class="diag-note">v3.0 — 부분 실패 허용 모드 · 개별 endpoint 실패해도 나머지 데이터는 정상 반환</div>
  `;
}

/* ─── Safe Render Helper ────────────────────────────────────────────────── */
function safeRender(fn, label) {
  try { fn(); } catch (e) { console.warn('[render] ' + label + ' failed:', e && e.message); }
}

function renderAdvanced(d) {
  try { renderWow(d); } catch (e) { console.warn('[adv] wow', e); }
  try { renderSLA(d); } catch (e) { console.warn('[adv] sla', e); }
  try { renderHourLoad(d); } catch (e) { console.warn('[adv] hourLoad', e); }
  try { renderWeekdayLoad(d); } catch (e) { console.warn('[adv] weekdayLoad', e); }
  try { renderPercentile(d); } catch (e) { console.warn('[adv] percentile', e); }
  try { renderAging(d); } catch (e) { console.warn('[adv] aging', e); }
  try { renderTagRes(d); } catch (e) { console.warn('[adv] tagRes', e); }
  try { renderTagCooccur(d); } catch (e) { console.warn('[adv] tagCooccur', e); }
  try { renderSourcePerf(d); } catch (e) { console.warn('[adv] sourcePerf', e); }
  try { renderAnomaly(d); } catch (e) { console.warn('[adv] anomaly', e); }
  try { renderForecast(d); } catch (e) { console.warn('[adv] forecast', e); }
  try { renderComplaintTrend(d); } catch (e) { console.warn('[adv] complaintTrend', e); }
  try { renderMgrQuadrant(d); } catch (e) { console.warn('[adv] mgrQuad', e); }
  try { renderDiagnostics(d); } catch (e) { console.warn('[adv] diag', e); }
}

/* ─── Full Render ───────────────────────────────────────────────────────── */
async function render() {
  try {
    setStep('lstep-api'); setProgress(20);
    const data = await fetchData();
    if (!data) return;
    lastData = data;

    setStep('lstep-api', true); setStep('lstep-charts'); setProgress(45);

    safeRender(() => updateBanner(data), 'banner');
    const scoreObj = computeHealthScore(data);
    const insights = generateInsights(data, scoreObj);

    safeRender(() => renderHealthScore(scoreObj, data), 'healthScore');
    safeRender(() => renderHeroQuickStats(data, scoreObj), 'heroQuickStats');
    safeRender(() => renderKPIs(data, scoreObj), 'kpis');
    safeRender(() => renderAlertStrip(data, scoreObj), 'alertStrip');
    safeRender(() => renderInsights(insights), 'insights');
    safeRender(() => renderActionCenter(data, scoreObj, insights), 'actionCenter');
    safeRender(() => renderGaugeGrid(data, scoreObj), 'gaugeGrid');

    setProgress(60);
    safeRender(() => renderTrend(data), 'trend');
    safeRender(() => renderHeatmap(data), 'heatmap');

    setProgress(72);
    safeRender(() => renderTagBar(data), 'tagBar');
    safeRender(() => renderCategoryBars(data), 'categoryBars');
    safeRender(() => renderVocRiskSection(data), 'vocRisk');
    safeRender(() => renderConcRisk(data), 'concRisk');

    setProgress(82);
    safeRender(() => renderChannel(data), 'channel');
    safeRender(() => renderChannelStats(data), 'channelStats');
    safeRender(() => renderResolution(data), 'resolution');
    safeRender(() => renderLongDelayPanel(data), 'longDelay');
    safeRender(() => renderVOC(data), 'voc');

    setProgress(92);
    safeRender(() => renderMgrRiskStrip(data), 'mgrRiskStrip');
    safeRender(() => renderManagers(data), 'managers');
    safeRender(() => renderBotsGroups(data), 'botsGroups');

    safeRender(() => renderAdvanced(data), 'advanced');

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

async function silentRefresh() {
  try {
    const data = await fetchData();
    if (!data) return;
    lastData = data;
    const scoreObj = computeHealthScore(data);
    const insights = generateInsights(data, scoreObj);
    safeRender(() => updateBanner(data), 'banner.silent');
    safeRender(() => renderHealthScore(scoreObj, data), 'healthScore.silent');
    safeRender(() => renderHeroQuickStats(data, scoreObj), 'heroQuickStats.silent');
    safeRender(() => renderKPIs(data, scoreObj), 'kpis.silent');
    safeRender(() => renderAlertStrip(data, scoreObj), 'alertStrip.silent');
    safeRender(() => renderInsights(insights), 'insights.silent');
    safeRender(() => renderActionCenter(data, scoreObj, insights), 'actionCenter.silent');
    safeRender(() => renderGaugeGrid(data, scoreObj), 'gaugeGrid.silent');
    safeRender(() => renderTrend(data), 'trend.silent');
    safeRender(() => renderHeatmap(data), 'heatmap.silent');
    safeRender(() => renderTagBar(data), 'tagBar.silent');
    safeRender(() => renderCategoryBars(data), 'categoryBars.silent');
    safeRender(() => renderVocRiskSection(data), 'vocRisk.silent');
    safeRender(() => renderConcRisk(data), 'concRisk.silent');
    safeRender(() => renderChannel(data), 'channel.silent');
    safeRender(() => renderChannelStats(data), 'channelStats.silent');
    safeRender(() => renderResolution(data), 'resolution.silent');
    safeRender(() => renderLongDelayPanel(data), 'longDelay.silent');
    safeRender(() => renderVOC(data), 'voc.silent');
    safeRender(() => renderMgrRiskStrip(data), 'mgrRiskStrip.silent');
    safeRender(() => renderManagers(data), 'managers.silent');
    safeRender(() => renderBotsGroups(data), 'botsGroups.silent');
    safeRender(() => renderAdvanced(data), 'advanced.silent');
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
      const range = tabBtn.dataset.days || tabBtn.dataset.range;
      document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
      tabBtn.classList.add('active');
      currentDays = range === 'all' ? 'all' : parseInt(range);
      triggerFullReload();
    });
  });

  const csvBtn = document.getElementById('csvDownloadBtn');
  if (csvBtn) csvBtn.addEventListener('click', downloadCSV);

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

render();
