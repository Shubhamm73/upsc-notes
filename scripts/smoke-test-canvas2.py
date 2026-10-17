"""0.8.3 smoke test: wide canvas, PYQ callout, note-wide Undo/Redo, text on every side of a
picture, Crop & shape. Needs `vite preview` on :4173.

Width: the note fills the screen (outline can fold away; Comfortable width is a choice), pictures
never taller than ~75% of the screen. PYQ: /pyq, year / paper / marks in the label, Ctrl+K, PDF,
Topic sheet. Undo/Redo: header buttons and Ctrl+Z / Ctrl+Shift+Z across sections, title, headings,
adding / deleting / moving sections. Pictures: typing on a selected picture never deletes it, line
above / below, Enter twice (and "Below picture") starts text under a floated picture, headings start
below, pictures inside callouts. Crop & shape: crop, shapes, turn, mirror, caption, text follows the
shape, saved, undone, PDF.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


PASTE = """async ([src]) => {
  const dt = new DataTransfer();
  const b = await (await fetch(src)).blob(); dt.items.add(new File([b], 'shot.png', { type: b.type || 'image/png' }));
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""
IDB_GET = """(id) => new Promise(res => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const q = r.result.transaction('notes').objectStore('notes').get(id); q.onsuccess = () => { r.result.close(); res(q.result || null); }; }; })"""
NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""
BLOCKS = "(i) => Array.from(document.querySelectorAll('.section-body .rich')[i || 0].children).map(e => e.tagName + (e.dataset.align ? '[' + e.dataset.align + ']' : '') + (e.dataset.clear ? '[clear]' : '') + ':' + e.textContent.trim().slice(0, 24))"


def text_of(pdf):
    return subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout


def caret_to_end_of(page, text):
    """Puts the caret at the end of the paragraph holding `text` (by range; see CLAUDE.md test gotchas)."""
    page.wait_for_timeout(150)
    page.evaluate("""(t) => {
        const root = document.activeElement.closest('.ProseMirror') || document.querySelector('.section-body .ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) if (n.textContent.includes(t)) break;
        const el = n.parentElement.closest('p, h2, h3, h4, li');
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        getSelection().removeAllRanges(); getSelection().addRange(r);
    }""", text)
    page.wait_for_timeout(150)


def save_pdf(page, name):
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / name
    dl.value.save_as(pdf)
    return pdf


# a picture with a clear left and right half, so turn / mirror / crop can be told apart
img = Image.new("RGB", (800, 400), (200, 40, 40))
img.paste((40, 90, 200), (400, 0, 800, 400))
img.save(OUT / "halves.png")

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, has_touch=True, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    png = page.evaluate("""async () => { const c = document.createElement('canvas'); c.width = 800; c.height = 400; const g = c.getContext('2d');
        g.fillStyle = '#c82828'; g.fillRect(0, 0, 400, 400); g.fillStyle = '#285ac8'; g.fillRect(400, 0, 400, 400); return c.toDataURL('image/png'); }""")

    # ================= width =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Wide note")
    col = lambda: page.locator(".canvas-col").bounding_box()["width"]
    check(col() >= 780, f"the note fills the screen beside the outline ({col():.0f}px of 1280)")
    page.click("#outline-toggle")
    page.wait_for_timeout(100)
    check(not page.locator("#outline").is_visible() and col() >= 1050, f"outline folds away and the note takes its room ({col():.0f}px)")
    page.click("#outline-toggle")
    page.wait_for_timeout(100)
    check(page.locator("#outline").is_visible(), "outline comes back")
    page.click("#note-more")
    page.click(".popover button:has-text('width')")
    page.wait_for_timeout(100)
    check(560 <= col() <= 760, f"Comfortable width is a reading column ({col():.0f}px)")
    page.click("#note-more")
    check(page.locator(".popover button:has-text('width')").inner_text() == "Full width", "the menu offers Full width back")
    page.click(".popover button:has-text('width')")
    page.wait_for_timeout(100)
    check(col() >= 780, "back to full width")
    page.goto(URL + "#/prefs")
    page.wait_for_selector("#pref-width-full")
    check(page.locator("#pref-width-full").get_attribute("aria-checked") == "true", "Settings shows the note width (Full)")

    # ================= PYQ callout =================
    page.goto(URL + "#/n/new/topic-sheet")
    page.wait_for_selector("#f-title")
    heads = [h.input_value() for h in page.locator(".section-heading").all()]
    check(heads[-1] == "PYQs", f"Topic sheet ends with a PYQs section ({heads})")
    page.fill("#f-title", "Federalism PYQs")
    ed = page.locator(".section-body .rich").last
    ed.click()
    page.keyboard.type("/pyq")
    page.wait_for_selector("#insert-menu:not([hidden])")
    check(page.locator(".insert-opt").first.get_attribute("data-item") == "callout-pyq", "/pyq offers the PYQ callout first")
    page.keyboard.press("Enter")
    page.keyboard.type("Discuss the role of the Inter-State Council in cooperative federalism.")
    check(ed.locator("aside.callout[data-callout='pyq']").count() == 1, "PYQ callout inserted")
    check(page.locator("#pyq-year").is_visible(), "PYQ tools show year, paper and marks")
    page.fill("#pyq-year", "2019")
    page.locator("#pyq-year").press("Enter")
    page.select_option("#pyq-paper", "GS2")
    page.select_option("#pyq-marks", "15")
    page.wait_for_timeout(150)
    label = ed.locator(".callout-label").first.inner_text()
    check(label.lower() == "pyq · 2019 · gs2 · 15 marks", f"PYQ label carries year, paper and marks ({label!r})")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    n = page.evaluate(NOTE, "Federalism PYQs")
    co = n["sections"][-1]["doc"]["content"][0]
    check(co["type"] == "callout" and co["attrs"]["kind"] == "pyq" and co["attrs"]["year"] == "2019" and co["attrs"]["paper"] == "GS2" and co["attrs"]["marks"] == "15", f"PYQ details saved ({co['attrs']})")
    page.keyboard.press("Control+k")
    page.fill("#global-search", "pyq")
    page.wait_for_selector(".search-hit")
    hit = page.locator(".search-hit").first.inner_text()
    check("Federalism PYQs" in hit and "PYQ · 2019" in hit, f"Ctrl+K 'pyq' finds the note with its PYQ ({hit!r})")
    page.keyboard.press("Escape")
    t = text_of(save_pdf(page, "pyq.pdf"))
    check("PYQ·2019·GS2·15MARKS" in t.replace(" ", "") and "Inter-State Council" in t, "PDF prints the PYQ with its details")

    # ================= Undo / Redo =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    check(page.locator("#note-undo").is_disabled() and page.locator("#note-redo").is_disabled(), "Undo and Redo start greyed out")
    page.fill("#f-title", "Undo test")
    ed = page.locator(".section-body .rich").first
    ed.click()
    page.keyboard.type("Alpha line")
    page.wait_for_timeout(600)
    page.click("#add-section")
    page.keyboard.type("Second")
    ed2 = page.locator(".section-body .rich").nth(1)
    ed2.click()
    page.keyboard.type("Beta line")
    page.wait_for_timeout(200)
    check(page.locator("#note-undo").is_enabled(), "Undo lights up after a change")
    page.click("#note-undo")
    check("Beta" not in ed2.inner_text(), "Undo takes back the last typing (section 2)")
    page.click("#note-undo")
    check(page.locator(".section-heading").nth(1).input_value() == "", "next Undo takes back the new section's heading")
    page.click("#note-undo")
    check(page.locator(".note-section").count() == 1, "next Undo takes back adding the section")
    page.click("#note-redo")
    page.click("#note-redo")
    page.click("#note-redo")
    check(page.locator(".note-section").count() == 2 and page.locator(".section-heading").nth(1).input_value() == "Second" and "Beta line" in page.locator(".section-body .rich").nth(1).inner_text(),
          "Redo brings back the section, its heading and its text, in order")
    # delete a section, undo brings it back with its text (and its own undo history)
    page.locator(".sec-menu-btn").nth(1).click()
    page.click(".popover button[aria-label='Delete section 2']")
    page.click(".popover button[aria-label='Delete section 2']")
    page.wait_for_timeout(100)
    check(page.locator(".note-section").count() == 1, "section deleted")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(100)
    check(page.locator(".note-section").count() == 2 and "Beta line" in page.locator(".section-body .rich").nth(1).inner_text(), "Ctrl+Z brings a deleted section back with its text")
    page.keyboard.press("Control+Shift+z")
    page.wait_for_timeout(100)
    check(page.locator(".note-section").count() == 1, "Ctrl+Shift+Z deletes it again")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(100)
    # move: section 2 up, then undo
    page.locator(".sec-menu-btn").nth(1).click()
    page.click(".popover button[aria-label='Move section 2 up']")
    heads = [h.input_value() for h in page.locator(".section-heading").all()]
    check(heads == ["Second", "Notes"], f"section moved up ({heads})")
    page.click("#note-undo")
    heads = [h.input_value() for h in page.locator(".section-heading").all()]
    check(heads == ["Notes", "Second"], f"Undo moves it back ({heads})")
    # text history survives the move: undo in section 1 still works
    page.click("#note-undo")
    page.click("#note-undo")
    page.click("#note-undo")
    page.click("#note-undo")
    check("Alpha" not in page.locator(".section-body .rich").first.inner_text(), "older typing in section 1 is still undoable after sections moved")
    page.click("#note-undo")
    check(page.input_value("#f-title") == "", "Undo reaches the title too")
    for _ in range(8):
        if page.locator("#note-redo").is_enabled():
            page.click("#note-redo")
    heads = [h.input_value() for h in page.locator(".section-heading").all()]
    check(page.input_value("#f-title") == "Undo test" and "Alpha line" in page.locator(".note-section", has_text="Alpha").inner_text() and heads == ["Second", "Notes"],
          f"Redo all the way brings everything back, the move too ({heads})")
    # Ctrl+Z in the title box is the note's undo, not the browser's
    page.click("#f-title")
    page.keyboard.press("End")
    page.keyboard.type(" X")
    page.keyboard.press("Control+z")
    check(page.input_value("#f-title") == "Undo test", "Ctrl+Z in the title undoes the title typing")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    n = page.evaluate(NOTE, "Undo test")
    check(n and [s["heading"] for s in n["sections"]] == ["Second", "Notes"], "undone and redone note is saved as shown")

    # ================= pictures: every side =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Pictures")
    ed = page.locator(".section-body .rich").first
    ed.click()
    page.keyboard.type("Line before the picture")
    page.keyboard.press("Enter")
    page.evaluate(PASTE, [png])
    page.wait_for_selector(".section-body .img-block img[src^='blob:']")
    page.wait_for_timeout(200)
    fig = page.locator(".section-body .img-block").first
    fb = fig.bounding_box()
    check(fb["height"] <= 800 * 0.75 + 2, f"a picture is never taller than ~75% of the screen ({fb['height']:.0f}px)")
    # tap the picture (select it) then type: the picture stays, the text starts a new line after it
    page.touchscreen.tap(fb["x"] + fb["width"] / 2, fb["y"] + 40)
    page.wait_for_timeout(200)
    check(page.locator(".section-body .img-block.is-selected").count() == 1, "tap selects the picture")
    page.keyboard.type("Typed while selected")
    page.wait_for_timeout(100)
    b = page.evaluate(BLOCKS)
    check(page.locator(".section-body .img-block").count() == 1 and b[1].startswith("FIGURE") and b[2].startswith("P:Typed while selected"), f"typing on a selected picture keeps it and writes below ({b})")
    # the same through an Android keyboard (key 'Unidentified', then the text arrives as composed input)
    page.locator(".section-body .img-block img").click()
    page.wait_for_timeout(100)
    page.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true, cancelable: true }))")
    page.keyboard.insert_text("Gboard text")
    page.wait_for_timeout(150)
    b = page.evaluate(BLOCKS)
    check(page.locator(".section-body .img-block").count() == 1 and b[2].startswith("P:Gboard text"), f"keyboard composition on a selected picture keeps it too ({b})")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(100)
    check(not any("Gboard" in x for x in page.evaluate(BLOCKS)) and page.locator(".section-body .img-block").count() == 1, "and Undo takes that line back, picture stays")
    # + Line above
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Add a line above the picture']")
    page.keyboard.type("Above it")
    b = page.evaluate(BLOCKS)
    check(b[1] == "P:Above it" and b[2].startswith("FIGURE"), f"+ Line above puts a line above the picture ({b})")
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Add a line below the picture']")
    page.keyboard.type("Below it")
    b = page.evaluate(BLOCKS)
    check(b[2].startswith("FIGURE") and b[3] == "P:Below it", f"+ Line below puts a line below the picture ({b})")
    # float left: text beside; Enter twice drops below
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Align image left']")
    page.wait_for_timeout(200)
    fb = fig.bounding_box()
    caret_to_end_of(page, "Typed while selected")
    page.keyboard.press("Enter")
    page.wait_for_timeout(100)
    check(page.locator(".tb-flow button[aria-label='Start this line below the picture']").is_visible(), "a line beside the picture offers 'Below picture'")
    page.keyboard.press("Enter")
    page.keyboard.type("Under the picture")
    page.wait_for_timeout(150)
    under = page.locator(".section-body p", has_text="Under the picture").bounding_box()
    fb = fig.bounding_box()
    check(under["y"] >= fb["y"] + fb["height"] - 1, f"Enter twice beside a picture starts the text below it ({under['y']:.0f} vs {fb['y'] + fb['height']:.0f})")
    check(page.locator(".tb-flow button[aria-label='Put this line back beside the picture']").is_visible(), "'Beside picture' puts it back")
    page.click(".tb-flow button[aria-label='Put this line back beside the picture']")
    page.wait_for_timeout(100)
    under = page.locator(".section-body p", has_text="Under the picture").bounding_box()
    check(under["y"] < fb["y"] + fb["height"], "the line sits beside the picture again")
    page.click(".tb-flow button[aria-label='Start this line below the picture']")
    page.wait_for_timeout(100)
    under = page.locator(".section-body p", has_text="Under the picture").bounding_box()
    check(under["y"] >= fb["y"] + fb["height"] - 1, "'Below picture' moves it under the picture")
    # a picture inside a callout
    caret_to_end_of(page, "Under the picture")
    page.keyboard.press("Enter")
    page.keyboard.type("/data")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.keyboard.type("NCRB figures")
    page.evaluate(PASTE, [png])
    page.wait_for_function("document.querySelectorAll('.section-body aside.callout .img-block img[src^=\"blob:\"]').length === 1")
    check(page.locator(".section-body aside.callout .img-block").count() == 1, "a picture can go inside a callout")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    n = page.evaluate(NOTE, "Pictures")
    blocks = n["sections"][0]["doc"]["content"]
    cleared = [x for x in blocks if (x.get("attrs") or {}).get("clear")]
    check(len(cleared) == 1 and cleared[0]["content"][0]["text"] == "Under the picture", "'below the picture' is saved with the line")
    page.reload()
    page.wait_for_selector(".section-body .img-block img[src^='blob:']")
    page.wait_for_timeout(200)
    fb = page.locator(".section-body .img-block").first.bounding_box()
    under = page.locator(".section-body p", has_text="Under the picture").bounding_box()
    check(under["y"] >= fb["y"] + fb["height"] - 1, "still below the picture after reload")
    t = text_of(save_pdf(page, "pictures.pdf"))
    lines = t.splitlines()
    ind = lambda l: len(l) - len(l.lstrip())
    beside = next((l for l in lines if "Typed while selected" in l), "")
    below = next((l for l in lines if "Under the picture" in l), "")
    check(beside and below and ind(beside) > ind(below) + 8, f"PDF: text beside the picture is indented, the line below it is not ({ind(beside)} / {ind(below)})")

    # ================= Crop & shape =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Shapes")
    ed = page.locator(".section-body .rich").first
    ed.click()
    with page.expect_file_chooser() as fc:
        page.keyboard.type("/image")
        page.wait_for_selector("#insert-menu:not([hidden])")
        page.keyboard.press("Enter")
    fc.value.set_files(str(OUT / "halves.png"))
    page.wait_for_selector(".section-body .img-block img[src^='blob:']")
    page.wait_for_timeout(200)
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Crop and shape']")
    page.wait_for_selector("#crop-editor")
    names = [c.get_attribute("aria-label") for c in page.locator(".crop-chip[data-shape]").all()]
    need = ["Triangle", "Circle", "Original", "Rhombus", "Pentagon", "Hexagon"]
    check(all(x in names for x in need), f"shapes include triangle, circle, rectangle, rhombus, pentagon, hexagon ({names})")
    # Cancel changes nothing
    page.click(".crop-chip[data-shape='hexagon']")
    page.click("#crop-cancel")
    check(page.locator("#crop-editor").count() == 0 and page.locator(".section-body .img-block").get_attribute("data-shape") == "rect", "Cancel leaves the picture as it was")
    # crop the left half by dragging the right edge in
    page.locator(".section-body .img-block img").dblclick()
    page.wait_for_selector("#crop-editor")
    hb = page.locator(".crop-handle.h-e").bounding_box()
    vb = page.locator(".crop-view").bounding_box()
    page.mouse.move(hb["x"] + 22, hb["y"] + 22)
    page.mouse.down()
    page.mouse.move(hb["x"] + 22 - vb["width"] / 2, hb["y"] + 22, steps=8)
    page.mouse.up()
    page.click("#crop-done")
    page.wait_for_timeout(300)
    clip = page.locator(".section-body .img-clip").bounding_box()
    check(abs(clip["width"] / clip["height"] - 1) < 0.05, f"cropped to the left half: a square ({clip['width']:.0f}×{clip['height']:.0f})")
    color = page.evaluate("""() => { const c = document.querySelector('.section-body .img-clip').getBoundingClientRect();
        return [c.left + c.width * 0.8, c.top + c.height / 2]; }""")
    page.screenshot(path=str(OUT / "crop.png"))
    shot = Image.open(OUT / "crop.png").convert("RGB")
    px = shot.getpixel((int(color[0]), int(color[1])))
    check(px[0] > 150 and px[2] < 100, f"only the red half shows ({px})")
    # circle
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Crop and shape']")
    page.wait_for_selector("#crop-editor")
    page.click(".crop-chip[data-shape='circle']")
    check(page.locator(".crop-chip[data-ratio='square']").get_attribute("aria-checked") == "true" and page.locator(".crop-chip[data-ratio='free']").is_disabled(), "a circle keeps a square crop")
    page.click("#crop-done")
    page.wait_for_timeout(300)
    check("ellipse" in page.evaluate("getComputedStyle(document.querySelector('.section-body .img-clip')).clipPath"), "the picture shows as a circle")
    # every shape applies
    for shape in ["triangle", "rhombus", "pentagon", "hexagon", "rect"]:
        page.locator(".section-body .img-block img").click()
        page.click("button[aria-label='Crop and shape']")
        page.wait_for_selector("#crop-editor")
        page.click(f".crop-chip[data-shape='{shape}']")
        page.click("#crop-done")
        page.wait_for_timeout(150)
        cp = page.evaluate("getComputedStyle(document.querySelector('.section-body .img-clip')).clipPath")
        check(page.locator(".section-body .img-block").get_attribute("data-shape") == shape and (cp.startswith("polygon") if shape != "rect" else cp == "none"), f"shape {shape} applies ({cp[:30]})")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    # 0.12: each Crop & shape result is its own Undo step (closeHistory), however quick the next one comes
    prev = page.evaluate(NOTE, "Shapes")["sections"][0]["doc"]["content"][0]["attrs"]
    prev_box = page.locator(".section-body .img-clip").bounding_box()
    # turn + mirror + reset
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Crop and shape']")
    page.wait_for_selector("#crop-editor")
    page.click("#crop-reset")
    page.click("#crop-rotate")
    page.click("#crop-flip")
    page.click("#crop-done")
    page.wait_for_timeout(300)
    clip = page.locator(".section-body .img-clip").bounding_box()
    check(clip["height"] > clip["width"] * 1.8, f"a quarter turn makes the wide picture tall ({clip['width']:.0f}×{clip['height']:.0f})")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    a = page.evaluate(NOTE, "Shapes")["sections"][0]["doc"]["content"][0]["attrs"]
    check(a["rotate"] == 90 and a["flip"] is True and a["crop"] is None and a["shape"] == "rect", f"turn and mirror saved, crop reset ({a})")
    # Undo takes the whole Crop & shape step back
    page.click("#note-undo")
    page.wait_for_timeout(150)
    clip = page.locator(".section-body .img-clip").bounding_box()
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    back = page.evaluate(NOTE, "Shapes")["sections"][0]["doc"]["content"][0]["attrs"]
    check(back == prev and abs(clip["width"] / clip["height"] - prev_box["width"] / prev_box["height"]) < 0.05,
          f"Undo takes back the whole Crop & shape step, and only it (crop before it again, {clip['width']:.0f}×{clip['height']:.0f})")
    page.click("#note-redo")
    page.wait_for_timeout(150)
    clip = page.locator(".section-body .img-clip").bounding_box()
    check(clip["height"] > clip["width"] * 1.8, "Redo turns it again")
    # pentagon floated left with text beside: the text follows the shape
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Crop and shape']")
    page.wait_for_selector("#crop-editor")
    page.click("#crop-reset")
    page.click(".crop-chip[data-shape='triangle']")
    page.click("#crop-done")
    page.wait_for_timeout(150)
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Align image left']")
    page.wait_for_timeout(150)
    check("polygon" in page.evaluate("getComputedStyle(document.querySelector('.section-body .img-block')).shapeOutside"), "text beside a floated shape follows its edge")
    # caption
    page.locator(".section-body .img-block img").click()
    page.fill("#image-caption", "Fig: Two halves")
    page.locator("#image-caption").press("Enter")
    page.wait_for_timeout(150)
    check(page.locator(".section-body .img-caption").inner_text() == "Fig: Two halves", "caption shows under the picture")
    check(page.evaluate("getComputedStyle(document.querySelector('.section-body .img-block')).shapeOutside") == "none", "with a caption, text wraps the picture's box")
    # 0.11: a heading made beside a floated picture stays beside it; ↓ Below picture puts it under
    ed.click()
    page.keyboard.press("Control+End")
    page.wait_for_timeout(150)
    page.keyboard.type("Beside the triangle")
    page.keyboard.press("Enter")
    page.keyboard.type("/heading")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.keyboard.type("Sub heading")
    page.wait_for_timeout(150)
    fb = page.locator(".section-body .img-block").bounding_box()
    hb = page.locator(".section-body h2", has_text="Sub heading").bounding_box()
    sb = page.locator(".section-body p", has_text="Beside the triangle").bounding_box()
    hx = page.evaluate("""() => { const h = [...document.querySelectorAll('.section-body h2')].find(e => e.textContent.includes('Sub heading'));
        const r = document.createRange(); r.selectNodeContents(h); return r.getClientRects()[0].left; }""")  # the h2's box runs under the float
    check(sb["y"] < fb["y"] + fb["height"] and hb["y"] < fb["y"] + fb["height"] and hx >= fb["x"] + fb["width"] - 1, "a heading made beside a floated picture stays beside it (0.11)")
    page.click("#ctxbar button:has-text('↓ Below picture')")
    page.wait_for_timeout(200)
    hb = page.locator(".section-body h2", has_text="Sub heading").bounding_box()
    check(hb["y"] >= fb["y"] + fb["height"] - 1, "↓ Below picture starts the heading below it")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    page.reload()
    page.wait_for_selector(".section-body .img-block img[src^='blob:']")
    page.wait_for_timeout(200)
    fig = page.locator(".section-body .img-block")
    check(fig.get_attribute("data-shape") == "triangle" and page.locator(".section-body .img-caption").inner_text() == "Fig: Two halves", "shape and caption survive reload")
    pdf = save_pdf(page, "shapes.pdf")
    t = text_of(pdf)
    check("Fig: Two halves" in t, "PDF prints the caption")
    from pypdf import PdfReader
    imgs = sum(len(pg.images) for pg in PdfReader(str(pdf)).pages)
    check(imgs >= 1, f"PDF has the shaped picture ({imgs} image)")
    page.keyboard.press("Control+k")
    page.fill("#global-search", "two halves")
    page.wait_for_selector(".search-hit")
    check("Shapes" in page.locator(".search-hit").first.inner_text(), "Ctrl+K finds a note by its picture caption")
    page.keyboard.press("Escape")

    # ================= a table dragged to column widths fits the page again =================
    cell = lambda t, w: {"type": "tableCell", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": [w]}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": t}]}]}
    page.evaluate(IDB_PUT, {
        "id": "wide-table", "subject": "GS3", "topic": "", "title": "Narrow table",
        "sections": [{"id": "s1", "heading": "Notes", "doc": {"type": "doc", "content": [
            {"type": "table", "content": [{"type": "tableRow", "content": [cell("Scheme", 120), cell("Year", 90)]}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "after"}]}]}}],
        "explain": "", "connect": "", "nextReview": "2026-10-20", "reviewCount": 0, "lastReviewed": None,
        "createdAt": 7, "updatedAt": 7, "deletedAt": None})
    page.goto(URL + "#/n/wide-table")
    page.reload()
    page.wait_for_selector(".section-body table")
    tw = page.locator(".section-body table").bounding_box()["width"]
    check(tw < 400, f"a table with dragged column widths keeps them ({tw:.0f}px)")
    page.locator(".section-body td", has_text="Scheme").click()
    page.click("button[aria-label='Fit the table to the page width']")
    page.wait_for_timeout(150)
    tw = page.locator(".section-body table").bounding_box()["width"]
    check(tw > 700, f"Fit width stretches it to the page ({tw:.0f}px)")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    doc = page.evaluate(IDB_GET, "wide-table")["sections"][0]["doc"]
    check(doc["content"][0]["content"][0]["content"][0]["attrs"]["colwidth"] is None, "fitted widths are saved")
    check("clear" not in str(doc), "saved paragraphs carry no empty 'clear' setting")

    # ================= portrait touch bar: Undo and Redo =================
    pp = browser.new_context(viewport={"width": 800, "height": 1280}, has_touch=True, is_mobile=True).new_page()
    pp.goto(URL + "#/n/new/blank")
    pp.wait_for_selector("#f-title")
    pp.locator(".section-body .rich").first.tap()
    pp.keyboard.type("Portrait text")
    pp.wait_for_selector("#touchbar button[aria-label='Redo']")
    pp.tap("#touchbar button[aria-label='Undo']")
    check("Portrait" not in pp.locator(".section-body .rich").first.inner_text(), "touch bar Undo")
    pp.tap("#touchbar button[aria-label='Redo']")
    check("Portrait text" in pp.locator(".section-body .rich").first.inner_text(), "touch bar Redo")
    check(pp.locator("#note-undo").is_visible() and pp.locator("#note-redo").is_visible(), "header Undo / Redo on a portrait screen too")
    col = pp.locator(".canvas-col").bounding_box()["width"]
    check(col >= 700, f"portrait: the note uses the screen width ({col:.0f}px of 800)")

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
