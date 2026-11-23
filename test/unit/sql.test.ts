import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNoise, isVolatile, kindOf, topLevel } from '../../src/sql/classify.js';
import { fingerprint, normalize } from '../../src/sql/normalize.js';

describe('fingerprint / normalize', () => {
  it('gives pg, sqlite and literal forms of the same statement one fingerprint', () => {
    const fps = new Set([
      fingerprint('SELECT * FROM orders WHERE customer_id = $1 AND status = $2'),
      fingerprint('select * from orders where customer_id = ? and status = ?'),
      fingerprint("select *   from ORDERS where customer_id = 42 and status = 'paid' -- trailing"),
      fingerprint('select * from orders where customer_id = :cid and status = @st'),
    ]);
    assert.equal(fps.size, 1);
  });

  it('collapses IN lists and multi-row VALUES', () => {
    assert.equal(normalize('select 1 from t where id in (1,2,3,4)'), normalize('select 1 from t where id in (9)'));
    assert.equal(normalize('insert into t values (1,2),(3,4),(5,6)'), normalize('insert into t values (7,8)'));
  });

  it('handles dollar quotes, E strings, comments and escaped quotes without leaking literals', () => {
    assert.equal(normalize("select $$it's$$ as a"), 'select ? as a');
    assert.equal(normalize("select E'a\\'b' as a"), 'select ? as a');
    assert.equal(normalize("select 'it''s' /* c */ as a"), 'select ? as a');
    assert.equal(normalize('select 1.5e3, 0xFF, .5 from t'), 'select ?, ?, ? from t');
  });

  it('keeps casts and quoted identifiers intact and distinguishes different statements', () => {
    assert.equal(normalize('select x::int from "My Table"'), 'select x::int from "My Table"');
    assert.notEqual(fingerprint('select a from t'), fingerprint('select b from t'));
  });
});

describe('noise filter', () => {
  it('drops transaction control and health checks', () => {
    for (const s of ['BEGIN', 'begin transaction', 'COMMIT', 'ROLLBACK', 'SAVEPOINT sp1', 'RELEASE SAVEPOINT sp1', 'ROLLBACK TO SAVEPOINT sp1', 'SELECT 1', 'select 1;', 'select version();', "SET TIME ZONE 'UTC'", 'SHOW server_version']) {
      assert.equal(isNoise(s), true, s);
    }
  });
  it('keeps real work', () => {
    for (const s of ['select 1 as x, y from t', 'select * from t', 'insert into t values (1)', 'select ?::int as n']) assert.equal(isNoise(s), false, s);
  });
});

describe('kindOf', () => {
  it('classifies statements', () => {
    assert.equal(kindOf('SELECT 1 FROM t'), 'select');
    assert.equal(kindOf('with x as (select 1) select * from x'), 'select');
    assert.equal(kindOf('with x as (select 1) insert into t select * from x'), 'write');
    assert.equal(kindOf('update t set a = 1'), 'write');
    assert.equal(kindOf('CREATE INDEX i ON t(a)'), 'ddl');
    assert.equal(kindOf('BEGIN'), 'txn');
  });
});

describe('volatile detector', () => {
  it('flags time, randomness and sequence state', () => {
    for (const s of [
      'select now()',
      'select random()',
      'select * from t where created_at > now() - interval \'1 day\'',
      "select datetime('now')",
      "select * from t where d < date('now', '-1 day')",
      'select current_timestamp',
      'select nextval(\'s\')',
      'select gen_random_uuid()',
      'select last_insert_rowid()',
      'select randomblob(8)',
    ]) {
      assert.equal(isVolatile(s), true, s);
    }
  });
  it('does not flag look-alikes inside strings, identifiers or comments', () => {
    for (const s of ["select 'now()' as a", 'select known_value from t', "select * from t where name = 'random()'", 'select 1 -- now()', 'select knows from t where renowned = ?']) {
      assert.equal(isVolatile(s), false, s);
    }
  });
});

describe('topLevel ORDER BY / LIMIT', () => {
  it('only counts depth-0 clauses', () => {
    assert.deepEqual(topLevel('select * from t order by a limit 5'), { orderBy: true, limit: true });
    assert.deepEqual(topLevel('select * from t where id in (select id from u order by x limit 3)'), { orderBy: false, limit: false });
    assert.deepEqual(topLevel('select * from t limit 5'), { orderBy: false, limit: true });
  });
});
