BOS.register({
  id: "sleep-timer", name: "Sleep Timer", version: "1.0.0",
  init(api) {
    const steps = [0, 15, 30, 60];           // minutes; 0 = off
    let step = 0, endsAt = 0, btn;

    const moon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

    function paint() {
      if (!endsAt) return btn.setLabel("");
      const left = Math.max(0, endsAt - Date.now());
      btn.setLabel(Math.ceil(left / 60000) + "m");
    }

    btn = api.ui.addTopbarButton({
      title: "Sleep timer", icon: moon,
      onClick() {
        step = (step + 1) % steps.length;
        if (steps[step] === 0) { endsAt = 0; api.ui.toast("Sleep timer off"); }
        else { endsAt = Date.now() + steps[step] * 60000; api.ui.toast("Music will pause in " + steps[step] + " min"); }
        paint();
      }
    });

    api.setInterval(() => {
      if (!endsAt) return;
      if (Date.now() >= endsAt) { endsAt = 0; step = 0; api.player.pause(); api.ui.toast("Sleep timer: paused"); }
      paint();
    }, 1000);
  }
});
