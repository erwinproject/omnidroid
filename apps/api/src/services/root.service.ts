import fs from 'node:fs';
import type {
  InstanceRecord,
  RootAuditEntry,
  RootConfig,
  RootStatusResponse,
} from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { RedroidDockerManager } from '../docker/redroid-docker.manager.js';
import type { ShellResult } from './adb.service.js';

const ROOT_DIR = '/data/adb/droidforge';
const DAEMON_BIN = `${ROOT_DIR}/df-su`;
const POLICY_FILE = 'root_policy.conf';

const FIND_DAEMON_PIDS =
  'for p in /proc/[0-9]*; do ' +
  '[ "${p##*/}" = "$$" ] && continue; ' +
  'c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null || true); ' +
  `case "$c" in "${DAEMON_BIN} --daemon"*) echo "\${p##*/}";; esac; ` +
  'done';

export function parsePackagesList(content: string): {
  pkgToUid: Map<string, number>;
  uidToPkg: Map<number, string>;
} {
  const pkgToUid = new Map<string, number>();
  const uidToPkg = new Map<number, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pkg = parts[0];
    const uid = Number.parseInt(parts[1] ?? '', 10);
    if (!pkg || !Number.isInteger(uid) || uid < 0) continue;
    pkgToUid.set(pkg, uid);
    if (!uidToPkg.has(uid)) uidToPkg.set(uid, pkg);
  }
  return { pkgToUid, uidToPkg };
}

