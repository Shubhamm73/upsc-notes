import { getMeta, setMeta } from '../db';
import { addDays, ymd } from './dates';

/** Streak lengths that get a quiet moment, once per streak. */
export const MILESTONES = [7, 30, 100];

/** What logging a review did: whether it added today, and the 7/30/100 milestone it reached (shown once per streak). */
export interface LoggedDay {
  added: string | null;
  milestone: number | null;
}

/** Records that something was reviewed today (feeds the streak). */
export async function logReviewDay(): Promise<LoggedDay> {
  const days = await getMeta<string[]>('reviewDays', []);
  const today = ymd();
  if (days.includes(today)) return { added: null, milestone: null };
  await setMeta('reviewDays', [...days, today].sort().slice(-400));
  const { days: n } = await currentStreak();
  if (!MILESTONES.includes(n)) return { added: today, milestone: null };
  const start = addDays(today, -(n - 1));
  const prev = await getMeta<{ start: string; shown: number[] } | null>('streakMilestones', null);
  const shown = prev?.start === start ? prev.shown : [];
  if (shown.includes(n)) return { added: today, milestone: null };
  await setMeta('streakMilestones', { start, shown: [...shown, n] });
  return { added: today, milestone: n };
}

/** Takes back what logReviewDay did (Undo of the day's only rating). */
export async function unlogReviewDay(day: LoggedDay) {
  if (!day.added) return;
  const days = await getMeta<string[]>('reviewDays', []);
  await setMeta('reviewDays', days.filter((d) => d !== day.added));
  if (day.milestone) {
    const prev = await getMeta<{ start: string; shown: number[] } | null>('streakMilestones', null);
    if (prev) await setMeta('streakMilestones', { ...prev, shown: prev.shown.filter((m) => m !== day.milestone) });
  }
}

export function milestoneText(n: number): string {
  return n >= 100
    ? '100 days in a row. That is real discipline.'
    : n >= 30
      ? '30 days in a row. A month of steady revision.'
      : '7 days in a row. A full week of reviews.';
}

/**
 * Days in a row with at least one review. A streak stays alive through today
 * until midnight, so a streak counted up to yesterday is still shown.
 */
export async function currentStreak(): Promise<{ days: number; reviewedToday: boolean }> {
  const set = new Set(await getMeta<string[]>('reviewDays', []));
  const today = ymd();
  const reviewedToday = set.has(today);
  let cursor = reviewedToday ? today : addDays(today, -1);
  let n = 0;
  while (set.has(cursor)) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return { days: n, reviewedToday };
}

export const setLastNote = (id: string) => setMeta('lastNoteId', id);
export const getLastNote = () => getMeta<string | null>('lastNoteId', null);
