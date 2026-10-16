"""0.12 smoke test: heading looks, containers, callout style, My styles. Needs `vite preview` on :4173.

Headings: Style opens a panel beside the note with 12 looks, Subject + 13 colours, fill, corners, icon,
width and alignment, each tap one Undo step; the level popover (H2/H3/H4/Normal text) keeps the look;
Save as my style keeps it for every note (meta 'styles', backup format 6, "/" finds it by name); Same as
last repeats the last look; Plain heading takes it off. Containers: select lines, Put in container (the
floating toolbar) → soft / titled / sticky / framed / quote / two columns round them, one Undo step;
title, icon, fill, author; two columns side by side on the tablet and stacked on a phone; Remove
container keeps everything in place; callouts can't take a heading. A callout gets fill and corners.
PDF prints the looks (numbers, split label, titles, authors). A note from before 0.12 opens untouched.
"""
import json
import re
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
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""


def content(page, title):
    return page.evaluate(NOTE, title)["sections"][0]["doc"]["content"]


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def slash(page, query):
    page.keyboard.type("/" + query)
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")


def undo(page):
    page.click("#note-undo")
    page.wait_for_timeout(200)


def redo(page):
    page.click("#note-redo")
    page.wait_for_timeout(200)


def caret_end(page, text):
    page.wait_for_timeout(150)
    page.evaluate("""(t) => {
        const root = document.querySelector('.section-body .ProseMirror');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) if (n.textContent.includes(t)) break;
        const r = document.createRange(); r.setStart(n, n.length); r.collapse(true);
        getSelection().removeAllRanges(); getSelection().addRange(r);
    }""", text)
    page.wait_for_timeout(200)


def select_span(page, a, b):
    """Selects from the start of text a to the end of text b (lines in between too)."""
    page.wait_for_timeout(150)
    page.evaluate("""([a, b]) => {
        const root = document.querySelector('.section-body .ProseMirror');
        const find = (t) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
          while ((n = w.nextNode())) if (n.textContent.includes(t)) return n; throw new Error('not found ' + t); };
        const s = find(a), e = find(b);
        const r = document.createRange(); r.setStart(s, s.textContent.indexOf(a)); r.setEnd(e, e.textContent.indexOf(b) + b.length);
        getSelection().removeAllRanges(); getSelection().addRange(r);
    }""", [a, b])
    page.wait_for_timeout(300)


def css(loc, prop, pseudo=None):
    return loc.evaluate(f"(e) => getComputedStyle(e, {json.dumps(pseudo)}).getPropertyValue({json.dumps(prop)})")


def colour_of(page, var):
    return page.evaluate(f"() => {{ const d = document.createElement('div'); d.style.color = 'var({var})'; document.querySelector('.canvas-col').append(d); const c = getComputedStyle(d).color; d.remove(); return c; }}")


def put_in_container(page, a, b, kind):
    select_span(page, a, b)
    page.click("button[aria-label='Put in container']")
    page.wait_for_selector("#container-sheet")
    page.click(f".ct-opt[data-container='{kind}']")
    page.wait_for_timeout(300)


def save_pdf(page, name):
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / name
    dl.value.save_as(pdf)
    page.click("#details summary")
    return pdf


