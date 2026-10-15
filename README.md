# Booster OS — Plugin System

## Files
```
index.html          your app (+ small plugin bridge near the end of the main <script>, + 2 script tags before </body>)
lyrics.js           unchanged
plugins.js          the plugin runtime (loader, API, Plugins page)
plugins/
  registry.js       list of built-in plugins (add a line to ship a new one)
  sleep-timer.js    example extension (top-bar button + timer)
  tab-title.js      example extension (events)
  play-stats.js     example extension (custom sidebar page)
  neon-theme.css    example theme (just CSS variables)
  jiosaavn.js       source plugin: JioSaavn (built in)
  ytmusic.js        source plugin: YouTube Music (audio)
  ytvideo.js        source plugin: YouTube Video (audio)
```
Deploy: push this folder to GitHub, Settings → Pages → branch `main`. Nothing else needed.

## Using plugins (inside the app)
Open the **puzzle icon** in the top-right (works on phone and desktop; desktop also has *Plugins* in the sidebar).
Sidebar → **Plugins**
- **On/off:** use the switch next to each plugin (remembered in this browser).
- **Add a plugin:** paste a link to a `.js` (extension) or `.css` (theme) file and tap *Add link*, or tap *Choose file* and pick one from your phone/computer. The app reads the plugin's id/name by itself.
- **Remove:** *Remove* button on plugins you added.
- Plugins have full access to the app — only add ones you trust.

Built-in plugins are listed in `plugins/registry.js` (`enabled: true/false` is just the first-load default).

## Writing an extension
```js
BOS.register({
  id: "hello", name: "Hello", version: "1.0.0",
  init(api) {
    api.on("trackchange", t => api.ui.toast("Now playing: " + t.name));
  }
});
```
Add `{ id:"hello", name:"Hello", type:"extension", entry:"plugins/hello.js", description:"...", enabled:true }` to `plugins/registry.js`.
Everything created through `api` (buttons, pages, CSS, timers, listeners) is removed automatically when the plugin is turned off.

## API (`api` passed to init)
| | |
|---|---|
| `api.on(evt, fn)` | events: `trackchange`, `play`, `pause`, `ended`, `progress` ({position,duration}) |
| `api.player` | `play(track,list,index)`, `pause()`, `resume()`, `toggle()`, `next()`, `prev()`, `seek(s)`, `setVolume(0-1)`; read: `track`, `isPlaying`, `queue`, `volume`, `position`, `duration`, `audio` |
| `api.ui.toast(msg, type)` | toast (`type` = "error" optional) |
| `api.ui.css(text)` | inject CSS |
| `api.ui.addTopbarButton({label,icon,title,onClick})` | returns the button; `btn.setLabel(text)` |
| `api.ui.addPage({id,title,icon,render(container,api)})` | sidebar item + full page |
| `api.theme.setVars({"--accent-r":255})` | override CSS variables (reverted on disable) |
| `api.storage.get(k,def)` / `.set(k,v)` | per-plugin persistent storage |
| `api.setInterval` / `api.setTimeout` | auto-cleared timers |
| `api.navigate(view)` | e.g. "home", "search", "library", "settings" |
| `api.unsafe` | raw internals: `State, Queue, Store, History, Api, Player…` (not a stable API) |

## Themes
A theme is a `.css` file registered with `type:"theme"`. Useful variables: `--accent-r/g/b`, `--bg-0/1/2`, `--text-1/2/3`, `--r-sm…--r-xl`.

## Source plugins (songs / audio)
A **source** plugin brings songs into the app. Switch it **ON** and its songs show up; switch it **OFF** and they disappear.
- **Plugins page**: puzzle icon (top right) -> switch next to *JioSaavn*, *YouTube Music*, *YouTube Video*.
- **Search page**: a *Sources* card shows the sources that are ON. Tap a chip to include/exclude that source in the results.
- **JioSaavn OFF**: Home, Search, albums, artists, playlists and playback of JioSaavn songs all stop (the app refuses every JioSaavn request).
- **YouTube OFF**: its songs vanish from Search and its songs will not play. A playing song of a plugin you switch off is paused.
- YouTube plugins use a public **Piped** server. Servers come and go, so if YouTube search returns nothing, open *Plugins -> YouTube Music -> Settings* and paste a working Piped API URL.

Write your own source:
```js
BOS.register({
  id: "mysource", name: "My Source", version: "1.0.0",
  init(api) {
    api.sources.register({
      name: "My Source",
      async search(q, { signal, limit }) { return [{ id:"123", name:"Song", artistName:"Artist", image:"https://...", duration:200 }]; },
      async resolve(track) { return "https://.../audio.m4a"; }   // or { url, alt }
    });
  }
});
```
Add `{ id:"mysource", name:"My Source", type:"source", entry:"plugins/mysource.js", description:"...", enabled:true }` to `plugins/registry.js`.

## Not included yet (next steps)
- Albums / artists / playlists from non-JioSaavn sources (only songs for now).
- Lyrics-provider plugins.
