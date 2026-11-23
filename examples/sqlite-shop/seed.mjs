// Synthetic data for the sqlite-shop example. Deterministic: the same seed always produces the same database.
// Zero dependencies: node:sqlite only.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const FIRST = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Ivy', 'Lucas', 'Nora', 'Owen', 'Ruby', 'Leo', 'Maya', 'Finn', 'Cleo', 'Jude', 'Iris', 'Theo', 'Luna', 'Kai'];
const LAST = ['Reyes', 'Nakamura', 'Okafor', 'Silva', 'Haddad', 'Novak', 'Larsen', 'Moreau', 'Patel', 'Kowalski', 'Tanaka', 'Rossi', 'Brandt', 'Mensah', 'Lindqvist'];
const CATEGORY = ['books', 'kitchen', 'garden', 'toys', 'audio', 'outdoors', 'office', 'pets'];
const STATUS = ['paid', 'paid', 'paid', 'shipped', 'shipped', 'delivered', 'delivered', 'delivered', 'refunded', 'cancelled'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(file, { orders = 100_000, customers = 2000, products = 500, regions = 50 } = {}) {
  fs.rmSync(file, { force: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = off; pragma synchronous = off;
    create table customers (id integer primary key, name text not null, email text not null, region text not null, created_at text not null);
    create table products (id integer primary key, name text not null, category text not null, price_cents integer not null);
    create table orders (id integer primary key, customer_id integer not null, status text not null, total_cents integer not null, created_at text not null);
    create table order_items (id integer primary key, order_id integer not null, product_id integer not null, qty integer not null, price_cents integer not null);
  `);
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  db.exec('begin');
  const ic = db.prepare('insert into customers values (?, ?, ?, ?, ?)');
  for (let i = 1; i <= customers; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    ic.run(i, name, `${name.toLowerCase().replace(/\W+/g, '.')}.${i}@example.com`, `r${String((i % regions) + 1).padStart(2, '0')}`, `2023-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`);
  }
  const ip = db.prepare('insert into products values (?, ?, ?, ?)');
  const prices = [];
  for (let i = 1; i <= products; i++) {
    const price = 300 + Math.floor(r() * 19700);
    prices.push(price);
    ip.run(i, `${pick(['Classic', 'Pro', 'Mini', 'Eco', 'Deluxe'])} ${pick(CATEGORY)} item ${i}`, pick(CATEGORY), price);
  }
  const io = db.prepare('insert into orders values (?, ?, ?, ?, ?)');
  const it = db.prepare('insert into order_items values (?, ?, ?, ?, ?)');
  let item = 1;
  for (let i = 1; i <= orders; i++) {
    const n = 1 + Math.floor(r() * 3);
    let total = 0;
    for (let k = 0; k < n; k++) {
      const p = 1 + Math.floor(r() * products);
      const qty = 1 + Math.floor(r() * 3);
      total += prices[p - 1] * qty;
      it.run(item++, i, p, qty, prices[p - 1]);
    }
    io.run(i, 1 + Math.floor(r() * customers), pick(STATUS), total, `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`);
  }
  db.exec('commit');
  const counts = Object.fromEntries(['customers', 'products', 'orders', 'order_items'].map((t) => [t, Number(db.prepare(`select count(*) c from ${t}`).get().c)]));
  db.close();
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'shop.db';
  const t0 = Date.now();
  const c = await seed(file, { orders: Number(process.env.ORDERS ?? 100_000) });
  console.log(`seeded ${file} in ${Date.now() - t0} ms:`, c);
}
