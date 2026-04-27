// Autostay CS Dashboard — app.js  (v3.0 — Enhanced)
// Fetches from /api/data (Vercel serverless) → renders hero, action center,
// health score, insights, alert strip, charts, heatmap, manager table, bots/groups

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
let currentDays = 30;   // 7 | 30 | 'all'
let refreshTimer = null;

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

  // 1. Complaint rate penalty
  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintRate = complaints / total;
  if (complaintRate > 0.20)      score -= 25;
  else if (complaintRate > 0.15) score -= 18;
  else if (complaintRate > 0.10) score -= 10;
  else if (complaintRate > 0.05) score -= 4;

  // 2. Slow resolution penalty
  const slowRate = (rb['8시간+'] || 0) / resTotal;
  const medRate  = (rb['2~8시간'] || 0) / resTotal;
  if (slowRate > 0.50)      score -= 20;
  else if (slowRate > 0.35) score -= 14;
  else if (slowRate > 0.20) score -= 8;
  if (medRate > 0.30)       score -= 5;

  // 3. Manager concentration penalty
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  if (managers.length > 0) {
    const topPct = (managers[0].count || 0) / total;
    if (topPct > 0.85)      score -= 20;
    else if (topPct > 0.70) score -= 12;
    else if (topPct > 0.55) score -= 5;
  }

  // 4. Quick resolution bonus
  const quickRate = ((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal;
  if (quickRate > 0.50)      score += 10;
  else if (quickRate > 0.30) score += 5;

  // 5. Open chats penalty
  if (d.summary.openChats > 10) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getGrade(score) {
  if (score >= 80) return { grade: 'A', label: '양호', color: '#15803d' };
  if (score >= 65) return { grade: 'B', label: '보통', color: '#b45309' };
  if (score >= 50) return { grade: 'C', label: '주의', color: '#dc2626' };
  return { grade: 'D', label: '위험', color: '#be123c' };
}

/* ─── Auto-Insights ─────────────────────────────────────────────────────── */
function generateInsights(d, score) {
  const insights = [];
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));

  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintPct = Math.round(complaints / total * 100);
  if (complaintPct >= 15) {
    insights.push({ type: 'danger', icon: '⚠', text: `컴플레인 ${complaintPct}% — 즉각 대응 필요` });
  } else if (complaintPct >= 8) {
    insights.push({ type: 'warn', icon: '!', text: `컴플레인 ${complaintPct}% — 주의 모니터링` });
  }

  if (managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    if (topPct > 80) {
      insights.push({ type: 'danger', icon: '👤', text: `${managers[0].name} 집중도 ${topPct}% — 번아웃 위험` });
    } else if (topPct > 60) {
      insights.push({ type: 'warn', icon: '👤', text: `${managers[0].name} 집중도 ${topPct}% — 분산 권장` });
    }
  }

  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 40) {
    insights.push({ type: 'warn', icon: '⏱', text: `8시간+ 해결 ${slowPct}% — 비동기 정책 검토` });
  }

  const quickPct = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);
  if (quickPct >= 40) {
    insights.push({ type: 'good', icon: '✓', text: `30분 내 해결 ${quickPct}% — 신속 대응 양호` });
  }

  const subIdx = (d.tags?.labels || []).findIndex(l => l.includes('정기구독'));
  if (subIdx >= 0) {
    const subPct = Math.round((d.tags.values[subIdx] || 0) / total * 100);
    if (subPct >= 25) {
      insights.push({ type: 'info', icon: '🔄', text: `구독 관련 문의 ${subPct}% — 자동화 플로우 점검` });
    }
  }

  if (d.summary.openChats > 0) {
    insights.push({ type: 'warn', icon: '💬', text: `미해결 오픈 채팅 ${d.summary.openChats}건` });
  } else {
    insights.push({ type: 'good', icon: '✓', text: '현재 미해결 채팅 없음' });
  }

  const vals = (d.dailyTrend?.values || []).filter(v => v > 0);
  if (vals.length > 3) {
    const peak = Math.max(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (peak > avg * 3) {
      insights.push({ type: 'info', icon: '📈', text: `${d.summary.peakDay?.label} 급증 피크 (${peak}건 · 평균 ${Math.round(avg)}건 대비)` });
    }
  }

  return insights;
}

