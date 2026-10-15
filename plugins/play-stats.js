BOS.register({
  id: "play-stats", name: "Play Stats", version: "1.0.0",
  init(api) {
    const played = [];                            // this session only
    api.on("trackchange", t => played.push({ name: t.name, artist: t.artistName, at: Date.now() }));

    const page = api.ui.addPage({
      id: "stats", title: "Play Stats",
      render(el) {
        const byArtist = {};
        played.forEach(p => { byArtist[p.artist] = (byArtist[p.artist] || 0) + 1; });
        const top = Object.entries(byArtist).sort((a, b) => b[1] - a[1]).slice(0, 5);
        el.innerHTML =
          '<div style="max-width:700px;margin:0 auto;padding:6px 0 40px">'
          + '<h2 style="font-size:30px;font-weight:800;letter-spacing:-.03em">Play Stats</h2>'
          + '<p style="color:var(--text-2);margin:6px 0 18px">' + played.length + ' song(s) played this session</p>'
          + (top.length
              ? top.map(([a, n]) => '<div class="glass-2" style="padding:12px 16px;border-radius:var(--r-lg);margin-bottom:8px;display:flex;justify-content:space-between"><b>'
                  + api.unsafe.esc(a) + '</b><span style="color:var(--text-2)">' + n + '×</span></div>').join("")
              : '<div style="color:var(--text-2)">Play something, then come back.</div>')
          + '</div>';
      }
    });
  }
});
