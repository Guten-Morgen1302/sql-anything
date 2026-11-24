#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveAgent } from './agent.js';
import { loadFindings, runScan, runVerify, shellSplit, UsageError } from './api.js';
import { COMMANDS, EXIT, type Command } from './meta.js';
import { latestRunDir } from './capture.js';
import { muteSqliteWarning, parseTarget } from './db/conn.js';
import { fix } from './fix/fix.js';
import { go, goPlan } from './go.js';
import { writeReport } from './report/report.js';
import type { ScanReport } from './scan/analyze.js';
import { check } from './verify/check.js';

const USAGE = `sql-anything: find the slow SQL, fix it, and replay-verify the fix before you trust it.

  sql-anything go     --db <db> [--agent claude|none] [--hit <url>...] [--duration 20s] [--max-fixes 3] -- <app command>
  sql-anything scan   [--db <sqlite-file|postgres-url>] [--duration 20s] [--hit <url>...] [--trace <dir>] -- <app command>
  sql-anything fix    <F1> --db <db> [--trace <dir>] [--agent claude|none | --agent-cmd "<cmd>"] [--no-index] [--migration idx.sql] [--max-attempts 3] [--max-seconds 90]
                      [--run "<server cmd>" --check-url <url> | --check-cmd "<cmd>"]
  sql-anything verify --db <db> [--trace <dir>] [--migration file.sql] [--rewrite rewrites.json] [--target <F1|fingerprint>]
  sql-anything verify --db <db> --baseline-dir <dir> --patched-dir <dir> (--check-url <url> --run "<server cmd>" | --check-cmd "<cmd>")
  sql-anything bench  (same flags as verify; timing only, no pass/fail)
  sql-anything report [--trace <dir>] [--fix F1...] [--out <dir>] [--label "synthetic demo"]
  sql-anything demo   [--out dir] [--no-open]   zero-config showcase on a synthetic SQLite shop (about 15 s)
  sql-anything mcp    (stdio MCP server: scan, verify, verify_workload, fix, report)

Exit codes: 0 ok / verified win, 2 patch rejected by the gate, 3 usage or environment error, 4 nothing captured or result unverifiable.
Kill switch: SQL_ANYTHING_DISABLE=1 makes the capture hook do nothing and refuses go/fix.
`;

const num = (s?: string) => (s === undefined ? undefined : Number(s));
const err = (s: string) => console.error(s);

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

function printGates(r: { gates: any[]; reason?: string; warnings?: string[] }): void {
  for (const g of r.gates) {
    const mark = g.status === 'pass' ? 'PASS' : g.status === 'fail' ? 'FAIL' : 'skip';
    console.log(`  [${mark}] ${g.name}: ${g.measured}   (need: ${g.threshold})`);
    if (g.detail) console.log(`         ${g.detail}`);
  }
  if (r.reason) console.log(`  reason: ${r.reason}`);
  for (const w of r.warnings ?? []) console.log(`  warning: ${w}`);
}

function split(argv: string[]): { own: string[]; rest: string[] } {
  const i = argv.indexOf('--');
  return i < 0 ? { own: argv, rest: [] } : { own: argv.slice(0, i), rest: argv.slice(i + 1) };
}

async function cmdScan(argv: string[]): Promise<number> {
  const { own, rest } = split(argv);
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
  const r = await runScan({
    db: values.db,
    trace: values.trace,
    cmd: rest,
    duration: values.duration,
    hits: values.hit,
    hitRepeat: num(values['hit-repeat']),
    explain: !values['no-explain'],
    explainTop: num(values['explain-top']),
    nPlusOneMin: num(values['n-plus-one-min']),
    allowRemote: !!values['allow-remote-shadow'],
    log: err,
  });
  if (r.exitCode !== 0) {
    err(r.error ?? 'nothing captured');
    return r.exitCode;
  }
  if (values.json) console.log(JSON.stringify(r.report, null, 2));
  else printScan(r.report!, r.dir);
  return 0;
}

