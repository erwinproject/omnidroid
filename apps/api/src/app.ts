import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { loadEnv, type AppEnv } from './config/env.js';
import type { AppContext } from './context.js';
import { StateStore } from './db/database.js';
import { RedroidDockerManager } from './docker/redroid-docker.manager.js';
import { registerAppRoutes } from './routes/apps.routes.js';
import { registerDeviceRoutes } from './routes/device.routes.js';
import { registerFileRoutes } from './routes/files.routes.js';
import { registerInputRoutes } from './routes/input.routes.js';
import { registerInstanceRoutes } from './routes/instances.routes.js';
import { registerProfileRoutes } from './routes/profiles.routes.js';
import { registerProxyRoutes } from './routes/proxies.routes.js';
import { registerScreenRoutes } from './routes/screen.routes.js';
import { registerSystemRoutes } from './routes/system.routes.js';
import { registerUiRoutes } from './routes/ui.routes.js';
import { AdbService, type AdbExecutor } from './services/adb.service.js';
import { AiSnapshotService } from './services/ai-snapshot.service.js';
import { ChromeService } from './services/chrome.service.js';
import { H264StreamService } from './services/h264-stream.service.js';
import { InputService } from './services/input.service.js';
import { InstanceOrchestrator } from './services/instance.orchestrator.js';
import { ProxyRelayService } from './services/proxy-relay.service.js';
import { PruneService } from './services/prune.service.js';
import { RecordingService } from './services/recording.service.js';
import { RootService } from './services/root.service.js';
import { StealthService } from './services/stealth.service.js';
import { StreamService } from './services/stream.service.js';
import { UiAutomationService } from './services/ui-automation.service.js';
import { registerWsRoutes } from './ws/ws.routes.js';

export interface BuildAppOptions {
  env?: AppEnv;
  store?: StateStore;
  docker?: RedroidDockerManager;
  adb?: AdbExecutor;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<{
  app: FastifyInstance;
  ctx: AppContext;
}> {
  const env = options.env ?? loadEnv();
  const dbPath = env.NODE_ENV === 'test' ? ':memory:' : path.resolve(env.DATA_DIR, 'droidforge.db');
  const store = options.store ?? new StateStore(dbPath);
  const docker = options.docker ?? new RedroidDockerManager(env);
  const adb = options.adb ?? new AdbService(env.ADB_BIN);
  const chrome = new ChromeService(env, adb);
  const stealth = new StealthService(adb);
  const proxyRelay = new ProxyRelayService(env);
  const recordings = new RecordingService(env);
  const prune = new PruneService(env, store, docker, recordings);
  const root = new RootService(env, docker);
  const input = new InputService(adb);
  const ui = new UiAutomationService(adb, input);
  const aiSnapshot = new AiSnapshotService(adb, ui);
  const stream = new StreamService(adb);
  const h264 = new H264StreamService(adb, env);
  stream.attachH264(h264);
  const orchestrator = new InstanceOrchestrator(
    env,
    store,
    docker,
    adb,
    stealth,
    proxyRelay,
    recordings,
    prune,
    stream,
    aiSnapshot,
    root,
    chrome,
  );

  const ctx: AppContext = {
    env,
    store,
    docker,
    adb,
    chrome,
    stealth,
    proxyRelay,
    recordings,
    prune,
    root,
    input,
    ui,
    aiSnapshot,
    stream,
    h264,
    orchestrator,
  };

  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
    bodyLimit: 256 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });
  await app.register(websocket);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'DroidForge — Full Docker Redroid Android Emulator API',
        description:
          'Complete REST & WebSocket API for containerized Android (Redroid) orchestration, custom stealth device profiles, live screen streaming, and AI Agent UI automation.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
      tags: [
        { name: 'Profiles', description: 'Device profile presets & realistic identity generator' },
        { name: 'Instances', description: 'Redroid Docker container lifecycle, clone & snapshots' },
        { name: 'Screen', description: 'Screenshots, screen info, recording & live stream' },
        { name: 'Input', description: 'Tap, swipe, text, keyevent & gesture macros' },
        { name: 'UI & AI', description: 'UI hierarchy, Set-of-Marks AI snapshot, wait & batch pipelines' },
        { name: 'Apps', description: 'APK install/uninstall, launch, stop, clear & permissions' },
        { name: 'Files', description: 'Android filesystem list, push, pull & delete' },
        { name: 'Device', description: 'Shell, clipboard, GPS, battery, network, rotation & stealth check' },
        { name: 'Proxy', description: 'Multi-protocol proxy pool, auth relay, live exit IP verification & timezone sync' },
        { name: 'System', description: 'Host Redroid images, storage dry-run preview & unused resource prune' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  // API Key auth hook
  app.addHook('onRequest', async (req, reply) => {
    if (!env.REQUIRE_AUTH) return;
    const url = req.url;
    if (url === '/health' || url.startsWith('/docs') || url === '/openapi.json') return;

    const headerKey = req.headers['x-api-key'];
    const queryKey = (req.query as Record<string, string | undefined>)?.apiKey;
    if (headerKey !== env.API_KEY && queryKey !== env.API_KEY) {
      return reply.code(401).send({ error: 'Unauthorized: invalid or missing X-API-Key' });
    }
  });

  // Unified error handler
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        issues: err.issues,
      });
    }
    const e = err as Error & { statusCode?: number };
    const statusCode = e.statusCode ?? 500;
    return reply.code(statusCode).send({
      error: e.message || 'Internal Server Error',
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'droidforge-api',
    port: env.API_PORT,
    dockerNetwork: env.DOCKER_NETWORK,
    adbPortRange: [env.ADB_PORT_MIN, env.ADB_PORT_MAX],
  }));

  app.get('/openapi.json', async () => app.swagger());

  registerProfileRoutes(app, ctx);
  registerInstanceRoutes(app, ctx);
  registerScreenRoutes(app, ctx);
  registerInputRoutes(app, ctx);
  registerUiRoutes(app, ctx);
  registerAppRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerProxyRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerWsRoutes(app, ctx);

  if (env.NODE_ENV !== 'test') {
    await orchestrator.restoreActiveRelays();
  }

  app.addHook('onClose', async () => {
    ctx.stream.stopAll();
    await ctx.proxyRelay.stopAll();
    ctx.store.close();
  });

  return { app, ctx };
}