export function buildRootPolicyFile(config: RootConfig, pkgToUid: Map<string, number>): string {
  const lines = [
    `mode=${config.enabled ? config.mode : 'disabled'}`,
    `adb_root=${config.adbRoot ? '1' : '0'}`,
  ];
  if (config.enabled && config.mode === 'allowlist') {
    const seen = new Set<number>();
    for (const pkg of config.allowedPackages) {
      const uid = pkgToUid.get(pkg);
      if (uid !== undefined && !seen.has(uid)) {
        seen.add(uid);
        lines.push(`uid=${uid}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function parseSuAuditLog(content: string, uidToPkg: Map<number, string>): RootAuditEntry[] {
  const entries: RootAuditEntry[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(ALLOW|DENY)\s+(.*)$/);
    if (!match) continue;
    const epoch = Number.parseInt(match[1]!, 10);
    const uid = Number.parseInt(match[2]!, 10);
    const pid = Number.parseInt(match[3]!, 10);
    const allowed = match[4] === 'ALLOW';
    const command = match[5] ?? '';
    const packageName = uid === 0 ? 'root' : uid === 2000 ? 'com.android.shell' : (uidToPkg.get(uid) ?? null);
    entries.push({
      timestamp: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : new Date(0).toISOString(),
      uid,
      packageName,
      pid,
      allowed,
      command,
    });
  }
  return entries.reverse();
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export class RootService {
  constructor(
    private readonly env: AppEnv,
    private readonly docker: RedroidDockerManager,
  ) {}

  private async readPackagesList(containerId: string): Promise<{
    pkgToUid: Map<string, number>;
    uidToPkg: Map<number, string>;
  }> {
    const res = await this.docker
      .execInContainer(containerId, ['sh', '-c', 'cat /data/system/packages.list 2>/dev/null || true'], {
        timeoutMs: 8000,
      })
      .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    return parsePackagesList(res.stdout);
  }

  /** Applies the instance's rootConfig inside a running Redroid container (no reboot required). */
  async apply(instance: InstanceRecord): Promise<void> {
    if (!instance.containerId) return;
    const stats = await this.docker.getContainerStats(instance.containerId);
    if (!stats.running) return;

    const { pkgToUid } = await this.readPackagesList(instance.containerId);
    const policyText = buildRootPolicyFile(instance.rootConfig, pkgToUid);

    if (instance.rootConfig.enabled) {
      if (!fs.existsSync(this.env.DF_SU_BIN_PATH)) {
        throw new Error(`Root binary not found at ${this.env.DF_SU_BIN_PATH}`);
      }
      const binBuf = fs.readFileSync(this.env.DF_SU_BIN_PATH);

      await this.docker.execInContainer(instance.containerId, [
        'sh',
        '-c',
        `mkdir -p ${ROOT_DIR} && chmod 0755 ${ROOT_DIR}`,
      ]);
      await this.docker.putFileToContainer(instance.containerId, ROOT_DIR, 'df-su', binBuf, 0o755);
      await this.docker.putFileToContainer(
        instance.containerId,
        ROOT_DIR,
        POLICY_FILE,
        Buffer.from(policyText, 'utf8'),
        0o644,
      );

      const installRes = await this.docker.execInContainer(instance.containerId, [
        'sh',
        '-c',
        `mkdir -p /system/xbin && chmod 0755 /system/xbin && rm -f /system/bin/su /system/xbin/su && cp ${DAEMON_BIN} /system/bin/su && cp ${DAEMON_BIN} /system/xbin/su && chown 0:0 /system/bin/su /system/xbin/su && chmod 0755 /system/bin/su /system/xbin/su`,
      ]);
      if (installRes.exitCode !== 0) {
        throw new Error(installRes.stderr.trim() || 'Failed to install su binary in Redroid container');
      }

      const daemonCheck = await this.docker.execInContainer(instance.containerId, [
        'sh',
        '-c',
        `pids=$(${FIND_DAEMON_PIDS}); if [ -n "$pids" ]; then echo RUNNING; else echo STOPPED; fi`,
      ]);
      if (!daemonCheck.stdout.includes('RUNNING')) {
        await this.docker.execInContainer(instance.containerId, [DAEMON_BIN, '--daemon'], { detach: true });
        await new Promise((r) => setTimeout(r, 150));
      }
    } else {
      await this.docker.execInContainer(instance.containerId, [
        'sh',
        '-c',
        `pids=$(${FIND_DAEMON_PIDS}); if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi; rm -f /system/bin/su /system/xbin/su`,
      ]);
      const dirCheck = await this.docker
        .execInContainer(instance.containerId, ['sh', '-c', `test -d ${ROOT_DIR} && echo YES || echo NO`])
        .catch(() => ({ exitCode: 1, stdout: 'NO', stderr: '' }));
      if (dirCheck.stdout.includes('YES')) {
        await this.docker.putFileToContainer(
          instance.containerId,
          ROOT_DIR,
          POLICY_FILE,
          Buffer.from(policyText, 'utf8'),
          0o644,
        );
      }
    }
  }

  async getStatus(instance: InstanceRecord): Promise<RootStatusResponse> {
    const base = {
      instanceId: instance.id,
      enabled: instance.rootConfig.enabled,
      mode: instance.rootConfig.mode,
      adbRoot: instance.rootConfig.adbRoot,
      allowedPackages: instance.rootConfig.allowedPackages,
    };

    if (!instance.containerId || instance.status === 'stopped') {
      return {
        ...base,
        daemonRunning: false,
        suBinaryPresent: false,
        recentLogs: [],
      };
    }

    const stats = await this.docker.getContainerStats(instance.containerId);
    if (!stats.running) {
      return {
        ...base,
        daemonRunning: false,
        suBinaryPresent: false,
        recentLogs: [],
      };
    }

    const script = [
      'echo "===DAEMON==="',
      `pids=$(${FIND_DAEMON_PIDS}); if [ -n "$pids" ]; then echo RUNNING; else echo STOPPED; fi`,
      'echo "===SU_BIN==="',
      'if [ -x /system/bin/su ] || [ -x /system/xbin/su ]; then echo PRESENT; else echo ABSENT; fi',
      'echo "===PKGS==="',
      'cat /data/system/packages.list 2>/dev/null || true',
      'echo "===LOG==="',
      `tail -n 50 ${ROOT_DIR}/su.log 2>/dev/null || true`,
    ].join('\n');

    const res = await this.docker
      .execInContainer(instance.containerId, ['sh', '-c', script], { timeoutMs: 8000 })
      .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));

    const out = res.stdout;
    const extract = (marker: string, next?: string): string => {
      const startToken = `===${marker}===`;
      const startIdx = out.indexOf(startToken);
      if (startIdx < 0) return '';
      const from = startIdx + startToken.length;
      const endIdx = next ? out.indexOf(`===${next}===`, from) : -1;
      return (endIdx >= 0 ? out.slice(from, endIdx) : out.slice(from)).trim();
    };

    const daemonRunning = extract('DAEMON', 'SU_BIN').includes('RUNNING');
    const suBinaryPresent = extract('SU_BIN', 'PKGS').includes('PRESENT');
    const { uidToPkg } = parsePackagesList(extract('PKGS', 'LOG'));
    const recentLogs = parseSuAuditLog(extract('LOG'), uidToPkg);

    return {
      ...base,
      daemonRunning,
      suBinaryPresent,
      recentLogs,
    };
  }

  async runRootShell(instance: InstanceRecord, command: string, timeoutMs = 15000): Promise<ShellResult> {
    if (!instance.rootConfig.enabled) {
      throw httpError(403, 'Root access is disabled on this instance. Enable Root first.');
    }
    if (!instance.containerId) {
      throw httpError(409, 'Instance container is not created');
    }
    const stats = await this.docker.getContainerStats(instance.containerId);
    if (!stats.running) {
      throw httpError(409, 'Instance container is not running');
    }
    const res = await this.docker.execInContainer(instance.containerId, ['sh', '-c', command], { timeoutMs });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout.trimEnd(),
      stderr: res.stderr.trimEnd(),
    };
  }
}
