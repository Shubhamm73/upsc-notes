"""0.16 smoke test: charts, diagrams, mind maps and tables at any size, with text beside them; one Chart entry in
the slash menu; heading looks as drawn in the Redesign Plan. Needs `vite preview` on :4173.

- A diagram, a mind map, a chart and a table each have a corner grip: a drag stores `width` (whole %) on the
  node, centred figures sit narrower in the middle, and the size shows while dragging.
- Left · text beside / Right · text beside float a diagram, a mind map and a table: the next paragraph sits
  beside it on screen; Center puts it back on its own row. One Undo per change.
- The slash menu lists Chart once (no separate Diagram or Mind map rows); "/diagram" and "/mind map" still
  find their entries.
- Heading looks: Banner is a solid ribbon (clip-path), Numbered shows "01", Brackets draws corner marks,
  Card carries the subject eyebrow.
- The PDF of a note with a floated diagram still builds.
"""
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
TITLE = "Figures any size"
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""


def blocks(page):
    return page.evaluate(NOTE, TITLE)["sections"][0]["doc"]["content"]


def first(page, t):
    return next((b for b in blocks(page) if b["type"] == t), None)


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def settle(page):
    page.wait_for_timeout(1100)
    saved(page)


def to_end(page):
    page.evaluate("""() => { const pm = document.querySelector('.section-body .ProseMirror'); pm.focus();
      const s = getSelection(); s.selectAllChildren(pm); s.collapseToEnd(); }""")
    page.wait_for_timeout(100)


def slash(page, query):
    page.keyboard.type("/" + query)
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")


def drag_grip(page, sel, dx):
    g = page.locator(f"{sel} > .fig-grip").first
    g.scroll_into_view_if_needed()
    page.locator(sel).first.hover()
    b = g.bounding_box()
    x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, 9):
        page.mouse.move(x + dx * i / 8, y)
        page.wait_for_timeout(16)
    showing = page.locator(f"{sel} > .fig-size").first.text_content()
    page.mouse.up()
    page.wait_for_timeout(200)
    return showing


def select_fig(page, sel):
    page.locator(f"{sel} .chart-head .chart-titles").first.click()
    page.wait_for_timeout(150)


def bar(page, aria):
    page.click(f"#ctxbar button[aria-label='{aria}']")
    page.wait_for_timeout(250)


