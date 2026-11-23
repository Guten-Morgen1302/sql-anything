/**
 * Typed parameter serialization. JSON can't carry Date / BigInt / Buffer / NaN, so those are tagged
 * with `$t`. Anything we can't reproduce exactly becomes `{ $t: 'unverifiable' }` and the statement is
 * excluded from replay. Encoding must never throw into the host app.
 */
export type Tagged =
  | null
  | boolean
  | number
  | string
  | Tagged[]
  | { $t: string; v?: unknown; why?: string };

const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 6;

export function encodeParams(args: unknown): Tagged[] {
  try {
    const budget = { n: 0 };
    const list = Array.isArray(args) ? args : [args];
    return list.map((a) => enc(a, 0, budget));
  } catch {
    return [{ $t: 'unverifiable', why: 'encode-failed' }];
  }
}

function enc(v: unknown, depth: number, b: { n: number }): Tagged {
  try {
    if (depth > MAX_DEPTH) return { $t: 'unverifiable', why: 'too-deep-or-circular' };
    if (v === null) return null;
    switch (typeof v) {
      case 'undefined':
        return { $t: 'undefined' };
      case 'boolean':
        return v;
      case 'string':
        b.n += v.length;
        return b.n > MAX_BYTES ? { $t: 'unverifiable', why: 'too-large' } : v;
      case 'number':
        if (Number.isFinite(v) && !Object.is(v, -0)) return v;
        return { $t: 'num', v: Object.is(v, -0) ? '-0' : String(v) };
      case 'bigint':
        return { $t: 'bigint', v: v.toString() };
      case 'function':
      case 'symbol':
        return { $t: 'unverifiable', why: typeof v };
    }
    if (v instanceof Date) {
      return Number.isNaN(v.getTime()) ? { $t: 'unverifiable', why: 'invalid-date' } : { $t: 'date', v: v.toISOString() };
    }
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      const u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      b.n += u8.byteLength;
      if (b.n > MAX_BYTES) return { $t: 'unverifiable', why: 'too-large' };
      return { $t: 'buffer', v: Buffer.from(u8).toString('base64') };
    }
    if (Array.isArray(v)) return v.map((x) => enc(x, depth + 1, b));
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, Tagged> = {};
      for (const k of Object.keys(v as object)) out[k] = enc((v as Record<string, unknown>)[k], depth + 1, b);
      return { $t: 'obj', v: out };
    }
    return { $t: 'unverifiable', why: (v as object).constructor?.name ?? 'object' };
  } catch {
    return { $t: 'unverifiable', why: 'encode-failed' };
  }
}

export function hasUnverifiable(t: Tagged | undefined): boolean {
  if (t === undefined || t === null || typeof t !== 'object') return false;
  if (Array.isArray(t)) return t.some(hasUnverifiable);
  if (t.$t === 'unverifiable') return true;
  if (t.$t === 'obj' && t.v && typeof t.v === 'object') return Object.values(t.v as Record<string, Tagged>).some(hasUnverifiable);
  return false;
}

/** Rebuild the exact driver-level values. Throws on unverifiable input: callers check hasUnverifiable first. */
export function decodeParam(t: Tagged): unknown {
  if (t === null || typeof t !== 'object') return t;
  if (Array.isArray(t)) return t.map(decodeParam);
  switch (t.$t) {
    case 'undefined':
      return undefined;
    case 'num':
      return Number(t.v);
    case 'bigint':
      return BigInt(t.v as string);
    case 'date':
      return new Date(t.v as string);
    case 'buffer':
      return Buffer.from(t.v as string, 'base64');
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(t.v as Record<string, Tagged>)) out[k] = decodeParam(x);
      return out;
    }
    default:
      throw new Error(`cannot decode param tag ${t.$t}`);
  }
}

export function decodeParams(ts: Tagged[] | undefined): unknown[] {
  return (ts ?? []).map(decodeParam);
}
