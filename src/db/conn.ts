/* eslint-disable @typescript-eslint/no-explicit-any */
export type DbKind = 'sqlite' | 'pg';

export interface DbTarget {
  kind: DbKind;
  /** sqlite: file path. pg: connection string */
  url: string;
  /** pg schema-clone fallback: schema the connection should resolve first */
  searchPath?: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** rows affected, for writes */
  changes: number;
}

export interface Conn {
  readonly kind: DbKind;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function parseTarget(s: string): DbTarget {
  if (/^postgres(ql)?:\/\//i.test(s)) return { kind: 'pg', url: s };
  return { kind: 'sqlite', url: s.replace(/^sqlite:(\/\/)?/i, '') };
}

let warningsMuted = false;
/** node:sqlite prints an ExperimentalWarning on load. Our own use of it is not news to the user. */
export function muteSqliteWarning(): void {
  if (warningsMuted) return;
  warningsMuted = true;
  const ow = process.emitWarning;
  (process as any).emitWarning = function (m: any, ...r: any[]) {
    if (String(m?.message ?? m).includes('SQLite')) return;
    return (ow as any).call(this, m, ...r);
  };
}

export async function openConn(t: DbTarget, opts: { readOnly?: boolean } = {}): Promise<Conn> {
  return t.kind === 'sqlite' ? openSqlite(t.url, opts.readOnly) : openPg(t);
}

// ------------------------------------------------------------------ sqlite ---------------------------------------
function sqliteArgs(params: unknown[]): unknown[] {
  const conv = (v: unknown): unknown => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return v;
  };
  if (params.length === 1 && Array.isArray(params[0])) return (params[0] as unknown[]).map(conv);
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !(params[0] instanceof Date) && !ArrayBuffer.isView(params[0])) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params[0] as object)) o[k] = conv(v);
    return [o];
  }
  return params.map(conv);
}

async function openSqlite(file: string, readOnly = false): Promise<Conn> {
  muteSqliteWarning();
  const { DatabaseSync } = await import('node:sqlite');
  const db: any = new DatabaseSync(file, { readOnly } as any);
  const cache = new Map<string, any>();
  const prep = (sql: string) => {
    let st = cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      st.setReadBigInts?.(true); // exact integers: a number would round >2^53 and hide a diff
      st.setReturnArrays?.(true);
      cache.set(sql, st);
    }
    return st;
  };
  return {
    kind: 'sqlite',
    async query(sql, params = []) {
      const st = prep(sql);
      const args = sqliteArgs(params);
      const isRead = st.columns ? st.columns().length > 0 : /^\s*(select|with|values|pragma|explain)/i.test(sql);
      if (!isRead) {
        const r = st.run(...args);
        return { columns: [], rows: [], changes: Number(r.changes ?? 0) };
      }
      const raw: any[] = st.all(...args);
      const columns: string[] = st.columns ? st.columns().map((c: any) => c.name) : raw.length && !Array.isArray(raw[0]) ? Object.keys(raw[0]) : [];
      const rows = raw.map((r) => (Array.isArray(r) ? r : Object.values(r)));
      return { columns, rows, changes: 0 };
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      cache.clear();
      db.close();
    },
  };
}

// ------------------------------------------------------------------ postgres -------------------------------------
async function openPg(t: DbTarget): Promise<Conn> {
  const pg: any = (await import('pg')).default;
  // Return every value as its raw text so canonicalization compares what Postgres sent, not what a JS driver guessed.
  const client = new pg.Client({
    connectionString: t.url,
    types: { getTypeParser: () => (x: string) => x },
    statement_timeout: 60_000,
  });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  if (t.searchPath) await client.query(`SET search_path TO "${t.searchPath.replace(/"/g, '""')}", public`);
  const decode = (v: unknown) => v;
  return {
    kind: 'pg',
    async query(sql, params = []) {
      const r = await client.query({ text: sql, values: params.map(decode), rowMode: 'array' });
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      return { columns: (last.fields ?? []).map((f: any) => f.name), rows: last.rows ?? [], changes: last.rowCount ?? 0 };
    },
    async exec(sql) {
      await client.query(sql);
    },
    async close() {
      await client.end().catch(() => {});
    },
  };
}
