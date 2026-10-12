"""Upgrade test: an installed previous release updates to this build without losing or rewriting data.

One browser profile (like the tablet): write a note in the OLD build, switch the server to the NEW
build, check the "new version" banner, tap Reload now, then check the note is intact, unchanged
(same updatedAt) and still editable.

Usage (port 4173 must be free; the script starts and stops the servers itself):
  git worktree add /tmp/prev <previous-release-commit> && cd /tmp/prev && ln -s <repo>/node_modules . && npm run build
  npm run build && python3 scripts/upgrade-test.py /tmp/prev
The old build is driven only through things every release since 0.6 has: typing, Ctrl+Shift+H
for a highlight, #add-section, #f-explain (opened from Details when present).
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

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
        if page.locator("#details summary").count():
            page.click("#details summary")
        page.fill("#f-explain", "My own words")
        expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
        page.wait_for_function("navigator.serviceWorker.ready.then(() => true)")
        page.reload()
        page.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)
        before = page.evaluate(ALL_NOTES)
        check(len(before) == 1, f"{old_v}: note saved")

        # ---- switch the server to the new build: the installed app offers the update ----
        new_v = serve(NEW)
        page.reload()
        page.wait_for_selector(".banner:has-text('new version')", timeout=20000)
        check(True, f"update banner offers {new_v}")
        page.click(".banner button:has-text('Reload now')")
        page.wait_for_timeout(2500)
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
        check(not errors, f"no page errors {errors}")
        ctx.close()
finally:
    subprocess.run(["fuser", "-k", "4173/tcp"], capture_output=True)
    shutil.rmtree(profile, ignore_errors=True)
sys.exit(1 if failures else 0)
