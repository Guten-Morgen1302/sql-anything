/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface AgentSpec {
  name: string;
  cmd: string[];
}

export const CLAUDE_CMD = ['claude', '-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep'];

/** Find an executable on PATH, honoring PATHEXT on Windows. */
export function resolveBin(name: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = name.includes('/') || name.includes('\\') ? [''] : (process.env.PATH ?? '').split(path.delimiter);
  for (const d of dirs) {
    for (const e of ['', ...exts]) {
      const p = d ? path.join(d, name + e) : name + e;
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** An agent never sees the database: strip every variable that could carry a connection string. */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(DATABASE_URL|SQL_ANYTHING_DB_URL|PG[A-Z_]*|POSTGRES[A-Z_]*|DB_[A-Z_]*|MYSQL[A-Z_]*|NODE_OPTIONS|SQL_ANYTHING_TRACE_DIR)$/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export function resolveAgent(agent: string | undefined, agentCmd: string | undefined, split: (s: string) => string[]): AgentSpec | null {
  if (agentCmd) return { name: 'custom', cmd: split(agentCmd) };
  if (!agent || agent === 'none') return null;
  if (agent === 'claude') {
    if (!resolveBin('claude')) throw new Error('--agent claude: the `claude` CLI is not on PATH. Install Claude Code, or use --agent none for deterministic index fixes only.');
    return { name: 'claude', cmd: CLAUDE_CMD };
  }
  throw new Error(`unknown agent "${agent}". v0.1 supports: claude, none (or --agent-cmd "<command>" for any headless agent that reads its prompt on stdin).`);
}

export interface AgentRun {
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
}

/** Run the agent headless in `cwd`, prompt on stdin. */
export function runAgent(spec: AgentSpec, prompt: string, cwd: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<AgentRun> {
  return new Promise((resolve) => {
    const bin = resolveBin(spec.cmd[0]) ?? spec.cmd[0];
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const q = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    const env = scrubbedEnv(process.env, opts.env);
    const child = needsShell
      ? spawn([bin, ...spec.cmd.slice(1)].map(q).join(' '), { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(bin, spec.cmd.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (d: Buffer) => (tail = (tail + d.toString()).slice(-4000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 10 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, tail: String(e.message) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, tail });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
}
