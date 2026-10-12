"""UI-1 smoke test: shell, Today, quick capture, streak, search, settings, font styles. Needs preview on :4173."""
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
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---- empty Today ----
    page.goto(URL)
    page.wait_for_selector(".today-title")
    check("first note" in page.locator(".today-title").inner_text(), "empty Today invites the first note")
    check(page.locator(".rail").is_visible() and page.locator(".rail-new").is_visible(), "landscape: icon rail with New note")
    check(page.locator(".nav-item[aria-current='true']").inner_text().strip() == "Today", "Today is the current section")

    # ---- quick capture ----
    page.fill("#capture", "RBI kept the repo rate at 6.5%. Link to inflation targeting.")
    page.select_option("#capture-subject", "GS3")
    page.click("#capture-save")
    expect(page.locator(".today-title")).to_contain_text("1 thing is due", timeout=5000)
    check(page.locator("#start-review").get_attribute("href").startswith("#/n/"), "Start review opens the first due note")
    check("RBI kept the repo rate" in page.locator(".continue-title").inner_text(), "Continue writing shows the captured note")
    check("Start a streak" in page.locator(".streak").inner_text(), "no streak before any review")

    # ---- review builds the streak and a ring ----
    page.click("#start-review")
    page.wait_for_selector("#mark-reviewed")
    page.click("#mark-reviewed")
    page.wait_for_timeout(600)
    page.click(".nav-item:has-text('Today')")
    page.wait_for_selector(".today-title")
    expect(page.locator(".streak")).to_contain_text("1-day streak", timeout=5000)
    check("all caught up" in page.locator(".today-title").inner_text(), "Today shows caught up after review")
    gs3 = page.locator(".ring:has-text('GS3') svg").get_attribute("aria-label")
    check(gs3 == "GS3: 100 percent on schedule", f"GS3 ring fills ({gs3})")
    page.screenshot(path=str(OUT / "today-day.png"))

    # ---- ring opens Notes filtered to the subject ----
    page.click(".ring:has-text('GS3')")
    page.wait_for_selector(".note-card")
    check(page.locator(".subject-chip[aria-pressed='true']").inner_text().strip() == "GS3", "ring tap filters Notes by subject")

    # ---- Ctrl+K search ----
    page.keyboard.press("Control+k")
    page.wait_for_selector("#global-search")
    page.fill("#global-search", "inflation")
    page.wait_for_selector(".search-hit")
    page.keyboard.press("Enter")
    page.wait_for_selector("#f-title")
    check("RBI kept" in page.input_value("#f-title"), "Ctrl+K search opens the matching note")

    # ---- per-note font style ----
    page.click("#details summary")
    page.select_option("#note-style", "notebook")
    check("font-notebook" in page.locator(".editor").get_attribute("class"), "per-note font style applied")

    # ---- settings: theme + font ----
    page.click(".nav-item:has-text('More')")
    page.click("a.more-row:has-text('Settings')")
    page.click("[data-theme-opt='night']")
    check(page.evaluate("document.documentElement.dataset.theme") == "night", "night theme applied")
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    check(bg == "rgb(17, 21, 25)", f"night background ({bg})")
    page.click("[data-font-opt='editorial']")
    check(page.evaluate("document.documentElement.dataset.font") == "editorial", "app font style applied")
    head = page.evaluate("getComputedStyle(document.querySelector('h1')).fontFamily")
    check("Literata" in head, f"headings use Literata ({head})")
    page.reload()
    check(page.evaluate("document.documentElement.dataset.theme") == "night", "theme survives reload")
    page.goto(URL)
    page.wait_for_selector(".today-title")
    page.screenshot(path=str(OUT / "today-night.png"))
    page.click(".nav-item:has-text('More')")
    page.click("a.more-row:has-text('Settings')")
    page.click("[data-theme-opt='system']")
    page.click("[data-font-opt='desk']")
    check(page.evaluate("document.documentElement.dataset.theme") is None, "system theme clears override")

    # ---- portrait: bottom bar ----
    pc = browser.new_context(viewport={"width": 800, "height": 1280})
    pp = pc.new_page()
    pp.on("pageerror", lambda e: errors.append(str(e)))
    pp.goto(URL)
    pp.wait_for_selector(".today-title")
    box = pp.locator(".rail").bounding_box()
    check(box["y"] > 1100 and box["width"] > 700, f"portrait: navigation is a bottom bar ({box})")
    check(not pp.locator(".rail-new").is_visible(), "portrait: rail-only buttons hidden")
    check(pp.locator(".search-top").is_visible(), "portrait: search button in the top line")
    check(not pp.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "portrait: no sideways scroll")
    pp.screenshot(path=str(OUT / "today-portrait.png"))
    pp.goto(URL + "#/prefs")
    pp.wait_for_selector(".font-card")
    pp.screenshot(path=str(OUT / "settings-portrait.png"), full_page=True)
    pc.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print("artifacts in", OUT)
sys.exit(1 if failures else 0)
