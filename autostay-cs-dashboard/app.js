ARD_BORDER = { A: '#a7f3d0', B: '#fde68a', C: '#fed7aa', D: '#fecdd3' };

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

  const countEl = document.getElementById('acTodayCountARD_BORDER = { A: '#a7f3d0', B: '#fde68a', C: '#fed7aa', D: '#fecdd3' };

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
      <div class="kpi-meta"><span class="data-badge badge-real">ì¤ë°ì´í°</span><span class="delta ${complaintPct >= 15 ? 'bad' : complaintPct >= 8 ? 'warn' : 'good'}">${complaintPct >= 15 ? 'ì¦ì ëì' : complaintPct >= 8 ? 'ëª¨ëí°ë§' : 'ìí¸'}|/span></div>
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
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    // ìì¼ë³ ì ì²´ í©ì°
    const dayLabels = ['ì', 'í', 'ì', 'ëª©', 'ê¸', 'í ', 'ì¼'];
    const dayTotals = {};
    for (let di = 0; di < 7; di++) {
      dayTotals[di] = 0;
      for (let h = 0; h < 24; h++) dayTotals[di] += hm[`${di}-${h}`] || 0;
    }
    const peakDayIdx = Object.entries(dayTotals).sort((a, b) => b[1] - a[1])[0];

    hmPeakEl.innerHTML = `
      <div class="hm-peak-title">í¼í¬ ì§ì¤ ìê°ë</div>
      <div class="hm-peak-list">
        ${top3Hours.map(([h, v], rank) => `
          <div class="hm-peak-row rank-${rank + 1}">
            <span class="hm-peak-rank">${rank + 1}ì</span>
            <span class="hm-peak-hour">${h}ì</span>
            <div class="hm-peak-bar-wrap"><div class="hm-peak-bar" style="width:${Math.round(v / (top3Hours[0][1] || 1) * 100)}%"></div></div>
            <span class="hm-peak-val">${v}ê±´</span>
          </div>
        `).join('')}
      </div>
      ${peakDayIdx ? `<div class="hm-peak-day-note">ð ì£¼ê° ìµë¤: <strong>${dayLabels[parseInt(peakDayIdx[0])]}ìì¼</strong> (${peakDayIdx[1]}ê±´)</div>` : ''}
    `;
  }
}

