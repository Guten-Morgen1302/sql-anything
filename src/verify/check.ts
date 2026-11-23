/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, freePort, killTree, sleep, spawnWithHook, waitForUrl } from '../capture.js';
import type { DbTarget } from '../db/conn.js';
import { makeShadows } from '../db/shadow.js';
import { isNoise } from '../sql/classify.js';
import { bootstrapRatio, median, mulberry32, percentile, type RatioCI } from '../stats.js';
import { readTrace } from '../trace/read.js';
import type { GateResult, Verdict } from './verify.js';

export interface CheckOptions {
  db: DbTarget;
  /** two checkouts of the app: before and after the patch (e.g. git worktrees) */
  baselineDir: string;
  patchedDir: string;
  /** server command, used with checkUrl */
  runCmd?: string[];
  /** read-only GET against the running server */
  checkUrl?: string;
  /** one-shot workload command, run once per repetition; its stdout is the result */
  checkCmd?: string[];
  reps?: number;
  warmup?: number;
  minSpeedup?: number;
  maxRegress?: number;
  seed?: number;
  allowRemote?: boolean;
}

export interface CheckResult {
  verdict: Verdict;
  exitCode: 0 | 2 | 4;
  gates: GateResult[];
  queriesPerRun: { baseline: number; patched: number };
  wall: { baselineP50Ms: number; baselineP95Ms: number; patchedP50Ms: number; patchedP95Ms: number; speedup: RatioCI };
  maskedPaths: string[];
  reason?: string;
  warnings: string[];
}

interface Variant {
  bodies: string[];
  times: number[];
  queries: number[];
}

