import { inferMarketInfo } from '../parser.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EM_BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const EM_F10_BASE = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const EM_QUOTE_BASE = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

async function fetchJsonWithTimeout(url, timeoutMs = 12000, referer = 'https://data.eastmoney.com/gdhs/') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) {
      throw new Error(`Eastmoney HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function cleanDate(raw) {
  if (!raw) return null;
  return String(raw).slice(0, 10);
}

export function normalizeEastmoneyRow(row) {
  const stockCode = String(row.SECURITY_CODE || '').trim();
  const endDate = cleanDate(row.END_DATE);
  const prevEndDate = cleanDate(row.PRE_END_DATE);
  const noticeDate = cleanDate(row.HOLD_NOTICE_DATE) || endDate;
  const marketInfo = inferMarketInfo(stockCode);

  const holderNum = row.HOLDER_NUM != null ? Number(row.HOLDER_NUM) : null;
  const prevHolderNum = row.PRE_HOLDER_NUM != null ? Number(row.PRE_HOLDER_NUM) : null;
  const holderChange = row.HOLDER_NUM_CHANGE != null ? Number(row.HOLDER_NUM_CHANGE) : null;
  const holderChangeRatio = row.HOLDER_NUM_RATIO != null ? Number(row.HOLDER_NUM_RATIO) : null;
  const intervalChrate = row.INTERVAL_CHRATE != null ? Number(row.INTERVAL_CHRATE) : null;
  const avgMarketCap = row.AVG_MARKET_CAP != null ? Number(row.AVG_MARKET_CAP) : null;
  const avgHoldNum = row.AVG_HOLD_NUM != null ? Number(row.AVG_HOLD_NUM) : null;
  const totalMarketCap = row.TOTAL_MARKET_CAP != null ? Number(row.TOTAL_MARKET_CAP) : null;
  const closePrice = row.CLOSE_PRICE != null ? Number(row.CLOSE_PRICE) : null;

  const eventTimeMs = noticeDate
    ? Date.parse(`${noticeDate}T09:00:00+08:00`)
    : Date.now();

  return {
    id: `em_${stockCode}_${endDate}`,
    source: 'eastmoney',
    sourceLabel: '东方财富汇总',
    stockCode,
    secuCode: row.SECUCODE || marketInfo.secuCode,
    stockName: row.SECURITY_NAME_ABBR || stockCode,
    market: marketInfo.market,
    board: marketInfo.board,
    holderNum,
    prevHolderNum,
    holderChange,
    holderChangeRatio,
    intervalChrate,
    endDate,
    prevEndDate,
    noticeDate,
    avgMarketCap,
    avgHoldNum,
    totalMarketCap,
    closePrice,
    changeReason: row.CHANGE_REASON || null,
    eventTimeMs,
    sourceUrl: `https://data.eastmoney.com/gdhs/detail/${stockCode}.html`,
  };
}

export async function fetchLatestEastmoneyDisclosures({ pageSize = 220, pageNumber = 1 } = {}) {
  const params = new URLSearchParams({
    sortColumns: 'HOLD_NOTICE_DATE,END_DATE,HOLDER_NUM_RATIO',
    sortTypes: '-1,-1,1',
    pageSize: String(pageSize),
    pageNumber: String(pageNumber),
    reportName: 'RPT_HOLDERNUMLATEST',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
  });
  const json = await fetchJsonWithTimeout(`${EM_BASE}?${params.toString()}`);
  const rows = json?.result?.data || [];
  return rows.map(normalizeEastmoneyRow);
}

/**
 * 东财 F10 股东研究底层表补全引擎 (`RPT_F10_EH_HOLDERNUM`)：
 * 解决东财公开 `gdhs` 中心 (`RPT_HOLDERNUMLATEST` / `RPT_HOLDERNUM_DET`) 天然漏收全部 A+B 股（如 000596 古井贡酒、000625 长安汽车）
 * 与部分 A+H 股（如 002594 比亚迪、600036 招商银行）的行业级盲区！
 */
