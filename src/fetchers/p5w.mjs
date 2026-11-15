import { parseInteractionQA, parseSseTimestamp, inferMarketInfo, decodeHtmlEntities } from '../parser.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const P5W_SEARCH_URL = 'https://ir.p5w.net/interaction/getNewSearchR.shtml';

function formatYmdShanghai(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function postP5wSearch(paramsObj, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(P5W_SEARCH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Origin: 'https://ir.p5w.net',
        Referer: 'https://ir.p5w.net/',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams(paramsObj).toString(),
    });
    if (!res.ok) {
      throw new Error(`P5W HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeP5wRow(raw, nowMs = Date.now()) {
  const stockCode = String(raw.companyCode || '').trim().slice(0, 6);
  const rawId = String(raw.pid || '');
  if (!/^\d{6}$/.test(stockCode) || !rawId || !raw.replyContent) return null;

  const answerTimeStr = String(raw.replyerTimeStr || raw.questionerTimeStr || '').trim();
  const eventTimeMs = parseSseTimestamp(answerTimeStr, nowMs);

  const rawQuestion = String(raw.content || '');
  const rawAnswer = String(raw.replyContent || '');

  const parsed = parseInteractionQA({
    question: rawQuestion,
    answer: rawAnswer,
    refTimestampMs: eventTimeMs,
  });

  if (!parsed.isTopic) return null;

  const cleanQ = decodeHtmlEntities(rawQuestion);
  const cleanA = decodeHtmlEntities(rawAnswer.replace(/[（(]\s*来自[：:][^）)]+[)）]\s*$/, ''));
  const marketInfo = inferMarketInfo(stockCode);

  // 准确还原真实来源标签（上证e互动 / 深交所互动易 / 全景路演直答）
  let source = 'p5w_ir';
  let sourceLabel = '全景网互动/路演';
  if (parsed.originChannel?.includes('上证')) {
    source = 'sse_ehudong';
    sourceLabel = '上证e互动(全景同步)';
  } else if (parsed.originChannel?.includes('深交') || parsed.originChannel?.includes('互动易')) {
    source = 'szse_irm';
    sourceLabel = '深交所互动易(全景同步)';
  }

  return {
    id: `p5w_${rawId}`,
    rawId,
    channelProvider: 'p5w',
    source,
    sourceLabel,
    stockCode,
    secuCode: marketInfo.secuCode,
    stockName: decodeHtmlEntities(raw.companyShortname || stockCode).replace(/\s+/g, ''),
    market: marketInfo.market,
    board: marketInfo.board,
    question: cleanQ,
    answer: cleanA,
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
    noticeDate: formatYmdShanghai(eventTimeMs),
    answerTimeStr: answerTimeStr || formatYmdShanghai(eventTimeMs),
    eventTimeMs,
    sourceUrl: 'https://ir.p5w.net/',
  };
}

/**
 * 抓取全景网投资者关系平台最新股东人数问答（覆盖沪深北三市 + 补全上证e互动全量关键词检索！）
 */
export async function fetchLatestP5wHolderQA({ isWarmup = false } = {}) {
  const keywords = isWarmup
    ? ['股东人数', '股东户数', '股东总数', '持有人数']
    : ['股东人数', '股东户数'];
  const rowsPerQuery = isWarmup ? '35' : '20';
  const now = Date.now();

  const settled = await Promise.allSettled(
    keywords.map((kw) =>
      postP5wSearch({
        keyWords: kw,
        page: '0',
        rows: rowsPerQuery,
        isAnswer: '1',
      })
    )
  );

  const map = new Map();
  let anySuccess = false;
  let lastErr = null;

  for (const s of settled) {
    if (s.status === 'fulfilled') {
      anySuccess = true;
      const list = s.value?.rows || [];
      for (const raw of list) {
        const item = normalizeP5wRow(raw, now);
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

/**
 * 按个股代码查询全景网（含沪市60/688、北交所8/92、深市00/30）近期股东人数问答
 */
export async function fetchStockP5wQA(stockCode) {
  const code = String(stockCode || '').trim().slice(0, 6);
  if (!/^\d{6}$/.test(code)) return [];
  const now = Date.now();

  try {
    const json = await postP5wSearch({
      keyWords: `${code} 股东`,
      page: '0',
      rows: '25',
      isAnswer: '1',
    });
    const out = [];
    for (const raw of json?.rows || []) {
      if (String(raw.companyCode || '').trim() !== code) continue;
      const item = normalizeP5wRow(raw, now);
      if (item) out.push(item);
    }
    return out.sort((a, b) => b.eventTimeMs - a.eventTimeMs);
  } catch {
    return [];
  }
}
