"""Turn a recording into text with faster-whisper, on this computer, if it is installed.

Cortex does not install or download anything by itself. If the faster-whisper package is missing, the
feature stays off and tells the user the one command that enables it. The speech models are downloaded
by faster-whisper on first use (and cached), so the first transcription needs an internet connection.
"""
from __future__ import annotations

import threading
from pathlib import Path

MODEL = "small"                 # a good speed/quality balance on a laptop CPU
INSTALL_HINT = "Transcription needs the faster-whisper package. Install it once with:  server\\.venv\\Scripts\\pip install faster-whisper"

_model = None
_lock = threading.Lock()


def available() -> bool:
    """True when faster-whisper can be imported (the package is installed)."""
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:           # noqa: BLE001 - any import failure means it is not usable
        return False


def _load():
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel
            _model = WhisperModel(MODEL, device="cpu", compute_type="int8")
        return _model


def transcribe(path: Path) -> str:
    """The spoken text of an audio file. Raises ValueError (a clean 400) when it cannot run."""
    if not available():
        raise ValueError(INSTALL_HINT)
    if not path.is_file():
        raise ValueError("That recording could not be found.")
    try:
        model = _load()
        segments, _info = model.transcribe(str(path), vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
    except ValueError:
        raise
    except Exception as e:      # noqa: BLE001 - surface a readable reason to the user
        raise ValueError(f"The recording could not be transcribed: {e}") from e
    return text or "(no speech was recognised)"
