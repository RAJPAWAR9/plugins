/* YouTube Music source plugin (audio only) - v1.2.0
   ON  = songs from YouTube Music appear in Search and can be played.   OFF = they disappear.
   Uses Piped API servers (public YouTube front-end). Servers go up and down, so this plugin:
     - loads a live list of Piped servers,
     - for playback, TESTS each server's audio link (CORS + range request) before giving it to the player,
       because the app's <audio> tag uses crossorigin="anonymous" and silently stays mute if the link has no CORS headers,
     - remembers the server that really worked.
   If NO Piped server works (public ones are mostly dead now), it plays the same song from JioSaavn instead (best match by title,
   artist and length) so the track still plays.
   Own server: Plugins -> YouTube Music -> Settings. */
BOS.register({
  id: "ytmusic", name: "YouTube Music", version: "1.2.0",
  description: "Songs from YouTube Music, played as audio.",

  configure: function (api) {
    var cur = api.storage.get("instance", "");
    var v = prompt("Piped API server URL (example: https://pipedapi.kavin.rocks).\nLeave empty to use the automatic server list.", cur);
    if (v === null) return;
    v = v.trim().replace(/\/+$/, "");
    api.storage.set("instance", v); api.storage.set("good", "");
    api.ui.toast(v ? "Server saved" : "Using the automatic server list");
  },

  init: function (api) {
    var FILTER = "music_songs";
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


    /* ---- fallback: same song from JioSaavn ---- */
    function norm(s) {
      return String(s || "").toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/official|video|lyrical|lyrics|lyric|audio|full song|hd|4k|ft\.?|feat\.?|song|music/g, " ")
        .replace(/[^a-z0-9\u0900-\u097f ]+/g, " ").replace(/\s+/g, " ").trim();
    }
    function toks(s) { return norm(s).split(" ").filter(function (w) { return w.length > 1; }); }
    function overlap(a, b) {
      if (!a.length || !b.length) return 0;
      var hit = a.filter(function (w) { return b.indexOf(w) >= 0; }).length;
      return hit / Math.max(1, Math.min(a.length, b.length));
    }
    function pickUrl(raw) {
      var d = raw && raw.downloadUrl;
      if (Array.isArray(d) && d.length) {
        var best = d[d.length - 1];
        for (var i = 0; i < d.length; i++) if (/160/.test(d[i].quality || "")) best = d[i];
        return best && best.url;
      }
      return null;
    }
    async function jioFallback(track) {
      var Api = api.unsafe && api.unsafe.Api;
      if (!Api || !Api.searchSongs) throw new Error("JioSaavn fallback not available");
      var nameT = toks(track.name), artT = toks(track.artistName);
      var q = (norm(track.name) + " " + norm(track.artistName)).trim().slice(0, 80);
      var r = await Api.searchSongs(q, 0, 10);
      var res = (r && r.data && r.data.results) || [];
      var bestScore = 0, best = null;
      res.forEach(function (x) {
        var s = overlap(nameT, toks(x.name || x.title)) * 0.6;
        var xa = (x.artists && x.artists.primary || []).map(function (p) { return p.name; }).join(" ") + " " + (x.singers || x.primaryArtists || "");
        s += overlap(artT, toks(xa)) * 0.25;
        if (track.duration && x.duration && Math.abs(track.duration - Number(x.duration)) <= 15) s += 0.15;
        if (s > bestScore && pickUrl(x)) { bestScore = s; best = x; }
      });
      if (!best || bestScore < 0.5) throw new Error("no matching song on JioSaavn");
      return pickUrl(best);
    }

    api.sources.register({
      name: "YouTube Music",
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
        var lastErr = null, t0 = Date.now(), tried = 0, noCors = 0;
        var dead = api.storage.get("deadAt", 0);
        var list = (Date.now() - dead < 10 * 60 * 1000) ? [] : await bases(6);   /* all Piped servers failed lately: go straight to fallback */
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
        if (list.length) api.storage.set("deadAt", Date.now());
        try {
          var jurl = await jioFallback(track);
          api.ui.toast("YouTube servers are down - playing the JioSaavn version of this song");
          return { url: jurl };
        } catch (e2) {
          throw new Error("no working Piped server (" + (lastErr && lastErr.message || "skipped") + ") and " + (e2 && e2.message || "fallback failed") + ". Plugins -> YouTube Music -> Settings: paste a working Piped API URL.");
        }
      }
    });
  }
});