function normalizeF10GroupRows(rawGroup = []) {
  if (!rawGroup.length) return [];
  const sorted = [...rawGroup].sort((a, b) =>
    String(b.END_DATE || '').localeCompare(String(a.END_DATE || ''))
  );

  return sorted.map((row, idx) => {
    const older = sorted[idx + 1] || null;
    const stockCode = String(row.SECURITY_CODE || '').trim();
    const endDate = cleanDate(row.END_DATE);
    const prevEndDate = older ? cleanDate(older.END_DATE) : null;
    const noticeDate = cleanDate(row.NOTICE_DATE) || endDate;
    const marketInfo = inferMarketInfo(stockCode);

    const hasANum = row.HOLDER_A_NUM != null && Number(row.HOLDER_A_NUM) > 0;
    const f10TotalHolderNum = row.HOLDER_TOTAL_NUM != null ? Number(row.HOLDER_TOTAL_NUM) : null;
    const holderNum = hasANum ? Number(row.HOLDER_A_NUM) : f10TotalHolderNum;

    const olderHasANum = older && older.HOLDER_A_NUM != null && Number(older.HOLDER_A_NUM) > 0;
    const olderHolderNum = older
      ? olderHasANum
        ? Number(older.HOLDER_A_NUM)
        : older.HOLDER_TOTAL_NUM != null
          ? Number(older.HOLDER_TOTAL_NUM)
          : null
      : null;

    const rawDelta = row.HOLDER_TOTAL_NUMCHANGE != null ? Number(row.HOLDER_TOTAL_NUMCHANGE) : null;
    const prevHolderNum =
      olderHolderNum ?? (holderNum != null && rawDelta != null && !hasANum ? holderNum - rawDelta : null);

    const holderChange =
      holderNum != null && prevHolderNum != null
        ? holderNum - prevHolderNum
        : !hasANum
          ? rawDelta
          : null;

    const holderChangeRatio =
      hasANum && row.HOLDER_ANUM_RATIO != null
        ? Number(row.HOLDER_ANUM_RATIO)
        : row.TOTAL_NUM_RATIO != null && !hasANum
          ? Number(row.TOTAL_NUM_RATIO)
          : prevHolderNum && prevHolderNum > 0 && holderNum != null
            ? ((holderNum - prevHolderNum) / prevHolderNum) * 100
            : null;

    const closePrice = row.PRICE != null ? Number(row.PRICE) : null;
    const olderPrice = older?.PRICE != null ? Number(older.PRICE) : null;
    const intervalChrate =
      closePrice && closePrice > 0 && olderPrice && olderPrice > 0
        ? ((closePrice - olderPrice) / olderPrice) * 100
        : null;

    const avgMarketCap = row.AVG_HOLD_AMT != null ? Number(row.AVG_HOLD_AMT) : null;
    const avgHoldNum =
      row.AVG_FREE_SHARES != null
        ? Number(row.AVG_FREE_SHARES)
        : row.AVG_TOTAL_SHARES != null
          ? Number(row.AVG_TOTAL_SHARES)
          : null;
    const totalMarketCap = avgMarketCap && holderNum ? avgMarketCap * holderNum : null;

    const eventTimeMs = noticeDate ? Date.parse(`${noticeDate}T09:00:00+08:00`) : Date.now();

    return {
      id: `em_${stockCode}_${endDate}`,
      source: 'eastmoney',
      sourceLabel: '东方财富F10',
      stockCode,
      secuCode: row.SECUCODE || marketInfo.secuCode,
      stockName: row.SECURITY_NAME_ABBR || stockCode,
      market: marketInfo.market,
      board: marketInfo.board,
      holderNum,
      f10TotalHolderNum,
      prevHolderNum,
      holderChange,
      holderChangeRatio,
      intervalChrate,
      endDate,
      prevEndDate,
      noticeDate,
      avgMarketCap,
      avgHoldNum,
      totalMarketCap,
      closePrice,
      changeReason: null,
      eventTimeMs,
      sourceUrl: `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code=${marketInfo.market}${stockCode}`,
    };
  });
}

export async function fetchF10HolderRowsByCodes(codes = [], perStockLimit = 8) {
  const uniqueCodes = [...new Set(codes.map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c)))];
  if (!uniqueCodes.length) return [];

  const out = [];
  const chunkSize = 6;
  for (let i = 0; i < uniqueCodes.length; i += chunkSize) {
    const chunk = uniqueCodes.slice(i, i + chunkSize);
    const filterExpr =
      chunk.length === 1
        ? `(SECURITY_CODE="${chunk[0]}")`
        : `(SECURITY_CODE in (${chunk.map((c) => `"${c}"`).join(',')}))`;
    const params = new URLSearchParams({
      reportName: 'RPT_F10_EH_HOLDERNUM',
      columns: 'ALL',
      filter: filterExpr,
      sortColumns: 'SECURITY_CODE,END_DATE',
      sortTypes: '1,-1',
      pageNumber: '1',
      pageSize: String(Math.max(12, chunk.length * (perStockLimit + 1))),
      source: 'HSF10',
      client: 'PC',
    });
    try {
      const json = await fetchJsonWithTimeout(
        `${EM_F10_BASE}?${params.toString()}`,
        12000,
        'https://emweb.securities.eastmoney.com/'
      );
      const rawRows = json?.result?.data || [];
      const byCode = new Map();
      for (const r of rawRows) {
        const c = String(r.SECURITY_CODE || '').trim();
        if (!c) continue;
        if (!byCode.has(c)) byCode.set(c, []);
        byCode.get(c).push(r);
      }
      for (const group of byCode.values()) {
        const normalized = normalizeF10GroupRows(group);
        out.push(...normalized.slice(0, perStockLimit));
      }
    } catch {
      // 忽略单批异常
    }
  }
  return out;
}

