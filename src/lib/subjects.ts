/** Each subject's colour token (see the subject colour system in styles.css). */
const VARS: Record<string, string> = {
  GS1: '--sub-gs1',
  GS2: '--sub-gs2',
  GS3: '--sub-gs3',
  GS4: '--sub-gs4',
  Essay: '--sub-essay',
  Interview: '--sub-interview',
  'Current affairs': '--sub-ca',
  PSIR: '--sub-psir'
};

export function subjectColor(subject: string): string {
  return `var(${VARS[subject] ?? '--muted'})`;
}
