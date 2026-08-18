(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const frame = $("site");

  const MAX_HISTORY = 100;
  const FETCH_TIMEOUT_MS = 30_000;
  const ERROR_TAIL_MAX = 2048;

  const state = { current: "", history: [], index: -1, loading: false };
  loadHistory();

  const KNOWN_MESSAGES = new Set([
    "insite:navigate",
    "insite:openTab",
    "insite:download",
    "insite:result",
    "insite:element",
    "insite:status",
    "insite:urlchange",
  ]);

  function normalize(v) {
    v = String(v || "").trim();
    if (!v) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "https://" + v;
    try {
      const u = new URL(v);
      return ["http:", "https:"].includes(u.protocol) ? u.href : "";
    } catch {
      return "";
    }
  }

  function b64url(s) {
    const bytes = new TextEncoder().encode(s);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function pageUrl(url) {
    return `/api/page/${b64url(url)}`;
  }

  async function checkAuth() {
    try {
      const r = await fetch("/auth/status", { cache: "no-store" });
      const j = await r.json();
      const ok = !j.required || j.authenticated;
      $("proxyState").textContent = ok ? (j.required ? "Protected ✓" : "Open") : "Auth required";
      $("proxyState").classList.toggle("ok", ok);
      $("proxyState").classList.toggle("err", !ok);
      $("login").classList.toggle("hide", ok);
      $("logout").classList.toggle("hide", !j.required);
      return ok;
    } catch {
      $("proxyState").textContent = "Auth error";
      $("proxyState").classList.add("err");
      return false;
    }
  }

  function setTarget(u) {
    state.current = u;
    $("url").value = u;
    $("targetCard").innerHTML = "";
    const line = document.createElement("div");
    line.textContent = u;
    const sub = document.createElement("div");
    sub.className = "muted";
    sub.textContent = "Same-origin API browser";
    $("targetCard").append(line, sub);
  }

  function showSpinner(on) {
    $("spinner").classList.toggle("hide", !on);
  }

  async function navigate(raw, push = true) {
    const u = normalize(raw);
    if (!u) {
      flashError("Enter a valid http(s) URL.");
      return;
    }
    if (state.loading) return;
    state.loading = true;
    setTarget(u);
    $("loadError").classList.add("hide");
    $("erudaState").textContent = "Loading…";
    showSpinner(true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const r = await fetch(pageUrl(u), {
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
      });
      if (r.status === 401) {
        await checkAuth();
        throw new Error("Authentication required.");
      }
      if (!r.ok) {
        const tail = (await r.text()).slice(0, ERROR_TAIL_MAX);
        throw new Error(`${r.status} ${r.statusText}: ${tail}`);
      }
      const html = await r.text();
      frame.srcdoc = html;
      if (push) {
        state.history = state.history.slice(0, state.index + 1);
        state.history.push(u);
        if (state.history.length > MAX_HISTORY) state.history.shift();
        state.index = state.history.length - 1;
        saveHistory();
      }
      $("erudaState").textContent = "Eruda 3.4.3";
      updateNavButtons();
    } catch (e) {
      const msg =
        e.name === "AbortError" ? "Request timed out." : "Could not load target: " + e.message;
      flashError(msg);
      $("erudaState").textContent = "Load failed";
    } finally {
      clearTimeout(timer);
      state.loading = false;
      showSpinner(false);
    }
  }

  function flashError(msg) {
    $("loadError").textContent = msg;
    $("loadError").classList.remove("hide");
  }

  function updateNavButtons() {
    $("back").disabled = state.index <= 0;
    $("forward").disabled = state.index + 1 >= state.history.length;
  }

  function saveHistory() {
    try {
      localStorage.setItem(
        "insite.history",
        JSON.stringify({ h: state.history.slice(-MAX_HISTORY), i: state.index }),
      );
    } catch {
      /* quota, incognito, etc. */
    }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem("insite.history");
      if (!raw) return;
      const j = JSON.parse(raw);
      if (Array.isArray(j.h)) {
        state.history = j.h.slice(-MAX_HISTORY);
        state.index = Math.max(-1, Math.min(state.history.length - 1, Number(j.i) || -1));
      }
    } catch {
      /* corrupt, ignore */
    }
  }

  $("nav").addEventListener("submit", (e) => {
    e.preventDefault();
    navigate($("url").value);
  });
  $("back").onclick = () => {
    if (state.index > 0) {
      state.index--;
      navigate(state.history[state.index], false);
    }
  };
  $("forward").onclick = () => {
    if (state.index + 1 < state.history.length) {
      state.index++;
      navigate(state.history[state.index], false);
    }
  };
  $("reload").onclick = () => state.current && navigate(state.current, false);
  $("newTab").onclick = () => {
    if (state.current) window.open(pageUrl(state.current), "_blank", "noopener,noreferrer");
  };
  $("clearHistory").onclick = () => {
    state.history = [];
    state.index = -1;
    saveHistory();
    updateNavButtons();
  };
  $("logout").onclick = async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.reload();
  };

  $("health").onclick = async () => {
    try {
      const r = await fetch("/healthz", { cache: "no-store" });
      const j = await r.json();
      $("healthOut").hidden = false;
      $("healthOut").textContent = JSON.stringify(j, null, 2);
    } catch (e) {
      $("healthOut").hidden = false;
      $("healthOut").textContent = "Health check failed: " + e.message;
    }
  };

  $("fab").onclick = () => $("drawer").classList.toggle("open");
  $("closeDrawer").onclick = () => $("drawer").classList.remove("open");
  document.querySelectorAll(".drawer-tabs button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".drawer-tabs button").forEach((x) => {
        x.classList.remove("active");
        x.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      b.setAttribute("aria-selected", "true");
      $("tab-" + b.dataset.tab).classList.add("active");
    };
  });

  function message(type, data = {}) {
    frame.contentWindow?.postMessage({ type, ...data }, "*");
  }
  $("devtools").onclick = () => message("insite:showEruda", { tool: "console" });
  document
    .querySelectorAll("[data-tool]")
    .forEach((b) => (b.onclick = () => message("insite:showEruda", { tool: b.dataset.tool })));
  $("pick").onclick = () => message("insite:pick");
  $("dark").onclick = () => message("insite:dark");
  $("run").onclick = () => {
    $("drawer").classList.add("open");
    document.querySelector('[data-tab="js"]').click();
    $("code").focus();
  };
  $("execute").onclick = () => message("insite:eval", { code: $("code").value });
  $("html").onclick = () => message("insite:eval", { code: "document.documentElement.outerHTML" });
  $("text").onclick = () =>
    message("insite:eval", { code: "document.body ? document.body.innerText : ''" });

  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.type !== "string") return;
    if (!KNOWN_MESSAGES.has(d.type)) return;

    if (d.type === "insite:navigate" && typeof d.url === "string") navigate(d.url);
    else if (d.type === "insite:openTab" && typeof d.url === "string") {
      window.open(pageUrl(d.url), "_blank", "noopener,noreferrer");
    } else if (d.type === "insite:download" && typeof d.url === "string") {
      const a = document.createElement("a");
      a.href = pageUrl(d.url);
      a.rel = "noopener noreferrer";
      a.click();
    } else if (d.type === "insite:result") {
      $("result").textContent = d.ok ? formatValue(d.value) : "ERROR: " + d.error;
    } else if (d.type === "insite:element") {
      $("drawer").classList.add("open");
      document.querySelector('[data-tab="element"]').click();
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(d.value, null, 2);
      const container = $("elementOut");
      container.textContent = "";
      container.appendChild(pre);
    } else if (d.type === "insite:status" && typeof d.text === "string") {
      $("erudaState").textContent = d.text;
    } else if (d.type === "insite:urlchange" && typeof d.url === "string") {
      $("url").value = d.url;
      state.current = d.url;
    }
  });

  function formatValue(v) {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("loginError").textContent = "";
    const password = $("password").value;
    const r = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password }),
    });
    if (r.ok) {
      $("password").value = "";
      $("login").classList.add("hide");
      await checkAuth();
      if (!state.current) navigate("https://example.com");
    } else if (r.status === 429) {
      $("loginError").textContent = "Too many attempts. Try again later.";
    } else {
      $("loginError").textContent = "Invalid password.";
    }
  };

  // Keyboard shortcuts.
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "l") {
      e.preventDefault();
      $("url").focus();
      $("url").select();
    } else if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      $("back").click();
    } else if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      $("forward").click();
    } else if (mod && e.key.toLowerCase() === "r") {
      e.preventDefault();
      $("reload").click();
    } else if (e.key === "F12") {
      e.preventDefault();
      message("insite:showEruda", { tool: "console" });
    }
  });

  updateNavButtons();

  // Boot: only fetch the default page once we know auth is OK; otherwise show the login modal
  // and let the login form kick things off. This kills the race where navigate() would fire
  // against /api/page while the modal was still showing.
  (async () => {
    const authed = await checkAuth();
    if (authed) navigate("https://example.com");
    else $("password").focus();
  })();
})();
