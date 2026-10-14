"""0.11 smoke test: Google Drive backup and restore. Needs `vite preview` on :4173.

Google is stubbed in the page: Google Identity Services (the sign-in popup: ok, cancelled, refused, can't
open, never answers) and the Picker are replaced by an init script before the app loads, and the Drive REST
API is a fake Drive in this script behind `context.route` (with the CORS headers a browser needs; Playwright
answers intercepted requests itself, so preflights were checked against the real Drive with curl). The full-page sign-in is a stub of Google's address that sends the browser back with a token.

Checks: connect (folder made for him or picked, schedule, first backup), the file in Drive (format 5, counts,
settings), Back up now, keep the last 10 (older ones to Drive's trash, never deleted; the guard keeps the
largest older backup while it holds more than every newer one), the upload id fallback when Location isn't
readable, an expired token (renewed on Back up now, and on the next tap outside a note, never inside one),
no backup while a note is open, big change, offline then online, More's warning, restore on an empty tablet
(list newest first, merge, settings, Drive turned on to the same folder, twice adds nothing), settings not
undone by an older file, the full-page sign-in (connect, silent renewal at launch, refused), disconnect.
"""
import json
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect

URL = "http://localhost:4173/upsc-notes/"
SCOPE = "https://www.googleapis.com/auth/drive.file"
failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


GIS_STUB = """(() => {
  const mode = () => localStorage.getItem('__gisMode') || 'ok';
  const log = window.__gis = { requests: [], revoked: [], picker: null };
  let n = Number(sessionStorage.getItem('__gisN') || 0);
  window.google = {
    accounts: { oauth2: {
      initTokenClient(cfg) {
        return { requestAccessToken(o) {
          log.requests.push(o || {});
          const m = mode();
          setTimeout(() => {
            if (m === 'ok') { n++; sessionStorage.setItem('__gisN', n); cfg.callback({ access_token: 'tok-' + Date.now() + '-' + n, expires_in: 3599, scope: '%s', token_type: 'Bearer' }); }
            else if (m === 'cancel') cfg.error_callback({ type: 'popup_closed' });
            else if (m === 'fail') cfg.error_callback({ type: 'popup_failed_to_open' });
            else if (m === 'deny') cfg.callback({ error: 'access_denied' });
            else if (m === 'noscope') cfg.callback({ access_token: 'tok-x', expires_in: 3599, scope: 'email' });
          }, 60);
        } };
      },
      revoke(t, cb) { log.revoked.push(t); cb && cb(); }
    } },
    picker: {
      ViewId: { FOLDERS: 'folders' }, Action: { PICKED: 'picked', CANCEL: 'cancel' },
      DocsView: class { setIncludeFolders() { return this; } setSelectFolderEnabled() { return this; } setMimeTypes(m) { log.mime = m; return this; } },
      PickerBuilder: class {
        addView() { return this; } setOAuthToken(t) { this.t = t; return this; } setDeveloperKey(k) { this.k = k; return this; }
        setAppId(a) { this.a = a; return this; } setTitle() { return this; } setCallback(cb) { this.cb = cb; return this; } build() { return this; }
        setVisible() { log.picker = { token: this.t, key: this.k, app: this.a }; const p = JSON.parse(localStorage.getItem('__pick') || 'null');
          setTimeout(() => this.cb(p ? { action: 'picked', docs: [p] } : { action: 'cancel' }), 40); }
      }
    }
  };
})();""" % SCOPE


