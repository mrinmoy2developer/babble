#!/usr/bin/env python3
"""
piper_server.py — a tiny persistent Piper TTS sidecar for Babble.

Loads voice models ONCE and keeps them resident, so synthesis stays ~20ms
instead of reloading the ~0.5s model on every word. Holds multiple voices in
one process (lazy-loaded on first use), so players can switch voices freely.

Babble (the Node server) spawns and supervises this; you normally don't run it
by hand. Stdlib + piper-tts only.

  GET  /health      -> {"ok": true, "loaded": [...ids...]}
  GET  /voices      -> {"voices": [{"id": "en_US-amy-medium"}, ...]}  (scans dir)
  POST /synthesize  -> body {"voice","text","length_scale","volume"} -> audio/wav

Usage:
  python3 piper_server.py --voices-dir /path/to/voices [--host 127.0.0.1] [--port 5923]
"""

import argparse
import glob
import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper import PiperVoice, SynthesisConfig

VOICES_DIR = ""
_voices = {}                 # id -> PiperVoice (loaded, resident)
_lock = threading.Lock()     # guard model load + synth (onnxruntime: be safe)


def available_ids():
    ids = []
    for p in sorted(glob.glob(os.path.join(VOICES_DIR, "*.onnx"))):
        ids.append(os.path.splitext(os.path.basename(p))[0])
    return ids


def get_voice(vid):
    """Lazy-load and cache a voice by id (<id>.onnx in the voices dir)."""
    with _lock:
        if vid in _voices:
            return _voices[vid]
        path = os.path.join(VOICES_DIR, vid + ".onnx")
        if not os.path.isfile(path):
            return None
        voice = PiperVoice.load(path)
        _voices[vid] = voice
        return voice


def synth_wav(vid, text, length_scale, volume):
    voice = get_voice(vid)
    if voice is None:
        return None
    cfg = SynthesisConfig(length_scale=length_scale, volume=volume)
    buf = io.BytesIO()
    with _lock:  # serialize synthesis (cheap when warm: ~20ms)
        with wave.open(buf, "wb") as w:
            voice.synthesize_wav(text, w, syn_config=cfg)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence per-request stderr spam
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "loaded": list(_voices)})
        elif self.path == "/voices":
            self._json(200, {"voices": [{"id": i} for i in available_ids()]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            text = (req.get("text") or "").strip()
            vid = req.get("voice") or (available_ids() or [None])[0]
            length_scale = req.get("length_scale")
            volume = req.get("volume", 1.0)
            if not text:
                return self._json(400, {"error": "empty text"})
            if not vid:
                return self._json(400, {"error": "no voice available"})
            wav = synth_wav(vid, text, length_scale, volume)
            if wav is None:
                return self._json(404, {"error": f"unknown voice: {vid}"})
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})


def main():
    global VOICES_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices-dir", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5923)
    ap.add_argument("--preload", default="", help="comma-separated voice ids to load at startup")
    args = ap.parse_args()
    VOICES_DIR = os.path.expanduser(args.voices_dir)

    for vid in filter(None, (v.strip() for v in args.preload.split(","))):
        get_voice(vid)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"piper_server ready on http://{args.host}:{args.port} "
          f"voices={available_ids()} preloaded={list(_voices)}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
