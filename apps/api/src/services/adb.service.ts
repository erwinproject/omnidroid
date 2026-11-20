import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AdbExecutor {
  connect(target: string): Promise<boolean>;
  disconnect(target: string): Promise<void>;
  shell(target: string, command: string, timeoutMs?: number): Promise<ShellResult>;
  execOut(target: string, args: string[], timeoutMs?: number): Promise<Buffer>;
  screencapPng(target: string): Promise<Buffer>;
  installApk(target: string, apkPath: string, options?: { grantPermissions?: boolean; reinstall?: boolean; abi?: string }): Promise<ShellResult>;
  pushFile(target: string, localPath: string, remotePath: string): Promise<ShellResult>;
  pullFile(target: string, remotePath: string, localPath: string): Promise<ShellResult>;
  isBootCompleted(target: string): Promise<boolean>;
  getPublicKey?(): Promise<string | null>;
  isAuthorized?(target: string): Promise<boolean>;
  spawnLogcat(target: string, args?: string[]): ChildProcess;
  installMultiple?(target: string, apkPaths: string[]): Promise<ShellResult>;
  forward?(target: string, remote: string): Promise<number>;
  removeForward?(target: string, localPort: number): Promise<void>;
  spawnShell?(target: string, command: string): ChildProcess;
  /** Persistent-session shell for low latency input; resolves when the command was written. */
  fastShell?(target: string, command: string): Promise<void>;
}

export class AdbService implements AdbExecutor {
  private readonly adbBin: string;

  constructor(adbBin = 'adb') {
    this.adbBin = adbBin;
  }

  private async runAdb(args: string[], timeoutMs = 15000): Promise<ShellResult> {
    try {
      const { stdout, stderr } = await execFileAsync(this.adbBin, args, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: typeof e.code === 'number' ? e.code : 1,
        stdout: (e.stdout ?? '').trim(),
        stderr: (e.stderr ?? e.message ?? 'ADB command failed').trim(),
      };
    }
  }

  async connect(target: string): Promise<boolean> {
    const res = await this.runAdb(['connect', target], 8000);
    const out = `${res.stdout} ${res.stderr}`.toLowerCase();
    return res.exitCode === 0 && (out.includes('connected') || out.includes('already connected'));
  }

  async disconnect(target: string): Promise<void> {
    await this.runAdb(['disconnect', target], 5000);
  }

  async shell(target: string, command: string, timeoutMs = 15000): Promise<ShellResult> {
    return this.runAdb(['-s', target, 'shell', command], timeoutMs);
  }

  async execOut(target: string, args: string[], timeoutMs = 15000): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.adbBin, ['-s', target, 'exec-out', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ADB exec-out timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(Buffer.concat(errChunks).toString('utf8') || `ADB exec-out exited with ${code}`));
        }
      });
    });
  }

  async screencapPng(target: string): Promise<Buffer> {
    return this.execOut(target, ['screencap', '-p'], 10000);
  }

  async installApk(
    target: string,
    apkPath: string,
    options?: { grantPermissions?: boolean; reinstall?: boolean; abi?: string },
  ): Promise<ShellResult> {
    const flags: string[] = [];
    if (options?.reinstall !== false) flags.push('-r');
    if (options?.grantPermissions !== false) flags.push('-g');
    if (options?.abi) flags.push('--abi', options.abi);
    return this.runAdb(['-s', target, 'install', ...flags, apkPath], 120000);
  }

  async pushFile(target: string, localPath: string, remotePath: string): Promise<ShellResult> {
    return this.runAdb(['-s', target, 'push', localPath, remotePath], 60000);
  }

  async pullFile(target: string, remotePath: string, localPath: string): Promise<ShellResult> {
    return this.runAdb(['-s', target, 'pull', remotePath, localPath], 60000);
  }

  async isBootCompleted(target: string): Promise<boolean> {
    const res = await this.shell(target, 'getprop sys.boot_completed', 4000);
    return res.exitCode === 0 && res.stdout.trim() === '1';
  }

  async getPublicKey(): Promise<string | null> {
    const pubKeyPath = path.join(os.homedir(), '.android', 'adbkey.pub');
    if (!fs.existsSync(pubKeyPath)) {
      await this.runAdb(['start-server'], 8000);
    }
    if (!fs.existsSync(pubKeyPath)) {
      return null;
    }
    const key = fs.readFileSync(pubKeyPath, 'utf8').trim();
    return key.length > 0 ? key : null;
  }

  async isAuthorized(target: string): Promise<boolean> {
    const res = await this.runAdb(['-s', target, 'get-state'], 5000);
    return res.exitCode === 0 && res.stdout.trim() === 'device';
  }

  async installMultiple(target: string, apkPaths: string[]): Promise<ShellResult> {
    return this.runAdb(['-s', target, 'install-multiple', '-r', '-g', ...apkPaths], 180000);
  }

  async forward(target: string, remote: string): Promise<number> {
    const res = await this.runAdb(['-s', target, 'forward', 'tcp:0', remote], 8000);
    const port = Number.parseInt(res.stdout.split(/\s+/)[0] ?? '', 10);
    if (res.exitCode !== 0 || !Number.isInteger(port) || port <= 0) {
      throw new Error(res.stderr || res.stdout || 'adb forward failed');
    }
    return port;
  }

  async removeForward(target: string, localPort: number): Promise<void> {
    await this.runAdb(['-s', target, 'forward', '--remove', `tcp:${localPort}`], 5000);
  }

  spawnShell(target: string, command: string): ChildProcess {
    return spawn(this.adbBin, ['-s', target, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  private readonly fastSessions = new Map<string, ChildProcess>();

  async fastShell(target: string, command: string): Promise<void> {
    let child = this.fastSessions.get(target);
    if (!child || child.killed || child.exitCode !== null || !child.stdin?.writable) {
      child = spawn(this.adbBin, ['-s', target, 'shell'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('exit', () => {
        if (this.fastSessions.get(target) === child) this.fastSessions.delete(target);
      });
      child.on('error', () => {
        if (this.fastSessions.get(target) === child) this.fastSessions.delete(target);
      });
      this.fastSessions.set(target, child);
    }
    const stdin = child.stdin;
    if (!stdin) throw new Error('adb shell session unavailable');
    await new Promise<void>((resolve, reject) => {
      stdin.write(command + '\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  spawnLogcat(target: string, args: string[] = []): ChildProcess {
    return spawn(this.adbBin, ['-s', target, 'logcat', '-v', 'time', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}
