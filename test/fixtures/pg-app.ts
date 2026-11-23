/* eslint-disable @typescript-eslint/no-explicit-any */
// Fixture: Express-less N+1 over pg with an unindexed filter and a Date parameter.
import http from 'node:http';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

http
  .createServer(async (req, res) => {
    try {
      const cs = await pool.query('select id from customers where region = $1 order by id', ['r1']);
      const out: unknown[] = [];
      for (const c of cs.rows) {
        const n = await pool.query('select count(*) as c from orders where customer_id = $1', [c.id]);
        out.push({ id: c.id, orders: Number(n.rows[0].c) });
      }
      await pool.query('select $1::timestamptz as d, $2::bigint as b', [new Date('2026-11-23T10:00:00.123Z'), 9007199254740993n]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    } catch (e: any) {
      res.statusCode = 500;
      res.end(String(e.message));
    }
  })
  .listen(Number(process.env.PORT), '127.0.0.1');
