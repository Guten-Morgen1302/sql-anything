import { isNoise, kindOf } from '../sql/classify.js';
import { fingerprint, normalize } from '../sql/normalize.js';
import { hasUnverifiable, decodeParams } from '../trace/params.js';
import type { TraceRecord } from '../trace/types.js';
import { median, percentile } from '../stats.js';
import type { Conn } from '../db/conn.js';
import { explainOn, type PlanFacts } from './explain.js';

export type FindingKind = 'n+1' | 'seq-scan' | 'correlated-subquery' | 'slow-query';

export interface Finding {
  id: string;
  kind: FindingKind;
  fingerprint: string;
  sql: string;
  callsite: string | null;
  /** how the callsite was obtained: stack captured for that call, reused from an earlier call, or unknown */
  callsiteConfidence: 'exact' | 'cached' | 'none';
  calls: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  impactMs: number;
  weight: number;
  score: number;
  detail: string;
  n1?: { requests: number; maxPerRequest: number; medianPerRequest: number; grouping: 'request' | 'burst' };
  plan?: PlanFacts;
}

export interface ScanReport {
  captured: { records: number; noiseFiltered: number; selects: number; writes: number; hooksLoaded: number };
  findings: Finding[];
  warnings: string[];
}

export interface AnalyzeOptions {
  /** min repeats of one statement inside one request (or burst) to call it an N+1 */
  nPlusOneMin?: number;
  /** how many top fingerprints get an EXPLAIN */
  explainTop?: number;
  burstGapMs?: number;
  slowP95Ms?: number;
  slowShare?: number;
  /** a clone of the database to EXPLAIN against. Never the live database. */
  shadow?: Conn | null;
}

const WEIGHT: Record<FindingKind, number> = { 'seq-scan': 0.9, 'n+1': 0.8, 'correlated-subquery': 0.6, 'slow-query': 0.4 };

interface Group {
  fp: string;
  sql: string;
  recs: TraceRecord[];
}

