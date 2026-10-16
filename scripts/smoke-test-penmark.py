"""0.15.0 smoke test (UI-4 U4-2): Mark with the pen + optional haptics. Needs `vite preview` on :4173.

The S Pen is trusted CDP input (`Input.dispatchMouseEvent {pointerType: 'pen'}`, side button = buttons & 2);
a finger is a CDP touch. Covers: the two Settings switches (Mark text with the S Pen on, Vibrate off by
default, 44 px rows, in the backup's settings), a drag snaps to whole words, the preview changes nothing
until the pen lifts, one Undo per stroke, the line lock (a slanted stroke stays on its line; a clear move
to the next line runs on), a second pass removes, a stroke over mixed text adds, the side button removes,
tap = caret, long-press = select the word, a finger and the mouse never mark, a stroke stays in its table
cell, a sketch still draws (and never gets marked), the switch off = no marking, marks are ordinary
highlights (saved, reload), no sweep, the pen's scrolling is off only while it is near, the preview uses the
highlight colour in every theme, haptics off by default then 8 ms on a pen mark, 15 ms on Mark reviewed
and 12 ms on a rating, and the review card's note stays read-only under the pen.
"""
import json
import sys

from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""

# Client box of the nth occurrence of `word` inside the first section's editor.
WORD = """([word, nth, sel]) => { const root = document.querySelectorAll(sel || '.section-body .rich')[0];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n, k = 0;
  while ((n = w.nextNode())) { let i = -1; while ((i = n.data.indexOf(word, i + 1)) >= 0) { if (k++ === nth) {
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const b = r.getClientRects()[0];
    return { x: b.left, y: b.top, w: b.width, h: b.height }; } } } return null; }"""

IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""

MARKS = "() => [...document.querySelectorAll('.section-body .rich mark')].map(m => m.textContent)"
MARK_TOPS = "() => [...new Set([...document.querySelectorAll('.section-body .rich mark')].flatMap(m => [...m.getClientRects()].map(r => Math.round(r.top))))]"


def box(page, word, nth=0):
    b = page.evaluate(WORD, [word, nth, None])
    assert b, f"word {word!r} not on the page"
    return b


def at(b, fx=0.5, dy=0.0):
    return (b["x"] + b["w"] * fx, b["y"] + b["h"] / 2 + dy)


def pen(cdp, page, pts, buttons=1, hold=0, steps=8, release=True):
    """A pen stroke through `pts` (client coords). buttons 2 = drawn with the side button held."""
    base = {"pointerType": "pen", "button": "right" if buttons == 2 else "left", "clickCount": 1}
    x0, y0 = pts[0]
    cdp.send("Input.dispatchMouseEvent", {**base, "type": "mouseMoved", "x": x0, "y": y0, "button": "none", "buttons": 0, "force": 0})
    cdp.send("Input.dispatchMouseEvent", {**base, "type": "mousePressed", "x": x0, "y": y0, "force": 0.5, "buttons": buttons})
    if hold:
        page.wait_for_timeout(hold)
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        for i in range(1, steps + 1):
            cdp.send("Input.dispatchMouseEvent", {**base, "type": "mouseMoved", "x": ax + (bx - ax) * i / steps, "y": ay + (by - ay) * i / steps, "force": 0.5, "buttons": buttons})
    if release:
        xe, ye = pts[-1]
        cdp.send("Input.dispatchMouseEvent", {**base, "type": "mouseReleased", "x": xe, "y": ye, "force": 0, "buttons": 0})
    page.wait_for_timeout(80)


