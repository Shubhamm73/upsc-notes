/** Local calendar date as YYYY-MM-DD (not UTC, so "today" matches the tablet's clock). */
export function ymd(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}

export function prettyDate(date: string): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function daysSince(ts: number | null): number | null {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / 86_400_000);
}

/** Spaced-review intervals in days, indexed by how many reviews are done. */
export const REVIEW_INTERVALS = [1, 3, 7, 16, 35];

export function nextReviewAfter(reviewCount: number, today = ymd()): string {
  const i = Math.min(Math.max(reviewCount - 1, 0), REVIEW_INTERVALS.length - 1);
  return addDays(today, REVIEW_INTERVALS[i]);
}
