"""Upgrade test: an installed previous release updates to this build without losing or rewriting data.

One browser profile (like the tablet): in the OLD build write a note (highlight, second section, own
words, an image), add a word, mark the note reviewed (quick insights) and save a backup file. Switch
the server to the NEW build, check the "new version" banner, tap Reload now, then check:
- every note, word, image and stored setting is byte-for-byte what the old build stored;
- the database upgrade (0.8: Dexie v3) made one review card per quick insight, on the note's schedule;
- 0.9+ old builds first import a real-size tablet (220 notes, 1,100 words, 30 pictures, cards made by
  the old build's import) so the upgrade and the old backup are tested at the size he will have;
- 0.10 (Dexie v4) wrote only folder records (9 main subjects with General, a month and date for each day
  with words), every note, word, image, card and setting is byte-for-byte unchanged, the screens show
  everything where it was, a fresh tablet importing the old backup gets the same folders, and the old
  build refuses a format-4 backup and stores nothing;
- the note is intact, unchanged (same updatedAt) and still editable;
- the old backup file imports into the new build intact, on a fresh tablet and on this one, with
  its cards made once (no duplicates).

Usage (port 4173 must be free; the script starts and stops the servers itself):
  git worktree add /tmp/prev <previous-release-commit> && cd /tmp/prev && ln -s <repo>/node_modules . && npm run build
  npm run build && python3 scripts/upgrade-test.py /tmp/prev
The old build is driven only through things every release since 0.6 has: typing, Ctrl+Shift+H
for a highlight, #add-section, #f-explain (opened from Details when present), #mark-reviewed,
#v-word / #v-meaning and #backup-download; the image goes in through the slash menu when the old
build has one (0.7+).
"""
import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import date, timedelta

from PIL import Image
from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
OLD = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
NEW = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


