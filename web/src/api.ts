/** One run of an automation rule, as logged and as reported by the request that caused it. */
export interface AutomationRun { time: string; scope: string; ruleId: string; rule: string; note: string; result: 'ok' | 'error' | 'skipped'; detail: string }
export interface NoteInfo {
  path: string;
  title: string;
  folder: string;
  modified: number;
  created: number | string;
  pinned: boolean;
  icon: string;
  tags: string[];
  excerpt: string;
  links: string[];
  /** Hash of the note body returned by GET /api/note, used for conditional text saves. */
  revision?: string;
  aliases?: string[];
  /** Present when automations ran because of this change. */
  automations?: AutomationRun[];
}
export interface Note extends NoteInfo { content: string; meta: Record<string, unknown>; attachments: Record<string, string>; coverUrl?: string | null }
export interface CanvasInfo { path: string; title: string; folder: string; modified: number }
export interface SearchHit extends NoteInfo { snippet: string }
export interface DocumentHit {path:string;title:string;page:number;snippet:string}
export interface DocumentSearch {available:boolean;running:boolean;totalFiles:number;indexedFiles:number;indexedPages:number;complete:boolean;indexingComplete:boolean;noOCR:boolean;hits:DocumentHit[];error?:string;files?:{path:string;title:string;state:string;indexedPages:number;totalPages:number;searchablePages:number;reason?:string}[]}
export interface BackupStatus {enabled:boolean;localOnly:boolean;destination:string;running:boolean;pending:boolean;lastBackup:{path:string;time:number;files:number;bytes:number;sha256:string}|null;lastError:string;retention:number;archives:number}
export interface Backlink { path: string; title: string; context: string }
export interface Unlinked { path: string; title: string; name: string; context: string }
export interface OutgoingLink { target: string; path: string | null }
export interface Version { id: string; time: number; size: number }
export interface TrashItem { id: string; path: string; deleted: number }
export interface EmbedData {
  found: boolean; target?: string; path?: string; title?: string; heading?: string; content?: string;
  missingHeading?: boolean; attachments?: Record<string, string>;
}
export interface Settings {
  theme: 'light' | 'dark' | 'system'; accent: string; fontSize: number; width: number; snippets: Record<string, boolean>;
  /** Local AI through Ollama. A model name of '' means the built-in default. */
  ai_enabled: boolean; write_model: string; ask_model: string; embed_model: string;
}
export interface SnippetFile { name: string; enabled: boolean; css: string }
export interface SettingsData { settings: Settings; snippets: SnippetFile[]; folder: string }
export interface SavedTab { id: string; kind: 'note' | 'canvas' | 'graph' | 'base' | 'tasks'; path?: string; base?: { folder?: string; tag?: string; title: string } }
/** The tab shown in the right-hand pane, and the share of the width the left pane takes. */
export interface SplitState { tab: string; ratio: number }
export interface Workspace { tabs: SavedTab[]; active?: string; split: SplitState | null }
/** Each save carries only the parts it changes; the server keeps the rest. null removes a part. */
export interface AppState { tabs?: SavedTab[]; active?: string | null; sort?: string; split?: SplitState | null; workspaces?: Record<string, Workspace> }
export interface ImageFile { path: string; name: string; url: string; modified: number }
export interface BulkResult { changed: number; unchanged: number; failed: { path: string; error: string }[]; automations?: AutomationRun[] }
export interface Restored { path: string; kind?: 'folder' | 'canvas' }
export interface TemplateInfo { path: string; title: string }
export interface GraphNode { id: string; label: string; kind: 'note' | 'ghost' | 'tag'; community: number; degree: number; folder: string; tags: string[] }
export interface GraphQuestion { question: string; why: string; type: string; notes: string[] }
export interface GraphPath { found: boolean; path: string[]; labels: string[]; hops?: number }
export interface PublishResult { dest: string; pages: number; tags: number; assets: number; index: string; onlyPublished: boolean }
export interface GraphData {
  nodes: GraphNode[];
  edges: { source: string; target: string; relation: string }[];
  communities: { id: number; label: string; size: number; cohesion: number }[];
  hubs: { id: string; label: string; degree: number }[];
  surprises: { source: string; target: string; bridges: boolean }[];
  engine: string;
}

