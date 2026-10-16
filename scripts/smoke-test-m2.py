"""M2 smoke test: rich editor, sections, images, charts. Needs `vite preview` on :4173."""
import json
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


def slash(page, query):
    """Types /query at the start of an empty line and picks the first match (UI-2 slash menu)."""
    page.keyboard.type("/" + query)
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")


def mark(page, text):
    """Selects `text` (its last occurrence in the focused editor) and marks it from the floating toolbar."""
    # The editor finishes handling the last keystroke a few ms after it; a selection made
    # before that is put back to the caret. People can't select that fast; tests can.
    page.wait_for_timeout(150)
    page.evaluate("""(t) => {
        const root = document.activeElement.closest('.ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let hit = null, n;
        while ((n = w.nextNode())) { const i = n.textContent.lastIndexOf(t); if (i >= 0) hit = [n, i]; }
        if (!hit) throw new Error('text not found: ' + t);
        const r = document.createRange();
        r.setStart(hit[0], hit[1]);
        r.setEnd(hit[0], hit[1] + t.length);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
    }""", text)
    page.wait_for_selector("#bubble:not([hidden])")
    page.wait_for_timeout(150)
    page.click("#bubble button[aria-label='Highlight']")
    page.evaluate("""() => {
        const s = getSelection();
        let el = s.focusNode.nodeType === 1 ? s.focusNode : s.focusNode.parentElement;
        el = el.closest('p, h2, h3, h4, li > p, td > p, th > p');
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        s.removeAllRanges();
        s.addRange(r);
    }""")
    page.wait_for_timeout(100)


# a landscape photo and a portrait PNG
Image.new("RGB", (3000, 2000), (180, 90, 60)).save(OUT / "photo.jpg", quality=90)
Image.new("RGBA", (600, 900), (40, 120, 200, 128)).save(OUT / "diagram.png")

