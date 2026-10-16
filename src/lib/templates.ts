/**
 * Note templates offered on New note (0.14: 19 in five groups, plus his own). A template decides the
 * starting sections and what each section starts with: tables, callouts, containers, diagrams, charts
 * and mind maps the editor already knows, so a note made from a template is an ordinary note.
 * Docs are built fresh each time (a mind map needs new ids per note).
 */
import type { DocNode } from '../db';
import { sampleChart, type ChartKind } from './charts';
import { sampleDiagram, type DiagramKind } from './diagrams';
import { newId as mmId } from './mindmap';
import { PANEL_DEFAULT, type PanelKind } from './looks';
import { findMyTemplate, myTemplates } from './my-templates';

export const TEMPLATE_GROUPS = ['Mains writing', 'Revision', 'Current affairs', 'Subject sheets', 'Start fresh'] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number] | 'My templates';

export interface TemplateSection {
  heading: string;
  /** What the section starts with; absent: one empty line. */
  make?: () => DocNode;
}

export interface NoteTemplate {
  id: string;
  name: string;
  hint: string;
  group: TemplateGroup;
  sections: TemplateSection[];
  /** Shows the Mains word meter (150 / 250). */
  meter?: boolean;
  /** What it comes with, for the gallery ("Word meter", "Stakeholder table" …). */
  blocks?: string[];
}

// ---------- starter blocks ----------
type N = DocNode;
const t = (text: string, bold = false): N => (bold ? { type: 'text', text, marks: [{ type: 'bold' }] } : { type: 'text', text });
const p = (text = '', bold = false): N => (text ? { type: 'paragraph', content: [t(text, bold)] } : { type: 'paragraph' });
const doc = (...content: N[]): N => ({ type: 'doc', content: content.length ? content : [p()] });
/** Blocks, then an empty line to write on. */
const blocks = (...b: N[]) => () => doc(...b, p());
const cell = (type: 'tableHeader' | 'tableCell', text = ''): N => ({ type, content: [p(text)] });
const table = (heads: string[], rows: (string[] | number)[], caption: string | null = null, firstCol = false): N => ({
  type: 'table',
  attrs: { tstyle: null, color: null, caption, firstCol: firstCol ? true : null },
  content: [
    { type: 'tableRow', content: heads.map((x) => cell('tableHeader', x)) },
    ...rows.flatMap((r) => (typeof r === 'number' ? Array.from({ length: r }, () => heads.map(() => '')) : [r])).map((r) => ({ type: 'tableRow', content: heads.map((_, i) => cell(firstCol && i === 0 ? 'tableHeader' : 'tableCell', r[i] ?? '')) }))
  ]
});
const callout = (kind: 'article' | 'case' | 'data' | 'example' | 'wayforward' | 'pyq'): N => ({ type: 'callout', attrs: { kind, year: null, paper: null, marks: null }, content: [p()] });
const panel = (kind: PanelKind, content: N[], title: string | null = null): N => ({ type: 'panel', attrs: { ...PANEL_DEFAULT, kind, title }, content });
const columns = (left: string, right: string): N =>
  panel('columns', [
    { type: 'panelColumn', content: [p(left, true), p()] },
    { type: 'panelColumn', content: [p(right, true), p()] }
  ]);
const list = (n: number, ordered = true): N => ({ type: ordered ? 'orderedList' : 'bulletList', content: Array.from({ length: n }, () => ({ type: 'listItem', content: [p()] })) });
const diagram = (kind: DiagramKind): N => ({ type: 'diagram', attrs: sampleDiagram(kind) as unknown as Record<string, unknown> });
const chart = (kind: ChartKind): N => ({ type: 'chart', attrs: { ...sampleChart(kind), align: 'center', width: 100 } as unknown as Record<string, unknown> });
const mindMap = (): N => {
  const root = mmId();
  const node = (text: string, parent: string | null) => ({ id: parent ? mmId() : root, text, parent, color: null, shape: 'pill', x: 0, y: 0, pinned: false, folded: false, marked: false });
  return { type: 'mindMap', attrs: { layout: 'radial', nodes: [node('Topic', null), node('Branch 1', root), node('Branch 2', root), node('Branch 3', root)] } };
};

