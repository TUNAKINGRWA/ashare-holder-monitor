import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HolderMonitor } from '../src/monitor.mjs';
import { renderQrSvg } from '../src/qrcode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_STORE = path.resolve(__dirname, '../data/seed-store.json');

// 模块级单例：在 Vercel 温热实例间复用内存与 /tmp 缓存
const monitor = new HolderMonitor({
  dataDir: '/tmp/holder-monitor-data',
  seedStorePath: SEED_STORE,
  serverlessMode: true,
});

function sendJson(res, statusCode, obj) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export default async function handler(req, res) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const urlObj = new URL(req.url || '/', `${proto}://${host}`);
    const pathname = urlObj.pathname;
    const watchParam = (urlObj.searchParams.get('watch') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      await monitor.ensureFreshData({ maxAgeMs: 28000, watchCodes: watchParam });
      return sendJson(res, 200, monitor.getSnapshot());
    }

    if (req.method === 'POST' && pathname === '/api/poll') {
      await monitor.init();
      const out = await monitor.poll({ isWarmup: false });
      return sendJson(res, 200, {
        ok: true,
        newAlertsCount: out?.newAlerts?.length || 0,
        snapshot: monitor.getSnapshot(),
        status: monitor.getStatusPayload(),
      });
    }

    if (req.method === 'GET' && pathname === '/api/accuracy') {
      await monitor.ensureFreshData({ maxAgeMs: 60000 });
      return sendJson(res, 200, monitor.getAccuracyReport());
    }

    if (req.method === 'GET' && pathname === '/api/mobile-access') {
      const originUrl = `${proto}://${host}`;
      return sendJson(res, 200, {
        status: 'online',
        runtimeMode: 'vercel',
        publicUrl: originUrl,
        provider: 'Vercel Global HTTPS CDN',
        lanUrl: originUrl,
        localUrl: originUrl,
        publicQrSvg: renderQrSvg(originUrl),
        lanQrSvg: renderQrSvg(originUrl),
      });
    }

    if (req.method === 'POST' && pathname === '/api/settings') {
      await monitor.init();
      const body = await readBody(req);
      const status = monitor.updateSettings(body);
      return sendJson(res, 200, { ok: true, status });
    }

    if (req.method === 'POST' && pathname === '/api/watchlist/toggle') {
      await monitor.init();
      const body = await readBody(req);
      const result = await monitor.toggleWatchlist(body.code, body.name);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/stock/')) {
      await monitor.init();
      const code = pathname.replace('/api/stock/', '').trim();
      const detail = await monitor.getStockDetail(code);
      return sendJson(res, 200, detail);
    }

    if (req.method === 'GET' && pathname === '/api/search') {
      await monitor.init();
      const q = urlObj.searchParams.get('q') || '';
      const list = await monitor.searchStocks(q);
      return sendJson(res, 200, { results: list });
    }

    if (req.method === 'POST' && pathname === '/api/simulate-alert') {
      await monitor.ensureFreshData({ maxAgeMs: 60000 });
      const snapshot = monitor.getSnapshot();
      const sample =
        snapshot.fusedStream.find((x) => x.holderChangeRatio != null && x.holderChangeRatio < -3) ||
        snapshot.fusedStream[0] || {
          stockCode: '000021',
          stockName: '深科技',
          holderNum: 414890,
          holderChangeRatio: -6.48,
          endDate: '2026-11-10',
          sourceLabel: '深交所互动易',
        };
      return sendJson(res, 200, {
        ok: true,
        alert: {
          ...sample,
          id: `sim_${Date.now()}`,
          isSimulated: true,
          syncStatus: 'ahead',
        },
      });
    }

    return sendJson(res, 404, { error: 'API route not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Serverless internal error' });
  }
}
