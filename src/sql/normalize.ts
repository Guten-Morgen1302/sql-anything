import { createHash } from 'node:crypto';

/**
 * Tokenizer-based normalizer. Strips comments, replaces literals and every placeholder style ($1, ?, :n, @n)
 * with `?`, collapses IN/VALUES lists, lowercases keywords. No native dependency, same result for pg and sqlite.
 */
export function normalize(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  const isIdStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
  const isIdPart = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);
  const push = (s: string) => out.push(s);
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      if (out.length && out[out.length - 1] !== ' ') push(' ');
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      if (out.length && out[out.length - 1] !== ' ') push(' ');
    } else if (c === "'") {
      // E'..' strings allow backslash escapes. Drop the E/N/B/X prefix letter we already emitted.
      const prev = out[out.length - 1];
      const escStr = prev !== undefined && /^[eE]$/.test(prev);
      if (prev !== undefined && /^[eEnNbBxX]$/.test(prev)) out.pop();
      i++;
      while (i < n) {
        if (escStr && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      push('?');
    } else if (c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      push(sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$(\d+)/.exec(sql.slice(i, i + 12));
      const dq = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        push('?');
        i += m[0].length;
      } else if (dq) {
        const tag = dq[0];
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? n : e + tag.length;
        push('?');
      } else {
        push(c);
        i++;
      }
    } else if (c === '?') {
      push('?');
      i++;
    } else if ((c === ':' || c === '@') && isIdStart(sql[i + 1] ?? '') && sql[i - 1] !== c && sql[i + 1] !== c) {
      let j = i + 1;
      while (j < n && isIdPart(sql[j])) j++;
      push('?');
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && /[xX]/.test(sql[i + 1] ?? '')) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(sql[j])) j++;
      } else {
        while (j < n && /[0-9._]/.test(sql[j])) j++;
        if (/[eE]/.test(sql[j] ?? '') && /[0-9+-]/.test(sql[j + 1] ?? '')) {
          j += 2;
          while (j < n && /[0-9]/.test(sql[j])) j++;
        }
      }
      push('?');
      i = j;
    } else if (isIdStart(c)) {
      let j = i;
      while (j < n && isIdPart(sql[j])) j++;
      push(sql.slice(i, j).toLowerCase());
      i = j;
    } else {
      push(c);
      i++;
    }
  }
  let s = out.join('').trim();
  s = s.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)'); // IN (?, ?, ?) and one VALUES row
  s = s.replace(/\(\?\)(?:\s*,\s*\(\?\))+/g, '(?)'); // multi-row VALUES
  s = s.replace(/\s*;+\s*$/, '').replace(/\s+/g, ' ');
  return s;
}

export function fingerprint(sql: string): string {
  return createHash('sha1').update(normalize(sql)).digest('hex').slice(0, 12);
}
