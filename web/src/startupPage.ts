import type {AppState, Note, NoteInfo} from './api';

/** Try the remembered page without putting the full library on its critical path. */
export async function loadStartupPage(
  state: Promise<AppState>,
  library: Promise<{notes: NoteInfo[]}>,
  read: (path: string) => Promise<Note>,
  createFirst: () => Promise<Note>,
  stillStarting: () => boolean,
): Promise<Note | undefined> {
  const saved = await state.catch((): AppState => ({}));
  if (!stillStarting()) return;
  const page = saved.tabs?.find(tab => tab.id === saved.active && tab.kind === 'note' && tab.path)
    ?? saved.tabs?.find(tab => tab.kind === 'note' && tab.path);
  if (page?.path) {
    const opened = await read(page.path).catch(() => undefined);
    if (opened || !stillStarting()) return opened;
  }

  const {notes} = await library;
  if (!stillStarting()) return;
  if (!notes.length) return createFirst();
  const recent = notes.reduce((latest, note) => note.modified > latest.modified ? note : latest);
  return read(recent.path);
}
