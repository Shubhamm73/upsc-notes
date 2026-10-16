"""0.13 smoke test: the mind map. Needs `vite preview` on :4173.

Insert → Mind map adds a `mindMap` node (a centre and three ideas) and opens the full-screen editor:
+ Child (Tab), + Sibling (Enter), F2 label, Delete, arrows, Space folds, Ctrl+Z / Ctrl+Y and the Undo / Redo
buttons, drag a node (what hangs under it moves too), Tidy up, long-press folds ("+N"), double-tap edits the
label, colour and shape per node, Radial / Tree, pinch zoom, two-finger and one-finger pan, Ctrl+wheel zoom.
Done, Android back, leaving the note and the app going to the background all save; one note Undo takes back a
whole editing session. Every label is searchable, a marked idea is a key line. In the PDF a big map gets its
own landscape page and folded branches print unfolded.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from pypdf import PdfReader

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []
TITLE = "Federalism map"


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


NOTE = """(title) => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
  const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result.find(n => n.title === title) || null); }; }; })"""
IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""


def maps(page, title=TITLE):
    return [b for b in page.evaluate(NOTE, title)["sections"][0]["doc"]["content"] if b["type"] == "mindMap"]


def texts(page):
    return [n["text"] for n in maps(page)[0]["attrs"]["nodes"]]


def saved(page):
    expect(page.locator("#save-state")).to_have_attribute("data-state", "saved", timeout=5000)


def settle(page):
    """Autosave waits ~0.8 s after the last change; read IndexedDB only after it."""
    page.wait_for_timeout(1100)
    saved(page)


def to_end(page):
    page.evaluate("""() => { const pm = document.querySelector('.section-body .ProseMirror'); pm.focus();
      const s = getSelection(); s.selectAllChildren(pm); s.collapseToEnd(); }""")
    page.wait_for_timeout(100)


def count(page):
    return page.locator(".mm-count").text_content()


def node(page, text):
    """The idea whose label (its wrapped lines joined) is `text`; an empty locator when there is none."""
    nid = page.evaluate("""(t) => { const g = [...document.querySelectorAll('.mm-svg .mm-node')].find(g =>
      [...g.children].filter(c => c.tagName === 'text').map(c => c.textContent).join(' ') === t); return g ? g.dataset.id : '-'; }""", text)
    return page.locator(f".mm-svg .mm-node[data-id='{nid}']")


def centre(loc):
    b = loc.bounding_box()
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def at(page, text):
    """A node's place in map units (its translate)."""
    t = node(page, text).get_attribute("transform")
    x, y = re.match(r"translate\(([-\d.]+),([-\d.]+)\)", t).groups()
    return float(x), float(y)


def view(page):
    t = page.locator(".mm-svg > g").get_attribute("transform")
    tx, ty, k = re.match(r"translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)", t).groups()
    return float(tx), float(ty), float(k)


def label(page):
    return page.locator("#mm-label").input_value()


