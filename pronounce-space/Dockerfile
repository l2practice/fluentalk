# Pronunciation evidence service for the Speaking App — Hugging Face Docker Space, CPU.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models TORCH_THREADS=2

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg espeak-ng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt ./
RUN pip install -r requirements.txt

# The phone model (~1.2 GB) is baked into the image, so a cold start does not download it.
COPY openpronounce ./openpronounce
RUN python -c "from openpronounce.phones import _load_model; _load_model()" && chmod -R a+rX /models

COPY assess.py app.py ./
RUN useradd -m -u 1000 user
USER user
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
