(() => {
  "use strict";

  // Base URL for anchor/form resolution. Inside a srcdoc iframe location.href is
  // "about:srcdoc", which throws for relative inputs — so we resolve against the target's
  // origin/pathname that the server injected via __INSITE__.
  const BASE = window.__INSITE__?.target || "https://example.com/";

  const state = { picking: false, hover: null, oldOutline: "", dark: false };
  const send = (type, value = {}) => {
    try {
      parent.postMessage({ type, ...value }, "*");
    } catch {
      /* noop */
    }
  };

  function absolute(href) {
    try {
      return new URL(href, BASE).href;
    } catch {
      return "";
    }
  }

  function describe(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const text = (el.textContent || "").trim();
    return {
      tag: el.tagName,
      id: el.id || "",
      class: typeof el.className === "string" ? el.className : "",
      role: el.getAttribute("role") || "",
      text: text.length > 500 ? text.slice(0, 500) + "…" : text,
      box: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      styles: {
        display: cs.display,
        position: cs.position,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        font: cs.font,
        margin: cs.margin,
        padding: cs.padding,
      },
    };
  }

  function stopPicker() {
    state.picking = false;
    if (state.hover) {
      try {
        state.hover.style.outline = state.oldOutline;
      } catch {
        /* noop */
      }
      state.hover = null;
    }
    document.removeEventListener("mousemove", pickMove, true);
    document.removeEventListener("click", pickClick, true);
  }

  function pickMove(e) {
    if (!state.picking) return;
    if (state.hover) state.hover.style.outline = state.oldOutline;
    state.hover = e.target;
    state.oldOutline = state.hover.style.outline;
    state.hover.style.outline = "2px solid #60a5fa";
  }

  function pickClick(e) {
    if (!state.picking) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = e.target;
    const value = describe(el);
    stopPicker();
    send("insite:element", { value });
  }

  function startPicker() {
    if (state.picking) return;
    state.picking = true;
    document.addEventListener("mousemove", pickMove, true);
    document.addEventListener("click", pickClick, true);
  }

  function toggleDark() {
    let s = document.getElementById("__insite_dark__");
    if (!s) {
      s = document.createElement("style");
      s.id = "__insite_dark__";
      document.documentElement.appendChild(s);
    }
    state.dark = !state.dark;
    s.textContent = state.dark
      ? "html{background:#111!important;filter:invert(.92) hue-rotate(180deg)!important}img,video,canvas,iframe{filter:invert(1) hue-rotate(180deg)!important}"
      : "";
  }

  // ---- Anchor and form interception ----------------------------------------
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented) return;
      const a = e.target.closest?.("a[href]");
      if (!a) return;
      const raw = a.getAttribute("href");
      if (!raw || raw.startsWith("#")) return;
      const u = absolute(raw);
      if (!/^https?:/i.test(u)) return;

      // Middle-click, ctrl/cmd/shift/alt click → open a proxied tab instead of navigating.
      if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        send("insite:openTab", { url: u });
        return;
      }
      if (e.button !== 0) return;

      // Download attribute → hand off to the shell so the browser gets a Content-Disposition
      // response.
      if (a.hasAttribute("download")) {
        e.preventDefault();
        send("insite:download", { url: u });
        return;
      }

      // Same-origin same-pathname (SPA link that only changes hash/query) → let the page
      // handle it so client-side routers work.
      try {
        const cur = new URL(location.href, BASE);
        const dest = new URL(u);
        if (dest.origin === cur.origin && dest.pathname === cur.pathname) return;
      } catch {
        /* fall through */
      }

      e.preventDefault();
      e.stopPropagation();
      send("insite:navigate", { url: u });
    },
    true,
  );

  document.addEventListener(
    "submit",
    (e) => {
      const f = e.target;
      if (!(f instanceof HTMLFormElement)) return;
      const method = (f.method || "get").toLowerCase();
      const u = absolute(f.getAttribute("action") || location.href);
      if (!/^https?:/i.test(u)) return;
      e.preventDefault();
      if (method === "get") {
        const q = new URLSearchParams();
        for (const [k, v] of new FormData(f)) {
          if (typeof v === "string") q.append(k, v);
        }
        const dest = new URL(u);
        for (const [k, v] of q) dest.searchParams.append(k, String(v));
        send("insite:navigate", { url: dest.href });
      } else {
        // POST bodies flow through /api/page with method=POST; ask the shell to navigate
        // via GET only if we cannot preserve the payload. For now the shell drops POST bodies
        // when navigating from a form click (documented limitation).
        send("insite:navigate", { url: u });
      }
    },
    true,
  );

  // ---- SPA route detection --------------------------------------------------
  const emitUrl = () =>
    send("insite:urlchange", {
      url: absolute(location.pathname + location.search + location.hash),
    });
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    emitUrl();
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    emitUrl();
    return r;
  };
  window.addEventListener("popstate", emitUrl);

  // ---- Shell → iframe messages ---------------------------------------------
  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.type !== "string") return;

    if (d.type === "insite:showEruda" && window.eruda) {
      try {
        window.eruda.show(d.tool && d.tool !== "all" ? d.tool : undefined);
      } catch {
        try {
          window.eruda.show();
        } catch {
          /* noop */
        }
      }
    } else if (d.type === "insite:pick") {
      startPicker();
    } else if (d.type === "insite:dark") {
      toggleDark();
    } else if (d.type === "insite:eval" && typeof d.code === "string") {
      try {
        const fn = new Function("return (async () => { " + d.code + " })()");
        const value = await fn();
        let safe;
        try {
          safe = JSON.parse(JSON.stringify(value));
        } catch {
          safe = String(value);
        }
        send("insite:result", { ok: true, value: safe });
      } catch (err) {
        send("insite:result", { ok: false, error: err?.stack || String(err) });
      }
    }
  });

  send("insite:status", { text: "Connected ✓" });
})();
