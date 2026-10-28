export const STUDY_SUBJECTS = ['Maths', 'International Economics', 'Business Economics', 'Marketing', 'English', 'Danish'] as const;

export function studyInstruction(subject = ''): string {
  const focus = subject === 'Maths' ? 'Keep all equations and show the supplied worked steps clearly.'
    : subject.includes('Economics') ? 'Keep economic assumptions, units, definitions and graph explanations clear.'
      : subject === 'Marketing' ? 'Organize the supplied models, concepts and case examples.'
        : subject === 'English' || subject === 'Danish' ? 'Keep original quotations exact and distinguish textual evidence from interpretation.'
          : 'Keep key concepts, definitions and supplied examples clear.';
  return `Turn this source into clear${subject ? ` ${subject}` : ''} study notes. Use only the supplied material; do not invent facts, quotations, calculations or examples. Write explanations in English unless I explicitly request another language. Preserve equations, numbers, units, original quotations and Danish subject terms. ${focus} Use short headings and readable paragraphs or lists. End with a few revision questions answerable from the source. If information is missing or ambiguous, say so.`;
}

