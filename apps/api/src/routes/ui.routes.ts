import type { FastifyInstance } from 'fastify';
import {
  UiBatchActionsSchema,
  UiClickInputSchema,
  UiSelectorSchema,
  UiWaitInputSchema,
} from '@droidforge/shared';
import type { AppContext } from '../context.js';

export function registerUiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/instances/:id/ui/hierarchy', { schema: { tags: ['UI & AI'], summary: 'Dump Android UI hierarchy as XML and parsed JSON tree' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    return ctx.ui.dumpHierarchy(inst);
  });

  app.get('/api/v1/instances/:id/ui/ai-snapshot', { schema: { tags: ['UI & AI'], summary: 'Capture AI-ready Set-of-Marks (SoM) annotated screenshot + interactive elements map' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    return ctx.aiSnapshot.captureSnapshot(inst);
  });

  app.post('/api/v1/instances/:id/ui/find', { schema: { tags: ['UI & AI'], summary: 'Find UI nodes matching selector attributes' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const selector = UiSelectorSchema.parse(req.body);
    const nodes = await ctx.ui.find(inst, selector);
    return { count: nodes.length, nodes };
  });

  app.post('/api/v1/instances/:id/ui/click', { schema: { tags: ['UI & AI'], summary: 'Click an element by AI snapshot elementId or UI selector' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = UiClickInputSchema.parse(req.body);

    if (input.elementId !== undefined) {
      const el = ctx.aiSnapshot.getCachedElement(inst.id, input.elementId);
      if (!el) {
        return reply.code(404).send({
          error: `Element #${input.elementId} not found in latest AI snapshot. Call GET /ui/ai-snapshot first.`,
        });
      }
      const pt = await ctx.input.tap(inst, { x: el.bounds.centerX, y: el.bounds.centerY, normalized: false });
      return { ok: true, clicked: pt, element: el };
    }

    if (input.selector) {
      const nodes = await ctx.ui.find(inst, input.selector);
      if (nodes.length === 0) {
        return reply.code(404).send({ error: 'No UI node matched the selector' });
      }
      const pt = await ctx.input.tap(inst, {
        x: nodes[0].bounds.centerX,
        y: nodes[0].bounds.centerY,
        normalized: false,
      });
      return { ok: true, clicked: pt, node: nodes[0] };
    }

    return reply.code(400).send({ error: 'Provide either elementId or selector' });
  });

  app.post('/api/v1/instances/:id/ui/wait', { schema: { tags: ['UI & AI'], summary: 'Wait until a UI selector becomes visible or gone' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = UiWaitInputSchema.parse(req.body);
    return ctx.ui.waitFor(inst, input);
  });

  app.post('/api/v1/instances/:id/ui/actions/batch', { schema: { tags: ['UI & AI'], summary: 'Execute a multi-step UI automation pipeline' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = UiBatchActionsSchema.parse(req.body);

    const exec = await ctx.ui.executeBatch(inst, input, (instanceId, elementId) => {
      const el = ctx.aiSnapshot.getCachedElement(instanceId, elementId);
      return el ? { x: el.bounds.centerX, y: el.bounds.centerY } : undefined;
    });

    let finalScreenshotBase64: string | undefined;
    if (input.captureFinalScreenshot) {
      const png = await ctx.adb.screencapPng(inst.adbTarget).catch(() => null);
      if (png) finalScreenshotBase64 = png.toString('base64');
    }

    return { ...exec, finalScreenshotBase64 };
  });
}