/* âââ Render: Category Doughnut âââââââââââââââââââââââââââââââââââââââââââ */
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
          callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}ê±´ (${((ctx.parsed / summary.totalChats) * 100).toFixed(1)}%)` }
        }
      }
    }
  });
}

/* âââ Render: Category Bars (í­ëª© #5 â ì»´íë ì¸ ë¶ë¦¬) ââââââââââââââââââââ */
function renderCategoryBars(d) {
  const { tags, summary } = d;
  const total = summary.totalChats || 1;

  // ì»´íë ì¸ ë¶ë¦¬: "ì»´íë ì¸" ì ì²´, "ì»´íë ì¸/ì´ì©ë¶ê°" ë³ë íì
  const groups = {
    'êµ¬ë ê´ë ¨':         { count: 0, color: '#0f766e',  badge: 'ì¤ë°ì´í°' },
    'ì»´íë ì¸ (ì ì²´)':   { count: 0, color: '#be123c',  badge: 'ì¤ë°ì´í°' },
    'ì»´íë ì¸/ì´ì©ë¶ê°': { count: 0, color: '#e11d48',  badge: 'ì¤ë°ì´í°' },
    'ì´ì© ë¬¸ì':         { count: 0, color: '#1d4ed8',  badge: 'ì¤ë°ì´í°' },
    'ê¸°í/ì´ì':         { count: 0, color: '#6d28d9',  badge: 'ì¤ë°ì´í°' },
  };

  (tags?.labels || []).forEach((lbl, i) => {
    const val = tags.values[i] || 0;
    if (lbl.includes('ì ê¸°êµ¬ë') || lbl === 'êµ¬ë')   groups['êµ¬ë ê´ë ¨'].count += val;
    else if (lbl === 'ì»´íë ì¸/ì´ì©ë¶ê°')              groups['ì»´íë ì¸/ì´ì©ë¶ê°'].count += val;
    else if (lbl.includes('ì»´íë ì¸'))                 groups['ì»´íë ì¸ (ì ì²´)'].count += val;
    else if (lbl.includes('ì´ì©') || lbl.includes('ë¨ì')) groups['ì´ì© ë¬¸ì'].count += val;
    else                                               groups['ê¸°í/ì´ì'].count += val;
  });

  // ì»´íë ì¸ ì ì²´ = ì¼ë° ì»´íë ì¸ + ì´ì©ë¶ê° (ì¤ë³µ ì¹´ì´í¸ ìì´ íì)
  groups['ì»´íë ì¸ (ì ì²´)'].count += groups['ì»´íë ì¸/ì´ì©ë¶ê°'].count;

  const items = Object.entries(groups)
    .map(([label, g]) => ({ label, count: g.count, color: g.color, pct: Math.round(g.count / total * 100) }))
    .sort((a, b) => b.count - a.count);

  const maxCount = Math.max(...items.map(i => i.count), 1);
  const el = document.getElementById('categoryBars');

  // ì»´íë ì¸ ì ì²´ í©ê³ (ì ì²´ + ì´ì©ë¶ê° ì¤ë³µ ìì´ ì´ë¯¸ ê³ì°ë¨)
  const complaintItem = items.find(i => i.label === 'ì»´íë ì¸ (ì ì²´)');
  const complaintSummaryHtml = complaintItem && complaintItem.count > 0 ? `
    <div class="cat-complaint-header">
      <span class="cat-complaint-icon">â </span>
      <span class="cat-complaint-label">ì»´íë ì¸ ì ì²´</span>
      <span class="cat-complaint-count">${complaintItem.count}ê±´</span>
      <span class="cat-complaint-pct">${complaintItem.pct}%</span>
      ${complaintItem.pct >= 15 ? '<span class="cat-complaint-badge danger">ì¦ì ëì</span>' : complaintItem.pct >= 8 ? '<span class="cat-complaint-badge warn">ëª¨ëí°ë§</span>' : ''}
    </div>
  ` : '';

  el.innerHTML = complaintSummaryHtml + items.map(item => `
    <div class="cat-bar-row${item.label === 'ì»´íë ì¸ (ì ì²´)' ? ' cat-bar-row-complaint' : ''}">
      <div class="cat-bar-label">${item.label}</div>
      <div class="cat-bar-track">
        <div class="cat-bar-fill" style="width:${Math.max(item.count / maxCount * 100, item.count > 0 ? 3 : 0)}%;background:${item.color}"></div>
      </div>
      <div class="cat-bar-val">${item.count}ê±´<span class="cat-pct">${item.pct}%</span></div>
    </div>
  `).join('');
}

/* âââ Render: Channel Chart âââââââââââââââââââââââââââââââââââââââââââââââ */
function renderChannel(d) {
  const { sources, summary } = d;
  const total = summary.totalChats || 1;
  const labels = ['ìì¬ ì±/ì¹', 'ì í'];
  const values = [sources.native || 0, sources.phone || 0];
  const bgColors = ['#0f766e', '#1d4ed8'];
  if ((sources.other || 0) > 0) { labels.push('ê¸°í'); values.push(sources.other); bgColors.push('#a8a29e'); }

  if (charts.ch) charts.ch.destroy();
  charts.ch = new Chart(document.getElementById('channelChart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderRadius: 4, barThickness: 22 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 9, cornerRadius: 7, callbacks: { label: ctx => `${ctx.parsed.x.toLocaleString()}ê±´ (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` } }
      },
      scales: {
        x: { ticks: { callback: v => v + 'ê±´', font: { size: 11 } }, grid: { color: '#f1efe8' }, beginAtZero: true },
        y: { grid: { display: false }, ticks: { font: { size: 11.5 } } }
      }
    }
  });
}

/* âââ Render: Channel Stats âââââââââââââââââââââââââââââââââââââââââââââââ */
function renderChannelStats(d) {
  const { sources, summary } = d;
  const total = summary.totalChats || 1;
  const items = [
    { label: 'ìì¬ ì±/ì¹ (native)', count: sources.native || 0, color: '#0f766e' },
    { label: 'ì í (phone)',        count: sources.phone || 0,  color: '#1d4ed8' },
    { label: 'ê¸°í',                count: sources.other || 0,  color: '#a8a29e' },
  ];
  const el = document.getElementById('channelStats');
  el.innerHTML = items.filter(s => s.count > 0).map(s => `
    <div class="ch-stat">
      <div class="ch-stat-dot" style="background:${s.color}"></div>
      <div class="ch-stat-label">${s.label}</div>
      <div class="ch-stat-count">${s.count.toLocaleString()}ê±´</div>
      <div class="ch-stat-pct">${Math.round(s.count / total * 100)}%</div>
    </div>
  `).join('');
}

/* âââ Render: Resolution Time âââââââââââââââââââââââââââââââââââââââââââââ */
function renderResolution(d) {
  const rb = d.resolutionBuckets;
  const resTotal = Object.values(rb).reduce((a, b) => a + b, 0) || 1;
  const quick = (rb['0~5ë¶'] || 0) + (rb['5~30ë¶'] || 0);
  const quickPct = Math.round(quick / resTotal * 100);
  const slowPct  = Math.round((rb['8ìê°+'] || 0) / resTotal * 100);

  const rs = d.resolutionStats || {};
  // 0ì ë°ì´í° ììì¼ë¡ ì²ë¦¬ (ë¹ì´ìë resolutionStatsìì 0ì´ ë°íë  ì ìì)
  const medianMin  = (rs.median  > 0) ? rs.median  : null;
  const p90Min     = (rs.p90     > 0) ? rs.p90     : null;
  const avgEx8hMin = (rs.avgEx8h > 0) ? rs.avgEx8h : null;

  const resSummary = document.getElementById('resSummary');
  if (resSummary) {
    resSummary.innerHTML = `
      <div class="res-big ${quickPct >= 50 ? 'good' : quickPct >= 30 ? 'warn' : 'bad'}">
        <div class="res-big-val">${quickPct}%</div>
        <div class="res-big-lbl">30ë¶ ë´ í´ê²°ë¥ </div>
      </div>
      <div class="res-big ${slowPct <= 20 ? 'good' : slowPct <= 40 ? 'warn' : 'bad'}">
        <div class="res-big-val">${slowPct}%</div>
        <div class="res-big-lbl">8ìê°+ ì¥ê¸°</div>
        ${(rb['8ìê°+'] || 0) > 0 ? `<a href="#" class="drill-link" onclick="openLongChatsPanel();return false;">â¸ ìì¸ë³´ê¸°</a>` : ''}
      </div>
      <div class="res-big">
        <div class="res-big-val">${d.summary.avgResolutionMin ?? 'â'}</div>
        <div class="res-big-lbl">íê· (ë¶)</div>
      </div>
    `;
  }

  // ë³´ì¡° íµê³ ë¸ë¡ (ì¤ìê° Â· p90 Â· 8h+ì ì¸ íê· )
  const resAuxEl = document.getElementById('resAuxStats');
  if (resAuxEl) {
    resAuxEl.innerHTML = `
      <div class="res-aux-row">
        <span class="res-aux-item" title="ì ì²´ í´ê²°ìê°ì ì¤ê°ê° â ê·¹ë¨ê°ì ë ë¯¼ê°í ëíê°">
          <span class="res-aux-lbl">ì¤ìê°</span>
          <span class="res-aux-val">${medianMin != null ? medianMin + 'ë¶' : 'â'}</span>
          <span class="data-badge badge-calc" style="font-size:9px">ê³ì°ê°</span>
        </span>
        <span class="res-aux-item" title="ìì 10% ê¸°ì¤ì  â ì´ ê°ì ì´ê³¼íë©´ ì¥ê¸° ì¼ì´ì¤">
          <span class="res-aux-lbl">90í¼ì¼íì¼</span>
          <span class="res-aux-val">${p90Min != null ? p90Min + 'ë¶' : 'â'}</span>
          <span class="data-badge badge-calc" style="font-size:9px">ê³ì°ê°</span>
        </span>
        <span class="res-aux-item" title="8ìê°+ ë¹ëê¸° ì±í ì ì¸ íê·  â ì¤ì  ìë ìê°ì ë ê·¼ì ">
          <span class="res-aux-lbl">8h+ì ì¸ íê· </span>
          <span class="res-aux-val ${avgEx8hMin != null && avgEx8hMin > 120 ? 'warn-text' : ''}">${avgEx8hMin != null ? avgEx8hMin + 'ë¶' : 'â'}</span>
          <span class="data-badge badge-analyze" style="font-size:9px">ë¶ìê°</span>
        </span>
      </div>
    `;
  }

  const buckets = [
    { label: '0~5ë¶',      val: rb['0~5ë¶'] || 0,      cls: 'ok',   note: 'ì¢ì í´ê²°' },
    { label: '5~30ë¶',     val: rb['5~30ë¶'] || 0,     cls: 'ok',   note: 'ì ì ì²ë¦¬' },
    { label: '30ë¶~2ìê°', val: rb['30ë¶~2ìê°'] || 0, cls: 'warn', note: 'ì¼ë°' },
    { label: '2~8ìê°',    val: rb['2~8ìê°'] || 0,    cls: 'warn', note: 'ì§ì°' },
    { label: '8ìê°+',     val: rb['8ìê°+'] || 0,     cls: 'bad',  note: 'ë¹ëê¸°Â·ìµì¼' },
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
              <span class="rt-bar-label${pct < 18 ? ' light' : ''}">${b.val}ê±´ Â· ${pct}%</span>
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
      ? `ì ì²´ íê·  ${avg}ë¶ (â${Math.round(avg / 60 * 10) / 10}ìê°) Â· ë¹ëê¸° ì±í í¹ì±ì ê³ ê° ë¯¸ìëµ ìê° í¬í¨`
      : 'íê·  í´ê²°ìê° ë°ì´í° ìì';
  }
}

/* âââ Render: VOC (í­ëª© #8 â ë¹ì¨ ê¸°ë°ìì ëªíí) âââââââââââââââââââââââ */
function renderVOC(d) {
  const { tags, summary } = d;
  const el = document.getElementById('vocList');
  if (!tags?.labels?.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px">íê·¸ ë°ì´í° ìì</div>';
    return;
  }
  const totalForPct = summary.totalChats || 1;
  el.innerHTML = tags.labels.slice(0, 8).map((lbl, i) => {
    const cnt = tags.values[i];
    const pct = Math.round(cnt / totalForPct * 100);
    const cls = pct >= 15 ? 'rising' : pct >= 8 ? 'warn-r' : '';
    const ctx = VOC_CONTEXTS[lbl] || 'ê´ë ¨ ë¬¸ì';
    // í­ëª© #8: ì ì£¼ ëë¹ ë¹êµ ìì´ "ë¹ì¨ ê¸°ë°" íììì ëªíí
    const trendHtml = pct >= 15
      ? '<span class="voc-trend up">ë¹ì¨ ìì</span>'
      : pct >= 8
        ? '<span class="voc-trend up" style="background:var(--amber-bg);color:var(--amber)">ì£¼ëª© íì</span>'
        : '<span class="voc-trend flat">ì¼ë°</span>';
    return `
      <div class="voc-item ${cls}">
        <div>
          <div class="voc-keyword">#${lbl} ${trendHtml}</div>
          <div class="voc-context">${ctx}</div>
        </div>
        <div class="voc-count">ì´ <strong>${cnt}</strong>ê±´</div>
        <div class="voc-pct ${pct >= 15 ? 'pct-high' : pct >= 8 ? 'pct-mid' : 'pct-low'}">${pct}%</div>
      </div>
    `;
  }).join('');
}

/* âââ Manager Sort State ââââââââââââââââââââââââââââââââââââââââââââââââââ */
let agentSortKey = 'count';
let lastManagerData = null;

// í­ëª© #12: ì´ëª¨ì§ â íì¤í¸ ë¼ë²¨ ê¸°ë° ì½ë©í¸
function agentComment(m, rank) {
  if (!m.count) return '<span class="agent-comment off">ë¹íì±</span>';
  if (rank === 0 && m.operatorScore > 30 && m.touchScore > 50)
    return '<span class="agent-comment top">TOP í¼í¬ë¨¸</span>';
  if (m.operatorScore < 10 && m.touchScore < 20)
    return '<span class="agent-comment warn">ì½ì¹­ íì</span>';
  if (m.touchScore < 20)
    return '<span class="agent-comment warn">ìë ë³´ì</span>';
  if (m.operatorScore < 10)
    return '<span class="agent-comment warn">í¨ì¨ ì ê²</span>';
  return '<span class="agent-comment normal">ì ì</span>';
}

/* âââ Render: Manager Rows (í­ëª© #3 â ë´ë¹ìë³ ê°ë³ í´ê²°ìê°) âââââââââââ */
function renderManagerRows(managers, total, _avgRes) {
  const tbody = document.getE
