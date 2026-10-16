"""0.14 smoke test: themes and Note look. Needs `vite preview` on :4173.

Settings → Theme: Match the tablet, nine themes (Study desk, Night, Slate, True black, Sepia, Ocean, Forest
night, Rose, High contrast) and Custom. Every theme passes AA for text and muted text on the page and on
cards (High contrast AAA), and its accent reads on cards. Custom: a base theme, an accent (made darker or
lighter until it reads), roundness 0-24 and spacing Compact / Regular / Roomy; touch targets stay 44 px.
A theme saved by an older version ("night") stays Night. Note ⋯ → Note look: cover, heading style set,
font and accent for this note, its whole subject or every note; the note's own look wins; one Undo step;
plain headings take the set without the doc changing; the PDF prints the look on white. Backup format 8
carries the looks and the theme.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""
META = """(key) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('meta').objectStore('meta').get(key); g.onsuccess = () => { q.result.close(); r(g.result ? g.result.value : null); }; }; })"""
# contrast of two CSS colours as the page resolves them
CONTRAST = """([a, b]) => {
  const rgb = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c.match(/[\\d.]+/g).slice(0, 3).map(Number); };
  const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const [x, y] = [lum(rgb(a)), lum(rgb(b))]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}"""
THEMES = ["day", "night", "slate", "black", "sepia", "ocean", "forest", "rose", "contrast"]


def ratio(page, a, b):
    return page.evaluate(CONTRAST, [a, b])


def look_sheet(page):
    page.click("#note-more")
    page.click(".popover button[aria-label='Note look']")
    page.wait_for_selector("#look-sheet")


def new_note(page, title, folder, text):
    page.goto(URL + "#/n/new/topic-sheet")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", title)
    page.click("#f-subject")
    page.click(f"#move-sheet [data-folder='{folder}']")
    page.locator(".section-body .rich").first.click()
    page.keyboard.type(text)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ================= a theme from before 0.14 stays =================
    page.goto(URL)
    page.evaluate("localStorage.setItem('upsc.theme', 'night')")
    page.reload()
    page.wait_for_selector(".today-title")
    check(page.evaluate("document.documentElement.dataset.theme") == "night" and page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(17, 21, 25)", "an older 'night' setting opens as Night")

    # ================= the picker =================
    page.goto(URL + "#/prefs")
    page.wait_for_selector(".th-tile")
    opts = page.locator(".th-tile").evaluate_all("els => els.map(e => e.dataset.themeOpt)")
    check(opts == ["system"] + THEMES + ["custom"], f"Match the tablet, 9 themes and Custom ({opts})")
    sizes = page.locator(".th-tile").evaluate_all("els => els.map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))")
    check(min(sizes) >= 44, f"theme tiles are touch-sized (smallest {min(sizes):.0f}px)")
    check(page.locator(".th-tile[aria-checked='true']").get_attribute("data-theme-opt") == "night", "the current theme is marked")

    # ================= every theme: applied, readable =================
    for t in THEMES:
        page.click(f"[data-theme-opt='{t}']")
        page.wait_for_timeout(100)
        aaa = t == "contrast"
        need = 7 if aaa else 4.5
        check(page.evaluate("document.documentElement.dataset.theme") == t, f"{t}: applied")
        worst = min(ratio(page, f"var({fg})", f"var({bg})") for fg in ("--fg", "--muted") for bg in ("--bg", "--surface", "--chip"))
        check(worst >= need, f"{t}: text and muted text {worst:.2f}:1 (needs {need})")
        acc = min(ratio(page, "var(--accent)", f"var({bg})") for bg in ("--bg", "--surface"))
        check(acc >= need, f"{t}: accent reads as text {acc:.2f}:1")
        btn = ratio(page, "var(--accent-fg)", "var(--accent)")
        check(btn >= need, f"{t}: text on accent buttons {btn:.2f}:1")
        sub = min(ratio(page, f"var(--sub-{k})", "var(--surface)") for k in ("gs1", "gs2", "gs3", "gs4", "ca", "essay"))
        check(sub >= (4.5 if aaa else 3), f"{t}: subject colours stand out on cards {sub:.2f}:1")
        page.screenshot(path=str(OUT / f"settings-{t}.png"))
    page.reload()
    page.wait_for_selector(".th-tile")
    check(page.evaluate("document.documentElement.dataset.theme") == "contrast", "the theme survives a reload")
    meta_color = page.evaluate("document.querySelector('meta[name=theme-color]')?.content")
    check(bool(meta_color), f"the browser bar follows the theme ({meta_color})")

    # ================= Custom =================
    page.click("[data-theme-opt='custom']")
    page.wait_for_selector("#custom-theme:not([hidden])")
    check(page.evaluate("document.documentElement.dataset.theme") == "custom", "Custom: applied")
    page.select_option("#custom-base", "night")
    page.wait_for_timeout(100)
    check(page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(17, 21, 25)", "Custom: starts from Night")
    page.click("#custom-accent [data-accent='#3f51a3']")  # indigo: too dark on Night, made lighter
    page.wait_for_timeout(100)
    acc = min(ratio(page, "var(--accent)", f"var({bg})") for bg in ("--bg", "--surface"))
    check(acc >= 4.5, f"Custom: a dark accent on Night is lightened until it reads ({acc:.2f}:1)")
    check(ratio(page, "var(--accent-fg)", "var(--accent)") >= 4.5, "Custom: button text on that accent reads")
    page.locator("#custom-round").fill("0")
    page.locator("#custom-round").dispatch_event("change")
    page.wait_for_timeout(100)
    r = page.evaluate("getComputedStyle(document.querySelector('.card-block')).borderTopLeftRadius")
    check(r == "0px", f"Custom: roundness 0 squares the cards ({r})")
    page.locator("#custom-round").fill("24")
    page.locator("#custom-round").dispatch_event("change")
    page.wait_for_timeout(100)
    r = page.evaluate("getComputedStyle(document.querySelector('.card-block')).borderTopLeftRadius")
    check(r == "28px", f"Custom: roundness 24 rounds them more ({r})")
    page.click("#custom-density [data-density='compact']")
    pad = page.evaluate("getComputedStyle(document.querySelector('.card-block')).paddingTop")
    check(page.evaluate("document.documentElement.dataset.density") == "compact" and pad == "12px", f"Custom: Compact spacing ({pad})")
    small = page.locator("button:visible").evaluate_all("els => els.filter(e => !e.closest('.th-tile')).map(e => e.getBoundingClientRect().height).filter(h => h > 0)")
    check(min(small) >= 44, f"Compact keeps 44 px buttons (smallest {min(small):.0f}px)")
    page.click("#custom-density [data-density='roomy']")
    pad = page.evaluate("getComputedStyle(document.querySelector('.card-block')).paddingTop")
    check(pad == "24px", f"Custom: Roomy spacing ({pad})")
    page.reload()
    page.wait_for_selector("#custom-theme:not([hidden])")
    c = json.loads(page.evaluate("localStorage.getItem('upsc.custom')"))
    check(c["base"] == "night" and c["accent"] == "#3f51a3" and c["round"] == 24 and c["density"] == "roomy", f"Custom survives a reload ({c})")
    page.screenshot(path=str(OUT / "custom.png"), full_page=True)
    page.click("[data-theme-opt='system']")
    check(page.evaluate("document.documentElement.dataset.theme") is None and "--bg" not in (page.evaluate("document.documentElement.getAttribute('style')") or "") and page.evaluate("document.documentElement.dataset.density") is None, "Match the tablet clears the theme, its colours and spacing")
    page.click("[data-theme-opt='day']")

    # ================= Note look =================
    new_note(page, "Look one", "gen:GS2", "Parliament")
    page.keyboard.press("Enter")
    page.keyboard.type("/heading")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.keyboard.type("Lok Sabha")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    check(page.locator("#note-cover").is_hidden() and page.evaluate("document.querySelector('.canvas').dataset.hset") is None, "a note starts with no cover and classic headings")
    look_sheet(page)
    btns = page.locator("#look-sheet button:visible").evaluate_all("els => els.map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))")
    check(min(btns) >= 44, f"Note look: touch-sized (smallest {min(btns):.0f}px)")
    check(page.locator("#look-headings .hset-tile").count() == 8 and page.locator("#look-accent .sw").count() == 14, "8 heading sets, subject colour + 13 accents")
    page.click("#look-cover [data-v='subject']")
    page.click("#look-headings [data-set='pill']")
    page.click("#look-accent [data-accent='gs4']")
    page.select_option("#look-font", "editorial")
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") == "pill", "Note look previews on the note while he picks")
    page.click("#look-apply")
    page.wait_for_timeout(300)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    n = page.evaluate(NOTE, "Look one")
    check(n["look"] == {"cover": "subject", "headings": "pill", "accent": "gs4"} and n["fontStyle"] == "editorial", f"stored on the note ({n.get('look')}, {n.get('fontStyle')})")
    check(page.locator("#note-cover").is_visible(), "the cover shows")
    subj = page.evaluate("document.querySelector('.canvas').style.getPropertyValue('--subj')")
    check(subj == "var(--sub-gs4)", f"the accent colours the note ({subj})")
    check(page.locator(".canvas.font-editorial").count() == 1, "the font applies")
    h2 = page.locator(".section-body h2").first
    check(h2.get_attribute("data-look") == "pill", "a plain heading takes the set's look")
    docs = json.dumps(n["sections"])
    check('"look"' not in docs, "the doc itself is not changed")
    check(ratio(page, "var(--fg)", "var(--bg)") >= 4.5, "background and text still follow the app theme")
    page.click("#note-undo")
    page.wait_for_timeout(300)
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") is None and page.locator("#note-cover").is_hidden(), "one Undo takes the whole look off")
    page.click("#note-redo")
    page.wait_for_timeout(300)
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") == "pill", "Redo puts it back")
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    # cancel leaves it as it was
    look_sheet(page)
    page.click("#look-headings [data-set='tab']")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") == "pill", "closing without Apply changes nothing")
    page.screenshot(path=str(OUT / "note-look.png"))

    # PDF: cover and pill headings, on white
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / "look.pdf"
    dl.value.save_as(pdf)
    page.click("#details summary")
    subprocess.run(["pdftoppm", "-png", "-r", "50", "-f", "1", "-l", "1", str(pdf), str(OUT / "look")])
    img = Image.open(next(OUT.glob("look-*.png"))).convert("RGB")
    w, hgt = img.size
    corner = img.getpixel((5, 5))
    band = img.getpixel((w // 2, int(hgt * 0.085)))
    check(corner == (255, 255, 255), f"PDF: the page stays white ({corner})")
    check(band != (255, 255, 255), f"PDF: the cover band prints ({band})")
    text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    check("Key terms" in text and "Lok Sabha" in text, "PDF: section titles and headings print")

    # ================= subject and every-note looks =================
    new_note(page, "Look two", "gen:GS2", "Rajya Sabha")
    look_sheet(page)
    page.click("#look-headings [data-set='banner']")
    page.click("#look-scope [data-v='subject']")
    page.click("#look-apply")
    page.wait_for_timeout(400)
    looks = page.evaluate(META, "looks")
    check(looks and "gen:GS2" in looks["subjects"] and looks["subjects"]["gen:GS2"]["look"]["headings"] == "banner", f"a subject look is kept as a default ({looks})")
    n2 = page.evaluate(NOTE, "Look two")
    check("look" not in n2, "applying to the subject leaves this note without a look of its own")
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") == "banner", "this note shows the subject look")
    page.goto(URL + "#/n/" + n["id"])
    page.wait_for_selector(".section-body h2")
    page.wait_for_timeout(300)
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") == "pill", "a note with its own look keeps it")
    new_note(page, "Look three", "gen:GS3", "Inflation")
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") is None, "a note in another subject is untouched")
    look_sheet(page)
    page.click("#look-headings [data-set='numbered']")
    page.click("#look-scope [data-v='everywhere']")
    page.click("#look-apply")
    page.wait_for_timeout(400)
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") == "numbered", "every-note look applies here")
    num = page.evaluate("getComputedStyle(document.querySelector('.section-head'), '::before').content")
    check("snum" in num, f"Numbered: section titles are numbered ({num})")
    page.goto(URL + "#/n/" + n2["id"])
    page.wait_for_selector(".section-heading")
    page.wait_for_timeout(300)
    check(page.evaluate("document.querySelector('.canvas').dataset.hset") == "banner", "the subject look wins over every-note's")
    # undo of a subject apply (on note three, same session)
    page.goto(URL + "#/n/" + page.evaluate(NOTE, "Look three")["id"])
    page.wait_for_selector(".section-heading")
    look_sheet(page)
    page.click("#look-headings [data-set='boxed']")
    page.click("#look-scope [data-v='subject']")
    page.click("#look-apply")
    page.wait_for_timeout(400)
    check(page.evaluate(META, "looks")["subjects"]["gen:GS3"]["look"]["headings"] == "boxed", "subject look for GS3")
    page.click("#note-undo")
    page.wait_for_timeout(500)
    lk = page.evaluate(META, "looks")["subjects"]["gen:GS3"]
    check(lk.get("deleted") is True and page.evaluate("document.querySelector('.canvas').dataset.hset") == "numbered", "Undo takes the subject look back off (every-note look shows again)")
    # reset own look
    page.goto(URL + "#/n/" + n["id"])
    page.wait_for_selector(".section-body h2")
    look_sheet(page)
    page.click("#look-reset")
    page.wait_for_timeout(400)
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)
    page.wait_for_timeout(300)
    n1 = page.evaluate(NOTE, "Look one")
    check("look" not in n1 and "fontStyle" not in n1 and page.evaluate("document.querySelector('.canvas').dataset.hset") == "banner", "Use default look: the note follows its subject again")

    # every theme: the note reads
    for t in THEMES:
        page.evaluate(f"localStorage.setItem('upsc.theme', '{t}')")
        page.reload()
        page.wait_for_selector(".section-heading")
        cs = page.evaluate("(() => { const s = getComputedStyle(document.querySelector('.section-heading')); return [s.color, s.backgroundColor]; })()")
        # banner = solid ribbon: the title sits on its own fill, not the page
        r = ratio(page, cs[0], cs[1] if cs[1] not in ("rgba(0, 0, 0, 0)", "transparent") else "var(--bg)")
        check(r >= (7 if t == "contrast" else 4.5), f"{t}: section titles read in a note look ({r:.2f}:1)")
        page.screenshot(path=str(OUT / f"note-{t}.png"))
    page.evaluate("localStorage.setItem('upsc.theme', 'day')")

    # ================= backup format 8 =================
    page.goto(URL + "#/prefs")
    page.click("[data-theme-opt='sepia']")
    page.goto(URL + "#/settings")
    with page.expect_download() as dl:
        page.click("#backup-download")
    bpath = OUT / "themes-backup.json"
    dl.value.save_as(bpath)
    bk = json.loads(bpath.read_text())
    check(bk["format"] == 8 and bk["looks"]["everywhere"]["look"]["headings"] == "numbered" and bk["looks"]["subjects"]["gen:GS2"]["look"]["headings"] == "banner", "backup format 8 carries the looks")
    check(json.dumps(bk["settings"]).find("sepia") >= 0, "and the theme")
    fresh = browser.new_context(viewport={"width": 1280, "height": 800})
    fp = fresh.new_page()
    fp.on("pageerror", lambda e: errors.append(str(e)))
    fp.goto(URL + "#/settings")
    fp.wait_for_selector("#import-file", state="attached")
    fp.set_input_files("#import-file", str(bpath))
    expect(fp.locator(".import-result")).to_contain_text("added", timeout=5000)
    fl = fp.evaluate(META, "looks")
    check(fl["subjects"]["gen:GS2"]["look"]["headings"] == "banner" and fl["subjects"]["gen:GS3"].get("deleted") is True, "a fresh tablet gets the looks (a reset stays reset)")
    check(fp.evaluate("document.documentElement.dataset.theme") == "sepia", "and the theme")
    fp.goto(URL + "#/n/" + n2["id"])
    fp.wait_for_selector(".section-heading")
    fp.wait_for_timeout(300)
    check(fp.evaluate("document.querySelector('.canvas').dataset.hset") == "banner", "notes there show the subject look")
    fresh.close()

    # ================= phone =================
    ph = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    pp = ph.new_page()
    pp.on("pageerror", lambda e: errors.append(str(e)))
    pp.goto(URL + "#/prefs")
    pp.wait_for_selector(".th-tile")
    check(pp.evaluate("document.documentElement.scrollWidth") <= 390, "phone: the theme picker fits")
    pp.goto(URL + "#/n/new/blank")
    pp.wait_for_selector("#f-title")
    pp.locator("#note-more").dispatch_event("click")  # the note header is wider than a phone (since 0.11)
    pp.locator(".popover button[aria-label='Note look']").dispatch_event("click")
    pp.wait_for_selector("#look-sheet")
    bb = pp.locator("#look-sheet").bounding_box()
    vw = pp.evaluate("innerWidth")
    over = pp.evaluate("(() => { const s = document.querySelector('#look-sheet'); return s.scrollWidth - s.clientWidth; })()")
    check(bb["x"] >= 0 and bb["x"] + bb["width"] <= vw and over <= 0, f"phone: Note look fits the screen and nothing in it spills ({bb}, viewport {vw}, spill {over})")
    pp.screenshot(path=str(OUT / "look-phone.png"))
    ph.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
sys.exit(1 if failures else 0)
