// Controle pelo celular: o PC vira um servidorzinho na rede Wi-Fi

import { drawQr } from "../qr.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initRemote(app) {
  const { $, api, IS_WALLPAPER, settings, saveSettings, serviceName, keyOf, positionNow, toast, control, player, toTrack, renderQueue, playModes, setShuffleMode, setRepeatMode, vol, isLocalVol, setVolumeLevel, playingService, notifyNow, stepVolume, setLyricsBar } = app;
  let remoteInfo = null;
  let remoteCoverSent = null;
  let remoteVol = { level: settings.volume, target: "Volume" };

  /** Comandos que chegam do mini player e do celular. */
  function remoteCommand(m) {
    const t = m.track;
    switch (m.action) {
      case "toggle": case "next": case "prev":
        if (m.from === "hotkey" && m.action === "toggle") setTimeout(() => notifyNow(app.media.playing ? "Tocando" : "Pausado"), 350);
        return control(m.action);
      case "volup": case "voldown":
        return stepVolume(m.action === "volup" ? 0.05 : -0.05);
      case "mini":
        return $("#btnMini").click();
      case "lyricsbar":
        return setLyricsBar(!settings.lyricsbar);
      case "seek":
        return Number.isFinite(m.value) && control("seek", Math.round(m.value));
      case "volume":
        if (!Number.isFinite(m.value)) return;
        vol.source = isLocalVol() ? null : app.media.available ? app.media.source || "" : "";
        setVolumeLevel(m.value);
        remoteVol = { level: vol.level, target: remoteVol.target };
        return pushRemote(true);
      case "jump":
        return player?.queue.jump(+m.value);
      case "shuffle":
        return setShuffleMode(!!m.value);
      case "repeat":
        return ["off", "all", "one"].includes(m.value) && setRepeatMode(m.value);
      case "play": case "playnext": case "queue": {
        if (!player || !t?.url) return;
        const tr = toTrack(t, t.service === "soundcloud" ? "soundcloud" : "ytmusic");
        if (m.action === "play") player.playQueue([tr], 0);
        else if (m.action === "playnext") player.queue.playNext(tr);
        else player.queue.add(tr);
        return renderQueue(true);
      }
    }
  }

  function pushRemote(force = false) {
    if (!settings.remote || !remoteInfo || IS_WALLPAPER) return;
    const curKey = keyOf(app.media);
    const h = curKey ? app.history.find((x) => x.key === curKey) : null;
    const info = player?.active && app.local ? player.queue.info() : null;
    const cover = curKey ? app.media.coverUrl || app.media.thumb || h?.thumb || "" : "";
    const now = {
      key: curKey,
      title: curKey ? app.media.title : "",
      artist: curKey ? app.media.artist || app.media.album || "" : "",
      playing: !!(app.media.available && app.media.playing),
      positionMs: Math.round(positionNow()),
      durationMs: app.media.durationMs || 0,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
      serviceName: curKey ? serviceName(playingService()) : "",
      lyricsOffset: settings.lyricsOffset || 0,
      local: !!info,
      modes: playModes(),
      volume: isLocalVol() ? { level: settings.volume, target: "Harle Player" } : remoteVol,
      queue: info
        ? info.tracks.map((t, i) => ({ i, title: t.title, artist: t.artist, cover: /^https:/.test(t.cover || "") ? t.cover : null })).slice(info.index + 1, info.index + 41)
        : [],
    };
    if (force || cover !== remoteCoverSent) {
      now.cover = cover;
      remoteCoverSent = cover;
    }
    api.invoke("remote_update", { now }).catch(() => {});
  }
  function pushRemoteLyrics() {
    if (!settings.remote || !remoteInfo || IS_WALLPAPER) return;
    const l = app.lyrics ? { key: app.lyrics.key, lines: app.lyrics.lines.map((x) => ({ t: x.t, text: x.text })) } : { key: keyOf(app.media), lines: [] };
    api.invoke("remote_lyrics", { lyrics: l }).catch(() => {});
  }
  // posição fresquinha a cada 1 s, e o volume do app de fora a cada 5 s
  setInterval(() => pushRemote(), 1000);
  setInterval(async () => {
    if (!settings.remote || !remoteInfo || isLocalVol()) return;
    try {
      const v = await api.invoke("get_volume", { source: app.media.available ? app.media.source || "" : "" });
      if (v) remoteVol = { level: v.level, target: v.target === "Sistema" ? "PC" : v.target };
    } catch {}
  }, 5000);

  async function setRemote(on, quiet = false) {
    settings.remote = on;
    saveSettings();
    if (on) {
      try {
        remoteInfo = await api.invoke("remote_start");
        if (!remoteInfo) remoteInfo = { url: `${location.origin}/remote.html?k=demo`, demo: true };
        remoteCoverSent = null;
        pushRemote(true);
        pushRemoteLyrics();
      } catch (e) {
        remoteInfo = null;
        settings.remote = false;
        saveSettings();
        if (!quiet) toast(`Não deu pra ligar o controle: ${e}`, 4000);
      }
    } else {
      remoteInfo = null;
      api.invoke("remote_stop").catch(() => {});
    }
    renderRemote();
  }
  function renderRemote() {
    $("#swRemote").classList.toggle("on", !!settings.remote);
    const box = $("#remoteBox");
    box.hidden = !(settings.remote && remoteInfo);
    if (box.hidden) return;
    drawQr($("#remoteQr"), remoteInfo.url, 5);
    $("#remoteUrl").textContent = remoteInfo.url.replace(/\?k=.*/, "");
  }
  $("#swRemote").addEventListener("click", () => setRemote(!settings.remote));
  $("#remoteNew").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      remoteInfo = (await api.invoke("remote_new_code")) || remoteInfo;
      renderRemote();
      toast("Código novo: escaneie o QR de novo no celular");
    } catch (err) {
      toast(String(err));
    }
  });

  return {
    get remoteVol() { return remoteVol; },
    set remoteVol(v) { remoteVol = v; },
    get remoteCommand() { return remoteCommand; },
    get pushRemote() { return pushRemote; },
    get pushRemoteLyrics() { return pushRemoteLyrics; },
    get setRemote() { return setRemote; },
  };
}
