/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { capture } from '../../src/capture.js';
import { openConn, type DbTarget } from '../../src/db/conn.js';
import { makeShadows } from '../../src/db/shadow.js';
import { analyze } from '../../src/scan/analyze.js';
import { decodeParams } from '../../src/trace/params.js';
import { readTrace } from '../../src/trace/read.js';
import { verify } from '../../src/verify/verify.js';
import { FIXTURES, freePort, seedPg, startPg, tmpDir } from '../helpers.js';

let server: Awaited<ReturnType<typeof startPg>>;
let db: DbTarget;
let traceDir: string;

before(async () => {
  server = await startPg();
  db = await seedPg(await server.createDb('scan_app'));
  traceDir = path.join(tmpDir(), 'trace');
  const port = await freePort();
  const cap = await capture({
    cmd: [process.execPath, path.join(FIXTURES, 'pg-app.js')],
    traceDir,
    env: { DATABASE_URL: db.url, PORT: String(port) },
    hits: [`http://127.0.0.1:${port}/`],
    hitRepeat: 2,
    quiet: true,
  });
  assert.ok(cap.hits.length === 2 && cap.hits.every((h) => h.status === 200), JSON.stringify(cap.hits.map((h) => [h.status, h.body.slice(0, 80)])));
}, { timeout: 180_000 });
after(async () => {
  await server?.stop();
});

describe('scan on a real app (Postgres, pg Pool)', () => {
  it('captures pg through the Pool callback path, with request grouping and exact param types', () => {
    const t = readTrace(traceDir);
    assert.ok(t.hooks.length >= 1);
    const lookups = t.records.filter((r) => r.sql.startsWith('select count(*) as c from orders'));
    assert.equal(lookups.length, 150, '3 requests (2 hits + readiness probe) x 50 customers');
    assert.ok(lookups.every((r) => r.req !== null));
    const typed = t.records.find((r) => r.sql.includes('::timestamptz'))!;
    const [d, big] = decodeParams(typed.params);
    assert.ok(d instanceof Date);
    assert.equal((d as Date).toISOString(), '2026-11-23T10:00:00.123Z');
    assert.equal(big, 9007199254740993n);
  });

  it('EXPLAIN (ANALYZE, BUFFERS) on a shadow clone flags the selective Seq Scan and the N+1', async () => {
    const t = readTrace(traceDir);
    const sh = await makeShadows(db, 1);
    assert.equal(sh.method, 'template', 'app was stopped, so a real CREATE DATABASE ... TEMPLATE clone is used');
    const conn = await openConn(sh.targets[0]);
    try {
      const rep = await analyze(t.records, t.hooks.length, { shadow: conn });
      const scan = rep.findings.find((f) => f.kind === 'seq-scan')!;
      assert.ok(scan, JSON.stringify(rep.findings.map((f) => [f.kind, f.sql])));
      assert.match(scan.plan!.summary, /Seq Scan on orders/);
      assert.ok(scan.plan!.selectiveSeqScans[0].rejected > 0.99);
      assert.ok(scan.plan!.execMs! > 0);
      const n1 = rep.findings.find((f) => f.kind === 'n+1')!;
      assert.equal(n1.fingerprint, scan.fingerprint);
      assert.equal(n1.n1!.maxPerRequest, 50);
      assert.match(n1.callsite!, /pg-app\.js:\d+:\d+$/);
      assert.ok(!rep.findings.some((f) => /^(begin|commit|rollback)/.test(f.sql)));
    } finally {
      await conn.close();
      await sh.dispose();
    }
    // the shadow database is gone afterwards and the source was never touched
    const admin = await openConn({ kind: 'pg', url: db.url.replace('/scan_app', '/postgres') });
    const left = await admin.query("select datname from pg_database where datname like 'sa_shadow_%'");
    await admin.close();
    assert.equal(left.rows.length, 0, 'no shadow database is left behind');
  });

  it('end to end: the captured trace verifies a real CREATE INDEX (typed params replay exactly)', async () => {
    const t = readTrace(traceDir);
    const r = await verify({ db, records: t.records, migrationSql: 'create index idx_orders_customer on orders(customer_id)', seed: 5 });
    assert.equal(r.verdict, 'PASS', JSON.stringify({ g: r.gates, m: r.mismatches, u: r.unverifiable, reason: r.reason }));
    assert.equal(r.shadowMethod, 'template');
    console.log(`    [pg e2e] ${r.verified}/${r.replayed} captured inputs identical; speedup ${r.speed!.speedup.point.toFixed(1)}x (CI lo ${r.speed!.speedup.lo.toFixed(1)})`);
  });

  it('with the app still connected, falls back to a same-database schema clone and says so', async () => {
    const pg: any = (await import('pg')).default;
    const busy = new pg.Client({ connectionString: db.url }); // an open session blocks CREATE DATABASE ... TEMPLATE
    await busy.connect();
    try {
      const t = readTrace(traceDir);
      const r = await verify({ db, records: t.records, migrationSql: 'create index idx_orders_customer on orders(customer_id)', seed: 5 });
      assert.equal(r.shadowMethod, 'schema-clone');
      assert.ok(r.warnings.some((w) => /schema clones/.test(w)));
      assert.equal(r.verdict, 'PASS', JSON.stringify({ g: r.gates, m: r.mismatches, reason: r.reason }));
      const left = await busy.query("select nspname from pg_namespace where nspname like 'sa_shadow_%'");
      assert.equal(left.rows.length, 0, 'schema clones are dropped afterwards');
      const idx = await busy.query("select indexname from pg_indexes where indexname = 'idx_orders_customer'");
      assert.equal(idx.rows.length, 0, 'the migration only ever touched the clone');
    } finally {
      await busy.end();
    }
  });

  it('refuses to clone a non-local host unless told to', async () => {
    await assert.rejects(makeShadows({ kind: 'pg', url: 'postgres://db.example.com:5432/prod' }, 1), /refusing to clone db\.example\.com/);
  });
});