class FakeDrive:
    """Enough of Drive v3 for the app: about, files list/get/create/patch, media download, resumable upload."""

    def __init__(self):
        self.files = {}
        self.sessions = {}
        self.revoked = set()
        self.tokens = []
        self.n = 0
        self.clock = time.time() - 86400 * 30
        self.calls = []
        self.expose_location = True
        self.fail_upload = False
        self.preflights = 0

    def stamp(self, at=None):
        self.clock += 1
        return datetime.fromtimestamp(at if at else self.clock, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def add(self, name, mime, parents, props, content=b"", at=None):
        self.n += 1
        fid = f"file{self.n}"
        self.files[fid] = {"id": fid, "name": name, "mimeType": mime, "parents": parents, "appProperties": props, "createdTime": self.stamp(at), "trashed": False, "content": content}
        return self.files[fid]

    def meta(self, f):
        m = {k: v for k, v in f.items() if k != "content"}
        m["size"] = str(len(f["content"]))
        return m

    def backups(self, folder=None, trashed=False):
        out = [f for f in self.files.values() if f["appProperties"].get("upscNotes") == "backup" and f["trashed"] == trashed and (folder is None or folder in f["parents"])]
        return sorted(out, key=lambda f: f["createdTime"], reverse=True)

    def folders(self):
        return [f for f in self.files.values() if f["mimeType"] == "application/vnd.google-apps.folder"]

    def handle(self, route):
        req = route.request
        origin = req.headers.get("origin", "http://localhost:4173")
        cors = {"Access-Control-Allow-Origin": origin, "Vary": "Origin",
                "Access-Control-Expose-Headers": ("Location, " if self.expose_location else "") + "X-GUploader-UploadID, Content-Length, Date"}
        u = urlparse(req.url)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        if req.method == "OPTIONS":
            self.preflights += 1
            return route.fulfill(status=204, headers={**cors, "Access-Control-Allow-Methods": "DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT",
                                                      "Access-Control-Allow-Headers": "authorization,content-type,x-upload-content-type,x-upload-content-length", "Access-Control-Max-Age": "0"})

        def reply(status, body=None, extra=None, raw=None):
            h = {**cors, **(extra or {})}
            if raw is not None:
                return route.fulfill(status=status, headers={**h, "Content-Type": "application/json"}, body=raw)
            return route.fulfill(status=status, headers={**h, "Content-Type": "application/json"}, body=json.dumps(body if body is not None else {}))

        auth = req.headers.get("authorization", "")
        tok = auth[7:] if auth.startswith("Bearer ") else ""
        self.calls.append((req.method, u.path, qs, tok))
        if not tok.startswith("tok-") or tok in self.revoked:
            return reply(401, {"error": {"code": 401, "message": "Invalid Credentials"}})
        if tok not in self.tokens:
            self.tokens.append(tok)
        path = u.path
        if path == "/drive/v3/about":
            return reply(200, {"user": {"displayName": "Test Brother", "emailAddress": "brother@example.com"}})
        if path == "/drive/v3/files" and req.method == "GET":
            q = qs.get("q", "")
            if "value='folder'" in q:
                out = sorted([f for f in self.folders() if f["appProperties"].get("upscNotes") == "folder" and not f["trashed"]], key=lambda f: f["createdTime"])
            else:
                par = re.search(r"'([^']+)' in parents", q)
                out = self.backups(par.group(1) if par else None)
            return reply(200, {"files": [self.meta(f) for f in out]})
        if path == "/drive/v3/files" and req.method == "POST":
            body = json.loads(req.post_data or "{}")
            f = self.add(body.get("name"), body.get("mimeType"), body.get("parents", ["root"]), body.get("appProperties", {}))
            return reply(200, self.meta(f))
        m = re.match(r"^/drive/v3/files/([^/]+)$", path)
        if m:
            f = self.files.get(m.group(1))
            if not f:
                return reply(404, {"error": {"code": 404, "message": "File not found"}})
            if req.method == "PATCH":
                f.update({k: v for k, v in json.loads(req.post_data or "{}").items() if k in ("trashed", "name")})
                return reply(200, self.meta(f))
            if req.method == "DELETE":
                return reply(403, {"error": {"message": "the app must never delete outright"}})
            if qs.get("alt") == "media":
                return reply(200, raw=f["content"])
            return reply(200, self.meta(f))
        if path == "/upload/drive/v3/files" and req.method == "POST" and qs.get("uploadType") == "resumable":
            if self.fail_upload:
                return reply(500, {"error": {"code": 500, "message": "backend error"}})
            sid = f"S{len(self.sessions) + 1}"
            self.sessions[sid] = {"meta": json.loads(req.post_data or "{}"), "len": req.headers.get("x-upload-content-length")}
            loc = f"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id={sid}"
            return reply(200, {}, {"Location": loc, "X-GUploader-UploadID": sid})
        if path == "/upload/drive/v3/files" and req.method == "PUT":
            s = self.sessions.pop(qs.get("upload_id", ""), None)
            if not s:
                return reply(404, {"error": {"message": "no such upload"}})
            data = req.post_data_buffer or b""
            meta = s["meta"]
            f = self.add(meta["name"], meta.get("mimeType"), meta.get("parents", ["root"]), meta.get("appProperties", {}), data)
            f["declaredLength"] = s["len"]
            return reply(200, self.meta(f))
        return reply(400, {"error": {"message": f"fake drive: {req.method} {path} not handled"}})


def google_auth(route, fake, error=None):
    """Google's full-page sign-in, stubbed: straight back to the app with a token (or an error)."""
    u = urlparse(route.request.url)
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    fake.auth_requests.append(q)
    back = q["redirect_uri"]
    if error or fake.auth_error:
        frag = f"error={error or fake.auth_error}&state={q['state']}"
    else:
        frag = f"access_token=tok-redirect-{len(fake.auth_requests)}&token_type=Bearer&expires_in=3599&scope={SCOPE}&state={q['state']}"
    route.fulfill(status=200, content_type="text/html", body=f"<script>location.replace({json.dumps(back + '#' + frag)})</script>")


def state(page):
    return page.evaluate("JSON.parse(localStorage.getItem('upsc.driveState') || 'null')")


def cfg(page):
    return page.evaluate("JSON.parse(localStorage.getItem('upsc.drive') || 'null')")


def set_state(page, patch):
    page.evaluate("(p) => localStorage.setItem('upsc.driveState', JSON.stringify({ ...JSON.parse(localStorage.getItem('upsc.driveState') || '{}'), ...p }))", patch)


def toast(page, text, timeout=8000):
    expect(page.locator(".toast")).to_contain_text(text, timeout=timeout)


def capture(page, text):
    page.goto(URL + "#/")
    page.wait_for_selector("#capture")
    page.fill("#capture", text)
    page.click("#capture-save")
    toast(page, "as a draft")


def wait_until(page, fn, timeout=10):
    """Waits with Playwright (never time.sleep: the sync API answers routed requests only inside its own calls)."""
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        page.wait_for_timeout(100)
    return fn()


def settings_page(page):
    page.goto(URL + "#/settings")
    page.wait_for_selector("#drive")


def new_context(browser, fake):
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, has_touch=True, accept_downloads=True)
    ctx.add_init_script(GIS_STUB)
    ctx.route("https://www.googleapis.com/**", fake.handle)
    ctx.route("https://accounts.google.com/o/oauth2/v2/auth**", lambda r: google_auth(r, fake))
    return ctx


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    fake = FakeDrive()
    fake.auth_requests = []
    fake.auth_error = None
    ctx = new_context(browser, fake)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    capture(page, "Fiscal federalism and the 16th Finance Commission")
    capture(page, "Monsoon and the Indian Ocean Dipole")
    page.goto(URL + "#/prefs")
    page.wait_for_selector("#pref-width-full")
    page.click("[data-theme-opt='night']")
    page.wait_for_timeout(100)

    # ---------------- off: what the section offers ----------------
    settings_page(page)
    check(page.locator("#drive-connect").is_visible() and not page.locator("#drive-now").is_visible(), "Drive off: Connect Google Drive shown, Back up now hidden")
    check("only the files this app makes" in page.inner_text("#drive"), "the section says which permission Google asks for")

    # ---------------- connect: cancelled, refused, popup can't open, no answer ----------------
    page.evaluate("localStorage.setItem('__gisMode', 'cancel')")
    page.click("#drive-connect")
    toast(page, "Sign-in cancelled")
    check(not (state(page) or {}).get("on") and not fake.calls, "cancelled popup: nothing connected, Drive never called")
    page.evaluate("localStorage.setItem('__gisMode', 'deny')")
    page.click("#drive-connect")
    toast(page, "wasn’t allowed")
    page.evaluate("localStorage.setItem('__gisMode', 'noscope')")
    page.click("#drive-connect")
    toast(page, "wasn’t allowed")
    check(not fake.calls, "Drive permission unticked on Google's screen: treated as refused")
    page.evaluate("localStorage.setItem('__gisMode', 'hang')")
    page.click("#drive-connect")
    page.wait_for_selector("#drive-wait")
    check(page.locator("#drive-fullpage").is_visible(), "while Google's window is open: 'Sign in on a full page instead' is offered")
    page.click("#drive-wait-cancel")
    toast(page, "Sign-in cancelled")
    page.evaluate("localStorage.setItem('__gisMode', 'fail')")
    page.click("#drive-connect")
    page.wait_for_selector("#drive-popup-failed")
    check((state(page) or {}).get("signin") == "redirect", "popup can't open: this device switches to the full-page sign-in")
    page.keyboard.press("Escape")
    set_state(page, {"signin": "popup"})
    page.evaluate("localStorage.setItem('__gisMode', 'ok')")

    # ---------------- connect: folder made for him, schedule, first backup ----------------
    settings_page(page)
    page.click("#drive-connect")
    page.wait_for_selector("#drive-folder-sheet")
    req = page.evaluate("window.__gis.requests.at(-1)")
    check(req.get("prompt") == "select_account", f"first sign-in asks Google to choose the account ({req})")
    check((state(page) or {}).get("email") == "brother@example.com", "the account is read from Drive (no extra permission)")
    page.click("#drive-folder-new")
    page.wait_for_selector("#drive-schedule-sheet")
    check(page.locator("[data-every='2']").get_attribute("aria-pressed") == "true", "schedule: every 2 days by default")
    check(page.locator("#drive-onchange").is_checked(), "schedule: 'right after a big change' on by default")
    check("last 10" in page.inner_text("#drive-schedule-sheet"), "the sheet says the last 10 are kept")
    page.click("#drive-turn-on")
    toast(page, "Backed up to Google Drive: 2 notes")
    folders = fake.folders()
    check(len(folders) == 1 and folders[0]["name"] == "UPSC Notes backups" and folders[0]["appProperties"] == {"upscNotes": "folder"}, "folder 'UPSC Notes backups' made in My Drive, tagged as the app's")
    folder = folders[0]["id"]
    b = fake.backups(folder)
    check(len(b) == 1, "one backup in the folder")
    data = json.loads(b[0]["content"])
    check(data["app"] == "upsc-notes" and data["format"] == 5 and data["counts"]["notes"] == 2, f"the Drive file is a format-5 backup with both notes ({data['format']}, {data['counts']})")
    check(data["settings"].get("theme", {}).get("value") == "night" and data["settings"]["theme"]["at"] > 0, "settings travel in the backup, with when they were chosen")
    check("drive" in data["settings"] and json.loads(data["settings"]["drive"]["value"])["every"] == 2, "the Drive schedule travels too")
    check(b[0]["appProperties"].get("notes") == "2" and b[0]["appProperties"].get("format") == "5", f"the file is labelled with its counts ({b[0]['appProperties']})")
    check(re.match(r"upsc-notes-backup-\d{4}-\d\d-\d\d-\d{4}\.json$", b[0]["name"]) is not None, f"file name has date and time ({b[0]['name']})")
    check(b[0]["declaredLength"] == str(len(b[0]["content"])), "resumable upload: declared length matches the file")
    st = state(page)
    check(st["on"] and st["lastAt"] and st["kept"] == 1 and not st.get("error"), f"state: on, backed up, 1 kept ({st})")
    check(page.evaluate("JSON.parse(sessionStorage.getItem('upsc.driveToken'))") is not None and page.evaluate("Object.keys(localStorage).filter(k => /token/i.test(k))") == [], "the token is in this tab's sessionStorage only, never localStorage")
    expect(page.locator("#drive-status")).to_contain_text("Backed up today")
    check(page.inner_text("#drive-account") == "brother@example.com", "Account shown")
    check(page.inner_text("#drive-folder") == "My Drive › UPSC Notes backups", "Folder shown")
    nxt = page.evaluate("(() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); })()")
    check(page.inner_text("#drive-when").startswith(f"Every 2 days · next on {nxt}"), f"Schedule shows the next date ({page.inner_text('#drive-when')})")
    check("(1 so far)" in page.inner_text("#drive-kept"), "Kept shows how many so far")
    check(page.locator("#drive-connect").is_hidden() and page.locator("#drive-now").is_visible(), "on: Back up now, Change schedule, Restore, Disconnect")

    # ---------------- keep the last 10 ----------------
    for i in range(11):
        page.click("#drive-now")
        expect(page.locator(".toast")).to_contain_text("Backed up to Google Drive", timeout=8000)
        page.wait_for_function("(n) => (JSON.parse(localStorage.getItem('upsc.driveState')).kept || 0) >= Math.min(10, n)", arg=i + 2)
    page.wait_for_timeout(300)
    live, trashed = fake.backups(folder), fake.backups(folder, trashed=True)
    check(len(live) == 10 and len(trashed) == 2, f"12 backups made: newest 10 kept, 2 oldest in Drive's trash ({len(live)} / {len(trashed)})")
    check(min(f["createdTime"] for f in live) > max(f["createdTime"] for f in trashed), "the ones trashed are the oldest")
    check(not any(c[0] == "DELETE" for c in fake.calls), "nothing is ever deleted outright (trash only)")
    check(state(page)["kept"] == 10 and "(10 so far)" in page.inner_text("#drive-kept"), "Kept: 10")
    # the guard: an older backup holding far more than every newer one is kept
    oldest_t = min(int(datetime.strptime(f["createdTime"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()) for f in live)
    big = fake.add("upsc-notes-backup-old.json", "application/json", [folder], {"upscNotes": "backup", "notes": "500", "words": "900"}, b"{}", at=oldest_t - 3600)
    page.click("#drive-now")
    toast(page, "Backed up to Google Drive")
    page.wait_for_timeout(300)
    check(not fake.files[big["id"]]["trashed"], "guard: the largest older backup stays while it holds more than all of the newest 10")
    check(len(fake.backups(folder)) == 11, f"…as an 11th ({len(fake.backups(folder))})")
    fake.files[big["id"]]["appProperties"]["notes"] = "1"
    fake.files[big["id"]]["appProperties"]["words"] = "0"
    page.click("#drive-now")
    toast(page, "Backed up to Google Drive")
    page.wait_for_timeout(300)
    check(fake.files[big["id"]]["trashed"] and len(fake.backups(folder)) == 10, "a small old backup goes like any other")

    # ---------------- upload address from the upload id when Location isn't readable ----------------
    fake.expose_location = False
    before = len(fake.files)
    page.click("#drive-now")
    toast(page, "Backed up to Google Drive")
    check(len(fake.files) == before + 1, "Location not exposed: the upload id builds the same address and the upload works")
    fake.expose_location = True

    # ---------------- an upload that fails ----------------
    fake.fail_upload = True
    page.click("#drive-now")
    toast(page, "It will try again later")
    page.wait_for_selector("#drive-error:not([hidden])")
    check("500" in page.inner_text("#drive-error"), f"a failed upload is shown in the section ({page.inner_text('#drive-error')})")
    fake.fail_upload = False
    page.click("#drive-now")
    toast(page, "Backed up to Google Drive")
    check(page.locator("#drive-error").is_hidden(), "the next good backup clears it")

    # ---------------- the token runs out ----------------
    fake.revoked.update(fake.tokens)
    n_req = page.evaluate("window.__gis.requests.length")
    page.click("#drive-now")
    toast(page, "sign-in ran out")
    check(page.evaluate("sessionStorage.getItem('upsc.driveToken')") is None, "a 401 drops the token")
    page.click("#drive-now")
    toast(page, "Backed up to Google Drive")
    req = page.evaluate("window.__gis.requests.at(-1)")
    check(page.evaluate("window.__gis.requests.length") == n_req + 1 and req.get("prompt") == "" and req.get("login_hint") == "brother@example.com",
          f"Back up now renews it silently for the same account ({req})")

    # ---------------- automatic: due on open, renewed on the next tap outside a note ----------------
    note_id = page.evaluate("""() => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
        const g = q.result.transaction('notes').objectStore('notes').getAll(); g.onsuccess = () => { q.result.close(); r(g.result[0].id); }; }; })""")
    page.evaluate("sessionStorage.removeItem('upsc.driveToken')")
    set_state(page, {"lastAt": int(time.time() * 1000) - 3 * 86400000, "error": None, "lastTryAt": None})
    count = len(fake.files)
    page.goto(URL + f"#/n/{note_id}")
    page.reload()
    page.wait_for_selector("#f-title")
    n_req = page.evaluate("window.__gis.requests.length")
    page.click("#f-title")
    page.wait_for_timeout(500)
    check(page.evaluate("window.__gis.requests.length") == n_req and len(fake.files) == count, "due, token gone: a tap inside an open note asks Google nothing")
    page.click("#note-back")
    page.wait_for_selector("#folder-grid, .note-card")
    page.wait_for_timeout(300)
    page.mouse.click(640, 30)
    wait_until(page, lambda: len(fake.files) > count)
    page.wait_for_timeout(300)
    check(len(fake.files) == count + 1 and page.evaluate("window.__gis.requests.at(-1).prompt") == "", f"the next tap outside a note renews the token silently and backs up by itself (+{len(fake.files) - count}, {page.evaluate('window.__gis.requests.slice(-2)')}, {page.evaluate('location.hash')})")

    # ---------------- never while a note is open; after leaving it ----------------
    set_state(page, {"lastAt": int(time.time() * 1000) - 3 * 86400000})
    count = len(fake.files)
    page.goto(URL + f"#/n/{note_id}")
    page.wait_for_selector("#f-title")
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_timeout(800)
    check(len(fake.files) == count, f"due with a valid token, but a note is open: no backup while writing (+{len(fake.files) - count})")
    page.click("#note-back")
    wait_until(page, lambda: len(fake.files) > count)
    page.wait_for_timeout(300)
    check(len(fake.files) == count + 1, "leaving the note: the due backup is made")

    # ---------------- big change ----------------
    page.goto(URL + "#/n/new/blank")
    page.wait_for_selector("#f-title")
    page.fill("#f-title", "A brand new note")
    page.wait_for_function("JSON.parse(localStorage.getItem('upsc.driveState')).dirtyAt > JSON.parse(localStorage.getItem('upsc.driveState')).lastAt", timeout=5000)
    check(True, "a new note marks a big change")
    count = len(fake.files)
    set_state(page, {"lastAt": int(time.time() * 1000) - 2 * 3600000, "dirtyAt": int(time.time() * 1000) - 120000})
    page.goto(URL + "#/notes")
    wait_until(page, lambda: len(fake.files) > count)
    page.wait_for_timeout(300)
    check(len(fake.files) == count + 1, f"after a big change (and an hour since the last): backed up when he leaves the note {state(page)} {cfg(page)}")
    set_state(page, {"lastAt": int(time.time() * 1000) - 10 * 60000, "dirtyAt": int(time.time() * 1000) - 120000})
    count = len(fake.files)
    page.goto(URL + "#/more")
    page.wait_for_timeout(800)
    check(len(fake.files) == count, "big changes back up at most once an hour")

    # ---------------- offline ----------------
    set_state(page, {"lastAt": int(time.time() * 1000) - 3 * 86400000, "dirtyAt": None})
    count = len(fake.files)
    ctx.set_offline(True)
    page.evaluate("location.hash = '#/notes'")
    page.wait_for_timeout(600)
    check(len(fake.files) == count, "offline: no try")
    page.evaluate("location.hash = '#/settings'")
    page.wait_for_selector("#drive-now")
    page.click("#drive-now")
    toast(page, "Needs internet")
    page.evaluate("location.hash = '#/notes'")
    page.wait_for_timeout(200)
    ctx.set_offline(False)
    wait_until(page, lambda: len(fake.files) > count)
    page.wait_for_timeout(300)
    check(len(fake.files) == count + 1, f"back online: the due backup is made {state(page)} {page.evaluate('navigator.onLine')}")

    # ---------------- More's warning ----------------
    set_state(page, {"lastAt": int(time.time() * 1000) - 5 * 86400000, "error": None})
    ctx.set_offline(True)
    page.goto(URL + "#/more")
    page.wait_for_selector("#more-backup")
    page.wait_for_timeout(200)
    check("Drive backup missed" in page.inner_text("#more-backup") and "warn" in page.get_attribute("#more-backup", "class"), f"missed > 2× the schedule: More's Backup row in warning colour ({page.inner_text('#more-backup')})")
    check(page.locator(".banner").count() == 0, "and no banner")
    set_state(page, {"lastAt": int(time.time() * 1000) - 1 * 86400000})
    page.goto(URL + "#/")
    page.goto(URL + "#/more")
    page.wait_for_timeout(200)
    check("warn" not in (page.get_attribute("#more-backup", "class") or "") and "Google Drive backup on" in page.inner_text("#more-backup"), "on schedule: no warning")
    ctx.set_offline(False)

    # ---------------- Change schedule ----------------
    settings_page(page)
    page.click("#drive-schedule")
    page.click("[data-every='7']")
    page.click("#drive-turn-on")
    page.wait_for_timeout(200)
    check(cfg(page)["every"] == 7 and page.inner_text("#drive-when").startswith("Every week"), "schedule changed to every week")
    page.click("#drive-schedule")
    page.click("[data-every='2']")
    page.click("#drive-turn-on")

    # ---------------- restore on an empty tablet ----------------
    page.goto(URL + "#/settings")
    page.click("#drive-now")
    toast(page, "Backed up to Google Drive: 3 notes")
    newest = fake.backups(folder)[0]
    ctx2 = new_context(browser, fake)
    p2 = ctx2.new_page()
    p2.on("pageerror", lambda e: errors.append(str(e)))
    p2.goto(URL + "#/")
    p2.wait_for_selector("#restore-card:not([hidden])")
    check(p2.locator("#today-restore").is_visible(), "an empty app: Today offers Restore from Google Drive")
    p2.click("#today-restore")
    p2.wait_for_selector("#drive-restore-sheet .drive-pick")
    picks = p2.locator(".drive-pick")
    check(picks.count() == 10, f"his 10 backups listed ({picks.count()})")
    check(picks.first.get_attribute("data-id") == newest["id"] and "newest" in picks.first.inner_text() and picks.first.get_attribute("aria-pressed") == "true", "newest first, chosen by default")
    check("3 notes" in picks.first.inner_text() and ("Linux" in picks.first.inner_text() or "Browser" in picks.first.inner_text()), f"each shows device and counts ({picks.first.inner_text()!r})")
    check("nothing already on this device is deleted" in p2.inner_text("#drive-restore-sheet"), "the sheet says restore merges")
    p2.click("#drive-restore-go")
    p2.wait_for_selector("#drive-restored")
    check("3 added" in p2.inner_text("#drive-restored-text"), f"restored: {p2.inner_text('#drive-restored-text')}")
    check("now on for this device too" in p2.inner_text("#drive-restored"), "Drive backup turns on for this device too")
    check(p2.evaluate("document.documentElement.dataset.theme") == "night", "his settings came back (night theme)")
    c2 = cfg(p2)
    check(c2["folderId"] == folder and c2["every"] == 2, f"…to the same folder, same schedule ({c2})")
    check(p2.evaluate("""() => new Promise(r => { const q = indexedDB.open('upsc-notes'); q.onsuccess = () => {
        const g = q.result.transaction('notes').objectStore('notes').count(); g.onsuccess = () => { q.result.close(); r(g.result); }; }; })""") == 3, "3 notes on the new tablet")
    p2.click("#drive-go-today")
    p2.wait_for_timeout(400)
    check(p2.locator("#restore-card").is_hidden(), "Today stops offering restore once there are notes")
    p2.goto(URL + "#/settings")
    p2.wait_for_selector("#drive-restore")
    p2.click("#drive-restore")
    p2.wait_for_selector("#drive-restore-sheet .drive-pick")
    p2.click("#drive-restore-go")
    p2.wait_for_selector("#drive-restored")
    check("0 added" in p2.inner_text("#drive-restored-text"), "restoring twice adds nothing")
    p2.keyboard.press("Escape")

    # an older file never undoes a newer choice
    p2.goto(URL + "#/prefs")
    p2.click("[data-theme-opt='day']")
    p2.wait_for_timeout(100)
    p2.goto(URL + "#/settings")
    p2.click("#drive-restore")
    p2.wait_for_selector("#drive-restore-sheet .drive-pick")
    p2.click("#drive-restore-go")
    p2.wait_for_selector("#drive-restored")
    check(p2.evaluate("document.documentElement.dataset.theme") == "day", "a theme chosen here after the backup stays (the file's is older)")
    ctx2.close()

    # a format-4 file still imports through the same path
    fmt4 = dict(data)
    fmt4["format"] = 4
    fmt4.pop("settings")
    ctx3 = new_context(browser, fake)
    p3 = ctx3.new_page()
    p3.goto(URL + "#/settings")
    p3.wait_for_selector("#import-file", state="attached")
    p3.set_input_files("#import-file", files=[{"name": "old.json", "mimeType": "application/json", "buffer": json.dumps(fmt4).encode()}])
    expect(p3.locator(".import-result")).to_contain_text("2 added", timeout=5000)
    bad = dict(data)
    bad["settings"] = ["not", "an", "object"]
    p3.set_input_files("#import-file", files=[{"name": "bad.json", "mimeType": "application/json", "buffer": json.dumps(bad).encode()}])
    expect(p3.locator(".import-result")).to_contain_text("damaged", timeout=5000)
    check(True, "format 4 imports; a format-5 file with broken settings is refused")
    ctx3.close()

    # ---------------- Picker: a folder he chooses ----------------
    ctx4 = new_context(browser, fake)
    p4 = ctx4.new_page()
    p4.on("pageerror", lambda e: errors.append(str(e)))
    capture(p4, "A note on the second tablet")
    mine = fake.add("My UPSC", "application/vnd.google-apps.folder", ["root"], {})
    p4.evaluate("(f) => localStorage.setItem('__pick', JSON.stringify(f))", {"id": mine["id"], "name": "My UPSC"})
    settings_page(p4)
    p4.click("#drive-connect")
    p4.wait_for_selector("#drive-folder-sheet")
    p4.click("#drive-folder-pick")
    p4.wait_for_selector("#drive-schedule-sheet")
    pk = p4.evaluate("window.__gis.picker")
    check(pk["token"].startswith("tok-") and pk["key"].startswith("AIza") and pk["app"] == "1050877831533", f"the Picker gets the token, API key and project number ({pk['app']})")
    p4.click("#drive-turn-on")
    toast(p4, "Backed up to Google Drive")
    check(len(fake.backups(mine["id"])) == 1 and p4.inner_text("#drive-folder") == "My Drive › My UPSC", "the backup goes to the folder he picked")
    # the picked folder is removed in Drive: backups go to "UPSC Notes backups" (found, not a second one made)
    fake.files[mine["id"]]["trashed"] = True
    p4.click("#drive-now")
    toast(p4, "Backed up to Google Drive")
    check(len(fake.folders()) == 2 and cfg(p4)["folderId"] == folder, "picked folder gone: back to the app's own folder, found again (no duplicate)")

    # ---------------- disconnect ----------------
    count = len(fake.files)
    p4.click("#drive-disconnect")
    p4.click("#drive-disconnect-go")
    toast(p4, "disconnected")
    check(not state(p4)["on"] and len(p4.evaluate("window.__gis.revoked")) == 1, "Disconnect: off, and Google's permission revoked")
    check(len(fake.files) == count and p4.locator("#drive-connect").is_visible(), "backups stay in Drive; Connect is offered again")
    ctx4.close()

    # ---------------- the full-page sign-in ----------------
    ctx5 = new_context(browser, fake)
    p5 = ctx5.new_page()
    p5.on("pageerror", lambda e: errors.append(str(e)))
    capture(p5, "A note on the installed app")
    p5.evaluate("localStorage.setItem('upsc.driveState', JSON.stringify({ on: false, signin: 'redirect' }))")
    settings_page(p5)
    p5.click("#drive-connect")
    p5.wait_for_selector("#drive-folder-sheet", timeout=10000)
    a = fake.auth_requests[-1]
    check(a["redirect_uri"] == URL and a["response_type"] == "token" and a["scope"] == SCOPE and a["prompt"] == "select_account",
          f"full page: Google's address with this app's return address, token flow, drive.file only ({a['redirect_uri']})")
    check(p5.evaluate("location.hash") == "#/settings" and "access_token" not in p5.evaluate("location.href"), "back on Backup & storage; the token is not left in the address")
    p5.click("#drive-folder-new")
    p5.click("#drive-turn-on")
    toast(p5, "Backed up to Google Drive")
    # silent renewal at launch
    count = len(fake.files)
    p5.evaluate("sessionStorage.removeItem('upsc.driveToken')")
    set_state(p5, {"lastAt": int(time.time() * 1000) - 3 * 86400000, "error": None})
    p5.goto(URL + "?launch=1#/")  # a launch: one fresh page load (a hash change alone would already start it)
    wait_until(p5, lambda: len(fake.files) > count)
    check(len(fake.files) == count + 1 and fake.auth_requests[-1]["prompt"] == "none" and fake.auth_requests[-1].get("login_hint") == "brother@example.com",
          f"full-page mode: a due backup renews at launch without a prompt and backs up (+{len(fake.files) - count}, {fake.auth_requests[-1]})")
    p5.wait_for_timeout(300)
    check(p5.evaluate("location.hash") == "#/" and "access_token" not in p5.evaluate("location.href"), "and returns to Today")
    # silent renewal refused (signed out of Google): asks him, once
    p5.evaluate("sessionStorage.removeItem('upsc.driveToken')")
    set_state(p5, {"lastAt": int(time.time() * 1000) - 3 * 86400000, "error": None})
    fake.auth_error = "interaction_required"
    n_auth = len(fake.auth_requests)
    p5.reload()
    p5.wait_for_function("JSON.parse(localStorage.getItem('upsc.driveState')).needsSignIn === true", timeout=10000)
    p5.reload()
    p5.wait_for_timeout(1500)
    check(len(fake.auth_requests) == n_auth + 1, "a refused silent sign-in is not retried on every launch")
    settings_page(p5)
    check("sign in again" in p5.inner_text("#drive-error"), "Backup & storage asks him to sign in again")
    fake.auth_error = None
    ctx5.close()

    # ---------------- Google's script not loaded yet when he taps ----------------
    ctx6 = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx6.route("https://www.googleapis.com/**", fake.handle)
    gis_served = {"on": False}
    ctx6.route("https://accounts.google.com/gsi/client", lambda r: r.fulfill(status=200, content_type="text/javascript", body=GIS_STUB) if gis_served["on"] else r.abort())
    p6 = ctx6.new_page()
    p6.on("pageerror", lambda e: errors.append(str(e)))
    capture(p6, "A note while Google loads")
    settings_page(p6)
    p6.wait_for_timeout(300)
    check(not p6.evaluate("!!window.google"), "Google's script couldn't load (offline from Google)")
    gis_served["on"] = True
    p6.click("#drive-connect")
    p6.wait_for_selector("#drive-loading")
    p6.wait_for_selector("#drive-continue:not([disabled])")
    check(p6.evaluate("!!window.google?.accounts?.oauth2"), "a tap before it loaded: the app loads it and asks for one more tap")
    p6.click("#drive-continue")
    p6.wait_for_selector("#drive-folder-sheet")
    check((state(p6) or {}).get("signin") != "redirect", "…then Google's popup runs within that tap (the device keeps the popup sign-in)")
    ctx6.close()

    check(not errors, f"no page errors {errors}")
    browser.close()

sys.exit(1 if failures else 0)
