"""0.12 smoke test: tables. Needs `vite preview` on :4173.

Insert → Table opens a dialog (drag across a 10 × 8 grid or use the steppers up to 50 × 12, header row, bold
first column, five styles, Subject + 13 colours, "Insert R × C table"), one Undo takes the table back. The
table bar keeps + Row … Delete table and adds "R × C ▾" (rows and columns together; it warns before cells
with text go, one Undo puts them back) and Style (style, colour, header row, first column, caption).
Figure columns line up on the right in a fixed-width face (worked out on screen, never stored). A table
written before 0.12 shows as Clean, first column not bold, and opening it rewrites nothing. The caption
is searchable and printed; the PDF prints each style's lines, the header band and right-aligned figures.
A table scrolls sideways inside its own card on a phone; the page never does.
"""
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

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
TABLE = "(t) => { const d = (n) => n.type === 'table' ? n : (n.content || []).map(d).find(Boolean); return d(t); }"


def doc(page, title):
    return page.evaluate(NOTE, title)["sections"][0]["doc"]


def table_of(page, title):
    return page.evaluate(TABLE, doc(page, title))


def size_of(t):
    rows = t["content"]
    return len(rows), sum(c.get("attrs", {}).get("colspan", 1) for c in rows[0]["content"])


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def slash(page, query):
    page.keyboard.type("/" + query)
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")


def undo(page):
    page.click("#note-undo")
    page.wait_for_timeout(250)


def caret_in_cell(page, text):
    page.evaluate("""(t) => {
        const root = document.querySelector('.section-body .ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) if (n.textContent === t) break;
        const r = document.createRange(); r.setStart(n, n.length); r.collapse(true);
        getSelection().removeAllRanges(); getSelection().addRange(r);
    }""", text)
    page.wait_for_timeout(200)


def save_pdf(page, name):
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / name
    dl.value.save_as(pdf)
    page.click("#details summary")
    return pdf


