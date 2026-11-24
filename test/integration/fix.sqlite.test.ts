/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { runScan } from '../../src/api.js';
import { go } from '../../src/go.js';
import { fix } from '../../src/fix/fix.js';
import { writeReport } from '../../src/report/report.js';
import { FIXTURES, REPO, seedSqlite, tmpDir } from '../helpers.js';

let root: string;
let dbFile: string;
let project: string;
const agent = (mode: string) => {
  process.env.SA_FAKE_MODE = mode;
  return { name: 'fake', cmd: [process.execPath, path.join(FIXTURES, 'fake-agent.js')] };
};
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const CHECK_CMD = { checkCmd: [process.execPath, 'server.mjs', 'cmd-all'], reps: 8 };

/** A real git project: the fixture app as server.mjs, node_modules linked, one commit. */
function makeProject(): string {
  const dir = path.join(root, 'project-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.mjs'), fs.readFileSync(path.join(FIXTURES, 'sqlite-app.js'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","private":true}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.sql-anything/\n');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  // a real checkout: with core.autocrlf=true (the Windows default) tracked files sit on disk with CRLF, not as node wrote them
  for (const f of ['server.mjs', 'package.json', '.gitignore']) fs.rmSync(path.join(dir, f));
  git(dir, 'checkout', '-q', '--', '.');
  return dir;
}

async function scanProject(dir: string, port: number) {
  process.env.PORT = String(port);
  const r = await runScan({ cmd: [process.execPath, 'server.mjs'], cwd: dir, db: dbFile, hits: [`http://127.0.0.1:${port}/`], hitRepeat: 3 });
  assert.equal(r.exitCode, 0, r.error);
  return r;
}

before(async () => {
  root = tmpDir();
  dbFile = path.join(root, 'app.db');
  await seedSqlite(dbFile);
  process.env.SQL_ANYTHING_DB_URL = dbFile; // what the app reads; the agent must NOT see it
});
after(() => {
  delete process.env.SA_FAKE_MODE;
  delete process.env.SA_FAKE_LOG;
  for (const d of fs.readdirSync(root)) {
    const nm = path.join(root, d, 'node_modules');
    try {
      fs.unlinkSync(nm);
    } catch {
      try {
        fs.rmdirSync(nm);
      } catch {
        /* no link */
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

let port = 41800;
beforeEach(() => {
  port += 1;
});

describe('fix: deterministic index path (no agent, no LLM)', () => {
  it('finds a CREATE INDEX that passes the gate, writes migration + rollback, and the card/markdown carry only verified numbers', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const seq = s.report!.findings.find((f) => f.kind === 'seq-scan')!;
    assert.ok(seq, 'scan flags the selective scan of orders');
    const r = await fix({ runDir: s.dir, findingId: seq.id, db: dbFile, agent: null, seed: 11 });
    assert.equal(r.status, 'verified', JSON.stringify(r.attempts));
    assert.equal(r.record!.via, 'index-candidate');
    assert.match(r.record!.migrationSql!, /CREATE INDEX IF NOT EXISTS "idx_orders_customer_id" ON "orders" \("customer_id"\);/);
    assert.match(r.record!.downSql!, /DROP INDEX IF EXISTS "idx_orders_customer_id"/);
    assert.ok(fs.existsSync(path.join(r.dir!, 'migration.sql')) && fs.existsSync(path.join(r.dir!, 'down.sql')) && fs.existsSync(path.join(r.dir!, 'verify.json')));
    assert.equal(r.record!.verify!.verdict, 'PASS');
    assert.match(r.record!.verify!.plans!.before, /SCAN/);
    assert.match(r.record!.verify!.plans!.after, /SEARCH.*idx_orders_customer_id/);

    const rep = writeReport({ runDir: s.dir, projectRoot: project, label: 'synthetic demo' });
    const svg = fs.readFileSync(path.join(path.dirname(rep.files[0]), 'card-' + seq.id + '.svg'), 'utf8');
    const sp = r.record!.verify!.speed!;
    assert.ok(svg.includes(`${sp.speedup.point >= 100 ? Math.round(sp.speedup.point) : sp.speedup.point >= 10 ? sp.speedup.point.toFixed(1) : sp.speedup.point.toFixed(2)}×`));
    assert.match(svg, /\d+\/\d+ replayed · row parity/);
    assert.ok(svg.includes('synthetic demo') && svg.includes('SCAN') && svg.includes('SEARCH'));
    assert.ok(!svg.includes(root.replace(/\\/g, '/')) && !svg.includes(root), 'no absolute paths on the card');
    assert.match(rep.markdown, /CREATE INDEX IF NOT EXISTS/);
    assert.match(rep.markdown, /Roll back: `DROP INDEX IF EXISTS/);
    assert.match(rep.markdown, /evidence, not proof/);
    assert.ok(!rep.markdown.includes(root), 'no absolute paths in the PR block');
    console.log(`    [fix] ${seq.id} ${sp.speedup.point.toFixed(1)}x, p50 ${sp.baseP50Ms} -> ${sp.patchedP50Ms} ms; plan ${r.record!.verify!.plans!.before} => ${r.record!.verify!.plans!.after}`);
    // the source database was never touched
    const { DatabaseSync } = await import('node:sqlite');
    const db: any = new DatabaseSync(dbFile, { readOnly: true } as any);
    assert.equal(db.prepare("select count(*) c from sqlite_master where type='index' and name like 'idx_orders%'").get().c, 0);
    db.close();
  });

  it('an N+1 needs a code change: without an agent it says so and changes nothing', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    const r = await fix({ runDir: s.dir, findingId: n1.id, db: dbFile, agent: null, deterministic: false });
    assert.equal(r.status, 'no-fix');
    assert.match(r.message, /needs a code change/);
  });
});

describe('fix: agent loop (scripted agent), gated by verify, git-revertable', () => {
  it('a correct N+1 fix is accepted: patch file, query count 51 -> 1, worktrees cleaned up, rollback is a git apply -R', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    const log = path.join(root, 'log-a');
    process.env.SA_FAKE_LOG = log;
    const r = await fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: project, agent: agent('fix-n1'), deterministic: false, check: CHECK_CMD, seed: 7 });
    assert.equal(r.status, 'verified', JSON.stringify(r.attempts));
    assert.equal(r.attempts.length, 1, JSON.stringify(r.attempts));
    assert.equal(r.record!.via, 'agent');
    assert.deepEqual(r.record!.changedFiles, ['server.mjs']);
    assert.deepEqual(r.record!.check!.queriesPerRun, { baseline: 1020, patched: 20 });
    assert.equal(r.record!.check!.verdict, 'PASS');
    const patch = path.join(r.dir!, 'fix.patch');
    assert.match(fs.readFileSync(patch, 'utf8'), /-const VARIANT: string = 'N1';|\+const VARIANT = 'FIXED';/);

    // clean rollback story: nothing in the user's repo changed, no worktree left, and the patch applies and reverts
    assert.equal(git(project, 'status', '--porcelain').stdout.trim(), '');
    assert.equal(git(project, 'worktree', 'list').stdout.trim().split('\n').length, 1, 'agent worktrees are removed');
    assert.equal(git(project, 'apply', '--check', patch).status, 0);
    assert.equal(git(project, 'apply', patch).status, 0);
    assert.match(fs.readFileSync(path.join(project, 'server.mjs'), 'utf8'), /VARIANT = 'FIXED'/);
    assert.equal(git(project, 'apply', '-R', patch).status, 0);
    assert.equal(git(project, 'status', '--porcelain').stdout.trim(), '', 'git apply -R restores the original byte for byte');
    assert.ok(fs.existsSync(path.join(project, 'node_modules')), 'the linked node_modules was never deleted through the junction');

    // the agent's prompt: finding + call site, no values; its environment: no database connection strings, no hook
    const prompt = fs.readFileSync(path.join(log, 'prompt-1.txt'), 'utf8');
    assert.match(prompt, /Finding F\d+ \(n\+1\)/);
    assert.match(prompt, /Issued from: server\.mjs \(line \d+\)/);
    assert.ok(!prompt.includes(root) && !prompt.includes('postgres://'));
    const keys: string[] = JSON.parse(fs.readFileSync(path.join(log, 'env-1.json'), 'utf8'));
    assert.ok(!keys.includes('SQL_ANYTHING_DB_URL') && !keys.includes('DATABASE_URL') && !keys.includes('NODE_OPTIONS'), `agent env leaked: ${keys.filter((k) => /DB|DATABASE|NODE_OPTIONS/.test(k))}`);
    assert.ok(keys.includes('SQL_ANYTHING_FINDING'));

    const rep = writeReport({ runDir: s.dir, projectRoot: project });
    const svg = fs.readFileSync(rep.cards[0].file, 'utf8');
    assert.ok(svg.includes('1020 → 20 per run') && svg.includes('endpoint wall time') && /\d\/\d runs · output parity/.test(svg));
    assert.match(rep.markdown, /git apply -R fix\.patch/);
    delete process.env.SA_FAKE_LOG;
  });

  it('a wrong patch (LEFT JOIN -> INNER JOIN) is rejected, the failure is fed back, and the second attempt is accepted', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    const log = path.join(root, 'log-b');
    process.env.SA_FAKE_LOG = log;
    const r = await fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: project, agent: agent('broken-then-fixed'), deterministic: false, check: CHECK_CMD, seed: 7 });
    assert.equal(r.status, 'verified', JSON.stringify(r.attempts));
    assert.deepEqual(r.attempts.map((a) => a.outcome), ['rejected', 'verified']);
    assert.match(r.attempts[0].failed.join(' '), /parity gate failed.*output differs at \$\.regions/);
    const second = fs.readFileSync(path.join(log, 'prompt-2.txt'), 'utf8');
    assert.match(second, /previous attempt was REJECTED/);
    assert.match(second, /output differs at \$\.regions/);
    assert.equal(git(project, 'worktree', 'list').stdout.trim().split('\n').length, 1);
    assert.equal(git(project, 'status', '--porcelain').stdout.trim(), '');
    delete process.env.SA_FAKE_LOG;
  });

  it('a patch that stays wrong is never accepted: after max attempts nothing is written and the repo is untouched', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    const r = await fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: project, agent: agent('always-broken'), deterministic: false, check: CHECK_CMD, maxAttempts: 2, seed: 7 });
    assert.equal(r.status, 'rejected');
    assert.equal(r.attempts.length, 2);
    assert.ok(r.attempts.every((a) => a.outcome === 'rejected'));
    assert.equal(r.dir, undefined);
    assert.ok(!fs.existsSync(path.join(s.dir, 'fixes', n1.id, 'patch.json')));
    assert.match(r.message, /Nothing was changed in your repository/);
    assert.equal(git(project, 'status', '--porcelain').stdout.trim(), '');
  });

  it('application code changed but no workload to measure it: UNVERIFIABLE, never accepted', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    const r = await fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: project, agent: agent('fix-n1'), deterministic: false, maxAttempts: 1 });
    assert.equal(r.status, 'unverifiable');
    assert.match(r.attempts[0].failed[0], /no workload was given to measure it/);
    assert.ok(!fs.existsSync(path.join(s.dir, 'fixes', n1.id, 'patch.json')));
  });

  it('an agent that changes nothing, crashes, or writes garbage is reported precisely, not trusted', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    const run = (mode: string) => fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: project, agent: agent(mode), deterministic: false, check: CHECK_CMD, maxAttempts: 1 });
    const noop = await run('noop');
    assert.equal(noop.attempts[0].outcome, 'no-change');
    const crash = await run('crash');
    assert.equal(crash.attempts[0].outcome, 'error');
    assert.match(crash.attempts[0].failed[0], /exited with code 7: boom: model unavailable/);
    const garbage = await run('proposal-garbage');
    assert.match(garbage.attempts[0].failed[0], /proposal\.json is not valid JSON/);
    assert.equal(git(project, 'worktree', 'list').stdout.trim().split('\n').length, 1);
  });

  it('an agent-proposed index goes through the same gate (here it passes) with no code change and no workload needed', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    const r = await fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: project, agent: agent('proposal-index'), deterministic: false, seed: 5 });
    assert.equal(r.status, 'verified', JSON.stringify(r.attempts));
    assert.match(r.record!.migrationSql!, /agent_idx_orders_customer/);
    assert.equal(r.record!.verify!.verdict, 'PASS');
    assert.equal(r.record!.patchFile, undefined, 'no source change, so no patch file');
  });

  it('refuses to start from a dirty working tree (baseline and patched must differ only by the fix)', async () => {
    project = makeProject();
    const s = await scanProject(project, port);
    const n1 = s.report!.findings.find((f) => f.kind === 'n+1')!;
    fs.appendFileSync(path.join(project, 'server.mjs'), '\n// local edit\n');
    await assert.rejects(fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: project, agent: agent('fix-n1'), deterministic: false, check: CHECK_CMD }), /uncommitted changes/);
    const plain = path.join(root, 'not-a-repo');
    fs.mkdirSync(plain);
    await assert.rejects(fix({ runDir: s.dir, findingId: n1.id, db: dbFile, projectDir: plain, agent: agent('fix-n1'), deterministic: false, check: CHECK_CMD }), /need a git repository/);
  });

  it('SQL_ANYTHING_DISABLE=1 refuses fix and go', async () => {
    process.env.SQL_ANYTHING_DISABLE = '1';
    try {
      await assert.rejects(fix({ runDir: root, findingId: 'F1', db: dbFile }), /switched off/);
      await assert.rejects(go({ cmd: [process.execPath, '-e', '1'], db: dbFile }), /switched off/);
    } finally {
      delete process.env.SQL_ANYTHING_DISABLE;
    }
  });
});

describe('go: one command, end to end', () => {
  it('--dry-run prints the staged plan and runs nothing', async () => {
    const r = await go({ cmd: [process.execPath, 'server.mjs'], db: dbFile, agent: { name: 'claude', cmd: ['claude'] }, hits: ['http://127.0.0.1:3000/'], dryRun: true });
    assert.equal(r.plan.length, 6);
    assert.match(r.plan.join('\n'), /1\. capture.*2\. scan.*3\. fix.*claude.*4\. verify.*5\. report/s);
    assert.equal(r.dir, undefined);
  });

  it('capture -> scan -> verified fix -> report, in one call', async () => {
    project = makeProject();
    process.env.PORT = String(port);
    const r = await go({ cmd: [process.execPath, 'server.mjs'], cwd: project, db: dbFile, hits: [`http://127.0.0.1:${port}/`], hitRepeat: 3, maxFixes: 1, label: 'synthetic demo', seed: 3 });
    assert.equal(r.exitCode, 0, JSON.stringify(r.fixes.map((f) => [f.status, f.message, f.attempts])));
    assert.equal(r.fixes.length, 1);
    assert.equal(r.fixes[0].status, 'verified');
    assert.ok(r.report!.files.some((f) => f.endsWith('report.md')) && r.report!.files.some((f) => f.endsWith('.svg')));
    assert.match(r.report!.markdown, /CREATE INDEX/);
  });

  it('exit 4 with a reason when nothing could be captured', async () => {
    project = makeProject();
    const r = await go({ cmd: [process.execPath, '-e', '1'], cwd: project, db: dbFile });
    assert.equal(r.exitCode, 4);
    assert.match(r.error!, /0 queries/);
  });
});
