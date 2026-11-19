import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import type {
  InstanceProxyState,
  InstanceProxyVerifyResult,
  InstanceRecord,
  ProxyConfig,
  ProxyRelayStats,
  ProxyTestResult,
} from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { AdbExecutor } from './adb.service.js';

interface RelayEntry {
  instanceId: string;
  port: number;
  host: string;
  config: ProxyConfig;
  server: http.Server;
  sockets: Set<net.Socket>;
  stats: ProxyRelayStats;
}

class SocketReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private err: Error | null = null;
  private waiter: (() => void) | null = null;

  private readonly onData = (chunk: Buffer) => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.notify();
  };

  private readonly onEnd = () => {
    this.ended = true;
    this.notify();
  };

  private readonly onError = (e: Error) => {
    this.err = e;
    this.notify();
  };

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('error', this.onError);
  }

  private notify(): void {
    if (this.waiter) {
      const fn = this.waiter;
      this.waiter = null;
      fn();
    }
  }

  private waitForMore(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.err) {
        reject(this.err);
        return;
      }
      if (this.ended) {
        reject(new Error('Upstream socket closed unexpectedly during handshake'));
        return;
      }
      const timer = setTimeout(() => {
        if (this.waiter) this.waiter = null;
        reject(new Error('Proxy handshake timed out'));
      }, timeoutMs);

      this.waiter = () => {
        clearTimeout(timer);
        if (this.err) reject(this.err);
        else resolve();
      };
    });
  }

  async readExact(len: number, timeoutMs: number): Promise<Buffer> {
    while (this.buf.length < len) {
      await this.waitForMore(timeoutMs);
    }
    const out = this.buf.subarray(0, len);
    this.buf = this.buf.subarray(len);
    return out;
  }

  async readUntilHeaderEnd(timeoutMs: number, maxBytes = 16384): Promise<{ headerText: string; rest: Buffer }> {
    while (true) {
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        const headerText = this.buf.subarray(0, idx).toString('utf8');
        const rest = this.buf.subarray(idx + 4);
        this.buf = Buffer.alloc(0);
        return { headerText, rest };
      }
      if (this.buf.length > maxBytes) {
        throw new Error('Upstream HTTP CONNECT response headers exceeded 16KB');
      }
      await this.waitForMore(timeoutMs);
    }
  }

  detach(): Buffer {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('error', this.onError);
    const remaining = this.buf;
    this.buf = Buffer.alloc(0);
    return remaining;
  }
}

const SOCKS5_ERRORS: Record<number, string> = {
  1: 'General SOCKS server failure',
  2: 'Connection not allowed by ruleset',
  3: 'Network unreachable',
  4: 'Host unreachable',
  5: 'Connection refused by destination',
  6: 'TTL expired',
  7: 'Command not supported',
  8: 'Address type not supported',
};

function parseHostPortTarget(authority: string, defaultPort = 443): { host: string; port: number } {
  const trimmed = authority.trim();
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) throw new Error(`Invalid target host: ${authority}`);
    const host = trimmed.slice(1, closeIdx);
    const portStr = trimmed.slice(closeIdx + 1);
    const port = portStr.startsWith(':') ? Number(portStr.slice(1)) : defaultPort;
    return { host, port };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return { host: trimmed, port: defaultPort };
  const host = trimmed.slice(0, idx);
  const port = Number(trimmed.slice(idx + 1));
  return { host, port: Number.isInteger(port) && port > 0 ? port : defaultPort };
}

function isHostBypassed(host: string, bypassCsv: string): boolean {
  const normalized = host.trim().toLowerCase();
  const patterns = bypassCsv
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  for (const pat of patterns) {
    if (pat === '*') return true;
    if (pat === normalized) return true;
    if (pat.startsWith('*.') && normalized.endsWith(pat.slice(1))) return true;
    if (pat.startsWith('.') && normalized.endsWith(pat)) return true;
  }
  return false;
}

