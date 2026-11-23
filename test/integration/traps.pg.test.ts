import { after, before } from 'node:test';
import type { DbTarget } from '../../src/db/conn.js';
import { seedPg, startPg } from '../helpers.js';
import { defineTraps } from './traps.js';

let server: Awaited<ReturnType<typeof startPg>>;
let plain: DbTarget;
let indexed: DbTarget;
before(async () => {
  server = await startPg();
  plain = await seedPg(await server.createDb('trap_plain'));
  indexed = await seedPg(await server.createDb('trap_indexed'), { indexed: true });
}, { timeout: 120_000 });
after(async () => {
  await server?.stop();
});

defineTraps('postgres', { kind: 'pg', plain: () => plain, indexed: () => indexed });