/* ─── Render: Health Score ──────────────────────────────────────────────── */
function renderHealthScore(score, d) {
  const { grade, label, color } = getGrade(score);
  const total = d.summary.totalChats || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('컴플레인')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);

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

  const ss = document.getElementById('healthSub');
  if (ss) {
    const topPct = managers.length > 0 ? Math.round((managers[0].count || 0) / total * 100) : 0;
    ss.textContent = `컴플레인 ${Math.round(complaints / total * 100)}% · 집중도 ${topPct}%`;
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
        <span class="insight-icon">${ins.icon}</span>
        <span>${ins.text}</span>
      </div>
    `).join('')}
  `;
}

/* ─── Render: Alert Strip ───────────────────────────────────────────────── */
function renderAlertStrip(d, score) {
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
        level: 'danger', icon: '🔴',
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
      level: 'danger', icon: '🚨',
      title: '컴플레인 급증',
      body: `컴플레인 태그 ${complaintPct}% (${complaints}건) — 서비스 품질 즉시 점검 권장.`
    });
  }

  const slowPct = Math.round((rb['8시간+'] || 0) / resTotal * 100);
  if (slowPct > 40) {
    alerts.push({
      level: 'warn', icon: '⏱',
      title: '장시간 미해결 다수',
      body: `전체의 ${slowPct}%가 8시간 이상 소요. 비동기 응답 정책 검토 권장.`
    });
  }

  if (score < 50) {
    alerts.push({
      level: 'danger', icon: '⚡',
      title: 'CS 건강 위험 단계 (D등급)',
      body: `CS 건강 점수 ${score}점 — 복합 위험 상태. 긴급 CS 운영 개선 필요.`
    });
  }

  if (!alerts.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = alerts.map(a => `
    <div class="alert-item ${a.level}">
      <div class="al-icon">${a.icon}</div>
      <div class="al-text">
        <div class="al-title">${a.title}</div>
        <div class="al-body">${a.body}</div>
      </div>
    </div>
  `).join('');
}

