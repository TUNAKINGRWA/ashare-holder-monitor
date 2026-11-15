import { parseInteractionQA, inferMarketInfo, decodeHtmlEntities } from '../parser.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IRM_SEARCH_URL = 'https://irm.cninfo.com.cn/newircs/index/search';
const IRM_KEYBOARD_URL = 'https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo';

function formatYmdShanghai(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateTimeShanghai(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

async function postIrmForm(url, paramsObj, queryObj = null, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams(paramsObj).toString();
    const fullUrl = queryObj
      ? `${url}?${new URLSearchParams(queryObj).toString()}`
      : url;
    const res = await fetch(fullUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Origin: 'https://irm.cninfo.com.cn',
        Referer: 'https://irm.cninfo.com.cn/newircs/index/search',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`SZSE IRM HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSzseItem(raw) {
  const rawId = String(raw.indexId || raw.esId || '');
  const stockCode = String(raw.stockCode || '').trim();
  if (!rawId || !stockCode || !raw.attachedContent) return null;

  const answerTimeMs = raw.attachedPubDate
    ? Number(raw.attachedPubDate)
    : raw.updateDate
      ? Number(raw.updateDate)
      : Date.now();

  const question = decodeHtmlEntities(raw.mainContent || '');
  const answer = decodeHtmlEntities(raw.attachedContent || '');
  const parsed = parseInteractionQA({
    question,
    answer,
    refTimestampMs: answerTimeMs,
  });

  if (!parsed.isTopic) return null;

  const marketInfo = inferMarketInfo(stockCode);

  return {
    id: `szse_${rawId}`,
    rawId,
    channelProvider: 'szse_direct',
    source: 'szse_irm',
    sourceLabel: '深交所互动易',
    stockCode,
    secuCode: marketInfo.secuCode,
    stockName: decodeHtmlEntities(raw.companyShortName || raw.attachedAuthor || stockCode).replace(/\s+/g, ''),
    market: marketInfo.market,
    board: marketInfo.board,
    question,
    answer,
    replyType: parsed.replyType,
    holderNum: parsed.holderNum,
    endDate: parsed.endDate,
    typoCorrectedFrom: parsed.typoCorrectedFrom || null,
    isApproximate: parsed.isApproximate,
    precisionHalfWidth: parsed.precisionHalfWidth || 0,
    minPossible: parsed.minPossible ?? parsed.holderNum,
    maxPossible: parsed.maxPossible ?? parsed.holderNum,
    excludesBuyback: parsed.excludesBuyback,
    isStalePeriodicQuote: parsed.isStalePeriodicQuote,
    inlinePrev: parsed.inlinePrev || null,
    allPeriods: parsed.allPeriods || [],
    noticeDate: formatYmdShanghai(answerTimeMs),
    answerTimeStr: formatDateTimeShanghai(answerTimeMs),
    eventTimeMs: answerTimeMs,
    sourceUrl: `https://irm.cninfo.com.cn/newircs/question/questionDetail?questionId=${rawId}`,
  };
}

/**
 * 抓取深交所互动易最新“股东人数/户数/总数/持有人数”问答
 */
export async function fetchLatestSzseHolderQA({ isWarmup = false } = {}) {
  const now = Date.now();
  const startDay = formatYmdShanghai(now - 14 * 24 * 3600 * 1000);
  const endDay = formatYmdShanghai(now + 24 * 3600 * 1000);
  const kwPageSize = isWarmup ? '40' : '25';
  const keywords = isWarmup
    ? ['股东人数', '股东户数', '股东总数', '持有人数']
    : ['股东人数', '股东户数', '持有人数'];

  const tasks = [
    // 1. 全深市纯时间倒序最新已回复流（零延迟捕获刚发出的回复）
    postIrmForm(IRM_SEARCH_URL, {
      pageNo: '1',
      pageNum: '1',
      pageSize: '30',
      searchTypes: '11,',
    }),
    // 2. 多关键词全口径检索（含中登“持有人数”官方表述）
    ...keywords.map((kw) =>
      postIrmForm(
        IRM_SEARCH_URL,
        {
          pageNo: '1',
          pageNum: '1',
          pageSize: kwPageSize,
          searchTypes: '11,',
          keyWord: kw,
          startDay,
          endDay,
        },
        { startDay, endDay }
      )
    ),
  ];

  const settled = await Promise.allSettled(tasks);
  const map = new Map();
  let anySuccess = false;
  let lastErr = null;

  for (const s of settled) {
    if (s.status === 'fulfilled') {
      anySuccess = true;
      const list = s.value?.results || s.value?.data || [];
      for (const raw of list) {
        const item = normalizeSzseItem(raw);
        if (item && !map.has(item.id)) {
          map.set(item.id, item);
        }
      }
    } else {
      lastErr = s.reason;
    }
  }

  if (!anySuccess && lastErr) {
    throw lastErr;
  }

  return [...map.values()].sort((a, b) => b.eventTimeMs - a.eventTimeMs);
}

export async function fetchStockSzseQA(stockCode) {
  const code = String(stockCode).trim().slice(0, 6);
  if (code.startsWith('6') || code.startsWith('8') || code.startsWith('92')) return [];

  try {
    const kb = await postIrmForm(IRM_KEYBOARD_URL, { keyWord: code });
    const orgInfo = (kb?.data || []).find((d) => String(d.stockCode || '').includes(code)) || kb?.data?.[0];
    const orgId = orgInfo?.secid || orgInfo?.orgId || '';

    const query = {
      _t: '1',
      stockcode: code,
      orgId,
      pageSize: '25',
      pageNum: '1',
      keyWord: '股东',
      searchTypes: '11,',
    };
    const json = await postIrmForm(IRM_SEARCH_URL, query, query);
    const list = json?.results || json?.data || [];
    const out = [];
    for (const raw of list) {
      if (raw.stockCode && String(raw.stockCode) !== code) continue;
      const item = normalizeSzseItem({ ...raw, stockCode: code });
      if (item) out.push(item);
    }
    return out.sort((a, b) => b.eventTimeMs - a.eventTimeMs);
  } catch {
    return [];
  }
}
