"""Pronunciation evidence for free (spontaneous) speech.

The learner's own words, as transcribed by Whisper, are the reference: there is
no model answer. For every word we compare the phones the dictionary expects
(espeak, American and British) with the phones a phone recogniser actually heard
in the audio (OpenPronounce's ``phones`` module, MIT). The recogniser has no
vocabulary, so unlike Whisper it does not tidy a mispronounced word into the
right one.

On top of the per-word comparison this module counts *recurring patterns*
(dropped final consonants, /θ/ said as /t/...). A single slip says little, a
pattern repeated across an answer is what a teacher acts on, and counting
patterns lets us stay lenient on single words (no false alarms) while still
catching the errors Vietnamese learners make most.

Blind spot, by design: when a word was so far off that Whisper heard another
word ("ship" written as "sheep"), the reference itself is wrong and the error
is invisible. Results are a lower bound, never a complete list.
"""

import re
import time

import numpy as np

from openpronounce import phones
from openpronounce.languages import LANGUAGES, Language

SR = 16000
FRAME_SEC = 0.02            # wav2vec2: one output frame per 20 ms
CHUNK_SEC = 12.0            # chunks are cut near this length, at a pause
CHUNK_MAX_SEC = 18.0        # ...and never longer than this
PAD_SEC = 0.2               # audio kept around each chunk's first/last word
MAX_AUDIO_SEC = 240.0
# A phone error counts towards a pattern when the recogniser is at least this
# sure of it (error confidence divided by the error's base cost, 0-1).
PATTERN_CERTAINTY = 0.6
# OpenPronounce flags a word when its errors reach 40 % of its phones (or 2 phones).
# One clear substitution in a short word ("right" said "light": 1 of 3) stays under
# that, so a single full-cost substitution this certain flags the word as well.
CLEAR_SUBSTITUTION = 0.9

ACCENTS = ("en", "en-gb")   # "en" is espeak en-us in OpenPronounce


# ── British English, registered next to OpenPronounce's American English ──
def _register_british():
    if "en-gb" in LANGUAGES:
        return
    us = LANGUAGES["en"]
    LANGUAGES["en-gb"] = Language("en-gb", "en-gb", us.asr_model, "English (UK)", us.acoustic_good)
    phones._PHONE_MAP["en-gb"] = dict(phones._PHONE_MAP["en"], **{
        "ɒ": "ɑ",    # LOT: British /ɒ/, recogniser often /ɑ/
        "a": "æ",    # espeak en-gb writes TRAP as /a/
    })
    phones._NEAR_PHONES["en-gb"] = phones._NEAR_PHONES["en"] + [{"əʊ", "oʊ"}, {"eə", "ɛ"}, {"ɪə", "ɪ"}]
    phones.ALTERNATE_PRONUNCIATIONS["en-gb"] = phones.ALTERNATE_PRONUNCIATIONS["en"]


_register_british()


# ── patterns ──
CONSONANTS = set("p b t d k ɡ f v θ ð s z ʃ ʒ h m n ŋ l ɹ r j w tʃ dʒ x".split())

PATTERNS = {
    "final_s":      ("Ending -s / -es dropped",          "Mất âm -s/-es cuối từ (số nhiều, ngôi thứ 3)"),
    "final_cons":   ("Final consonant dropped",           "Mất phụ âm cuối"),
    "th":           ("/θ/ /ð/ (th) said as t, d, s or z", "Âm th /θ/ /ð/ đọc thành t, d, s hoặc z"),
    "sh_s":         ("/ʃ/ and /s/ mixed up",              "Nhầm /ʃ/ và /s/"),
    "dj":           ("/dʒ/ (j) said as z or ʒ",           "Âm /dʒ/ (j) đọc thành z hoặc ʒ"),
    "ch":           ("/tʃ/ (ch) said as ʃ, s or t",       "Âm /tʃ/ (ch) đọc thành ʃ, s hoặc t"),
    "l_n":          ("/l/ and /n/ mixed up",              "Nhầm /l/ và /n/"),
    "r":            ("/r/ said as z, j or l",             "Âm /r/ đọc thành z, j hoặc l"),
    "v":            ("/v/ said as j, b or w",             "Âm /v/ đọc thành j, b hoặc w"),
    "vowel_len":    ("Long/short vowel (ship/sheep)",     "Nguyên âm dài/ngắn (ship/sheep)"),
    "ae":           ("/æ/ said as /ɛ/ (bad/bed)",         "Âm /æ/ đọc thành /ɛ/ (bad/bed)"),
}