def marks(page):
    return page.evaluate(MARKS)


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def undo_depth_click(page):
    page.click("#note-undo")
    page.wait_for_timeout(80)


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, has_touch=True)
    ctx.add_init_script("window.__buzz = []; Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (ms) => { window.__buzz.push(ms); return true; } });")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    cdp = ctx.new_cdp_session(page)

    # ================= Settings =================
    page.goto(URL + "#/prefs")
    page.wait_for_selector("#pen-block")
    check(page.is_checked("#pref-penmark"), "Settings: 'Mark text with the S Pen' is on by default")
    check(not page.is_checked("#pref-haptics"), "Settings: 'Vibrate on actions' is off by default")
    check("Mark text with the S Pen" in page.inner_text("#pen-block") and "Vibrate on actions" in page.inner_text("#pen-block"), "the Pen & touch card names both switches")
    rows = page.locator("#pen-block label.check").evaluate_all("els => els.map(e => e.getBoundingClientRect().height)")
    check(len(rows) == 2 and min(rows) >= 44, f"both switch rows are ≥ 44 px tall ({rows})")
    ls = page.evaluate("() => [localStorage.getItem('upsc.penMark'), localStorage.getItem('upsc.haptics')]")
    check(ls == [None, None], "opening Settings writes neither setting")

    # ================= a note to mark =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Pen marks")
    ed = page.locator(".section-body .rich").first
    ed.click()
    page.keyboard.type("Rivers of the Deccan plateau flow east into the Bay of Bengal.")
    page.keyboard.press("Enter")
    long = " ".join(["Monsoon winds carry moisture from the Arabian Sea across the Western Ghats every summer."] * 4)
    page.keyboard.type(long)
    page.keyboard.press("Enter")
    page.wait_for_timeout(900)
    saved(page)
    before = json.dumps(page.evaluate(NOTE, "Pen marks")["sections"])

    # ---- hover: the pen's own scrolling is off while it's near ----
    b = box(page, "Deccan")
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "pointerType": "pen", "x": at(b)[0], "y": at(b)[1], "button": "none", "buttons": 0})
    page.wait_for_timeout(50)
    ta = page.locator(".section-body .ProseMirror").first.evaluate("e => [e.classList.contains('pen-near'), getComputedStyle(e).touchAction]")
    check(ta == [True, "none"], f"a hovering pen turns the text's touch scrolling off ({ta})")
    page.wait_for_timeout(1700)
    ta = page.locator(".section-body .ProseMirror").first.evaluate("e => [e.classList.contains('pen-near'), getComputedStyle(e).touchAction]")
    check(ta[0] is False and ta[1] != "none", f"…and back on 1.5 s after the pen is gone ({ta})")

    # ---- preview: nothing changes until the pen lifts ----
    a, z = box(page, "Deccan"), box(page, "flow")
    pen(cdp, page, [at(a, 0.4), at(z, 0.3)], release=False)
    prev = page.evaluate("() => [...document.querySelectorAll('.section-body .pen-mark')].map(e => e.textContent).join('')")
    check(prev == "Deccan plateau flow", f"while the pen is down the preview shows whole words ({prev!r})")
    check(marks(page) == [], "…and nothing is marked yet")
    bg = page.evaluate("() => { const e = document.querySelector('.section-body .pen-mark'); const m = getComputedStyle(document.documentElement).getPropertyValue('--mark').trim(); return [getComputedStyle(e).backgroundColor, m]; }")
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "pointerType": "pen", "x": at(z, 0.3)[0], "y": at(z, 0.3)[1], "button": "left", "buttons": 0, "clickCount": 1})
    page.wait_for_timeout(100)
    check(marks(page) == ["Deccan plateau flow"], f"lifting the pen marks 'Deccan plateau flow' (half words snapped) ({marks(page)})")
    check(page.locator(".section-body .pen-mark").count() == 0, "the preview is gone after the stroke")
    check(page.locator(".sweep").count() == 0, "a pen mark has no sweep animation (the pen showed it)")
    real_bg = page.evaluate("() => getComputedStyle(document.querySelector('.section-body .rich mark')).backgroundColor")
    check(bg[0] == real_bg, f"the preview is the highlight colour ({bg[0]} = {real_bg})")

    # ---- one Undo per stroke ----
    undo_depth_click(page)
    check(marks(page) == [] and "Deccan plateau flow" in ed.inner_text(), "one Undo takes the whole stroke back")
    page.click("#note-redo")
    page.wait_for_timeout(80)
    check(marks(page) == ["Deccan plateau flow"], "Redo puts it back")

    # ---- second pass removes ----
    a, z = box(page, "Deccan"), box(page, "flow")
    pen(cdp, page, [at(a, 0.2), at(z, 0.8)])
    rm_prev = marks(page)
    check(rm_prev == [], f"a second pass over the marked words removes the mark ({rm_prev})")
    undo_depth_click(page)
    check(marks(page) == ["Deccan plateau flow"], "Undo brings the mark back (one step)")

    # ---- a stroke that starts on unmarked text adds across the marked words ----
    a, z = box(page, "Rivers"), box(page, "east")
    pen(cdp, page, [at(a, 0.5), at(z, 0.5)])
    check(marks(page) == ["Rivers of the Deccan plateau flow east"], f"starting on unmarked text adds, merging the old mark ({marks(page)})")

    # ---- side button removes, wherever the stroke starts ----
    a, z = box(page, "the", 0), box(page, "plateau")
    pen(cdp, page, [at(a, 0.5), at(z, 0.5)], buttons=2)
    check(marks(page) == ["Rivers of ", " flow east"], f"the side button removes ('the Deccan plateau' un-marked) ({marks(page)})")
    pen(cdp, page, [at(box(page, "Rivers"), 0.1), at(box(page, "east"), 0.9)], buttons=2)
    check(marks(page) == [], "a side-button stroke over the rest clears the line")

    # ---- line lock ----
    moist = page.evaluate(WORD, ["moisture", 0, None])
    line_h = moist["h"]
    a = box(page, "Monsoon", 0)
    b2 = box(page, "Ghats", 0)
    # slanted: ends 0.6 of a line lower, at the far right of the first line
    pen(cdp, page, [at(a, 0.3), (b2["x"] + b2["w"] * 0.5, a["y"] + a["h"] / 2 + 0.6 * line_h)])
    tops = page.evaluate(MARK_TOPS)
    m = marks(page)
    check(len(tops) == 1 and m and m[0].startswith("Monsoon winds") and m[0].endswith("Ghats"), f"a slanted stroke stays on its line ({m}, {len(tops)} line(s))")
    undo_depth_click(page)
    # clear move to the next line: runs on like a selection
    second = page.evaluate("""() => { const p = document.querySelectorAll('.section-body .rich p')[1]; const r = document.createRange(); r.selectNodeContents(p);
      const rects = [...r.getClientRects()]; const tops = [...new Set(rects.map(x => Math.round(x.top)))]; return tops; }""")
    check(len(second) >= 2, f"the long paragraph wraps ({len(second)} lines)")
    a = box(page, "winds", 0)
    pen(cdp, page, [at(a, 0.5), (a["x"] + 40, a["y"] + a["h"] / 2 + 1.0 * (second[1] - second[0]))])
    tops = page.evaluate(MARK_TOPS)
    check(len(tops) >= 2, f"a clear move to the next line marks across both lines ({len(tops)} lines)")
    m = marks(page)
    check(len(m) == 1 and m[0].startswith("winds"), f"…starting at the first word ({m[0][:30] if m else m!r})")
    undo_depth_click(page)
    check(marks(page) == [], "Undo clears it")

    # ---- tap = caret, long-press = select the word ----
    b = box(page, "Bengal")
    pen(cdp, page, [at(b, 0.5)], steps=1)
    sel = page.evaluate("() => { const s = getSelection(); return [s.isCollapsed, s.anchorNode && s.anchorNode.textContent.includes('Bengal'), document.activeElement.classList.contains('ProseMirror')]; }")
    check(sel == [True, True, True], f"a pen tap puts the caret in the word ({sel})")
    check(marks(page) == [], "a tap marks nothing")
    page.keyboard.type("X")
    check("BenXgal" in ed.inner_text() or "BengXal" in ed.inner_text() or "BeXngal" in ed.inner_text(), "typing goes where the pen tapped")
    page.keyboard.press("Backspace")
    b = box(page, "plateau")
    pen(cdp, page, [at(b, 0.5), (at(b, 0.5)[0] + 2, at(b, 0.5)[1])], hold=650, steps=2)
    s = page.evaluate("() => getSelection().toString()")
    check(s == "plateau", f"a long-press selects the word ({s!r})")
    check(marks(page) == [], "a long-press marks nothing")

    # ---- a finger and the mouse never mark ----
    a, z = box(page, "Rivers"), box(page, "Bay")
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": at(a)[0], "y": at(a)[1]}]})
    for i in range(1, 9):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": at(a)[0] + (at(z)[0] - at(a)[0]) * i / 8, "y": at(a)[1]}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(100)
    check(marks(page) == [] and page.locator(".section-body .pen-mark").count() == 0, "a finger drag never marks")
    page.mouse.move(*at(a))
    page.mouse.down()
    page.mouse.move(*at(z), steps=6)
    page.mouse.up()
    s = page.evaluate("() => getSelection().toString()")
    check(marks(page) == [] and "Deccan" in s, f"a mouse drag selects as before ({s!r})")

    # ---- saved as an ordinary highlight, survives reload ----
    a, z = box(page, "Bay"), box(page, "Bengal")
    pen(cdp, page, [at(a, 0.5), at(z, 0.5)])
    page.wait_for_timeout(900)
    saved(page)
    n = page.evaluate(NOTE, "Pen marks")
    hl = [t["text"] for s_ in n["sections"] for blk in s_["doc"]["content"] for t in blk.get("content", []) if any(mk["type"] == "highlight" for mk in t.get("marks", []))]
    check(hl == ["Bay of Bengal"], f"stored as an ordinary highlight mark ({hl})")
    page.reload()
    page.wait_for_selector(".section-body .rich mark")
    check(marks(page) == ["Bay of Bengal"], "the mark is there after a reload")
    ed = page.locator(".section-body .rich").first

    # ---- haptics: off = silent; on = 8 ms on a pen mark ----
    check(page.evaluate("() => window.__buzz") == [], "haptics off: no vibration")
    page.goto(URL + "#/prefs")
    page.wait_for_selector("#pref-haptics")
    page.click("label[for='pref-haptics']")
    check(page.evaluate("() => localStorage.getItem('upsc.haptics')") == "on", "switching Vibrate on is saved")
    check(page.evaluate("() => window.__buzz") == [12], "switching it on gives a sample buzz")
    page.goto(URL + "#/notes")
    page.goto(URL + f"#/n/{n['id']}")
    page.wait_for_selector(".section-body .rich mark")
    page.evaluate("() => { window.__buzz = []; }")
    a = box(page, "Rivers")
    pen(cdp, page, [at(a, 0.2), at(a, 0.9)])
    check(page.evaluate("() => window.__buzz") == [8], f"haptics on: a pen mark buzzes 8 ms ({page.evaluate('() => window.__buzz')})")
    page.evaluate("() => { window.__buzz = []; }")
    pen(cdp, page, [at(box(page, "Bengal"), 0.5)], steps=1)
    check(page.evaluate("() => window.__buzz") == [], "a tap doesn't buzz")
    page.click("#mark-reviewed")
    page.wait_for_timeout(600)
    bz = page.evaluate("() => window.__buzz")
    check(bz[:1] == [15] and all(8 <= x <= 20 for x in bz), f"Mark reviewed buzzes 15 ms ({bz})")
    page.wait_for_timeout(500)

    # ---- the switch off: the pen doesn't mark ----
    page.goto(URL + "#/prefs")
    page.wait_for_selector("#pref-penmark")
    page.click("label[for='pref-penmark']")
    check(page.evaluate("() => localStorage.getItem('upsc.penMark')") == "off", "switching pen marking off is saved")
    page.goto(URL + "#/notes")
    page.goto(URL + f"#/n/{n['id']}")
    page.wait_for_selector(".section-body .rich mark")
    m0 = marks(page)
    a, z = box(page, "Monsoon"), box(page, "carry")
    pen(cdp, page, [at(a, 0.5), at(z, 0.5)])
    check(marks(page) == m0 and page.locator(".section-body .pen-mark").count() == 0, "switched off: a pen stroke marks nothing")
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "pointerType": "pen", "x": at(a)[0], "y": at(a)[1], "button": "none", "buttons": 0})
    check(not page.locator(".section-body .ProseMirror").first.evaluate("e => e.classList.contains('pen-near')"), "switched off: the pen scrolls the text as before")
    page.goto(URL + "#/prefs")
    page.wait_for_selector("#pref-penmark")
    page.click("label[for='pref-penmark']")
    check(page.evaluate("() => localStorage.getItem('upsc.penMark')") == "on", "switched back on")

    # ================= table cell fence + sketch =================
    page.goto(URL + "#/notes")
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Pen fences")
    ed = page.locator(".section-body .rich").first
    ed.click()
    page.keyboard.type("Above the table.")
    page.keyboard.press("Enter")
    page.keyboard.type("/sketch")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.wait_for_selector(".section-body .sketch-paper")
    page.keyboard.type("Below the sketch.")
    page.keyboard.press("Enter")
    page.keyboard.type("/table")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.wait_for_selector("#table-dialog")
    page.click("#table-insert")
    page.wait_for_selector(".section-body table")
    page.locator(".section-body table th").first.click()
    page.keyboard.type("Fundamental rights")
    page.keyboard.press("Tab")
    page.keyboard.type("Directive principles")
    page.wait_for_timeout(300)
    a, z = box(page, "Fundamental"), box(page, "principles")
    pen(cdp, page, [at(a, 0.5), at(z, 0.5)])
    check(marks(page) == ["Fundamental rights"], f"a stroke stays in the table cell it started in ({marks(page)})")
    a = box(page, "Below")
    pen(cdp, page, [at(a, 0.5), at(z, 0.5)])
    m = marks(page)
    check("Below the sketch" in m and not any("Directive" in x for x in m), f"a stroke from above never runs into the table ({m})")

    # sketch: the pen still draws, nothing gets marked
    page.wait_for_timeout(300)
    m_before = marks(page)
    sb = page.locator(".section-body .sketch-paper").first.bounding_box()
    pen(cdp, page, [(sb["x"] + sb["width"] * 0.2, sb["y"] + sb["height"] * 0.5), (sb["x"] + sb["width"] * 0.6, sb["y"] + sb["height"] * 0.5)])
    page.wait_for_timeout(900)
    saved(page)
    nn = page.evaluate(NOTE, "Pen fences")
    sk = [blk for s_ in nn["sections"] for blk in s_["doc"]["content"] if blk["type"] == "sketchBlock"]
    check(sk and len(sk[0]["attrs"]["strokes"]) == 1, f"a pen stroke on a sketch still draws ({len(sk[0]['attrs']['strokes']) if sk else 'no sketch'})")
    check(marks(page) == m_before, "…and marks nothing")

    # ================= every theme: the preview is the highlight colour =================
    bad = []
    page.goto(URL + "#/prefs")
    page.wait_for_selector("#theme-block")
    tids = page.locator("#theme-block [data-theme-opt]").evaluate_all("els => els.map(e => e.dataset.themeOpt)")
    for tid in tids:
        page.evaluate("(t) => localStorage.setItem('upsc.theme', t)", tid)
        page.goto(URL + f"#/n/{n['id']}")
        page.reload()
        page.wait_for_selector(".section-body .rich mark")
        a, z = box(page, "Monsoon"), box(page, "carry")
        pen(cdp, page, [at(a, 0.5), at(z, 0.5)], release=False)
        c = page.evaluate("() => [getComputedStyle(document.querySelector('.section-body .pen-mark')).backgroundColor, getComputedStyle(document.querySelector('.section-body .rich mark')).backgroundColor]")
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "pointerType": "pen", "x": at(z)[0], "y": at(z)[1], "button": "left", "buttons": 0, "clickCount": 1})
        page.wait_for_timeout(100)
        page.click("#note-undo")
        if c[0] != c[1]:
            bad.append((tid, c))
    check(len(tids) >= 9 and not bad, f"the pen preview is the theme's highlight colour in all {len(tids)} themes ({bad})")
    page.evaluate("() => localStorage.removeItem('upsc.theme')")

    # ================= review session: read-only card, 12 ms on a rating =================
    rec = page.evaluate(NOTE, "Pen marks")
    rec["nextReview"] = "2000-01-01"
    page.evaluate(IDB_PUT, rec)
    page.goto(URL + "#/review/notes")
    page.reload()
    page.wait_for_selector("#rv-show")
    page.keyboard.press("Space")
    page.wait_for_selector("#rv-answer")
    page.wait_for_selector(".rv-note .rich mark")
    page.wait_for_timeout(300)
    rv_marks = page.evaluate("() => [...document.querySelectorAll('.rv-note mark')].map(m => m.textContent)")
    b = page.evaluate(WORD, ["table", 0, ".rv-note .rich"])
    if b:
        pen(cdp, page, [at(b, 0.5), (b["x"] + b["w"] + 30, b["y"] + b["h"] / 2)], release=False)
        prev = page.locator(".rv-note .pen-mark").count()
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "pointerType": "pen", "x": b["x"] + b["w"] + 30, "y": b["y"] + b["h"] / 2, "button": "left", "buttons": 0, "clickCount": 1})
        page.wait_for_timeout(300)
    check(b is not None and prev == 0 and page.evaluate("() => [...document.querySelectorAll('.rv-note mark')].map(m => m.textContent)") == rv_marks,
          f"the review card's note is read-only: the pen marks nothing there ({b is not None}, {rv_marks})")
    page.evaluate("() => { window.__buzz = []; }")
    page.keyboard.press("3")
    page.wait_for_timeout(500)
    bz = page.evaluate("() => window.__buzz")
    check(bz == [12], f"haptics on: a rating buzzes 12 ms ({bz})")

    check(not errors, f"no page errors ({errors[:3]})")
    browser.close()

print(f"\n{'ALL PASS' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)
