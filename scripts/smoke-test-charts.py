"""0.13 smoke test: charts. Needs `vite preview` on :4173.

Insert → Chart opens one gallery: 12 charts from numbers, 8 diagrams and the mind map from words. Every chart
kind inserts as a `chart` node and draws as SVG in the Study desk colours (the plan's look): rounded bars,
light grid, chip legend, title + subtitle + source, values on tap (a bubble), draw-in 300 ms (none with
reduced motion). Edit data: title, type, subtitle, source, unit, six palettes and the subject's family,
numbers always / on tap, rows and series; Done is one undo step, Cancel changes nothing. A 0.12 chart
(`chartBlock`) opens with the new look untouched, and turns into a `chart` on its first edit (one Undo
takes it back). Chart words are searchable; the PDF prints every chart as vector drawing (no picture).
"""
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from pypdf import PdfReader

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []

KINDS = ["column", "bar", "stacked", "line", "area", "combo", "pie", "donut", "radar", "polar", "scatter", "bubble"]
WORDS = ["timeline", "flow", "cycle", "pyramid", "venn", "tree", "compare", "matrix", "mindmap"]


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""


def blocks(page, title):
    return page.evaluate(NOTE, title)["sections"][0]["doc"]["content"]


def charts(page, title):
    return [b for b in blocks(page, title) if b["type"] in ("chart", "chartBlock")]


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
    slash(page, "chart")
    page.wait_for_selector("#chart-gallery")
    page.click(f"#chart-gallery .gallery-tile[data-kind='{kind}']")
    page.wait_for_selector(f".chart-block[data-kind='{kind}'] svg")
    page.wait_for_timeout(150)


def new_note(page, title):
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", title)
    page.locator(".section-body .rich").first.click()


