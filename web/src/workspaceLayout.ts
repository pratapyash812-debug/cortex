export interface WorkspacePreferences {
  subjects: boolean;
  pages: boolean;
  subjectWidth: number;
  pageWidth: number;
  wide: boolean;
  uiScale?: number;
}

export const defaultWorkspace: WorkspacePreferences = {
  subjects: true, pages: true, subjectWidth: 188, pageWidth: 224, wide: false, uiScale: 100,
};

export const panelLimits = {subjects: [144, 300], pages: [172, 400]} as const;
export type WorkspacePanel = keyof typeof panelLimits;

export function panelWidth(panel: WorkspacePanel, width: number) {
  const [min, max] = panelLimits[panel];
  return Math.max(min, Math.min(max, Math.round(width)));
}

export function workspacePanels(viewport: number, settings: WorkspacePreferences) {
  const writingWidth = 680;
  const pages = settings.pages && viewport >= writingWidth + settings.pageWidth;
  const subjects = settings.subjects && viewport >= writingWidth + settings.subjectWidth + (settings.pages ? settings.pageWidth : 0);
  return {subjects, pages};
}
