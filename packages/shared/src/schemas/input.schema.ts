import { z } from 'zod';

export const TapInputSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  normalized: z.boolean().default(false),
});

export const DoubleTapInputSchema = TapInputSchema.extend({
  intervalMs: z.number().int().min(30).max(500).default(80),
});

export const LongPressInputSchema = TapInputSchema.extend({
  durationMs: z.number().int().min(200).max(10000).default(800),
});

export const SwipeInputSchema = z.object({
  x1: z.number().min(0),
  y1: z.number().min(0),
  x2: z.number().min(0),
  y2: z.number().min(0),
  durationMs: z.number().int().min(50).max(5000).default(300),
  normalized: z.boolean().default(false),
});

export const TextInputSchema = z.object({
  text: z.string().min(1).max(4000),
  clearFirst: z.boolean().default(false),
});

export const KeyEventInputSchema = z.object({
  key: z.union([z.string().min(1), z.number().int().min(0)]),
});

export const GestureStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: z.number(), y: z.number(), normalized: z.boolean().optional() }),
  z.object({
    type: z.literal('swipe'),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    durationMs: z.number().int().optional(),
    normalized: z.boolean().optional(),
  }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('keyevent'), key: z.union([z.string(), z.number().int()]) }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(10).max(30000) }),
]);

export const GestureInputSchema = z.object({
  steps: z.array(GestureStepSchema).min(1).max(50),
});

export const ScreenshotQuerySchema = z.object({
  format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  encoding: z.enum(['binary', 'base64']).default('binary'),
  scale: z.coerce.number().min(0.1).max(1).default(1),
  quality: z.coerce.number().int().min(10).max(100).default(85),
});

export type TapInput = z.infer<typeof TapInputSchema>;
export type DoubleTapInput = z.infer<typeof DoubleTapInputSchema>;
export type LongPressInput = z.infer<typeof LongPressInputSchema>;
export type SwipeInput = z.infer<typeof SwipeInputSchema>;
export type TextInput = z.infer<typeof TextInputSchema>;
export type KeyEventInput = z.infer<typeof KeyEventInputSchema>;
export type GestureInput = z.infer<typeof GestureInputSchema>;
export type ScreenshotQuery = z.infer<typeof ScreenshotQuerySchema>;
