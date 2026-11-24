import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAgent, scrubbedEnv } from '../../src/agent.js';
import { shellSplit } from '../../src/api.js';
import { indexCandidates } from '../../src/fix/candidates.js';
import { buildPrompt } from '../../src/fix/fix.js';
import { fmtMs, fmtX, renderCard, type CardData } from '../../src/report/card.js';
import type { Finding } from '../../src/scan/analyze.js';

describe('deterministic index candidates', () => {
  const one = (sql: string, table?: string) => indexCandidates(sql, table).map((c) => `${c.table}(${c.columns.join(',')})`);
  it('equality columns first, then one range column', () => {
    assert.deepEqual(one('select * from orders where status = ? and customer_id = ? and total > ?'), ['orders(status,customer_id,total)']);
    assert.deepEqual(one('select * from orders where created_at >= ? and customer_id = $1'), ['orders(customer_id,created_at)']);
  });
  it('handles aliases and joins, one candidate per table, restricted to the scanned table when known', () => {
    const sql = 'select c.id, o.id from customers c join orders o on o.customer_id = c.id where c.region = ? and o.status = ?';
    assert.deepEqual(one(sql).sort(), ['customers(region)', 'orders(customer_id,status)']);
    assert.deepEqual(one(sql, 'orders'), ['orders(customer_id,status)']);
  });
  it('skips a lone id (primary key), expressions, functions and non-selects', () => {
    assert.deepEqual(one('select * from t where id = ?'), []);
    assert.deepEqual(one('select * from t where customer_id + 0 = ?'), []);
    assert.deepEqual(one('select * from t where lower(email) = ?'), []);
    assert.deepEqual(one('update t set a = 1 where b = ?'), []);
  });
  it('IN lists and quoted identifiers', () => {
    assert.deepEqual(one('select * from "Order Items" where "sku" in (1,2,3)'), ['Order Items(sku)']);
  });
  it('names are short, safe, and the Postgres migration is online-safe', () => {
    const [c] = indexCandidates('select * from orders where customer_id = ?');
    assert.equal(c.name, 'idx_orders_customer_id');
    assert.match(c.migrationSql('pg'), /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_customer_id" ON "orders" \("customer_id"\);$/);
    assert.match(c.migrationSql('sqlite'), /^CREATE INDEX IF NOT EXISTS/);
    assert.equal(c.downSql, 'DROP INDEX IF EXISTS "idx_orders_customer_id";');
    const long = indexCandidates(`select * from t where ${'a'.repeat(70)} = ?`)[0];
    assert.ok(long.name.length <= 63);
  });
});

const card = (over: Partial<CardData> = {}): CardData => ({
  findingId: 'F1',
  kind: 'seq-scan',
  callsite: 'src/server.js:42',
  sql: 'select count(*) as c from orders where customer_id = ?',
  speedup: 214.4,
  speedupLo: 190.2,
  samples: 150,
  before: { p50: 6.8, p95: 8.7 },
  after: { p50: 0.03, p95: 0.05 },
  planBefore: 'SCAN orders',
  planAfter: 'SEARCH orders USING INDEX idx_orders_customer_id (customer_id=?)',
  queries: { before: 51, after: 1 },
  parity: { ok: 500, total: 500, what: 'replayed' },
  level: 'query',
  ...over,
});

describe('SVG benchmark card', () => {
  it('shows speedup, p50/p95 before and after, plan shift, query drop and the parity badge', () => {
    const svg = renderCard(card());
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
    assert.ok(svg.trimEnd().endsWith('</svg>'));
    for (const needle of ['214×', 'p50 latency', 'p95 latency', '6.8 ms before', '0.03 ms after', 'SCAN orders', 'SEARCH orders USING INDEX', '51 → 1 per run', '500/500 replayed · row parity', 'src/server.js:42', 'Evidence, not proof']) {
      assert.ok(svg.includes(needle), `missing: ${needle}`);
    }
    assert.ok(svg.includes('fill="#0d1117"'), 'dark mode background');
  });
  it('endpoint-level cards say output parity and wall time; labels render', () => {
    const svg = renderCard(card({ level: 'endpoint', parity: { ok: 6, total: 6, what: 'runs' }, label: 'synthetic demo' }));
    assert.ok(svg.includes('6/6 runs · output parity') && svg.includes('endpoint wall time') && svg.includes('synthetic demo'));
  });
  it('escapes everything it prints: hostile SQL cannot inject markup', () => {
    const svg = renderCard(card({ sql: `select '</text><script>alert(1)</script>' & "x"`, callsite: '<img src=x onerror=1>:1', label: '<b>' }));
    assert.ok(!svg.includes('<script') && !svg.includes('<img') && !svg.includes('<b>'));
    assert.ok(svg.includes('&lt;script&gt;'));
    const open = (svg.match(/<(?!\/|\?|!)[a-zA-Z]/g) ?? []).length;
    const closed = (svg.match(/<\/[a-zA-Z]+>/g) ?? []).length + (svg.match(/\/>/g) ?? []).length;
    assert.equal(open, closed, 'every element is closed');
  });
  it('number formatting', () => {
    assert.equal(fmtX(214.4), '214×');
    assert.equal(fmtX(21.44), '21.4×');
    assert.equal(fmtX(2.144), '2.14×');
    assert.equal(fmtMs(0.0004), '0 µs');
    assert.equal(fmtMs(0.4321), '0.43 ms');
    assert.equal(fmtMs(12.34), '12.3 ms');
    assert.equal(fmtMs(1234), '1234 ms');
  });
});

describe('agent plumbing', () => {
  it('the agent never sees database connection strings or the hook', () => {
    const env = scrubbedEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', DATABASE_URL: 'postgres://localhost/db', SQL_ANYTHING_DB_URL: 'x', PGPASSWORD: 'p', PGHOST: 'h', POSTGRES_URL: 'p', DB_HOST: 'h', NODE_OPTIONS: '--import hook', SQL_ANYTHING_TRACE_DIR: 't' }, { SQL_ANYTHING_FINDING: 'F1' });
    assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'PATH', 'SQL_ANYTHING_FINDING']);
  });
  it('resolveAgent: none, custom, unknown, and a missing claude CLI is a clear error', () => {
    assert.equal(resolveAgent(undefined, undefined, shellSplit), null);
    assert.equal(resolveAgent('none', undefined, shellSplit), null);
    assert.deepEqual(resolveAgent(undefined, 'node "my agent.js" --x', shellSplit)!.cmd, ['node', 'my agent.js', '--x']);
    assert.throws(() => resolveAgent('gpt', undefined, shellSplit), /unknown agent/);
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.throws(() => resolveAgent('claude', undefined, shellSplit), /not on PATH/);
    } finally {
      process.env.PATH = path;
    }
  });
  it('shellSplit keeps quoted arguments together', () => {
    assert.deepEqual(shellSplit(`node "a b.js" --port 3000 'x y'`), ['node', 'a b.js', '--port', '3000', 'x y']);
    assert.deepEqual(shellSplit('a "" b'), ['a', '', 'b']);
  });
  it('the prompt carries the finding but no parameter values, and repeats the rejection reason', () => {
    const f = { id: 'F1', kind: 'n+1', fingerprint: 'abc123', sql: 'select count(*) from orders where customer_id = ?', callsite: '/proj/src/server.js:17:9', detail: '50 identical lookups per request', plan: undefined } as unknown as Finding;
    const p = buildPrompt(f, '/proj', ['parity gate failed: output differs at $.customers[0]']);
    assert.match(p, /Issued from: src\/server\.js \(line 17\)/);
    assert.match(p, /REJECTED/);
    assert.match(p, /output differs at \$\.customers\[0\]/);
    assert.match(p, /You have no database access/);
    assert.ok(!/postgres:\/\//.test(p));
  });
});
