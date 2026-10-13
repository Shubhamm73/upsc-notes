import { db, type Note, type ReviewCard, type Vocab } from '../db';
import { planCardSync } from './cards';
import { ymd } from './dates';
import { extractInsights } from './insights';
import { logReviewDay, unlogReviewDay } from './activity';
import { nextAfter, rateRecord, stepOf, type Rating } from './schedule';

/** Rough seconds per card, for "about 9 min". */
export const SECONDS = { insight: 15, word: 25, note: 120 } as const;
/** Most key lines and words in one session; the rest wait for "Keep going". Due notes are never capped. */
export const SESSION_LIMIT = 40;

export type ItemType = keyof typeof SECONDS;
export type QueueItem =
  | { type: 'insight'; id: string; card: ReviewCard; note: Note }
  | { type: 'word'; id: string; word: Vocab }
  | { type: 'note'; id: string; note: Note };
export type SessionFilter = 'all' | 'insights' | 'words' | 'notes';

export const dueOf = (it: QueueItem) => (it.type === 'insight' ? it.card.due : it.type === 'word' ? it.word.nextReview : it.note.nextReview);

/** Keeps a note's cards in step with its quick insights (after Mark reviewed, a note rating, or an import). */
export function syncNoteCards(note: Note, opts: { seed?: boolean } = {}) {
  return db.transaction('rw', db.cards, async () => {
    const existing = await db.cards.where('noteId').equals(note.id).toArray();
    const plan = planCardSync(note, note.insights?.items ?? [], existing, opts);
    if (plan.put.length) await db.cards.bulkPut(plan.put);
    return plan;
  });
}

/** Everything due today or earlier: live insight cards of live notes, words and notes. */
export function dueItems(notes: Note[], words: Vocab[], cards: ReviewCard[], today = ymd()): QueueItem[] {
  const live = new Map(notes.filter((n) => !n.deletedAt).map((n) => [n.id, n]));
  const out: QueueItem[] = [];
  for (const c of cards) {
    const note = live.get(c.noteId);
    if (note && !c.retiredAt && c.due <= today) out.push({ type: 'insight', id: c.id, card: c, note });
  }
  for (const w of words) if (!w.deletedAt && w.nextReview <= today) out.push({ type: 'word', id: w.id, word: w });
  for (const n of live.values()) if (n.nextReview <= today) out.push({ type: 'note', id: n.id, note: n });
  return out;
}

/** Everything due, plus all notes (for the subject rings), in one read. */
export async function loadDue(today = ymd()): Promise<{ items: QueueItem[]; notes: Note[] }> {
  const [notes, words, cards] = await db.transaction('r', db.notes, db.vocab, db.cards, () =>
    Promise.all([db.notes.toArray(), db.vocab.toArray(), db.cards.where('due').belowOrEqual(today).toArray()])
  );
  return { items: dueItems(notes, words, cards, today), notes };
}

const TYPE_ORDER: Record<ItemType, number> = { insight: 0, word: 1, note: 2 };
const posOf = (it: QueueItem) => (it.type === 'insight' ? it.card.pos : 0);
const byDue = (a: QueueItem, b: QueueItem) =>
  dueOf(a).localeCompare(dueOf(b)) ||
  TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
  (a.type === 'insight' && b.type === 'insight' ? a.note.id.localeCompare(b.note.id) || posOf(a) - posOf(b) : 0) ||
  a.id.localeCompare(b.id);

export function filterItems(items: QueueItem[], filter: SessionFilter): QueueItem[] {
  if (filter === 'all') return items;
  const t: ItemType = filter === 'insights' ? 'insight' : filter === 'words' ? 'word' : 'note';
  return items.filter((i) => i.type === t);
}

/**
 * A session: every due note, plus the SESSION_LIMIT most overdue key lines and words. Insight and
 * word cards alternate and whole notes come last (a note's key lines are tested before the note
 * shows the answers). `more` = key lines and words left for "Keep going".
 */
export function buildSession(items: QueueItem[], filter: SessionFilter = 'all', limit = SESSION_LIMIT): { queue: QueueItem[]; more: number } {
  const pool = filterItems(items, filter).sort(byDue);
  const quick = pool.filter((i) => i.type !== 'note');
  const chosen = quick.slice(0, limit);
  const ins = chosen.filter((i) => i.type === 'insight');
  const wds = chosen.filter((i) => i.type === 'word');
  const queue: QueueItem[] = [];
  for (let i = 0; i < Math.max(ins.length, wds.length); i++) {
    if (ins[i]) queue.push(ins[i]);
    if (wds[i]) queue.push(wds[i]);
  }
  queue.push(...pool.filter((i) => i.type === 'note'));
  return { queue, more: quick.length - chosen.length };
}

