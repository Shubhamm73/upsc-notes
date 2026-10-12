"""0.8.2 smoke test: paste from anywhere, and images beside text. Needs `vite preview` on :4173.

Paste: screenshots / copied pictures, web HTML with pictures (copied onto the tablet, never linked),
headings mapped to the note's levels, "- / 1." text to real lists, a paste always beats the slash
menu, dropped image files. Wrap: Left/Right float the image with text and bullets beside it (the
line typed before the picture moves beside it), Center stays on its own row, resize, reload, PDF.
"""
import json
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


PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC"

# Dispatches a real paste event with the given clipboard (what Ctrl+V / long-press Paste deliver).
PASTE = """async ([files, data]) => {
  const dt = new DataTransfer();
  for (const src of files) { const b = await (await fetch(src)).blob(); dt.items.add(new File([b], 'shot.png', { type: b.type || 'image/png' })); }
  for (const [t, v] of Object.entries(data)) dt.setData(t, v);
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}"""
DROP = """async ([src, x, y]) => {
  const dt = new DataTransfer();
  const b = await (await fetch(src)).blob(); dt.items.add(new File([b], 'map.png', { type: 'image/png' }));
  const target = document.elementFromPoint(x, y);
  for (const type of ['dragenter', 'dragover', 'drop'])
    target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}"""
IMAGES = """() => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('images').objectStore('images').count(); g.onsuccess = () => { q.result.close(); r(g.result); }; }; })"""
NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""


def clear(page):
    page.keyboard.press("Control+a")
    page.keyboard.press("Delete")
    page.wait_for_timeout(100)


def text_rect(page, text):
    """Bounding box of a run of text (a paragraph's own box spans the column even when its text wraps a float)."""
    return page.evaluate("""(t) => { const w = document.createTreeWalker(document.querySelector('.section-body .rich'), NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) { const i = n.textContent.indexOf(t); if (i >= 0) { const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + Math.min(t.length, 12)); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right }; } } return null; }""", text)


