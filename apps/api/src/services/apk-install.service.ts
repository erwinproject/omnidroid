import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { AdbExecutor } from './adb.service.js';

export type PackageKind = 'apk' | 'bundle';

export interface InstallResult {
  name: string;
  ok: boolean;
  kind: PackageKind;
  output?: string;
  error?: string;
  obbFiles?: number;
}

const MAX_UNCOMPRESSED_BYTES = 6 * 1024 * 1024 * 1024;

export function detectPackageKind(fileName: string): PackageKind | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.apk') return 'apk';
  if (ext === '.xapk' || ext === '.apks' || ext === '.apkm' || ext === '.zip') return 'bundle';
  return null;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resultFromAdb(name: string, kind: PackageKind, res: { exitCode: number; stdout: string; stderr: string }): InstallResult {
  const output = (res.stdout || '').trim();
  const success = res.exitCode === 0 && /success/i.test(output || 'Success');
  return success
    ? { name, ok: true, kind, output }
    : { name, ok: false, kind, error: (res.stderr || output || 'Install failed').trim() };
}

/**
 * Installs a single uploaded package. Supports plain APKs and split bundles
 * (.xapk / .apks / .apkm) including OBB expansion files.
 */
export async function installPackageFile(
  adb: AdbExecutor,
  target: string,
  filePath: string,
  originalName: string,
  workDir: string,
): Promise<InstallResult> {
  const kind = detectPackageKind(originalName);
  if (!kind) {
    return { name: originalName, ok: false, kind: 'apk', error: 'Unsupported file type (use .apk, .xapk, .apks or .apkm)' };
  }

  if (kind === 'apk') {
    const res = await adb.installApk(target, filePath, { grantPermissions: true, reinstall: true });
    return resultFromAdb(originalName, kind, res);
  }

  const extractDir = path.join(workDir, `bundle_${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    const total = entries.reduce((sum, e) => sum + e.header.size, 0);
    if (total > MAX_UNCOMPRESSED_BYTES) {
      return { name: originalName, ok: false, kind, error: 'Bundle is too large to extract' };
    }

    const hasSplits = entries.some((e) => /(^|\/)splits\/[^/]+\.apk$/i.test(e.entryName));
    const apkEntries = entries.filter((e) => {
      const lower = e.entryName.toLowerCase();
      if (!lower.endsWith('.apk')) return false;
      if (hasSplits && lower.includes('standalones/')) return false;
      return true;
    });
    const universal = apkEntries.find((e) => path.posix.basename(e.entryName).toLowerCase() === 'universal.apk');
    const selected = universal ? [universal] : apkEntries;
    if (selected.length === 0) {
      return { name: originalName, ok: false, kind, error: 'No APK found inside the bundle' };
    }

    // Flatten entry names (basename only) to prevent zip-slip path traversal.
    const apkPaths: string[] = [];
    selected.forEach((entry, index) => {
      const dest = path.join(extractDir, `${index}_${path.posix.basename(entry.entryName).replace(/[^\w.\-+]/g, '_')}`);
      fs.writeFileSync(dest, entry.getData());
      apkPaths.push(dest);
    });

    let res;
    if (apkPaths.length === 1) {
      res = await adb.installApk(target, apkPaths[0]!, { grantPermissions: true, reinstall: true });
    } else if (adb.installMultiple) {
      res = await adb.installMultiple(target, apkPaths);
    } else {
      return { name: originalName, ok: false, kind, error: 'Split APK install is not supported by this ADB backend' };
    }

    const result = resultFromAdb(originalName, kind, res);
    if (!result.ok) return result;

    // XAPK expansion files: Android/obb/<package>/<file>.obb
    let obbCount = 0;
    for (const entry of entries) {
      const match = /^Android\/obb\/([A-Za-z0-9_.]+)\/([^/]+\.obb)$/.exec(entry.entryName);
      if (!match) continue;
      const [, pkg, obbName] = match;
      const local = path.join(extractDir, `obb_${obbCount}.obb`);
      fs.writeFileSync(local, entry.getData());
      const remoteDir = `/sdcard/Android/obb/${pkg}`;
      await adb.shell(target, `mkdir -p ${shQuote(remoteDir)}`);
      const pushed = await adb.pushFile(target, local, `${remoteDir}/${obbName}`);
      if (pushed.exitCode === 0) obbCount += 1;
    }
    return { ...result, obbFiles: obbCount };
  } catch (err) {
    return { name: originalName, ok: false, kind, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}
