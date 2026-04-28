// Autostay CS Dashboard â app.js  v3.3
// 9ê° ì¶ê° í­ëª©: ë³´ì¡° íµê³(ì¤ìê°Â·p90Â·8h+ì ì¸), í¼í¬ ì±ëÂ·ì¥ê¸°ì íì¨, íí¸ë§µ í¼í¬TOP3,
// ë´ë¹ì ì¡°ì¹ ê¶ê³  ì¹´ë, ì»´íë ì¸ í¤ë ê°ì¡°, 500ê±´ ê¸°ì¤ ëªíí, dedup, basisNote ê°ì 

'use strict';

/* âââ Constants âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */
const COLORS = [
  '#0f766e','#be123c','#14b8a6','#3b82f6','#8b5cf6',
  '#f59e0b','#0369a1','#e11d48','#6d28d9','#0d9488'
];
const AVATAR_COLORS = [
  '#0f766e,#14b8a6','#1d4ed8,#3b82f6','#b45309,#f59e0b',
  '#be123c,#f43f5e','#6d28d9,#8b5cf6','#0369a1,#0ea5e9','#059669,#34d399'
];
const EXCLUDED_MANAGERS = ['ì ìë¯¼'];

const VOC_CONTEXTS = {
  'ì ê¸°êµ¬ë/ì ê¸°êµ¬ëì°¨ëë³ê²½': 'êµ¬ë ì°¨ë ë³ê²½ ìì²­ Â· ìëí íë¡ì° ì ê² ê¶ì¥',
  'ì»´íë ì¸': 'ìë¹ì¤ ë¶ë§ ì§ì  íì Â· ì¦ì ëì íì',
  'ì ê¸°êµ¬ë': 'êµ¬ë ì ì²­Â·í´ì§Â·ë³ê²½ ì¼ë° ë¬¸ì',
  'ë¨ìì´ì©ë¬¸ì': 'ì¬ì© ë°©ë²Â·ì´ì© ìë´ ì¼ë° ë¬¸ì',
  'ê¸°í': 'ë¶ë¥ ì¸ ê¸°í ë¬¸ì',
  'ê°ë§¹ìë´ë¬¸ì': 'íí¸ë ë§¤ì¥ ê°ë§¹ ìë´ Â· ììí ì°ê²° ê¶ì¥',
  'ì»´íë ì¸/ì´ì©ë¶ê°': 'ìë¹ì¤ ì´ì© ë¶ê° ìí Â· ì¦ì ëì íì',
  'íì/íí´': 'íì íí´ ìì²­ Â· íí´ ê·¸ë£¹ ì°ê³',
};

/* âââ Chart.js Defaults âââââââââââââââââââââââââââââââââââââââââââââââââââ */
Chart.defaults.font.family = "'Pretendard Variable', Pretendard, sans-serif";
Chart.defaults.color = '#78716c';
Chart.defaults.borderColor = '#f1efe8';

let charts = {};
let lastData = null;
let currentDays = 30;
let refreshTimer = null;
let lastSuccessTime = null; // í­ëª© #10: ë§ì§ë§ ì±ê³µ ëê¸°í ìê°

/* âââ Loading Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââ */
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

/* âââ Formatters ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */
function fmt(n, unit = '') {
  if (n == null) return 'â';
  return Number(n).toLocaleString('ko-KR') + unit;
}
function initials(name) {
  return (name || '?').replace(/ì¤í ì¤íì´_/, '').replace(/[^A-Za-zê°-í£]/g, '').slice(0, 2).toUpperCase() || '?';
}
function avatarStyle(idx) {
  const [a, b] = AVATAR_COLORS[idx % AVATAR_COLORS.length].split(',');
  return `background:linear-gradient(135deg,${a},${b})`;
}

/* âââ CS Health Score âââââââââââââââââââââââââââââââââââââââââââââââââââââ */
function computeHealthScore(d) {
  let score = 100;
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;

  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('ì»´íë ì¸')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintRate = complaints / total;
  let deductComplaint = 0;
  if (complaintRate > 0.20)      deductComplaint = 25;
  else if (complaintRate > 0.15) deductComplaint = 18;
  else if (complaintRate > 0.10) deductComplaint = 10;
  else if (complaintRate > 0.05) deductComplaint = 4;
  score -= deductComplaint;

  const slowRate = (rb['8ìê°+'] || 0) / resTotal;
  const medRate  = (rb['2~8ìê°'] || 0) / resTotal;
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

  const quickRate = ((rb['0~5ë¶'] || 0) + (rb['5~30ë¶'] || 0)) / resTotal;
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
  if (score >= 80) return { grade: 'A', label: 'ìí¸', color: '#15803d' };
  if (score >= 65) return { grade: 'B', label: 'ë³´íµ', color: '#b45309' };
  if (score >= 50) return { grade: 'C', label: 'ì£¼ì', color: '#dc2626' };
  return { grade: 'D', label: 'ìí', color: '#be123c' };
}

