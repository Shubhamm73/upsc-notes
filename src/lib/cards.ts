import type { InsightItem, Note, ReviewCard } from '../db';
import { addDays, ymd } from './dates';
import { keyLineDetails } from './insights';
import { stepOf } from './schedule';

/** How alike two lines must be (word overlap) for an edited highlight to keep its card's history. */
export const CARRY_OVER = 0.6;

export const cardKey = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A card's id: the same line in the same note always gets the same id, on any device. */
export const cardId = (noteId: string, key: string) => `${noteId}:${hash(key)}`;

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Dice coefficient over the words of two lines: 1 = same words, 0 = none shared. */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return (2 * both) / (A.size + B.size);
}

const CONTEXT_MAX = 180;
function trimContext(s: string, side: 'before' | 'after'): string {
  const t = s.replace(/\s+/g, ' ');
  if (t.length <= CONTEXT_MAX) return t;
  if (side === 'before') return '…' + t.slice(-CONTEXT_MAX).replace(/^\S*\s/, '');
  return t.slice(0, CONTEXT_MAX).replace(/\s\S*$/, '') + '…';
}

/** The paragraph text around each key line of a note, by key (first place the line appears). */
function contextByKey(note: Note): Map<string, { before: string; after: string }> {
  const out = new Map<string, { before: string; after: string }>();
  for (const s of note.sections) {
    for (const d of keyLineDetails(s.doc)) {
      const k = cardKey(d.text);
      if (!out.has(k)) out.set(k, { before: trimContext(d.before, "before").trim(), after: trimContext(d.after, "after").trim() });
    }
  }
  return out;
}

/** Live cards first, then the most recently reviewed: the one that keeps a key when two share it. */
const rank = (c: ReviewCard) => (c.retiredAt ? 0 : 2e15) + (c.lastReviewed ?? 0);

/**
 * Brings a note's cards in step with its quick insights (`items`, the snapshot just built).
 * Pure: returns the cards to write; never deletes.
 * - A line that already has a card (same key, live or retired) keeps it; a retired one comes back.
 * - A line with no card takes over the history of a card whose line just vanished, if the words are
 *   at least CARRY_OVER alike (an edited highlight); otherwise it gets a new card.
 * - A live card whose line is gone is retired. Two live cards with one key: the lesser is retired.
 * New cards start at step 0, due tomorrow; with `seed` (upgrade and import) they take the note's own
 * step and next review, since they came from the note's last review.
 */
export function planCardSync(
  note: Note,
  items: InsightItem[],
  existing: ReviewCard[],
  opts: { seed?: boolean; now?: number; today?: string } = {}
): { put: ReviewCard[]; created: number; retired: number } {
  const now = opts.now ?? Date.now();
  const today = opts.today ?? ymd();
  const context = contextByKey(note);
  const cards = existing.map((c) => ({ ...c }));
  const changed = new Set<ReviewCard>();
  const byKey = new Map<string, ReviewCard>();
  for (const c of [...cards].sort((a, b) => rank(b) - rank(a))) {
    if (!byKey.has(c.key)) byKey.set(c.key, c);
    else if (!c.retiredAt) {
      c.retiredAt = now;
      c.updatedAt = now;
      changed.add(c);
    }
  }
  const used = new Set<ReviewCard>();
  const update = (c: ReviewCard, it: InsightItem, pos: number) => {
    const key = cardKey(it.text);
    const ctx = context.get(key) ?? { before: '', after: '' };
    const next = { section: it.section, text: it.text, key, pos, before: ctx.before, after: ctx.after, retiredAt: null };
    if ((Object.keys(next) as (keyof typeof next)[]).some((k) => c[k] !== next[k])) {
      Object.assign(c, next);
      c.updatedAt = now;
      changed.add(c);
    }
    used.add(c);
  };

  const unmatched: { it: InsightItem; pos: number }[] = [];
  const seenKeys = new Set<string>();
  items.forEach((it, pos) => {
    const key = cardKey(it.text);
    if (seenKeys.has(key)) return; // the same line in two sections: one card
    seenKeys.add(key);
    const c = byKey.get(key);
    if (c && !used.has(c)) update(c, it, pos);
    else unmatched.push({ it, pos });
  });

  // Edited highlights: pair each new line with the most alike card whose line just vanished.
  const vanished = cards.filter((c) => !used.has(c) && !c.retiredAt && !changed.has(c));
  const pairs: { u: (typeof unmatched)[number]; c: ReviewCard; score: number }[] = [];
  for (const u of unmatched)
    for (const c of vanished) {
      const score = similarity(u.it.text, c.text);
      if (score >= CARRY_OVER) pairs.push({ u, c, score });
    }
  pairs.sort((a, b) => b.score - a.score);
  const paired = new Set<(typeof unmatched)[number]>();
  for (const p of pairs) {
    if (paired.has(p.u) || used.has(p.c)) continue;
    paired.add(p.u);
    update(p.c, p.u.it, p.u.pos);
  }

  let created = 0;
  const ids = new Set(cards.map((c) => c.id));
  for (const u of unmatched) {
    if (paired.has(u)) continue;
    const key = cardKey(u.it.text);
    let id = cardId(note.id, key);
    for (let i = 2; ids.has(id); i++) id = `${cardId(note.id, key)}-${i}`;
    ids.add(id);
    const ctx = context.get(key) ?? { before: '', after: '' };
    const seedStep = stepOf(note);
    const c: ReviewCard = {
      id,
      kind: 'insight',
      noteId: note.id,
      section: u.it.section,
      text: u.it.text,
      key,
      pos: u.pos,
      before: ctx.before,
      after: ctx.after,
      step: opts.seed ? Math.max(seedStep, 0) : 0,
      due: opts.seed ? note.nextReview || today : addDays(today, 1),
      reps: 0,
      lapses: 0,
      lastReviewed: null,
      createdAt: now,
      updatedAt: now,
      retiredAt: null
    };
    created++;
    changed.add(c);
    used.add(c);
  }

  let retired = 0;
  for (const c of cards) {
    if (used.has(c) || c.retiredAt) continue;
    c.retiredAt = now;
    c.updatedAt = now;
    changed.add(c);
    retired++;
  }
  return { put: [...changed], created, retired };
}
