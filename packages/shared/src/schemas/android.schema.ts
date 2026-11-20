import { z } from 'zod';

export const AndroidVersionSchema = z.enum(['11', '12', '13', '14', '15', '16']);

export type AndroidVersion = z.infer<typeof AndroidVersionSchema>;

export const PLAYSTORE_SUPPORTED_ANDROID_VERSIONS = ['12', '13', '14'] as const;

export function isPlayStoreSupportedAndroidVersion(version: AndroidVersion): boolean {
  return (PLAYSTORE_SUPPORTED_ANDROID_VERSIONS as readonly string[]).includes(version);
}
