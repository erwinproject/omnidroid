import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CreateProxyProfileSchema,
  ImportProxiesSchema,
  SetInstanceProxyInputSchema,
  TestProxyInputSchema,
  parseProxyString,
  type ProxyConfig,
  type ProxyProfile,
} from '@droidforge/shared';
import type { AppContext } from '../context.js';

function maskProxyProfile(p: ProxyProfile): ProxyProfile {
  return {
    ...p,
    password: p.password ? '***' : undefined,
  };
}

export function registerProxyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/proxies', { schema: { tags: ['Proxy'], summary: 'List all saved proxy profiles' } }, async () => {
    return ctx.store.listProxies().map(maskProxyProfile);
  });

  app.post('/api/v1/proxies', { schema: { tags: ['Proxy'], summary: 'Add a proxy profile to the pool' } }, async (req, reply) => {
    const input = CreateProxyProfileSchema.parse(req.body);
    let config: ProxyConfig;
    if ('raw' in input) {
      config = parseProxyString(input.raw, input.defaultProtocol, input.bypass ?? 'localhost,127.0.0.1');
    } else {
      config = {
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        username: input.username || undefined,
        password: input.password || undefined,
        bypass: input.bypass,
      };
    }

    const now = new Date().toISOString();
    const id = `pxy_${crypto.randomBytes(4).toString('hex')}`;
    const name = input.name?.trim() || `${config.protocol.toUpperCase()} ${config.host}:${config.port}`;

    const record: ProxyProfile = {
      id,
      name,
      protocol: config.protocol,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      bypass: config.bypass,
      lastStatus: 'untested',
      lastLatencyMs: null,
      lastExitIp: null,
      lastCountry: null,
      lastCountryCode: null,
      lastCity: null,
      lastIsp: null,
      lastTimezone: null,
      lastError: null,
      lastTestedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    ctx.store.saveProxy(record);
    return reply.code(201).send(maskProxyProfile(record));
  });

  app.post('/api/v1/proxies/import', { schema: { tags: ['Proxy'], summary: 'Bulk import proxy lines into the pool' } }, async (req, reply) => {
    const input = ImportProxiesSchema.parse(req.body);
    const lines = input.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const imported: ProxyProfile[] = [];
    const failed: Array<{ line: string; error: string }> = [];
    const now = new Date().toISOString();

    for (const line of lines) {
      try {
        const config = parseProxyString(line, input.defaultProtocol);
        const id = `pxy_${crypto.randomBytes(4).toString('hex')}`;
        const record: ProxyProfile = {
          id,
          name: `${config.protocol.toUpperCase()} ${config.host}:${config.port}`,
          protocol: config.protocol,
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          bypass: config.bypass,
          lastStatus: 'untested',
          lastLatencyMs: null,
          lastExitIp: null,
          lastCountry: null,
          lastCountryCode: null,
          lastCity: null,
          lastIsp: null,
          lastTimezone: null,
          lastError: null,
          lastTestedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        ctx.store.saveProxy(record);
        imported.push(maskProxyProfile(record));
      } catch (err) {
        failed.push({ line, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return reply.code(201).send({ imported, failed });
  });

  app.post('/api/v1/proxies/test', { schema: { tags: ['Proxy'], summary: 'Test proxy connectivity, latency, and exit IP/geo' } }, async (req) => {
    const input = TestProxyInputSchema.parse(req.body);
    let config: ProxyConfig;
    let saved: ProxyProfile | undefined;

    if (input.proxyProfileId) {
      saved = ctx.store.getProxy(input.proxyProfileId);
      if (!saved) {
        const err = new Error(`Proxy profile not found: ${input.proxyProfileId}`) as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      config = {
        protocol: saved.protocol,
        host: saved.host,
        port: saved.port,
        username: saved.username,
        password: saved.password,
        bypass: saved.bypass,
      };
    } else if (input.config) {
      config = input.config;
    } else if (input.raw && input.raw.trim()) {
      config = parseProxyString(input.raw);
    } else {
      const err = new Error('Provide raw, config, or proxyProfileId to test') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const result = await ctx.proxyRelay.testProxy(config);
    if (saved) {
      ctx.store.saveProxy({
        ...saved,
        lastStatus: result.ok ? 'ok' : 'error',
        lastLatencyMs: result.latencyMs,
        lastExitIp: result.exitIp,
        lastCountry: result.country,
        lastCountryCode: result.countryCode,
        lastCity: result.city,
        lastIsp: result.isp,
        lastTimezone: result.timezone,
        lastError: result.error,
        lastTestedAt: result.testedAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return result;
  });

  app.post('/api/v1/proxies/:id/test', { schema: { tags: ['Proxy'], summary: 'Test a saved proxy profile by ID' } }, async (req) => {
    const { id } = req.params as { id: string };
    const saved = ctx.store.getProxy(id);
    if (!saved) {
      const err = new Error(`Proxy profile not found: ${id}`) as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    const result = await ctx.proxyRelay.testProxy({
      protocol: saved.protocol,
      host: saved.host,
      port: saved.port,
      username: saved.username,
      password: saved.password,
      bypass: saved.bypass,
    });
    ctx.store.saveProxy({
      ...saved,
      lastStatus: result.ok ? 'ok' : 'error',
      lastLatencyMs: result.latencyMs,
      lastExitIp: result.exitIp,
      lastCountry: result.country,
      lastCountryCode: result.countryCode,
      lastCity: result.city,
      lastIsp: result.isp,
      lastTimezone: result.timezone,
      lastError: result.error,
      lastTestedAt: result.testedAt,
      updatedAt: new Date().toISOString(),
    });
    return result;
  });

  app.delete('/api/v1/proxies/:id', { schema: { tags: ['Proxy'], summary: 'Delete a saved proxy profile' } }, async (req) => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.store.deleteProxy(id) };
  });

  app.get('/api/v1/instances/:id/proxy', { schema: { tags: ['Proxy'], summary: 'Get active proxy relay state and stats for an instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    return ctx.proxyRelay.getAndroidState(ctx.adb, inst);
  });

  app.put('/api/v1/instances/:id/proxy', { schema: { tags: ['Proxy'], summary: 'Apply or update HTTP/HTTPS/SOCKS5 proxy on an instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    const input = SetInstanceProxyInputSchema.parse(req.body);
    return ctx.orchestrator.applyInstanceProxy(id, input);
  });

  app.delete('/api/v1/instances/:id/proxy', { schema: { tags: ['Proxy'], summary: 'Disable proxy and restore direct connection on an instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    return ctx.orchestrator.clearInstanceProxy(id);
  });

  app.post('/api/v1/instances/:id/proxy/verify', { schema: { tags: ['Proxy'], summary: 'Verify live exit IP from inside the Android container' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    return ctx.proxyRelay.verifyFromAndroid(ctx.adb, inst);
  });

  app.get('/api/v1/system/images', { schema: { tags: ['System'], summary: 'Check available Redroid base and Play Store Docker images' } }, async () => {
    return ctx.docker.getSystemImages();
  });
}