M1_NOTE = {
    "id": "m1-note", "subject": "GS2", "topic": "Polity", "title": "Old M1 note",
    "sections": [{"id": "s1", "heading": "Notes", "doc": {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Line one from M1"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "Line two from M1"}]}]}}],
    "explain": "", "connect": "", "nextReview": "2026-10-12", "reviewCount": 0, "lastReviewed": None,
    "createdAt": 1, "updatedAt": 1, "deletedAt": None,
}

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")

    # ---- an M1-format note opens in the rich editor unchanged ----
    page.evaluate("""(note) => new Promise((res, rej) => {
        const r = indexedDB.open('upsc-notes');
        r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite');
          tx.objectStore('notes').put(note); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); };
    })""", M1_NOTE)
    page.goto(URL + "#/n/m1-note")
    page.wait_for_selector(".rich")
    check("Line two from M1" in page.locator(".rich").first.inner_text(), "M1 note opens in rich editor")

    # ---- new rich note ----
    page.goto(URL + "#/n/new")
    page.click(".tpl-card[data-template='blank']")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Rich note test")
    ed = page.locator(".section-body .rich").first
    ed.click()
    slash(page, "heading")
    page.keyboard.type("Heading here")
    page.keyboard.press("Enter")
    slash(page, "dash")
    page.keyboard.type("dash one")
    page.keyboard.press("Enter")
    page.keyboard.type("dash two")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")  # leave list
    slash(page, "numbered")
    page.keyboard.type("first")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.keyboard.type("bold text")
    page.keyboard.press("Shift+Home")
    page.wait_for_selector("#bubble:not([hidden])", timeout=3000)
    page.wait_for_timeout(150)
    check(page.locator("#bubble").is_visible(), "floating toolbar appears on a selection")
    page.click("#bubble button[aria-label='Bold']")
    page.evaluate("""() => {
        const s = getSelection();
        let el = s.focusNode.nodeType === 1 ? s.focusNode : s.focusNode.parentElement;
        el = el.closest('p, h2, h3, h4, li > p, td > p, th > p');
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        s.removeAllRanges();
        s.addRange(r);
    }""")
    page.wait_for_timeout(100)
    page.keyboard.press("Enter")
    check(ed.locator("h2").count() == 1, "heading applied")
    check(ed.locator("ul[data-list-style='dash'] li").count() == 2, "dash list with 2 items")
    check(ed.locator("ol li").count() == 1, "numbered list")
    check(ed.locator("strong").count() == 1, "bold text")

    # table
    slash(page, "table")
    page.wait_for_selector("#table-dialog")  # 0.12: Insert → Table opens the size dialog (starts at 4 × 3)
    page.click("#tbl-rows-minus")
    page.click("#table-insert")
    check(ed.locator("table").count() == 1, "table inserted")
    check(page.locator(".tb-table").is_visible(), "table tools appear inside a table")
    page.click("button[aria-label='Add row below']")
    check(ed.locator("table tr").count() == 4, "row added (header + 3)")
    page.keyboard.type("cell text")

    # move caret out of the table to the end, then image
    ed.locator("p").last.click()
    with page.expect_file_chooser() as fc:
        slash(page, "image")
    fc.value.set_files([str(OUT / "photo.jpg"), str(OUT / "diagram.png")])
    page.wait_for_function("document.querySelectorAll('.img-block img[src]').length === 2", timeout=10000)
    check(True, "two images inserted and shown")
    widths = page.eval_on_selector_all(".img-block", "els => els.map(e => e.querySelector('.img-frame').style.width)")
    check(widths == ["100%", "50%"], f"default widths landscape 100%, portrait 50% ({widths})")

    # select first image, align right, resize by drag
    page.locator(".img-block img").first.click()
    page.wait_for_selector(".tb-align:not([hidden])")
    page.click("button[aria-label='Align image right']")
    check(page.locator(".img-block").first.get_attribute("data-align") == "right", "image aligned right")
    page.click("button[aria-label='Center image']")
    page.locator(".img-block img").first.click()
    h = page.locator(".resize-handle").first
    box = h.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] - 150, box["y"] + 10, steps=8)
    page.mouse.up()
    w = page.locator(".img-frame").first.evaluate("e => e.style.width")
    check(w not in ("100%", "") and int(w.rstrip('%')) < 100, f"drag resize shrinks image ({w})")

    # chart
    ed.locator("p").last.click()
    slash(page, "chart")
    page.wait_for_selector("#chart-gallery")
    page.click("#chart-gallery .gallery-tile[data-kind='column']")
    page.wait_for_selector(".chart-block svg")
    page.click(".chart-edit")
    page.fill(".chart-row input", "Seats won")
    page.locator(".chart-grid tr").nth(1).locator("input").nth(1).fill("42")
    page.click(".chart-actions button:has-text('Add row')")
    page.click(".chart-actions button:has-text('Done')")
    check(page.locator(".chart-title").inner_text() == "Seats won", "chart title saved")

    # sections
    page.fill(".section-heading >> nth=0", "Basics")
    page.click("#add-section")
    page.locator(".section-heading").nth(1).fill("Case law")
    page.locator(".section-body .rich").nth(1).click()
    page.keyboard.type("Kesavananda Bharati 1973")
    page.click(".section-head button[aria-label='Section 2 options']")
    page.click(".popover button[aria-label='Move section 2 up']")
    heads = page.eval_on_selector_all(".section-heading", "els => els.map(e => e.value)")
    check(heads == ["Case law", "Basics"], f"section reordered ({heads})")

    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    page.screenshot(path=str(OUT / "m2-editor.png"), full_page=True)

    # ---- persistence after reload ----
    page.reload()
    page.wait_for_selector(".section-body .rich")
    check(page.locator(".section-heading").nth(0).input_value() == "Case law", "sections persist")
    rich = page.locator(".section-body .rich").nth(1)
    check(rich.locator("ul[data-list-style='dash'] li").count() == 2, "dash list persists")
    check(rich.locator("table tr").count() == 4, "table persists")
    page.wait_for_function("document.querySelectorAll('.img-block img[src]').length === 2", timeout=10000)
    check(True, "images persist")
    check(page.locator(".chart-title").inner_text() == "Seats won", "chart persists")
    data = page.evaluate("""() => new Promise(res => { const r = indexedDB.open('upsc-notes');
        r.onsuccess = () => { const q = r.result.transaction('images').objectStore('images').getAll();
        q.onsuccess = () => res(q.result.map(i => [i.width, i.height, i.blob.type, i.blob.size])); }; })""")
    check(len(data) == 2 and data[0][0] <= 1600 and data[0][1] <= 1600, f"images compressed to <=1600px {data}")
    check(sorted(d[2] for d in data) == ["image/jpeg", "image/png"], "jpeg stays jpeg, png stays png")

    # ---- backup carries images ----
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    path = OUT / dl.value.suggested_filename
    dl.value.save_as(path)
    b = json.loads(path.read_text())
    check(b["counts"]["images"] == 2, "backup includes both images")

    # ---- removing an image frees its storage once the note is closed ----
    page.goto(URL + "#/notes")
    page.click(".note-card:has-text('Rich note test')")
    page.wait_for_function("document.querySelectorAll('.img-block img[src]').length === 2", timeout=10000)
    page.locator(".img-block img").nth(1).click()
    page.click("button[aria-label='Remove selected picture, chart or diagram']")
    page.wait_for_timeout(1500)
    page.goto(URL + "#/")
    page.wait_for_timeout(2500)
    n = page.evaluate("""() => new Promise(res => { const r = indexedDB.open('upsc-notes');
        r.onsuccess = () => { const q = r.result.transaction('images').objectStore('images').count(); q.onsuccess = () => res(q.result); }; })""")
    check(n == 1, f"unused image removed after closing note ({n} left)")

    # ---- portrait tablet layout ----
    pc = browser.new_context(viewport={"width": 800, "height": 1280})
    pp = pc.new_page()
    pp.on("pageerror", lambda e: errors.append(str(e)))
    pp.goto(URL + "#/n/new/blank")
    pp.wait_for_selector(".canvas-head")
    overflow = pp.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    check(not overflow, "portrait: no sideways page scroll")
    pp.screenshot(path=str(OUT / "m2-portrait.png"))
    pc.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
