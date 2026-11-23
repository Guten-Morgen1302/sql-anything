/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { capture } from '../../src/capture.js';
import { decodeParams } from '../../src/trace/params.js';
import { readTrace } from '../../src/trace/read.js';
import { FIXTURES, tmpDir } from '../helpers.js';

const probe = path.join(FIXTURES, 'hook-probe.js');

describe('capture hook', () => {
  it('captures node:sqlite and better-sqlite3 (and the worker thread), with exact param types and call sites', async () => {
    const dir = tmpDir();
    const r = await capture({ cmd: [process.execPath, probe], traceDir: dir, quiet: true });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    assert.equal(out.nodeSqlitePatched, true);
    assert.equal(out.stackTraceLimit, 10, 'the hook must not change the host Error.stackTraceLimit');
    assert.deepEqual(out.got, { id: 1, name: 'ann' });
    assert.match(out.threw, /UNIQUE constraint/, 'driver errors reach the app unchanged');
    assert.ok(!r.stdout.includes('ExperimentalWarning'));

    const t = readTrace(dir);
    assert.ok(t.hooks.length >= 2, `hook loaded in main and worker thread, got ${t.hooks.length}`);
    assert.ok(t.hooks.some((h) => h.thread !== 0), 'worker thread loaded the hook');
    const dbs = new Set(t.records.map((x) => x.db));
    assert.ok(dbs.has('node:sqlite') && dbs.has('better-sqlite3'));
    assert.ok(t.records.some((x) => x.sql.includes('from_worker') && x.thread !== 0), 'worker query captured');

    const ins = t.records.find((x) => x.db === 'node:sqlite' && x.sql.startsWith('insert into t'))!;
    const [id, blob, big] = decodeParams(ins.params);
    assert.equal(id, 1);
    assert.ok(Buffer.isBuffer(blob));
    assert.deepEqual([...(blob as Buffer)], [1, 2, 3]);
    assert.equal(big, 9007199254740993n, 'BigInt survives the JSONL trace exactly');

    const failed = t.records.find((x) => x.sql.startsWith('insert into u') && x.err)!;
    assert.match(failed.err ?? '', /UNIQUE constraint/);
    for (const rec of t.records.filter((x) => x.sql.includes('where id = ?'))) {
      assert.match(rec.frame ?? '', /hook-probe\.js:\d+:\d+$/, 'call site is the app line, not the hook');
      assert.equal(rec.frame_exact, true);
    }
  });

  it('SQL_ANYTHING_DISABLE=1: zero patching, zero files', async () => {
    const dir = tmpDir();
    const r = await capture({ cmd: [process.execPath, probe], traceDir: dir, env: { SQL_ANYTHING_DISABLE: '1' }, quiet: true });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    assert.equal(out.nodeSqlitePatched, false);
    assert.equal(out.pgPatched, false);
    assert.deepEqual(fs.readdirSync(dir), [], 'no trace file is even opened');
  });

  it('a hook that cannot write its trace must not break the app', async () => {
    const dir = tmpDir();
    const blocker = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    const r = await capture({ cmd: [process.execPath, probe], traceDir: path.join(blocker, 'sub'), quiet: true });
    assert.equal(r.exitCode, 0, 'app still runs and exits 0');
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()!).got, { id: 1, name: 'ann' });
  });

  it('works when the hook path and the app path contain spaces', async () => {
    const dir = tmpDir('sa spaced ');
    const app = path.join(dir, 'my app.mjs');
    fs.writeFileSync(app, "const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(':memory:').prepare('select 1 as spaced, 2 as x').get();");
    const traceDir = path.join(dir, 'trace dir');
    const r = await capture({ cmd: [process.execPath, app], traceDir, quiet: true });
    assert.equal(r.exitCode, 0);
    assert.ok(readTrace(traceDir).records.some((x) => x.sql.includes('spaced')));
  });
});
