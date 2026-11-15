/**
 * A股实时股东人数监测台 - 前端实时交互与双轴图表引擎
 * 支持三种运行架构无缝自适应：
 * 1. local: 本地常驻服务（SSE 毫秒级长连接 + 五源采集 + SSH 公网穿透）
 * 2. vercel: Vercel Serverless 全栈云函数（五源按需采集 + 智能客户端轮询）
 * 3. gh-pages: GitHub Pages 纯静态云端（预置多源问答库 + 浏览器跨域直连东财实时披露与实时行情）
 */
import { renderQrSvg } from './qrcode.mjs';
import { BrowserLiveEngine } from './browserEngine.mjs';

const WATCHLIST_STORAGE_KEY = 'holder_watchlist_v2';
const browserEngine = new BrowserLiveEngine();

const state = {
  runtimeMode: 'local', // 'local' | 'vercel' | 'gh-pages'
  snapshot: null,
  status: null,
  activeTab: 'fused', // 'fused' | 'qa' | 'em' | 'watchlist'
  chipFilter: 'all', // 'all' | 'concentrated' | 'sharp5' | 'sharp10' | 'divergence' | 'ahead'
  boardFilter: 'all',
  sortBy: 'time', // 'time' | 'drop' | 'rise' | 'avgcap'
  qaValidOnly: true,
  searchQuery: '',
  soundEnabled: localStorage.getItem('holder_sound') !== '0',
  notifyEnabled: localStorage.getItem('holder_notify') === '1',
  currentDrawerCode: null,
  currentDrawerData: null,
  mobileAccess: null,
  mobileModalOpen: false,
  esInstance: null,
  clientPollTimer: null,
  clientSeenIds: new Set(),
};

function getSavedWatchCodes() {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => (typeof x === 'string' ? x : x?.code)).filter((c) => /^\d{6}$/.test(String(c || '')));
  } catch {
    return [];
  }
}

function saveWatchlistToStorage(watchlist = []) {
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
  } catch {
    // ignore
  }
}

function isCloudWebOrigin() {
  const h = window.location.hostname;
  return window.location.protocol === 'https:' && h !== 'localhost' && h !== '127.0.0.1';
}

// ---------------- 安全转义与数值格式化 ----------------
function esc(val) {
  if (val == null) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtHolderNum(num) {
  if (num == null || !Number.isFinite(Number(num))) return '--';
  return `${Math.round(Number(num)).toLocaleString('zh-CN')} 户`;
}

function fmtSignedInt(num) {
  if (num == null || !Number.isFinite(Number(num))) return '--';
  const n = Math.round(Number(num));
  const prefix = n > 0 ? '+' : '';
  return `${prefix}${n.toLocaleString('zh-CN')} 户`;
}

function fmtAvgCap(yuan) {
  if (yuan == null || !Number.isFinite(Number(yuan))) return '--';
  const wan = Number(yuan) / 10000;
  if (wan >= 100) return `${wan.toFixed(1)} 万`;
  return `${wan.toFixed(2)} 万`;
}

function fmtPriceChrate(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return '<span style="color:var(--text-muted)">--</span>';
  const v = Number(pct);
  const sign = v > 0 ? '+' : '';
  const cls = v > 0 ? 'text-bull' : v < 0 ? 'text-bear' : '';
  return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
}

function renderDeltaBadge(ratio) {
  if (ratio == null || !Number.isFinite(Number(ratio))) {
    return `<span class="delta-pill is-neutral">待对比上期</span>`;
  }
  const r = Number(ratio);
  if (r < 0) {
    let tag = '集中';
    if (r <= -10) tag = '⚡急剧集中';
    else if (r <= -5) tag = '🔥大幅集中';
    return `<span class="delta-pill is-bull">▼ ${r.toFixed(2)}% · ${tag}</span>`;
  }
  if (r > 0) {
    const tag = r >= 10 ? '大幅分散' : '分散';
    return `<span class="delta-pill is-bear">▲ +${r.toFixed(2)}% · ${tag}</span>`;
  }
  return `<span class="delta-pill is-neutral">0.00% · 持平</span>`;
}

function isDivergenceItem(item) {
  return (
    item.holderChangeRatio != null &&
    item.holderChangeRatio <= -2 &&
    (item.intervalChrate == null || item.intervalChrate <= 3) &&
    (item.postCutoffChrate == null || item.postCutoffChrate <= 3.5)
  );
}

// ---------------- Web Audio 合成提示音与系统桌面通知 ----------------
let audioCtx = null;

function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// 首次点击页面任意处自动解锁浏览器音频上下文
window.addEventListener('pointerdown', () => ensureAudioContext(), { once: true });

function playAlertChime(isUrgent = false) {
  if (!state.soundEnabled) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;

  const notes = isUrgent ? [523.25, 659.25, 1046.5] : [587.33, 880.0];
  const now = ctx.currentTime;

  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + idx * 0.11);

    gain.gain.setValueAtTime(0.001, now + idx * 0.11);
    gain.gain.exponentialRampToValueAtTime(0.16, now + idx * 0.11 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + idx * 0.11 + 0.36);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + idx * 0.11);
    osc.stop(now + idx * 0.11 + 0.38);
  });
}

function sendSystemNotification(item) {
  if (!state.notifyEnabled || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const ratioStr =
    item.holderChangeRatio != null
      ? ` (${item.holderChangeRatio > 0 ? '+' : ''}${Number(item.holderChangeRatio).toFixed(2)}%)`
      : '';
  const prefix = item.isSimulated ? '[测试] ' : item.isWatched ? '⭐[自选] ' : '🔔 ';
  const title = `${prefix}${item.stockName}(${item.stockCode}) 最新股东人数`;
  const body = `截至 ${item.endDate || '最新'}：${fmtHolderNum(item.holderNum)}${ratioStr} · 来源：${item.sourceLabel || '实时监测'}`;

  try {
    const n = new Notification(title, {
      body,
      tag: `holder_${item.stockCode}_${item.endDate || Date.now()}`,
    });
    n.onclick = () => {
      window.focus();
      openStockDrawer(item.stockCode);
      n.close();
    };
  } catch {
    // 忽略部分浏览器环境限制
  }
}

function showInAppToast(item) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast-item';
  const ratioText =
    item.holderChangeRatio != null
      ? `${item.holderChangeRatio > 0 ? '+' : ''}${Number(item.holderChangeRatio).toFixed(2)}%`
      : '刚披露';

  el.innerHTML = `
    <div class="toast-title">
      <span>${item.isSimulated ? '🔔 [模拟测试] ' : item.isWatched ? '⭐ [自选更新] ' : '⚡ [新披露] '}${esc(item.stockName)} (${esc(item.stockCode)})</span>
      <span class="${(item.holderChangeRatio ?? 0) < 0 ? 'text-bull' : 'text-bear'}">${esc(ratioText)}</span>
    </div>
    <div class="toast-body">
      截至 ${esc(item.endDate || '最新')} 股东数 <strong>${esc(fmtHolderNum(item.holderNum))}</strong> · ${esc(item.sourceLabel || '')}
    </div>
  `;
  el.addEventListener('click', () => {
    openStockDrawer(item.stockCode);
    el.remove();
  });
  container.appendChild(el);
  setTimeout(() => {
    if (el.parentNode) el.remove();
  }, 8000);
}

function triggerAlerts(alerts = []) {
  if (!alerts.length) return;
  const hasUrgent = alerts.some(
    (a) => a.isWatched || (a.holderChangeRatio != null && a.holderChangeRatio <= -5)
  );
  playAlertChime(hasUrgent);

  // 手机端触觉震动反馈（Android / 支持的移动端浏览器）
  try {
    if (navigator.vibrate) {
      navigator.vibrate(hasUrgent ? [140, 70, 180] : [100]);
    }
  } catch {
    // ignore
  }

  alerts.slice(0, 3).forEach((item) => {
    showInAppToast(item);
    sendSystemNotification(item);
  });
}

// ---------------- 顶部状态栏与倒计时渲染 ----------------
function updateAlertButtonsUI() {
  const soundBtn = document.getElementById('soundToggleBtn');
  soundBtn.classList.toggle('is-active', state.soundEnabled);
  soundBtn.textContent = state.soundEnabled ? '🔊 声音提醒: 开' : '🔇 声音提醒: 关';

  const notifyBtn = document.getElementById('notifyToggleBtn');
  const granted = 'Notification' in window && Notification.permission === 'granted' && state.notifyEnabled;
  notifyBtn.classList.toggle('is-active', granted);
  if (!('Notification' in window)) {
    notifyBtn.textContent = '🖥 桌面通知: 不支持';
  } else if (Notification.permission === 'denied') {
    notifyBtn.textContent = '🖥 桌面通知: 已拦截';
  } else {
    notifyBtn.textContent = granted ? '🖥 桌面通知: 已开启' : '🖥 桌面通知: 点击开启';
  }
}

