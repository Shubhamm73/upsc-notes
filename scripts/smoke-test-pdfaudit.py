"""U4-4 smoke test: PDF audit of every block. Needs `vite preview` on :4173.

One note holds every block type the editor has: 12 heading looks plus H2/H3/H4, a paragraph with every mark and
a link, bullet / numbered / dash lists, a table, all 6 callouts, all 6 containers, a chart, a diagram, a mind map,
a picture and a sketch. The note PDF and a section PDF export with no page or console error, have pages, hold a
marker word from every block that prints text, are not blank page by page, and keep the sticky / quote / titled
container text in reading order.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = "http://localhost:4173/upsc-notes/"
OUT = Path(tempfile.mkdtemp())
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


IDB_PUT = """(rec) => new Promise((res, rej) => { const r = indexedDB.open('upsc-notes');
  r.onsuccess = () => { const tx = r.result.transaction('notes', 'readwrite'); tx.objectStore('notes').put(rec);
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })"""
IMG_PUT = """(id) => new Promise((res, rej) => { const c = document.createElement('canvas'); c.width = 240; c.height = 160;
  const g = c.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 240, 160); g.fillStyle = '#2980b9'; g.fillRect(40, 30, 120, 90);
  c.toBlob((blob) => { const r = indexedDB.open('upsc-notes'); r.onsuccess = () => {
    const tx = r.result.transaction('images', 'readwrite'); tx.objectStore('images').put({ id, noteId: 'pdf-audit', blob, width: 240, height: 160, updatedAt: Date.now() });
    tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); }; }, 'image/png'); })"""
# a sketch stroke made with the app's own encoder (zigzag varints, base64)
STROKE = """() => { const pts = []; for (let i = 0; i <= 40; i++) pts.push(80 + i * 20, 300 + Math.sin(i / 4) * 150, 0.8);
  const bytes = []; const put = (v) => { let z = v < 0 ? -2 * v - 1 : 2 * v; while (z >= 128) { bytes.push((z & 127) | 128); z = Math.floor(z / 128); } bytes.push(z); };
  let px = 0, py = 0, pp = 0;
  for (let i = 0; i + 2 < pts.length; i += 3) { const x = Math.round(pts[i] * 4), y = Math.round(pts[i + 1] * 4), p = Math.round(pts[i + 2] * 100); put(x - px); put(y - py); put(p - pp); px = x; py = y; pp = p; }
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return 'pen.ink.l:' + btoa(bin); }"""


def t(text, marks=None):
    n = {"type": "text", "text": text}
    if marks:
        n["marks"] = marks
    return n


def p(*kids):
    return {"type": "paragraph", "content": list(kids)}


def pt(text):
    return p(t(text))


def li(text):
    return {"type": "listItem", "content": [pt(text)]}


def cell(text, head=False):
    return {"type": "tableHeader" if head else "tableCell", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None}, "content": [pt(text)]}


STYLES = ['plain', 'underline', 'marker', 'pill', 'banner', 'card', 'tab', 'numbered', 'boxed', 'brackets', 'split', 'sticky']
KINDS = ['article', 'case', 'data', 'example', 'wayforward', 'pyq']
PANELS = ['soft', 'titled', 'sticky', 'framed', 'quote']
MARKERS = []


def mk(name):
    MARKERS.append(name)
    return name


def build_doc(img_id, stroke):
    c = []
    for lv in (2, 3, 4):
        c.append({"type": "heading", "attrs": {"level": lv}, "content": [t(mk(f"HeadLevel{lv}Zq"))]})
    for s in STYLES:
        look = {"style": s, "color": "interview", "fill": "solid", "corner": "round", "icon": "none", "width": "full", "align": "left"}
        c.append({"type": "heading", "attrs": {"level": 2, "look": look}, "content": [t(mk(f"Look{s}Zq"))]})
    c.append(p(t(mk("BoldZq") + " ", [{"type": "bold"}]), t(mk("ItalicZq") + " ", [{"type": "italic"}]), t(mk("UnderZq") + " ", [{"type": "underline"}]),
               t(mk("StrikeZq") + " ", [{"type": "strike"}]), t(mk("MarkZq") + " ", [{"type": "highlight", "attrs": {"color": "#ffe066"}}]),
               t(mk("LinkZq"), [{"type": "link", "attrs": {"href": "https://example.com/zq"}}])))
    c.append({"type": "bulletList", "content": [li(mk("BulletOneZq")), li(mk("BulletTwoZq"))]})
    c.append({"type": "orderedList", "attrs": {"start": 1}, "content": [li(mk("OrderOneZq")), li(mk("OrderTwoZq"))]})
    c.append({"type": "bulletList", "attrs": {"dash": True, "style": "dash"}, "content": [li(mk("DashOneZq")), li(mk("DashTwoZq"))]})
    c.append({"type": "table", "content": [
        {"type": "tableRow", "content": [cell(mk("TblHeadAZq"), True), cell(mk("TblHeadBZq"), True)]},
        {"type": "tableRow", "content": [cell(mk("TblCellAZq")), cell(mk("TblCellBZq"))]}]})
    for k in KINDS:
        attrs = {"kind": k}
        if k == "pyq":
            attrs.update({"year": "2019", "paper": "GS2", "marks": "15"})
        c.append({"type": "callout", "attrs": attrs, "content": [pt(mk(f"Callout{k}Zq"))]})
    for k in PANELS:
        attrs = {"kind": k}
        if k == "titled":
            attrs["title"] = mk("PanelTitleZq")
        if k == "quote":
            attrs["author"] = mk("PanelAuthorZq")
        c.append({"type": "panel", "attrs": attrs, "content": [pt(mk(f"Panel{k}FirstZq")), pt(mk(f"Panel{k}SecondZq"))]})
    col = lambda a: {"type": "panelColumn", "content": [pt(mk(a))]}
    c.append({"type": "panel", "attrs": {"kind": "columns"}, "content": [col("PanelColLeftZq"), col("PanelColRightZq")]})
    c.append({"type": "chart", "attrs": {"kind": "column", "title": mk("ChartTitleZq"), "labels": ["BJP", "INC", "DMK"], "series": [{"name": "Seats", "values": [303, 52, 24]}], "align": "center", "width": 100}})
    c.append({"type": "diagram", "attrs": {"kind": "timeline", "title": mk("DiagramTitleZq"), "items": [
        {"text": mk("DiagItemOneZq"), "detail": "", "color": None, "level": 0, "cells": []},
        {"text": mk("DiagItemTwoZq"), "detail": "", "color": None, "level": 0, "cells": []}], "heads": [], "note": "", "palette": "desk"}})
    nd = lambda i, tx, par, sh="pill": {"id": i, "text": tx, "parent": par, "color": None, "shape": sh, "x": 0, "y": 0, "pinned": False, "folded": False, "marked": False}
    c.append({"type": "mindMap", "attrs": {"layout": "radial", "nodes": [nd("n0", mk("MindCentreZq"), None), nd("b0", mk("MindBranchZq"), "n0"), nd("b0k0", mk("MindLeafZq"), "b0", "box")]}})
    c.append({"type": "imageBlock", "attrs": {"imageId": img_id, "width": 50, "align": "center", "alt": "", "caption": mk("PictureCaptionZq")}})
    c.append({"type": "sketchBlock", "attrs": {"strokes": [stroke], "height": 600, "width": 100, "align": "center"}})
    c.append(pt(mk("TailParagraphZq")))
    return {"type": "doc", "content": c}


def text_of(pdf):
    return subprocess.run(["pdftotext", str(pdf), "-"], capture_output=True, text=True).stdout


def squash(s):
    return re.sub(r"\s+", "", s)


def ink_ratios(pdf, prefix):
    subprocess.run(["pdftoppm", "-r", "40", "-png", str(pdf), str(OUT / prefix)], check=True)
    from PIL import Image
    out = []
    for f in sorted(OUT.glob(prefix + "*.png")):
        im = Image.open(f).convert("L")
        h = im.histogram()
        out.append(sum(h[:245]) / sum(h))
    return out


def pages_of(pdf):
    from pypdf import PdfReader
    return len(PdfReader(str(pdf)).pages)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)

    page.goto(URL + "#/notes")
    page.wait_for_selector("#new-note")
    page.evaluate(IMG_PUT, "pdf-audit-img")
    stroke = page.evaluate(STROKE)
    doc = build_doc("pdf-audit-img", stroke)
    note = {"id": "pdf-audit", "title": "PDF audit note", "subject": "GS2", "topic": "", "template": "blank", "explain": "", "connect": "",
            "createdAt": 1700000000000, "updatedAt": 1700000000000, "deletedAt": None, "folderId": "gen:GS2",
            "sections": [{"id": "s-a", "heading": "Everything", "doc": doc},
                         {"id": "s-b", "heading": "Second", "doc": {"type": "doc", "content": [pt("SecondSectionZq")]}}]}
    page.evaluate(IDB_PUT, note)
    page.goto(URL + "#/n/pdf-audit")
    page.wait_for_selector(".section-body .ProseMirror")
    page.wait_for_selector(".chart-block svg")
    page.wait_for_timeout(1200)
    errors.clear()

    # ---- note PDF
    page.click("#details summary")
    with page.expect_download(timeout=90000) as dl:
        page.click("#note-pdf")
    npdf = OUT / "note.pdf"
    dl.value.save_as(npdf)
    page.click("#details summary")
    page.wait_for_timeout(500)
    check(not errors, f"note PDF export raises no page or console error ({errors[:3]})")
    n = pages_of(npdf)
    check(n >= 1, f"note PDF has pages ({n})")
    txt = squash(text_of(npdf))
    check("SecondSectionZq" in txt, "note PDF holds the second section")
    # every marker: those that print text
    missing = [m for m in MARKERS if m not in txt]
    for m in MARKERS:
        check(m in txt, f"note PDF text holds {m}")
    check(not missing, f"every block's marker is in the note PDF (missing {missing})")
    ratios = ink_ratios(npdf, "np")
    check(len(ratios) == n, f"page images rendered for all {n} pages")
    for i, r in enumerate(ratios, 1):
        check(r > 0.005, f"note PDF page {i} is not blank (ink {r * 100:.2f}%)")
    # reading order inside the sticky / quote / titled containers
    for k, first, second in [("titled", "PanelTitleZq", "PaneltitledFirstZq"), ("sticky", "PanelstickyFirstZq", "PanelstickySecondZq"),
                             ("quote", "PanelquoteFirstZq", "PanelquoteSecondZq"), ("titled", "PaneltitledFirstZq", "PaneltitledSecondZq"),
                             ("quote", "PanelquoteSecondZq", "PanelAuthorZq")]:
        a, b = txt.find(first), txt.find(second)
        check(0 <= a < b, f"{k} container text in reading order: {first} before {second} ({a}, {b})")
    # whole-document order of the main blocks
    seq = ["HeadLevel2Zq", "BoldZq", "BulletOneZq", "OrderOneZq", "DashOneZq", "TblHeadAZq", "Calloutarticle", "PanelsoftFirstZq", "PanelColLeftZq",
           "ChartTitleZq", "DiagramTitleZq", "MindCentreZq", "PictureCaptionZq", "TailParagraphZq", "SecondSectionZq"]
    pos = [txt.find(s) for s in seq]
    check(all(x >= 0 for x in pos) and pos == sorted(pos), f"blocks print in document order ({pos})")
    from pypdf import PdfReader
    imgs = sum(len(pg.images) for pg in PdfReader(str(npdf)).pages)
    check(imgs >= 2, f"picture and sketch print as images ({imgs})")

    # ---- section PDF
    errors.clear()
    page.click("#outline button[aria-label='Section 1 options']")
    with page.expect_download(timeout=90000) as dl2:
        page.click(".popover button[aria-label='Export section 1 as PDF']")
    spdf = OUT / "section.pdf"
    dl2.value.save_as(spdf)
    page.wait_for_timeout(500)
    check(not errors, f"section PDF export raises no page or console error ({errors[:3]})")
    sn = pages_of(spdf)
    check(sn >= 1, f"section PDF has pages ({sn})")
    st = squash(text_of(spdf))
    check("SecondSectionZq" not in st, "section PDF holds only its own section")
    smiss = [m for m in MARKERS if m not in st and m != "SecondSectionZq"]
    check(not smiss, f"every block's marker is in the section PDF (missing {smiss})")
    for i, r in enumerate(ink_ratios(spdf, "sp"), 1):
        check(r > 0.005, f"section PDF page {i} is not blank (ink {r * 100:.2f}%)")
    browser.close()

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
