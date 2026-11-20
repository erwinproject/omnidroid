import { z } from 'zod';
import { AndroidVersionSchema } from './android.schema.js';

export const ProxyProtocolSchema = z.enum(['http', 'https', 'socks5']);

export const ProxyConfigSchema = z.object({
  protocol: ProxyProtocolSchema.default('http'),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  bypass: z.string().max(1000).default('localhost,127.0.0.1'),
});

export const ProxyStatusSchema = z.enum(['untested', 'ok', 'error']);

export const ProxyProfileSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  protocol: ProxyProtocolSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  bypass: z.string().default('localhost,127.0.0.1'),
  lastStatus: ProxyStatusSchema.default('untested'),
  lastLatencyMs: z.number().int().nullable().default(null),
  lastExitIp: z.string().nullable().default(null),
  lastCountry: z.string().nullable().default(null),
  lastCountryCode: z.string().nullable().default(null),
  lastCity: z.string().nullable().default(null),
  lastIsp: z.string().nullable().default(null),
  lastTimezone: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  lastTestedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateProxyProfileSchema = z.union([
  z.object({
    name: z.string().min(1).max(80).optional(),
    raw: z.string().min(3).max(1000),
    defaultProtocol: ProxyProtocolSchema.default('http'),
    bypass: z.string().max(1000).optional(),
  }),
  z.object({
    name: z.string().min(1).max(80).optional(),
    protocol: ProxyProtocolSchema.default('http'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(255).optional(),
    password: z.string().max(255).optional(),
    bypass: z.string().max(1000).default('localhost,127.0.0.1'),
  }),
]);

export const ImportProxiesSchema = z.object({
  text: z.string().min(1).max(100000),
  defaultProtocol: ProxyProtocolSchema.default('http'),
});

export const TestProxyInputSchema = z.object({
  raw: z.string().optional(),
  proxyProfileId: z.string().optional(),
  config: ProxyConfigSchema.optional(),
});

export const ProxyTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nullable(),
  exitIp: z.string().nullable(),
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  isp: z.string().nullable(),
  timezone: z.string().nullable(),
  error: z.string().nullable(),
  testedAt: z.string(),
});

export const SetInstanceProxyInputSchema = z.object({
  enabled: z.boolean().default(true),
  proxyProfileId: z.string().nullable().optional(),
  raw: z.string().nullable().optional(),
  config: ProxyConfigSchema.nullable().optional(),
  syncTimezone: z.boolean().default(false),
});

export const ProxyRelayStatsSchema = z.object({
  activeConnections: z.number().int(),
  totalRequests: z.number().int(),
  bytesIn: z.number().int(),
  bytesOut: z.number().int(),
  lastError: z.string().nullable(),
});

export const InstanceProxyStateSchema = z.object({
  instanceId: z.string(),
  enabled: z.boolean(),
  proxyProfileId: z.string().nullable(),
  config: z
    .object({
      protocol: ProxyProtocolSchema,
      host: z.string(),
      port: z.number().int(),
      username: z.string().optional(),
      hasPassword: z.boolean(),
      bypass: z.string(),
    })
    .nullable(),
  relayActive: z.boolean(),
  relayEndpoint: z.string().nullable(),
  androidHttpProxy: z.string().nullable(),
  stats: ProxyRelayStatsSchema,
});

export const InstanceProxyVerifyResultSchema = ProxyTestResultSchema.extend({
  instanceId: z.string(),
  viaProxy: z.boolean(),
  androidHttpProxy: z.string().nullable(),
  relayEndpoint: z.string().nullable(),
});

export const SystemImageStatusSchema = z.object({
  androidVersion: AndroidVersionSchema,
  baseImage: z.string(),
  baseInstalled: z.boolean(),
  playStoreImage: z.string(),
  playStoreSupported: z.boolean().default(true),
  playStoreInstalled: z.boolean(),
  playStoreSizeMb: z.number().nullable(),
  buildCommand: z.string(),
});

