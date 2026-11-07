"""Pronunciation evidence service for the Speaking App (Hugging Face Space).

POST /assess   multipart: audio (webm/mp4/wav…), transcript, words (JSON), vocab (JSON)
GET  /health   {"ok": true, "ready": <model loaded>}

One analysis runs at a time (the free CPU has 2 cores); the others wait their
turn, and when the queue is long the client is told to come back later.
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

import assess

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pronounce")
torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "2")))

ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://l2practice.github.io,http://localhost:8099").split(",") if o.strip()]
MAX_BYTES = 12 * 1024 * 1024
MAX_QUEUE = int(os.environ.get("MAX_QUEUE", "12"))

@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=model, daemon=True).start()   # load the model while the Space wakes up
    yield


app = FastAPI(title="Speaking App pronunciation service", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"],
                   expose_headers=["Retry-After"])

_model = None
_model_lock = threading.Lock()
_gate = asyncio.Semaphore(1)
_waiting = 0


def model():
    global _model
    with _model_lock:
        if _model is None:
            log.info("loading the phone model")
            _model = assess.Model()
            log.info("phone model ready")
    return _model


@app.get("/health")
def health():
    return {"ok": True, "ready": _model is not None, "queue": _waiting}


def decode(path):
    """Any browser recording → 16 kHz mono float32 (ffmpeg)."""
    res = subprocess.run(
        [shutil.which("ffmpeg") or "ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le",
         "-ac", "1", "-ar", str(assess.SR), "-"],
        capture_output=True, timeout=60, check=False)
    if res.returncode != 0:
        raise ValueError("could not decode the recording")
    return np.frombuffer(res.stdout, dtype=np.float32).copy()


def _json_list(text):
    if not text:
        return []
    try:
        value = json.loads(text)
    except ValueError:
        raise HTTPException(400, "words/vocab must be JSON lists")
    if not isinstance(value, list):
        raise HTTPException(400, "words/vocab must be JSON lists")
    return value


@app.post("/assess")
async def api_assess(audio: UploadFile = File(...), transcript: str = Form(""),
                     words: str = Form(""), vocab: str = Form("")):
    global _waiting
    word_list, vocab_list = _json_list(words), _json_list(vocab)
    if len(transcript) > 20000 or len(word_list) > 3000:
        raise HTTPException(413, "transcript too long")
    data = await audio.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "recording too large")
    if len(data) < 1000:
        raise HTTPException(400, "recording too short")
    if _waiting >= MAX_QUEUE:
        raise HTTPException(503, "busy, try again later", headers={"Retry-After": "60"})

    _waiting += 1
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".audio")
    try:
        tmp.write(data)
        tmp.close()
        wave = await run_in_threadpool(decode, tmp.name)
        async with _gate:
            return await run_in_threadpool(assess.assess, wave, transcript, word_list, vocab_list, model())
    except ValueError as e:
        raise HTTPException(400, str(e))
    except HTTPException:
        raise
    except Exception:
        log.exception("assessment failed")
        raise HTTPException(500, "assessment failed")
    finally:
        _waiting -= 1
        try:
            os.remove(tmp.name)
        except OSError:
            pass
