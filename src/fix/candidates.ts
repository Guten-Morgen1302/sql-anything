import { createHash } from 'node:crypto';
import { normalize } from '../sql/normalize.js';

export interface IndexCandidate {
  table: string;
  columns: string[];
  name: string;
  /** what verify applies to the clone */
  verifySql: string;
  /** what the user runs: online-safe on Postgres */
  migrationSql: (kind: 'sqlite' | 'pg') => string;
  downSql: string;
  reason: string;
}

const STOP = new Set(['on', 'where', 'join', 'left', 'right', 'inner', 'cross', 'full', 'outer', 'group', 'order', 'limit', 'using', 'natural', 'offset', 'union', 'having', 'window', 'except', 'intersect', 'set', 'returning', 'lateral']);
const unq = (s: string) => s.replace(/^"|"$/g, '');
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface Pred {
  table: string;
  col: string;
  kind: 'eq' | 'range';
}

/**
 * Deterministic index candidates from the SQL text: equality columns first (in the order the query filters on them),
 * then at most one range column. No LLM involved. verify decides whether a candidate is actually worth it.
 */
export function indexCandidates(sql: string, scannedTable?: string): IndexCandidate[] {
  const s = normalize(sql);
  if (!/^(select|with|\()/.test(s)) return [];
  const alias = new Map<string, string>(); // alias or table name -> table
  const tables: string[] = [];
  for (const m of s.matchAll(/\b(?:from|join)\s+("[^"]+"|[\w.]+)(?:\s+(?:as\s+)?("[^"]+"|\w+))?/g)) {
    const table = unq(m[1].split('.').pop()!);
    if (table === '(' || table === 'select') continue;
    tables.push(table);
    alias.set(table, table);
    const a = m[2] ? unq(m[2]) : '';
    if (a && !STOP.has(a)) alias.set(a, table);
  }
  const only = new Set(tables);
  const preds: Pred[] = [];
  const re = /(?:("[^"]+"|\w+)\.)?("[^"]+"|\w+)\s*(<=|>=|<>|!=|=|<|>|\blike\b|\bin\b|\bbetween\b)\s*(\?|\(\?\)|(?:"[^"]+"|\w+)\.(?:"[^"]+"|\w+))/g;
  for (const m of s.matchAll(re)) {
    const col = unq(m[2]);
    if (STOP.has(col) || col === '?') continue;
    let table = m[1] ? alias.get(unq(m[1])) : only.size === 1 ? [...only][0] : undefined;
    if (!table) continue;
    const op = m[3];
    const kind: Pred['kind'] = op === '=' || op === 'in' ? 'eq' : 'range';
    if (op === 'like' && !/^\?$/.test(m[4])) continue;
    table = unq(table);
    preds.push({ table, col, kind });
  }
  // ORDER BY at any depth (an ORM's `... FROM t ORDER BY created_at DESC LIMIT n` subquery): the first sort column of a
  // single known table can be served by an index, which turns "scan everything, sort, take 50" into "walk the index".
  const orderBy = new Map<string, string>(); // table -> first sort column
  for (const m of s.matchAll(/\border by\s+(?:("[^"]+"|\w+)\.)?("[^"]+"|\w+)(?:\s+(?:asc|desc))?/g)) {
    const col = unq(m[2]);
    if (col === '?' || STOP.has(col)) continue;
    const table = m[1] ? alias.get(unq(m[1])) : only.size === 1 ? [...only][0] : undefined;
    if (table && !orderBy.has(unq(table))) orderBy.set(unq(table), col);
  }
  const out: IndexCandidate[] = [];
  for (const table of new Set([...preds.map((p) => p.table), ...orderBy.keys()])) {
    if (scannedTable && table.toLowerCase() !== scannedTable.toLowerCase()) continue;
    const mine = preds.filter((p) => p.table === table);
    const eq = [...new Set(mine.filter((p) => p.kind === 'eq').map((p) => p.col))];
    const range = [...new Set(mine.filter((p) => p.kind === 'range').map((p) => p.col))].filter((c) => !eq.includes(c));
    const sortCol = orderBy.get(table);
    // equality columns, then the sort column (so rows come out already ordered), else one range column
    const tail = sortCol && !eq.includes(sortCol) ? [sortCol] : range.slice(0, 1);
    const cols = [...eq, ...tail].slice(0, 3);
    if (!cols.length || (cols.length === 1 && cols[0] === 'id')) continue; // `id` is almost always the primary key already
    out.push(make(table, cols));
  }
  return out;
}

function make(table: string, cols: string[]): IndexCandidate {
  let name = `idx_${table}_${cols.join('_')}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (name.length > 60) name = name.slice(0, 50) + '_' + createHash('sha1').update(name).digest('hex').slice(0, 8);
  const colList = cols.map(ident).join(', ');
  return {
    table,
    columns: cols,
    name,
    verifySql: `CREATE INDEX ${ident(name)} ON ${ident(table)} (${colList})`,
    migrationSql: (kind) => (kind === 'pg' ? `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(name)} ON ${ident(table)} (${colList});` : `CREATE INDEX IF NOT EXISTS ${ident(name)} ON ${ident(table)} (${colList});`),
    downSql: `DROP INDEX IF EXISTS ${ident(name)};`,
    reason: `${cols.length === 1 ? 'column' : 'columns'} ${cols.join(', ')} of ${table} are what the query filters on`,
  };
}