export async function fetchEastmoneyLatestByCodes(codes = []) {
  const uniqueCodes = [...new Set(codes.map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c)))];
  if (!uniqueCodes.length) return [];

  const results = [];
  const chunkSize = 35;
  for (let i = 0; i < uniqueCodes.length; i += chunkSize) {
    const chunk = uniqueCodes.slice(i, i + chunkSize);
    const filterExpr =
      chunk.length === 1
        ? `(SECURITY_CODE="${chunk[0]}")`
        : `(SECURITY_CODE in (${chunk.map((c) => `"${c}"`).join(',')}))`;
    const params = new URLSearchParams({
      reportName: 'RPT_HOLDERNUMLATEST',
      columns: 'ALL',
      filter: filterExpr,
      pageNumber: '1',
      pageSize: String(chunk.length + 5),
      source: 'WEB',
      client: 'WEB',
    });
    try {
      const json = await fetchJsonWithTimeout(`${EM_BASE}?${params.toString()}`);
      const rows = json?.result?.data || [];
      results.push(...rows.map(normalizeEastmoneyRow));
    } catch {
      // 忽略单批异常
    }
  }

  // 对 A+B / A+H 等东财 gdhs 漏收股票自动启用 F10 底层库补齐！
  const foundSet = new Set(results.map((r) => r.stockCode));
  const missingForF10 = uniqueCodes.filter((c) => !foundSet.has(c));
  if (missingForF10.length > 0) {
    const f10Rows = await fetchF10HolderRowsByCodes(missingForF10, 2);
    results.push(...f10Rows);
  }
  return results;
}

/**
 * 批量拉取指定股票最近多期股东户数时间轴（用于解决多期同时披露或跨期对比断层！）
 */
export async function fetchEastmoneyMultiPeriodByCodes(codes = []) {
  const uniqueCodes = [...new Set(codes.map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c)))];
  if (!uniqueCodes.length) return [];

  const results = [];
  const chunkSize = 8;
  for (let i = 0; i < uniqueCodes.length; i += chunkSize) {
    const chunk = uniqueCodes.slice(i, i + chunkSize);
    const filterExpr =
      chunk.length === 1
        ? `(SECURITY_CODE="${chunk[0]}")`
        : `(SECURITY_CODE in (${chunk.map((c) => `"${c}"`).join(',')}))`;
    const params = new URLSearchParams({
      reportName: 'RPT_HOLDERNUM_DET',
      columns: 'ALL',
      filter: filterExpr,
      sortColumns: 'END_DATE',
      sortTypes: '-1',
      pageNumber: '1',
      pageSize: String(chunk.length * 10),
      source: 'WEB',
      client: 'WEB',
    });
    try {
      const json = await fetchJsonWithTimeout(`${EM_BASE}?${params.toString()}`);
      const rows = json?.result?.data || [];
      results.push(...rows.map(normalizeEastmoneyRow));
    } catch {
      // 忽略单批异常
    }
  }

  const foundSet = new Set(results.map((r) => r.stockCode));
  const missingForF10 = uniqueCodes.filter((c) => !foundSet.has(c));
  if (missingForF10.length > 0) {
    const f10Rows = await fetchF10HolderRowsByCodes(missingForF10, 8);
    results.push(...f10Rows);
  }
  return results;
}

/**
 * 批量获取A股最新实时现价、当日涨跌幅、实时总市值与流通市值
 * 用于精确计算“统计截止日后至今涨跌幅 (postCutoffChrate)”及实时户均市值！
 */
export async function fetchBatchLiveQuotes(codes = []) {
  const uniqueCodes = [...new Set(codes.map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c)))];
  const quoteMap = new Map();
  if (!uniqueCodes.length) return quoteMap;

  const chunkSize = 80;
  for (let i = 0; i < uniqueCodes.length; i += chunkSize) {
    const chunk = uniqueCodes.slice(i, i + chunkSize);
    const secids = chunk.map((c) => inferMarketInfo(c).quoteSecId).join(',');
    const url = `${EM_QUOTE_BASE}?fltt=2&invt=2&fields=f2,f3,f12,f14,f20,f21&secids=${secids}`;
    try {
      const json = await fetchJsonWithTimeout(url, 8000, 'https://quote.eastmoney.com/');
      for (const item of json?.data?.diff || []) {
        const code = String(item.f12 || '').trim();
        const livePrice = typeof item.f2 === 'number' && item.f2 > 0 ? item.f2 : null;
        if (!code || !livePrice) continue;
        quoteMap.set(code, {
          stockCode: code,
          stockName: item.f14 || code,
          livePrice,
          todayChrate: typeof item.f3 === 'number' ? item.f3 : null,
          liveTotalCap: typeof item.f20 === 'number' && item.f20 > 0 ? item.f20 : null,
          liveFloatCap: typeof item.f21 === 'number' && item.f21 > 0 ? item.f21 : null,
        });
      }
    } catch {
      // 忽略单批行情异常
    }
  }
  return quoteMap;
}