/* ─── Render: Action Command Center ────────────────────────────────────── */
function renderActionCenter(d, score, insights) {
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
      type: 'danger', icon: '💬',
      title: `미해결 오픈 채팅 ${d.summary.openChats}건`,
      desc: '즉시 확인 및 응답 필요 — 고객 대기 중'
    });
  }
  if (complaintPct >= 15) {
    todayItems.push({
      type: 'danger', icon: '🚨',
      title: `컴플레인 ${complaintPct}% (${complaints}건)`,
      desc: '서비스 불만 급증 — 원인 파악 및 즉시 대응'
    });
  } else if (complaintPct >= 8) {
    todayItems.push({
      type: 'warn', icon: '⚠',
      title: `컴플레인 ${complaintPct}% (${complaints}건)`,
      desc: '지속 모니터링 — 추이 관찰 권장'
    });
  }
  if (managers.length > 0) {
    const topPct2 = Math.round((managers[0].count || 0) / total * 100);
    if (topPct2 > 70) {
      todayItems.push({
        type: 'danger', icon: '👤',
        title: `${managers[0].name} 집중도 ${topPct2}%`,
        desc: '단독 처리 과부하 — 담당자 추가 배정 검토'
      });
    }
  }
  if (todayItems.length === 0) {
    todayItems.push({ type: 'good', icon: '✅', title: '조치 필요 항목 없음', desc: 'CS 상태 양호 — 정기 모니터링 유지' });
  }

  const countEl = document.getElementById('acTodayCount');
  const urgentCount = todayItems.filter(i => i.type === 'danger').length;
  if (countEl) {
    if (urgentCount > 0) {
      countEl.textContent = urgentCount;
      countEl.style.display = 'inline-flex';
    } else {
      countEl.style.display = 'none';
    }
  }

  const todayBody = document.getElementById('acTodayBody');
  if (todayBody) {
    todayBody.innerHTML = todayItems.map(item => `
      <div class="ac-item ${item.type}">
        <div class="ac-item-icon">${item.icon}</div>
        <div class="ac-item-text">
          <div class="ac-item-title">${item.title}</div>
          <div class="ac-item-desc">${item.desc}</div>
        </div>
      </div>
    `).join('');
  }

  // ── 카드 2: 주요 리스크 TOP 3 ──
  const riskItems = [];
  if (score < 50) riskItems.push({ type: 'danger', icon: '⚡', title: `CS 건강 D등급 (${score}점)`, desc: '복합 위험 상태 — 긴급 CS 운영 점검 필요' });
  if (complaintPct >= 10) riskItems.push({ type: 'danger', icon: '😡', title: `컴플레인율 ${complaintPct}%`, desc: '서비스 품질 하락 신호 — 즉시 대응' });
  if (slowPct > 30) riskItems.push({ type: 'warn', icon: '⏳', title: `8시간+ 해결 ${slowPct}%`, desc: '비동기 채팅 관리 정책 점검 필요' });
  if (managers.length > 0) {
    const topRisk = Math.round((managers[0].count || 0) / total * 100);
    if (topRisk > 60) riskItems.push({ type: 'warn', icon: '🔁', title: `${managers[0].name} 집중 ${topRisk}%`, desc: '업무 분산 및 백업 담당자 지정 권장' });
  }
  if (d.summary.openChats > 5) riskItems.push({ type: 'warn', icon: '📭', title: `미응답 오픈 ${d.summary.openChats}건`, desc: '고객 대기 장기화 — 우선 처리 필요' });
  if (quickPct < 20) riskItems.push({ type: 'warn', icon: '🐢', title: `30분 내 해결 ${quickPct}%`, desc: '응답 속도 개선 필요 — SLA 기준 수립 권장' });

  const topRisks = riskItems.slice(0, 3);
  if (topRisks.length === 0) topRisks.push({ type: 'good', icon: '✅', title: '주요 리스크 없음', desc: 'CS 지표 정상 범위 유지 중' });

  const riskBody = document.getElementById('acRiskBody');
  if (riskBody) {
    riskBody.innerHTML = topRisks.map(item => `
      <div class="ac-item ${item.type}">
        <div class="ac-item-icon">${item.icon}</div>
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
  const vocBody = document.getElementById('acVocBody');

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
        const ctx = VOC_CONTEXTS[t.lbl] || '관련 문의';
        const type = t.pct >= 15 ? 'danger' : 'warn';
        const icon = t.lbl.includes('컴플레인') ? '😡' : t.lbl.includes('구독') ? '🔄' : t.lbl.includes('탈퇴') ? '🚪' : '💬';
        return `
          <div class="ac-item ${type}">
            <div class="ac-item-icon">${icon}</div>
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

/* ─── Render: KPI Grid ──────────────────────────────────────────────────── */
function renderKPIs(d) {
  const { summary } = d;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const topMgr = managers[0];
  const totalChats = summary.totalChats;
  const openChats = summary.openChats;
  const avgRes = summary.avgResolutionMin;
  const peakCount = summary.peakDay?.count || 0;
  const peakLabel = summary.peakDay?.label || '—';
  const topPct = topMgr ? Math.round((topMgr.count / totalChats) * 100) : 0;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quickPct = Math.round(((rb['0~5분'] || 0) + (rb['5~30분'] || 0)) / resTotal * 100);

  const grid = document.getElementById('kpiGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">분석 채팅 수</div>
      <div class="kpi-value">${fmt(totalChats)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="delta neutral">closed 기준</span></div>
    </div>
    <div class="kpi-card a-${openChats > 5 ? 'rose' : openChats > 0 ? 'amber' : 'green'}">
      <div class="kpi-label">현재 오픈</div>
      <div class="kpi-value">${fmt(openChats)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="delta ${openChats === 0 ? 'good' : 'bad'}">${openChats === 0 ? '✓ 없음' : '진행 중'}</span><span class="delta-lbl">실시간</span></div>
    </div>
    <div class="kpi-card a-amber">
      <div class="kpi-label">평균 해결시간</div>
      <div class="kpi-value">${fmt(avgRes)}<span class="unit">분</span></div>
      <div class="kpi-meta"><span class="delta neutral">≈${avgRes != null ? Math.round(avgRes / 60 * 10) / 10 : '—'}시간</span></div>
    </div>
    <div class="kpi-card a-${quickPct >= 50 ? 'green' : quickPct >= 30 ? 'amber' : 'rose'}">
      <div class="kpi-label">30분 내 해결률</div>
      <div class="kpi-value">${quickPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="delta ${quickPct >= 40 ? 'good' : 'bad'}">${quickPct >= 40 ? '양호' : '개선 필요'}</span></div>
    </div>
    <div class="kpi-card a-${topPct > 80 ? 'rose' : topPct > 60 ? 'amber' : 'green'}">
      <div class="kpi-label">주담당자 집중도</div>
      <div class="kpi-value">${topPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="delta neutral">${topMgr?.name || '—'}</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">일 최고 피크</div>
      <div class="kpi-value">${fmt(peakCount)}<span class="unit">건</span></div>
      <div class="kpi-meta"><span class="delta bad">${peakLabel}</span></div>
    </div>
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
  if (badge) badge.textContent = currentDays === 'all' ? '500건' : `${currentDays}일`;

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
          borderRadius: 3,
          borderSkipped: false,
        },
        {
          label: '일 평균',
          data: Array(dailyTrend.labels.length).fill(avg),
          type: 'line',
          borderColor: '#f59e0b',
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
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
            label: ctx => ctx.dataset.type === 'line'
              ? `평균: ${ctx.parsed.y}건`
              : `${ctx.parsed.y}건`
          }
        },
        annotation: {
          annotations: peak > avg * 2 ? {
            peakLine: {
              type: 'line',
              yMin: peak, yMax: peak,
              borderColor: '#be123c', borderWidth: 1.5, borderDash: [4, 3],
              label: {
                content: `피크 ${peak}건`,
                display: true, position: 'end',
                backgroundColor: '#be123c', color: '#fff',
                font: { size: 10, weight: 'bold' },
                padding: { x: 6, y: 3 }, borderRadius: 4,
              }
            }
          } : {}
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, maxRotation: 0, maxTicksLimit: 12 }
        },
        y: {
          grid: { color: '#f1efe8' },
          ticks: { font: { size: 11 }, callback: v => v + '건' },
          beginAtZero: true,
        }
      }
    }
  });
}

