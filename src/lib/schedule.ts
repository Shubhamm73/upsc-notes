import { addDays, REVIEW_INTERVALS, ymd } from './dates';

/** How a card went: Again = forgot (back later today), Hard = keep the interval, Easy = next interval. */
export type Rating = 'again' | 'hard' | 'easy';
export const LAST_STEP = REVIEW_INTERVALS.length - 1;

interface Steppable {
  reviewStep?: number;
  reviewCount: number;
}

/**
 * The interval step of a note or word's last review: an index into REVIEW_INTERVALS, -1 = never.
 * Records from before 0.8 have no reviewStep; their reviewCount set the interval, so it is read from that.
 */
export function stepOf(r: Steppable): number {
  if (typeof r.reviewStep === 'number') return r.reviewStep;
  return r.reviewCount > 0 ? Math.min(r.reviewCount - 1, LAST_STEP) : -1;
}

/**
 * The step and due date a rating gives. Again keeps the item due today and drops it to the first
 * interval (an item never reviewed stays never reviewed, so forgetting it never lengthens its first gap).
 */
export function nextAfter(step: number, rating: Rating, today = ymd()): { step: number; due: string; days: number } {
  if (rating === 'again') return { step: Math.min(step, 0), due: today, days: 0 };
  const s = rating === 'easy' ? Math.min(step + 1, LAST_STEP) : Math.min(Math.max(step, 0), LAST_STEP);
  const days = REVIEW_INTERVALS[s];
  return { step: s, due: addDays(today, days), days };
}

/** "later today", "tomorrow", "in 3 days" for a rating button. */
export function whenLabel(step: number, rating: Rating): string {
  const { days } = nextAfter(step, rating);
  return days === 0 ? 'later today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

/**
 * Applies a rating to a note or word in place (review fields only; the caller saves it).
 * Hard and Easy add to reviewCount ("reviewed N times"); Again only brings the item back today.
 * (Every rating still counts for the streak: see rateItem.)
 */
export function rateRecord(r: Steppable & { nextReview: string; lastReviewed?: number | null }, rating: Rating, now = Date.now()) {
  const next = nextAfter(stepOf(r), rating);
  r.reviewStep = next.step;
  r.nextReview = next.due;
  if (rating !== 'again') {
    r.reviewCount += 1;
    r.lastReviewed = now;
  }
}
