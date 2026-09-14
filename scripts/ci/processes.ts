import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';
import { get } from 'node:https';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

/** 每个子进程拥有独立进程组，测试超时/信号退出时同时回收其浏览器和 Worker。 */
export class Processes {
  private children = new Set<ChildProcess>();
  constructor(
    readonly report: string,
    readonly env: NodeJS.ProcessEnv,
  ) {}
  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  async close(): Promise<void> {
    const children = [...this.children];
    for (const child of children) this.kill(child, 'SIGTERM');
    // 进程组主进程退出并不保证 Chromium 后代已退出，始终回收剩余组成员。
    if (children.length) await delay(300);
    for (const child of children) this.kill(child, 'SIGKILL');
    this.children.clear();
  }
  start(name: string, command: string, args: string[], echo = false): { child: ChildProcess; done: Promise<void> } {
    const log = createWriteStream(join(this.report, `${name}.log`));
    const child = spawn(command, args, { env: this.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    if (echo) {
      child.stdout!.pipe(process.stdout, { end: false });
      child.stderr!.pipe(process.stderr, { end: false });
    }
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        log.end();
        if (code === 0) resolve();
        else reject(new Error(`${name} 失败：${signal ?? code}；日志 ${join(this.report, `${name}.log`)}`));
      });
    });
    // 后台服务在 readiness 或最终清理前退出，也不产生未处理的 rejection。
    void done.catch(() => {});
    return { child, done };
  }
  async run(name: string, minutes: number, command: string, args: string[]): Promise<void> {
    console.log(`开始：${name}`);
    const { child, done } = this.start(name, command, args, true);
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      this.kill(child, 'SIGKILL');
    }, minutes * 60_000);
    try {
      await done;
      if (expired) throw new Error(`${name} 超时`);
      await appendFile(join(this.report, 'results.txt'), `${name} PASS\n`);
    } finally {
      clearTimeout(timeout);
      this.kill(child, 'SIGKILL');
      this.children.delete(child);
    }
  }
  async vite(port: number): Promise<void> {
    const origin = `https://127.0.0.1:${port}`;
    const { child, done } = this.start('vite', process.execPath, [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ]);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        await done;
        throw new Error('Vite 提前退出');
      }
      const log = join(this.report, 'vite.log');
      if (
        existsSync(log) &&
        stripVTControlCharacters(await readFile(log, 'utf8')).includes(origin) &&
        (await reachable(origin))
      )
        return;
      await delay(1000);
    }
    console.error(await readFile(join(this.report, 'vite.log'), 'utf8'));
    throw new Error('Vite 启动超时');
  }
}
function reachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(url, { rejectUnauthorized: false, timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}