def serve(d):
    subprocess.run(["fuser", "-k", "4173/tcp"], capture_output=True)
    time.sleep(1)
    subprocess.Popen(["npx", "vite", "preview", "--port", "4173", "--strictPort"], cwd=d, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    html = urllib.request.urlopen(URL).read().decode()
    js = re.search(r'assets/index-[^"]*\.js', html).group(0)
    version = re.search(r'(\d+\.\d+\.\d+) \(', urllib.request.urlopen(URL + js).read().decode()).group(1)
    print(f"serving {version} from {d}")
    return version


ALL_NOTES = """() => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result); }; }; })"""
ALL = """(store) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  if (![...q.result.objectStoreNames].includes(store)) { q.result.close(); return r(null); }
  const g = q.result.transaction(store).objectStore(store).getAll(); g.onsuccess = () => { q.result.close(); r(g.result); }; }; })"""
# Images with their bytes, in the backup file's shape (blob -> type + base64), so the two can be compared.
ALL_IMAGES = """() => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('images').objectStore('images').getAll(); g.onsuccess = async () => { const out = [];
    for (const { blob, ...rest } of g.result) { const b = new Uint8Array(await blob.arrayBuffer()); let s = '';
      for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
      out.push({ ...rest, type: blob.type, data: btoa(s) }); }
    q.result.close(); r(out.sort((a, b) => a.id.localeCompare(b.id))); }; }; })"""
DB_VERSION = """() => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => { const v = q.result.version; q.result.close(); r(v); }; })"""


def snapshot(page):
    return {"notes": page.evaluate(ALL, "notes"), "vocab": page.evaluate(ALL, "vocab"), "images": page.evaluate(ALL_IMAGES), "meta": page.evaluate(ALL, "meta")}


SUBJECTS = ["GS1", "GS2", "GS3", "GS4", "Essay", "Interview", "Current affairs", "PSIR"]


def stroke(pts):
    """A sketch stroke code (lib/sketch.ts encodeStroke): zigzag varint deltas of x*4, y*4, pressure*100, base64."""
    out = bytearray()

    def put(v):
        z = -2 * v - 1 if v < 0 else 2 * v
        while z >= 0x80:
            out.append((z & 0x7F) | 0x80)
            z //= 128
        out.append(z)
    px = py = pp = 0
    for x, y, pr in pts:
        x, y, pr = round(x * 4), round(y * 4), round(pr * 100)
        put(x - px); put(y - py); put(pr - pp)
        px, py, pp = x, y, pr
    return "pen.ink.m:" + base64.b64encode(bytes(out)).decode()


def real_size_backup(path, now_ms):
    """A format-3 (0.9) backup the size of a real tablet after months of use: 220 notes over every subject
    (sections, highlights and quick insights, lists, tables, callouts, pictures, sketches; some in Trash,
    two with a subject that isn't one of the 8), 1,100 words added over 150 days (some in Trash), 30 pictures.
    Review cards are made by the old build's own import, from the quick insights."""
    day = 86_400_000
    images, notes, words = [], [], []
    for i in range(30):
        buf = io.BytesIO()
        Image.new("RGB", (320 + i, 200), ((i * 37) % 255, (i * 91) % 255, (i * 53) % 255)).save(buf, "PNG")
        images.append({"id": f"img-{i:03d}", "noteId": f"note-{i:03d}", "width": 320 + i, "height": 200, "updatedAt": now_ms - i * day,
                       "type": "image/png", "data": base64.b64encode(buf.getvalue()).decode()})
    text = lambda t, marks=None: {"type": "text", "text": t, **({"marks": marks} if marks else {})}
    para = lambda *c: {"type": "paragraph", "content": list(c)}
    for i in range(220):
        nid = f"note-{i:03d}"
        subject = SUBJECTS[i % 8] if i < 218 else "Optional Sociology"
        key = f"Key line {i} about {subject}"
        body = [para(text(f"Note {i} on {subject}. "), text(key, [{"type": "highlight"}]), text(" and more context.")),
                {"type": "bulletList", "content": [{"type": "listItem", "content": [para(text(f"Point {k} of note {i}"))]} for k in range(3)]}]
        if i % 5 == 0:
            body.append({"type": "table", "content": [{"type": "tableRow", "content": [{"type": "tableCell", "content": [para(text(f"r{r}c{c}"))]} for c in range(3)]} for r in range(3)]})
        if i % 7 == 0:
            body.append({"type": "callout", "attrs": {"kind": "case"}, "content": [para(text(f"Case for note {i}"))]})
        if i < 30:
            body.append({"type": "imageBlock", "attrs": {"imageId": f"img-{i:03d}", "width": 50, "align": "right" if i % 2 else "center"}})
        if i % 20 == 3:
            body.append({"type": "sketchBlock", "attrs": {"strokes": [stroke([(100 + k * 20, 100 + (k % 3) * 30, 0.5) for k in range(20)])], "height": 600, "width": 100, "align": "center", "caption": f"Sketch {i}"}})
        reviewed = i % 3 != 0
        notes.append({
            "id": nid, "subject": subject, "topic": f"Topic {i % 13}", "title": f"Real note {i:03d}",
            "sections": [{"id": f"{nid}-s1", "heading": "Notes", "doc": {"type": "doc", "content": body}},
                         {"id": f"{nid}-s2", "heading": "Way forward", "doc": {"type": "doc", "content": [para(text(f"Way forward for {i}."))]}}],
            "explain": f"In my words {i}", "connect": "", **({"template": "topic-sheet"} if i % 4 == 0 else {}),
            **({"insights": {"generatedAt": now_ms - i * 3600_000, "items": [{"section": "Notes", "text": key}]}} if reviewed else {}),
            "nextReview": (date.today() + timedelta(days=(i % 9) - 3)).isoformat(), "reviewCount": 2 if reviewed else 0, **({"reviewStep": 1} if reviewed and i % 2 else {}),
            "lastReviewed": now_ms - day if reviewed else None, "createdAt": now_ms - (i + 1) * day // 2, "updatedAt": now_ms - i * 3600_000,
            "deletedAt": now_ms - 2 * day if i in (11, 57, 103, 149, 191, 205, 209, 213) else None})
    for i in range(1100):
        words.append({
            "id": f"word-{i:04d}", "word": f"Word{i:04d}", "meaning": f"Meaning of word {i}", "uses": [{"sentence": f"A sentence with word {i}.", "context": "Essay"}],
            "synonyms": [f"syn{i}"], "antonyms": [], "nextReview": (date.today() + timedelta(days=(i % 7) - 2)).isoformat(), "reviewCount": i % 3,
            **({"lastReviewed": now_ms - day} if i % 3 else {}), "createdAt": now_ms - (i % 150) * day - (i * 7919) % day, "updatedAt": now_ms - (i % 150) * day,
            "deletedAt": now_ms - day if i % 45 == 7 else None})
    data = {"app": "upsc-notes", "format": 3, "schemaVersion": 3, "exportedAt": "2026-10-13T00:00:00.000Z",
            "counts": {"notes": len(notes), "vocab": len(words), "images": len(images), "cards": 0},
            "notes": notes, "vocab": words, "images": images, "cards": [], "meta": {"reviewDays": [(date.today() - timedelta(days=k)).isoformat() for k in range(1, 9)]}}
    with open(path, "w") as f:
        json.dump(data, f)
    return data


def ver(v):
    return tuple(int(x) for x in v.split("."))


def key(rows):
    return sorted(rows, key=lambda r: r.get("id", r.get("key")))


profile = tempfile.mkdtemp()
try:
    with sync_playwright() as p:
        old_v = serve(OLD)
        ctx = p.chromium.launch_persistent_context(profile, viewport={"width": 1280, "height": 900})
        page = ctx.pages[0]
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # Turn Playwright's file-picker interception on now. expect_file_chooser() turns it on lazily and
        # doesn't wait for Chrome to confirm before pressing the key, so when the browser is busy (the
        # new note's first save) the picker opened first and the event never came (3 runs in 5).
        page.on("filechooser", lambda fc: None)

        # ---- old build: write a note with a highlight, a second section and own words ----
        page.goto(URL + "#/n/new")
        page.wait_for_selector("#f-title, .tpl-card")  # 0.7+ asks for a template first
        if page.locator(".tpl-card").count():
            page.click(".tpl-card[data-template='blank']")
        page.wait_for_selector("#f-title")
        page.fill("#f-title", f"Written in {old_v}")
        page.locator(".section-body .rich").first.click()
        page.keyboard.type("Plain line. ")
        page.keyboard.press("Control+Shift+h")
        page.keyboard.type("Key line from the old build")
        page.keyboard.press("Control+Shift+h")
        page.click("#add-section")
        page.locator(".section-heading").nth(1).fill("Second")
        page.locator(".section-body .rich").nth(1).click()
        page.keyboard.type("Second section text")
        # an image (slash menu, 0.7+)
        img = os.path.join(profile + "-files", "map.png")
        os.makedirs(os.path.dirname(img), exist_ok=True)
        Image.new("RGB", (640, 400), (60, 120, 90)).save(img)
        page.keyboard.press("Enter")
        page.keyboard.type("/image")
        # wait for the menu to filter down to Image (pressing Enter earlier picks whatever is first)
        try:
            page.wait_for_selector(".insert-opt[data-item='image'][aria-selected='true']", timeout=3000)
            has_image = True
        except Exception:
            has_image = False
        if has_image:
            with page.expect_file_chooser() as fc:
                page.keyboard.press("Enter")
            fc.value.set_files(img)
            page.wait_for_function("document.querySelectorAll('.img-block img[src]').length === 1", timeout=10000)
        else:
            for _ in range(6):
                page.keyboard.press("Backspace")
        if page.locator("#details summary").count():
            page.click("#details summary")
        page.fill("#f-explain", "My own words")
        expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
        page.click("#mark-reviewed")
        page.wait_for_timeout(1500)
        # a word
        page.goto(URL + "#/v/new")
        page.fill("#v-word", "Ubiquitous")
        page.fill("#v-meaning", "Found everywhere")
        expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
        # ---- 0.9+: a tablet the size of months of real use, loaded through the old build's own Import ----
        bulk = None
        if ver(old_v) >= (0, 9, 0):
            bulk = real_size_backup(os.path.join(profile + "-files", "real-size.json"), int(time.time() * 1000))
            page.goto(URL + "#/settings")
            page.wait_for_selector("#import-file", state="attached")
            page.set_input_files("#import-file", os.path.join(profile + "-files", "real-size.json"))
            expect(page.locator(".import-result")).to_contain_text("Imported:", timeout=60000)
            res = page.inner_text(".import-result")
            check("1320 added" in res and "30 images" in res, f"{old_v}: real-size data imported: 220 notes, 1,100 words, 30 pictures ({res})")
        # a backup file from the old build
        page.goto(URL + "#/settings")
        with page.expect_download() as dl:
            page.click("#backup-download")
        backup = os.path.join(profile + "-files", "old-backup.json")
        dl.value.save_as(backup)
        page.goto(URL + "#/notes")
        page.wait_for_function("navigator.serviceWorker.ready.then(() => true)")
        page.reload()
        page.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)
        before = page.evaluate(ALL_NOTES)
        mine = lambda notes: next(n for n in notes if n["title"] == f"Written in {old_v}")
        extra = len(bulk["notes"]) if bulk else 0
        check(len(before) == 1 + extra, f"{old_v}: note saved ({len(before)} notes)")
        old = snapshot(page)
        old_cards = page.evaluate(ALL, "cards") or []
        check(len(old["vocab"]) == 1 + (len(bulk["vocab"]) if bulk else 0) and len(old["images"]) == (1 if has_image else 0) + (len(bulk["images"]) if bulk else 0),
              f"{old_v}: words saved, images saved ({len(old['vocab'])} words, {len(old['images'])} images)")
        items = (mine(before).get("insights") or {}).get("items", [])
        check([i["text"] for i in items] == ["Key line from the old build"], f"{old_v}: quick insight made by Mark reviewed")
        if bulk:
            check(len(old_cards) == 1 + sum(1 for n in bulk["notes"] if n.get("insights")), f"{old_v}: review cards made by its import ({len(old_cards)})")
        old_file = json.loads(open(backup).read())
        want = {"notes": len(before), "vocab": len(old["vocab"]), "images": len(old["images"])}
        if "cards" in old_file["counts"]:  # 0.8+ backups also count review cards
            want["cards"] = len(old_cards)
        check(old_file["counts"] == want, f"{old_v}: backup file saved {old_file['counts']}")

        # ---- switch the server to the new build: the installed app offers the update ----
        new_v = serve(NEW)
        notes_home = "#/notes/f/gen%3AGS1" if ver(new_v) >= (0, 10, 0) else "#/notes"  # 0.10: notes live in folders
        page.reload()
        page.wait_for_selector(".banner:has-text('new version')", timeout=20000)
        check(True, f"update banner offers {new_v}")
        t0 = time.time()
        page.click(".banner button:has-text('Reload now')")
        if ver(new_v) >= (0, 10, 0):
            # the reload runs the Dexie upgrade, then Notes shows the main subjects
            page.wait_for_selector(".fcard[data-id='main:GS1']", timeout=30000)
            opened_in = time.time() - t0
        page.wait_for_timeout(2500)

        # ---- the database upgrade kept everything and made the review cards ----
        page.goto(URL + "#/notes")
        page.wait_for_selector(".note-card")  # the new build has opened (and upgraded) the database
        new = snapshot(page)
        check(key(new["notes"]) == key(old["notes"]), f"every note is byte-for-byte what the old build stored ({len(new['notes'])})")
        check(key(new["vocab"]) == key(old["vocab"]), f"every word is unchanged ({len(new['vocab'])})")
        check(new["images"] == old["images"], f"every image is unchanged, bytes included ({len(new['images'])})")
        check(key(new["meta"]) == key(old["meta"]), "stored settings (streak days, last backup) unchanged")
        check(mine(new["notes"]).get("insights") == mine(before).get("insights"), "quick insights unchanged")
        if ver(new_v) >= (0, 8, 0):
            check(page.evaluate(DB_VERSION) == (40 if ver(new_v) >= (0, 10, 0) else 30), f"database upgraded to Dexie v{page.evaluate(DB_VERSION) // 10}")
            cards = page.evaluate(ALL, "cards") or []
            if ver(old_v) < (0, 8, 0):
                n0 = mine(new["notes"])
                check(len(cards) == len(items) and [c["text"] for c in sorted(cards, key=lambda c: c["pos"])] == [i["text"] for i in items],
                      f"one review card per quick insight ({len(cards)})")
                check(all(c["noteId"] == n0["id"] and c["due"] == n0["nextReview"] and c["step"] == max(n0["reviewCount"] - 1, 0) and c["retiredAt"] is None for c in cards),
                      "cards start on the note's own schedule")
            else:
                check(key(cards) == key(old_cards), f"every review card is unchanged ({len(cards)})")
        if ver(new_v) >= (0, 10, 0):
            # 0.10: only folder records were written: the 8 subjects as main subjects with one General each,
            # Others, and a month and date for each day that has words. Nothing else.
            folders = page.evaluate(ALL, "folders") or []
            seeded = ["GS1", "GS2", "GS3", "GS4", "Essay", "Interview", "Current affairs", "PSIR", "Others"]
            local_day = lambda ts: page.evaluate("ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }", ts)
            days = {local_day(w["createdAt"]) for w in new["vocab"] if not w["deletedAt"]}
            want_ids = {f"main:{k}" for k in seeded} | {f"gen:{k}" for k in seeded} | {f"wd:{d}" for d in days} | {f"wm:{d[:7]}" for d in days}
            check({f["id"] for f in folders} == want_ids, f"folders: 9 main subjects with General, {len(days)} dates in {len({d[:7] for d in days})} months, nothing else ({len(folders)})")
            check(all(f["updatedAt"] == 0 and f["deletedAt"] is None for f in folders), "folders the app makes never win a merge (updatedAt 0)")
            check(not any("folderId" in n for n in new["notes"]) and not any("folderId" in w for w in new["vocab"]), "the upgrade added no folderId to any note or word")
            check(opened_in < 8, f"Reload now → upgraded and showing the main subjects in {opened_in:.1f} s ({len(new['notes'])} notes, {len(new['vocab'])} words)")
            # the screens show everything where it was
            by_subject = {}
            for n in new["notes"]:
                if not n["deletedAt"]:
                    k = n["subject"] if n["subject"] in seeded else "Others"
                    by_subject[k] = by_subject.get(k, 0) + 1
            cards_txt = {k: page.inner_text(f".fcard[data-id='main:{k}'] .fmeta") for k in seeded}
            check(all(cards_txt[k].startswith(f"{by_subject.get(k, 0)} note") for k in seeded), f"every main subject counts its notes ({by_subject})")
            page.goto(URL + "#/notes/f/gen%3AOthers")
            page.wait_for_selector(".note-card")
            check(page.locator(".note-card:has-text('Real note 218')").count() == 1, "a note whose subject isn't one of the 8 shows in Others › General")
            page.goto(URL + "#/notes/f/gen%3AGS3")
            page.wait_for_selector(".note-card")
            check(page.locator(".note-card").count() == by_subject["GS3"], f"GS3 › General lists its {by_subject['GS3']} notes")
            page.goto(URL + "#/vocab")
            page.wait_for_selector("#folder-grid .fcard[data-id]")
            month_total = sum(int(t.split()[0]) for t in page.eval_on_selector_all("#folder-grid .fcard[data-id] .fmeta", "e => e.map(x => x.textContent)"))
            check(month_total == sum(1 for w in new["vocab"] if not w["deletedAt"]), f"every word is in a month ({month_total})")
            page.goto(URL + "#/n/note-003")
            page.wait_for_selector(".sketch-paper")
            page.wait_for_function("document.querySelectorAll('.img-block img[src]').length === 1", timeout=10000)
            check(page.locator(".rich table").count() == 0 and page.locator(".callout").count() == 0, "a real-size note opens (picture and sketch)")
            page.goto(URL + "#/notes")
            page.wait_for_timeout(1200)
            check(key(page.evaluate(ALL_NOTES)) == key(old["notes"]), "opening it changed nothing stored")
        page.goto(URL + notes_home)
        page.click(f".note-card:has-text('Written in {old_v}')")
        page.wait_for_selector("#f-title")
        check(page.evaluate("[...document.scripts].some(s => s.src.includes('/assets/index-'))"), "app reloaded")
        first = page.locator(".section-body .rich").first
        check("Key line from the old build" in first.inner_text() and first.locator("mark").count() == 1, "text and highlight intact")
        check(page.locator(".section-heading").nth(1).input_value() == "Second", "second section intact")
        if page.locator("#details summary").count():
            page.click("#details summary")
        check(page.input_value("#f-explain") == "My own words", "own words intact")
        check("Key line from the old build" in page.locator("#insights").inner_text(), "quick insights shown in the note")
        if old["images"]:
            page.wait_for_function("document.querySelectorAll('.img-block img[src]').length === 1", timeout=10000)
            check(True, "image shown in the note")
        page.goto(URL + "#/notes")
        page.wait_for_timeout(1500)
        after = page.evaluate(ALL_NOTES)
        check(key(after) == key(before), "opening and leaving the note in the new build changed nothing stored")

        # ---- and it still edits and saves ----
        page.click(f".note-card:has-text('Written in {old_v}')")
        page.wait_for_selector("#f-title")
        page.locator(".section-body .rich").nth(1).click()
        page.keyboard.press("End")
        page.keyboard.type(" plus an edit")
        page.wait_for_timeout(1500)
        page.reload()
        page.wait_for_selector("#f-title")
        check("plus an edit" in page.locator(".section-body .rich").nth(1).inner_text(), "editing in the new build saves")

        # ---- the old backup file imports into the new build: onto this tablet (nothing newer) ----
        cards_here = page.evaluate(ALL, "cards") or []
        folders_here = page.evaluate(ALL, "folders") or []
        page.goto(URL + "#/settings")
        page.set_input_files("#import-file", backup)
        expect(page.locator(".import-result")).to_contain_text("Imported:", timeout=10000)
        res = page.inner_text(".import-result")
        check("0 added" in res and "0 updated" in res, f"old backup onto the upgraded tablet changes nothing: {res}")
        check((page.evaluate(ALL, "cards") or []) == cards_here, "no duplicate cards from re-importing")
        if ver(new_v) >= (0, 10, 0):
            check((page.evaluate(ALL, "folders") or []) == folders_here, "no folder added or changed by re-importing")
        check(not errors, f"no page errors {errors}")
        ctx.close()

        # ---- ... and onto a fresh tablet: everything arrives intact, with its cards ----
        fresh_browser = p.chromium.launch()
        fresh = fresh_browser.new_page()
        fresh.on("pageerror", lambda e: errors.append(str(e)))
        fresh.goto(URL + "#/settings")
        fresh.wait_for_selector("#import-file", state="attached")
        fresh.set_input_files("#import-file", backup)
        expect(fresh.locator(".import-result")).to_contain_text("Imported:", timeout=10000)
        res = fresh.inner_text(".import-result")
        n_added = len(old_file["notes"]) + len(old_file["vocab"])
        check(f"Imported: {n_added} added" in res, f"fresh tablet: every note and word added ({res})")
        got = snapshot(fresh)
        check(key(got["notes"]) == key(old_file["notes"]), "fresh tablet: notes exactly as in the backup file")
        check(key(got["vocab"]) == key(old_file["vocab"]), "fresh tablet: words exactly as in the backup file")
        check(got["images"] == sorted(old_file["images"], key=lambda i: i["id"]), "fresh tablet: images exactly as in the backup file, bytes included")
        if ver(new_v) >= (0, 8, 0):
            fc = fresh.evaluate(ALL, "cards") or []
            if ver(old_v) < (0, 8, 0):
                nf = mine(old_file["notes"])
                check(len(fc) == len(items) and all(c["due"] == nf["nextReview"] for c in fc), f"fresh tablet: cards made from the quick insights ({len(fc)})")
            else:
                check(key(fc) == key(old_file["cards"]), f"fresh tablet: review cards exactly as in the backup file ({len(fc)})")
            fresh.set_input_files("#import-file", backup)
            expect(fresh.locator(".import-result")).to_contain_text("0 added", timeout=10000)
            check(len(fresh.evaluate(ALL, "cards") or []) == len(fc), "fresh tablet: importing twice makes no duplicate cards")
        if ver(new_v) >= (0, 10, 0):
            ff = fresh.evaluate(ALL, "folders") or []
            strip = lambda fs: sorted([{k: v for k, v in f.items() if k != "createdAt"} for f in fs], key=lambda f: f["id"])
            check(strip(ff) == strip(folders_here), f"fresh tablet: the same folders as the upgraded one ({len(ff)})")
            check(not any("folderId" in n for n in fresh.evaluate(ALL, "notes")), "fresh tablet: the import added no folderId to any note")
        # ---- 0.9+: a backup with a sketch is refused by the old build (it would open that section blank) ----
        if ver(new_v) >= (0, 9, 0) and ver(old_v) < (0, 9, 0):
            fresh.goto(URL + "#/n/new/blank")
            fresh.wait_for_selector("#f-title")
            fresh.fill("#f-title", "Sketched in the new build")
            fresh.locator(".section-body .rich").first.click()
            fresh.keyboard.type("/sketch")
            fresh.wait_for_selector(".insert-opt[data-item='sketch'][aria-selected='true']")
            fresh.keyboard.press("Enter")
            fresh.wait_for_selector(".sketch-paper")
            fresh.evaluate("""async () => { const paper = document.querySelector('.sketch-paper'); const r = paper.getBoundingClientRect();
                for (const [t, f] of [['pointerdown', 0.1], ['pointermove', 0.3], ['pointermove', 0.5], ['pointerup', 0.5]]) {
                  paper.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', clientX: r.left + f * r.width, clientY: r.top + f * r.height, pressure: 0.6, buttons: t === 'pointerup' ? 0 : 1 }));
                  await new Promise(res => requestAnimationFrame(res)); } }""")
            expect(fresh.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
            fresh.goto(URL + "#/settings")
            with fresh.expect_download() as dl:
                fresh.click("#backup-download")
            newer = os.path.join(profile + "-files", "new-backup.json")
            dl.value.save_as(newer)
            check(json.loads(open(newer).read())["format"] == 3, "the new build's backup is format 3")
            fresh_browser.close()
            serve(OLD)
            back = p.chromium.launch()
            oldpage = back.new_page()
            oldpage.on("pageerror", lambda e: errors.append(str(e)))
            oldpage.goto(URL + "#/settings")
            oldpage.wait_for_selector("#import-file", state="attached")
            oldpage.set_input_files("#import-file", newer)
            oldpage.wait_for_timeout(1500)
            check("newer version" in oldpage.inner_text("body"), f"{old_v} refuses a {new_v} backup (\"made by a newer version\") instead of opening sketches as blank sections")
            check(oldpage.evaluate(ALL_NOTES) == [], f"{old_v} stored nothing from it")
            back.close()
        elif ver(new_v) >= (0, 10, 0) and ver(old_v) < (0, 10, 0):
            # ---- 0.10+: a backup with folders (format 4) is refused by the old build (it would drop the folders) ----
            fresh.goto(URL + "#/notes/f/gen%3AGS2")
            fresh.wait_for_selector("#folder-edit, #new-note")
            fresh.goto(URL + "#/notes/f/main%3AGS2")
            fresh.wait_for_selector("#folder-add")
            fresh.click("#folder-add")
            fresh.fill("#folder-name", "Polity")
            fresh.click("#folder-save")
            fresh.wait_for_timeout(300)
            fresh.goto(URL + "#/settings")
            with fresh.expect_download() as dl:
                fresh.click("#backup-download")
            newer = os.path.join(profile + "-files", "new-backup.json")
            dl.value.save_as(newer)
            nb = json.loads(open(newer).read())
            check(nb["format"] == 4 and any(f["name"] == "Polity" for f in nb["folders"]), "the new build's backup is format 4 and carries the folders")
            fresh_browser.close()
            serve(OLD)
            back = p.chromium.launch()
            oldpage = back.new_page()
            oldpage.on("pageerror", lambda e: errors.append(str(e)))
            oldpage.goto(URL + "#/settings")
            oldpage.wait_for_selector("#import-file", state="attached")
            oldpage.set_input_files("#import-file", newer)
            oldpage.wait_for_timeout(2500)
            check("newer version" in oldpage.inner_text("body"), f"{old_v} refuses a {new_v} backup (\"made by a newer version\") instead of dropping the folders")
            check(oldpage.evaluate(ALL_NOTES) == [] and (oldpage.evaluate(ALL, "vocab") or []) == [], f"{old_v} stored nothing from it")
            back.close()
        else:
            fresh_browser.close()
        check(not errors, f"no page errors after import {errors}")
finally:
    subprocess.run(["fuser", "-k", "4173/tcp"], capture_output=True)
    shutil.rmtree(profile, ignore_errors=True)
    shutil.rmtree(profile + "-files", ignore_errors=True)
sys.exit(1 if failures else 0)
