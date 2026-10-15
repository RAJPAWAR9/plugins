/* YouTube Music source plugin (audio only) - v1.2.0
   ON  = songs from YouTube Music appear in Search and can be played.   OFF = they disappear.
   Uses Piped API servers (public YouTube front-end). Servers go up and down, so this plugin:
     - loads a live list of Piped servers,
     - for playback, TESTS each server's audio link (CORS + range request) before giving it to the player,
       because the app's <audio> tag uses crossorigin="anonymous" and silently stays mute if the link has no CORS headers,
     - remembers the server that really worked.
   Own server: Plugins -> YouTube Music -> Settings. */
BOS.register({
  id: "ytmusic", name: "YouTube Music", version: "1.2.0",
  description: "Songs from YouTube Music, played as audio.",

  configure: function (api) {
    var cur = api.storage.get("instance", "");
    var v = prompt("Piped API server URL (example: https://pipedapi.kavin.rocks).\nLeave empty to use the automatic server list.", cur);
    if (v === null) return;
    v = v.trim().replace(/\/+$/, "");
    if (v === cur) { api.ui.toast("Unchanged"); return; }
    api.storage.set("instance", v); api.storage.set("good", "");
    api.ui.toast(v ? "Server saved" : "Using the automatic server list");
  },

  init: function (api) {
    var FILTER = "music_songs", FILTER2 = "music_videos";
    var DEFAULTS = [
      "https://pipedapi.kavin.rocks",
      "https://pipedapi.adminforge.de",
      "https://api.piped.private.coffee",
      "https://pipedapi.r4fo.com",
      "https://pipedapi.leptons.xyz",
      "https://pipedapi.nosebs.ru",
      "https://pipedapi.drgns.space"
    ];
    var LIST_URL = "https://piped-instances.kavin.rocks/";
    var DEADLINE = 20000;
    var cache = {};   /* vid -> { url, alt, t } */

    function timed(ms, outer) {
      var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms);
      function onOuter() { ctl.abort(); }
      if (outer) {
        if (outer.aborted) ctl.abort();
        else outer.addEventListener("abort", onOuter, { once: true });
      }
      return {
        signal: ctl.signal,
        done: function () {
          clearTimeout(t);
          if (outer) outer.removeEventListener("abort", onOuter);
        }
      };
    }

    function fetchJson(url, ms, outer) {
      var c = timed(ms, outer);
      return fetch(url, { signal: c.signal }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (j) { c.done(); return j; },
              function (e) { c.done(); throw e; });
    }

    /* live list of Piped servers (cached 6 h); failure is fine, we still have DEFAULTS */
    async function loadDyn() {
      var dyn = api.storage.get("dyn", null);
      if (dyn && dyn.list && dyn.list.length && Date.now() - dyn.t < 6 * 3600 * 1000) return dyn.list;
      try {
        var arr = await fetchJson(LIST_URL, 4000);
        var l = (arr || []).filter(function (x) {
          return x && x.api_url && (x.uptime_30d == null || x.uptime_30d >= 60);
        }).sort(function (a, b) { return (b.uptime_30d || 0) - (a.uptime_30d || 0); })
          .map(function (x) { return String(x.api_url).replace(/\/+$/, ""); })
          .slice(0, 12);
        if (l.length) { api.storage.set("dyn", { t: Date.now(), list: l }); return l; }
      } catch (e) {}
      return (dyn && dyn.list) || [];
    }

    async function bases(max) {
      var extra = await loadDyn();
      var out = [], seen = {};
      [api.storage.get("instance", ""), api.storage.get("good", "")]
        .concat(DEFAULTS, extra)
        .forEach(function (b) {
          b = b && b.replace(/\/+$/, "");
          if (b && !seen[b]) { seen[b] = 1; out.push(b); }
        });
      return out.slice(0, max);
    }

    function videoId(item) {
      var m = String(item.url || "").match(/[?&]v=([\w-]{6,})/);
      return m ? m[1] : null;
    }

    /* direct YouTube links only work from Piped's own server, so route them through its proxy */
    function viaProxy(url, proxyUrl) {
      try {
        if (!proxyUrl) return url;
        var u = new URL(url);
        if (!/(^|\.)googlevideo\.com$/.test(u.hostname)) return url;
        var pr = new URL(proxyUrl);
        u.searchParams.set("host", u.host);
        var base = pr.pathname.replace(/\/+$/, "");
        u.protocol = pr.protocol;
        u.host = pr.host;
        u.pathname = base + u.pathname;
        return u.toString();
      } catch (e) { return url; }
    }

    /* can the <audio crossorigin="anonymous"> tag really load this link? (CORS + range request) */
    async function probe(url, ms, outer) {
      var c = timed(ms || 4500, outer);
      try {
        var r = await fetch(url, { headers: { Range: "bytes=0-1" }, signal: c.signal });
        var ok = r.status === 200 || r.status === 206;
        if (ok) {
          var acao = r.headers.get("access-control-allow-origin");
          var self = (typeof location !== "undefined" && location.origin) || "null";
          if (acao !== "*" && acao !== self) ok = false;
        }
        try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {}
        return ok;
      } catch (e) { return false; }
      finally { c.done(); }
    }

    function cleanArtist(n) {
      return String(n || "YouTube")
        .replace(/\s*-\s*Topic$/i, "")
        .replace(/\s*VEVO$/i, "")
        .replace(/\s*-\s*Official(\s+(Audio|Video))?$/i, "")
        .replace(/\s*\(Official\s+(Audio|Video)\)$/i, "")
        .trim() || "YouTube";
    }

    function pushItems(out, seen, items) {
      (items || []).forEach(function (it) {
        if (it.type && it.type !== "stream") return;
        var vid = videoId(it);
        if (!vid || seen[vid]) return;
        seen[vid] = 1;
        out.push({
          id: "ytmusic:" + vid, _vid: vid,
          name: it.title || "Untitled",
          artistName: cleanArtist(it.uploaderName),
          image: "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg",
          duration: it.duration > 0 ? it.duration : 0
        });
      });
    }

    api.sources.register({
      name: "YouTube Music",
      ttl: 60 * 60 * 1000,   /* YouTube links expire: re-fetch after 60 min */

      search: async function (q, opts) {
        var outer = opts && opts.signal, limit = (opts && opts.limit) || 20;
        var list = await bases(4), lastErr = null, j = null;
        for (var i = 0; i < list.length && !j; i++) {
          try {
            j = await fetchJson(list[i] + "/search?q=" + encodeURIComponent(q) + "&filter=" + FILTER, 3500, outer);
            if (j && j.error) { j = null; throw new Error("server error"); }
          } catch (e) {
            if (e && e.name === "AbortError" && outer && outer.aborted) throw e;
            lastErr = e;
          }
        }
        if (!j) throw lastErr || new Error("no Piped server reachable");

        var out = [], seen = {};
        pushItems(out, seen, j.items);

        /* songs only -> top up with videos (covers, live takes) */
        if (out.length < limit) {
          var list2 = await bases(3), j2 = null;
          for (var m = 0; m < list2.length && !j2; m++) {
            try {
              j2 = await fetchJson(list2[m] + "/search?q=" + encodeURIComponent(q) + "&filter=" + FILTER2, 3000, outer);
              if (j2 && j2.error) { j2 = null; throw new Error("server error"); }
            } catch (e) {
              if (e && e.name === "AbortError" && outer && outer.aborted) throw e;
            }
          }
          if (j2) pushItems(out, seen, j2.items);
        }
        return out.slice(0, limit);
      },

      resolve: async function (track, opts) {
        var outer = opts && opts.signal;
        var vid = track._vid || String(track.id).split(":").pop();

        var hit = cache[vid];
        if (hit && Date.now() - hit.t < 50 * 60 * 1000) return { url: hit.url, alt: hit.alt };

        var list = await bases(7), lastErr = null, t0 = Date.now(), blocked = 0;

        for (var i = 0; i < list.length; i++) {
          var left = DEADLINE - (Date.now() - t0);
          if (left <= 800) break;
          try {
            var j = await fetchJson(list[i] + "/streams/" + encodeURIComponent(vid), Math.min(5000, left), outer);
            if (j && j.error) throw new Error(String(j.error).slice(0, 60));
            var a = (j.audioStreams || []).filter(function (s) { return s && s.url; });
            if (!a.length) throw new Error("no audio stream");

            var mp4 = a.filter(function (s) {
              return /audio\/mp4/i.test(s.mimeType || "") || /m4a/i.test(s.format || "");
            });
            var rest = a.filter(function (s) { return mp4.indexOf(s) < 0; });
            function byRate(x, y) { return (y.bitrate || 0) - (x.bitrate || 0); }
            mp4.sort(byRate); rest.sort(byRate);

            var pick = mp4.slice(0, 2).concat(rest.slice(0, 1));   /* m4a first (works on every phone), webm as backup */
            for (var k = 0; k < pick.length; k++) {
              left = DEADLINE - (Date.now() - t0);
              if (left <= 500) break;
              var u = viaProxy(pick[k].url, j.proxyUrl);
              if (await probe(u, Math.min(4500, left), outer)) {
                api.storage.set("good", list[i]);
                cache[vid] = { url: u, alt: pick[k].url, t: Date.now() };
                return { url: u, alt: pick[k].url };
              }
              blocked++;
            }
            throw new Error("audio link blocked (no CORS)");
          } catch (e) {
            if (e && e.name === "AbortError" && outer && outer.aborted) throw e;
            lastErr = e;
          }
        }
        var why = lastErr ? lastErr.message : (blocked ? "all links blocked" : "unknown");
        throw new Error("no working Piped server (" + why + "). Try Plugins -> YouTube Music -> Settings and paste another Piped API URL.");
      }
    });
  }
});