function renderStatus(status) {
  if (!status) return;
  state.status = status;

  const badge = document.getElementById('liveBadge');
  const statusText = document.getElementById('liveStatusText');
  const pauseBtn = document.getElementById('pauseBtn');
  const intervalSelect = document.getElementById('intervalSelect');

  badge.classList.remove('is-live', 'is-paused', 'is-polling');
  if (status.isPolling) {
    badge.classList.add('is-polling');
    statusText.textContent = '正在同步五引擎数据...';
  } else if (status.settings?.paused) {
    badge.classList.add('is-paused');
    statusText.textContent = '自动轮询已暂停';
  } else {
    badge.classList.add('is-live');
    statusText.textContent = '实时监测中';
  }

  pauseBtn.textContent = status.settings?.paused ? '▶ 恢复轮询' : '⏸ 暂停';
  if (status.settings?.pollIntervalSec) {
    intervalSelect.value = String(status.settings.pollIntervalSec);
  }

  // 五大源连接健康状态
  const healthBar = document.getElementById('sourceHealthBar');
  for (const key of ['eastmoney', 'szse_irm', 'sse_ehudong', 'p5w_ir', 'live_quote']) {
    const chip = healthBar.querySelector(`[data-src="${key}"]`);
    const info = status.sourceHealth?.[key];
    if (!chip || !info) continue;
    chip.className = `health-chip ${info.status}`;
    const emEl = chip.querySelector('.latency');
    if (info.status === 'ok') {
      emEl.textContent = `${info.latencyMs}ms`;
      chip.title = `${info.name} · 最近同步条数 ${info.count}`;
    } else if (info.status === 'loading') {
      emEl.textContent = '采集中';
    } else if (info.status === 'error') {
      emEl.textContent = '重试中';
      chip.title = `${info.name} 异常: ${info.error || ''}`;
    }
  }
}

setInterval(() => {
  const el = document.getElementById('countdownText');
  const st = state.status;
  if (!st || st.settings?.paused || !st.nextPollAt) {
    el.textContent = st?.settings?.paused ? '已暂停轮询' : '准备就绪';
    return;
  }
  if (st.isPolling) {
    el.textContent = '同步中...';
    return;
  }
  const remain = Math.max(0, Math.ceil((st.nextPollAt - Date.now()) / 1000));
  el.textContent = `下次轮询 ${remain}s`;
}, 1000);

// ---------------- KPI 与过滤逻辑 ----------------
function renderSummaryKPIs(summary) {
  if (!summary) return;
  document.getElementById('kpiLatestDate').textContent = summary.latestNoticeDate || '--';
  document.getElementById('kpiTotalCounts').textContent =
    `融合流 ${summary.totalFusedCount} 条 · 互动去重后 ${summary.totalQACount} 条`;

  if (summary.accuracy) {
    const accPct = Math.min(summary.accuracy.benchmarkAccuracyPct, summary.accuracy.crossConsistencyPct);
    document.getElementById('accuracyBadgeVal').textContent =
      summary.accuracy.crossVerifiedPairs > 0
        ? `${accPct.toFixed(accPct === 100 ? 0 : 1)}% (${summary.accuracy.crossVerifiedPairs}组对账)`
        : `${summary.accuracy.benchmarkAccuracyPct}%`;
  }

  const rate = summary.concentrationRatio || 0;
  document.getElementById('kpiConcentrationRate').textContent = `${rate.toFixed(1)}%`;
  document.getElementById('kpiRatioFill').style.width = `${Math.max(5, Math.min(95, rate))}%`;
  document.getElementById('kpiConcentratedDetail').textContent =
    `集中 ${summary.decreasedCount} 家（≤-5%: ${summary.sharpDecreasedCount}） / 分散 ${summary.increasedCount} 家`;

  document.getElementById('kpiAheadCount').textContent = `${summary.aheadCount} 家`;
  document.getElementById('kpiDivergenceBadge').textContent = `背离吸筹 ${summary.divergenceCount} 家`;

  const topEl = document.getElementById('kpiTopStock');
  const topSub = document.getElementById('kpiTopStockSub');
  if (summary.topConcentrated) {
    const t = summary.topConcentrated;
    topEl.innerHTML = `${esc(t.stockName)} <span class="text-bull">${Number(t.holderChangeRatio).toFixed(2)}%</span>`;
    topSub.textContent = `${t.stockCode} · 截至 ${t.endDate} · 点击看双轴趋势图`;
    document.getElementById('kpiCardTopDrop').dataset.code = t.stockCode;
  } else {
    topEl.textContent = '--';
  }
}

function filterAndSortItems(rawList, isQATab = false) {
  let list = [...rawList];

  if (isQATab && state.qaValidOnly) {
    list = list.filter((x) => x.replyType === 'disclosed');
  }

  // 芯片条件过滤
  if (state.chipFilter === 'concentrated') {
    list = list.filter((x) => x.holderChangeRatio != null && x.holderChangeRatio < 0);
  } else if (state.chipFilter === 'sharp5') {
    list = list.filter((x) => x.holderChangeRatio != null && x.holderChangeRatio <= -5);
  } else if (state.chipFilter === 'sharp10') {
    list = list.filter((x) => x.holderChangeRatio != null && x.holderChangeRatio <= -10);
  } else if (state.chipFilter === 'divergence') {
    list = list.filter((x) => isDivergenceItem(x));
  } else if (state.chipFilter === 'ahead') {
    list = list.filter((x) => x.syncStatus === 'ahead');
  }

  // 板块过滤
  if (state.boardFilter !== 'all') {
    list = list.filter((x) => x.board === state.boardFilter);
  }

  // 本地搜索词过滤
  const q = state.searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (x) =>
        String(x.stockCode || '').toLowerCase().includes(q) ||
        String(x.stockName || '').toLowerCase().includes(q) ||
        String(x.answer || '').toLowerCase().includes(q)
    );
  }

  // 排序
  if (state.sortBy === 'drop') {
    list.sort((a, b) => (a.holderChangeRatio ?? 999) - (b.holderChangeRatio ?? 999));
  } else if (state.sortBy === 'unpumped') {
    list = list.filter((x) => x.holderChangeRatio != null && x.holderChangeRatio < -1);
    list.sort((a, b) => {
      const scoreA = (a.holderChangeRatio || 0) + Math.max(0, (a.postCutoffChrate || 0) * 1.2);
      const scoreB = (b.holderChangeRatio || 0) + Math.max(0, (b.postCutoffChrate || 0) * 1.2);
      return scoreA - scoreB;
    });
  } else if (state.sortBy === 'rise') {
    list.sort((a, b) => (b.holderChangeRatio ?? -999) - (a.holderChangeRatio ?? -999));
  } else if (state.sortBy === 'avgcap') {
    list.sort((a, b) => (b.avgMarketCap ?? -1) - (a.avgMarketCap ?? -1));
  }

  return list;
}