export async function fetchStockHolderHistory(stockCode, limit = 30) {
  const code = String(stockCode).trim().slice(0, 6);
  if (!/^\d{6}$/.test(code)) {
    throw new Error('股票代码格式应为6位数字');
  }
  const params = new URLSearchParams({
    reportName: 'RPT_HOLDERNUM_DET',
    columns: 'ALL',
    filter: `(SECURITY_CODE="${code}")`,
    sortColumns: 'END_DATE',
    sortTypes: '-1',
    pageNumber: '1',
    pageSize: String(limit),
    source: 'WEB',
    client: 'WEB',
  });

  const json = await fetchJsonWithTimeout(`${EM_BASE}?${params.toString()}`);
  let rows = (json?.result?.data || []).map(normalizeEastmoneyRow);
  if (rows.length === 0) {
    rows = await fetchF10HolderRowsByCodes([code], limit);
  }

  let streak = 0;
  for (const r of rows) {
    if (r.holderChangeRatio == null || r.holderChangeRatio === 0) break;
    if (streak === 0) {
      streak = r.holderChangeRatio < 0 ? -1 : 1;
    } else if (streak < 0 && r.holderChangeRatio < 0) {
      streak -= 1;
    } else if (streak > 0 && r.holderChangeRatio > 0) {
      streak += 1;
    } else {
      break;
    }
  }

  let streakCumulativeRatio = null;
  const absStreak = Math.abs(streak);
  if (absStreak >= 2 && rows[0]?.holderNum && rows[absStreak - 1]?.prevHolderNum) {
    const base = rows[absStreak - 1].prevHolderNum;
    if (base > 0) {
      streakCumulativeRatio = ((rows[0].holderNum - base) / base) * 100;
    }
  }

  return {
    stockCode: code,
    stockName: rows[0]?.stockName || code,
    secuCode: rows[0]?.secuCode || inferMarketInfo(code).secuCode,
    board: rows[0]?.board || inferMarketInfo(code).board,
    streak,
    streakCumulativeRatio,
    latest: rows[0] || null,
    history: rows,
  };
}

export async function searchEastmoneyStocks(keyword = '', limit = 20) {
  const q = String(keyword).trim().replace(/["'()]/g, '');
  if (!q) return [];

  const isDigits = /^\d{2,6}$/.test(q);
  const filter = isDigits
    ? `(SECURITY_CODE like "%${q}%")`
    : `(SECURITY_NAME_ABBR like "%${q}%")`;

  const params = new URLSearchParams({
    reportName: 'RPT_HOLDERNUMLATEST',
    columns: 'ALL',
    filter,
    sortColumns: 'HOLD_NOTICE_DATE,SECURITY_CODE',
    sortTypes: '-1,1',
    pageNumber: '1',
    pageSize: String(limit),
    source: 'WEB',
    client: 'WEB',
  });

  const json = await fetchJsonWithTimeout(`${EM_BASE}?${params.toString()}`);
  const primaryRows = (json?.result?.data || []).map(normalizeEastmoneyRow);
  if (primaryRows.length > 0) return primaryRows;

  // 若搜索 A+B / A+H 标的（如 000596 古井贡酒、002594 比亚迪、600036 招商银行），自动回退 F10 库检索！
  const f10Params = new URLSearchParams({
    reportName: 'RPT_F10_EH_HOLDERNUM',
    columns: 'ALL',
    filter: `${filter}(IS_DEFAULT="0")`,
    sortColumns: 'END_DATE,SECURITY_CODE',
    sortTypes: '-1,1',
    pageNumber: '1',
    pageSize: String(limit * 3),
    source: 'HSF10',
    client: 'PC',
  });
  try {
    const f10Json = await fetchJsonWithTimeout(
      `${EM_F10_BASE}?${f10Params.toString()}`,
      10000,
      'https://emweb.securities.eastmoney.com/'
    );
    const byCode = new Map();
    for (const r of f10Json?.result?.data || []) {
      const c = String(r.SECURITY_CODE || '').trim();
      if (!c) continue;
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(r);
    }
    const dedupLatest = [];
    for (const group of byCode.values()) {
      const norm = normalizeF10GroupRows(group);
      if (norm[0]) dedupLatest.push(norm[0]);
      if (dedupLatest.length >= limit) break;
    }
    return dedupLatest;
  } catch {
    return [];
  }
}
