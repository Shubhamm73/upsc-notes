"""0.11 smoke test: any text beside a picture, sketch or chart. Needs `vite preview` on :4173.

Before 0.11 a heading never sat beside a floated picture: it (and everything after it) jumped below, and a
chart could not sit beside text at all. Now: a line turned into a heading beside a picture stays beside it
(slash menu, "## "), "↑ Beside picture / ↓ Below picture" work on headings, bold / italic / highlight / lists /
callouts sit beside it, a sketch the same, a chart gets Left / Center / Right (and keeps it through Edit data),
headings in notes written before 0.11 keep their place (opening such a note rewrites nothing), and the PDF
prints headings beside the picture too.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

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
NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""
# Where each block of the first section is: its text's left edge against the picture's right edge and bottom.
LAYOUT = """() => { const rich = document.querySelector('.section-body .rich');
  const pic = rich.querySelector('.img-block, .sketch-block, .chart-block'); const pr = pic.getBoundingClientRect();
  return Array.from(rich.children).filter(e => e !== pic).map(e => { const rg = document.createRange(); rg.selectNodeContents(e);
    const r = rg.getClientRects()[0] || e.getBoundingClientRect();
    return { tag: e.tagName, text: e.textContent.trim().slice(0, 30), beside: r.left >= pr.right - 1 && r.top < pr.bottom, below: r.top >= pr.bottom - 1 }; }); }"""


def caret_end(page, text):
    page.wait_for_timeout(150)
    page.evaluate("""(t) => {
        const root = document.querySelector('.section-body .ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) if (n.textContent.includes(t)) break;
        const el = n.parentElement.closest('p, h2, h3, h4, li');
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        getSelection().removeAllRanges(); getSelection().addRange(r);
    }""", text)
    page.wait_for_timeout(150)


def select_text(page, text):
    page.wait_for_timeout(150)
    page.evaluate("""(t) => {
        const root = document.querySelector('.section-body .ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) { const i = n.textContent.indexOf(t); if (i >= 0) {
          const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length);
          getSelection().removeAllRanges(); getSelection().addRange(r); return; } }
        throw new Error('not found ' + t);
    }""", text)
    page.wait_for_timeout(200)


def slash(page, query):
    page.keyboard.type("/" + query)
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")


def where(page, text):
    return next((b for b in page.evaluate(LAYOUT) if text in b["text"]), None)


def doc_blocks(page, title):
    return page.evaluate(NOTE, title)["sections"][0]["doc"]["content"]


def save_pdf(page, name):
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / name
    dl.value.save_as(pdf)
    return pdf


def word_x(pdf, word):
    """Left edge (pt) of the first occurrence of a word in the PDF (pdftotext -bbox)."""
    html = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], capture_output=True, text=True).stdout
    import re
    m = re.search(r'<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>' + re.escape(word) + "</word>", html)
    return (float(m.group(1)), float(m.group(2))) if m else None


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    png = page.evaluate("""() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const g = c.getContext('2d');
        g.fillStyle = '#c82828'; g.fillRect(0, 0, 800, 600); return c.toDataURL('image/png'); }""")

    # ================= a picture, then a heading beside it =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Heading beside")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("Intro line beside the map.")
    page.evaluate(PASTE, [png])
    page.wait_for_selector(".img-block img")
    page.wait_for_timeout(300)
    page.click(".img-block img")
    page.click("button[aria-label='Align image left']")
    page.wait_for_timeout(200)
    check(where(page, "Intro line")["beside"], "the line before the picture sits beside it")
    caret_end(page, "Intro line")
    page.keyboard.press("Enter")
    slash(page, "heading")
    page.keyboard.type("Causes of the drought")
    page.keyboard.press("Enter")
    page.keyboard.type("Plain text after the heading.")
    page.keyboard.press("Enter")
    page.keyboard.type("- first point")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    slash(page, "case")
    page.keyboard.type("A case beside the picture")
    page.wait_for_timeout(1200)
    lay = page.evaluate(LAYOUT)
    check(where(page, "Causes of the drought")["tag"].startswith("H") and where(page, "Causes of the drought")["beside"], f"a heading made beside the picture stays beside it ({lay})")
    check(where(page, "Plain text after")["beside"] and where(page, "first point")["beside"] and where(page, "A case beside")["beside"],
          "text, a list and a callout after that heading stay beside the picture too")
    blocks = doc_blocks(page, "Heading beside")
    head = next(b for b in blocks if b["type"] == "heading")
    check(head.get("attrs", {}).get("clear") is False, f"saved: the heading carries clear: false ({head.get('attrs')})")
    para = next(b for b in blocks if b["type"] == "paragraph")
    check("clear" not in para.get("attrs", {}), "paragraphs keep their old shape (no clear attribute)")

    # inline formatting beside the picture
    select_text(page, "Plain text")
    page.keyboard.press("Control+b")
    select_text(page, "after the")
    page.keyboard.press("Control+i")
    select_text(page, "heading.")
    page.keyboard.press("Control+Shift+h")
    page.wait_for_timeout(1200)
    para = next(b for b in doc_blocks(page, "Heading beside") if b["type"] == "paragraph" and "Plain" in json.dumps(b))
    marks = {m["type"] for t in para["content"] for m in t.get("marks", [])}
    check({"bold", "italic", "highlight"} <= marks and where(page, "Plain text after")["beside"], f"bold, italic and highlight on a line beside the picture ({marks})")

    # ↓ Below picture / ↑ Beside picture on a heading
    caret_end(page, "Causes of the drought")
    page.wait_for_selector("#ctxbar button:has-text('↓ Below picture'):visible")
    page.click("#ctxbar button:has-text('↓ Below picture')")
    page.wait_for_timeout(300)
    check(where(page, "Causes of the drought")["below"], "↓ Below picture moves the heading under the picture")
    page.wait_for_timeout(1000)
    head = next(b for b in doc_blocks(page, "Heading beside") if b["type"] == "heading")
    check("clear" not in head.get("attrs", {}), f"…saved as a plain heading, as before 0.11 ({head.get('attrs')})")
    caret_end(page, "Causes of the drought")
    page.click("#ctxbar button:has-text('↑ Beside picture')")
    page.wait_for_timeout(300)
    check(where(page, "Causes of the drought")["beside"], "↑ Beside picture puts it back")
    page.click("#note-undo") if page.locator("#note-undo").count() else page.keyboard.press("Control+z")
    page.wait_for_timeout(300)
    check(where(page, "Causes of the drought")["below"], "one Undo step")
    page.keyboard.press("Control+Shift+z")
    page.wait_for_timeout(300)

    # "## " typed beside the picture
    caret_end(page, "A case beside")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.keyboard.type("## Way out")
    page.wait_for_timeout(300)
    w = where(page, "Way out")
    check(w and w["tag"] == "H2" and w["beside"], f"'## ' beside the picture makes a heading that stays beside it ({w})")

    pdf = save_pdf(page, "beside.pdf")
    hx = word_x(pdf, "Causes")
    check(hx is not None and hx[0] > 230, f"PDF: the heading prints beside the picture ({hx})")

    # ================= a note from before 0.11 =================
    old = {
        "id": "old-heading-note", "subject": "GS1", "topic": "", "title": "Old heading note", "explain": "", "connect": "",
        "nextReview": "2026-10-20", "reviewCount": 0, "lastReviewed": None, "createdAt": 1760000000000, "updatedAt": 1760000000000, "deletedAt": None,
        "sections": [{"id": "s1", "heading": "Notes", "doc": {"type": "doc", "content": [
            {"type": "sketchBlock", "attrs": {"strokes": [], "height": 600, "width": 50, "align": "left", "caption": ""}},
            {"type": "paragraph", "content": [{"type": "text", "text": "Old text beside."}]},
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Old heading below"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "Old text under the heading."}]}]}}]
    }
    page.evaluate(IDB_PUT, old)
    page.goto(URL + "#/notes")
    page.reload()
    page.goto(URL + "#/n/old-heading-note")
    page.wait_for_selector(".sketch-block")
    page.wait_for_timeout(600)
    check(where(page, "Old text beside")["beside"] and where(page, "Old heading below")["below"] and where(page, "Old text under")["below"],
          "a note from before 0.11: its heading still starts below the sketch (layout unchanged)")
    page.goto(URL + "#/notes")
    page.wait_for_timeout(300)
    check(page.evaluate(NOTE, "Old heading note")["updatedAt"] == 1760000000000, "opening and leaving it rewrites nothing")
    page.goto(URL + "#/n/old-heading-note")
    page.wait_for_selector(".sketch-block")
    caret_end(page, "Old heading below")
    page.click("#ctxbar button:has-text('↑ Beside picture')")
    page.wait_for_timeout(300)
    check(where(page, "Old heading below")["beside"] and where(page, "Old text under")["beside"], "↑ Beside picture brings an old heading (and what follows) up beside the sketch")
    caret_end(page, "Old text beside")
    page.keyboard.press("Enter")
    slash(page, "heading")
    page.keyboard.type("New heading by a sketch")
    page.wait_for_timeout(300)
    check(where(page, "New heading by a sketch")["beside"], "a heading made beside a sketch stays beside it")

    # ================= a chart beside text =================
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Chart beside")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("GDP growth slowed in the last quarter.")
    page.keyboard.press("Enter")
    slash(page, "chart")
    page.wait_for_selector("#chart-gallery")
    page.click("#chart-gallery .gallery-tile[data-kind='column']")
    page.wait_for_selector(".chart-block svg")
    page.click(".chart-title")
    page.wait_for_timeout(200)
    check(page.locator("#ctxbar .tb-align .ctx-label").text_content() == "Chart", "a selected chart: the tools say Chart")
    check(page.locator("#ctxbar .tb-align button:has-text('Crop & shape')").is_hidden() and page.locator("#image-caption").is_hidden(), "no Crop & shape or caption for a chart (it has a title)")
    page.click("button[aria-label='Align image left']")
    page.wait_for_timeout(300)
    fig = page.locator(".chart-block")
    check(fig.get_attribute("data-align") == "left" and abs(fig.bounding_box()["width"] / page.locator(".section-body .rich").first.bounding_box()["width"] - 0.5) < 0.05,
          "Left: the chart floats at half the width")
    check(where(page, "GDP growth")["beside"], "the line typed before the chart now sits beside it")
    caret_end(page, "GDP growth")
    page.keyboard.press("Enter")
    slash(page, "heading")
    page.keyboard.type("Why it slowed")
    page.wait_for_timeout(300)
    check(where(page, "Why it slowed")["beside"], "a heading beside the chart")
    page.click(".chart-edit")
    page.fill(".chart-row input", "GDP growth, %")
    page.click(".chart-actions button:has-text('Done')")
    page.wait_for_timeout(1200)
    chart = next(b for b in doc_blocks(page, "Chart beside") if b["type"] == "chart")
    check(chart["attrs"]["align"] == "left" and chart["attrs"]["width"] == 50 and chart["attrs"]["title"] == "GDP growth, %", f"Edit data keeps the chart's place ({chart['attrs']['align']}, {chart['attrs']['width']})")
    page.click(".chart-title")
    page.click("button[aria-label='Center image']")
    page.wait_for_timeout(300)
    check(page.locator(".chart-block").get_attribute("data-align") == "center" and where(page, "GDP growth")["below"], "Center: the chart takes its own row again (the text under it)")
    page.click(".chart-title")
    page.click("button[aria-label='Align image right']")
    page.wait_for_timeout(1200)
    pdf = save_pdf(page, "chart.pdf")
    t = word_x(pdf, "slowed")
    c = word_x(pdf, "GDP")
    check(t is not None and c is not None, f"PDF has the text and the chart title ({t}, {c})")
    ct = word_x(pdf, "growth,")
    check(t and ct and t[0] < 200 and ct[0] > 280 and abs(ct[1] - t[1]) < 40, f"PDF: a Right chart prints on the right with the text beside it ({t}, title {ct})")
    page.screenshot(path=str(OUT / "chart-beside.png"))

    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
