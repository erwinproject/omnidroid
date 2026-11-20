import { z } from 'zod';
import { DeviceProfileOverrideSchema, DeviceProfileSchema } from './profile.schema.js';
import { ProxyConfigSchema } from './proxy.schema.js';

export const InstanceStatusSchema = z.enum([
  'creating',
  'booting',
  'running',
  'stopped',
  'error',
]);

export const AndroidVersionSchema = z.enum(['11', '12', '13', '14']);

export const CreateInstanceSchema = z.object({
  name: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  androidVersion: AndroidVersionSchema.default('13'),
  customImage: z.string().min(3).optional(),
  profileId: z.string().default('pixel-8-pro'),
  deviceProfile: DeviceProfileOverrideSchema.optional(),
  stealthMode: z.boolean().default(true),
  width: z.number().int().min(320).max(2160).optional(),
  height: z.number().int().min(480).max(3840).optional(),
  dpi: z.number().int().min(120).max(640).optional(),
  fps: z.number().int().min(15).max(60).default(30),
  gpuMode: z.enum(['guest', 'host', 'auto']).default('guest'),
  memoryMb: z.number().int().min(1024).max(32768).default(2048),
  cpus: z.number().min(1).max(16).default(2),
  exposeAdbPort: z.boolean().default(false),
  enablePlayStore: z.boolean().default(false),
  proxy: z.string().optional(),
  proxyConfig: ProxyConfigSchema.nullable().optional(),
  proxyProfileId: z.string().nullable().optional(),
  customProps: z.record(z.string()).optional(),
  autoStart: z.boolean().default(true),
});

export const UpdateInstanceSchema = z
  .object({
    name: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
    androidVersion: AndroidVersionSchema,
    enablePlayStore: z.boolean(),
    profileId: z.string(),
    deviceProfile: DeviceProfileOverrideSchema,
    stealthMode: z.boolean(),
    width: z.number().int().min(320).max(2160),
    height: z.number().int().min(480).max(3840),
    dpi: z.number().int().min(120).max(640),
    fps: z.number().int().min(15).max(60),
    gpuMode: z.enum(['guest', 'host', 'auto']),
    memoryMb: z.number().int().min(1024).max(32768),
    cpus: z.number().min(1).max(16),
    exposeAdbPort: z.boolean(),
    customProps: z.record(z.string()),
  })
  .partial();

export const InstanceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  containerId: z.string().nullable(),
  containerName: z.string(),
  volumeName: z.string(),
  image: z.string(),
  androidVersion: AndroidVersionSchema,
  status: InstanceStatusSchema,
  adbTarget: z.string(),
  hostAdbPort: z.number().int().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  dpi: z.number().int(),
  fps: z.number().int(),
  gpuMode: z.enum(['guest', 'host', 'auto']),
  memoryMb: z.number().int(),
  cpus: z.number(),
  stealthMode: z.boolean(),
  enablePlayStore: z.boolean().default(false),
  /** True when width/height/dpi were changed live; the next start recreates the container. */
  bootConfigDirty: z.boolean().default(false),
  proxy: z.string().nullable(),
  proxyConfig: ProxyConfigSchema.nullable().default(null),
  proxyProfileId: z.string().nullable().default(null),
  profile: DeviceProfileSchema,
  customProps: z.record(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const InstanceHealthSchema = z.object({
  instanceId: z.string(),
  containerRunning: z.boolean(),
  adbConnected: z.boolean(),
  bootCompleted: z.boolean(),
  cpuPercent: z.number().nullable(),
  memoryUsageMb: z.number().nullable(),
  memoryLimitMb: z.number().nullable(),
});

export const SnapshotRecordSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  name: z.string(),
  filePath: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.string(),
});

export const CloneInstanceSchema = z.object({
  name: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  randomizeIdentity: z.boolean().default(true),
  exposeAdbPort: z.boolean().default(false),
});

export type UpdateInstanceInput = z.infer<typeof UpdateInstanceSchema>;
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;
export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;
export type InstanceRecord = z.infer<typeof InstanceRecordSchema>;
export type InstanceHealth = z.infer<typeof InstanceHealthSchema>;
export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;
export type CloneInstanceInput = z.infer<typeof CloneInstanceSchema>;
