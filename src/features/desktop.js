// Aviso de música nova (cartão no canto da tela) e atalhos globais

import * as Stats from "../stats.js";
import { esc, cleanTitle, cleanArtist } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initDesktop(app) {
  const { $, $$, api, IS_WALLPAPER, settings, saveSettings, serviceName, keyOf, toast, player, vol, isLocalVol, setVolumeLevel, playingService } = app;
  let notifyTimer = 0;
  const appFocused = () => !document.hidden && document.hasFocus();
  function scheduleNotify(key) {
    if (!settings.notify || IS_WALLPAPER) return;
    clearTimeout(notifyTimer);
    // espera a capa e a cor chegarem; só avisa se o app não está na frente
    notifyTimer = setTimeout(() => {
      if (keyOf(app.media) === key && !appFocused()) notifyNow();
    }, 900);
  }
  function notifyNow(label) {
    if (!settings.notify || IS_WALLPAPER || !keyOf(app.media)) return;
    const h = app.history.find((x) => x.key === keyOf(app.media));
    api.invoke("notify_show", {
      payload: {
        label: label || "Tocando agora",
        title: app.media.title,
        artist: [app.media.artist, serviceName(playingService())].filter(Boolean).join(" · "),
        cover: app.media.coverUrl || app.media.thumb || h?.thumb || null,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
      },
    }).catch(() => {});
  }
  /** Ctrl+Alt+↑/↓: muda o volume de quem está tocando e mostra no canto. */
  async function stepVolume(delta) {
    let level, target;
    if (isLocalVol()) {
      vol.source = null;
      level = settings.volume;
      target = "Harle Player";
    } else {
      vol.source = app.media.available ? app.media.source || "" : "";
      try {
        const v = await api.invoke("get_volume", { source: vol.source });
        level = v?.level ?? vol.level;
        target = v?.target === "Sistema" ? "PC" : v?.target || "PC";
      } catch {
        level = vol.level;
        target = "PC";
      }
    }
    setVolumeLevel(Math.round((level + delta) * 20) / 20);
    app.remoteUi.remoteVol = { level: vol.level, target };
    if (!appFocused() && settings.notify) {
      api.invoke("notify_show", {
        payload: {
          kind: "volume",
          level: vol.level,
          target,
          title: keyOf(app.media) ? app.media.title : "Volume",
          cover: app.media.coverUrl || app.media.thumb || null,
          accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
        },
      }).catch(() => {});
    } else {
      toast(`Volume ${Math.round(vol.level * 100)}% · ${target}`);
    }
  }
  async function setHotkeys(on, quiet = false) {
    settings.hotkeys = on;
    saveSettings();
    try {
      const failed = await api.invoke("set_hotkeys", { on });
      $("#hotkeysNote").textContent = on && failed?.length ? `Outro programa já usa: ${failed.join(", ")}` : "";
    } catch (e) {
      if (!quiet) toast(String(e));
    }
    $("#swHotkeys").classList.toggle("on", settings.hotkeys);
  }
  $("#swHotkeys").addEventListener("click", () => setHotkeys(!settings.hotkeys));
  $("#swNotify").addEventListener("click", () => {
    settings.notify = !settings.notify;
    saveSettings();
    $("#swNotify").classList.toggle("on", settings.notify);
    if (settings.notify) notifyNow("Assim fica o aviso");
  });

  // ===================================================================
  // Abaixar a música (alguém falando no Discord, DJ falando)
  // ===================================================================
  const duckReasons = new Map(); // motivo → fração (0–1)
  let duckSaved = null; // { source, level } do app de fora antes de abaixar
  let duckTimer = 0;
  async function setDuckReason(reason, factor) {
    if (factor == null || factor >= 1) duckReasons.delete(reason);
    else duckReasons.set(reason, factor);
    const f = Math.min(1, ...duckReasons.values());
    // player interno: abaixa direto no som dele (suave, sem estalo)
    player?.setDuck(isLocalVol() ? f : 1);
    if (isLocalVol()) return;
    // app de fora (Spotify…): mexe no volume dele no mixer e devolve depois
    const source = app.media.available ? app.media.source || "" : "";
    clearTimeout(duckTimer);
    if (f < 1) {
      if (!duckSaved || duckSaved.source !== source) {
        try {
          const v = await api.invoke("get_volume", { source });
          if (!v || v.target === "Sistema") return; // não mexe no volume do PC inteiro
          duckSaved = { source, level: v.level };
        } catch {
          return;
        }
      }
      fadeAppVolume(source, duckSaved.level * f);
    } else if (duckSaved) {
      const back = duckSaved;
      duckSaved = null;
      duckTimer = setTimeout(() => fadeAppVolume(back.source, back.level), 150);
    }
  }
  async function fadeAppVolume(source, target, steps = 5) {
    let from = target;
    try { from = (await api.invoke("get_volume", { source }))?.level ?? target; } catch {}
    for (let i = 1; i <= steps; i++) {
      const lv = from + ((target - from) * i) / steps;
      try { await api.invoke("set_volume", { source, level: lv }); } catch { return; }
      await new Promise((r) => setTimeout(r, 45));
    }
  }
  api.listen("voice-activity", (talking) => {
    if (!settings.ducking) return;
    setDuckReason("discord", talking ? settings.duckLevel : 1);
    document.body.classList.toggle("voice-ducked", !!talking);
  });
  function setDucking(on) {
    settings.ducking = on;
    saveSettings();
    api.invoke("set_ducking", { on }).catch(() => {});
    if (!on) setDuckReason("discord", 1);
    renderExtras();
  }

  // ===================================================================
  // Letra flutuante (faixa na parte de baixo da tela, por cima de tudo)
  // ===================================================================
  let barSig = "";
  let barPlaying = null;
  function feedLyricsBar(pos) {
    if (!settings.lyricsbar || IS_WALLPAPER || !api.emit) return;
    const line = app.lyrics && app.lyrics.key === keyOf(app.media) ? (() => {
      const L = app.lyrics.lines;
      let idx = -1;
      for (let i = 0; i < L.length; i++) if (L[i].t <= pos) idx = i; else break;
      return idx >= 0 ? { ...L[idx], idx, next: L[idx + 1]?.text || "" } : null;
    })() : null;
    const text = line && pos <= line.end + 400 ? line.text : "";
    const sig = `${keyOf(app.media)}|${line?.idx}|${text}`;
    const playing = !!app.media.playing;
    if (sig === barSig && playing === barPlaying) return;
    const restart = sig === barSig; // só mudou play/pause: recalcula a varrida
    barSig = sig;
    barPlaying = playing;
    api.emit("hp-lyric", {
      text, next: text ? line.next : "", start: line?.t || 0, end: line?.end || 0, pos, playing, restart,
      font: settings.lyricFont,
    }).catch?.(() => {});
  }
  async function setLyricsBar(on) {
    settings.lyricsbar = on;
    saveSettings();
    try {
      await api.invoke("set_lyricsbar", { on });
      barSig = "";
    } catch (e) {
      toast(String(e));
    }
    renderExtras();
    if (on && !settings.lyrics) toast("Ligue as letras sincronizadas pra ela aparecer");
  }

  // ===================================================================
  // DJ com voz: anuncia a música entre uma e outra, tipo rádio
  // ===================================================================
  let djCount = 0;
  let djLastArtist = "";
  let djArtistRun = 0;
  let djTimer = 0;
  function djVoices() {
    const all = window.speechSynthesis?.getVoices?.() || [];
    const pt = all.filter((v) => /^pt(-|_)?BR/i.test(v.lang) || /portugu/i.test(v.name));
    // prefere vozes "Natural"/"Online" (bem mais humanas), depois qualquer pt-BR
    return pt.sort((a, b) => /natural|online/i.test(b.name) - /natural|online/i.test(a.name));
  }
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function djLine() {
    const title = cleanTitle(app.media.title || "");
    const artist = cleanArtist(app.media.artist || "") || "artista desconhecido";
    const key = keyOf(app.media);
    const week = Stats.summarize(app.stats, Stats.periodRange("7d").from);
    const t = week.tracks.find((x) => x.key === key);
    const a = week.artists.find((x) => x.name.toLowerCase() === Stats.mainArtist(app.media.artist || "").toLowerCase());
    const h = new Date().getHours();
    const greet = h < 5 ? "Madrugada adentro" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
    const lines = [];
    if (djCount === 0) lines.push(`${greet}! Começando com ${title}, de ${artist}.`);
    if (djArtistRun >= 2) lines.push(`${artist} de novo! Já é a ${djArtistRun + 1}ª seguida, hein.`);
    if (t && t.plays >= 3) lines.push(`${title}, de ${artist}. Essa é a ${t.plays + 1}ª vez que você ouve essa só essa semana.`);
    if (!t) lines.push(pick([`Agora uma que ainda não tinha tocado essa semana: ${title}, de ${artist}.`, `Novidade na área: ${title}, de ${artist}.`]));
    if (a && a.sec > 1800) lines.push(`${artist}, que já te fez companhia por ${Math.round(a.sec / 60)} minutos essa semana. Toca aí: ${title}.`);
    lines.push(pick([`Agora: ${title}, de ${artist}.`, `Na sequência, ${artist}, com ${title}.`, `Tocando agora no Harle Player: ${title}, de ${artist}.`, `Aumenta aí, que é ${title}, de ${artist}.`]));
    return lines[0];
  }
  function djSpeak(text) {
    const synth = window.speechSynthesis;
    if (!synth || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = djVoices().find((x) => x.name === settings.djVoice) || djVoices()[0];
    if (v) u.voice = v;
    u.lang = v?.lang || "pt-BR";
    u.rate = 1.04;
    u.onstart = () => setDuckReason("dj", 0.28);
    const done = () => setDuckReason("dj", 1);
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }
  function djOnTrack(key) {
    if (!settings.dj || IS_WALLPAPER) return;
    clearTimeout(djTimer);
    window.speechSynthesis?.cancel();
    const artist = Stats.mainArtist(app.media.artist || "").toLowerCase();
    djArtistRun = artist && artist === djLastArtist ? djArtistRun + 1 : 0;
    djLastArtist = artist;
    const speak = settings.djEvery === "all" || djCount === 0 || djArtistRun >= 2 || Math.random() < 0.4;
    djTimer = setTimeout(() => {
      if (keyOf(app.media) !== key || !app.media.playing) return;
      if (speak) djSpeak(djLine());
      djCount++;
    }, 1500);
  }

  // ---------- configurações da aba Extras (Discord, letra flutuante, DJ) ----------
  function renderExtras() {
    $("#swDucking").classList.toggle("on", settings.ducking);
    $$("#segDuck button").forEach((b) => b.classList.toggle("sel", +b.dataset.v === settings.duckLevel));
    $("#segDuck").classList.toggle("off", !settings.ducking);
    $("#segDuck").previousElementSibling?.classList.toggle("off", !settings.ducking);
    $("#swLyricsBar").classList.toggle("on", settings.lyricsbar);
    $("#swDj").classList.toggle("on", settings.dj);
    $$("#segDjEvery button").forEach((b) => b.classList.toggle("sel", b.dataset.v === settings.djEvery));
    const voices = djVoices();
    $("#djVoice").innerHTML = voices.length
      ? voices.map((v) => `<option value="${esc(v.name)}" ${v.name === settings.djVoice ? "selected" : ""}>${esc(v.name.replace(/^Microsoft\s+/, "").replace(/\s*-\s*Portuguese.*$/i, ""))}</option>`).join("")
      : `<option>Nenhuma voz em português instalada</option>`;
  }
  window.speechSynthesis?.addEventListener?.("voiceschanged", () => !IS_WALLPAPER && renderExtras());
  $("#swDucking").addEventListener("click", () => setDucking(!settings.ducking));
  $("#segDuck").addEventListener("click", (e) => {
    if (!e.target.dataset.v) return;
    settings.duckLevel = +e.target.dataset.v;
    saveSettings();
    renderExtras();
  });
  $("#swLyricsBar").addEventListener("click", () => setLyricsBar(!settings.lyricsbar));
  $("#swDj").addEventListener("click", () => {
    settings.dj = !settings.dj;
    saveSettings();
    renderExtras();
    if (settings.dj) djSpeak("Fala! Eu sou o DJ do Harle Player. Vou aparecendo entre as músicas.");
    else window.speechSynthesis?.cancel();
  });
  $("#segDjEvery").addEventListener("click", (e) => {
    if (!e.target.dataset.v) return;
    settings.djEvery = e.target.dataset.v;
    saveSettings();
    renderExtras();
  });
  $("#djVoice").addEventListener("change", (e) => {
    settings.djVoice = e.target.value;
    saveSettings();
  });
  $("#djTest").addEventListener("click", (e) => {
    e.preventDefault();
    djSpeak(keyOf(app.media) ? djLine() : "Testando, testando. Som na caixa!");
  });

  return {
    get notifyNow() { return notifyNow; },
    get stepVolume() { return stepVolume; },
    get scheduleNotify() { return scheduleNotify; },
    get setHotkeys() { return setHotkeys; },
    get feedLyricsBar() { return feedLyricsBar; },
    get setLyricsBar() { return setLyricsBar; },
    get djOnTrack() { return djOnTrack; },
    get renderExtras() { return renderExtras; },
  };
}