/* âââ Auto-Insights âââââââââââââââââââââââââââââââââââââââââââââââââââââââ */
function generateInsights(d, scoreObj) {
  const score = scoreObj.score;
  const insights = [];
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));

  const complaintPct = scoreObj.complaintPct;
  if (complaintPct >= 15) {
    insights.push({ type: 'danger', icon: 'ìí', text: `ì»´íë ì¸ ${complaintPct}% â ì¦ê° ëì íì (ê¸°ì¤: 15% ì´ê³¼)` });
  } else if (complaintPct >= 8) {
    insights.push({ type: 'warn', icon: 'ì£¼ì', text: `ì»´íë ì¸ ${complaintPct}% â ëª¨ëí°ë§ íì (ê¸°ì¤: 8% ì´ê³¼)` });
  }

  if (managers.length > 0) {
    const topPct = Math.round((managers[0].count || 0) / total * 100);
    const topName = managers[0].name.replace('ì¤í ì¤íì´_', '');
    const unassigned = d.summary?.unassignedChats || 0;
    if (topPct > 80) {
      insights.push({ type: 'danger', icon: 'ìí', text: `${topName} ì§ì¤ë ${topPct}% â ìë¬´ í¸ì¤ ì¬ê° (ê¸°ì¤: 80% ì´ê³¼)${unassigned > 0 ? ` Â· ë¯¸ë°°ì  ${unassigned}ê±´` : ''}` });
    } else if (topPct > 60) {
      insights.push({ type: 'warn', icon: 'ì£¼ì', text: `${topName} ì§ì¤ë ${topPct}% â ì¬ë°°ì  ê²í  ê¶ì¥ (ê¸°ì¤: 60% ì´ê³¼)${unassigned > 0 ? ` Â· ë¯¸ë°°ì  ${unassigned}ê±´` : ''}` });
    } else if (unassigned > 0) {
      insights.push({ type: 'warn', icon: 'ì£¼ì', text: `ë¯¸ë°°ì  ${unassigned}ê±´ â ë´ë¹ì ì§ì  íì` });
    }
  }

  const slowPct = Math.round((rb['8ìê°+'] || 0) / resTotal * 100);
  if (slowPct > 30) {
    insights.push({ type: 'warn', icon: 'ì§ì°', text: `8ìê°+ í´ê²° ${slowPct}% â ë¹ëê¸° ëê¸° í¬í¨ Â· ì ì± ì ê² íì (ê¸°ì¤: 30% ì´ê³¼)` });
  }

  const quickPct = Math.round(((rb['0~5ë¶'] || 0) + (rb['5~30ë¶'] || 0)) / resTotal * 100);
  if (quickPct >= 40) {
    insights.push({ type: 'good', icon: 'ìí¸', text: `30ë¶ ë´ í´ê²° ${quickPct}% â ì ì ëì ìí¸ (ê¸°ì¤: 40% ì´ì)` });
  }

  const subIdx = (d.tags?.labels || []).findIndex(l => l.includes('ì ê¸°êµ¬ë'));
  if (subIdx >= 0) {
    const subPct = Math.round((d.tags.values[subIdx] || 0) / total * 100);
    if (subPct >= 25) {
      insights.push({ type: 'info', icon: 'ì ê²', text: `êµ¬ë ê´ë ¨ ë¬¸ì ${subPct}% â FAQ ìëí íë¡ì° ì ê² ê¶ì¥` });
    }
  }

  const openCount = d.summary.openChats || 0;
  if (openCount > 0) {
    insights.push({ type: 'warn', icon: 'ëê¸°', text: `ë¯¸í´ê²° ì¤í ì±í ${openCount}ê±´ â íì¬ ì²ë¦¬ ì¤` });
  } else {
    insights.push({ type: 'good', icon: 'ìë£', text: 'íì¬ ë¯¸í´ê²° ì±í ìì' });
  }

  const vals = (d.dailyTrend?.values || []).filter(v => v > 0);
  if (vals.length > 3) {
    const peak = Math.max(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (peak > avg * 3) {
      insights.push({ type: 'info', icon: 'í¼í¬', text: `${d.summary.peakDay?.label} ì´ì ê¸ì¦ (${peak}ê±´ Â· íê·  ${Math.round(avg)}ê±´ ëë¹ ${Math.round(peak/avg)}ë°°)` });
    }
  }

  return insights;
}

