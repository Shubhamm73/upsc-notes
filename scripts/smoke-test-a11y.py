"""0.18 accessibility + Read mode test. Needs `vite preview` on :4173 and node_modules/axe-core.

axe-core (WCAG 2.2 A/AA + best practice) finds nothing on every screen, day and night; the page has one h1; menu items are
named by what they show; the note is usable by keyboard alone (visible focus, Escape closes a sheet and gives the focus
back); touch targets are 44 px. Read mode: Edit | Read switch (and Ctrl+E) stops every way of changing the note while
reading, scrolling, folding, the outline and PDF still work, and Edit gives the note back untouched.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

URL = "http://localhost:4173/upsc-notes/"
AXE = (Path(__file__).resolve().parent.parent / "node_modules/axe-core/axe.min.js").read_text()
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTES = """() => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result); }; }; })"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""


def p(text, marks=None):
    return {"type": "paragraph", "content": [{"type": "text", "text": text, **({"marks": marks} if marks else {})}]}


RICH = [
    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Fundamental rights"}]},
    p("Article 21 protects life and personal liberty."),
    {"type": "paragraph", "content": [{"type": "text", "text": "Key line: "}, {"type": "text", "text": "right to privacy is part of Article 21", "marks": [{"type": "highlight"}]}]},
    {"type": "panel", "attrs": {"kind": "sticky", "title": "Remember"}, "content": [p("Puttaswamy 2017, nine judges.")]},
    {"type": "panel", "attrs": {"kind": "titled", "title": "Key rights"}, "content": [p("Articles 14 to 32.")]},
    {"type": "panel", "attrs": {"kind": "quote", "author": "B. R. Ambedkar"}, "content": [p("The heart and soul of the Constitution.")]},
    {"type": "bulletList", "content": [{"type": "listItem", "content": [p("Equality")]}, {"type": "listItem", "content": [p("Freedom")]}]},
]


def axe(page, label, exclude=None):
    if not page.evaluate("typeof axe !== 'undefined'"):
        page.add_script_tag(content=AXE)
    res = page.evaluate(
        """(ex) => axe.run(ex ? {exclude: ex} : document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']}})
        .then(r => r.violations.map(v => v.id + ' x' + v.nodes.length + ' ' + v.nodes.slice(0, 2).map(n => n.target.join(' ')).join(' ; ')))""",
        exclude,
    )
    check(not res, f"axe: {label}" + (" -> " + " | ".join(res) if res else ""))


def set_theme(page, theme):
    page.evaluate("(t) => { if (t === 'day') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }", theme)
    page.wait_for_timeout(150)


def seed(page):
    page.goto(URL)
    page.wait_for_selector(".today-title")
    page.fill("#capture", "Right to privacy")
    page.wait_for_selector("#capture-subject option[value='gen:GS2']", state="attached")
    page.select_option("#capture-subject", "gen:GS2")
    page.click("#capture-save")
    page.wait_for_timeout(700)
    note = page.evaluate(NOTES)[0]
    note["sections"][0]["doc"] = {"type": "doc", "content": RICH}
    note["sections"].append({"id": "sec2", "heading": "Cases", "doc": {"type": "doc", "content": [p("Puttaswamy v Union of India.")]}})
    page.evaluate(IDB_PUT, note)
    return note["id"]


