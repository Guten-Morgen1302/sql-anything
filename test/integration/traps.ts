/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DbTarget } from '../../src/db/conn.js';
import { fingerprint } from '../../src/sql/normalize.js';
import { verify, type VerifyResult } from '../../src/verify/verify.js';
import { rec } from '../helpers.js';

export interface TrapEnv {
  kind: 'sqlite' | 'pg';
  /** orders(customer_id) NOT indexed */
  plain: () => DbTarget;
  /** orders(customer_id) indexed */
  indexed: () => DbTarget;
}

const gate = (r: VerifyResult, name: string) => r.gates.find((g) => g.name === name)!;
const show = (r: VerifyResult) => JSON.stringify({ v: r.verdict, g: r.gates.map((g) => `${g.name}:${g.status} ${g.measured}`), m: r.mismatches.slice(0, 2), u: r.unverifiable, reason: r.reason });

/**
 * The trap suite: patches that LOOK like optimizations and are wrong, plus positive controls proving the gate is not a
 * rubber stamp that rejects everything. Same cases run against SQLite and real Postgres.
 */
export function defineTraps(label: string, env: TrapEnv): void {
  const pg = env.kind === 'pg';
  const ph = (n: number) => (pg ? `$${n}` : '?');
  const run = (o: Partial<Parameters<typeof verify>[0]> & { db: DbTarget; records: ReturnType<typeof rec>[] }) =>
    verify({ seed: 42, maxSeconds: 60, ...o });

  const custOrders = `select id, total from orders where customer_id = ${ph(1)}`;
  const custRecords = () => Array.from({ length: 60 }, (_, i) => rec(custOrders, [i + 1], { db: pg ? 'pg' : 'node:sqlite' }));
  const insertSql = `insert into orders (id, customer_id, status, total, created_at) values (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)})`;

  describe(`${label}: trap suite (verify must reject wrong patches)`, () => {
    it('POSITIVE CONTROL: a correct CREATE INDEX passes every gate', async () => {
      const r = await run({ db: env.plain(), records: custRecords(), migrationSql: 'create index idx_orders_customer on orders(customer_id)' });
      assert.equal(r.verdict, 'PASS', show(r));
      assert.equal(r.exitCode, 0);
      assert.equal(gate(r, 'parity').status, 'pass');
      assert.equal(gate(r, 'speed').status, 'pass');
      assert.ok(r.speed!.speedup.lo >= 1.5, `speedup CI lower bound ${r.speed!.speedup.lo}`);
      assert.equal(r.verified, 60);
      console.log(`    [${label}] index speedup ${r.speed!.speedup.point.toFixed(1)}x (CI lo ${r.speed!.speedup.lo.toFixed(1)}), p50 ${r.speed!.baseP50Ms} -> ${r.speed!.patchedP50Ms} ms`);
    });

    it('NULL trap: NOT IN -> NOT EXISTS changes the answer when the subquery has a NULL', async () => {
      const sql = `select id from members where id > ${ph(1)} and email not in (select email from blocked)`;
      const patched = `select id from members m where m.id > ${ph(1)} and not exists (select 1 from blocked b where b.email = m.email)`;
      const records = [0, 10, 20, 30, 40].map((n) => rec(sql, [n]));
      const r = await run({ db: env.plain(), records, rewrites: { [fingerprint(sql)]: patched } });
      assert.equal(r.verdict, 'REJECT', show(r));
      assert.equal(r.exitCode, 2);
      assert.equal(gate(r, 'parity').status, 'fail');
      assert.match(r.mismatches[0].reason, /row count/);
    });

    it('LEFT JOIN -> INNER JOIN drift drops the customers without orders', async () => {
      const sql = `select c.id, o.id as oid from customers c left join orders o on o.customer_id = c.id and o.status = ${ph(1)} where c.region = ${ph(2)}`;
      const patched = `select c.id, o.id as oid from customers c join orders o on o.customer_id = c.id and o.status = ${ph(1)} where c.region = ${ph(2)}`;
      const records = [['new', 'r7'], ['paid', 'r7'], ['shipped', 'r7'], ['new', 'r4']].map((p) => rec(sql, p));
      const r = await run({ db: env.plain(), records, rewrites: { [fingerprint(sql)]: patched } });
      assert.equal(r.verdict, 'REJECT', show(r));
      assert.equal(gate(r, 'parity').status, 'fail');
    });

    it('duplicate-row bug: IN (subquery) rewritten as a JOIN multiplies rows', async () => {
      const sql = `select c.id from customers c where c.id in (select customer_id from orders where status = ${ph(1)})`;
      const patched = `select c.id from customers c join orders o on o.customer_id = c.id where o.status = ${ph(1)}`;
      const records = ['new', 'paid', 'shipped'].map((s) => rec(sql, [s]));
      const r = await run({ db: env.plain(), records, rewrites: { [fingerprint(sql)]: patched } });
      assert.equal(r.verdict, 'REJECT', show(r));
      assert.match(r.mismatches[0].reason, /row count/);
    });

    it('missing tie-breaker: ORDER BY score LIMIT picks different rows among ties', async () => {
      const sql = `select id, score from scores order by score desc limit ${ph(1)}`;
      const patched = `select id, score from scores order by score desc, id desc limit ${ph(1)}`;
      const records = [5, 10, 20].map((n) => rec(sql, [n]));
      const r = await run({ db: env.plain(), records, rewrites: { [fingerprint(sql)]: patched } });
      assert.equal(r.verdict, 'REJECT', show(r));
      assert.equal(gate(r, 'parity').status, 'fail');
    });

    it('tie-order drift: same rows, different order under ORDER BY is rejected, not waved through', async () => {
      const sql = `select id, score from scores where score >= ${ph(1)} order by score`;
      const patched = `select id, score from scores where score >= ${ph(1)} order by score, id desc`;
      const r = await run({ db: env.plain(), records: [rec(sql, [99])], rewrites: { [fingerprint(sql)]: patched } });
      assert.equal(r.verdict, 'REJECT', show(r));
      assert.match(r.mismatches[0].reason, /different order/);
    });

    it('volatile queries (random()/now()) are UNVERIFIABLE, exit 4, never a pass', async () => {
      const rnd = `select id, random() as r from scores where id = ${ph(1)}`;
      const now = pg ? 'select now() as n' : "select datetime('now') as n";
      const records = [...[1, 2, 3].map((i) => rec(rnd, [i])), rec(now, [])];
      const r = await run({ db: env.plain(), records, migrationSql: 'create index idx_scores_player on scores(player)' });
      assert.equal(r.verdict, 'UNVERIFIABLE', show(r));
      assert.equal(r.exitCode, 4);
      assert.equal(r.verified, 0);
      assert.ok(r.unverifiable.reasons['volatile-function'] >= 4);
    });

    it('LIMIT without ORDER BY is UNVERIFIABLE (different plans may legitimately return different rows)', async () => {
      const r = await run({ db: env.plain(), records: [rec(`select id from scores limit ${ph(1)}`, [5])], migrationSql: 'create index idx_scores_player on scores(player)' });
      assert.equal(r.exitCode, 4, show(r));
      assert.equal(r.unverifiable.reasons['limit-without-order-by'], 1);
    });

    it('an unserializable param marks the statement unverifiable instead of crashing', async () => {
      const r = await run({ db: env.plain(), records: [rec(custOrders, [() => 1])], migrationSql: 'create index idx_orders_customer on orders(customer_id)' });
      assert.equal(r.exitCode, 4, show(r));
      assert.equal(r.unverifiable.reasons['unserializable-param'], 1);
    });

    it('a mix keeps the verifiable inputs and counts the volatile ones', async () => {
      const rnd = `select id, random() as r from scores where id = ${ph(1)}`;
      const records = [...custRecords(), rec(rnd, [1])];
      const r = await run({ db: env.plain(), records, migrationSql: 'create index idx_orders_customer on orders(customer_id)' });
      assert.equal(r.verdict, 'PASS', show(r));
      assert.equal(r.verified, 60);
      assert.equal(r.unverifiable.reasons['volatile-function'], 1);
    });

    it('a rewrite that gets SLOWER is rejected (defeating an existing index with customer_id + 0)', async () => {
      const slow = `select id, total from orders where customer_id + 0 = ${ph(1)}`;
      const r = await run({ db: env.indexed(), records: custRecords(), rewrites: { [fingerprint(custOrders)]: slow } });
      assert.equal(r.verdict, 'REJECT', show(r));
      assert.equal(gate(r, 'parity').status, 'pass', 'results are identical, only speed is wrong');
      assert.equal(gate(r, 'speed').status, 'fail');
      assert.ok(r.speed!.speedup.point < 1, `speedup ${r.speed!.speedup.point}`);
    });

    it('a no-op patch is rejected: identical timing is not a 1.5x win', async () => {
      const r = await run({ db: env.indexed(), records: custRecords(), migrationSql: 'analyze' });
      assert.equal(r.verdict, 'REJECT', show(r));
      assert.equal(gate(r, 'speed').status, 'fail');
    });

    it('regression guard: speeding up one query while slowing another is rejected', async () => {
      const a = `select id, total from orders where customer_id + 0 = ${ph(1)}`;
      const aFast = `select id, total from orders where customer_id = ${ph(1)}`;
      const b = `select count(*) as n from orders where customer_id = ${ph(1)}`;
      const bSlow = `select count(*) as n from orders where customer_id + 0 = ${ph(1)}`;
      const records = [...Array.from({ length: 40 }, (_, i) => rec(a, [i + 1])), ...Array.from({ length: 40 }, (_, i) => rec(b, [i + 1]))];
      const r = await run({ db: env.indexed(), records, rewrites: { [fingerprint(a)]: aFast, [fingerprint(b)]: bSlow }, target: [fingerprint(a)] });
      assert.equal(gate(r, 'parity').status, 'pass', show(r));
      assert.equal(gate(r, 'speed').status, 'pass', show(r));
      assert.equal(gate(r, 'regression').status, 'fail', show(r));
      assert.equal(r.verdict, 'REJECT');
    });

    it('write regression: indexes that speed reads but make captured INSERTs slower are rejected', async () => {
      // Postgres: 3,000-row batch inserts into a table that carries composite and expression indexes, so index maintenance
      // dominates and the 15% gate is crossed by a wide margin, not by noise. SQLite keeps single-row inserts.
      const batch = `insert into orders (id, customer_id, status, total, created_at) select g, (g % 400) + 1, 'new', g % 997, 'w' || g from generate_series($1::int, $2::int) g`;
      const writes = pg
        ? Array.from({ length: 12 }, (_, i) => rec(batch, [500000 + i * 3000, 500000 + i * 3000 + 2999], { db: 'pg' }))
        : Array.from({ length: 200 }, (_, i) => rec(insertSql, [200000 + i, (i % 400) + 1, 'new', i, 'w' + i]));
      const migration = [
        'create index w1 on orders(customer_id)',
        'create index w2 on orders(status)',
        'create index w3 on orders(total)',
        'create index w4 on orders(created_at)',
        'create index w5 on orders(status, total)',
        'create index w6 on orders(customer_id, created_at)',
        'create index w7 on orders(total, status)',
        'create index w8 on orders(created_at, customer_id)',
        'create index w9 on orders(status, created_at)',
        'create index w10 on orders(total, created_at)',
        ...(pg ? ['create index w11 on orders(lower(status), (total % 100))', 'create index w12 on orders((total * 2), lower(created_at), customer_id)'] : []),
      ].join(';\n');
      const r = await run({ db: env.plain(), records: [...custRecords(), ...writes], migrationSql: migration });
      assert.equal(gate(r, 'parity').status, 'pass', show(r));
      assert.equal(gate(r, 'speed').status, 'pass', show(r));
      assert.equal(gate(r, 'writes').status, 'fail', show(r));
      assert.equal(r.verdict, 'REJECT');
      console.log(`    [${label}] ${pg ? 'twelve' : 'ten'} indexes: ${gate(r, 'writes').measured}`);
    });

    it('behaviour change on writes: a UNIQUE index makes a captured INSERT fail only on the patched side', async () => {
      const writes = [0, 1, 2].map((i) => rec(insertSql, [300000 + i, 1, 'new', 1, 'same-created-at']));
      const migration = 'create index idx_orders_customer on orders(customer_id);\ncreate unique index u_created on orders(created_at)';
      const r = await run({ db: env.plain(), records: [...custRecords(), ...writes], migrationSql: migration });
      assert.equal(gate(r, 'writes').status, 'fail', show(r));
      assert.match(gate(r, 'writes').detail ?? '', /behaves differently/);
      assert.equal(r.verdict, 'REJECT');
    });

    it('write overhead of ONE useful index, measured and reported', async () => {
      const writes = Array.from({ length: 200 }, (_, i) => rec(insertSql, [400000 + i, (i % 400) + 1, 'new', i, 'x' + i]));
      const r = await run({ db: env.plain(), records: [...custRecords(), ...writes], migrationSql: 'create index idx_orders_customer on orders(customer_id)' });
      const w = gate(r, 'writes');
      console.log(`    [${label}] single index: ${r.verdict}; ${w.status}: ${w.measured}`);
      assert.ok(['pass', 'fail'].includes(w.status), 'the write guard ran');
      assert.equal(gate(r, 'speed').status, 'pass');
    });

    it('bench mode reports timing without enforcing gates', async () => {
      const r = await run({ db: env.indexed(), records: custRecords(), rewrites: { [fingerprint(custOrders)]: `select id, total from orders where customer_id + 0 = ${ph(1)}` }, gate: false });
      assert.equal(r.verdict, 'PASS');
      assert.ok(r.speed!.speedup.point < 1);
    });

    it('the source database is never modified', async () => {
      const before = await run({ db: env.plain(), records: custRecords(), migrationSql: 'create index idx_orders_customer on orders(customer_id)' });
      assert.equal(before.verdict, 'PASS');
      const again = await run({ db: env.plain(), records: custRecords(), migrationSql: 'create index idx_orders_customer on orders(customer_id)' });
      assert.equal(again.verdict, 'PASS', 'the second run still finds no index in the source: it was never touched');
    });
  });
}