const s = (heading: string, make?: () => DocNode): TemplateSection => (make ? { heading, make } : { heading });
const plain = (...headings: string[]) => headings.map((x) => s(x));

export const TEMPLATES: NoteTemplate[] = [
  // Mains writing
  { id: 'gs-answer', group: 'Mains writing', name: 'GS answer', hint: 'Practise a Mains answer, with a word meter (150 / 250).', sections: plain('Intro', 'Body', 'Way forward'), meter: true, blocks: ['Word meter'] },
  {
    id: 'essay-outline',
    group: 'Mains writing',
    name: 'Essay outline',
    hint: 'Plan an essay across every dimension before you write.',
    sections: [
      s('Thesis'),
      s('Dimensions', blocks(table(['Dimension', 'Points'], [['Political'], ['Economic'], ['Social'], ['Technological'], ['Legal'], ['Environmental']], null, true))),
      s('Quotes and anecdotes', blocks(panel('quote', [p()]))),
      s('Counter-view'),
      s('Conclusion')
    ],
    blocks: ['Dimensions table', 'Quote container']
  },
  {
    id: 'ethics-case',
    group: 'Mains writing',
    name: 'Ethics case study',
    hint: 'GS4 case: stakeholders, dilemmas, options, then your course of action.',
    sections: [
      s('Facts of the case'),
      s('Stakeholders', blocks(table(['Stakeholder', 'Interest', 'Concern'], [3]))),
      s('Ethical dilemmas'),
      s('Options with pros and cons', blocks(columns('Pros', 'Cons'))),
      s('Course of action')
    ],
    blocks: ['Stakeholder table', 'Two-column panel']
  },
  {
    id: 'pyq-practice',
    group: 'Mains writing',
    name: 'PYQ practice',
    hint: 'Answer a past question, then check yourself against a model.',
    sections: [s('The question', blocks(callout('pyq'))), s('My answer'), s('Points I missed', blocks(chart('radar'))), s('Model structure')],
    meter: true,
    blocks: ['Word meter', 'PYQ callout', 'Radar self-check']
  },
  // Revision
  { id: 'topic-sheet', group: 'Revision', name: 'Topic sheet', hint: 'Everything on one topic, ready for revision.', sections: plain('Key terms', 'Articles and cases', 'Data', 'Examples', 'PYQs') },
  {
    id: 'one-page',
    group: 'Revision',
    name: 'One-page revision',
    hint: 'The whole topic on one page for the last week.',
    sections: [s('Key terms', blocks(panel('titled', [p()], 'Term'), panel('titled', [p()], 'Term'))), s('5 must-know facts', blocks(list(5))), s('Mnemonic', blocks(panel('sticky', [p()]))), s('Likely questions')],
    blocks: ['Titled panels', 'Sticky note']
  },
  { id: 'cornell', group: 'Revision', name: 'Cornell notes', hint: 'Cue questions beside your notes, a summary below.', sections: [s('Cues and notes', blocks(columns('Cue questions', 'Notes'))), s('Summary')], blocks: ['Two-column panel'] },
  { id: 'mind-map', group: 'Revision', name: 'Mind-map page', hint: 'Map the topic first, then a note on each branch.', sections: [s('Mind map', blocks(mindMap())), s('Notes on each branch')], blocks: ['Mind map'] },
  {
    id: 'comparison',
    group: 'Revision',
    name: 'Comparison',
    hint: 'Two things side by side: schemes, reports, thinkers, eras.',
    sections: [s('Comparison table', blocks(table(['Aspect', 'First', 'Second'], [3], null, true))), s('Similarities', blocks(diagram('venn'))), s('Differences'), s('Verdict')],
    blocks: ['Comparison table', 'Venn diagram']
  },
  // Current affairs
  { id: 'current-affairs', group: 'Current affairs', name: 'Current affairs', hint: 'One news item, tied to the syllabus.', sections: plain('News', 'Background', 'Syllabus link', 'Prelims facts', 'Mains angle') },
  {
    id: 'editorial',
    group: 'Current affairs',
    name: 'Editorial summary',
    hint: 'One editorial in three lines, both sides and your view.',
    sections: [s('Source and date'), s('Gist in 3 lines', blocks(list(3))), s('Arguments for and against', blocks(columns('For', 'Against'))), s('Data quoted', blocks(callout('data'))), s('My view'), s('Syllabus tag')],
    blocks: ['Two-column panel', 'Data callout']
  },
  {
    id: 'scheme-card',
    group: 'Current affairs',
    name: 'Scheme / policy card',
    hint: 'A government scheme at a glance, for Prelims and Mains.',
    sections: [
      s('Ministry, launch and budget', blocks(table(['Ministry', 'Launched', 'Budget'], [1]))),
      s('Objectives'),
      s('Key features'),
      s('Data and progress'),
      s('Criticism'),
      s('Related PYQs', blocks(callout('pyq')))
    ],
    blocks: ['Fact table', 'PYQ callout']
  },
  {
    id: 'report-index',
    group: 'Current affairs',
    name: 'Report & index',
    hint: 'A report or index: who released it, findings, India’s rank.',
    sections: [s('Released by'), s('Key findings'), s('India’s rank and score', blocks(table(['Year', 'Rank', 'Score'], [3]), chart('bar'))), s('What it means for India')],
    blocks: ['Rank table', 'Bar chart']
  },
  { id: 'monthly-digest', group: 'Current affairs', name: 'Monthly digest', hint: 'A month of news, sorted by subject.', sections: plain('Polity', 'Economy', 'Environment', 'International relations', 'Science and tech', 'Prelims one-liners') },
  // Subject sheets
  { id: 'history-timeline', group: 'Subject sheets', name: 'History timeline', hint: 'An event or era: causes, course, consequences.', sections: [s('Timeline', blocks(diagram('timeline'))), ...plain('Causes', 'Events', 'Consequences', 'Personalities')], blocks: ['Timeline diagram'] },
  {
    id: 'constitution-article',
    group: 'Subject sheets',
    name: 'Constitution article',
    hint: 'One Article: text, provisions, cases and amendments.',
    sections: [s('Text of the Article', blocks(callout('article'))), s('Provisions'), s('Landmark cases'), s('Amendments', blocks(table(['Amendment', 'Year', 'What changed'], [2]))), s('Related Articles')],
    blocks: ['Article callout', 'Amendments table']
  },
  { id: 'map-sheet', group: 'Subject sheets', name: 'Map sheet', hint: 'A map with labels, places and why they matter.', sections: [s('Map with labels'), s('Location facts', blocks(table(['Place', 'Where', 'Why it matters'], [3]))), s('Places in the news')], blocks: ['Location table'] },
  { id: 'thinker-sheet', group: 'Subject sheets', name: 'Thinker sheet', hint: 'A thinker for Essay, Ethics or PSIR: ideas, quotes, critiques.', sections: [s('Life and context'), s('Key ideas'), s('Quotes', blocks(panel('quote', [p()]))), s('Critiques'), s('How to use in answers')], blocks: ['Quote container'] },
  // Start fresh
  { id: 'blank', group: 'Start fresh', name: 'Blank', hint: 'One empty section. Add more as you go.', sections: plain('Notes') }
];

const BLANK = TEMPLATES.find((x) => x.id === 'blank')!;

/** A template by id: one of the 19, one of his (my:…), else Blank. */
export function templateOf(id: string | undefined): NoteTemplate {
  return TEMPLATES.find((x) => x.id === id) ?? (id?.startsWith('my:') ? findMyTemplate(id) : undefined) ?? BLANK;
}
export const isTemplateId = (id: string | undefined): boolean => !!id && (TEMPLATES.some((x) => x.id === id) || (id.startsWith('my:') && !!findMyTemplate(id)));
/** Every template he can start from: the 19, then his own. */
export const allTemplates = (): NoteTemplate[] => [...TEMPLATES, ...myTemplates()];

/** A section's starting doc (a fresh copy). */
export const sectionDoc = (sec: TemplateSection): DocNode => sec.make?.() ?? doc();
