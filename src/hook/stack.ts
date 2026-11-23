import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url)).toLowerCase();
const SKIP = /node_modules|node:|ext:|\(native\)|<anonymous>$/;
const LOC = /(?:\()?((?:file:\/\/)?[^()\s][^()]*?):(\d+):(\d+)\)?$/;

export interface Site {
  frame: string | null;
  fn: string | null;
  exact: boolean;
}

interface Entry {
  n: number;
  frame: string | null;
  fn: string | null;
}

/**
 * First-seen capture: the first FIRST_N calls of any SQL text always capture a stack, so one slow query is never
 * left without a call site. After that we sample every SAMPLE_EVERY-th call and reuse the cached frame
 * (marked exact=false). The cache is bounded; an evicted text counts as unseen and gets captured again.
 */
export class SiteCache {
  private cache = new Map<string, Entry>();
  constructor(
    private readonly max = 4096,
    private readonly firstN = 3,
    private readonly sampleEvery = 64,
  ) {}

  site(sql: string): Site {
    const key = sql.length > 2048 ? sql.slice(0, 2048) + '#' + sql.length : sql;
    let e = this.cache.get(key);
    if (!e) {
      e = { n: 0, frame: null, fn: null };
      this.cache.set(key, e);
      if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value as string);
    }
    e.n++;
    if (e.n <= this.firstN || e.n % this.sampleEvery === 0) {
      const c = captureFrame();
      e.frame = c.frame;
      e.fn = c.fn;
      return { ...c, exact: true };
    }
    return { frame: e.frame, fn: e.fn, exact: false };
  }
}

/** First stack frame that is neither node internals, node_modules, nor this hook. */
export function captureFrame(): { frame: string | null; fn: string | null } {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 30; // restored below: the host app's own limit must not change
  let stack = '';
  try {
    stack = new Error().stack ?? '';
  } finally {
    Error.stackTraceLimit = prev;
  }
  for (const raw of stack.split('\n').slice(1)) {
    const line = raw.trim().replace(/^at /, '');
    if (!line || SKIP.test(line)) continue;
    const m = LOC.exec(line);
    if (!m) continue;
    let file = m[1];
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        /* keep raw */
      }
    }
    if (file.toLowerCase().startsWith(HOOK_DIR)) continue;
    const fn = /^(?:async )?([^\s(]+) \(/.exec(line)?.[1] ?? null;
    return { frame: `${file}:${m[2]}:${m[3]}`, fn };
  }
  return { frame: null, fn: null };
}
