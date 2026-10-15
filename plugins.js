/* ==========================================================================
   BOOSTER OS — PLUGIN SYSTEM  (plugins.js)
   Spicetify-style: extensions (JS), themes (CSS), custom pages, a Plugins page (toggle + add by link or file).

   A plugin is a single .js file that calls:

     BOS.register({
       id: "my-plugin",            // unique, a-z 0-9 -
       name: "My Plugin",
       version: "1.0.0",
       init(api){ ... },           // called when enabled
       destroy(){ ... }            // optional; everything made through `api` is auto-cleaned
     });

   See README.md for the full API.
   ========================================================================== */
(function () {
  "use strict";

  var B = window.__BOS_BRIDGE;
  if (!B) { console.error("[BOS] plugin bridge missing — plugins disabled."); return; }

  var LS = "bosPlugins_";
  var ls = {
    get: function (k, d) { try { var v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {} }
  };

  var defs = {};      // id -> definition passed to BOS.register
  var active = {};    // id -> { cleanups: [] }
  var status = {};    // id -> "off" | "loading" | "on" | "error"
  var errors = {};    // id -> message
  var $ = B.$, $$ = B.$$, esc = B.esc;

  /* ------------------------------------------------------------------ registry */
  function registry() {
    var base = Array.isArray(window.BOS_PLUGIN_REGISTRY) ? window.BOS_PLUGIN_REGISTRY : [];
    var user = ls.get("user", []);
    return base.map(function (p) { return Object.assign({ builtin: true }, p); })
      .concat(user.map(function (p) { return Object.assign({ builtin: false }, p); }));
  }
  function findEntry(id) { return registry().filter(function (p) { return p.id === id; })[0]; }
  /* in-app toggle (saved in this browser) wins; registry.js "enabled" is the default for first load */
  function isEnabled(p) {
    var map = ls.get("enabled", {});
    return p.id in map ? !!map[p.id] : !!p.enabled;
  }
  function setEnabled(id, v) { var m = ls.get("enabled", {}); m[id] = !!v; ls.set("enabled", m); }

  /* ------------------------------------------------------------------ scoped API given to each plugin */
  function makeApi(id, cleanups) {
    function addCleanup(fn) { cleanups.push(fn); return fn; }
    var P = B.Player, S = B.State;
    var api = {
      id: id,
      version: 1,

      /* ---- player ---- */
      player: {
        play: function (track, list, index) { return P.play(track, list || null, index == null ? null : index, { autoTransition: false }); },
        pause: function () { P.pause(); },
        resume: function () { P.resume(); },
        toggle: function () { P.toggle(); },
        next: function () { return P.next(false); },
        prev: function () { P.prev(); },
        seek: function (sec) { P.seekTo(sec); },
        setVolume: function (v) { P.setVolume(v); },
        get track() { return S.currentTrack; },
        get isPlaying() { return !!S.isPlaying; },
        get queue() { return S.queue; },
        get volume() { return S.volume; },
        get position() { return B.primaryAudio().currentTime || 0; },
        get duration() { return B.primaryAudio().duration || 0; },
        get audio() { return B.primaryAudio(); }
      },

      /* ---- events: trackchange | play | pause | ended | progress ---- */
      on: function (evt, fn) { var off = B.on(evt, fn); addCleanup(off); return off; },

      /* ---- UI ---- */
      ui: {
        toast: function (msg, type) { B.toast(String(msg), type); },
        /* inject CSS that is removed when the plugin is disabled */
        css: function (text) {
          var el = document.createElement("style");
          el.setAttribute("data-bos-plugin", id);
          el.textContent = text;
          document.head.appendChild(el);
          addCleanup(function () { el.remove(); });
          return el;
        },
        /* small button in the top bar. opts: {label, icon (svg string), title, onClick} */
        addTopbarButton: function (opts) {
          var host = $("#topbar .flex-c");
          if (!host) return null;
          var b = document.createElement("button");
          b.className = "icon-btn";
          b.setAttribute("data-bos-plugin", id);
          b.setAttribute("aria-label", opts.title || opts.label || id);
          b.title = opts.title || opts.label || "";
          b.innerHTML = (opts.icon || "") + (opts.label ? '<span class="bos-plg-btnlabel">' + esc(opts.label) + "</span>" : "");
          b.addEventListener("click", function (e) { try { opts.onClick && opts.onClick(e, b); } catch (err) { fail(id, err); } });
          host.insertBefore(b, host.firstChild);
          addCleanup(function () { b.remove(); });
          b.setLabel = function (t) {
            var s = b.querySelector(".bos-plg-btnlabel");
            if (!s) { s = document.createElement("span"); s.className = "bos-plg-btnlabel"; b.appendChild(s); }
            s.textContent = t || ""; if (!t) s.remove();
          };
          return b;
        },
        /* sidebar link + full page. opts: {id, title, icon (svg), render(container, api)} */
        addPage: function (opts) {
          var key = id + "-" + opts.id;
          var view = document.createElement("div");
          view.className = "view"; view.id = "view-plugin-" + key;
          view.setAttribute("data-bos-plugin", id);
          $("#view-scroll").appendChild(view);

          var nav = document.createElement("div");
          nav.className = "nav-item"; nav.setAttribute("data-nav", "plugin:" + key);
          nav.setAttribute("data-bos-plugin", id);
          nav.innerHTML = (opts.icon || ICON.puzzle) + '<span class="nlabel">' + esc(opts.title) + "</span>";
          var spacer = $("#sidebar .nav-spacer");
          spacer.parentNode.insertBefore(nav, spacer);
          nav.addEventListener("click", function () { showPage(key, opts.title, view, opts.render, api); });

          addCleanup(function () {
            var wasHere = view.classList.contains("active");
            view.remove(); nav.remove();
            if (wasHere) B.navigate("home");
          });
          return { open: function () { showPage(key, opts.title, view, opts.render, api); }, el: view };
        }
      },

      /* ---- theme helpers (revert automatically) ---- */
      theme: {
        /* set CSS variables, e.g. { "--accent-r": 255, "--bg-0": "#000" } */
        setVars: function (vars) {
          var root = document.documentElement, prev = {};
          Object.keys(vars).forEach(function (k) {
            prev[k] = root.style.getPropertyValue(k);
            root.style.setProperty(k, String(vars[k]));
          });
          addCleanup(function () {
            Object.keys(prev).forEach(function (k) {
              if (prev[k]) root.style.setProperty(k, prev[k]); else root.style.removeProperty(k);
            });
          });
        }
      },

      /* ---- per-plugin persistent storage ---- */
      storage: {
        get: function (k, d) { return ls.get("data_" + id + "_" + k, d); },
        set: function (k, v) { ls.set("data_" + id + "_" + k, v); }
      },

      /* ---- sources: songs for Search + playback. ON = songs appear, OFF = they disappear (removed automatically) ----
         src = { name, search(q,{signal,limit}) -> [{id,name,artistName,image,duration}], resolve(track) -> url | {url,alt}, ttl(ms) } */
      sources: {
        register: function (src) {
          if (!src || typeof src.search !== "function") throw new Error("api.sources.register needs { name, search(q), resolve(track) }");
          var off = B.SourceHub.register(Object.assign({}, src, { id: id, name: src.name || id }));
          addCleanup(off); return off;
        }
      },

      /* ---- timers that stop when the plugin is disabled ---- */
      setInterval: function (fn, ms) { var t = setInterval(fn, ms); addCleanup(function () { clearInterval(t); }); return t; },
      setTimeout: function (fn, ms) { var t = setTimeout(fn, ms); addCleanup(function () { clearTimeout(t); }); return t; },

      navigate: function (view, params) { B.navigate(view, params); },

      /* power users: the raw app internals (State, Queue, Store, Api, History...).
         Not a stable API — may change between app versions. */
      unsafe: B
    };
    return api;
  }

  function showPage(key, title, view, render, api) {
    $$(".view").forEach(function (v) { v.classList.remove("active"); });
    view.classList.add("active");
    B.State.view = "plugin:" + key;
    var t = $("#page-title"); if (t) t.textContent = title;
    $$(".nav-item,.bn-item").forEach(function (n) { n.classList.toggle("active", n.dataset.nav === "plugin:" + key); });
    var sc = $("#view-scroll"); if (sc) sc.scrollTop = 0;
    try { history.pushState({ boosterOS: true, view: "home", params: {}, depth: ((history.state && history.state.depth) || 0) + 1, scrollTop: 0 }, "", "#plugin-" + key); } catch (e) {}
    try { render && render(view, api); } catch (e) { view.innerHTML = '<div class="empty-state"><div class="es-title">Plugin page failed</div><div class="es-desc">' + esc(e.message) + "</div></div>"; console.error(e); }
  }

  /* ------------------------------------------------------------------ lifecycle */
  function fail(id, err) {
    console.error("[BOS plugin " + id + "]", err);
    status[id] = "error"; errors[id] = String(err && err.message || err);
    B.toast("Plugin '" + id + "' error: " + errors[id], "error");
    refreshManager();
  }

  function start(id) {
    var def = defs[id];
    if (!def) return;
    if (active[id]) return;
    var cleanups = [];
    var apiObj = makeApi(id, cleanups);
    active[id] = { cleanups: cleanups, api: apiObj };
    try {
      var r = def.init && def.init(apiObj);
      if (r && typeof r.then === "function") {
        r.then(function () { status[id] = "on"; }, function (e) { stop(id); fail(id, e); });
        status[id] = "loading";
      } else { status[id] = "on"; }
      delete errors[id];
    } catch (e) { stop(id); fail(id, e); }
    refreshManager();
  }

  function stop(id) {
    var a = active[id];
    var def = defs[id];
    if (a) {
      try { def && def.destroy && def.destroy(); } catch (e) { console.error(e); }
      a.cleanups.splice(0).reverse().forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
      delete active[id];
    }
    status[id] = "off";
    refreshManager();
  }

  function loadScript(url, onload, onerror) {
    var s = document.createElement("script");
    s.src = url; s.async = true; s.setAttribute("data-bos-plugin-src", url.slice(0, 80));
    s.onload = onload; s.onerror = onerror;
    document.head.appendChild(s);
  }
  function blobUrl(code, mime) { return URL.createObjectURL(new Blob([code], { type: mime })); }
  function srcOf(entry) { return entry.code ? blobUrl(entry.code, entry.type === "theme" ? "text/css" : "text/javascript") : entry.entry; }

  var stylesheets = {};
  function enable(id) {
    var entry = findEntry(id); if (!entry) return;
    setEnabled(id, true);
    if (entry.type === "source") B.SourceHub.changed();
    if (entry.type === "theme") {
      if (stylesheets[id]) return;
      var l = document.createElement("link");
      l.rel = "stylesheet"; l.href = srcOf(entry); l.setAttribute("data-bos-plugin", id);
      l.onerror = function () { l.remove(); delete stylesheets[id]; fail(id, new Error("could not load the theme")); };
      document.head.appendChild(l); stylesheets[id] = l; status[id] = "on"; refreshManager();
      return;
    }
    if (defs[id]) { start(id); return; }
    status[id] = "loading";
    loadScript(srcOf(entry), function () {
      if (!defs[id]) return fail(id, new Error("file loaded but never called BOS.register({id:'" + id + "'})"));
      if (isEnabled(entry)) start(id); else status[id] = "off";
    }, function () { fail(id, new Error("could not load " + (entry.entry || "the plugin file"))); });
  }

  function disable(id) {
    var entry = findEntry(id); setEnabled(id, false);
    if (entry && entry.type === "theme") {
      if (stylesheets[id]) { stylesheets[id].remove(); delete stylesheets[id]; }
      status[id] = "off"; return;
    }
    stop(id);
    if (entry && entry.type === "source") B.SourceHub.changed();
  }

  /* ------------------------------------------------------------------ adding plugins from the app */
  var capture = null;
  function slug(s) { return String(s || "plugin").replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin"; }
  function saveUser(p) {
    var user = ls.get("user", []).filter(function (x) { return x.id !== p.id; });
    user.push(p); ls.set("user", user);
  }
  /* Load a JS file just far enough to read its BOS.register({id,name,...}), then keep it. */
  function probeJs(src, done, failed) {
    capture = function (def) { capture = null; done(def); };
    loadScript(src, function () {
      if (capture) { capture = null; failed(new Error("that file never called BOS.register(...)")); }
    }, function () { capture = null; failed(new Error("could not load that URL (wrong link, or the site blocks it)")); });
  }
  function addFromUrl(url) {
    url = String(url || "").trim();
    if (!/^https?:\/\//.test(url)) return B.toast("Paste a full link starting with https://", "error");
    if (!confirm("Plugins run with full access to the app and your saved data.\nOnly add it if you trust the source.\n\n" + url)) return;
    if (/\.css(\?|#|$)/i.test(url)) {
      var tid = slug(url.split("/").pop().split("?")[0]);
      saveUser({ id: tid, name: tid, type: "theme", entry: url, description: "Theme from URL" });
      enable(tid); return B.toast("Theme added");
    }
    probeJs(url, function (def) {
      defs[def.id] = def;
      saveUser({ id: def.id, name: def.name || def.id, type: "extension", entry: url, description: def.description || "Added from URL" });
      enable(def.id); B.toast("Plugin added: " + (def.name || def.id));
    }, function (e) { B.toast(e.message, "error"); });
  }
  function addFromCode(code, filename) {
    if (!confirm("Plugins run with full access to the app and your saved data.\nOnly add it if you trust the source.\n\n" + filename)) return;
    if (/\.css$/i.test(filename)) {
      var tid = slug(filename);
      saveUser({ id: tid, name: tid, type: "theme", code: code, description: "Theme from file" });
      enable(tid); return B.toast("Theme added");
    }
    probeJs(blobUrl(code, "text/javascript"), function (def) {
      defs[def.id] = def;
      saveUser({ id: def.id, name: def.name || def.id, type: "extension", code: code, description: def.description || "Added from file" });
      enable(def.id); B.toast("Plugin added: " + (def.name || def.id));
    }, function (e) { B.toast(e.message, "error"); });
  }
  function removePlugin(id) {
    disable(id);
    ls.set("user", ls.get("user", []).filter(function (x) { return x.id !== id; }));
    var m = ls.get("enabled", {}); delete m[id]; ls.set("enabled", m);
    delete defs[id]; delete status[id]; refreshManager();
  }

  /* ------------------------------------------------------------------ public global */
  window.BOS = {
    version: 1,
    register: function (def) {
      if (!def || !/^[a-z0-9-]+$/.test(def.id || "")) { console.error("[BOS] register(): bad or missing id", def); return; }
      if (capture) { capture(def); return; }
      defs[def.id] = def;
      /* script was loaded by hand (e.g. from the console)? start it right away */
      if (!findEntry(def.id)) { start(def.id); }
    },
    enable: enable, disable: disable,
    addFromUrl: addFromUrl, addFromCode: addFromCode, removePlugin: removePlugin,
    list: function () { return registry().map(function (p) { return { id: p.id, name: p.name, type: p.type, enabled: isEnabled(p), status: status[p.id] || "off" }; }); },
    on: B.on, off: B.off
  };

  /* ------------------------------------------------------------------ icons */
  var ICON = {
    puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h-1a2 2 0 1 0 0 4h1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3z"/></svg>'
  };


  /* ------------------------------------------------------------------ manager page (sidebar → Plugins) */
  var managerEl = null;
  function refreshManager() {
    var lbl = document.querySelector('.nav-item[data-nav="plugin:manager"] .nlabel');
    if (lbl) lbl.textContent = "Plugins (" + registry().length + ")";
    if (managerEl && managerEl.classList.contains("active")) renderManager(managerEl);
  }

  function renderManager(el) {
    var rows = registry().map(function (p) {
      var on = isEnabled(p), st = status[p.id] || (on ? "loading" : "off");
      var badge = st === "error" ? '<span class="bos-plg-badge err">error</span>' : (on ? '<span class="bos-plg-badge on">on</span>' : "");
      return '<div class="bos-plg-row glass-2">'
        + '<div class="bos-plg-info"><div class="bos-plg-name">' + esc(p.name || p.id) + " " + badge
        + ' <span class="bos-plg-type">' + esc(p.type || "extension") + "</span></div>"
        + '<div class="bos-plg-desc">' + esc(p.description || "") + "</div>"
        + (errors[p.id] ? '<div class="bos-plg-errtxt">' + esc(errors[p.id]) + "</div>" : "")
        + "</div>"
        + (defs[p.id] && defs[p.id].configure && active[p.id] ? '<button class="bos-plg-cfg" data-cfg="' + esc(p.id) + '">Settings</button>' : "")
        + (p.builtin ? "" : '<button class="bos-plg-rm" data-rm="' + esc(p.id) + '">Remove</button>')
        + '<label class="bos-plg-sw"><input type="checkbox" data-pl="' + esc(p.id) + '"' + (on ? " checked" : "") + '><span></span></label>'
        + "</div>";
    }).join("");

    el.innerHTML =
      '<div class="bos-plg-wrap">'
      + '<div class="bos-plg-hero"><div class="bos-plg-count">' + registry().length + ' plugin' + (registry().length === 1 ? '' : 's') + '</div>'
      + '<p>' + registry().filter(function (p) { return isEnabled(p); }).length + ' on. Extensions add features, themes change the look. Plugins run with full access to the app, so only add ones you trust.</p></div>'
      + rows
      + '<div class="bos-plg-add glass-2"><div class="bos-plg-name">Add a plugin</div>'
      + '<div class="bos-plg-desc">Paste a link to a .js (extension) or .css (theme) file, or pick a file from your phone/computer.</div>'
      + '<div class="bos-plg-addrow"><input id="bos-plg-url" placeholder="https://raw.githubusercontent.com/you/repo/main/my-plugin.js" autocomplete="off">'
      + '<button id="bos-plg-addbtn">Add link</button></div>'
      + '<div class="bos-plg-addrow"><label class="bos-plg-file">Choose file (.js / .css)<input type="file" id="bos-plg-file" accept=".js,.css,text/javascript,text/css"></label></div>'
      + '</div></div>';

    $$("input[data-pl]", el).forEach(function (cb) {
      cb.addEventListener("change", function () { cb.checked ? enable(cb.dataset.pl) : disable(cb.dataset.pl); setTimeout(function () { renderManager(el); }, 50); });
    });
    $$("[data-cfg]", el).forEach(function (b) {
      b.addEventListener("click", function () {
        var d = defs[b.dataset.cfg], a = active[b.dataset.cfg];
        try { d && d.configure && a && d.configure(a.api); } catch (e) { fail(b.dataset.cfg, e); }
      });
    });
    $$("[data-rm]", el).forEach(function (b) {
      b.addEventListener("click", function () { if (confirm("Remove plugin '" + b.dataset.rm + "'?")) removePlugin(b.dataset.rm); });
    });
    $("#bos-plg-addbtn", el).addEventListener("click", function () { addFromUrl($("#bos-plg-url", el).value); });
    $("#bos-plg-file", el).addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { addFromCode(String(r.result), f.name); };
      r.readAsText(f);
    });
  }

  function installManager() {
    var view = document.createElement("div");
    view.className = "view"; view.id = "view-plugin-manager";
    $("#view-scroll").appendChild(view);
    managerEl = view;

    var nav = document.createElement("div");
    nav.className = "nav-item"; nav.setAttribute("data-nav", "plugin:manager");
    nav.innerHTML = ICON.puzzle + '<span class="nlabel">Plugins (' + registry().length + ')</span>';
    var spacer = $("#sidebar .nav-spacer");
    spacer.parentNode.insertBefore(nav, spacer);
    function openManager() { showPage("manager", "Plugins", view, function (el) { renderManager(el); }, null); }
    nav.addEventListener("click", openManager);

    /* phones hide the sidebar, so also put a Plugins button in the top bar (always visible) */
    var topHost = $("#topbar .flex-c");
    if (topHost) {
      var tb = document.createElement("button");
      tb.className = "icon-btn"; tb.id = "bos-plg-open"; tb.title = "Plugins"; tb.setAttribute("aria-label", "Plugins");
      tb.innerHTML = ICON.puzzle;
      tb.addEventListener("click", openManager);
      topHost.appendChild(tb);
    }

    var css = document.createElement("style");
    css.id = "bos-plugin-system-css";
    css.textContent =
      ".bos-plg-wrap{max-width:760px;margin:0 auto;padding:6px 0 160px;display:flex;flex-direction:column;gap:12px}"
      + ".bos-plg-count{font-size:clamp(24px,5vw,34px);font-weight:800;letter-spacing:-.03em}"
      + ".bos-plg-hero p{color:var(--text-2);font-size:13.5px;margin:4px 0 10px}"
      + ".bos-plg-row,.bos-plg-add{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:var(--r-lg)}"
      + ".bos-plg-add{flex-direction:column;align-items:stretch}"
      + ".bos-plg-info{flex:1;min-width:0}"
      + ".bos-plg-name{font-weight:700;font-size:15px;color:var(--text-1)}"
      + ".bos-plg-desc{color:var(--text-2);font-size:12.5px;margin-top:3px}"
      + ".bos-plg-errtxt{color:#ff6b6b;font-size:12px;margin-top:4px}"
      + ".bos-plg-type{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);margin-left:6px}"
      + ".bos-plg-badge{font-size:10px;font-weight:800;padding:2px 7px;border-radius:99px;margin-left:6px;text-transform:uppercase}"
      + ".bos-plg-badge.on{background:var(--accent-soft);color:var(--text-1)}.bos-plg-badge.err{background:rgba(255,80,80,.25);color:#ff8a8a}"
      + ".bos-plg-sw{position:relative;width:46px;height:26px;flex:none}"
      + ".bos-plg-sw input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:2}"
      + ".bos-plg-sw span{position:absolute;inset:0;border-radius:99px;background:rgba(255,255,255,.14);transition:background .2s}"
      + ".bos-plg-sw span::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s}"
      + ".bos-plg-sw input:checked+span{background:var(--accent)}.bos-plg-sw input:checked+span::after{transform:translateX(20px)}"
      + ".bos-plg-add input[type=text],.bos-plg-add #bos-plg-url{background:rgba(255,255,255,.06);border:1px solid var(--glass-2-brd);border-radius:12px;padding:10px 12px;color:var(--text-1);font:inherit;font-size:13px;min-width:0}"
      + "#bos-plg-addbtn,.bos-plg-file,.bos-plg-rm{background:var(--accent);color:#fff;border:0;border-radius:12px;padding:10px 18px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;display:inline-block}"
      + ".bos-plg-rm{background:rgba(255,80,80,.22);padding:8px 12px;font-size:12px}"
      + ".bos-plg-cfg{background:rgba(255,255,255,.12);color:var(--text-1);border:0;border-radius:12px;padding:8px 12px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}"
      + ".bos-plg-file input{display:none}"
      + ".bos-plg-addrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.bos-plg-addrow #bos-plg-url{flex:1;min-width:160px}"
      + ".bos-plg-btnlabel{font-size:11px;font-weight:700;margin-left:6px;color:var(--text-1)}"
      + "[data-theme=light] .bos-plg-add #bos-plg-url{background:rgba(0,0,0,.05)}";
    document.head.appendChild(css);
  }


  /* ------------------------------------------------------------------ boot */
  function boot() {
    installManager();
    registry().forEach(function (p) { if (p.type === "source") { var m = ls.get("enabled", {}); if (!(p.id in m)) setEnabled(p.id, !!p.enabled); } });
    registry().forEach(function (p) { if (isEnabled(p)) enable(p.id); else status[p.id] = "off"; });
    console.info("[BOS] plugin system ready —", registry().length, "plugin(s) known");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
