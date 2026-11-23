export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export interface RatioCI {
  point: number;
  lo: number;
  hi: number;
  n: number;
}

/**
 * Paired bootstrap of median(a)/median(b). With a = baseline time and b = patched time the ratio is the speedup.
 * The gate uses the lower bound: 30 samples can't support a raw p95 threshold, a confidence bound can.
 */
export function bootstrapRatio(a: number[], b: number[], rng: () => number, iters = 400): RatioCI {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { point: NaN, lo: NaN, hi: NaN, n: 0 };
  const point = median(a.slice(0, n)) / median(b.slice(0, n));
  const ratios: number[] = [];
  const ra = new Array<number>(n);
  const rb = new Array<number>(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      ra[i] = a[j];
      rb[i] = b[j];
    }
    ratios.push(median(ra) / median(rb));
  }
  ratios.sort((x, y) => x - y);
  return { point, lo: ratios[Math.floor(0.025 * iters)], hi: ratios[Math.min(iters - 1, Math.floor(0.975 * iters))], n };
}
