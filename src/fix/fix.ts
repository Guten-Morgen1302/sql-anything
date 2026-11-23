/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, type AgentSpec } from '../agent.js';
import { loadFindings, UsageError } from '../api.js';
import { parseTarget, type DbTarget } from '../db/conn.js';
import type { Finding } from '../scan/analyze.js';
import { readTrace } from '../trace/read.js';
import { check, type CheckOptions, type CheckResult } from '../verify/check.js';
import { verify, type VerifyOptions, type VerifyResult } from '../verify/verify.js';
import { indexCandidates } from './candidates.js';
import type { Attempt, FixRecord, FixResult } from './types.js';

export interface FixOptions {
  runDir: string;
  findingId: string;
  db: string;
  /** the app's git checkout. Required for agent fixes: every change must be revertable. */
  projectDir?: string;
  agent?: AgentSpec | null;
  /** try deterministic CREATE INDEX candidates first (default true) */
  deterministic?: boolean;
  /** a hand-written migration to put through the gate instead of the generated candidates (down is derived for CREATE INDEX) */
  userMigration?: string;
  maxAttempts?: number;
  /** how to measure a code change end to end (needed to accept agent edits to application code) */
  check?: Partial<Pick<CheckOptions, 'runCmd' | 'checkUrl' | 'checkCmd' | 'reps'>>;
  minSpeedup?: number;
  /** sampling knobs passed to every verify call (samples, rounds, maxSeconds), e.g. for a fast demo */
  tuning?: Partial<Pick<VerifyOptions, 'samples' | 'rounds' | 'maxSeconds' | 'minSamples'>>;
  allowRemote?: boolean;
  agentTimeoutMs?: number;
  seed?: number;
  log?: (s: string) => void;
}

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// The agent worktree and its patch are blob-level: no CRLF conversion, so the patch applies to (and reverts from) the user's
// checkout byte for byte whatever core.autocrlf says on their machine.
const gitRaw = (cwd: string, ...args: string[]) => git(cwd, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args);

export function gateText(r: VerifyResult | CheckResult): string[] {
  const out = r.gates.filter((g) => g.status === 'fail').map((g) => `${g.name} gate failed: measured ${g.measured}; need ${g.threshold}${g.detail ? `. ${g.detail}` : ''}`);
  if ('mismatches' in r) for (const m of r.mismatches.slice(0, 3)) out.push(`result mismatch: ${m.reason}`);
  if (r.reason) out.push(r.reason);
  return out;
}

const rel = (p: string | null, base: string) => (p ? path.relative(base, p).split(path.sep).join('/') : null);

function callsiteText(callsite: string | null, projectDir: string): string {
  const m = callsite ? /^(.*):(d+):d+$/.exec(callsite) : null;
  if (!m) return 'Call site: unknown, search the code for this statement.';
  const file = path.isAbsolute(m[1]) ? rel(m[1], projectDir) : m[1];
  return `Issued from: ${file} (line ${m[2]})`;
}

