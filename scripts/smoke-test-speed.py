"""0.17 smoke test: speed pass (U4-3). Needs `vite preview` on :4173.

The live numbers (words, key lines) are now worked out per section and remembered per saved doc, and the
heading-set looks are drawn again only when the doc or the set changes. These checks guard against a stale
number or look: counts follow typing in any section, a new highlight, deleting a section and Undo; a repeated
key line under the same section name still counts once; the heading set still decorates after typing and after
switching sets. A 5,000-word note opens with the right count, takes typing, and autosaves within the ~0.8 s debounce.
"""
import os
import random

from playwright.sync_api import expect, sync_playwright

URL = "http://localhost:4173/upsc-notes/"
URL = os.environ.get("UPSC_URL") or URL
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(id) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').get(id); g.onsuccess = () => { q.result.close(); r(g.result || null); }; }; })"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""


def t(text, hl=False):
    return {"type": "text", "text": text, **({"marks": [{"type": "highlight"}]} if hl else {})}


def p(*runs):
    return {"type": "paragraph", "content": list(runs)}


def note(nid, title, sections, look=None):
    n = {"id": nid, "title": title, "subject": "GS2", "topic": "", "template": "blank", "explain": "", "connect": "",
         "nextReview": "2030-01-01", "reviewCount": 0, "lastReviewed": None, "createdAt": 1700000000000,
         "updatedAt": 1700000000000, "deletedAt": None, "folderId": "gen:GS2",
         "sections": [{"id": f"{nid}-{i}", "heading": h, "doc": {"type": "doc", "content": c}} for i, (h, c) in enumerate(sections)]}
    if look:
        n["look"] = look
    return n


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def caret_end_of(page, text):
    page.evaluate("""(t) => { const w = document.createTreeWalker(document.querySelector('#editor') || document.body, NodeFilter.SHOW_TEXT); let n, hit = null;
        while ((n = w.nextNode())) if (n.textContent.includes(t)) hit = n;
        if (!hit) throw new Error('text not found: ' + t);
        const el = hit.parentElement.closest('[contenteditable=true]'); el.focus();
        const r = document.createRange(); r.setStart(hit, hit.textContent.length); r.collapse(true);
        getSelection().removeAllRanges(); getSelection().addRange(r); }""", text)
    page.wait_for_timeout(150)


def select_text(page, text):
    page.evaluate("""(t) => { const root = document.activeElement.closest('.ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let hit = null, n;
        while ((n = w.nextNode())) { const i = n.textContent.lastIndexOf(t); if (i >= 0) hit = [n, i]; }
        if (!hit) throw new Error('text not found: ' + t);
        const r = document.createRange(); r.setStart(hit[0], hit[1]); r.setEnd(hit[0], hit[1] + t.length);
        getSelection().removeAllRanges(); getSelection().addRange(r); }""", text)
    page.wait_for_selector("#bubble:not([hidden])")
    page.wait_for_timeout(150)


def words(page):
    return page.inner_text("#word-count")


