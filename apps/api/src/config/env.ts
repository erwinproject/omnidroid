import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(10001).max(65535).default(13000),
  API_HOST: z.string().default('0.0.0.0'),
  API_KEY: z.string().default('change-me-super-secret-api-key'),
  REQUIRE_AUTH: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  DOCKER_NETWORK: z.string().default('emulator-net'),
  REDROID_IMAGE_REPO: z.string().default('redroid/redroid'),
  ADB_PORT_MIN: z.coerce.number().int().min(10001).max(60000).default(15555),
  ADB_PORT_MAX: z.coerce.number().int().min(10002).max(65000).default(19999),
  DATA_DIR: z.string().default('./data'),
  ADB_BIN: z.string().default('adb'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(overrides?: Partial<Record<string, string>>): AppEnv {
  return EnvSchema.parse({ ...process.env, ...overrides });
}
