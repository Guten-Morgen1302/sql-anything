/* eslint-disable @typescript-eslint/no-explicit-any */
// Fixture: exercises every patched driver and reports what the hook did to the process. Run under --import hook.
import { createRequire } from 'node:module';
import { Worker, isMainThread } from 'node:worker_threads';

const require = createRequire(import.meta.url);

if (isMainThread) {
  const { DatabaseSync } = await import('node:sqlite');
  const Database = require('better-sqlite3');
  const pgMod = require('pg');
  const n = new DatabaseSync(':memory:');
  n.exec('create table t (id integer primary key, v blob, big integer)');
  n.prepare('insert into t values (?, ?, ?)').run(1, Buffer.from([1, 2, 3]), 9007199254740993n);
  const row = n.prepare('select id, v from t where id = ?').get(1);
  const b = new Database(':memory:');
  b.exec('create table u (id integer primary key, name text)');
  b.prepare('insert into u values (?, ?)').run(1, 'ann');
  const got = b.prepare('select * from u where id = ?').get(1);
  let threw = '';
  try {
    b.prepare('insert into u values (?, ?)').run(1, 'dup'); // errors must still reach the app unchanged
  } catch (e: any) {
    threw = e.message;
  }
  await new Promise<void>((resolve) => {
    const w = new Worker(new URL(import.meta.url)); // the hook must follow into worker threads
    w.on('exit', () => resolve());
  });
  console.log(
    JSON.stringify({
      nodeSqlitePatched: !!(DatabaseSync.prototype as any).__sa,
      pgPatched: !!pgMod.Client.prototype.__sa,
      stackTraceLimit: Error.stackTraceLimit,
      rowId: Number((row as any).id),
      got,
      threw,
    }),
  );
} else {
  const { DatabaseSync } = await import('node:sqlite');
  new DatabaseSync(':memory:').prepare('select 42 as from_worker').get();
}
