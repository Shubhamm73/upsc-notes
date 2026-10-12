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
  { id: 'wayforward', label: 'Way forward', hint: 'Reforms and suggestions', icon: 'arrow', print: '#3c7a3a', printBg: '#edf5ec' }
];

export function calloutKind(id: unknown): CalloutKind {
  return CALLOUT_KINDS.find((k) => k.id === id) ?? CALLOUT_KINDS[0];
}
