import type { FastifyInstance } from 'fastify';
import { CloneInstanceSchema, CreateInstanceSchema } from '@droidforge/shared';
import type { AppContext } from '../context.js';

export function registerInstanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/instances', { schema: { tags: ['Instances'], summary: 'List all Redroid emulator instances' } }, async () => {
    return ctx.store.listInstances();
  });

  app.post('/api/v1/instances', { schema: { tags: ['Instances'], summary: 'Create and start a new Redroid container instance' } }, async (req, reply) => {
    const input = CreateInstanceSchema.parse(req.body);
    const created = await ctx.orchestrator.create(input);
    return reply.code(201).send(created);
  });

  app.get('/api/v1/instances/:id', { schema: { tags: ['Instances'], summary: 'Get instance details' } }, async (req) => {
    const { id } = req.params as { id: string };
    return ctx.orchestrator.requireInstance(id);
  });

  app.post('/api/v1/instances/:id/start', { schema: { tags: ['Instances'], summary: 'Start a stopped instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    return ctx.orchestrator.start(id);
  });

  app.post('/api/v1/instances/:id/stop', { schema: { tags: ['Instances'], summary: 'Stop a running instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    return ctx.orchestrator.stop(id);
  });

  app.post('/api/v1/instances/:id/restart', { schema: { tags: ['Instances'], summary: 'Restart an instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    return ctx.orchestrator.restart(id);
  });

  app.delete('/api/v1/instances/:id', { schema: { tags: ['Instances'], summary: 'Delete an instance container (and optional volume)' } }, async (req) => {
    const { id } = req.params as { id: string };
    const { removeVolume } = req.query as { removeVolume?: string };
    await ctx.orchestrator.remove(id, removeVolume === 'true');
    return { deleted: true };
  });

  app.get('/api/v1/instances/:id/health', { schema: { tags: ['Instances'], summary: 'Get boot readiness, ADB status, and container CPU/RAM metrics' } }, async (req) => {
    const { id } = req.params as { id: string };
    return ctx.orchestrator.health(id);
  });

  app.post('/api/v1/instances/:id/clone', { schema: { tags: ['Instances'], summary: 'Clone instance configuration and /data volume' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = CloneInstanceSchema.parse(req.body);
    const cloned = await ctx.orchestrator.clone(id, input);
    return reply.code(201).send(cloned);
  });

  app.get('/api/v1/instances/:id/snapshots', { schema: { tags: ['Instances'], summary: 'List snapshots for an instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    ctx.orchestrator.requireInstance(id);
    return ctx.store.listSnapshots(id);
  });

  app.post('/api/v1/instances/:id/snapshots', { schema: { tags: ['Instances'], summary: 'Create a volume backup snapshot' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string };
    const snap = await ctx.orchestrator.createSnapshot(id, body.name);
    return reply.code(201).send(snap);
  });

  app.post('/api/v1/instances/:id/snapshots/:snapId/restore', { schema: { tags: ['Instances'], summary: 'Restore instance volume from snapshot' } }, async (req) => {
    const { id, snapId } = req.params as { id: string; snapId: string };
    await ctx.orchestrator.restoreSnapshot(id, snapId);
    return { restored: true };
  });
}