// ---------------- 卡片与表格渲染 ----------------
function renderFeedCard(item) {
  const strongConc = item.holderChangeRatio != null && item.holderChangeRatio <= -5;
  const isAhead = item.syncStatus === 'ahead';
  const divergence = isDivergenceItem(item);

  const classes = ['feed-card'];
  if (strongConc) classes.push('is-concentrated-strong');
  if (isAhead) classes.push('is-ahead');
  if (item.isNew) classes.push('is-new');

  const badges = [];
  if (item.isNew) badges.push(`<span class="badge-new">NEW</span>`);
  if (isAhead) badges.push(`<span class="badge-ahead">⚡ 一手抢先 · 领先东财</span>`);
  else if (item.fusedType === 'dual_verified') badges.push(`<span class="badge-dual">✓ 双源印证</span>`);
  if (item.replyType === 'stale_periodic') badges.push(`<span class="badge-stale">旧季报复述</span>`);
  if (item.typoCorrectedFrom) {
    badges.push(`<span class="badge-noise" title="董秘原文笔误写成了未来日期 ${esc(item.typoCorrectedFrom)}，引擎已结合提问锚点与交易日历自动纠偏为 ${esc(item.endDate)}">🛠️ 已纠偏笔误</span>`);
  }
  if (item.roundingNoiseWarning) badges.push(`<span class="badge-noise" title="董秘披露为约数（如约XX万户），上期精确值落在该约数四舍五入区间内">≈ 约数误差带内</span>`);
  if (divergence) badges.push(`<span class="badge-divergence">💎 黄金潜伏</span>`);
  if (item.duplicateCount && item.duplicateCount > 1) {
    badges.push(`<span class="board-badge" title="同日多条相同数值回复已自动合并，保留最早披露时刻">同批×${item.duplicateCount}</span>`);
  }

  let qaBlock = '';
  if (item.answer) {
    const declinedCls = item.replyType === 'declined' || item.replyType === 'stale_periodic' ? 'is-declined' : '';
    qaBlock = `
      <div class="qa-snippet ${declinedCls}">
        ${item.question ? `<div class="qa-q-line">问：${esc(item.question.slice(0, 90))}${item.question.length > 90 ? '...' : ''}</div>` : ''}
        <div><strong>董秘回复：</strong>${esc(item.answer.slice(0, 150))}${item.answer.length > 150 ? '...' : ''}</div>
      </div>
    `;
  }

  const timeDisplay = item.answerTimeStr || `披露日 ${item.noticeDate || '--'}`;
  const subMetricLabel =
    item.postCutoffChrate != null
      ? '户均市值 / 截止后涨跌'
      : item.avgMarketCap != null
        ? '户均市值 / 统计期涨跌'
        : '上期户数 / 上期截止';
  const subMetricVal =
    item.postCutoffChrate != null
      ? `${fmtAvgCap(item.avgMarketCap)} · ${fmtPriceChrate(item.postCutoffChrate)}`
      : item.avgMarketCap != null
        ? `${fmtAvgCap(item.avgMarketCap)} · ${fmtPriceChrate(item.intervalChrate)}`
        : `${fmtHolderNum(item.prevHolderNum)}`;
  const subMetricFoot =
    item.prevHolderNum != null
      ? `上期 ${fmtHolderNum(item.prevHolderNum)} (${esc(item.prevEndDate || '--')})`
      : item.excludesBuyback
        ? '已剔除回购专用账户'
        : '点击查看历次趋势对比';
  const priceFoot =
    item.livePrice != null
      ? `现价 ¥${Number(item.livePrice).toFixed(2)}${item.intervalChrate != null ? ` · 期涨跌 ${Number(item.intervalChrate) > 0 ? '+' : ''}${Number(item.intervalChrate).toFixed(1)}%` : ''}`
      : item.closePrice != null
        ? `截止收盘 ¥${Number(item.closePrice).toFixed(2)}`
        : '';

  return `
    <article class="${classes.join(' ')}" data-stock-code="${esc(item.stockCode)}">
      <div class="card-top">
        <div class="stock-identity">
          <span class="stock-name">${esc(item.stockName)}</span>
          <span class="code-badge">${esc(item.stockCode)}</span>
          <span class="board-badge">${esc(item.board || '')}</span>
          ${badges.join('')}
        </div>
        <button
          class="star-btn ${item.isWatched ? 'watched' : ''}"
          data-watch-code="${esc(item.stockCode)}"
          data-watch-name="${esc(item.stockName)}"
          title="${item.isWatched ? '取消自选盯盘' : '加入自选重点盯盘'}"
        >${item.isWatched ? '★' : '☆'}</button>
      </div>

      <div class="metrics-row">
        <div class="metric-cell">
          <span class="metric-label">最新股东户数 (${esc(item.endDate || '未注明截止日')})</span>
          <span class="metric-val">${item.holderNum ? esc(fmtHolderNum(item.holderNum)) : '<span style="color:var(--text-muted)">未直接披露数值</span>'}</span>
          <span class="metric-sub">${esc(subMetricFoot)}</span>
        </div>
        <div class="metric-cell">
          <span class="metric-label">较上期变化幅度</span>
          <div style="margin-top:3px">${renderDeltaBadge(item.holderChangeRatio)}</div>
          <span class="metric-sub" style="margin-top:2px">${item.holderChange != null ? esc(fmtSignedInt(item.holderChange)) : ''}</span>
        </div>
        <div class="metric-cell">
          <span class="metric-label">${subMetricLabel}</span>
          <span class="metric-val" style="font-size:13.5px">${subMetricVal}</span>
          <span class="metric-sub">${esc(priceFoot)}</span>
        </div>
      </div>

      ${qaBlock}

      <div class="card-footer">
        <span class="source-tag">📡 ${esc(item.sourceLabel || '')}</span>
        <span>${esc(timeDisplay)} · 点击看趋势图 →</span>
      </div>
    </article>
  `;
}

