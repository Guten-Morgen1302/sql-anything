import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SiteCache } from '../../src/hook/stack.js';
import { bootstrapRatio, median, mulberry32, percentile } from '../../src/stats.js';
import { compare, digest, encodeCell } from '../../src/verify/canonical.js';

describe('bootstrap speedup CI', () => {
  const noisy = (rng: () => number, base: number, n: number) => Array.from({ length: n }, () => base * (0.8 + 0.4 * rng()));
  it('a real 4x win has a lower bound well above 1.5', () => {
    const rng = mulberry32(7);
    const r = bootstrapRatio(noisy(rng, 4, 60), noisy(rng, 1, 60), rng);
    assert.ok(r.lo > 3, `lo=${r.lo}`);
    assert.ok(r.point > 3.5 && r.point < 4.5);
  });
  it('no change straddles 1.0, so it can never clear a 1.5x gate', () => {
    const rng = mulberry32(8);
    const r = bootstrapRatio(noisy(rng, 1, 60), noisy(rng, 1, 60), rng);
    assert.ok(r.lo < 1.2 && r.hi > 0.85, `${r.lo}..${r.hi}`);
  });
  it('is deterministic for a seed and handles empty input', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 1, 2, 2, 3];
    assert.deepEqual(bootstrapRatio(a, b, mulberry32(3)), bootstrapRatio(a, b, mulberry32(3)));
    assert.ok(Number.isNaN(bootstrapRatio([], [], mulberry32(1)).point));
  });
  it('median and percentile', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  });
});

describe('canonical row encoding', () => {
  it('never collides int / real / text / NULL / blob', () => {
    const cells = [1n, 1, '1', null, new Uint8Array([1]), true].map(encodeCell);
    assert.equal(new Set(cells).size, cells.length);
  });
  it('NULL is not the string NULL and -0 equals 0', () => {
    assert.notEqual(encodeCell(null), encodeCell('NULL'));
    assert.equal(encodeCell(-0), encodeCell(0));
  });
  const r = (rows: unknown[][], columns = ['a']) => digest({ columns, rows, changes: 0 });
  it('multiset ignores order, ordered does not', () => {
    const x = r([[1], [2], [3]]);
    const y = r([[3], [1], [2]]);
    assert.equal(x.multiset, y.multiset);
    assert.notEqual(x.ordered, y.ordered);
    assert.equal(compare(x, y, false).ok, true);
    const o = compare(x, y, true);
    assert.equal(o.ok, false);
    assert.match((o as { reason: string }).reason, /different order/);
  });
  it('catches duplicate rows, dropped rows and column drift', () => {
    assert.equal(compare(r([[1], [2]]), r([[1], [2], [2]]), false).ok, false);
    assert.equal(compare(r([[1], [2]]), r([[1]]), false).ok, false);
    assert.equal(compare(r([[1]], ['a']), r([[1]], ['b']), false).ok, false);
    assert.equal(compare(r([[null]]), r([['NULL']]), false).ok, false);
  });
  it('postgres numeric scale is a difference (raw text is compared)', () => {
    assert.equal(compare(r([['1.0']]), r([['1.00']]), false).ok, false);
  });
});

describe('first-seen stack capture', () => {
  it('always captures the first 3 calls of an unseen SQL text, then samples', () => {
    const c = new SiteCache(100, 3, 10);
    const exact = Array.from({ length: 25 }, () => c.site('select 1 from t').exact);
    assert.deepEqual(exact.slice(0, 3), [true, true, true]);
    assert.deepEqual(exact.slice(3, 9), [false, false, false, false, false, false]);
    assert.equal(exact[9], true); // 10th call: sampled
    assert.equal(exact[19], true); // 20th call: sampled
    assert.equal(exact[10], false);
  });
  it('a single slow query keeps its call site: attribution is never dropped on the first calls', () => {
    const c = new SiteCache();
    const s = c.site('select pg_sleep(5)');
    assert.equal(s.exact, true);
    assert.match(s.frame ?? '', /stats-canonical-stack\.test\.js:\d+:\d+$/);
  });
  it('reuses the cached frame for unsampled calls', () => {
    const c = new SiteCache(100, 1, 1000);
    const first = c.site('select 2');
    const again = c.site('select 2');
    assert.equal(again.exact, false);
    assert.equal(again.frame, first.frame);
  });
  it('is bounded: an evicted text is "unseen" again and re-captured', () => {
    const c = new SiteCache(2, 3, 1000);
    for (let i = 0; i < 5; i++) c.site('select a');
    c.site('select b');
    c.site('select c'); // evicts 'select a'
    assert.equal(c.site('select a').exact, true);
  });
  it('does not change the host app Error.stackTraceLimit', () => {
    const before = Error.stackTraceLimit;
    new SiteCache().site('select 3');
    assert.equal(Error.stackTraceLimit, before);
  });
});
