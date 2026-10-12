import { getMeta, setMeta } from '../db';
import { addDays, ymd } from './dates';

/** Records that something was reviewed today (feeds the streak). */
export async function logReviewDay() {
  const days = await getMeta<string[]>('reviewDays', []);
  const today = ymd();
  if (days[days.length - 1] === today) return;
  await setMeta('reviewDays', [...days.filter((d) => d !== today), today].slice(-400));
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
