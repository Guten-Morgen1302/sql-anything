/* eslint-disable @typescript-eslint/no-explicit-any */
import Module, { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { threadId } from 'node:worker_threads';
import { encodeParams } from '../trace/params.js';
import type { TraceRecord } from '../trace/types.js';
import { TraceWriter } from './writer.js';
import { SiteCache } from './stack.js';

const MAX_SQL = 8192;
const ENTRY_URL = new URL('./index.js', import.meta.url).href;

/**
 * Installs the capture hook. Everything here is wrapped so that a failure in tracing can never change what the host
 * app sees: results and exceptions pass through untouched, recording happens in `finally` inside try/catch.
 */
export function install(): string[] {
  const writer = new TraceWriter();
  const sites = new SiteCache();
  const als = new AsyncLocalStorage<{ id: number }>();
  const tagReq = process.env.SQL_ANYTHING_TAG_REQ === '1';
  let seq = 0;
  let reqCounter = 0;
  const patched: string[] = [];

  interface Call {
    t0: number;
    wall: number;
    req: number | null;
    site: ReturnType<SiteCache['site']>;
    sql: string;
  }
  const begin = (sql: unknown): Call => {
    const s = typeof sql === 'string' ? sql : String(sql ?? '');
    let site: Call['site'] = { frame: null, fn: null, exact: false };
    try {
      site = sites.site(s);
    } catch {
      /* attribution is best effort */
    }
    return { t0: performance.now(), wall: Date.now(), req: als.getStore()?.id ?? null, site, sql: s };
  };
  const record = (db: TraceRecord['db'], op: string, c: Call, args: unknown, extra: Partial<TraceRecord> = {}) => {
    try {
      const rec: TraceRecord = {
        v: 1,
        type: 'q',
        t: c.wall,
        seq: seq++,
        pid: process.pid,
        thread: threadId,
        db,
        op,
        sql: c.sql.length > MAX_SQL ? c.sql.slice(0, MAX_SQL) : c.sql,
        dur_us: Math.round((performance.now() - c.t0) * 1000),
        req: c.req,
        frame: c.site.frame,
        fn: c.site.fn,
        frame_exact: c.site.exact,
        ...extra,
      };
      if (c.sql.length > MAX_SQL) rec.sql_truncated = true;
      if (args !== undefined) rec.params = encodeParams(args);
      writer.write(rec);
    } catch {
      /* never throw into the app */
    }
  };

  // --- HTTP request context (AsyncLocalStorage) ---------------------------------------------------------------
  try {
    const http = process.getBuiltinModule('node:http') as typeof import('node:http');
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (this: any, ev: string, ...a: any[]) {
      if (ev !== 'request') return (emit as any).call(this, ev, ...a);
      const id = ++reqCounter;
      if (tagReq) {
        try {
          a[1]?.setHeader?.('x-sql-anything-req', String(id));
        } catch {
          /* headers may already be sent */
        }
      }
      return als.run({ id }, () => (emit as any).call(this, ev, ...a));
    } as any;
    patched.push('http');
  } catch {
    /* ignore */
  }

  // --- worker threads: NODE_OPTIONS=--import is not applied to Worker, so inject it -------------------------------
  try {
    const wt = process.getBuiltinModule('node:worker_threads') as typeof import('node:worker_threads');
    const W = wt.Worker as any;
    if (!W.__sa) {
      class SAWorker extends W {
        constructor(file: any, opts: any = {}) {
          const exec: string[] = [...(opts.execArgv ?? process.execArgv)];
          if (!exec.some((x) => String(x).includes(ENTRY_URL))) exec.push('--import', ENTRY_URL);
          super(file, { ...opts, execArgv: exec });
        }
      }
      (SAWorker as any).__sa = true;
      (wt as any).Worker = SAWorker;
      syncBuiltinESMExports();
      patched.push('worker_threads');
    }
  } catch {
    /* ignore */
  }

  // --- node:sqlite (builtin: patch the shared prototypes) --------------------------------------------------------
  try {
    // Loading node:sqlite prints an ExperimentalWarning. Hold ours back until the app first uses sqlite.
    const ow = process.emitWarning;
    let held: any[] | null = null;
    (process as any).emitWarning = function (m: any, ...r: any[]) {
      if (String(m?.message ?? m).includes('SQLite')) {
        held = [m, ...r];
        return;
      }
      return (ow as any).call(this, m, ...r);
    };
    let sq: any;
    try {
      sq = process.getBuiltinModule('node:sqlite');
    } finally {
      process.emitWarning = ow;
    }
    const release = () => {
      if (held) {
        const h = held;
        held = null;
        (process.emitWarning as any)(...h);
      }
    };
    const P = sq?.DatabaseSync?.prototype;
    if (P && !P.__sa) {
      P.__sa = true;
      const oexec = P.exec;
      P.exec = function (this: any, sql: string) {
        release();
        const c = begin(sql);
        let err: string | undefined;
        try {
          return oexec.call(this, sql);
        } catch (e: any) {
          err = e?.message;
          throw e;
        } finally {
          record('node:sqlite', 'exec', c, undefined, err ? { err } : {});
        }
      };
      const oprep = P.prepare;
      P.prepare = function (this: any, sql: string, ...rest: any[]) {
        release();
        const st = oprep.call(this, sql, ...rest);
        try {
          const SP = Object.getPrototypeOf(st);
          if (!SP.__sa) {
            SP.__sa = true;
            for (const m of ['run', 'get', 'all']) {
              const o = SP[m];
              SP[m] = function (this: any, ...args: any[]) {
                const c = begin(this.sourceSQL);
                let err: string | undefined;
                let res: any;
                try {
                  res = o.apply(this, args);
                  return res;
                } catch (e: any) {
                  err = e?.message;
                  throw e;
                } finally {
                  record('node:sqlite', m, c, args, err ? { err } : Array.isArray(res) ? { rows: res.length } : {});
                }
              };
            }
          }
        } catch {
          /* ignore */
        }
        return st;
      };
      patched.push('node:sqlite');
    }
  } catch {
    /* ignore */
  }

  // --- pg + better-sqlite3 (CJS packages) ------------------------------------------------------------------------
  // pg.Pool#query hands the statement to a client later, from pool-internal callbacks, so by the time Client#query runs
  // the app's frame (and its request context) is gone from the stack. Capture both at Pool#query and hand them over.
  const pending = new Map<string, Call[]>();
  const patchPg = (m: any) => {
    if (!m?.Client || m.Client.prototype.__sa) return;
    const CP = m.Client.prototype;
    CP.__sa = true;
    const oq = CP.query;
    if (m.Pool?.prototype?.query) {
      const op = m.Pool.prototype.query;
      m.Pool.prototype.query = function (this: any, cfg: any, ...rest: any[]) {
        try {
          const sql = cfg && typeof cfg === 'object' ? cfg.text : cfg;
          if (typeof sql === 'string' && !(cfg && typeof cfg.submit === 'function')) {
            const q = pending.get(sql) ?? pending.set(sql, []).get(sql)!;
            q.push(begin(sql));
            if (q.length > 1000) q.shift();
          }
        } catch {
          /* attribution is best effort */
        }
        return op.call(this, cfg, ...rest);
      };
    }
    CP.query = function (this: any, cfg: any, ...rest: any[]) {
      try {
        const isObj = cfg && typeof cfg === 'object';
        if (isObj && typeof cfg.submit === 'function') return oq.call(this, cfg, ...rest); // cursor/stream: not traced yet
        const sql = isObj ? cfg.text : cfg;
        const vals = isObj ? cfg.values : rest[0];
        const params = Array.isArray(vals) ? vals : undefined;
        const pooled = typeof sql === 'string' ? pending.get(sql)?.shift() : undefined;
        const c = pooled ? { ...pooled, t0: performance.now() } : begin(sql);
        const args = [cfg, ...rest];
        const li = args.length - 1;
        // pg-pool calls client.query(text, values, callback): the callback form must be traced too
        if (typeof args[li] === 'function') {
          const ocb = args[li];
          args[li] = function (this: any, err: any, res: any) {
            record('pg', 'query', c, params, { rows: res?.rowCount ?? undefined, ...(err ? { err: String(err.message) } : {}) });
            return ocb.apply(this, arguments);
          };
          return oq.apply(this, args);
        }
        const r = oq.apply(this, args);
        if (r && typeof r.then === 'function') {
          r.then(
            (x: any) => record('pg', 'query', c, params, { rows: x?.rowCount ?? undefined }),
            (e: any) => record('pg', 'query', c, params, { err: String(e?.message) }),
          );
        }
        return r;
      } catch (e) {
        throw e;
      }
    };
    patched.push('pg');
  };
  const patchBsq = (m: any) => {
    if (typeof m !== 'function' || m.prototype.__sa) return;
    m.prototype.__sa = true;
    const tmp = new m(':memory:');
    const SP = Object.getPrototypeOf(tmp.prepare('select 1'));
    tmp.close();
    const oex = m.prototype.exec;
    m.prototype.exec = function (this: any, sql: string) {
      const c = begin(sql);
      let err: string | undefined;
      try {
        return oex.call(this, sql);
      } catch (e: any) {
        err = e?.message;
        throw e;
      } finally {
        record('better-sqlite3', 'exec', c, undefined, err ? { err } : {});
      }
    };
    for (const mm of ['run', 'get', 'all', 'iterate']) {
      const o = SP[mm];
      SP[mm] = function (this: any, ...args: any[]) {
        const c = begin(this.source);
        let err: string | undefined;
        let res: any;
        try {
          res = o.apply(this, args);
          return res;
        } catch (e: any) {
          err = e?.message;
          throw e;
        } finally {
          record('better-sqlite3', mm, c, args, err ? { err } : Array.isArray(res) ? { rows: res.length } : {});
        }
      };
    }
    patched.push('better-sqlite3');
  };

  // Eager: resolve from the app's cwd and entry dir and patch the shared prototypes. ESM `import` of a CJS package
  // does not go through Module._load, so this is what covers `import pg from 'pg'`.
  const roots = new Set<string>([process.cwd()]);
  if (process.argv[1]) roots.add(path.dirname(path.resolve(process.argv[1])));
  for (const root of roots) {
    const req = createRequire(path.join(root, 'noop.js'));
    for (const [name, fn] of [
      ['pg', patchPg],
      ['better-sqlite3', patchBsq],
    ] as const) {
      try {
        fn(req(name));
      } catch {
        /* package not resolvable from here: the Module._load fallback below may still catch it */
      }
    }
  }
  // Fallback: any CJS require() from anywhere (nested copies, monorepos).
  const oload = (Module as any)._load;
  (Module as any)._load = function (this: any, request: string, ...rest: any[]) {
    const m = oload.call(this, request, ...rest);
    try {
      if (request === 'pg') patchPg(m);
      else if (request === 'better-sqlite3') patchBsq(m);
    } catch {
      /* ignore */
    }
    return m;
  };

  writer.write({ v: 1, type: 'hook-loaded', pid: process.pid, thread: threadId, node: process.version, patched });
  return patched;
}
