import { z } from 'zod';

export const DeviceProfileSchema = z.object({
  id: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(2).max(100),
  isBuiltIn: z.boolean().default(false),
  brand: z.string().min(1).max(64),
  manufacturer: z.string().min(1).max(64),
  model: z.string().min(1).max(64),
  device: z.string().min(1).max(64),
  product: z.string().min(1).max(64),
  hardware: z.string().min(1).max(64),
  board: z.string().min(1).max(64),
  platform: z.string().min(1).max(64),
  buildType: z.enum(['user', 'userdebug']).default('user'),
  buildTags: z.string().default('release-keys'),
  buildId: z.string().default('AP2A.240805.005'),
  buildFingerprint: z.string().min(5),
  securityPatch: z.string().default('2024-08-05'),
  width: z.number().int().min(320).max(2160).default(1080),
  height: z.number().int().min(480).max(3840).default(2400),
  dpi: z.number().int().min(120).max(640).default(420),
  macOui: z.string().regex(/^[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}$/).default('3C:28:6D'),
  serialNo: z.string().optional(),
  androidId: z.string().regex(/^[0-9a-fA-F]{16}$/).optional(),
  macAddress: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/).optional(),
  locale: z.string().default('id-ID'),
  timezone: z.string().default('Asia/Jakarta'),
  carrierName: z.string().default('Telkomsel'),
  carrierMccMnc: z.string().default('51010'),
  countryIso: z.string().length(2).default('id'),
});

export const CreateDeviceProfileSchema = DeviceProfileSchema.omit({
  id: true,
  isBuiltIn: true,
}).extend({
  id: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
});

export const DeviceProfileOverrideSchema = DeviceProfileSchema.omit({
  id: true,
  isBuiltIn: true,
  name: true,
}).partial();

export const GeneratedIdentitySchema = z.object({
  serialNo: z.string(),
  androidId: z.string(),
  macAddress: z.string(),
  batteryLevel: z.number().int().min(35).max(92),
});

export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;
export type CreateDeviceProfileInput = z.infer<typeof CreateDeviceProfileSchema>;
export type DeviceProfileOverride = z.infer<typeof DeviceProfileOverrideSchema>;
export type GeneratedIdentity = z.infer<typeof GeneratedIdentitySchema>;
