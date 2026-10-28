export type StudyGrade = 'again' | 'hard' | 'good' | 'easy';

export interface StudyCard {
  id: string;
  question: string;
  answer: string;
  sourcePath: string;
  sourceTitle: string;
  heading: string;
  dueAt: number;
  reviewedCount: number;
  lastReviewedAt: number | null;
  lastGrade: StudyGrade | null;
}

export interface StudyStats {
  total: number;
  due: number;
  upcoming: number;
  reviewed: number;
  recentSources: { sourcePath: string; sourceTitle: string; lastReviewedAt: number }[];
}

export interface StudyOverview { cards: StudyCard[]; stats: StudyStats }
export interface StudyReviewResult { card: StudyCard; stats: StudyStats }

async function studyRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let message = `Study request failed (${response.status})`;
    try {
      const body = await response.json() as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch { /* Keep the status message when the server did not return JSON. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function getStudyOverview(folder = '', tag = ''): Promise<StudyOverview> {
  const query = new URLSearchParams();
  if (folder.trim()) query.set('folder', folder.trim());
  if (tag.trim()) query.set('tag', tag.trim().replace(/^#/, ''));
  const suffix = query.size ? `?${query.toString()}` : '';
  return studyRequest<StudyOverview>(`/api/study${suffix}`);
}

export function submitStudyReview(cardId: string, grade: StudyGrade): Promise<StudyReviewResult> {
  return studyRequest<StudyReviewResult>('/api/study/review', {
    method: 'POST',
    body: JSON.stringify({ cardId, grade }),
  });
}

export interface StudyReviewContext { folder: string; tag: string; requestId: number; refreshKey: number }

export function isStudyReviewContextCurrent(expected: StudyReviewContext, current: StudyReviewContext): boolean {
  return expected.requestId === current.requestId
    && expected.refreshKey === current.refreshKey
    && expected.folder.trim() === current.folder.trim()
    && expected.tag.trim().replace(/^#/, '') === current.tag.trim().replace(/^#/, '');
}

/** Review a card, then reload stats/cards for the active folder and tag instead of using vault-wide POST stats. */
export async function reviewStudyCardInScope(cardId: string, grade: StudyGrade, folder: string, tag: string): Promise<{ review: StudyReviewResult; overview: StudyOverview }> {
  const review = await submitStudyReview(cardId, grade);
  const overview = await getStudyOverview(folder, tag);
  return { review, overview };
}

/** Due cards first, then upcoming cards in ascending due time. Never fabricate or transform card content. */
export function orderStudyCards(cards: StudyCard[], now = Date.now() / 1000): StudyCard[] {
  return [...cards].sort((a, b) => {
    const aDue = a.dueAt <= now ? 0 : 1;
    const bDue = b.dueAt <= now ? 0 : 1;
    return aDue - bDue || a.dueAt - b.dueAt || a.id.localeCompare(b.id);
  });
}

/** Keep the session denominator stable when a graded due card leaves the due queue. */
export function studySessionProgress<T extends { id: string }>(queue: T[], seen: Set<string>): { completed: number; total: number } {
  const remaining = queue.reduce((count, card) => count + (seen.has(card.id) ? 0 : 1), 0);
  return { completed: seen.size, total: seen.size + remaining };
}