function renderEmTable(list) {
  if (!list.length) {
    return `<div class="empty-state">当前筛选条件下暂无匹配的东方财富结构化记录</div>`;
  }
  const rowsHtml = list
    .map(
      (item) => `
      <tr data-stock-code="${esc(item.stockCode)}">
        <td>
          <button
            class="star-btn ${item.isWatched ? 'watched' : ''}"
            data-watch-code="${esc(item.stockCode)}"
            data-watch-name="${esc(item.stockName)}"
          >${item.isWatched ? '★' : '☆'}</button>
          <strong>${esc(item.stockName)}</strong>
          <span class="code-badge">${esc(item.stockCode)}</span>
        </td>
        <td><span class="board-badge">${esc(item.board)}</span></td>
        <td><strong>${esc(fmtHolderNum(item.holderNum))}</strong></td>
        <td>${renderDeltaBadge(item.holderChangeRatio)}</td>
        <td class="${(item.holderChange ?? 0) < 0 ? 'text-bull' : 'text-bear'}">${esc(fmtSignedInt(item.holderChange))}</td>
        <td>${fmtPriceChrate(item.intervalChrate)}</td>
        <td>${fmtPriceChrate(item.postCutoffChrate)}</td>
        <td>${esc(fmtAvgCap(item.avgMarketCap))}</td>
        <td>${esc(item.endDate || '--')}</td>
        <td>${esc(item.noticeDate || '--')}</td>
      </tr>
    `
    )
    .join('');

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>股票简称 / 代码</th>
            <th>板块</th>
            <th>最新股东户数</th>
            <th>较上期增减率</th>
            <th>增减户数</th>
            <th>统计期涨跌</th>
            <th>截止后至今涨跌</th>
            <th>户均持股市值</th>
            <th>统计截止日</th>
            <th>公告/披露日</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderMainContent() {
  const snap = state.snapshot;
  const contentArea = document.getElementById('contentArea');
  if (!snap) return;

  // 更新各Tab数字角标
  document.getElementById('countFused').textContent = snap.fusedStream?.length || 0;
  const disclosedQaCount = (snap.qaStream || []).filter((q) => q.replyType === 'disclosed').length;
  document.getElementById('countQA').textContent = state.qaValidOnly
    ? disclosedQaCount
    : snap.qaStream?.length || 0;
  document.getElementById('countEM').textContent = snap.emStream?.length || 0;
  document.getElementById('countWatch').textContent = snap.watchlist?.length || 0;

  // 控制专属筛选控件显隐
  document.getElementById('qaValidOnlyWrap').classList.toggle('hidden', state.activeTab !== 'qa');
  document.getElementById('watchlistQuickBar').classList.toggle('hidden', state.activeTab !== 'watchlist');

  if (state.activeTab === 'em') {
    const filtered = filterAndSortItems(snap.emStream || [], false);
    contentArea.innerHTML = renderEmTable(filtered);
    return;
  }

  if (state.activeTab === 'watchlist') {
    const watchCodes = new Set((snap.watchlist || []).map((w) => w.code));
    if (watchCodes.size === 0) {
      contentArea.innerHTML = `
        <div class="empty-state">
          尚未添加自选盯盘股票。您可以在上方输入6位代码添加，或在任意实时卡片右上角点击 <strong>☆</strong> 一键加自选！
        </div>
      `;
      return;
    }
    // 将自选股关联到融合流或基准数据展示
    const byCode = new Map();
    for (const f of snap.fusedStream || []) {
      if (watchCodes.has(f.stockCode) && !byCode.has(f.stockCode)) {
        byCode.set(f.stockCode, f);
      }
    }
    for (const w of snap.watchlist || []) {
      if (!byCode.has(w.code)) {
        byCode.set(w.code, {
          stockCode: w.code,
          stockName: w.name,
          board: w.board,
          holderNum: w.latestHolderNum,
          holderChangeRatio: w.latestChangeRatio,
          endDate: w.latestEndDate,
          noticeDate: w.latestNoticeDate,
          syncStatus: w.isAhead ? 'ahead' : 'synced',
          sourceLabel: '自选基准监控',
          isWatched: true,
        });
      }
    }
    const list = filterAndSortItems([...byCode.values()], false);
    contentArea.innerHTML = list.length
      ? `<div class="stream-grid">${list.map(renderFeedCard).join('')}</div>`
      : `<div class="empty-state">当前筛选条件下暂无匹配的自选股记录</div>`;
    return;
  }

  const baseStream = state.activeTab === 'qa' ? snap.qaStream || [] : snap.fusedStream || [];
  const filtered = filterAndSortItems(baseStream, state.activeTab === 'qa');

  if (!filtered.length) {
    contentArea.innerHTML = `
      <div class="empty-state">
        当前筛选条件下暂无记录。您可以切换上方筛选胶囊，或使用右上角「全市场查股」检索任意 A 股历史股东户数。
      </div>
    `;
    return;
  }

  contentArea.innerHTML = `<div class="stream-grid">${filtered.slice(0, 180).map(renderFeedCard).join('')}</div>`;
}

// ---------------- 个股详情抽屉与高分屏双轴 Canvas 图表 ----------------
async function openStockDrawer(stockCode) {
  const code = String(stockCode || '').trim().slice(0, 6);
  if (!code) return;

  state.currentDrawerCode = code;
  document.getElementById('drawerBackdrop').classList.remove('hidden');
  const drawer = document.getElementById('detailDrawer');
  drawer.classList.remove('hidden');

  document.getElementById('drawerStockName').textContent = '加载中...';
  document.getElementById('drawerStockCode').textContent = code;
  document.getElementById('drawerStreakBadge').classList.add('hidden');
  document.getElementById('drawerBody').innerHTML = `<div class="loading-state">正在拉取 ${esc(code)} 历次股东人数序列与最新互动易/e互动问答...</div>`;

  try {
    let detail;
    if (state.runtimeMode === 'gh-pages') {
      detail = await browserEngine.getStockDetail(code);
    } else {
      const res = await fetch(`./api/stock/${encodeURIComponent(code)}`);
      detail = await res.json();
      if (detail.error) throw new Error(detail.error);
    }
    state.currentDrawerData = detail;
    renderDrawerDetail(detail);
  } catch (err) {
    document.getElementById('drawerBody').innerHTML = `<div class="empty-state">加载失败：${esc(err.message)}</div>`;
  }
}

function closeStockDrawer() {
  state.currentDrawerCode = null;
  document.getElementById('drawerBackdrop').classList.add('hidden');
  document.getElementById('detailDrawer').classList.add('hidden');
}

async function openAccuracyModal() {
  document.getElementById('accuracyModalBackdrop').classList.remove('hidden');
  const modal = document.getElementById('accuracyModal');
  const body = document.getElementById('accuracyModalBody');
  modal.classList.remove('hidden');
  body.innerHTML = `<div class="loading-state">正在运行黄金对抗基准与全量跨源真值对账...</div>`;

  try {
    const endpoint = state.runtimeMode === 'gh-pages' ? './accuracy-seed.json' : './api/accuracy';
    const res = await fetch(endpoint);
    const data = await res.json();
    const bm = data.benchmark;
    const cv = data.crossVerification;

    const catHtml = (bm.categories || [])
      .map(
        (c) => `
        <span class="filter-pill" style="cursor:default; border-color:rgba(16,185,129,0.35); color:#a7f3d0">
          ✓ ${esc(c.name)} ${c.passed}/${c.total}
        </span>
      `
      )
      .join('');

    const sampleRows = (cv.matchedSamples || [])
      .map(
        (s) => `
        <tr>
          <td><strong>${esc(s.stockName)}</strong> <span class="code-badge">${esc(s.stockCode)}</span></td>
          <td>${esc(s.endDate)}</td>
          <td>${esc(fmtHolderNum(s.qaNum))}</td>
          <td>${esc(fmtHolderNum(s.emNum))}</td>
          <td><span style="color:#34d399; font-weight:700">✓ 零误差完全一致</span></td>
        </tr>
      `
      )
      .join('');

    const discRows = (cv.discrepancies || []).length
      ? `<div class="drawer-section-title" style="margin-top:14px">⚠️ 跨源源端差异提示（通常源于董秘口头整数约数 vs 东财精确报表）</div>` +
        cv.discrepancies
          .map(
            (d) => `
          <div class="qa-snippet">
            <strong>${esc(d.stockName)} (${esc(d.stockCode)}) · ${esc(d.endDate)}</strong>：
            互动提取 <strong>${esc(fmtHolderNum(d.qaHolderNum))}</strong> vs 东财收录 <strong>${esc(fmtHolderNum(d.emHolderNum))}</strong>
            <div class="qa-q-line">${esc(d.answerSnippet)}</div>
          </div>
        `
          )
          .join('')
      : '';

    body.innerHTML = `
      <div class="drawer-kpi-strip">
        <div class="drawer-stat-box">
          <div class="metric-label">黄金对抗基准准确率</div>
          <div class="metric-val" style="color:#34d399">${bm.accuracyPct}% (${bm.passedCases}/${bm.totalCases})</div>
        </div>
        <div class="drawer-stat-box">
          <div class="metric-label">数值抽取精确率 (Precision)</div>
          <div class="metric-val" style="color:#34d399">${bm.precisionPct}%</div>
        </div>
        <div class="drawer-stat-box">
          <div class="metric-label">数值抽取召回率 (Recall)</div>
          <div class="metric-val" style="color:#34d399">${bm.recallPct}%</div>
        </div>
        <div class="drawer-stat-box">
          <div class="metric-label">跨源真值对账一致率</div>
          <div class="metric-val" style="color:#38bdf8">${cv.consistencyRatePct}% (${cv.verifiedPairs}组)</div>
        </div>
      </div>

      <div>
        <div class="drawer-section-title">🛡️ ${(bm.categories || []).length} 大语法与强对抗防误报测试维度（实时全量通过）</div>
        <div class="chip-group">${catHtml}</div>
      </div>

      <div>
        <div class="drawer-section-title">🔍 实时跨源真值对账抽样（一手董秘原文独立解析 vs 东财结构化库，精确一致 ${cv.exactDigitMatchPairs} 组 / 约数误差带一致 ${cv.roundingConsistentPairs} 组）</div>
        ${
          sampleRows
            ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>股票</th><th>截止日</th><th>互动原文提取值</th><th>东财官方入库值</th><th>核验结论</th></tr></thead><tbody>${sampleRows}</tbody></table></div>`
            : `<div class="kpi-sub">等待跨源数据完成首次对账...</div>`
        }
        ${discRows}
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="empty-state">加载自检报告失败：${esc(err.message)}</div>`;
  }
}

function closeAccuracyModal() {
  document.getElementById('accuracyModalBackdrop').classList.add('hidden');
  document.getElementById('accuracyModal').classList.add('hidden');
}

// ---------------- 手机扫码双通道 / 云端永久网页访问弹窗 ----------------
function updateMobileAccessPill() {
  const btn = document.getElementById('mobileAccessBtn');
  if (!btn) return;
  if (state.mobileAccess?.publicUrl || isCloudWebOrigin()) {
    btn.innerHTML = `📱 手机看盘 <span style="color:#34d399">● 已就绪</span>`;
  } else {
    btn.innerHTML = `📱 手机扫码看盘`;
  }
}

function renderMobileModalBody() {
  const body = document.getElementById('mobileModalBody');
  if (!body) return;
  const info = state.mobileAccess;
  if (!info) {
    body.innerHTML = `<div class="loading-state">正在获取手机访问链接与矢量二维码...</div>`;
    return;
  }

  const isCloud = state.runtimeMode === 'gh-pages' || state.runtimeMode === 'vercel' || isCloudWebOrigin();
  const pubStatusBadge = info.publicUrl
    ? `<span class="badge-dual" style="background:rgba(16,185,129,0.18); color:#34d399">● ${isCloud ? '全球云端 HTTPS 24h 在线' : '外网 HTTPS 已连通'}</span>`
    : `<span class="badge-noise">⏳ 正在建立外网 HTTPS 穿透...</span>`;

  const secondCardHtml = isCloud
    ? `
      <div class="qr-channel-card">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:center">
          <strong style="font-size:15px">☁️ 云端全天候部署状态</strong>
          <span class="badge-dual">无需开电脑</span>
        </div>
        <div class="kpi-sub" style="line-height:1.7; text-align:left; margin-top:6px">
          • <strong>当前运行环境</strong>：${state.runtimeMode === 'vercel' ? 'Vercel 全球 Serverless 云函数' : 'GitHub Pages 全球 CDN + 浏览器实时直连引擎'}<br/>
          • <strong>电脑关机可用</strong>：已部署至公网云端，24×7 永久在线，微信/手机浏览器随时打开即看。<br/>
          • <strong>实时数据源</strong>：自动同步东方财富最新股东户数披露、F10 股东研究库与毫秒级现价涨跌幅。<br/>
          • <strong>自选股记忆</strong>：手机上点击 ★ 收藏的自选股将持久保存在本机浏览器中。
        </div>
      </div>
    `
    : `
      <div class="qr-channel-card">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:center">
          <strong style="font-size:15px">📶 通道二：同 Wi-Fi 局域网直连</strong>
          <span class="badge-dual">零延迟内网</span>
        </div>
        <div class="kpi-sub">手机与电脑连接同一路由器 Wi-Fi 时，内网毫秒级直连最稳最快</div>
        <div class="qr-svg-box">
          ${
            info.lanQrSvg
              ? info.lanQrSvg
              : `<div style="color:#475569; font-size:12px; padding:12px">未检测到局域网 Wi-Fi IP</div>`
          }
        </div>
        <div class="qr-url-box">${esc(info.lanUrl || info.localUrl)}</div>
        <div style="display:flex; gap:8px; width:100%">
          <button class="btn btn-ghost btn-sm" style="flex:1" data-copy-url="${esc(info.lanUrl || info.localUrl)}">
            📋 复制局域网链接
          </button>
        </div>
      </div>
    `;

  body.innerHTML = `
    <div class="qr-channels-grid">
      <div class="qr-channel-card is-primary">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:center">
          <strong style="font-size:15px">🌐 ${isCloud ? '云端永久网址 · 手机扫码即看' : '通道一：外网 5G / 随身实时看'}</strong>
          ${pubStatusBadge}
        </div>
        <div class="kpi-sub">手机相机、微信或 Safari 直接扫码打开，支持 5G 流量随时随地看实时筹码</div>
        <div class="qr-svg-box">
          ${
            info.publicQrSvg
              ? info.publicQrSvg
              : `<div style="color:#475569; font-size:12px; padding:12px">正在握手生成公网二维码...<br/>约需 3~6 秒</div>`
          }
        </div>
        <div class="qr-url-box">${esc(info.publicUrl || '正在自动分配 https:// 公网安全链接...')}</div>
        <div style="display:flex; gap:8px; width:100%">
          <button class="btn btn-primary btn-sm" style="flex:1" data-copy-url="${esc(info.publicUrl || '')}" ${info.publicUrl ? '' : 'disabled'}>
            📋 复制云端网页链接
          </button>
          ${
            isCloud
              ? ''
              : `<button class="btn btn-ghost btn-sm" id="reconnectTunnelBtn" title="重新分配公网穿透通道">↻ 刷新通道</button>`
          }
        </div>
      </div>

      ${secondCardHtml}
    </div>

    <div class="pwa-guide-box">
      <strong>💡 变身手机全屏原生 App 小技巧：</strong><br/>
      1. 用 <strong>iPhone Safari</strong> 打开上方网址 → 点击底部中间 <strong>「分享 ↑」→「添加到主屏幕」</strong>，即可生成桌面图标并全屏运行。<br/>
      2. 在手机页面点一下右上角 <strong>「🔊 声音提醒」</strong> 解锁移动端音频权限，发现新股东户数披露时会自动响铃 + 震动提醒。
    </div>
  `;

  body.querySelectorAll('[data-copy-url]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.copyUrl;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        const orig = btn.textContent;
        btn.textContent = '✓ 已复制链接';
        setTimeout(() => {
          btn.textContent = orig;
        }, 1800);
      } catch {
        prompt('请手动复制链接：', url);
      }
    });
  });

  const reconnBtn = document.getElementById('reconnectTunnelBtn');
  if (reconnBtn) {
    reconnBtn.addEventListener('click', async () => {
      reconnBtn.disabled = true;
      reconnBtn.textContent = '↻ 重连中...';
      await fetch('./api/mobile-access/reconnect', { method: 'POST' });
    });
  }
}

async function openMobileModal() {
  state.mobileModalOpen = true;
  document.getElementById('mobileModalBackdrop').classList.remove('hidden');
  document.getElementById('mobileModal').classList.remove('hidden');

  if (state.runtimeMode === 'gh-pages' || state.runtimeMode === 'vercel' || isCloudWebOrigin()) {
    const cleanUrl = window.location.href.split('#')[0];
    state.mobileAccess = {
      status: 'online',
      publicUrl: cleanUrl,
      publicQrSvg: renderQrSvg(cleanUrl),
      lanUrl: cleanUrl,
      localUrl: cleanUrl,
    };
    updateMobileAccessPill();
    renderMobileModalBody();
    return;
  }

  renderMobileModalBody();
  try {
    const res = await fetch('./api/mobile-access');
    state.mobileAccess = await res.json();
    updateMobileAccessPill();
    if (state.mobileModalOpen) renderMobileModalBody();
  } catch {
    // ignore
  }
}

function closeMobileModal() {
  state.mobileModalOpen = false;
  document.getElementById('mobileModalBackdrop').classList.add('hidden');
  document.getElementById('mobileModal').classList.add('hidden');
}

function updateDrawerWatchBtn(isWatched) {
  const btn = document.getElementById('drawerWatchBtn');
  btn.textContent = isWatched ? '★ 已在自选' : '☆ 加自选';
  btn.classList.toggle('btn-accent-outline', isWatched);
}

function renderDrawerDetail(detail) {
  document.getElementById('drawerStockName').textContent = detail.stockName || detail.stockCode;
  document.getElementById('drawerStockCode').textContent = detail.secuCode || detail.stockCode;
  document.getElementById('drawerBoardBadge').textContent = detail.board || 'A股';
  updateDrawerWatchBtn(detail.isWatched);

  const streakEl = document.getElementById('drawerStreakBadge');
  if (detail.streak && Math.abs(detail.streak) >= 2) {
    streakEl.classList.remove('hidden', 'is-bull', 'is-bear');
    if (detail.streak < 0) {
      streakEl.classList.add('is-bull');
      const cum =
        detail.streakCumulativeRatio != null
          ? ` (累计 ${detail.streakCumulativeRatio.toFixed(2)}%)`
          : '';
      streakEl.textContent = `🔥 连续 ${Math.abs(detail.streak)} 期筹码集中${cum}`;
    } else {
      streakEl.classList.add('is-bear');
      streakEl.textContent = `连续 ${detail.streak} 期股东增加`;
    }
  } else {
    streakEl.classList.add('hidden');
  }

  const isSH = String(detail.stockCode).startsWith('6');
  document.getElementById('drawerLinks').innerHTML = `
    <a href="https://data.eastmoney.com/gdhs/detail/${esc(detail.stockCode)}.html" target="_blank" rel="noopener">东方财富股东户数详情 ↗</a>
    <a href="${isSH ? 'https://sns.sseinfo.com/' : 'https://irm.cninfo.com.cn/'}" target="_blank" rel="noopener">${isSH ? '上证e互动官网 ↗' : '深交所互动易官网 ↗'}</a>
  `;

  const latest = detail.history?.[0] || {};
  const qaListHtml = (detail.qaList || []).length
    ? detail.qaList
        .slice(0, 8)
        .map(
          (q) => `
        <div class="qa-snippet ${q.replyType === 'declined' ? 'is-declined' : ''}">
          <div class="qa-q-line">
            <span>📡 ${esc(q.sourceLabel)} · ${esc(q.answerTimeStr || q.noticeDate || '')}</span>
            ${q.holderNum ? ` · 提取户数: <strong style="color:#fff">${esc(fmtHolderNum(q.holderNum))}</strong> (${esc(q.endDate || '未注明日期')})` : ''}
          </div>
          ${q.question ? `<div class="qa-q-line">问：${esc(q.question)}</div>` : ''}
          <div>答：${esc(q.answer)}</div>
        </div>
      `
        )
        .join('')
    : `<div class="kpi-sub">近期暂未检索到该股在互动平台的股东人数问答记录</div>`;

  const historyRowsHtml = (detail.history || [])
    .slice(0, 20)
    .map(
      (h) => `
      <tr>
        <td>${esc(h.endDate || '--')} ${h.isAheadVirtualPoint ? '<span class="badge-ahead">⚡一手</span>' : ''}</td>
        <td>${esc(h.noticeDate || '--')}</td>
        <td><strong>${esc(fmtHolderNum(h.holderNum))}</strong></td>
        <td>${renderDeltaBadge(h.holderChangeRatio)}</td>
        <td>${h.closePrice != null ? `¥${Number(h.closePrice).toFixed(2)}` : '--'}</td>
        <td>${fmtPriceChrate(h.intervalChrate)}</td>
        <td>${esc(fmtAvgCap(h.avgMarketCap))}</td>
      </tr>
    `
    )
    .join('');

  document.getElementById('drawerBody').innerHTML = `
    <div class="drawer-kpi-strip">
      <div class="drawer-stat-box">
        <div class="metric-label">最新股东户数 (${esc(latest.endDate || '--')})</div>
        <div class="metric-val">${esc(fmtHolderNum(latest.holderNum))}</div>
      </div>
      <div class="drawer-stat-box">
        <div class="metric-label">较上期增减幅度</div>
        <div style="margin-top:4px">${renderDeltaBadge(latest.holderChangeRatio)}</div>
      </div>
      <div class="drawer-stat-box">
        <div class="metric-label">户均持股市值</div>
        <div class="metric-val">${esc(fmtAvgCap(latest.avgMarketCap))}</div>
      </div>
      <div class="drawer-stat-box">
        <div class="metric-label">参考收盘价 / 区间涨跌</div>
        <div class="metric-val">${latest.closePrice != null ? `¥${Number(latest.closePrice).toFixed(2)}` : '--'} <small>${fmtPriceChrate(latest.intervalChrate)}</small></div>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-header">
        <span class="chart-title">历次股东户数 vs 股价双轴走势 & 单期筹码增减率</span>
        <div class="chart-legend">
          <span class="legend-item"><i class="legend-swatch" style="background:#38bdf8"></i>股东户数(左轴)</span>
          <span class="legend-item"><i class="legend-swatch" style="background:#fbbf24"></i>收盘价(右轴)</span>
          <span class="legend-item"><i class="legend-swatch" style="background:#f43f5e"></i>户数减少=筹码集中</span>
          <span class="legend-item"><i class="legend-swatch" style="background:#10b981"></i>户数增加=筹码分散</span>
        </div>
      </div>
      <div class="chart-canvas-wrap">
        <canvas id="trendCanvas"></canvas>
        <div id="chartTooltip" class="chart-tooltip hidden"></div>
      </div>
    </div>

    <div>
      <div class="drawer-section-title">💬 互动易 / 上证e互动近期股东人数问答</div>
      <div class="qa-list-stack">${qaListHtml}</div>
    </div>

    <div>
      <div class="drawer-section-title">📋 历次股东户数披露明细（近 ${(detail.history || []).slice(0, 20).length} 期）</div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>统计截止日</th>
              <th>披露日期</th>
              <th>股东户数</th>
              <th>较上期增减</th>
              <th>收盘价</th>
              <th>区间涨跌</th>
              <th>户均市值</th>
            </tr>
          </thead>
          <tbody>${historyRowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    initInteractiveTrendChart(detail.history || []);
  });
}