/* âââ Render: Health Score + ê°ì  ìì¸ (í­ëª© #4) âââââââââââââââââââââââââ */
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

  // ìí¬ ê²ì´ì§ ì ëë©ì´ì
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

  // ê²ì´ì§ ì ì ì ì«ì
  const sv = document.getElementById('healthScore');
  if (sv) { sv.textContent = score; sv.setAttribute('fill', gs.color); }

  // ë±ê¸ ë±ì§ (ì°ìë¨ pill)
  const sg = document.getElementById('healthGrade');
  if (sg) {
    sg.textContent = `${grade} Â· ${label}`;
    sg.style.cssText = `background:${gs.bg};border-color:${gs.border};color:${gs.color}`;
  }

  // ì¹´ë íëë¦¬ ìì (ë±ê¸ì ë°ë¼)
  const card = document.getElementById('healthCard');
  if (card) card.style.borderColor = GRADE_CARD_BORDER[grade] || GRADE_CARD_BORDER.D;

  // ê°ì  ìì¸ â ë° + ìì¹ íì¼ë¡ íì
  const ss = document.getElementById('healthSub');
  if (!ss) return;

  const factors = [];
  if (deductComplaint > 0) factors.push({ label: 'ì»´íë ì¸ì¨', val: `${complaintPct}%`, pct: Math.min(complaintPct, 100), deduct: deductComplaint });
  if (deductSlow > 0)      factors.push({ label: '8ìê°+ ìëµ', val: `${slowPct}%`,      pct: Math.min(slowPct, 100),      deduct: deductSlow });
  if (deductConc > 0)      factors.push({ label: 'ì§ì¤ë',     val: `${topPct}%`,       pct: Math.min(topPct, 100),       deduct: deductConc });

  // ë¶ì ê¸°ì¤ ë¸í¸ (ê²ì´ì§ íë¨)
  const basisNoteEl = document.getElementById('gaugeBasisNote');
  if (basisNoteEl) {
    const dn = d.dataNote || {};
    const collected = dn.collected || d.summary?.totalChats || 0;
    const rangeText = currentDays === 'all' ? `ìµê·¼ ${dn.limit || 500}ê±´ íë` : `ìµê·¼ ${currentDays}ì¼`;
    basisNoteEl.textContent = `${rangeText} Â· ${collected}ê±´ ê¸°ì¤ ë¶ì`;
  }

  if (factors.length === 0) {
    ss.innerHTML = '<div class="hf-row-ok">â ê°ì  ìì¸ ìì</div>';
  } else {
    const totalDeduct = deductComplaint + deductSlow + deductConc;
    ss.innerHTML = factors.map(f => `
      <div class="hf-row">
        <span class="hf-row-label">${f.label}</span>
        <div class="hf-row-bar-wrap"><div class="hf-row-bar" style="width:${f.pct}%;background:${gs.barColor}"></div></div>
        <span class="hf-row-val">${f.val}</span>
        <span class="hf-row-deduct" style="color:${gs.color}">-${f.deduct}ì </span>
      </div>
    `).join('') + `<div class="hf-total-row">ì´ ê°ì  -${totalDeduct}ì  / 100ì </div>`;
  }
}

