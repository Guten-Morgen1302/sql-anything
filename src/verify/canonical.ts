import { createHash } from 'node:crypto';
import type { QueryResult } from '../db/conn.js';

export interface Digest {
  columns: string[];
  count: number;
  /** hash of the rows in returned order */
  ordered: string;
  /** hash of the rows with order ignored (multiset) */
  multiset: string;
}

const SEP = String.fromCharCode(1);
const NUL = String.fromCharCode(0) + 'N';

/**
 * One tagged string per cell so 1 (int), 1.0 (real), '1' (text) and NULL never collide, and NULL ordering,
 * -0, NaN, bigint and blobs are all exact. Postgres values arrive as their raw text (see db/conn.ts).
 */
export function encodeCell(v: unknown): string {
  if (v === null || v === undefined) return NUL;
  switch (typeof v) {
    case 'string':
      return 's:' + v;
    case 'bigint':
      return 'i:' + v.toString();
    case 'number':
      return Number.isNaN(v) ? 'f:NaN' : 'f:' + (Object.is(v, -0) ? '0' : String(v));
    case 'boolean':
      return 'z:' + (v ? '1' : '0');
  }
  if (v instanceof Uint8Array) return 'b:' + Buffer.from(v).toString('hex');
  if (v instanceof Date) return 'd:' + v.toISOString();
  return 'j:' + JSON.stringify(v);
}

const h = (s: string) => createHash('sha1').update(s).digest('hex');

export function digest(r: QueryResult): Digest {
  const rowHashes = r.rows.map((row) => h(row.map(encodeCell).join(SEP)));
  const ordered = createHash('sha1');
  for (const x of rowHashes) ordered.update(x);
  const multiset = createHash('sha1');
  for (const x of [...rowHashes].sort()) multiset.update(x);
  return { columns: r.columns, count: r.rows.length, ordered: ordered.digest('hex'), multiset: multiset.digest('hex') };
}

export type Parity = { ok: true } | { ok: false; reason: string };

/**
 * Same columns, same rows. When the statement has a top-level ORDER BY the sequence must match too. If the sets are
 * equal but the sequence is not, the ORDER BY has ties and the two plans broke them differently: that is rejected
 * (add a tie-breaker column) rather than waved through.
 */
export function compare(a: Digest, b: Digest, ordered: boolean): Parity {
  if (a.columns.join(SEP) !== b.columns.join(SEP)) return { ok: false, reason: `columns differ: [${a.columns}] vs [${b.columns}]` };
  if (a.count !== b.count) return { ok: false, reason: `row count ${a.count} vs ${b.count}` };
  if (a.multiset !== b.multiset) return { ok: false, reason: 'row contents differ' };
  if (ordered && a.ordered !== b.ordered) return { ok: false, reason: 'same rows but different order (ties in ORDER BY broken differently; add a tie-breaker)' };
  return { ok: true };
}