/* ─── Render: Heatmap (0-23h KST) ──────────────────────────────────────── */
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
    div.className = 'hm-head';
    div.textContent = h;
    el.appendChild(div);
  });

  days.forEach((day, di) => {
    const lbl = document.createElement('div');
    lbl.className = 'hm-row-label';
    lbl.textContent = day;
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
      datasets: [{
        data: tags.values,
        backgroundColor: COLORS,
        borderColor: '#fff', borderWidth: 2, hoverOffset: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '56%',
      plugins: {
        legend: {
          position: 'right',
          labels: { boxWidth: 7, boxHeight: 7, padding: 9, usePointStyle: true, pointStyle: 'rect', font: { size: 10 } }
        },
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 7,
          callbacks: {
            label: ctx => `${ctx.label}: ${ctx.parsed}건 (${((ctx.parsed / summary.totalChats) * 100).toFixed(1)}%)`
          }
        }
      }
    }
  });
}

/* ─── Render: Category Bars ──────────────────────────────────────────────── */
function renderCategoryBars(d) {
  const { tags, summary } = d;
  const total = summary.totalChats || 1;
  const groups = {
    '구독 관련': { count: 0, color: '#0f766e' },
    '컴플레인':  { count: 0, color: '#be123c' },
    '이용 문의': { count: 0, color: '#1d4ed8' },
    '기타/운영': { count: 0, color: '#6d28d9' },
  };

  (tags?.labels || []).forEach((lbl, i) => {
    const val = tags.values[i] || 0;
    if (lbl.includes('정기구독') || lbl.includes('구독'))  groups['구독 관련'].count += val;
    else if (lbl.includes('컴플레인'))                      groups['컴플레인'].count += val;
    else if (lbl.includes('이용') || lbl.includes('단순')) groups['이용 문의'].count += val;
    else                                                     groups['기타/운영'].count += val;
  });

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
        tooltip: {
          backgroundColor: '#1c1917', padding: 9, cornerRadius: 7,
          callbacks: { label: ctx => `${ctx.parsed.x.toLocaleString()}건 (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` }
        }
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
      ? `평균 ${avg}분 (≈${Math.round(avg / 60 * 10) / 10}시간) · 비동기 채팅 특성상 고객 미응답 시간 포함`
      : '평균 해결시간 데이터 없음';
  }
}

