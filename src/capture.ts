import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOOK_PATH = fileURLToPath(new URL('./hook/index.js', import.meta.url));

export function newRunDir(base = process.cwd()): string {
  const root = path.join(base, '.sql-anything');
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  // keep traces (they contain real query parameters) out of git without touching the user's .gitignore
  const gi = path.join(root, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.join(root, 'runs', `${ts}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function latestRunDir(base = process.cwd()): string | null {
  const runs = path.join(base, '.sql-anything', 'runs');
  if (!fs.existsSync(runs)) return null;
  const all = fs.readdirSync(runs).sort();
  return all.length ? path.join(runs, all[all.length - 1]) : null;
}

export interface CaptureOptions {
  cmd: string[];
  cwd?: string;
  traceDir: string;
  durationMs?: number;
  hits?: string[];
  hitRepeat?: number;
  env?: Record<string, string>;
  tagReq?: boolean;
  quiet?: boolean;
}

export interface CaptureResult {
  exitCode: number | null;
  stdout: string;
  hits: { url: string; status: number; ms: number; req: number | null; body: string }[];
  timedOut: boolean;
}

const WIN_SHELL_CMDS = /^(npm|npx|pnpm|yarn|bunx?|tsx|ts-node|nodemon)(\.cmd)?$/i;

/** Spawn a child with the hook injected. No shell unless Windows needs one for .cmd shims. */
export function spawnWithHook(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; traceDir: string; tagReq?: boolean }) {
  const hookUrl = pathToFileURL(HOOK_PATH).href; // percent-encoded: survives spaces and backslashes in NODE_OPTIONS
  const nodeOptions = [process.env.NODE_OPTIONS, `--import ${hookUrl}`].filter(Boolean).join(' ');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    NODE_OPTIONS: nodeOptions,
    SQL_ANYTHING_TRACE_DIR: opts.traceDir,
    ...(opts.tagReq ? { SQL_ANYTHING_TAG_REQ: '1' } : {}),
  };
  const [bin, ...args] = cmd;
  const useShell = process.platform === 'win32' && (WIN_SHELL_CMDS.test(path.basename(bin)) || /\.(cmd|bat)$/i.test(bin));
  const q = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return useShell
    ? spawn([bin, ...args].map(q).join(' '), { cwd: opts.cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(bin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as import('node:net').AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForUrl(url: string, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && alive()) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await sleep(150);
    }
  }
  return false;
}

export async function capture(o: CaptureOptions): Promise<CaptureResult> {
  const child = spawnWithHook(o.cmd, { cwd: o.cwd, env: o.env, traceDir: o.traceDir, tagReq: o.tagReq });
  let stdout = '';
  let exited = false;
  let exitCode: number | null = null;
  child.stdout?.on('data', (d) => {
    stdout += d;
    if (!o.quiet) process.stderr.write(d);
  });
  child.stderr?.on('data', (d) => {
    if (!o.quiet) process.stderr.write(d);
  });
  const done = new Promise<void>((res) => {
    child.on('exit', (c) => {
      exited = true;
      exitCode = c;
      res();
    });
    child.on('error', () => {
      exited = true;
      res();
    });
  });
  const hits: CaptureResult['hits'] = [];
  let timedOut = false;
  const timer = o.durationMs
    ? setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, o.durationMs)
    : null;
  if (o.hits?.length) {
    if (await waitForUrl(o.hits[0], 30_000, () => !exited)) {
      for (let i = 0; i < (o.hitRepeat ?? 1); i++) {
        for (const url of o.hits) {
          const t0 = performance.now();
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            const body = await res.text();
            const h = res.headers.get('x-sql-anything-req');
            hits.push({ url, status: res.status, ms: performance.now() - t0, req: h ? Number(h) : null, body });
          } catch {
            hits.push({ url, status: 0, ms: performance.now() - t0, req: null, body: '' });
          }
        }
      }
      await sleep(450); // the hook flushes its buffer every 200ms; a killed process can't flush on exit
      killTree(child.pid);
    } else {
      killTree(child.pid);
    }
  }
  await done;
  if (timer) clearTimeout(timer);
  return { exitCode, stdout, hits, timedOut };
}
