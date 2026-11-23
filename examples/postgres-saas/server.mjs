// postgres-saas: a deliberately slow, SYNTHETIC multi-tenant API on Postgres with the three classic bottlenecks.
//   GET /api/tenants/:id/projects   N+1:                a task count per project in a driver loop
//   GET /api/tenants/:id/overdue    unindexed join:     tasks x projects x users, filtered on unindexed columns
//   GET /api/tenants/:id/dashboard  correlated subquery: a comment count re-computed for every project row
import http from 'node:http';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://saas:saas@localhost:54330/saas', max: 4 });

// @n1-begin
async function projects(tenant) {
  const ps = (await pool.query('select id, name from projects where tenant_id = $1 and not archived order by id', [tenant])).rows;
  const out = [];
  for (const p of ps) {
    // one query per project: the N+1
    const n = (await pool.query("select count(*) as open_tasks from tasks where project_id = $1 and status = 'open'", [p.id])).rows[0];
    out.push({ id: p.id, name: p.name, openTasks: Number(n.open_tasks) });
  }
  return out;
}
// @n1-end

async function overdue(tenant) {
  return (
    await pool.query(
      `select t.id, t.title, u.name as assignee, p.name as project
         from tasks t
         join projects p on p.id = t.project_id
         join users u on u.id = t.assignee_id
        where t.status = 'open' and t.due_date < $2::date and p.tenant_id = $1
        order by t.due_date, t.id
        limit 50`,
      [tenant, '2025-06-01'],
    )
  ).rows;
}

async function dashboard(tenant) {
  return (
    await pool.query(
      `select p.id, p.name,
              (select count(*) from comments c join tasks t on t.id = c.task_id where t.project_id = p.id) as comment_count
         from projects p
        where p.tenant_id = $1
        order by p.id`,
      [tenant],
    )
  ).rows.map((r) => ({ id: r.id, name: r.name, commentCount: Number(r.comment_count) }));
}

http
  .createServer(async (req, res) => {
    try {
      const m = /^\/api\/tenants\/(\d+)\/(projects|overdue|dashboard)$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
      if (!m) {
        res.statusCode = 404;
        return res.end('{"error":"not found"}');
      }
      const t = Number(m[1]);
      const body = m[2] === 'projects' ? await projects(t) : m[2] === 'overdue' ? await overdue(t) : await dashboard(t);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message) }));
    }
  })
  .listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.error(`postgres-saas listening on :${process.env.PORT ?? 3000}`));
