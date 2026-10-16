"""0.14 smoke test: templates. Needs `vite preview` on :4173.

New note shows 19 templates in five groups (Mains writing, Revision, Current affairs, Subject sheets, Start
fresh), each a tile with a small picture of its sections; one tap starts. Each template gives its sections
and what they start with (tables, callouts, containers, diagrams, charts, a mind map), all blocks the
editor already knows: nothing opens read-only. GS answer and PYQ practice show the word meter. The template
chip lists them in groups; switching an empty note swaps the sections in one Undo step. A subject page
keeps its four Start from chips and links to All templates. Save as template keeps sections, headings with
their looks, containers and callouts (emptied) and tables (header row kept) and drops writing, lists and
figures; it shows under My templates with rename and delete. Backup format 8 carries the templates.
"""
import json
import subprocess
import sys
import tempfile
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
META = """(key) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('meta').objectStore('meta').get(key); g.onsuccess = () => { q.result.close(); r(g.result ? g.result.value : null); }; }; })"""

GROUPS = {"Mains writing": 4, "Revision": 5, "Current affairs": 5, "Subject sheets": 4, "Start fresh": 1}
# id -> (sections, selectors that must be in the note, meter shown)
EXPECT = {
    "gs-answer": (["Intro", "Body", "Way forward"], [], True),
    "essay-outline": (["Thesis", "Dimensions", "Quotes and anecdotes", "Counter-view", "Conclusion"], ["table", ".panel[data-kind='quote'], .panel.quote, [data-panel='quote']"], False),
    "ethics-case": (["Facts of the case", "Stakeholders", "Ethical dilemmas", "Options with pros and cons", "Course of action"], ["table", ".panel-column, [data-panel-column]"], False),
    "pyq-practice": (["The question", "My answer", "Points I missed", "Model structure"], ["aside.callout[data-callout='pyq']", "figure.chart-block"], True),
    "topic-sheet": (["Key terms", "Articles and cases", "Data", "Examples", "PYQs"], [], False),
    "one-page": (["Key terms", "5 must-know facts", "Mnemonic", "Likely questions"], ["ol li", ".panel"], False),
    "cornell": (["Cues and notes", "Summary"], [".panel-column, [data-panel-column]"], False),
    "mind-map": (["Mind map", "Notes on each branch"], ["figure.mindmap-block"], False),
    "comparison": (["Comparison table", "Similarities", "Differences", "Verdict"], ["table", "figure.diagram-block"], False),
    "current-affairs": (["News", "Background", "Syllabus link", "Prelims facts", "Mains angle"], [], False),
    "editorial": (["Source and date", "Gist in 3 lines", "Arguments for and against", "Data quoted", "My view", "Syllabus tag"], ["ol li", "aside.callout[data-callout='data']", ".panel-column, [data-panel-column]"], False),
    "scheme-card": (["Ministry, launch and budget", "Objectives", "Key features", "Data and progress", "Criticism", "Related PYQs"], ["table", "aside.callout[data-callout='pyq']"], False),
    "report-index": (["Released by", "Key findings", "India’s rank and score", "What it means for India"], ["table", "figure.chart-block"], False),
    "monthly-digest": (["Polity", "Economy", "Environment", "International relations", "Science and tech", "Prelims one-liners"], [], False),
    "history-timeline": (["Timeline", "Causes", "Events", "Consequences", "Personalities"], ["figure.diagram-block"], False),
    "constitution-article": (["Text of the Article", "Provisions", "Landmark cases", "Amendments", "Related Articles"], ["aside.callout[data-callout='article']", "table"], False),
    "map-sheet": (["Map with labels", "Location facts", "Places in the news"], ["table"], False),
    "thinker-sheet": (["Life and context", "Key ideas", "Quotes", "Critiques", "How to use in answers"], [".panel"], False),
    "blank": (["Notes"], [], False),
}


def headings(page):
    return page.locator(".section-heading").evaluate_all("els => els.map(e => e.value)")


