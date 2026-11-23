import path from 'node:path';
import { after, before } from 'node:test';
import fs from 'node:fs';
import type { DbTarget } from '../../src/db/conn.js';
import { seedSqlite, tmpDir } from '../helpers.js';
import { defineTraps } from './traps.js';

let plain: DbTarget;
let indexed: DbTarget;
let dir: string;
before(async () => {
  dir = tmpDir();
  plain = await seedSqlite(path.join(dir, 'plain.db'));
  indexed = await seedSqlite(path.join(dir, 'indexed.db'), { indexed: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

defineTraps('sqlite', { kind: 'sqlite', plain: () => plain, indexed: () => indexed });
