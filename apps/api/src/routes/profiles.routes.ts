import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CreateDeviceProfileSchema,
  generateRealisticIdentity,
  type DeviceProfile,
} from '@droidforge/shared';
import type { AppContext } from '../context.js';

export function registerProfileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/profiles', { schema: { tags: ['Profiles'], summary: 'List built-in & custom device profiles' } }, async () => {
    return ctx.store.listProfiles();
  });

  app.get('/api/v1/profiles/:id', { schema: { tags: ['Profiles'], summary: 'Get device profile by ID' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = ctx.store.getProfile(id);
    if (!profile) return reply.code(404).send({ error: `Profile not found: ${id}` });
    return profile;
  });

  app.post('/api/v1/profiles', { schema: { tags: ['Profiles'], summary: 'Create a custom device profile (model, brand, build type, fingerprint)' } }, async (req, reply) => {
    const parsed = CreateDeviceProfileSchema.parse(req.body);
    const id = parsed.id ?? `custom-${crypto.randomBytes(3).toString('hex')}`;
    const existing = ctx.store.getProfile(id);
    if (existing?.isBuiltIn) {
      return reply.code(409).send({ error: `Cannot overwrite built-in profile: ${id}` });
    }
    const profile: DeviceProfile = {
      ...parsed,
      id,
      isBuiltIn: false,
    };
    ctx.store.saveProfile(profile);
    return reply.code(201).send(profile);
  });

  app.put('/api/v1/profiles/:id', { schema: { tags: ['Profiles'], summary: 'Update an existing custom device profile' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = ctx.store.getProfile(id);
    if (!existing) return reply.code(404).send({ error: `Profile not found: ${id}` });
    if (existing.isBuiltIn) {
      return reply.code(409).send({ error: `Cannot modify built-in profile: ${id}` });
    }
    const parsed = CreateDeviceProfileSchema.parse(req.body);
    const profile: DeviceProfile = {
      ...parsed,
      id,
      isBuiltIn: false,
    };
    ctx.store.saveProfile(profile);
    return reply.code(200).send(profile);
  });

  app.delete('/api/v1/profiles/:id', { schema: { tags: ['Profiles'], summary: 'Delete a custom device profile' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = ctx.store.getProfile(id);
    if (!existing) return reply.code(404).send({ error: `Profile not found: ${id}` });
    if (existing.isBuiltIn) return reply.code(400).send({ error: 'Cannot delete built-in profile' });
    const deleted = ctx.store.deleteProfile(id);
    return { deleted };
  });

  app.post('/api/v1/profiles/generate-identity', { schema: { tags: ['Profiles'], summary: 'Generate realistic serialNo, ANDROID_ID, MAC address, and battery level' } }, async (req) => {
    const body = (req.body ?? {}) as { macOui?: string };
    return generateRealisticIdentity(body.macOui);
  });
}