export type ProxyProtocol = z.infer<typeof ProxyProtocolSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type ProxyProfile = z.infer<typeof ProxyProfileSchema>;
export type CreateProxyProfileInput = z.infer<typeof CreateProxyProfileSchema>;
export type ImportProxiesInput = z.infer<typeof ImportProxiesSchema>;
export type TestProxyInput = z.infer<typeof TestProxyInputSchema>;
export type ProxyTestResult = z.infer<typeof ProxyTestResultSchema>;
export type SetInstanceProxyInput = z.infer<typeof SetInstanceProxyInputSchema>;
export type ProxyRelayStats = z.infer<typeof ProxyRelayStatsSchema>;
export type InstanceProxyState = z.infer<typeof InstanceProxyStateSchema>;
export type InstanceProxyVerifyResult = z.infer<typeof InstanceProxyVerifyResultSchema>;
export type SystemImageStatus = z.infer<typeof SystemImageStatusSchema>;

function splitHostPort(hostPort: string): { host: string; port: number } {
  const cleaned = hostPort.trim().replace(/\/+$/, '');
  if (cleaned.startsWith('[')) {
    const closeIdx = cleaned.indexOf(']');
    if (closeIdx === -1) throw new Error(`Invalid IPv6 proxy host: ${hostPort}`);
    const host = cleaned.slice(1, closeIdx);
    const portPart = cleaned.slice(closeIdx + 1);
    if (!portPart.startsWith(':')) throw new Error(`Missing proxy port in: ${hostPort}`);
    const port = Number(portPart.slice(1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid proxy port in: ${hostPort}`);
    }
    return { host, port };
  }

  const colonIdx = cleaned.lastIndexOf(':');
  if (colonIdx <= 0) {
    throw new Error(`Proxy must include host and port: ${hostPort}`);
  }
  const host = cleaned.slice(0, colonIdx).trim();
  const port = Number(cleaned.slice(colonIdx + 1).trim());
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy host or port: ${hostPort}`);
  }
  return { host, port };
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseProxyString(
  raw: string,
  defaultProtocol: ProxyProtocol = 'http',
  bypass = 'localhost,127.0.0.1',
): ProxyConfig {
  let trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Proxy string cannot be empty');
  }

  let protocol: ProxyProtocol = defaultProtocol;
  let hasExplicitScheme = false;
  const schemeMatch = trimmed.match(/^(https?|socks5h?|socks):\/\//i);
  if (schemeMatch) {
    hasExplicitScheme = true;
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'https') protocol = 'https';
    else if (scheme === 'http') protocol = 'http';
    else protocol = 'socks5';
    trimmed = trimmed.slice(schemeMatch[0].length);
  }

  // Strip optional trailing slash/path if URL-formatted
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx !== -1) {
    trimmed = trimmed.slice(0, slashIdx);
  }

  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx !== -1) {
    const authPart = trimmed.slice(0, atIdx);
    const hostPortPart = trimmed.slice(atIdx + 1);
    const sepIdx = authPart.indexOf(':');
    const username = sepIdx === -1 ? safeDecode(authPart) : safeDecode(authPart.slice(0, sepIdx));
    const password = sepIdx === -1 ? undefined : safeDecode(authPart.slice(sepIdx + 1));
    const { host, port } = splitHostPort(hostPortPart);
    return ProxyConfigSchema.parse({
      protocol,
      host,
      port,
      username: username || undefined,
      password: password !== undefined && password !== '' ? password : undefined,
      bypass,
    });
  }

  if (!hasExplicitScheme && !trimmed.startsWith('[')) {
    const parts = trimmed.split(':');
    if (parts.length >= 4 && /^\d{1,5}$/.test(parts[1])) {
      const port = Number(parts[1]);
      if (port >= 1 && port <= 65535) {
        return ProxyConfigSchema.parse({
          protocol,
          host: parts[0].trim(),
          port,
          username: parts[2] || undefined,
          password: parts.slice(3).join(':') || undefined,
          bypass,
        });
      }
    }
  }

  const { host, port } = splitHostPort(trimmed);
  return ProxyConfigSchema.parse({
    protocol,
    host,
    port,
    bypass,
  });
}

export function formatProxyUrl(config: ProxyConfig, maskPassword = true): string {
  const hostPart = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  if (config.username) {
    const user = encodeURIComponent(config.username);
    const pass = config.password ? (maskPassword ? '***' : encodeURIComponent(config.password)) : '';
    return `${config.protocol}://${user}${config.password ? `:${pass}` : ''}@${hostPart}:${config.port}`;
  }
  return `${config.protocol}://${hostPart}:${config.port}`;
}
