import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  fetchLatestEastmoneyDisclosures,
  fetchEastmoneyLatestByCodes,
  fetchEastmoneyMultiPeriodByCodes,
  fetchBatchLiveQuotes,
  fetchStockHolderHistory,
  searchEastmoneyStocks,
} from './fetchers/eastmoney.mjs';
import { fetchLatestSzseHolderQA, fetchStockSzseQA } from './fetchers/szseIrm.mjs';
import { fetchLatestSseHolderQA } from './fetchers/sseInfo.mjs';
import { fetchLatestP5wHolderQA, fetchStockP5wQA } from './fetchers/p5w.mjs';
import { isSameReportPeriod, inferMarketInfo, parseInteractionQA } from './parser.mjs';
import { runGoldenBenchmark, auditCrossSourceConsistency } from './accuracy.mjs';

export class HolderMonitor extends EventEmitter {
  constructor({ dataDir, seedStorePath = null, serverlessMode = false }) {
    super();
    this.dataDir = dataDir;
    this.seedStorePath = seedStorePath;
    this.serverlessMode = serverlessMode;
    this.storePath = path.join(dataDir, 'store.json');
    this.initialized = false;

    this.emItems = []; // 最新东财披露列表
    this.emBaselineMap = new Map(); // stockCode -> 最新一期东财对象
    this.emTimelineMap = new Map(); // stockCode -> 按END_DATE倒序排列的多期东财历史数组
    this.liveQuoteMap = new Map(); // stockCode -> { livePrice, todayChrate, liveTotalCap, liveFloatCap }
    this.qaMap = new Map(); // id -> 互动问答对象
    this.watchlist = new Map();
    this.seenIds = new Set();
    this.sessionNewIds = new Set();

    this.settings = {
      pollIntervalSec: 60,
      paused: false,
    };

    this.sourceHealth = {
      eastmoney: { name: '东财户数中心', status: 'idle', lastSyncAt: null, latencyMs: null, count: 0, error: null },
      szse_irm: { name: '深交所互动易', status: 'idle', lastSyncAt: null, latencyMs: null, count: 0, error: null },
      sse_ehudong: { name: '上证e互动', status: 'idle', lastSyncAt: null, latencyMs: null, count: 0, error: null },
      p5w_ir: { name: '全景网沪深北聚合', status: 'idle', lastSyncAt: null, latencyMs: null, count: 0, error: null },
      live_quote: { name: '实时行情引擎', status: 'idle', lastSyncAt: null, latencyMs: null, count: 0, error: null },
    };

    this.benchmarkCache = runGoldenBenchmark();
    this.crossAuditCache = null;

    this.isPolling = false;
    this.hasCompletedInitialSync = false;
    this.lastPollAt = null;
    this.nextPollAt = null;
    this.pollTimer = null;
    this.saveTimer = null;
  }

  async init() {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadStore();
    this.initialized = true;
    if (!this.serverlessMode) {
      this.poll({ isWarmup: true }).catch((err) => {
        console.error('[Monitor] Initial poll error:', err.message);
      });
      this.scheduleNextPoll();
    }
  }

  /**
   * Serverless / 云函数按需保鲜同步：冷启动或距上次轮询超过 maxAgeMs 时实时拉取五源最新数据
   */
  async ensureFreshData({ maxAgeMs = 30000, watchCodes = [] } = {}) {
    await this.init();
    if (Array.isArray(watchCodes) && watchCodes.length > 0) {
      for (const c of watchCodes) {
        const clean = String(c || '').trim().slice(0, 6);
        if (/^\d{6}$/.test(clean) && !this.watchlist.has(clean)) {
          this.watchlist.set(clean, {
            code: clean,
            name: this.emBaselineMap.get(clean)?.stockName || clean,
            board: inferMarketInfo(clean).board,
            addedAt: Date.now(),
          });
        }
      }
    }
    const now = Date.now();
    if (!this.hasCompletedInitialSync || !this.lastPollAt || now - this.lastPollAt > maxAgeMs) {
      await this.poll({ isWarmup: false });
    }
  }