/* ─── Render: VOC ───────────────────────────────────────────────────────── */
function renderVOC(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocList');
  if (!tags?.labels?.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px">태그 데이터 없음</div>';
    return;
  }
  el.innerHTML = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt / summary.totalChats * 100);
    const cls = pct >= 15 ? 'rising' : pct >= 8 ? 'warn-r' : '';
    const pctClass = pct >= 15 ? 'pct-high' : pct >= 8 ? 'pct-mid' : 'pct-low';
    const ctx = VOC_CONTEXTS[lbl] || '관련 문의';
    return `
      <div class="voc-item ${cls}">
        <div>
          <div class="voc-keyword">#${lbl}</div>
          <div class="voc-context">${ctx}</div>
        </div>
        <div class="voc-count">총 <strong>${cnt}</strong>건</div>
        <div class="voc-pct ${pctClass}">${pct}%</div>
      </div>
    `;
  }).join('');
}

/* ─── Render: Manager Table ─────────────────────────────────────────────── */
function renderManagers(d) {
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const total = d.summary.totalChats || 1;
  const tbody = document.getElementById('managerTbody');

  const concAlert = document.getElementById('concAlert');
  if (concAlert && managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    if (topPct > 70) {
      concAlert.style.display = 'flex';
      concAlert.textContent = `⚠ ${managers[0].name} 집중도 ${topPct}%`;
    } else {
      concAlert.style.display = 'none';
    }
  }

  if (!managers.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tbl-loading">담당자 데이터 없음</td></tr>';
    return;
  }

  tbody.innerHTML = managers.map((m, i) => {
    const topPct = total > 0 ? Math.round(m.count / total * 100) : 0;
    const touchPct = Math.min(m.touchScore, 100);
    const isActive = m.count > 0;
    const badge = i === 0 && isActive ? '<span class="badge-top">★ 주담당</span>'
                : !isActive ? '<span class="badge-off">비활성</span>'
                : '—';
    const opColor = m.operatorScore > 30 ? 'var(--teal)' : m.operatorScore > 10 ? '#b45309' : 'var(--muted)';
    const tcColor = m.touchScore > 50 ? 'var(--teal)' : m.touchScore > 20 ? '#b45309' : 'var(--muted)';

    return `
      <tr>
        <td>
          <div class="agent-name-cell">
            <div class="agent-avatar" style="${avatarStyle(i)}">${initials(m.name)}</div>
            <span class="agent-name">${m.name}</span>
          </div>
        </td>
        <td><span style="font-weight:800;font-variant-numeric:tabular-nums">${isActive ? m.count + '건' : '—'}</span></td>
        <td>
          ${isActive ? `
            <div class="score-cell">
              <div class="score-bar" style="width:70px"><div class="score-fill" style="width:${topPct}%"></div></div>
              <span style="font-size:10.5px;color:var(--muted)">${topPct}%</span>
            </div>` : '—'}
        </td>
        <td class="num-r">
          <div class="score-cell" style="justify-content:flex-end">
            <div class="score-bar"><div class="score-fill" style="width:${Math.min(m.operatorScore, 100)}%;background:${opColor}"></div></div>
            <span style="font-weight:700;color:${opColor}">${m.operatorScore}</span>
          </div>
        </td>
        <td class="num-r">
          <div class="score-cell" style="justify-content:flex-end">
            <div class="score-bar"><div class="score-fill" style="width:${touchPct}%;background:${tcColor}"></div></div>
            <span style="font-weight:700;color:${tcColor}">${m.touchScore}</span>
          </div>
        </td>
        <td class="num-r" style="color:var(--muted);font-size:11px">${isActive && d.summary.avgResolutionMin != null ? Math.round(d.summary.avgResolutionMin) + '분' : '—'}</td>
        <td>${badge}</td>
      </tr>
    `;
  }).join('');
}

