"""M3 smoke test: vocabulary. Needs `vite preview` on :4173."""
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
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/vocab")
    page.click("#new-word")
    page.fill("#v-word", "Ameliorate")
    page.fill("#v-meaning", "To make something bad better")
    page.fill(".use-sentence", "Land reforms sought to ameliorate rural distress.")
    page.select_option(".use-meta select", "GS answer")
    page.click("#add-use")
    page.locator(".use-sentence").nth(1).fill("Welfare schemes ameliorate inequality.")
    page.fill("#v-syn", "improve")
    page.keyboard.press("Enter")
    page.fill("#v-syn", "alleviate, mitigate")
    page.fill("#v-ant", "worsen")
    page.keyboard.press("Enter")
    page.fill("#v-syn", "Improve")  # duplicate, ignored
    page.keyboard.press("Enter")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)
    check(page.locator(".grid2 .field").nth(0).locator(".chip").count() == 3, "3 synonyms, duplicate ignored")

    page.reload()
    page.wait_for_selector("#v-word")
    check(page.input_value("#v-word") == "Ameliorate", "word persists")
    check(page.locator(".use-sentence").count() == 2, "both examples persist")
    check(page.locator(".use-meta select").first.input_value() == "GS answer", "example context persists")
    check(page.locator(".grid2 .field").nth(1).locator(".chip").count() == 1, "antonym persists")

    # remove a synonym chip
    page.click("button[aria-label='Remove mitigate']")
    page.wait_for_timeout(1200)
    check(page.locator(".grid2 .field").nth(0).locator(".chip").count() == 2, "chip removed")

    # review
    page.click("#v-reviewed")
    page.wait_for_timeout(300)
    check("Next review" in page.locator(".review-info").inner_text(), "review scheduled")

    # duplicate warning
    page.click("#new-word")
    page.fill("#v-word", "ameliorate ")
    check(page.locator(".dup").is_visible(), "duplicate word warning shows")
    page.fill("#v-word", "Pragmatic")
    page.fill("#v-meaning", "Dealing with things sensibly")
    expect(page.locator(".save-status")).to_have_text("Saved on this tablet", timeout=5000)

    # search
    page.goto(URL + "#/vocab")
    page.fill("#vocab-search", "alleviate")
    check(page.locator("#vocab-list .note-card").count() == 1, "search finds by synonym")
    page.fill("#vocab-search", "")
    check(page.locator("#vocab-list .note-card").count() == 2, "list shows both words")
    order = page.eval_on_selector_all("#vocab-list strong", "e => e.map(x => x.textContent)")
    check(order == ["Ameliorate", "Pragmatic"], f"alphabetical order {order}")

    # backup includes vocab
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    path = OUT / dl.value.suggested_filename
    dl.value.save_as(path)
    b = json.loads(path.read_text())
    w = next(x for x in b["vocab"] if x["word"] == "Ameliorate")
    check(b["counts"]["vocab"] == 2 and w["synonyms"] == ["improve", "alleviate"], f"backup holds vocab {w['synonyms']}")

    # portrait
    pc = browser.new_context(viewport={"width": 800, "height": 1280})
    pp = pc.new_page()
    pp.goto(URL + "#/v/new")
    pp.wait_for_selector("#v-word")
    pp.fill("#v-word", "Ubiquitous")
    check(not pp.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "portrait: no sideways scroll")
    pp.screenshot(path=str(OUT / "m3-portrait.png"))
    pc.close()

    page.goto(URL + "#/v/" + w["id"])
    page.wait_for_selector("#v-word")
    page.screenshot(path=str(OUT / "m3-landscape.png"))
    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
