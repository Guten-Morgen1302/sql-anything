export interface CardData {
  findingId: string;
  kind: string;
  callsite: string | null;
  sql: string;
  speedup: number;
  speedupLo: number;
  samples: number;
  before: { p50: number; p95: number };
  after: { p50: number; p95: number };
  planBefore?: string;
  planAfter?: string;
  queries?: { before: number; after: number };
  parity: { ok: number; total: number; what: 'replayed' | 'runs' };
  level: 'query' | 'endpoint';
  label?: string;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const fmtMs = (n: number) => (n >= 100 ? `${n.toFixed(0)} ms` : n >= 1 ? `${n.toFixed(1)} ms` : n >= 0.001 ? `${n.toFixed(2)} ms` : `${(n * 1000).toFixed(0)} µs`);
export const fmtX = (n: number) => (n >= 100 ? `${Math.round(n)}×` : n >= 10 ? `${n.toFixed(1)}×` : `${n.toFixed(2)}×`);

const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** Dark-mode 1200x630 card. Contains no parameter values and no absolute paths; every text node is escaped. */
export function renderCard(d: CardData): string {
  const W = 420; // bar track width
  const maxP50 = Math.max(d.before.p50, d.after.p50, 1e-9);
  const maxP95 = Math.max(d.before.p95, d.after.p95, 1e-9);
  const bar = (v: number, max: number) => Math.max(3, Math.round((v / max) * W));
  const badge = `${d.parity.ok}/${d.parity.total} ${d.parity.what} · ${d.level === 'endpoint' ? 'output parity' : 'row parity'}`;
  const badgeW = Math.round(badge.length * 11.6 + 64);
  const t = (x: number, y: number, size: number, fill: string, s: string, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
  const rows: string[] = [];
  const metric = (title: string, y: number, b: number, a: number, max: number) => {
    rows.push(t(520, y, 18, '#8b949e', title));
    rows.push(`<rect x="520" y="${y + 12}" width="${bar(b, max)}" height="24" rx="5" fill="#6e7681"/>`, t(520 + W + 14, y + 30, 18, '#c9d1d9', `${fmtMs(b)} before`));
    rows.push(`<rect x="520" y="${y + 44}" width="${bar(a, max)}" height="24" rx="5" fill="#3fb950"/>`, t(520 + W + 14, y + 62, 18, '#3fb950', `${fmtMs(a)} after`));
  };
  metric('p50 latency', 128, d.before.p50, d.after.p50, maxP50);
  metric('p95 latency', 238, d.before.p95, d.after.p95, maxP95);
  const lines: string[] = [];
  let y = 372;
  if (d.planBefore && d.planAfter) {
    lines.push(t(64, y, 18, '#8b949e', 'plan'), t(150, y, 18, '#f85149', cut(d.planBefore, 78)));
    lines.push(t(150, y + 28, 18, '#3fb950', '→ ' + cut(d.planAfter, 76)));
    y += 64;
  }
  if (d.queries) {
    lines.push(t(64, y, 18, '#8b949e', 'queries'), t(150, y, 18, '#c9d1d9', `${d.queries.before} → ${d.queries.after} per run`));
    y += 36;
  }
  if (d.callsite) {
    lines.push(t(64, y, 18, '#8b949e', 'where'), t(150, y, 18, '#c9d1d9', cut(d.callsite, 80)));
    y += 36;
  }
  lines.push(t(64, y, 16, '#6e7681', cut(d.sql, 112)));
  const ariaLabel = `${d.findingId} ${d.kind}: ${fmtX(d.speedup)} faster`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(ariaLabel)}" font-family="${esc(MONO)}">
<rect width="1200" height="630" fill="#0d1117"/>
<rect x="24" y="24" width="1152" height="582" rx="20" fill="#161b22" stroke="#30363d"/>
${t(64, 84, 26, '#c9d1d9', 'sql-anything', 'font-weight="700"')}
${t(1136, 84, 22, '#8b949e', `${d.findingId} · ${d.kind}`, 'text-anchor="end"')}
${d.label ? t(1136, 112, 16, '#d29922', d.label, 'text-anchor="end"') : ''}
${t(64, 232, 128, '#3fb950', fmtX(d.speedup), 'font-weight="700"')}
${t(64, 276, 24, '#c9d1d9', d.level === 'endpoint' ? 'faster · endpoint wall time' : 'faster · median query time')}
${t(64, 306, 16, '#8b949e', `95% CI lower bound ${fmtX(d.speedupLo)} · n=${d.samples}`)}
${rows.join('\n')}
${lines.join('\n')}
<rect x="64" y="534" width="${badgeW}" height="40" rx="20" fill="#1f6f43"/>
<path d="M82 554 l6 6 l12 -13" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
${t(112, 560, 20, '#ffffff', badge, 'font-weight="700"')}
${t(64, 598, 13, '#6e7681', 'replay-verified on captured inputs against one data snapshot. Evidence, not proof: production data and plans can differ. Timings include capture overhead.')}
</svg>
`;
}