/* âââ Render: Insights Strip ââââââââââââââââââââââââââââââââââââââââââââââ */
function renderInsights(insights) {
  const strip = document.getElementById('insightsStrip');
  if (!strip) return;
  if (!insights.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = `
    <div class="insights-label">ìë ì¸ì¬ì´í¸</div>
    ${insights.map(ins => `
      <div class="insight-chip ${ins.type}">
        <span class="insight-icon insight-label-badge">${ins.icon}</span>
        <span>${ins.text}</span>
      </div>
    `).join('')}
  `;
}

/* âââ Render: Alert Strip âââââââââââââââââââââââââââââââââââââââââââââââââ */
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
        level: 'danger', icon: 'ê³¼ë¶í',
        title: 'ë´ë¹ì ê³¼ë¶í',
        body: `${managers[0].name}ì´(ê°) ì ì²´ ${topPct}% (${managers[0].count}ê±´) ë¨ë ì²ë¦¬ ì¤. ìë¬´ ë¶ì° íì.`
      });
    }
  }

  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('ì»´íë ì¸')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintPct = Math.round(complaints / total * 100);
  if (complaintPct >= 15) {
    alerts.push({
      level: 'danger', icon: 'ê¸´ê¸',
      title: 'ì»´íë ì¸ ê¸ì¦',
      body: `ì»´íë ì¸ íê·¸ ${complaintPct}% (${complaints}ê±´) â ìë¹ì¤ íì§ ì¦ì ì ê² ê¶ì¥.`
    });
  }

  const slowPct = Math.round((rb['8ìê°+'] || 0) / resTotal * 100);
  if (slowPct > 40) {
    alerts.push({
      level: 'warn', icon: 'ì§ì°',
      title: 'ì¥ìê° ë¯¸í´ê²° ë¤ì',
      body: `ì ì²´ì ${slowPct}%ê° 8ìê° ì´ì ìì. ë¹ëê¸° ìëµ ì ì± ê²í  ê¶ì¥.`
    });
  }

  if (score < 50) {
    alerts.push({
      level: 'danger', icon: 'Dë±ê¸',
      title: 'CS ê±´ê° ìí ë¨ê³',
      body: `CS ê±´ê° ì ì ${score}ì  â ë³µí© ìí ìí. ê¸´ê¸ CS ì´ì ê°ì  íì.`
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

/* âââ Render: Action Command Center ââââââââââââââââââââââââââââââââââââââ */
function renderActionCenter(d, scoreObj, insights) {
  // ë¯¸ë°°ì  ì±í ì¦ì ì¡°ì¹ ë°°ë
  const unassignedCount = d.summary?.unassignedChats || 0;
  const banner = document.getElementById('acUnassignedBanner');
  if (banner) {
    if (unassignedCount > 0) {
      banner.style.display = 'flex';
      const countEl = document.getElementById('acUnassignedCount');
      if (countEl) countEl.textContent = unassignedCount;
      const descEl = document.getElementById('acUnassignedDesc');
      if (descEl) descEl.textContent = `ë´ë¹ì ë¯¸ë°°ì  ì±í ${unassignedCount}ê±´ â ì¦ì ë°°ì  íì. ì±ëí¡ ê´ë¦¬ì > ë¯¸ë°°ì  í íì¸.`;
    } else {
      banner.style.display = 'none';
    }
  }

  const score = scoreObj.score;
  const total = d.summary.totalChats || 1;
  const rb = d.resolutionBuckets || {};
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));

  const complaints = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('ì»´íë ì¸')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);
  const complaintPct = Math.round(complaints / total * 100);
  const slowPct = Math.round((rb['8ìê°+'] || 0) / resTotal * 100);
  const quickPct = Math.round(((rb['0~5ë¶'] || 0) + (rb['5~30ë¶'] || 0)) / resTotal * 100);

  // ââ ì¹´ë 1: ì¤ë ì¡°ì¹í  í­ëª© ââ
  const todayItems = [];

  if (d.summary.openChats > 0) {
    todayItems.push({
      type: 'danger', label: 'ì¦ì',
      title: `ë¯¸í´ê²° ì¤í ì±í ${d.summary.openChats}ê±´`,
      desc: 'ì¦ì íì¸ ë° ìëµ íì â ê³ ê° ëê¸° ì¤'
    });
  }
  if (complaintPct >= 15) {
    todayItems.push({
      type: 'danger', label: 'ê¸´ê¸',
      title: `ì»´íë ì¸ ${complaintPct}% (${complaints}ê±´)`,
      desc: 'ìë¹ì¤ ë¶ë§ ê¸ì¦ â ìì¸ íì ë° ì¦ì ëì'
    });
  } else if (complaintPct >= 8) {
    todayItems.push({
      type: 'warn', label: 'ì£¼ì',
      title: `ì»´íë ì¸ ${complaintPct}% (${complaints}ê±´)`,
      desc: 'ì§ì ëª¨ëí°ë§ â ì¶ì´ ê´ì°° ê¶ì¥'
    });
  }
  if (managers.length > 0) {
    const topPct2 = Math.round((managers[0].count || 0) / total * 100);
    if (topPct2 > 70) {
      todayItems.push({
        type: 'danger', label: 'ë¶ì°íì',
        title: `${managers[0].name} ì§ì¤ë ${topPct2}%`,
        desc: 'ë¨ë ì²ë¦¬ ê³¼ë¶í â ë´ë¹ì ì¶ê° ë°°ì  ê²í  Â· ì¬ë°°ì  í íì¸'
      });
    }
  }
  // 8ìê°+ ê±´ì´ ë§ì¼ë©´ drill-down ìë´ (í­ëª© #7 ì°ê³)
  if ((rb['8ìê°+'] || 0) > 0) {
    todayItems.push({
      type: 'info', label: 'íì¸',
      title: `8ìê°+ ë¯¸í´ê²° ${rb['8ìê°+'] || 0}ê±´`,
      desc: `<a class="ac-drill-link" href="#" onclick="openLongChatsPanel();return false;">â¸ ìì¸ ëª©ë¡ ë³´ê¸° (ë ì§Â·íê·¸Â·ë´ë¹ì)</a>`
    });
  }

  if (todayItems.length === 0) {
    todayItems.push({ type: 'good', label: 'ì ì', title: 'ì¡°ì¹ íì í­ëª© ìì', desc: 'CS ìí ìí¸ â ì ê¸° ëª¨ëí°ë§ ì ì§' });
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

  // ââ ì¹´ë 2: ì£¼ì ë¦¬ì¤í¬ TOP 3 ââ
  const riskItems = [];
  if (score < 50) riskItems.push({ type: 'danger', label: 'Dë±ê¸', title: `CS ê±´ê° Dë±ê¸ (${score}ì )`, desc: 'ë³µí© ìí ìí â ê¸´ê¸ CS ì´ì ì ê² íì' });
  if (complaintPct >= 10) riskItems.push({ type: 'danger', label: 'ë¶ë§', title: `ì»´íë ì¸ì¨ ${complaintPct}%`, desc: 'ìë¹ì¤ íì§ íë½ ì í¸ â ì¦ì ëì' });
  if (slowPct > 30) riskItems.push({ type: 'warn', label: 'ì§ì°', title: `8ìê°+ í´ê²° ${slowPct}%`, desc: 'ë¹ëê¸° ì±í ê´ë¦¬ ì ì± ì ê² íì' });
  if (managers.length > 0) {
    const topRisk = Math.round((managers[0].count || 0) / total * 100);
    if (topRisk > 60) riskItems.push({ type: 'warn', label: 'ì§ì¤', title: `${managers[0].name} ì§ì¤ ${topRisk}%`, desc: 'ìë¬´ ë¶ì° ë° ë°±ì ë´ë¹ì ì§ì  ê¶ì¥' });
  }
  if (d.summary.openChats > 5) riskItems.push({ type: 'warn', label: 'ëê¸°', title: `ë¯¸ìëµ ì¤í ${d.summary.openChats}ê±´`, desc: 'ê³ ê° ëê¸° ì¥ê¸°í â ì°ì  ì²ë¦¬ íì' });
  if (quickPct < 20) riskItems.push({ type: 'warn', label: 'ìë', title: `30ë¶ ë´ í´ê²° ${quickPct}%`, desc: 'ìëµ ìë ê°ì  íì â SLA ê¸°ì¤ ìë¦½ ê¶ì¥' });

  const topRisks = riskItems.slice(0, 3);
  if (topRisks.length === 0) topRisks.push({ type: 'good', label: 'ì ì', title: 'ì£¼ì ë¦¬ì¤í¬ ìì', desc: 'CS ì§í ì ì ë²ì ì ì§ ì¤' });

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

  // ââ ì¹´ë 3: VOC ìë¦¼ ââ
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
    vocBadge.textContent = urgentVoc > 0 ? `${urgentVoc}ê±´ ê¸´ê¸` : `${risingTags.length}ê±´ ì£¼ëª©`;
    vocBadge.className = urgentVoc > 0 ? 'ac-count' : 'ac-badge';
  }

  if (vocBody) {
    if (!risingTags.length) {
      vocBody.innerHTML = '<div class="ac-empty">10% ì´ì VOC ìì â ë¶ì° ë¶í¬ ìí¸</div>';
    } else {
      vocBody.innerHTML = risingTags.map(t => {
        const ctx  = VOC_CONTEXTS[t.lbl] || 'ê´ë ¨ ë¬¸ì';
        const type = t.pct >= 15 ? 'danger' : 'warn';
        const lbl  = t.lbl.includes('ì»´íë ì¸') ? 'ë¶ë§' : t.lbl.includes('êµ¬ë') ? 'êµ¬ë' : t.lbl.includes('íí´') ? 'íí´' : 'ë¬¸ì';
        return `
          <div class="ac-item ${type}">
            <div class="ac-item-icon ac-label-badge">${lbl}</div>
            <div class="ac-item-text">
              <div class="ac-item-title">#${t.lbl} Â· ${t.pct}% (${t.cnt}ê±´)</div>
              <div class="ac-item-desc">${ctx}</div>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

/* âââ Render: Hero Quick Stats (hero-copy íë¨ íµì¬ ìì¹) ââââââââââââââââ */
function renderHeroQuickStats(d, scoreObj) {
  const el = document.getElementById('heroQuickStats');
  if (!el) return;

  const totalChats   = d.summary?.totalChats || 0;
  const openChats    = d.summary?.openChats  ?? 'â';
  const complaintPct = scoreObj ? (scoreObj.complaintPct || 0) : 0;
  const avgRes       = d.summary?.avgResolutionMin;

  // íê· í´ê²°ìê° í¬ë§·
  let avgResText = 'â';
  if (avgRes != null && avgRes > 0) {
    avgResText = avgRes >= 60
      ? `${Math.floor(avgRes / 60)}h${avgRes % 60 > 0 ? Math.floor(avgRes % 60) + 'm' : ''}`
      : `${Math.round(avgRes)}ë¶`;
  }

  // ì»´íë ì¸ì¨ ìì
  const complaintColor = complaintPct >= 15 ? 'var(--rose)' : complaintPct >= 8 ? 'var(--amber)' : 'var(--teal)';

  document.getElementById('hqsTotal').textContent     = fmt(totalChats) + 'ê±´';
  document.getElementById('hqsOpen').textContent      = openChats + 'ê±´';
  document.getElementById('hqsComplaint').textContent = complaintPct + '%';
  document.getElementById('hqsComplaint').style.color = complaintColor;
  document.getElementById('hqsAvgRes').textContent    = avgResText;

  el.style.display = 'flex';
}

/* âââ Render: KPI Grid (í­ëª© #2 â ë°ì´í° ìì§ ê¸°ì¤ ëªì) ââââââââââââââââ */
function renderKPIs(d, scoreObj) {
  const { summary } = d;
  const managers = (d.managers || []).filter(m => !EXCLUDED_MANAGERS.includes(m.name));
  const topMgr   = managers[0];
  const totalChats  = summary.totalChats;
  const openChats   = summary.openChats;
  const avgRes      = summary.avgResolutionMin;
  const peakCount   = summary.peakDay?.count || 0;
  const peakLabel   = summary.peakDay?.label || 'â';
  const topPct      = topMgr ? Math.round((topMgr.count / totalChats) * 100) : 0;
  const rb          = d.resolutionBuckets || {};
  const resTotal    = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quickPct    = Math.round(((rb['0~5ë¶'] || 0) + (rb['5~30ë¶'] || 0)) / resTotal * 100);

  // ì»´íë ì¸ KPI (scoreObjë¡ë¶í°)
  const complaintPct = scoreObj ? (scoreObj.complaintPct || 0) : 0;
  const complaintCount = (d.tags?.labels || []).reduce((acc, lbl, i) => {
    if (lbl.includes('ì»´íë ì¸')) acc += (d.tags.values[i] || 0);
    return acc;
  }, 0);

  const TARGET_AVG_MIN  = 120;
  const TARGET_QUICK_PCT = 60;
  const avgResFill  = avgRes != null ? Math.min(Math.round((TARGET_AVG_MIN / Math.max(avgRes, 1)) * 100), 100) : 0;
  const avgResClass = avgRes != null && avgRes <= TARGET_AVG_MIN ? '' : avgRes <= TARGET_AVG_MIN * 1.5 ? 'warn' : 'danger';
  const quickFill   = Math.min(quickPct, 100);
  const quickClass  = quickPct >= TARGET_QUICK_PCT ? '' : quickPct >= TARGET_QUICK_PCT * 0.7 ? 'warn' : 'danger';

  // ìì§ ê¸°ì¤ ë¬¸êµ¬ (í­ëª© #1 â í­ ëªì¹­, #2 â ê¸°ì¤ ëªì)
  const dataNote   = d.dataNote || {};
  const collected  = dataNote.collected  || 0;
  const isSampled  = dataNote.isSampled  || false;
  const limitVal   = dataNote.limit      || 500;
  const rangeLabel = currentDays === 'all'
    ? (isSampled ? `ìµê·¼ ${limitVal}ê±´ íë` : `ìì§ ${collected}ê±´`)
    : `${currentDays}ì¼`;
  const basisNote  = currentDays === 'all'
    ? `${isSampled ? `â  ìì§ ìí(${limitVal}ê±´) ëë¬ Â· ì ì²´ ê¸°ê° ìë` : `ìì§ ${collected}ê±´`} Â· closed ì±í ê¸°ì¤ Â· KST`
    : `ìµê·¼ ${currentDays}ì¼ Â· closed ì±í ìµë ${limitVal}ê±´ ê¸°ì¤ Â· ${totalChats}ê±´ ì§ê³ Â· KST`;

  // ë¶ì ê¸°ì¤ í¤ë íì
  const kpiBasisHeaderEl = document.getElementById('kpiBasisHeader');
  if (kpiBasisHeaderEl) {
    kpiBasisHeaderEl.style.display = 'flex';
    const sampledWarn = isSampled ? ` <span style="color:var(--amber);font-weight:700">â  ìì§ ìí(${limitVal}ê±´) ëë¬</span>` : '';
    kpiBasisHeaderEl.innerHTML = `<span>ð ë¶ì ê¸°ì¤</span> <span style="font-weight:400;color:#0d9488">${currentDays === 'all' ? `ìµê·¼ ${limitVal}ê±´ íë` : `ìµê·¼ ${currentDays}ì¼`} Â· closed ì±í <strong>${totalChats}ê±´</strong> ì§ê³ Â· KST ê¸°ì¤</span>${sampledWarn}`;
  }

  const grid = document.getElementById('kpiGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">ë¶ì ì±í ì</div>
      <div class="kpi-value">${fmt(totalChats)}<span class="unit">ê±´</span></div>
      <div class="kpi-meta"><span class="data-badge badge-real">ì¤ë°ì´í°</span><span class="delta neutral">${rangeLabel}</span></div>
    </div>
    <div class="kpi-card a-${openChats > 5 ? 'rose' : openChats > 0 ? 'amber' : 'green'}">
      <div class="kpi-label">íì¬ ì¤í</div>
      <div class="kpi-value">${fmt(openChats)}<span class="unit">ê±´</span></div>
      <div class="kpi-meta"><span class="data-badge badge-real">ì¤ë°ì´í°</span><span class="delta ${openChats === 0 ? 'good' : 'bad'}">${openChats === 0 ? 'ìì' : 'ì§íì¤'}</span><span class="delta-lbl">ì¤ìê°</span></div>
    </div>
    <div class="kpi-card a-${avgResClass === 'danger' ? 'rose' : avgResClass === 'warn' ? 'amber' : 'green'}">
      <div class="kpi-label">íê·  í´ê²°ìê°</div>
      <div class="kpi-value">${fmt(avgRes)}<span class="unit">ë¶</span></div>
      <div class="kpi-meta"><span class="data-badge badge-calc">ê³ì°ê°</span><span class="delta neutral">ëª©í ${TARGET_AVG_MIN}ë¶</span></div>
      <div class="kpi-target-wrap">
        <div class="kpi-target-label"><span>ë¬ì±ë¥ </span><span>${avgResFill}%</span></div>
        <div class="kpi-target"><div class="kpi-target-fill ${avgResClass}" style="width:${avgResFill}%"></div></div>
      </div>
    </div>
    <div class="kpi-card a-${quickPct >= TARGET_QUICK_PCT ? 'green' : quickPct >= 30 ? 'amber' : 'rose'}">
      <div class="kpi-label">30ë¶ ë´ í´ê²°ë¥ </div>
      <div class="kpi-value">${quickPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="data-badge badge-calc">ê³ì°ê°</span><span class="delta ${quickPct >= TARGET_QUICK_PCT ? 'good' : 'bad'}">${quickPct >= TARGET_QUICK_PCT ? 'ëª©í ë¬ì±' : 'ê°ì  íì'}</span></div>
      <div class="kpi-target-wrap">
        <div class="kpi-target-label"><span>ëª©í ${TARGET_QUICK_PCT}%</span><span>${quickFill}%</span></div>
        <div class="kpi-target"><div class="kpi-target-fill ${quickClass}" style="width:${quickFill}%"></div></div>
      </div>
    </div>
    <div class="kpi-card a-${topPct > 80 ? 'rose' : topPct > 60 ? 'amber' : 'green'}">
      <div class="kpi-label">ì£¼ë´ë¹ì ì§ì¤ë</div>
      <div class="kpi-value">${topPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="data-badge badge-calc">ê³ì°ê°</span><span class="delta neutral">${topMgr?.name || 'â'}</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">ì¼ ìµê³  í¼í¬</div>
      <div class="kpi-value">${fmt(peakCount)}<span class="unit">ê±´</span></div>
      <div class="kpi-meta"><span class="data-badge badge-real">ì¤ë°ì´í°</span><span class="delta bad">${peakLabel}</span></div>
    </div>
    <div class="kpi-card a-${complaintPct >= 15 ? 'rose' : complaintPct >= 8 ? 'amber' : 'green'}">
      <div class="kpi-label">ì»´íë ì¸ì¨</div>
      <div class="kpi-value">${complaintPct}<span class="unit">%</span></div>
      <div class="kpi-meta"><span class="data-badge badge-real">ì¤ë°ì´í°</span><span class="delta ${complaintPct >= 15 ? 'bad' : complaintPct >= 8 ? 'warn' : 'good'}">${complaintPct >= 15 ? 'ì¦ì ëì' : complaintPct >= 8 ? 'ëª¨ëí°ë§' : 'ìí¸'}</span></div>
      <div class="kpi-meta" style="margin-top:2px"><span style="font-size:10px;color:var(--muted)">${complaintCount}ê±´</span></div>
    </div>
  `;
}

/* âââ Render: Trend Chart âââââââââââââââââââââââââââââââââââââââââââââââââ */
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
  if (badge) badge.textContent = currentDays === 'all' ? 'ìµê·¼ 500ê±´' : `${currentDays}ì¼`;

  document.getElementById('trendLegend').innerHTML = `
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#0f766e;display:inline-block"></span>ì¼ë°</span>
    <span class="trend-legend-item"><span style="width:10px;height:10px;border-radius:2px;background:#be123c;display:inline-block"></span>í¼í¬</span>
    <span class="trend-legend-item"><span style="width:22px;height:3px;background:none;border-top:1.5px dashed #f59e0b;display:inline-block"></span>íê· ì </span>
  `;

  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart(document.getElementById('trendChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: dailyTrend.labels,
      datasets: [
        {
          label: 'ì¢ë£ ì±í',
          data: dailyTrend.values,
          backgroundColor: dailyTrend.values.map(v =>
            v >= peak * 0.8 ? '#be123c' : v >= peak * 0.45 ? '#0f766e' : '#14b8a6'
          ),
          borderRadius: 3, borderSkipped: false,
        },
        {
          label: 'ì¼ íê· ',
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
          callbacks: { label: ctx => ctx.dataset.type === 'line' ? `íê· : ${ctx.parsed.y}ê±´` : `${ctx.parsed.y}ê±´` }
        },
        annotation: {
          annotations: peak > avg * 2 ? {
            peakLine: {
              type: 'line', yMin: peak, yMax: peak,
              borderColor: '#be123c', borderWidth: 1.5, borderDash: [4, 3],
              label: {
                content: `í¼í¬ ${peak}ê±´`, display: true, position: 'end',
                backgroundColor: '#be123c', color: '#fff',
                font: { size: 10, weight: 'bold' }, padding: { x: 6, y: 3 }, borderRadius: 4,
              }
            }
          } : {}
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, maxTicksLimit: 12 } },
        y: { grid: { color: '#f1efe8' }, ticks: { font: { size: 11 }, callback: v => v + 'ê±´' }, beginAtZero: true }
      }
    }
  });

  // í¼í¬ ë¶ì í¨ë ë ëë§ (í­ëª© #9)
  renderPeakAnalysis(d.peakAnalysis, d.managers || []);
}

/* âââ Render: Peak Analysis Panel (í­ëª© #9) âââââââââââââââââââââââââââââââ */
function renderPeakAnalysis(peakAnalysis, managers) {
  const el = document.getElementById('peakAnalysisPanel');
  if (!el) return;
  if (!peakAnalysis || peakAnalysis.count < 2) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  const mgrMap = {};
  (managers || []).forEach(m => { mgrMap[m.id] = m.name; });

  const topTagsHtml = (peakAnalysis.topTags || []).map(t =>
    `<span class="peak-tag">#${t.tag} <strong>${t.cnt}</strong>ê±´</span>`
  ).join('');

  const topMgrHtml = (peakAnalysis.topAssignees || []).map(a =>
    `<span class="peak-tag">${mgrMap[a.id] || a.id} <strong>${a.cnt}</strong>ê±´</span>`
  ).join('') || '<span style="color:var(--muted);font-size:11px">ë´ë¹ì ì ë³´ ìì</span>';

  const hourStr = peakAnalysis.peakHour
    ? `${peakAnalysis.peakHour.hour}ì (${peakAnalysis.peakHour.cnt}ê±´ ì§ì¤)`
    : 'â';

  // ì ì ì±ë ë¶í¬
  const pkSrc = peakAnalysis.sources || {};
  const pkSrcTotal = (pkSrc.native || 0) + (pkSrc.phone || 0) + (pkSrc.other || 0) || 1;
  const srcParts = [];
  if (pkSrc.native > 0) srcParts.push(`ì±/ì¹ ${Math.round(pkSrc.native / pkSrcTotal * 100)}%`);
  if (pkSrc.phone  > 0) srcParts.push(`ì í ${Math.round(pkSrc.phone  / pkSrcTotal * 100)}%`);
  if (pkSrc.other  > 0) srcParts.push(`ê¸°í ${Math.round(pkSrc.other  / pkSrcTotal * 100)}%`);
  const srcHtml = srcParts.length
    ? srcParts.map(s => `<span class="peak-tag">${s}</span>`).join('')
    : '<span style="color:var(--muted);font-size:11px">ë°ì´í° ìì</span>';

  // ì¥ê¸°ì±í ì íì¨
  const longRate = peakAnalysis.longChatRate ?? null;
  const longRateColor = longRate > 30 ? 'var(--rose)' : longRate > 15 ? 'var(--amber)' : 'var(--teal)';

  el.innerHTML = `
    <div class="peak-panel-header">
      <span class="peak-date-badge">${peakAnalysis.date}</span>
      <span class="peak-count-badge">ìµê³  ${peakAnalysis.count}ê±´</span>
      <span class="peak-title">í¼í¬ ì¼ì ìì¸ ë¶ì</span>
      <span class="data-badge badge-analyze">ë¶ìê°</span>
    </div>
    <div class="peak-facts">
      <div class="peak-fact"><span class="peak-fact-lbl">ì§ì¤ íê·¸</span><div class="peak-fact-vals">${topTagsHtml || '<span style="color:var(--muted);font-size:11px">íê·¸ ìì</span>'}</div></div>
      <div class="peak-fact"><span class="peak-fact-lbl">ì²ë¦¬ ë´ë¹ì</span><div class="peak-fact-vals">${topMgrHtml}</div></div>
      <div class="peak-fact"><span class="peak-fact-lbl">í¼í¬ ìê°ë</span><div class="peak-fact-vals"><span class="peak-tag">${hourStr}</span></div></div>
      <div class="peak-fact"><span class="peak-fact-lbl">ì ì ì±ë</span><div class="peak-fact-vals">${srcHtml}</div></div>
      ${longRate != null ? `<div class="peak-fact"><span class="peak-fact-lbl">ì¥ê¸°ì íì¨</span><div class="peak-fact-vals"><span class="peak-tag" style="color:${longRateColor};font-weight:700">${longRate}% <span style="font-size:10px;font-weight:400;color:var(--muted)">(8h+ ë¹ì¨)</span></span></div></div>` : ''}
    </div>
  `;
}

/* âââ Render: Heatmap âââââââââââââââââââââââââââââââââââââââââââââââââââââ */
function renderHeatmap(d) {
  const days = ['ì', 'í', 'ì', 'ëª©', 'ê¸', 'í ', 'ì¼'];
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
      cell.title = `${day}ìì¼ ${h}ì Â· ${v}ê±´`;
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

  // ââ í¼í¬ ìê°ë TOP 3 ìì½ (íí¸ë§µ ì¬ë°± íì©) âââââââââââââââââââââââââââââ
  const hmPeakEl = document.getElementById('hmPeakSummary');
  if (hmPeakEl) {
    // ìê°ëë³ ì ì²´ í©ì° (ìì¼ ë¬´ê´)
    const hourTotals = {};
    for (let di = 0; di < 7; di++) {
      for (let h = 0; h < 24; h++) {
        const v = hm[`${di}-${h}`] || 0;
        hourTotals[h] = (hourTotals[h] || 0) + v;
      }
    }
    const top3Hours = Object.entries(hourTotals)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[
