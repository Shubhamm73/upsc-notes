import type { Editor } from '@tiptap/core';
import { isHistoryTransaction, redoDepth, undoDepth } from '@tiptap/pm/history';
import type { Transaction } from '@tiptap/pm/state';

/**
 * One Undo / Redo for the whole open note. Each section is its own editor with its own
 * history; this keeps the order of everything across them, plus the changes that live
 * outside the editors (title, topic, subject, template, section headings, adding,
 * deleting and moving sections, own words, connections, font).
 *
 * - text: "the next undo step of section X's editor" (its own history holds the change)
 * - field: a value before and after; quick typing in one field merges into one step
 * - op: anything else, as a pair of functions
 */
type Entry =
  | { kind: 'text'; section: string }
  | { kind: 'field'; key: string; before: unknown; after: unknown; at: number; apply(v: unknown): void }
  | { kind: 'op'; undo(): void; redo(): void };

const MERGE_MS = 1500;

export class NoteHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  /** True while this class itself is undoing in an editor (its listener must not re-file that). */
  private applying = false;

  constructor(
    private o: {
      editor(section: string): Editor | undefined;
      /** Shows the section (expands it, scrolls the change into view). */
      reveal(section: string, editor: Editor): void;
      changed(): void;
    }
  ) {}

  /** Files every new undo step of a section's editor in the note-wide order. Returns a detach function. */
  track(section: string, ed: Editor): () => void {
    let u = undoDepth(ed.state);
    let r = redoDepth(ed.state);
    const onTx = ({ transaction }: { transaction: Transaction }) => {
      const nu = undoDepth(ed.state);
      const nr = redoDepth(ed.state);
      if (!this.applying) {
        if (isHistoryTransaction(transaction)) {
          // the editor undid / redid by itself (not through this class): keep the order in step
          if (nu < u) this.move(this.undoStack, this.redoStack, section);
          else if (nu > u) this.move(this.redoStack, this.undoStack, section);
        } else if (nu > u || nr < r) {
          if (nu > u) this.undoStack.push({ kind: 'text', section });
          this.redoStack = [];
        }
      }
      u = nu;
      r = nr;
      this.o.changed();
    };
    ed.on('transaction', onTx);
    return () => ed.off('transaction', onTx);
  }

  private move(from: Entry[], to: Entry[], section: string) {
    for (let i = from.length - 1; i >= 0; i--) {
      const e = from[i];
      if (e.kind === 'text' && e.section === section) {
        from.splice(i, 1);
        to.push(e);
        return;
      }
    }
  }

  /** A field changed from `before` to `after` (typing in one field within 1.5 s is one step). */
  field(key: string, before: unknown, after: unknown, apply: (v: unknown) => void) {
    if (before === after) return;
    const top = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (top?.kind === 'field' && top.key === key && now - top.at < MERGE_MS) {
      top.after = after;
      top.at = now;
      if (top.after === top.before) this.undoStack.pop();
    } else {
      this.undoStack.push({ kind: 'field', key, before, after, at: now, apply });
    }
    this.redoStack = [];
    this.o.changed();
  }

  /** Any other change, undone and redone by the given functions. */
  op(undo: () => void, redo: () => void) {
    this.undoStack.push({ kind: 'op', undo, redo });
    this.redoStack = [];
    this.o.changed();
  }

  canUndo(): boolean {
    return this.undoStack.some((e) => this.usable(e, 'undo'));
  }

  canRedo(): boolean {
    return this.redoStack.some((e) => this.usable(e, 'redo'));
  }

  private usable(e: Entry, dir: 'undo' | 'redo'): boolean {
    if (e.kind !== 'text') return true;
    const ed = this.o.editor(e.section);
    return !!ed && !ed.isDestroyed && (dir === 'undo' ? undoDepth(ed.state) : redoDepth(ed.state)) > 0;
  }

  undo() {
    this.step('undo');
  }

  redo() {
    this.step('redo');
  }

  private step(dir: 'undo' | 'redo') {
    const from = dir === 'undo' ? this.undoStack : this.redoStack;
    const to = dir === 'undo' ? this.redoStack : this.undoStack;
    while (from.length) {
      const e = from.pop()!;
      if (!this.usable(e, dir)) continue; // e.g. a section's history ended with the note
      if (e.kind === 'text') {
        const ed = this.o.editor(e.section)!;
        this.applying = true;
        try {
          if (dir === 'undo') ed.commands.undo();
          else ed.commands.redo();
        } finally {
          this.applying = false;
        }
        this.o.reveal(e.section, ed);
      } else if (e.kind === 'field') {
        e.apply(dir === 'undo' ? e.before : e.after);
        e.at = 0; // never merge into a step that was undone and redone
      } else if (dir === 'undo') {
        e.undo();
      } else {
        e.redo();
      }
      to.push(e);
      break;
    }
    this.o.changed();
  }
}
