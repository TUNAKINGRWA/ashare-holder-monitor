/**
 * A股股东人数问答解析引擎 v2.0 (Ultra-Precision Clause & Timeline Parser)
 * 特性：
 * 1. 全角数字/中文数词/千分位空格归一化
 * 2. 提问意图真实性判别（区分“真问股东人数”与“仅拿旧户数当背景问机构持仓/经营”）
 * 3. 中登公司(CSDC)全口径术语覆盖（合并普通账户和融资融券信用账户持有人数、股份持有人数、股东共X户等）
 * 4. 严密防误报护栏（剔除H股/B股/优先股/可转债持有人、政企客户/居民用户X户、回购增持万股、较上期减少X户差值）
 * 5. 单条回复多期数据同时提取 + 最新报告期自动优选 + 文本内上期基准联动
 * 6. 季报复述识别（区分“一手新鲜旬度披露”与“拿两个月前季报敷衍回复”）
 * 7. 约数四舍五入误差带计算（如“约42万户” -> ±5,000户精度区间）
 */

const CN_MONTH_MAP = {
  '十二': '12',
  '十一': '11',
  '十': '10',
  '九': '09',
  '八': '08',
  '七': '07',
  '六': '06',
  '五': '05',
  '四': '04',
  '三': '03',
  '二': '02',
  '一': '01',
  '正': '01',
};

const CN_DAY_MAP = {
  '三十一': '31', '三十': '30', '二十九': '29', '二十八': '28', '二十七': '27',
  '二十六': '26', '二十五': '25', '二十四': '24', '二十三': '23', '二十二': '22',
  '二十一': '21', '二十': '20', '十九': '19', '十八': '18', '十七': '17',
  '十六': '16', '十五': '15', '十四': '14', '十三': '13', '十二': '12',
  '十一': '11', '十': '10', '九': '09', '八': '08', '七': '07',
  '六': '06', '五': '05', '四': '04', '三': '03', '二': '02', '一': '01',
};

const CN_DIGIT_VAL = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3,
  四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};

export function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    // 全角数字转半角 ０-９ -> 0-9
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.')
    // 数字内部的中文逗号或窄空格千分位归一，如 "41，205" -> "41,205"
    .replace(/(\d)[，](\d{3})(?!\d)/g, '$1,$2')
    .replace(/(\d)\s+(\d{3})(?=\s*(?:户|人|名|[，。！？；\n]|$))/g, '$1,$2')
    .replace(/[ \t\r]+/g, ' ')
    .trim();
}

/**
 * 将常见中文数字户数转为阿拉伯数字表达：
 * 如 "三万五千户" -> "35000户", "十二万余户" -> "12万余户", "4万2千户" -> "42000户"
 */
export function normalizeChineseNumbers(text = '') {
  let out = String(text);

  // 混合表达：4万2千 / 3万5千 -> 42000 / 35000
  out = out.replace(/(\d+)\s*万\s*([一二两三四五六七八九1-9])\s*千/g, (_, w, q) => {
    const qVal = /\d/.test(q) ? Number(q) : CN_DIGIT_VAL[q] || 0;
    return String(Number(w) * 10000 + qVal * 1000);
  });

  // 纯中文万千表达：三万五千 / 十二万 / 八万六千
  out = out.replace(
    /([一二两三四五六七八九十]{1,3})\s*万(?:\s*([一二两三四五六七八九])\s*千)?(?=[^股元]*?(?:户|人|名))/g,
    (_, wPart, qPart) => {
      let wNum = 0;
      if (wPart === '十') wNum = 10;
      else if (wPart.startsWith('十')) wNum = 10 + (CN_DIGIT_VAL[wPart[1]] || 0);
      else if (wPart.endsWith('十')) wNum = (CN_DIGIT_VAL[wPart[0]] || 0) * 10;
      else if (wPart.includes('十')) {
        const [a, b] = wPart.split('十');
        wNum = (CN_DIGIT_VAL[a] || 0) * 10 + (CN_DIGIT_VAL[b] || 0);
      } else {
        wNum = CN_DIGIT_VAL[wPart] || 0;
      }
      if (!wNum) return _;
      if (qPart) {
        return String(wNum * 10000 + (CN_DIGIT_VAL[qPart] || 0) * 1000);
      }
      return `${wNum}万`;
    }
  );

  return out;
}

export function normalizeChineseDateWords(text = '') {
  let out = String(text);
  // 中文年份：二零二六年 / 二〇二六年 -> 2026年
  out = out.replace(/二[零〇]二([零〇一二三四五六七八九])\s*年/g, (_, d) => `202${CN_DIGIT_VAL[d] ?? 6}年`);
  for (const [cn, num] of Object.entries(CN_MONTH_MAP)) {
    out = out.replace(new RegExp(`${cn}\\s*月`, 'g'), `${num}月`);
  }
  for (const [cn, num] of Object.entries(CN_DAY_MAP)) {
    out = out.replace(new RegExp(`(\\d{1,2}\\s*月\\s*)${cn}\\s*(日|号)`, 'g'), `$1${num}日`);
  }
  return out;
}

function getLastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getShanghaiYearMonth(refTimestampMs = Date.now()) {
  const shTime = new Date(refTimestampMs + 8 * 3600 * 1000);
  return {
    year: shTime.getUTCFullYear(),
    month: shTime.getUTCMonth() + 1,
    day: shTime.getUTCDate(),
  };
}

/**
 * 董秘未来日期笔误自动纠偏器：
 * 真实案例：如 300555 ST路通 在 2026-11-11 回复“截止11.10股东人数”时，董秘笔误写成了未来日期“截至2026年11月20日，股东总数为5307人”；
 * 或董秘在 2026年11月 笔误写成“2027年11月10日”。中登公司不可能提前下发未来3天以上的名册，此处结合提问锚点与旬度日历自动纠偏！
 */
export function sanitizeFutureDateTypo(rawEndDate, questionDate, refTimestampMs = Date.now()) {
  if (!rawEndDate) return { endDate: null, typoCorrectedFrom: null };
  const { year: rY, month: rM, day: rD } = getShanghaiYearMonth(refTimestampMs);
  const replyDateYmd = `${rY}-${pad2(rM)}-${pad2(rD)}`;

  const endDayMs = Date.parse(`${rawEndDate}T00:00:00+08:00`);
  const replyDayMs = Date.parse(`${replyDateYmd}T00:00:00+08:00`);
  if (!Number.isFinite(endDayMs) || !Number.isFinite(replyDayMs)) {
    return { endDate: rawEndDate, typoCorrectedFrom: null };
  }

  const futureDays = Math.round((endDayMs - replyDayMs) / (24 * 3600 * 1000));
  // 允许最多2天周末自然日顺延（如周五晚间提前称呼周六/周日的月末或20日名册）
  if (futureDays <= 2) {
    return { endDate: rawEndDate, typoCorrectedFrom: null };
  }

  // 1. 优先使用投资者提问中合法的近期截止日（如问“截止11.10”，答笔误写成“11月20日”）
  if (questionDate) {
    const qDayMs = Date.parse(`${questionDate}T00:00:00+08:00`);
    const qDiffDays = Math.round((qDayMs - replyDayMs) / (24 * 3600 * 1000));
    if (Number.isFinite(qDiffDays) && qDiffDays <= 2 && qDiffDays >= -90) {
      return { endDate: questionDate, typoCorrectedFrom: rawEndDate };
    }
  }

  const [y, m, d] = rawEndDate.split('-').map(Number);

  // 2. 年份笔误纠偏（如在2026年11月15日误写成“2027年11月10日”）
  if (y > rY && m >= 1 && m <= 12) {
    const candSameYear = `${rY}-${pad2(m)}-${pad2(Math.min(d, getLastDayOfMonth(rY, m)))}`;
    if (candSameYear <= replyDateYmd) {
      return { endDate: candSameYear, typoCorrectedFrom: rawEndDate };
    }
  }

  // 3. 月份笔误纠偏（如在2026年10月13日误写成“2026年11月10日”）
  if (m > rM && y === rY) {
    const candSameMonth = `${rY}-${pad2(rM)}-${pad2(Math.min(d, getLastDayOfMonth(rY, rM)))}`;
    if (candSameMonth <= replyDateYmd) {
      return { endDate: candSameMonth, typoCorrectedFrom: rawEndDate };
    }
  }

  // 4. 兜底回退至不晚于回复日的最近一个中登标准旬度截止日（20日 / 10日 / 上月末）
  let snapped;
  if (rD >= 20) {
    snapped = `${rY}-${pad2(rM)}-20`;
  } else if (rD >= 10) {
    snapped = `${rY}-${pad2(rM)}-10`;
  } else {
    const prevY = rM === 1 ? rY - 1 : rY;
    const prevM = rM === 1 ? 12 : rM - 1;
    snapped = `${prevY}-${pad2(prevM)}-${pad2(getLastDayOfMonth(prevY, prevM))}`;
  }
  return { endDate: snapped, typoCorrectedFrom: rawEndDate };
}

function inferYearForMonth(month, refTimestampMs = Date.now()) {
  const { year: refYear, month: refMonth } = getShanghaiYearMonth(refTimestampMs);
  if (month > refMonth + 1) {
    return refYear - 1;
  }
  return refYear;
}

/**
 * 从单段文本中提取单个统计截止日 (YYYY-MM-DD)
 */
