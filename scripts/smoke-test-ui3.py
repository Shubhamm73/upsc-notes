"""UI-3 smoke test: review & recall. Needs `vite preview` on :4173.

Cards from Mark reviewed (cloze context, deterministic ids), the Today queue, session order
(insights and words alternate, notes last), reveal (Space, tap, button, swipe up), Again / Hard /
Easy (buttons, 1/2/3, arrows, mouse and touch swipes; edge and short drags ignored), undo (button
and Ctrl+Z), the whole-note card (read-only, Easy = Mark reviewed: edited highlight keeps its card,
removed one is retired, new one gets a card, re-highlighted one comes back), summary (cards, time,
streak, rings, Keep going), the 40-card limit (notes never capped), filters and the empty state,
streak moments at 7 / 30 with the Settings switch, reduced motion, trash, backup format 2 and import
of format 1 and 2 (no duplicates), and the Dexie v3 schema.

Time is pinned with Playwright's clock: D0 = 12 Oct 2026, D1 = the next day, and so on.
"""
import datetime
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []
errors = []

BASE = datetime.datetime(2026, 10, 12, 10, 0)
T0 = int(BASE.timestamp() * 1000)


def day(n):
    return (BASE + datetime.timedelta(days=n)).strftime("%Y-%m-%d")


def at(n):
    return BASE + datetime.timedelta(days=n)


D0, D1, D2, D4 = day(0), day(1), day(2), day(4)


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


# Logs every element animation (class + duration), so motion checks don't race the animations.
ANIM_LOG = """(() => { window.__anims = []; const o = Element.prototype.animate;
  Element.prototype.animate = function (k, t) { window.__anims.push({ cls: String(this.className && this.className.baseVal !== undefined ? this.className.baseVal : this.className), d: typeof t === 'number' ? t : t && t.duration });
    return o.call(this, k, t); }; })()"""

IDB_ALL = """(store) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const q = r.result.transaction(store).objectStore(store).getAll(); q.onsuccess = () => { r.result.close(); res(q.result); }; };
  r.onerror = () => rej(r.error); })"""