def classify(expected, heard, last):
    """Pattern key of one phone error, or None. ``heard`` is the joined heard string ('' = dropped)."""
    if heard == "":
        if last and expected in CONSONANTS:
            return "final_s" if expected in ("s", "z") else "final_cons"
        return None
    if expected in ("θ", "ð") and heard in ("t", "d", "s", "z", "f"):
        return "th"
    if (expected, heard) in (("ʃ", "s"), ("s", "ʃ"), ("ʒ", "z")):
        return "sh_s"
    if expected == "dʒ" and heard in ("z", "ʒ", "j"):
        return "dj"
    if expected == "tʃ" and heard in ("ʃ", "s", "t"):
        return "ch"
    if {expected, heard} == {"l", "n"}:
        return "l_n"
    if expected == "ɹ" and heard in ("z", "j", "l", "ʒ"):
        return "r"
    if expected == "v" and heard in ("j", "b", "w"):
        return "v"
    if {expected, heard} in ({"i", "ɪ"}, {"u", "ʊ"}):
        return "vowel_len"
    if expected == "æ" and heard in ("ɛ", "e"):
        return "ae"
    return None


def _base_cost(expected, heard, last, lang):
    if heard == "":
        return phones.FINAL_DELETION_COST if last else 1.0
    return phones._substitution_cost(expected, heard, lang)


# ── chunking: Whisper words → ≤ CHUNK_MAX_SEC pieces cut at pauses ──
_WORD_RE = phones._WORD_RE


def tokens_of(words):
    """Flatten Whisper words into the tokens OpenPronounce will see, each mapped to its Whisper word."""
    out = []
    for i, w in enumerate(words):
        for tok in _WORD_RE.findall(str(w.get("word", ""))):
            out.append((tok.lower(), i))
    return out


def chunks_of(words, duration):
    """Group Whisper words (with start/end seconds) into chunks; returns lists of word indices."""
    timed = [i for i, w in enumerate(words) if _num(w.get("end")) > _num(w.get("start"), -1)]
    if not timed:
        return []
    chunks, cur = [], [timed[0]]
    for prev, i in zip(timed, timed[1:]):
        span = _num(words[i]["end"]) - _num(words[cur[0]]["start"])
        gap = _num(words[i]["start"]) - _num(words[prev]["end"])
        if span > CHUNK_MAX_SEC or (span > CHUNK_SEC and gap >= 0.15):
            chunks.append(cur)
            cur = []
        cur.append(i)
    chunks.append(cur)
    return chunks


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ── the model, loaded once (tests pass their own posteriors function) ──
class Model:
    def __init__(self):
        processor, _ = phones._load_model()
        self.vocab = phones.phone_vocab()
        self.blank = processor.tokenizer.pad_token_id

    def posteriors(self, wave):
        return phones.phone_log_posteriors(wave, SR)


def _compare_chunk(log_post, vocab, blank, text):
    """Per-word reports for one chunk, each word judged against the closer of the two accents."""
    best = {}
    for lang in ACCENTS:
        recognition = phones.decode_ctc(log_post, vocab, blank, lang)
        for r in phones._word_reports(recognition, text, lang):
            score = r["weighted_edits"] / max(1, len(r["expected"]))
            old = best.get(r["position"])
            if old is None or score < old[0] - 1e-9:
                best[r["position"]] = (score, lang, r)
    return [best[k] for k in sorted(best)]