def save_pdf(page, name):
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / name
    dl.value.save_as(pdf)
    page.click("#details summary")
    return pdf


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    new_note(page, "Energy charts")
    page.keyboard.type("Charts below.")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    saved(page)

    # ================= the gallery =================
    slash(page, "chart")
    page.wait_for_selector("#chart-gallery")
    heads = page.locator("#chart-gallery .gallery-group h3").all_text_contents()
    check(heads == ["From numbers · 12", "From words · 9"], f"the gallery has two groups: 12 from numbers, 9 from words ({heads})")
    got = page.locator("#gallery-numbers .gallery-tile").evaluate_all("els => els.map(e => e.dataset.kind)")
    check(got == KINDS, f"the 12 charts, in order ({got})")
    got = page.locator("#gallery-words .gallery-tile").evaluate_all("els => els.map(e => e.dataset.kind)")
    check(got == WORDS, f"the 8 diagrams and the mind map ({got})")
    check(page.locator("#chart-gallery .gallery-tile svg").count() == 21, "every tile shows a small picture of the real thing")
    sizes = page.locator("#chart-gallery .gallery-tile").evaluate_all("els => els.map(e => Math.min(e.offsetWidth, e.offsetHeight))")
    check(min(sizes) >= 44, f"tiles are at least 44 px ({min(sizes)})")
    check(page.locator("#chart-gallery .gallery-tile").first.evaluate("e => e === document.activeElement"), "the first chart tile has focus")
    page.keyboard.press("Escape")
    check(page.locator("#chart-gallery").count() == 0 and not charts(page, "Energy charts"), "Esc closes the gallery and inserts nothing")

    # ================= all 12 kinds =================
    for k in KINDS:
        insert(page, k)
    # a new chart draws in once (later redraws don't animate)
    anim = page.locator(".chart-block[data-kind='bubble'] .ch-in").first.evaluate("e => [getComputedStyle(e).animationName, getComputedStyle(e).animationDuration]")
    check(anim == ["ch-in", "0.3s"], f"charts draw in over 300 ms ({anim})")
    saved(page)
    cs = charts(page, "Energy charts")
    check([c["type"] for c in cs] == ["chart"] * 12 and [c["attrs"]["kind"] for c in cs] == KINDS, f"12 `chart` nodes, one of each kind ({[c['attrs']['kind'] for c in cs]})")
    check(all(c["attrs"]["palette"] == "desk" for c in cs), "new charts take the Study desk colours (the plan's look)")
    tipless = [k for k in KINDS if page.locator(f".chart-block[data-kind='{k}'] [data-tip]").count() == 0]
    check(not tipless, f"every kind has parts that show their value on tap ({tipless})")
    col = page.locator(".chart-block").nth(0)
    check(col.locator(".chart-title").text_content() == "Renewable energy capacity" and "example numbers" in col.locator(".chart-sub").text_content(), "a chart has a title and a subtitle")
    rounded = col.locator("svg path[data-tip]").first.get_attribute("d")
    check(" A" in rounded or "Q" in rounded or " a" in rounded, f"bars have rounded ends ({rounded[:60]})")
    check(col.locator("svg line[stroke-dasharray]").count() >= 3, "a light dashed grid")
    check(col.locator("svg text", has_text="186").count() == 1, "a column chart shows its numbers (values always)")
    check(page.locator(".chart-block[data-kind='line'] svg text", has_text="5.5").count() == 0 and page.locator(".chart-block[data-kind='line'] svg text", has_text="4.4%").count() == 1,
          "a line chart labels only its last point (values on tap)")
    check(page.locator(".chart-block[data-kind='line'] svg text", has_text="8%").count() == 1, "a percentage axis says %")
    check(page.locator(".chart-block[data-kind='stacked'] .chart-chip").count() == 4 and page.locator(".chart-block[data-kind='column'] .chart-legend").is_hidden(),
          "a chip legend for 2+ series, none for one")

    # ---- values on tap ----
    page.locator(".chart-block[data-kind='line'] svg circle[data-tip]").nth(1).click()
    tip = page.locator(".chart-block[data-kind='line'] .fig-tip")
    check(tip.is_visible() and "May" in tip.text_content() and "6.7" in tip.text_content(), f"tapping a point shows its value ({tip.text_content()})")
    page.locator(".chart-block[data-kind='line'] .chart-head").click()
    check(tip.is_hidden(), "tapping elsewhere hides it")
    pie = page.locator(".chart-block[data-kind='pie']")
    pie.locator("svg [data-tip]").nth(1).click()
    check("States' share" in pie.locator(".fig-tip").text_content() and "22%" in pie.locator(".fig-tip").text_content(), "a pie slice shows its name and share")

    # ---- legend chips hide a series ----
    st = page.locator(".chart-block[data-kind='stacked']")
    before = st.locator("svg [data-tip]").count()
    st.locator(".chart-chip").nth(0).click()
    check(st.locator(".chart-chip").nth(0).get_attribute("aria-pressed") == "false" and st.locator("svg [data-tip]").count() == before - 5, "tapping a chip hides its series")
    for i in range(1, 4):
        st.locator(".chart-chip").nth(i).click()
    check(st.locator(".chart-chip[aria-pressed='true']").count() == 1, "the last series can't be hidden")
    for i in range(4):
        if st.locator(".chart-chip").nth(i).get_attribute("aria-pressed") == "false":
            st.locator(".chart-chip").nth(i).click()
    check(st.locator("svg [data-tip]").count() == before, "tapping again shows it")
    check(cs[2]["attrs"] == charts(page, "Energy charts")[2]["attrs"], "hiding a series is a view, never saved")

    # ---- touch targets ----
    small = page.locator(".chart-edit, .chart-chip").evaluate_all("els => els.filter(e => e.offsetParent).map(e => Math.min(e.offsetWidth, e.offsetHeight)).filter(v => v < 44)")
    check(not small, f"Edit data and the chips are at least 44 px ({small})")

    # ================= Edit data =================
    col.locator(".chart-edit").click()
    panel = col.locator(".chart-panel")
    check(panel.is_visible() and col.locator(".chart-row input").input_value() == "Renewable energy capacity", "Edit data opens the panel under the chart")
    check(panel.locator(".fig-pal").count() == 7 and panel.locator(".fig-pal[aria-checked='true']").get_attribute("data-palette") == "desk", "the subject's family + six palettes, Study desk picked")
    col.locator(".chart-row input").fill("Solar capacity")
    panel.locator("input[aria-label='Subtitle']").fill("GW, by year")
    panel.locator("input[aria-label='Source']").fill("MNRE")
    panel.locator(".fig-pal[data-palette='ocean']").click()
    check(col.locator(".chart-title").text_content() == "Solar capacity", "the picture follows the edit live")
    panel.locator(".chart-grid tr").nth(1).locator("input").nth(1).fill("110")
    panel.locator(".chart-actions button:has-text('Add row')").click()
    panel.locator(".chart-actions button:has-text('Add series')").click()
    panel.locator(".chart-actions button:has-text('Done')").click()
    settle(page)
    c = charts(page, "Energy charts")[0]["attrs"]
    check(c["title"] == "Solar capacity" and c["subtitle"] == "GW, by year" and c["source"] == "MNRE" and c["palette"] == "ocean", f"Done saves title, subtitle, source, palette ({c['title']}, {c['palette']})")
    check(c["series"][0]["values"][0] == 110 and len(c["labels"]) == 6 and len(c["series"]) == 2, f"…and the numbers, a new row and a new series ({c['series'][0]['values']}, {len(c['labels'])}, {len(c['series'])})")
    check(col.locator(".chart-foot").text_content() == "Source: MNRE", "the source shows under the chart")
    page.click("#note-undo")
    settle(page)
    c = charts(page, "Energy charts")[0]["attrs"]
    check(c["title"] == "Renewable energy capacity" and len(c["labels"]) == 5 and c["palette"] == "desk", f"one Undo takes the whole edit back ({c['title']}, {len(c['labels'])}, {c['palette']})")
    page.click("#note-redo")
    page.wait_for_timeout(500)
    col.locator(".chart-edit").click()
    col.locator(".chart-row input").fill("Never saved")
    panel.locator("select[aria-label='Chart type']").select_option("line")
    check(col.get_attribute("data-kind") == "line", "changing the type redraws at once")
    panel.locator(".chart-actions button:has-text('Cancel')").click()
    settle(page)
    c = charts(page, "Energy charts")[0]["attrs"]
    check(c["title"] == "Solar capacity" and c["kind"] == "column" and col.get_attribute("data-kind") == "column", "Cancel changes nothing")
    # numbers on tap
    col.locator(".chart-edit").click()
    panel.locator(".fig-seg button:has-text('On tap')").click()
    panel.locator(".chart-actions button:has-text('Done')").click()
    settle(page)
    check(charts(page, "Energy charts")[0]["attrs"]["values"] == "tap" and col.locator("svg text", has_text="186").count() == 0, "Numbers: On tap hides the printed values")

    # ---- night redraws in night colours ----
    fill_day = page.locator(".chart-block[data-kind='bar'] svg path[data-tip]").first.get_attribute("fill")
    page.evaluate("() => { document.documentElement.setAttribute('data-theme', 'night'); window.dispatchEvent(new Event('themechange')); }")
    page.wait_for_timeout(300)
    fill_night = page.locator(".chart-block[data-kind='bar'] svg path[data-tip]").first.get_attribute("fill")
    check(fill_day != fill_night, f"night redraws the chart in night colours ({fill_day} → {fill_night})")
    page.evaluate("() => { document.documentElement.removeAttribute('data-theme'); window.dispatchEvent(new Event('themechange')); }")


    # ================= search =================
    page.keyboard.press("Control+k")
    page.wait_for_selector("#global-search")
    page.fill("#global-search", "mizoram")
    page.wait_for_timeout(400)
    check("Energy charts" in page.locator("#search-results").inner_text(), "Ctrl+K finds a chart's label")
    page.fill("#global-search", "MNRE")
    page.wait_for_timeout(400)
    check("Energy charts" in page.locator("#search-results").inner_text(), "…and its source")
    page.keyboard.press("Escape")

    # ================= PDF: vector =================
    saved(page)
    pdf = save_pdf(page, "charts.pdf")
    txt = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    for needle in ["Solar capacity", "GW, by year", "Source: MNRE", "Forest cover: top 5 states", "Mizoram", "Where a rupee goes", "Literacy vs income", "2021"]:
        check(needle in txt, f"the PDF prints '{needle}'")
    n_img = sum(len(pg.images) for pg in PdfReader(str(pdf)).pages)
    check(n_img == 0, f"charts print as vector drawing, not pictures ({n_img} images)")
    subprocess.run(["pdftoppm", "-png", "-r", "70", "-f", "1", "-l", "2", str(pdf), str(OUT / "charts")])

    # ================= a 0.12 chart =================
    rec = page.evaluate(NOTE, "Energy charts")
    old = json.loads(json.dumps(rec))
    old["id"] = "old-chart-note"
    old["title"] = "Old chart"
    old["updatedAt"] = 1760000000000
    legacy = {"type": "chartBlock", "attrs": {"kind": "bar", "title": "Seats 2019", "labels": ["BJP", "INC", "DMK"], "series": [{"name": "Seats", "values": [303, 52, 24]}], "align": "center", "width": 100}}
    old["sections"] = [{**rec["sections"][0], "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Lok Sabha 2019."}]}, legacy, {"type": "paragraph"}]}}]
    page.evaluate(IDB_PUT, old)
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.goto(URL + "#/n/old-chart-note")
    page.wait_for_selector(".chart-block svg")
    page.wait_for_timeout(1500)
    oc = page.locator(".chart-block")
    check(oc.get_attribute("data-kind") == "column" and oc.locator(".chart-title").text_content() == "Seats 2019" and oc.locator("svg text", has_text="303").count() == 1,
          "a 0.12 bar chart opens as a column chart with the new look")
    now = page.evaluate(NOTE, "Old chart")
    check(now["updatedAt"] == 1760000000000 and now["sections"][0]["doc"]["content"][1] == legacy, "opening it rewrites nothing")
    oc.locator(".chart-edit").click()
    oc.locator(".chart-row input").fill("Seats won, 2019")
    oc.locator(".chart-actions button:has-text('Done')").click()
    settle(page)
    b = blocks(page, "Old chart")[1]
    check(b["type"] == "chart" and b["attrs"]["kind"] == "column" and b["attrs"]["title"] == "Seats won, 2019" and b["attrs"]["labels"] == ["BJP", "INC", "DMK"] and b["attrs"]["series"][0]["values"] == [303, 52, 24],
          f"its first edit turns it into a 0.13 chart, numbers kept ({b['type']})")
    page.click("#note-undo")
    settle(page)
    b = blocks(page, "Old chart")[1]
    check(b == legacy, f"one Undo puts the 0.12 chart back exactly ({b['type']})")

    # ================= reduced motion, the Tab S8 and a phone =================
    for w, h in [(800, 1280), (390, 800)]:
        ctx2 = browser.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce", has_touch=True)
        p2 = ctx2.new_page()
        p2.on("pageerror", lambda e: errors.append(str(e)))
        p2.goto(URL)
        p2.evaluate(IDB_PUT, rec)
        p2.goto(URL + "#/n/" + rec["id"])
        p2.wait_for_selector(".chart-block svg")
        p2.wait_for_timeout(800)
        if w == 800:
            a2 = p2.locator(".chart-block .ch-in").evaluate_all("els => els.map(e => getComputedStyle(e).animationName).filter(n => n !== 'none').length")
            check(a2 == 0, f"no draw-in with reduced motion ({a2} animated)")
            over = p2.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(over <= 0, f"Tab S8 portrait: twelve charts, the page never scrolls sideways ({over})")
        # (the note header is already wider than 390 px, as in 0.11, so on a phone the cards are measured)
        bad = p2.evaluate("""() => { const col = document.querySelector('.section-body .rich').getBoundingClientRect();
            return [...document.querySelectorAll('.chart-block')].filter(f => { const r = f.getBoundingClientRect(), s = f.querySelector('svg').getBoundingClientRect();
              return r.right > col.right + 1 || s.right > r.right + 1 || f.scrollWidth > f.clientWidth + 1; }).map(f => f.dataset.kind); }""")
        check(not bad, f"{w} px: every chart fits its column ({bad})")
        p2.screenshot(path=str(OUT / f"width-{w}.png"))
        ctx2.close()

    page.screenshot(path=str(OUT / "charts.png"))
    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
if failures:
    print(f"{len(failures)} FAILED")
    sys.exit(1)
print("ALL PASSED")