function buildBasicProxyAuth(config: ProxyConfig): string | undefined {
  if (!config.username && !config.password) return undefined;
  const raw = `${config.username ?? ''}:${config.password ?? ''}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

function encodeSocks5Address(host: string): Buffer {
  if (net.isIPv4(host)) {
    const parts = host.split('.').map((n) => Number(n));
    return Buffer.from([0x01, parts[0], parts[1], parts[2], parts[3]]);
  }
  const hostBuf = Buffer.from(host, 'utf8');
  if (hostBuf.length > 255) {
    throw new Error(`Target host too long for SOCKS5: ${host}`);
  }
  return Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
}

function connectRawTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connection to ${host}:${port} timed out`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectTlsSocket(host: string, port: number, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS connection to ${host}:${port} timed out`));
    }, timeoutMs);

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function dialSocks5(
  config: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const socket = await connectRawTcp(config.host, config.port, timeoutMs);
  const reader = new SocketReader(socket);

  try {
    const hasAuth = Boolean(config.username !== undefined && config.username !== '');
    const greeting = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    socket.write(greeting);

    const methodReply = await reader.readExact(2, timeoutMs);
    if (methodReply[0] !== 0x05) {
      throw new Error(`Invalid SOCKS version from upstream: ${methodReply[0]}`);
    }
    if (methodReply[1] === 0xff) {
      throw new Error('SOCKS5 upstream rejected auth methods (authentication required or unsupported)');
    }

    if (methodReply[1] === 0x02) {
      const uBuf = Buffer.from(config.username ?? '', 'utf8');
      const pBuf = Buffer.from(config.password ?? '', 'utf8');
      if (uBuf.length > 255 || pBuf.length > 255) {
        throw new Error('SOCKS5 username/password exceeds 255 bytes');
      }
      const authReq = Buffer.concat([
        Buffer.from([0x01, uBuf.length]),
        uBuf,
        Buffer.from([pBuf.length]),
        pBuf,
      ]);
      socket.write(authReq);

      const authReply = await reader.readExact(2, timeoutMs);
      if (authReply[1] !== 0x00) {
        throw new Error(`SOCKS5 username/password authentication failed (status ${authReply[1]})`);
      }
    } else if (methodReply[1] !== 0x00) {
      throw new Error(`Unsupported SOCKS5 auth method selected: ${methodReply[1]}`);
    }

    const addrBuf = encodeSocks5Address(targetHost);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    const connectReq = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrBuf, portBuf]);
    socket.write(connectReq);

    const head = await reader.readExact(4, timeoutMs);
    if (head[0] !== 0x05) {
      throw new Error(`Invalid SOCKS5 reply version: ${head[0]}`);
    }
    if (head[1] !== 0x00) {
      throw new Error(SOCKS5_ERRORS[head[1]] ?? `SOCKS5 CONNECT failed with code ${head[1]}`);
    }

    const atyp = head[3];
    if (atyp === 0x01) {
      await reader.readExact(6, timeoutMs);
    } else if (atyp === 0x04) {
      await reader.readExact(18, timeoutMs);
    } else if (atyp === 0x03) {
      const lenBuf = await reader.readExact(1, timeoutMs);
      await reader.readExact(lenBuf[0] + 2, timeoutMs);
    } else {
      throw new Error(`Unknown SOCKS5 address type in reply: ${atyp}`);
    }

    const leftover = reader.detach();
    if (leftover.length > 0) {
      socket.unshift(leftover);
    }
    return socket;
  } catch (err) {
    reader.detach();
    socket.destroy();
    throw err;
  }
}

async function dialHttpConnect(
  config: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const socket: net.Socket =
    config.protocol === 'https'
      ? await connectTlsSocket(config.host, config.port, timeoutMs)
      : await connectRawTcp(config.host, config.port, timeoutMs);
  const reader = new SocketReader(socket);

  try {
    const authHeader = buildBasicProxyAuth(config);
    const lines = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      ...(authHeader ? [`Proxy-Authorization: ${authHeader}`] : []),
      'Connection: keep-alive',
      '',
      '',
    ];
    socket.write(lines.join('\r\n'));

    const { headerText, rest } = await reader.readUntilHeaderEnd(timeoutMs);
    const statusLine = headerText.split(/\r?\n/)[0] ?? '';
    const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
    const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
    if (statusCode !== 200) {
      if (statusCode === 407) {
        throw new Error('Upstream HTTP proxy rejected credentials (407 Proxy Authentication Required)');
      }
      throw new Error(`Upstream HTTP CONNECT failed: ${statusLine || 'empty response'}`);
    }

    const leftover = reader.detach();
    const combined =
      rest.length > 0 && leftover.length > 0
        ? Buffer.concat([rest, leftover])
        : rest.length > 0
          ? rest
          : leftover;
    if (combined.length > 0) {
      socket.unshift(combined);
    }
    return socket;
  } catch (err) {
    reader.detach();
    socket.destroy();
    throw err;
  }
}

export async function dialUpstreamTunnel(
  config: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs = 12000,
): Promise<net.Socket> {
  if (config.protocol === 'socks5') {
    return dialSocks5(config, targetHost, targetPort, timeoutMs);
  }
  return dialHttpConnect(config, targetHost, targetPort, timeoutMs);
}

function parseRawHttpResponse(raw: string): { statusCode: number; body: string } {
  const idx = raw.indexOf('\r\n\r\n');
  const sepLen = idx !== -1 ? 4 : raw.indexOf('\n\n') !== -1 ? 2 : 0;
  const splitAt = idx !== -1 ? idx : raw.indexOf('\n\n');
  if (splitAt === -1) {
    return { statusCode: 0, body: raw };
  }
  const head = raw.slice(0, splitAt);
  const body = raw.slice(splitAt + sepLen);
  const statusMatch = head.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
  return {
    statusCode: statusMatch ? Number(statusMatch[1]) : 0,
    body,
  };
}

function httpRequestOverSocket(
  socket: net.Socket,
  host: string,
  reqPath: string,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('HTTP probe timed out waiting for response'));
    }, timeoutMs);

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('end', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(parseRawHttpResponse(raw));
    });

    socket.write(
      [
        `GET ${reqPath} HTTP/1.0`,
        `Host: ${host}`,
        'Accept: application/json',
        'Accept-Encoding: identity',
        'User-Agent: DroidForge/1.0',
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
  });
}

function httpGetViaHttpProxy(
  config: ProxyConfig,
  targetUrl: string,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const authHeader = buildBasicProxyAuth(config);
    const mod = config.protocol === 'https' ? https : http;
    const req = mod.request(
      {
        host: config.host,
        port: config.port,
        method: 'GET',
        path: targetUrl,
        ...(config.protocol === 'https' ? { rejectUnauthorized: false, servername: config.host } : {}),
        headers: {
          Host: parsed.host,
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'DroidForge/1.0',
          Connection: 'close',
          ...(authHeader ? { 'Proxy-Authorization': authHeader } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Proxy HTTP request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseGeoResponse(body: string): Partial<ProxyTestResult> {
  const json = JSON.parse(body.trim()) as Record<string, unknown>;
  if (json.status === 'fail') {
    throw new Error(String(json.message || 'Geo lookup failed'));
  }
  const ip = (json.query ?? json.ip) as string | undefined;
  const conn = (json.connection && typeof json.connection === 'object'
    ? (json.connection as Record<string, unknown>)
    : undefined);
  const tzObj = (json.timezone && typeof json.timezone === 'object'
    ? (json.timezone as Record<string, unknown>)
    : undefined);
  return {
    exitIp: ip ?? null,
    country: (json.country as string | undefined) ?? null,
    countryCode: ((json.countryCode ?? json.country_code) as string | undefined) ?? null,
    region: ((json.regionName ?? json.region) as string | undefined) ?? null,
    city: (json.city as string | undefined) ?? null,
    isp: ((json.isp ?? conn?.isp ?? conn?.org) as string | undefined) ?? null,
    timezone:
      (typeof json.timezone === 'string'
        ? json.timezone
        : (tzObj?.id as string | undefined)) ?? null,
  };
}

export class ProxyRelayService {
  private readonly relays = new Map<string, RelayEntry>();

  constructor(private readonly env: AppEnv) {}

  detectRelayHost(): string {
    if (this.env.PROXY_RELAY_HOST) {
      return this.env.PROXY_RELAY_HOST;
    }
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      if (!addrs) continue;
      for (const info of addrs) {
        if (info.family === 'IPv4' && !info.internal) {
          return info.address;
        }
      }
    }
    return '127.0.0.1';
  }

  getRelayInfo(instanceId: string): {
    relayActive: boolean;
    relayEndpoint: string | null;
    stats: ProxyRelayStats;
  } {
    const entry = this.relays.get(instanceId);
    if (!entry) {
      return {
        relayActive: false,
        relayEndpoint: null,
        stats: { activeConnections: 0, totalRequests: 0, bytesIn: 0, bytesOut: 0, lastError: null },
      };
    }
    return {
      relayActive: true,
      relayEndpoint: `${entry.host}:${entry.port}`,
      stats: { ...entry.stats },
    };
  }

  async ensureRelay(instanceId: string, config: ProxyConfig): Promise<{ host: string; port: number }> {
    const existing = this.relays.get(instanceId);
    if (existing) {
      existing.config = config;
      return { host: existing.host, port: existing.port };
    }

    const host = this.detectRelayHost();
    const minPort = this.env.PROXY_RELAY_PORT_MIN;
    const maxPort = this.env.PROXY_RELAY_PORT_MAX;
    const usedPorts = new Set([...this.relays.values()].map((r) => r.port));

    let boundServer: http.Server | null = null;
    let boundPort = 0;

    const sockets = new Set<net.Socket>();
    const stats: ProxyRelayStats = {
      activeConnections: 0,
      totalRequests: 0,
      bytesIn: 0,
      bytesOut: 0,
      lastError: null,
    };

    const entryPlaceholder: { entry: RelayEntry | null } = { entry: null };

    const createServerInstance = () => {
      const server = http.createServer((req, res) => {
        const entry = entryPlaceholder.entry;
        if (!entry) {
          res.writeHead(503);
          res.end('Relay initializing');
          return;
        }
        void this.handleHttpRequest(entry, req, res);
      });

      server.on('connect', (req, clientSocket: net.Socket, head) => {
        const entry = entryPlaceholder.entry;
        if (!entry) {
          clientSocket.destroy();
          return;
        }
        void this.handleConnectTunnel(entry, req, clientSocket, head);
      });

      server.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });

      return server;
    };

    for (let port = minPort; port <= maxPort; port++) {
      if (usedPorts.has(port)) continue;
      const server = createServerInstance();
      const listened = await new Promise<boolean>((resolve) => {
        const onErr = () => resolve(false);
        server.once('error', onErr);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', onErr);
          resolve(true);
        });
      });
      if (listened) {
        boundServer = server;
        boundPort = port;
        break;
      }
      try {
        server.close();
      } catch {
        // Ignore
      }
    }

    if (!boundServer || !boundPort) {
      throw new Error(`No available relay ports in range ${minPort}-${maxPort}`);
    }

    const entry: RelayEntry = {
      instanceId,
      port: boundPort,
      host,
      config,
      server: boundServer,
      sockets,
      stats,
    };
    entryPlaceholder.entry = entry;
    this.relays.set(instanceId, entry);
    return { host, port: boundPort };
  }

  private async handleConnectTunnel(
    entry: RelayEntry,
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    entry.stats.totalRequests += 1;
    entry.stats.activeConnections += 1;
    let closed = false;
    const decActive = () => {
      if (!closed) {
        closed = true;
        entry.stats.activeConnections = Math.max(0, entry.stats.activeConnections - 1);
      }
    };

    let upstreamSocket: net.Socket | null = null;
    try {
      const { host, port } = parseHostPortTarget(req.url ?? '', 443);
      const bypassed = isHostBypassed(host, entry.config.bypass);

      upstreamSocket = bypassed
        ? await connectRawTcp(host, port, 12000)
        : await dialUpstreamTunnel(entry.config, host, port, 12000);

      entry.sockets.add(upstreamSocket);
      upstreamSocket.on('close', () => {
        if (upstreamSocket) entry.sockets.delete(upstreamSocket);
        decActive();
        if (!clientSocket.destroyed) clientSocket.destroy();
      });

      clientSocket.on('close', () => {
        decActive();
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
      });

      clientSocket.on('error', () => {
        decActive();
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
      });

      upstreamSocket.on('error', (err) => {
        entry.stats.lastError = err.message;
        decActive();
        if (!clientSocket.destroyed) clientSocket.destroy();
      });

      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: DroidForge-Relay\r\n\r\n');
      if (head.length > 0) {
        entry.stats.bytesOut += head.length;
        upstreamSocket.write(head);
      }

      clientSocket.on('data', (chunk) => {
        entry.stats.bytesOut += chunk.length;
      });
      upstreamSocket.on('data', (chunk) => {
        entry.stats.bytesIn += chunk.length;
      });

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    } catch (err) {
      entry.stats.lastError = err instanceof Error ? err.message : String(err);
      decActive();
      if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    }
  }

  private async handleHttpRequest(
    entry: RelayEntry,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    entry.stats.totalRequests += 1;
    entry.stats.activeConnections += 1;
    let finished = false;
    const done = () => {
      if (!finished) {
        finished = true;
        entry.stats.activeConnections = Math.max(0, entry.stats.activeConnections - 1);
      }
    };
    res.on('close', done);
    res.on('finish', done);

    try {
      const rawUrl = req.url ?? '/';
      const targetUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? new URL(rawUrl)
        : new URL(`http://${req.headers.host ?? 'localhost'}${rawUrl}`);

      const bypassed = isHostBypassed(targetUrl.hostname, entry.config.bypass);

      if (!bypassed && (entry.config.protocol === 'http' || entry.config.protocol === 'https')) {
        const authHeader = buildBasicProxyAuth(entry.config);
        const mod = entry.config.protocol === 'https' ? https : http;
        const headers: Record<string, string | string[] | undefined> = { ...req.headers };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];
        headers.host = targetUrl.host;
        headers.connection = 'close';
        if (authHeader) {
          headers['proxy-authorization'] = authHeader;
        }

        const upReq = mod.request(
          {
            host: entry.config.host,
            port: entry.config.port,
            method: req.method,
            path: targetUrl.toString(),
            headers,
            ...(entry.config.protocol === 'https'
              ? { rejectUnauthorized: false, servername: entry.config.host }
              : {}),
            timeout: 20000,
          },
          (upRes) => {
            const chunks: Buffer[] = [];
            upRes.on('data', (c: Buffer) => {
              entry.stats.bytesIn += c.length;
              chunks.push(c);
            });
            upRes.on('end', () => {
              const body = Buffer.concat(chunks);
              const outHeaders = { ...upRes.headers };
              delete outHeaders['transfer-encoding'];
              outHeaders['content-length'] = String(body.length);
              res.writeHead(upRes.statusCode ?? 502, outHeaders);
              res.end(body);
            });
          },
        );
        upReq.on('error', (err) => {
          entry.stats.lastError = err.message;
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Proxy upstream error: ${err.message}`);
          } else {
            res.destroy();
          }
        });
        req.on('data', (c: Buffer) => {
          entry.stats.bytesOut += c.length;
        });
        req.pipe(upReq);
        return;
      }

      // SOCKS5 upstream or bypassed direct HTTP
      const targetPort = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80));
      const tunnelSocket = bypassed
        ? await connectRawTcp(targetUrl.hostname, targetPort, 12000)
        : await dialUpstreamTunnel(entry.config, targetUrl.hostname, targetPort, 12000);

      entry.sockets.add(tunnelSocket);
      tunnelSocket.on('close', () => entry.sockets.delete(tunnelSocket));

      const bodyChunks: Buffer[] = [];
      for await (const c of req) {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        entry.stats.bytesOut += buf.length;
        bodyChunks.push(buf);
      }
      const reqBody = Buffer.concat(bodyChunks);

      const outLines = [`${req.method ?? 'GET'} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`];
      const skipHeaders = new Set(['proxy-connection', 'proxy-authorization', 'connection']);
      for (const [k, v] of Object.entries(req.headers)) {
        if (!v || skipHeaders.has(k.toLowerCase())) continue;
        outLines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      if (!req.headers.host) outLines.push(`Host: ${targetUrl.host}`);
      if (reqBody.length > 0 && !req.headers['content-length']) {
        outLines.push(`Content-Length: ${reqBody.length}`);
      }
      outLines.push('Connection: close', '', '');

      tunnelSocket.write(outLines.join('\r\n'));
      if (reqBody.length > 0) tunnelSocket.write(reqBody);

      const respBufs: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        tunnelSocket.on('data', (c: Buffer) => {
          entry.stats.bytesIn += c.length;
          respBufs.push(c);
        });
        tunnelSocket.once('end', resolve);
        tunnelSocket.once('error', reject);
      });

      const rawResp = Buffer.concat(respBufs);
      const headerEnd = rawResp.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        res.writeHead(502);
        res.end('Malformed upstream HTTP response');
        return;
      }

      const headStr = rawResp.subarray(0, headerEnd).toString('utf8');
      let bodyBuf: Buffer = rawResp.subarray(headerEnd + 4);
      const headLines = headStr.split(/\r?\n/);
      const statusMatch = (headLines[0] ?? '').match(/^HTTP\/\d\.\d\s+(\d{3})/i);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 200;

      const respHeaders: Record<string, string> = {};
      let isChunked = false;
      for (const line of headLines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        if (name === 'transfer-encoding' && val.toLowerCase().includes('chunked')) {
          isChunked = true;
          continue;
        }
        if (name === 'content-length' || name === 'connection') continue;
        respHeaders[name] = val;
      }

      if (isChunked) {
        bodyBuf = decodeChunkedBody(bodyBuf);
      }
      respHeaders['content-length'] = String(bodyBuf.length);
      res.writeHead(statusCode, respHeaders);
      res.end(bodyBuf);
    } catch (err) {
      entry.stats.lastError = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Proxy relay error: ${entry.stats.lastError}`);
      } else {
        res.destroy();
      }
    }
  }

  async stopRelay(instanceId: string): Promise<void> {
    const entry = this.relays.get(instanceId);
    if (!entry) return;
    this.relays.delete(instanceId);
    for (const sock of entry.sockets) {
      try {
        sock.destroy();
      } catch {
        // Ignore
      }
    }
    entry.sockets.clear();
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.relays.keys()].map((id) => this.stopRelay(id)));
  }

  async testProxy(config: ProxyConfig, timeoutMs = 10000): Promise<ProxyTestResult> {
    const start = Date.now();
    const testedAt = new Date().toISOString();

    const tryIpApi = async (): Promise<Partial<ProxyTestResult>> => {
      const path = '/json/?fields=status,message,country,countryCode,regionName,city,isp,timezone,query';
      const resp =
        config.protocol === 'socks5'
          ? await httpRequestOverSocket(
              await dialUpstreamTunnel(config, 'ip-api.com', 80, timeoutMs),
              'ip-api.com',
              path,
              timeoutMs,
            )
          : await httpGetViaHttpProxy(config, `http://ip-api.com${path}`, timeoutMs);
      if (resp.statusCode === 407) {
        throw new Error('Proxy authentication failed (HTTP 407)');
      }
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        throw new Error(`HTTP ${resp.statusCode} from ip-api.com`);
      }
      return parseGeoResponse(resp.body);
    };

    const tryHttpsIpWhoIs = async (): Promise<Partial<ProxyTestResult>> => {
      const rawSock = await dialUpstreamTunnel(config, 'ipwho.is', 443, timeoutMs);
      const tlsSock = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const ts = tls.connect({ socket: rawSock, servername: 'ipwho.is', rejectUnauthorized: true });
        ts.once('secureConnect', () => resolve(ts));
        ts.once('error', reject);
      });
      const resp = await httpRequestOverSocket(tlsSock, 'ipwho.is', '/', timeoutMs);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        throw new Error(`HTTP ${resp.statusCode} from ipwho.is`);
      }
      return parseGeoResponse(resp.body);
    };

    try {
      let info: Partial<ProxyTestResult>;
      try {
        info = await tryIpApi();
      } catch (primaryErr) {
        const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        if (msg.includes('407') || msg.includes('authentication') || msg.includes('SOCKS')) {
          throw primaryErr;
        }
        info = await tryHttpsIpWhoIs();
      }

      return {
        ok: Boolean(info.exitIp),
        latencyMs: Date.now() - start,
        exitIp: info.exitIp ?? null,
        country: info.country ?? null,
        countryCode: info.countryCode ?? null,
        region: info.region ?? null,
        city: info.city ?? null,
        isp: info.isp ?? null,
        timezone: info.timezone ?? null,
        error: null,
        testedAt,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        exitIp: null,
        country: null,
        countryCode: null,
        region: null,
        city: null,
        isp: null,
        timezone: null,
        error: err instanceof Error ? err.message : String(err),
        testedAt,
      };
    }
  }

  async applyToAndroid(
    adb: AdbExecutor,
    instance: InstanceRecord,
    config: ProxyConfig,
    syncTimezone = false,
    timezoneHint?: string | null,
  ): Promise<{ host: string; port: number }> {
    const endpoint = await this.ensureRelay(instance.id, config);
    const proxyHostPort = `${endpoint.host}:${endpoint.port}`;
    const safeBypass = (config.bypass || 'localhost,127.0.0.1').replace(/[^a-zA-Z0-9.,*_-]/g, '');

    const cmds = [
      `settings put global http_proxy ${proxyHostPort}`,
      `settings put global global_http_proxy_host ${endpoint.host}`,
      `settings put global global_http_proxy_port ${endpoint.port}`,
      safeBypass
        ? `settings put global global_http_proxy_exclusion_list "${safeBypass}"`
        : 'settings delete global global_http_proxy_exclusion_list',
    ];

    if (syncTimezone && timezoneHint && /^[A-Za-z_]+\/[A-Za-z0-9_+-]+$/.test(timezoneHint)) {
      cmds.push('settings put global auto_time_zone 0');
      cmds.push(`setprop persist.sys.timezone "${timezoneHint}"`);
    }

    await adb.shell(instance.adbTarget, cmds.join(' && '));
    return endpoint;
  }

  async clearOnAndroid(adb: AdbExecutor, instance: InstanceRecord): Promise<void> {
    await this.stopRelay(instance.id);
    await adb.shell(
      instance.adbTarget,
      [
        'settings put global http_proxy :0',
        'settings delete global global_http_proxy_host',
        'settings delete global global_http_proxy_port',
        'settings delete global global_http_proxy_exclusion_list',
      ].join('; '),
    );
  }

  async getAndroidState(adb: AdbExecutor, instance: InstanceRecord): Promise<InstanceProxyState> {
    const relay = this.getRelayInfo(instance.id);
    let androidHttpProxy: string | null = null;

    if (instance.status === 'running' || instance.status === 'booting') {
      try {
        const res = await adb.shell(instance.adbTarget, 'settings get global http_proxy');
        const val = res.stdout.trim();
        androidHttpProxy = val && val !== 'null' && val !== ':0' ? val : null;
      } catch {
        androidHttpProxy = null;
      }
    }

    return {
      instanceId: instance.id,
      enabled: Boolean(instance.proxyConfig),
      proxyProfileId: instance.proxyProfileId ?? null,
      config: instance.proxyConfig
        ? {
            protocol: instance.proxyConfig.protocol,
            host: instance.proxyConfig.host,
            port: instance.proxyConfig.port,
            username: instance.proxyConfig.username,
            hasPassword: Boolean(instance.proxyConfig.password),
            bypass: instance.proxyConfig.bypass,
          }
        : null,
      relayActive: relay.relayActive,
      relayEndpoint: relay.relayEndpoint,
      androidHttpProxy,
      stats: relay.stats,
    };
  }

  async verifyFromAndroid(adb: AdbExecutor, instance: InstanceRecord): Promise<InstanceProxyVerifyResult> {
    const start = Date.now();
    const testedAt = new Date().toISOString();
    const relay = this.getRelayInfo(instance.id);

    try {
      const settingRes = await adb.shell(instance.adbTarget, 'settings get global http_proxy');
      const rawSetting = settingRes.stdout.trim();
      const androidHttpProxy = rawSetting && rawSetting !== 'null' && rawSetting !== ':0' ? rawSetting : null;
      const viaProxy = Boolean(androidHttpProxy && androidHttpProxy.includes(':'));

      let cmd: string;
      if (viaProxy && androidHttpProxy) {
        const { host, port } = parseHostPortTarget(androidHttpProxy, 8080);
        cmd = `printf 'GET http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,isp,timezone,query HTTP/1.0\\r\\nHost: ip-api.com\\r\\nConnection: close\\r\\n\\r\\n' | toybox nc -w 10 ${host} ${port}`;
      } else {
        cmd = `printf 'GET /json/?fields=status,message,country,countryCode,regionName,city,isp,timezone,query HTTP/1.0\\r\\nHost: ip-api.com\\r\\nConnection: close\\r\\n\\r\\n' | toybox nc -w 10 ip-api.com 80`;
      }

      const res = await adb.shell(instance.adbTarget, cmd, 15000);
      const parsed = parseRawHttpResponse(res.stdout);
      if (parsed.statusCode < 200 || parsed.statusCode >= 300) {
        throw new Error(
          parsed.statusCode
            ? `HTTP ${parsed.statusCode}: ${parsed.body.slice(0, 140)}`
            : `No HTTP response from Android probe (${res.stderr || res.stdout.slice(0, 120)})`,
        );
      }

      const info = parseGeoResponse(parsed.body);
      return {
        instanceId: instance.id,
        viaProxy,
        androidHttpProxy,
        relayEndpoint: relay.relayEndpoint,
        ok: Boolean(info.exitIp),
        latencyMs: Date.now() - start,
        exitIp: info.exitIp ?? null,
        country: info.country ?? null,
        countryCode: info.countryCode ?? null,
        region: info.region ?? null,
        city: info.city ?? null,
        isp: info.isp ?? null,
        timezone: info.timezone ?? null,
        error: null,
        testedAt,
      };
    } catch (err) {
      return {
        instanceId: instance.id,
        viaProxy: Boolean(instance.proxyConfig),
        androidHttpProxy: null,
        relayEndpoint: relay.relayEndpoint,
        ok: false,
        latencyMs: Date.now() - start,
        exitIp: null,
        country: null,
        countryCode: null,
        region: null,
        city: null,
        isp: null,
        timezone: null,
        error: err instanceof Error ? err.message : String(err),
        testedAt,
      };
    }
  }
}

function decodeChunkedBody(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const sizeHex = buf.subarray(offset, lineEnd).toString('ascii').split(';')[0].trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const dataStart = lineEnd + 2;
    const dataEnd = Math.min(buf.length, dataStart + size);
    parts.push(buf.subarray(dataStart, dataEnd));
    offset = dataEnd + 2;
  }
  return parts.length ? Buffer.concat(parts) : buf;
}