def assess(wave, transcript, words=None, vocab=None, model=None):
    """Assess a 16 kHz mono waveform against the learner's own transcript.

    ``words``: Whisper words ``[{word, start, end}]`` (seconds), used to cut long
    answers into chunks and to give every word a time in the recording.
    ``vocab``: the teacher's target words/phrases for the question.
    """
    t0 = time.time()
    wave = np.asarray(wave, dtype=np.float32)
    duration = len(wave) / SR
    if duration > MAX_AUDIO_SEC:
        raise ValueError(f"recording longer than {MAX_AUDIO_SEC:.0f} s")
    model = model or Model()

    words = [w for w in (words or []) if isinstance(w, dict)]
    pieces = []          # (audio slice, [(token, whisper index)], offset seconds)
    if words:
        toks = tokens_of(words)
        for idx in chunks_of(words, duration):
            keep = set(idx)
            # pad into the pause around the chunk, never into the neighbouring word
            # (its phones would be heard as extra phones of this chunk's last word)
            first, last = idx[0], idx[-1]
            before = _num(words[first - 1]["end"]) if first > 0 else 0.0
            after = _num(words[last + 1]["start"], duration) if last + 1 < len(words) else duration
            start = max(0.0, before, _num(words[first]["start"]) - PAD_SEC)
            end = min(duration, after, _num(words[last]["end"]) + PAD_SEC)
            ctoks = [t for t in toks if t[1] in keep]
            if ctoks and end > start:
                pieces.append((wave[int(start * SR):int(end * SR)], ctoks, start))
    if not pieces:       # no timings: the whole recording against the whole transcript
        ctoks = [(t.lower(), None) for t in _WORD_RE.findall(transcript or "")]
        if ctoks:
            pieces.append((wave[: int(min(duration, 60.0) * SR)], ctoks, 0.0))

    results, patterns = [], {}
    total_phones = 0
    total_err = 0.0
    for audio, ctoks, offset in pieces:
        if len(audio) < SR * 0.3:
            continue
        log_post = model.posteriors(audio)
        text = " ".join(t for t, _ in ctoks)
        for score, lang, r in _compare_chunk(log_post, model.vocab, model.blank, text):
            tok, wi = ctoks[r["position"]] if r["position"] < len(ctoks) else (r["word"], None)
            n = len(r["expected"])
            total_phones += n
            total_err += r["weighted_edits"]
            edits = r["weighted_edits"]
            flagged = bool(r["distance"]) and (edits / max(1, n) >= phones.PHONE_ERROR_THRESHOLD
                                               or edits >= phones.PHONE_ERROR_MIN_EDITS)
            found = []
            for k, p in enumerate(r["phones"]):
                last = k == len(r["phones"]) - 1
                if p["confidence"] <= 0:
                    continue
                cost = _base_cost(p["expected"], p["heard"], last, lang)
                certainty = p["confidence"] / max(1e-6, cost)
                if cost >= 1.0 and p["heard"] and p["expected"] not in p["heard"] and certainty >= CLEAR_SUBSTITUTION:
                    flagged = True
                key = classify(p["expected"], p["heard"], last)
                if key and certainty >= PATTERN_CERTAINTY:
                    found.append(key)
                    slot = patterns.setdefault(key, {"count": 0, "words": []})
                    slot["count"] += 1
                    if tok not in slot["words"] and len(slot["words"]) < 6:
                        slot["words"].append(tok)
            entry = {
                "word": tok,
                "i": wi,
                "accent": "uk" if lang == "en-gb" else "us",
                "expected": "".join(r["expected"]),
                "heard": "".join(r["actual"]),
                "score": round(1 - min(1.0, score), 3),
                "flagged": flagged,
                "patterns": found,
                "phones": [{"e": p["expected"], "h": p["heard"], "c": round(p["confidence"], 2)}
                           for p in r["phones"] if p["confidence"] > 0],
            }
            if wi is not None and wi < len(words):
                entry["start"] = round(_num(words[wi].get("start")), 2)
                entry["end"] = round(_num(words[wi].get("end")), 2)
            results.append(entry)

    accuracy = 1 - total_err / total_phones if total_phones else None
    out_patterns = [
        {"key": k, "label": PATTERNS[k][0], "vi": PATTERNS[k][1], "count": v["count"], "words": v["words"]}
        for k, v in sorted(patterns.items(), key=lambda kv: -kv[1]["count"])
    ]
    issues = [w for w in results if w["flagged"] or w["patterns"]]
    issues.sort(key=lambda w: w["score"])
    return {
        "version": 1,
        "duration": round(duration, 2),
        "words_checked": len(results),
        "phones_checked": total_phones,
        "accuracy": None if accuracy is None else round(max(0.0, accuracy), 3),
        "flagged": sum(1 for w in results if w["flagged"]),
        "patterns": out_patterns,
        "issues": issues[:40],
        "vocab": vocab_report(vocab, results),
        "seconds": round(time.time() - t0, 2),
        "note": "Lower bound: words Whisper heard as a different word cannot be checked.",
    }


def vocab_report(vocab, results):
    """For each target word/phrase: was it used, and how well was it pronounced."""
    if not vocab:
        return []
    seq = [w["word"] for w in results]
    out = []
    for item in vocab[:40]:
        target = [t.lower() for t in _WORD_RE.findall(str(item))]
        if not target:
            continue
        hits = [i for i in range(len(seq) - len(target) + 1) if seq[i:i + len(target)] == target]
        if not hits:
            out.append({"item": item, "used": False})
            continue
        scored = [results[i + k] for i in hits for k in range(len(target))]
        out.append({
            "item": item,
            "used": True,
            "times": len(hits),
            "score": round(min(w["score"] for w in scored), 3),
            "flagged": any(w["flagged"] for w in scored),
        })
    return out
