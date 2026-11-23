// A recorded, deterministic "agent" for the demo: it applies the known eager-loading fix for sqlite-shop's N+1.
// It reads the prompt on stdin like a real headless agent and ignores it. No LLM is involved. The change it makes
// still has to pass the same verification gate as anything an LLM writes.
import fs from 'node:fs';

for await (const _ of process.stdin); // drain the prompt

const FIXED = `// @n1-begin
function leaderboard(region) {
  // one grouped query instead of one query per customer
  return db
    .prepare('select c.id as id, c.name as name, count(o.id) as orders, coalesce(sum(o.total_cents), 0) as spent from customers c left join orders o on o.customer_id = c.id where c.region = ? group by c.id order by c.id')
    .all(region)
    .map((r) => ({ id: Number(r.id), name: r.name, orders: Number(r.orders), spentCents: Number(r.spent) }));
}
// @n1-end`;

const src = fs.readFileSync('server.mjs', 'utf8');
const next = src.replace(/\/\/ @n1-begin[\s\S]*?\/\/ @n1-end/, () => FIXED);
if (next === src) {
  console.error('reference-agent: the @n1 markers were not found in server.mjs');
  process.exit(1);
}
fs.writeFileSync('server.mjs', next);
