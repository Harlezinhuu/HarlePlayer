// Karaokê: tira a voz, sua voz nos fones (com efeitos) e gravação

import * as Stats from "../stats.js";
import { createKaraoke } from "../karaoke.js";
import { fmt, cleanTitle, cleanArtist } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initKaraoke(app) {
  const { $, api, settings, serviceName, keyOf, toast, control, player, playQuery, toggleLyrics, playingService } = app;
  const karaoke = player ? createKaraoke(() => player.audioGraph()) : null;
  let kOn = false;
  let recTimer = 0, recStart = 0;
  const K_DEFAULTS = { voice: 0 };
  async function setKaraokeMode(on) {
    kOn = on;
    document.body.classList.toggle("karaoke-on", on);
    $("#btnKaraoke").classList.toggle("on", on);
    $("#karaokeBar").hidden = !on;
    if (on) {
      if (!settings.lyrics) toggleLyrics();
      await player?.setKaraoke(true, K_DEFAULTS.voice);
    } else {
      if (karaoke?.recording) await stopRecording();
      karaoke?.micStop();
      await player?.setKaraoke(false);
    }
    renderKaraoke();
  }
  function renderKaraoke() {
    if (!karaoke) return;
    const localNow = !!(player?.active && app.local);
    $("#kNotLocal").hidden = localNow || !kOn;
    $("#kControls").hidden = !localNow;
    if (!localNow && keyOf(app.media)) $("#kNotLocalText").textContent = `"${app.media.title}" está tocando no ${serviceName(playingService()) || "outro app"}. O karaokê só tira a voz do que toca aqui dentro.`;
    $("#kMic").classList.toggle("on", karaoke.micOn);
    $("#kMic").querySelector("span").textContent = karaoke.micOn ? "Microfone ligado" : "Ligar microfone";
    for (const k of ["mic", "echo", "reverb"]) {
      const el = $(`#k_${k}`);
      el.value = Math.round(karaoke.levels[k] * 100);
      el.style.setProperty("--p", `${el.value}%`);
    }
    const v = $("#k_voice");
    v.value = Math.round(K_DEFAULTS.voice * 100);
    v.style.setProperty("--p", `${v.value}%`);
    $("#kRec").classList.toggle("on", karaoke.recording);
  }
  $("#btnKaraoke").addEventListener("click", () => setKaraokeMode(!kOn));
  $("#kExit").addEventListener("click", () => setKaraokeMode(false));
  $("#kPlayHere").addEventListener("click", () => {
    const q = `${cleanTitle(app.media.title || "")} ${cleanArtist(app.media.artist || "")}`.trim();
    if (app.media.available && app.media.playing && !app.local) control("toggle"); // pausa o app de fora
    const prev = settings.service;
    settings.service = prev === "soundcloud" ? "soundcloud" : "ytmusic";
    playQuery(q); // lê o serviço na hora; depois volta o que estava escolhido
    settings.service = prev;
  });
  $("#kMic").addEventListener("click", async () => {
    try {
      if (karaoke.micOn) karaoke.micStop();
      else {
        await karaoke.micStart();
        toast("Microfone ligado: use fone de ouvido pra não dar microfonia 🎧", 3500);
      }
    } catch (e) {
      toast(/denied|NotAllowed/i.test(String(e)) ? "O Windows não deixou usar o microfone. Libere em Configurações do Windows → Privacidade → Microfone." : `Microfone: ${e?.message || e}`, 6000);
    }
    renderKaraoke();
  });
  for (const k of ["mic", "echo", "reverb"]) {
    $(`#k_${k}`).addEventListener("input", (e) => {
      karaoke.set(k, e.target.value / 100);
      e.target.style.setProperty("--p", `${e.target.value}%`);
    });
  }
  $("#k_voice").addEventListener("input", (e) => {
    K_DEFAULTS.voice = e.target.value / 100;
    e.target.style.setProperty("--p", `${e.target.value}%`);
    player?.setKaraoke(true, K_DEFAULTS.voice);
  });
  async function stopRecording() {
    clearInterval(recTimer);
    const blob = await karaoke.recStop();
    renderKaraoke();
    $("#kRecTime").textContent = "Gravar";
    if (!blob || blob.size < 2000) return;
    await saveRecording(blob, `karaoke-${cleanTitle(app.media.title || "musica").replace(/[^\w-]+/g, "-").slice(0, 30)}-${Stats.dayKey(new Date())}`);
  }
  async function saveRecording(blob, name) {
    const data = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });
    if (api.demo) {
      const a = document.createElement("a");
      a.href = data;
      a.download = `${name}.webm`;
      a.click();
      return;
    }
    try {
      const path = await api.invoke("save_audio", { name, dataBase64: data });
      toast(`Gravação salva em ${path}`, 5000);
    } catch (e) {
      toast(`Não consegui salvar: ${e}`, 4000);
    }
  }
  $("#kRec").addEventListener("click", async () => {
    if (karaoke.recording) return stopRecording();
    try {
      karaoke.recStart();
      recStart = Date.now();
      recTimer = setInterval(() => ($("#kRecTime").textContent = fmt(Date.now() - recStart)), 500);
      $("#kRecTime").textContent = "0:00";
    } catch (e) {
      toast(`Não deu pra gravar: ${e?.message || e}`);
    }
    renderKaraoke();
  });

  return {
    get karaoke() { return karaoke; },
    get setKaraokeMode() { return setKaraokeMode; },
    get saveRecording() { return saveRecording; },
    get kOn() { return kOn; },
    get renderKaraoke() { return renderKaraoke; },
  };
}