export type PropType = 'text' | 'number' | 'checkbox' | 'date' | 'list' | 'relation' | 'formula' | 'rollup';
export type PropValue = string | number | boolean | string[] | null | undefined;
export type RollupFn = 'count' | 'sum' | 'min' | 'max';
/** A column of a database. Formulas and rollups are declared here (saved in .cortex/bases.json), never in the notes. */
export interface BaseProperty { key: string; type: PropType; expr?: string; relation?: string; property?: string; fn?: RollupFn }
export interface RelationLink { label: string; path: string | null }
export interface BaseRow {
  path: string; title: string; icon: string; folder: string; modified: number; props: Record<string, PropValue>;
  /** Formula and rollup results, and the reason one failed. */
  computed?: Record<string, PropValue>; errors?: Record<string, string>;
  /** Relation properties with each [[link]] resolved to a note. */
  links?: Record<string, RelationLink[]>;
  /** Gallery and list views only. */
  excerpt?: string; cover?: string;
}
export interface BaseFilter { key: string; op: 'contains' | 'equals' | 'empty' | 'notempty' | 'checked' | 'unchecked'; value: string }
export interface BaseFilters { mode: 'and' | 'or'; items: BaseFilter[] }
export type BaseViewKind = 'table' | 'board' | 'calendar' | 'timeline' | 'gallery' | 'list' | 'chart';
/** Sets one property to one value on every note the database is showing. */
export interface BaseButton { label: string; key: string; value: string | number | boolean | null }
export interface BasePrefs {
  view?: BaseViewKind;
  groupBy?: string;
  dateBy?: string;
  sort?: { key: string; dir: 'asc' | 'desc' };
  columns?: BaseProperty[];
  filters?: BaseFilters;
  chartBy?: string;
  chartKind?: 'bar' | 'donut';
  /** Timeline: start and end date properties ('' = no end) and an optional property to group by ('' = none). */
  startBy?: string;
  endBy?: string;
  timelineBy?: string;
  buttons?: BaseButton[];
  forms?: BaseForm[];
  automations?: AutoRule[];
}
/** What a form asks for: the property it fills (key), its type and how it is shown. */
export type FormFieldType = 'text' | 'select' | 'number' | 'checkbox' | 'date' | 'list' | 'relation';
export interface FormField {
  key: string; label: string; type: FormFieldType; required: boolean; help?: string;
  /** Choices of a select field, or the allowed entries of a list field. */
  options?: string[];
  /** Shown only while another field of the form has this value. */
  showIf?: { key: string; equals: string };
}
export interface BaseForm {
  id: string; name: string; description?: string; fields: FormField[];
  /** The field whose answer names the note ("" = "Response <date time>"). */
  titleField?: string; bodyTemplate?: string; submitLabel: string; successMessage: string;
}
export type FormAnswer = string | number | boolean | string[];
export interface FormPageData { form: BaseForm; database: { folder: string; tag: string; title: string }; titles?: string[] }
export interface FormSubmitted { path: string; title: string; message: string; automations?: AutomationRun[] }

