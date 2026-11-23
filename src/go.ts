import path from 'node:path';
import type { AgentSpec } from './agent.js';
import { runScan, UsageError } from './api.js';
import { fix } from './fix/fix.js';
import type { FixResult } from './fix/types.js';
import type { Finding } from './scan/analyze.js';
import { writeReport, type ReportOutcome } from './report/report.js';
import type { CheckOptions } from './verify/check.js';

export interface GoOptions {
  cmd: string[];
  db: string;
  cwd?: string;
  agent?: AgentSpec | null;
  hits?: string[];
  hitRepeat?: number;
  duration?: string;
  maxFixes?: number;
  maxAttempts?: number;
  check?: Partial<Pick<CheckOptions, 'runCmd' | 'checkUrl' | 'checkCmd' | 'reps'>>;
  minSpeedup?: number;
  allowRemote?: boolean;
  agentTimeoutMs?: number;
  label?: string;
  dryRun?: boolean;
  seed?: number;
  log?: (s: string) => void;
}

export interface GoOutcome {
  exitCode: 0 | 2 | 4;
  dir?: string;
  plan: string[];
  findings: Finding[];
  fixes: FixResult[];
  report?: ReportOutcome;
  error?: string;
}

/** The staged plan, printed before anything runs so the one-command flow is predictable. */
export function goPlan(o: GoOptions): string[] {
  return [
    `1. capture   run \`${o.cmd.join(' ')}\` with the capture hook${o.hits?.length ? `, request ${o.hits.join(', ')} ×${o.hitRepeat ?? 1}` : o.duration ? ` for ${o.duration}` : ' until it exits'}`,
    `2. scan      rank findings (EXPLAIN on a clone of ${o.db.replace(/\/\/[^@/]*@/, '//***@')}, never the live database)`,
    `3. fix       top ${o.maxFixes ?? 3} findings: deterministic index candidates first${o.agent ? `, then ${o.agent.name} (max ${o.maxAttempts ?? 3} attempts each) for code/query changes` : ' (no agent: N+1 and rewrites are listed, not fixed)'}`,
    '4. verify    every candidate must pass the gate on database clones: row parity, interleaved speedup, no regressions, write guard',
    '5. report    Markdown PR block + SVG benchmark card for each verified fix',
    'Your repository and database are not modified: verified changes are written as files under .sql-anything/ (migration.sql, down.sql, fix.patch).',
  ];
}

export async function go(o: GoOptions): Promise<GoOutcome> {
  if (process.env.SQL_ANYTHING_DISABLE === '1') throw new UsageError('SQL_ANYTHING_DISABLE=1 is set: sql-anything is switched off, nothing was run');
  const log = o.log ?? (() => {});
  const plan = goPlan(o);
  if (o.dryRun) return { exitCode: 0, plan, findings: [], fixes: [] };

  const scan = await runScan({ db: o.db, cmd: o.cmd, cwd: o.cwd, hits: o.hits, hitRepeat: o.hitRepeat, duration: o.duration, allowRemote: o.allowRemote, log });
  if (scan.exitCode !== 0 || !scan.report) return { exitCode: 4, dir: scan.dir, plan, findings: [], fixes: [], error: scan.error };
  const findings = scan.report.findings;
  if (!findings.length) return { exitCode: 0, dir: scan.dir, plan, findings, fixes: [] };

  // one fix per fingerprint: an N+1 and its seq scan are the same statement
  const seen = new Set<string>();
  const todo = findings.filter((f) => (seen.has(f.fingerprint) ? false : (seen.add(f.fingerprint), true))).slice(0, o.maxFixes ?? 3);
  const check = o.check ?? (o.hits?.length ? { runCmd: o.cmd, checkUrl: o.hits[0] } : undefined);
  const fixes: FixResult[] = [];
  for (const f of todo) {
    fixes.push(
      await fix({
        runDir: scan.dir,
        findingId: f.id,
        db: o.db,
        projectDir: o.cwd,
        agent: o.agent,
        maxAttempts: o.maxAttempts,
        check,
        minSpeedup: o.minSpeedup,
        allowRemote: o.allowRemote,
        agentTimeoutMs: o.agentTimeoutMs,
        seed: o.seed,
        log,
      }),
    );
  }
  const ok = fixes.filter((x) => x.status === 'verified');
  const report = ok.length ? writeReport({ runDir: scan.dir, ids: ok.map((x) => x.findingId), label: o.label, projectRoot: path.resolve(o.cwd ?? process.cwd()) }) : undefined;
  const exitCode: GoOutcome['exitCode'] = ok.length ? 0 : fixes.some((x) => x.status === 'rejected') ? 2 : 4;
  return { exitCode, dir: scan.dir, plan, findings, fixes, report };
}