/* ─── Render: Bots & Groups ─────────────────────────────────────────────── */
function renderBotsGroups(d) {
  const { bots, groups } = d;

  const botPanel = document.getElementById('botPanel');
  botPanel.innerHTML = `
    <div class="panel-header">
      <div>
        <div class="panel-title">봇 운영 현황</div>
        <div class="panel-sub">채널톡 연동 챗봇</div>
      </div>
      <span class="real-badge">✓ 실데이터</span>
    </div>
    <div class="bot-stats">
      <div class="bot-stat-val">${(bots || []).length}</div>
      <div class="bot-stat-lbl">활성 봇</div>
    </div>
    <div class="bot-names">
      ${(bots || []).map(b => `<span class="bot-name-tag">${b.name}</span>`).join('') || '<span style="color:var(--muted);font-size:12px">봇 없음</span>'}
    </div>
  `;

  const groupPanel = document.getElementById('groupPanel');
  groupPanel.innerHTML = `
    <div class="panel-header">
      <div>
        <div class="panel-title">운영 그룹 현황</div>
        <div class="panel-sub">담당자 배정 그룹 · ${(groups || []).length}개</div>
      </div>
      <span class="real-badge">✓ 실데이터</span>
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

/* ─── Update Topbar & Hero Meta ─────────────────────────────────────────── */
function updateBanner(d) {
  const timeStr = new Date(d.updatedAt).toLocaleString('ko-KR');
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
  const res = await fetch(`/api/data?${qs}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

/* ─── Schedule Refresh (dedup) ──────────────────────────────────────────── */
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
    const score = computeHealthScore(data);
    const insights = generateInsights(data, score);

    renderHealthScore(score, data);
    renderKPIs(data);
    renderAlertStrip(data, score);
    renderInsights(insights);
    renderActionCenter(data, score, insights);

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
    if (eb) { eb.textContent = `⚠ 데이터 로드 실패: ${err.message} — 5분 후 자동 재시도`; eb.style.display = 'block'; }
    scheduleRefresh();
  }
}

/* ─── Silent Refresh ────────────────────────────────────────────────────── */
async function silentRefresh() {
  try {
    const data = await fetchData();
    lastData = data;
    updateBanner(data);
    const score = computeHealthScore(data);
    const insights = generateInsights(data, score);
    renderHealthScore(score, data);
    renderKPIs(data);
    renderAlertStrip(data, score);
    renderInsights(insights);
    renderActionCenter(data, score, insights);
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
  scheduleRefresh(); // ← fixed: use scheduleRefresh instead of raw setTimeout
}

/* ─── Events ─────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Manual refresh button
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.addEventListener('click', () => triggerFullReload());

  // Range filter tabs
  document.querySelectorAll('.range-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const range = tabBtn.dataset.range;
      document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
      tabBtn.classList.add('active');
      currentDays = range === 'all' ? 'all' : parseInt(range);
      triggerFullReload();
    });
  });

  // Collapsible sections
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
