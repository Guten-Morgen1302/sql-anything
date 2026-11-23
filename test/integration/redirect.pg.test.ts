/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { capture } from '../../src/capture.js';
import { readTrace } from '../../src/trace/read.js';
import { REPO, freePort, startPg, tmpDir } from '../helpers.js';

let server: Awaited<ReturnType<typeof startPg>>;
let src: string;
let dst: string;
let dir: string;

before(async () => {
  server = await startPg();
  src = await server.createDb('redir_src');
  dst = await server.createDb('redir_dst');
  const pg: any = (await import('pg')).default;
  for (const [url, rows] of [[src, 1], [dst, 2]] as const) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query('create table t (id int)');
    await c.query(`insert into t select generate_series(1, ${rows})`);
    await c.end();
  }
  dir = tmpDir('sa-redir-');
  // An app that configures its database with explicit options and never reads DATABASE_URL (Sequelize-style).
  fs.writeFileSync(
    path.join(dir, 'app.mjs'),
    `import http from 'node:http';
import pg from 'pg';
const u = new URL(process.env.APP_OWN_DB);
const pool = new pg.Pool({ host: u.hostname, port: Number(u.port), user: u.username, password: u.password, database: u.pathname.slice(1) });
http.createServer(async (req, res) => {
  const r = await pool.query('select count(*)::int as n from t');
  res.end(JSON.stringify(r.rows[0]));
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
  );
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
}, { timeout: 120_000 });

after(async () => {
  try {
    fs.unlinkSync(path.join(dir, 'node_modules')); // the junction, never its target
  } catch {
    try {
      fs.rmdirSync(path.join(dir, 'node_modules'));
    } catch {
      /* gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  await server?.stop();
});

describe('pg connection redirect: verification must never measure the wrong database', () => {
  it('without a redirect the app uses its own database, and the hook records which one', async () => {
    const port = await freePort();
    const traceDir = path.join(dir, 'trace-a');
    const r = await capture({ cmd: [process.execPath, 'app.mjs'], cwd: dir, traceDir, env: { APP_OWN_DB: src, PORT: String(port) }, hits: [`http://127.0.0.1:${port}/`], quiet: true });
    assert.equal(JSON.parse(r.hits[0].body).n, 1, 'source database has 1 row');
    const conns = readTrace(traceDir).conns;
    assert.ok(conns.length >= 1 && conns.every((c) => c.database === 'redir_src' && c.redirected === false));
  });

  it('with SQL_ANYTHING_PG_REDIRECT the same app is pointed at the clone, and that is recorded', async () => {
    const port = await freePort();
    const traceDir = path.join(dir, 'trace-b');
    const r = await capture({ cmd: [process.execPath, 'app.mjs'], cwd: dir, traceDir, env: { APP_OWN_DB: src, PORT: String(port), SQL_ANYTHING_PG_REDIRECT: dst }, hits: [`http://127.0.0.1:${port}/`], quiet: true });
    assert.equal(JSON.parse(r.hits[0].body).n, 2, 'the app answered from the clone (2 rows), although its own config says the source');
    const conns = readTrace(traceDir).conns;
    assert.ok(conns.length >= 1 && conns.every((c) => c.database === 'redir_dst' && c.redirected === true));
  });
});
