"""0.9.0 smoke test (U4-1): the Sketch block. Needs `vite preview` on :4173.

The S Pen is emulated with PointerEvents (pointerType "pen", varying pressure), and also with
trusted CDP pen input; a palm is a touch pointer while the pen draws. A finger drag is a real CDP
touch: it must scroll the note and never draw (unless "Draw with finger" is on).

Covers: Sketch in the slash menu (no "coming soon"), pressure → width, palm rejection, palm-then-pen,
finger scrolls, mouse draws, highlighter, colours and sizes, eraser (tool and S Pen button), Clear
(two taps), note-wide Undo / Redo over strokes and text, More room and the height handle, Left with
text beside, caption, search, saved and redrawn after reload, leaving doesn't rewrite the note,
night ink, PDF, backup format 3 and import, the review card is read-only, and a section written by
a newer version opens read-only instead of blank.
"""
import json
from html import escape
import subprocess
import sys
import tempfile
from pathlib import Path

from pypdf import PdfReader
from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""

# Dispatches pointer events on sketch number `idx`. Each step: [event, pointerType, pointerId, fx, fy, pressure, buttons].
# fx / fy are fractions of the sketch's box. One animation frame between moves, like a real pen.
SEQ = """async ([idx, steps]) => {
  const paper = document.querySelectorAll('.sketch-paper')[idx];
  const r = paper.getBoundingClientRect();
  for (const [name, type, id, fx, fy, p, buttons] of steps) {
    paper.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: type,
      isPrimary: true, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, pressure: p,
      buttons: name === 'pointerup' ? 0 : (buttons ?? 1), button: name === 'pointermove' ? -1 : (buttons === 2 ? 2 : 0) }));
    if (name === 'pointermove') await new Promise(res => requestAnimationFrame(res));
  }
}"""

# Opaque pixels of the sketch's canvas: in a box (fractions), or as the thickness of a horizontal line at column fx.
INK = """([idx, x0, y0, x1, y1]) => {
  const c = document.querySelectorAll('.sketch-ink')[idx]; const g = c.getContext('2d');
  const d = g.getImageData(Math.round(x0 * c.width), Math.round(y0 * c.height), Math.max(1, Math.round((x1 - x0) * c.width)), Math.max(1, Math.round((y1 - y0) * c.height))).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 60) n++; return n; }"""
THICK = """([idx, fx, fy]) => {
  const c = document.querySelectorAll('.sketch-ink')[idx]; const g = c.getContext('2d');
  const x = Math.round(fx * c.width), y = Math.round(fy * c.height);
  const d = g.getImageData(x, Math.max(0, y - 40), 1, 80).data; let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 60) n++; return n / (c.width / document.querySelectorAll('.sketch-paper')[idx].clientWidth); }"""
COLOR_AT = """([idx, fx, fy]) => { const c = document.querySelectorAll('.sketch-ink')[idx]; const g = c.getContext('2d');
  const d = g.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }"""


def line(fy, x0=0.1, x1=0.6, p=0.5, kind="pen", pid=1, n=12, buttons=None):
    pts = [(x0 + (x1 - x0) * i / (n - 1), fy, p) for i in range(n)]
    steps = [["pointerdown", kind, pid, *pts[0], buttons]]
    steps += [["pointermove", kind, pid, *q, buttons] for q in pts[1:]]
    steps += [["pointerup", kind, pid, *pts[-1], buttons]]
    return steps


def sketch(page, title, i=0):
    n = page.evaluate(NOTE, title)
    found = []

    def walk(node):
        if node.get("type") == "sketchBlock":
            found.append(node)
        for c in node.get("content", []):
            walk(c)

    for s in n["sections"]:
        walk(s["doc"])
    return found[i] if len(found) > i else None, n


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def strokes(page, title):
    saved(page)
    sk, _ = sketch(page, title)
    return sk["attrs"]["strokes"] if sk else None


