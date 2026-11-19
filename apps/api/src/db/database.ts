import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BUILTIN_DEVICE_PROFILES,
  parseProxyString,
  type DeviceProfile,
  type InstanceRecord,
  type InstanceStatus,
  type ProxyProfile,
  type SnapshotRecord,
} from '@droidforge/shared';

function normalizeInstance(raw: InstanceRecord): InstanceRecord {
  let proxyConfig = raw.proxyConfig ?? null;
  if (!proxyConfig && raw.proxy) {
    try {
      proxyConfig = parseProxyString(raw.proxy);
    } catch {
      proxyConfig = null;
    }
  }
  return {
    ...raw,
    enablePlayStore: raw.enablePlayStore ?? false,
    proxyProfileId: raw.proxyProfileId ?? null,
    proxyConfig,
  };
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        host_adb_port INTEGER UNIQUE,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  // ---- Profiles ----
  listProfiles(): DeviceProfile[] {
    const rows = this.db.prepare('SELECT data FROM profiles ORDER BY created_at DESC').all() as Array<{
      data: string;
    }>;
    const custom = rows.map((r) => JSON.parse(r.data) as DeviceProfile);
    return [...BUILTIN_DEVICE_PROFILES, ...custom];
  }

  getProfile(id: string): DeviceProfile | undefined {
    const builtIn = BUILTIN_DEVICE_PROFILES.find((p) => p.id === id);
    if (builtIn) return builtIn;
    const row = this.db.prepare('SELECT data FROM profiles WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as DeviceProfile) : undefined;
  }

  saveProfile(profile: DeviceProfile): void {
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT OR REPLACE INTO profiles (id, data, created_at) VALUES (?, ?, ?)')
      .run(profile.id, JSON.stringify(profile), now);
  }

  deleteProfile(id: string): boolean {
    const res = this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  // ---- Proxies ----
  listProxies(): ProxyProfile[] {
    const rows = this.db.prepare('SELECT data FROM proxies ORDER BY created_at DESC').all() as Array<{
      data: string;
    }>;
    return rows.map((r) => JSON.parse(r.data) as ProxyProfile);
  }

  getProxy(id: string): ProxyProfile | undefined {
    const row = this.db.prepare('SELECT data FROM proxies WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as ProxyProfile) : undefined;
  }

  saveProxy(proxy: ProxyProfile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO proxies (id, name, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(proxy.id, proxy.name, JSON.stringify(proxy), proxy.createdAt, proxy.updatedAt);
  }

  deleteProxy(id: string): boolean {
    const res = this.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  // ---- Instances ----
  listInstances(): InstanceRecord[] {
    const rows = this.db.prepare('SELECT data FROM instances ORDER BY created_at DESC').all() as Array<{
      data: string;
    }>;
    return rows.map((r) => normalizeInstance(JSON.parse(r.data) as InstanceRecord));
  }

  getInstance(id: string): InstanceRecord | undefined {
    const row = this.db.prepare('SELECT data FROM instances WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    return row ? normalizeInstance(JSON.parse(row.data) as InstanceRecord) : undefined;
  }

  getInstanceByName(name: string): InstanceRecord | undefined {
    const row = this.db.prepare('SELECT data FROM instances WHERE name = ?').get(name) as
      | { data: string }
      | undefined;
    return row ? normalizeInstance(JSON.parse(row.data) as InstanceRecord) : undefined;
  }

  saveInstance(instance: InstanceRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO instances (id, name, host_adb_port, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instance.id,
        instance.name,
        instance.hostAdbPort,
        instance.status,
        JSON.stringify(instance),
        instance.createdAt,
        instance.updatedAt,
      );
  }

  updateInstanceStatus(id: string, status: InstanceStatus, containerId?: string | null): InstanceRecord | undefined {
    const inst = this.getInstance(id);
    if (!inst) return undefined;
    const updated: InstanceRecord = {
      ...inst,
      status,
      ...(containerId !== undefined ? { containerId } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.saveInstance(updated);
    return updated;
  }

  deleteInstance(id: string): boolean {
    this.db.prepare('DELETE FROM snapshots WHERE instance_id = ?').run(id);
    const res = this.db.prepare('DELETE FROM instances WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  allocateUniqueAdbPort(minPort: number, maxPort: number): number {
    const rows = this.db
      .prepare('SELECT host_adb_port FROM instances WHERE host_adb_port IS NOT NULL')
      .all() as Array<{ host_adb_port: number }>;
    const used = new Set(rows.map((r) => r.host_adb_port));
    for (let p = minPort; p <= maxPort; p++) {
      if (!used.has(p)) {
        return p;
      }
    }
    throw new Error(`No available unique ADB ports in range ${minPort}-${maxPort}`);
  }

  // ---- Snapshots ----
  listSnapshots(instanceId: string): SnapshotRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, instance_id, name, file_path, size_bytes, created_at FROM snapshots WHERE instance_id = ? ORDER BY created_at DESC',
      )
      .all(instanceId) as Array<{
      id: string;
      instance_id: string;
      name: string;
      file_path: string;
      size_bytes: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      name: r.name,
      filePath: r.file_path,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    }));
  }

  getSnapshot(snapId: string): SnapshotRecord | undefined {
    const r = this.db
      .prepare('SELECT id, instance_id, name, file_path, size_bytes, created_at FROM snapshots WHERE id = ?')
      .get(snapId) as
      | {
          id: string;
          instance_id: string;
          name: string;
          file_path: string;
          size_bytes: number;
          created_at: string;
        }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      instanceId: r.instance_id,
      name: r.name,
      filePath: r.file_path,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    };
  }

  saveSnapshot(snap: SnapshotRecord): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (id, instance_id, name, file_path, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(snap.id, snap.instanceId, snap.name, snap.filePath, snap.sizeBytes, snap.createdAt);
  }

  close(): void {
    this.db.close();
  }
}
