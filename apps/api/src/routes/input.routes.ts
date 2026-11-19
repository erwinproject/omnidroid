import type { FastifyInstance } from 'fastify';
import {
  DoubleTapInputSchema,
  GestureInputSchema,
  KeyEventInputSchema,
  LongPressInputSchema,
  SwipeInputSchema,
  TapInputSchema,
  TextInputSchema,
} from '@droidforge/shared';
import type { AppContext } from '../context.js';

export function registerInputRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/instances/:id/input/tap', { schema: { tags: ['Input'], summary: 'Tap at absolute or normalized (0..1) coordinates' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = TapInputSchema.parse(req.body);
    const pt = await ctx.input.tap(inst, input);
    return { ok: true, point: pt };
  });

  app.post('/api/v1/instances/:id/input/double-tap', { schema: { tags: ['Input'], summary: 'Double tap at coordinates' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = DoubleTapInputSchema.parse(req.body);
    const pt = await ctx.input.doubleTap(inst, input);
    return { ok: true, point: pt };
  });

  app.post('/api/v1/instances/:id/input/long-press', { schema: { tags: ['Input'], summary: 'Long press at coordinates' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = LongPressInputSchema.parse(req.body);
    const pt = await ctx.input.longPress(inst, input);
    return { ok: true, point: pt };
  });

  app.post('/api/v1/instances/:id/input/swipe', { schema: { tags: ['Input'], summary: 'Swipe / drag between two points' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = SwipeInputSchema.parse(req.body);
    await ctx.input.swipe(inst, input);
    return { ok: true };
  });

  app.post('/api/v1/instances/:id/input/text', { schema: { tags: ['Input'], summary: 'Type text into the focused field' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = TextInputSchema.parse(req.body);
    await ctx.input.text(inst, input);
    return { ok: true };
  });

  app.post('/api/v1/instances/:id/input/keyevent', { schema: { tags: ['Input'], summary: 'Send Android keyevent (HOME, BACK, RECENTS, ENTER, etc.)' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = KeyEventInputSchema.parse(req.body);
    const keyCode = await ctx.input.keyevent(inst, input.key);
    return { ok: true, keyCode };
  });

  app.post('/api/v1/instances/:id/input/gesture', { schema: { tags: ['Input'], summary: 'Execute a multi-step input gesture macro' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = GestureInputSchema.parse(req.body);
    const executedSteps = await ctx.input.gesture(inst, input);
    return { ok: true, executedSteps };
  });
}
