/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { type Conn, type DbTarget, muteSqliteWarning, openConn } from './conn.js';

export interface Shadows {
  targets: DbTarget[];
  /** how each clone was made, e.g. "template" or "schema-clone" (weaker: schema-qualified names are not isolated) */
  method: string;
  warnings: string[];
  dispose(): Promise<void>;
}

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

export function assertLocalPg(url: string, allowRemote: boolean): void {
  if (allowRemote) return;
  const u = new URL(url);
  const host = u.hostname || new URLSearchParams(u.search).get('host') || '';
  if (!LOCAL_HOSTS.has(host) && !host.startsWith('/')) {
    throw new Error(`refusing to clone ${host}: the shadow copy would hold a copy of that database's data. Pass --allow-remote-shadow to override.`);
  }
}

/** Make `n` independent clones of `source`. The source is only ever read. */
export async function makeShadows(source: DbTarget, n: number, opts: { allowRemote?: boolean } = {}): Promise<Shadows> {
  return source.kind === 'sqlite' ? sqliteShadows(source, n) : pgShadows(source, n, !!opts.allowRemote);
}

async function sqliteShadows(source: DbTarget, n: number): Promise<Shadows> {
  muteSqliteWarning();
  if (!fs.existsSync(source.url)) throw new Error(`sqlite database not found: ${source.url}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-anything-shadow-'));
  const { DatabaseSync } = await import('node:sqlite');
  const targets: DbTarget[] = [];
  const src: any = new DatabaseSync(source.url, { readOnly: true } as any);
  try {
    for (let i = 0; i < n; i++) {
      const dst = path.join(dir, `shadow-${i}.db`);
      src.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); // consistent snapshot even if the app is writing in WAL mode
      targets.push({ kind: 'sqlite', url: dst });
    }
  } finally {
    src.close();
  }
  return {
    targets,
    method: 'file-snapshot',
    warnings: [],
    async dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function pgShadows(source: DbTarget, n: number, allowRemote: boolean): Promise<Shadows> {
  assertLocalPg(source.url, allowRemote);
  const u = new URL(source.url);
  const srcDb = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const adminUrl = new URL(source.url);
  adminUrl.pathname = '/postgres';
  const admin = await openConn({ kind: 'pg', url: adminUrl.toString() });
  const id = randomBytes(4).toString('hex');
  const created: string[] = [];
  const warnings: string[] = [];
  const targets: DbTarget[] = [];
  let method = 'template';
  let fileCopy = false;
  try {
    fileCopy = Number((await admin.query('show server_version_num')).rows[0][0]) >= 150000;
    for (let i = 0; i < n; i++) {
      const name = `sa_shadow_${id}_${i}`;
      await createFromTemplate(admin, name, srcDb, fileCopy);
      created.push(name);
      const t = new URL(source.url);
      t.pathname = '/' + name;
      targets.push({ kind: 'pg', url: t.toString() });
    }
  } catch (e: any) {
    await dropDatabases(admin, created);
    created.length = 0;
    targets.length = 0;
    // 55006: source is in use (the app is still connected). We never kick other sessions off a user's database.
    if (e?.code !== '55006') {
      await admin.close();
      throw new Error(`cannot create shadow database: ${e?.message ?? e}`);
    }
    method = 'schema-clone';
    warnings.push(
      'source database has other connections, so CREATE DATABASE ... TEMPLATE was not possible. Used same-database schema clones instead. Tables are copied, but views and schema-qualified names (e.g. "public"."t") are NOT isolated. Stop the app for a stricter clone.',
    );
    const src = await openConn(source);
    try {
      const tabs = (await src.query("select tablename from pg_tables where schemaname = 'public' order by 1")).rows.map((r) => String(r[0]));
      for (let i = 0; i < n; i++) {
        const sch = `sa_shadow_${id}_${i}`;
        await src.exec(`CREATE SCHEMA ${qi(sch)}`);
        created.push(sch);
        for (const t of tabs) {
          await src.exec(`CREATE TABLE ${qi(sch)}.${qi(t)} (LIKE public.${qi(t)} INCLUDING ALL)`);
          await src.exec(`INSERT INTO ${qi(sch)}.${qi(t)} OVERRIDING SYSTEM VALUE SELECT * FROM public.${qi(t)}`);
        }
        targets.push({ kind: 'pg', url: source.url, searchPath: sch });
      }
    } catch (e2) {
      for (const s of created) await src.exec(`DROP SCHEMA IF EXISTS ${qi(s)} CASCADE`).catch(() => {});
      await src.close();
      await admin.close();
      throw e2;
    }
    await src.close();
  }
  let disposed = false;
  return {
    targets,
    method,
    warnings,
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (method === 'template') await dropDatabases(admin, created);
      else {
        const c = await openConn(source);
        for (const s of created) await c.exec(`DROP SCHEMA IF EXISTS ${qi(s)} CASCADE`).catch(() => {});
        await c.close();
      }
      await admin.close();
    },
  };
}

/** The app may have just been stopped: its backends take a moment to disappear. Retry briefly before giving up (55006). */
async function createFromTemplate(admin: Conn, name: string, srcDb: string, fileCopy: boolean): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // PG15+: STRATEGY = FILE_COPY copies files instead of replaying WAL block by block, much faster for big databases
      await admin.exec(`CREATE DATABASE ${qi(name)} TEMPLATE ${qi(srcDb)}${fileCopy ? ' STRATEGY = FILE_COPY' : ''}`);
      return;
    } catch (e: any) {
      if (e?.code !== '55006' || attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function dropDatabases(admin: Conn, names: string[]): Promise<void> {
  for (const n of names) await admin.exec(`DROP DATABASE IF EXISTS ${qi(n)} WITH (FORCE)`).catch(() => {});
}

export async function analyze(c: Conn): Promise<void> {
  await c.exec('ANALYZE');
}
