import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeParams, encodeParams, hasUnverifiable } from '../../src/trace/params.js';

const roundtrip = (v: unknown[]) => decodeParams(JSON.parse(JSON.stringify(encodeParams(v))));

describe('typed parameter serialization', () => {
  it('round-trips Date, BigInt and Buffer through JSON with exact driver types', () => {
    const d = new Date('2026-11-23T12:34:56.789Z');
    const big = 9007199254740993n; // > 2^53: a JS number would silently round it
    const buf = Buffer.from([0, 255, 1, 128]);
    const [d2, big2, buf2] = roundtrip([d, big, buf]) as [Date, bigint, Buffer];
    assert.ok(d2 instanceof Date);
    assert.equal(d2.getTime(), d.getTime());
    assert.equal(typeof big2, 'bigint');
    assert.equal(big2, big);
    assert.ok(Buffer.isBuffer(buf2));
    assert.deepEqual([...buf2], [0, 255, 1, 128]);
  });

  it('keeps undefined, NaN, Infinity and -0 distinct from null and 0', () => {
    const out = roundtrip([undefined, NaN, Infinity, -Infinity, -0, null, 0]);
    assert.equal(out[0], undefined);
    assert.ok(Number.isNaN(out[1] as number));
    assert.equal(out[2], Infinity);
    assert.equal(out[3], -Infinity);
    assert.ok(Object.is(out[4], -0));
    assert.equal(out[5], null);
    assert.ok(Object.is(out[6], 0));
  });

  it('round-trips arrays, plain objects (named params) and Uint8Array', () => {
    const out = roundtrip([[1, 'a', 2n], { id: 5, d: new Date(0), nested: { b: Buffer.from('hi') } }, new Uint8Array([1, 2])]) as any[];
    assert.deepEqual(out[0], [1, 'a', 2n]);
    assert.equal(out[1].id, 5);
    assert.equal(out[1].d.getTime(), 0);
    assert.equal(out[1].nested.b.toString(), 'hi');
    assert.deepEqual([...out[2]], [1, 2]);
  });

  it('marks unserializable params as unverifiable instead of throwing', () => {
    const circular: any = {};
    circular.self = circular;
    for (const bad of [() => 1, Symbol('x'), new Map(), new (class Foo {})(), circular, new Date('nope'), 'x'.repeat(70_000)]) {
      const enc = encodeParams([bad]);
      assert.equal(hasUnverifiable(enc), true, String(bad).slice(0, 20));
    }
    assert.equal(hasUnverifiable(encodeParams([1, 'a', null, new Date()])), false);
  });

  it('never throws for hostile objects (throwing getters, proxies)', () => {
    const evil = new Proxy({}, { ownKeys() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
    assert.doesNotThrow(() => encodeParams([evil, { get x() { throw new Error('g'); } }]));
    assert.equal(hasUnverifiable(encodeParams([evil])), true);
  });

  it('wraps a single non-array argument', () => {
    assert.deepEqual(encodeParams(7), [7]);
  });
});
