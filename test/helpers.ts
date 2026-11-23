/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbTarget } from '../src/db/conn.js';
import { muteSqliteWarning } from '../src/db/conn.js';
import { encodeParams } from '../src/trace/params.js';
import type { TraceRecord } from '../src/trace/types.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(REPO, 'dist', 'test', 'fixtures');

let seq = 0;
/** A synthetic trace record: lets the trap suite exercise verify without launching an app. */
export function rec(sql: string, params: unknown[] = [], over: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: 1,
    type: 'q',
    t: 1_700_000_000_000 + seq,
    seq: seq++,
    pid: 1,
    thread: 0,
    db: 'node:sqlite',
    op: 'all',
    sql,
    params: encodeParams(params),
    dur_us: 100,
    req: null,
    frame: null,
    frame_exact: false,
    ...over,
  };
}

export function tmpDir(prefix = 'sa-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

export async function openSqliteRaw(file: string): Promise<any> {
  muteSqliteWarning();
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file);
}

/** Same schema and data shape for both engines. Ties in `scores`, NULL in `blocked`, customers with no orders. */
export const SCHEMA = [
  'create table customers (id integer primary key, name text, region text)',
  'create table orders (id integer primary key, customer_id integer, status text, total integer, created_at text)',
  'create table scores (id integer primary key, player text, score integer)',
  'create table members (id integer primary key, email text)',
  'create table blocked (id integer primary key, email text)',
];

export async function seedSqlite(file: string, opts: { indexed?: boolean; orders?: number } = {}): Promise<DbTarget> {
  const db = await openSqliteRaw(file);
  for (const s of SCHEMA) db.exec(s);
  db.exec('begin');
  const ic = db.prepare('insert into customers values (?,?,?)');
  for (let i = 1; i <= 500; i++) ic.run(i, 'c' + i, 'r' + (i % 10));
  const io = db.prepare('insert into orders values (?,?,?,?,?)');
  const n = opts.orders ?? 40000;
  for (let i = 1; i <= n; i++) {
    let c = 1 + ((i * 13) % 500);
    if (c % 7 === 0) c += 1; // customers with id % 7 == 0 never order
    io.run(i, c, ['new', 'paid', 'shipped'][i % 3], i % 1000, 'd' + i);
  }
  const isc = db.prepare('insert into scores values (?,?,?)');
  for (let i = 1; i <= 3000; i++) isc.run(i, 'p' + i, 100 - (i % 5));
  const im = db.prepare('insert into members values (?,?)');
  for (let i = 1; i <= 200; i++) im.run(i, `u${i}@x.com`);
  const ib = db.prepare('insert into blocked values (?,?)');
  for (let i = 1; i <= 20; i++) ib.run(i, `u${i}@x.com`);
  ib.run(21, null); // a NULL in the NOT IN list is the classic trap
  db.exec('commit');
  if (opts.indexed) db.exec('create index idx_orders_customer on orders(customer_id)');
  db.close();
  return { kind: 'sqlite', url: file };
}

export async function seedPg(url: string, opts: { indexed?: boolean; orders?: number } = {}): Promise<DbTarget> {
  const pg: any = (await import('pg')).default;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  for (const s of SCHEMA) await c.query(s.replace('integer primary key', 'integer primary key'));
  await c.query("insert into customers select i, 'c'||i, 'r'||(i%10) from generate_series(1,500) i");
  const n = opts.orders ?? 40000;
  await c.query(
    `insert into orders select i, case when (1+((i*13)%500))%7=0 then 2+((i*13)%500) else 1+((i*13)%500) end,
       (array['new','paid','shipped'])[1+(i%3)], i%1000, 'd'||i from generate_series(1,${n}) i`,
  );
  await c.query('insert into scores select i, \'p\'||i, 100-(i%5) from generate_series(1,3000) i');
  await c.query("insert into members select i, 'u'||i||'@x.com' from generate_series(1,200) i");
  await c.query("insert into blocked select i, 'u'||i||'@x.com' from generate_series(1,20) i");
  await c.query('insert into blocked values (21, null)');
  if (opts.indexed) await c.query('create index idx_orders_customer on orders(customer_id)');
  await c.query('analyze');
  await c.end();
  return { kind: 'pg', url };
}

/** Real Postgres without Docker. */
export async function startPg(): Promise<{ baseUrl: string; createDb(name: string): Promise<string>; stop(): Promise<void> }> {
  const EP: any = (await import('embedded-postgres')).default;
  const port = await freePort();
  const dir = tmpDir('sa-pg-');
  const pg = new EP({ databaseDir: path.join(dir, 'data'), user: 'sa', password: 'sa', port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const baseUrl = `postgres://sa:sa@localhost:${port}`;
  return {
    baseUrl,
    async createDb(name: string) {
      await pg.createDatabase(name);
      return `${baseUrl}/${name}`;
    },
    async stop() {
      await pg.stop();
      // Windows can hold the data directory for a moment after postgres exits (EBUSY): retry, and never fail a test over cleanup
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        /* leftover temp dir is harmless */
      }
    },
  };
}

export function findLine(file: string, needle: string): number {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`"${needle}" not found in ${file}`);
  return i + 1;
}
