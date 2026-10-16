"""0.13 smoke test: diagrams from words. Needs `vite preview` on :4173.

Insert → Diagram (or the gallery's "From words" group) inserts one of eight diagrams as a `diagram` node:
timeline, flowchart, cycle, pyramid, Venn, hierarchy, comparison, 2×2 matrix. Each starts with real UPSC
example words and draws as SVG in the Study desk colours. Edit diagram opens a panel under it: title, type,
items (text, detail, colour, move up/down, delete, add), tree levels (← →), comparison columns, Venn up to 3
sets, a 2×2 up to 4 boxes. Done is one undo step, Cancel changes nothing. Every word is searchable; the PDF
prints each diagram as vector drawing (no picture). Night redraws in night colours.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from pypdf import PdfReader

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []

KINDS = ["timeline", "flow", "cycle", "pyramid", "venn", "tree", "compare", "matrix"]
SAMPLE = {
    "timeline": ("National movement", "Jallianwala"),
    "flow": ("How a Bill becomes law", "Becomes an Act"),
    "cycle": ("Water cycle", "Condensation"),
    "pyramid": ("Ecological pyramid", "Producers"),
    "venn": ("Fundamental Rights and DPSP", "DPSP"),
    "tree": ("Parliament of India", "Rajya Sabha"),
    "compare": ("Lok Sabha vs Rajya Sabha", "Money Bill"),
    "matrix": ("SWOT: India's space sector", "Opportunities"),
}


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""
TITLE = "Polity diagrams"


def diagrams(page):
    return [b for b in page.evaluate(NOTE, TITLE)["sections"][0]["doc"]["content"] if b["type"] == "diagram"]


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def settle(page):
    """Autosave waits ~0.8 s after the last change; read IndexedDB only after it."""
    page.wait_for_timeout(1100)
    saved(page)


def slash(page, query):
    page.keyboard.type("/" + query)
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")


def to_end(page):
    page.evaluate("""() => { const pm = document.querySelector('.section-body .ProseMirror'); pm.focus();
      const s = getSelection(); s.selectAllChildren(pm); s.collapseToEnd(); }""")
    page.wait_for_timeout(100)


def insert(page, kind):
    to_end(page)
    slash(page, "diagram")
    page.wait_for_selector("#chart-gallery")
    page.click(f"#gallery-words .gallery-tile[data-kind='{kind}']")
    page.wait_for_selector(f".diagram-block[data-kind='{kind}'] svg")
    page.wait_for_timeout(150)


def svg_text(loc):
    return loc.locator("svg").evaluate("s => [...s.querySelectorAll('text')].map(t => t.textContent).join(' | ')")


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", TITLE)
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("Diagrams below.")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    saved(page)

    # ================= Insert → Diagram =================
    slash(page, "diagram")
    page.wait_for_selector("#chart-gallery")
    focused = page.evaluate("() => [document.activeElement.closest('.gallery-group')?.id, document.activeElement.dataset.kind]")
    check(focused == ["gallery-words", "timeline"], f"Insert → Diagram opens the gallery on the words group ({focused})")
    top = page.evaluate("() => document.getElementById('gallery-words').getBoundingClientRect().top")
    check(top < 400, f"…scrolled to it ({round(top)})")
    page.click("#gallery-cancel")
    check(page.locator("#chart-gallery").count() == 0 and not diagrams(page), "Cancel closes it and inserts nothing")

    for k in KINDS:
        insert(page, k)
    anim = page.locator(".diagram-block[data-kind='matrix'] .ch-in").first.evaluate("e => [getComputedStyle(e).animationName, getComputedStyle(e).animationDuration]")
    check(anim == ["ch-in", "0.3s"], f"a new diagram draws in over 300 ms ({anim})")
    settle(page)
    ds = diagrams(page)
    check([d["attrs"]["kind"] for d in ds] == KINDS, f"8 `diagram` nodes, one of each kind ({[d['attrs']['kind'] for d in ds]})")
    check(all(d["attrs"]["palette"] == "desk" for d in ds), "new diagrams take the Study desk colours")
    for k in KINDS:
        blk = page.locator(f".diagram-block[data-kind='{k}']")
        title, word = SAMPLE[k]
        check(blk.locator(".diagram-title").text_content() == title and word in svg_text(blk), f"{k}: '{title}' with example words ('{word}')")
    small = page.locator(".diagram-edit").evaluate_all("els => els.map(e => Math.min(e.offsetWidth, e.offsetHeight)).filter(v => v < 44)")
    check(not small, f"Edit diagram buttons are at least 44 px ({small})")

    # ================= Edit diagram: a flowchart =================
    flow = page.locator(".diagram-block").nth(1)  # by place: its kind changes below
    flow.locator(".diagram-edit").click()
    panel = flow.locator(".diagram-panel")
    check(panel.is_visible() and panel.locator("input[aria-label='Diagram title']").input_value() == "How a Bill becomes law", "Edit diagram opens the panel under it")
    check(panel.locator(".dg-items li").count() == 6, "…one row per step")
    small = panel.locator("button, input, select").evaluate_all("els => els.filter(e => e.offsetParent).map(e => e.offsetHeight).filter(v => v < 44)")
    check(not small, f"every panel control is at least 44 px tall ({small})")
    panel.locator("input[aria-label='Diagram title']").fill("Ordinary Bill")
    check(flow.locator(".diagram-title").text_content() == "Ordinary Bill", "the picture follows the edit live")
    panel.locator("input[aria-label='Step 1: Step']").fill("Introduced in either House")
    panel.locator("button:has-text('Add step')").click()
    check(panel.locator(".dg-items li").count() == 7, "Add step adds a row")
    check(page.evaluate("() => document.activeElement.getAttribute('aria-label')") == "Step 7: Step", "…and puts the cursor in it")
    page.keyboard.type("Gazette notification")
    panel.locator("button[aria-label='Move step 7 up']").click()
    check(panel.locator("input[aria-label='Step 6: Step']").input_value() == "Gazette notification", "↑ moves a step up")
    panel.locator("button[aria-label='Delete step 2']").click()
    check(panel.locator(".dg-items li").count() == 6, "✕ deletes a step")
    panel.locator("select[aria-label='Step 1 colour']").select_option("gs2")
    panel.locator("button:has-text('Done')").click()
    settle(page)
    d = diagrams(page)[1]["attrs"]
    texts = [i["text"] for i in d["items"]]
    check(d["title"] == "Ordinary Bill" and texts == ["Introduced in either House", "Committee", "Passed by both Houses", "President's assent", "Gazette notification", "Becomes an Act"],
          f"Done saves title, edits, add, move and delete ({texts})")
    check(d["items"][0]["color"] == "gs2", "…and a step's colour")
    check(panel.is_hidden() and flow.locator(".diagram-edit").is_visible(), "the panel closes")
    page.click("#note-undo")
    settle(page)
    d = diagrams(page)[1]["attrs"]
    check(d["title"] == "How a Bill becomes law" and len(d["items"]) == 6 and d["items"][0]["text"] == "Introduced", "one Undo takes the whole edit back")
    page.click("#note-redo")
    settle(page)
    check(diagrams(page)[1]["attrs"]["title"] == "Ordinary Bill", "Redo puts it back")
    flow.locator(".diagram-edit").click()
    panel.locator("input[aria-label='Diagram title']").fill("Never saved")
    panel.locator("select[aria-label='Diagram type']").select_option("cycle")
    check(flow.get_attribute("data-kind") == "cycle", "changing the type redraws at once")
    panel.locator("button:has-text('Cancel')").click()
    settle(page)
    d = diagrams(page)[1]["attrs"]
    check(d["title"] == "Ordinary Bill" and d["kind"] == "flow" and flow.get_attribute("data-kind") == "flow" and flow.locator(".diagram-title").text_content() == "Ordinary Bill", "Cancel changes nothing")

    # ================= hierarchy levels =================
    tree = page.locator(".diagram-block[data-kind='tree']")
    tree.locator(".diagram-edit").click()
    tp = tree.locator(".diagram-panel")
    check(tp.locator("button[aria-label='Move box 1 in a level']").count() == 0, "the top box has no level arrows")
    tp.locator("button[aria-label='Move box 3 in a level']").click()
    pad = tp.locator(".dg-items li").nth(2).locator(".dg-fields").evaluate("e => e.style.paddingLeft")
    check(pad == "44px", f"→ moves a box in a level (indent {pad})")
    tp.locator("button:has-text('Done')").click()
    settle(page)
    lv = [i["level"] for i in diagrams(page)[5]["attrs"]["items"]]
    check(lv == [0, 1, 2, 1], f"…saved as level 2 under Lok Sabha ({lv})")
    tree.locator(".diagram-edit").click()
    tp.locator("button[aria-label='Move box 3 out a level']").click()
    tp.locator("button:has-text('Done')").click()
    settle(page)
    lv = [i["level"] for i in diagrams(page)[5]["attrs"]["items"]]
    check(lv == [0, 1, 1, 1], f"← moves it back out ({lv})")

    # ================= comparison columns =================
    cmp_ = page.locator(".diagram-block[data-kind='compare']")
    cmp_.locator(".diagram-edit").click()
    cp = cmp_.locator(".diagram-panel")
    check(cp.locator(".dg-heads input").count() == 2, "a comparison has column headings")
    cp.locator("button:has-text('Add column')").click()
    cp.locator("input[aria-label='Column 3 heading']").fill("Vidhan Sabha")
    cp.locator("input[aria-label='Row 2: Column 3']").fill("5 years")
    check("Vidhan Sabha" in svg_text(cmp_), "a new column draws at once")
    cp.locator("button:has-text('Done')").click()
    settle(page)
    d = diagrams(page)[6]["attrs"]
    check(d["heads"] == ["Lok Sabha", "Rajya Sabha", "Vidhan Sabha"] and d["items"][1]["cells"][2] == "5 years", f"Done saves the column and its cell ({d['heads']})")

    # ================= caps: Venn 3 sets, 2×2 four boxes =================
    venn = page.locator(".diagram-block[data-kind='venn']")
    venn.locator(".diagram-edit").click()
    vp = venn.locator(".diagram-panel")
    check(vp.locator("textarea[aria-label='Shared by all']").count() == 0 and vp.locator("input[aria-label='Shared by all']").input_value() == "Both aim at a welfare state", "a Venn has a 'Shared by all' field")
    vp.locator("button:has-text('Add set')").click()
    vp.locator("input[aria-label='Set 3: Name']").fill("Fundamental Duties")
    vp.locator("button:has-text('Add set')").click()
    check(vp.locator(".dg-items li").count() == 3, "a Venn stops at 3 sets")
    check(venn.locator("svg circle").count() == 3, "…and draws three circles")
    vp.locator("button:has-text('Done')").click()
    mx = page.locator(".diagram-block[data-kind='matrix']")
    mx.locator(".diagram-edit").click()
    mx.locator(".diagram-panel button:has-text('Add box')").click()
    check(mx.locator(".diagram-panel .dg-items li").count() == 4, "a 2×2 stops at 4 boxes")
    mx.locator(".diagram-panel button:has-text('Done')").click()
    settle(page)
    check(len(diagrams(page)[4]["attrs"]["items"]) == 3, "the third Venn set is saved")

    # ---- night ----
    day = page.locator(".diagram-block[data-kind='pyramid'] svg").inner_html()
    page.evaluate("() => { document.documentElement.setAttribute('data-theme', 'night'); window.dispatchEvent(new Event('themechange')); }")
    page.wait_for_timeout(300)
    night = page.locator(".diagram-block[data-kind='pyramid'] svg").inner_html()
    check(day != night, "night redraws a diagram in night colours")
    page.evaluate("() => { document.documentElement.removeAttribute('data-theme'); window.dispatchEvent(new Event('themechange')); }")

    # ================= search =================
    page.keyboard.press("Control+k")
    page.wait_for_selector("#global-search")
    for q in ["Jallianwala", "Gazette notification", "Fundamental Duties"]:
        page.fill("#global-search", q)
        page.wait_for_timeout(400)
        check(TITLE in page.locator("#search-results").inner_text(), f"Ctrl+K finds a diagram's words ('{q}')")
    page.keyboard.press("Escape")

    # ================= PDF: vector =================
    saved(page)
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / "diagrams.pdf"
    dl.value.save_as(pdf)
    page.click("#details summary")
    txt = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    for needle in ["National movement", "Ordinary Bill", "Becomes an Act", "Water cycle", "Producers", "Fundamental Duties", "Parliament of India", "Vidhan Sabha", "Strengths"]:
        check(needle in txt, f"the PDF prints '{needle}'")
    n_img = sum(len(pg.images) for pg in PdfReader(str(pdf)).pages)
    check(n_img == 0, f"diagrams print as vector drawing, not pictures ({n_img} images)")
    subprocess.run(["pdftoppm", "-png", "-r", "70", "-f", "1", "-l", "3", str(pdf), str(OUT / "diagrams")])

    # ================= reduced motion, the Tab S8 and a phone =================
    rec = page.evaluate(NOTE, TITLE)
    for w, h in [(800, 1280), (390, 800)]:
        ctx2 = browser.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce", has_touch=True)
        p2 = ctx2.new_page()
        p2.on("pageerror", lambda e: errors.append(str(e)))
        p2.goto(URL)
        p2.evaluate(IDB_PUT, rec)
        p2.goto(URL + "#/n/" + rec["id"])
        p2.wait_for_selector(".diagram-block svg")
        p2.wait_for_timeout(800)
        if w == 800:
            a2 = p2.locator(".diagram-block .ch-in").evaluate_all("els => els.map(e => getComputedStyle(e).animationName).filter(n => n !== 'none').length")
            check(a2 == 0, f"no draw-in with reduced motion ({a2} animated)")
            over = p2.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(over <= 0, f"Tab S8 portrait: eight diagrams, the page never scrolls sideways ({over})")
            p2.locator(".diagram-block[data-kind='compare'] .diagram-edit").tap()
            bad = p2.evaluate("() => { const f = document.querySelector('.diagram-block[data-kind=compare]'); return f.scrollWidth - f.clientWidth; }")
            check(bad <= 1, f"Tab S8 portrait: the edit panel fits ({bad})")
        bad = p2.evaluate("""() => { const col = document.querySelector('.section-body .rich').getBoundingClientRect();
            return [...document.querySelectorAll('.diagram-block')].filter(f => { const r = f.getBoundingClientRect(), s = f.querySelector('svg').getBoundingClientRect();
              return r.right > col.right + 1 || s.right > r.right + 1 || f.scrollWidth > f.clientWidth + 1; }).map(f => f.dataset.kind); }""")
        check(not bad, f"{w} px: every diagram fits its column ({bad})")
        p2.screenshot(path=str(OUT / f"width-{w}.png"), full_page=True)
        ctx2.close()

    page.screenshot(path=str(OUT / "diagrams.png"))
    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
if failures:
    print(f"{len(failures)} FAILED")
    sys.exit(1)
print("ALL PASSED")
