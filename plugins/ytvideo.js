/* YouTube Video source plugin (audio only) - v1.1.0
   ON  = songs from YouTube Video appear in Search and can be played.   OFF = they disappear.
   Uses Piped API servers (public YouTube front-end). Servers go up and down, so this plugin:
     - loads a live list of Piped servers,
     - for playback, TESTS each server's audio link (CORS + range request) before giving it to the player,
       because the app's <audio> tag uses crossorigin="anonymous" and silently stays mute if the link has no CORS headers,
     - remembers the server that really worked.
   Own server: Plugins -> YouTube Video -> Settings. */
BOS.register({
  id: "ytvideo", name: "YouTube Video", version: "1.1.0",
  description: "YouTube videos (live, remix, cover), played as audio.",

  configure: function (api) {
    var cur = api.storage.get("instance", "");
    var v = prompt("Piped API server URL (example: https://pipedapi.kavin.rocks).\nLeave empty to use the automatic server list.", cur);
    if (v === null) return;
    v = v.trim().replace(/\/+$/, "");
    api.storage.set("instance", v); api.storage.set("good", "");
    api.ui.toast(v ? "Server saved" : "Using the automatic server list");
  },

  init: function (api) {
    var FILTER = "videos";
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
    var dyn = api.storage.get("dyn", null);      /* { t: time, list: [urls] } */

    function timed(ms, outer) {
      var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms);
      if (outer) {
        if (outer.aborted) ctl.abort();
        else outer.addEventListener("abort", function () { ctl.abort(); }, { once: true });
      }
      return { signal: ctl.signal, done: function () { clearTimeout(t); } };
    }

    function fetchJson(url, ms, outer) {
      var c = timed(ms, outer);
      return fetch(url, { signal: c.signal }).then(function (r) {
        c.done();
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }, function (e) { c.done(); throw e; });
    }

    /* live list of Piped servers (cached 6 h); failure is fine, we still have DEFAULTS */
    async function loadDyn() {
      if (dyn && dyn.list && dyn.list.length && Date.now() - dyn.t < 6 * 3600 * 1000) return dyn.list;
      try {
        var arr = await fetchJson(LIST_URL, 4000);
        var l = (arr || []).filter(function (x) { return x && x.api_url && (x.uptime_30d == null || x.uptime_30d >= 60); })
          .sort(function (a, b) { return (b.uptime_30d || 0) - (a.uptime_30d || 0); })
          .map(function (x) { return String(x.api_url).replace(/\/+$/, ""); });
        if (l.length) { dyn = { t: Date.now(), list: l.slice(0, 12) }; api.storage.set("dyn", dyn); return dyn.list; }
      } catch (e) {}
      return (dyn && dyn.list) || [];
    }

    async function bases(max) {
      var extra = await loadDyn();
      var out = [], seen = {};
      [api.storage.get("instance", ""), api.storage.get("good", "")].concat(DEFAULTS, extra).forEach(function (b) {
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
        if (!/googlevideo\.com$/.test(u.hostname)) return url;
        var pr = new URL(proxyUrl);
        u.searchParams.set("host", u.host);
        u.protocol = pr.protocol; u.host = pr.host;
        return u.toString();
      } catch (e) { return url; }
    }

    /* can the <audio crossorigin="anonymous"> tag really load this link? (CORS + range request) */
    async function probe(url, outer) {
      var c = timed(4500, outer);
      try {
        var r = await fetch(url, { headers: { Range: "bytes=0-1" }, signal: c.signal });
        var ok = r.status === 200 || r.status === 206;
        try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {}
        return ok;
      } catch (e) { return false; }
      finally { c.done(); }
    }

    api.sources.register({
      name: "YouTube Video",
      ttl: 60 * 60 * 1000,   /* YouTube links expire: re-fetch after 60 min */

      search: async function (q, opts) {
        var outer = opts && opts.signal, list = await bases(4), lastErr = null, j = null;
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
        var out = [];
        (j.items || []).forEach(function (it) {
          if (it.type && it.type !== "stream") return;
          var vid = videoId(it); if (!vid) return;
          out.push({
            id: vid, _vid: vid,
            name: it.title || "Untitled",
            artistName: String(it.uploaderName || "YouTube").replace(/\s*-\s*Topic$/i, ""),
            image: "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg",
            duration: it.duration > 0 ? it.duration : 0
          });
        });
        return out.slice(0, (opts && opts.limit) || 20);
      },

      resolve: async function (track) {
        var vid = track._vid || String(track.id).split(":").pop();
        var list = await bases(7), lastErr = null, t0 = Date.now(), tried = 0, noCors = 0;
        for (var i = 0; i < list.length; i++) {
          if (Date.now() - t0 > 20000) break;          /* never make the user wait forever */
          try {
            var j = await fetchJson(list[i] + "/streams/" + encodeURIComponent(vid), 5000);
            if (j && j.error) throw new Error(String(j.error).slice(0, 60));
            var a = (j.audioStreams || []).filter(function (s) { return s && s.url; });
            if (!a.length) throw new Error("no audio stream");
            var mp4 = a.filter(function (s) { return /audio\/mp4/i.test(s.mimeType || "") || /m4a/i.test(s.format || ""); });
            var rest = a.filter(function (s) { return mp4.indexOf(s) < 0; });
            function byRate(x, y) { return (y.bitrate || 0) - (x.bitrate || 0); }
            mp4.sort(byRate); rest.sort(byRate);
            var pick = mp4.slice(0, 2).concat(rest.slice(0, 1));   /* m4a first (works on every phone), webm as backup */
            for (var k = 0; k < pick.length; k++) {
              var u = viaProxy(pick[k].url, j.proxyUrl);
              tried++;
              if (await probe(u)) {
                api.storage.set("good", list[i]);
                return { url: u, alt: pick[k].url };
              }
              noCors++;
            }
            throw new Error("audio link blocked (no CORS)");
          } catch (e) { lastErr = e; }
        }
        throw new Error("no working Piped server (" + (lastErr && lastErr.message || "unknown") + "). Try Plugins -> YouTube Video -> Settings and paste another Piped API URL.");
      }
    });
  }
});
