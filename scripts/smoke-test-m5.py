"""v0.5 smoke test: CSAT->Interview migration, quick insights, trash, unified search, inline links."""
import subprocess
import sys
import tempfile
from pathlib import Path

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


IDB_PUT = """([store, rec, version]) => new Promise((res, rej) => {
  const r = indexedDB.open('upsc-notes', version);
  r.onupgradeneeded = () => { const d = r.result;
    for (const [n, k] of [['notes','id'],['vocab','id'],['images','id'],['meta','key']]) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, {keyPath: k}); };
  r.onsuccess = () => { const tx = r.result.transaction(store, 'readwrite'); tx.objectStore(store).put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); };
})"""
IDB_GET = """([store, id]) => new Promise(res => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const q = r.result.transaction(store).objectStore(store).get(id); q.onsuccess = () => res(q.result || null); }; })"""
IDB_COUNT = """(store) => new Promise(res => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const q = r.result.transaction(store).objectStore(store).count(); q.onsuccess = () => res(q.result); }; })"""

OLD = {"id": "old-csat", "subject": "CSAT", "topic": "Comprehension", "title": "Old CSAT note",
       "sections": [{"id": "s1", "heading": "Notes", "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}],
       "explain": "", "connect": "", "nextReview": "2026-10-12", "reviewCount": 0, "lastReviewed": None,
       "createdAt": 1, "updatedAt": 1, "deletedAt": None}
STALE = dict(OLD, id="stale-trash", subject="GS1", title="Trashed 40 days ago", deletedAt=1)

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---- a v1 database (Dexie stores version*10) with a CSAT note and an old trashed note ----
    page.goto(URL + "favicon.svg")
    page.evaluate(IDB_PUT, ["notes", OLD, 10])
    page.evaluate(IDB_PUT, ["notes", STALE, 10])
    page.goto(URL + "#/notes")
    page.wait_for_selector(".note-card")
    n = page.evaluate(IDB_GET, ["notes", "old-csat"])
    check(n and n["subject"] == "Interview", f"CSAT note migrated to Interview ({n and n['subject']})")
    check(page.evaluate(IDB_GET, ["notes", "stale-trash"]) is None, "item in trash over 30 days purged on launch")
    chips = page.eval_on_selector_all(".chips button", "e => e.map(x => x.textContent)")
    check("Interview" in chips and "CSAT" not in chips, f"subject chips show Interview ({chips})")

    # ---- quick insights ----
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Fundamental Rights")
    page.fill(".section-heading", "Basics")
    ed = page.locator(".section-body .rich").first
    ed.click()
    page.keyboard.type("Part III of the Constitution. Justiciable rights unlike DPSP.")
    mark(page, "Justiciable rights")
    page.keyboard.press("Enter")
    slash(page, "dash")
    page.keyboard.type("Article 32 is the heart and soul")
    mark(page, "Article 32 is the heart and soul")
    page.click("#add-section")
    page.locator(".section-heading").nth(1).fill("Cases")
    page.locator(".section-body .rich").nth(1).click()
    page.keyboard.type("Maneka Gandhi 1978")
    mark(page, "Maneka Gandhi 1978")
    check(page.locator("#insights details").count() == 0, "no insights card before review")
    page.click("#mark-reviewed")
    page.wait_for_selector("#insights details")
    items = page.eval_on_selector_all("#insights li", "e => e.map(x => x.textContent)")
    check(items == ["Justiciable rights", "Article 32 is the heart and soul", "Maneka Gandhi 1978"], f"insights from highlights in order ({items})")
    sections = page.eval_on_selector_all("#insights .insight-section", "e => e.map(x => x.textContent)")
    check(sections == ["Basics", "Cases"], f"insights grouped by section ({sections})")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    page.reload()
    page.wait_for_selector("#insights details")
    check(page.locator("#insights li").count() == 3, "insights persist after reload")
    check("3 quick insights" in page.locator(".note-card[aria-current='true']").inner_text(), "list card shows insight count")
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / dl.value.suggested_filename
    dl.value.save_as(pdf)
    txt = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    check("Quick insights" in txt and "Article 32 is the heart and soul" in txt, "note PDF starts with quick insights")
    page.screenshot(path=str(OUT / "insights.png"))

    # ---- inline link box ----
    page.locator(".section-body .rich").nth(1).click()
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type("Indian Kanoon")
    page.keyboard.press("Shift+Home")
    page.wait_for_selector("#bubble:not([hidden])")
    page.wait_for_timeout(150)
    page.click("#bubble button[aria-label='Add, edit or remove a link']")
    check(page.locator(".link-row").is_visible(), "inline link box opens (no pop-up)")
    page.fill(".link-input", "indiankanoon.org")
    page.keyboard.press("Enter")
    href = page.locator(".section-body .rich").nth(1).locator("a").first.get_attribute("href")
    check(href == "https://indiankanoon.org", f"link inserted with https ({href})")

    # ---- unified search ----
    page.goto(URL + "#/v/new")
    page.fill("#v-word", "Justiciable")
    page.fill("#v-meaning", "Enforceable in a court")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    page.goto(URL + "#/notes")
    page.fill("#search", "justiciable")
    check(page.locator(".note-card:not(.word-card)").count() == 1 and page.locator(".word-card").count() == 1, "search finds the note and the word")

    # ---- trash: move, restore, delete forever ----
    page.fill("#search", "")
    page.click(".note-card:has-text('Old CSAT note')")
    page.click("#details summary")
    page.click("#note-trash")
    page.wait_for_timeout(500)
    check(page.locator(".note-card:has-text('Old CSAT note')").count() == 0, "trashed note leaves the list")
    page.goto(URL + "#/trash")
    page.wait_for_selector(".trash-row")
    check("removed for good in 30 days" in page.locator(".trash-row").first.inner_text(), "trash shows days left")
    page.click(".trash-row button:has-text('Restore')")
    page.wait_for_timeout(500)
    check(page.locator(".trash-row").count() == 0, "restore empties trash")
    page.goto(URL + "#/notes")
    check(page.locator(".note-card:has-text('Old CSAT note')").count() == 1, "restored note is back")

    page.click(".note-card:has-text('Fundamental Rights')")
    page.click("#details summary")
    page.click("#note-trash")
    page.wait_for_url("**/#/notes")
    page.goto(URL + "#/trash")
    page.click(".trash-row button:has-text('Delete forever')")
    btn = page.locator(".confirm-panel button:has-text('Delete forever')")
    check(btn.is_disabled(), "delete forever disabled until DELETE typed")
    page.fill(".confirm-input", "delete")
    check(btn.is_disabled(), "lowercase delete is not accepted")
    page.fill(".confirm-input", "DELETE")
    btn.click()
    page.wait_for_timeout(800)
    left = page.evaluate(IDB_COUNT, "notes")
    check(left == 1, f"note deleted forever ({left} notes left)")

    # word trash + empty trash
    page.goto(URL + "#/vocab")
    page.click(".note-card:has-text('Justiciable')")
    page.click("#word-trash")
    page.wait_for_url("**/#/vocab")
    page.goto(URL + "#/trash")
    page.click("#empty-trash")
    page.fill(".confirm-input", "DELETE")
    page.click(".confirm-panel button:has-text('Delete forever')")
    page.wait_for_timeout(800)
    check(page.evaluate(IDB_COUNT, "vocab") == 0, "empty trash removes words for good")
    check("Trash is empty" in page.locator("#trash-list").inner_text(), "trash shows empty")
    page.screenshot(path=str(OUT / "trash.png"))

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