export const estimateSeconds = (items: QueueItem[]) => items.reduce((t, i) => t + SECONDS[i.type], 0);
export const minutesFor = (items: QueueItem[]) => Math.max(1, Math.round(estimateSeconds(items) / 60));

/** The step a rating starts from (for button labels). */
export function stepOfItem(it: QueueItem): number {
  if (it.type === 'insight') return it.card.step;
  return stepOf(it.type === 'word' ? it.word : it.note);
}

export interface RateResult {
  /** Puts back exactly what the rating changed. */
  undo: () => Promise<void>;
  /** 7, 30 or 100 when this review made the streak reach it (once per streak). */
  milestone: number | null;
}

/**
 * Applies a rating and saves it at once (so leaving mid-session loses nothing). The item's record is
 * updated in place, so a card that comes back after Again shows its new state.
 */
export async function rateItem(it: QueueItem, rating: Rating): Promise<RateResult> {
  const now = Date.now();
  let undo: () => Promise<void>;
  if (it.type === 'insight') {
    // Rate the stored card: a note rated earlier in this session may have re-synced it.
    const fresh = (await db.cards.get(it.card.id)) ?? it.card;
    const before = structuredClone(fresh);
    const c = structuredClone(fresh);
    const next = nextAfter(c.step, rating);
    c.step = next.step;
    c.due = next.due;
    if (rating === 'again') c.lapses += 1;
    else {
      c.reps += 1;
      c.lastReviewed = now;
    }
    c.updatedAt = now;
    await db.cards.put(c);
    it.card = c;
    undo = async () => {
      await db.cards.put(before);
      it.card = before;
    };
  } else if (it.type === 'word') {
    const fresh = (await db.vocab.get(it.word.id)) ?? it.word;
    const before = structuredClone(fresh);
    const w = structuredClone(fresh);
    rateRecord(w, rating, now);
    w.updatedAt = now;
    await db.vocab.put(w);
    it.word = w;
    undo = async () => {
      await db.vocab.put(before);
      it.word = before;
    };
  } else {
    const { note, before, cardsBefore } = await reviewNote(it.note.id, rating, now);
    it.note = note;
    undo = async () => {
      await db.transaction('rw', db.notes, db.cards, async () => {
        await db.notes.put(before);
        const keep = new Set(cardsBefore.map((c) => c.id));
        const ids = await db.cards.where('noteId').equals(before.id).primaryKeys();
        await db.cards.bulkDelete(ids.filter((id) => !keep.has(id))); // cards this rating created
        await db.cards.bulkPut(cardsBefore);
      });
      it.note = before;
    };
  }
  // Every rating, Again included, is study time and keeps the streak; undo takes the day back
  // if this rating was the one that logged it.
  const day = await logReviewDay();
  return {
    undo: async () => {
      await undo();
      await unlogReviewDay(day);
    },
    milestone: day.milestone
  };
}

/**
 * Reviews a note in one transaction: its review fields, its quick insights (Hard and Easy rebuild
 * them, exactly as Mark reviewed always has) and its cards. Mark reviewed in the note and a rating
 * in a session both come here, so a failure changes nothing and trying again is safe.
 * The note's text is never touched.
 */
export function reviewNote(id: string, rating: Rating, now = Date.now()): Promise<{ note: Note; before: Note; cardsBefore: ReviewCard[] }> {
  return db.transaction('rw', db.notes, db.cards, async () => {
    const before = await db.notes.get(id);
    if (!before) throw new Error('This note is not saved yet.');
    const note = structuredClone(before);
    rateRecord(note, rating, now);
    if (rating !== 'again') {
      const ins = extractInsights(note);
      if (ins.items.length) note.insights = ins;
      else delete note.insights;
    }
    note.updatedAt = now;
    const cardsBefore = await db.cards.where('noteId').equals(id).toArray();
    await db.notes.put(note);
    if (rating !== 'again') {
      const plan = planCardSync(note, note.insights?.items ?? [], cardsBefore, { now });
      if (plan.put.length) await db.cards.bulkPut(plan.put);
    }
    return { note, before, cardsBefore };
  });
}

/** Removes the cards of notes that are deleted for good. */
export async function deleteCardsOf(noteIds: string[]) {
  if (noteIds.length) await db.cards.where('noteId').anyOf(noteIds).delete();
}
