import Dexie, { type Table } from 'dexie';

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

export interface Note {
  id: string;
  subject: string;
  topic: string;
  title: string;
  sections: Section[];
  explain: string;
  connect: string;
  nextReview: string; // YYYY-MM-DD, local date
  reviewCount: number;
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

export interface MetaRec {
  key: string;
  value: unknown;
}

export const SUBJECTS = ['GS1', 'GS2', 'GS3', 'GS4', 'Essay', 'CSAT', 'Current affairs', 'PSIR'] as const;
export const SCHEMA_VERSION = 1;

class NotesDB extends Dexie {
  notes!: Table<Note, string>;
  vocab!: Table<Vocab, string>;
  images!: Table<ImageRec, string>;
  meta!: Table<MetaRec, string>;

  constructor() {
    super('upsc-notes');
    this.version(SCHEMA_VERSION).stores({
      notes: 'id, subject, updatedAt, nextReview',
      vocab: 'id, word, updatedAt, nextReview',
      images: 'id, noteId',
      meta: 'key'
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
