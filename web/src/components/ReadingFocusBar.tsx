import { BookOpen, Minimize2 } from 'lucide-react';
import './ReadingFocus.css';

export function ReadingFocusBar({ active, onExit }: { active: boolean; onExit: () => void }) {
  if (!active) return null;

  return (
    <div className="reading-focus-bar" role="group" aria-label="Reading focus controls">
      <span className="reading-focus-status"><BookOpen size={15} aria-hidden="true" /> Reading Focus</span>
      <button className="reading-focus-exit" type="button" onClick={onExit} aria-label="Exit reading focus">
        <Minimize2 size={15} aria-hidden="true" />
        <span>Exit</span>
      </button>
    </div>
  );
}
