// Synthetic multi-tenant SaaS data for the postgres-saas example. Everything is generated inside Postgres with
// generate_series, deterministic (setseed), 100k+ rows by default. SEED_SCALE=0.1 makes it 10x smaller for tests.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

export async function seed(url, scale = Number(process.env.SEED_SCALE ?? 1)) {
  const n = (x) => Math.max(1, Math.round(x * scale));
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      drop table if exists comments, tasks, projects, users, tenants cascade;
      create table tenants  (id integer primary key, name text not null);
      create table users    (id integer primary key, tenant_id integer not null, name text not null, email text not null);
      create table projects (id integer primary key, tenant_id integer not null, name text not null, archived boolean not null default false);
      create table tasks    (id integer primary key, project_id integer not null, assignee_id integer not null, title text not null,
                             status text not null, due_date date not null, created_at timestamptz not null);
      create table comments (id integer primary key, task_id integer not null, author_id integer not null, body text not null, created_at timestamptz not null);
      select setseed(0.42);
    `);
    const T = n(20);
    const U = n(2000);
    const P = n(2000);
    const K = n(120000);
    const M = n(200000);
    await c.query(`insert into tenants select i, 'Tenant ' || i from generate_series(1, ${T}) i`);
    await c.query(`insert into users select i, 1 + (i % ${T}), 'User ' || i, 'user' || i || '@example.com' from generate_series(1, ${U}) i`);
    await c.query(`insert into projects select i, 1 + (i % ${T}), 'Project ' || i, (i % 17 = 0) from generate_series(1, ${P}) i`);
    await c.query(`insert into tasks select i, 1 + (i % ${P}), 1 + ((i * 7) % ${U}),
        'Task ' || i, (array['open','open','in_progress','done','done','blocked'])[1 + (i % 6)],
        date '2025-01-01' + ((i * 13) % 700), timestamptz '2024-01-01' + (i || ' minutes')::interval
      from generate_series(1, ${K}) i`);
    await c.query(`insert into comments select i, 1 + ((i * 11) % ${K}), 1 + ((i * 3) % ${U}), 'comment ' || i, timestamptz '2024-06-01' + (i || ' minutes')::interval from generate_series(1, ${M}) i`);
    await c.query('analyze');
    const out = {};
    for (const t of ['tenants', 'users', 'projects', 'tasks', 'comments']) out[t] = Number((await c.query(`select count(*) from ${t}`)).rows[0].count);
    return out;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { databaseUrl } = await import('./db.mjs');
  const t0 = Date.now();
  const counts = await seed(databaseUrl());
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`, counts);
}