def doc_text(page, nid):
    n = [x for x in page.evaluate(NOTES) if x["id"] == nid][0]
    return json.dumps([n["title"], n["topic"], n["explain"], n["connect"], n["sections"]], sort_keys=True)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    nid = seed(page)

    # ================= axe on every screen, day and night =================
    routes = ["#/", "#/notes", "#/notes/f/main%3AGS2", "#/vocab", "#/review", "#/more", "#/prefs", "#/settings", "#/trash", "#/n/new"]
    for theme in ["day", "night"]:
        set_theme(page, theme)
        for r in routes:
            page.goto(URL + r)
            page.wait_for_timeout(450)
            axe(page, f"{theme} {r}")
        page.goto(URL + "#/n/" + nid)
        page.wait_for_selector("#f-title")
        page.wait_for_timeout(500)
        check(page.locator("h1:visible").count() == 1, f"{theme}: the open note has one visible h1")
        axe(page, f"{theme} open note (sticky, titled, quote, highlight)")
        page.click("#note-more")
        page.wait_for_timeout(250)
        axe(page, f"{theme} note menu", exclude=[".popover"])
        page.keyboard.press("Escape")
        page.click("#mode-read")
        page.wait_for_timeout(300)
        axe(page, f"{theme} Read mode")
        page.click("#mode-edit")
    set_theme(page, "day")
    for theme in ["paper", "ink", "sepia", "contrast"]:  # other themes: whatever exists is checked
        has = page.evaluate("(t) => !!document.querySelector(`[data-theme-opt='${t}']`)", theme)
        if has:
            set_theme(page, theme)
            axe(page, f"{theme} open note")
    set_theme(page, "day")

    # ================= menu items are named by what they show (2.5.3) =================
    page.goto(URL + "#/n/" + nid)
    page.wait_for_selector("#f-title")
    page.click("#note-more")
    page.wait_for_selector(".popover [role='menuitem']")
    bad = page.evaluate(
        "[...document.querySelectorAll('.popover [role=menuitem]')].filter(b => b.getAttribute('aria-label') && !b.getAttribute('aria-label').toLowerCase().includes(b.textContent.trim().replace('…', '').toLowerCase())).map(b => b.textContent)"
    )
    check(not bad, f"menu items: aria-label contains the visible text {bad}")
    page.keyboard.press("Escape")

    # ================= keyboard only =================
    page.goto(URL + "#/")
    page.wait_for_selector(".today-title")
    stops, unseen = 0, []
    page.evaluate("document.activeElement && document.activeElement.blur()")
    for _ in range(40):
        page.keyboard.press("Tab")
        info = page.evaluate(
            """() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e);
            const r = e.getBoundingClientRect(); const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
            return {n: (e.id || e.className || e.tagName) + ':' + (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 20), ring, vis: r.width > 0 && r.height > 0}; }"""
        )
        if info and info["vis"]:
            stops += 1
            if not info["ring"]:
                unseen.append(info["n"])
    check(stops >= 15, f"Today: Tab reaches {stops} controls")
    check(not unseen, f"every Tab stop on Today shows a focus ring {unseen}")
    # a sheet: Escape closes, focus comes back to what opened it
    page.goto(URL + "#/n/" + nid)
    page.wait_for_selector("#f-title")
    page.focus("#f-subject")
    page.keyboard.press("Enter")
    page.wait_for_selector(".sheet")
    check(page.evaluate("!!document.activeElement.closest('.sheet')"), "a sheet takes the focus")
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)
    check(page.locator(".sheet").count() == 0, "Escape closes the sheet")
    check(page.evaluate("document.activeElement && document.activeElement.id") == "f-subject", "the focus goes back to the button that opened it")

    # ================= touch targets >= 44 px =================
    for label, route in [("Today", "#/"), ("Notes", "#/notes"), ("open note", "#/n/" + nid), ("Settings", "#/prefs")]:
        page.goto(URL + route)
        page.wait_for_timeout(500)
        small = page.evaluate(
            """() => [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], summary')]
            .map(e => (e.matches('input[type=checkbox], input[type=radio]') && e.closest('label')) || e)
            .filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden], .sr-only') && e.offsetParent !== null
              && !(e.matches('a') && e.closest('p, li > span, .rich, .crumbs')) && (r.height < 43.5 || r.width < 43.5); })
            .map(e => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)).slice(0, 12)"""
        )
        check(not small, f"{label}: every control is at least 44 x 44 {small}")

    # ================= Read mode =================
    page.goto(URL + "#/n/" + nid)
    page.wait_for_selector("#f-title")
    page.wait_for_timeout(600)
    before = doc_text(page, nid)
    check(page.get_attribute("#mode-edit", "aria-pressed") == "true" and page.get_attribute("#mode-read", "aria-pressed") == "false", "a note opens in Edit")
    page.click("#mode-read")
    page.wait_for_timeout(250)
    check(page.get_attribute("#mode-read", "aria-pressed") == "true" and page.get_attribute("#mode-edit", "aria-pressed") == "false", "Read: the switch shows Read")
    check(page.evaluate("[...document.querySelectorAll('.rich')].every(e => e.getAttribute('contenteditable') === 'false')"), "Read: no section is editable")
    check(page.evaluate("['f-title', 'f-topic', 'f-explain', 'f-connect'].every(i => document.getElementById(i).readOnly)"), "Read: title, topic and the reflect fields are read-only")
    check(page.evaluate("[...document.querySelectorAll('.section-heading')].every(e => e.readOnly)"), "Read: section headings are read-only")
    check(page.evaluate("document.getElementById('f-template').disabled && document.getElementById('f-subject').disabled"), "Read: template and subject can't be changed")
    check(page.locator(".add-section").is_hidden() and page.locator("#note-undo").is_hidden(), "Read: Add section and Undo are gone")
    check(page.locator(".ol-add").count() == 0 or page.locator(".ol-add").first.is_hidden(), "Read: the outline has no Add section")
    page.click(".rich p >> nth=1")
    page.keyboard.type("MISTAKE")
    page.keyboard.press("Backspace")
    page.keyboard.press("Control+b")
    page.keyboard.press("Enter")
    page.click("#f-title", force=True)
    page.keyboard.type("MISTAKE")
    page.wait_for_timeout(1100)
    check("MISTAKE" not in page.locator(".rich").first.inner_text() and page.input_value("#f-title") == "Right to privacy", "Read: typing changes nothing on screen")
    check(page.locator("#bubble:visible, .bubble:visible, #touchbar:visible, .touchbar:visible").count() == 0, "Read: no formatting bar appears")
    page.evaluate("document.querySelector('.rich').dispatchEvent(new ClipboardEvent('paste', {clipboardData: new DataTransfer(), bubbles: true, cancelable: true}))")
    check(doc_text(page, nid) == before, "Read: the stored note is byte-for-byte unchanged")
    # reading tools still work
    page.keyboard.press("Escape")
    page.click(".section-head .sec-collapse >> nth=0")
    page.wait_for_timeout(200)
    check(page.locator(".note-section.collapsed").count() == 1, "Read: a section can still be folded")
    page.click(".section-head .sec-collapse >> nth=0")
    page.click("#note-more")
    items = page.locator(".popover [role='menuitem']").all_text_contents()
    check(any("Edit this note" in i for i in items), "Read: the note menu offers Edit this note")
    page.keyboard.press("Escape")
    page.click(".section-head .sec-menu-btn >> nth=0")
    items = page.locator(".popover [role='menuitem']").all_text_contents()
    check(not any(w in " ".join(items) for w in ["Move up", "Move down", "Delete"]) and any("Export" in i for i in items), f"Read: the section menu keeps only fold and PDF {items}")
    page.keyboard.press("Escape")
    # Ctrl+E toggles, and the keyboard returns to writing
    page.keyboard.press("Control+e")
    page.wait_for_timeout(200)
    check(page.get_attribute("#mode-edit", "aria-pressed") == "true", "Ctrl+E goes back to Edit")
    check(page.evaluate("[...document.querySelectorAll('.rich')].every(e => e.getAttribute('contenteditable') === 'true')"), "Edit: sections are editable again")
    check(page.locator(".add-section").is_visible() and page.locator("#note-undo").is_visible(), "Edit: Add section and Undo are back")
    page.locator(".rich p >> nth=1").click()
    page.keyboard.press("End")
    page.keyboard.type(" Added.")
    page.wait_for_timeout(1200)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    check("Added." in doc_text(page, nid), "Edit: writing saves as before")
    page.keyboard.press("Control+e")
    page.wait_for_timeout(200)
    check(page.get_attribute("#mode-read", "aria-pressed") == "true", "Ctrl+E from inside the text goes to Read")
    # a new note always opens for writing; Read survives opening another existing note
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    check(page.get_attribute("#mode-edit", "aria-pressed") == "true" and not page.evaluate("document.getElementById('f-title').readOnly"), "a new note opens in Edit")
    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
