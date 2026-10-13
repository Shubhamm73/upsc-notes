/** Note templates offered on New note. A template only decides the starting sections. */
export interface NoteTemplate {
  id: string;
  name: string;
  hint: string;
  sections: string[];
}

export const TEMPLATES: NoteTemplate[] = [
  { id: 'gs-answer', name: 'GS answer', hint: 'Practise a Mains answer, with a word meter (150 / 250).', sections: ['Intro', 'Body', 'Way forward'] },
  { id: 'topic-sheet', name: 'Topic sheet', hint: 'Everything on one topic, ready for revision.', sections: ['Key terms', 'Articles and cases', 'Data', 'Examples', 'PYQs'] },
  { id: 'current-affairs', name: 'Current affairs', hint: 'One news item, tied to the syllabus.', sections: ['News', 'Background', 'Syllabus link', 'Prelims facts', 'Mains angle'] },
  { id: 'blank', name: 'Blank', hint: 'One empty section. Add more as you go.', sections: ['Notes'] }
];

export function templateOf(id: string | undefined): NoteTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[TEMPLATES.length - 1];
}
