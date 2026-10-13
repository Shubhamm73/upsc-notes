"""0.10 smoke test: folders for notes (main subject › subject › notes) and words (month › date › words).

Run against `npx vite preview --port 4173`. Covers: the 9 main subjects a tablet starts with, + add,
Edit mode (rename, red − delete, drag handle with a mouse, a real finger and the arrow keys), colours
inherited by subjects, breadcrumb and browser back going up one level, New note filed in the subject,
Move to… (one Undo step), Recent row, Ctrl+K and Continue writing opening a note in one tap,
deleting a folder (its notes go to Trash, restore brings the folder back, the last subject and Others
can't be deleted), words filed by day with Add word to today, manual months and dates, Move to another
date, old notes and words (no folder) shown in place without being rewritten, and backup format 4
(folders carried, import twice adds nothing, an old format-3 file gets the same folders as the upgrade).
"""
import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []
TODAY = date.today().isoformat()


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


ALL = """(store) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction(store).objectStore(store).getAll(); g.onsuccess = () => { q.result.close(); r(g.result); }; }; })"""
PUT = """([store, rec]) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction(store, 'readwrite'); tx.objectStore(store).put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""


def rows(page, store):
    return page.evaluate(ALL, store)


def by_id(page, store):
    return {r["id"]: r for r in rows(page, store)}


def folder_href(fid, words=False):
    return URL + ("#/vocab/f/" if words else "#/notes/f/") + quote(fid, safe="")


def card_ids(page):
    return page.eval_on_selector_all("#folder-grid .fcard[data-id]", "e => e.map(x => x.dataset.id)")


COLOUR = "([sel, v]) => getComputedStyle(document.querySelector(sel)).getPropertyValue('--c').trim() === getComputedStyle(document.documentElement).getPropertyValue(v).trim()"


def card_names(page):
    return page.eval_on_selector_all("#folder-grid .fcard[data-id] .fname", "e => e.map(x => x.textContent)")


def new_note(page, title, text="Some text."):
    page.click("#new-note")
    page.wait_for_selector(".tpl-card")
    page.click(".tpl-card[data-template='blank']")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", title)
    page.locator(".section-body .rich").first.click()
    page.keyboard.type(text)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def drag_mouse(page, src, dst):
    a = page.locator(src).bounding_box()
    b = page.locator(dst).bounding_box()
    page.mouse.move(a["x"] + a["width"] / 2, a["y"] + a["height"] / 2)
    page.mouse.down()
    for i in range(1, 13):
        page.mouse.move(a["x"] + (b["x"] + b["width"] / 2 - a["x"]) * i / 12, a["y"] + (b["y"] + b["height"] / 2 - a["y"]) * i / 12)
        page.wait_for_timeout(16)
    page.mouse.up()


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ================= a fresh tablet =================
    page.goto(URL + "#/notes")
    page.wait_for_selector("#folder-grid .fcard[data-id]")
    names = card_names(page)
    check(names == ["GS1", "GS2", "GS3", "GS4", "Essay", "Interview", "Current affairs", "PSIR", "Others"], f"9 main subjects, in order ({names})")
    folders = by_id(page, "folders")
    mains = [f for f in folders.values() if f["kind"] == "notes" and f["parent"] is None]
    check(len(mains) == 9 and all(folders.get("gen:" + m["id"][5:], {}).get("parent") == m["id"] for m in mains), "each main subject has one General (fixed ids main:X / gen:X)")
    check(page.evaluate(COLOUR, [".fcard[data-id='main:GS1']", "--sub-gs1"]), "GS1 keeps its ochre colour")
    check(page.locator("#crumbs").inner_text().strip() == "Notes" and page.locator("#search").is_visible(), "root: breadcrumb and search")

    # Edit mode at the top level: Others has no red −
    page.click("#folder-edit")
    check(page.locator(".fcard[data-id='main:Others'] .fdel").count() == 0 and page.locator(".fcard[data-id='main:GS1'] .fdel").count() == 1, "Others can't be deleted; other main subjects can")
    check(page.locator(".fcard[data-id='main:GS1'] .fgrip").count() == 1, "Edit mode: every main subject has a drag handle")
    page.click("#folder-edit")

    # ---- + Add main subject (name and colour) ----
    page.click("#folder-add")
    page.wait_for_selector("#folder-dialog")
    page.click("#folder-save")  # empty name: stays open
    check(page.locator("#folder-dialog").is_visible(), "an empty name doesn't add anything")
    page.fill("#folder-name", "Prelims")
    page.click(".swatch[data-colour='violet']")
    page.click("#folder-save")
    expect(page.locator("#folder-grid .fcard[data-id] .fname").last).to_have_text("Prelims")
    prelims = next(f for f in rows(page, "folders") if f["name"] == "Prelims")
    check(prelims["colour"] == "violet" and prelims["order"] == 9 and prelims["parent"] is None, "Prelims added last, violet")
    check(any(f["parent"] == prelims["id"] and f["name"] == "General" for f in rows(page, "folders")), "a new main subject starts with General")

    # ---- into GS1: + Add subject (suggestions), colour inherited ----
    page.click(".fcard[data-id='main:GS1']")
    page.wait_for_url("**/#/notes/f/main%3AGS1")
    page.wait_for_selector("#crumbs .here:has-text('GS1')")
    check(page.locator("#crumbs").inner_text().replace("\n", " ").split() == ["Notes", "›", "GS1"], "breadcrumb Notes › GS1")
    page.click("#folder-add")
    page.click(".suggest .chip-btn:has-text('History')")
    check(page.input_value("#folder-name") == "History", "a suggestion fills the name")
    page.click("#folder-save")
    for n in ["Geography", "Society"]:
        page.click("#folder-add")
        page.fill("#folder-name", n)
        page.keyboard.press("Enter")
        page.wait_for_timeout(250)
    expect(page.locator(".fcard[data-id] .fname")).to_have_count(4)
    check(card_names(page) == ["General", "History", "Geography", "Society"], f"subjects in the order added ({card_names(page)})")
    hist = next(f for f in rows(page, "folders") if f["name"] == "History")
    check(hist["parent"] == "main:GS1" and hist["colour"] is None, "a subject stores no colour of its own")
    check(page.evaluate(COLOUR, [f".fcard[data-id='{hist['id']}']", "--sub-gs1"]), "History is ochre like GS1")
    check(page.locator("h1").first.evaluate("e => getComputedStyle(e).color") == page.locator(".fcard[data-id='main:GS1'], .browse-head h1").first.evaluate("e => getComputedStyle(e).color"), "heading in the main subject's colour")

    # ---- Edit: rename, reorder (mouse drag, arrow keys) ----
    page.click("#folder-edit")
    page.fill(f"input[data-rename='{hist['id']}']", "Modern History")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check(by_id(page, "folders")[hist["id"]]["name"] == "Modern History", "rename by tapping the name")
    soc = next(f for f in rows(page, "folders") if f["name"] == "Society")
    drag_mouse(page, f".fcard[data-id='{soc['id']}'] .fgrip", f".fcard[data-id='gen:GS1']")
    page.wait_for_timeout(400)
    order = sorted([f for f in rows(page, "folders") if f["parent"] == "main:GS1"], key=lambda f: f["order"])
    check([f["name"] for f in order] == ["Society", "General", "Modern History", "Geography"], f"mouse drag on the handle reorders ({[f['name'] for f in order]})")
    page.locator(f".fcard[data-id='{soc['id']}'] .fgrip").focus()
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(300)
    order = sorted([f for f in rows(page, "folders") if f["parent"] == "main:GS1"], key=lambda f: f["order"])
    check([f["name"] for f in order] == ["General", "Society", "Modern History", "Geography"], "arrow key on the handle moves it one place")
    page.click("#folder-edit")
    page.reload()
    page.wait_for_selector("#folder-grid .fcard[data-id]")
    check(card_names(page) == ["General", "Society", "Modern History", "Geography"], "order and name survive a reload")

    # ---- a subject: New note files the note there ----
    page.click(f".fcard[data-id='{hist['id']}']")
    page.wait_for_selector("#new-note")
    check(page.locator("#crumbs").inner_text().replace("\n", " ").split() == ["Notes", "›", "GS1", "›", "Modern", "History"], "breadcrumb Notes › GS1 › Modern History")
    check(page.locator("#new-note.big").count() == 1 and page.locator(".tpl-row .chip-link").count() == 4, "subject: big New note and Start from: template chips")
    new_note(page, "Revolt of 1857", "Causes and consequences.")
    n1 = next(n for n in rows(page, "notes") if n["title"] == "Revolt of 1857")
    check(n1["folderId"] == hist["id"] and n1["subject"] == "GS1", "New note inside Modern History is filed there (folderId, subject GS1)")
    check(page.inner_text("#f-subject").strip() == "GS1 › Modern History", "the chip under the title shows GS1 › Modern History")
    check(page.get_attribute("#note-back", "href") == "#/notes/f/" + quote(hist["id"], safe=""), "← goes to the note's subject")
    page.go_back()
    page.wait_for_selector(".note-card:has-text('Revolt of 1857')")
    check(page.url.endswith(quote(hist["id"], safe="")), "browser back from the note: its subject")
    page.go_back()
    page.wait_for_selector(".fcard[data-id='gen:GS1']")
    check(page.url.endswith("main%3AGS1"), "browser back again: up one level to GS1")
    page.go_back()
    page.wait_for_selector(".fcard[data-id='main:GS1']")
    check(page.url.endswith("#/notes"), "and again: Notes")

    # a template chip in a subject starts that template there
    page.goto(folder_href(hist["id"]))
    page.click(".tpl-row .chip-link[data-template='gs-answer']")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "Was 1857 a war of independence?")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    n2 = next(n for n in rows(page, "notes") if n["title"].startswith("Was 1857"))
    check(n2["folderId"] == hist["id"] and n2.get("template") == "gs-answer", "Start from: GS answer, filed in the subject")

    # ---- Move to… (from the chip and from ⋯), one Undo step ----
    page.click("#f-subject")
    page.wait_for_selector("#move-sheet")
    check(page.locator("#move-sheet .move-opt[aria-current='true']").inner_text().strip() == "Modern History", "Move to… marks where it is now")
    check(page.locator("#move-sheet .move-main").count() == 10, "Move to… lists every main subject")
    page.click("#move-sheet [data-folder='gen:GS2']")
    page.wait_for_timeout(1200)
    n2 = by_id(page, "notes")[n2["id"]]
    check(n2["folderId"] == "gen:GS2" and n2["subject"] == "GS2", "moved to GS2 › General")
    check(page.inner_text("#f-subject").strip() == "GS2 › General" and "Moved to GS2 › General" in page.inner_text(".toast"), "chip and toast say where it went")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(1200)
    n2 = by_id(page, "notes")[n2["id"]]
    check(n2["folderId"] == hist["id"] and n2["subject"] == "GS1", "Undo puts it back in one step")
    page.click("#note-more")
    page.click(".popover button[aria-label='Move to']")
    page.click("#move-sheet [data-folder='gen:Others']")
    page.wait_for_timeout(1200)
    check(by_id(page, "notes")[n2["id"]]["folderId"] == "gen:Others", "⋯ → Move to… works too")

    # ---- New note from elsewhere goes to the last subject used ----
    page.goto(URL + "#/notes")
    page.click("#new-note")
    page.wait_for_selector("#new-place")
    check("Others › General" in page.inner_text("#new-place"), f"New note outside a folder: last subject used ({page.inner_text('#new-place')})")
    page.goto(URL + "#/notes")

    # ---- Recent row, Ctrl+K, Continue writing: one tap ----
    page.wait_for_selector("#recent .note-card")
    recent = page.eval_on_selector_all("#recent .note-card strong", "e => e.map(x => x.textContent)")
    check(recent[:2] == ["Was 1857 a war of independence?", "Revolt of 1857"], f"Recent row, newest first ({recent})")
    page.click("#recent .note-card:has-text('Revolt of 1857')")
    page.wait_for_selector("#f-title")
    check(page.input_value("#f-title") == "Revolt of 1857", "Recent opens the note in one tap")
    page.keyboard.press("Control+k")
    page.fill("#global-search", "modern hist")
    page.wait_for_selector(".folder-hit")
    check("Subject in GS1" in page.inner_text(".folder-hit") and "GS1 › Modern History" in page.inner_text("#search-results"), "Ctrl+K finds the subject by name and shows where notes are")
    page.click(".folder-hit")
    page.wait_for_selector(".note-card:has-text('Revolt of 1857')")
    check(page.url.endswith(quote(hist["id"], safe="")), "a subject hit opens the folder")
    page.keyboard.press("Control+k")
    page.fill("#global-search", "consequences")
    page.wait_for_selector(".search-hit:not(.folder-hit)")
    page.keyboard.press("Enter")
    page.wait_for_selector("#f-title")
    check(page.input_value("#f-title") == "Revolt of 1857", "Ctrl+K opens a note in one tap")
    page.goto(URL + "#/")
    page.wait_for_selector("#resume")
    check("GS1 › Modern History" in page.inner_text(".continue") and page.get_attribute("#resume", "href") == f"#/n/{n1['id']}", "Today's Continue writing: where it is, one tap to open")
    rings = page.eval_on_selector_all(".ring span", "e => e.map(x => x.textContent)")
    check(rings[:8] == ["GS1", "GS2", "GS3", "GS4", "Essay", "Interview", "Current affairs", "PSIR"] and "Others" in rings and "Prelims" in rings, f"Today's rings: one per main subject ({rings})")

    # ---- renaming a main subject rewrites no note ----
    before = by_id(page, "notes")[n1["id"]]["updatedAt"]
    page.goto(URL + "#/notes")
    page.click("#folder-edit")
    page.fill("input[data-rename='main:GS1']", "GS1 History & Society")
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    page.click("#folder-edit")
    check(by_id(page, "notes")[n1["id"]]["updatedAt"] == before, "renaming GS1 doesn't rewrite its notes")
    page.goto(URL + f"#/n/{n1['id']}")
    page.wait_for_selector("#f-subject")
    check(page.inner_text("#f-subject").strip() == "GS1 History & Society › Modern History", "the note shows the new name")

    # ---- the due list ----
    page.goto(URL + "#/notes")
    page.click("#due-link")
    page.wait_for_selector("#note-list .note-card")
    check(page.locator("#note-list .note-card").count() == 2 and "Due today" in page.inner_text("#crumbs"), "N due today → the due notes")

    # ---- root search lists matches flat ----
    page.goto(URL + "#/notes")
    page.fill("#search", "1857")
    check(page.locator("#note-list .note-card").count() == 2 and page.locator("#folder-grid").count() == 0, "search on Notes lists matching notes")

    # ================= deleting folders =================
    page.goto(URL + "#/notes/f/main%3AGS1")
    page.wait_for_selector("#folder-edit")
    page.click("#folder-edit")
    page.click(f".fcard[data-id='{hist['id']}'] .fdel")
    page.wait_for_selector("#folder-delete")
    txt = page.inner_text("#folder-delete")
    check("Delete “Modern History”?" in txt and "Its 1 note goes to Trash. You can restore it for 30 days" in txt, f"the dialog says how many notes go to Trash ({txt!r})")
    page.click("#folder-delete .sheet-actions button:has-text('Cancel')")
    check(by_id(page, "folders")[hist["id"]]["deletedAt"] is None, "Cancel keeps it")
    page.click(f".fcard[data-id='{hist['id']}'] .fdel")
    page.click("#folder-delete-confirm")
    page.wait_for_timeout(600)
    f = by_id(page, "folders")[hist["id"]]
    n1r = by_id(page, "notes")[n1["id"]]
    check(f["deletedAt"] is not None and n1r["deletedAt"] is not None and n1r["folderId"] == hist["id"], "deleted: the folder is marked, its note is in Trash and keeps its folder")
    check(hist["id"] not in card_ids(page) and "in Trash for 30 days" in page.inner_text(".toast"), "the card goes; toast says Trash, 30 days")
    page.goto(URL + "#/trash")
    page.wait_for_selector(".trash-row")
    check("Modern History" in page.inner_text(".trash-row"), "Trash shows where the note was")
    page.click(".trash-row button:has-text('Restore')")
    page.wait_for_timeout(600)
    check(by_id(page, "folders")[hist["id"]]["deletedAt"] is None and by_id(page, "notes")[n1["id"]]["deletedAt"] is None, "restoring the note brings its folder back")
    page.goto(URL + "#/notes/f/main%3AGS1")
    page.wait_for_selector(f".fcard[data-id='{hist['id']}']")
    check("1 note" in page.inner_text(f".fcard[data-id='{hist['id']}']"), "with the note in it")

    # the last subject can't be deleted
    page.click("#folder-edit")
    for fid in [x for x in card_ids(page) if x != "gen:GS1"]:
        page.click(f".fcard[data-id='{fid}'] .fdel")
        page.click("#folder-delete-confirm")
        page.wait_for_timeout(400)
    check(card_ids(page) == ["gen:GS1"] and page.locator(".fcard[data-id='gen:GS1'] .fdel").count() == 0, "the last subject (General) has no red −")
    page.click("#folder-edit")

    # deleting a main subject: its subjects and notes
    page.goto(URL + "#/notes/f/" + quote(prelims["id"], safe=""))
    page.wait_for_selector("#new-note")
    page.click("#folder-add")
    page.fill("#folder-name", "CSAT maths")
    page.click("#folder-save")
    page.wait_for_timeout(300)
    csat = next(x for x in rows(page, "folders") if x["name"] == "CSAT maths")
    page.goto(folder_href(csat["id"]))
    new_note(page, "Percentages", "10% of 50 is 5.")
    page.goto(URL + "#/notes")
    page.click("#folder-edit")
    page.click(f".fcard[data-id='{prelims['id']}'] .fdel")
    page.wait_for_selector("#folder-delete")
    txt = page.inner_text("#folder-delete")
    check("2 subjects and 1 note go to Trash" in txt, f"deleting a main subject names its subjects and notes ({txt!r})")
    page.click("#folder-delete-confirm")
    page.wait_for_timeout(500)
    fs = by_id(page, "folders")
    check(all(fs[x]["deletedAt"] for x in [prelims["id"], csat["id"]]) and next(n for n in rows(page, "notes") if n["title"] == "Percentages")["deletedAt"], "main subject, its subjects and its notes all go")
    page.click("#folder-edit")

    # ================= words: month › date › words =================
    page.goto(URL + "#/vocab")
    page.wait_for_selector("#new-word")
    check(date.today().strftime("%-d %b") in page.inner_text("#new-word"), f"Add word to today names the date ({page.inner_text('#new-word')})")
    page.click("#new-word")
    page.wait_for_selector("#v-word")
    page.fill("#v-word", "Probity")
    page.fill("#v-meaning", "Strict honesty")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    w1 = next(w for w in rows(page, "vocab") if w["word"] == "Probity")
    fs = by_id(page, "folders")
    month = TODAY[:7]
    check(w1["folderId"] == "wd:" + TODAY and fs["wd:" + TODAY]["parent"] == "wm:" + month and fs["wm:" + month]["kind"] == "words", "Add word to today made the month and date and filed the word")
    check(fs["wm:" + month]["name"] == date.today().strftime("%B %Y") and fs["wd:" + TODAY]["name"] == date.today().strftime("%a %-d %b"), f"named like “{date.today().strftime('%B %Y')}” and “{date.today().strftime('%a %-d %b')}”")
    check("Filed under" in page.inner_text("#word-place"), "the word says where it is filed")
    page.click("#word-back")
    page.wait_for_selector("#vocab-list .note-card")
    check(page.url.endswith(quote("wd:" + TODAY, safe="")), "← goes to the word's date")
    page.click("#add-word-here")
    page.fill("#v-word", "Egalitarian")
    page.fill("#v-meaning", "All people equal")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    check(next(w for w in rows(page, "vocab") if w["word"] == "Egalitarian")["folderId"] == "wd:" + TODAY, "Add word inside a date files it there")

    # manual month and date
    last_month = (date.today().replace(day=1) - timedelta(days=1))
    lm = last_month.strftime("%Y-%m")
    page.goto(URL + "#/vocab")
    page.click("#folder-add")
    page.fill("#folder-month", lm)
    page.click("#folder-save")
    page.wait_for_selector(f".fcard[data-id='wm:{lm}']")
    check(card_ids(page)[:2] == ["wm:" + month, "wm:" + lm], f"months newest first ({card_ids(page)})")
    page.click(f".fcard[data-id='wm:{lm}']")
    page.click("#folder-add")
    page.fill("#folder-date", f"{lm}-05")
    page.click("#folder-save")
    page.click("#folder-add")
    page.fill("#folder-date", f"{lm}-20")
    page.click("#folder-save")
    page.wait_for_selector(f".fcard[data-id='wd:{lm}-05']")
    page.wait_for_selector(f".fcard[data-id='wd:{lm}-20']")
    check(card_ids(page) == [f"wd:{lm}-20", f"wd:{lm}-05"], f"dates newest first ({card_ids(page)})")
    page.click("#folder-edit")
    check(page.locator(".fgrip").count() == 0 and page.locator(".fdel").count() == 2, "Words Edit: delete and rename, no drag handle (dates sort themselves)")
    page.click("#folder-edit")
    page.click(f".fcard[data-id='wd:{lm}-05']")
    page.click("#add-word-here")
    page.fill("#v-word", "Salient")
    page.fill("#v-meaning", "Most important")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    w3 = next(w for w in rows(page, "vocab") if w["word"] == "Salient")
    check(w3["folderId"] == f"wd:{lm}-05", "a word added to a past date is filed there")
    # Move to another date
    page.click("#word-move")
    page.fill("#word-date", f"{lm}-20")
    page.click("#word-move-save")
    page.wait_for_timeout(1200)
    check(by_id(page, "vocab")[w3["id"]]["folderId"] == f"wd:{lm}-20", "Move to another date")
    page.goto(folder_href(f"wm:{lm}", True))
    page.wait_for_selector(f".fcard[data-id='wd:{lm}-20']")
    check("Salient" in page.inner_text(f".fcard[data-id='wd:{lm}-20']") and "1 word" in page.inner_text(f".fcard[data-id='wd:{lm}-20']"), "the date card lists its words")
    # delete a date: its words go to Trash
    page.click("#folder-edit")
    page.click(f".fcard[data-id='wd:{lm}-20'] .fdel")
    check("1 word go" in page.inner_text("#folder-delete") or "1 word" in page.inner_text("#folder-delete"), "date delete dialog counts its words")
    page.click("#folder-delete-confirm")
    page.wait_for_timeout(500)
    check(by_id(page, "vocab")[w3["id"]]["deletedAt"] is not None, "its words go to Trash")
    page.click("#folder-edit")

    # ================= old data: no folder ids =================
    old_note = {"id": "old-gs3", "subject": "GS3", "topic": "Economy", "title": "Old GS3 note", "sections": [{"id": "s1", "heading": "Notes", "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Fiscal deficit."}]}]}}],
                "explain": "", "connect": "", "nextReview": "2030-01-01", "reviewCount": 1, "lastReviewed": 1, "createdAt": 1, "updatedAt": 7, "deletedAt": None}
    lost = dict(old_note, id="lost-folder", title="Note in a lost folder", subject="GS4", folderId="nope", updatedAt=8)
    old_word = {"id": "old-word", "word": "Fiduciary", "meaning": "Held in trust", "uses": [], "synonyms": [], "antonyms": [], "nextReview": "2030-01-01", "reviewCount": 0,
                "createdAt": 1767225600000 + 3 * 86400000, "updatedAt": 9, "deletedAt": None}  # 4 Jan 2026 (UTC; local date by the tablet's clock)
    for store, rec in [("notes", old_note), ("notes", lost), ("vocab", old_word)]:
        page.evaluate(PUT, [store, rec])
    page.reload()
    page.goto(folder_href("gen:GS3"))
    page.wait_for_selector(".note-card:has-text('Old GS3 note')")
    check(True, "an old note (no folder) shows under its subject's General")
    page.goto(folder_href("gen:GS4"))
    page.wait_for_selector(".note-card:has-text('Note in a lost folder')")
    check(True, "a note whose folder isn't there shows under its subject's General")
    wd = page.evaluate("ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }", old_word["createdAt"])
    page.goto(folder_href("wd:" + wd, True))
    page.wait_for_selector(".note-card:has-text('Fiduciary')")
    check(by_id(page, "folders").get("wm:" + wd[:7]) is not None, f"an old word shows under the day it was added ({wd}), month made on launch")
    stored = by_id(page, "notes")
    check(stored["old-gs3"] == old_note and stored["lost-folder"] == lost and by_id(page, "vocab")["old-word"] == old_word, "old note and word not rewritten (no folderId added)")

    # ================= backup format 4 =================
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    bpath = OUT / "folders-backup.json"
    dl.value.save_as(bpath)
    bk = json.loads(bpath.read_text())
    here = rows(page, "folders")
    check(bk["format"] == 4 and bk["counts"]["folders"] == len(here) and len(bk["folders"]) == len(here), f"backup format 4 carries every folder, deleted ones too ({len(here)})")
    check(any(f["deletedAt"] for f in bk["folders"]), "deleted folders are in the backup (so a merge can't bring them back)")

    fresh = browser.new_context(viewport={"width": 1280, "height": 800})
    p2 = fresh.new_page()
    p2.on("pageerror", lambda e: errors.append(str(e)))
    p2.goto(URL + "#/settings")
    p2.wait_for_selector("#import-file", state="attached")
    p2.set_input_files("#import-file", str(bpath))
    expect(p2.locator(".import-result")).to_contain_text("added", timeout=5000)
    strip = lambda fs: sorted([{k: v for k, v in f.items() if k not in ("createdAt", "updatedAt")} for f in fs], key=lambda f: f["id"])
    check(strip(rows(p2, "folders")) == strip(here), "a fresh tablet gets the same folders (ids, names, order, colours, deleted ones)")
    p2.goto(folder_href("main:GS1"))
    p2.wait_for_selector(".browse-head h1")
    check(p2.inner_text(".browse-head h1") == "GS1 History & Society", "renamed main subject comes across")
    n_folders = len(rows(p2, "folders"))
    p2.goto(URL + "#/settings")
    p2.set_input_files("#import-file", str(bpath))
    expect(p2.locator(".import-result")).to_contain_text("0 added", timeout=5000)
    check(len(rows(p2, "folders")) == n_folders and "0 folders" in p2.inner_text(".import-result"), "importing twice adds no folder")
    fresh.close()

    # an old (format 3) file on a fresh tablet: folders the way the upgrade makes them
    old = dict(bk, format=3)
    old.pop("folders")
    old["counts"] = {k: v for k, v in bk["counts"].items() if k != "folders"}
    for n in old["notes"]:
        n.pop("folderId", None)
    for w in old["vocab"]:
        w.pop("folderId", None)
    opath = OUT / "format3.json"
    opath.write_text(json.dumps(old))
    f3 = browser.new_context(viewport={"width": 1280, "height": 800})
    p3 = f3.new_page()
    p3.on("pageerror", lambda e: errors.append(str(e)))
    p3.goto(URL + "#/settings")
    p3.wait_for_selector("#import-file", state="attached")
    p3.set_input_files("#import-file", str(opath))
    expect(p3.locator(".import-result")).to_contain_text("added", timeout=5000)
    ids = {f["id"] for f in rows(p3, "folders")}
    want = {f"main:{k}" for k in ["GS1", "GS2", "GS3", "GS4", "Essay", "Interview", "Current affairs", "PSIR", "Others"]} | {f"gen:{k}" for k in ["GS1", "GS2", "GS3", "GS4", "Essay", "Interview", "Current affairs", "PSIR", "Others"]}
    live_words = [w for w in old["vocab"] if not w["deletedAt"]]
    days = {p3.evaluate("ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }", w["createdAt"]) for w in live_words}
    check(want <= ids and {f"wd:{d}" for d in days} <= ids and {f"wm:{d[:7]}" for d in days} <= ids, "format 3: main subjects with General, words by the day added")
    stored = by_id(p3, "notes")
    check(all("folderId" not in stored[n["id"]] for n in old["notes"]), "format 3 import rewrites no note")
    p3.goto(folder_href("gen:GS3"))
    p3.wait_for_selector(".note-card")
    check(p3.locator(".note-card:has-text('Old GS3 note')").count() == 1, "a format-3 note shows under its subject's General")
    before_ids = sorted(ids)
    p3.goto(URL + "#/settings")
    p3.set_input_files("#import-file", str(opath))
    expect(p3.locator(".import-result")).to_contain_text("0 added", timeout=5000)
    check(sorted(f["id"] for f in rows(p3, "folders")) == before_ids, "importing the format-3 file twice adds no folder")
    f3.close()

    # ================= portrait, a real finger on the handle =================
    pc = browser.new_context(viewport={"width": 800, "height": 1280}, has_touch=True)
    pp = pc.new_page()
    pp.on("pageerror", lambda e: errors.append(str(e)))
    pp.goto(URL + "#/notes/f/main%3AGS2")
    pp.wait_for_selector("#folder-add")
    for n in ["Polity", "Governance"]:
        pp.click("#folder-add")
        pp.fill("#folder-name", n)
        pp.click("#folder-save")
        pp.wait_for_timeout(250)
    pp.tap("#folder-edit")
    gov = next(x for x in rows(pp, "folders") if x["name"] == "Governance")
    a = pp.locator(f".fcard[data-id='{gov['id']}'] .fgrip").bounding_box()
    b = pp.locator(".fcard[data-id='gen:GS2']").bounding_box()
    cdp = pc.new_cdp_session(pp)
    x0, y0 = a["x"] + a["width"] / 2, a["y"] + a["height"] / 2
    x1, y1 = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for i in range(1, 16):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / 15, "y": y0 + (y1 - y0) * i / 15}]})
        pp.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    pp.wait_for_timeout(400)
    order = [x["name"] for x in sorted([x for x in rows(pp, "folders") if x["parent"] == "main:GS2"], key=lambda x: x["order"])]
    check(order[0] == "Governance", f"a finger drag on the handle reorders ({order})")
    check(pp.evaluate("window.scrollY") == 0, "and doesn't scroll the page")
    check(not pp.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "portrait: no sideways scroll")
    targets = pp.eval_on_selector_all(".fdel, .fgrip, #folder-add, #folder-edit, #crumbs a", "e => e.map(x => { const r = x.getBoundingClientRect(); return Math.min(r.width, r.height); })")
    check(min(targets) >= 44, f"touch targets ≥ 44 px ({min(targets):.0f})")
    pp.screenshot(path=str(OUT / "folders-portrait.png"))
    pc.close()

    page.goto(URL + "#/notes")
    page.wait_for_selector("#folder-grid")
    page.screenshot(path=str(OUT / "folders-landscape.png"))
    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
