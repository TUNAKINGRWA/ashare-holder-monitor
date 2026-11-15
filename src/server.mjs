import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HolderMonitor } from './monitor.mjs';
import { PublicTunnelManager, detectLanIpv4 } from './tunnel.mjs';
import { renderQrSvg } from './qrcode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const monitor = new HolderMonitor({ dataDir: DATA_DIR });
const sseClients = new Set();
let tunnelManager = null;
let boundPort = 3688;

function getMobileAccessPayload() {
  const base = tunnelManager
    ? tunnelManager.getState()
    : {
        status: 'stopped',
        publicUrl: null,
        provider: null,
        lanIp: detectLanIpv4(),
        lanUrl: detectLanIpv4() ? `http://${detectLanIpv4()}:${boundPort}` : null,
        localUrl: `http://127.0.0.1:${boundPort}`,
        lastError: null,
        updatedAt: null,
      };

  return {
    ...base,
    port: boundPort,
    publicQrSvg: base.publicUrl ? renderQrSvg(base.publicUrl) : null,
    lanQrSvg: base.lanUrl ? renderQrSvg(base.lanUrl) : null,
  };
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

monitor.on('status', (status) => broadcastSSE('status', status));
monitor.on('watchlist', (watchlist) => broadcastSSE('watchlist', watchlist));
monitor.on('snapshot', ({ snapshot, newAlerts }) => {
  broadcastSSE('snapshot', { snapshot, newAlerts });
});

// 每15秒发送心跳防止连接空闲断开
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 15000).unref();

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // --- SSE 实时推送流 ---
    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: status\ndata: ${JSON.stringify(monitor.getStatusPayload())}\n\n`);
      res.write(`event: mobile_access\ndata: ${JSON.stringify(getMobileAccessPayload())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // --- 手机扫码访问地址与二维码（公网 HTTPS + 局域网 Wi-Fi）---
    if (req.method === 'GET' && pathname === '/api/mobile-access') {
      return sendJson(res, 200, getMobileAccessPayload());
    }

    if (req.method === 'POST' && pathname === '/api/mobile-access/reconnect') {
      if (tunnelManager) tunnelManager.reconnect();
      return sendJson(res, 200, { ok: true, mobileAccess: getMobileAccessPayload() });
    }

    // --- 全量快照 ---
    if (req.method === 'GET' && pathname === '/api/snapshot') {
      return sendJson(res, 200, monitor.getSnapshot());
    }

    // --- 实时准确度自检与跨源真值核验报告 ---
    if (req.method === 'GET' && pathname === '/api/accuracy') {
      return sendJson(res, 200, monitor.getAccuracyReport());
    }

    // --- 立即手动刷新 ---
    if (req.method === 'POST' && pathname === '/api/poll') {
      const out = await monitor.poll({ isWarmup: false });
      monitor.scheduleNextPoll();
      return sendJson(res, 200, {
        ok: true,
        newAlertsCount: out?.newAlerts?.length || 0,
        status: monitor.getStatusPayload(),
      });
    }

    // --- 更新轮询配置 ---
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const status = monitor.updateSettings(body);
      return sendJson(res, 200, { ok: true, status });
    }

    // --- 自选关注切换 ---
    if (req.method === 'POST' && pathname === '/api/watchlist/toggle') {
      const body = await readJsonBody(req);
      const result = await monitor.toggleWatchlist(body.code, body.name);
      return sendJson(res, 200, { ok: true, ...result });
    }

    // --- 个股历史趋势与互动详情 ---
    if (req.method === 'GET' && pathname.startsWith('/api/stock/')) {
      const code = pathname.replace('/api/stock/', '').trim();
      const detail = await monitor.getStockDetail(code);
      return sendJson(res, 200, detail);
    }

    // --- 全市场远程搜索 ---
    if (req.method === 'GET' && pathname === '/api/search') {
      const q = urlObj.searchParams.get('q') || '';
      const list = await monitor.searchStocks(q);
      return sendJson(res, 200, { results: list });
    }

    // --- 模拟实时推送测试（验证声音 + 桌面弹窗 + 列表动画，不污染持久化库）---
    if (req.method === 'POST' && pathname === '/api/simulate-alert') {
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
      const mockAlert = {
        ...sample,
        id: `sim_${Date.now()}`,
        stockName: `${sample.stockName}`,
        isSimulated: true,
        syncStatus: 'ahead',
        holderChangeRatio: sample.holderChangeRatio ?? -6.48,
      };
      broadcastSSE('simulate_alert', mockAlert);
      return sendJson(res, 200, { ok: true, alert: mockAlert });
    }

    // --- 静态前端资源服务 ---
    let relPath = pathname === '/' ? '/index.html' : pathname;
    relPath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(PUBLIC_DIR, relPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    try {
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

async function startServer(preferredPort = Number(process.env.PORT) || 3688) {
  await monitor.init();

  let port = preferredPort;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '0.0.0.0');
      });

      boundPort = port;
      const lanIp = detectLanIpv4();

      console.log(`\n========================================================`);
      console.log(`  🚀 A股实时股东人数监测台已启动（全设备实时同步）`);
      console.log(`  💻 本机电脑访问: http://127.0.0.1:${port}`);
      if (lanIp) {
        console.log(`  📶 手机同Wi-Fi访问: http://${lanIp}:${port}`);
      }
      console.log(`  ⏳ 正在建立免注册外网 HTTPS 穿透通道（供手机 5G 随时随地访问）...`);
      console.log(`========================================================\n`);

      if (process.env.DISABLE_TUNNEL !== '1') {
        tunnelManager = new PublicTunnelManager({ localPort: port });
        tunnelManager.on('update', () => {
          broadcastSSE('mobile_access', getMobileAccessPayload());
        });
        tunnelManager.start();
      }
      return;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        port += 1;
      } else {
        throw err;
      }
    }
  }
  throw new Error('无法绑定本地端口');
}

function shutdown() {
  if (tunnelManager) tunnelManager.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
