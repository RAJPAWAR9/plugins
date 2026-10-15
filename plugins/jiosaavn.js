/* JioSaavn is the app's built-in music source.
   The switch for it is handled by the app itself: when this plugin is OFF every JioSaavn request is refused,
   so its songs, albums, artists and playlists disappear from Home, Search and playback. Turn it ON and they return. */
BOS.register({
  id: "jiosaavn", name: "JioSaavn", version: "2.0.0",
  description: "Built-in source: songs, albums, artists and playlists.",
  init: function (api) { /* nothing to set up: the app routes JioSaavn through this switch */ }
});
