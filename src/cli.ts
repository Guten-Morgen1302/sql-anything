#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { capture, latestRunDir, newRunDir } from './capture.js';
import { muteSqliteWarning, openConn, parseTarget, type DbTarget } from './db/conn.js';
import { makeShadows } from './db/shadow.js';
import { analyze, type ScanReport } from './scan/analyze.js';
import { readTrace } from './trace/read.js';
import { check } from './verify/check.js';
import { verify, type VerifyResult } from './verify/verify.js';

const USAGE = `sql-anything: find the slow SQL, then replay-verify the fix.

  sql-anything scan   [--db <sqlite-file|postgres-url>] [--duration 20s] [--hit <url>...] [--trace <dir>] -- <app command>
  sql-anything verify --db <db> [--trace <dir>] [--migration file.sql] [--rewrite rewrites.json] [--target <F1|fingerprint>]
  sql-anything verify --db <db> --baseline-dir <dir> --patched-dir <dir> (--check-url <url> --run "<server cmd>" | --check-cmd "<cmd>")
  sql-anything bench  (same flags as verify; timing only, no pass/fail)

Exit codes: 0 ok / verified win, 2 patch rejected by the gate, 3 usage or environment error, 4 nothing captured or result unverifiable.
Kill switch: SQL_ANYTHING_DISABLE=1 makes the capture hook do nothing.
Coming in milestone 2: go, fix, report, mcp, demo.`;

class UsageError extends Error {}

function splitArgs(argv: string[]): { own: string[]; rest: string[] } {
  const i = argv.indexOf('--');
  return i < 0 ? { own: argv, rest: [] } : { own: argv.slice(0, i), rest: argv.slice(i + 1) };
}

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
    } else if (ch === '"' || ch === "'") (q = ch), (has = true);
    else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s);
  if (!m) throw new UsageError(`bad duration "${s}" (try 20s, 2m, 1500ms)`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60000 } as any)[m[2] ?? 's'];
}

function printScan(rep: ScanReport, dir: string): void {
  const c = rep.captured;
  console.log(`captured ${c.records} statements (${c.noiseFiltered} transaction/health-check statements ignored, ${c.selects} reads, ${c.writes} writes) from ${c.hooksLoaded} process(es)`);
  if (!rep.findings.length) console.log('no findings: nothing here is slow enough, repeated enough or scan-heavy enough to rank.');
  for (const f of rep.findings) {
    console.log(`\n${f.id}  ${f.kind.padEnd(19)} score ${f.score}  (${f.calls} calls, ${f.totalMs} ms total, p95 ${f.p95Ms} ms)`);
    console.log(`    ${f.sql}`);
    console.log(`    at ${f.callsite ?? 'unknown call site'}${f.callsiteConfidence === 'cached' ? ' (reused from an earlier call of the same SQL)' : ''}`);
    console.log(`    ${f.detail}`);
    if (f.plan) console.log(`    plan: ${f.plan.summary.slice(0, 160)}`);
  }
  for (const w of rep.warnings) console.log(`warning: ${w}`);
  console.log(`\nfindings: ${path.join(dir, 'findings.json')}`);
}