def tap(page, text):
    page.mouse.click(*centre(node(page, text)))
    page.wait_for_timeout(400)  # past the double-tap window


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True, has_touch=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", TITLE)
    page.locator(".section-body .rich").first.click()
    page.keyboard.type("Map below.")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    saved(page)

    # ================= Insert → Mind map =================
    page.keyboard.type("/mind map")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.wait_for_selector(".mm-overlay")
    check(page.locator(".mm-svg .mm-node").count() == 4 and count(page) == "4 ideas · 2 levels", f"Insert → Mind map opens the editor on a centre and three ideas ({count(page)})")
    check(label(page) == "Main idea" and page.locator("#mm-del").is_disabled(), "the centre is selected and can't be deleted")
    check(page.evaluate("() => document.activeElement.classList.contains('mm-canvas')"), "the map has the keyboard")
    small = page.locator(".mm-overlay button").evaluate_all("els => els.filter(e => e.offsetParent).map(e => [e.getAttribute('aria-label') || e.textContent, Math.min(e.offsetWidth, e.offsetHeight)]).filter(v => v[1] < 44)")
    check(not small, f"every editor button is at least 44 px ({small})")
    check(page.locator("#mm-done").bounding_box()["height"] >= 48, "Done is the primary button")
    settle(page)
    m0 = maps(page)
    check(len(m0) == 1 and [n["text"] for n in m0[0]["attrs"]["nodes"]] == ["Main idea", "Idea 1", "Idea 2", "Idea 3"], "the new map is in the note at once")

    # ================= keys: Tab, Enter, F2, Esc, arrows, Delete =================
    page.keyboard.press("Tab")
    check(page.evaluate("() => document.activeElement.id") == "mm-label" and label(page) == "New idea", "Tab adds a child and puts the cursor in its label")
    page.keyboard.type("Fiscal federalism")
    page.wait_for_timeout(100)  # the map redraws on the next frame
    check(node(page, "Fiscal federalism").count() == 1, "the map follows the label as he types")
    page.keyboard.press("Enter")
    page.keyboard.type("Cooperative federalism")
    page.keyboard.press("Escape")
    check(page.locator(".mm-overlay").count() == 1 and page.evaluate("() => document.activeElement.classList.contains('mm-canvas')"), "Esc in the label goes back to the map, the editor stays open")
    check(count(page) == "6 ideas · 2 levels", f"Enter adds a sibling ({count(page)})")
    page.keyboard.press("Tab")
    page.keyboard.type("NITI Aayog")
    page.keyboard.press("Escape")
    check(count(page) == "7 ideas · 3 levels", f"…a child of a child is level 3 ({count(page)})")
    page.keyboard.press("F2")
    check(page.evaluate("() => document.activeElement.id") == "mm-label", "F2 edits the label")
    page.keyboard.press("End")
    page.keyboard.type(" (2015)")
    page.keyboard.press("Escape")
    page.wait_for_timeout(100)
    check(node(page, "NITI Aayog (2015)").count() == 1, "…and the edit shows")
    page.keyboard.press("Delete")
    check(count(page) == "6 ideas · 2 levels" and node(page, "NITI Aayog (2015)").count() == 0 and label(page) == "Cooperative federalism", "Delete removes the idea and selects its parent")
    page.keyboard.press("Control+z")
    check(node(page, "NITI Aayog (2015)").count() == 1, "Ctrl+Z brings it back")
    page.keyboard.press("Control+y")
    check(node(page, "NITI Aayog (2015)").count() == 0, "Ctrl+Y deletes it again")
    page.click("#mm-undo")
    check(node(page, "NITI Aayog (2015)").count() == 1 and page.locator("#mm-redo").is_enabled(), "the Undo button too")
    page.click("#mm-redo")
    page.click("#mm-undo")
    page.locator(".mm-canvas").focus()
    tap(page, "Main idea")
    page.keyboard.press("ArrowRight")
    right = label(page)
    check(right not in ("Main idea", ""), f"arrows move between ideas ({right})")
    tap(page, "Main idea")
    page.keyboard.press("ArrowLeft")
    check(label(page) not in ("Main idea", right), f"…in the direction pressed ({label(page)})")

    # ================= double-tap, drag, Tidy up =================
    page.mouse.dblclick(*centre(node(page, "Idea 1")))
    page.wait_for_timeout(100)
    check(page.evaluate("() => document.activeElement.id") == "mm-label" and label(page) == "Idea 1", "double-tap edits a label")
    page.keyboard.press("ControlOrMeta+a")
    page.keyboard.type("Constitutional features")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    a0, b0 = at(page, "Cooperative federalism"), at(page, "NITI Aayog (2015)")
    _, _, k = view(page)
    x, y = centre(node(page, "Cooperative federalism"))
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 60, y + 40, steps=8)
    page.mouse.up()
    page.wait_for_timeout(200)
    a1, b1 = at(page, "Cooperative federalism"), at(page, "NITI Aayog (2015)")
    da, db = (a1[0] - a0[0], a1[1] - a0[1]), (b1[0] - b0[0], b1[1] - b0[1])
    check(abs(da[0] - 60 / k) < 3 and abs(da[1] - 40 / k) < 3, f"dragging a node moves it with the finger ({da[0]:.0f},{da[1]:.0f} at k {k})")
    check(abs(da[0] - db[0]) < 1 and abs(da[1] - db[1]) < 1, "…and what hangs under it moves too")
    page.click("#mm-tidy")
    page.wait_for_timeout(200)
    check(at(page, "Cooperative federalism") == a0 and at(page, "NITI Aayog (2015)") == b0, "Tidy up puts every idea back in its place")

    # ================= fold: long-press, Space, the Fold button =================
    x, y = centre(node(page, "Cooperative federalism"))
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(650)
    page.mouse.up()
    page.wait_for_timeout(200)
    check(node(page, "NITI Aayog (2015)").count() == 0 and node(page, "Cooperative federalism").locator("text", has_text="+1").count() == 1, "long-press folds a branch and shows +1")
    check(page.locator("#mm-fold").get_attribute("aria-pressed") == "true", "…and the Fold button shows it")
    page.locator(".mm-canvas").focus()
    page.keyboard.press(" ")
    check(node(page, "NITI Aayog (2015)").count() == 1, "Space unfolds it")
    page.click("#mm-fold")
    check(node(page, "NITI Aayog (2015)").count() == 0, "the Fold button folds it")
    page.click("#mm-fold")

    # ================= colour, shape, mark =================
    tap(page, "Fiscal federalism")
    page.click(".mm-colours .sw[data-c='gs2']")
    check(page.locator(".mm-colours .sw[data-c='gs2']").get_attribute("aria-checked") == "true", "a colour per idea")
    page.click(".mm-bar2 .fig-seg button[data-v='circle']")
    r = node(page, "Fiscal federalism").locator("rect").nth(1)
    check(abs(float(r.get_attribute("rx")) * 2 - float(r.get_attribute("width"))) < 0.2 and r.get_attribute("width") == r.get_attribute("height"), "a shape per idea (circle)")
    page.click("#mm-mark")
    check(page.locator("#mm-mark").get_attribute("aria-pressed") == "true", "Mark makes an idea a key line")
    small = page.locator(".mm-colours .sw").evaluate_all("els => els.map(e => Math.min(e.offsetWidth, e.offsetHeight)).filter(v => v < 44)")
    check(page.locator(".mm-colours .sw").count() == 14 and not small, f"Auto + 13 colour swatches, each 44 px ({small})")

    # ================= zoom and pan =================
    tx0, ty0, k0 = view(page)
    page.click(".mm-zoom button[aria-label='Zoom in']")
    check(abs(view(page)[2] - k0 * 1.25) < 0.01, "+ zooms in")
    cx, cy = centre(page.locator(".mm-canvas"))
    page.mouse.move(cx, cy)
    page.keyboard.down("Control")
    page.mouse.wheel(0, 300)
    page.keyboard.up("Control")
    page.wait_for_timeout(150)
    check(view(page)[2] < k0 * 1.25 - 0.1, f"Ctrl+wheel zooms out ({view(page)[2]})")
    page.click(".mm-zoom button[aria-label='Fit to screen']")
    tx0, ty0, k0 = view(page)
    box = page.locator(".mm-canvas").bounding_box()
    page.mouse.move(box["x"] + 30, box["y"] + 30)
    page.mouse.down()
    page.mouse.move(box["x"] + 130, box["y"] + 80, steps=6)
    page.mouse.up()
    tx1, ty1, _ = view(page)
    check(abs(tx1 - tx0 - 100) < 2 and abs(ty1 - ty0 - 50) < 2, f"one finger on empty space pans ({tx1 - tx0:.0f},{ty1 - ty0:.0f})")
    # two fingers: a real touch pinch through the browser's touch input
    cdp = ctx.new_cdp_session(page)
    k0 = view(page)[2]
    y = box["y"] + 40
    pts = lambda d: [{"x": cx - d, "y": y, "id": 1}, {"x": cx + d, "y": y, "id": 2}]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(60)})
    for d in range(70, 131, 10):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pts(d)})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(150)
    k1 = view(page)[2]
    check(abs(k1 / k0 - 130 / 60) < 0.15, f"pinch zooms with the fingers ({k0:.2f} → {k1:.2f})")
    tx0, ty0, _ = view(page)
    two = lambda dx: [{"x": cx - 60 + dx, "y": y, "id": 1}, {"x": cx + 60 + dx, "y": y, "id": 2}]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": two(0)})
    for dx in range(10, 81, 10):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": two(dx)})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(150)
    tx1, _, k2 = view(page)
    check(abs(tx1 - tx0 - 80) < 3 and abs(k2 - k1) < 0.01, f"two fingers pan ({tx1 - tx0:.0f})")
    for _ in range(12):
        page.click(".mm-zoom button[aria-label='Zoom in']")
    check(view(page)[2] <= 3.0001, f"zoom stops at 3× ({view(page)[2]})")
    page.click(".mm-zoom button[aria-label='Fit to screen']")

    # ================= Tree layout =================
    before = at(page, "Fiscal federalism")
    page.click(".mm-head .fig-seg button[data-v='tree']")
    check(page.locator(".mm-head .fig-seg button[data-v='tree']").get_attribute("aria-checked") == "true" and at(page, "Fiscal federalism") != before, "Tree lays the map out as a tree")
    r_ = at(page, "Main idea")
    kids = [at(page, t)[0] for t in ["Constitutional features", "Fiscal federalism", "Cooperative federalism"]]
    check(all(x > r_[0] for x in kids), "…ideas to the right of the centre")

    # ================= Done =================
    page.click("#mm-done")
    page.wait_for_selector(".mm-overlay", state="detached")
    settle(page)
    mm = maps(page)[0]["attrs"]
    t = {n["text"]: n for n in mm["nodes"]}
    check(mm["layout"] == "tree" and set(t) == {"Main idea", "Constitutional features", "Idea 2", "Idea 3", "Fiscal federalism", "Cooperative federalism", "NITI Aayog (2015)"}, f"Done saves the map ({sorted(t)})")
    fis = t["Fiscal federalism"]
    check(fis["color"] == "gs2" and fis["shape"] == "circle" and fis["marked"] and t["NITI Aayog (2015)"]["parent"] == t["Cooperative federalism"]["id"], "…colour, shape, mark and who hangs under whom")
    fig = page.locator(".mindmap-block")
    check(fig.locator(".mindmap-title").text_content() == "Main idea" and fig.locator(".mindmap-count").text_content() == "7 ideas · 3 levels", "the note shows the map, its centre and its size")
    check(fig.locator("svg text", has_text="NITI Aayog (2015)").count() == 1, "…drawn in full")
    expect(page.locator("#keyline-count")).to_have_text("1 key line", timeout=3000)
    check(True, "a marked idea counts as a key line")
    check(page.evaluate("() => document.activeElement.classList.contains('mindmap-edit')"), "closing gives the keyboard back to Edit mind map")
    page.click("#note-undo")
    settle(page)
    check(texts(page) == ["Main idea", "Idea 1", "Idea 2", "Idea 3"], f"one note Undo takes back the whole editing session ({texts(page)})")
    page.click("#note-redo")
    settle(page)
    check(len(texts(page)) == 7, "Redo puts it back")

    # ================= other ways out all save =================
    fig.locator(".mindmap-edit").click()
    page.wait_for_selector(".mm-overlay")
    page.keyboard.press("Tab")
    page.keyboard.type("Back button idea")
    page.locator(".mm-canvas").focus()
    page.evaluate("() => history.back()")
    page.wait_for_selector(".mm-overlay", state="detached")
    settle(page)
    check("Back button idea" in texts(page) and page.url.endswith("#/n/" + page.evaluate(NOTE, TITLE)["id"]), "Android back closes the editor, saves, and stays in the note")

    fig.locator(".mindmap-edit").click()
    page.wait_for_selector(".mm-overlay")
    page.keyboard.press("Tab")
    page.keyboard.type("Hidden-app idea")
    page.evaluate("() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }")
    settle(page)
    check("Hidden-app idea" in texts(page) and page.locator(".mm-overlay").count() == 1, "the app going to the background saves (the editor stays open)")
    page.evaluate("() => { delete document.visibilityState; }")
    page.keyboard.press("Escape")
    page.keyboard.press("Tab")
    page.keyboard.type("Second idea")
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    page.wait_for_selector(".mm-overlay", state="detached")
    settle(page)
    check("Second idea" in texts(page), "Esc on the map closes and saves")
    page.click("#note-undo")
    settle(page)
    tx_ = texts(page)
    check("Hidden-app idea" not in tx_ and "Second idea" not in tx_ and "Back button idea" in tx_, f"two saves in one session are still one note Undo ({len(tx_)} ideas)")
    page.click("#note-redo")
    settle(page)

    fig.locator(".mindmap-edit").click()
    page.wait_for_selector(".mm-overlay")
    page.keyboard.press("Tab")
    page.keyboard.type("Leaving idea")
    page.evaluate("() => { location.hash = '#/notes'; }")
    page.wait_for_selector("#new-note")
    page.wait_for_timeout(1200)
    check(page.locator(".mm-overlay").count() == 0 and "Leaving idea" in texts(page), "leaving the note closes the editor and keeps the change")

    # ================= search =================
    page.keyboard.press("Control+k")
    page.wait_for_selector("#global-search")
    for q in ["NITI Aayog", "Leaving idea"]:
        page.fill("#global-search", q)
        page.wait_for_timeout(400)
        check(TITLE in page.locator("#search-results").inner_text(), f"Ctrl+K finds an idea in a mind map ('{q}')")
    page.keyboard.press("Escape")

    # ================= the gallery tile =================
    rec = page.evaluate(NOTE, TITLE)
    page.goto(URL + "#/n/" + rec["id"])
    page.wait_for_selector(".mindmap-block svg")
    to_end(page)
    page.keyboard.type("/chart")
    page.wait_for_selector("#insert-menu:not([hidden])")
    page.keyboard.press("Enter")
    page.click("#gallery-words .gallery-tile[data-kind='mindmap']")
    page.wait_for_selector(".mm-overlay")
    check(count(page) == "4 ideas · 2 levels", "the gallery's Mind map tile does the same")
    page.click("#mm-done")
    page.wait_for_selector(".mm-overlay", state="detached")
    settle(page)
    check(len(maps(page)) == 2, "two maps in one note")

    # ================= a big map in the PDF =================
    nodes = [{"id": "r", "text": "Indian economy", "parent": None}]
    for i in range(6):
        nodes.append({"id": f"b{i}", "text": f"Sector {i + 1}", "parent": "r", "folded": i == 2})
        for j in range(6):
            nodes.append({"id": f"b{i}k{j}", "text": f"Point {i + 1}.{j + 1}", "parent": f"b{i}"})
    nodes = [{"color": None, "shape": "pill", "x": 0, "y": 0, "pinned": False, "folded": False, "marked": False, **n} for n in nodes]
    big = dict(rec)
    big["id"] = "big-map-note"
    big["title"] = "Big map"
    big["sections"] = [{**rec["sections"][0], "doc": {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Before the map."}]},
        {"type": "mindMap", "attrs": {"layout": "radial", "nodes": nodes}},
        {"type": "paragraph", "content": [{"type": "text", "text": "After the map."}]}]}}]
    page.evaluate(IDB_PUT, big)
    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.goto(URL + "#/n/big-map-note")
    page.wait_for_selector(".mindmap-block svg")
    check(page.locator(".mindmap-count").text_content() == "43 ideas · 3 levels", "a 43-idea map opens")
    check(page.locator(".mindmap-block svg text", has_text="Point 3.1").count() == 0 and page.locator(".mindmap-block svg text", has_text="+6").count() == 1, "a folded branch shows +6 in the note")
    hits = page.evaluate("""() => { const r = [...document.querySelectorAll('.mindmap-block .mm-node')].map(g => g.querySelector('rect').getBoundingClientRect());
      let n = 0; for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++)
        if (r[i].left < r[j].right && r[j].left < r[i].right && r[i].top < r[j].bottom && r[j].top < r[i].bottom) n++; return n; }""")
    check(hits == 0, f"no two ideas overlap in a big radial map ({hits})")
    page.click("#details summary")
    with page.expect_download(timeout=60000) as dl:
        page.click("#note-pdf")
    pdf = OUT / "bigmap.pdf"
    dl.value.save_as(pdf)
    pages = PdfReader(str(pdf)).pages
    shapes = [(float(pg.mediabox.width), float(pg.mediabox.height)) for pg in pages]
    land = [i for i, (w, h) in enumerate(shapes) if w > h]
    check(len(land) == 1 and land[0] > 0 and land[0] + 1 < len(shapes), f"a big map gets its own landscape page between portrait ones ({shapes})")
    txt = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    check("Point 3.1" in txt and "Point 6.6" in txt and "Indian economy" in txt, "the PDF prints every idea, folded ones too")
    pg_texts = [subprocess.run(["pdftotext", "-f", str(i + 1), "-l", str(i + 1), str(pdf), "-"], capture_output=True, text=True).stdout for i in range(len(pages))]
    check("Before the map." in pg_texts[land[0] - 1] and "After the map." in pg_texts[land[0] + 1] if land else False, "text before and after stays on portrait pages")
    check(sum(len(pg.images) for pg in pages) == 0, "the map prints as vector drawing")
    subprocess.run(["pdftoppm", "-png", "-r", "60", str(pdf), str(OUT / "bigmap")])

    # ================= reduced motion, the Tab S8 =================
    ctx2 = browser.new_context(viewport={"width": 800, "height": 1280}, reduced_motion="reduce", has_touch=True)
    p2 = ctx2.new_page()
    p2.on("pageerror", lambda e: errors.append(str(e)))
    p2.goto(URL)
    p2.evaluate(IDB_PUT, big)
    p2.goto(URL + "#/n/big-map-note")
    p2.wait_for_selector(".mindmap-block svg")
    p2.wait_for_timeout(600)
    a2 = p2.locator(".mindmap-block .ch-in").evaluate_all("els => els.map(e => getComputedStyle(e).animationName).filter(n => n !== 'none').length")
    check(a2 == 0, f"no fade-in with reduced motion ({a2} animated)")
    p2.locator(".mindmap-edit").tap()
    p2.wait_for_selector(".mm-overlay")
    over = p2.evaluate("() => { const o = document.querySelector('.mm-overlay'); return [o.scrollWidth - o.clientWidth, o.getBoundingClientRect().width]; }")
    check(over[0] <= 0 and over[1] == 800, f"Tab S8 portrait: the editor fills the screen, nothing sideways ({over})")
    nb = p2.locator(".mm-svg .mm-node").first.bounding_box()
    check(nb["width"] >= 44 and nb["height"] >= 30, f"ideas are big enough to tap after Fit ({nb['width']:.0f}×{nb['height']:.0f})")
    p2.locator("#mm-done").tap()
    p2.wait_for_selector(".mm-overlay", state="detached")
    check(p2.evaluate("() => !document.body.classList.contains('mm-open')"), "Done gives the page its scroll back")
    p2.screenshot(path=str(OUT / "tab-s8.png"))
    ctx2.close()

    page.screenshot(path=str(OUT / "mindmap.png"))
    check(not errors, f"no page errors {errors}")
    browser.close()

print(f"artifacts in {OUT}")
if failures:
    print(f"{len(failures)} FAILED")
    sys.exit(1)
print("ALL PASSED")
