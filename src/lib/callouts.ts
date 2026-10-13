/** UPSC callouts: tinted boxes for the building blocks of an answer. Colours live in styles.css (--co-*). */
export interface CalloutKind {
  id: string;
  label: string;
  hint: string;
  icon: string;
  /** PDF colours (the PDF is always printed in day colours). */
  print: string;
  printBg: string;
}

export const CALLOUT_KINDS: CalloutKind[] = [
  { id: 'article', label: 'Article', hint: 'An article of the Constitution or a law', icon: 'article', print: '#2f5fa8', printBg: '#eef2fa' },
  { id: 'case', label: 'Case', hint: 'A judgment and what it held', icon: 'case', print: '#8a3d6b', printBg: '#f7eef3' },
  { id: 'data', label: 'Data', hint: 'A figure, statistic or report', icon: 'data', print: '#12707a', printBg: '#e9f4f5' },
  { id: 'example', label: 'Example', hint: 'A real-world example', icon: 'example', print: '#9a6410', printBg: '#fbf3e4' },
  { id: 'wayforward', label: 'Way forward', hint: 'Reforms and suggestions', icon: 'arrow', print: '#3c7a3a', printBg: '#edf5ec' },
  { id: 'pyq', label: 'PYQ', hint: 'A previous year question: year, paper, marks', icon: 'pyq', print: '#5b3fa0', printBg: '#f1edf9' }
];

/** Papers a PYQ can come from (the PYQ callout's paper chip). */
export const PYQ_PAPERS = ['Prelims', 'GS1', 'GS2', 'GS3', 'GS4', 'Essay', 'Optional'];
export const PYQ_MARKS = ['2', '10', '15', '20', '125', '250'];

/** "PYQ · 2019 · GS2 · 15 marks": a PYQ callout's label with whichever details are filled in. */
export function calloutLabel(attrs: Record<string, unknown> | undefined): string {
  const k = calloutKind(attrs?.kind);
  if (k.id !== 'pyq') return k.label;
  const year = String(attrs?.year ?? '').trim();
  const paper = String(attrs?.paper ?? '').trim();
  const marks = String(attrs?.marks ?? '').trim();
  return [k.label, year, paper, marks ? `${marks} marks` : ''].filter(Boolean).join(' · ');
}

export function calloutKind(id: unknown): CalloutKind {
  return CALLOUT_KINDS.find((k) => k.id === id) ?? CALLOUT_KINDS[0];
}
