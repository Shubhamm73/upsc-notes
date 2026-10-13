"""v0.9.1 smoke test: Share backup on the tablet.

Chrome on Android shares only some file types (pictures, PDF, audio, video, plain text …), so
navigator.canShare() said no to the .json backup and "Share backup" never appeared on the tablet.
The stub below follows Chrome's rule (extension AND type must be on its list); headless Chromium
on Linux has no share sheet of its own. The backup now goes out as ….json.txt (text/plain) and
imports like the .json file.
"""
import json
import re
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


# Chrome for Android's Web Share file rule (share_service_impl.cc): permitted extensions and types only.
ANDROID_SHARE = """(() => {
  const EXT = /\\.(bmp|css|csv|ehtml|flac|gif|htm|html|ico|jfif|jpeg|jpg|m4a|m4v|mp3|mp4|mpeg|mpg|oga|ogg|ogm|opus|pdf|pjp|pjpeg|png|shtm|shtml|svg|svgz|text|tif|tiff|txt|wav|weba|webm|webp|xbm)$/i;
  const TYPE = (t) => /^(image|audio|video)\\//.test(t) || ['application/pdf', 'text/plain', 'text/csv', 'text/html', 'text/css'].includes(t);
  const ok = (d) => !!d && Array.isArray(d.files) && d.files.length > 0 && d.files.every((f) => EXT.test(f.name) && TYPE(f.type));
  Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: function (d) { return ok(d); } });
  Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: async function (d) {
    if (!ok(d)) throw new DOMException('Permission denied', 'NotAllowedError');
    if (window.__cancel) throw new DOMException('Share canceled', 'AbortError');
    const f = d.files[0];
    window.__shared = { name: f.name, type: f.type, title: d.title, text: await f.text() };
  } });
})();"""

NO_SHARE = """(() => {
  for (const k of ['canShare', 'share']) { try { delete Navigator.prototype[k]; } catch (e) {} }
  Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: undefined });
})();"""


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []

    # ---- the tablet: share a backup ----
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    ctx.add_init_script(ANDROID_SHARE)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    check(page.evaluate("navigator.canShare({ files: [new File(['{}'], 'b.json', { type: 'application/json' })] })") is False,
          "the stub refuses a .json file, like Chrome on Android (the 0.9.0 bug)")
    page.click("#new-note")
    page.click(".tpl-card[data-template='blank']")
    page.fill("#f-title", "Fiscal federalism")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("Article 280: the Finance Commission.")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)

    page.goto(URL + "#/settings")
    expect(page.locator(".last-backup")).to_have_text("Last backup: never.", timeout=5000)
    check(page.locator("#backup-share").is_visible(), "Share backup appears where Chrome shares only its file types")

    # cancel the share sheet: nothing counts as backed up
    page.evaluate("window.__cancel = true")
    page.click("#backup-share")
    expect(page.locator(".toast")).to_have_text("Backup not shared.", timeout=5000)
    expect(page.locator(".last-backup")).to_have_text("Last backup: never.", timeout=5000)
    check(True, "cancelling the share sheet leaves 'Last backup: never.'")

    page.evaluate("window.__cancel = false")
    page.click("#backup-share")
    page.wait_for_function("!!window.__shared", timeout=10000)
    shared = page.evaluate("window.__shared")
    check(re.fullmatch(r"upsc-notes-backup-\d{4}-\d{2}-\d{2}\.json\.txt", shared["name"]) is not None, f"shared file is named ….json.txt ({shared['name']})")
    check(shared["type"] == "text/plain", "shared file is plain text, a type Chrome shares")
    check(shared["title"] == shared["name"], "share title is the file name")
    data = json.loads(shared["text"])
    check(data.get("app") == "upsc-notes" and data["counts"]["notes"] == 1, "shared file is the full backup (1 note)")
    check(any(n.get("title") == "Fiscal federalism" for n in data.get("notes", [])), "the note is inside the shared backup")
    expect(page.locator(".toast")).to_contain_text("Backup saved: 1 notes", timeout=5000)
    expect(page.locator(".last-backup")).to_have_text("Last backup: today.", timeout=5000)
    check(True, "a shared backup counts as today's backup")

    # Save to Downloads is unchanged: still a .json file
    with page.expect_download() as dl:
        page.click("#backup-download")
    check(dl.value.suggested_filename.endswith(".json"), f"Save to Downloads still saves .json ({dl.value.suggested_filename})")
    json_path = OUT / dl.value.suggested_filename
    dl.value.save_as(json_path)
    txt_path = OUT / shared["name"]
    txt_path.write_text(shared["text"])
    accept = page.get_attribute("#import-file", "accept") or ""
    check(".txt" in accept and "text/plain" in accept and ".json" in accept, f"Import's file picker offers .json and .txt ({accept})")
    ctx.close()

    # ---- a fresh tablet: restore from the shared .json.txt (as Drive gives it back) ----
    ctx2 = browser.new_context(viewport={"width": 800, "height": 1280})
    ctx2.add_init_script(ANDROID_SHARE)
    page2 = ctx2.new_page()
    page2.on("pageerror", lambda e: errors.append(str(e)))
    page2.goto(URL + "#/settings")
    page2.set_input_files("#import-file", files=[{"name": txt_path.name, "mimeType": "text/plain", "buffer": txt_path.read_bytes()}])
    expect(page2.locator(".import-result")).to_contain_text("1 added", timeout=5000)
    page2.set_input_files("#import-file", files=[{"name": txt_path.name, "mimeType": "text/plain", "buffer": txt_path.read_bytes()}])
    expect(page2.locator(".import-result")).to_contain_text("0 added", timeout=5000)
    check(True, "a ….json.txt backup imports, and twice adds nothing")
    page2.set_input_files("#import-file", str(json_path))
    expect(page2.locator(".import-result")).to_contain_text("0 added", timeout=5000)
    check(True, "the .json from Downloads still imports")
    bad = OUT / "notes.txt"
    bad.write_text("just some text")
    page2.set_input_files("#import-file", str(bad))
    expect(page2.locator(".import-result")).to_contain_text("couldn't be read as a backup", timeout=5000)
    check(".json.txt" in page2.inner_text(".import-result"), "a text file that isn't a backup is refused, naming both file kinds")
    page2.goto(URL + "#/notes")
    page2.wait_for_selector(".note-card")
    check(page2.locator(".note-card").count() == 1 and "Fiscal federalism" in page2.inner_text(".note-card"), "the restored note is listed once")
    page2.locator(".note-card").first.click()
    page2.wait_for_selector("#f-title")
    check(page2.locator(".section-body .rich").first.inner_text().startswith("Article 280"), "the restored note's text is intact")
    ctx2.close()

    # ---- a browser with no share sheet: the button stays hidden ----
    ctx3 = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx3.add_init_script(NO_SHARE)
    page3 = ctx3.new_page()
    page3.on("pageerror", lambda e: errors.append(str(e)))
    page3.goto(URL + "#/settings")
    page3.wait_for_selector("#backup-download")
    check(not page3.locator("#backup-share").is_visible(), "no share sheet: Share backup stays hidden, Save to Downloads remains")
    ctx3.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