def keys(page):
    return page.inner_text("#keyline-count")


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")

    # ---------- live numbers stay right section by section ----------
    small = note("speed-counts", "Speed counts", [
        ("Alpha", [{"type": "heading", "attrs": {"level": 2}, "content": [t("Topic one")]}, p(t("one "), t("two three", True), t(" four five"))]),
        ("Beta", [p(t("six "), t("seven", True), t(" eight"))]),
        ("Alpha", [p(t("nine", True), t(" "), t("two three", True))]),
    ], look={"cover": "none", "headings": "banner", "accent": None})
    page.evaluate(IDB_PUT, small)
    page.goto(URL + "#/n/speed-counts")
    page.wait_for_selector("#word-count")
    page.wait_for_timeout(600)
    check(words(page) == "13 words", f"opens with every section counted ({words(page)})")
    check(keys(page) == "3 key lines", f"a key line repeated under the same section name counts once ({keys(page)})")
    h2 = page.locator(".section-body h2").first
    check(h2.get_attribute("data-look") == "banner", f"the note's heading set decorates its heading ({h2.get_attribute('data-look')})")

    caret_end_of(page, "seven")
    page.keyboard.press("End")
    page.keyboard.type(" alpha beta")
    page.wait_for_timeout(300)
    check(words(page) == "15 words", f"typing in the second section updates the count ({words(page)})")
    saved(page)
    n = page.evaluate(NOTE, "speed-counts")
    check("alpha beta" in str(n["sections"][1]["doc"]) and n["sections"][0]["doc"] == small["sections"][0]["doc"], "the typing is saved in its own section, the others are kept as they were")

    select_text(page, "beta")
    page.click("#bubble button[aria-label='Highlight']")
    page.wait_for_function("() => !document.querySelector('.sweep, .sweeping')", timeout=3000)
    page.wait_for_timeout(200)
    check(keys(page) == "4 key lines", f"a new highlight adds a key line ({keys(page)})")

    page.locator(".sec-menu-btn").nth(2).click()
    page.click(".popover button[aria-label='Delete section 3']")
    page.click(".popover button[aria-label='Delete section 3']")
    page.wait_for_timeout(300)
    check(page.locator(".note-section").count() == 2 and words(page) == "12 words" and keys(page) == "3 key lines",
          f"deleting a section takes its words and key lines off ({words(page)}, {keys(page)})")
    page.locator(".section-body .rich").first.click()
    page.keyboard.press("Control+z")
    page.wait_for_timeout(300)
    check(page.locator(".note-section").count() == 3 and words(page) == "15 words" and keys(page) == "4 key lines",
          f"Undo brings them back ({words(page)}, {keys(page)})")

    caret_end_of(page, "Topic one")
    page.keyboard.type(" again")
    page.wait_for_timeout(300)
    check(h2.get_attribute("data-look") == "banner" and "again" in h2.inner_text(), "the heading keeps its set's look while he types in it")
    check(words(page) == "16 words", f"a heading's words count too ({words(page)})")
    saved(page)
    page.click("#note-more")
    page.click(".popover button[aria-label='Note look']")
    page.wait_for_selector("#look-sheet")
    page.click("#look-headings [data-set='pill']")
    page.wait_for_timeout(200)
    check(h2.get_attribute("data-look") == "pill", f"switching sets redraws the heading at once ({h2.get_attribute('data-look')})")
    page.click("#look-apply")
    page.wait_for_timeout(300)
    saved(page)
    check(page.evaluate(NOTE, "speed-counts")["look"]["headings"] == "pill", "the new set is stored on the note")
    check(h2.get_attribute("data-look") == "pill", "and stays drawn after the sheet closes")

    # ---------- a 5,000-word note ----------
    random.seed(3)
    voc = "parliament constitution federal state union article amendment court review rights policy reform economy".split()
    secs = []
    total = 0
    for i in range(6):
        content = []
        for k in range(14):
            if k % 5 == 0:
                content.append({"type": "heading", "attrs": {"level": 2 if k == 0 else 3}, "content": [t(f"Heading {i} {k}")]})
                total += 3
            line = " ".join(random.choice(voc) for _ in range(60))
            content.append(p(t(line[:200]), t(line[200:260], True), t(line[260:])) if k % 4 == 1 else p(t(line)))
            total += 60
        secs.append((f"Part {i + 1}", content))
    big = note("speed-big", "Speed big", secs)
    page.evaluate(IDB_PUT, big)
    page.goto(URL + "#/n/speed-big")
    page.wait_for_selector("#word-count")
    page.wait_for_timeout(800)
    got = int(words(page).split()[0])
    check(total > 5000 and got == total, f"a {total}-word note opens with its count ({got})")
    caret_end_of(page, "Heading 3 5")
    page.keyboard.press("Enter")
    page.keyboard.type("speed check words")
    page.wait_for_timeout(300)
    check(int(words(page).split()[0]) == total + 3, f"typing in it updates the count ({words(page)})")
    t0 = page.evaluate("performance.now()")
    page.wait_for_function("document.getElementById('save-state').dataset.state === 'saved'", timeout=5000)
    dt = page.evaluate("performance.now()") - t0
    check(dt < 2500, f"autosave lands within the ~0.8 s debounce ({dt + 300:.0f} ms after the last key)")
    n = page.evaluate(NOTE, "speed-big")
    check("speed check words" in str(n["sections"][3]["doc"]), "the typing is in the stored note")

    check(not errors, f"no page errors ({errors[:2]})")
    browser.close()

print(f"\n{'ALL PASS' if not failures else str(len(failures)) + ' FAILED'}")
raise SystemExit(1 if failures else 0)