export type AutoTrigger = { type: 'added' } | { type: 'changed'; key: string; value?: string | number | boolean } | { type: 'checked'; key: string };
export type AutoAction =
  | { type: 'set'; key: string; value?: string | number | boolean | null; stamp?: 'today' | 'now' }
  | { type: 'add_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'move'; folder: string }
  | { type: 'apply_template'; template: string }
  | { type: 'create_linked'; template: string; folder?: string; title?: string; linkKey?: string };
/** "When <trigger> then <actions>" for one database. */
export interface AutoRule { id: string; name: string; enabled: boolean; trigger: AutoTrigger; actions: AutoAction[] }

export interface BaseData { scope: string; properties: BaseProperty[]; rows: BaseRow[]; prefs: BasePrefs }
export interface BaseScope { folder?: string; tag?: string }
export interface DiffLine { op: 'same' | 'add' | 'del' | 'gap'; text?: string; old?: number | null; new?: number | null; count?: number }
export interface DiffData { lines: DiffLine[]; added: number; removed: number; identical: boolean; id: string }
export type AiModelKey = 'write_model' | 'ask_model' | 'embed_model';
export type AiStatus = {
  running: boolean; enabled: boolean; models: string[]; missing: string[];
  defaults: Record<AiModelKey, string>;
  index: { indexed: number; total: number; building: boolean; error: string };
} & Record<AiModelKey, string>;
/** How the last sync went: ok, retry (files still arriving), offline (folder missing), passphrase (needed), error. */
export type SyncState = 'ok' | 'retry' | 'offline' | 'passphrase' | 'error';
export interface SyncLast {
  time: number; ok: boolean; state: SyncState; message: string;
  uploaded?: number; downloaded?: number; deleted?: number; renamed?: number; merged?: number; conflicts?: number; pending?: number;
  /** Notes and files this device changed in that sync. */
  paths?: string[];
}
/** A copy of a note kept beside the version that stayed, because both devices changed it. */
export interface SyncConflict { path: string; original: string; device: string; time: number; original_exists: boolean }
export interface SyncStatus {
  configured: boolean; folder: string; vault_id: string; device_name: string; interval: number; auto: boolean;
  encrypted: boolean; needs_passphrase: boolean; keyring: boolean; running: boolean; last: SyncLast | null; conflicts: SyncConflict[];
}
export interface SyncVault { id: string; name: string; encrypted: boolean }
export interface SyncConnect { folder: string; vault_id?: string; passphrase?: string; remember?: boolean; device_name?: string; interval?: number }
export interface FigureConfig {
  kind: 'function' | 'line' | 'bar' | 'diagram'; title: string; theme: 'light' | 'dark';
  numberFormat?: 'english' | 'decimal-comma'; expressions?: string[]; xMin?: number; xMax?: number; data?: string; steps?: string[]; xLabel?: string; yLabel?: string;
}
export interface FigureSaved { id: string; image: string; markdown: string; config: FigureConfig }
export type ImportFormat = 'folder' | 'notion' | 'enex' | 'html' | 'docx' | 'course' | 'markdown' | 'ics';
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';
/** A rectangle on a PDF page, as fractions of the page size (0..1), so it survives any zoom. */
export interface PdfRect { x: number; y: number; w: number; h: number }
export interface PdfHighlight { id: string; page: number; color: HighlightColor; rects: PdfRect[]; text?: string; note?: string }
/** One freehand stroke on a canvas. `points` are flat [x0,y0,x1,y1,…] in canvas coordinates. Kept in .cortex, not in the .canvas file. */
export interface CanvasStroke { id: string; color: string; width: number; points: number[] }
export interface ImportResult { written: number; folder: string; stats: Record<string, number>; warnings?: string[] }

// ---- tasks, blocks, reminders, bookmarks -------------------------------------------------------------------
export type TaskGroup = 'overdue' | 'today' | 'upcoming' | 'nodate' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';
/** A `- [ ]` line of a note, as the server read it. `raw` is the line exactly as written; it is sent back to tick the task so a stale list cannot tick the wrong line. */
export interface TaskItem {
  id: string; path: string; note: string; folder: string; line: number; raw: string; mark: string; done: boolean; text: string;
  due: string | null; time: string | null; priority: TaskPriority | null; tags: string[]; heading: string; depth: number; group: TaskGroup;
}
export interface TaskFilter { tag?: string; folder?: string; path?: string; text?: string; status?: 'open' | 'done' | 'all'; due?: '' | TaskGroup | 'week'; priority?: TaskPriority | '' }
export interface TaskList {
  tasks: TaskItem[]; total: number; counts: Record<TaskGroup, number>; truncated: boolean; today: string;
  /** Choices for the Tasks page's filters; not sent with blocks. */
  tags?: string[]; folders?: string[];
}
export interface TaskToggled { ok: boolean; path: string; line: number; raw: string; done: boolean; changed: boolean; moved: boolean; automations?: AutomationRun[] }

export type BlockKind = 'base' | 'query' | 'tasks';
export interface BlockFailure { ok: false; kind: string; errors: string[] }
export interface BlockQuery {
  ok: true; kind: 'base' | 'query'; view: BaseViewKind | 'list' | 'table'; title: string; scope: string; total: number; shown: number;
  open: { folder: string; tag: string }; properties: BaseProperty[]; rows: BaseRow[];
  /** groupBy, dateBy, chartBy, ... for the view: the block's own, else the ones saved with the database. */
  options: Partial<BasePrefs>;
  spec: { title: string; columns: string[] | null };
}
export interface BlockTasks extends TaskList { ok: true; kind: 'tasks'; spec: { title: string; group: 'due' | 'note' | 'none'; limit: number } }
export type BlockData = BlockFailure | BlockQuery | BlockTasks;

export interface Reminder {
  id: string; kind: 'task' | 'note'; title: string; note: string; path: string; line?: number; raw?: string;
  /** When it was set for, and when it is due now (later after a snooze), as local YYYY-MM-DDTHH:MM. */
  when: string; due: string; allDay: boolean; snoozed: boolean; told: boolean; priority?: TaskPriority | null;
}
export interface ReminderList { due: Reminder[]; upcoming: Reminder[]; now: string }

export interface GraphSettings { tags?: boolean; ghosts?: boolean; local?: boolean; depth?: number; filter?: string; hideOthers?: boolean; colorBy?: 'cluster' | 'folder' | 'tag'; center?: string }
interface BookmarkBase { id: string; title?: string }
export interface NoteBookmark extends BookmarkBase { type: 'note'; path: string }
export interface HeadingBookmark extends BookmarkBase { type: 'heading'; path: string; heading: string }
export interface SearchBookmark extends BookmarkBase { type: 'search'; query: string }
export interface GraphBookmark extends BookmarkBase { type: 'graph'; settings: GraphSettings }
export interface BaseBookmark extends BookmarkBase { type: 'base'; folder: string; tag: string; view?: BaseViewKind }
export type LeafBookmark = NoteBookmark | HeadingBookmark | SearchBookmark | GraphBookmark | BaseBookmark;
export interface GroupBookmark extends BookmarkBase { type: 'group'; title: string; collapsed?: boolean; items: LeafBookmark[] }
export type Bookmark = LeafBookmark | GroupBookmark;
/** A bookmark to add; the server gives it an id. */
export type NewBookmark = Omit<NoteBookmark, 'id'> | Omit<HeadingBookmark, 'id'> | Omit<SearchBookmark, 'id'> | Omit<GraphBookmark, 'id'> | Omit<BaseBookmark, 'id'>;
export interface BookmarkList { items: Bookmark[]; obsidian: { importable: number; skipped: number } }

/** A failed request; `fields` holds the reason for each form field the server rejected. */
export class ApiError extends Error {
  fields?: Record<string, string>;
  status?: number;
  conflict?: { path: string; currentRevision: string | null };
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error || `Request failed (${res.status})`);
    err.fields = data.fields;
    err.status = res.status;
    err.conflict = data.conflict;
    throw err;
  }
  return data as T;
}
const enc = encodeURIComponent;