function initInteractiveTrendChart(historyDesc = []) {
  const canvas = document.getElementById('trendCanvas');
  const tooltip = document.getElementById('chartTooltip');
  if (!canvas) return;

  // 取最近18期并按时间从旧到新排列
  const points = [...historyDesc]
    .filter((x) => x.holderNum != null)
    .slice(0, 18)
    .reverse();

  if (points.length < 2) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText('历史期数不足2期，暂无法绘制趋势曲线', 24, 60);
    return;
  }

  let hoverIdx = -1;

  const draw = () => {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, rect.width);
    const height = Math.max(260, rect.height);
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 64;
    const padRight = 54;
    const padTop = 18;
    const mainBottom = Math.round(height * 0.64);
    const barTop = Math.round(height * 0.72);
    const barBottom = height - 26;
    const plotW = width - padLeft - padRight;
    const mainH = mainBottom - padTop;

    const holders = points.map((p) => p.holderNum);
    let minH = Math.min(...holders);
    let maxH = Math.max(...holders);
    if (minH === maxH) {
      minH *= 0.9;
      maxH *= 1.1;
    } else {
      const span = maxH - minH;
      minH = Math.max(0, minH - span * 0.12);
      maxH = maxH + span * 0.12;
    }

    const prices = points.map((p) => p.closePrice).filter((v) => v != null && v > 0);
    let minP = prices.length ? Math.min(...prices) : 0;
    let maxP = prices.length ? Math.max(...prices) : 100;
    if (minP === maxP) {
      minP *= 0.9;
      maxP *= 1.1;
    } else {
      const pSpan = maxP - minP;
      minP = Math.max(0, minP - pSpan * 0.15);
      maxP = maxP + pSpan * 0.15;
    }

    const ratios = points.map((p) => Math.abs(p.holderChangeRatio || 0));
    const maxAbsRatio = Math.max(5, ...ratios) * 1.15;

    const getX = (i) =>
      points.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (points.length - 1)) * plotW;
    const getYH = (val) => mainBottom - ((val - minH) / (maxH - minH)) * mainH;
    const getYP = (val) => mainBottom - ((val - minP) / (maxP - minP)) * mainH;

    // 1. 绘制背景网格与左右坐标轴刻度
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
    ctx.lineWidth = 1;
    ctx.font = '11px -apple-system, sans-serif';
    for (let g = 0; g <= 3; g++) {
      const y = padTop + (g / 3) * mainH;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      const hVal = maxH - (g / 3) * (maxH - minH);
      ctx.fillStyle = '#7dd3fc';
      ctx.textAlign = 'right';
      ctx.fillText(hVal >= 10000 ? `${(hVal / 10000).toFixed(1)}万` : `${Math.round(hVal)}`, padLeft - 7, y + 4);

      if (prices.length) {
        const pVal = maxP - (g / 3) * (maxP - minP);
        ctx.fillStyle = '#fcd34d';
        ctx.textAlign = 'left';
        ctx.fillText(`¥${pVal.toFixed(1)}`, width - padRight + 6, y + 4);
      }
    }

    // 2. 绘制股东户数渐变面积与主折线 (#38bdf8)
    const grad = ctx.createLinearGradient(0, padTop, 0, mainBottom);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.26)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = getX(i);
      const y = getYH(p.holderNum);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(getX(points.length - 1), mainBottom);
    ctx.lineTo(getX(0), mainBottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = getX(i);
      const y = getYH(p.holderNum);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // 3. 绘制收盘价对比折线 (#fbbf24)
    if (prices.length >= 2) {
      ctx.beginPath();
      let started = false;
      points.forEach((p, i) => {
        if (p.closePrice == null || p.closePrice <= 0) return;
        const x = getX(i);
        const y = getYP(p.closePrice);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    // 4. 绘制底部单期户数变化率柱状图（红=户数下降筹码集中，绿=户数上升筹码分散）
    const zeroY = (barTop + barBottom) / 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY);
    ctx.lineTo(width - padRight, zeroY);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText('0%', padLeft - 7, zeroY + 4);

    const barWidth = Math.max(6, Math.min(20, (plotW / points.length) * 0.52));
    const halfBarH = (barBottom - barTop) / 2;

    points.forEach((p, i) => {
      const x = getX(i);
      const r = p.holderChangeRatio || 0;
      const barH = (Math.min(Math.abs(r), maxAbsRatio) / maxAbsRatio) * halfBarH;
      if (r < 0) {
        // 筹码集中（户数减少）向上绘制暖红柱或高亮展示
        ctx.fillStyle = '#f43f5e';
        ctx.fillRect(x - barWidth / 2, zeroY - barH, barWidth, Math.max(2, barH));
      } else if (r > 0) {
        ctx.fillStyle = '#10b981';
        ctx.fillRect(x - barWidth / 2, zeroY, barWidth, Math.max(2, barH));
      }

      // X轴日期刻度（抽稀显示）
      const step = Math.max(1, Math.ceil(points.length / 6));
      if (i % step === 0 || i === points.length - 1) {
        ctx.fillStyle = '#94a3b8';
        ctx.textAlign = 'center';
        ctx.fillText(String(p.endDate || '').slice(5), x, height - 7);
      }
    });

    // 5. 绘制节点圆点与悬停十字准星
    points.forEach((p, i) => {
      const x = getX(i);
      const y = getYH(p.holderNum);
      ctx.beginPath();
      ctx.arc(x, y, p.isAheadVirtualPoint ? 5.5 : i === hoverIdx ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = p.isAheadVirtualPoint ? '#f59e0b' : '#38bdf8';
      ctx.fill();
      ctx.strokeStyle = '#0d1424';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    if (hoverIdx >= 0 && hoverIdx < points.length) {
      const hx = getX(hoverIdx);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(241, 245, 249, 0.45)';
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, barBottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  draw();

  const updateHoverAtClientX = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const padLeft = 64;
    const padRight = 54;
    const plotW = rect.width - padLeft - padRight;
    const ratio = (mx - padLeft) / plotW;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    hoverIdx = idx;
    draw();

    const p = points[idx];
    const chgStr =
      p.holderChangeRatio != null
        ? `${p.holderChangeRatio > 0 ? '+' : ''}${Number(p.holderChangeRatio).toFixed(2)}%`
        : '--';
    tooltip.innerHTML = `
      <div><strong>截止日：${esc(p.endDate)}</strong> ${p.isAheadVirtualPoint ? '<span style="color:#fbbf24">(⚡一手抢先)</span>' : ''}</div>
      <div>股东户数：<strong>${esc(fmtHolderNum(p.holderNum))}</strong></div>
      <div>较上期变化：<span class="${(p.holderChangeRatio ?? 0) < 0 ? 'text-bull' : 'text-bear'}">${esc(chgStr)}</span></div>
      ${p.closePrice != null ? `<div>收盘价：¥${Number(p.closePrice).toFixed(2)}</div>` : ''}
      ${p.avgMarketCap != null ? `<div>户均市值：${esc(fmtAvgCap(p.avgMarketCap))}</div>` : ''}
    `;
    tooltip.classList.remove('hidden');
    const leftPos = mx > rect.width * 0.55 ? mx - 175 : mx + 12;
    tooltip.style.left = `${Math.max(6, Math.min(rect.width - 180, leftPos))}px`;
    tooltip.style.top = `14px`;
  };

  canvas.onmousemove = (e) => updateHoverAtClientX(e.clientX);
  canvas.ontouchstart = (e) => {
    if (e.touches?.[0]) updateHoverAtClientX(e.touches[0].clientX);
  };
  canvas.ontouchmove = (e) => {
    if (e.touches?.[0]) updateHoverAtClientX(e.touches[0].clientX);
  };

  canvas.onmouseleave = () => {
    hoverIdx = -1;
    tooltip.classList.add('hidden');
    draw();
  };
}

// ---------------- 自选切换与全市场远程查股 ----------------
async function toggleWatchlist(code, name = '') {
  try {
    let data;
    if (state.runtimeMode === 'gh-pages') {
      data = await browserEngine.toggleWatchlist(code, name);
    } else {
      const res = await fetch('./api/watchlist/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name }),
      });
      data = await res.json();
      if (!data.ok) throw new Error(data.error || '操作失败');
    }

    saveWatchlistToStorage(data.watchlist || []);

    // 本地同步自选状态并立刻重绘
    if (state.snapshot) {
      state.snapshot.watchlist = data.watchlist;
      const watchedSet = new Set(data.watchlist.map((w) => w.code));
      for (const arr of [state.snapshot.fusedStream, state.snapshot.qaStream, state.snapshot.emStream]) {
        if (!arr) continue;
        for (const item of arr) {
          item.isWatched = watchedSet.has(item.stockCode);
        }
      }
      renderMainContent();
    }
    if (state.currentDrawerCode === code && state.currentDrawerData) {
      state.currentDrawerData.isWatched = data.watched;
      updateDrawerWatchBtn(data.watched);
    }
  } catch (err) {
    alert(err.message);
  }
}

async function runRemoteSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  // 若直接输入精确6位股票代码，直接打开个股详情抽屉同时展示搜索卡片！
  if (/^\d{6}$/.test(q)) {
    openStockDrawer(q);
  }
  const panel = document.getElementById('remoteSearchPanel');
  const listEl = document.getElementById('remoteSearchList');
  const titleEl = document.getElementById('remoteSearchTitle');
  panel.classList.remove('hidden');
  titleEl.textContent = `正在全市场 5500+ 只 A 股中检索 “${q}” ...`;
  listEl.innerHTML = '';

  try {
    let results = [];
    if (state.runtimeMode === 'gh-pages') {
      results = await browserEngine.searchStocks(q);
    } else {
      const res = await fetch(`./api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      results = data.results || [];
    }
    titleEl.textContent = `全市场检索 “${q}” 共找到 ${results.length} 只股票（点击查看30期股东户数趋势）`;
    listEl.innerHTML = results.length
      ? results.map(renderFeedCard).join('')
      : `<div class="kpi-sub">未找到匹配的A股代码或简称</div>`;
  } catch (err) {
    titleEl.textContent = `检索出错：${err.message}`;
  }
}

// ---------------- 客户端快照应用与自动轮询调度器（Vercel / GitHub Pages） ----------------
function applyIncomingSnapshot(snap, isInitial = false, explicitAlerts = null) {
  if (!snap) return;
  const detectedAlerts = [];

  for (const item of snap.fusedStream || []) {
    if (!item?.id) continue;
    if (!state.clientSeenIds.has(item.id)) {
      state.clientSeenIds.add(item.id);
      if (!isInitial && explicitAlerts === null) {
        item.isNew = true;
        detectedAlerts.push(item);
      }
    }
  }

  state.snapshot = snap;
  if (Array.isArray(snap.watchlist) && snap.watchlist.length > 0 && getSavedWatchCodes().length === 0) {
    saveWatchlistToStorage(snap.watchlist);
  }
  renderStatus(snap.status);
  renderSummaryKPIs(snap.summary);
  renderMainContent();

  const alertsToFire = explicitAlerts !== null ? explicitAlerts : detectedAlerts;
  if (Array.isArray(alertsToFire) && alertsToFire.length > 0) {
    triggerAlerts(alertsToFire);
  }
}

function scheduleClientAutoPoll() {
  if (state.clientPollTimer) {
    clearTimeout(state.clientPollTimer);
    state.clientPollTimer = null;
  }
  if (state.runtimeMode === 'local') return;

  const paused = Boolean(state.status?.settings?.paused);
  if (paused) {
    if (state.status) {
      state.status.nextPollAt = null;
      renderStatus(state.status);
    }
    return;
  }

  const sec = Number(state.status?.settings?.pollIntervalSec || 60);
  const nextAt = Date.now() + sec * 1000;
  if (state.status) {
    state.status.nextPollAt = nextAt;
    renderStatus(state.status);
  }

  state.clientPollTimer = setTimeout(async () => {
    try {
      if (state.runtimeMode === 'gh-pages') {
        if (state.status) renderStatus({ ...state.status, isPolling: true });
        const { snapshot, newAlerts } = await browserEngine.poll({ isFirst: false });
        applyIncomingSnapshot(snapshot, false, newAlerts);
      } else if (state.runtimeMode === 'vercel') {
        if (state.status) renderStatus({ ...state.status, isPolling: true });
        const watchParam = getSavedWatchCodes().join(',');
        const url = watchParam
          ? `./api/snapshot?watch=${encodeURIComponent(watchParam)}`
          : './api/snapshot';
        const res = await fetch(url);
        if (res.ok) {
          const snap = await res.json();
          applyIncomingSnapshot(snap, false, null);
        }
      }
    } catch (err) {
      console.warn('Auto poll error:', err.message);
    } finally {
      scheduleClientAutoPoll();
    }
  }, sec * 1000);
}

// ---------------- 事件绑定与多模式实时通道启动 ----------------
function bindEvents() {
  // Tab切换
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      renderMainContent();
    });
  });

  // 筹码胶囊筛选
  document.getElementById('chipFilters').addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    state.chipFilter = pill.dataset.filter;
    renderMainContent();
  });

  document.getElementById('boardFilterSelect').addEventListener('change', (e) => {
    state.boardFilter = e.target.value;
    renderMainContent();
  });

  document.getElementById('sortSelect').addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderMainContent();
  });

  document.getElementById('qaValidOnlyCheck').addEventListener('change', (e) => {
    state.qaValidOnly = e.target.checked;
    renderMainContent();
  });

  // 搜索输入与远程查股
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    renderMainContent();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runRemoteSearch();
  });
  document.getElementById('remoteSearchBtn').addEventListener('click', runRemoteSearch);
  document.getElementById('closeRemoteSearchBtn').addEventListener('click', () => {
    document.getElementById('remoteSearchPanel').classList.add('hidden');
  });

  // 轮询频率与暂停/立即刷新
  document.getElementById('intervalSelect').addEventListener('change', async (e) => {
    const pollIntervalSec = Number(e.target.value);
    if (state.runtimeMode === 'gh-pages') {
      browserEngine.settings.pollIntervalSec = pollIntervalSec;
      renderStatus(browserEngine.getStatusPayload());
      scheduleClientAutoPoll();
      return;
    }
    const res = await fetch('./api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollIntervalSec }),
    });
    if (state.runtimeMode === 'vercel' && res.ok) {
      const data = await res.json();
      if (data.status) renderStatus(data.status);
      scheduleClientAutoPoll();
    }
  });

  document.getElementById('pauseBtn').addEventListener('click', async () => {
    const nextPaused = !(state.status?.settings?.paused);
    if (state.runtimeMode === 'gh-pages') {
      browserEngine.settings.paused = nextPaused;
      renderStatus(browserEngine.getStatusPayload());
      scheduleClientAutoPoll();
      return;
    }
    const res = await fetch('./api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: nextPaused }),
    });
    if (state.runtimeMode === 'vercel' && res.ok) {
      const data = await res.json();
      if (data.status) renderStatus(data.status);
      scheduleClientAutoPoll();
    }
  });

  document.getElementById('refreshNowBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshNowBtn');
    btn.disabled = true;
    btn.textContent = '⟳ 同步中...';
    try {
      if (state.runtimeMode === 'gh-pages') {
        if (state.status) renderStatus({ ...state.status, isPolling: true });
        const { snapshot, newAlerts } = await browserEngine.poll({ isFirst: false });
        applyIncomingSnapshot(snapshot, false, newAlerts);
        scheduleClientAutoPoll();
      } else {
        const res = await fetch('./api/poll', { method: 'POST' });
        if (state.runtimeMode === 'vercel' && res.ok) {
          const data = await res.json();
          if (data.snapshot) applyIncomingSnapshot(data.snapshot, false, null);
          scheduleClientAutoPoll();
        }
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ 立即刷新';
    }
  });

  // 声音与桌面通知开关
  document.getElementById('soundToggleBtn').addEventListener('click', () => {
    ensureAudioContext();
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('holder_sound', state.soundEnabled ? '1' : '0');
    updateAlertButtonsUI();
    if (state.soundEnabled) playAlertChime(false);
  });

  document.getElementById('notifyToggleBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      state.notifyEnabled = perm === 'granted';
    } else if (Notification.permission === 'granted') {
      state.notifyEnabled = !state.notifyEnabled;
    } else {
      alert('浏览器已拦截通知权限，请在浏览器地址栏左侧设置中允许通知。');
      return;
    }
    localStorage.setItem('holder_notify', state.notifyEnabled ? '1' : '0');
    updateAlertButtonsUI();
  });

  document.getElementById('simulateBtn').addEventListener('click', async () => {
    ensureAudioContext();
    if ('Notification' in window && Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        state.notifyEnabled = true;
        localStorage.setItem('holder_notify', '1');
        updateAlertButtonsUI();
      }
    }
    if (state.runtimeMode === 'gh-pages') {
      const sample =
        state.snapshot?.fusedStream?.find((x) => x.holderChangeRatio != null && x.holderChangeRatio < -3) ||
        state.snapshot?.fusedStream?.[0] || {
          stockCode: '000021',
          stockName: '深科技',
          holderNum: 414890,
          holderChangeRatio: -6.48,
          endDate: '2026-11-10',
          sourceLabel: '深交所互动易',
        };
      triggerAlerts([{ ...sample, id: `sim_${Date.now()}`, isSimulated: true }]);
      return;
    }
    const res = await fetch('./api/simulate-alert', { method: 'POST' });
    if (state.runtimeMode === 'vercel' && res.ok) {
      const data = await res.json();
      if (data.alert) triggerAlerts([data.alert]);
    }
  });

  // KPI 卡片快捷联动
  document.getElementById('kpiCardConcentrated').addEventListener('click', () => {
    document.querySelector('[data-filter="concentrated"]')?.click();
  });
  document.getElementById('kpiCardAhead').addEventListener('click', () => {
    document.querySelector('[data-filter="ahead"]')?.click();
  });
  document.getElementById('kpiCardTopDrop').addEventListener('click', (e) => {
    const code = e.currentTarget.dataset.code;
    if (code) openStockDrawer(code);
  });

  // 自选栏快捷添加
  document.getElementById('watchAddBtn').addEventListener('click', () => {
    const inp = document.getElementById('watchAddInput');
    const code = inp.value.trim();
    if (/^\d{6}$/.test(code)) {
      toggleWatchlist(code);
      inp.value = '';
    } else {
      alert('请输入6位数字A股代码，如 600519 或 000021');
    }
  });

  // 委托点击：打开个股抽屉 或 切换自选星标
  document.body.addEventListener('click', (e) => {
    const star = e.target.closest('[data-watch-code]');
    if (star) {
      e.stopPropagation();
      toggleWatchlist(star.dataset.watchCode, star.dataset.watchName || '');
      return;
    }
    const cardOrRow = e.target.closest('[data-stock-code]');
    if (cardOrRow) {
      openStockDrawer(cardOrRow.dataset.stockCode);
    }
  });

  // 抽屉、准确度弹窗与手机看盘二维码弹窗控制
  document.getElementById('accuracyAuditBtn').addEventListener('click', openAccuracyModal);
  document.getElementById('accuracyModalCloseBtn').addEventListener('click', closeAccuracyModal);
  document.getElementById('accuracyModalBackdrop').addEventListener('click', closeAccuracyModal);

  document.getElementById('mobileAccessBtn').addEventListener('click', openMobileModal);
  document.getElementById('mobileModalCloseBtn').addEventListener('click', closeMobileModal);
  document.getElementById('mobileModalBackdrop').addEventListener('click', closeMobileModal);

  document.getElementById('drawerCloseBtn').addEventListener('click', closeStockDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeStockDrawer);
  document.getElementById('drawerWatchBtn').addEventListener('click', () => {
    if (state.currentDrawerCode) {
      toggleWatchlist(state.currentDrawerCode, state.currentDrawerData?.stockName || '');
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAccuracyModal();
      closeMobileModal();
      if (state.currentDrawerCode) closeStockDrawer();
    }
  });

  // 手机端首次轻触自动激活 Web Audio 合成器
  document.addEventListener(
    'touchstart',
    () => {
      if (state.soundEnabled) ensureAudioContext();
    },
    { once: true, passive: true }
  );

  // 手机锁屏唤醒或从微信/后台切回前台时，立即同步最新数据
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (state.runtimeMode === 'gh-pages') {
      const { snapshot, newAlerts } = await browserEngine.poll({ isFirst: false });
      applyIncomingSnapshot(snapshot, false, newAlerts);
      scheduleClientAutoPoll();
    } else if (state.runtimeMode === 'vercel') {
      await loadInitialSnapshot(false);
    } else {
      await loadInitialSnapshot(false);
      if (!state.esInstance || state.esInstance.readyState === EventSource.CLOSED) {
        connectSSE();
      }
    }
  });
}

async function activateStaticCloudMode() {
  state.runtimeMode = 'gh-pages';
  updateMobileAccessPill();
  await browserEngine.init();
  // 先在 100ms 内秒级首屏渲染预置全市场多源快照
  applyIncomingSnapshot(browserEngine.getSnapshot(), true, []);
  // 紧接着浏览器并发直连东财实时披露与实时行情接口完成最新鲜刷新
  renderStatus({ ...browserEngine.getStatusPayload(), isPolling: true });
  const { snapshot } = await browserEngine.poll({ isFirst: true });
  applyIncomingSnapshot(snapshot, true, []);
  scheduleClientAutoPoll();
}

async function loadInitialSnapshot(isBoot = true) {
  try {
    const watchParam = getSavedWatchCodes().join(',');
    const url = watchParam
      ? `./api/snapshot?watch=${encodeURIComponent(watchParam)}`
      : './api/snapshot';
    const res = await fetch(url);
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok || !ctype.includes('application/json')) {
      await activateStaticCloudMode();
      return;
    }

    const snap = await res.json();
    const mode = snap.status?.runtimeMode || 'local';
    state.runtimeMode = mode;
    updateMobileAccessPill();
    applyIncomingSnapshot(snap, isBoot, isBoot ? [] : null);

    if (mode === 'local' && isBoot) {
      connectSSE();
    } else if (mode === 'vercel') {
      scheduleClientAutoPoll();
    }
  } catch {
    // 静态托管环境下无 /api 路由时自动切换纯前端实时直连引擎
    await activateStaticCloudMode();
  }
}

function connectSSE() {
  if (state.runtimeMode !== 'local') return;
  if (state.esInstance) {
    try {
      state.esInstance.close();
    } catch {
      // ignore
    }
  }
  const es = new EventSource('./api/stream');
  state.esInstance = es;

  es.addEventListener('status', (e) => {
    renderStatus(JSON.parse(e.data));
  });

  es.addEventListener('mobile_access', (e) => {
    state.mobileAccess = JSON.parse(e.data);
    updateMobileAccessPill();
    if (state.mobileModalOpen) {
      renderMobileModalBody();
    }
  });

  es.addEventListener('snapshot', (e) => {
    const { snapshot, newAlerts } = JSON.parse(e.data);
    applyIncomingSnapshot(snapshot, false, newAlerts || []);
  });

  es.addEventListener('simulate_alert', (e) => {
    const mockItem = JSON.parse(e.data);
    triggerAlerts([mockItem]);
  });

  es.onerror = () => {
    // EventSource 会自动重连
  };
}

updateAlertButtonsUI();
updateMobileAccessPill();
bindEvents();
loadInitialSnapshot(true);
