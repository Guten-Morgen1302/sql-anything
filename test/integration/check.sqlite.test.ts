/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DbTarget } from '../../src/db/conn.js';
import { check } from '../../src/verify/check.js';
import { FIXTURES, REPO, seedSqlite, tmpDir } from '../helpers.js';

let root: string;
let db: DbTarget;

/** A "checkout" of the app: the fixture with its VARIANT set, plus a node_modules link so deps resolve like a real project. */
function checkout(name: string, variant: 'N1' | 'FIXED' | 'BROKEN'): string {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  const src = fs.readFileSync(path.join(FIXTURES, 'sqlite-app.js'), 'utf8').replace("const VARIANT = 'N1';", `const VARIANT = '${variant}';`);
  assert.ok(src.includes(`'${variant}'`));
  fs.writeFileSync(path.join(d, 'server.mjs'), src);
  return d;
}

before(async () => {
  root = tmpDir();
  db = await seedSqlite(path.join(root, 'app.db'));
});
after(() => {
  for (const n of ['base', 'base2', 'fixed', 'broken']) {
    const link = path.join(root, n, 'node_modules');
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* link already gone */ } } // remove the junction itself, never its target
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('N+1 verifier (--check-url / --check-cmd)', () => {
  it('--check-url: a real N+1 fix passes: parity (noisy field masked), query count 51 -> 1, faster', async () => {
    const r = await check({ db, baselineDir: checkout('base', 'N1'), patchedDir: checkout('fixed', 'FIXED'), runCmd: [process.execPath, 'server.mjs'], checkUrl: 'http://127.0.0.1:{port}/', reps: 10, seed: 3 });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.gates) + (r.reason ?? ''));
    assert.deepEqual(r.warnings, [], 'interleaved: no fallback warning');
    assert.deepEqual(r.queriesPerRun, { baseline: 51, patched: 1 });
    assert.ok(r.maskedPaths.includes('$.generatedAt'), `generatedAt differs run to run and must be masked: ${r.maskedPaths}`);
    assert.ok(r.wall.speedup.lo >= 1.5, `speedup CI lo ${r.wall.speedup.lo}`);
    console.log(`    [check-url] 51 -> 1 queries, ${r.wall.baselineP50Ms} -> ${r.wall.patchedP50Ms} ms (${r.wall.speedup.point.toFixed(1)}x, CI lo ${r.wall.speedup.lo.toFixed(1)})`);
  });

  it('--check-url: an "optimized" INNER JOIN that drops customers is rejected on output parity', async () => {
    const r = await check({ db, baselineDir: checkout('base2', 'N1'), patchedDir: checkout('broken', 'BROKEN'), runCmd: [process.execPath, 'server.mjs'], checkUrl: 'http://127.0.0.1:{port}/', reps: 6 });
    assert.equal(r.verdict, 'REJECT');
    assert.equal(r.gates.find((g) => g.name === 'parity')!.status, 'fail');
    assert.match(r.gates[0].measured, /output differs at \$\.customers/);
  });

  it('--check-cmd: compares stdout of a one-shot workload', async () => {
    const r = await check({ db, baselineDir: path.join(root, 'base'), patchedDir: path.join(root, 'fixed'), checkCmd: [process.execPath, 'server.mjs', 'cmd-all'], reps: 6 });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.gates) + (r.reason ?? ''));
    assert.deepEqual(r.queriesPerRun, { baseline: 408, patched: 8 });
    assert.ok(r.wall.baselineP50Ms >= 150, `workload must outweigh node start-up jitter, baseline p50 ${r.wall.baselineP50Ms} ms`);
    console.log(`    [check-cmd] 408 -> 8 queries, ${r.wall.baselineP50Ms} -> ${r.wall.patchedP50Ms} ms (${r.wall.speedup.point.toFixed(1)}x)`);
  });

  it('--check-cmd: a tiny workload is dominated by process start-up, so a 51 -> 1 query win is NOT claimed as a speedup', async () => {
    const r = await check({ db, baselineDir: path.join(root, 'base'), patchedDir: path.join(root, 'fixed'), checkCmd: [process.execPath, 'server.mjs', 'cmd'], reps: 6 });
    assert.equal(r.gates.find((g) => g.name === 'parity')!.status, 'pass');
    assert.deepEqual(r.queriesPerRun, { baseline: 51, patched: 1 });
    assert.equal(r.gates.find((g) => g.name === 'speed')!.status, 'fail');
  });

  it('--check-cmd: a patch that makes no difference is rejected (no speedup)', async () => {
    const r = await check({ db, baselineDir: path.join(root, 'base'), patchedDir: path.join(root, 'base'), checkCmd: [process.execPath, 'server.mjs', 'cmd'], reps: 6 });
    assert.equal(r.gates.find((g) => g.name === 'parity')!.status, 'pass');
    assert.equal(r.gates.find((g) => g.name === 'speed')!.status, 'fail');
    assert.equal(r.verdict, 'REJECT');
  });

  it('non-JSON output that changes between baseline runs is UNVERIFIABLE (exit 4), not guessed', async () => {
    const r = await check({ db, baselineDir: root, patchedDir: root, checkCmd: [process.execPath, '-e', 'console.log(Math.random())'], reps: 4 });
    assert.equal(r.verdict, 'UNVERIFIABLE');
    assert.equal(r.exitCode, 4);
    assert.match(r.reason!, /entirely different|not byte-stable/);
  });

  it('text output that changes between baseline runs is UNVERIFIABLE too', async () => {
    const r = await check({ db, baselineDir: root, patchedDir: root, checkCmd: [process.execPath, '-e', 'console.log("rand " + Math.random())'], reps: 4 });
    assert.equal(r.exitCode, 4);
    assert.match(r.reason!, /not byte-stable/);
  });

  it('refuses ambiguous input', async () => {
    await assert.rejects(check({ db, baselineDir: root, patchedDir: root }), /exactly one of/);
    await assert.rejects(check({ db, baselineDir: root, patchedDir: root, checkUrl: 'http://x' }), /--run/);
  });
});
