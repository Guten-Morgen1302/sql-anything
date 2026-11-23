/* eslint-disable @typescript-eslint/no-explicit-any */
// Fixture app. VARIANT is rewritten by the tests when they copy this file into a "checkout".
//   N1     : the classic ORM loop, one COUNT per customer
//   FIXED  : one grouped LEFT JOIN, same output
//   BROKEN : "optimized" with an INNER JOIN, which silently drops customers with no orders
import http from 'node:http';
import Database from 'better-sqlite3';

const VARIANT: string = 'N1';
const db = new Database(process.env.SQL_ANYTHING_DB_URL!);
db.exec('begin');
db.exec('commit'); // transaction noise that scan must ignore

function customers(region = 'r1'): unknown[] {
  if (VARIANT === 'N1') {
    const ids = db.prepare('select id from customers where region = ? order by id').all(region) as { id: number }[];
    return ids.map((c) => ({ id: c.id, orders: (db.prepare('select count(*) as c from orders where customer_id = ?').get(c.id) as any).c }));
  }
  const join = VARIANT === 'BROKEN' ? 'join' : 'left join';
  return db.prepare(`select c.id as id, count(o.id) as orders from customers c ${join} orders o on o.customer_id = c.id where c.region = ? group by c.id order by c.id`).all(region);
}

const body = () => JSON.stringify({ generatedAt: Date.now(), customers: customers() });
// cmd-all: four regions per run, so SQL time dominates process start-up and a real N+1 win is measurable by wall time
const bodyAll = () => JSON.stringify({ generatedAt: Date.now(), regions: Array.from({ length: 4 }, (_, i) => customers('r' + (i + 1))) });

if (process.argv[2] === 'cmd') {
  console.log(body());
} else if (process.argv[2] === 'cmd-all') {
  console.log(bodyAll());
} else {
  http
    .createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(body());
    })
    .listen(Number(process.env.PORT), '127.0.0.1');
}
