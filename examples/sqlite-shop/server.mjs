// sqlite-shop: a deliberately slow, SYNTHETIC little shop API. Zero dependencies (node:sqlite).
//   GET /api/regions/:region/leaderboard   customers of a region with their order totals   (N+1 loop, unindexed filter)
//   GET /api/customers/:id/orders?status=  one customer's orders in a status               (unindexed multi-column filter)
//   GET /api/health
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.SQL_ANYTHING_DB_URL ?? process.env.DB_PATH ?? 'shop.db');

// @n1-begin
function leaderboard(region) {
  const customers = db.prepare('select id, name from customers where region = ? order by id').all(region);
  return customers.map((c) => {
    // one query per customer: the N+1. orders.customer_id has no index, so each one also scans the whole table.
    const s = db.prepare('select count(*) as orders, coalesce(sum(total_cents), 0) as spent from orders where customer_id = ?').get(c.id);
    return { id: Number(c.id), name: c.name, orders: Number(s.orders), spentCents: Number(s.spent) };
  });
}
// @n1-end

function customerOrders(id, status) {
  return db
    .prepare('select id, status, total_cents from orders where customer_id = ? and status = ? order by id desc limit 20')
    .all(id, status)
    .map((o) => ({ id: Number(o.id), status: o.status, totalCents: Number(o.total_cents) }));
}

function route(url) {
  const u = new URL(url, 'http://x');
  let m;
  if ((m = /^\/api\/regions\/([\w-]+)\/leaderboard$/.exec(u.pathname))) return leaderboard(m[1]);
  if ((m = /^\/api\/customers\/(\d+)\/orders$/.exec(u.pathname))) return customerOrders(Number(m[1]), u.searchParams.get('status') ?? 'paid');
  if (u.pathname === '/api/health') return { ok: true };
  return undefined;
}

if (process.argv[2] === 'once') {
  console.log(JSON.stringify(route(process.argv[3])));
} else {
  http
    .createServer((req, res) => {
      const body = route(req.url ?? '/');
      res.statusCode = body === undefined ? 404 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body ?? { error: 'not found' }));
    })
    .listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.error(`sqlite-shop listening on :${process.env.PORT ?? 3000}`));
}
