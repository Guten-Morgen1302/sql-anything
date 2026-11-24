// Where this example connects. No password is stored in the repository: `npm run setup` generates a random one into a
// git-ignored `.env`, and Docker Compose reads the same file. You can also bring your own database with DATABASE_URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = path.join(dir, '.env');

export function readPassword() {
  if (!fs.existsSync(ENV_FILE)) return undefined;
  return /^SAAS_DB_PASSWORD=(.+)$/m.exec(fs.readFileSync(ENV_FILE, 'utf8'))?.[1].trim();
}

export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const pw = readPassword();
  if (!pw) throw new Error('no database configured: set DATABASE_URL, or run `npm run setup` (it generates a local password into .env)');
  return `postgres://saas:${encodeURIComponent(pw)}@127.0.0.1:54330/saas`;
}

// `node db.mjs` prints the URL, so you can pass it on: --db "$(node db.mjs)"
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(databaseUrl());
