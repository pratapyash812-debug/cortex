import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiStatus } from './api';

// Local AI (Ollama): the writing actions, and a hook that reads the server's newline-delimited JSON streams.

export const WRITE_ACTIONS = [
  { id: 'improve', label: 'Improve' },
  { id: 'shorter', label: 'Shorter' },
  { id: 'longer', label: 'Longer' },
  { id: 'fix', label: 'Fix spelling' },
  { id: 'summarize', label: 'Summarise' },
  { id: 'professional', label: 'Professional' },
  { id: 'casual', label: 'Casual' },
  { id: 'continue', label: 'Continue' },
  { id: 'deep', label: 'Deep answer' },
  { id: 'research', label: 'Search local notes' },
  { id: 'custom', label: 'Custom…' },
] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number]['id'];

export const actionLabel = (id: string) => WRITE_ACTIONS.find(a => a.id === id)?.label ?? id;

export interface AiSource { n: number; path: string; title: string; coverage?: string }
/** Where a question looks: the whole vault, one folder (with its subfolders) or one tag. */
export interface AskScope { folder?: string; tag?: string }
interface AiEvent { text?: string; done?: boolean; error?: string; sources?: AiSource[]; notice?: string; model?: string }

export interface AiRun {
  status: 'idle' | 'running' | 'done' | 'stopped' | 'error';
  text: string;
  error: string;
  sources: AiSource[];
  /** A note from the server about how the answer was found (for example, keyword search only). */
  notice: string;
  /** The model that generated this result, reported by its completed stream, not current settings. */
  model: string;
  /** The submitted Ask question belongs to this run, even while its panel is unmounted. */
  question: string;
}
export const IDLE_RUN: AiRun = { status: 'idle', text: '', error: '', sources: [], notice: '', model: '', question: '' };

/** POSTs a request and calls `onEvent` for each line of the reply as it arrives. */
async function readEvents(path: string, body: unknown, onEvent: (e: AiEvent) => void, signal: AbortSignal) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const flush = (line: string) => { if (line.trim()) onEvent(JSON.parse(line) as AiEvent); };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = pending.indexOf(String.fromCharCode(10))) >= 0) {
      flush(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }
  flush(pending + decoder.decode());
}

/** One streamed AI request at a time: `start` replaces a running one, `stop` keeps what has arrived. */
export function useAiRun() {
  const [run, setRun] = useState<AiRun>(IDLE_RUN);
  const abort = useRef<AbortController | null>(null);

  const start = useCallback(async (path: string, body: unknown) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const question = path === '/api/ai/ask' && body && typeof body === 'object'
      && 'question' in body && typeof body.question === 'string' ? body.question : '';
    setRun({ ...IDLE_RUN, status: 'running', question });
    const update = (fn: (r: AiRun) => AiRun) => { if (!ctl.signal.aborted) setRun(fn); };
    try {
      await readEvents(path, body, ev => {
        if (ev.error) update(r => ({ ...r, status: 'error', error: ev.error! }));
        else if (ev.text) update(r => ({ ...r, text: r.text + ev.text }));
        else if (ev.done) update(r => (r.status === 'running' ? { ...r, status: 'done', sources: ev.sources ?? [], notice: ev.notice ?? '', model: typeof ev.model === 'string' ? ev.model : '' } : r));
      }, ctl.signal);
      update(r => (r.status === 'running' ? { ...r, status: 'error', error: 'The reply stopped early. Try again.' } : r));
    } catch (e) {
      const message = e instanceof TypeError ? 'Cannot reach the Cortex server.' : (e as Error).message;
      update(r => ({ ...r, status: 'error', error: message }));
    }
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    setRun(r => (r.status === 'running' ? { ...r, status: 'stopped' } : r));
  }, []);
  const reset = useCallback(() => { abort.current?.abort(); setRun(IDLE_RUN); }, []);
  useEffect(() => () => abort.current?.abort(), []);
  return { run, start, stop, reset };
}

export type AskRun = ReturnType<typeof useAiRun>;

/** A model name without the registry prefix, for lists. */
export const shortModel = (name: string) => name.replace(/^hf\.co\//, '');

/** Compact result attribution; keep ordinary Ollama tags such as qwen3:4b-instruct. */
export const resultModelLabel = (name: string) => shortModel(name).split('/').pop()!.replace(/-GGUF(?::.*)?$/i, '');

/** One plain sentence about what stops AI from working right now, or '' when nothing does. */
export function aiProblem(status: AiStatus | null, need: 'ask_model' | 'write_model' = 'ask_model'): string {
  if (!status) return '';
  if (!status.enabled) return 'AI is turned off. Turn it on in Settings.';
  if (!status.running) return 'Ollama is not running. Start the Ollama app, then try again.';
  const model = status[need];
  return status.missing.includes(model) ? `The model ${shortModel(model)} is not installed in Ollama. Pick another one in Settings.` : '';
}
