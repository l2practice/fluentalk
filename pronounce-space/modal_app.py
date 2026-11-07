"""The pronunciation service on Modal (https://modal.com).

Deploy from this folder:   modal deploy modal_app.py
The address printed at the end (…modal.run) is the service URL for the app.

A container starts when an answer arrives and stops SCALEDOWN seconds after the
last one. Modal bills the cores and memory *reserved* for every second a
container is up, idle or not, so the idle tail is kept short: with the memory
snapshot a cold start takes seconds, which costs less than waiting idle.
The app sends answers in batches (a test part at a time, one request after
another), so one container serves a student.
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
SCALEDOWN = 30       # seconds a container stays up after the last answer (billed while idle)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "espeak-ng")
    .pip_install("torch==2.5.1", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install(*PINS)
    .env({"HF_HOME": "/models", "TORCH_THREADS": "4", "PYTHONPATH": "/root"})   # 4 threads = the 2 cores below
    .add_local_dir("openpronounce", "/root/openpronounce", copy=True)
    .run_commands("cd /root && python -c 'from openpronounce.phones import _load_model; _load_model()'")
    .add_local_file("assess.py", "/root/assess.py")
    .add_local_file("app.py", "/root/app.py")
)

app = modal.App("speaking-pronounce", image=image)


# Memory snapshot: the model is loaded once, the container's memory is saved,
# and later cold starts restore it instead of loading 1.2 GB again.
# cpu=2.0 is 2 physical cores = 4 vCPUs, matching the 4 torch threads (4 cores
# were reserved — and billed — while only 2 did any work).
@app.cls(cpu=2.0, memory=3072, timeout=600, scaledown_window=SCALEDOWN, max_containers=3,
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
