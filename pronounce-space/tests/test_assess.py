"""Tests without the real model: torch is stubbed and the phone posteriors are
synthesised from the phones a test says were "heard"."""

import json
import sys
import types

import numpy as np
import pytest

# ── stub torch (the real one is only needed to run the model) ──
_torch = types.ModuleType("torch")
_torch.cuda = types.SimpleNamespace(is_available=lambda: False)
_torch.device = lambda name: name
_torch.set_num_threads = lambda n: None
sys.modules.setdefault("torch", _torch)

sys.path.insert(0, __file__.rsplit("/tests/", 1)[0])
import assess  # noqa: E402
from openpronounce import phones  # noqa: E402

VOCAB = ["<pad>", "<s>", "</s>", "<unk>"] + sorted(set(
    "p b t d k ɡ f v θ ð s z ʃ ʒ h m n ŋ l ɹ j w tʃ dʒ ɪ i ʊ u ɛ æ a ʌ ɑ ɒ ɔ ə ɚ ɜ eɪ aɪ aʊ oʊ əʊ ɔɪ eə ɪə oː".split()))


def posteriors(heard, strong=None):
    """Log posteriors that decode to ``heard``: two frames per phone, a blank between.
    ``strong`` maps a frame-phone index to an extra phone given 0.3 posterior there."""
    for p in list(heard) + list((strong or {}).values()):
        if p not in VOCAB:
            VOCAB.append(p)          # phones espeak produced that the list above lacks
    frames = []
    for k, p in enumerate(heard):
        for _ in range(2):
            row = np.full(len(VOCAB), -12.0, dtype=np.float32)
            row[VOCAB.index(p)] = np.log(0.95)
            if strong and k in strong:
                row[VOCAB.index(strong[k])] = np.log(0.3)
            frames.append(row)
        blank = np.full(len(VOCAB), -12.0, dtype=np.float32)
        blank[0] = np.log(0.95)
        frames.append(blank)
    return np.stack(frames)


def us(text):
    _, groups = phones.get_expected_phones(text, "en")
    return [p for g in groups for p in g]


def gb(text):
    _, groups = phones.get_expected_phones(text, "en-gb")
    return [p for g in groups for p in g]


class FakeModel:
    """Each sample of the fake waveform holds the index of the word spoken there,
    so the model knows which words a chunk covers and 'hears' them via ``hear``."""

    blank = 0

    @property
    def vocab(self):
        return tuple(VOCAB)

    def __init__(self, words, hear):
        self.words, self.hear, self.calls = words, hear, []

    def posteriors(self, wave):
        idx = sorted({int(v) for v in np.unique(wave) if v >= 0})
        self.calls.append(idx)
        heard = []
        for i in idx:
            heard += self.hear(i, self.words[i])
        return posteriors(heard)


def timed(text, step=0.5):
    out = []
    for i, w in enumerate(text.split()):
        out.append({"word": w, "start": round(i * step, 2), "end": round(i * step + step * 0.8, 2)})
    return out


def wave_for(words):
    dur = words[-1]["end"] + 0.5
    wave = np.full(int(dur * assess.SR), -1.0, dtype=np.float32)
    for i, w in enumerate(words):
        wave[int(w["start"] * assess.SR):int(w["end"] * assess.SR)] = i
    return wave


def run(text, hear=None, vocab=None, step=0.5):
    words = timed(text, step)
    hear = hear or (lambda i, w: us(w))
    model = FakeModel([w["word"] for w in words], hear)
    return assess.assess(wave_for(words), text, words, vocab, model), model


def test_perfect_answer_has_no_issues():
    res, _ = run("I really enjoy cooking traditional food with my family")
    assert res["issues"] == [] and res["patterns"] == []
    assert res["accuracy"] == 1.0 and res["words_checked"] == 9


def test_dropped_final_consonants_are_a_pattern_but_not_word_flags():
    def hear(i, w):
        p = us(w)
        return p[:-1] if w in ("food", "cats", "likes", "good") else p
    res, _ = run("my sister likes good food and cats", hear)
    keys = {p["key"]: p for p in res["patterns"]}
    assert keys["final_s"]["count"] == 2 and set(keys["final_s"]["words"]) == {"likes", "cats"}
    assert keys["final_cons"]["count"] == 2
    # one dropped final phone is not enough to flag the word itself (upstream leniency)
    assert not any(w["flagged"] for w in res["issues"] if w["word"] == "food")
    assert res["accuracy"] < 1.0


