# Test-environment shim (macOS host): make Chromium look like the Linux container the suites were
# written for (and like the Android tablet): Linux user agent + navigator.platform, so ProseMirror's
# "Mod" is Ctrl and the app names the device as on Linux. Loaded only via PYTHONPATH by scripts/run-suites.sh.
import os
if os.environ.get("UPSC_LINUX_SHIM"):
    from playwright.sync_api import _generated as g
    UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    JS = "Object.defineProperty(Navigator.prototype,'platform',{get:()=> 'Linux x86_64'});" \
         "try{Object.defineProperty(Navigator.prototype,'userAgentData',{get:()=>undefined})}catch(e){}"
    def wrap(cls, name):
        orig = getattr(cls, name)
        def f(self, *a, **k):
            k.setdefault("user_agent", UA)
            ctx = orig(self, *a, **k)
            ctx.add_init_script(JS)
            return ctx
        setattr(cls, name, f)
    wrap(g.Browser, "new_context")
    wrap(g.BrowserType, "launch_persistent_context")
    orig_np = g.Browser.new_page
    def new_page(self, *a, **k):
        k.setdefault("user_agent", UA)
        p = orig_np(self, *a, **k)
        p.context.add_init_script(JS)
        p.add_init_script(JS)
        return p
    g.Browser.new_page = new_page
    # macOS Chromium: Home/End go to the document's start/end; on Linux/Android they go to the line's.
    KEYMAP = {"Home": "Meta+ArrowLeft", "End": "Meta+ArrowRight", "Shift+Home": "Shift+Meta+ArrowLeft", "Shift+End": "Shift+Meta+ArrowRight",
              "Control+Home": "Meta+ArrowUp", "Control+End": "Meta+ArrowDown", "Control+Shift+Home": "Shift+Meta+ArrowUp", "Control+Shift+End": "Shift+Meta+ArrowDown"}
    orig_press = g.Keyboard.press
    def press(self, key, *a, **k):
        return orig_press(self, KEYMAP.get(key, key), *a, **k)
    g.Keyboard.press = press
