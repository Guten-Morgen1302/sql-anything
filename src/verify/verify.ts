/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Conn, type DbTarget, openConn } from '../db/conn.js';
import { makeShadows } from '../db/shadow.js';
import { isIntrospection, isNoise, isVolatile, kindOf, topLevel } from '../sql/classify.js';
import { fingerprint, normalize } from '../sql/normalize.js';
import { bootstrapRatio, median, mulberry32, percentile, type RatioCI } from '../stats.js';
import { decodeParams, hasUnverifiable } from '../trace/params.js';
import type { TraceRecord } from '../trace/types.js';
import { explainOn } from '../scan/explain.js';
import { compare, digest } from './canonical.js';

export interface VerifyOptions {
  db: DbTarget;
  records: TraceRecord[];
  /** DDL applied to the patched clone only, e.g. CREATE INDEX */
  migrationSql?: string;
  /** fingerprint -> replacement SQL (same placeholders, same order) */
  rewrites?: Record<string, string>;
  /** fingerprint(s) the patch is meant to speed up; default: rewritten fingerprints, else the whole workload */
  target?: string[];
  samples?: number;
  rounds?: number;
  minSamples?: number;
  maxSeconds?: number;
  minSpeedup?: number;
  maxRegress?: number;
  writeBudget?: number;
  writeSamples?: number;
  seed?: number;
  allowRemote?: boolean;
  /** bench only: skip the pass/fail gates */
  gate?: boolean;
}

export type Verdict = 'PASS' | 'REJECT' | 'UNVERIFIABLE';

export interface GateResult {
  name: 'parity' | 'speed' | 'regression' | 'writes';
  status: 'pass' | 'fail' | 'skipped';
  measured: string;
  threshold: string;
  detail?: string;
}

export interface FpStats {
  fingerprint: string;
  samples: number;
  baseP50Ms: number;
  baseP95Ms: number;
  patchedP50Ms: number;
  patchedP95Ms: number;
  speedup: RatioCI;
}

export interface VerifyResult {
  verdict: Verdict;
  exitCode: 0 | 2 | 4;
  replayed: number;
  verified: number;
  unverifiable: { count: number; reasons: Record<string, number> };
  mismatches: { fingerprint: string; sql: string; reason: string }[];
  gates: GateResult[];
  target: string[] | 'workload';
  speed?: { baseP50Ms: number; baseP95Ms: number; patchedP50Ms: number; patchedP95Ms: number; speedup: RatioCI };
  perFingerprint: FpStats[];
  /** plan summaries for the first verified target input: how the plan changed (e.g. SCAN -> SEARCH USING INDEX) */
  plans?: { before: string; after: string };
  shadowMethod: string;
  warnings: string[];
  seed: number;
  reason?: string;
}

interface Input {
  fp: string;
  sql: string;
  patchedSql: string;
  params: unknown[];
  ordered: boolean;
}

const msNow = () => performance.now();

async function timed(c: Conn, sql: string, params: unknown[]) {
  const t = msNow();
  try {
    const r = await c.query(sql, params);
    return { ms: msNow() - t, r, err: null as string | null };
  } catch (e: any) {
    return { ms: msNow() - t, r: null, err: String(e?.code ?? e?.message ?? e).split('\n')[0] };
  }
}