async function cmdScan(argv: string[]): Promise<number> {
  const { own, rest } = splitArgs(argv);
  const { values } = parseArgs({
    args: own,
    options: {
      db: { type: 'string' },
      duration: { type: 'string' },
      hit: { type: 'string', multiple: true },
      'hit-repeat': { type: 'string' },
      trace: { type: 'string' },
      json: { type: 'boolean' },
      'no-explain': { type: 'boolean' },
      'explain-top': { type: 'string' },
      'n-plus-one-min': { type: 'string' },
      'allow-remote-shadow': { type: 'boolean' },
    },
  });
  let dir: string;
  if (values.trace) dir = path.resolve(values.trace);
  else {
    if (!rest.length) throw new UsageError('scan needs an app command after "--" (or --trace <dir> to analyze an earlier run)');
    dir = newRunDir();
    console.error(`capturing into ${dir}`);
    const cap = await capture({
      cmd: rest,
      traceDir: dir,
      durationMs: values.duration ? parseDuration(values.duration) : undefined,
      hits: values.hit,
      hitRepeat: values['hit-repeat'] ? Number(values['hit-repeat']) : 1,
    });
    if (cap.exitCode && !cap.timedOut && !values.hit) console.error(`the app exited with code ${cap.exitCode}`);
  }
  const trace = readTrace(dir);
  if (!trace.hooks.length) {
    console.error('0 queries captured: the capture hook never loaded in the app process.\nThe app may run through a bundler or a wrapper that drops NODE_OPTIONS, or SQL_ANYTHING_DISABLE=1 is set. Supported: pg, better-sqlite3, node:sqlite (Prisma 7 and Drizzle through pg).');
    return 4;
  }
  if (!trace.records.length) {
    console.error('the hook loaded but 0 queries were captured. Did the app run any SQL during the capture window? Use --hit <url> or a longer --duration.');
    return 4;
  }
  let shadows: Awaited<ReturnType<typeof makeShadows>> | null = null;
  let conn: Awaited<ReturnType<typeof openConn>> | null = null;
  const warnings: string[] = [];
  if (values.db && !values['no-explain']) {
    try {
      shadows = await makeShadows(parseTarget(values.db), 1, { allowRemote: !!values['allow-remote-shadow'] });
      warnings.push(...shadows.warnings);
      conn = await openConn(shadows.targets[0]);
    } catch (e: any) {
      warnings.push(`plan analysis skipped: ${e?.message ?? e}`);
    }
  }
  try {
    const rep = await analyze(trace.records, trace.hooks.length, {
      shadow: conn,
      explainTop: values['explain-top'] ? Number(values['explain-top']) : undefined,
      nPlusOneMin: values['n-plus-one-min'] ? Number(values['n-plus-one-min']) : undefined,
    });
    rep.warnings.unshift(...warnings);
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(rep, null, 2));
    if (values.json) console.log(JSON.stringify(rep, null, 2));
    else printScan(rep, dir);
  } finally {
    await conn?.close();
    await shadows?.dispose();
  }
  return 0;
}

function printGates(r: { gates: any[]; reason?: string; warnings?: string[] }): void {
  for (const g of r.gates) {
    const mark = g.status === 'pass' ? 'PASS' : g.status === 'fail' ? 'FAIL' : 'skip';
    console.log(`  [${mark}] ${g.name}: ${g.measured}   (need: ${g.threshold})`);
    if (g.detail) console.log(`         ${g.detail}`);
  }
  if (r.reason) console.log(`  reason: ${r.reason}`);
  for (const w of r.warnings ?? []) console.log(`  warning: ${w}`);
}

