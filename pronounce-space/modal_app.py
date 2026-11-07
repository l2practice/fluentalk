"""The pronunciation service on Modal (https://modal.com).

Deploy from this folder:   modal deploy modal_app.py
The address printed at the end (…modal.run) is the service URL for the app.

A container starts when an answer arrives and stops SCALEDOWN seconds after the
last one, so time is only paid while someone is practising. The phone model is
baked into the image, so a cold start loads it from disk (no download).
"""

import modal

PINS = [
    "transformers==4.46.3",
    "phonemizer==3.3.0",
    "Levenshtein==0.26.1",
    "numpy==1.26.4",
    "fastapi==0.115.6",
    "python-multipart==0.0.20",
]
SCALEDOWN = 180      # keep a warm container this long after the last answer (one practice session)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "espeak-ng")
    .pip_install("torch==2.5.1", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install(*PINS)
    .env({"HF_HOME": "/models", "TORCH_THREADS": "4", "PYTHONPATH": "/root"})
    .add_local_dir("openpronounce", "/root/openpronounce", copy=True)
    .run_commands("cd /root && python -c 'from openpronounce.phones import _load_model; _load_model()'")
    .add_local_file("assess.py", "/root/assess.py")
    .add_local_file("app.py", "/root/app.py")
)

app = modal.App("speaking-pronounce", image=image)


# Memory snapshot: the model is loaded once, the container's memory is saved,
# and later cold starts restore it instead of loading 1.2 GB again.
# 4 cores halve the analysis time; billing is per core-second, so the cost
# per answer stays about the same.
@app.cls(cpu=4.0, memory=3072, timeout=600, scaledown_window=SCALEDOWN, max_containers=2,
         enable_memory_snapshot=True)
@modal.concurrent(max_inputs=8)      # requests queue inside the container; one analysis runs at a time
class Service:
    @modal.enter(snap=True)
    def load(self):
        import app as service        # app.py: the FastAPI service (also used by the Docker image)
        service.model()
        self.service = service

    @modal.asgi_app(label="speaking-pronounce-web")
    def web(self):
        return self.service.app