/** One sheet (tab) of a note. The notebook's primary note is always its first sheet. */
export interface Sheet { path: string; title: string }
/** The sheets of a note. A plain note reports itself as the only sheet with isNotebook false. */
export interface NotebookView { primary: string; isNotebook: boolean; sheets: Sheet[] }

export const api = {
  documentSearch:(query:string,path='')=>call<DocumentSearch>('GET',`/api/documents/search?q=${enc(query)}${path?'&path='+enc(path):''}`),
  documentStatus:()=>call<DocumentSearch>('GET','/api/documents/status'),
  backupStatus:()=>call<BackupStatus>('GET','/api/backups/status'),
  runBackup:()=>call<BackupStatus&{accepted:boolean}>('POST','/api/backups/run',{}),
  previewFigure: (config: FigureConfig) => call<{config: FigureConfig; svg: string; summary: string}>('POST', '/api/figures/preview', config),
  saveFigure: (path: string, config: FigureConfig) => call<FigureSaved>('POST', '/api/figures', {path, config}),
  figure: (id: string) => call<{id: string; config: FigureConfig}>('GET', `/api/figures?id=${enc(id)}`),

  tree: () => call<{ notes: NoteInfo[]; canvases: CanvasInfo[]; folders: string[]; vault: string; notebooks: Record<string, string[]> }>('GET', '/api/tree'),
  notebook: (path: string) => call<NotebookView>('GET', `/api/notebook?path=${enc(path)}`),
  createNotebook: (title: string) => call<Note>('POST', '/api/notebook/create', { title }),
  addSheet: (path: string, title?: string) => call<NotebookView & { created: string }>('POST', '/api/notebook', { path, ...(title ? { title } : {}) }),
  reorderSheets: (primary: string, order: string[]) => call<NotebookView>('POST', '/api/notebook/reorder', { primary, order }),
  removeSheet: (path: string) => call<NotebookView>('DELETE', `/api/notebook/sheet?path=${enc(path)}`),
  note: (path: string) => call<Note>('GET', `/api/note?path=${enc(path)}`),
  save: (path: string, content: string, meta?: Record<string, unknown>, baseRevision?: string) => call<NoteInfo>('PUT', '/api/note', { path, content, meta, ...(baseRevision !== undefined ? { baseRevision } : {}) }),
  create: (folder: string, title: string, content = '') => call<Note>('POST', '/api/note', { folder, title, content }),
  remove: (path: string) => call('DELETE', `/api/note?path=${enc(path)}`),
  move: (from: string, to: string) => call<Note>('POST', '/api/move', { from, to }),
  newFolder: (path: string) => call('POST', '/api/folder', { path }),
  trashFolder: (path: string) => call<{ trashed: number }>('DELETE', `/api/folder?path=${enc(path)}&trash=1`),
  moveFolder: (from: string, to: string) => call<{ path: string; moved: number; rewritten: number }>('POST', '/api/folder/move', { from, to }),
  deleteCanvas: (path: string) => call('DELETE', `/api/canvas?path=${enc(path)}`),
  settings: () => call<SettingsData>('GET', '/api/settings'),
  saveSettings: (s: Settings) => call<SettingsData>('PUT', '/api/settings', s),
  state: () => call<AppState>('GET', '/api/state'),
  saveState: (s: AppState) => call('PUT', '/api/state', s),
  search: (q: string) => call<SearchHit[]>('GET', `/api/search?q=${enc(q)}`),
  base: (s: BaseScope, cards = false) => call<BaseData>('GET', `/api/base?folder=${enc(s.folder ?? '')}&tag=${enc(s.tag ?? '')}${cards ? '&cards=1' : ''}`),
  saveBasePrefs: (s: BaseScope, prefs: BasePrefs) => call<{ ok: boolean; prefs: BasePrefs }>('PUT', '/api/base/prefs', { folder: s.folder ?? '', tag: s.tag ?? '', prefs }),
  form: (id: string) => call<FormPageData>('GET', `/api/form?id=${enc(id)}`),
  submitForm: (id: string, answers: Record<string, FormAnswer>) => call<FormSubmitted>('POST', '/api/form/submit', { id, answers }),
  automationLog: (s: BaseScope) => call<AutomationRun[]>('GET', `/api/automations/log?folder=${enc(s.folder ?? '')}&tag=${enc(s.tag ?? '')}`),
  formUrl: (id: string) => `/form/${enc(id)}`,
  setMeta: (path: string, key: string, value: PropValue) => call<NoteInfo & { meta: Record<string, unknown>; coverUrl: string | null }>('PATCH', '/api/note/meta', { path, key, value: value ?? null }),
  setMetaMany: (paths: string[], key: string, value: BaseButton['value']) => call<BulkResult>('POST', '/api/notes/meta', { paths, key, value }),
  images: () => call<ImageFile[]>('GET', '/api/images'),
  backlinks: (path: string) => call<Backlink[]>('GET', `/api/backlinks?path=${enc(path)}`),
  outgoing: (path: string) => call<OutgoingLink[]>('GET', `/api/outgoing?path=${enc(path)}`),
  unlinked: (path: string) => call<Unlinked[]>('GET', `/api/unlinked?path=${enc(path)}`),
  linkMention: (path: string, target: string) => call<NoteInfo>('POST', '/api/link-mention', { path, target }),
  graph: (tags: boolean) => call<GraphData>('GET', `/api/graph${tags ? '?tags=1' : ''}`),
  graphQuestions: (tags: boolean) => call<GraphQuestion[]>('GET', `/api/graph/questions${tags ? '?tags=1' : ''}`),
  graphPath: (from: string, to: string, tags: boolean, ghosts: boolean) =>
    call<GraphPath>('GET', `/api/graph/path?from=${enc(from)}&to=${enc(to)}&tags=${tags ? 1 : 0}&ghosts=${ghosts ? 1 : 0}`),
  graphCanvas: () => call<{ path: string; notes: number; links: number; groups: number }>('POST', '/api/graph/export', {}),
  graphJsonUrl: (tags: boolean) => `/api/graph/export?format=json${tags ? '&tags=1' : ''}`,
  noteHtmlUrl: (path: string, mode: 'download' | 'print') => `/api/export/html?path=${enc(path)}${mode === 'print' ? '&inline=1&print=1' : ''}`,
  publish: (dest: string, onlyPublished: boolean, graph: boolean) => call<PublishResult>('POST', '/api/publish', { dest, onlyPublished, graph }),
  embed: (target: string) => call<EmbedData>('GET', `/api/embed?target=${enc(target)}`),
  templates: () => call<{ folder: string; templates: TemplateInfo[] }>('GET', '/api/templates'),
  template: (path: string, title: string) => call<{ meta: Record<string, unknown>; content: string }>('POST', '/api/template', { path, title }),
  unique: (folder: string) => call<Note>('POST', '/api/unique', { folder }),
  daily: () => call<Note>('POST', '/api/daily'),
  history: (path: string) => call<Version[]>('GET', `/api/history?path=${enc(path)}`),
  version: (path: string, id: string) => call<{ content: string }>('GET', `/api/version?path=${enc(path)}&id=${enc(id)}`),
  diff: (path: string, id: string) => call<DiffData>('GET', `/api/diff?path=${enc(path)}&id=${enc(id)}`),
  trash: () => call<TrashItem[]>('GET', '/api/trash'),
  restore: (id: string) => call<Restored>('POST', '/api/restore', { id }),
  purge: (id: string) => call('DELETE', `/api/trash?id=${enc(id)}`),
  importFile: async (format: ImportFormat, name: string, body: Blob) => {
    const res = await fetch(`/api/import/${format}?name=${enc(name)}`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
    return data as ImportResult;
  },
  aiStatus: () => call<AiStatus>('GET', '/api/ai/status'),
  syncStatus: () => call<SyncStatus>('GET', '/api/sync'),
  syncInspect: (folder: string) => call<{ folder: string; vaults: SyncVault[] }>('GET', `/api/sync/inspect?folder=${enc(folder)}`),
  syncConnect: (c: SyncConnect) => call<SyncStatus>('POST', '/api/sync/connect', c),
  syncSettings: (s: { device_name?: string; interval?: number; auto?: boolean }) => call<SyncStatus>('PUT', '/api/sync/settings', s),
  syncNow: () => call<SyncStatus>('POST', '/api/sync/now', {}),
  syncPassphrase: (passphrase: string, remember: boolean) => call<SyncStatus>('POST', '/api/sync/passphrase', { passphrase, remember }),
  syncEncryption: (enabled: boolean, passphrase?: string, remember = true) => call<SyncStatus>('POST', '/api/sync/encryption', { enabled, passphrase, remember }),
  syncDisconnect: () => call<SyncStatus>('POST', '/api/sync/disconnect', {}),
  syncConflict: (path: string, action: 'mine' | 'theirs' | 'both') => call<SyncStatus>('POST', '/api/sync/conflict', { path, action }),
  syncBrowse: (initial: string) => call<{ folder: string }>('POST', '/api/sync/browse', { initial }),
  tasks: (f: TaskFilter = {}, limit = 1000) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
    q.set('limit', String(limit));
    return call<TaskList>('GET', `/api/tasks?${q}`);
  },
  toggleTask: (t: Pick<TaskItem, 'path' | 'line' | 'raw'>, done?: boolean) => call<TaskToggled>('POST', '/api/tasks/toggle', { path: t.path, line: t.line, raw: t.raw, done }),
  block: (kind: BlockKind, source: string) => call<BlockData>('POST', '/api/block', { kind, source }),
  reminders: () => call<ReminderList>('GET', '/api/reminders'),
  snoozeReminder: (id: string, minutes?: number, until?: string) => call<ReminderList>('POST', '/api/reminders/snooze', { id, minutes, until }),
  doneReminder: (id: string) => call<ReminderList>('POST', '/api/reminders/done', { id }),
  bookmarks: () => call<BookmarkList>('GET', '/api/bookmarks'),
  saveBookmarks: (items: Bookmark[]) => call<BookmarkList>('PUT', '/api/bookmarks', { items }),
  addBookmark: (item: NewBookmark | { type: 'group'; title: string }, group?: string) => call<BookmarkList>('POST', '/api/bookmarks/add', { item, group }),
  importObsidianBookmarks: () => call<BookmarkList & { added: number }>('POST', '/api/bookmarks/import-obsidian', {}),
  clip: (url: string) => call<Note & { folder: string }>('POST', '/api/clip', { url }),
  pdfHighlights: (path: string) => call<{ highlights: PdfHighlight[] }>('GET', `/api/pdf/highlights?path=${enc(path)}`),
  savePdfHighlights: (path: string, highlights: PdfHighlight[]) => call<{ highlights: PdfHighlight[] }>('PUT', '/api/pdf/highlights', { path, highlights }),
  canvasDrawing: (path: string) => call<{ strokes: CanvasStroke[]; options?: {grid:boolean;axes:boolean} }>('GET', `/api/canvas/drawing?path=${enc(path)}`),
  saveCanvasDrawing: (path: string, strokes: CanvasStroke[]) => call<{ strokes: CanvasStroke[] }>('PUT', '/api/canvas/drawing', { path, strokes }),
  transcribeStatus: () => call<{ available: boolean }>('GET', '/api/transcribe/status'),
  transcribe: (path: string) => call<{ text: string }>('POST', '/api/transcribe', { path }),
  upload: async (file: File) => {
    const res = await fetch(`/api/upload?name=${enc(file.name)}`, { method: 'POST', body: file });
    if (!res.ok) throw new Error('Upload failed');
    return (await res.json()) as { path: string; url: string };
  },
};
