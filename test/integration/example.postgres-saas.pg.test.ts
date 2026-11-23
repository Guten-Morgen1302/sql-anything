/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { capture } from '../../src/capture.js';
import { openConn } from '../../src/db/conn.js';
import { makeShadows } from '../../src/db/shadow.js';
import { analyze } from '../../src/scan/analyze.js';
import { fix } from '../../src/fix/fix.js';
import { readTrace } from '../../src/trace/read.js';
import { REPO, freePort, startPg, tmpDir } from '../helpers.js';

const EX = path.join(REPO, 'examples', 'postgres-saas');
let server: Awaited<ReturnType<typeof startPg>>;
let url: string;
let dir: string;

before(async () => {
  server = await startPg();
  url = await server.createDb('saas');
  dir = tmpDir('sa-saas-');
  const { seed } = await import(pathToFileURL(path.join(EX, 'seed.mjs')).href);
  const counts = await seed(url, 0.1);
  assert.ok(counts.tasks >= 12000 && counts.comments >= 20000, JSON.stringify(counts));
}, { timeout: 240_000 });
after(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await server?.stop();
});

describe('examples/postgres-saas: three classic bottlenecks, found by scan', () => {
  it('N+1 loop, unindexed multi-table join and correlated subquery are all reported', async () => {
    const port = await freePort();
    const traceDir = path.join(dir, 'trace');
    const base = `http://127.0.0.1:${port}/api/tenants/1`;
    const cap = await capture({ cmd: [process.execPath, path.join(EX, 'server.mjs')], cwd: EX, traceDir, env: { DATABASE_URL: url, PORT: String(port) }, hits: [`${base}/projects`, `${base}/overdue`, `${base}/dashboard`], hitRepeat: 2, quiet: true });
    assert.ok(cap.hits.every((h) => h.status === 200), JSON.stringify(cap.hits.map((h) => [h.url, h.status, h.body.slice(0, 100)])));
    const t = readTrace(traceDir);
    const sh = await makeShadows({ kind: 'pg', url }, 1);
    const conn = await openConn(sh.targets[0]);
    let rep;
    try {
      rep = await analyze(t.records, t.hooks.length, { shadow: conn });
    } finally {
      await conn.close();
      await sh.dispose();
    }
    const kinds = rep.findings.map((f) => `${f.kind}: ${f.sql.slice(0, 70)}`);
    const n1 = rep.findings.find((f) => f.kind === 'n+1' && /open_tasks/.test(f.sql));
    assert.ok(n1, kinds.join('\n'));
    assert.match(n1!.callsite!, /server\.mjs:\d+:\d+$/);
    assert.ok(n1!.n1!.maxPerRequest >= 90, `~94 non-archived projects per tenant, got ${n1!.n1!.maxPerRequest}`);
    const corr = rep.findings.find((f) => f.kind === 'correlated-subquery' && /comment_count/.test(f.sql));
    assert.ok(corr, kinds.join('\n'));
    const join = rep.findings.find((f) => f.kind === 'seq-scan' && /join users/.test(f.sql));
    assert.ok(join, kinds.join('\n'));
    console.log(`    [postgres-saas] findings:\n      ${rep.findings.map((f) => `${f.id} ${f.kind} score ${f.score} (${f.sql.slice(0, 60)})`).join('\n      ')}`);
    fs.writeFileSync(path.join(traceDir, 'findings.json'), JSON.stringify(rep));
  });

  it('the N+1 count query gets a verified composite index', async () => {
    const traceDir = path.join(dir, 'trace');
    const rep = JSON.parse(fs.readFileSync(path.join(traceDir, 'findings.json'), 'utf8'));
    const n1 = rep.findings.find((f: any) => f.kind === 'n+1');
    const r = await fix({ runDir: traceDir, findingId: n1.id, db: url, agent: null, seed: 3 });
    assert.equal(r.status, 'verified', JSON.stringify(r.attempts));
    assert.match(r.record!.migrationSql!, /CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_project_id_status" ON "tasks" \("project_id", "status"\);/);
    assert.match(r.record!.verify!.plans!.after, /Index/);
    console.log(`    [postgres-saas] ${r.record!.verify!.speed!.speedup.point.toFixed(1)}x; plan ${r.record!.verify!.plans!.before} => ${r.record!.verify!.plans!.after}`);
  });
});
