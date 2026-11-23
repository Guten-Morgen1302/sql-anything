import { normalize } from './normalize.js';

export type StmtKind = 'select' | 'write' | 'ddl' | 'txn' | 'other';

const TXN = /^(begin|commit|rollback|savepoint|release|start transaction|end|abort)\b/;

/** Transaction control and driver health checks. Dropped from scan and replay. */
export function isNoise(sql: string): boolean {
  const s = normalize(sql);
  if (TXN.test(s)) return true;
  if (s === 'select ?' || s === 'select ? as ?') return true; // SELECT 1 health check
  if (/^select version\(\)$/.test(s)) return true;
  if (/^(set|reset|show|discard|deallocate|listen|unlisten)\b/.test(s)) return true;
  return false;
}

export function kindOf(sql: string): StmtKind {
  const s = normalize(sql);
  const first = /^\(?\s*([a-z]+)/.exec(s)?.[1] ?? '';
  if (TXN.test(s)) return 'txn';
  if (first === 'select' || first === 'values' || first === 'table') return 'select';
  if (first === 'with') return /\b(insert into|update [a-z"_]|delete from)/.test(s) ? 'write' : 'select';
  if (first === 'insert' || first === 'update' || first === 'delete' || first === 'replace' || first === 'merge') return 'write';
  if (first === 'create' || first === 'drop' || first === 'alter' || first === 'truncate') return 'ddl';
  return 'other';
}

/** Functions whose value depends on time, randomness or sequence state: a replay can't be compared row for row. */
const VOLATILE: RegExp[] = [
  /\b(now|random|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|gen_random_uuid|uuid_generate_v\d\w*|nextval|setval|lastval|txid_current|randomblob|randomzeroblob|last_insert_rowid|changes|total_changes|pg_current_xact_id|random_normal)\s*\(/i,
  /\b(current_timestamp|current_date|current_time|localtime|localtimestamp)\b/i,
  /\b(date|time|datetime|julianday|unixepoch|strftime)\s*\([^)]*'now'/i,
];

export function isVolatile(sql: string): boolean {
  const noComments = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  // strip string literals, except the 'now' argument that the third pattern looks for
  const stripped = noComments.replace(/'(?:[^']|'')*'/g, (m) => (/^'now'$/i.test(m) ? m : "''"));
  return VOLATILE.some((r) => r.test(stripped));
}

/** Top-level (paren depth 0) ORDER BY / LIMIT detection on the normalized text. */
export function topLevel(sql: string): { orderBy: boolean; limit: boolean } {
  const s = normalize(sql);
  let depth = 0;
  let orderBy = false;
  let limit = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /[a-z]/.test(c) && (i === 0 || !/[a-z0-9_]/.test(s[i - 1]))) {
      if (s.startsWith('order by', i)) orderBy = true;
      else if (/^(limit|fetch first|fetch next|top)\b/.test(s.slice(i, i + 12))) limit = true;
    }
  }
  return { orderBy, limit };
}

/**
 * Queries about the schema itself (ORM start-up introspection, `\d`-style lookups). After any DDL they legitimately return
 * different rows, so they cannot be compared before and after a migration, and they are not application hot spots.
 */
export function isIntrospection(sql: string): boolean {
  return /\b(information_schema\.|pg_catalog\.|pg_class\b|pg_index\b|pg_indexes\b|pg_constraint\b|pg_attribute\b|pg_namespace\b|pg_tables\b|pg_type\b|pg_get_\w+\(|sqlite_master\b|sqlite_schema\b|sqlite_temp_master\b|pragma_\w+)/i.test(sql);
}
