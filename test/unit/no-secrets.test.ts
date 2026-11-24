import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPO } from '../helpers.js';

/**
 * Secret-scanner guard (GitGuardian flagged literal example passwords once). This is a deliberately small, local check for the
 * patterns that actually appeared. It does not replace a real scanner.
 */
function trackedFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' });
  if (r.status === 0 && r.stdout) return r.stdout.split('\0').filter(Boolean);
  // not a git checkout (an extracted tarball): walk the tree
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', '.sql-anything'].includes(e.name)) continue;
      const rel = path.join(d, e.name);
      e.isDirectory() ? walk(rel) : out.push(rel);
    }
  };
  walk('');
  return out;
}

const SKIP = new Set(['package-lock.json', path.join('test', 'unit', 'no-secrets.test.ts').replace(/\\/g, '/')]);
const TEXT = /\.(ts|mjs|cjs|js|json|md|yml|yaml|sql|svg|txt)$|^\.gitignore$/;

/** A URL with a literal user AND password. Placeholders (USER:PASSWORD), `${...}`, and `:@` forms are fine. */
const URL_WITH_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@'"`${}<>]+):([^\s:/@'"`${}<>]+)@/gi;
const BCRYPT_HASH = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/;
const PLACEHOLDER = /^(USER|PASSWORD|HOST|PASS|user|password|host|pass|xxx+|\*+|<[^>]+>|\.\.\.)$/;

describe('no literal credentials in the repository', () => {
  const files = trackedFiles().filter((f) => TEXT.test(f) && !SKIP.has(f.replace(/\\/g, '/')));

  it('scans a meaningful number of files', () => {
    assert.ok(files.length > 50, `only ${files.length} files scanned`);
  });

  it('no URL carries a literal user:password (use USER:PASSWORD placeholders or build the URL at run time)', () => {
    const found: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(REPO, f), 'utf8');
      for (const m of text.matchAll(URL_WITH_PASSWORD)) {
        if (PLACEHOLDER.test(m[1]) && PLACEHOLDER.test(m[2])) continue;
        found.push(`${f}: ${m[0].replace(/:[^:@]+@$/, ':***@')}`);
      }
    }
    assert.deepEqual(found, []);
  });

  it('no bcrypt-style hashes, private keys or well-known token shapes', () => {
    const found: string[] = [];
    const patterns: [string, RegExp][] = [
      ['bcrypt hash', BCRYPT_HASH],
      ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
      ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
      ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
      ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
      ['Anthropic/OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ];
    for (const f of files) {
      const text = fs.readFileSync(path.join(REPO, f), 'utf8');
      for (const [name, re] of patterns) if (re.test(text)) found.push(`${f}: ${name}`);
    }
    assert.deepEqual(found, []);
  });

  it('no password assigned a literal: neither `password: "text"` in code nor a whole-line `SOME_PASSWORD: text` / `SOME_PASSWORD=text`', () => {
    const found: string[] = [];
    const quoted = /\b(?:[A-Za-z_]*[Pp]assword|[A-Z_]*PASSWORD)\b\s*[:=]\s*(['"`])([^'"`\n$]{3,})\1/g; // password: 'literal' (a `${...}` is a run-time value)
    const wholeLine = /^\s*(?:export\s+)?[A-Z_]*PASSWORD\s*[:=]\s*([A-Za-z0-9._-]{3,})\s*$/gm; // POSTGRES_PASSWORD: literal  (YAML, .env)
    for (const f of files) {
      const text = fs.readFileSync(path.join(REPO, f), 'utf8');
      for (const [re, idx] of [[quoted, 2], [wholeLine, 1]] as const) {
        for (const m of text.matchAll(re)) {
          if (PLACEHOLDER.test(m[idx])) continue;
          found.push(`${f}: ${m[0].trim().slice(0, 60)}`);
        }
      }
    }
    assert.deepEqual(found, [], 'a literal password is back in the repository');
  });

  it('the assignment check catches literals and ignores run-time values', () => {
    const quoted = /\b(?:[A-Za-z_]*[Pp]assword|[A-Z_]*PASSWORD)\b\s*[:=]\s*(['"`])([^'"`\n$]{3,})\1/;
    const wholeLine = /^\s*(?:export\s+)?[A-Z_]*PASSWORD\s*[:=]\s*([A-Za-z0-9._-]{3,})\s*$/m;
    assert.ok(quoted.test("const pg = { password: 'hunter2' }"));
    assert.ok(wholeLine.test('      POSTGRES_PASSWORD: saas'));
    assert.ok(wholeLine.test('export DB_PASSWORD=swordfish'));
    assert.ok(!wholeLine.test('      POSTGRES_PASSWORD: ci-${{ github.run_id }}-${{ github.run_attempt }}'));
    assert.ok(!wholeLine.test('      POSTGRES_PASSWORD: ${SAAS_DB_PASSWORD:?run "npm run setup" first}'));
    assert.ok(!quoted.test('password: u.password'));
    assert.ok(!quoted.test('cp.password = this.password = decodeURIComponent(u.password)'));
  });

  it('the guard itself catches the old mistakes', () => {
    assert.ok(new RegExp(URL_WITH_PASSWORD.source, 'i').test('postgres://saas:saas@localhost:54330/saas'));
    assert.ok(!new RegExp(URL_WITH_PASSWORD.source, 'i').test('postgres://localhost:54330/saas'));
    assert.ok(BCRYPT_HASH.test('$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  });
});