export function bestCallsite(recs: TraceRecord[]): { callsite: string | null; confidence: Finding['callsiteConfidence'] } {
  const exact = new Map<string, number>();
  const cached = new Map<string, number>();
  for (const r of recs) {
    if (!r.frame) continue;
    const m = r.frame_exact ? exact : cached;
    m.set(r.frame, (m.get(r.frame) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const e = top(exact);
  if (e) return { callsite: e, confidence: 'exact' };
  const c = top(cached);
  return c ? { callsite: c, confidence: 'cached' } : { callsite: null, confidence: 'none' };
}

export async function analyze(records: TraceRecord[], hooksLoaded: number, opts: AnalyzeOptions = {}): Promise<ScanReport> {
  const nMin = opts.nPlusOneMin ?? 5;
  const gap = opts.burstGapMs ?? 100;
  const warnings: string[] = [];
  let noise = 0;
  const usable: TraceRecord[] = [];
  for (const r of records) {
    if (isNoise(r.sql)) noise++;
    else usable.push(r);
  }
  const selects = usable.filter((r) => kindOf(r.sql) === 'select');
  const writes = usable.filter((r) => kindOf(r.sql) === 'write');

  const byFp = new Map<string, Group>();
  for (const r of selects) {
    const fp = fingerprint(r.sql);
    let g = byFp.get(fp);
    if (!g) byFp.set(fp, (g = { fp, sql: r.sql, recs: [] }));
    g.recs.push(r);
  }
  const totalSelectMs = selects.reduce((s, r) => s + r.dur_us / 1000, 0);

  // --- N+1 -----------------------------------------------------------------------------------------------------
  const findings: Finding[] = [];
  const n1Fps = new Set<string>();
  for (const g of byFp.values()) {
    const buckets = new Map<string, TraceRecord[]>();
    let burstId = 0;
    const lastT = new Map<string, number>();
    let grouping: 'request' | 'burst' = 'request';
    for (const r of g.recs) {
      let key: string;
      if (r.req !== null) key = `${r.pid}:${r.thread}:r${r.req}`;
      else {
        grouping = 'burst';
        const pk = `${r.pid}:${r.thread}`;
        const prev = lastT.get(pk);
        if (prev === undefined || r.t - prev > gap) burstId++;
        lastT.set(pk, r.t);
        key = `${pk}:b${burstId}`;
      }
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
    }
    const hits = [...buckets.values()].filter((b) => b.length >= nMin && new Set(b.map((x) => JSON.stringify(x.params ?? null))).size >= 2);
    if (!hits.length) continue;
    const inHits = hits.flat();
    const counts = hits.map((b) => b.length);
    const { callsite, confidence } = bestCallsite(inHits);
    const durs = inHits.map((r) => r.dur_us / 1000);
    const total = durs.reduce((a, b) => a + b, 0);
    n1Fps.add(g.fp);
    findings.push(mk('n+1', g, {
      callsite,
      confidence,
      calls: inHits.length,
      totalMs: total,
      durs,
      detail: `${median(counts)} identical lookups per ${grouping === 'request' ? 'request' : 'burst'} (max ${Math.max(...counts)}) across ${hits.length} ${grouping === 'request' ? 'requests' : 'bursts'}; could be 1-2 queries`,
      n1: { requests: hits.length, maxPerRequest: Math.max(...counts), medianPerRequest: median(counts), grouping },
    }));
  }

  // --- plan-based findings, only for the heaviest fingerprints ------------------------------------------------
  const ranked = [...byFp.values()].sort((a, b) => sumMs(b.recs) - sumMs(a.recs));
  const planFor = new Map<string, PlanFacts>();
  if (opts.shadow) {
    for (const g of ranked.slice(0, opts.explainTop ?? 10)) {
      const rec = g.recs.find((r) => !r.sql_truncated && !hasUnverifiable(r.params as never));
      if (!rec) continue;
      try {
        planFor.set(g.fp, await explainOn(opts.shadow, rec.sql, decodeParams(rec.params)));
      } catch (e: any) {
        warnings.push(`EXPLAIN failed for ${g.fp}: ${String(e?.message ?? e).split('\n')[0]}`);
      }
    }
  }
  for (const g of ranked) {
    const plan = planFor.get(g.fp);
    const durs = g.recs.map((r) => r.dur_us / 1000);
    const total = durs.reduce((a, b) => a + b, 0);
    const { callsite, confidence } = bestCallsite(g.recs);
    const base = { callsite, confidence, calls: g.recs.length, totalMs: total, durs, plan };
    if (plan?.selectiveSeqScans.length) {
      const s = plan.selectiveSeqScans[0];
      findings.push(mk('seq-scan', g, { ...base, detail: `sequential scan of ${s.table} (${s.scannedRows.toLocaleString('en-US')} rows) rejects ${(s.rejected * 100).toFixed(1)}% of them: an index on the filtered columns should turn this into a lookup` }));
    } else if (plan?.correlatedSubquery) {
      findings.push(mk('correlated-subquery', g, { ...base, detail: 'correlated subquery re-executes per outer row; a join or pre-aggregation usually removes the loop' }));
    } else if (!n1Fps.has(g.fp) && (percentile(durs, 95) >= (opts.slowP95Ms ?? 50) || (totalSelectMs > 0 && total / totalSelectMs >= (opts.slowShare ?? 0.05) && g.recs.length >= 3))) {
      findings.push(mk('slow-query', g, { ...base, detail: `${((total / Math.max(totalSelectMs, 1e-9)) * 100).toFixed(0)}% of all captured read time` }));
    }
  }

  findings.sort((a, b) => b.score - a.score);
  findings.forEach((f, i) => (f.id = `F${i + 1}`));
  return { captured: { records: records.length, noiseFiltered: noise, selects: selects.length, writes: writes.length, hooksLoaded }, findings, warnings };
}

const sumMs = (rs: TraceRecord[]) => rs.reduce((s, r) => s + r.dur_us / 1000, 0);

function mk(
  kind: FindingKind,
  g: Group,
  x: { callsite: string | null; confidence: Finding['callsiteConfidence']; calls: number; totalMs: number; durs: number[]; detail: string; plan?: PlanFacts; n1?: Finding['n1'] },
): Finding {
  return {
    id: '',
    kind,
    fingerprint: g.fp,
    sql: normalize(g.sql).slice(0, 400),
    callsite: x.callsite,
    callsiteConfidence: x.confidence,
    calls: x.calls,
    totalMs: round(x.totalMs),
    p50Ms: round(median(x.durs)),
    p95Ms: round(percentile(x.durs, 95)),
    impactMs: round(x.totalMs),
    weight: WEIGHT[kind],
    score: round(x.totalMs * WEIGHT[kind]),
    detail: x.detail,
    n1: x.n1,
    plan: x.plan,
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000;
