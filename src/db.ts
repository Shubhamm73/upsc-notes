import Dexie, { type Table } from 'dexie';
import { planCardSync } from './lib/cards';

/** A section of a note. `doc` is editor JSON (ProseMirror/TipTap shape). */
export interface Section {
  id: string;
  heading: string;
  doc: DocNode;
}

export interface DocNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: DocNode[];
}

export interface InsightItem {
  section: string;
  text: string;
}

export interface NoteInsights {
  generatedAt: number;
  items: InsightItem[];
}

export interface Note {
  id: string;
  subject: string;
  topic: string;
  title: string;
  sections: Section[];
  explain: string;
  connect: string;
  /** Snapshot of highlighted lines, rebuilt each time the note is marked reviewed. */
  insights?: NoteInsights;
  /** Template the note started from (see TEMPLATES); absent = Blank. Added in 0.7, no index, so no Dexie version bump. */
  template?: string;
  /** Optional font style for this note only (see FONT_STYLES); absent = the app's style. */
  fontStyle?: string;
  nextReview: string; // YYYY-MM-DD, local date
  reviewCount: number;
  /** Index into REVIEW_INTERVALS of the last review (0.8+). Absent on older records: read via stepOf(). */
  reviewStep?: number;
  lastReviewed: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface VocabUse {
  sentence: string;
  context: 'Essay' | 'GS answer' | 'Interview' | 'Other';
}

export interface Vocab {
  id: string;
  word: string;
  meaning: string;
  uses: VocabUse[];
  synonyms: string[];
  antonyms: string[];
  nextReview: string;
  reviewCount: number;
  /** See Note.reviewStep. */
  reviewStep?: number;
  lastReviewed?: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ImageRec {
  id: string;
  noteId: string;
  blob: Blob;
  width: number;
  height: number;
  updatedAt: number;
}

/**
 * One flashcard made from a highlighted line (a quick insight). Cards are created and kept in step
 * with the note's quick insights whenever they are rebuilt (see lib/cards.ts). A card whose line is
 * no longer highlighted is retired (kept, out of the queue), never deleted, so its history comes
 * back if the line is highlighted again.
 */
export interface ReviewCard {
  id: string;
  kind: 'insight';
  noteId: string;
  /** Section heading the line was in at the last rebuild (display only). */
  section: string;
  text: string;
  /** Normalised text, used to match the card to its line. */
  key: string;
  /** Position among the note's quick insights at the last rebuild. */
  pos: number;
  /** The rest of the line's paragraph, for the blanked-out prompt. Empty when the whole paragraph is marked. */
  before: string;
  after: string;
  /** Index into REVIEW_INTERVALS of the last review; -1 = never. */
  step: number;
  due: string; // YYYY-MM-DD
  reps: number;
  lapses: number;
  lastReviewed: number | null;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
}

export interface MetaRec {
  key: string;
  value: unknown;
}

export const SUBJECTS = ['GS1', 'GS2', 'GS3', 'GS4', 'Essay', 'Interview', 'Current affairs', 'PSIR'] as const;
export const SCHEMA_VERSION = 3;

/** Subjects that were renamed; old values are moved over on upgrade and on backup import. */
export const RENAMED_SUBJECTS: Record<string, string> = { CSAT: 'Interview' };

class NotesDB extends Dexie {
  notes!: Table<Note, string>;
  vocab!: Table<Vocab, string>;
  images!: Table<ImageRec, string>;
  meta!: Table<MetaRec, string>;
  cards!: Table<ReviewCard, string>;

  constructor() {
    super('upsc-notes');
    const stores = {
      notes: 'id, subject, updatedAt, nextReview',
      vocab: 'id, word, updatedAt, nextReview',
      images: 'id, noteId',
      meta: 'key'
    };
    this.version(1).stores(stores);
    // v2: the CSAT subject became Interview
    this.version(2)
      .stores(stores)
      .upgrade((tx) =>
        tx
          .table('notes')
          .toCollection()
          .modify((n: Note) => {
            if (RENAMED_SUBJECTS[n.subject]) n.subject = RENAMED_SUBJECTS[n.subject];
          })
      );
    // v3 (0.8): review cards for quick insights. Notes, words and images are not touched;
    // each note's existing quick insights become cards on the note's own schedule.
    this.version(3)
      .stores({ ...stores, cards: 'id, noteId, due' })
      .upgrade(async (tx) => {
        const notes = (await tx.table('notes').toArray()) as Note[];
        const put: ReviewCard[] = [];
        for (const n of notes) if (n.insights?.items.length) put.push(...planCardSync(n, n.insights.items, [], { seed: true }).put);
        if (put.length) await tx.table('cards').bulkPut(put);
      });
  }
}

export const db = new NotesDB();

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const rec = await db.meta.get(key);
  return rec === undefined ? fallback : (rec.value as T);
}

export function setMeta(key: string, value: unknown) {
  return db.meta.put({ key, value });
}

export function newId(): string {
  return crypto.randomUUID();
}
