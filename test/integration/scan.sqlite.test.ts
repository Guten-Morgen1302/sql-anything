/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { capture } from '../../src/capture.js';
import { openConn } from '../../src/db/conn.js';
import { makeShadows } from '../../src/db/shadow.js';
import { analyze } from '../../src/scan/analyze.js';
import { readTrace } from '../../src/trace/read.js';
import { FIXTURES, findLine, freePort, seedSqlite, tmpDir } from '../helpers.js';

let dir: string;
let dbFile: string;
before(async () => {
  dir = tmpDir();
  dbFile = path.join(dir, 'app.db');
  await seedSqlite(dbFile);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('scan on a real app (SQLite, better-sqlite3 + http)', () => {
  it('finds the N+1 with its source file:line, flags the selective seq scan, ignores BEGIN/COMMIT, ranks by impact', async () => {
    const port = await freePort();
    const traceDir = path.join(dir, 'trace');
    const app = path.join(FIXTURES, 'sqlite-app.js');
    const cap = await capture({ cmd: [process.execPath, app], traceDir, env: { SQL_ANYTHING_DB_URL: dbFile, PORT: String(port) }, hits: [`http://127.0.0.1:${port}/`], hitRepeat: 3, quiet: true });
    assert.equal(cap.hits.length, 3);
    assert.ok(cap.hits.every((h) => h.status === 200));

    const trace = readTrace(traceDir);
    assert.ok(trace.hooks.length >= 1);
    const sh = await makeShadows({ kind: 'sqlite', url: dbFile }, 1);
    const conn = await openConn(sh.targets[0]);
    let rep;
    try {
      rep = await analyze(trace.records, trace.hooks.length, { shadow: conn });
    } finally {
      await conn.close();
      await sh.dispose();
    }

    assert.ok(rep.captured.noiseFiltered >= 2, `BEGIN/COMMIT noise ignored, got ${rep.captured.noiseFiltered}`);
    assert.ok(trace.records.some((r) => /^begin/i.test(r.sql)), 'the trace keeps the raw statements');
    assert.ok(!rep.findings.some((f) => /^(begin|commit)/.test(f.sql)), 'transaction control never becomes a finding');
    const n1 = rep.findings.find((f) => f.kind === 'n+1')!;
    assert.ok(n1, JSON.stringify(rep.findings.map((f) => f.kind)));
    assert.equal(n1.n1!.requests, 4, 'grouped per HTTP request (AsyncLocalStorage): 3 hits + the readiness probe, which is a real request too');
    assert.equal(n1.n1!.grouping, 'request');
    assert.equal(n1.n1!.maxPerRequest, 50);
    assert.equal(n1.calls, 4 * 50);
    const line = findLine(app, 'where customer_id = ?');
    assert.equal(n1.callsiteConfidence, 'exact');
    assert.ok(n1.callsite!.endsWith(`sqlite-app.js:${line}:${n1.callsite!.split(':').at(-1)}`), `callsite ${n1.callsite} should be line ${line} of sqlite-app.js`);
    assert.ok(n1.sql.includes('customer_id = ?'));

    const scan = rep.findings.find((f) => f.kind === 'seq-scan' && f.sql.includes('from orders'))!;
    assert.ok(scan, 'selective full scan of orders is a finding');
    assert.match(scan.detail, /orders/);
    assert.ok(!rep.findings.some((f) => /customers where region/.test(f.sql) && f.kind === 'seq-scan'), 'a scan of a 500-row table is not a finding');

    const scores = rep.findings.map((f) => f.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'ranked by impact x class weight');
    assert.deepEqual(rep.findings.map((f) => f.id), rep.findings.map((_, i) => `F${i + 1}`));
  });

  it('without request context, groups an N+1 as a low-confidence burst', async () => {
    const traceDir = path.join(dir, 'trace-script');
    const script = path.join(dir, 'script.mjs');
    fs.writeFileSync(
      script,
      `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(path.join(FIXTURES, 'x.js'))})('better-sqlite3');
const db = new Database(process.env.SQL_ANYTHING_DB_URL);
for (let i = 1; i <= 8; i++) db.prepare('select count(*) as c from orders where customer_id = ?').get(i);
`,
    );
    await capture({ cmd: [process.execPath, script], traceDir, env: { SQL_ANYTHING_DB_URL: dbFile }, quiet: true });
    const t = readTrace(traceDir);
    const rep = await analyze(t.records, t.hooks.length, {});
    const n1 = rep.findings.find((f) => f.kind === 'n+1')!;
    assert.ok(n1);
    assert.equal(n1.n1!.grouping, 'burst');
    assert.equal(n1.calls, 8);
  });

  it('exit-code contract: a run where the hook never loads is detectable (no hook-loaded marker)', async () => {
    const traceDir = path.join(dir, 'trace-dead');
    await capture({ cmd: [process.execPath, '-e', '1'], traceDir, env: { SQL_ANYTHING_DISABLE: '1' }, quiet: true });
    const t = readTrace(traceDir);
    assert.equal(t.hooks.length, 0);
    assert.equal(t.records.length, 0);
  });
});
