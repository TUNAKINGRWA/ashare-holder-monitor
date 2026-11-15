import { parseInteractionQA, isSameReportPeriod } from './parser.mjs';

const REF_NOV_2026 = Date.parse('2026-11-15T12:00:00+08:00');
const REF_JAN_2027 = Date.parse('2027-01-08T12:00:00+08:00');

export const GOLDEN_BENCHMARK_CASES = [
  // --- 类别1：标准精确户数 ---
  {
    category: '标准精确披露',
    q: '请问贵公司截止11月10日最新股东数？',
    a: '尊敬的投资者，您好！截至2026年11月10日，公司股东户数为414,890户。感谢您的关注！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 414890, endDate: '2026-11-10' },
  },
  {
    category: '标准精确披露',
    q: '尊敬的董秘您好！请问截至11月10日股东总户数？',
    a: '尊敬的投资者您好！截至11月10日，公司股东总户数为88,574户。感谢您的关注。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 88574, endDate: '2026-11-10' },
  },

  // --- 类别2：无“户/人”单位裸数字披露 ---
  {
    category: '无单位裸数字',
    q: '最新股东人数',
    a: '尊敬的投资者您好，截至2026年11月10日，公司股东人数为39,202，感谢您的关注！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 39202, endDate: '2026-11-10' },
  },
  {
    category: '无单位裸数字',
    q: '请问最新一期的股东户数？',
    a: '您好！截至2026年11月10日，公司股东人数为67729。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 67729, endDate: '2026-11-10' },
  },
  {
    category: '无单位裸数字',
    q: '请问公司最新股东人数？',
    a: '尊敬的投资者，您好！截至2026年11月10日，公司普通股股东总数为84,135。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 84135, endDate: '2026-11-10' },
  },

  // --- 类别3：省略“人数/户数”的“股东共X户” ---
  {
    category: '省略人数名词结构',
    q: '请问公司最新一期的股东户数是多少？谢谢',
    a: '您好，截至2026年11月10日，公司股东共114103户，感谢您对公司的关注和支持，谢谢！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 114103, endDate: '2026-11-10' },
  },
  {
    category: '省略人数名词结构',
    q: '请问11月10日股东人数？',
    a: '您好！截至2026年11月10日收盘为 26,330 户。谢谢！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 26330, endDate: '2026-11-10' },
  },
  {
    category: '省略人数名词结构',
    q: '请问11月10日股东户数是多少？',
    a: '您好！47,127户。感谢关注！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 47127, endDate: '2026-11-10' },
  },

  // --- 类别4：中登公司(CSDC)官方持有人数术语 ---
  {
    category: '中登官方持有人术语',
    q: '您好，请问截至11月10日最新的股东人数是多少？',
    a: '尊敬的投资者您好，截至2026年11月10日，公司合并普通账户和融资融券信用账户的持有人数为5,274。感谢您的关注。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 5274, endDate: '2026-11-10' },
  },
  {
    category: '中登官方持有人术语',
    q: '请问截止2026年10月20日公司的股东人数是多少？',
    a: '尊敬的投资者您好，感谢您的关注，截至2026年10月20日，公司合并普通账户和融资融券信用账户持有人数为49,422。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 49422, endDate: '2026-10-20' },
  },
  {
    category: '中登官方持有人术语',
    q: '请问公司截止2026年11月10日的股东户数是多少？',
    a: '您好！根据中国证券登记结算有限责任公司下发的《合并普通账户和融资融券信用账户前N名明细数据表》显示，截至2026年11月10日，公司股份持有人数（已合并）为21024。谢谢您的关注！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 21024, endDate: '2026-11-10' },
  },
  {
    category: '中登官方持有人术语',
    q: '请问最新股东人数？',
    a: '您好，经查询中国证券登记结算有限责任公司的数据，公司2026年11月10日含信用账户合并名册的股东人数为31,252户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 31252, endDate: '2026-11-10' },
  },

  // --- 类别5：中文日期、跨年推断与旬末归一 ---
  {
    category: '复杂日期与跨年推断',
    q: '请问，截至二零二六年十一月十日公司的股东总数是多少？',
    a: '您好，截至二零二六年十一月十日收盘，公司股东人数为18,021户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 18021, endDate: '2026-11-10' },
  },
  {
    category: '复杂日期与跨年推断',
    q: '请问12月31日股东户数？',
    a: '您好，截至12月31日公司股东户数为28,400户。',
    refTs: REF_JAN_2027,
    expect: { replyType: 'disclosed', holderNum: 28400, endDate: '2026-12-31' },
  },
  {
    category: '复杂日期与跨年推断',
    q: '请问11月上旬股东人数？',
    a: '您好，截至2026年11月上旬公司股东总户数为19,500户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 19500, endDate: '2026-11-10' },
  },

  // --- 类别6：中文数词、全角数字与约数精度 ---
  {
    category: '中文数词与全角约数',
    q: '请问最新一期股东人数？',
    a: '您好，截至2026年11月10日，公司股东总户数约为42万户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 420000, endDate: '2026-11-10', isApproximate: true },
  },
  {
    category: '中文数词与全角约数',
    q: '请问11月10日股东人数？',
    a: '感谢您的关注！截止2026年11月10日收盘，最新股东人数8.6万余户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 86000, endDate: '2026-11-10', isApproximate: true },
  },
  {
    category: '中文数词与全角约数',
    q: '请问11月10日股东人数？',
    a: '您好，截至2026年11月10日，公司股东人数约三万五千户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 35000, endDate: '2026-11-10' },
  },
  {
    category: '中文数词与全角约数',
    q: '请问11月10日股东人数？',
    a: '您好，截至2026年11月10日，公司股东户数为４１，２０５户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 41205, endDate: '2026-11-10' },
  },

  // --- 类别7：单条回复多期并列（必须自动提取最新一期！）---
  {
    category: '多期并列自动取最新',
    q: '请问10月20日和11月10日股东人数分别是多少？',
    a: '您好！截至2026年10月20日公司股东人数为25,000户，截至2026年11月10日公司股东人数为22,500户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 22500, endDate: '2026-11-10' },
  },
  {
    category: '多期并列自动取最新',
    q: '请问近期股东户数变化？',
    a: '尊敬的投资者您好：截至2026年11月10日股东户数为18,021户，较上期（2026年10月31日19,500户）减少1,479户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 18021, endDate: '2026-11-10' },
  },

  // --- 类别8：差值前置防误抓陷阱 ---
  {
    category: '差值前置防误抓',
    q: '请问最新股东人数及变化？',
    a: '您好，截至2026年11月10日，公司股东户数较上期减少2,500户，最新股东总户数为18,200户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 18200, endDate: '2026-11-10' },
  },
  {
    category: '差值前置防误抓',
    q: '请问最新股东户数？',
    a: '您好，截至2026年11月10日，公司股东人数比10月末下降3,200户至24,100户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 24100, endDate: '2026-11-10' },
  },

  // --- 类别9：A+H / A+B 跨市场股本防误抓 ---
  {
    category: 'A+H/B股精确甄别',
    q: '请问最新股东人数？',
    a: '投资者您好，截止2026年11月10日，H股股东512户，A股股东人数100,774户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 100774, endDate: '2026-11-10' },
  },
  {
    category: 'A+H/B股精确甄别',
    q: '请问最新股东户数？',
    a: '您好，截至2026年11月10日公司股东总户数101,286户，其中A股股东100,774户，H股股东512户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 100774, endDate: '2026-11-10' },
  },

  // --- 类别10：客户/用户/转债/员工持股/回购 强对抗防误报陷阱 ---
  {
    category: '对抗防误报护栏',
    q: '请问公司目前服务多少户政企客户？另外最新股东人数是多少？',
    a: '您好！公司目前已累计服务政企客户超50,000户。非定期报告时点的股东人数请查阅公司定期报告。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'declined', holderNum: null },
  },
  {
    category: '对抗防误报护栏',
    q: '请问公司覆盖多少居民用户？11月10日股东户数多少？',
    a: '您好，公司管道燃气覆盖居民用户580万户。股东户数请以定期报告披露为准。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'declined', holderNum: null },
  },
  {
    category: '对抗防误报护栏',
    q: '请问可转债持有人和普通股股东人数分别是多少？',
    a: '您好，公司可转债持有人共12,800户，普通股股东人数请在定期报告中查阅。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'declined', holderNum: null },
  },
  {
    category: '对抗防误报护栏',
    q: '请问截至11月10日公司股东人数是多少？',
    a: '您好，股东人数将于定期报告披露；公司第二期员工持股计划持有人共480人，控股股东近期增持500万股。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'declined', holderNum: null },
  },
  {
    category: '对抗防误报护栏',
    q: '你好，最近各大公司都在回购股份，贵司有何回报股东计划？',
    a: '投资者您好，公司持续维护股东利益，累计回购334.8万股并派发现金红利5,000万元。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'irrelevant', holderNum: null },
  },
  {
    category: '对抗防误报护栏',
    q: '公司股东户数1.52万户，较上期减少4.03%，股权结构趋于集中，机构持仓比例是多少？北向资金是否有持续增持？',
    a: '尊敬的投资者，您好！相关比例数据为非公开数据，感谢您的关注。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'irrelevant', holderNum: null },
  },

  // --- 类别11：季报旧数据敷衍回复精准隔离 ---
  {
    category: '旧季报复述隔离',
    q: '请问公司最新股东人数？',
    a: '尊敬的投资者，您好！为保证投资者平等获悉公司信息，公司在定期报告中披露对应时点的股东户数。根据公司披露的2026年第三季度报告，截至2026年9月末，公司股东总户数为703,418户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'stale_periodic', holderNum: 703418, endDate: '2026-09-30' },
  },
  {
    category: '旧季报复述隔离',
    q: '请问10月31日最新股东人数？',
    a: '尊敬的投资者您好，截至2026年9月30日，公司的股东人数为18,328。感谢您的关注与支持！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'stale_periodic', holderNum: 18328, endDate: '2026-09-30' },
  },

  // --- 类别12：标准拒答识别 ---
  {
    category: '标准拒答识别',
    q: '您好！请问截至10月底公司股东人数是多少？',
    a: '您好！股东可将持有公司股份的证明文件发送至公司邮箱（sushi@chinasti.com），待公司审核股东身份后会以邮件形式告知。谢谢！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'declined', holderNum: null },
  },

  // --- 类别13：地狱级“分别为”多日期并列一对一映射 ---
  {
    category: '分别为并列映射',
    q: '请问10月31日和11月10日股东人数分别是多少？',
    a: '您好！截至2026年10月31日、2026年11月10日，公司股东人数分别为28,500户、26,100户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 26100, endDate: '2026-11-10' },
  },
  {
    category: '分别为并列映射',
    q: '请问10月中旬、10月底、11月10日三期股东户数？',
    a: '尊敬的投资者您好，截至10月20日、10月31日及11月10日，公司股东总户数分别为31,200户、28,500户和25,900户，感谢关注！',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 25900, endDate: '2026-11-10' },
  },

  // --- 类别14：普通账户与融资融券信用账户分项拆解（必须选合并总数！）---
  {
    category: '普通与信用账户合并甄别',
    q: '请问最新合并股东人数是多少？',
    a: '您好，截至2026年11月10日，公司融资融券信用账户股东3,120户，合并普通账户和融资融券信用账户股东总户数为34,500户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 34500, endDate: '2026-11-10' },
  },
  {
    category: '普通与信用账户合并甄别',
    q: '请问11.10最新股东户数？',
    a: '您好，截至11.10公司股东户数为3.28万（含信用账户）。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 32800, endDate: '2026-11-10', isApproximate: true },
  },

  // --- 类别15：股东大会出席人数 / 户均持股前置 / 混合中文数字 等极限边界 ---
  {
    category: '极限语法与防误报边界',
    q: '请问出席临时股东大会的股东有多少人？最新股东总户数是多少？',
    a: '您好，出席本次股东大会现场及网络投票的股东及代理人共452人；非定期报告时点的公司股东总户数请查阅定期报告。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'declined', holderNum: null },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司户均持股和最新股东户数？',
    a: '您好，截至2026年11月10日，公司户均持股约1.85万股，股东总户数为23,450户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 23450, endDate: '2026-11-10' },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问11月10日股东人数？',
    a: '您好，截至2026年11月10日公司股东人数不足2万户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 20000, endDate: '2026-11-10', isApproximate: true },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问11月10日股东户数？',
    a: '您好，截至2026年11月10日，公司股东人数约4万2千户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 42000, endDate: '2026-11-10' },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问最新股东人数？ (全景网聚合标签)',
    a: '您好，截至2026年11月10日，公司股东总户数为19,876户。 (来自：上证e互动)',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 19876, endDate: '2026-11-10' },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司10月下旬股东人数？',
    a: '尊敬的投资者您好，截至2026年10月下旬公司股东户数为51,320户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 51320, endDate: '2026-10-31' },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司11月中旬股东人数？',
    a: '您好，截至2026年11月中旬公司股东人数为16,780户。',
    refTs: Date.parse('2026-11-23T12:00:00+08:00'),
    expect: { replyType: 'disclosed', holderNum: 16780, endDate: '2026-11-20' },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司股东人数？',
    a: '您好，截至2026/11/10收盘，公司登记在册股东人数14 820户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 14820, endDate: '2026-11-10' },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司股东人数？',
    a: '您好，截至2026.11.10，公司在册股东共十二万余户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 120000, endDate: '2026-11-10', isApproximate: true },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司有多少家子公司？股东人数是多少？',
    a: '您好，公司目前拥有全资及控股子公司共350家子公司；非定期报告股东人数不便单独提供，敬请谅解。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'declined', holderNum: null },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司门店数量及最新股东户数？',
    a: '您好，公司全国连锁门店达3,800家门店；截至2026年11月10日股东总户数为27,650户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 27650, endDate: '2026-11-10' },
  },
  {
    category: '极限语法与防误报边界',
    q: '请问公司B股股东和A股股东人数？',
    a: '您好，截至2026年11月10日，公司B股股东8,420户，A股股东62,310户。',
    refTs: REF_NOV_2026,
    expect: { replyType: 'disclosed', holderNum: 62310, endDate: '2026-11-10' },
  },

  // --- 类别16：董秘未来日期笔误自动纠偏（含 300555 ST路通 真实案例）---
  {
    category: '董秘未来笔误自动纠偏',
    q: '截止11.10股东人数，谢谢！',
    a: '尊敬的投资者，您好。截至2026年11月20日，公司的股东总数为5307人。感谢您的关注。',
    refTs: Date.parse('2026-11-11T09:52:19+08:00'),
    expect: {
      replyType: 'disclosed',
      holderNum: 5307,
      endDate: '2026-11-10',
      typoCorrectedFrom: '2026-11-20',
    },
  },
  {
    category: '董秘未来笔误自动纠偏',
    q: '请问最新股东人数是多少？',
    a: '您好，截至2027年11月10日，公司股东总户数为18,560户。',
    refTs: REF_NOV_2026,
    expect: {
      replyType: 'disclosed',
      holderNum: 18560,
      endDate: '2026-11-10',
      typoCorrectedFrom: '2027-11-10',
    },
  },
  {
    category: '董秘未来笔误自动纠偏',
    q: '请问公司最新股东户数？',
    a: '尊敬的投资者您好，截至2026年11月20日公司股东户数为32,100户。',
    refTs: Date.parse('2026-11-14T15:30:00+08:00'),
    expect: {
      replyType: 'disclosed',
      holderNum: 32100,
      endDate: '2026-11-10',
      typoCorrectedFrom: '2026-11-20',
    },
  },
];