  upsertEmRowIntoTimeline(row) {
    if (!row?.stockCode || !row?.endDate) return;
    const code = row.stockCode;
    const list = this.emTimelineMap.get(code) || [];
    const idx = list.findIndex((x) => isSameReportPeriod(x.endDate, row.endDate));
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...row };
    } else {
      list.push(row);
    }
    list.sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''));
    this.emTimelineMap.set(code, list);

    const prevBase = this.emBaselineMap.get(code);
    if (!prevBase || (row.endDate && (!prevBase.endDate || row.endDate >= prevBase.endDate))) {
      this.emBaselineMap.set(code, list[0]);
    }
  }

  async loadStore() {
    try {
      let raw;
      try {
        raw = await fs.readFile(this.storePath, 'utf8');
      } catch (err) {
        if (this.seedStorePath) {
          raw = await fs.readFile(this.seedStorePath, 'utf8');
        } else {
          throw err;
        }
      }
      const data = JSON.parse(raw);

      if (Array.isArray(data.watchlist)) {
        for (const w of data.watchlist) {
          if (w?.code) this.watchlist.set(String(w.code), w);
        }
      }
      if (data.settings) {
        if (typeof data.settings.pollIntervalSec === 'number') {
          this.settings.pollIntervalSec = Math.max(15, Math.min(3600, data.settings.pollIntervalSec));
        }
        if (typeof data.settings.paused === 'boolean') {
          this.settings.paused = data.settings.paused;
        }
      }
      if (Array.isArray(data.emItems)) {
        this.emItems = data.emItems;
        for (const item of data.emItems) {
          this.upsertEmRowIntoTimeline(item);
        }
      }
      if (Array.isArray(data.emTimelines)) {
        for (const [code, arr] of data.emTimelines) {
          for (const r of arr) this.upsertEmRowIntoTimeline(r);
          if (!this.emTimelineMap.has(code)) this.emTimelineMap.set(code, arr);
        }
      }
      if (Array.isArray(data.qaItems)) {
        for (const q of data.qaItems) {
          if (!q?.id) continue;
          // 用最新 v2.0 解析器重新重放校验旧缓存，自动升级旧版误判！
          const reparsed = parseInteractionQA({
            question: q.question || '',
            answer: q.answer || '',
            refTimestampMs: q.eventTimeMs || Date.now(),
          });
          if (!reparsed.isTopic) continue;
          this.qaMap.set(q.id, {
            ...q,
            replyType: reparsed.replyType,
            holderNum: reparsed.holderNum,
            endDate: reparsed.endDate,
            typoCorrectedFrom: reparsed.typoCorrectedFrom || null,
            isApproximate: reparsed.isApproximate,
            precisionHalfWidth: reparsed.precisionHalfWidth || 0,
            minPossible: reparsed.minPossible ?? reparsed.holderNum,
            maxPossible: reparsed.maxPossible ?? reparsed.holderNum,
            excludesBuyback: reparsed.excludesBuyback,
            isStalePeriodicQuote: reparsed.isStalePeriodicQuote,
            inlinePrev: reparsed.inlinePrev || null,
            allPeriods: reparsed.allPeriods || [],
          });
        }
      }
      if (Array.isArray(data.seenIds)) {
        for (const id of data.seenIds) this.seenIds.add(id);
      }
    } catch {
      // 首次启动无缓存文件
    }
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveStore().catch((err) => console.error('[Monitor] Save error:', err.message));
    }, 900);
  }

  async saveStore() {
    const qaItems = [...this.qaMap.values()]
      .sort((a, b) => b.eventTimeMs - a.eventTimeMs)
      .slice(0, 600);
    const emTimelines = [...this.emTimelineMap.entries()]
      .slice(0, 400)
      .map(([code, arr]) => [code, arr.slice(0, 10)]);
    const seenArr = [...this.seenIds].slice(-5000);

    const payload = {
      version: '2.0',
      savedAt: Date.now(),
      settings: this.settings,
      watchlist: [...this.watchlist.values()],
      emItems: this.emItems.slice(0, 320),
      emTimelines,
      qaItems,
      seenIds: seenArr,
    };
    await fs.writeFile(this.storePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  scheduleNextPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.settings.paused) {
      this.nextPollAt = null;
      this.emit('status', this.getStatusPayload());
      return;
    }
    const ms = this.settings.pollIntervalSec * 1000;
    this.nextPollAt = Date.now() + ms;
    this.pollTimer = setTimeout(async () => {
      await this.poll({ isWarmup: false });
      this.scheduleNextPoll();
    }, ms);
    this.emit('status', this.getStatusPayload());
  }

  updateSettings({ pollIntervalSec, paused }) {
    if (typeof pollIntervalSec === 'number' && Number.isFinite(pollIntervalSec)) {
      this.settings.pollIntervalSec = Math.max(15, Math.min(3600, Math.round(pollIntervalSec)));
    }
    if (typeof paused === 'boolean') {
      this.settings.paused = paused;
    }
    this.scheduleSave();
    this.scheduleNextPoll();
    return this.getStatusPayload();
  }

  async toggleWatchlist(stockCode, stockName = '') {
    const code = String(stockCode || '').trim().slice(0, 6);
    if (!/^\d{6}$/.test(code)) {
      throw new Error('请输入有效的6位A股代码');
    }
    if (this.watchlist.has(code)) {
      this.watchlist.delete(code);
      this.scheduleSave();
      this.emit('watchlist', this.getWatchlistArray());
      return { watched: false, code, watchlist: this.getWatchlistArray() };
    }

    let resolvedName = stockName || this.emBaselineMap.get(code)?.stockName || '';
    if (!resolvedName || resolvedName === code) {
      const rows = await fetchEastmoneyMultiPeriodByCodes([code]);
      for (const r of rows) this.upsertEmRowIntoTimeline(r);
      resolvedName = this.emBaselineMap.get(code)?.stockName || '';
    }

    const entry = {
      code,
      name: resolvedName || code,
      board: inferMarketInfo(code).board,
      addedAt: Date.now(),
    };
    this.watchlist.set(code, entry);
    this.scheduleSave();
    this.emit('watchlist', this.getWatchlistArray());
    return { watched: true, code, entry, watchlist: this.getWatchlistArray() };
  }

  /**
   * 为某只股票构建“东财多期历史 + 全部一手互动披露”的统一按期排序时间轴
   */
  getUnifiedStockPeriods(stockCode) {
    const code = String(stockCode || '').trim();
    const periodNodes = [];

    for (const em of this.emTimelineMap.get(code) || []) {
      if (em.endDate && em.holderNum) {
        periodNodes.push({
          endDate: em.endDate,
          holderNum: em.holderNum,
          prevHolderNum: em.prevHolderNum,
          prevEndDate: em.prevEndDate,
          holderChange: em.holderChange,
          holderChangeRatio: em.holderChangeRatio,
          avgMarketCap: em.avgMarketCap,
          totalMarketCap: em.totalMarketCap,
          closePrice: em.closePrice,
          intervalChrate: em.intervalChrate,
          stockName: em.stockName,
          fromSource: 'eastmoney',
        });
      }
    }

    // 融入该股所有互动问答中提取出的全部期数（例如易点天下同日披露10-30与11-10两期！）
    for (const q of this.qaMap.values()) {
      if (q.stockCode !== code) continue;
      const periods = q.allPeriods?.length
        ? q.allPeriods
        : q.holderNum && q.endDate
          ? [{ endDate: q.endDate, holderNum: q.holderNum, isApproximate: q.isApproximate }]
          : [];
      for (const p of periods) {
        if (!p.endDate || !p.holderNum) continue;
        const alreadyInEm = periodNodes.some(
          (n) => isSameReportPeriod(n.endDate, p.endDate)
        );
        if (!alreadyInEm) {
          periodNodes.push({
            endDate: p.endDate,
            holderNum: p.holderNum,
            isApproximate: p.isApproximate,
            fromSource: q.source,
          });
        }
      }
    }

    periodNodes.sort((a, b) => b.endDate.localeCompare(a.endDate));
    return periodNodes;
  }

  /**
   * 为任一条目附加实时行情（实时现价、统计截止日后至今涨跌幅 postCutoffChrate、实时户均市值）
   */
  attachLiveQuoteMetrics(item) {
    const quote = this.liveQuoteMap.get(item.stockCode);
    if (!quote) return item;

    const cutoffClose = item.closePrice;
    const postCutoffChrate =
      cutoffClose && cutoffClose > 0 && quote.livePrice > 0
        ? ((quote.livePrice - cutoffClose) / cutoffClose) * 100
        : null;

    const liveAvgMarketCap =
      quote.liveTotalCap && item.holderNum && item.holderNum > 0
        ? quote.liveTotalCap / item.holderNum
        : item.avgMarketCap;

    return {
      ...item,
      stockName: item.stockName && item.stockName !== item.stockCode ? item.stockName : quote.stockName,
      livePrice: quote.livePrice,
      todayChrate: quote.todayChrate,
      postCutoffChrate,
      avgMarketCap: item.avgMarketCap ?? liveAvgMarketCap,
      liveAvgMarketCap,
    };
  }

  /**
   * 跨源时间轴精准匹配与增减计算（v2.0 支持多期时间轴回溯、同文上期联动、约数误差带校验）
   */
  enrichQAItemWithBaseline(qaItem) {
    const timeline = this.getUnifiedStockPeriods(qaItem.stockCode);
    const emLatest = this.emBaselineMap.get(qaItem.stockCode);

    if ((qaItem.replyType !== 'disclosed' && qaItem.replyType !== 'stale_periodic') || !qaItem.holderNum) {
      return this.attachLiveQuoteMetrics({
        ...qaItem,
        stockName: emLatest?.stockName || qaItem.stockName,
        prevHolderNum: null,
        prevEndDate: null,
        holderChange: null,
        holderChangeRatio: null,
        avgMarketCap: emLatest?.avgMarketCap ?? null,
        closePrice: emLatest?.closePrice ?? null,
        intervalChrate: null,
        roundingNoiseWarning: false,
        syncStatus: 'declined',
      });
    }

    const qaDate = qaItem.endDate;

    // 1. 查找东财是否已同步同一报告期
    const matchedEmNode = timeline.find(
      (n) =>
        n.fromSource === 'eastmoney' &&
        ((qaDate && isSameReportPeriod(qaDate, n.endDate)) ||
          (!qaDate && Math.abs(n.holderNum - qaItem.holderNum) <= 10))
    );

    // 2. 在统一多期时间轴中寻找紧邻的上一报告期节点（包括东财历史节点 或 同日互动披露的更早一期！）
    let prevNode = null;
    if (qaDate) {
      prevNode = timeline.find(
        (n) => n.endDate < qaDate && !isSameReportPeriod(n.endDate, qaDate)
      );
    }
    if (!prevNode && qaItem.inlinePrev?.holderNum) {
      prevNode = {
        endDate: qaItem.inlinePrev.endDate || null,
        holderNum: qaItem.inlinePrev.holderNum,
      };
    }

    let prevHolderNum = matchedEmNode?.prevHolderNum ?? prevNode?.holderNum ?? null;
    let prevEndDate = matchedEmNode?.prevEndDate ?? prevNode?.endDate ?? null;

    // 若时间轴中有比东财默认上期更近的一手中间期（例如东财最新是9-30，而互动同时出了10-30和11-10），采用更近的中间期！
    if (prevNode && prevEndDate && prevNode.endDate && prevNode.endDate > prevEndDate && !isSameReportPeriod(prevNode.endDate, qaDate)) {
      prevHolderNum = prevNode.holderNum;
      prevEndDate = prevNode.endDate;
    }

    const holderChange =
      prevHolderNum != null ? qaItem.holderNum - prevHolderNum : matchedEmNode?.holderChange ?? null;
    const holderChangeRatio =
      prevHolderNum && prevHolderNum > 0
        ? ((qaItem.holderNum - prevHolderNum) / prevHolderNum) * 100
        : matchedEmNode?.holderChangeRatio ?? null;

    // 校验约数四舍五入误差带：如果董秘说“约42万户”（区间[415000, 425000]），而上期是423000，属于误差带内波动！
    const roundingNoiseWarning = Boolean(
      qaItem.isApproximate &&
        prevHolderNum != null &&
        qaItem.minPossible != null &&
        qaItem.maxPossible != null &&
        prevHolderNum >= qaItem.minPossible &&
        prevHolderNum <= qaItem.maxPossible
    );

    // 判定同步状态：领先东财 (ahead) / 东财已同步 (synced) / 历史旧期或旧季报 (historical)
    let syncStatus = 'unmatched';
    if (qaItem.replyType === 'stale_periodic') {
      syncStatus = 'stale_periodic';
    } else if (matchedEmNode) {
      syncStatus = 'synced';
    } else if (!emLatest || (qaDate && emLatest.endDate && qaDate > emLatest.endDate && !isSameReportPeriod(qaDate, emLatest.endDate))) {
      syncStatus = 'ahead';
    } else if (qaDate && emLatest?.endDate && qaDate < emLatest.endDate) {
      syncStatus = 'historical';
    }

    const estimatedAvgCap =
      matchedEmNode?.avgMarketCap ??
      (emLatest?.totalMarketCap && qaItem.holderNum > 0
        ? emLatest.totalMarketCap / qaItem.holderNum
        : emLatest?.avgMarketCap ?? null);

    return this.attachLiveQuoteMetrics({
      ...qaItem,
      stockName: emLatest?.stockName || qaItem.stockName,
      endDate: qaDate || matchedEmNode?.endDate || null,
      prevHolderNum,
      prevEndDate,
      holderChange,
      holderChangeRatio,
      avgMarketCap: estimatedAvgCap,
      closePrice: matchedEmNode?.closePrice ?? emLatest?.closePrice ?? null,
      intervalChrate: matchedEmNode?.intervalChrate ?? null,
      roundingNoiseWarning,
      syncStatus,
    });
  }

  /**
   * 跨渠道（深交所直连 + 上证直连 + 全景网聚合）智能去重器：
   * 同一股票、同一天内完全相同的提问与回答，优先保留交易所直连源，消除全景网镜像重复！
   */
  mergeIncomingQAs(directList = [], p5wList = []) {
    // 先写入交易所直连记录
    const directSignatures = new Set();
    for (const q of [...this.qaMap.values(), ...directList]) {
      if (q.channelProvider !== 'p5w') {
        const sig = `${q.stockCode}_${q.noticeDate}_${q.holderNum || 'no'}_${String(q.answer || '').slice(0, 28)}`;
        directSignatures.add(sig);
      }
    }

    const combined = [...directList];
    for (const pItem of p5wList) {
      const sig = `${pItem.stockCode}_${pItem.noticeDate}_${pItem.holderNum || 'no'}_${String(pItem.answer || '').slice(0, 28)}`;
      if (directSignatures.has(sig)) {
        continue; // 直连源已有同条问答，跳过镜像副本
      }
      combined.push(pItem);
    }
    return combined;
  }

  getWatchlistArray() {
    return [...this.watchlist.values()].map((w) => {
      const em = this.emBaselineMap.get(w.code);
      const quote = this.liveQuoteMap.get(w.code);
      const latestQa = [...this.qaMap.values()]
        .filter((q) => q.stockCode === w.code && q.replyType === 'disclosed')
        .sort((a, b) => b.eventTimeMs - a.eventTimeMs)[0];

      return {
        ...w,
        name: em?.stockName || quote?.stockName || latestQa?.stockName || w.name,
        latestHolderNum:
          latestQa?.syncStatus === 'ahead'
            ? latestQa.holderNum
            : em?.holderNum ?? latestQa?.holderNum ?? null,
        latestChangeRatio:
          latestQa?.syncStatus === 'ahead'
            ? latestQa.holderChangeRatio
            : em?.holderChangeRatio ?? latestQa?.holderChangeRatio ?? null,
        latestEndDate:
          latestQa?.syncStatus === 'ahead'
            ? latestQa.endDate
            : em?.endDate ?? latestQa?.endDate ?? null,
        latestNoticeDate:
          latestQa?.syncStatus === 'ahead'
            ? latestQa.noticeDate
            : em?.noticeDate ?? latestQa?.noticeDate ?? null,
        livePrice: quote?.livePrice ?? em?.closePrice ?? null,
        todayChrate: quote?.todayChrate ?? null,
        isAhead: latestQa?.syncStatus === 'ahead',
      };
    });
  }

  /**
   * 执行五引擎并发采集、多期时间轴对齐、实时行情融合与跨源真值自检
   */
  async poll({ isWarmup = false } = {}) {
    if (this.isPolling) return null;
    this.isPolling = true;
    this.emit('status', this.getStatusPayload());

    const isFirstBaseline = isWarmup || (this.seenIds.size === 0 && !this.hasCompletedInitialSync);
    const newAlerts = [];

    const runSource = async (key, fn) => {
      const t0 = Date.now();
      this.sourceHealth[key].status = 'loading';
      try {
        const res = await fn();
        const count = res instanceof Map ? res.size : Array.isArray(res) ? res.length : 0;
        this.sourceHealth[key] = {
          ...this.sourceHealth[key],
          status: 'ok',
          lastSyncAt: Date.now(),
          latencyMs: Date.now() - t0,
          count,
          error: null,
        };
        return res;
      } catch (err) {
        this.sourceHealth[key] = {
          ...this.sourceHealth[key],
          status: 'error',
          latencyMs: Date.now() - t0,
          error: err.message || '连接超时',
        };
        return null;
      }
    };

    try {
      const [emList, szseList, sseList, p5wList] = await Promise.all([
        runSource('eastmoney', () =>
          fetchLatestEastmoneyDisclosures({ pageSize: isWarmup ? 250 : 160 })
        ),
        runSource('szse_irm', () => fetchLatestSzseHolderQA({ isWarmup })),
        runSource('sse_ehudong', () => fetchLatestSseHolderQA({ isWarmup })),
        runSource('p5w_ir', () => fetchLatestP5wHolderQA({ isWarmup })),
      ]);

      // 1. 更新东方财富最新披露与时间轴
      if (emList && emList.length > 0) {
        const mergedEmMap = new Map();
        for (const item of [...emList, ...this.emItems]) {
          if (!mergedEmMap.has(item.id)) mergedEmMap.set(item.id, item);
          this.upsertEmRowIntoTimeline(item);
        }
        this.emItems = [...mergedEmMap.values()].slice(0, 320);

        for (const item of emList) {
          if (!this.seenIds.has(item.id)) {
            this.seenIds.add(item.id);
            if (!isFirstBaseline) {
              item.discoveredAtMs = Date.now();
              this.sessionNewIds.add(item.id);
              newAlerts.push({ ...item, isWatched: this.watchlist.has(item.stockCode) });
            }
          }
        }
      }

      // 2. 跨渠道合并互动问答，并按需拉取缺失的多期历史序列（消除跨期断层！）
      const incomingQA = this.mergeIncomingQAs(
        [...(szseList || []), ...(sseList || [])],
        p5wList || []
      );

      // 先写入原始问答以便 getUnifiedStockPeriods 能感知同批多期问答
      const newRawQAs = [];
      for (const rawQa of incomingQA) {
        const existing = this.qaMap.get(rawQa.id);
        if (existing?.discoveredAtMs) rawQa.discoveredAtMs = existing.discoveredAtMs;
        this.qaMap.set(rawQa.id, rawQa);
        if (!this.seenIds.has(rawQa.id)) {
          this.seenIds.add(rawQa.id);
          newRawQAs.push(rawQa);
        }
      }

      const allTrackedCodes = [
        ...new Set([
          ...[...this.qaMap.values()]
            .filter((q) => q.holderNum != null)
            .map((q) => q.stockCode),
          ...[...this.watchlist.keys()],
        ]),
      ];

      // 2a. 对尚未载入东财基准的股票，先用 RPT_HOLDERNUMLATEST 保证每只股票100%拿到最新一期+上期基准（消除高频股分页挤占！）
      const codesMissingLatest = allTrackedCodes.filter((code) => !this.emBaselineMap.has(code));
      if (codesMissingLatest.length > 0) {
        const latestRows = await fetchEastmoneyLatestByCodes(codesMissingLatest);
        for (const r of latestRows) {
          this.upsertEmRowIntoTimeline(r);
        }
      }

      // 2b. 再补充多期历史序列（小分块拉取，解决多期同时披露或跨期对比断层）
      const codesNeedingMultiPeriod = allTrackedCodes.filter(
        (code) => (this.emTimelineMap.get(code)?.length || 0) < 2
      );

      if (codesNeedingMultiPeriod.length > 0) {
        const multiRows = await fetchEastmoneyMultiPeriodByCodes(codesNeedingMultiPeriod);
        for (const r of multiRows) {
          this.upsertEmRowIntoTimeline(r);
        }
      }

      // 3. 批量同步活跃股票的毫秒级实时行情（现价、当日涨跌、统计日后至今涨跌幅）
      const activeQuoteCodes = [
        ...this.emItems.slice(0, 180).map((x) => x.stockCode),
        ...[...this.qaMap.values()].slice(0, 150).map((x) => x.stockCode),
        ...[...this.watchlist.keys()],
      ];
      const quotes = await runSource('live_quote', () => fetchBatchLiveQuotes(activeQuoteCodes));
      if (quotes) {
        for (const [c, q] of quotes.entries()) {
          this.liveQuoteMap.set(c, q);
        }
      }

      // 更新 emItems 的实时行情指标
      this.emItems = this.emItems.map((em) => this.attachLiveQuoteMetrics(em));

      // 4. 全量富化问答库并生成新鲜有效增量提醒（严格过滤旧季报复述 stale_periodic！）
      for (const [id, q] of this.qaMap.entries()) {
        const enriched = {
          ...this.enrichQAItemWithBaseline(q),
          discoveredAtMs: q.discoveredAtMs,
        };
        this.qaMap.set(id, enriched);
      }

      if (!isFirstBaseline) {
        for (const rawQa of newRawQAs) {
          const enriched = this.qaMap.get(rawQa.id);
          if (!enriched) continue;
          enriched.discoveredAtMs = Date.now();
          this.sessionNewIds.add(enriched.id);
          // 仅对“真正新鲜披露了户数 (disclosed)”或“自选股新问答”发提醒，绝不对旧季报复述误报警！
          if (enriched.replyType === 'disclosed' || this.watchlist.has(enriched.stockCode)) {
            newAlerts.push({
              ...enriched,
              isWatched: this.watchlist.has(enriched.stockCode),
            });
          }
        }
      }

      // 5. 运行跨源真值交叉核验（实时计算与东财官方库的一致率）
      this.crossAuditCache = auditCrossSourceConsistency(
        [...this.qaMap.values()],
        this.emTimelineMap
      );

      this.hasCompletedInitialSync = true;
      this.lastPollAt = Date.now();
      this.scheduleSave();

      const snapshot = this.getSnapshot();
      this.emit('snapshot', { snapshot, newAlerts });
      return { snapshot, newAlerts };
    } finally {
      this.isPolling = false;
      this.emit('status', this.getStatusPayload());
    }
  }

  /**
   * 聚合压缩同公司同日重复粘贴的相同数值回复（保留最早首次披露时间，统计同批回复次数！）
   */
  buildDeduplicatedQAStream() {
    const rawSorted = [...this.qaMap.values()].sort((a, b) => a.eventTimeMs - b.eventTimeMs);
    const groupMap = new Map();

    for (const q of rawSorted) {
      // 对披露了相同截止日+相同户数的同日多条重复问答进行聚合，保留最早发布时间！
      const groupKey =
        q.holderNum != null
          ? `num_${q.stockCode}_${q.noticeDate}_${q.endDate || 'na'}_${q.holderNum}`
          : `txt_${q.stockCode}_${q.noticeDate}_${String(q.answer || '').slice(0, 30)}`;

      const existing = groupMap.get(groupKey);
      if (!existing) {
        groupMap.set(groupKey, {
          ...q,
          duplicateCount: 1,
          earliestTimeStr: q.answerTimeStr,
          latestTimeMs: q.eventTimeMs,
          isNew: this.sessionNewIds.has(q.id),
          isWatched: this.watchlist.has(q.stockCode),
        });
      } else {
        existing.duplicateCount += 1;
        existing.latestTimeMs = Math.max(existing.latestTimeMs, q.eventTimeMs);
        if (this.sessionNewIds.has(q.id)) existing.isNew = true;
        // 若新的一条来自交易所直连而旧的是聚合源，优先展示直连源标签
        if (q.channelProvider !== 'p5w' && existing.channelProvider === 'p5w') {
          existing.sourceLabel = q.sourceLabel;
          existing.sourceUrl = q.sourceUrl;
        }
      }
    }

    return [...groupMap.values()].sort((a, b) => b.eventTimeMs - a.eventTimeMs);
  }

  /**
   * 构建融合实时披露流（仅纳入新鲜有效旬度/月度披露，彻底剔除旧季报复述噪音！）
   */
  buildFusedStream(dedupedQAStream) {
    const fusedMap = new Map();

    // 仅纳入 replyType === 'disclosed'（新鲜有效披露）且非历史过时问答
    const freshDisclosedQAs = dedupedQAStream.filter(
      (q) => q.replyType === 'disclosed' && q.holderNum && q.syncStatus !== 'historical'
    );

    for (const qa of freshDisclosedQAs) {
      const matchingEm = this.emItems.find(
        (em) =>
          em.stockCode === qa.stockCode &&
          ((qa.endDate && em.endDate && isSameReportPeriod(qa.endDate, em.endDate)) ||
            (!qa.endDate && em.holderNum === qa.holderNum))
      );

      const periodKey = `${qa.stockCode}_${matchingEm?.endDate || qa.endDate || qa.id}`;
      if (fusedMap.has(periodKey)) continue;

      if (matchingEm) {
        fusedMap.set(
          periodKey,
          this.attachLiveQuoteMetrics({
            ...matchingEm,
            id: qa.id,
            emId: matchingEm.id,
            fusedType: 'dual_verified',
            primarySource: qa.source,
            sourceLabel: `${qa.sourceLabel.replace('(全景同步)', '')} + 东财`,
            question: qa.question,
            answer: qa.answer,
            answerTimeStr: qa.earliestTimeStr || qa.answerTimeStr,
            duplicateCount: qa.duplicateCount,
            excludesBuyback: qa.excludesBuyback,
            typoCorrectedFrom: qa.typoCorrectedFrom || null,
            isApproximate: qa.isApproximate,
            roundingNoiseWarning: qa.roundingNoiseWarning,
            syncStatus: 'synced',
            noticeDate: qa.noticeDate > matchingEm.noticeDate ? qa.noticeDate : matchingEm.noticeDate,
            sortTimeMs: Math.max(qa.discoveredAtMs || 0, matchingEm.discoveredAtMs || 0, qa.eventTimeMs),
            isNew: qa.isNew || this.sessionNewIds.has(matchingEm.id),
            isWatched: this.watchlist.has(qa.stockCode),
            qaSourceUrl: qa.sourceUrl,
          })
        );
      } else {
        fusedMap.set(periodKey, {
          ...qa,
          fusedType: qa.syncStatus === 'ahead' ? 'ahead_qa' : 'qa_only',
          primarySource: qa.source,
          sortTimeMs: Math.max(qa.discoveredAtMs || 0, qa.eventTimeMs),
          qaSourceUrl: qa.sourceUrl,
        });
      }
    }

    for (const em of this.emItems) {
      let alreadyMerged = false;
      for (const existing of fusedMap.values()) {
        if (
          existing.stockCode === em.stockCode &&
          existing.endDate &&
          em.endDate &&
          isSameReportPeriod(existing.endDate, em.endDate)
        ) {
          alreadyMerged = true;
          break;
        }
      }
      if (alreadyMerged) continue;

      const key = `em_${em.stockCode}_${em.endDate}`;
      fusedMap.set(key, {
        ...em,
        fusedType: 'em_structured',
        primarySource: 'eastmoney',
        syncStatus: 'synced',
        sortTimeMs: Math.max(em.discoveredAtMs || 0, em.eventTimeMs),
        isNew: this.sessionNewIds.has(em.id),
        isWatched: this.watchlist.has(em.stockCode),
      });
    }

    return [...fusedMap.values()].sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      if ((a.noticeDate || '') !== (b.noticeDate || '')) {
        return (b.noticeDate || '').localeCompare(a.noticeDate || '');
      }
      if ((a.syncStatus === 'ahead') !== (b.syncStatus === 'ahead')) {
        return a.syncStatus === 'ahead' ? -1 : 1;
      }
      if (a.sortTimeMs !== b.sortTimeMs) {
        return b.sortTimeMs - a.sortTimeMs;
      }
      return (a.holderChangeRatio ?? 999) - (b.holderChangeRatio ?? 999);
    });
  }

  computeSummary(fusedList, dedupedQAList) {
    const latestNoticeDate = fusedList[0]?.noticeDate || null;
    const recentBatch = latestNoticeDate
      ? fusedList.filter((x) => x.noticeDate === latestNoticeDate)
      : fusedList.slice(0, 100);
    const sample = recentBatch.length >= 15 ? recentBatch : fusedList.slice(0, 100);

    let decreasedCount = 0;
    let sharpDecreasedCount = 0;
    let increasedCount = 0;
    let divergenceCount = 0;

    for (const item of sample) {
      if (item.holderChangeRatio == null) continue;
      if (item.holderChangeRatio < 0) {
        decreasedCount++;
        if (item.holderChangeRatio <= -5) sharpDecreasedCount++;
        // 黄金潜伏背离：筹码下降>=2%，统计期内涨幅<=3%，且统计截止日后至今也未大涨(<=3.5%)
        if (
          item.holderChangeRatio <= -2 &&
          (item.intervalChrate == null || item.intervalChrate <= 3) &&
          (item.postCutoffChrate == null || item.postCutoffChrate <= 3.5)
        ) {
          divergenceCount++;
        }
      } else if (item.holderChangeRatio > 0) {
        increasedCount++;
      }
    }

    const aheadCount = fusedList.filter((x) => x.syncStatus === 'ahead').length;
    const topConcentrated =
      [...sample]
        .filter((x) => x.holderChangeRatio != null && x.holderChangeRatio < 0)
        .sort((a, b) => a.holderChangeRatio - b.holderChangeRatio)[0] || null;

    return {
      latestNoticeDate,
      sampleSize: sample.length,
      totalFusedCount: fusedList.length,
      totalQACount: dedupedQAList.length,
      rawQACount: this.qaMap.size,
      decreasedCount,
      sharpDecreasedCount,
      increasedCount,
      divergenceCount,
      aheadCount,
      concentrationRatio:
        decreasedCount + increasedCount > 0
          ? (decreasedCount / (decreasedCount + increasedCount)) * 100
          : 0,
      topConcentrated: topConcentrated
        ? {
            stockCode: topConcentrated.stockCode,
            stockName: topConcentrated.stockName,
            holderChangeRatio: topConcentrated.holderChangeRatio,
            endDate: topConcentrated.endDate,
          }
        : null,
      accuracy: {
        benchmarkAccuracyPct: this.benchmarkCache.accuracyPct,
        benchmarkCases: this.benchmarkCache.totalCases,
        crossVerifiedPairs: this.crossAuditCache?.verifiedPairs || 0,
        crossConsistencyPct: this.crossAuditCache?.consistencyRatePct ?? 100,
      },
    };
  }

  getAccuracyReport() {
    this.benchmarkCache = runGoldenBenchmark();
    this.crossAuditCache = auditCrossSourceConsistency(
      [...this.qaMap.values()],
      this.emTimelineMap
    );
    return {
      benchmark: this.benchmarkCache,
      crossVerification: this.crossAuditCache,
    };
  }

  getStatusPayload() {
    return {
      runtimeMode: this.serverlessMode ? 'vercel' : 'local',
      isPolling: this.isPolling,
      hasCompletedInitialSync: this.hasCompletedInitialSync,
      lastPollAt: this.lastPollAt,
      nextPollAt: this.serverlessMode
        ? (this.lastPollAt || Date.now()) + this.settings.pollIntervalSec * 1000
        : this.nextPollAt,
      settings: this.settings,
      sourceHealth: this.sourceHealth,
    };
  }

  getSnapshot() {
    const qaStream = this.buildDeduplicatedQAStream();
    const fused = this.buildFusedStream(qaStream);
    const emStream = this.emItems.map((em) => ({
      ...em,
      isNew: this.sessionNewIds.has(em.id),
      isWatched: this.watchlist.has(em.stockCode),
    }));

    return {
      status: this.getStatusPayload(),
      summary: this.computeSummary(fused, qaStream),
      fusedStream: fused,
      qaStream,
      emStream,
      watchlist: this.getWatchlistArray(),
    };
  }

  /**
   * 个股详情抽屉：整合 30 期东财历史 + 深市互动易 + 全景网(含沪市/北交所) + 实时现价！
   */
  async getStockDetail(stockCode) {
    const code = String(stockCode || '').trim().slice(0, 6);
    const [historyData, remoteSzseQA, remoteP5wQA, quoteMap] = await Promise.all([
      fetchStockHolderHistory(code, 30),
      fetchStockSzseQA(code),
      fetchStockP5wQA(code),
      fetchBatchLiveQuotes([code]),
    ]);

    for (const r of historyData.history) {
      this.upsertEmRowIntoTimeline(r);
    }
    const quote = quoteMap.get(code);
    if (quote) this.liveQuoteMap.set(code, quote);

    const mergedRemote = this.mergeIncomingQAs(remoteSzseQA, remoteP5wQA);
    for (const q of mergedRemote) {
      this.qaMap.set(q.id, q);
    }

    const stockQAs = [...this.qaMap.values()]
      .filter((x) => x.stockCode === code)
      .map((q) => this.enrichQAItemWithBaseline(q))
      .sort((a, b) => b.eventTimeMs - a.eventTimeMs);

    const history = historyData.history.map((h) => this.attachLiveQuoteMetrics(h));

    // 将所有领先东方财富入库的一手新节点按日期顺序拼入趋势图最前端！
    const aheadQAs = stockQAs
      .filter((q) => q.syncStatus === 'ahead' && q.holderNum && q.endDate)
      .sort((a, b) => a.endDate.localeCompare(b.endDate));

    const addedPeriods = new Set();
    for (const aheadQA of aheadQAs) {
      if (addedPeriods.has(aheadQA.endDate)) continue;
      addedPeriods.add(aheadQA.endDate);
      history.unshift(
        this.attachLiveQuoteMetrics({
          id: aheadQA.id,
          source: aheadQA.source,
          sourceLabel: `${aheadQA.sourceLabel}（一手抢先）`,
          stockCode: code,
          secuCode: historyData.secuCode,
          stockName: historyData.stockName,
          board: historyData.board,
          holderNum: aheadQA.holderNum,
          prevHolderNum: aheadQA.prevHolderNum,
          holderChange: aheadQA.holderChange,
          holderChangeRatio: aheadQA.holderChangeRatio,
          intervalChrate: null,
          endDate: aheadQA.endDate,
          prevEndDate: aheadQA.prevEndDate,
          noticeDate: aheadQA.noticeDate,
          avgMarketCap: aheadQA.avgMarketCap,
          closePrice: quote?.livePrice ?? aheadQA.closePrice,
          isAheadVirtualPoint: true,
        })
      );
    }

    return {
      ...historyData,
      liveQuote: quote || null,
      isWatched: this.watchlist.has(code),
      history,
      qaList: stockQAs,
    };
  }

  async searchStocks(keyword) {
    const list = await searchEastmoneyStocks(keyword, 20);
    const quoteMap = await fetchBatchLiveQuotes(list.map((x) => x.stockCode));
    for (const [c, q] of quoteMap.entries()) this.liveQuoteMap.set(c, q);

    for (const item of list) {
      this.upsertEmRowIntoTimeline(item);
    }
    return list.map((item) => ({
      ...this.attachLiveQuoteMetrics(item),
      isWatched: this.watchlist.has(item.stockCode),
    }));
  }
}