async function cmdVerify(argv: string[], bench: boolean): Promise<number> {
  const { own } = split(argv);
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
      'max-seconds': { type: 'string' },
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
  if (values['check-url'] || values['check-cmd']) {
    if (!values['baseline-dir'] || !values['patched-dir']) throw new UsageError('N+1 check needs --baseline-dir and --patched-dir (two checkouts: before and after the patch)');
    const r = await check({
      db: parseTarget(values.db),
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
  const { result: r } = await runVerify({
    db: values.db,
    trace: values.trace,
    migrationSql: values.migration ? fs.readFileSync(values.migration, 'utf8') : undefined,
    rewrites: values.rewrite ? JSON.parse(fs.readFileSync(values.rewrite, 'utf8')) : undefined,
    target: values.target,
    samples: num(values.samples),
    rounds: num(values.rounds),
    minSpeedup: num(values['min-speedup']),
    maxRegress: num(values['max-regress']),
    writeBudget: num(values['write-budget']),
    maxSeconds: num(values['max-seconds']),
    seed: num(values.seed),
    allowRemote: !!values['allow-remote-shadow'],
    gate: !bench,
  });
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${bench ? 'bench' : 'verify'}: ${r.verdict}  (${r.verified}/${r.replayed} replayed inputs identical, ${r.unverifiable.count} unverifiable${r.unverifiable.count ? ' ' + JSON.stringify(r.unverifiable.reasons) : ''})`);
    printGates(r);
    for (const m of r.mismatches.slice(0, 3)) console.log(`  mismatch ${m.fingerprint}: ${m.reason}`);
    if (r.speed) console.log(`  target p50 ${r.speed.baseP50Ms} -> ${r.speed.patchedP50Ms} ms, p95 ${r.speed.baseP95Ms} -> ${r.speed.patchedP95Ms} ms (seed ${r.seed})`);
  }
  return r.exitCode;
}

const fixOptions = {
  db: { type: 'string' },
  trace: { type: 'string' },
  agent: { type: 'string' },
  'agent-cmd': { type: 'string' },
  'no-index': { type: 'boolean' },
  migration: { type: 'string' },
  'max-attempts': { type: 'string' },
  'agent-timeout': { type: 'string' },
  run: { type: 'string' },
  'check-url': { type: 'string' },
  'check-cmd': { type: 'string' },
  reps: { type: 'string' },
  project: { type: 'string' },
  'min-speedup': { type: 'string' },
  'max-seconds': { type: 'string' },
  'allow-remote-shadow': { type: 'boolean' },
  seed: { type: 'string' },
  json: { type: 'boolean' },
} as const;

function checkOpts(v: any) {
  return v['check-url'] || v['check-cmd'] ? { runCmd: v.run ? shellSplit(v.run) : undefined, checkUrl: v['check-url'], checkCmd: v['check-cmd'] ? shellSplit(v['check-cmd']) : undefined, reps: num(v.reps) } : undefined;
}

async function cmdFix(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: fixOptions, allowPositionals: true });
  if (!values.db) throw new UsageError('--db <sqlite-file|postgres-url> is required');
  const id = positionals[0];
  if (!id) throw new UsageError('which finding? e.g. `sql-anything fix F1 --db app.db` (ids come from `scan`)');
  const runDir = values.trace ? path.resolve(values.trace) : latestRunDir();
  if (!runDir) throw new UsageError('no captured run found: run `sql-anything scan ... -- <app>` first');
  const agent = resolveAgent(values.agent, values['agent-cmd'], shellSplit);
  const r = await fix({
    runDir,
    findingId: id,
    db: values.db,
    projectDir: values.project ? path.resolve(values.project) : undefined,
    agent,
    deterministic: !values['no-index'],
    userMigration: values.migration ? fs.readFileSync(values.migration, 'utf8') : undefined,
    maxAttempts: num(values['max-attempts']),
    agentTimeoutMs: values['agent-timeout'] ? Number(values['agent-timeout']) * 1000 : undefined,
    check: checkOpts(values),
    minSpeedup: num(values['min-speedup']),
    tuning: values['max-seconds'] ? { maxSeconds: Number(values['max-seconds']) } : undefined,
    allowRemote: !!values['allow-remote-shadow'],
    seed: num(values.seed),
    log: err,
  });
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.status.toUpperCase()}: ${r.message}`);
    for (const a of r.attempts) console.log(`  attempt ${a.n} [${a.via}] ${a.outcome}: ${a.description}${a.failed.length ? '\n      ' + a.failed.join('\n      ') : ''}`);
    if (r.record?.migrationSql) console.log(`\nmigration (apply it yourself):\n  ${r.record.migrationSql}\nrollback:\n  ${r.record.downSql}`);
    if (r.record?.patchFile) console.log(`\napply:    git apply ${path.join(r.dir!, r.record.patchFile)}\nrollback: git apply -R ${path.join(r.dir!, r.record.patchFile)}`);
  }
  return r.status === 'verified' ? EXIT.OK : r.status === 'rejected' ? EXIT.REJECTED : EXIT.UNVERIFIABLE;
}

async function cmdGo(argv: string[]): Promise<number> {
  const { own, rest } = split(argv);
  const { values } = parseArgs({
    args: own,
    options: { ...fixOptions, hit: { type: 'string', multiple: true }, 'hit-repeat': { type: 'string' }, duration: { type: 'string' }, 'max-fixes': { type: 'string' }, label: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });
  if (!values.db) throw new UsageError('--db <sqlite-file|postgres-url> is required');
  if (!rest.length) throw new UsageError('go needs your app command after "--", e.g. sql-anything go --db app.db --agent claude -- node server.js');
  const agent = resolveAgent(values.agent, values['agent-cmd'], shellSplit);
  const opts = {
    cmd: rest,
    db: values.db,
    cwd: values.project ? path.resolve(values.project) : undefined,
    agent,
    hits: values.hit,
    hitRepeat: num(values['hit-repeat']),
    duration: values.duration,
    maxFixes: num(values['max-fixes']),
    maxAttempts: num(values['max-attempts']),
    agentTimeoutMs: values['agent-timeout'] ? Number(values['agent-timeout']) * 1000 : undefined,
    check: checkOpts(values),
    minSpeedup: num(values['min-speedup']),
    tuning: values['max-seconds'] ? { maxSeconds: Number(values['max-seconds']) } : undefined,
    allowRemote: !!values['allow-remote-shadow'],
    label: values.label,
    seed: num(values.seed),
    dryRun: !!values['dry-run'],
    log: err,
  };
  console.log('sql-anything go: plan');
  for (const l of goPlan(opts)) console.log('  ' + l);
  if (opts.dryRun) return 0;
  console.log('');
  const r = await go(opts);
  if (r.error) {
    err(r.error);
    return r.exitCode;
  }
  console.log(`\nfound ${r.findings.length} finding(s) in ${r.dir}`);
  for (const f of r.fixes) {
    console.log(`  ${f.status.toUpperCase().padEnd(12)} ${f.message}`);
    for (const a of f.attempts.filter((x) => x.outcome !== 'verified')) console.log(`      attempt ${a.n} [${a.via}] ${a.outcome}: ${a.failed[0] ?? a.description}`);
  }
  if (r.report) console.log(`\nreport: ${r.report.files.join('\n        ')}`);
  return r.exitCode;
}

async function cmdReport(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { trace: { type: 'string' }, fix: { type: 'string', multiple: true }, out: { type: 'string' }, label: { type: 'string' } } });
  const dir = values.trace ? path.resolve(values.trace) : latestRunDir();
  if (!dir) throw new UsageError('no captured run found: run `sql-anything scan` / `go` first or pass --trace <dir>');
  loadFindings(dir);
  const r = writeReport({ runDir: dir, ids: values.fix, outDir: values.out, label: values.label });
  if (!r.cards.length) {
    console.log('no verified fixes in this run yet: run `sql-anything fix <F1> --db ...` or `sql-anything go` first.');
    return EXIT.UNVERIFIABLE;
  }
  for (const f of r.files) console.log(f);
  return EXIT.OK;
}