export function buildPrompt(f: Finding, projectDir: string, previous: string[], siblings: Finding[] = []): string {
  return [
    'You are fixing ONE slow-SQL finding in this repository. Work only inside the current directory.',
    '',
    `Finding ${f.id} (${f.kind}): ${f.detail}`,
    `Statement (normalized, values removed): ${f.sql}`,
    `Fingerprint: ${f.fingerprint}`,
    f.callsite ? `Issued from: ${rel(f.callsite.replace(/:\d+$/, '').replace(/:\d+$/, ''), projectDir) ?? f.callsite} (line ${f.callsite.split(':').slice(-2)[0]})` : 'Call site: unknown, search the code for this statement.',
    f.plan ? `Query plan: ${f.plan.summary}` : '',
    siblings.length
      ? [
          '',
          'Other N+1 loops were found in the same requests. The speed gate measures the whole endpoint, so a fix for one loop alone is usually too small to pass. Fix them in the same change:',
          ...siblings.map((s) => `- ${s.id}: ${s.n1?.medianPerRequest ?? '?'} lookups per request at ${callsiteText(s.callsite, projectDir).replace('Issued from: ', '')}: ${s.sql.slice(0, 140)}`),
        ].join('\n')
      : '',
    '',
    'What to do:',
    '- For an N+1: replace the per-row lookups with eager loading or ONE batched query, keeping the output byte-for-byte identical.',
    '- For a slow statement: rewrite it, or add an index by writing .sql-anything/proposal.json as {"migration": "CREATE INDEX ..."}.',
    '- To rewrite SQL text you may also write {"rewrites": {"<fingerprint>": "<new sql with the SAME placeholders in the SAME order>"}} in that file.',
    '',
    'Hard rules:',
    '- Results must stay identical: same rows, same columns, same order, NULL handling, duplicates. LEFT JOIN must not become INNER JOIN.',
    '- Do not connect to any database and do not run the application against real data. You have no database access.',
    '- Do not edit tests, lockfiles, CI config or the sql-anything setup. Make the smallest diff that fixes this one finding.',
    '',
    'Your change is verified automatically on identical database clones: output parity and a measured speedup. A wrong or slower change is rejected and you are told why.',
    previous.length ? `\nYour previous attempt was REJECTED:\n${previous.map((p) => `- ${p}`).join('\n')}\nFix the cause; do not repeat it.` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

interface Proposal {
  migration?: string;
  rewrites?: Record<string, string>;
}

function readProposal(dir: string): Proposal | { error: string } | null {
  const f = path.join(dir, '.sql-anything', 'proposal.json');
  if (!fs.existsSync(f)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    const out: Proposal = {};
    if (p.migration !== undefined) {
      if (typeof p.migration !== 'string') return { error: 'proposal.json: "migration" must be a string of SQL' };
      out.migration = p.migration;
    }
    if (p.rewrites !== undefined) {
      if (!p.rewrites || typeof p.rewrites !== 'object' || Object.values(p.rewrites).some((v) => typeof v !== 'string')) return { error: 'proposal.json: "rewrites" must map fingerprint -> SQL string' };
      out.rewrites = p.rewrites;
    }
    return out;
  } catch (e: any) {
    return { error: `proposal.json is not valid JSON: ${e.message}` };
  }
}

function write(dir: string, name: string, content: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

/** Never recurse through a link: the node_modules junction points at the user's real dependencies. */
function removeWorktree(top: string, wt: string, links: string[]) {
  for (const link of links) {
    try {
      fs.unlinkSync(link);
    } catch {
      try {
        fs.rmdirSync(link); // Windows junction
      } catch {
        /* already gone */
      }
    }
  }
  git(top, 'worktree', 'remove', '--force', wt);
  git(top, 'worktree', 'prune');
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
}

export async function fix(o: FixOptions): Promise<FixResult> {
  if (process.env.SQL_ANYTHING_DISABLE === '1') throw new UsageError('SQL_ANYTHING_DISABLE=1 is set: sql-anything is switched off, nothing was changed');
  const log = o.log ?? (() => {});
  const report = loadFindings(o.runDir);
  const finding = report.findings.find((f) => f.id === o.findingId || f.fingerprint === o.findingId);
  if (!finding) throw new UsageError(`no finding "${o.findingId}" in ${o.runDir}`);
  const trace = readTrace(o.runDir);
  const db: DbTarget = parseTarget(o.db);
  const attempts: Attempt[] = [];
  const fixDir = path.join(o.runDir, 'fixes', finding.id);
  const minSpeedup = o.minSpeedup;

  const finish = (status: FixResult['status'], message: string, extra: Partial<FixResult> = {}): FixResult => ({ status, findingId: finding.id, attempts, message, ...extra });
  const accept = (record: Omit<FixRecord, 'attempts' | 'createdAt' | 'findingId' | 'fingerprint' | 'kind' | 'callsite' | 'sql'>): FixResult => {
    const full: FixRecord = { findingId: finding.id, fingerprint: finding.fingerprint, kind: finding.kind, callsite: finding.callsite, sql: finding.sql, attempts: attempts.length, createdAt: new Date().toISOString(), ...record };
    write(fixDir, 'patch.json', JSON.stringify(full, null, 2));
    if (full.migrationSql) write(fixDir, 'migration.sql', full.migrationSql + '\n');
    if (full.downSql) write(fixDir, 'down.sql', full.downSql + '\n');
    if (full.verify) write(fixDir, 'verify.json', JSON.stringify(full.verify, null, 2));
    if (full.check) write(fixDir, 'check.json', JSON.stringify(full.check, null, 2));
    return finish('verified', `${finding.id}: verified fix after ${attempts.length} attempt(s). Files in ${fixDir}`, { dir: fixDir, record: full });
  };

  // ---- 1. deterministic index candidates (no LLM) ------------------------------------------------------------
  const scanned = finding.plan?.selectiveSeqScans?.[0]?.table;
  if (o.userMigration) {
    const sql = o.userMigration.trim().replace(/;+$/, '');
    log(`${finding.id}: verifying your migration`);
    const r = await verify({ db, records: trace.records, migrationSql: sql, target: [finding.fingerprint], minSpeedup, allowRemote: o.allowRemote, seed: o.seed, ...o.tuning });
    const outcome: Attempt['outcome'] = r.verdict === 'PASS' ? 'verified' : r.verdict === 'REJECT' ? 'rejected' : 'unverifiable';
    attempts.push({ n: 1, via: 'user-migration', description: sql.slice(0, 200), outcome, failed: outcome === 'verified' ? [] : gateText(r) });
    const down = [...sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?("[^"]+"|\w+)/gi)].map((m) => `DROP INDEX IF EXISTS ${m[1]};`).join('\n');
    if (r.verdict === 'PASS') return accept({ via: 'user-migration', migrationSql: sql + ';', downSql: down || undefined, verify: r });
    return finish(outcome === 'rejected' ? 'rejected' : 'unverifiable', `${finding.id}: your migration did not pass the gate`);
  }
  const candidates = o.deterministic === false ? [] : indexCandidates(finding.sql, scanned).slice(0, 3);
  for (const c of candidates) {
    log(`${finding.id}: trying ${c.verifySql}`);
    const r = await verify({ db, records: trace.records, migrationSql: c.verifySql, target: [finding.fingerprint], minSpeedup, allowRemote: o.allowRemote, seed: o.seed, ...o.tuning });
    const outcome: Attempt['outcome'] = r.verdict === 'PASS' ? 'verified' : r.verdict === 'REJECT' ? 'rejected' : 'unverifiable';
    attempts.push({ n: attempts.length + 1, via: 'index-candidate', description: c.verifySql, outcome, failed: outcome === 'verified' ? [] : gateText(r) });
    if (r.verdict === 'PASS') return accept({ via: 'index-candidate', migrationSql: c.migrationSql(db.kind), downSql: c.downSql, verify: r });
  }

  // ---- 2. agent loop -----------------------------------------------------------------------------------------
  if (!o.agent) {
    const why = finding.kind === 'n+1' ? 'an N+1 needs a code change: rerun with --agent claude' : 'no deterministic index candidate passed the gate';
    return finish(attempts.some((a) => a.outcome === 'rejected') ? 'rejected' : attempts.length ? 'unverifiable' : 'no-fix', `${finding.id}: ${why}`);
  }
  const projectDir = path.resolve(o.projectDir ?? process.cwd());
  const topRun = git(projectDir, 'rev-parse', '--show-toplevel');
  if (topRun.status !== 0) throw new UsageError('agent fixes need a git repository so every change can be reverted cleanly (`git init` and commit first)');
  const top = path.resolve(topRun.stdout.trim());
  if (git(top, 'rev-parse', '--verify', 'HEAD').status !== 0) throw new UsageError('the repository has no commits yet: commit first so the fix is a clean diff against HEAD');
  const dirty = git(top, 'status', '--porcelain', '--', '.', ':(exclude,glob)**/.sql-anything/**').stdout.trim();
  if (dirty) throw new UsageError(`the working tree has uncommitted changes:\n${dirty.split('\n').slice(0, 5).join('\n')}\nCommit or stash them first so baseline and patched differ only by the fix.`);

  const max = o.maxAttempts ?? 3;
  const previous: string[] = attempts.flatMap((a) => (a.outcome === 'rejected' ? [`index attempt (${a.description}): ${a.failed.join('; ')}`] : []));
  const subdir = path.relative(top, projectDir);
  for (let n = 1; n <= max; n++) {
    const wt = path.join(o.runDir, 'work', `${finding.id}-${n}`);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    const add = gitRaw(top, 'worktree', 'add', '--detach', wt, 'HEAD');
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    const cwd = path.join(wt, subdir);
    // dependencies are not part of the checkout: link them in. Hoisted monorepos keep node_modules at the repo root, so link both.
    const links: string[] = [];
    for (const [from, to] of [[path.join(projectDir, 'node_modules'), path.join(cwd, 'node_modules')], [path.join(top, 'node_modules'), path.join(wt, 'node_modules')]]) {
      if (fs.existsSync(from) && !fs.existsSync(to) && !links.includes(to)) {
        fs.symlinkSync(from, to, 'junction');
        links.push(to);
      }
    }
    try {
      log(`${finding.id}: agent attempt ${n}/${max}`);
      const prompt = buildPrompt(finding, projectDir, previous, finding.kind === 'n+1' ? report.findings.filter((x) => x.kind === 'n+1' && x.id !== finding.id) : []);
      const run = await runAgent(o.agent, prompt, cwd, { timeoutMs: o.agentTimeoutMs, env: { SQL_ANYTHING_FINDING: finding.id } });
      if (run.timedOut || run.exitCode !== 0) {
        const why = run.timedOut ? 'the agent timed out' : `the agent exited with code ${run.exitCode}: ${run.tail.slice(-300).trim()}`;
        attempts.push({ n: attempts.length + 1, via: 'agent', description: 'agent run', outcome: 'error', failed: [why] });
        previous.length = 0;
        previous.push(why);
        continue;
      }
      gitRaw(wt, 'add', '-A', '--', '.', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.sql-anything/**');
      const changed = gitRaw(wt, 'diff', '--cached', '--name-only').stdout.split('\n').filter(Boolean);
      const proposal = readProposal(cwd);
      if (proposal && 'error' in proposal) {
        attempts.push({ n: attempts.length + 1, via: 'agent', description: 'proposal.json', outcome: 'rejected', failed: [proposal.error] });
        previous.length = 0;
        previous.push(proposal.error);
        continue;
      }
      if (!changed.length && !proposal) {
        const why = 'you made no change: no file was edited and no .sql-anything/proposal.json was written';
        attempts.push({ n: attempts.length + 1, via: 'agent', description: 'agent run', outcome: 'no-change', failed: [why] });
        previous.length = 0;
        previous.push(why);
        continue;
      }

      let vr: VerifyResult | undefined;
      let cr: CheckResult | undefined;
      const failed: string[] = [];
      let unverifiable = false;
      if (proposal && (proposal.migration || proposal.rewrites)) {
        vr = await verify({ db, records: trace.records, migrationSql: proposal.migration, rewrites: proposal.rewrites, target: proposal.rewrites ? Object.keys(proposal.rewrites) : [finding.fingerprint], minSpeedup, allowRemote: o.allowRemote, seed: o.seed, ...o.tuning });
        if (vr.verdict === 'REJECT') failed.push(...gateText(vr));
        else if (vr.verdict === 'UNVERIFIABLE') (unverifiable = true), failed.push(...gateText(vr));
      }
      if (changed.length && finding.kind !== 'n+1') {
        // The end-to-end check measures ONE workload. It can vouch for an N+1 fix to that workload, not for an unrelated statement.
        unverifiable = true;
        failed.push(`application code changed (${changed.join(', ')}) for a ${finding.kind} finding, which can only be verified query by query. Express the fix as .sql-anything/proposal.json (a migration or rewrites) instead of editing code.`);
      } else if (changed.length) {
        const c = o.check;
        if (!c?.checkUrl && !c?.checkCmd) {
          unverifiable = true;
          failed.push(`application code changed (${changed.join(', ')}) but no workload was given to measure it. Pass --check-url (with --run) or --check-cmd so the change is verified end to end.`);
        } else {
          cr = await check({ db, baselineDir: projectDir, patchedDir: cwd, ...c, minSpeedup, allowRemote: o.allowRemote, seed: o.seed });
          if (cr.verdict === 'REJECT') failed.push(...gateText(cr));
          else if (cr.verdict === 'UNVERIFIABLE') (unverifiable = true), failed.push(...gateText(cr));
        }
      }
      const outcome: Attempt['outcome'] = failed.length ? (unverifiable && !failed.some((f) => /gate failed|mismatch/.test(f)) ? 'unverifiable' : 'rejected') : 'verified';
      attempts.push({ n: attempts.length + 1, via: 'agent', description: [...changed, proposal?.migration ? 'migration' : '', proposal?.rewrites ? 'rewrites' : ''].filter(Boolean).join(', '), outcome, failed });
      if (outcome !== 'verified') {
        previous.length = 0;
        previous.push(...failed);
        continue;
      }
      const patch = gitRaw(wt, 'diff', '--cached', '--binary').stdout;
      const record: Parameters<typeof accept>[0] = { via: 'agent', changedFiles: changed, verify: vr, check: cr, rewrites: proposal?.rewrites, migrationSql: proposal?.migration, downSql: undefined };
      if (patch) {
        write(fixDir, 'fix.patch', patch);
        record.patchFile = 'fix.patch';
      }
      return accept(record);
    } finally {
      removeWorktree(top, wt, links); // the verified diff is already saved as fix.patch
    }
  }
  const last = attempts[attempts.length - 1];
  const status: FixResult['status'] = attempts.every((a) => a.outcome === 'unverifiable') ? 'unverifiable' : 'rejected';
  return finish(status, `${finding.id}: no verified fix after ${attempts.length} attempt(s). Last: ${last?.failed.join('; ') ?? 'n/a'}. Nothing was changed in your repository.`);
}
