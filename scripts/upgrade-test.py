"""Upgrade test: an installed previous release updates to this build without losing or rewriting data.

One browser profile (like the tablet): in the OLD build write a note (highlight, second section, own
words, an image), add a word, mark the note reviewed (quick insights) and save a backup file. Switch
the server to the NEW build, check the "new version" banner, tap Reload now, then check:
- every note, word, image and stored setting is byte-for-byte what the old build stored;
- the database upgrade (0.8: Dexie v3) made one review card per quick insight, on the note's schedule;
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
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

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
        has_image = page.locator("#insert-menu:not([hidden])").count() > 0
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
        check(len(before) == 1, f"{old_v}: note saved")
        old = snapshot(page)
        check(len(old["vocab"]) == 1 and len(old["images"]) == (1 if has_image else 0), f"{old_v}: word saved, image saved ({len(old['images'])})")
        items = (before[0].get("insights") or {}).get("items", [])
        check([i["text"] for i in items] == ["Key line from the old build"], f"{old_v}: quick insight made by Mark reviewed")
        old_file = json.loads(open(backup).read())
        check(old_file["counts"] == {"notes": 1, "vocab": 1, "images": len(old["images"])}, f"{old_v}: backup file saved {old_file['counts']}")

        # ---- switch the server to the new build: the installed app offers the update ----
        new_v = serve(NEW)
        page.reload()
        page.wait_for_selector(".banner:has-text('new version')", timeout=20000)
        check(True, f"update banner offers {new_v}")
        page.click(".banner button:has-text('Reload now')")
        page.wait_for_timeout(2500)

        # ---- the database upgrade kept everything and made the review cards ----
        page.goto(URL + "#/notes")
        page.wait_for_selector(".note-card")  # the new build has opened (and upgraded) the database
        new = snapshot(page)
        check(key(new["notes"]) == key(old["notes"]), "every note is byte-for-byte what the old build stored")
        check(key(new["vocab"]) == key(old["vocab"]), "every word is unchanged")
        check(new["images"] == old["images"], f"every image is unchanged, bytes included ({len(new['images'])})")
        check(key(new["meta"]) == key(old["meta"]), "stored settings (streak days, last backup) unchanged")
        check(new["notes"][0].get("insights") == before[0].get("insights"), "quick insights unchanged")
        if ver(new_v) >= (0, 8, 0):
            check(page.evaluate(DB_VERSION) == 30, "database upgraded to Dexie v3")
            cards = page.evaluate(ALL, "cards") or []
            n0 = new["notes"][0]
            check(len(cards) == len(items) and [c["text"] for c in sorted(cards, key=lambda c: c["pos"])] == [i["text"] for i in items],
                  f"one review card per quick insight ({len(cards)})")
            check(all(c["noteId"] == n0["id"] and c["due"] == n0["nextReview"] and c["step"] == max(n0["reviewCount"] - 1, 0) and c["retiredAt"] is None for c in cards),
                  "cards start on the note's own schedule")
        page.goto(URL + "#/notes")
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
        check(after == before, "opening and leaving the note in the new build changed nothing stored")

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
        page.goto(URL + "#/settings")
        page.set_input_files("#import-file", backup)
        expect(page.locator(".import-result")).to_contain_text("Imported:", timeout=10000)
        res = page.inner_text(".import-result")
        check("0 added" in res and "0 updated" in res, f"old backup onto the upgraded tablet changes nothing: {res}")
        check((page.evaluate(ALL, "cards") or []) == cards_here, "no duplicate cards from re-importing")
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
        check("2 added" in res, f"fresh tablet: note and word added ({res})")
        got = snapshot(fresh)
        check(key(got["notes"]) == key(old_file["notes"]), "fresh tablet: notes exactly as in the backup file")
        check(key(got["vocab"]) == key(old_file["vocab"]), "fresh tablet: words exactly as in the backup file")
        check(got["images"] == sorted(old_file["images"], key=lambda i: i["id"]), "fresh tablet: images exactly as in the backup file, bytes included")
        if ver(new_v) >= (0, 8, 0):
            fc = fresh.evaluate(ALL, "cards") or []
            nf = old_file["notes"][0]
            check(len(fc) == len(items) and all(c["due"] == nf["nextReview"] for c in fc), f"fresh tablet: cards made from the quick insights ({len(fc)})")
            fresh.set_input_files("#import-file", backup)
            expect(fresh.locator(".import-result")).to_contain_text("0 added", timeout=10000)
            check(len(fresh.evaluate(ALL, "cards") or []) == len(fc), "fresh tablet: importing twice makes no duplicate cards")
        fresh_browser.close()
        check(not errors, f"no page errors after import {errors}")
finally:
    subprocess.run(["fuser", "-k", "4173/tcp"], capture_output=True)
    shutil.rmtree(profile, ignore_errors=True)
    shutil.rmtree(profile + "-files", ignore_errors=True)
sys.exit(1 if failures else 0)
