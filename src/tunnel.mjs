import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';

function stripAnsi(str = '') {
  return String(str).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/**
 * 自动探测本机局域网真实 Wi-Fi / 以太网 IPv4 地址（排除 198.18.* 虚拟网卡与 169.254.* 链路本地地址）
 */
export function detectLanIpv4() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(nets)) {
    if (!Array.isArray(addrs)) continue;
    // 跳过常见代理/VPN虚拟隧道网卡
    if (/^(?:utun|tun|tap|ppp|gif|stf|lo|llw|awdl|bridge)/i.test(name)) continue;

    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      if (ip.startsWith('198.18.') || ip.startsWith('198.19.') || ip.startsWith('169.254.')) continue;
      const priority =
        name === 'en0'
          ? 100
          : name.startsWith('en')
            ? 90
            : ip.startsWith('192.168.') || ip.startsWith('10.')
              ? 80
              : 50;
      candidates.push({ ip, priority });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates[0]?.ip || null;
}

/**
 * 免注册公网 HTTPS 穿透守护器（支持 localhost.run SSH 隧道与 Pinggy 443 端口自动容灾重连）
 */
export class PublicTunnelManager extends EventEmitter {
  constructor({ localPort }) {
    super();
    this.localPort = localPort;
    this.proc = null;
    this.status = 'connecting'; // 'connecting' | 'online' | 'reconnecting' | 'error' | 'stopped'
    this.publicUrl = null;
    this.provider = null;
    this.lastError = null;
    this.updatedAt = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.providerIndex = 0;
  }

  getState() {
    const lanIp = detectLanIpv4();
    return {
      status: this.status,
      publicUrl: this.publicUrl,
      provider: this.provider,
      lanIp,
      lanUrl: lanIp ? `http://${lanIp}:${this.localPort}` : null,
      localUrl: `http://127.0.0.1:${this.localPort}`,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  start() {
    this.stopped = false;
    this._launchTunnel();
  }

  reconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.proc = null;
    }
    this.publicUrl = null;
    this.status = 'connecting';
    this.emit('update', this.getState());
    this._launchTunnel();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.proc = null;
    }
    this.status = 'stopped';
  }

  _extractPublicUrl(rawBuffer) {
    const clean = stripAnsi(rawBuffer);

    // 1. localhost.run 标准 TLS 隧道行："<host> tunneled with tls termination, https://<host>"
    const lhrExplicit = clean.match(/tunneled with tls termination,\s*(https:\/\/[^\s\]\r\n]+)/i);
    if (lhrExplicit) return lhrExplicit[1].trim();

    // 2. 通用已验证穿透域名匹配（排除 admin.localhost.run 等管理官网链接）
    const allUrls = clean.match(/https:\/\/[a-zA-Z0-9.-]+/g) || [];
    for (const u of allUrls) {
      if (
        /admin\.localhost\.run|localhost\.run$|docs\.|twitter\.com|github\.com|pinggy\.io$/i.test(u)
      ) {
        continue;
      }
      if (/\.(?:lhr\.[a-z]+|localhost\.run|pinggy\.link|pinggy-free\.link|trycloudflare\.com)$/i.test(u)) {
        return u;
      }
    }
    return null;
  }

  _launchTunnel() {
    if (this.stopped) return;

    const providers = [
      {
        name: 'localhost.run (SSH HTTPS)',
        cmd: '/usr/bin/ssh',
        args: [
          '-T',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ServerAliveInterval=25',
          '-o', 'ServerAliveCountMax=3',
          '-o', 'ConnectTimeout=10',
          '-o', 'ExitOnForwardFailure=yes',
          '-R', `80:127.0.0.1:${this.localPort}`,
          'nokey@localhost.run',
        ],
      },
      {
        name: 'Pinggy (443 HTTPS)',
        cmd: '/usr/bin/ssh',
        args: [
          '-T',
          '-p', '443',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ServerAliveInterval=25',
          '-o', 'ConnectTimeout=10',
          '-o', 'ExitOnForwardFailure=yes',
          `-R0:127.0.0.1:${this.localPort}`,
          'nokey@a.pinggy.io',
        ],
      },
    ];

    const chosen = providers[this.providerIndex % providers.length];
    this.status = this.publicUrl ? 'reconnecting' : 'connecting';
    this.emit('update', this.getState());

    let outputBuf = '';
    let resolvedUrl = false;

    const child = spawn(chosen.cmd, chosen.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;

    const startupTimeout = setTimeout(() => {
      if (!resolvedUrl && this.proc === child) {
        this.providerIndex++;
        this.lastError = `${chosen.name} 握手超时，正在切换备用通道`;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, 15000);

    const handleChunk = (chunk) => {
      outputBuf += chunk.toString('utf8');
      if (outputBuf.length > 16384) {
        outputBuf = outputBuf.slice(-10000);
      }
      const url = this._extractPublicUrl(outputBuf);
      if (url && url !== this.publicUrl) {
        resolvedUrl = true;
        clearTimeout(startupTimeout);
        this.publicUrl = url;
        this.provider = chosen.name;
        this.status = 'online';
        this.lastError = null;
        this.updatedAt = Date.now();
        console.log(`  🌐 手机外网 5G 实时访问地址: ${url}`);
        this.emit('update', this.getState());
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (err) => {
      clearTimeout(startupTimeout);
      this.lastError = err.message;
    });

    child.on('close', () => {
      clearTimeout(startupTimeout);
      if (this.stopped) return;
      if (this.proc === child) this.proc = null;

      if (!resolvedUrl) {
        this.providerIndex++;
      }
      this.status = 'reconnecting';
      this.emit('update', this.getState());

      this.reconnectTimer = setTimeout(() => {
        this._launchTunnel();
      }, resolvedUrl ? 2500 : 1500);
    });
  }
}
