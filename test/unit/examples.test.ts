import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPO } from '../helpers.js';

const EX = path.join(REPO, 'examples');
const scripts = (dir: string) => fs.readdirSync(path.join(EX, dir)).filter((f) => f.endsWith('.mjs')).map((f) => path.join(EX, dir, f));

describe('examples ship without syntax errors', () => {
  it('every example script parses (node --check)', () => {
    const bad: string[] = [];
    for (const f of [...scripts('sqlite-shop'), ...scripts('postgres-saas')]) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${path.relative(REPO, f)}: ${r.stderr.split('\n')[0]}`);
    }
    assert.deepEqual(bad, []);
    assert.ok(scripts('postgres-saas').length >= 4, 'setup, db, seed and server are all there');
  });
});

describe('examples/postgres-saas: no stored password', () => {
  const compose = fs.readFileSync(path.join(EX, 'postgres-saas', 'docker-compose.yml'), 'utf8');

  it('docker-compose.yml reads the password from the environment, requires it, and publishes the port on localhost only', () => {
    assert.match(compose, /POSTGRES_PASSWORD: \$\{SAAS_DB_PASSWORD:\?/, 'the password must be required from the environment, with no default');
    assert.match(compose, /"127\.0\.0\.1:54330:5432"/, 'the database must not be published on all interfaces');
    assert.ok(!/POSTGRES_PASSWORD: [A-Za-z0-9]/.test(compose), 'a literal password is back in docker-compose.yml');
    assert.match(compose, /image: postgres:\d+/);
    assert.match(compose, /healthcheck:/);
  });

  it('package.json "setup" runs setup.mjs, and every script it references exists', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(EX, 'postgres-saas', 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.setup, 'node setup.mjs');
    for (const s of Object.values<string>(pkg.scripts)) {
      const m = /^node (\S+\.mjs)/.exec(s);
      if (m) assert.ok(fs.existsSync(path.join(EX, 'postgres-saas', m[1])), `${s} points at a missing file`);
    }
  });

  it('db.mjs: DATABASE_URL wins; with .env it builds the URL; with neither it fails with an instruction', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pgsaas-'));
    try {
      fs.copyFileSync(path.join(EX, 'postgres-saas', 'db.mjs'), path.join(tmp, 'db.mjs'));
      const run = (env: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(tmp, 'db.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

      const none = run();
      assert.notEqual(none.status, 0);
      assert.match(none.stderr, /no database configured: set DATABASE_URL, or run `npm run setup`/);

      const own = run({ DATABASE_URL: 'postgres://u@h:5432/d' });
      assert.equal(own.status, 0);
      assert.equal(own.stdout.trim(), 'postgres://u@h:5432/d');

      fs.writeFileSync(path.join(tmp, '.env'), 'SAAS_DB_PASSWORD=ab/c d\n');
      const fromEnv = run();
      assert.equal(fromEnv.status, 0, fromEnv.stderr);
      assert.equal(fromEnv.stdout.trim(), 'postgres://saas:ab%2Fc%20d@127.0.0.1:54330/saas', 'special characters are URL-encoded');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('setup.mjs generates a random password only when none exists, and never prints it', () => {
    const src = fs.readFileSync(path.join(EX, 'postgres-saas', 'setup.mjs'), 'utf8');
    assert.match(src, /randomBytes\(16\)/);
    assert.match(src, /if \(!readPassword\(\)\)/, 'an existing password must not be overwritten');
    assert.ok(!/console\.log\([^)]*(password|PASSWORD)[^)]*\$\{/.test(src), 'setup must not print the password');
  });
});
