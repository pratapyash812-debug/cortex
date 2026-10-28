import { useRef, useState } from 'react';
import { api, type Note, type NoteInfo, type PropValue } from './api';
import type { EditorHandle } from './components/Editor';

/**
 * One open note and its saving: the note itself, the text being typed, and the debounced save.
 * Each pane of the window has its own session, so two notes side by side never share a save timer.
 */
export function useNoteSession(onSaved: (info: NoteInfo) => void, onSaveError: (error: unknown) => void = () => {}) {
  const [note, setNote] = useState<Note | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved'|'saving'|'error'>('saved');
  const noteRef = useRef<Note | null>(null);
  const generationRef = useRef(0);
  const revisionRef = useRef<{ path: string; generation: number; revision?: string; content: string } | null>(null);
  noteRef.current = note;
  const contentRef = useRef('');
  const timer = useRef<number | undefined>(undefined);
  const dirtyRef = useRef<{ path: string; content: string } | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingWritesRef = useRef(0);
  const editorRef = useRef<EditorHandle | null>(null);

  const persist = (path: string, content: string, meta?: Record<string, unknown>, captureLatest = false) => {
    // Count intent synchronously, including time spent waiting behind another
    // save. A clean-body pin is still unsafe to abandon before its write settles.
    pendingWritesRef.current++;
    setSaveStatus('saving');
    // Retain the revision owner itself, not just its initial revision. Queued
    // writes for an old pane load must still follow each other's successful
    // revisions after the user opens a different note.
    const owner = revisionRef.current?.path === path && revisionRef.current.generation === generationRef.current
      ? revisionRef.current : null;
    const ownsCurrent = () => owner !== null && revisionRef.current === owner
      && generationRef.current === owner.generation && noteRef.current?.path === path;
    const save = async () => {
      let savedContent = content;
      if (captureLatest && ownsCurrent()) {
        captureEditor();
        savedContent = contentRef.current;
      }
      // A delayed editor notification or a second flush may repeat a body that
      // the ordered writer already acknowledged. Do not write it again.
      if (owner && owner.content === savedContent && !meta) {
        if (ownsCurrent() && dirtyRef.current?.content === savedContent) dirtyRef.current = null;
        return;
      }
      const info = await api.save(path, savedContent, meta, owner?.revision);
      if (owner) owner.revision = info.revision;
      if (owner) owner.content = savedContent;
      if (ownsCurrent() && dirtyRef.current?.path === path && dirtyRef.current.content === savedContent) dirtyRef.current = null;
      onSaved(info);
      return info;
    };
    const pending = saveQueue.current.then(save, save);
    saveQueue.current = pending.then(() => undefined, () => undefined);
    return pending.catch(error => { setSaveStatus('error'); onSaveError(error); throw error; }).finally(() => {
      pendingWritesRef.current--;
      if (!pendingWritesRef.current && !dirtyRef.current) setSaveStatus('saved');
    });
  };

  const cancelSave = () => { window.clearTimeout(timer.current); timer.current = undefined; };

  /** Capture edits before Milkdown's delayed notification, including on window close. */
  const captureEditor = () => {
    const current = noteRef.current;
    const generation = generationRef.current;
    const editor = editorRef.current;
    // markdownUpdated is debounced inside Milkdown. Read the current ProseMirror
    // document before switching tabs so a just-typed edit is included even if
    // its callback has not reached onChange yet.
    if (current && editor?.path === current.path) {
      const snapshot = editor.readMarkdown();
      if (snapshot !== null && generationRef.current === generation && noteRef.current?.path === current.path && snapshot !== contentRef.current) {
        contentRef.current = snapshot;
        dirtyRef.current = { path: current.path, content: snapshot };
      }
    }
    return dirtyRef.current;
  };

  /** Save now if an edit is waiting. */
  const flush = async () => {
    const pending = captureEditor();
    cancelSave();
    if (pending) await persist(pending.path, pending.content);
    await saveQueue.current;
  };

  /** The editor changed: save shortly after typing stops. */
  const onChange = (path: string, generation: number, md: string) => {
    // A Milkdown update can be delivered after its editor was replaced. Never
    // infer the destination from the currently open note: the update belongs to
    // the exact note load that created that editor.
    if (generationRef.current !== generation || noteRef.current?.path !== path) return;
    if (md === contentRef.current) return;
    contentRef.current = md;
    dirtyRef.current = md === revisionRef.current?.content && !pendingWritesRef.current ? null : { path, content: md };
    setSaveStatus(dirtyRef.current || pendingWritesRef.current ? 'saving' : 'saved');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      if (generationRef.current === generation && noteRef.current?.path === path && dirtyRef.current) void persist(path, md).catch(() => {});
    }, 600);
  };

  /** Show a note (replacing the one open). */
  const load = (n: Note) => {
    cancelSave();
    generationRef.current++;
    revisionRef.current = { path: n.path, generation: generationRef.current, revision: n.revision, content: n.content };
    dirtyRef.current = null;
    editorRef.current = null;
    contentRef.current = n.content;
    noteRef.current = n;
    setNote(n);
    setSaveStatus('saved');
  };
  const clear = () => { cancelSave(); generationRef.current++; revisionRef.current = null; dirtyRef.current = null; editorRef.current = null; noteRef.current = null; setNote(null); contentRef.current = ''; };

  /** A closing-window request keeps the current load's last acknowledged revision. */
  const unsaved = () => {
    const pending = captureEditor();
    const owner = revisionRef.current;
    return pending && owner?.path === pending.path && owner.generation === generationRef.current && typeof owner.revision === 'string'
      ? { ...pending, baseRevision: owner.revision } : pending;
  };

  /** Pin, icon and the like: saved with the note's text, so a pending edit is not lost. */
  const setMeta = async (meta: Record<string, unknown>) => {
    const n = noteRef.current;
    if (!n) return;
    const generation = generationRef.current;
    captureEditor();
    const content = contentRef.current;
    cancelSave();
    // One queued body+metadata save replaces flush-then-save. Read the latest
    // owned editor at execution so pinning cannot write an older snapshot after
    // a newer autosave completed while the metadata action was waiting.
    await persist(n.path, content, meta, true);
    if (generationRef.current !== generation || noteRef.current?.path !== n.path) return;
    setNote(cur => cur && cur.path === n.path ? { ...cur, meta: { ...cur.meta, ...meta }, ...(meta.pinned !== undefined ? { pinned: !!meta.pinned } : {}), ...(meta.icon !== undefined ? { icon: String(meta.icon) } : {}) } : cur);
  };

  /** Set or remove one frontmatter key through the meta route; the body on disk is never rewritten. */
  const setProp = async (key: string, value: PropValue) => {
    const n = noteRef.current;
    if (!n) return;
    const generation = generationRef.current;
    // This includes the clean flush's await: closing before the property request
    // starts would otherwise see neither a dirty body nor an in-flight save.
    pendingWritesRef.current++;
    try {
      await flush();
      const owner = revisionRef.current;
      const operation = saveQueue.current.then(() => api.setMeta(n.path, key, value));
      saveQueue.current = operation.then(() => undefined, () => undefined);
      const { meta, coverUrl, ...info } = await operation;
      if (owner?.path === n.path) owner.revision = info.revision;
      if (generationRef.current === generation && noteRef.current?.path === n.path) {
        setNote(cur => (cur && cur.path === info.path ? { ...cur, ...info, meta, coverUrl } : cur));
      }
      onSaved(info);
    } finally { pendingWritesRef.current--; }
  };

  /** A file now embedded in the note (a recording): remembered with the note so a reopened page can find it. */
  const addAttachment = (name: string, path: string) =>
    setNote(n => (n ? { ...n, attachments: { ...n.attachments, [name]: path } } : n));

  /** Replace the text with another version (restoring history), saved at once. */
  const replaceContent = async (content: string) => {
    const n = noteRef.current;
    if (!n) return;
    const generation = generationRef.current;
    cancelSave();
    // The visible editor must reflect the requested restore immediately. A
    // navigation/close snapshot during its save must not resurrect old text.
    if (editorRef.current?.path === n.path) editorRef.current.replaceMarkdown(content, true);
    contentRef.current = content;
    dirtyRef.current = { path: n.path, content };
    await persist(n.path, content);
    if (generationRef.current !== generation || noteRef.current?.path !== n.path || captureEditor()) return;
    const saved = await api.note(n.path);
    if (generationRef.current === generation && noteRef.current?.path === n.path && !captureEditor()) load(saved);
  };

  // Keep this separate from unsaved(): a pending property is a close risk,
  // but must never be serialized as a synthetic note-body keepalive request.
  const hasPendingWrites = () => pendingWritesRef.current > 0;

  return { note, saveStatus, noteRef, contentRef, editorRef, hasPendingWrites, generation: generationRef.current, flush, cancelSave, onChange, load, clear, unsaved, persist, setMeta, setProp, addAttachment, replaceContent };
}

export type NoteSession = ReturnType<typeof useNoteSession>;
