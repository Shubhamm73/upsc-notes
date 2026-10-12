"""M4 smoke test: PDF export for a section, a note, and everything. Needs `vite preview` on :4173."""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from pypdf import PdfReader
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


def text_of(pdf: Path) -> str:
    return subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout


def image_count(pdf: Path) -> int:
    n = 0
    for page in PdfReader(str(pdf)).pages:
        n += len(page.images)
    return n


Image.new("RGB", (1200, 800), (180, 90, 60)).save(OUT / "photo.jpg")

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---- build a note with every block type ----
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Parliament")
    page.select_option("#f-subject", "GS2")
    page.fill("#f-topic", "Polity")
    page.fill(".section-heading", "Composition")
    ed = page.locator(".section-body .rich").first
    ed.click()
    slash(page, "heading")
    page.keyboard.type("Lok Sabha basics")
    page.keyboard.press("Enter")
    slash(page, "dash")
    page.keyboard.type("Max strength 552")
    page.keyboard.press("Enter")
    page.keyboard.type("Article 81")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    slash(page, "numbered")
    page.keyboard.type("Speaker elected")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.keyboard.type("Money bills start here")
    mark(page, "Money bills start here")
    page.keyboard.press("Enter")
    slash(page, "table")
    page.keyboard.type("House")
    page.keyboard.press("Tab")
    page.keyboard.type("Term")
    page.keyboard.press("Tab")
    page.keyboard.type("Seats")
    page.keyboard.press("Tab")
    page.keyboard.type("Lok Sabha")
    page.keyboard.press("Tab")
    page.keyboard.type("5 years")
    ed.locator("p").last.click()
    with page.expect_file_chooser() as fc:
        slash(page, "image")
    fc.value.set_files(str(OUT / "photo.jpg"))
    page.wait_for_selector(".img-block img[src]")
    ed.locator("p").last.click()
    slash(page, "chart")
    page.wait_for_selector(".chart-block canvas")
    page.click("#add-section")
    page.locator(".section-heading").nth(1).fill("Powers")
    page.locator(".section-body .rich").nth(1).click()
    page.keyboard.type("No-confidence motion only in Lok Sabha")
    page.click("#details summary")
    page.fill("#f-explain", "Parliament makes laws and holds the executive to account.")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)

    def grab(*click_selectors):
        with page.expect_download(timeout=60000) as dl:
            for sel in click_selectors:
                page.click(sel)
        path = OUT / dl.value.suggested_filename
        dl.value.save_as(path)
        return path

    # ---- section PDF ----
    # the section PDF now lives in the section's menu in the outline rail
    sec = grab("#outline button[aria-label='Section 2 options']", ".popover button[aria-label='Export section 2 as PDF']")
    t = text_of(sec)
    check(sec.name == "Parliament-Powers.pdf", f"section file name ({sec.name})")
    check("No-confidence motion" in t and "Max strength" not in t, "section PDF holds only that section")

    # ---- note PDF ----
    note = grab("#note-pdf")
    t = text_of(note)
    for needle in ["Parliament", "GS2 · Polity", "Composition", "Lok Sabha basics", "– Max strength 552", "1. Speaker elected",
                   "Money bills start here", "House", "5 years", "Untitled chart", "Powers", "In my own words"]:
        check(needle in t, f"note PDF contains '{needle}'")
    imgs = image_count(note)
    check(imgs >= 2, f"note PDF embeds photo and chart ({imgs} images)")
    subprocess.run(["pdftoppm", "-png", "-r", "60", "-f", "1", "-l", "1", str(note), str(OUT / "note-page")])

    # ---- vocab + full PDF ----
    page.goto(URL + "#/v/new")
    page.fill("#v-word", "Bicameral")
    page.fill("#v-meaning", "Having two houses")
    page.fill(".use-sentence", "India has a bicameral Parliament.")
    page.fill("#v-syn", "two-chambered")
    page.keyboard.press("Enter")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    page.goto(URL + "#/settings")
    full = grab("#pdf-all")
    t = text_of(full)
    pages = len(PdfReader(str(full)).pages)
    check("Contents" in t and "GS2" in t and "Vocabulary" in t and "Bicameral" in t, "full PDF has contents, subject, vocabulary")
    check(pages >= 4, f"full PDF has cover, contents, notes, vocabulary pages ({pages})")
    check("1 notes · 1 words" in t, "cover shows counts")

    page.select_option("#pdf-subject", "GS3")
    page.uncheck("#pdf-vocab")
    empty = grab("#pdf-all")
    check("Nothing to export" in text_of(empty), "empty subject explains itself")

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
