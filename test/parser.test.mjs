import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInteractionQA,
  parseSseFeedsHtml,
  isSameReportPeriod,
  extractCutoffDate,
  inferMarketInfo,
} from '../src/parser.mjs';
import { HolderMonitor } from '../src/monitor.mjs';
import { runGoldenBenchmark, auditCrossSourceConsistency } from '../src/accuracy.mjs';
import { renderQrSvg, encodeQrMatrix } from '../src/qrcode.mjs';
import { detectLanIpv4 } from '../src/tunnel.mjs';

const REF_TS = Date.parse('2026-11-15T12:00:00+08:00');

test('passes 100% of the 53-case Golden Adversarial Benchmark suite (100% precision & 100% recall)', () => {
  const report = runGoldenBenchmark();
  assert.equal(report.totalCases, 53);
  assert.equal(report.failures.length, 0, `Benchmark failures: ${JSON.stringify(report.failures)}`);
  assert.equal(report.accuracyPct, 100);
  assert.equal(report.precisionPct, 100);
  assert.equal(report.recallPct, 100);
});

test('parses SSE e-hudong HTML feed items accurately', () => {
  const sampleHtml = `
    <div class="m_feed_item" id="item-1800999">
      <div class="m_feed_detail m_qa_detail">
        <div class="m_feed_cnt">
          <div class="m_feed_txt" id="m_feed_txt-1800999">
            <a href='user.do?uid=391'>:贵州茅台(600519)</a>请问董秘，截至11月10日公司股东户数是多少？
          </div>
          <div class="m_feed_func">
            <div class="m_feed_from"><span>2026年11月12日 09:45</span></div>
          </div>
        </div>
      </div>
      <div class="m_feed_detail m_qa">
        <div class="m_feed_face">
          <a class="ansface" title="贵州茅台"><img src="https://sns.sseinfo.com/resources/images/avatar/company/600519.png"></a>
        </div>
        <div class="m_feed_cnt">
          <div class="m_feed_txt">尊敬的投资者您好，截至2026年11月10日，公司股东总户数为168,420户，感谢关注。</div>
        </div>
        <div class="m_feed_func top10">
          <div class="m_feed_from"><span>2026年11月13日 18:27</span></div>
        </div>
      </div>
    </div>
  `;
  const list = parseSseFeedsHtml(sampleHtml, REF_TS);
  assert.equal(list.length, 1);
  assert.equal(list[0].stockCode, '600519');
  const parsed = parseInteractionQA({
    question: list[0].question,
    answer: list[0].answer,
    refTimestampMs: list[0].answerTimeMs,
  });
  assert.equal(parsed.holderNum, 168420);
  assert.equal(parsed.endDate, '2026-11-10');
});

test('chains multi-period intra-QA disclosures and flags rounding noise bounds', () => {
  const monitor = new HolderMonitor({ dataDir: '/tmp/holder_test_v2' });
  // 东财仅收录到 2026-09-30 (85,000户)
  monitor.upsertEmRowIntoTimeline({
    id: 'em_301171_2026-09-30',
    stockCode: '301171',
    stockName: '易点天下',
    endDate: '2026-09-30',
    holderNum: 85000,
    prevHolderNum: 80000,
    totalMarketCap: 20000000000,
    closePrice: 30,
  });

  // 互动易同日披露了 10-30 (97,250户) 和 11-10 (114,103户) 两期
  monitor.qaMap.set('szse_oct', {
    id: 'szse_oct',
    source: 'szse_irm',
    stockCode: '301171',
    replyType: 'disclosed',
    holderNum: 97250,
    endDate: '2026-10-30',
    allPeriods: [{ endDate: '2026-10-30', holderNum: 97250 }],
  });
  const novQa = {
    id: 'szse_nov',
    source: 'szse_irm',
    stockCode: '301171',
    replyType: 'disclosed',
    holderNum: 114103,
    endDate: '2026-11-10',
    allPeriods: [{ endDate: '2026-11-10', holderNum: 114103 }],
  };
  monitor.qaMap.set('szse_nov', novQa);

  // 11-10 必须自动衔接 10-30 (97,250) 计算增减，而不是跳回东财的 9-30 (85,000)！
  const enrichedNov = monitor.enrichQAItemWithBaseline(novQa);
  assert.equal(enrichedNov.syncStatus, 'ahead');
  assert.equal(enrichedNov.prevEndDate, '2026-10-30');
  assert.equal(enrichedNov.prevHolderNum, 97250);
  assert.equal(enrichedNov.holderChange, 114103 - 97250);

  // 约数四舍五入误差带检测：上期精确 423,100 户，本期披露“约42万户”（区间[415000, 425000]）
  monitor.upsertEmRowIntoTimeline({
    id: 'em_000938_2026-10-30',
    stockCode: '000938',
    stockName: '紫光股份',
    endDate: '2026-10-30',
    holderNum: 423100,
    prevHolderNum: 430000,
  });
  const approxParsed = parseInteractionQA({
    question: '请问11月10日股东户数？',
    answer: '您好，截至2026年11月10日公司股东总户数约为42万户。',
    refTimestampMs: REF_TS,
  });
  const enrichedApprox = monitor.enrichQAItemWithBaseline({
    id: 'szse_approx',
    source: 'szse_irm',
    stockCode: '000938',
    ...approxParsed,
  });
  assert.equal(enrichedApprox.roundingNoiseWarning, true);
});

test('aligns period buckets and cross-source ground-truth verification', () => {
  assert.equal(isSameReportPeriod('2026-10-30', '2026-10-31'), true);
  assert.equal(isSameReportPeriod('2026-11-10', '2026-10-31'), false);
  const janTs = Date.parse('2027-01-08T10:00:00+08:00');
  assert.equal(extractCutoffDate('截至12月31日股东户数为20000户', '', janTs), '2026-12-31');
  assert.equal(inferMarketInfo('688001').quoteSecId, '1.688001');

  const emMap = new Map([
    ['000021', [{ source: 'eastmoney', endDate: '2026-11-10', holderNum: 414890 }]],
  ]);
  const audit = auditCrossSourceConsistency(
    [{ stockCode: '000021', stockName: '深科技', endDate: '2026-11-10', holderNum: 414890 }],
    emMap
  );
  assert.equal(audit.consistencyRatePct, 100);
  assert.equal(audit.exactDigitMatchPairs, 1);
});

test('generates valid QR code SVG matrices for LAN and public HTTPS tunnel URLs', () => {
  const svg = renderQrSvg('https://demo-tunnel.lhr.life');
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  const matrix = encodeQrMatrix('https://demo-tunnel.lhr.life');
  assert.equal(matrix.length, 25); // Version 2 (25x25) for 28-byte URL
  // Top-left finder corners must be dark
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[0][6], 1);
  assert.equal(matrix[6][0], 1);
  assert.equal(matrix[3][3], 1);
  const lanIp = detectLanIpv4();
  if (lanIp) {
    assert.match(lanIp, /^\d+\.\d+\.\d+\.\d+$/);
  }
});