export async function verify(o: VerifyOptions): Promise<VerifyResult> {
  const seed = o.seed ?? 1;
  const rng = mulberry32(seed);
  const maxSamples = o.samples ?? 500;
  const warnings: string[] = [];
  const unverifiable: Record<string, number> = {};
  const rewrites = o.rewrites ?? {};
  const unv = (why: string) => (unverifiable[why] = (unverifiable[why] ?? 0) + 1);

  // ---- choose replay inputs ----------------------------------------------------------------------------------
  const usable = o.records.filter((r) => !isNoise(r.sql));
  const selectsByFp = new Map<string, Input[]>();
  const seen = new Set<string>();
  for (const r of usable) {
    if (kindOf(r.sql) !== 'select') continue;
    if (r.sql_truncated) {
      unv('sql-truncated');
      continue;
    }
    if (hasUnverifiable(r.params as never)) {
      unv('unserializable-param');
      continue;
    }
    if (isVolatile(r.sql)) {
      unv('volatile-function');
      continue;
    }
    if (isIntrospection(r.sql)) {
      unv('schema-introspection'); // a migration changes these results by definition
      continue;
    }
    const tl = topLevel(r.sql);
    if (tl.limit && !tl.orderBy) {
      unv('limit-without-order-by');
      continue;
    }
    const key = r.sql + '\u0000' + JSON.stringify(r.params ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    const fp = fingerprint(r.sql);
    const list = selectsByFp.get(fp) ?? [];
    list.push({ fp, sql: r.sql, patchedSql: rewrites[fp] ?? r.sql, params: decodeParams(r.params), ordered: tl.orderBy });
    selectsByFp.set(fp, list);
  }
  // fair round-robin across fingerprints so one hot query can't crowd out the rest
  const inputs: Input[] = [];
  const lists = [...selectsByFp.values()];
  for (let i = 0; inputs.length < maxSamples && lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length && inputs.length < maxSamples) inputs.push(l[i]);
  }
  const targetFps: string[] | 'workload' = o.target?.length ? o.target : Object.keys(rewrites).length ? Object.keys(rewrites) : 'workload';
  const isTarget = (fp: string) => targetFps === 'workload' || targetFps.includes(fp);
  const targetInputs = inputs.filter((i) => isTarget(i.fp));

  const base: Omit<VerifyResult, 'verdict' | 'exitCode' | 'gates'> = {
    replayed: 0,
    verified: 0,
    unverifiable: { count: 0, reasons: unverifiable },
    mismatches: [],
    target: targetFps,
    perFingerprint: [],
    shadowMethod: '',
    warnings,
    seed,
  };
  const finish = (verdict: Verdict, gates: GateResult[], extra: Partial<VerifyResult> = {}): VerifyResult => {
    base.unverifiable.count = Object.values(unverifiable).reduce((a, b) => a + b, 0);
    return { ...base, verdict, exitCode: verdict === 'PASS' ? 0 : verdict === 'REJECT' ? 2 : 4, gates, ...extra };
  };

  if (!targetInputs.length) {
    return finish('UNVERIFIABLE', [], { reason: `no replayable input for the target (${base.unverifiable.reasons ? JSON.stringify(unverifiable) : ''}). Volatile functions, LIMIT without ORDER BY and unserializable params can't be compared row for row.` });
  }

  // ---- three clones: A = baseline, B = patched, C = a second untouched baseline -------------------------------
  // C is the A/A control. Two physically different database copies never time identically; C measures that
  // noise floor so the regression guard only fires on slowdowns that are bigger than the noise.
  const shadows = await makeShadows(o.db, 3, { allowRemote: o.allowRemote });
  base.shadowMethod = shadows.method;
  warnings.push(...shadows.warnings);
  const A = await openConn(shadows.targets[0]);
  const B = await openConn(shadows.targets[1]);
  const C = await openConn(shadows.targets[2]);
  try {
    if (o.migrationSql) await B.exec(o.migrationSql);
    await A.exec('ANALYZE'); // identical stats on every side, so a plan difference comes from the patch
    await B.exec('ANALYZE');
    await C.exec('ANALYZE');

    // ---- 1. parity (also warms both caches) ---------------------------------------------------------------
    const verifiedInputs: Input[] = [];
    for (const inp of inputs) {
      base.replayed++;
      const first = rng() < 0.5;
      const ra = first ? await timed(A, inp.sql, inp.params) : null;
      const rb = await timed(B, inp.patchedSql, inp.params);
      const ra2 = ra ?? (await timed(A, inp.sql, inp.params));
      if (ra2.err && rb.err) {
        unv('errored-on-both-sides');
        continue;
      }
      if (ra2.err || rb.err) {
        base.mismatches.push({ fingerprint: inp.fp, sql: normalize(inp.patchedSql).slice(0, 400), // normalized: ORMs inline values into SQL text, and result files must not carry them
           reason: `error on one side only: baseline=${ra2.err ?? 'ok'} patched=${rb.err ?? 'ok'}` });
        continue;
      }
      const p = compare(digest(ra2.r!), digest(rb.r!), inp.ordered);
      if (p.ok) verifiedInputs.push(inp);
      else base.mismatches.push({ fingerprint: inp.fp, sql: normalize(inp.patchedSql).slice(0, 400), // normalized: ORMs inline values into SQL text, and result files must not carry them
           reason: p.reason });
    }
    base.verified = verifiedInputs.length;
    const parity: GateResult = {
      name: 'parity',
      status: base.mismatches.length ? 'fail' : 'pass',
      measured: `${base.verified}/${base.replayed} inputs identical`,
      threshold: 'all replayed inputs identical',
      detail: base.mismatches[0] ? `${base.mismatches.length} mismatch(es); first: ${base.mismatches[0].reason}` : undefined,
    };
    const verifiedTarget = verifiedInputs.filter((i) => isTarget(i.fp));
    if (!verifiedInputs.length && !base.mismatches.length) {
      return finish('UNVERIFIABLE', [parity], { reason: 'no input could be verified row for row' });
    }
    if (base.mismatches.length) return finish('REJECT', [parity, ...skipped(['speed', 'regression', 'writes'])]);
    if (!verifiedTarget.length) return finish('UNVERIFIABLE', [parity], { reason: 'none of the target inputs could be verified row for row' });

    // ---- 2. randomized interleaved A/B timing ---------------------------------------------------------------
    const minSamples = o.minSamples ?? 30;
    const rounds = o.rounds ?? 3;
    const deadline = msNow() + (o.maxSeconds ?? 90) * 1000;
    const samples = new Map<string, { a: number[]; b: number[]; c: number[] }>();
    const sample = async (inp: Input) => {
      // randomized arm order cancels cache-warmth bias
      const arms: ['a' | 'b' | 'c', Conn, string][] = [
        ['a', A, inp.sql],
        ['b', B, inp.patchedSql],
        ['c', C, inp.sql],
      ];
      for (let i = arms.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arms[i], arms[j]] = [arms[j], arms[i]];
      }
      const s = samples.get(inp.fp) ?? samples.set(inp.fp, { a: [], b: [], c: [] }).get(inp.fp)!;
      for (const [arm, conn, sql] of arms) s[arm].push((await timed(conn, sql, inp.params)).ms);
    };
    for (let round = 0; ; round++) {
      const enough = round >= rounds && [...samples.entries()].filter(([fp]) => isTarget(fp)).reduce((s, [, v]) => s + v.a.length, 0) >= minSamples;
      if (enough || msNow() > deadline) break;
      for (const inp of verifiedInputs) await sample(inp);
    }
    // top-up: a fingerprint with 3 inputs would otherwise get a regression verdict from 9 samples
    for (const [fp, s] of samples) {
      const mine = verifiedInputs.filter((i) => i.fp === fp);
      for (let k = 0; s.a.length < minSamples && msNow() < deadline; k++) await sample(mine[k % mine.length]);
    }
    const perFp: FpStats[] = [...samples.entries()].map(([fp, s]) => ({
      fingerprint: fp,
      samples: s.a.length,
      baseP50Ms: r3(median(s.a)),
      baseP95Ms: r3(percentile(s.a, 95)),
      patchedP50Ms: r3(median(s.b)),
      patchedP95Ms: r3(percentile(s.b, 95)),
      speedup: bootstrapRatio(s.a, s.b, rng),
    }));
    base.perFingerprint = perFp;
    const pooled = (pick: (fp: string) => boolean) => {
      const a: number[] = [];
      const b: number[] = [];
      for (const [fp, s] of samples) if (pick(fp)) (a.push(...s.a), b.push(...s.b));
      return { a, b };
    };
    const tp = pooled(isTarget);
    const speedup = bootstrapRatio(tp.a, tp.b, rng);
    const speed = { baseP50Ms: r3(median(tp.a)), baseP95Ms: r3(percentile(tp.a, 95)), patchedP50Ms: r3(median(tp.b)), patchedP95Ms: r3(percentile(tp.b, 95)), speedup };
    if (tp.a.length < minSamples) {
      return finish('UNVERIFIABLE', [parity], { speed, reason: `only ${tp.a.length} timing samples for the target (need ${minSamples}); capture more traffic` });
    }
    const minSpeedup = o.minSpeedup ?? 1.5;
    const speedGate: GateResult = {
      name: 'speed',
      status: speedup.lo >= minSpeedup ? 'pass' : 'fail',
      measured: `${fx(speedup.point)} (95% CI lower bound ${fx(speedup.lo)}, n=${tp.a.length})`,
      threshold: `CI lower bound >= ${minSpeedup}x`,
    };

    // ---- 3. regression guard: nothing outside the target may get slower ------------------------------------
    const maxRegress = o.maxRegress ?? 0.1;
    const regressed = perFp
      .filter((f) => !isTarget(f.fingerprint) || targetFps === 'workload')
      .filter((f) => {
        const s = samples.get(f.fingerprint)!;
        const slow = bootstrapRatio(s.b, s.a, rng); // patched/baseline: > 1 means slower
        const noise = bootstrapRatio(s.c, s.a, rng); // untouched copy / baseline: the A/A noise floor
        return slow.lo > 1 + maxRegress && slow.lo > noise.hi && median(s.b) - median(s.a) > 0.05;
      });
    const regressionGate: GateResult = {
      name: 'regression',
      status: regressed.length ? 'fail' : 'pass',
      measured: regressed.length ? `${regressed.length} fingerprint(s) slower, worst ${regressed[0].fingerprint}` : 'no other fingerprint slower than the A/A noise floor',
      threshold: `no fingerprint slower than ${(maxRegress * 100).toFixed(0)}% (CI lower bound) beyond the A/A noise floor`,
    };
    if (targetFps === 'workload') regressionGate.detail = 'target is the whole workload, so every fingerprint is held to the regression bound';

    // ---- 4. write guard --------------------------------------------------------------------------------------
    const writeGate = await writeGuard(A, B, usable, o, rng, shadows.targets[0].kind);

    try {
      const pi = verifiedTarget[0];
      const before = await explainOn(A, pi.sql, pi.params);
      const after = await explainOn(B, pi.patchedSql, pi.params);
      base.plans = { before: before.summary, after: after.summary };
    } catch {
      /* the plan shift is a nice-to-have on the report card, never a gate */
    }

    const gates = [parity, speedGate, regressionGate, writeGate];
    if (o.gate === false) return finish('PASS', gates, { speed, reason: 'bench only: gates not enforced' });
    const failed = gates.filter((g) => g.status === 'fail');
    return failed.length ? finish('REJECT', gates, { speed }) : finish('PASS', gates, { speed });
  } finally {
    await A.close().catch(() => {});
    await B.close().catch(() => {});
    await C.close().catch(() => {});
    await shadows.dispose().catch(() => {});
  }
}