def test_th_as_t():
    def hear(i, w):
        return ["t" if p == "θ" else p for p in us(w)]
    res, _ = run("I think three things are worth it", hear)
    th = next(p for p in res["patterns"] if p["key"] == "th")
    assert th["count"] == 4    # think, three, things, worth
    assert th["vi"].startswith("Âm th")


def test_british_pronunciation_is_accepted():
    text = "I hope you can go to the shop and have a bath"
    res, _ = run(text, lambda i, w: gb(w))
    assert res["flagged"] == 0
    assert all(w["accent"] in ("us", "uk") for w in res["issues"])


def test_real_substitution_is_flagged_with_timing():
    def hear(i, w):
        return ["l", "aɪ", "t"] if w == "right" else us(w)   # right → light-ish
    res, _ = run("you are right about that", hear)
    bad = [w for w in res["issues"] if w["flagged"]]
    assert [w["word"] for w in bad] == ["right"]
    assert bad[0]["start"] == 1.0 and bad[0]["i"] == 2
    assert {"e": "ɹ", "h": "l", "c": 1.0} in bad[0]["phones"]
    assert "r" in bad[0]["patterns"]


def test_plausible_expected_phone_is_not_a_confident_error():
    # heard /t/ for /θ/, but /θ/ itself was also likely (GOP): no confident error
    text = "think"
    heard = ["t", "ɪ", "ŋ", "k"]

    class M(FakeModel):
        def posteriors(self, wave):
            return posteriors(heard, strong={0: "θ"})
    words = timed(text)
    res = assess.assess(wave_for(words), text, words, None, M(["think"], None))
    assert res["patterns"] == [] and res["accuracy"] == 1.0


def test_long_answers_are_cut_into_chunks_at_pauses():
    text = " ".join(["people often spend their weekends with family"] * 6)   # 42 words, ~21 s
    res, model = run(text, step=0.5)
    assert len(model.calls) >= 2
    covered = sorted(i for c in model.calls for i in c)
    assert covered == list(range(42))
    assert res["words_checked"] == 42 and res["issues"] == []


def test_without_timings_whole_recording_is_used():
    text = "it is good"
    model = FakeModel(["it", "is", "good"], None)
    model.posteriors = lambda wave: posteriors(us(text))
    res = assess.assess(np.zeros(assess.SR * 2, dtype=np.float32), text, [], None, model)
    assert res["words_checked"] == 3 and res["issues"] == []


def test_vocab_report():
    def hear(i, w):
        return ["dʒ" if p == "tʃ" else p for p in us(w)] if w == "cheap" else us(w)
    res, _ = run("street food is cheap and tasty", hear,
                 vocab=["street food", "cheap", "mouth-watering"])
    v = {x["item"]: x for x in res["vocab"]}
    assert v["street food"]["used"] and v["street food"]["score"] == 1.0
    assert v["cheap"]["used"] and v["cheap"]["score"] < 1.0
    assert v["mouth-watering"]["used"] is False


def test_too_long_recording_is_refused():
    with pytest.raises(ValueError):
        assess.assess(np.zeros(int(assess.SR * (assess.MAX_AUDIO_SEC + 1)), dtype=np.float32), "x", [], None,
                      FakeModel([], None))


# ── the HTTP layer ──
def test_api(monkeypatch):
    from fastapi.testclient import TestClient
    import app as server

    text = "I think so"
    words = timed(text)
    monkeypatch.setattr(server, "decode", lambda path: wave_for(words))
    server._model = FakeModel([w["word"] for w in words], lambda i, w: ["t" if p == "θ" else p for p in us(w)])
    client = TestClient(server.app)

    r = client.post("/assess", data={"transcript": text, "words": json.dumps(words), "vocab": "[]"},
                    files={"audio": ("a.webm", b"x" * 5000, "audio/webm")},
                    headers={"Origin": "https://l2practice.github.io"})
    assert r.status_code == 200, r.text
    assert r.headers["access-control-allow-origin"] == "https://l2practice.github.io"
    assert r.json()["words_checked"] == 3

    r = client.post("/assess", data={"transcript": text, "words": "{bad"},
                    files={"audio": ("a.webm", b"x" * 5000, "audio/webm")})
    assert r.status_code == 400
    r = client.post("/assess", data={"transcript": text}, files={"audio": ("a.webm", b"x" * 10, "audio/webm")})
    assert r.status_code == 400
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert r.json()["ready"] is True and "access-control-allow-origin" not in r.headers
