import type { Tagged } from './params.js';

/** One captured statement. JSONL, one per line. `v` is the schema version. */
export interface TraceRecord {
  v: 1;
  type: 'q';
  /** epoch ms at call time */
  t: number;
  seq: number;
  pid: number;
  thread: number;
  db: 'pg' | 'better-sqlite3' | 'node:sqlite';
  op: string;
  sql: string;
  /** true when the SQL text was cut at the size cap: such a statement can't be replayed */
  sql_truncated?: boolean;
  params?: Tagged[];
  dur_us: number;
  /** request id from the HTTP request context, null outside a request */
  req: number | null;
  /** app call site `file:line:col`, null if every frame was internal */
  frame: string | null;
  fn?: string | null;
  /** true when the stack was captured for this very call; false when reused from an earlier call of the same SQL */
  frame_exact: boolean;
  rows?: number;
  err?: string;
}

export interface HookLoadedRecord {
  v: 1;
  type: 'hook-loaded';
  pid: number;
  thread: number;
  node: string;
  patched: string[];
}