Image.new("RGB", (1200, 900), (60, 120, 180)).save(OUT / "photo.jpg")

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Paste test")
    ed = page.locator(".section-body .rich").first
    ed.click()

    # ---- a screenshot / "Copy image" (a picture file on the clipboard) ----
    page.evaluate(PASTE, [[PNG], {"text/html": f'<img src="{PNG}">'}])
    page.wait_for_selector(".img-block img[src^='blob:']", timeout=5000)
    check(ed.locator(".img-block").count() == 1, "pasted picture becomes an image block")
    check(page.evaluate(IMAGES) == 1, "pasted picture is stored on the tablet")
    clear(page)

    # ---- web page: text, bold, a picture (same-origin and data:), h1, bullets ----
    same_origin = URL + "icons/icon-192.png"
    page.evaluate(PASTE, [[], {"text/html": f'<h1>Big heading</h1><p>Web text <b>bold</b></p><img src="{same_origin}"><ul><li>web bullet</li></ul><p><img src="{PNG}"></p>', "text/plain": "Big heading Web text bold web bullet"}])
    page.wait_for_function("document.querySelectorAll('.section-body .img-block img[src^=\"blob:\"]').length === 2", timeout=8000)
    check(ed.locator("h2").inner_text() == "Big heading", "web h1 lands as a Heading")
    check(ed.locator("strong").inner_text() == "bold" and ed.locator("ul li").count() == 1, "web formatting and bullets kept")
    check(ed.locator(".img-frame.loading").count() == 0, "web pictures copied onto the tablet")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    saved = json.dumps(page.evaluate(NOTE, "Paste test"))
    check("icon-192" not in saved and "data:image" not in saved, "the saved note keeps no web addresses, only stored images")
    clear(page)

    # ---- a picture the website won't hand over: removed, with a hint ----
    page.evaluate(PASTE, [[], {"text/html": '<p>Caption text</p><img src="http://localhost:9/blocked.png">', "text/plain": "Caption text"}])
    expect(page.locator(".toast")).to_contain_text("couldn't be copied", timeout=8000)
    check(ed.locator(".img-block").count() == 0 and "Caption text" in ed.inner_text(), "unreachable web picture removed, text kept")
    clear(page)

    # ---- a paste always beats the slash menu ----
    page.keyboard.type("/tab")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.evaluate(PASTE, [[], {"text/plain": "Pasted over the menu"}])
    page.wait_for_timeout(200)
    check(page.locator("#insert-menu").is_hidden(), "paste closes the slash menu")
    check(ed.inner_text().strip() == "Pasted over the menu", f"paste replaces the typed /word ({ed.inner_text().strip()!r})")
    clear(page)
    page.evaluate(PASTE, [[], {"text/plain": "/notes on polity"}])
    page.wait_for_timeout(200)
    check(page.locator("#insert-menu").is_hidden(), "pasted text starting with / doesn't open the menu")
    clear(page)

    # ---- "- point" / "1. step" text becomes real lists ----
    page.evaluate(PASTE, [[], {"text/plain": "Features:\n- federal\n- parliamentary\n• secular\n1. Preamble\n2. Part III"}])
    page.wait_for_timeout(200)
    check(ed.locator("ul[data-list-style='dash'] li").count() == 2, "'- ' lines become a dash list")
    check(ed.locator("ul:not([data-list-style]) li").count() == 1, "'• ' lines become a bullet list")
    check(ed.locator("ol li").count() == 2 and "Features:" in ed.locator("p").first.inner_text(), "'1. ' lines become a numbered list, other lines stay text")
    clear(page)

    # ---- dropping an image file ----
    box = ed.bounding_box()
    before = page.evaluate(IMAGES)
    page.evaluate(DROP, [PNG, box["x"] + 20, box["y"] + 10])
    page.wait_for_selector(".section-body .img-block img[src^='blob:']", timeout=5000)
    check(page.evaluate(IMAGES) == before + 1, "dropped image file is stored and inserted")
    clear(page)

    # ---- image beside text: the line typed first moves beside the picture ----
    page.keyboard.type("Separation of powers keeps each organ in check, so no single institution holds all power.")
    page.keyboard.press("Enter")
    with page.expect_file_chooser() as fc:
        page.keyboard.type("/image")
        page.wait_for_selector("#insert-menu:not([hidden])")
        page.keyboard.press("Enter")
    fc.value.set_files(str(OUT / "photo.jpg"))
    page.wait_for_selector(".section-body .img-block img[src^='blob:']")
    page.locator(".section-body .img-block img").click()
    check(page.locator(".tb-align button[aria-label='Align image left']").inner_text() == "Left · text beside", "image tools say text goes beside")
    page.click("button[aria-label='Align image left']")
    page.wait_for_timeout(200)
    fig = page.locator(".section-body .img-block")
    check(fig.get_attribute("data-align") == "left", "image aligned left")
    check(page.locator(".section-body .img-frame").evaluate("e => e.closest('figure').style.width") == "50%", "full-width picture narrowed to half to make room")
    first_block = page.evaluate("document.querySelector('.section-body .rich').firstElementChild.tagName")
    check(first_block == "FIGURE", "picture moved up beside the line typed before it")
    ib = fig.bounding_box()
    t = text_rect(page, "Separation of powers")
    check(t and t["x"] >= ib["x"] + ib["width"] - 1 and t["y"] < ib["y"] + ib["height"], f"text sits to the right of the picture ({t}, {ib})")
    # click the text beside the picture (an empty line's box runs under the float), then go to the end
    page.mouse.click(t["right"] + 5, t["y"] + 5)
    page.wait_for_timeout(150)
    page.keyboard.press("Control+End")
    page.wait_for_timeout(150)
    page.keyboard.type("/dash")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.keyboard.type("bullet beside the picture")
    li = page.locator(".section-body li").first.bounding_box()
    check(li["x"] >= ib["x"] + ib["width"] - 1 and li["y"] < ib["y"] + ib["height"], "a bullet list sits beside the picture too")

    # right: text on the left
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Align image right']")
    page.wait_for_timeout(200)
    ib = fig.bounding_box()
    t = text_rect(page, "Separation of powers")
    check(t and t["right"] <= ib["x"] + 1 and t["y"] < ib["y"] + ib["height"], "Right: text sits to the left of the picture")

    # resize a floated picture
    page.locator(".section-body .img-block img").click()
    hb = page.locator(".section-body .resize-handle").bounding_box()
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
    page.mouse.down()
    page.mouse.move(hb["x"] + 80, hb["y"] + 10, steps=6)  # handle is on the left of a right-floated picture
    page.mouse.up()
    w = fig.evaluate("e => e.style.width")
    check(w.endswith("%") and int(w[:-1]) < 50, f"floated picture resizes ({w})")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)

    # center: own row again
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Center image']")
    page.wait_for_timeout(200)
    ib = fig.bounding_box()
    t = text_rect(page, "Separation of powers")
    check(t["y"] >= ib["y"] + ib["height"] - 1, "Center: the picture has its own row, text below")
    page.locator(".section-body .img-block img").click()
    page.click("button[aria-label='Align image left']")
    page.wait_for_timeout(200)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    page.screenshot(path=str(OUT / "wrap.png"))

    page.reload()
    page.wait_for_selector(".section-body .img-block img[src^='blob:']")
    check(page.locator(".section-body .img-block").get_attribute("data-align") == "left", "wrap survives reload")
    ib = page.locator(".section-body .img-block").bounding_box()
    t = text_rect(page, "Separation of powers")
    check(t["x"] >= ib["x"] + ib["width"] - 1, "text still beside the picture after reload")

    # PDF: picture and its text side by side
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / dl.value.suggested_filename
    dl.value.save_as(pdf)
    lines = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout.splitlines()
    ind = lambda l: len(l) - len(l.lstrip())
    line = next((l for l in lines if "Separation of powers" in l), "")
    head = next((l for l in lines if l.strip() == "Notes"), "")
    # pdftotext squeezes the gap, but text beside a picture starts well to the right of the heading
    check(line and ind(line) >= ind(head) + 10, f"PDF: text printed beside the picture (indent {ind(line)} vs heading {ind(head)})")

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
