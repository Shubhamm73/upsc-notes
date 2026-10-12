"""M1 smoke test against `npm run preview` (http://localhost:4173/upsc-notes/).

Checks: create a note, autosave, survive reload, backup download, import into a
fresh profile, and a reload while offline (service worker).
Run: npm run build && (npx vite preview --port 4173 &) && python3 scripts/smoke-test.py
"""
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []

    # ---- profile A: write, reload, back up ----
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null || true")
    page.click("#new-note")
    page.fill("#f-title", "Separation of powers")
    page.select_option("#f-subject", "GS2")
    page.fill("#f-topic", "Judiciary")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("Montesquieu.")
    page.keyboard.press("Enter")
    page.keyboard.type("Article 50: separate judiciary from executive.")
    page.fill("#f-explain", "No single organ holds all power.")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    check("#/n/" in page.url and not page.url.endswith("/new"), "URL switches from new to the note id after first save")

    page.reload()
    page.wait_for_selector(".note-card")
    check(page.locator(".note-card strong").first.inner_text() == "Separation of powers", "note survives reload")
    check(page.locator(".section-body .rich").first.inner_text().startswith("Montesquieu."), "body text survives reload")

    page.click("#mark-reviewed")
    page.wait_for_timeout(300)
    check("Next review" in page.locator(".review-info").inner_text(), "mark reviewed schedules next review")

    # backup reminder banner present before first backup
    check(page.locator(".banner.warn").count() >= 1, "backup reminder shows when no backup exists")

    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    path = OUT / dl.value.suggested_filename
    dl.value.save_as(path)
    data = json.loads(path.read_text())
    check(data["app"] == "upsc-notes" and data["counts"]["notes"] == 1, f"backup file holds 1 note ({path.name})")
    page.wait_for_timeout(300)
    check("today" in page.locator(".last-backup").inner_text(), "last backup shows today")

    # ---- offline reload (service worker) ----
    page.goto(URL + "#/notes")
    page.wait_for_function("navigator.serviceWorker.ready.then(() => true)")
    page.reload()  # make sure the page is controlled
    page.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)
    ctx.set_offline(True)
    page.reload()
    page.wait_for_selector(".note-card", timeout=10000)
    check(page.locator(".note-card").count() == 1, "app and note load while offline")
    ctx.set_offline(False)
    ctx.close()

    # ---- profile B: fresh device, import ----
    ctx2 = browser.new_context(viewport={"width": 800, "height": 1280})
    page2 = ctx2.new_page()
    page2.on("pageerror", lambda e: errors.append(str(e)))
    page2.goto(URL + "#/settings")
    page2.set_input_files("#import-file", str(path))
    expect(page2.locator(".import-result")).to_contain_text("1 added", timeout=5000)
    # importing again must not duplicate or overwrite
    page2.set_input_files("#import-file", str(path))
    expect(page2.locator(".import-result")).to_contain_text("0 added", timeout=5000)
    page2.goto(URL + "#/notes")
    page2.wait_for_selector(".note-card")
    check(page2.locator(".note-card").count() == 1, "import restores the note once, no duplicates")

    # bad file is refused without changes
    bad = OUT / "not-a-backup.json"
    bad.write_text('{"hello": 1}')
    page2.goto(URL + "#/settings")
    page2.set_input_files("#import-file", str(bad))
    expect(page2.locator(".import-result")).to_contain_text("isn't a UPSC Study Notes backup", timeout=5000)

    # portrait layout: list hidden while editing
    page2.goto(URL + "#/notes")
    page2.click(".note-card")
    page2.wait_for_selector("#f-title")
    check(not page2.locator(".pane-list").is_visible(), "portrait: list hides while a note is open")
    page2.screenshot(path=str(OUT / "portrait-editor.png"))
    ctx2.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print("screenshots in", OUT)
sys.exit(1 if failures else 0)