def words(pdf):
    html = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], capture_output=True, text=True).stdout
    return [(m.group(5), float(m.group(1)), float(m.group(2)), float(m.group(3))) for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>', html)]


def word(ws, w, after_y=0):
    return next((x for x in ws if x[0] == w and x[2] >= after_y), None)


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Tables")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("Seats in the House.")
    page.keyboard.press("Enter")
    page.wait_for_timeout(700)

    # ================= Insert → Table: the dialog =================
    slash(page, "table")
    page.wait_for_selector("#table-dialog")
    check(page.locator("#table-insert").text_content() == "Insert 4 × 3 table", "the dialog starts at 4 × 3 (rows include the header)")
    check(page.locator("#tbl-header").get_attribute("aria-pressed") == "true" and page.locator("#tbl-firstcol").get_attribute("aria-pressed") == "true", "Header row and Bold first column start on")
    check(page.locator("#tbl-styles .lp-tile").count() == 5 and page.locator("#tbl-styles button[data-tstyle='clean']").get_attribute("aria-pressed") == "true", "five styles, Clean chosen")
    check(page.locator("#tbl-colours .swatch").count() == 14 and page.locator("#tbl-colours [data-colour='subject']").get_attribute("aria-pressed") == "true", "Subject + 13 colours, Subject chosen")
    check(page.locator("#grid-pick .gp-cell").count() == 80 and page.locator("#grid-pick .gp-cell.on").count() == 12, "a 10 × 8 grid with 4 × 3 lit")
    # drag across the grid to 5 × 4
    a = page.locator(".gp-cell[data-r='1'][data-c='1']").bounding_box()
    b = page.locator(".gp-cell[data-r='5'][data-c='4']").bounding_box()
    page.mouse.move(a["x"] + 5, a["y"] + 5)
    page.mouse.down()
    page.mouse.move(b["x"] + 6, b["y"] + 6, steps=6)
    page.mouse.up()
    check(page.locator("#table-insert").text_content() == "Insert 5 × 4 table" and page.locator("#grid-pick .gp-cell.on").count() == 20, f"dragging the grid picks 5 × 4 ({page.locator('#table-insert').text_content()})")
    # steppers go past the grid
    for _ in range(7):
        page.click("#tbl-rows-plus")
    page.click("#tbl-cols-minus")
    check(page.locator("#tbl-rows").text_content() == "12" and page.locator("#table-insert").text_content() == "Insert 12 × 3 table" and "more than the grid" in page.locator("#grid-size").text_content(),
          "the steppers go past the grid (12 × 3)")
    for _ in range(6):
        page.click("#tbl-rows-minus")
    page.click("#tbl-styles button[data-tstyle='banded']")
    page.click("#tbl-colours [data-colour='gs2']")
    check(page.locator("#table-insert").text_content() == "Insert 6 × 3 table", "back to 6 × 3")
    tiles = page.locator("#table-dialog button, #table-dialog .swatch").evaluate_all("els => els.filter(e => e.offsetParent).map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))")
    check(min(tiles) >= 40, f"every dialog button is a touch target (smallest {min(tiles):.0f}px; swatches 40px in the dialog)")
    page.screenshot(path=str(OUT / "table-dialog.png"))
    page.click("#table-insert")
    page.wait_for_timeout(300)
    card = page.locator(".section-body .table-card").first
    check(card.count() == 1 and card.get_attribute("data-tstyle") == "banded" and card.get_attribute("data-first-col") == "bold", "the table is on a Banded card, first column bold")
    check(page.locator(".section-body table tr").count() == 6 and page.locator(".section-body table th").count() == 3, "6 rows (header + 5) × 3 columns")
    check("--sub-gs2" in (card.get_attribute("style") or ""), "the chosen colour is on the card")
    page.keyboard.type("State")
    for t in ["Seats", "Share", "Uttar Pradesh", "80", "14.7%", "Bihar", "40", "7.4%"]:
        page.keyboard.press("Tab")
        page.keyboard.type(t)
    page.wait_for_timeout(300)
    saved(page)
    t = table_of(page, "Tables")
    check(t["attrs"].get("tstyle") == "banded" and t["attrs"].get("color") == "gs2" and t["attrs"].get("firstCol") is True and "caption" not in t["attrs"], f"stored: tstyle, color, firstCol; no empty caption ({t['attrs']})")
    check(size_of(t) == (6, 3), f"stored size 6 × 3 ({size_of(t)})")

    # ================= figure columns =================
    nums = page.locator(".section-body td.num")
    check(nums.count() == 10 and page.locator(".section-body th.num-head").count() == 2 and page.locator(".section-body td.num:has-text('Bihar')").count() == 0,
          f"the two figure columns are found, empty rows too, not the State column ({nums.count()} cells)")
    st = nums.first.evaluate("e => [getComputedStyle(e).textAlign, getComputedStyle(e).fontFamily]")
    check(st[0] == "right" and "IBM Plex Mono" in st[1], f"figures line up on the right in IBM Plex Mono ({st})")
    check(page.locator(".section-body td:has-text('Uttar Pradesh')").evaluate("e => getComputedStyle(e).fontWeight") == "700", "the first column is bold")
    check('"num' not in json.dumps(doc(page, "Tables")), "figure marks are never stored")
    banded = page.locator(".section-body table tr").nth(1).locator("td").first.evaluate("e => getComputedStyle(e).backgroundColor")
    plain = page.locator(".section-body table tr").nth(2).locator("td").first.evaluate("e => getComputedStyle(e).backgroundColor")
    check(banded != plain, f"Banded: every other row is tinted ({banded} / {plain})")

    # ================= Undo takes the inserted table back in one step =================
    page.wait_for_timeout(600)
    n_before = page.locator(".section-body table").count()
    for _ in range(12):
        if page.locator(".section-body table").count() == 0:
            break
        undo(page)
    check(n_before == 1 and page.locator(".section-body table").count() == 0, "Undo takes the table out")
    page.click("#note-redo")
    page.wait_for_timeout(250)
    check(page.locator(".section-body table").count() == 1, "Redo puts the table back (empty: the typing is the next step)")
    for _ in range(12):
        if page.locator(".section-body td:has-text('7.4%')").count():
            break
        page.click("#note-redo")
        page.wait_for_timeout(150)
    check(page.locator(".section-body td:has-text('7.4%')").count() == 1, "Redo brings the typing back too")

    # ================= the table bar =================
    caret_in_cell(page, "80")
    bar = page.locator("#ctxbar .tb-table")
    for name in ["+ Row", "+ Column", "− Row", "− Column", "Header row", "Fit width", "Delete table", "Style"]:
        check(bar.locator(f"button:has-text('{name}')").count() == 1, f"the table bar has {name}")
    check(page.locator("#table-size").text_content() == "6 × 3 ▾", f"the size button says 6 × 3 ({page.locator('#table-size').text_content()})")

    # ================= R × C ▾: rows and columns together =================
    page.click("#table-size")
    page.wait_for_selector("#size-pop")
    check(page.locator("#size-apply").is_disabled(), "Apply waits for a change")
    for _ in range(4):
        page.click("#size-rows-minus")
    check(page.locator("#size-rows").text_content() == "2", "rows down to 2")
    check(page.locator("#size-warn").is_visible() and "3 cells" in page.locator("#size-warn").text_content(), f"it warns that 3 cells with text would go ({page.locator('#size-warn').text_content()})")
    check(page.locator("#size-apply").text_content() == "Delete 3 cells and resize" and "danger-btn" in page.locator("#size-apply").get_attribute("class"), "the button says Delete 3 cells and resize, in red")
    page.click("#size-rows-plus")
    page.click("#size-rows-plus")
    page.click("#size-cols-plus")
    check(page.locator("#size-warn").is_hidden() and page.locator("#size-apply").text_content() == "Apply", "4 × 4 loses nothing: no warning")
    page.click("#size-apply")
    page.wait_for_timeout(300)
    check(page.locator("#size-pop").count() == 0 and page.locator("#table-size").text_content() == "4 × 4 ▾", "Apply resizes to 4 × 4")
    saved(page)
    check(size_of(table_of(page, "Tables")) == (4, 4), "stored 4 × 4")
    undo(page)
    check(page.locator("#table-size").text_content() == "6 × 3 ▾" and page.locator(".section-body table tr").count() == 6, "one Undo puts 6 × 3 back")
    # shrink with content: the cells go, Undo brings them back
    caret_in_cell(page, "80")
    page.click("#table-size")
    for _ in range(4):
        page.click("#size-rows-minus")
    page.click("#size-cols-minus")
    page.click("#size-apply")
    page.wait_for_timeout(300)
    check(page.locator(".section-body table tr").count() == 2 and page.locator(".section-body td:has-text('Bihar')").count() == 0 and page.locator("#table-size").text_content() == "2 × 2 ▾", "Delete … and resize: 2 × 2, Bihar's row gone")
    undo(page)
    check(page.locator(".section-body td:has-text('Bihar')").count() == 1 and page.locator(".section-body td:has-text('7.4%')").count() == 1, "one Undo brings every removed cell back")
    # Esc closes the popover and changes nothing
    caret_in_cell(page, "80")
    page.click("#table-size")
    page.click("#size-rows-plus")
    page.keyboard.press("Escape")
    check(page.locator("#size-pop").count() == 0 and page.locator(".section-body table tr").count() == 6, "Esc closes the size popover, nothing changes")
    # up to 50 × 12
    page.click("#table-size")
    for _ in range(50):
        page.click("#size-rows-plus")
    for _ in range(12):
        page.click("#size-cols-plus")
    check(page.locator("#size-rows").text_content() == "50" and page.locator("#size-cols").text_content() == "12", "the steppers stop at 50 rows, 12 columns")
    page.click("#size-cancel")

    # ================= Style: style, colour, header, first column, caption =================
    caret_in_cell(page, "80")
    page.click("button[aria-label='Table style']")
    page.wait_for_selector("#look-panel:not([hidden])")
    check(page.locator("#look-panel .lp-title").text_content() == "Table style", "Style opens the Table style panel")
    page.wait_for_timeout(600)
    for s in ["clean", "lined", "minimal", "boxed"]:
        page.click(f"#table-styles button[data-tstyle='{s}']")
        page.wait_for_timeout(150)
        check(card.get_attribute("data-tstyle") == s and page.locator(f"#table-styles button[data-tstyle='{s}']").get_attribute("aria-pressed") == "true", f"style {s} applies")
    head = page.locator(".section-body th").first.evaluate("e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]")
    gs2 = page.evaluate("() => { const d = document.createElement('div'); d.style.color = 'var(--sub-gs2)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }")
    check(head[0] == gs2 and head[1] == "rgb(255, 255, 255)", f"Boxed: the header row is the colour with white text ({head}, {gs2})")
    page.wait_for_timeout(600)
    page.fill("#table-caption", "Lok Sabha seats by state")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check(page.locator(".section-body .table-cap").text_content() == "Lok Sabha seats by state", "the caption shows above the table")
    page.wait_for_timeout(600)
    page.click("#table-firstcol-toggle")
    page.wait_for_timeout(300)
    check(card.get_attribute("data-first-col") is None, "Bold first column off")
    page.wait_for_timeout(600)
    page.click("#look-colours [data-colour='subject']")
    page.wait_for_timeout(300)
    check("--sub-gs2" not in (card.get_attribute("style") or ""), "Subject colour: the card follows the note's subject")
    saved(page)
    t = table_of(page, "Tables")
    check(t["attrs"].get("tstyle") == "boxed" and t["attrs"].get("caption") == "Lok Sabha seats by state" and "color" not in t["attrs"] and "firstCol" not in t["attrs"], f"stored: boxed, caption, no colour, no first column ({t['attrs']})")
    undo(page)
    check("--sub-gs2" in (card.get_attribute("style") or ""), "one Undo per change: the colour comes back")
    page.click("#note-redo")
    page.wait_for_timeout(250)
    page.click("#table-header-toggle")
    page.wait_for_timeout(300)
    check(page.locator(".section-body th").count() == 0, "Header row off from the Style panel")
    page.click("#table-header-toggle")
    page.wait_for_timeout(300)
    check(page.locator(".section-body th").count() == 3, "and on again")
    page.click("#look-done")
    check(page.locator("#look-panel").is_hidden(), "Done closes the panel")
    # leaving the table closes it too
    caret_in_cell(page, "80")
    page.click("button[aria-label='Table style']")
    page.wait_for_selector("#look-panel:not([hidden])")
    page.locator(".section-body p:has-text('Seats in the House')").click()
    page.wait_for_timeout(300)
    check(page.locator("#look-panel").is_hidden(), "the panel closes when the caret leaves the table")
    saved(page)

    # ================= search finds the caption =================
    page.keyboard.press("Control+k")
    page.fill("#global-search", "lok sabha seats")
    page.wait_for_timeout(500)
    check(page.locator("#search-results .search-hit:has-text('Tables')").count() >= 1, "search finds the note by its table caption")
    page.keyboard.press("Escape")

    # ================= PDF =================
    pdf = save_pdf(page, "tables.pdf")
    ws = words(pdf)
    cap = word(ws, "Lok")
    state = word(ws, "State")
    check(cap is not None and state is not None and cap[2] < state[2], f"PDF: the caption prints above the table ({cap}, {state})")
    seats = word(ws, "Seats", state[2] if state else 0)
    n80 = word(ws, "80")
    n40 = word(ws, "40")
    check(seats and n80 and n40 and abs(n80[3] - n40[3]) < 1.5 and n80[1] > n40[1] - 6 and abs(n80[3] - seats[3]) < 2, f"PDF: figures are right-aligned in their column ({seats}, {n80}, {n40})")
    pdfi = subprocess.run(["pdftoppm", "-r", "50", "-png", "-f", "1", "-l", "1", str(pdf), str(OUT / "tables-pdf")], capture_output=True)
    check(pdfi.returncode == 0, "PDF page renders")

    # ================= a table from before 0.12 =================
    old = page.evaluate(NOTE, "Tables")
    old_id = "old-table-note"
    rec = json.loads(json.dumps(old))
    rec.update({"id": old_id, "title": "Old table", "updatedAt": 1700000000000, "createdAt": 1700000000000})
    rec["sections"] = [{"id": "s-old", "heading": "Notes", "doc": {"type": "doc", "content": [
        {"type": "table", "content": [
            {"type": "tableRow", "content": [{"type": "tableHeader", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Body"}]}]},
                                              {"type": "tableHeader", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Members"}]}]}]},
            {"type": "tableRow", "content": [{"type": "tableCell", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Rajya Sabha"}]}]},
                                              {"type": "tableCell", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "245"}]}]}]}]},
        {"type": "paragraph"}]}}]
    rec.pop("insights", None)
    page.evaluate(IDB_PUT, rec)
    page.goto(URL + "#/n/" + old_id)
    page.wait_for_selector(".section-body .table-card")
    page.wait_for_timeout(1500)
    oc = page.locator(".section-body .table-card")
    check(oc.get_attribute("data-tstyle") == "clean" and oc.get_attribute("data-first-col") is None, "a table from before 0.12 shows as Clean, first column not bold")
    check(page.locator(".section-body td:has-text('Rajya Sabha')").evaluate("e => getComputedStyle(e).fontWeight") != "700", "its first column stays as it was")
    after = page.evaluate(NOTE, "Old table")
    check(after["updatedAt"] == 1700000000000 and after["sections"][0]["doc"] == rec["sections"][0]["doc"], "opening it rewrites nothing")

    # ================= night: on-colour text =================
    page.goto(URL + "#/n/" + old["id"])
    page.wait_for_selector(".section-body .table-card[data-tstyle='boxed']")
    page.evaluate("() => document.documentElement.setAttribute('data-theme', 'night')")
    night = page.locator(".section-body th").first.evaluate("e => getComputedStyle(e).color")
    check(night == "rgb(16, 22, 27)", f"night: header text on the colour is dark ({night})")
    page.evaluate("() => document.documentElement.removeAttribute('data-theme')")

    # ================= phone width: the table scrolls in its card =================
    phone = browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True)
    pp = phone.new_page()
    pp.on("pageerror", lambda e: errors.append(str(e)))
    pp.goto(URL + "#/notes")
    pp.wait_for_selector("#new-note")
    pp.evaluate(IDB_PUT, {**old, "id": "wide-one", "title": "Wide"})
    pp.goto(URL + "#/n/wide-one")
    pp.wait_for_selector(".section-body .table-card")
    pp.locator(".section-body td").first.click()
    pp.wait_for_timeout(300)
    pp.click("#table-size")
    for _ in range(7):
        pp.click("#size-cols-plus")
    pp.click("#size-apply")
    pp.wait_for_timeout(400)
    # (the note header is already wider than 390px, as in 0.11, so the card itself is measured)
    sw = pp.evaluate("() => { const w = document.querySelector('.section-body .tableWrapper'); return [w.scrollWidth, w.clientWidth, Math.round(document.querySelector('.section-body .table-card').getBoundingClientRect().right), innerWidth]; }")
    check(sw[0] > sw[1] and sw[2] <= sw[3], f"phone: a 9-column table scrolls inside its card, the card stays on screen ({sw})")
    pp.screenshot(path=str(OUT / "phone-table.png"))
    phone.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
