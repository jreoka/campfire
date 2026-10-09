#!/usr/bin/env python3
"""Transcribe an audio file with Cactus Whistle (16.9MB, CPU-only).
Usage: whistle-dictate.py <audio-file>
Converts to 16kHz mono WAV via ffmpeg, transcribes, prints text (one line).
"""
import os
import subprocess
import sys
import tempfile

def main():
    if len(sys.argv) != 2:
        print("usage: whistle-dictate.py <audio-file>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    if not os.path.isfile(path):
        print("not found: " + path, file=sys.stderr)
        sys.exit(2)

    model_dir = os.environ.get("WHISTLE_MODEL_DIR", "/app/whistle-models")
    weights = os.path.join(model_dir, "whistle.cact")
    if not os.path.isfile(weights):
        # Fall back to letting needle fetch it (first run without baked model).
        weights = None

    # Whistle wants 16kHz mono WAV.
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wav_path = tf.name
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", path,
             "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
            capture_output=True, timeout=60)
        if r.returncode != 0 or not os.path.isfile(wav_path):
            print("ffmpeg failed: " + r.stderr.decode()[:200], file=sys.stderr)
            sys.exit(3)

        import needle
        kwargs = {"weights": weights} if weights else {}
        result = needle.transcribe(wav_path, **kwargs)
        text = result.get("text", "") if isinstance(result, dict) else str(result)
        print(" ".join(str(text).split()))
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass

if __name__ == "__main__":
    main()