/** Leaves of a JSON value keyed by path. Object keys are visited sorted, so key order never matters. */
function leaves(v: unknown, p = '$', out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(v)) {
    out.set(p + '.length', String(v.length));
    v.forEach((x, i) => leaves(x, `${p}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v).sort()) leaves((v as any)[k], `${p}.${k}`, out);
  } else out.set(p, JSON.stringify(v));
  return out;
}

function canon(body: string): { json: boolean; map: Map<string, string>; text: string } {
  const t = body.replace(/\r\n/g, '\n').trim();
  try {
    return { json: true, map: leaves(JSON.parse(t)), text: t };
  } catch {
    return { json: false, map: new Map(), text: t };
  }
}

function envFor(target: DbTarget): Record<string, string> {
  const env: Record<string, string> = { SQL_ANYTHING_DB_URL: target.url };
  if (target.kind === 'pg') env.DATABASE_URL = target.url;
  if (target.searchPath) env.PGOPTIONS = `-c search_path=${target.searchPath},public`;
  return env;
}

const countByReq = (dir: string) => {
  const counts = new Map<number, number>();
  for (const q of readTrace(dir).records) if (q.req !== null && !isNoise(q.sql)) counts.set(q.req, (counts.get(q.req) ?? 0) + 1);
  return counts;
};

/**
 * Baseline and patched are measured interleaved (A, B, A, B ... with a randomized order inside each pair) so machine
 * drift, thermal throttling or a noisy neighbour hits both arms equally. Warm-up pairs are discarded.
 */
async function runInterleaved(o: CheckOptions, targets: DbTarget[], warm: number, reps: number, rng: () => number, warnings: string[]): Promise<[Variant, Variant]> {
  const dirs = [o.baselineDir, o.patchedDir];
  const envs = targets.map(envFor);
  const vs: [Variant, Variant] = [
    { bodies: [], times: [], queries: [] },
    { bodies: [], times: [], queries: [] },
  ];
  const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-anything-check-'));
  const order = (): number[] => (rng() < 0.5 ? [0, 1] : [1, 0]);
  try {
    if (o.checkCmd) {
      for (let i = 0; i < warm + reps; i++) {
        for (const arm of order()) {
          const td = path.join(traceRoot, `arm${arm}-rep${i}`);
          const t0 = performance.now();
          const r = await capture({ cmd: o.checkCmd, cwd: dirs[arm], traceDir: td, env: envs[arm], quiet: true });
          const ms = performance.now() - t0;
          if (i < warm) continue;
          vs[arm].bodies.push(r.exitCode === 0 ? r.stdout : `exit ${r.exitCode}`);
          vs[arm].times.push(ms);
          vs[arm].queries.push(readTrace(td).records.filter((q) => !isNoise(q.sql)).length);
        }
      }
      return vs;
    }
    if (!o.checkUrl!.includes('{port}')) {
      warnings.push('--check-url has a fixed port, so the two servers cannot run side by side: baseline and patched ran back to back instead of interleaved. Use http://127.0.0.1:{port}/path to interleave.');
      for (const arm of [0, 1]) {
        const td = path.join(traceRoot, `arm${arm}`);
        const r = await capture({ cmd: o.runCmd!, cwd: dirs[arm], traceDir: td, env: envs[arm], tagReq: true, hits: [o.checkUrl!], hitRepeat: warm + reps, quiet: true });
        const counts = countByReq(td);
        r.hits.slice(warm).forEach((h) => {
          vs[arm].bodies.push(h.status >= 200 && h.status < 300 ? h.body : `HTTP ${h.status}`);
          vs[arm].times.push(h.ms);
          vs[arm].queries.push(h.req !== null ? (counts.get(h.req) ?? 0) : NaN);
        });
      }
      return vs;
    }
    // both servers up at once, each on its own port
    const ports = [await freePort(), await freePort()];
    const urls = ports.map((p) => o.checkUrl!.replace('{port}', String(p)));
    const kids = [0, 1].map((arm) => {
      const k = spawnWithHook(o.runCmd!, { cwd: dirs[arm], env: { ...envs[arm], PORT: String(ports[arm]) }, traceDir: path.join(traceRoot, `arm${arm}`), tagReq: true });
      k.stdout?.on('data', () => {});
      k.stderr?.on('data', () => {});
      return k;
    });
    const reqIds: [number[], number[]] = [[], []];
    try {
      for (const arm of [0, 1]) {
        if (!(await waitForUrl(urls[arm], 30_000, () => kids[arm].exitCode === null))) return vs; // caller reports "did not complete"
      }
      for (let i = 0; i < warm + reps; i++) {
        for (const arm of order()) {
          const t0 = performance.now();
          let body = '';
          let status = 0;
          let req = NaN;
          try {
            const res = await fetch(urls[arm], { signal: AbortSignal.timeout(30_000) });
            body = await res.text();
            status = res.status;
            req = Number(res.headers.get('x-sql-anything-req'));
          } catch {
            /* counted as an incomplete run */
          }
          const ms = performance.now() - t0;
          if (i < warm) continue;
          vs[arm].bodies.push(status >= 200 && status < 300 ? body : `HTTP ${status}`);
          vs[arm].times.push(ms);
          reqIds[arm].push(req);
        }
      }
      await sleep(450); // the hook flushes every 200ms and a killed process cannot flush on exit
    } finally {
      kids.forEach((k) => killTree(k.pid));
    }
    for (const arm of [0, 1]) {
      const counts = countByReq(path.join(traceRoot, `arm${arm}`));
      vs[arm].queries = reqIds[arm].map((id) => (Number.isFinite(id) ? (counts.get(id) ?? 0) : NaN));
    }
    return vs;
  } finally {
    fs.rmSync(traceRoot, { recursive: true, force: true });
  }
}

/**
 * Lightweight N+1 verifier. Runs the app before and after the patch, interleaved, against identical clones of the database, compares
 * the canonicalized output, the wall time and the number of SQL statements per run. Read-only GET or a one-shot command
 * only; a full HTTP record/replay proxy is v0.2.
 */
export async function check(o: CheckOptions): Promise<CheckResult> {
  const rng = mulberry32(o.seed ?? 1);
  const reps = o.reps ?? 15;
  const warm = o.warmup ?? 2;
  const warnings: string[] = [];
  const empty = (verdict: Verdict, reason: string, gates: GateResult[] = []): CheckResult => ({
    verdict,
    exitCode: verdict === 'PASS' ? 0 : verdict === 'REJECT' ? 2 : 4,
    gates,
    queriesPerRun: { baseline: NaN, patched: NaN },
    wall: { baselineP50Ms: NaN, baselineP95Ms: NaN, patchedP50Ms: NaN, patchedP95Ms: NaN, speedup: { point: NaN, lo: NaN, hi: NaN, n: 0 } },
    maskedPaths: [],
    reason,
    warnings,
  });
  if (!o.checkUrl === !o.checkCmd) throw new Error('pass exactly one of --check-url or --check-cmd');
  if (o.checkUrl && !o.runCmd?.length) throw new Error('--check-url needs --run "<server command>"');

  const shadows = await makeShadows(o.db, 2, { allowRemote: o.allowRemote });
  warnings.push(...shadows.warnings);
  try {
    const [base, patched] = await runInterleaved(o, shadows.targets, warm, reps, rng, warnings);
    if (base.bodies.length < reps || patched.bodies.length < reps) {
      return empty('UNVERIFIABLE', `the workload did not complete ${reps} runs on both sides (baseline ${base.bodies.length}, patched ${patched.bodies.length}). Is the server reachable at the check URL?`);
    }

    // Noise filter: whatever differs between two baseline runs (timestamps, ids) is masked before comparing.
    const bc = base.bodies.map(canon);
    const masked = new Set<string>();
    for (const c of bc.slice(1)) {
      if (c.json !== bc[0].json) return empty('UNVERIFIABLE', 'baseline output is not stable between runs (JSON vs non-JSON)');
      if (!c.json) {
        if (c.text !== bc[0].text) return empty('UNVERIFIABLE', 'baseline output is not byte-stable between runs and is not JSON, so it cannot be masked');
        continue;
      }
      for (const k of new Set([...c.map.keys(), ...bc[0].map.keys()])) if (c.map.get(k) !== bc[0].map.get(k)) masked.add(k);
    }
    if (bc[0].json && (masked.has('$') || (bc[0].map.size > 0 && masked.size >= bc[0].map.size))) {
      return empty('UNVERIFIABLE', 'baseline output is entirely different on every run (nothing left to compare after masking), so parity cannot be checked');
    }
    let parityFail: string | null = null;
    for (const body of patched.bodies) {
      const c = canon(body);
      if (c.json !== bc[0].json) {
        parityFail = 'patched output is not the same kind (JSON vs non-JSON) as baseline';
        break;
      }
      if (!c.json) {
        if (c.text !== bc[0].text) parityFail = 'stdout differs from baseline';
      } else {
        for (const k of new Set([...c.map.keys(), ...bc[0].map.keys()])) {
          if (masked.has(k)) continue;
          if (c.map.get(k) !== bc[0].map.get(k)) {
            parityFail = `output differs at ${k}: baseline ${bc[0].map.get(k) ?? '(absent)'} vs patched ${c.map.get(k) ?? '(absent)'}`;
            break;
          }
        }
      }
      if (parityFail) break;
    }

    const speedup = bootstrapRatio(base.times, patched.times, rng);
    const slow = bootstrapRatio(patched.times, base.times, rng);
    const qb = median(base.queries.filter(Number.isFinite));
    const qp = median(patched.queries.filter(Number.isFinite));
    const minSpeedup = o.minSpeedup ?? 1.5;
    const maxRegress = o.maxRegress ?? 0.1;
    const gates: GateResult[] = [
      { name: 'parity', status: parityFail ? 'fail' : 'pass', measured: parityFail ?? `${patched.bodies.length}/${patched.bodies.length} runs identical to baseline (${masked.size} noisy path(s) masked)`, threshold: 'identical canonical output' },
      { name: 'speed', status: speedup.lo >= minSpeedup ? 'pass' : 'fail', measured: `${speedup.point.toFixed(2)}x (95% CI lower bound ${speedup.lo.toFixed(2)}x, n=${reps}); queries/run ${qb} -> ${qp}`, threshold: `CI lower bound >= ${minSpeedup}x` },
      { name: 'regression', status: slow.lo > 1 + maxRegress ? 'fail' : 'pass', measured: `patched/baseline ${slow.point.toFixed(2)}x`, threshold: `not slower than ${(maxRegress * 100).toFixed(0)}%` },
    ];
    const verdict: Verdict = gates.some((g) => g.status === 'fail') ? 'REJECT' : 'PASS';
    return {
      verdict,
      exitCode: verdict === 'PASS' ? 0 : 2,
      gates,
      queriesPerRun: { baseline: qb, patched: qp },
      wall: { baselineP50Ms: r3(median(base.times)), baselineP95Ms: r3(percentile(base.times, 95)), patchedP50Ms: r3(median(patched.times)), patchedP95Ms: r3(percentile(patched.times, 95)), speedup },
      maskedPaths: [...masked],
      warnings,
    };
  } finally {
    await shadows.dispose().catch(() => {});
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