def pdf_words(pdf):
    html = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], capture_output=True, text=True).stdout
    return [(m.group(3), float(m.group(1)), float(m.group(2))) for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)</word>', html)]


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # a note from before 0.12: a plain heading and a callout, no looks
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    old = {"id": "old-looks", "title": "Old headings", "subject": "GS2", "topic": "", "template": "blank", "explain": "", "connect": "",
           "createdAt": 1700000000000, "updatedAt": 1700000000000, "deletedAt": None, "folderId": "gen:GS2",
           "sections": [{"id": "s-o", "heading": "Notes", "doc": {"type": "doc", "content": [
               {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Preamble"}]},
               {"type": "callout", "attrs": {"kind": "case"}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Kesavananda Bharati"}]}]},
               {"type": "paragraph", "content": [{"type": "text", "text": "Basic structure"}]}]}}]}
    page.evaluate(IDB_PUT, old)
    page.goto(URL + "#/n/old-looks")
    page.wait_for_selector(".section-body h2")
    page.wait_for_timeout(1500)
    check(page.locator(".section-body h2[data-look]").count() == 0 and page.locator(".section-body aside.callout[data-fill]").count() == 0, "a note from before 0.12: plain heading, callout as it was")
    after = page.evaluate(NOTE, "Old headings")
    check(after["updatedAt"] == old["updatedAt"] and after["sections"][0]["doc"] == old["sections"][0]["doc"], "opening it rewrites nothing")

    # ================= heading looks =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Heading looks")
    page.click("#f-subject")
    page.click("#move-sheet [data-folder='gen:GS2']")
    page.locator(".section-body .rich").first.click()
    slash(page, "heading")
    page.keyboard.type("Fundamental Rights")
    page.keyboard.press("Enter")
    page.keyboard.type("Part III of the Constitution.")
    page.wait_for_timeout(600)
    caret_end(page, "Fundamental Rights")
    check(page.locator("#ctxbar .tb-heading").is_visible(), "a heading gets the Heading bar")
    check(page.locator("#heading-level").text_content().startswith("H2"), "the level button says H2")
    page.click("#heading-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    lp = page.locator("#look-panel").bounding_box()
    check(lp["x"] > 1280 - 400 and lp["width"] <= 372, f"Style opens a panel at the right of the note ({lp['x']:.0f}, {lp['width']:.0f}px)")
    check(page.locator("#look-grid .lp-tile").count() == 12, "12 looks")
    check(page.locator("#look-colours .swatch").count() == 14, "Subject + 13 colours")
    check(page.locator("#look-save").is_disabled() and page.locator("#look-plain").is_disabled(), "a plain heading: nothing to save or take off yet")
    h2 = page.locator(".section-body h2").first
    for s in ["underline", "marker", "pill", "banner", "card", "tab", "numbered", "boxed", "brackets", "split", "sticky", "plain"]:
        page.click(f"#look-grid [data-style='{s}']")
        page.wait_for_timeout(60)
        if s == "plain":  # Plain with no colour or icon is simply a plain heading: no look stored
            check(h2.get_attribute("data-look") is None, "look plain (no colour): back to a plain heading")
        else:
            check(h2.get_attribute("data-look") == s and page.locator(f"#look-grid [data-style='{s}']").get_attribute("aria-pressed") == "true", f"look {s}")
    check(h2.text_content() == "Fundamental Rights", "the words stay the words (no number, label or icon in the text)")
    # one Undo per tap, however quick
    page.click("#look-grid [data-style='pill']")
    page.click("#look-grid [data-style='banner']")
    undo(page)
    check(h2.get_attribute("data-look") == "pill", f"one Undo per tap: banner → pill ({h2.get_attribute('data-look')})")
    redo(page)
    check(h2.get_attribute("data-look") == "banner", "Redo: banner again")
    page.click("#look-grid [data-style='pill']")
    # colour, fill, corners, icon, width, alignment
    page.click("#look-colours [data-colour='interview']")
    page.wait_for_timeout(100)
    rose = colour_of(page, "--sub-interview")
    txt = h2.locator(".h-text")
    check(h2.get_attribute("data-color") == "interview", "colour Rose")
    page.click("#look-fill [data-v='solid']")
    page.wait_for_timeout(100)
    check(css(txt, "background-color") == rose and css(txt, "color") == "rgb(255, 255, 255)", f"Solid: the pill is the colour, words in white ({css(txt, 'background-color')}, {css(txt, 'color')})")
    page.click("#look-corner [data-v='square']")
    page.wait_for_timeout(100)
    check(css(txt, "border-top-left-radius") == "2px", f"Square corners ({css(txt, 'border-top-left-radius')})")
    page.click("#look-icon [aria-label='Star']")
    page.wait_for_timeout(100)
    mask = css(h2, "mask-image", "::after") or css(h2, "-webkit-mask-image", "::after")
    check(h2.get_attribute("data-icon") == "star" and "svg" in mask and h2.text_content() == "Fundamental Rights", "Star icon drawn before the words, not in the text")
    page.click("#look-width [data-v='full']")
    page.wait_for_timeout(100)
    check(txt.bounding_box()["width"] > h2.bounding_box()["width"] * 0.8, "Full line: the pill runs across")
    page.click("#look-align [data-v='center']")
    page.wait_for_timeout(100)
    check(css(h2, "justify-content") == "center", "Centre")
    saved(page)
    hd = content(page, "Heading looks")[0]
    check(hd["attrs"].get("look") == {"style": "pill", "color": "interview", "fill": "solid", "corner": "square", "icon": "star", "width": "full", "align": "center"}, f"stored look ({hd['attrs'].get('look')})")
    # the level popover keeps the look
    page.click("#look-done")
    caret_end(page, "Fundamental Rights")
    page.click("#heading-level")
    page.click("[role='menuitem'][aria-label='H3']")
    page.wait_for_timeout(200)
    h3 = page.locator(".section-body h3").first
    check(h3.count() == 1 and h3.get_attribute("data-look") == "pill" and h3.get_attribute("data-icon") == "star", "H3 from the level popover keeps the look")
    saved(page)
    check(content(page, "Heading looks")[0]["attrs"]["level"] == 3, "stored level 3")
    caret_end(page, "Fundamental Rights")
    page.click("#heading-level")
    page.click("[role='menuitem'][aria-label='H2']")
    page.wait_for_timeout(200)
    # Save as my style
    caret_end(page, "Fundamental Rights")
    page.click("#heading-save")
    page.wait_for_selector("#save-style")
    check(page.locator("#style-name").input_value() == "My style 1", "the name box offers My style 1")
    page.fill("#style-name", "Polity pill")
    page.click("#style-save")
    page.wait_for_timeout(400)
    st = page.evaluate(META, "styles")
    check(st and len(st) == 1 and st[0]["kind"] == "heading" and st[0]["name"] == "Polity pill" and st[0]["look"]["style"] == "pill", f"saved in meta 'styles' ({st})")
    # Same as last on a new heading
    caret_end(page, "Part III of the Constitution.")
    page.keyboard.press("Enter")
    slash(page, "heading")
    page.keyboard.type("Directive Principles")
    page.wait_for_timeout(200)
    page.click("#heading-same")
    page.wait_for_timeout(200)
    h2b = page.locator(".section-body h2:has-text('Directive Principles')")
    check(h2b.get_attribute("data-look") == "pill" and h2b.get_attribute("data-color") == "interview" and h2b.get_attribute("data-align") == "center", "Same as last: one tap repeats the look")
    # numbered + split
    page.click("#heading-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    page.click("#look-grid [data-style='numbered']")
    page.click("#look-done")
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type("Not enforceable by courts.")
    page.keyboard.press("Enter")
    slash(page, "heading")
    page.keyboard.type("Fundamental Duties")
    page.click("#heading-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    page.click("#look-grid [data-style='split']")
    page.wait_for_timeout(100)
    hs = page.locator(".section-body h2:has-text('Fundamental Duties')")
    name = page.locator(".canvas-col").evaluate("e => getComputedStyle(e).getPropertyValue('--subj-name').trim()")
    label = css(hs, "content", "::before")
    check(name and label == name and "GS" in label, f"Split shows the subject label before the words ({label})")
    # "/" finds the saved style by name
    page.click("#look-done")
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type("Article 51A")
    page.keyboard.press("Enter")
    page.keyboard.type("/polity")
    page.wait_for_selector("#insert-menu:not([hidden])")
    first = page.locator("#insert-menu [role='option']").first.text_content() if page.locator("#insert-menu [role='option']").count() else page.locator("#insert-menu button").first.text_content()
    check("Polity pill" in first, f"/polity offers My style Polity pill ({first})")
    page.keyboard.press("Enter")
    page.keyboard.type("Emergency provisions")
    page.wait_for_timeout(200)
    he = page.locator(".section-body h2:has-text('Emergency provisions')")
    check(he.count() == 1 and he.get_attribute("data-look") == "pill" and he.get_attribute("data-color") == "interview", "picking it makes a heading in that look")
    # Plain heading
    page.click("#heading-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    page.click("#look-plain")
    page.wait_for_timeout(200)
    check(he.get_attribute("data-look") is None, "Plain heading takes the look off")
    page.click("#look-done")
    saved(page)
    em = next(n for n in content(page, "Heading looks") if n["type"] == "heading" and n["content"][0]["text"] == "Emergency provisions")
    check("look" not in em["attrs"], f"a plain heading stores no look ({em['attrs']})")
    # night: solid on-colour text turns dark
    page.evaluate("() => document.documentElement.setAttribute('data-theme', 'night')")
    check(css(txt, "color") == "rgb(16, 22, 27)", f"night: words on the colour are dark ({css(txt, 'color')})")
    page.evaluate("() => document.documentElement.removeAttribute('data-theme')")
    # PDF
    pdf = save_pdf(page, "headings.pdf")
    ws = pdf_words(pdf)
    names = [w[0] for w in ws]
    check("Fundamental" in names and "Directive" in names and "Duties" in names, "PDF: the headings print")
    di = next(w for w in ws if w[0] == "Directive")
    check(any(w[0] == "1" and abs(w[2] - di[2]) < 6 and w[1] < di[1] for w in ws), "PDF: the Numbered heading has its number")
    du = next(w for w in ws if w[0] == "Duties")
    check(any(w[0].startswith("GS") and abs(w[2] - du[2]) < 8 and w[1] < du[1] for w in ws), "PDF: the Split heading has its subject label")
    page.screenshot(path=str(OUT / "headings.png"))

    # ================= containers =================
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Containers")
    page.locator(".section-body .rich").first.click()
    for t in ["Article 14 equality", "Article 19 freedoms", "Article 21 life", "Article 32 remedies"]:
        page.keyboard.type(t)
        page.keyboard.press("Enter")
    page.keyboard.type("After the box.")
    page.wait_for_timeout(700)
    put_in_container(page, "Article 14", "Article 32 remedies", "titled")
    panel = page.locator(".section-body .panel")
    check(panel.count() == 1 and panel.get_attribute("data-panel") == "titled" and panel.locator("p").count() == 4, "Put in container → Titled panel round the four lines")
    saved(page)
    top = content(page, "Containers")
    check(top[0]["type"] == "panel" and top[0]["attrs"]["kind"] == "titled" and len(top[0]["content"]) == 4 and top[1]["content"][0]["text"] == "After the box.", "stored: a panel holding the four paragraphs, the next line outside")
    undo(page)
    check(panel.count() == 0 and page.locator(".section-body .ProseMirror > p").count() == 5, "one Undo takes the container off, lines in place")
    redo(page)
    check(panel.count() == 1, "Redo puts it back")
    caret_end(page, "Article 19 freedoms")
    check(page.locator("#ctxbar .tb-panel").is_visible(), "the caret in a container shows the Container bar")
    page.click("#panel-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    check(page.locator("#panel-kinds .lp-tile").count() == 6, "six containers")
    page.fill("#panel-title", "Key rights")
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    check(panel.locator(".panel-head").text_content() == "Key rights", "the title shows in the strip")
    page.click("#panel-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    page.click("#look-icon [aria-label='Flag']")
    page.click("#look-fill [data-v='medium']")
    page.click("#look-colours [data-colour='cyan']")
    page.wait_for_timeout(200)
    check(panel.locator(".panel-head svg").count() == 1 and panel.get_attribute("data-fill") == "medium", "Flag icon in the strip, Medium fill")
    saved(page)
    a = content(page, "Containers")[0]["attrs"]
    check(a.get("title") == "Key rights" and a.get("icon") == "flag" and a.get("fill") == "medium" and a.get("color") == "cyan", f"stored title, icon, fill, colour ({a})")
    undo(page)
    check("cyan" not in (panel.get_attribute("style") or ""), "one Undo per change (colour)")
    redo(page)
    page.click("#look-done")
    # a tap on the strip opens Style at the title
    panel.locator(".panel-head").click()
    page.wait_for_selector("#look-panel:not([hidden])")
    check(page.evaluate("document.activeElement.id") == "panel-title", "a tap on the title strip opens Style with the title box ready")
    page.click("#look-done")
    # two columns
    caret_end(page, "Article 19 freedoms")
    page.click("#panel-style")
    page.click("#panel-kinds [data-kind='columns']")
    page.wait_for_timeout(300)
    cols = panel.locator(".panel-col")
    check(cols.count() == 2 and cols.nth(0).locator("p").count() == 2 and cols.nth(1).locator("p").count() == 2, "Two columns: the lines split 2 and 2")
    b0, b1 = cols.nth(0).bounding_box(), cols.nth(1).bounding_box()
    check(abs(b0["y"] - b1["y"]) < 4 and b1["x"] > b0["x"] + b0["width"] - 2, "side by side at 1280")
    saved(page)
    c = content(page, "Containers")[0]
    check([k["type"] for k in c["content"]] == ["panelColumn", "panelColumn"], "stored as two panelColumn children")
    page.click("#look-done")
    page.screenshot(path=str(OUT / "columns.png"))
    # back to one box: the lines in reading order
    caret_end(page, "Article 19 freedoms")
    page.click("#panel-style")
    page.click("#panel-kinds [data-kind='sticky']")
    page.wait_for_timeout(300)
    check(panel.locator(".panel-col").count() == 0 and [t.strip() for t in panel.locator("p").all_text_contents()] == ["Article 14 equality", "Article 19 freedoms", "Article 21 life", "Article 32 remedies"], "Sticky note: one box again, lines in order")
    page.click("#panel-kinds [data-kind='framed']")
    page.wait_for_timeout(200)
    check(panel.get_attribute("data-panel") == "framed" and panel.locator(".panel-head").is_hidden(), "Framed: no title strip")
    page.click("#panel-kinds [data-kind='quote']")
    page.wait_for_timeout(200)
    page.fill("#panel-author", "B. R. Ambedkar")
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    check(panel.locator(".panel-foot").text_content() == "— B. R. Ambedkar", "Quote: the author line")
    # Save the container look; it shows in Put in container
    caret_end(page, "Article 21 life")
    page.click("#panel-style")
    page.click("#look-save")
    page.fill("#style-name", "Rights quote")
    page.click("#style-save")
    page.wait_for_timeout(300)
    page.click("#look-done")
    caret_end(page, "After the box.")
    page.keyboard.press("Enter")
    page.keyboard.type("Second box line")
    select_span(page, "Second box", "Second box line")
    page.click("button[aria-label='Put in container']")
    page.wait_for_selector("#container-sheet")
    check(page.locator(".ct-opt[data-container='same-as-last']").count() == 1, "Put in container offers Same as last")
    mine = page.locator(".ct-opt[data-container^='mine-']")
    check(mine.count() == 1 and "Rights quote" in mine.text_content(), "and the saved container style")
    mine.click()
    page.wait_for_timeout(300)
    p2 = page.locator(".section-body .panel").nth(1)
    check(p2.get_attribute("data-panel") == "quote" and p2.locator(".panel-foot").text_content() == "— B. R. Ambedkar", "the saved style applies (quote, author)")
    # delete a saved style: two taps
    caret_end(page, "Second box line")
    page.click("#panel-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    page.click("#look-save")
    page.fill("#style-name", "Temp")
    page.click("#style-save")
    page.wait_for_timeout(300)
    dl = page.locator("#look-panel .my-style:has-text('Temp') .my-style-del")
    dl.click()
    check(dl.text_content() == "Delete?", "the first tap on × asks Delete?")
    dl.click()
    page.wait_for_timeout(300)
    check(page.locator("#look-panel .my-style:has-text('Temp')").count() == 0, "the second deletes it")
    st = page.evaluate(META, "styles")
    check(len(st) == 3 and next(s for s in st if s["name"] == "Temp")["deletedAt"], "a deleted style is kept as a tombstone")
    page.click("#look-done")
    # Remove container keeps everything
    caret_end(page, "Article 21 life")
    page.click("#panel-remove-bar")
    page.wait_for_timeout(300)
    saved(page)
    top = content(page, "Containers")
    check(top[0]["type"] == "paragraph" and [n["content"][0]["text"] for n in top[:4]] == ["Article 14 equality", "Article 19 freedoms", "Article 21 life", "Article 32 remedies"], "Remove container keeps the four lines in place")
    undo(page)
    check(page.locator(".section-body .panel").count() == 2, "Undo puts the container back")
    # callouts can't take a heading
    caret_end(page, "Second box line")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    slash(page, "heading")
    page.keyboard.type("Writs")
    page.keyboard.press("Enter")
    page.keyboard.type("Habeas corpus")
    select_span(page, "Writs", "Habeas corpus")
    page.click("button[aria-label='Put in container']")
    page.wait_for_selector("#container-sheet")
    co = page.locator(".ct-opt[data-container^='callout-']")
    check(co.count() >= 6 and all(co.nth(i).is_disabled() for i in range(co.count())) and page.locator(".ct-opt[data-container='soft']").is_enabled(), "with a heading in the lines: callouts greyed, containers still offered")
    page.click(".ct-opt[data-container='soft']")
    page.wait_for_timeout(300)
    check(page.locator(".section-body .panel h2:has-text('Writs')").count() == 1, "a container can hold a heading")
    # a callout's fill and corners
    caret_end(page, "Habeas corpus")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    slash(page, "article")
    page.keyboard.type("Article 32 is the heart and soul")
    page.wait_for_timeout(200)
    page.click("#callout-style")
    page.wait_for_selector("#look-panel:not([hidden])")
    page.click("#look-fill [data-v='solid']")
    page.click("#look-corner [data-v='square']")
    page.wait_for_timeout(200)
    call = page.locator(".section-body aside.callout")
    check(call.get_attribute("data-fill") == "solid" and call.get_attribute("data-corner") == "square" and css(call, "border-top-left-radius") == "2px", "a callout takes Solid fill and Square corners")
    page.click("#look-done")
    saved(page)
    ca = json.loads(page.evaluate("(d) => JSON.stringify((function f(n) { return n.type === 'callout' ? n : (n.content || []).map(f).find(Boolean); })(d))", {"type": "doc", "content": content(page, "Containers")}))
    check(ca["attrs"].get("fill") == "solid" and ca["attrs"].get("corner") == "square", f"stored callout fill and corners ({ca['attrs']})")
    # PDF
    pdf = save_pdf(page, "containers.pdf")
    text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    check("Article 14 equality" in text and "B. R. Ambedkar" in text and "Writs" in text and "Article 32 is the heart" in text, "PDF: containers, author line, heading in a box and the callout print")
    # the tablet in portrait and a phone: two columns
    caret_end(page, "Article 19 freedoms")
    page.click("#panel-style")
    page.click("#panel-kinds [data-kind='columns']")
    page.click("#look-done")
    saved(page)
    nid = page.evaluate(NOTE, "Containers")["id"]
    for w, h, side in [(800, 1280, True), (390, 800, False)]:
        cx = browser.new_context(viewport={"width": w, "height": h}, has_touch=w < 500)
        pg = cx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(URL + "#/notes")
        pg.wait_for_selector("#new-note")
        rec = page.evaluate(NOTE, "Containers")
        pg.evaluate(IDB_PUT, rec)
        pg.goto(URL + "#/n/" + nid)
        pg.wait_for_selector(".section-body .panel-col")
        k0, k1 = pg.locator(".panel-col").nth(0).bounding_box(), pg.locator(".panel-col").nth(1).bounding_box()
        beside = abs(k0["y"] - k1["y"]) < 4
        check(beside == side, f"{w}px: two columns {'side by side' if side else 'stacked'} ({k0['y']:.0f}/{k1['y']:.0f})")
        pg.screenshot(path=str(OUT / f"columns-{w}.png"))
        if w < 500:
            # the Style panel is a sheet at the bottom on a phone
            pg.locator(".panel-col p").first.click()
            pg.wait_for_timeout(300)
            pg.click("#panel-style")
            pg.wait_for_selector("#look-panel:not([hidden])")
            pg.wait_for_timeout(350)  # it slides up (≤ 300 ms)
            bb = pg.locator("#look-panel").bounding_box()
            check(bb["width"] >= 388 and abs(bb["y"] + bb["height"] - 800) < 2, f"phone: Style is a sheet at the bottom ({bb})")
            sizes = pg.locator("#look-panel button:visible").evaluate_all("els => els.map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))")
            check(min(sizes) >= 40, f"phone: Style buttons are touch-sized (smallest {min(sizes):.0f}px)")
        cx.close()

    # ================= backup format 6 carries the saved styles =================
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    bpath = OUT / "looks-backup.json"
    dl.value.save_as(bpath)
    bk = json.loads(bpath.read_text())
    check(bk["format"] == 8 and sorted(s["name"] for s in bk["styles"]) == ["Polity pill", "Rights quote", "Temp"], f"backup format 8 carries the styles, the deleted one as a tombstone ({bk['format']}, {[s['name'] for s in bk.get('styles', [])]})")
    fresh = browser.new_context(viewport={"width": 1280, "height": 800})
    fp = fresh.new_page()
    fp.on("pageerror", lambda e: errors.append(str(e)))
    fp.goto(URL + "#/settings")
    fp.wait_for_selector("#import-file", state="attached")
    fp.set_input_files("#import-file", str(bpath))
    expect(fp.locator(".import-result")).to_contain_text("3 saved styles", timeout=5000)
    fst = fp.evaluate(META, "styles")
    check(len(fst) == 3 and sorted(s["name"] for s in fst if not s["deletedAt"]) == ["Polity pill", "Rights quote"], "a fresh tablet gets the saved styles (the deleted one stays deleted)")
    fp.set_input_files("#import-file", str(bpath))
    expect(fp.locator(".import-result")).to_contain_text("0 added", timeout=5000)
    check("saved style" not in fp.locator(".import-result").text_content(), "importing twice adds no style")
    fp.goto(URL + "#/n/new/blank")
    fp.wait_for_selector("#f-title")
    fp.locator(".section-body .rich").first.click()
    fp.keyboard.type("/rights")
    fp.wait_for_selector("#insert-menu:not([hidden])")
    check("Rights quote" in fp.locator("#insert-menu").text_content(), "and \"/\" finds them there")
    fresh.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