async function cmdDemo(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' }, 'no-open': { type: 'boolean' }, keep: { type: 'boolean' } } });
  const { demo } = await import('./demo.js');
  console.log('sql-anything demo: synthetic SQLite shop, no Docker, no network, no API key');
  const r = await demo({ out: values.out, open: !values['no-open'], keep: !!values.keep, log: (s) => console.log(s) });
  for (const n of r.notes) console.log(`
note: ${n}`);
  console.log(`
done in ${r.seconds.toFixed(1)}s (exit ${r.exitCode})`);
  return r.exitCode;
}

/** One handler per command. Typed against COMMANDS: adding a command without a handler (or the reverse) does not compile. */
const HANDLERS: Record<Command, (rest: string[]) => Promise<number>> = {
  go: cmdGo,
  scan: cmdScan,
  fix: cmdFix,
  verify: (r) => cmdVerify(r, false),
  bench: (r) => cmdVerify(r, true),
  report: cmdReport,
  demo: cmdDemo,
  mcp: async () => {
    const { serveStdio } = await import('./mcp.js');
    await serveStdio();
    return await new Promise<number>(() => {}); // the stdio server runs until the client closes the pipe
  },
};

async function main(): Promise<number> {
  muteSqliteWarning();
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
      console.log(USAGE);
      return cmd === undefined ? EXIT.USAGE : EXIT.OK;
    }
    if (!(COMMANDS as readonly string[]).includes(cmd)) {
      err(`unknown command "${cmd}"

${USAGE}`);
      return EXIT.USAGE;
    }
    return await HANDLERS[cmd as Command](rest);
  } catch (e: any) {
    err(`error: ${e?.message ?? e}`);
    return EXIT.USAGE;
  }
}

if (process.argv[2] !== 'mcp') process.exitCode = await main();
else await main();