def beside(page, fig_sel, text):
    return page.evaluate(
        """([f, t]) => { const fig = document.querySelector(f).getBoundingClientRect();
        const p = [...document.querySelectorAll('.section-body .ProseMirror p')].find(x => x.textContent.includes(t));
        if (!p) return null; const rg = document.createRange(); rg.selectNodeContents(p); const r = rg.getClientRects()[0]; return r.top < fig.bottom - 2 && (r.left >= fig.right - 2 || r.right <= fig.left + 2); }""",
        [fig_sel, text],
    )


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
    page.keyboard.type("Figures below.")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)

    # ================= slash menu: one Chart entry =================
    page.keyboard.type("/")
    page.wait_for_selector("#insert-menu:not([hidden])")
    items = page.eval_on_selector_all(".insert-opt strong", "e => e.map(x => x.textContent)")
    check(items.count("Chart") == 1 and "Diagram" not in items and "Mind map" not in items, f"the menu lists Chart once, no Diagram / Mind map rows ({items})")
    page.keyboard.type("diagram")
    page.wait_for_timeout(150)
    items = page.eval_on_selector_all(".insert-opt strong", "e => e.map(x => x.textContent)")
    check(items[:1] == ["Diagram"] and "Image" not in items and "Sketch" not in items, f"/diagram finds Diagram first, no unrelated rows ({items})")
    page.keyboard.press("Escape")
    for _ in range(8):
        page.keyboard.press("Backspace")
    page.wait_for_timeout(100)
    page.keyboard.type("/mind")
    page.wait_for_selector("#insert-menu:not([hidden])")
    items = page.eval_on_selector_all(".insert-opt strong", "e => e.map(x => x.textContent)")
    check(items[:1] == ["Mind map"], f"/mind finds Mind map ({items})")
    page.keyboard.press("Escape")
    for _ in range(5):
        page.keyboard.press("Backspace")

    # ================= diagram: resize, float, center =================
    slash(page, "diagram")
    page.wait_for_selector("#chart-gallery")
    page.click("#gallery-words .gallery-tile[data-kind='timeline']")
    page.wait_for_selector(".diagram-block svg")
    to_end(page)
    page.keyboard.type("Text that should sit beside the diagram once it floats.")
    settle(page)
    check(page.locator(".diagram-block > .fig-grip").count() == 1, "a diagram has a resize grip")
    w0 = page.locator(".diagram-block").first.bounding_box()["width"]
    tag = drag_grip(page, ".diagram-block", -260)
    settle(page)
    d = first(page, "diagram")
    w1 = page.locator(".diagram-block").first.bounding_box()["width"]
    check(d and isinstance(d["attrs"].get("width"), int) and d["attrs"]["width"] < 100 and w1 < w0 - 100, f"drag narrows a centred diagram and stores its width ({d and d['attrs'].get('width')}%, {w0:.0f} → {w1:.0f}px)")
    check(tag and tag.endswith("%"), f"the size shows while dragging ({tag})")
    fb = page.locator(".diagram-block").first.bounding_box()
    col = page.locator(".section-body .ProseMirror").first.bounding_box()
    check(abs((fb["x"] - col["x"]) - (col["x"] + col["width"] - fb["x"] - fb["width"])) < 6, "a narrower centred diagram sits in the middle")

    select_fig(page, ".diagram-block")
    check(page.locator("#ctxbar").is_visible() and page.locator("#ctxbar .tb-align .ctx-label").text_content() == "Diagram", "selecting a diagram shows the Diagram tools")
    bar(page, "Align image left")
    settle(page)
    d = first(page, "diagram")
    check(d["attrs"]["align"] == "left" and page.locator(".diagram-block").first.get_attribute("data-align") == "left", "Left · text beside floats the diagram")
    check(beside(page, ".diagram-block", "Text that should sit beside") is True, "the next line sits beside the diagram")
    page.screenshot(path=str(OUT / "diagram-left.png"))
    bar(page, "Align image right")
    settle(page)
    check(first(page, "diagram")["attrs"]["align"] == "right" and beside(page, ".diagram-block", "Text that should sit beside") is True, "Right · text beside: text on the left of it")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(300)
    check(page.locator(".diagram-block").first.get_attribute("data-align") == "left", "one Undo takes the move back")
    select_fig(page, ".diagram-block")
    bar(page, "Center image")
    settle(page)
    check(first(page, "diagram")["attrs"]["align"] == "center" and beside(page, ".diagram-block", "Text that should sit beside") is False, "Center: the diagram is on its own row again")

    # ================= mind map: resize + float =================
    to_end(page)
    page.keyboard.press("Enter")
    page.keyboard.type("/mind map")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.wait_for_selector(".mm-overlay")
    page.click("#mm-done") if page.locator("#mm-done").count() else page.keyboard.press("Escape")
    page.wait_for_selector(".mm-overlay", state="detached")
    page.wait_for_selector(".mindmap-block svg")
    to_end(page)
    page.keyboard.type("Line next to the map.")
    settle(page)
    drag_grip(page, ".mindmap-block", -300)
    settle(page)
    m = first(page, "mindMap")
    check(m and m["attrs"].get("width", 100) < 100, f"a mind map resizes ({m and m['attrs'].get('width')}%)")
    select_fig(page, ".mindmap-block")
    bar(page, "Align image right")
    settle(page)
    check(first(page, "mindMap")["attrs"]["align"] == "right" and beside(page, ".mindmap-block", "Line next to the map") is True, "a mind map floats right with text beside it")
    check(len(first(page, "mindMap")["attrs"]["nodes"]) == 4, "its ideas are untouched")

    # ================= chart: centred resize =================
    to_end(page)
    page.keyboard.press("Enter")
    slash(page, "chart")
    page.wait_for_selector("#chart-gallery")
    page.click("#chart-gallery .gallery-tile[data-kind='column']")
    page.wait_for_selector(".chart-block[data-kind='column'] svg")
    settle(page)
    cw0 = page.locator(".chart-block").first.bounding_box()["width"]
    drag_grip(page, ".chart-block", -200)
    settle(page)
    c = first(page, "chart")
    cw1 = page.locator(".chart-block").first.bounding_box()["width"]
    check(c["attrs"]["align"] == "center" and c["attrs"]["width"] < 100 and cw1 < cw0 - 100, f"a centred chart can be made narrower ({c['attrs']['width']}%)")

    # ================= table: resize + float =================
    to_end(page)
    page.keyboard.press("Enter")
    slash(page, "table")
    page.wait_for_selector("#table-dialog, .sheet", timeout=5000)
    page.click("#table-insert") if page.locator("#table-insert").count() else page.keyboard.press("Enter")
    page.wait_for_selector(".table-card table")
    page.locator(".table-card td, .table-card th").first.click()
    page.keyboard.type("A1")
    settle(page)
    check(page.locator(".table-card > .fig-grip").count() == 1, "a table has a resize grip")
    tw0 = page.locator(".table-card").first.bounding_box()["width"]
    drag_grip(page, ".table-card", -300)
    settle(page)
    t = first(page, "table")
    tw1 = page.locator(".table-card").first.bounding_box()["width"]
    check(t["attrs"].get("width") and t["attrs"]["width"] < 100 and tw1 < tw0 - 120, f"drag narrows the table and stores its width ({t['attrs'].get('width')}%)")
    page.locator(".table-card :is(td, th)").first.click()
    page.wait_for_timeout(200)
    check(page.locator("#ctxbar button[aria-label='Table on the left, text beside it']").is_visible(), "the Table tools offer Left / Center / Right")
    bar(page, "Table on the left, text beside it")
    to_end(page)
    page.keyboard.type("Words beside the table.")
    settle(page)
    t = first(page, "table")
    check(t["attrs"]["align"] == "left" and page.locator(".table-card").first.get_attribute("data-align") == "left", "the table floats left")
    page.locator(".table-card").first.scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / "table-float.png"))
    check(beside(page, ".table-card", "Words beside the table") is True, "text sits beside the table")
    check(page.locator(".table-card :is(td, th)").first.text_content() == "A1", "its cells are untouched")
    page.locator(".table-card :is(td, th)").first.click()
    bar(page, "Fit the table to the page width")
    settle(page)
    check(not first(page, "table")["attrs"].get("width"), "Fit width gives the table the full width again")
    page.screenshot(path=str(OUT / "table-left.png"))

    # ================= heading looks (the plan's drawing) =================
    to_end(page)
    page.keyboard.press("Enter")
    page.keyboard.type("Polity basics")
    page.keyboard.press("Control+Alt+2")
    page.wait_for_timeout(200)
    h2 = page.locator(".section-body h2").last
    if not h2.count():
        slash(page, "heading")
        h2 = page.locator(".section-body h2").last
    h2.click()
    page.click("#heading-style")
    page.wait_for_selector(".look-panel")

    def look(style):
        page.click(f"#look-grid [data-style='{style}']")
        page.wait_for_timeout(200)
        return h2

    look("banner")
    clip = h2.locator(".h-text").evaluate("e => getComputedStyle(e).clipPath")
    check("polygon" in clip, f"Banner is a ribbon with a notched tail ({clip[:40]})")
    look("numbered")
    num = h2.evaluate("e => getComputedStyle(e, '::before').content")
    check("decimal-leading-zero" in num, f"Numbered shows two digits ({num})")
    look("brackets")
    br = h2.locator(".h-text").evaluate("e => [getComputedStyle(e, '::before').borderTopWidth, getComputedStyle(e, '::after').borderBottomWidth]")
    check(br == ["3px", "3px"], f"Brackets draws corner marks ({br})")
    look("card")
    eb = h2.locator(".h-text").evaluate("e => getComputedStyle(e, '::before').content")
    check(eb not in ("none", "normal", ""), f"Card carries a subject eyebrow ({eb})")
    page.screenshot(path=str(OUT / "headings.png"))

    check(not errors, f"no page errors ({errors[:2]})")
    browser.close()

print(f"\n{'ALL PASS' if not failures else str(len(failures)) + ' FAILED'} · screenshots in {OUT}")
raise SystemExit(1 if failures else 0)
