import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { CALLOUT_KINDS } from '../lib/callouts';
import { insertMindMap, openChartGallery } from './gallery';
import { setCallout } from './callout';
import { selectSketchBefore } from './sketch-block';
import { SKETCH_H } from '../lib/sketch';
import { savedStyles } from '../lib/my-styles';
import { PANEL_INFO, readPanelLook } from '../lib/looks';
import { applySavedStyle, openContainerSheet, openTableDialog } from './look-tools';

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
  /** Not listed in the menu; found only by typing its name ("/diagram", "/mind map"). */
  searchOnly?: boolean;
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
  keywords: `callout box ${k.label} ${k.id}${k.id === 'pyq' ? ' previous year question' : ''}`,
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
    run: (e) => openTableDialog(e)
  },
  // 0.16: one entry for the one gallery (charts, diagrams, mind map); "/diagram" and "/mind map" still jump straight in
  { id: 'chart', name: 'Chart', hint: 'Charts from numbers, diagrams and mind maps from words', glyph: 'i:data', keywords: 'chart graph bar column line pie donut area radar scatter bubble gallery', run: (e) => openChartGallery(e) },
  { id: 'diagram', name: 'Diagram', hint: 'Timeline, flowchart, cycle, pyramid, Venn, hierarchy, comparison, 2×2', glyph: 'i:diagram', keywords: 'timeline flowchart flow cycle pyramid venn hierarchy tree comparison compare matrix swot', searchOnly: true, run: (e) => openChartGallery(e, 'words') },
  { id: 'mindmap', name: 'Mind map', hint: 'Ideas around a centre: as many as you like', glyph: 'i:mindmap', keywords: 'mindmap brainstorm ideas branches', searchOnly: true, run: (e) => insertMindMap(e) },
  { id: 'image', name: 'Image', hint: 'From the tablet, resizable', glyph: 'i:image', keywords: 'image photo picture', run: (e, env) => env.pickImage(e) },
  {
    id: 'sketch',
    name: 'Sketch',
    hint: 'Draw with the S Pen: maps, diagrams, flowcharts',
    glyph: 'i:pen',
    keywords: 'sketch draw pen drawing s pen',
    run: (e) => {
      insertBlocks(e, { type: 'sketchBlock', attrs: { strokes: [], height: SKETCH_H, width: 100, align: 'center', caption: '' } });
      selectSketchBefore(e);
    }
  },
  {
    id: 'container',
    name: 'Container',
    hint: 'Panel, titled box, sticky note, frame, quote, two columns',
    glyph: 'i:container',
    keywords: 'container panel box sticky note frame quote columns two column key point remember',
    run: (e, env) => openContainerSheet(e, env.toast)
  },
  { id: 'callout', name: 'Callout', hint: 'Article, Case, Data, Example, Way forward, PYQ', glyph: 'i:article', keywords: 'callout box pyq', submenu: true, run: () => undefined },
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
  if (!q) return base.filter((i) => !i.searchOnly);
  const mine: InsertItem[] = savedStyles().map((st) => ({
    id: `style-${st.id}`,
    name: st.name,
    hint: st.kind === 'heading' ? 'My style · heading' : `My style · ${PANEL_INFO[readPanelLook(st.look).kind].name}`,
    glyph: 'i:palette',
    keywords: 'my style mystyle saved',
    run: (ed) => applySavedStyle(ed, st)
  }));
  const all = [...base, ...CALLOUT_ITEMS, ...mine];
  const starts = all.filter((i) => i.name.toLowerCase().startsWith(q));
  const words = all.filter((i) => !starts.includes(i) && i.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  const keys = all.filter((i) => !starts.includes(i) && !words.includes(i) && i.keywords.toLowerCase().includes(q));
  return [...starts, ...words, ...keys];
}