IDB_PUT = """([store, recs]) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction(store, 'readwrite'); for (const x of recs) tx.objectStore(store).put(x);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""
IDB_INFO = """() => new Promise(res => { const r = indexedDB.open('upsc-notes'); r.onsuccess = () => { const d = r.result;
  const t = d.transaction('cards'); const s = t.objectStore('cards');
  const out = { version: d.version, stores: [...d.objectStoreNames], key: s.keyPath, idx: [...s.indexNames] }; d.close(); res(out); }; })"""


def all_(page, store):
    return page.evaluate(IDB_ALL, store)


def put(page, store, recs):
    page.evaluate(IDB_PUT, [store, recs])


def get(page, store, id_):
    return next((r for r in all_(page, store) if r.get("id", r.get("key")) == id_), None)


def cards_by_text(page):
    return {c["text"]: c for c in all_(page, "cards")}


def meta(page, key):
    r = next((m for m in all_(page, "meta") if m["key"] == key), None)
    return r["value"] if r else None


def word(id_, w, meaning, due, **kw):
    return dict(id=id_, word=w, meaning=meaning, uses=[{"sentence": f"Use {w} in an essay.", "context": "Essay"}], synonyms=["alike"], antonyms=["unlike"],
                nextReview=due, reviewCount=0, createdAt=T0, updatedAt=T0, deletedAt=None, **kw)


def para(*runs):
    return {"type": "paragraph", "content": [{"type": "text", "text": t, **({"marks": [{"type": "highlight"}]} if m else {})} for t, m in runs]}


def note(id_, title, subject, due, paras, **kw):
    rec = dict(id=id_, subject=subject, topic="Seeded", title=title, sections=[{"id": id_ + "-s1", "heading": "Notes", "doc": {"type": "doc", "content": paras}}],
               explain="Seeded own words.", connect="", nextReview=due, reviewCount=0, lastReviewed=None, createdAt=T0, updatedAt=T0, deletedAt=None)
    rec.update(kw)
    return rec


def select_text(page, text):
    page.wait_for_timeout(150)
    page.evaluate("""(t) => { const root = document.activeElement.closest('.ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let hit = null, n;
        while ((n = w.nextNode())) { const i = n.textContent.lastIndexOf(t); if (i >= 0) hit = [n, i]; }
        if (!hit) throw new Error('text not found: ' + t);
        const r = document.createRange(); r.setStart(hit[0], hit[1]); r.setEnd(hit[0], hit[1] + t.length);
        getSelection().removeAllRanges(); getSelection().addRange(r); }""", text)
    page.wait_for_selector("#bubble:not([hidden])")
    page.wait_for_timeout(150)


def to_line_end(page):
    page.evaluate("""() => { const s = getSelection(); let el = s.focusNode.nodeType === 1 ? s.focusNode : s.focusNode.parentElement;
        el = el.closest('p'); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }""")
    page.wait_for_timeout(100)


def mark(page, text):
    select_text(page, text)
    page.click("#bubble button[aria-label='Highlight']")
    to_line_end(page)
    # the next select waits until the 200 ms marker sweep is fully gone (layer and decoration)
    page.wait_for_function("() => !document.querySelector('.sweep, .sweeping')", timeout=3000)


# Sets a new selection in the same task, just before the highlight sweep's 230 ms cleanup runs: the cleanup must not
# put the old selection back (0.13: it dispatched before ProseMirror read the pending selectionchange; no bubble).
RACE_HOOK = """(t) => { const o = window.setTimeout;
  window.setTimeout = function (fn, ms, ...a) { if (ms !== 230) return o(fn, ms, ...a); window.setTimeout = o;
    return o(() => { const root = document.querySelector('.section-body .ProseMirror');
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let hit = null, n;
      while ((n = w.nextNode())) { const i = n.textContent.lastIndexOf(t); if (i >= 0) hit = [n, i]; }
      const r = document.createRange(); r.setStart(hit[0], hit[1]); r.setEnd(hit[0], hit[1] + t.length);
      getSelection().removeAllRanges(); getSelection().addRange(r); fn(); }, ms); }; }"""


def mark_then_select(page, text, nxt):
    select_text(page, text)
    page.evaluate(RACE_HOOK, nxt)
    page.click("#bubble button[aria-label='Highlight']")
    page.wait_for_timeout(300)
    try:
        page.wait_for_selector("#bubble:not([hidden])", timeout=1500)
        page.wait_for_function("() => !document.querySelector('.sweep, .sweeping')", timeout=1500)
        return page.evaluate("""(t) => getSelection().toString() === t && [...document.querySelectorAll('.section-body mark')]
          .some(m => m.textContent === %r && getComputedStyle(m).backgroundColor !== 'rgba(0, 0, 0, 0)')""" % text, nxt)
    except Exception:
        return False


def new_ctx(browser, n, **kw):
    ctx = browser.new_context(viewport=kw.pop("viewport", {"width": 1280, "height": 900}), accept_downloads=True, **kw)
    page = ctx.new_page()
    page.clock.set_fixed_time(at(n))
    page.add_init_script(ANIM_LOG)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/")
    page.wait_for_selector(".today-title")
    return ctx, page


def go_day(page, n, hash_="#/"):
    page.clock.set_fixed_time(at(n))
    page.goto(URL + hash_)
    page.reload()


def kind(page):
    cls = page.get_attribute("#rv-card", "class")
    return next((k for k in ("insight", "word", "note") if f"is-{k}" in cls.split()), cls)


def count_is(page, text):
    expect(page.locator("#rv-count")).to_have_text(text, timeout=5000)


def reveal_space(page):
    page.wait_for_selector("#rv-show")  # the card's front is up (the session loads asynchronously)
    page.keyboard.press("Space")
    page.wait_for_selector("#rv-answer")
    page.wait_for_timeout(300)


def labels(page):
    return [page.inner_text(f"#rate-{r} span") for r in ("again", "hard", "easy")]


def mouse_swipe(page, dx, start_dx=0):
    box = page.locator("#rv-card").bounding_box()
    x, y = box["x"] + box["width"] / 2 + start_dx, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, 11):
        page.mouse.move(x + dx * i / 10, y)
        page.wait_for_timeout(16)
    page.mouse.up()


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ================= 1. writing → cards → a full session =================
    ctx, page = new_ctx(browser, 0)
    info = page.evaluate(IDB_INFO)
    check(info["version"] == 40 and "cards" in info["stores"] and info["key"] == "id" and set(info["idx"]) == {"noteId", "due"},
          f"Dexie v4 (0.10; v3 added cards): cards store keyed by id, indexed by noteId and due {info}")

    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Fundamental Rights vs DPSP")
    page.locator(".section-body .rich").first.click()
    # Type first, then mark: a highlight is inclusive, so a line typed after a marked line end would carry it on.
    page.keyboard.type("Under Article 21 the court read Maneka Gandhi 1978 as due process into personal liberty.")
    page.keyboard.press("Enter")
    page.keyboard.type("Minerva Mills 1980 balanced FR and DPSP.")
    page.keyboard.press("Enter")
    page.keyboard.type("Golaknath 1967 said Parliament cannot amend Fundamental Rights.")
    mark(page, "Maneka Gandhi 1978")
    mark(page, "Minerva Mills 1980 balanced FR and DPSP.")
    mark(page, "Golaknath 1967 said Parliament cannot amend Fundamental Rights.")
    page.click("#details summary")
    page.fill("#f-explain", "Rights and principles must be balanced.")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    check(all_(page, "cards") == [], "no cards before the note is marked reviewed")
    page.click("#mark-reviewed")
    expect(page.locator(".toast")).to_contain_text("to your review cards")
    page.wait_for_timeout(800)
    nid = all_(page, "notes")[0]["id"]
    cs = cards_by_text(page)
    check(len(cs) == 3, f"Mark reviewed makes one card per key line ({len(cs)})")
    check(all(c["step"] == 0 and c["due"] == D1 and c["reps"] == 0 and c["retiredAt"] is None and c["id"].startswith(nid + ":") for c in cs.values()),
          "new cards: step 0, due tomorrow, id from the note")
    mk = cs.get("Maneka Gandhi 1978", {})
    check(mk.get("before") == "Under Article 21 the court read" and mk.get("after") == "as due process into personal liberty.", f"card keeps the paragraph around the line {mk.get('before')!r} / {mk.get('after')!r}")
    check(cs.get("Minerva Mills 1980 balanced FR and DPSP.", {}).get("before") == "", "fully marked paragraph has no blank context")
    check([c["pos"] for c in sorted(cs.values(), key=lambda c: c["pos"])] == [0, 1, 2], "cards keep the quick-insight order")
    id_m = cs["Minerva Mills 1980 balanced FR and DPSP."]["id"]
    id_g = cs["Golaknath 1967 said Parliament cannot amend Fundamental Rights."]["id"]
    put(page, "vocab", [word("w-1", "Ubiquitous", "Found everywhere", D1), word("w-2", "Pellucid", "Very clear", D1)])

    # ---- D1: he edits the note before reviewing (cards change only at review time) ----
    go_day(page, 1, "#/notes")
    page.click(".note-card:has-text('Fundamental Rights vs DPSP')")
    page.wait_for_selector("#f-title")
    page.locator(".section-body .rich").first.click()
    select_text(page, "Golaknath 1967 said Parliament cannot amend Fundamental Rights.")
    page.click("#bubble button[aria-label='Highlight']")  # unmark
    to_line_end(page)
    select_text(page, "FR and")
    page.keyboard.type("Fundamental Rights and")
    page.wait_for_timeout(150)
    check(mark_then_select(page, "Article 21", "Minerva Mills"), "a selection made just before the highlight sweep ends is kept: bubble shows, highlight shows")
    to_line_end(page)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    page.wait_for_timeout(300)
    check(len(all_(page, "cards")) == 3 and all(c["retiredAt"] is None for c in all_(page, "cards")), "editing a note does not touch its cards")

    page.goto(URL + "#/")
    expect(page.locator("#due-summary")).to_have_text("6 items · about 4 min", timeout=5000)
    check(" ".join(page.text_content("#due-insights").split()) == "3 key lines" and page.get_attribute("#due-insights", "href") == "#/review/insights", "Today chip: key lines start an insight session")
    check(" ".join(page.text_content("#due-words").split()) == "2 words" and " ".join(page.text_content("#due-notes").split()) == "1 note", "Today chips: words and notes")
    check(page.get_attribute("#start-review", "href") == "#/review", "Start review opens the session")
    check("a key line from Fundamental Rights vs DPSP" in page.inner_text(".due-next"), "Today says what the session starts with")

    page.click("#start-review")
    page.wait_for_selector("#rv-card")
    check(page.locator(".rail").is_hidden() and page.locator(".topline").is_hidden(), "session is full screen (no rail, no top line)")
    count_is(page, "1 of 6")
    check(page.inner_text("#rv-left") == "about 4 min left", "time left shown")
    order = []

    # 1: Maneka (cloze) — Space, Again with "1"
    check(kind(page) == "insight" and page.locator("#rv-cloze .rv-blank").count() == 1, "insight front: paragraph with the line blanked out")
    check("Under Article 21 the court read" in page.inner_text("#rv-cloze") and "Maneka" not in page.inner_text("#rv-card"), "front hides the key line")
    page.evaluate("window.__anims = []")
    reveal_space(page)
    check([a["d"] for a in page.evaluate("window.__anims") if "rv-card" in a["cls"]][:2] == [120, 120], "flip: 120 + 120 ms (240 ms)")
    check(page.inner_text("#rv-answer .rv-line") == "Maneka Gandhi 1978", "back shows the marked line")
    check(labels(page) == ["later today", "tomorrow", "in 3 days"], f"buttons say what each rating does {labels(page)}")
    bh = [page.locator(f"#rate-{r}").bounding_box()["height"] for r in ("again", "hard", "easy")]
    check(min(bh) >= 64, f"rating buttons at least 64 px tall {bh}")
    page.keyboard.press("1")
    count_is(page, "2 of 7")
    c = cards_by_text(page)["Maneka Gandhi 1978"]
    check(c["due"] == D1 and c["step"] == 0 and c["lapses"] == 1 and c["reps"] == 0, "Again: still due today, first interval, lapse counted")
    order.append("I")

    # 2: word 1 — tap the card, ArrowRight = Easy
    check(kind(page) == "word" and page.inner_text(".rv-title") == "Ubiquitous", "word card front: the word")
    fs = page.evaluate("[document.body, document.querySelector('#rv-card'), document.querySelector('.rv-prompt')].map(e => getComputedStyle(e).fontSize)")
    check(fs[0] == fs[1] == fs[2], f"card type class doesn't restyle the card (body, card, prompt font {fs})")
    page.locator("#rv-card .rv-prompt").click()
    page.wait_for_selector("#rv-answer")
    page.wait_for_timeout(300)
    back = page.inner_text("#rv-answer")
    check("Found everywhere" in back and "Use Ubiquitous in an essay." in back and "alike" in back and "unlike" in back, "word back: meaning, sentence, synonyms, antonyms")
    page.evaluate("window.__anims = []")
    page.keyboard.press("ArrowRight")
    count_is(page, "3 of 7")
    w = get(page, "vocab", "w-1")
    check(w["reviewStep"] == 0 and w["nextReview"] == D2 and w["reviewCount"] == 1 and w["lastReviewed"], "word Easy (first review): tomorrow, counted")
    anims = page.evaluate("window.__anims")
    check(any("rv-ghost" in a["cls"] and a["d"] == 200 for a in anims) and any(a["cls"].startswith("rv-card") and a["d"] == 200 for a in anims),
          f"rated card slides out (200 ms) while the next settles in {anims}")
    order.append("W")

    # 3: Minerva (whole paragraph) — Hard, Undo, then a mouse swipe right = Easy
    check(kind(page) == "insight" and page.inner_text("#rv-which") == "Key line 2 of 3 in this section", "no context: says which key line of the section")
    page.click("#rv-show")
    page.wait_for_selector("#rv-answer")
    page.wait_for_timeout(300)
    key_m = "Minerva Mills 1980 balanced FR and DPSP."
    before = cards_by_text(page)[key_m]
    page.click("#rate-hard")
    count_is(page, "4 of 7")
    check(cards_by_text(page)[key_m]["due"] == D2, "Hard on a first-interval card: tomorrow")
    page.click("#rv-undo")
    count_is(page, "3 of 7")
    check(cards_by_text(page)[key_m] == before, "Undo puts the card back exactly as it was")
    check(page.locator("#rv-show").is_visible(), "undone card returns to its front")
    reveal_space(page)
    mouse_swipe(page, 420)
    count_is(page, "4 of 7")
    c = cards_by_text(page)[key_m]
    check(c["step"] == 1 and c["due"] == D4 and c["reps"] == 1, "swipe right = Easy: next interval (3 days)")
    order.append("I")

    # 4: word 2 — short drag springs back, swipe left = Again
    check(kind(page) == "word", "words and insights alternate")
    reveal_space(page)
    mouse_swipe(page, 40)
    page.wait_for_timeout(300)
    check(page.inner_text("#rv-count") == "4 of 7" and page.evaluate("document.querySelector('#rv-card').style.transform") == "", "short drag: springs back, no rating")
    mouse_swipe(page, -420)
    count_is(page, "5 of 8")
    w = get(page, "vocab", "w-2")
    check(w["nextReview"] == D1 and w["reviewStep"] == -1 and w["reviewCount"] == 0, "swipe left = Again: due today, not counted, a new word stays new")
    order.append("W")

    # 5: Maneka again — "3"
    check(kind(page) == "insight" and "Under Article 21" in page.inner_text("#rv-cloze"), "Again card comes back three cards later")
    reveal_space(page)
    check(labels(page) == ["later today", "tomorrow", "in 3 days"], "after Again the card counts from the first interval")
    page.keyboard.press("3")
    count_is(page, "6 of 8")
    c = cards_by_text(page)["Maneka Gandhi 1978"]
    check(c["step"] == 1 and c["due"] == D4 and c["reps"] == 1 and c["lapses"] == 1, "second pass Easy: 3 days, history kept")
    order.append("I")

    # 6: Golaknath — "2", Ctrl+Z, then "3"
    gk = "Golaknath 1967 said Parliament cannot amend Fundamental Rights."
    reveal_space(page)
    before = cards_by_text(page)[gk]
    page.keyboard.press("2")
    count_is(page, "7 of 8")
    page.keyboard.press("Control+z")
    count_is(page, "6 of 8")
    check(cards_by_text(page)[gk] == before, "Ctrl+Z undoes the last rating")
    reveal_space(page)
    page.keyboard.press("3")
    count_is(page, "7 of 8")
    order.append("I")

    # 7: the whole note — read-only back, Easy = Mark reviewed
    check(kind(page) == "note" and page.inner_text(".rv-title") == "Fundamental Rights vs DPSP", "whole-note card comes after the quick cards")
    check("Explain it in your own words" in page.inner_text("#rv-card") and "Rights and principles" not in page.inner_text("#rv-card"), "note front: explain prompt, own words hidden")
    n_before = get(page, "notes", nid)
    reveal_space(page)
    check("Rights and principles must be balanced." in page.inner_text(".rv-own"), "note back: his own words")
    check(page.locator(".rv-note .ProseMirror[contenteditable='false']").count() == 1 and page.locator(".rv-note mark").count() == 3, "note back: the full note, read-only, highlights shown")
    check(labels(page) == ["later today", "tomorrow", "in 3 days"], "note buttons follow its interval")
    box = page.locator(".rv-note").bounding_box()
    page.mouse.move(box["x"] + 20, box["y"] + 10)
    page.mouse.down()
    for i in range(1, 11):
        page.mouse.move(box["x"] + 20 + 42 * i, box["y"] + 10)
        page.wait_for_timeout(16)
    page.mouse.up()
    page.wait_for_timeout(300)
    check(page.inner_text("#rv-count") == "7 of 8", "mouse drag over the note's text selects it, it does not rate")
    page.keyboard.press("3")
    count_is(page, "8 of 8")
    n = get(page, "notes", nid)
    check(n["reviewCount"] == 2 and n["reviewStep"] == 1 and n["nextReview"] == D4 and n["lastReviewed"], "note Easy = Mark reviewed: counted, next interval")
    check(n["sections"] == n_before["sections"] and n["explain"] == n_before["explain"], "rating a note never changes its text")
    check([i["text"] for i in n["insights"]["items"]] == ["Article 21", "Maneka Gandhi 1978", "Minerva Mills 1980 balanced Fundamental Rights and DPSP."], "quick insights rebuilt from the current highlights")
    allc = {c["id"]: c for c in all_(page, "cards")}
    cs = cards_by_text(page)
    check(len(allc) == 4, f"one new card, none deleted ({len(allc)})")
    edited = cs.get("Minerva Mills 1980 balanced Fundamental Rights and DPSP.")
    check(edited is not None and edited["id"] == id_m, "edited highlight keeps its card id")
    check(edited and edited["step"] == 1 and edited["reps"] == 1 and edited["due"] == D4, "edited highlight keeps its review history")
    check(cs[gk]["retiredAt"] is not None and cs[gk]["step"] == 1, "removed highlight: card retired, history kept")
    a21 = cs.get("Article 21")
    check(a21 and a21["step"] == 0 and a21["due"] == D2 and a21["retiredAt"] is None, "new highlight: new card, due tomorrow")
    order.append("N")

    # 8: word 2 again — Hard after Again
    check(kind(page) == "word", "Again word returns at the end")
    reveal_space(page)
    check(labels(page) == ["later today", "tomorrow", "tomorrow"], "new word after Again: Easy is still only tomorrow (forgetting never lengthens the gap)")
    page.evaluate("window.__anims = []")
    page.keyboard.press("2")
    page.wait_for_selector(".rv-summary")
    w = get(page, "vocab", "w-2")
    check(w["nextReview"] == D2 and w["reviewCount"] == 1, "Hard: keeps the interval")
    order.append("W")
    check(order == ["I", "W", "I", "W", "I", "I", "N", "W"], f"session order {order}")

    # summary
    check(page.inner_text(".rv-summary .rv-title") == "Session done", "summary after the last card")
    check(page.inner_text("#rv-sum-cards") == "6" and page.inner_text("#rv-sum-time") == "under a minute", "summary: cards and time")
    check(page.inner_text("#rv-streak") == "2", "summary: streak (Mark reviewed yesterday counts too)")
    check(page.locator("#rv-rings .ring").count() == 1 and "GS1" in page.inner_text("#rv-rings"), "summary: ring for the subject reviewed")
    check(any(a["d"] == 300 for a in page.evaluate("window.__anims")), "summary: streak rolls up in 300 ms")
    check(page.locator("#rv-more").count() == 0 and page.locator("#rv-milestone").count() == 0, "nothing more due, no milestone on day 1")
    page.screenshot(path=str(OUT / "summary.png"))
    page.click("#rv-done")
    expect(page.locator(".today-title")).to_contain_text("all caught up", timeout=5000)
    expect(page.locator(".streak")).to_contain_text("2-day streak")
    check(page.locator(".rail").is_visible(), "leaving the session brings the rail back")

    # ---- backup: format 2+ (3 since 0.9) with cards and review days ----
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    bpath = OUT / "ui3-backup.json"
    dl.value.save_as(bpath)
    bk = json.loads(bpath.read_text())
    check(bk["format"] == 8 and bk["schemaVersion"] == 4, "backup: format 8 (0.14: templates, looks), schema 4")
    check(len(bk["cards"]) == 4 and bk["counts"]["cards"] == 4 and bk["meta"]["reviewDays"] == [D0, D1], "backup carries all cards (retired too) and the review days")

    # ---- D4: re-highlighting a removed line brings its card back ----
    go_day(page, 4, "#/notes")
    page.click(".note-card:has-text('Fundamental Rights vs DPSP')")
    page.wait_for_selector("#f-title")
    page.locator(".section-body .rich").first.click()
    mark(page, gk)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    page.click("#mark-reviewed")
    page.wait_for_timeout(800)
    cs = cards_by_text(page)
    check(cs[gk]["retiredAt"] is None and cs[gk]["step"] == 1 and cs[gk]["id"] == id_g and len(cs) == 4, "re-highlighted line: same card back, history kept")

    # ---- trash: a trashed note's cards leave the queue; delete forever removes them ----
    page.click("#details summary")
    page.click("#note-trash")
    page.wait_for_url("**/#/notes/**")  # 0.10: ← goes to the note's subject
    page.goto(URL + "#/")
    expect(page.locator("#due-summary")).to_have_text("2 items · about 1 min", timeout=5000)
    page.goto(URL + "#/trash")
    page.click(".trash-row button:has-text('Restore')")
    page.wait_for_timeout(400)
    page.goto(URL + "#/")
    # 2 words (due D2) + 4 live cards (Article 21 due D2, three due D4); the note was just reviewed
    expect(page.locator("#due-summary")).to_contain_text("6 items", timeout=5000)
    page.goto(URL + "#/notes")
    page.click(".note-card:has-text('Fundamental Rights vs DPSP')")
    page.click("#details summary")
    page.click("#note-trash")
    page.wait_for_url("**/#/notes/**")  # 0.10: ← goes to the note's subject
    page.goto(URL + "#/trash")
    page.click(".trash-row button:has-text('Delete forever')")
    page.fill(".confirm-input", "DELETE")
    page.click(".confirm-panel button:has-text('Delete forever')")
    page.wait_for_timeout(600)
    check(all_(page, "cards") == [] and all_(page, "notes") == [], "delete forever removes the note's cards")
    ctx.close()

    # ---- import the format-2 backup into a fresh tablet; twice adds nothing ----
    ctx, page = new_ctx(browser, 1)
    page.goto(URL + "#/settings")
    page.set_input_files("#import-file", str(bpath))
    expect(page.locator(".import-result")).to_contain_text("Imported: 3 added", timeout=5000)
    check(sorted(all_(page, "cards"), key=lambda c: c["id"]) == sorted(bk["cards"], key=lambda c: c["id"]), "format 2 import: cards exactly as backed up")
    check(meta(page, "reviewDays") == [D0, D1], "import restores the streak days")
    page.set_input_files("#import-file", str(bpath))
    expect(page.locator(".import-result")).to_contain_text("0 added, 0 updated, 3 already newer here, 0 images, 0 review cards", timeout=5000)
    check(len(all_(page, "cards")) == 4, "importing twice adds no cards")
    page.goto(URL + "#/")
    expect(page.locator(".streak")).to_contain_text("2-day streak", timeout=5000)
    ctx.close()

    # ---- a 0.7 (format 1) backup gets its cards on the note's schedule ----
    old = {"app": "upsc-notes", "format": 1, "schemaVersion": 2, "exportedAt": "2026-10-01T10:00:00.000Z", "counts": {"notes": 1, "vocab": 0, "images": 0},
           "notes": [note("old-1", "Old note", "GS2", "2026-10-20", [para(("Alpha line", True)), para(("Lead in ", False), ("Beta line", True))], reviewCount=3, lastReviewed=T0,
                          insights={"generatedAt": T0, "items": [{"section": "Notes", "text": "Alpha line"}, {"section": "Notes", "text": "Beta line"}]})],
           "vocab": [], "images": []}
    opath = OUT / "format1.json"
    opath.write_text(json.dumps(old))
    ctx, page = new_ctx(browser, 1)
    page.goto(URL + "#/settings")
    page.set_input_files("#import-file", str(opath))
    expect(page.locator(".import-result")).to_contain_text("1 added", timeout=5000)
    check("2 review cards" in page.inner_text(".import-result"), "format 1 import reports the cards it made")
    cs = cards_by_text(page)
    check(set(cs) == {"Alpha line", "Beta line"} and all(c["step"] == 2 and c["due"] == "2026-10-20" for c in cs.values()), "cards take the note's own step and next review")
    check(cs["Beta line"]["before"] == "Lead in", "imported card gets its context from the note")
    check(get(page, "notes", "old-1") == old["notes"][0], "the imported note is stored exactly as in the file")
    page.set_input_files("#import-file", str(opath))
    expect(page.locator(".import-result")).to_contain_text("0 review cards", timeout=5000)
    check(len(all_(page, "cards")) == 2, "re-importing a format 1 backup makes no duplicates")
    hurt = json.loads(json.dumps(bk))
    del hurt["cards"][0]["before"]
    hpath = OUT / "card-missing-field.json"
    hpath.write_text(json.dumps(hurt))
    page.set_input_files("#import-file", str(hpath))
    expect(page.locator(".import-result")).to_contain_text("damaged, so nothing was imported", timeout=5000)
    check(len(all_(page, "notes")) == 1 and len(all_(page, "cards")) == 2, "a card missing a field: nothing imported")
    bad = dict(bk, cards=None)
    del bad["cards"]
    bpath2 = OUT / "damaged.json"
    bpath2.write_text(json.dumps(bad))
    page.set_input_files("#import-file", str(bpath2))
    expect(page.locator(".import-result")).to_contain_text("incomplete or damaged", timeout=5000)
    ctx.close()

    # ================= 2. limit, filters, empty state, read-only note =================
    ctx, page = new_ctx(browser, 1)
    put(page, "vocab", [word(f"w{i:03}", f"Word {i:03}", f"Meaning {i}", D1) for i in range(45)])
    put(page, "notes", [note("n-a", "Polity note", "GS2", D1, [para(("Plain text.", False))]), note("n-b", "Economy note", "GS3", D0, [para(("More text.", False))])])
    page.reload()
    expect(page.locator("#due-summary")).to_contain_text("47 items", timeout=5000)
    page.goto(URL + "#/review/words")
    count_is(page, "1 of 40")
    check(kind(page) == "word", "word filter: only words, 40 at most")
    page.keyboard.press("Escape")
    page.wait_for_selector(".today-title")
    check(page.url.endswith("#/"), "Esc with nothing rated goes back to Today")
    page.goto(URL + "#/review")
    count_is(page, "1 of 42")
    check(page.get_attribute(".rv-progress", "aria-valuemax") == "42", "progress bar knows the size")
    reveal_space(page)
    page.keyboard.press("3")
    count_is(page, "2 of 42")
    page.keyboard.press("Escape")
    page.wait_for_selector(".rv-summary")
    check(page.inner_text(".rv-summary .rv-title") == "Good stopping point", "ending early shows the summary")
    check(page.inner_text("#rv-more") == "Keep going (46 more)", "Keep going counts what is still due")
    page.click("#rv-more")
    count_is(page, "1 of 42")
    check(page.locator("#rv-show").is_visible(), "Keep going starts a fresh session")
    page.click("#rv-show")
    page.click("#rate-easy")  # the moment the buttons appear, mid-flip
    count_is(page, "2 of 42")
    check(True, "a rating tapped as soon as the buttons appear is not dropped")
    page.click("#rv-show")
    page.wait_for_selector("#rv-answer")
    page.keyboard.press("Control+k")
    page.wait_for_selector(".search-overlay input")
    page.keyboard.type("3")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Control+z")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    check(page.locator(".search-overlay").count() == 0 and page.inner_text("#rv-count") == "2 of 42" and page.locator("#rv-answer").count() == 1,
          "keys typed in Ctrl+K search don't rate, undo or end the session")
    page.goto(URL + "#/review/notes")
    count_is(page, "1 of 2")
    check(kind(page) == "note" and page.inner_text(".rv-title") == "Economy note", "notes filter: every due note, most overdue first")
    before = all_(page, "notes")
    reveal_space(page)
    page.keyboard.press("Escape")
    page.wait_for_selector(".today-title")
    page.wait_for_timeout(300)
    check(all_(page, "notes") == before, "viewing a note card without rating changes nothing")
    page.goto(URL + "#/review/insights")
    expect(page.locator("#rv-card")).to_contain_text("No key lines are due right now.", timeout=5000)
    page.click("#rv-done")
    page.wait_for_selector(".today-title")
    ctx.close()

    # ================= 3. streak moments and the Settings switch =================
    ctx, page = new_ctx(browser, 1)
    put(page, "meta", [{"key": "reviewDays", "value": [day(-5 + i) for i in range(6)]}])
    put(page, "vocab", [word("s-1", "Sagacious", "Wise", D1), word("s-2", "Laconic", "Brief", D1)])
    page.reload()
    expect(page.locator(".streak")).to_contain_text("6-day streak", timeout=5000)
    page.goto(URL + "#/review")
    for _ in range(2):
        reveal_space(page)
        page.keyboard.press("3")
        page.wait_for_timeout(250)
    page.wait_for_selector(".rv-summary")
    check(page.locator("#rv-milestone").count() == 1 and "7 days in a row" in page.inner_text("#rv-milestone"), "7-day streak: a quiet line in the summary")
    check(meta(page, "streakMilestones") == {"start": day(-5), "shown": [7]}, "milestone remembered for this streak")
    put(page, "vocab", [word("s-3", "Verbose", "Wordy", D1)])
    page.goto(URL + "#/")
    page.reload()
    page.goto(URL + "#/review")
    reveal_space(page)
    page.keyboard.press("3")
    page.wait_for_selector(".rv-summary")
    check(page.locator("#rv-milestone").count() == 0, "the moment shows once")
    page.goto(URL + "#/prefs")
    page.uncheck("#pref-celebrate")
    put(page, "meta", [{"key": "reviewDays", "value": [day(-28 + i) for i in range(29)]}])
    put(page, "vocab", [word("s-4", "Taciturn", "Quiet", D1)])
    page.reload()
    check(not page.is_checked("#pref-celebrate"), "switch stays off after reload")
    page.goto(URL + "#/review")
    reveal_space(page)
    page.keyboard.press("3")
    page.wait_for_selector(".rv-summary")
    check(page.inner_text("#rv-streak") == "30" and page.locator("#rv-milestone").count() == 0, "switched off: 30-day streak counts, no moment shown")
    ctx.close()

    # ================= 4. reduced motion =================
    ctx, page = new_ctx(browser, 1, reduced_motion="reduce")
    put(page, "vocab", [word("r-1", "Lucid", "Clear", D1)])
    put(page, "notes", [note("r-n", "Motion note", "GS4", D1, [para(("Text.", False))])])
    page.reload()
    page.goto(URL + "#/review")
    page.wait_for_selector("#rv-show")
    page.evaluate("window.__anims = []")
    page.click("#rv-show")
    page.click("#rate-easy")
    count_is(page, "2 of 2")
    check(meta(page, "reviewDays") == [D1], "first rating of the day starts the streak")
    page.click("#rv-undo")
    count_is(page, "1 of 2")
    check(meta(page, "reviewDays") == [], "undoing the day's only rating takes the day back")
    for _ in range(2):
        page.click("#rv-show")
        page.click("#rate-easy")
        page.wait_for_timeout(200)
    page.wait_for_selector(".rv-summary")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(500)
    check(page.locator(".rv-summary").count() == 0 and page.locator("#rv-show").is_visible() and page.inner_text("#rv-count") == "2 of 2",
          "undo from the summary brings the last card back")
    page.click("#rv-show")
    page.click("#rate-easy")
    page.keyboard.press("Control+z")  # at once: the summary is still loading
    page.wait_for_timeout(600)
    check(page.locator(".rv-summary").count() == 0 and page.locator("#rv-show").is_visible(), "undo right after the last card is not painted over by the summary")
    page.click("#rv-show")
    page.click("#rate-easy")
    page.wait_for_selector(".rv-summary")
    check(page.evaluate("window.__anims") == [] and page.locator(".rv-ghost").count() == 0, "reduced motion: no flip, slide, ring sweep or roll")
    ctx.close()

    # ================= 5. touch: portrait tablet and a phone =================
    ctx, page = new_ctx(browser, 1, viewport={"width": 800, "height": 1280}, has_touch=True, is_mobile=True)
    put(page, "vocab", [word("t-1", "Candid", "Frank", D1), word("t-2", "Prudent", "Careful", D1)])
    page.reload()
    page.goto(URL + "#/review")
    page.wait_for_selector("#rv-show")
    check(page.locator(".rail").is_hidden(), "portrait: bottom bar hidden in the session")
    check(page.locator("#rv-show").bounding_box()["height"] >= 64, "Show answer is a 64 px target")
    cdp = ctx.new_cdp_session(page)

    def touch(x0, y0, x1, y1, steps=10):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
        for i in range(1, steps + 1):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / steps, "y": y0 + (y1 - y0) * i / steps}]})
            page.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    box = page.locator("#rv-card").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    touch(cx, cy, cx, cy - 150)
    page.wait_for_selector("#rv-answer")
    check(True, "touch: swipe up shows the answer")
    page.wait_for_timeout(300)
    box = page.locator("#rv-card").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + 60
    touch(cx, cy, cx + 400, cy)
    count_is(page, "2 of 2")
    check(get(page, "vocab", "t-1")["reviewCount"] == 1, "touch: swipe right rates Easy")
    page.tap("#rv-card .rv-prompt")
    page.wait_for_selector("#rv-answer")
    page.wait_for_timeout(300)
    box = page.locator("#rv-card").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + 60
    touch(cx, cy, cx - 400, cy)
    count_is(page, "3 of 3")
    check(get(page, "vocab", "t-2")["nextReview"] == D1, "touch: swipe left rates Again")
    page.screenshot(path=str(OUT / "portrait.png"))
    ctx.close()

    ctx, page = new_ctx(browser, 1, viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    put(page, "vocab", [word("p-1", "Astute", "Shrewd", D1)])
    page.reload()
    page.goto(URL + "#/review")
    page.wait_for_selector("#rv-show")
    page.click("#rv-show")
    page.wait_for_selector("#rv-answer")
    page.wait_for_timeout(300)
    cdp = ctx.new_cdp_session(page)
    box = page.locator("#rv-card").bounding_box()
    check(box["x"] < 24, f"phone: card reaches the edge zone ({box['x']})")
    touch(20, box["y"] + 60, 300, box["y"] + 60)
    page.wait_for_timeout(400)
    check(page.inner_text("#rv-count") == "1 of 1" and get(page, "vocab", "p-1")["reviewCount"] == 0, "swipe from the screen edge (Android back) does not rate")
    overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    check(not overflow, "phone: no sideways scroll")
    ctx.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
