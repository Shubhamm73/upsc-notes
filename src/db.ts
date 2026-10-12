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
  /** Optional font style for this note only (see FONT_STYLES); absent = the app's style. */
  fontStyle?: string;
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

export const SUBJECTS = ['GS1', 'GS2', 'GS3', 'GS4', 'Essay', 'Interview', 'Current affairs', 'PSIR'] as const;
export const SCHEMA_VERSION = 2;

/** Subjects that were renamed; old values are moved over on upgrade and on backup import. */
export const RENAMED_SUBJECTS: Record<string, string> = { CSAT: 'Interview' };

class NotesDB extends Dexie {
  notes!: Table<Note, string>;
  vocab!: Table<Vocab, string>;
  images!: Table<ImageRec, string>;
  meta!: Table<MetaRec, string>;

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
