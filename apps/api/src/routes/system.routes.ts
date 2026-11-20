import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PruneOptionsSchema } from '@droidforge/shared';
import type { AppContext } from '../context.js';

const PrunePreviewQuerySchema = z.object({
  includeUnusedImages: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  includeBuildCache: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  minTempFileAgeMs: z.coerce.number().int().min(0).optional(),
});

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/api/v1/system/images',
    {
      schema: {
        tags: ['System'],
        summary: 'Check available Redroid base and Play Store Docker images',
      },
    },
    async () => {
      return ctx.docker.getSystemImages();
    },
  );

  app.get(
    '/api/v1/system/prune/preview',
    {
      schema: {
        tags: ['System'],
        summary: 'Dry-run scan for orphaned Redroid containers, volumes, snapshots, recordings, temp files, and Docker images',
      },
    },
    async (req) => {
      const query = PrunePreviewQuerySchema.parse(req.query ?? {});
      return ctx.prune.prune({
        dryRun: true,
        removeUnusedRedroidImages: query.includeUnusedImages,
        removeBuildCache: query.includeBuildCache,
        ...(query.minTempFileAgeMs !== undefined ? { minTempFileAgeMs: query.minTempFileAgeMs } : {}),
      });
    },
  );

  app.post(
    '/api/v1/system/prune',
    {
      schema: {
        tags: ['System'],
        summary: 'Prune orphaned containers, volumes, snapshots, recordings, temp files, and unused Docker artifacts',
      },
    },
    async (req) => {
      const options = PruneOptionsSchema.parse(req.body ?? {});
      return ctx.prune.prune(options);
    },
  );

  app.get(
    '/api/v1/system/stream-check',
    {
      schema: {
        tags: ['System'],
        summary: 'Diagnose H.264 streaming: scrcpy-server presence, encoder start and time to first frame',
      },
    },
    async (req, reply) => {
      const { instanceId } = req.query as { instanceId?: string };
      if (!instanceId) return reply.code(400).send({ error: 'Query param "instanceId" is required' });
      const inst = ctx.orchestrator.requireInstance(instanceId);
      return ctx.h264.check(inst);
    },
  );
}
