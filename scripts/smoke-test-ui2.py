"""UI-2 smoke test: writing canvas. Needs `vite preview` on :4173.

Templates, slash menu, floating toolbar (above with a mouse, below on touch), UPSC callouts
(insert, change kind, quick insights, Ctrl+K search, PDF, backup), live key-line count,
GS answer meter, outline rail (jump, long-press reorder, collapse, section PDF), focus mode,
portrait touch bar, template chip, and an old 0.6 note opening untouched.
"""
import json
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
    page.keyboard.type("/" + query)
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")


def select_text(page, text):
    """Selects the last occurrence of `text` in the focused editor (as a finger or mouse drag would)."""
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


def to_line_end(page):
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


def mark(page, text):
    select_text(page, text)
    page.click("#bubble button[aria-label='Highlight']")
    to_line_end(page)


def text_of(pdf):
    return subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout


IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""
IDB_GET = """(id) => new Promise(res => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const q = r.result.transaction('notes').objectStore('notes').get(id); q.onsuccess = () => res(q.result || null); }; })"""

OLD_NOTE = {
    "id": "v06-note", "subject": "GS3", "topic": "Economy", "title": "Old 0.6 note",
    "sections": [
        {"id": "a", "heading": "Basics", "doc": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Repo rate is "}, {"type": "text", "text": "the RBI's policy rate", "marks": [{"type": "highlight"}]}]},
            {"type": "table", "content": [{"type": "tableRow", "content": [
                {"type": "tableCell", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "cell"}]}]}]}]}]}},
        {"id": "b", "heading": "Data", "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "CPI 4%"}]}]}},
    ],
    "explain": "", "connect": "", "nextReview": "2026-10-12", "reviewCount": 0, "lastReviewed": None,
    "createdAt": 5, "updatedAt": 5, "deletedAt": None,
}

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---- an old 0.6 note (no template, highlights, a table) opens intact and is not rewritten ----
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.evaluate(IDB_PUT, OLD_NOTE)
    page.goto(URL + "#/n/v06-note")
    page.wait_for_selector(".canvas")
    check(page.input_value("#f-template") == "blank", "old note shows the Blank template")
    check(page.locator(".section-heading").count() == 2 and page.locator(".rich table").count() == 1, "old note: sections and table intact")
    check(page.inner_text("#keyline-count") == "1 key line", f"live key-line count on open ({page.inner_text('#keyline-count')})")
    check(page.locator("#answer-meter").is_hidden(), "no answer meter outside the GS answer template")
    page.wait_for_timeout(1500)
    check(page.evaluate(IDB_GET, "v06-note")["updatedAt"] == 5, "opening an old note does not rewrite it")
    page.click(".canvas-head .back-link")
    page.wait_for_url("**/#/notes/**")  # 0.10: ← goes to the note's subject
    page.wait_for_timeout(1200)
    check(page.evaluate(IDB_GET, "v06-note")["updatedAt"] == 5, "leaving a note without editing does not re-save it")
    page.goto(URL + "#/n/v06-note")
    page.wait_for_selector(".canvas")
    check(page.locator(".pane-list").is_hidden(), "landscape: open note is a full-page canvas")
    title_size = page.evaluate("parseFloat(getComputedStyle(document.querySelector('#f-title')).fontSize)")
    check(34 <= title_size <= 36.5, f"title is 34-36 px ({title_size})")
    # 0.8.3: the note fills the screen; a ~90-character column is the Comfortable choice
    col = page.locator(".canvas-col").bounding_box()["width"]
    check(col >= 780, f"text column fills the screen beside the outline ({col:.0f}px)")
    page.evaluate("localStorage.setItem('upsc.width', 'comfortable'); document.documentElement.dataset.width = 'comfortable'")
    per_line = page.evaluate("""() => { const p = document.createElement('p'); p.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit';
        p.textContent = 'The Directive Principles of State Policy are guidelines for the framing of laws by the government. '.repeat(2);
        const col = document.querySelector('.rich'); col.append(p); const w = p.getBoundingClientRect().width / p.textContent.length; p.remove();
        return Math.round(col.getBoundingClientRect().width / w); }""")
    check(80 <= per_line <= 100, f"Comfortable width: about 90 characters of prose per line ({per_line})")
    page.evaluate("localStorage.removeItem('upsc.width'); document.documentElement.dataset.width = 'full'")

    # ---- New note: template picker ----
    page.click(".back-link")
    page.click("#new-note")
    page.wait_for_selector(".tpl-card")
    names = page.eval_on_selector_all(".tpl-card strong", "e => e.map(x => x.textContent)")
    check(len(names) == 19 and all(n in names for n in ["GS answer", "Topic sheet", "Current affairs", "Blank"]), f"19 templates offered, the first four among them ({names})")
    page.click(".tpl-card[data-template='topic-sheet']")
    page.wait_for_selector("#f-title")
    heads = page.eval_on_selector_all(".section-heading", "e => e.map(x => x.value)")
    check(heads == ["Key terms", "Articles and cases", "Data", "Examples", "PYQs"], f"Topic sheet sections ({heads})")
    page.fill("#f-title", "Fundamental Rights vs DPSP")
    page.click("#f-subject")  # 0.10: the subject chip opens Move to…
    page.click("#move-sheet [data-folder='gen:GS2']")
    page.fill("#f-topic", "Constitution")

    # ---- slash menu ----
    ed = page.locator(".section-body .rich").first
    ed.click()
    page.keyboard.type("/")
    page.wait_for_selector("#insert-menu:not([hidden])")
    items = page.eval_on_selector_all(".insert-opt strong", "e => e.map(x => x.textContent)")
    check(items == ["Heading", "Bullet list", "Dash list", "Numbered list", "Table", "Chart", "Image", "Sketch", "Container", "Callout", "Divider"], f"slash menu items ({items})")
    page.keyboard.type("tab")
    check(page.locator(".insert-opt").first.inner_text().startswith("Table"), "slash menu filters as you type")
    page.keyboard.press("Escape")
    check(page.locator("#insert-menu").is_hidden() and ed.inner_text().strip() == "/tab", "Esc closes the menu and keeps the text")
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.keyboard.type("/")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")  # Dash list
    check(ed.locator("ul[data-list-style='dash']").count() == 1, "arrow keys + Enter insert the chosen block")
    page.keyboard.type("Part III is justiciable")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")

    # ---- floating toolbar: above the selection with a mouse ----
    page.keyboard.type("Directive Principles guide policy.")
    select_text(page, "Directive Principles")
    sel = page.evaluate("(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return [r.top, r.bottom]; })()")
    bb = page.locator("#bubble").bounding_box()
    labels = page.eval_on_selector_all("#bubble .bubble-btns button", "e => e.map(x => x.getAttribute('aria-label'))")
    check(labels == ["Bold", "Italic", "Underline", "Highlight", "Add, edit or remove a link", "Put in container"], f"floating toolbar: B I U Mark Link Container ({labels})")
    check(bb["y"] + bb["height"] <= sel[0], f"mouse: toolbar sits above the selection ({bb['y'] + bb['height']:.0f} <= {sel[0]:.0f})")
    check(page.locator(".toolbar").count() == 0, "old permanent toolbar is gone")
    page.click("#bubble button[aria-label='Highlight']")
    to_line_end(page)
    expect(page.locator("#keyline-count")).to_have_text("1 key line", timeout=2000)
    check("has" in page.get_attribute("#keyline-count", "class"), "key-line pill lights up")

    # ---- callouts ----
    page.keyboard.press("Enter")
    slash(page, "case")
    page.keyboard.type("Minerva Mills v. Union of India (1980): harmony of Parts III and IV is basic structure")
    check(ed.locator("aside.callout[data-callout='case']").count() == 1, "Case callout inserted by /case")
    check(ed.locator(".callout-label").first.inner_text().lower() == "case", "callout shows its label")
    check(page.locator(".tb-callout").is_visible(), "callout tools appear inside a callout")
    mark(page, "harmony of Parts III and IV")
    expect(page.locator("#keyline-count")).to_have_text("2 key lines", timeout=2000)
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")  # leaves the callout
    slash(page, "callout")
    page.wait_for_selector(".insert-opt[data-item='callout-data']")
    page.click(".insert-opt[data-item='callout-data']")
    page.keyboard.type("NCRB 2022: 4.45 lakh crimes against women")
    page.click(".tb-callout button[aria-label='Article callout']")
    check(ed.locator("aside.callout[data-callout='article']").count() == 1, "callout kind can be changed")
    page.click(".tb-callout button[aria-label='Data callout']")
    check(ed.locator("aside.callout").count() == 2, "two callouts in the section")

    # outline counts per section
    counts = page.eval_on_selector_all("#outline .ol-count", "e => e.map(x => x.textContent)")
    check(counts[0] == "2", f"outline shows key lines per section ({counts})")

    # ---- second section, then template chip keeps everything ----
    page.locator(".section-body .rich").nth(1).click()
    page.keyboard.type("Article 37: fundamental in governance")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    check("Saved" in page.inner_text("#save-state"), "header shows Saved with a tick")

    # ---- Mark reviewed: callout highlights become quick insights ----
    page.click("#mark-reviewed")
    page.wait_for_selector("#insights li")
    ins = page.eval_on_selector_all("#insights li", "e => e.map(x => x.textContent)")
    check("harmony of Parts III and IV" in ins and "Directive Principles" in ins, f"highlights inside callouts become quick insights ({ins})")
    page.wait_for_timeout(400)
    check(page.locator(".flyer").count() == 0, "fly-up animation cleans up after itself")

    # ---- outline: tap to jump, collapse, long-press drag to reorder ----
    rows = page.locator("#outline .ol-jump")
    check(rows.count() == 5, "outline lists every section")
    rows.nth(3).click()
    page.wait_for_timeout(900)
    top = page.locator(".note-section").nth(3).bounding_box()["y"]
    head_bottom = page.locator(".canvas-head").bounding_box()
    check(top < 300, f"tap in outline jumps to the section ({top:.0f})")
    page.click(".note-section >> nth=2 >> .sec-collapse")
    check(page.locator(".note-section").nth(2).locator(".section-body").is_hidden(), "section collapses")
    check("folded" in page.locator("#outline .outline-row").nth(2).inner_text(), "outline shows the folded section")
    page.click(".note-section >> nth=2 >> .sec-collapse")
    a = rows.nth(3).bounding_box()
    b = rows.nth(0).bounding_box()
    page.mouse.move(a["x"] + 50, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.wait_for_timeout(650)
    page.mouse.move(a["x"] + 50, b["y"] + 4, steps=12)
    page.mouse.up()
    page.wait_for_timeout(300)
    heads = page.eval_on_selector_all(".section-heading", "e => e.map(x => x.value)")
    check(heads == ["Examples", "Key terms", "Articles and cases", "Data", "PYQs"], f"long-press drag reorders sections ({heads})")
    check(page.locator(".sec-btn").count() == 0 and page.locator("button[aria-label*='Move section'][aria-label$='up']:visible").count() == 0, "no up/down buttons left on the page")

    # section PDF from the outline menu (a callout is in it)
    with page.expect_download(timeout=60000) as dl:
        page.click("#outline button[aria-label='Section 2 options']")
        page.click(".popover button[aria-label='Export section 2 as PDF']")
    sec_pdf = OUT / dl.value.suggested_filename
    dl.value.save_as(sec_pdf)
    t = text_of(sec_pdf)
    check("CASE" in t and "Minerva Mills" in t and "DATA" in t and "NCRB 2022" in t, "callouts exported to the section PDF with their labels")
    check("Article 37" not in t, "section PDF holds only that section")

    # ---- search: "case" finds the note through its Case callout ----
    page.keyboard.press("Control+k")
    page.wait_for_selector("#global-search")
    page.fill("#global-search", "case")
    page.wait_for_selector(".search-hit")
    first = page.locator(".search-hit").first.inner_text()
    check("Fundamental Rights vs DPSP" in first and "Case: Minerva Mills" in first, f"Ctrl+K 'case' lists the note with its Case callout ({first!r})")
    page.fill("#global-search", "data callout")
    page.wait_for_selector(".search-hit")
    check("Fundamental Rights vs DPSP" in page.locator(".search-hit").first.inner_text(), "Ctrl+K finds Data callouts by name")
    page.keyboard.press("Escape")

    # ---- focus mode ----
    page.locator(".section-body .rich").nth(1).click()
    page.keyboard.press("Control+.")
    check(page.evaluate("document.body.classList.contains('focus-mode')"), "Ctrl + . turns on focus mode")
    check(page.locator(".rail").is_hidden() and page.locator(".outline").is_hidden() and page.locator(".canvas-head").is_hidden(), "focus mode hides everything but the text")
    page.wait_for_timeout(350)
    dim = page.evaluate("""() => [...document.querySelectorAll('.ProseMirror-focused > *')].map(e => getComputedStyle(e).opacity)""")
    check("1" in dim and any(float(x) < 0.5 for x in dim), f"non-active paragraphs are dimmed ({dim})")
    page.screenshot(path=str(OUT / "focus.png"))
    page.keyboard.press("Escape")
    check(not page.evaluate("document.body.classList.contains('focus-mode')"), "Esc leaves focus mode")
    page.click("#focus-toggle")
    check(page.evaluate("document.body.classList.contains('focus-mode')"), "Focus button turns it on (touch)")
    page.click("#focus-exit")
    check(not page.evaluate("document.body.classList.contains('focus-mode')"), "Exit focus button turns it off")

    # ---- PDF of the whole note includes callouts ----
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    note_pdf = OUT / dl.value.suggested_filename
    dl.value.save_as(note_pdf)
    t = text_of(note_pdf)
    check("CASE" in t and "Quick insights" in t, "note PDF has callouts and quick insights")
    page.screenshot(path=str(OUT / "canvas-day.png"), full_page=True)

    # ---- GS answer: answer-length meter ----
    page.goto(URL + "#/n/new")
    page.click(".tpl-card[data-template='gs-answer']")
    page.wait_for_selector("#answer-meter")
    heads = page.eval_on_selector_all(".section-heading", "e => e.map(x => x.value)")
    check(heads == ["Intro", "Body", "Way forward"], f"GS answer sections ({heads})")
    page.fill("#f-title", "Judicial activism")
    page.locator(".section-body .rich").nth(1).click()
    page.keyboard.type(" ".join(["word"] * 160))
    page.wait_for_timeout(300)
    check(page.get_attribute("#answer-meter", "data-zone") == "ok" and "160 / 250" in page.inner_text("#answer-meter"), "meter past the 150 mark")
    page.keyboard.type(" " + " ".join(["more"] * 100))
    page.wait_for_timeout(300)
    check(page.get_attribute("#answer-meter", "data-zone") == "over", "meter warns past 250")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)

    # ---- template chip: switching adds sections, never removes ----
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "RBI policy")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("Repo rate unchanged")
    page.select_option("#f-template", "current-affairs")
    heads = page.eval_on_selector_all(".section-heading", "e => e.map(x => x.value)")
    check(heads == ["Notes", "News", "Background", "Syllabus link", "Prelims facts", "Mains angle"], f"template chip adds sections, keeps text ({heads})")
    check("Repo rate unchanged" in page.locator(".section-body .rich").first.inner_text(), "existing text kept")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)

    # ---- backup carries template + callouts, import into a fresh profile ----
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    bpath = OUT / dl.value.suggested_filename
    dl.value.save_as(bpath)
    data = json.loads(bpath.read_text())
    fr = next(n for n in data["notes"] if n["title"] == "Fundamental Rights vs DPSP")
    check(fr.get("template") == "topic-sheet", "backup keeps the template")
    check('"callout"' in json.dumps(fr["sections"]), "backup keeps callouts")
    ctx.close()

    fresh = browser.new_context(viewport={"width": 1280, "height": 900})
    fp = fresh.new_page()
    fp.on("pageerror", lambda e: errors.append(str(e)))
    fp.goto(URL + "#/settings")
    fp.set_input_files("#import-file", str(bpath))
    expect(fp.locator(".import-result")).to_contain_text("added", timeout=5000)
    fp.goto(URL + "#/notes")
    fp.click(".note-card:has-text('Fundamental Rights vs DPSP')")
    fp.wait_for_selector("aside.callout[data-callout='case']")
    check(fp.input_value("#f-template") == "topic-sheet", "imported note keeps template and callouts")
    fresh.close()

    # ---- portrait tablet with touch: touch bar, toolbar below selection, heading menu PDF ----
    pc = browser.new_context(viewport={"width": 800, "height": 1280}, has_touch=True, is_mobile=True, device_scale_factor=2, accept_downloads=True)
    pp = pc.new_page()
    pp.on("pageerror", lambda e: errors.append(str(e)))
    pp.goto(URL + "#/n/new/blank")
    pp.wait_for_selector("#f-title")
    check(pp.locator("#touchbar").is_hidden(), "portrait: touch bar hidden until writing")
    pp.locator(".section-body .rich").first.tap()
    check(pp.locator("#touchbar").is_visible() and pp.locator(".rail").is_hidden(), "portrait: touch bar replaces the bottom nav while writing")
    tlabels = pp.eval_on_selector_all("#touchbar button", "e => e.map(x => x.getAttribute('aria-label'))")
    check(tlabels == ["Insert", "Mark (highlight)", "List: bullets, dashes, numbers, off", "Undo", "Redo", "Done writing"], f"touch bar: + Mark List Undo Redo Done ({tlabels})")
    sizes = pp.eval_on_selector_all("#touchbar button", "e => e.map(x => Math.round(x.getBoundingClientRect().height))")
    check(min(sizes) >= 44, f"touch bar targets >= 44 px ({sizes})")
    pp.keyboard.type("Separation of powers keeps each organ in check")
    select_text(pp, "each organ")
    sel = pp.evaluate("(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return [r.top, r.bottom]; })()")
    bb = pp.locator("#bubble").bounding_box()
    check(bb["y"] >= sel[1] + 20, f"touch: toolbar sits below the selection, clear of Android's menu ({bb['y']:.0f} >= {sel[1]:.0f}+20)")
    pp.tap("#touchbar button[aria-label='Mark (highlight)']")
    check(pp.locator(".rich mark").count() == 1, "touch bar Mark highlights the selection")
    to_line_end(pp)
    pp.keyboard.press("Enter")
    lst = "#touchbar button[aria-label='List: bullets, dashes, numbers, off']"
    pp.tap(lst)
    check(pp.locator(".rich ul:not([data-list-style])").count() == 1, "List: bullets")
    pp.tap(lst)
    check(pp.locator(".rich ul[data-list-style='dash']").count() == 1, "List: dashes")
    pp.tap(lst)
    check(pp.locator(".rich ol").count() == 1, "List: numbers")
    pp.tap(lst)
    check(pp.locator(".rich ol, .rich ul").count() == 0, "List: off")
    pp.tap("#tbar-insert")
    pp.wait_for_selector("#insert-menu:not([hidden])")
    mb = pp.locator("#insert-menu").bounding_box()
    tb = pp.locator("#touchbar").bounding_box()
    check(mb["y"] + mb["height"] <= tb["y"] + 1, "+ opens the insert menu above the touch bar")
    pp.tap(".insert-opt[data-item='divider']")
    check(pp.locator(".rich hr").count() == 1, "+ inserts a block")
    pp.tap("#touchbar button[aria-label='Undo']")
    check(pp.locator(".rich hr").count() == 0, "Undo works from the touch bar")
    pp.tap("#tbar-done")
    pp.wait_for_timeout(200)
    check(pp.locator("#touchbar").is_hidden() and pp.locator(".rail").is_visible(), "Done closes the touch bar")
    check(pp.locator("#outline").is_hidden(), "portrait: outline rail hidden")
    pp.locator(".section-body .rich").first.tap()
    pp.tap(".canvas-head .back-link")
    pp.wait_for_selector(".note-card")
    check(pp.locator("#touchbar").is_hidden() and pp.locator(".rail").is_visible(), "leaving a note mid-sentence brings the bottom nav back")
    pp.click(".note-card")
    pp.wait_for_selector("#f-title")
    with pp.expect_download(timeout=60000) as dl:
        pp.tap(".section-head button[aria-label='Section 1 options']")
        pp.tap(".popover button[aria-label='Export section 1 as PDF']")
    check(dl.value.suggested_filename.endswith(".pdf"), "portrait: section PDF from the heading menu")
    sizes = pp.eval_on_selector_all(".canvas-head button, .section-head button", "e => e.filter(x => x.offsetParent).map(x => Math.round(x.getBoundingClientRect().height))")
    check(min(sizes) >= 44, f"canvas buttons >= 44 px ({sorted(set(sizes))})")
    check(not pp.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "portrait: no sideways scroll")
    pp.screenshot(path=str(OUT / "portrait.png"))
    pc.close()

    # ---- night theme renders the canvas ----
    nc = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
    npg = nc.new_page()
    npg.on("pageerror", lambda e: errors.append(str(e)))
    npg.goto(URL + "#/n/new/topic-sheet")
    npg.wait_for_selector("#f-title")
    npg.locator(".section-body .rich").first.click()
    slash(npg, "example")
    npg.keyboard.type("Kerala's decentralised planning")
    bg = npg.evaluate("getComputedStyle(document.querySelector('.callout')).backgroundColor")
    check(bg != "rgba(0, 0, 0, 0)", f"night: callout has a tinted background ({bg})")
    npg.screenshot(path=str(OUT / "canvas-night.png"))
    nc.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
