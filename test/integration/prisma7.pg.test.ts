/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { capture } from '../../src/capture.js';
import { analyze } from '../../src/scan/analyze.js';
import { readTrace } from '../../src/trace/read.js';
import { FIXTURES, REPO, findLine, freePort, startPg, tmpDir } from '../helpers.js';

let server: Awaited<ReturnType<typeof startPg>>;
let proj: string;
let url: string;

before(async () => {
  server = await startPg();
  url = await server.createDb('prisma7');
  proj = tmpDir('sa-prisma7-');
  // copy the fixture project (schema, config, app) and link the repo's node_modules like a real install
  for (const f of ['prisma.config.mjs', 'app.mjs']) fs.copyFileSync(path.join(REPO, 'test', 'fixtures', 'prisma7', f), path.join(proj, f));
  fs.mkdirSync(path.join(proj, 'prisma'));
  fs.copyFileSync(path.join(REPO, 'test', 'fixtures', 'prisma7', 'prisma', 'schema.prisma'), path.join(proj, 'prisma', 'schema.prisma'));
  fs.writeFileSync(path.join(proj, 'package.json'), '{"type":"module","private":true}');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(proj, 'node_modules'), 'junction');
  const prisma = path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js');
  // plain `db push` into a brand-new empty database: no data-loss flag, no consent override
  for (const args of [['generate'], ['db', 'push']]) {
    const r = spawnSync(process.execPath, [prisma, ...args], { cwd: proj, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    assert.equal(r.status, 0, `prisma ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
}, { timeout: 240_000 });

after(async () => {
  try {
    fs.unlinkSync(path.join(proj, 'node_modules')); // the junction, never its target
  } catch {
    try {
      fs.rmdirSync(path.join(proj, 'node_modules'));
    } catch {
      /* gone */
    }
  }
  fs.rmSync(proj, { recursive: true, force: true });
  await server?.stop();
});

describe('Prisma 7 (@prisma/adapter-pg) through the production --import hook', () => {
  it('captures the Prisma queries, groups them per HTTP request, and attributes the N+1 to the app line', async () => {
    const port = await freePort();
    const traceDir = path.join(proj, 'trace');
    const cap = await capture({ cmd: [process.execPath, 'app.mjs'], cwd: proj, traceDir, env: { DATABASE_URL: url, PORT: String(port) }, hits: [`http://127.0.0.1:${port}/`], hitRepeat: 2, quiet: true });
    assert.ok(cap.hits.length === 2 && cap.hits.every((h) => h.status === 200), JSON.stringify(cap.hits.map((h) => [h.status, h.body.slice(0, 120)])));
    assert.equal(JSON.parse(cap.hits[0].body).length, 8);

    const t = readTrace(traceDir);
    assert.ok(t.hooks.length >= 1, 'the production hook loaded in the Prisma process');
    assert.ok(t.records.every((r) => r.db === 'pg'), 'Prisma 7 runs through pg, so the pg hook sees everything');
    const isLookup = (r: { sql: string }) => /from "public"\."Post" where/i.test(r.sql) || /"Post"\."authorId" = \$1/.test(r.sql);
    const inRequests = t.records.filter((r) => isLookup(r) && r.req !== null);
    assert.equal(inRequests.length, 3 * 8, '3 requests (2 hits + readiness probe) x 8 lookups, each tagged with its HTTP request via AsyncLocalStorage');
    assert.equal(new Set(inRequests.map((r) => r.req)).size, 3, 'three distinct requests');
    assert.ok(t.records.some((r) => r.req === null && /insert into "public"."User"/i.test(r.sql)), 'the startup seeding ran outside any request and has no request id');

    const rep = await analyze(t.records, t.hooks.length, {});
    assert.ok(!rep.findings.some((f) => /^(begin|commit|rollback)/i.test(f.sql)), 'BEGIN/COMMIT that Prisma wraps around writes is filtered');
    const n1 = rep.findings.find((f) => f.kind === 'n+1')!;
    assert.ok(n1, JSON.stringify(rep.findings.map((f) => [f.kind, f.sql])));
    assert.equal(n1.n1!.maxPerRequest, 8);
    assert.equal(n1.callsiteConfidence, 'exact');
    const line = findLine(path.join(proj, 'app.mjs'), '// N+1');
    const m = /app\.mjs:(\d+):\d+$/.exec(n1.callsite!);
    assert.ok(m && Number(m[1]) === line, `callsite ${n1.callsite} should be app.mjs line ${line}`);
  });
});
