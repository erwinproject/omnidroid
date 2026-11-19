import { z } from 'zod';

export const AppLaunchInputSchema = z.object({
  activity: z.string().optional(),
});

export const AppPermissionsInputSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  permissions: z.array(z.string().min(3)).min(1),
});

export const ShellCommandInputSchema = z.object({
  command: z.string().min(1).max(4000),
  timeoutMs: z.number().int().min(500).max(60000).default(15000),
});

export const ClipboardInputSchema = z.object({
  text: z.string().max(10000),
});

export const LocationInputSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().default(10),
});

export const BatteryInputSchema = z.object({
  level: z.number().int().min(0).max(100).optional(),
  status: z.enum(['charging', 'discharging', 'not_charging', 'full']).optional(),
  unplugged: z.boolean().optional(),
  reset: z.boolean().optional(),
});

export const NetworkInputSchema = z.object({
  wifi: z.boolean().optional(),
  airplaneMode: z.boolean().optional(),
  httpProxy: z.string().nullable().optional(),
});

export const RotationInputSchema = z.object({
  mode: z.enum(['portrait', 'landscape', 'reverse_portrait', 'reverse_landscape', 'auto']),
});

export const StealthCheckItemSchema = z.object({
  key: z.string(),
  category: z.enum(['build', 'emulator_markers', 'identity', 'hardware', 'abi']),
  status: z.enum(['pass', 'warn', 'fail']),
  actual: z.string(),
  detail: z.string(),
});

export const StealthCheckReportSchema = z.object({
  instanceId: z.string(),
  checkedAt: z.string(),
  score: z.number().int().min(0).max(100),
  passed: z.number().int(),
  warnings: z.number().int(),
  failed: z.number().int(),
  checks: z.array(StealthCheckItemSchema),
});

export type ShellCommandInput = z.infer<typeof ShellCommandInputSchema>;
export type LocationInput = z.infer<typeof LocationInputSchema>;
export type BatteryInput = z.infer<typeof BatteryInputSchema>;
export type NetworkInput = z.infer<typeof NetworkInputSchema>;
export type RotationInput = z.infer<typeof RotationInputSchema>;
export type StealthCheckItem = z.infer<typeof StealthCheckItemSchema>;
export type StealthCheckReport = z.infer<typeof StealthCheckReportSchema>;