async function cmdVerify(argv: string[], bench: boolean): Promise<number> {
  const { own } = splitArgs(argv);
  const { values } = parseArgs({
    args: own,
    options: {
      db: { type: 'string' },
      trace: { type: 'string' },
      migration: { type: 'string' },
      rewrite: { type: 'string' },
      target: { type: 'string', multiple: true },
      samples: { type: 'string' },
      rounds: { type: 'string' },
      'min-speedup': { type: 'string' },
      'max-regress': { type: 'string' },
      'write-budget': { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'boolean' },
      'allow-remote-shadow': { type: 'boolean' },
      'baseline-dir': { type: 'string' },
      'patched-dir': { type: 'string' },
      'check-url': { type: 'string' },
      'check-cmd': { type: 'string' },
      run: { type: 'string' },
      reps: { type: 'string' },
    },
  });
  if (!values.db) throw new UsageError('--db <sqlite-file|postgres-url> is required');
  const db: DbTarget = parseTarget(values.db);
  const num = (s?: string) => (s === undefined ? undefined : Number(s));

  if (values['check-url'] || values['check-cmd']) {
    if (!values['baseline-dir'] || !values['patched-dir']) throw new UsageError('N+1 check needs --baseline-dir and --patched-dir (two checkouts: before and after the patch)');
    const r = await check({
      db,
      baselineDir: path.resolve(values['baseline-dir']),
      patchedDir: path.resolve(values['patched-dir']),
      runCmd: values.run ? shellSplit(values.run) : undefined,
      checkUrl: values['check-url'],
      checkCmd: values['check-cmd'] ? shellSplit(values['check-cmd']) : undefined,
      reps: num(values.reps),
      minSpeedup: num(values['min-speedup']),
      maxRegress: num(values['max-regress']),
      seed: num(values.seed),
      allowRemote: !!values['allow-remote-shadow'],
    });
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`N+1 check: ${r.verdict}`);
      printGates(r);
      if (Number.isFinite(r.queriesPerRun.baseline)) console.log(`  queries per run: ${r.queriesPerRun.baseline} -> ${r.queriesPerRun.patched}`);
    }
    return r.exitCode;
  }

  const dir = values.trace ? path.resolve(values.trace) : latestRunDir();
  if (!dir) throw new UsageError('no captured run found: run `sql-anything scan ... -- <app>` first or pass --trace <dir>');
  const trace = readTrace(dir);
  let target = values.target;
  if (target?.some((t) => /^F\d+$/.test(t))) {
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8')) as ScanReport;
    target = target.map((t) => f.findings.find((x) => x.id === t)?.fingerprint ?? t);
  }
  const r: VerifyResult = await verify({
    db,
    records: trace.records,
    migrationSql: values.migration ? fs.readFileSync(values.migration, 'utf8') : undefined,
    rewrites: values.rewrite ? JSON.parse(fs.readFileSync(values.rewrite, 'utf8')) : undefined,
    target,
    samples: num(values.samples),
    rounds: num(values.rounds),
    minSpeedup: num(values['min-speedup']),
    maxRegress: num(values['max-regress']),
    writeBudget: num(values['write-budget']),
    seed: num(values.seed),
    allowRemote: !!values['allow-remote-shadow'],
    gate: !bench,
  });
  if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'verify.json'), JSON.stringify(r, null, 2));
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${bench ? 'bench' : 'verify'}: ${r.verdict}  (${r.verified}/${r.replayed} replayed inputs identical, ${r.unverifiable.count} unverifiable${r.unverifiable.count ? ' ' + JSON.stringify(r.unverifiable.reasons) : ''})`);
    printGates(r);
    for (const m of r.mismatches.slice(0, 3)) console.log(`  mismatch ${m.fingerprint}: ${m.reason}`);
    if (r.speed) console.log(`  target p50 ${r.speed.baseP50Ms} -> ${r.speed.patchedP50Ms} ms, p95 ${r.speed.baseP95Ms} -> ${r.speed.patchedP95Ms} ms (seed ${r.seed})`);
  }
  return r.exitCode;
}

async function main(): Promise<number> {
  muteSqliteWarning();
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'scan':
        return await cmdScan(rest);
      case 'verify':
        return await cmdVerify(rest, false);
      case 'bench':
        return await cmdVerify(rest, true);
      case 'go':
      case 'fix':
      case 'report':
      case 'mcp':
      case 'demo':
        console.error(`"${cmd}" is milestone 2 and is not implemented yet.`);
        return 3;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        console.log(USAGE);
        return cmd === undefined ? 3 : 0;
      default:
        console.error(`unknown command "${cmd}"\n\n${USAGE}`);
        return 3;
    }
  } catch (e: any) {
    if (e instanceof UsageError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      console.error(`error: ${e.message}`);
      return 3;
    }
    console.error(`error: ${e?.message ?? e}`);
    return 3;
  }
}

process.exitCode = await main();
