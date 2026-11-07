---
title: Speaking App Pronounce
emoji: 🗣️
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Phone-level pronunciation evidence for free speech
---

# Speaking App — pronunciation service

Checks how a learner pronounced **their own words** in a free-speech answer
(no model answer needed). The Speaking App sends the recording, the Whisper
transcript and its word timings; the service answers, word by word, which
phones the dictionary expects (American and British) and which phones were
actually heard, plus recurring patterns such as dropped final consonants or
/θ/ said as /t/.

* `POST /assess` — multipart: `audio`, `transcript`, `words` (JSON list of
  `{word, start, end}`), `vocab` (JSON list of target words/phrases).
* `GET /health` — `{"ok": true, "ready": true}` once the model is loaded.

Built on the phone recogniser of [OpenPronounce](https://github.com/Halleck45/OpenPronounce)
by Jean-François Lépine (MIT) and `facebook/wav2vec2-lv-60-espeak-cv-ft`.
Results are a lower bound: a word that Whisper heard as a different word
cannot be checked.

Settings (Space → Settings → Variables): `ALLOWED_ORIGINS` (comma-separated,
default `https://l2practice.github.io`), `MAX_QUEUE` (default 12).