function skipped(names: GateResult['name'][]): GateResult[] {
  return names.map((name) => ({ name, status: 'skipped', measured: 'not evaluated (parity failed)', threshold: '' }));
}

/**
 * Replay captured writes inside a transaction that is rolled back, on both clones, same order. Index maintenance cost
 * shows up here. Outcomes must also match: a unique index that makes a captured INSERT fail is a behaviour change.
 * This is an estimate: one rolled-back transaction on a cloned dataset, not a production write benchmark.
 */
async function writeGuard(A: Conn, B: Conn, usable: TraceRecord[], o: VerifyOptions, rng: () => number, kind: 'sqlite' | 'pg'): Promise<GateResult> {
  const limit = o.writeSamples ?? 200;
  const writes = usable.filter((r) => kindOf(r.sql) === 'write' && !r.sql_truncated && !hasUnverifiable(r.params as never)).slice(0, limit);
  const budget = o.writeBudget ?? 0.15;
  const threshold = `median write time <= +${(budget * 100).toFixed(0)}% (CI lower bound), identical outcomes`;
  if (!writes.length) return { name: 'writes', status: 'skipped', measured: 'no writes captured', threshold };
  const ta: number[] = [];
  const tb: number[] = [];
  let diverged: string | null = null;
  await A.exec('BEGIN');
  await B.exec('BEGIN');
  try {
    for (const w of writes) {
      const params = decodeParams(w.params);
      const run = async (c: Conn) => {
        if (kind === 'pg') await c.exec('SAVEPOINT sa_w');
        const t = await timed(c, w.sql, params);
        if (kind === 'pg') await c.exec(t.err ? 'ROLLBACK TO SAVEPOINT sa_w' : 'RELEASE SAVEPOINT sa_w');
        return t;
      };
      let ra;
      let rb;
      if (rng() < 0.5) {
        ra = await run(A);
        rb = await run(B);
      } else {
        rb = await run(B);
        ra = await run(A);
      }
      const oa = ra.err ? `err:${ra.err}` : `ok:${ra.r!.changes}`;
      const ob = rb.err ? `err:${rb.err}` : `ok:${rb.r!.changes}`;
      if (oa !== ob && !diverged) diverged = `a captured write behaves differently: baseline ${oa}, patched ${ob} (${w.sql.slice(0, 80)})`;
      if (!ra.err && !rb.err) (ta.push(ra.ms), tb.push(rb.ms));
    }
  } finally {
    await A.exec('ROLLBACK').catch(() => {});
    await B.exec('ROLLBACK').catch(() => {});
  }
  if (diverged) return { name: 'writes', status: 'fail', measured: 'outcome diverged', threshold, detail: diverged };
  if (ta.length < 10) return { name: 'writes', status: 'skipped', measured: `only ${ta.length} replayable writes`, threshold };
  const slow = bootstrapRatio(tb, ta, rng);
  return {
    name: 'writes',
    status: slow.lo > 1 + budget ? 'fail' : 'pass',
    measured: `writes ${fx(slow.point)} vs baseline (95% CI lower bound ${fx(slow.lo)}, n=${ta.length}); estimate`,
    threshold,
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fx = (n: number) => (Number.isFinite(n) ? n.toFixed(2) + 'x' : 'n/a');
