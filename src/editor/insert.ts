import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { CALLOUT_KINDS } from '../lib/callouts';
import { DEFAULT_CHART } from './chart-block';
import { setCallout } from './callout';

export interface InsertEnv {
  pickImage(editor: Editor): void;
  toast(text: string): void;
}

export interface InsertItem {
  id: string;
  name: string;
  hint: string;
  /** Short text glyph, or an icon name prefixed with "i:". */
  glyph: string;
  keywords: string;
  soon?: boolean;
  /** Opens the list of callout kinds instead of running. */
  submenu?: boolean;
  /** Only offered from the + button (not from "/"), and only when this says so. */
  plusOnly?: (e: Editor) => boolean;
  run(e: Editor, env: InsertEnv): void;
}

export function setList(e: Editor, style: 'disc' | 'dash') {
  const isBullet = e.isActive('bulletList');
  const current = e.getAttributes('bulletList').listStyle ?? 'disc';
  if (isBullet && current === style) e.chain().focus().toggleBulletList().run();
  else if (isBullet) e.chain().focus().updateAttributes('bulletList', { listStyle: style }).run();
  else e.chain().focus().toggleBulletList().updateAttributes('bulletList', { listStyle: style }).run();
}

/** Touch bar List button: none → bullets → dashes → numbers → none. */
export function cycleList(e: Editor) {
  if (e.isActive('orderedList')) e.chain().focus().toggleOrderedList().run();
  else if (e.isActive('bulletList') && e.getAttributes('bulletList').listStyle === 'dash') e.chain().focus().toggleOrderedList().run();
  else if (e.isActive('bulletList')) e.chain().focus().updateAttributes('bulletList', { listStyle: 'dash' }).run();
  else setList(e, 'disc');
}

/** A block added at the very end of a section gets an empty line after it, so writing can go on. */
export function ensureParagraphAfter(e: Editor) {
  const { doc, schema } = e.state;
  if (doc.lastChild?.type.name === 'paragraph') return;
  e.view.dispatch(e.state.tr.insert(doc.content.size, schema.nodes.paragraph.create()));
}

/** Inserts blocks after a selected image or chart instead of replacing it. */
export function insertBlocks(e: Editor, content: object | object[]) {
  const s = e.state.selection;
  if (s instanceof NodeSelection) e.chain().focus().insertContentAt(s.to, content).run();
  else e.chain().focus().insertContent(content).run();
  ensureParagraphAfter(e);
}

const inList = (e: Editor) => e.isActive('bulletList') || e.isActive('orderedList');

export const CALLOUT_ITEMS: InsertItem[] = CALLOUT_KINDS.map((k) => ({
  id: `callout-${k.id}`,
  name: `${k.label} callout`,
  hint: k.hint,
  glyph: `i:${k.icon}`,
  keywords: `callout box ${k.label} ${k.id}`,
  run: (e) => setCallout(e, k.id)
}));

export const INSERT_ITEMS: InsertItem[] = [
  { id: 'heading', name: 'Heading', hint: 'A sub-heading inside this section', glyph: 'H', keywords: 'heading title subheading h2', run: (e) => void e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'bullet', name: 'Bullet list', hint: 'Simple points', glyph: '•', keywords: 'bullet list points ul', run: (e) => setList(e, 'disc') },
  { id: 'dash', name: 'Dash list', hint: 'Points with dashes', glyph: '–', keywords: 'dash list points', run: (e) => setList(e, 'dash') },
  { id: 'numbered', name: 'Numbered list', hint: 'Steps or ranked points', glyph: '1.', keywords: 'numbered list ordered ol steps', run: (e) => void e.chain().focus().toggleOrderedList().run() },
  {
    id: 'table',
    name: 'Table',
    hint: 'Rows and columns',
    glyph: 'i:table',
    keywords: 'table grid rows columns compare',
    run: (e) => {
      e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      ensureParagraphAfter(e);
    }
  },
  { id: 'chart', name: 'Chart', hint: 'Bar, line or pie from a small grid', glyph: 'i:data', keywords: 'chart graph bar line pie', run: (e) => insertBlocks(e, { type: 'chartBlock', attrs: structuredClone(DEFAULT_CHART) }) },
  { id: 'image', name: 'Image', hint: 'From the tablet, resizable', glyph: 'i:image', keywords: 'image photo picture diagram map', run: (e, env) => env.pickImage(e) },
  { id: 'sketch', name: 'Sketch', hint: 'Draw with the S Pen · coming soon', glyph: 'i:marker', keywords: 'sketch draw pen drawing', soon: true, run: (_e, env) => env.toast('Sketching with the S Pen arrives in a later update.') },
  { id: 'callout', name: 'Callout', hint: 'Article, Case, Data, Example, Way forward', glyph: 'i:article', keywords: 'callout box', submenu: true, run: () => undefined },
  {
    id: 'divider',
    name: 'Divider',
    hint: 'A quiet line between ideas',
    glyph: '—',
    keywords: 'divider line rule separator hr',
    run: (e) => {
      e.chain().focus().setHorizontalRule().run();
      ensureParagraphAfter(e);
    }
  },
  { id: 'indent', name: 'Indent', hint: 'Move this point one level in', glyph: '→', keywords: 'indent', plusOnly: (e) => inList(e) && e.can().sinkListItem('listItem'), run: (e) => void e.chain().focus().sinkListItem('listItem').run() },
  { id: 'outdent', name: 'Outdent', hint: 'Move this point one level out', glyph: '←', keywords: 'outdent', plusOnly: (e) => inList(e) && e.can().liftListItem('listItem'), run: (e) => void e.chain().focus().liftListItem('listItem').run() }
];

/** Items for "/query": names first, then keywords; callout kinds show up by name ("/case"). */
export function filterItems(query: string): InsertItem[] {
  const q = query.trim().toLowerCase();
  const base = INSERT_ITEMS.filter((i) => !i.plusOnly);
  if (!q) return base;
  const all = [...base, ...CALLOUT_ITEMS];
  const starts = all.filter((i) => i.name.toLowerCase().startsWith(q));
  const words = all.filter((i) => !starts.includes(i) && i.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  const keys = all.filter((i) => !starts.includes(i) && !words.includes(i) && i.keywords.toLowerCase().includes(q));
  return [...starts, ...words, ...keys];
}
