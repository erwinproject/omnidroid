import { z } from 'zod';

export const PruneCategorySchema = z.enum([
  'orphaned_container',
  'orphaned_volume',
  'anonymous_volume',
  'orphaned_snapshot',
  'orphaned_recording',
  'temp_file',
  'dangling_image',
  'unused_image',
  'build_cache',
]);

export const PruneOptionsSchema = z.object({
  dryRun: z.boolean().default(false),
  removeOrphanedContainers: z.boolean().default(true),
  removeOrphanedVolumes: z.boolean().default(true),
  removeOrphanedSnapshots: z.boolean().default(true),
  removeOrphanedRecordings: z.boolean().default(true),
  removeTempFiles: z.boolean().default(true),
  removeDanglingImages: z.boolean().default(true),
  removeUnusedRedroidImages: z.boolean().default(false),
  removeBuildCache: z.boolean().default(false),
  minTempFileAgeMs: z.number().int().min(0).default(60_000),
});

export const PruneItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: PruneCategorySchema,
  sizeBytes: z.number().int().min(0),
  reason: z.string(),
});

export const PruneSummaryCountsSchema = z.object({
  orphanedContainers: z.number().int().min(0),
  orphanedVolumes: z.number().int().min(0),
  anonymousVolumes: z.number().int().min(0),
  orphanedSnapshots: z.number().int().min(0),
  orphanedRecordings: z.number().int().min(0),
  tempFiles: z.number().int().min(0),
  danglingImages: z.number().int().min(0),
  unusedImages: z.number().int().min(0),
  buildCacheBytes: z.number().int().min(0),
});

export const PruneReportSchema = z.object({
  dryRun: z.boolean(),
  executedAt: z.string(),
  durationMs: z.number().int().min(0),
  reclaimedBytes: z.number().int().min(0),
  counts: PruneSummaryCountsSchema,
  items: z.array(PruneItemSchema),
  errors: z.array(z.string()),
});

export const DeleteInstanceResultSchema = z.object({
  deleted: z.boolean(),
  instanceId: z.string(),
  removedVolume: z.boolean(),
  removedSnapshotFiles: z.number().int().min(0),
  removedRecordingFiles: z.number().int().min(0),
  reclaimedBytes: z.number().int().min(0),
  prune: PruneReportSchema.nullable(),
});

export const DeleteSnapshotResultSchema = z.object({
  deleted: z.boolean(),
  snapshotId: z.string(),
  reclaimedBytes: z.number().int().min(0),
});

export type PruneCategory = z.infer<typeof PruneCategorySchema>;
export type PruneOptions = z.infer<typeof PruneOptionsSchema>;
export type PruneOptionsInput = z.input<typeof PruneOptionsSchema>;
export type PruneItem = z.infer<typeof PruneItemSchema>;
export type PruneSummaryCounts = z.infer<typeof PruneSummaryCountsSchema>;
export type PruneReport = z.infer<typeof PruneReportSchema>;
export type DeleteInstanceResult = z.infer<typeof DeleteInstanceResultSchema>;
export type DeleteSnapshotResult = z.infer<typeof DeleteSnapshotResultSchema>;
