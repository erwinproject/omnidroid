import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InstanceRecord } from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { AdbExecutor } from './adb.service.js';

export interface ChromeApkTarget {
  arch: 'x86' | 'arm64';
  url: string;
  fileName: string;
  installAbi?: string;
}

export interface EnsureChromeResult {
  installed: boolean;
  source: 'skipped' | 'builtin' | 'provisioned' | 'error';
  detail?: string;
}

const MIN_CHROME_APK_BYTES = 10 * 1024 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PREINSTALLED_CHROME_APK = '/system/product/etc/preinstall/Chrome.apk';

export function selectChromeApkTarget(
  abiList: string,
  env: Pick<AppEnv, 'CHROME_APK_URL_X86' | 'CHROME_APK_URL_ARM64'>,
): ChromeApkTarget {
  if (abiList.toLowerCase().includes('x86')) {
    return {
      arch: 'x86',
      url: env.CHROME_APK_URL_X86,
      fileName: 'chrome-136.0.7103.125-x86.apk',
      installAbi: 'x86',
    };
  }
  return {
    arch: 'arm64',
    url: env.CHROME_APK_URL_ARM64,
    fileName: 'chrome-136.0.7103.125-arm64.apk',
  };
}

function isValidCachedApk(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= MIN_CHROME_APK_BYTES) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, header, 0, 4, 0);
      return bytesRead === 4 && header.equals(ZIP_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export class ChromeService {
  private readonly inFlightDownloads = new Map<string, Promise<string>>();
  private readonly inFlightInstalls = new Map<string, Promise<EnsureChromeResult>>();

  constructor(
    private readonly env: AppEnv,
    private readonly adb: AdbExecutor,
  ) {}

  async ensureChromeInstalled(instance: InstanceRecord): Promise<EnsureChromeResult> {
    if (!this.env.AUTO_INSTALL_CHROME || this.env.NODE_ENV === 'test') {
      return { installed: false, source: 'skipped' };
    }

    const existingJob = this.inFlightInstalls.get(instance.id);
    if (existingJob) {
      return existingJob;
    }

    const job = this.runEnsureChromeInstalled(instance).finally(() => {
      this.inFlightInstalls.delete(instance.id);
    });
    this.inFlightInstalls.set(instance.id, job);
    return job;
  }

  private async runEnsureChromeInstalled(instance: InstanceRecord): Promise<EnsureChromeResult> {
    const existing = await this.adb.shell(instance.adbTarget, 'pm path com.android.chrome 2>/dev/null || true');
    if (existing.stdout.includes('package:')) {
      return { installed: true, source: 'builtin' };
    }

    const preinstallCheck = await this.adb.shell(
      instance.adbTarget,
      `test -f ${PREINSTALLED_CHROME_APK} && echo yes || true`,
    );
    if (preinstallCheck.stdout.trim() === 'yes') {
      const installPreinstalled = await this.adb.shell(
        instance.adbTarget,
        `pm install -r -g --abi x86 ${PREINSTALLED_CHROME_APK}`,
        120000,
      );
      const verified = await this.adb.shell(instance.adbTarget, 'pm path com.android.chrome 2>/dev/null || true');
      if (verified.stdout.includes('package:')) {
        return { installed: true, source: 'builtin', detail: installPreinstalled.stdout };
      }
    }

    const abiRes = await this.adb.shell(instance.adbTarget, 'getprop ro.product.cpu.abilist');
    const target = selectChromeApkTarget(abiRes.stdout, this.env);

    const apkPath = await this.ensureCachedApk(target);
    const installRes = await this.adb.installApk(instance.adbTarget, apkPath, {
      grantPermissions: true,
      reinstall: true,
      ...(target.installAbi ? { abi: target.installAbi } : {}),
    });

    if (installRes.exitCode === 0) {
      return { installed: true, source: 'provisioned', detail: installRes.stdout };
    }
    return {
      installed: false,
      source: 'error',
      detail: installRes.stderr || installRes.stdout || 'Failed to install Chrome APK',
    };
  }

  private async ensureCachedApk(target: ChromeApkTarget): Promise<string> {
    const cacheDir = path.resolve(this.env.DATA_DIR, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const apkPath = path.join(cacheDir, target.fileName);

    if (isValidCachedApk(apkPath)) {
      return apkPath;
    }

    const inFlight = this.inFlightDownloads.get(target.fileName);
    if (inFlight) {
      return inFlight;
    }

    const downloadPromise = (async () => {
      const tmpPath = `${apkPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        const res = await fetch(target.url, { redirect: 'follow' });
        if (!res.ok || !res.body) {
          throw new Error(`Failed to download Chrome APK (${res.status} ${res.statusText})`);
        }
        await pipeline(
          Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
          fs.createWriteStream(tmpPath),
        );
        if (!isValidCachedApk(tmpPath)) {
          throw new Error(`Downloaded Chrome APK failed size/ZIP validation: ${target.fileName}`);
        }
        fs.renameSync(tmpPath, apkPath);
        return apkPath;
      } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        throw err;
      } finally {
        this.inFlightDownloads.delete(target.fileName);
      }
    })();

    this.inFlightDownloads.set(target.fileName, downloadPromise);
    return downloadPromise;
  }
}