export function extractDateFromSegment(rawSegment = '', refTimestampMs = Date.now()) {
  // 剔除“较10月末”“比2026年10月20日”“相比9月底”这类明确指向上期对比基准的日期短语，防止覆盖本期截止日！
  const src = normalizeChineseDateWords(rawSegment).replace(
    /(?:较|比|对比|相比)\s*(?:上期\s*[（(]?)?\s*(?:20\d{2}\s*[年.\-/]\s*)?\d{1,2}\s*(?:[月.\-/]\s*\d{1,2}\s*[日号]?|月\s*(?:上旬|中旬|下旬|末|底))/g,
    ' [PREV_DATE] '
  );
  if (!src) return null;

  // 1. 完整年月日 (优先带 截至/截止，其次常规年月日，排除“披露于2024年X月X日的公告”)
  const anchoredFull = src.match(
    /(?:截至|截止)(?:到|至)?\s*(20\d{2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?/
  );
  if (anchoredFull) {
    const [, y, m, d] = anchoredFull.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  // 2. 不带年份的锚定月日：截至11月10日 / 截至11.10 / 截至11-10
  const anchoredMd = src.match(
    /(?:截至|截止)(?:到|至)?\s*(\d{1,2})\s*(?:月\s*(\d{1,2})\s*[日号]?|[./-](\d{1,2})(?![0-9.%万亿]))/
  );
  if (anchoredMd) {
    const m = Number(anchoredMd[1]);
    const d = Number(anchoredMd[2] || anchoredMd[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${inferYearForMonth(m, refTimestampMs)}-${pad2(m)}-${pad2(d)}`;
    }
  }

  // 3. 旬度 / 月末 / 月底：2026年11月上旬 / 10月末 / 10月底
  const xunMatch = src.match(/(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(上旬|中旬|下旬|末|底)/);
  if (xunMatch) {
    const m = Number(xunMatch[2]);
    if (m >= 1 && m <= 12) {
      const y = xunMatch[1] ? Number(xunMatch[1]) : inferYearForMonth(m, refTimestampMs);
      const tag = xunMatch[3];
      const d = tag === '上旬' ? 10 : tag === '中旬' ? 20 : getLastDayOfMonth(y, m);
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
  }

  // 4. 季度末 / 半年末 / 年末
  const quarterMatch = src.match(
    /(?:(20\d{2})\s*年)?\s*(?:第)?(一季度|1季度|二季度|2季度|半年度|半年|年中|三季度|3季度|四季度|4季度|年末|年底)(?:报告期末|末|底)?/
  );
  if (quarterMatch && /(?:截至|截止|报告|股东|持有人)/.test(src)) {
    const qTag = quarterMatch[2];
    let m = 12;
    if (/一|1/.test(qTag)) m = 3;
    else if (/二|2|半年|年中/.test(qTag)) m = 6;
    else if (/三|3/.test(qTag)) m = 9;
    const y = quarterMatch[1] ? Number(quarterMatch[1]) : inferYearForMonth(m, refTimestampMs);
    return `${y}-${pad2(m)}-${pad2(getLastDayOfMonth(y, m))}`;
  }

  // 5. 紧邻股东/持有人描述的日期：公司2026年11月10日含信用账户...
  const unanchoredFull = src.match(
    /(20\d{2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?(?![^。；\n]{0,12}?(?:披露|公告|决议))/
  );
  if (unanchoredFull) {
    const [, y, m, d] = unanchoredFull.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  const unanchoredMd = src.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (unanchoredMd) {
    const m = Number(unanchoredMd[1]);
    const d = Number(unanchoredMd[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${inferYearForMonth(m, refTimestampMs)}-${pad2(m)}-${pad2(d)}`;
    }
  }

  return null;
}

export function extractCutoffDate(answerText = '', questionText = '', refTimestampMs = Date.now()) {
  return (
    extractDateFromSegment(answerText, refTimestampMs) ||
    extractDateFromSegment(questionText, refTimestampMs)
  );
}

// 股东人数核心名词组（覆盖中登公司与沪深京全部官方表述）
const HOLDER_NOUN_CORE =
  '(?:(?:A股|普通股|无限售|流通股|合并[^，。；\\n]{0,22}?)(?:股东|股份|证券|账户)?(?:总)?(?:持有人数|人数|户数|总数|总户数|家数|名册人数|数量|数)' +
  '|(?:股份|证券|普通股|账户)持有人(?:总)?(?:人数|户数|数)(?:[（(][^）)]{0,12}[)）])?' +
  '|持有人(?:总)?(?:人数|户数|数)(?:[（(][^）)]{0,12}[)）])?' +
  '|(?:在册|登记在册|全体)?股东(?:总)?(?:人数|户数|总数|总户数|家数|名册人数|数量|数)(?:[（(][^）)]{0,16}[)）])?)';

/**
 * 严格判定该问答是否“真正询问或披露了股东人数”
 * 解决痛点：如投资者说“公司股东户数1.52万户...请问机构持仓比例是多少？”，回答“相关比例非公开”，不应算作股东人数问答！
 */
export function isHolderCountTopic(questionText = '', answerText = '') {
  const q = decodeHtmlEntities(questionText);
  const a = decodeHtmlEntities(answerText);

  const countKeywordRe =
    /(?:股东\s*(?:总)?\s*(?:人数|户数|总数|总户数|家数|名册|数量|数)|(?:股份|账户|合并[^，。？\n]{0,16}?)持有人数|(?:人数|户数|多少户|几户|多少人|几人)[^，。？\n]{0,8}?股东|在册股东|最新股东(?:数|户|人)|股东(?:共|约|有|为)?\s*(?:多少|几|\d+)\s*(?:万)?\s*(?:户|人))/i;

  const aHasTopic = countKeywordRe.test(a);
  if (aHasTopic) return true;

  if (!countKeywordRe.test(q)) return false;

  // 若仅提问中出现了“股东户数”，需验证它是“疑问句核心”而非“陈述背景句”！
  // 按句号及逗号粒度切分子句：若包含“股东户数”的子句本身已经给出了具体户数且无疑问词，说明只是背景陈述！
  const qClauses = q.split(/[。！？!?；;\n，,]+/).filter(Boolean);
  for (const clause of qClauses) {
    if (countKeywordRe.test(clause)) {
      const alreadyStatedNumber = /股东(?:人数|户数|总数)?[为是约达共]?\s*\d+(?:\.\d+)?\s*万?\s*(?:户|人)/.test(clause);
      const hasInterrogative = /(?:多少|几|请问|能否|可否|是否|告知|公布|披露|提供|查询|最新|现在|目前|更新)/.test(clause);
      if (alreadyStatedNumber && !hasInterrogative) {
        continue;
      }
      return true;
    }
  }

  return false;
}

/**
 * 计算约数四舍五入误差区间
 * 例如："约42万户" -> [415000, 425000], "约7.3万户" -> [72500, 73500], "8.6万余户" -> [86000, 87000]
 */
function computePrecisionBounds(rawNumStr, wanFlag, snippetText) {
  const cleanNum = rawNumStr.replace(/,/g, '');
  const val = Number(cleanNum);
  const count = wanFlag ? Math.round(val * 10000) : Math.round(val);

  if (!wanFlag && !/(?:约|近|超|逾|余|左右|以上|多户|多人|大概)/.test(snippetText)) {
    return {
      isApproximate: false,
      halfWidth: 0,
      minPossible: count,
      maxPossible: count,
    };
  }

  let step = 100;
  if (wanFlag) {
    const decPart = cleanNum.includes('.') ? cleanNum.split('.')[1].length : 0;
    step = Math.pow(10, Math.max(0, 4 - decPart)); // "42万" -> step=10000; "7.3万" -> step=1000; "1.52万" -> step=100
  }

  if (/(?:余|多|超|逾|以上)/.test(snippetText)) {
    return {
      isApproximate: true,
      halfWidth: Math.round(step / 2),
      minPossible: count,
      maxPossible: count + step,
    };
  }

  if (/(?:不足|不到|低于|少于|以内)/.test(snippetText)) {
    return {
      isApproximate: true,
      halfWidth: Math.round(step / 2),
      minPossible: Math.max(1, count - step),
      maxPossible: count,
    };
  }

  const half = Math.round(step / 2);
  return {
    isApproximate: true,
    halfWidth: half,
    minPossible: Math.max(1, count - half),
    maxPossible: count + half,
  };
}

/**
 * 在单个子句中抽取股东户数候选值（带优先级评分与多重防误报校验）
 */
function extractCandidatesFromClause(clauseRaw, refTimestampMs, questionIsDirectAsk) {
  const normalized = normalizeChineseNumbers(normalizeChineseDateWords(clauseRaw));

  // 遮盖日期、股票代码、电话、邮箱用户名中的数字，但保留原句语义结构
  const masked = normalized
    .replace(/20\d{2}\s*[年.\-/]\s*\d{1,2}\s*[月.\-/]\s*\d{1,2}\s*[日号]?/g, ' [DATE] ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, ' [DATE] ')
    .replace(/[（(]\s*\d{6}(?:\.[A-Z]{2})?\s*[)）]/g, ' [CODE] ')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g, ' [EMAIL] ')
    .replace(/\b0\d{2,3}-\d{7,8}\b/g, ' [TEL] ');

  // 排除非A股普通股类别（H股/B股/外资股/优先股/可转债/债券/员工持股计划/激励对象/单独融资融券信用账户子项）
  const NON_ASHARE_PREFIX = /(?:H股|B股|外资股|优先股|可转债|转债|债券|员工持股|激励对象|期权|合伙人)(?:股东|持有人)?[^，。；\n]{0,8}$/i;
  // 排除股东大会出席/表决人数（如“出席本次股东大会的股东及代理人共412人”）
  const MEETING_PREFIX = /(?:出席|参加|参与|股东大会|现场会议|网络投票|表决权)[^。；\n]{0,24}$/;
  // 排除客户/用户/商户/住户等非股东“户”数！
  const CUSTOMER_PREFIX = /(?:客户|用户|商户|住户|居民|家庭|农户|工商户|商家|门店|网点|会员|订户|患者|终端)[^，。；\n]{0,12}$/;
  // 排除增减变动差值（如“较上期减少2,500户”“环比下降1200户”）
  const DELTA_PREFIX = /(?:减少|下降|降低|缩减|流失|增加|增长|上升|多出|净增|净减|变动|变化|相差|差额)(?:了|约|共)?\s*$/;
  // 排除明确标注为“上期/前值/较XX日”的对比背景值
  const PREV_REF_PREFIX = /(?:较|比|对比|相比|上期|上一期|前一期)[^，。；\n]{0,14}$/;

  const regexList = [
    // P0 (score 105): 明确指定 A股股东（在 A+H / A+B 同时披露时最高优先级命中 A股口径！）
    {
      score: 105,
      re: /A股(?:普通股)?股东(?:总)?(?:持有人数|人数|户数|总数|总户数|家数|名册人数|数量|数)?[^0-9。；！？\n，,]{0,12}?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?\s*(户|人|名|位|家)?/g,
    },
    // P1 (score 100): 明确 普通股 / 合并信用账户 股东或持有人数
    {
      score: 100,
      re: new RegExp(
        `(?:普通股|合并[^，。；\\n]{0,24}?)(?:股东|股份|证券|账户)?(?:总)?(?:持有人数|人数|户数|总数|总户数|家数|名册人数|数量|数)(?:[（(][^）)]{0,16}[)）])?[^0-9。；！？\\n]{0,16}?([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(万)?\\s*(户|人|名|位|家)?`,
        'g'
      ),
    },
    // P2 (score 90): 通用 股东人数 / 股东户数 / 股份持有人数 / 持有人数
    {
      score: 90,
      re: new RegExp(
        `${HOLDER_NOUN_CORE}[^0-9。；！？\\n]{0,16}?([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(万)?\\s*(户|人|名|位|家)?`,
        'g'
      ),
    },
    // P3 (score 85): “公司股东共114103户” / “公司在册股东约7.3万户” / “共有股东25,000户”（无“人数/户数”后缀但带“股东+动词+户/人/名”）
    {
      score: 85,
      re: /(?:在册|普通股|A股|公司|本公司|全体)?股东(?:共计|合计|总计|共有|共|约为|约有|约|达|有|为|是)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?\s*(?:余|多)?\s*(户|人|名)/g,
    },
    // P4 (score 82): “共有 25,000 户股东” / “较上期减少2500户至 21,900 户”
    {
      score: 82,
      re: /(?:增至|降至|减至|升至|跌至|达到|至)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?\s*(?:余|多)?\s*(户|人|名)/g,
    },
    // P5 (score 70, 仅当提问明确问股东人数时启用): 董秘极简回复 “截至XX日收盘为 18,021 户” 或 “您好，47,127户！”
    ...(questionIsDirectAsk
      ? [
          {
            score: 70,
            re: /(?:截至|截止|收盘|收市|目前|最新)[^0-9。；\n]{0,14}?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?\s*(?:余|多)?\s*(户|人|名)/g,
          },
          {
            score: 60,
            re: /(?:^|[，。！!：:\s])([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?\s*(户)(?=$|[，。！!；;\s（(])/g,
          },
        ]
      : []),
  ];

  const found = [];
  const clauseDate = extractDateFromSegment(clauseRaw, refTimestampMs);

  for (const { score, re } of regexList) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const fullMatch = m[0];
      const rawNumStr = m[1];
      const wanFlag = m[2];
      const unitFlag = m[3];

      const beforeText = masked.slice(Math.max(0, m.index - 22), m.index);
      const beforeWithInternal = masked.slice(Math.max(0, m.index - 18), m.index + fullMatch.indexOf(rawNumStr));
      const afterIdx = m.index + fullMatch.length;
      const trailing = masked.slice(afterIdx, afterIdx + 8);

      // 1. 后缀非户数单位拦截（股、元、%、倍、亿元、家子公司等）
      if (/^\s*(?:万|亿|千|百)?\s*(?:股|元|港元|美元|%|％|倍|吨|年|月|日|号|次|期|家子公司|家门店|家公司)/.test(trailing)) {
        continue;
      }
      // 2. 非A股普通股拦截（H股/B股/可转债/员工持股）及股东大会出席人数拦截
      if (
        NON_ASHARE_PREFIX.test(beforeText) ||
        MEETING_PREFIX.test(beforeWithInternal) ||
        /(?:H股|B股|优先股|可转债|转债|债券|员工持股|激励对象|股东大会|代理人)/i.test(fullMatch)
      ) {
        continue;
      }
      // 单独“信用账户股东X户”（非“含信用账户/合并信用账户”）降权，避免压过合并总户数
      const isIsolatedCreditSubAccount =
        /(?:^|[，,；\s])(?:融资融券)?信用(?:证券)?账户(?:股东|持有人)/.test(beforeText + fullMatch) &&
        !/(?:合并|含)/.test(beforeText + fullMatch);
      // 3. 客户/用户/居民“户”数拦截
      if (CUSTOMER_PREFIX.test(beforeWithInternal) || /(?:客户|用户|商户|住户|居民|农户|会员|门店)/.test(fullMatch)) {
        continue;
      }
      // 4. 持股/回购/增减持/分红上下文拦截
      if (/(?:持股|回购|增持|减持|分红|派发|质押|冻结|解禁)/.test(fullMatch)) {
        continue;
      }
      // 5. 增减差值拦截（除非是 P4 的“降至 X 户”）
      if (score !== 82 && DELTA_PREFIX.test(beforeWithInternal)) {
        continue;
      }

      const isPrevRef = PREV_REF_PREFIX.test(beforeText);

      const numericVal = Number(rawNumStr.replace(/,/g, ''));
      if (!Number.isFinite(numericVal) || numericVal <= 0) continue;

      if (!wanFlag && !unitFlag) {
        if (rawNumStr.includes('.')) continue;
        if (numericVal >= 1990 && numericVal <= 2035 && !rawNumStr.includes(',')) continue;
      }

      const finalCount = wanFlag ? Math.round(numericVal * 10000) : Math.round(numericVal);
      if (finalCount < 300 || finalCount > 25_000_000) continue;

      const precision = computePrecisionBounds(rawNumStr, wanFlag, fullMatch + trailing.slice(0, 2));

      found.push({
        holderNum: finalCount,
        endDate: clauseDate,
        score: (isPrevRef ? score - 50 : score) - (isIsolatedCreditSubAccount ? 40 : 0),
        isPrevRef,
        ...precision,
      });
    }
  }

  return found;
}

/**
 * 主入口：解析一条投资者互动问答
 */
export function parseInteractionQA({
  question = '',
  answer = '',
  refTimestampMs = Date.now(),
}) {
  const rawCleanQ = decodeHtmlEntities(question);
  // 识别并剥离全景网等聚合源尾部的 "(来自：深交所互动易)" / "(来自：上证e互动)"
  let originChannel = null;
  const originMatch = answer.match(/[（(]\s*来自[：:]\s*([^）)]+)[)）]\s*$/);
  if (originMatch) {
    originChannel = originMatch[1].trim();
  }
  const strippedAnswer = answer.replace(/[（(]\s*来自[：:][^）)]+[)）]\s*$/, '');
  const cleanA = decodeHtmlEntities(strippedAnswer);

  if (!isHolderCountTopic(rawCleanQ, cleanA)) {
    return {
      isTopic: false,
      replyType: 'irrelevant',
      holderNum: null,
      endDate: null,
      typoCorrectedFrom: null,
      allPeriods: [],
      isApproximate: false,
      excludesBuyback: false,
      isStalePeriodicQuote: false,
      originChannel,
    };
  }

  const questionDate = extractDateFromSegment(rawCleanQ, refTimestampMs);
  // 分句与分号级扫描，支持单条回复包含多个报告期（含“分别为”并列映射与多子句映射）
  const sentences = cleanA.split(/[。！？!?\n；;]+/).filter((s) => s.trim().length > 0);
  const allCandidates = [];

  for (const sentence of sentences) {
    // 特殊语法结构：并列映射句，如“截至10月31日、11月10日，公司股东人数分别为28,500户、26,100户”
    if (/分别(?:为|是)?/.test(sentence) && /(?:股东|持有人)/.test(sentence)) {
      const [leftPart, rightPart] = sentence.split(/分别(?:为|是)?/);
      if (leftPart && rightPart) {
        const dateTokens = leftPart
          .split(/[、和及与，]|(?<!\d),(?!\d)/)
          .map((seg) => extractDateFromSegment(seg, refTimestampMs))
          .filter(Boolean);
        const normRight = normalizeChineseNumbers(rightPart);
        const numMatches = [
          ...normRight.matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?\s*(?:余|多)?\s*(户|人|名)?/g),
        ]
          .map((m) => {
            const val = Number(m[1].replace(/,/g, ''));
            const cnt = m[2] ? Math.round(val * 10000) : Math.round(val);
            const prec = computePrecisionBounds(m[1], m[2], m[0]);
            return cnt >= 300 && cnt <= 25_000_000 ? { cnt, ...prec } : null;
          })
          .filter(Boolean);

        if (dateTokens.length >= 2 && dateTokens.length === numMatches.length) {
          for (let i = 0; i < dateTokens.length; i++) {
            allCandidates.push({
              holderNum: numMatches[i].cnt,
              endDate: dateTokens[i],
              score: 110,
              isPrevRef: false,
              isApproximate: numMatches[i].isApproximate,
              halfWidth: numMatches[i].halfWidth,
              minPossible: numMatches[i].minPossible,
              maxPossible: numMatches[i].maxPossible,
            });
          }
          continue;
        }
      }
    }

    // 若同一句内出现了两个独立“截至/截止”，仅按中文逗号或非千分位逗号切分以精确绑定各自的截止日！
    const dateMentions = sentence.match(/(?:截至|截止|20\d{2}\s*[年.\-/]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号])/g) || [];
    const subClauses =
      dateMentions.length >= 2
        ? sentence.split(/，|(?<!\d),(?!\d)/).filter((s) => s.trim().length > 0)
        : [sentence];

    let carryDate = extractDateFromSegment(sentence, refTimestampMs);
    for (const sub of subClauses) {
      const subDate = extractDateFromSegment(sub, refTimestampMs) || carryDate;
      if (subDate) carryDate = subDate;
      const cands = extractCandidatesFromClause(sub, refTimestampMs, true);
      for (const c of cands) {
        allCandidates.push({
          ...c,
          endDate: c.endDate || subDate || questionDate || null,
        });
      }
    }
  }

  if (allCandidates.length === 0) {
    return {
      isTopic: true,
      replyType: 'declined',
      holderNum: null,
      endDate: null,
      typoCorrectedFrom: null,
      allPeriods: [],
      isApproximate: false,
      excludesBuyback: false,
      isStalePeriodicQuote: false,
      originChannel,
    };
  }

  // 对候选截止日执行董秘未来日期笔误校验与自动纠偏（如 11-11 回复误写成 11-20 或 2027-11-10）
  const sanitizedCandidates = allCandidates.map((c) => {
    if (!c.endDate) return { ...c, typoCorrectedFrom: null };
    const { endDate, typoCorrectedFrom } = sanitizeFutureDateTypo(
      c.endDate,
      questionDate,
      refTimestampMs
    );
    return { ...c, endDate, typoCorrectedFrom };
  });

  // 按报告期去重（同一截止日保留最高置信度候选）
  const byPeriodKey = new Map();
  for (const c of sanitizedCandidates) {
    const key = c.endDate || `nodate_${c.holderNum}`;
    const existing = byPeriodKey.get(key);
    if (!existing || c.score > existing.score) {
      byPeriodKey.set(key, c);
    }
  }

  const uniquePeriods = [...byPeriodKey.values()]
    .filter((c) => !c.isPrevRef || byPeriodKey.size === 1)
    .sort((a, b) => {
      // 有明确最新截止日的优先按日期倒序，选出最新一期！
      if (a.endDate && b.endDate && a.endDate !== b.endDate) {
        return b.endDate.localeCompare(a.endDate);
      }
      return b.score - a.score;
    });

  const primary = uniquePeriods[0];
  // 如果同条回答中还披露了紧邻的上一期数值（如同时回答了10-30和11-10），记录文本自带上期！
  const inlinePrev = uniquePeriods.length >= 2 && uniquePeriods[1].endDate && primary.endDate && uniquePeriods[1].endDate < primary.endDate
    ? { endDate: uniquePeriods[1].endDate, holderNum: uniquePeriods[1].holderNum }
    : sanitizedCandidates.find((c) => c.isPrevRef && c.holderNum !== primary.holderNum) || null;

  // 判定是否为“仅复述过往季报/半年报/年报旧数据（非新鲜旬度披露）”
  let isStalePeriodicQuote = false;
  if (primary.endDate) {
    const endMs = Date.parse(`${primary.endDate}T23:59:59+08:00`);
    const ageDays = (refTimestampMs - endMs) / (24 * 3600 * 1000);
    const isQuarterEnd = /-(?:03-31|06-30|09-30|12-31)$/.test(primary.endDate);
    const mentionsPeriodicReport = /(?:定期报告|季度报告|三季报|一季报|半年报|半年度报告|年报|年度报告)/.test(cleanA);

    if (ageDays > 38 || (isQuarterEnd && mentionsPeriodicReport && ageDays > 24)) {
      isStalePeriodicQuote = true;
    }
  }

  const excludesBuyback = /(?:剔除|不含|扣除)[^。；\n]{0,14}?回购/.test(cleanA);

  return {
    isTopic: true,
    replyType: isStalePeriodicQuote ? 'stale_periodic' : 'disclosed',
    holderNum: primary.holderNum,
    endDate: primary.endDate,
    typoCorrectedFrom: primary.typoCorrectedFrom || null,
    isApproximate: primary.isApproximate,
    precisionHalfWidth: primary.halfWidth,
    minPossible: primary.minPossible,
    maxPossible: primary.maxPossible,
    excludesBuyback,
    isStalePeriodicQuote,
    inlinePrev,
    allPeriods: uniquePeriods.map((p) => ({
      endDate: p.endDate,
      holderNum: p.holderNum,
      isApproximate: p.isApproximate,
    })),
    originChannel,
  };
}

/**
 * 解析上证e互动时间文本为毫秒时间戳（东八区）
 */
export function parseSseTimestamp(timeStr = '', nowMs = Date.now()) {
  const s = String(timeStr).trim();
  if (!s) return nowMs;

  if (s.includes('刚刚')) return nowMs;
  const minAgo = s.match(/(\d+)\s*分钟前/);
  if (minAgo) return nowMs - Number(minAgo[1]) * 60 * 1000;
  const secAgo = s.match(/(\d+)\s*秒前/);
  if (secAgo) return nowMs - Number(secAgo[1]) * 1000;
  const hourAgo = s.match(/(\d+)\s*小时前/);
  if (hourAgo) return nowMs - Number(hourAgo[1]) * 3600 * 1000;

  const { year: curY, month: curM, day: curD } = getShanghaiYearMonth(nowMs);

  const todayMatch = s.match(/今天\s*(\d{1,2}):(\d{1,2})/);
  if (todayMatch) {
    return Date.parse(`${curY}-${pad2(curM)}-${pad2(curD)}T${pad2(todayMatch[1])}:${pad2(todayMatch[2])}:00+08:00`);
  }

  const yestMatch = s.match(/昨天\s*(\d{1,2}):(\d{1,2})/);
  if (yestMatch) {
    const base = Date.parse(`${curY}-${pad2(curM)}-${pad2(curD)}T${pad2(yestMatch[1])}:${pad2(yestMatch[2])}:00+08:00`);
    return base - 24 * 3600 * 1000;
  }

  const fullMatch = s.match(/(20\d{2})[-年.](\d{1,2})[-月.](\d{1,2})[日]?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (fullMatch) {
    return Date.parse(
      `${fullMatch[1]}-${pad2(fullMatch[2])}-${pad2(fullMatch[3])}T${pad2(fullMatch[4])}:${pad2(fullMatch[5])}:${pad2(fullMatch[6] || 0)}+08:00`
    );
  }

  const mdMatch = s.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{1,2})/);
  if (mdMatch) {
    const m = Number(mdMatch[1]);
    const y = inferYearForMonth(m, nowMs);
    return Date.parse(
      `${y}-${pad2(m)}-${pad2(mdMatch[2])}T${pad2(mdMatch[3])}:${pad2(mdMatch[4])}:00+08:00`
    );
  }

  return nowMs;
}

/**
 * 解析上证e互动 ajax/feeds.do 返回的 HTML 片段列表
 */
export function parseSseFeedsHtml(html = '', nowMs = Date.now()) {
  const items = [];
  const parts = String(html).split(/<div\s+class="m_feed_item"\s+id="item-/i);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const idMatch = block.match(/^(\d+)"/);
    if (!idMatch) continue;
    const itemId = idMatch[1];

    const qaSplit = block.split(/<div\s+class="m_feed_detail\s+m_qa"/i);
    const qPart = qaSplit[0] || '';
    const aPart = qaSplit[1] || '';
    if (!aPart) continue;

    let stockName = '';
    let stockCode = '';
    const codeInLink = qPart.match(/:([^<()]+?)\((\d{6})\)\s*<\/a>/);
    if (codeInLink) {
      stockName = decodeHtmlEntities(codeInLink[1]).trim();
      stockCode = codeInLink[2];
    } else {
      const avatarCode = block.match(/avatar\/company\/(\d{6})\.png/i);
      if (avatarCode) stockCode = avatarCode[1];
      const titleMatch = aPart.match(/class="ansface"[^>]*title="([^"]+)"/i);
      if (titleMatch) stockName = decodeHtmlEntities(titleMatch[1]).trim();
    }

    const qTxtMatch = qPart.match(/<div\s+class="m_feed_txt"[^>]*>([\s\S]*?)<\/div>/i);
    let questionText = '';
    if (qTxtMatch) {
      const rawQ = qTxtMatch[1].replace(/<a[^>]*>:[\s\S]*?<\/a>/i, '');
      questionText = decodeHtmlEntities(rawQ);
    }

    const aTxtMatch = aPart.match(/<div\s+class="m_feed_txt"[^>]*>([\s\S]*?)<\/div>/i);
    const answerText = aTxtMatch ? decodeHtmlEntities(aTxtMatch[1]) : '';

    const qTimeMatch = qPart.match(/<div\s+class="m_feed_from"[^>]*>\s*<span>([^<]+)<\/span>/i);
    const aTimeMatch = aPart.match(/<div\s+class="m_feed_from"[^>]*>\s*<span>([^<]+)<\/span>/i);
    const questionTimeStr = qTimeMatch ? qTimeMatch[1].trim() : '';
    const answerTimeStr = aTimeMatch ? aTimeMatch[1].trim() : questionTimeStr;
    const pubTimestampMs = parseSseTimestamp(answerTimeStr || questionTimeStr, nowMs);

    if (!stockCode || !answerText) continue;

    items.push({
      rawId: itemId,
      id: `sse_${itemId}`,
      platform: 'sse_ehudong',
      platformLabel: '上证e互动',
      stockCode,
      secuCode: `${stockCode}.SH`,
      stockName: stockName || stockCode,
      question: questionText,
      answer: answerText,
      answerTimeMs: pubTimestampMs,
      answerTimeStr,
      sourceUrl: 'https://sns.sseinfo.com/',
    });
  }
  return items;
}

