BOS.register({
  id: "tab-title", name: "Now Playing in Tab Title", version: "1.0.0",
  init(api) {
    const original = document.title;
    const set = t => { document.title = t ? t.name + " • " + t.artistName : original; };
    set(api.player.track);                       // already playing when enabled
    api.on("trackchange", set);
    api.on("pause", () => { document.title = original; });
    api.on("play",  () => set(api.player.track));
    this._restore = () => { document.title = original; };
  },
  destroy() { this._restore && this._restore(); }
});
