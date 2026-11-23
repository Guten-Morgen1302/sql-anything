/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { capture, latestRunDir, newRunDir } from './capture.js';
import { openConn, parseTarget, type DbTarget } from './db/conn.js';
import { makeShadows } from './db/shadow.js';
import { analyze, type ScanReport } from './scan/analyze.js';
import { readTrace } from './trace/read.js';
import { verify, type VerifyOptions, type VerifyResult } from './verify/verify.js';

export class UsageError extends Error {}

/** Minimal quote-aware split so `--run "node server.js --port 3000"` works on every OS without a shell. */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let has = false;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s);
  if (!m) throw new UsageError(`bad duration "${s}" (try 20s, 2m, 1500ms)`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60000 } as any)[m[2] ?? 's'];
}

// ------------------------------------------------------------------------------------------------ scan ----------
export interface ScanOptions {
  db?: string;
  /** analyze an earlier capture instead of launching the app */
  trace?: string;
  cmd?: string[];
  cwd?: string;
  duration?: string;
  hits?: string[];
  hitRepeat?: number;
  /** extra environment for the app process, e.g. PORT and the database path */
  env?: Record<string, string>;
  explain?: boolean;
  explainTop?: number;
  nPlusOneMin?: number;
  allowRemote?: boolean;
  log?: (s: string) => void;
}

export interface ScanOutcome {
  exitCode: 0 | 4;
  dir: string;
  report?: ScanReport;
  /** why nothing was captured (exit 4) */
  error?: string;
}

export async function runScan(o: ScanOptions): Promise<ScanOutcome> {
  const log = o.log ?? (() => {});
  let dir: string;
  if (o.trace) dir = path.resolve(o.trace);
  else {
    if (!o.cmd?.length) throw new UsageError('scan needs an app command after "--" (or --trace <dir> to analyze an earlier run)');
    dir = newRunDir(o.cwd);
    log(`capturing into ${dir}`);
    const cap = await capture({
      cmd: o.cmd,
      cwd: o.cwd,
      traceDir: dir,
      durationMs: o.duration ? parseDuration(o.duration) : undefined,
      hits: o.hits,
      hitRepeat: o.hitRepeat ?? 1,
      env: o.env,
      quiet: true,
    });
    if (cap.exitCode && !cap.timedOut && !o.hits?.length) log(`the app exited with code ${cap.exitCode}`);
  }
  const trace = readTrace(dir);
  if (!trace.hooks.length) {
    return {
      exitCode: 4,
      dir,
      error:
        '0 queries captured: the capture hook never loaded in the app process.\nThe app may run through a bundler or a wrapper that drops NODE_OPTIONS, or SQL_ANYTHING_DISABLE=1 is set. Supported: pg, better-sqlite3, node:sqlite (Prisma 7 and Drizzle through pg).',
    };
  }
  if (!trace.records.length) {
    return { exitCode: 4, dir, error: 'the hook loaded but 0 queries were captured. Did the app run any SQL during the capture window? Use --hit <url> or a longer --duration.' };
  }
  let shadows: Awaited<ReturnType<typeof makeShadows>> | null = null;
  let conn: Awaited<ReturnType<typeof openConn>> | null = null;
  const warnings: string[] = [];
  if (o.db && o.explain !== false) {
    try {
      shadows = await makeShadows(parseTarget(o.db), 1, { allowRemote: o.allowRemote });
      warnings.push(...shadows.warnings);
      conn = await openConn(shadows.targets[0]);
    } catch (e: any) {
      warnings.push(`plan analysis skipped: ${e?.message ?? e}`);
    }
  }
  try {
    const report = await analyze(trace.records, trace.hooks.length, { shadow: conn, explainTop: o.explainTop, nPlusOneMin: o.nPlusOneMin });
    report.warnings.unshift(...warnings);
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(report, null, 2));
    return { exitCode: 0, dir, report };
  } finally {
    await conn?.close();
    await shadows?.dispose();
  }
}

// ---------------------------------------------------------------------------------------------- verify ----------
export interface VerifyRunOptions extends Omit<VerifyOptions, 'db' | 'records' | 'target'> {
  db: string;
  /** run directory from `scan`; default: the latest run in ./.sql-anything */
  trace?: string;
  /** finding ids (F1) or fingerprints */
  target?: string[];
  cwd?: string;
}

export interface VerifyRunOutcome {
  dir: string;
  result: VerifyResult;
}

export function loadFindings(dir: string): ScanReport {
  const f = path.join(dir, 'findings.json');
  if (!fs.existsSync(f)) throw new UsageError(`no findings.json in ${dir}: run \`sql-anything scan\` first`);
  return JSON.parse(fs.readFileSync(f, 'utf8')) as ScanReport;
}

export async function runVerify(o: VerifyRunOptions): Promise<VerifyRunOutcome> {
  const dir = o.trace ? path.resolve(o.trace) : latestRunDir(o.cwd);
  if (!dir) throw new UsageError('no captured run found: run `sql-anything scan ... -- <app>` first or pass --trace <dir>');
  const trace = readTrace(dir);
  let target = o.target;
  if (target?.some((t) => /^F\d+$/.test(t))) {
    const rep = loadFindings(dir);
    target = target.map((t) => rep.findings.find((x) => x.id === t)?.fingerprint ?? t);
  }
  const { db, trace: _t, cwd: _c, target: _tg, ...rest } = o;
  const result = await verify({ ...rest, db: parseTarget(db) as DbTarget, records: trace.records, target });
  if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'verify.json'), JSON.stringify(result, null, 2));
  return { dir, result };
}
