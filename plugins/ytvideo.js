/* YouTube Video source plugin (audio only).
   ON  = songs from YouTube Video appear in Search and can be played.   OFF = they disappear.
   Uses a Piped API server (public YouTube front-end). Servers go up and down, so the plugin tries a few and
   remembers the one that worked. You can also set your own server: Plugins -> YouTube Video -> Settings. */
BOS.register({
  id: "ytvideo", name: "YouTube Video", version: "1.0.0",
  description: "YouTube videos (live, remix, cover), played as audio.",

  configure: function (api) {
    var cur = api.storage.get("instance", "");
    var v = prompt("Piped API server URL (example: https://pipedapi.kavin.rocks).\nLeave empty to use the built-in list.", cur);
    if (v === null) return;
    v = v.trim().replace(/\/+$/, "");
    api.storage.set("instance", v); api.storage.set("good", "");
    api.ui.toast(v ? "Server saved" : "Using the built-in server list");
  },

  init: function (api) {
    var FILTER = "videos";
    var DEFAULTS = [
      "https://pipedapi.kavin.rocks",
      "https://pipedapi.adminforge.de",
      "https://api.piped.private.coffee",
      "https://pipedapi.r4fo.com"
    ];

    function bases() {
      var out = [], seen = {};
      [api.storage.get("instance", ""), api.storage.get("good", "")].concat(DEFAULTS).forEach(function (b) {
        if (b && !seen[b]) { seen[b] = 1; out.push(b); }
      });
      return out.slice(0, 3);   /* at most 3 tries so a dead server never hangs the search */
    }

    function fetchJson(url, ms, outer) {
      return new Promise(function (resolve, reject) {
        var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms);
        if (outer) { if (outer.aborted) { clearTimeout(t); return reject({ name: "AbortError" }); } outer.addEventListener("abort", function () { ctl.abort(); }, { once: true }); }
        fetch(url, { signal: ctl.signal }).then(function (r) {
          clearTimeout(t);
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then(resolve, function (e) { clearTimeout(t); reject(e); });
      });
    }

    async function piped(path, ms, outer) {
      var list = bases(), lastErr = null;
      for (var i = 0; i < list.length; i++) {
        try {
          var j = await fetchJson(list[i] + path, ms, outer);
          if (j && j.error) throw new Error(j.error);
          api.storage.set("good", list[i]);
          return j;
        } catch (e) {
          if (e && e.name === "AbortError" && outer && outer.aborted) throw e;
          lastErr = e;
        }
      }
      throw lastErr || new Error("no Piped server reachable");
    }

    function videoId(item) {
      var m = String(item.url || "").match(/[?&]v=([\w-]{6,})/);
      return m ? m[1] : null;
    }

    /* Piped hands out direct YouTube links that only work from its own server, so route them through its proxy */
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

    api.sources.register({
      name: "YouTube Video",
      ttl: 90 * 60 * 1000,   /* YouTube links expire: re-fetch after 90 min */

      search: async function (q, opts) {
        var j = await piped("/search?q=" + encodeURIComponent(q) + "&filter=" + FILTER, 3000, opts && opts.signal);
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
        var j = await piped("/streams/" + encodeURIComponent(vid), 6000);
        var a = (j.audioStreams || []).filter(function (s) { return s && s.url; });
        if (!a.length) throw new Error("no audio stream");
        var mp4 = a.filter(function (s) { return /audio\/mp4/i.test(s.mimeType || "") || /m4a/i.test(s.format || ""); });
        var pool = mp4.length ? mp4 : a;
        pool.sort(function (x, y) { return (y.bitrate || 0) - (x.bitrate || 0); });
        var best = pool[0];
        return { url: viaProxy(best.url, j.proxyUrl), alt: best.url };
      }
    });
  }
});
