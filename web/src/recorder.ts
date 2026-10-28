import { useEffect, useRef, useState } from 'react';

export type RecorderState = { status: 'idle' } | { status: 'recording'; seconds: number } | { status: 'saving' };

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

const pad = (n: number) => String(n).padStart(2, '0');
/** "Recording 2026-10-26 14-30-05.webm": no characters a file system or a [[link]] would object to. */
export function recordingName(mime: string, at = new Date()): string {
  const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  return `Recording ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}.${ext}`;
}

/** Microphone recording with MediaRecorder. stop() resolves with the recording as a file; cancel() throws it away. */
export function useRecorder() {
  const [state, setState] = useState<RecorderState>({ status: 'idle' });
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<number | undefined>(undefined);

  const release = () => {
    window.clearInterval(ticker.current);
    recorder.current?.stream.getTracks().forEach(t => t.stop());
    recorder.current = null;
  };
  useEffect(() => () => { if (recorder.current?.state === 'recording') recorder.current.onstop = null; release(); }, []);

  /** Asks for the microphone and starts. Rejects with a readable message if that is not possible. */
  const start = async () => {
    if (recorder.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio.');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { throw new Error((e as DOMException).name === 'NotAllowedError' ? 'Microphone access was refused.' : `No microphone is available (${(e as Error).message}).`); }
    const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    recorder.current = r;
    r.start(1000);
    const began = Date.now();
    setState({ status: 'recording', seconds: 0 });
    ticker.current = window.setInterval(() => setState({ status: 'recording', seconds: Math.floor((Date.now() - began) / 1000) }), 500);
  };

  const stop = () => new Promise<File | null>(resolve => {
    const r = recorder.current;
    if (!r) { resolve(null); return; }
    setState({ status: 'saving' });
    r.onstop = () => {
      const type = r.mimeType || 'audio/webm';
      const blob = new Blob(chunks.current, { type });
      release();
      setState({ status: 'idle' });
      resolve(blob.size ? new File([blob], recordingName(type), { type }) : null);
    };
    r.stop();
  });

  const cancel = () => {
    const r = recorder.current;
    if (r) r.onstop = null;
    if (r && r.state !== 'inactive') r.stop();
    release();
    setState({ status: 'idle' });
  };

  return { state, start, stop, cancel };
}