/**
 * 运行内置黄金对抗基准集评测
 */
export function runGoldenBenchmark() {
  let passed = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const failures = [];
  const categoryStats = new Map();

  for (const tc of GOLDEN_BENCHMARK_CASES) {
    const res = parseInteractionQA({
      question: tc.q,
      answer: tc.a,
      refTimestampMs: tc.refTs,
    });

    const typeOk = res.replyType === tc.expect.replyType;
    const numOk = res.holderNum === tc.expect.holderNum;
    const dateOk = tc.expect.endDate === undefined || res.endDate === tc.expect.endDate;
    const approxOk =
      tc.expect.isApproximate === undefined || res.isApproximate === tc.expect.isApproximate;
    const typoOk =
      tc.expect.typoCorrectedFrom === undefined ||
      res.typoCorrectedFrom === tc.expect.typoCorrectedFrom;

    const ok = typeOk && numOk && dateOk && approxOk && typoOk;
    if (ok) passed++;
    else {
      failures.push({
        category: tc.category,
        question: tc.q,
        answer: tc.a,
        expected: tc.expect,
        actual: {
          replyType: res.replyType,
          holderNum: res.holderNum,
          endDate: res.endDate,
          isApproximate: res.isApproximate,
        },
      });
    }

    const expectedHasNum = tc.expect.holderNum != null;
    const actualHasNum = res.holderNum != null;
    if (expectedHasNum && actualHasNum && numOk && dateOk) truePositive++;
    else if (!expectedHasNum && actualHasNum) falsePositive++;
    else if (expectedHasNum && (!actualHasNum || !numOk || !dateOk)) falseNegative++;

    const cat = categoryStats.get(tc.category) || { total: 0, passed: 0 };
    cat.total++;
    if (ok) cat.passed++;
    categoryStats.set(tc.category, cat);
  }

  const total = GOLDEN_BENCHMARK_CASES.length;
  const precision =
    truePositive + falsePositive > 0
      ? (truePositive / (truePositive + falsePositive)) * 100
      : 100;
  const recall =
    truePositive + falseNegative > 0
      ? (truePositive / (truePositive + falseNegative)) * 100
      : 100;

  return {
    totalCases: total,
    passedCases: passed,
    accuracyPct: Number(((passed / total) * 100).toFixed(2)),
    precisionPct: Number(precision.toFixed(2)),
    recallPct: Number(recall.toFixed(2)),
    categories: [...categoryStats.entries()].map(([name, st]) => ({
      name,
      passed: st.passed,
      total: st.total,
    })),
    failures,
  };
}