def cdp_drag(cdp, kind, x0, y0, x1, y1, steps=10, force=None):
    """Trusted input: a finger ('touch') or the pen ('pen', pressure = force)."""
    if kind == "touch":
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
        for i in range(1, steps + 1):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / steps, "y": y0 + (y1 - y0) * i / steps}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    else:
        base = {"pointerType": "pen", "button": "left", "clickCount": 1}
        cdp.send("Input.dispatchMouseEvent", {**base, "type": "mouseMoved", "x": x0, "y": y0, "button": "none", "force": 0})
        cdp.send("Input.dispatchMouseEvent", {**base, "type": "mousePressed", "x": x0, "y": y0, "force": force or 0.5, "buttons": 1})
        for i in range(1, steps + 1):
            cdp.send("Input.dispatchMouseEvent", {**base, "type": "mouseMoved", "x": x0 + (x1 - x0) * i / steps, "y": y0 + (y1 - y0) * i / steps, "force": force or 0.5, "buttons": 1})
        cdp.send("Input.dispatchMouseEvent", {**base, "type": "mouseReleased", "x": x1, "y": y1, "force": 0, "buttons": 0})


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, has_touch=True, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    cdp = ctx.new_cdp_session(page)
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")

    # ================= insert =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Monsoon sketch")
    ed = page.locator(".section-body .rich").first
    ed.click()
    page.keyboard.type("Winds reverse direction between seasons.")
    page.keyboard.press("Enter")
    page.keyboard.type("/sk")
    page.wait_for_selector("#insert-menu:not([hidden])")
    opt = page.locator(".insert-opt").first
    check(opt.get_attribute("data-item") == "sketch" and "soon" not in (opt.get_attribute("class") or "") and "coming soon" not in opt.inner_text().lower(),
          f"/sk offers Sketch, no longer 'coming soon' ({opt.inner_text()!r})")
    page.keyboard.press("Enter")
    page.wait_for_selector(".sketch-block .sketch-paper")
    check(page.locator(".sketch-block").count() == 1, "Sketch inserted")
    check(page.locator(".sketch-strip").is_visible(), "a new sketch shows its tools")
    check(page.locator("#ctxbar .ctx-label", has_text="Sketch").is_visible() and not page.locator("#ctxbar button[aria-label='Crop and shape']").is_visible(),
          "context bar: Sketch tools, without Crop & shape")
    pb = page.locator(".sketch-paper").bounding_box()
    check(abs(pb["height"] / pb["width"] - 0.6) < 0.02, f"starts 1000 × 600 ({pb['width']:.0f} × {pb['height']:.0f} px)")
    check(page.locator(".sketch-paper").evaluate("e => getComputedStyle(e).touchAction") in ("pan-x pan-y", "pan-y pan-x"), "a finger may scroll over the sketch (touch-action pan)")
    saved(page)
    sk, _ = sketch(page, "Monsoon sketch")
    check(sk is not None and sk["attrs"]["strokes"] == [] and sk["attrs"]["height"] == 600, f"saved as a sketchBlock in the note ({sk and sk['attrs']})")

    # ================= S Pen: pressure =================
    page.evaluate(SEQ, [0, line(0.2, p=0.1)])
    page.evaluate(SEQ, [0, line(0.4, p=1.0)])
    st = strokes(page, "Monsoon sketch")
    check(len(st) == 2 and all(s.startswith("pen.ink.m:") for s in st), f"two pen strokes saved ({[s[:12] for s in st]})")
    light = page.evaluate(THICK, [0, 0.35, 0.2])
    hard = page.evaluate(THICK, [0, 0.35, 0.4])
    check(light > 0 and hard > light * 2, f"pressure sets the width: light {light:.1f} px, hard {hard:.1f} px")
    check(page.locator(".sketch-paper").evaluate("e => e.classList.contains('pen-near')"), "the pen near the paper switches its scrolling off (touch-action none)")
    check(page.locator(".sketch-paper").evaluate("e => getComputedStyle(e).touchAction") == "none", "touch-action is none while the pen is near")
    page.locator(".sketch-paper").evaluate("e => e.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'pen' }))")
    check(page.locator(".sketch-paper").evaluate("e => getComputedStyle(e).touchAction") != "none", "and back to finger scrolling when the pen leaves")

    # ================= palm rejection =================
    palm_steps = [["pointerdown", "pen", 3, 0.1, 0.6, 0.6, None]]
    for i in range(1, 6):
        palm_steps.append(["pointermove", "pen", 3, 0.1 + i * 0.05, 0.6, 0.6, None])
        if i == 2:
            palm_steps.append(["pointerdown", "touch", 9, 0.7, 0.85, 0.5, None])
        if i > 2:
            palm_steps.append(["pointermove", "touch", 9, 0.7 + (i - 2) * 0.05, 0.85, 0.5, None])
    palm_steps += [["pointerup", "touch", 9, 0.85, 0.85, 0, None], ["pointerup", "pen", 3, 0.35, 0.6, 0, None]]
    page.evaluate(SEQ, [0, palm_steps])
    st = strokes(page, "Monsoon sketch")
    check(len(st) == 3, f"a palm on the paper while the pen draws adds nothing ({len(st)} strokes)")
    check(page.evaluate(INK, [0, 0.66, 0.8, 0.95, 0.9]) == 0, "no ink where the palm moved")
    check(page.evaluate(INK, [0, 0.1, 0.57, 0.35, 0.63]) > 50, "the pen's line is there")
    page.evaluate(SEQ, [0, line(0.75, x0=0.65, x1=0.9, kind="touch", pid=11)])
    check(len(strokes(page, "Monsoon sketch")) == 3 and page.evaluate(INK, [0, 0.6, 0.7, 0.95, 0.8]) == 0, "a finger alone never draws")

    # a real finger drag over the sketch scrolls the note (trusted touch input)
    for _ in range(30):
        page.keyboard.press("End")
    ed.locator("p").last.click()
    page.keyboard.press("Control+End")
    for i in range(40):
        page.keyboard.type(f"Line {i} after the sketch.")
        page.keyboard.press("Enter")
    saved(page)
    page.locator(".sketch-block").scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    top0 = page.locator(".sketch-paper").bounding_box()["y"]
    b = page.locator(".sketch-paper").bounding_box()
    cdp_drag(cdp, "touch", b["x"] + b["width"] * 0.5, b["y"] + b["height"] * 0.8, b["x"] + b["width"] * 0.5, b["y"] + b["height"] * 0.8 - 250)
    page.wait_for_timeout(400)
    top1 = page.locator(".sketch-paper").bounding_box()["y"]
    check(top0 - top1 > 100, f"a finger drag on the sketch scrolls the note ({top0:.0f} → {top1:.0f})")
    check(len(strokes(page, "Monsoon sketch")) == 3, "and draws nothing")
    page.locator(".sketch-block").scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    # trusted pen input (CDP) with pressure
    b = page.locator(".sketch-paper").bounding_box()
    cdp_drag(cdp, "pen", b["x"] + b["width"] * 0.1, b["y"] + b["height"] * 0.9, b["x"] + b["width"] * 0.5, b["y"] + b["height"] * 0.9, force=0.8)
    st = strokes(page, "Monsoon sketch")
    check(len(st) == 4 and st[-1].startswith("pen."), f"a trusted pen stroke (CDP pen input) draws ({len(st)} strokes)")

    # mouse draws too
    b = page.locator(".sketch-paper").bounding_box()
    page.mouse.move(b["x"] + b["width"] * 0.7, b["y"] + b["height"] * 0.15)
    page.mouse.down()
    for i in range(1, 8):
        page.mouse.move(b["x"] + b["width"] * (0.7 + i * 0.03), b["y"] + b["height"] * (0.15 + i * 0.03))
    page.mouse.up()
    check(len(strokes(page, "Monsoon sketch")) == 5, "a mouse drag draws")

    # ================= tools =================
    check(page.locator(".sketch-strip").is_visible(), "tools show while sketching")
    page.click(".sketch-strip [data-sk='tool-hl']")
    check(page.locator(".sketch-strip [data-color='hl-yellow']").get_attribute("aria-pressed") == "true", "highlighter colours: Yellow first")
    page.evaluate(SEQ, [0, line(0.3, x0=0.1, x1=0.5, p=0.9)])
    st = strokes(page, "Monsoon sketch")
    check(st[-1].startswith("hl.hl-yellow.m:"), f"highlighter stroke saved ({st[-1][:16]})")
    rgba = page.evaluate(COLOR_AT, [0, 0.3, 0.3])
    check(0 < rgba[3] < 200, f"highlighter is see-through (alpha {rgba[3]})")
    page.click(".sketch-strip [data-sk='tool-pen']")
    page.click(".sketch-strip [data-color='red']")
    page.click(".sketch-strip [data-size='l']")
    page.evaluate(SEQ, [0, line(0.5, x0=0.62, x1=0.95, p=0.6)])
    st = strokes(page, "Monsoon sketch")
    check(st[-1].startswith("pen.red.l:"), f"colour and size choices (Red, Bold) ({st[-1][:12]})")
    rgba = page.evaluate(COLOR_AT, [0, 0.8, 0.5])
    check(rgba[0] > 150 and rgba[1] < 100 and rgba[3] > 200, f"drawn in red ({rgba})")
    prefs = page.evaluate("JSON.parse(localStorage.getItem('upsc.sketch'))")
    check(prefs["pen"] == {"color": "red", "size": "l"}, f"tool choices remembered on this device ({prefs})")
    n_before = len(st)

    # eraser removes the whole stroke it touches
    page.click(".sketch-strip [data-sk='tool-eraser']")
    page.evaluate(SEQ, [0, [["pointerdown", "pen", 4, 0.8, 0.42, 0.5, None], ["pointermove", "pen", 4, 0.8, 0.5, 0.5, None], ["pointermove", "pen", 4, 0.8, 0.58, 0.5, None], ["pointerup", "pen", 4, 0.8, 0.58, 0, None]]])
    st = strokes(page, "Monsoon sketch")
    check(len(st) == n_before - 1 and not any(s.startswith("pen.red") for s in st), "the eraser removes the stroke it touches")
    check(page.evaluate(INK, [0, 0.62, 0.45, 0.96, 0.55]) == 0, "and it's gone from the paper")
    # S Pen side button (buttons 32 = eraser, 2 = barrel) erases while the pen tool is chosen
    page.click(".sketch-strip [data-sk='tool-pen']")
    page.evaluate(SEQ, [0, [["pointerdown", "pen", 5, 0.3, 0.12, 0.5, 32], ["pointermove", "pen", 5, 0.3, 0.2, 0.5, 32], ["pointermove", "pen", 5, 0.3, 0.28, 0.5, 32], ["pointerup", "pen", 5, 0.3, 0.28, 0, 32]]])
    st2 = strokes(page, "Monsoon sketch")
    check(len(st2) == len(st) - 2, f"S Pen button erases while held (the light line and the highlighter) ({len(st)} → {len(st2)})")
    check(page.locator(".sketch-strip [data-sk='tool-pen']").get_attribute("aria-pressed") == "true", "the pen tool stays chosen")

    # ================= note-wide Undo / Redo =================
    page.keyboard.press("Control+z")
    check(len(strokes(page, "Monsoon sketch")) == len(st), "Ctrl+Z brings the erased strokes back")
    page.keyboard.press("Control+Shift+z")
    check(len(strokes(page, "Monsoon sketch")) == len(st2), "Ctrl+Shift+Z erases them again")
    page.click(".sketch-strip [data-sk='undo']")
    check(len(strokes(page, "Monsoon sketch")) == len(st), "the sketch tools' ↶ is the same Undo")
    page.click(".sketch-strip [data-sk='redo']")
    check(len(strokes(page, "Monsoon sketch")) == len(st2), "and ↷ the same Redo")
    # one ordered history: a stroke after typing undoes first, then the typing
    ed.locator("p", has_text="Winds reverse").click()
    page.keyboard.press("End")
    page.keyboard.type(" SW in summer.")
    page.wait_for_timeout(600)
    page.evaluate(SEQ, [0, line(0.7, x0=0.2, x1=0.4)])
    k = len(strokes(page, "Monsoon sketch"))
    page.click("#note-undo")
    check(len(strokes(page, "Monsoon sketch")) == k - 1 and "SW in summer" in ed.inner_text(), "header Undo: the stroke first (it came last)")
    page.click("#note-undo")
    saved(page)
    check("SW in summer" not in ed.inner_text() and len(strokes(page, "Monsoon sketch")) == k - 1, "then the typing before it")
    page.click("#note-redo")
    page.click("#note-redo")
    check("SW in summer" in ed.inner_text() and len(strokes(page, "Monsoon sketch")) == k, "Redo replays both, in order")

    # ================= clear =================
    page.locator(".sketch-paper").scroll_into_view_if_needed()
    page.evaluate(SEQ, [0, line(0.95, x0=0.9, x1=0.95)])  # touching the paper shows its tools again
    k = len(strokes(page, "Monsoon sketch"))
    page.click(".sketch-strip [data-sk='clear']")
    check(page.inner_text(".sketch-strip [data-sk='clear']") == "Tap again to clear" and len(strokes(page, "Monsoon sketch")) == k, "Clear asks for a second tap")
    page.click(".sketch-strip [data-sk='clear']")
    check(strokes(page, "Monsoon sketch") == [] and page.evaluate(INK, [0, 0, 0, 1, 1]) == 0, "second tap clears the sketch")
    page.keyboard.press("Control+z")
    check(len(strokes(page, "Monsoon sketch")) == k and page.evaluate(INK, [0, 0, 0, 1, 1]) > 100, "Clear is undone by Undo")

    # ================= size =================
    page.click(".sketch-strip [data-sk='more']")
    saved(page)
    sk, _ = sketch(page, "Monsoon sketch")
    pb = page.locator(".sketch-paper").bounding_box()
    check(sk["attrs"]["height"] == 900 and abs(pb["height"] / pb["width"] - 0.9) < 0.02, f"More room: 600 → 900 ({sk['attrs']['height']})")
    page.evaluate(SEQ, [0, line(0.6, x0=0.3, x1=0.5)])  # a line at 540 of 900
    g = page.locator(".sketch-grow")
    g.evaluate("e => e.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(150)
    gb = g.bounding_box()
    page.mouse.move(gb["x"] + gb["width"] / 2, gb["y"] + gb["height"] / 2)
    page.mouse.down()
    page.mouse.move(gb["x"] + gb["width"] / 2, gb["y"] - 2000, steps=5)
    page.mouse.up()
    saved(page)
    sk, _ = sketch(page, "Monsoon sketch")
    check(540 < sk["attrs"]["height"] < 640, f"the height handle shortens it, but never cuts off ink ({sk['attrs']['height']})")
    g.evaluate("e => e.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(150)
    gb = g.bounding_box()
    page.mouse.move(gb["x"] + gb["width"] / 2, gb["y"] + gb["height"] / 2)
    page.mouse.down()
    page.mouse.move(gb["x"] + gb["width"] / 2, gb["y"] + 150, steps=5)
    page.mouse.up()
    saved(page)
    h_now = sketch(page, "Monsoon sketch")[0]["attrs"]["height"]
    check(h_now > sk["attrs"]["height"] + 50, f"and drags it taller ({sk['attrs']['height']} → {h_now})")

    # ================= beside text, caption, search =================
    page.locator(".sketch-paper").evaluate("e => e.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(150)
    b = page.locator(".sketch-paper").bounding_box()
    page.touchscreen.tap(b["x"] + b["width"] * 0.97, b["y"] + b["height"] * 0.5)
    page.wait_for_timeout(150)
    check(page.locator(".sketch-block.is-selected").count() == 1 and len(strokes(page, "Monsoon sketch")) == k + 1, "a finger tap selects the sketch (and draws nothing)")
    page.click("#ctxbar button[aria-label='Align image left']")
    saved(page)
    sk, n = sketch(page, "Monsoon sketch")
    check(sk["attrs"]["align"] == "left" and sk["attrs"]["width"] == 50, f"Left · text beside: floats at 50% ({sk['attrs']['align']}, {sk['attrs']['width']})")
    doc = n["sections"][0]["doc"]["content"]
    check(doc[0]["type"] == "sketchBlock" and "Winds reverse" in json.dumps(doc[1]), "it moved above the line before it, so that line sits beside it")
    sb = page.locator(".sketch-block").bounding_box()
    tb = page.evaluate("""() => { const p = [...document.querySelectorAll('.section-body .rich p')].find(e => e.textContent.includes('Winds reverse'));
        const r = document.createRange(); r.selectNodeContents(p); const b = r.getClientRects()[0]; return { x: b.left, y: b.top }; }""")
    check(tb["x"] > sb["x"] + sb["width"] - 5 and tb["y"] < sb["y"] + sb["height"], "the text sits beside the sketch on screen")
    page.fill("#image-caption", "Monsoon wind reversal")
    page.locator("#image-caption").press("Enter")
    saved(page)
    check(sketch(page, "Monsoon sketch")[0]["attrs"]["caption"] == "Monsoon wind reversal", "caption saved")
    check(page.inner_text(".sketch-block .img-caption") == "Monsoon wind reversal", "caption shown under the sketch")
    page.click("#f-title")
    expect(page.locator(".sketch-strip")).to_be_hidden(timeout=2000)
    check(not page.locator(".sketch-strip").is_visible(), "tapping elsewhere puts the tools away")
    page.keyboard.press("Control+k")
    page.fill("#global-search", "sketch")
    page.wait_for_timeout(300)
    check("Monsoon sketch" in page.inner_text("#search-results"), "Ctrl+K 'sketch' finds notes with sketches")
    page.fill("#global-search", "wind reversal")
    page.wait_for_timeout(300)
    check("Monsoon sketch" in page.inner_text("#search-results"), "and the caption is searchable")
    page.keyboard.press("Escape")

    # ================= draw with finger =================
    page.locator(".sketch-paper").scroll_into_view_if_needed()
    page.evaluate(SEQ, [0, line(0.05, x0=0.1, x1=0.3)])
    k = len(strokes(page, "Monsoon sketch"))
    page.click(".sketch-strip [data-sk='finger']")
    check(page.get_attribute(".sketch-strip [data-sk='finger']", "aria-pressed") == "true" and page.locator(".sketch-paper").evaluate("e => getComputedStyle(e).touchAction") == "none",
          "Draw with finger on: the finger no longer scrolls the sketch")
    top0 = page.locator(".sketch-paper").bounding_box()["y"]
    b = page.locator(".sketch-paper").bounding_box()
    cdp_drag(cdp, "touch", b["x"] + b["width"] * 0.2, b["y"] + b["height"] * 0.5, b["x"] + b["width"] * 0.8, b["y"] + b["height"] * 0.3)
    page.wait_for_timeout(300)
    check(len(strokes(page, "Monsoon sketch")) == k + 1 and abs(page.locator(".sketch-paper").bounding_box()["y"] - top0) < 2, "a finger draws (and the note stays put)")
    # palm first, then the pen: the palm's stroke is dropped, the pen's is kept
    page.evaluate(SEQ, [0, [["pointerdown", "touch", 21, 0.5, 0.9, 0.5, None], ["pointermove", "touch", 21, 0.55, 0.92, 0.5, None],
                            ["pointerdown", "pen", 22, 0.1, 0.8, 0.5, None], ["pointermove", "pen", 22, 0.2, 0.8, 0.5, None], ["pointermove", "touch", 21, 0.6, 0.94, 0.5, None],
                            ["pointermove", "pen", 22, 0.3, 0.8, 0.5, None], ["pointerup", "touch", 21, 0.6, 0.94, 0, None], ["pointerup", "pen", 22, 0.3, 0.8, 0, None]]])
    st = strokes(page, "Monsoon sketch")
    check(len(st) == k + 2, f"palm first, then the pen: only the pen's line is kept ({len(st) - k - 1} added)")
    check(page.evaluate(INK, [0, 0.52, 0.88, 0.62, 0.96]) == 0, "nothing where the palm was")
    page.click(".sketch-strip [data-sk='finger']")
    check(page.locator(".sketch-paper").evaluate("e => getComputedStyle(e).touchAction") == "none", "the pen was just here: scrolling stays off for a moment")
    page.wait_for_timeout(1700)
    check(page.locator(".sketch-paper").evaluate("e => getComputedStyle(e).touchAction") != "none", "Draw with finger off, pen gone: a finger scrolls the sketch again")
    page.click(".sketch-strip [data-sk='done']")
    check(not page.locator(".sketch-strip").is_visible(), "Done puts the tools away")

    # ================= saved, redrawn, not rewritten =================
    saved(page)
    final = strokes(page, "Monsoon sketch")
    note_id = page.evaluate(NOTE, "Monsoon sketch")["id"]
    stamp = page.evaluate(NOTE, "Monsoon sketch")["updatedAt"]
    page.reload()
    page.wait_for_selector(".sketch-paper")
    page.wait_for_timeout(300)
    check(page.evaluate(INK, [0, 0, 0, 1, 1]) > 200, "after a reload the sketch is drawn from its strokes")
    check(strokes(page, "Monsoon sketch") == final, "every stroke kept")
    page.goto(URL + "#/notes")
    page.wait_for_timeout(500)
    check(page.evaluate(NOTE, "Monsoon sketch")["updatedAt"] == stamp, "opening and leaving the note doesn't rewrite it")
    page.goto(URL + f"#/n/{note_id}")
    page.wait_for_selector(".sketch-paper")
    page.wait_for_timeout(300)

    # ================= night ink =================
    day = page.evaluate("""() => { const c = document.querySelector('.sketch-ink'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - d[i + 2]) < 20) return [d[i], d[i + 1], d[i + 2]]; return null; }""")
    page.evaluate("() => { localStorage.setItem('upsc.theme', 'night'); document.documentElement.dataset.theme = 'night'; window.dispatchEvent(new Event('themechange')); }")
    page.wait_for_timeout(200)
    night = page.evaluate("""() => { const c = document.querySelector('.sketch-ink'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - d[i + 2]) < 20) return [d[i], d[i + 1], d[i + 2]]; return null; }""")
    check(day and night and sum(day) < 150 and sum(night) > 600, f"ink is dark by day, light at night ({day} → {night})")
    page.evaluate("() => { localStorage.setItem('upsc.theme', 'day'); document.documentElement.dataset.theme = 'day'; window.dispatchEvent(new Event('themechange')); }")

    # ================= PDF =================
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / "sketch.pdf"
    dl.value.save_as(pdf)
    reader = PdfReader(str(pdf))
    imgs = sum(len(pg.images) for pg in reader.pages)
    text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    check(imgs >= 1, f"the PDF prints the sketch ({imgs} picture)")
    check("Monsoon wind reversal" in text, "with its caption")
    beside = [l for l in text.splitlines() if "Winds reverse" in l]
    check(beside and beside[0].index("Winds reverse") > 20, f"the text prints beside the left sketch ({beside[:1]})")
    pic = next(iter(reader.pages[0].images)).image
    dark = sum(1 for px in pic.convert("L").get_flattened_data() if px < 100)
    check(dark > 200, f"the sketch prints in dark ink on white ({dark} dark pixels)")

    # ================= backup format 3 =================
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    bpath = OUT / "sketch-backup.json"
    dl.value.save_as(bpath)
    bk = json.loads(bpath.read_text())
    check(bk["format"] == 4, f"backup format 4 (0.10; 3 added sketches) ({bk['format']})")
    bnote = next(n for n in bk["notes"] if n["title"] == "Monsoon sketch")
    check(json.dumps(final) in json.dumps(bnote), "the backup carries every stroke")
    fresh = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    p2 = fresh.new_page()
    p2.on("pageerror", lambda e: errors.append(str(e)))
    p2.goto(URL + "#/settings")
    p2.wait_for_selector("#import-file", state="attached")
    p2.set_input_files("#import-file", str(bpath))
    p2.wait_for_timeout(1200)
    imported = p2.evaluate(NOTE, "Monsoon sketch")
    check(imported is not None and json.dumps(final) in json.dumps(imported), "import on a fresh tablet brings the sketch back intact")
    p2.goto(URL + f"#/n/{imported['id']}")
    p2.wait_for_selector(".sketch-paper")
    p2.wait_for_timeout(300)
    check(p2.evaluate(INK, [0, 0, 0, 1, 1]) > 200, "and draws it")
    newer = dict(bk, format=5)
    npath = OUT / "newer.json"
    npath.write_text(json.dumps(newer))
    p2.goto(URL + "#/settings")
    p2.wait_for_selector("#import-file", state="attached")
    p2.set_input_files("#import-file", str(npath))
    p2.wait_for_timeout(800)
    check("newer version" in p2.inner_text("body"), "a backup from a newer format is refused with a clear message")
    fresh.close()

    # ================= review card: read-only =================
    rec = page.evaluate(NOTE, "Monsoon sketch")
    rec["nextReview"] = "2000-01-01"
    page.evaluate(IDB_PUT, rec)
    page.goto(URL + "#/review/notes")
    page.reload()
    page.wait_for_selector("#rv-show")
    page.click("#rv-show")
    page.wait_for_selector("#rv-answer .sketch-paper")
    page.wait_for_timeout(300)
    rv_ink = page.evaluate("""() => { const c = document.querySelector('#rv-answer .sketch-ink'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 60) n++; return n; }""")
    check(rv_ink > 200, "the review's note card shows the sketch")
    page.evaluate("""async () => { const paper = document.querySelector('#rv-answer .sketch-paper'); const r = paper.getBoundingClientRect();
        for (const [t, f] of [['pointerdown', 0.1], ['pointermove', 0.3], ['pointermove', 0.5], ['pointerup', 0.5]]) {
          paper.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 40, pointerType: 'pen', clientX: r.left + f * r.width, clientY: r.top + r.height / 2, pressure: 0.6, buttons: t === 'pointerup' ? 0 : 1 }));
          await new Promise(res => requestAnimationFrame(res)); } }""")
    page.wait_for_timeout(400)
    check(not page.locator("#rv-answer .sketch-strip").is_visible() and page.locator("#rv-answer .sketch-grow").evaluate("e => getComputedStyle(e).display") == "none", "no sketch tools on the card")
    check(page.evaluate(NOTE, "Monsoon sketch")["sections"] == rec["sections"], "the pen draws nothing there (the session never writes note text)")

    # ================= tapping the text below an active sketch =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Tap below")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("/sketch")
    page.wait_for_selector(".insert-opt[data-item='sketch'][aria-selected='true']")
    page.keyboard.press("Enter")
    page.wait_for_selector(".sketch-strip:not([hidden])")
    page.wait_for_timeout(150)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(150)
    for t in ["First below", "Second below", "Third below"]:
        page.keyboard.type(t)
        page.keyboard.press("Enter")
    page.locator(".sketch-paper").evaluate("e => e.scrollIntoView({ block: 'start' })")
    page.evaluate(SEQ, [0, line(0.5, x0=0.2, x1=0.4)])  # the pen was just used: the tools are out
    check(page.locator(".sketch-strip").is_visible(), "tools out under the sketch")
    r = page.evaluate("""() => { const p = [...document.querySelectorAll('.section-body .rich p')].find(e => e.textContent === 'First below');
        const rg = document.createRange(); rg.selectNodeContents(p); const b = rg.getClientRects()[0]; return { x: b.right - 2, y: b.top + b.height / 2 }; }""")
    page.touchscreen.tap(r["x"], r["y"])
    page.wait_for_timeout(600)
    page.keyboard.type("!")
    texts = page.locator(".section-body .rich p").all_inner_texts()
    check("First below!" in texts and not page.locator(".sketch-strip").is_visible(), f"a tap on the line below an active sketch puts the caret on that line, then the tools go ({texts})")

    # ================= copy and paste inside the app =================
    page.goto(URL + "#/notes")  # from one note straight to a new one, #f-title would still be the old note's
    page.wait_for_selector("#new-note")
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Pasted sketch")
    page.locator(".section-body .rich").first.click()
    html = '<p>Copied:</p><figure data-sketch="' + escape(json.dumps({"s": final, "h": 640}), quote=True) + '" data-width="60" data-align="right" data-caption="Copied map"></figure>'
    page.evaluate("""(html) => { const dt = new DataTransfer(); dt.setData('text/html', html); dt.setData('text/plain', 'Copied:');
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""", html)
    page.wait_for_selector(".sketch-paper")
    saved(page)
    sk, _ = sketch(page, "Pasted sketch")
    check(sk and sk["attrs"]["strokes"] == final and sk["attrs"]["height"] == 640 and sk["attrs"]["align"] == "right" and sk["attrs"]["width"] == 60 and sk["attrs"]["caption"] == "Copied map",
          f"a sketch copied inside the app pastes as an editable sketch (strokes, size, side, caption) {'' if sk and sk['attrs']['strokes'] == final else (sk and {k: v for k, v in sk['attrs'].items() if k != 'strokes'}, sk and len(sk['attrs']['strokes']), len(final))}")

    # ================= a section from a newer version =================
    future = {"id": "future-note", "subject": "GS1", "topic": "", "title": "From the future", "explain": "", "connect": "", "template": None,
              "sections": [{"id": "s1", "heading": "Notes", "doc": {"type": "doc", "content": [
                  {"type": "paragraph", "content": [{"type": "text", "text": "Kept text"}]}, {"type": "hologramBlock", "attrs": {"x": 1}}]}}],
              "nextReview": "2099-01-01", "reviewCount": 0, "lastReviewed": None, "createdAt": 1, "updatedAt": 1, "deletedAt": None}
    page.evaluate(IDB_PUT, future)
    page.goto(URL + "#/n/future-note")
    page.reload()
    page.wait_for_selector("#f-title")
    page.wait_for_timeout(300)
    check(page.locator(".unreadable-note").is_visible() and "newer version" in page.inner_text(".unreadable-note"), "a section with an unknown block says it's from a newer version")
    check(page.locator(".section-body .ProseMirror").first.get_attribute("contenteditable") == "false", "and opens read-only instead of blank")
    page.fill("#f-title", "From the future, renamed")
    saved(page)
    kept = page.evaluate(NOTE, "From the future, renamed")
    check(kept["sections"][0]["doc"] == future["sections"][0]["doc"], "saving the note leaves that section exactly as it was")

    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