def menu(page, label):
    page.click("#note-more")
    page.click(f".popover button:has-text('{label}')")


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ================= the gallery =================
    page.goto(URL + "#/n/new")
    page.wait_for_selector(".tpl-card")
    cards = page.locator(".tpl-card")
    check(cards.count() == 19, f"19 templates on New note ({cards.count()})")
    for g, n in GROUPS.items():
        c = page.locator(f".tpl-group[data-group='{g}'] .tpl-card").count()
        check(c == n, f"group {g}: {n} templates ({c})")
    check(page.locator(".tpl-card .tpl-thumb").count() == 19, "every tile has a picture of its sections")
    sizes = cards.evaluate_all("els => els.map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))")
    check(min(sizes) >= 44, f"tiles are touch-sized (smallest {min(sizes):.0f}px)")
    check("Comes with: Dimensions table, Quote container" in page.locator(".tpl-card[data-template='essay-outline']").text_content(), "a tile says what it comes with")
    check(page.locator("#my-templates").is_hidden(), "no My templates group before he saves one")
    check(page.locator("#tpl-save-hint").is_visible(), "the gallery says how to save a note as a template")
    page.screenshot(path=str(OUT / "gallery.png"), full_page=True)
    page.click(".tpl-card[data-template='ethics-case']")
    page.wait_for_selector("#f-title")
    check("#/n/new/ethics-case" in page.url and headings(page)[1] == "Stakeholders", "one tap starts a note from it")

    # ================= every template =================
    for tid, (secs, sels, meter) in EXPECT.items():
        page.goto(URL + "#/n/new/" + tid)
        page.wait_for_selector("#f-title")
        page.wait_for_timeout(250)
        got = headings(page)
        check(got == secs, f"{tid}: sections {got}")
        for sel in sels:
            check(page.locator(f".section-body :is({sel})").count() > 0, f"{tid}: starts with {sel}")
        check(page.locator(".unreadable-note").count() == 0, f"{tid}: nothing opens read-only")
        check(page.locator("#answer-meter").is_visible() == meter, f"{tid}: word meter {'shown' if meter else 'hidden'}")
        check(page.locator("#f-template").input_value() == tid, f"{tid}: the template chip names it")
    # a table's header row comes filled in
    page.goto(URL + "#/n/new/essay-outline")
    page.wait_for_selector(".section-body table")
    cells = page.locator(".section-body table th").evaluate_all("els => els.map(e => e.textContent)")
    check(cells[:2] == ["Dimension", "Points"] and "Environmental" in cells, f"essay outline: dimensions table filled in ({cells[:4]})")

    # it saves as an ordinary note once he writes
    page.goto(URL + "#/n/new/report-index")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Global Hunger Index")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("IFPRI and partners")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    n = page.evaluate(NOTE, "Global Hunger Index")
    types = [b["type"] for b in n["sections"][2]["doc"]["content"]]
    check(n["template"] == "report-index" and types[:2] == ["table", "chart"], f"stored: template and blocks ({n['template']}, {types})")
    # PDF prints it
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / "report.pdf"
    dl.value.save_as(pdf)
    text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    check("rank and score" in text and "Key findings" in text and "Rank" in text, "the PDF prints its sections and table")

    # ================= the template chip =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-template")
    groups = page.locator("#f-template optgroup").evaluate_all("els => els.map(e => e.label)")
    check(groups == list(GROUPS), f"the chip lists templates in groups ({groups})")
    page.fill("#f-title", "Switch me")
    page.select_option("#f-template", "constitution-article")
    page.wait_for_timeout(300)
    check(headings(page)[0] == "Text of the Article" and page.locator(".section-body aside.callout[data-callout='article']").count() == 1, "switching an empty note swaps in the template with its blocks")
    page.click("#note-undo")
    page.wait_for_timeout(300)
    check(headings(page) == ["Notes"], "one Undo puts the blank note back")
    page.click("#note-redo")
    page.wait_for_timeout(300)
    check(len(headings(page)) == 5, "and Redo brings the template again")

    # ================= subject page: Start from chips =================
    page.goto(URL + "#/notes/f/" + "gen%3AGS2")
    page.wait_for_selector(".tpl-row")
    check(page.locator(".tpl-row .chip-link").count() == 4, "a subject keeps its four Start from chips")
    page.click("#all-templates")
    page.wait_for_selector(".tpl-card")
    check(page.url.endswith("#/n/new") and page.locator(".tpl-card").count() == 19, "All templates opens the gallery")

    # ================= save as template =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Polity sheet")
    sample = {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 2, "look": {"style": "pill", "color": "gs2", "fill": "soft", "corner": "round", "icon": None, "width": "fit", "align": "left"}}, "content": [{"type": "text", "text": "Key idea"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "Secret paragraph text"}]},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Secret list item"}]}]}]},
        {"type": "callout", "attrs": {"kind": "case", "year": None, "paper": None, "marks": None}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Secret case"}]}]},
        {"type": "panel", "attrs": {"kind": "titled", "color": "gs4", "fill": "soft", "corner": "round", "icon": "star", "title": "Remember", "author": None}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Secret panel"}]}]},
        {"type": "table", "attrs": {"tstyle": "banded", "color": None, "caption": None, "firstCol": None}, "content": [
            {"type": "tableRow", "content": [{"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Article"}]}]}, {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Subject"}]}]}]},
            {"type": "tableRow", "content": [{"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Art 14"}]}]}, {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Secret cell"}]}]}]}]},
        {"type": "chart", "attrs": {"kind": "pie", "title": "Seats", "subtitle": "", "labels": ["A", "B"], "series": [{"name": "s", "values": [1, 2]}], "palette": "desk", "values": "all", "align": "center", "width": 100}},
        {"type": "paragraph"}]}
    page.evaluate("""(doc) => { const ed = document.querySelector('.section-body .ProseMirror').editor; ed.commands.setContent(doc, true); }""", sample)
    page.wait_for_timeout(300)
    if page.locator(".section-body h2").count() == 0:
        # no editor handle on the DOM: type the pieces instead
        page.locator(".section-body .rich").first.click()
        page.keyboard.type("Secret paragraph text")
    page.locator(".section-heading").first.fill("Basics")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    menu(page, "Save as template")
    page.wait_for_selector("#tpl-save")
    check(page.locator("#tpl-name").input_value() == "Polity sheet", "the name starts as the note's title")
    page.fill("#tpl-name", "My polity sheet")
    page.click("#tpl-save-go")
    page.wait_for_timeout(400)
    saved = page.evaluate(META, "templates")
    check(saved and len(saved) == 1 and saved[0]["id"].startswith("my:") and saved[0]["name"] == "My polity sheet", f"saved in meta 'templates' ({saved and [t['name'] for t in saved]})")
    blob = json.dumps(saved)
    check("Secret" not in blob, "it keeps none of his writing")
    tdoc = saved[0]["sections"][0]["doc"]["content"]
    ttypes = [b["type"] for b in tdoc]
    check(saved[0]["sections"][0]["heading"] == "Basics", "it keeps the section titles")
    if "heading" in ttypes:
        h2 = tdoc[ttypes.index("heading")]
        check(h2["attrs"]["look"]["style"] == "pill" and h2["content"][0]["text"] == "Key idea", "it keeps headings with their looks")
        check("callout" in ttypes and "panel" in ttypes and "table" in ttypes, f"it keeps callouts, containers and tables ({ttypes})")
        check("chart" not in ttypes and "bulletList" not in ttypes, "it drops figures and lists")
        tb = tdoc[ttypes.index("table")]
        check(json.dumps(tb).count("Article") == 1 and tb["attrs"]["tstyle"] == "banded", "the table keeps its header row and style, the cells go")
        pn = tdoc[ttypes.index("panel")]
        check(pn["attrs"]["title"] == "Remember" and pn["attrs"]["icon"] == "star", "a container keeps its title and look")
    else:
        check(False, f"sample doc not loaded into the editor ({ttypes})")

    # My templates on New note
    page.goto(URL + "#/n/new")
    page.wait_for_selector("#my-templates .tpl-card")
    mine = page.locator("#my-templates .tpl-card")
    check(mine.count() == 1 and "My polity sheet" in mine.text_content(), "My templates shows it")
    mine.click()
    page.wait_for_selector("#f-title")
    page.wait_for_timeout(300)
    check(headings(page) == ["Basics"] and page.locator(".section-body table th").count() == 2 and page.locator(".section-body .panel").count() == 1, "a note from it gets the sections, table and container")
    check(page.locator("#f-template").input_value().startswith("my:") and page.locator("#f-template optgroup[label='My templates']").count() == 1, "the chip names it under My templates")
    # rename and delete
    page.goto(URL + "#/n/new")
    page.wait_for_selector("#my-templates .tpl-menu")
    page.click("#my-templates .tpl-menu")
    page.click(".popover button:has-text('Rename')")
    page.fill("#tpl-name", "Polity one-pager")
    page.click("#tpl-rename button.primary")
    page.wait_for_timeout(300)
    check("Polity one-pager" in page.locator("#my-templates").text_content(), "rename shows at once")
    # a second one to delete
    page.goto(URL + "#/n/new/topic-sheet")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Temp sheet")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    menu(page, "Save as template")
    page.click("#tpl-save-go")
    page.wait_for_timeout(300)
    page.goto(URL + "#/n/new")
    page.wait_for_selector("#my-templates .tpl-card")
    check(page.locator("#my-templates .tpl-card").count() == 2, "two of his templates")
    page.locator("#my-templates .tpl-menu").nth(1).click()
    page.click(".popover button:has-text('Delete')")
    page.wait_for_selector("#tpl-delete")
    page.click("#tpl-delete button.danger-btn")
    page.wait_for_timeout(300)
    check(page.locator("#my-templates .tpl-card").count() == 1, "delete (after asking) takes it off the list")
    meta = page.evaluate(META, "templates")
    check(len(meta) == 2 and sum(1 for t in meta if t["deletedAt"]) == 1, "the deleted one stays as a small record")
    temp = page.evaluate(NOTE, "Temp sheet")
    check(temp is not None and not temp["deletedAt"], "the note it came from is untouched")

    # ================= backup format 8 =================
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    bpath = OUT / "templates-backup.json"
    dl.value.save_as(bpath)
    bk = json.loads(bpath.read_text())
    check(bk["format"] == 8 and len(bk["templates"]) == 2 and "looks" in bk, f"backup format 8 carries the templates and looks ({bk['format']})")
    fresh = browser.new_context(viewport={"width": 1280, "height": 800})
    fp = fresh.new_page()
    fp.on("pageerror", lambda e: errors.append(str(e)))
    fp.goto(URL + "#/settings")
    fp.wait_for_selector("#import-file", state="attached")
    fp.set_input_files("#import-file", str(bpath))
    expect(fp.locator(".import-result")).to_contain_text("2 templates", timeout=5000)
    fp.set_input_files("#import-file", str(bpath))
    expect(fp.locator(".import-result")).to_contain_text("0 added", timeout=5000)
    check("template" not in fp.locator(".import-result").text_content(), "importing twice adds no template")
    fp.goto(URL + "#/n/new")
    fp.wait_for_selector("#my-templates .tpl-card")
    check(fp.locator("#my-templates .tpl-card").count() == 1 and "Polity one-pager" in fp.locator("#my-templates").text_content(), "a fresh tablet gets his template (the deleted one stays deleted)")
    fresh.close()

    # ================= phone =================
    ph = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    pp = ph.new_page()
    pp.on("pageerror", lambda e: errors.append(str(e)))
    pp.goto(URL + "#/n/new")
    pp.wait_for_selector(".tpl-card")
    wide = pp.evaluate("document.documentElement.scrollWidth")
    check(wide <= 390, f"phone: the gallery fits ({wide}px)")
    pp.screenshot(path=str(OUT / "gallery-phone.png"), full_page=True)
    ph.close()

    # reduced motion: the tile press has no animation
    rm = browser.new_context(viewport={"width": 1280, "height": 800}, reduced_motion="reduce")
    rp = rm.new_page()
    rp.goto(URL + "#/n/new")
    rp.wait_for_selector(".tpl-card")
    tr = rp.locator(".tpl-card").first.evaluate("e => getComputedStyle(e).transitionDuration")
    check(all(float(x.strip().rstrip("s") or 0) == 0 for x in tr.split(",")), f"reduced motion: no tile animation ({tr})")
    rm.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
