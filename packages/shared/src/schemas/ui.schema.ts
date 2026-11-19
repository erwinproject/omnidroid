import { z } from 'zod';

export const UiBoundsSchema = z.object({
  x1: z.number().int(),
  y1: z.number().int(),
  x2: z.number().int(),
  y2: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  centerX: z.number().int(),
  centerY: z.number().int(),
});

export interface UiNode {
  index: number;
  text: string;
  resourceId: string;
  className: string;
  packageName: string;
  contentDesc: string;
  checkable: boolean;
  checked: boolean;
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  longClickable: boolean;
  password: boolean;
  selected: boolean;
  bounds: z.infer<typeof UiBoundsSchema>;
  children: UiNode[];
}

export const UiSelectorSchema = z.object({
  text: z.string().optional(),
  textContains: z.string().optional(),
  resourceId: z.string().optional(),
  contentDesc: z.string().optional(),
  className: z.string().optional(),
  clickable: z.boolean().optional(),
  scrollable: z.boolean().optional(),
  index: z.number().int().min(0).optional(),
});

export const UiClickInputSchema = z.object({
  elementId: z.number().int().min(1).optional(),
  selector: UiSelectorSchema.optional(),
});

export const UiWaitInputSchema = z.object({
  selector: UiSelectorSchema,
  state: z.enum(['visible', 'gone']).default('visible'),
  timeoutMs: z.number().int().min(500).max(60000).default(10000),
  intervalMs: z.number().int().min(100).max(2000).default(400),
});

export const BatchActionStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('launch'), packageName: z.string() }),
  z.object({ action: z.literal('wait'), selector: UiSelectorSchema, timeoutMs: z.number().int().optional() }),
  z.object({ action: z.literal('click'), elementId: z.number().int().optional(), selector: UiSelectorSchema.optional() }),
  z.object({ action: z.literal('tap'), x: z.number(), y: z.number(), normalized: z.boolean().optional() }),
  z.object({
    action: z.literal('swipe'),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    durationMs: z.number().int().optional(),
    normalized: z.boolean().optional(),
  }),
  z.object({ action: z.literal('text'), text: z.string() }),
  z.object({ action: z.literal('keyevent'), key: z.union([z.string(), z.number().int()]) }),
  z.object({ action: z.literal('sleep'), ms: z.number().int().min(50).max(30000) }),
  z.object({ action: z.literal('assertVisible'), selector: UiSelectorSchema }),
]);

export const UiBatchActionsSchema = z.object({
  steps: z.array(BatchActionStepSchema).min(1).max(50),
  stopOnError: z.boolean().default(true),
  captureFinalScreenshot: z.boolean().default(false),
});

export const AiElementSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  text: z.string(),
  contentDesc: z.string(),
  resourceId: z.string(),
  className: z.string(),
  clickable: z.boolean(),
  scrollable: z.boolean(),
  editable: z.boolean(),
  bounds: UiBoundsSchema,
  normalizedCenter: z.object({
    x: z.number(),
    y: z.number(),
  }),
});

export const AiSnapshotResponseSchema = z.object({
  instanceId: z.string(),
  capturedAt: z.string(),
  screen: z.object({
    width: z.number().int(),
    height: z.number().int(),
  }),
  annotatedImageBase64: z.string(),
  mimeType: z.string(),
  elements: z.array(AiElementSchema),
});

export type UiBounds = z.infer<typeof UiBoundsSchema>;
export type UiSelector = z.infer<typeof UiSelectorSchema>;
export type UiClickInput = z.infer<typeof UiClickInputSchema>;
export type UiWaitInput = z.infer<typeof UiWaitInputSchema>;
export type UiBatchActionsInput = z.infer<typeof UiBatchActionsSchema>;
export type AiElement = z.infer<typeof AiElementSchema>;
export type AiSnapshotResponse = z.infer<typeof AiSnapshotResponseSchema>;