/**
 * 判断两个报告截止日期是否对应中登同一旬度/月度名册
 * 中登每月10日、20日、月末下发名册；遇周末/节假日会提前至最近交易日（如10月30日周五 vs 10月31日周六，或10月8日 vs 10月10日）
 */
export function isSameReportPeriod(dateA, dateB) {
  if (!dateA || !dateB) return false;
  const a = String(dateA).slice(0, 10);
  const b = String(dateB).slice(0, 10);
  if (a === b) return true;
  if (a.slice(0, 7) !== b.slice(0, 7)) return false;
  const dayA = Number(a.slice(8, 10));
  const dayB = Number(b.slice(8, 10));
  // 同一旬（上旬 7..12, 中旬 17..22, 月末 26..31）且相差不超过3天
  const bucket = (d) => (d <= 13 ? 1 : d <= 23 ? 2 : 3);
  return bucket(dayA) === bucket(dayB) && Math.abs(dayA - dayB) <= 3;
}

export function inferMarketInfo(stockCode = '') {
  const code = String(stockCode).trim().slice(0, 6);
  if (code.startsWith('688') || code.startsWith('689')) {
    return { secuCode: `${code}.SH`, market: 'SH', board: '科创板', quoteSecId: `1.${code}` };
  }
  if (code.startsWith('6')) {
    return { secuCode: `${code}.SH`, market: 'SH', board: '沪市主板', quoteSecId: `1.${code}` };
  }
  if (code.startsWith('30')) {
    return { secuCode: `${code}.SZ`, market: 'SZ', board: '创业板', quoteSecId: `0.${code}` };
  }
  if (code.startsWith('00')) {
    return { secuCode: `${code}.SZ`, market: 'SZ', board: '深市主板', quoteSecId: `0.${code}` };
  }
  if (code.startsWith('8') || code.startsWith('92') || code.startsWith('43')) {
    return { secuCode: `${code}.BJ`, market: 'BJ', board: '北交所', quoteSecId: `0.${code}` };
  }
  return { secuCode: `${code}.SZ`, market: 'SZ', board: 'A股', quoteSecId: `0.${code}` };
}
