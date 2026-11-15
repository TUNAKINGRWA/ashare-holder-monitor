import { parseSseFeedsHtml, parseInteractionQA, inferMarketInfo } from '../parser.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SSE_BASE = 'https://sns.sseinfo.com';

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

async function fetchSseText(path, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SSE_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Referer: 'https://sns.sseinfo.com/',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (!res.ok) {
      throw new Error(`SSE Info HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function enrichSseItem(item) {
  const parsed = parseInteractionQA({
    question: item.question,
    answer: item.answer,
    refTimestampMs: item.answerTimeMs,
  });
  if (!parsed.isTopic) return null;

  const marketInfo = inferMarketInfo(item.stockCode);
  return {
    id: item.id,
    rawId: item.rawId,
    channelProvider: 'sse_direct',
    source: 'sse_ehudong',
    sourceLabel: '上证e互动',
    stockCode: item.stockCode,
    secuCode: marketInfo.secuCode,
    stockName: item.stockName,
    market: marketInfo.market,
    board: marketInfo.board,
    question: item.question,
    answer: item.answer,
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
    noticeDate: formatYmdShanghai(item.answerTimeMs),
    answerTimeStr: formatDateTimeShanghai(item.answerTimeMs),
    eventTimeMs: item.answerTimeMs,
    sourceUrl: 'https://sns.sseinfo.com/',
  };
}

export async function fetchLatestSseHolderQA({ isWarmup = false } = {}) {
  const pages = isWarmup ? [1, 2, 3, 4, 5, 6] : [1, 2, 3];
  const now = Date.now();
  const map = new Map();
  let anySuccess = false;
  let lastErr = null;

  for (let i = 0; i < pages.length; i += 3) {
    const batch = pages.slice(i, i + 3);
    const settled = await Promise.allSettled(
      batch.map((page) =>
        fetchSseText(`/ajax/feeds.do?type=11&pageSize=20&lastid=-1&show=1&page=${page}`)
      )
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        anySuccess = true;
        const parsedList = parseSseFeedsHtml(s.value, now);
        for (const rawItem of parsedList) {
          const enriched = enrichSseItem(rawItem);
          if (enriched && !map.has(enriched.id)) {
            map.set(enriched.id, enriched);
          }
        }
      } else {
        lastErr = s.reason;
      }
    }
  }

  if (!anySuccess && lastErr) {
    throw lastErr;
  }

  return [...map.values()].sort((a, b) => b.eventTimeMs - a.eventTimeMs);
}