/**
 * 实时跨源真值交叉核验器（将本引擎从互动问答原文独立提取的数值，与东方财富官方结构化数据库同报告期数值逐条比对！）
 */
export function auditCrossSourceConsistency(qaList = [], emTimelineByCode = new Map()) {
  let verifiedPairs = 0;
  let exactDigitMatchPairs = 0;
  let roundingConsistentPairs = 0;
  const discrepancies = [];
  const matchedSamples = [];

  const seenStockPeriod = new Set();

  for (const qa of qaList) {
    if (!qa.holderNum || !qa.endDate) continue;
    const timeline = emTimelineByCode.get(qa.stockCode) || [];
    const emMatch = timeline.find(
      (em) => em.source === 'eastmoney' && em.endDate && isSameReportPeriod(qa.endDate, em.endDate)
    );
    if (!emMatch || !emMatch.holderNum) continue;

    const dedupKey = `${qa.stockCode}_${emMatch.endDate}_${qa.holderNum}`;
    if (seenStockPeriod.has(dedupKey)) continue;
    seenStockPeriod.add(dedupKey);

    verifiedPairs++;
    const diffA = Math.abs(qa.holderNum - emMatch.holderNum);
    const diffTotal =
      emMatch.f10TotalHolderNum != null ? Math.abs(qa.holderNum - emMatch.f10TotalHolderNum) : diffA;
    const diff = Math.min(diffA, diffTotal);

    if (diff === 0) {
      exactDigitMatchPairs++;
      if (matchedSamples.length < 8) {
        matchedSamples.push({
          stockCode: qa.stockCode,
          stockName: qa.stockName,
          endDate: qa.endDate,
          qaNum: qa.holderNum,
          emNum: emMatch.holderNum,
          matchType: 'exact',
        });
      }
      continue;
    }

    // 检查是否属于董秘回复约数（如“约42万户” vs 东财录入精确数或约数）的合法误差带内
    const minP = qa.minPossible ?? qa.holderNum;
    const maxP = qa.maxPossible ?? qa.holderNum;
    if (qa.isApproximate && emMatch.holderNum >= minP && emMatch.holderNum <= maxP) {
      roundingConsistentPairs++;
      continue;
    }

    discrepancies.push({
      stockCode: qa.stockCode,
      stockName: qa.stockName,
      endDate: qa.endDate,
      qaHolderNum: qa.holderNum,
      emHolderNum: emMatch.holderNum,
      answerSnippet: String(qa.answer || '').slice(0, 100),
    });
  }

  const consistentTotal = exactDigitMatchPairs + roundingConsistentPairs;
  const consistencyRatePct =
    verifiedPairs > 0 ? Number(((consistentTotal / verifiedPairs) * 100).toFixed(2)) : 100;

  return {
    verifiedPairs,
    exactDigitMatchPairs,
    roundingConsistentPairs,
    discrepancyCount: discrepancies.length,
    consistencyRatePct,
    discrepancies,
    matchedSamples,
  };
}
