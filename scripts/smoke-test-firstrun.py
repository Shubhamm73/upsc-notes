"""First-run Today: one primary action, template starters, empty rings, then Resume."""
import sys

from playwright.sync_api import expect, sync_playwright

URL = "http://localhost:4173/upsc-notes/"
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    for width in (800, 1280):
        for scheme in ("light", "dark"):
            ctx = browser.new_context(viewport={"width": width, "height": 1280 if width == 800 else 800}, color_scheme=scheme)
            page = ctx.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(URL)
            caption = page.locator("section[aria-label='Subject strength'] .meta")
            expect(caption).to_have_text("Fills as you review your notes")
            label = f"{width}px {scheme}"
            primary = page.locator("main :is(.primary, .start-review):visible")
            check(primary.count() == 1 and primary.inner_text().strip() == "Write a new note"
                  and primary.get_attribute("href") == "#/n/new", f"{label}: hero is the only primary action in main")
            check(page.locator(".continue .eyebrow").text_content() == "Start from a template"
                  and page.locator(".continue h3").inner_text() == "Give your first note a shape", f"{label}: template introduction")
            starters = page.locator(".template-starts a")
            check(starters.evaluate_all("els => els.map(e => [e.textContent, e.getAttribute('href')])") == [
                ["GS answer", "#/n/new/gs-answer"], ["Topic sheet", "#/n/new/topic-sheet"],
                ["Current affairs", "#/n/new/current-affairs"]
            ] and page.locator(".template-starts .primary").count() == 0, f"{label}: three secondary template links")
            all_templates = page.locator(".template-all")
            check(all_templates.inner_text() == "All 19 templates" and all_templates.get_attribute("href") == "#/n/new"
                  and "button" not in (all_templates.get_attribute("class") or ""), f"{label}: plain link to all templates")
            check(caption.inner_text() == "Fills as you review your notes", f"{label}: empty rings caption")
            rings = page.locator(".rings svg")
            check(rings.count() == 8 and page.locator(".rings svg text").all_text_contents() == [""] * 8
                  and "–" not in page.locator(".rings").inner_text(), f"{label}: eight empty ring labels without dashes")
            check(all(value.endswith(": no notes yet") for value in rings.evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")),
                  f"{label}: empty rings retain accessible names")
            sizes = page.locator(".template-starts a, .template-all").evaluate_all(
                "els => els.map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))")
            check(min(sizes) >= 44, f"{label}: template links have 44px touch targets")
            check(not page.evaluate("document.documentElement.scrollWidth > innerWidth"), f"{label}: no horizontal overflow")

            # Follow a starter and save through the editor, then return to Today.
            starters.first.click()
            page.wait_for_selector("#f-title")
            page.fill("#f-title", "First GS answer")
            expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
            note_href = page.evaluate("location.hash")
            page.click(".nav-item[href='#/']")
            resume = page.locator("#resume")
            expect(resume).to_be_visible()
            check(resume.inner_text() == "Resume" and resume.get_attribute("href") == note_href
                  and page.locator(".continue-title").inner_text() == "First GS answer"
                  and page.locator(".continue .eyebrow").text_content() == "Continue writing", f"{label}: saved note shows the original Resume card")
            check(page.locator(".template-starts").count() == 0 and page.locator("#capture-save.primary").count() == 1,
                  f"{label}: notes-present actions stay unchanged")
            expect(caption).to_have_text("notes reviewed and on schedule")
            check("0%" in page.locator(".rings svg text").all_text_contents(), f"{label}: a note shows its numeric ring value")
            ctx.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

sys.exit(1 if failures else 0)
