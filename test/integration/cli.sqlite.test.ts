/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FIXTURES, REPO, freePort, seedSqlite, tmpDir } from '../helpers.js';

const CLI = path.join(REPO, 'dist', 'src', 'cli.js');
let dir: string;
let dbFile: string;
let port: number;

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, SQL_ANYTHING_DB_URL: dbFile, PORT: String(port), ...env } });

before(async () => {
  dir = tmpDir();
  dbFile = path.join(dir, 'app.db');
  await seedSqlite(dbFile);
  port = await freePort();
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('CLI: scan then verify, exit codes', () => {
  it('scan -- <app> finds the N+1 and writes findings.json', () => {
    const r = cli(['scan', '--db', dbFile, '--hit', `http://127.0.0.1:${port}/`, '--hit-repeat', '2', '--', process.execPath, path.join(FIXTURES, 'sqlite-app.js')]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /F1 /);
    assert.match(r.stdout, /n\+1/);
    assert.match(r.stdout, /sqlite-app\.js:\d+:\d+/);
    const runs = fs.readdirSync(path.join(dir, '.sql-anything', 'runs'));
    assert.equal(runs.length, 1);
    assert.ok(fs.existsSync(path.join(dir, '.sql-anything', 'runs', runs[0], 'findings.json')));
    assert.equal(fs.readFileSync(path.join(dir, '.sql-anything', '.gitignore'), 'utf8').trim(), '*', 'traces (real params) are git-ignored automatically');
  });

  it('verify --target F1 --migration: a real index passes, exit 0, verify.json written', () => {
    fs.writeFileSync(path.join(dir, 'idx.sql'), 'create index idx_orders_customer on orders(customer_id);');
    const r = cli(['verify', '--db', dbFile, '--migration', path.join(dir, 'idx.sql'), '--target', 'F1', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, 'PASS');
    assert.ok(out.gates.every((g: any) => g.status !== 'fail'));
  });

  it('verify with a wrong rewrite: exit 2 and a readable failed gate', () => {
    const f = JSON.parse(fs.readFileSync(path.join(dir, '.sql-anything', 'runs', fs.readdirSync(path.join(dir, '.sql-anything', 'runs'))[0], 'findings.json'), 'utf8'));
    const fp = f.findings[0].fingerprint;
    fs.writeFileSync(path.join(dir, 'rw.json'), JSON.stringify({ [fp]: 'select count(*) as c from orders where customer_id = ? and status = \'new\'' }));
    const r = cli(['verify', '--db', dbFile, '--rewrite', path.join(dir, 'rw.json')]);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.match(r.stdout, /\[FAIL\] parity/);
    assert.match(r.stdout, /row contents differ/);
  });

  it('bench reports timing and never gates', () => {
    const r = cli(['bench', '--db', dbFile, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).perFingerprint.length > 0);
  });

  it('exit 4 with a clear reason when the hook never loaded (kill switch) and when no SQL ran', () => {
    const killed = cli(['scan', '--', process.execPath, '-e', '1'], { SQL_ANYTHING_DISABLE: '1' });
    assert.equal(killed.status, 4);
    assert.match(killed.stderr, /hook never loaded/);
    const quiet = cli(['scan', '--', process.execPath, '-e', '1']);
    assert.equal(quiet.status, 4);
    assert.match(quiet.stderr, /0 queries were captured/);
  });

  it('exit 3 on usage errors and on milestone-2 commands', () => {
    assert.equal(cli(['nope']).status, 3);
    assert.equal(cli(['go']).status, 3);
    assert.equal(cli(['verify']).status, 3);
    assert.equal(cli(['scan']).status, 3);
    assert.equal(cli(['verify', '--db', dbFile, '--trace', path.join(dir, 'does-not-exist')]).status, 4, 'an empty trace is unverifiable, not a crash');
  });
});
