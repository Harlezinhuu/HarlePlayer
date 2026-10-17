// Configurações

import { EQ_FREQS } from "../player.js";
import { esc } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initSettings(app) {
  const { $, $$, api, IS_WALLPAPER, settings, saveSettings, SERVICES, keyOf, toast, player, setAccent, idb, BUILTINS, loadLibrary, addWallpaperFile, applyBackground, showChunk, dropNow, applyFx, setService, refreshDiscordStatus } = app;
  function renderSettings() {
    document.querySelectorAll("#segBg button").forEach((b) => b.classList.toggle("sel", b.dataset.v === settings.bg));
    $("#swLyrics").classList.toggle("on", settings.lyrics);
    $("#sw24").classList.toggle("on", settings.clock24);
    $("#swWallpaper").classList.toggle("on", settings.wallpaperMode);
    $("#offVal").textContent = `${settings.lyricsOffset > 0 ? "+" : ""}${settings.lyricsOffset.toFixed(1).replace(".", ",")} s`;
    $("#btnLyrics").classList.toggle("on", settings.lyrics);
    document.body.classList.toggle("no-lyrics", !settings.lyrics);
    document.body.classList.toggle("lyrics-line", settings.lyricsMode !== "chunks");
    document.querySelectorAll("#segLyrics button").forEach((b) => b.classList.toggle("sel", b.dataset.v === settings.lyricsMode));
    for (const c of ["solid", "thin", "outline"]) document.body.classList.toggle(`clock-${c}`, settings.clockStyle === c);
    document.querySelectorAll("#segClock button").forEach((b) => b.classList.toggle("sel", b.dataset.v === settings.clockStyle));
    $("#swDiscord").classList.toggle("on", settings.discord);
    $("#swVisualizer").classList.toggle("on", settings.visualizer);
    $("#swParticles").classList.toggle("on", settings.particles);
    $("#swDropFx").classList.toggle("on", settings.dropFx);
    document.body.classList.toggle("no-visualizer", !settings.visualizer);
    $("#swDiscordSpotify").classList.toggle("on", settings.discordSpotify);
    $("#segBrowser").innerHTML = ["soundcloud", "ytmusic", "youtube"]
      .map((id) => `<button data-v="${id}" class="${id === settings.browserService ? "sel" : ""}">${esc(SERVICES[id].name)}</button>`)
      .join("");
    renderLibrary();
    renderTheme();
    renderEq();
  }

  // ---------- abas das configurações ----------
  $("#setTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-st]");
    if (!b) return;
    for (const x of $$("#setTabs button")) x.classList.toggle("sel", x === b);
    for (const pg of $$(".set-page")) pg.hidden = pg.dataset.page !== b.dataset.st;
    $("#settings").scrollTop = 0;
  });

  // ---------- tema ----------
  const ACCENTS = ["#4c8dff", "#9b5de5", "#ff4d8d", "#ff5a4f", "#ff9f1c", "#ffd166", "#1ed760", "#2ec4b6", "#e5e7eb"];
  function applyTheme() {
    document.body.classList.toggle("layout-mirror", settings.layout === "mirror");
    for (const f of ["sans", "condensed"]) document.body.classList.toggle(`lyric-${f}`, settings.lyricFont === f);
    document.documentElement.style.setProperty("--lyric-scale", String((settings.lyricScale || 100) / 100));
    document.documentElement.style.setProperty("--dim", String((settings.dim || 0) / 100));
    setAccent(app.coverAccent, false);
  }
  function renderTheme() {
    $$("#segLayout button").forEach((b) => b.classList.toggle("sel", b.dataset.v === settings.layout));
    $$("#segLyricFont button").forEach((b) => b.classList.toggle("sel", b.dataset.v === settings.lyricFont));
    const custom = settings.accent !== "cover" && !ACCENTS.includes(settings.accent);
    $("#segAccent").innerHTML =
      `<button class="auto ${settings.accent === "cover" ? "sel" : ""}" data-c="cover" title="Muda conforme a capa">Da capa</button>` +
      ACCENTS.map((c) => `<button style="--c:${c}" data-c="${c}" class="${settings.accent === c ? "sel" : ""}" title="${c}"></button>`).join("") +
      `<label class="${custom ? "sel" : ""}" title="Outra cor" style="${custom ? `background:${settings.accent}` : ""}">${custom ? "" : "+"}<input type="color" id="accentCustom" value="${custom ? settings.accent : "#4c8dff"}"></label>`;
    for (const [id, v] of [["#rngLyricSize", settings.lyricScale || 100], ["#rngDim", settings.dim || 0]]) {
      const el = $(id);
      el.value = v;
      el.style.setProperty("--p", `${((v - el.min) / (el.max - el.min)) * 100}%`);
    }
  }
  const setTheme = (patch) => {
    Object.assign(settings, patch);
    saveSettings();
    applyTheme();
    renderTheme();
  };
  $("#segLayout").addEventListener("click", (e) => e.target.dataset.v && setTheme({ layout: e.target.dataset.v }));
  $("#segLyricFont").addEventListener("click", (e) => e.target.dataset.v && setTheme({ lyricFont: e.target.dataset.v }));
  $("#segAccent").addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (b) setTheme({ accent: b.dataset.c });
  });
  $("#segAccent").addEventListener("input", (e) => {
    if (e.target.id !== "accentCustom") return;
    settings.accent = e.target.value;
    saveSettings();
    applyTheme();
  });
  $("#segAccent").addEventListener("change", (e) => e.target.id === "accentCustom" && renderTheme());
  for (const [id, key] of [["#rngLyricSize", "lyricScale"], ["#rngDim", "dim"]]) {
    $(id).addEventListener("input", (e) => {
      settings[key] = +e.target.value;
      applyTheme();
      e.target.style.setProperty("--p", `${((e.target.value - e.target.min) / (e.target.max - e.target.min)) * 100}%`);
    });
    $(id).addEventListener("change", saveSettings);
  }

  // ---------- equalizador ----------
  const EQ_PRESETS = {
    flat: { name: "Normal", g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    bass: { name: "Grave+", g: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    bassmax: { name: "Grave forte", g: [9, 8, 6, 3, 0, -1, 0, 0, 0, 0] },
    vocal: { name: "Vocal", g: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
    pop: { name: "Pop", g: [-1, 1, 3, 4, 2, 0, -1, -1, 0, 1] },
    rock: { name: "Rock", g: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
    electronic: { name: "Eletrônica", g: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
    acoustic: { name: "Acústico", g: [3, 3, 2, 1, 1, 1, 2, 3, 2, 1] },
    treble: { name: "Agudos+", g: [0, 0, 0, 0, 0, 1, 3, 5, 6, 6] },
  };
  const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
  function renderEq() {
    $("#swEq").classList.toggle("on", settings.eq);
    const custom = settings.eqPreset === "custom";
    $("#segEqPreset").innerHTML =
      Object.entries(EQ_PRESETS).map(([id, p]) => `<button data-v="${id}" class="${settings.eqPreset === id ? "sel" : ""}">${p.name}</button>`).join("") +
      (custom ? `<button data-v="custom" class="sel">Personalizado</button>` : "");
    $("#eqBands").classList.toggle("off", !settings.eq);
    if ($("#eqBands").childElementCount !== EQ_FREQS.length) {
      $("#eqBands").innerHTML = EQ_FREQS.map((f, i) => `<label class="eq-band"><span class="db" data-db="${i}"></span><input type="range" min="-12" max="12" step="1" data-i="${i}" aria-label="${fmtHz(f)} Hz"><span>${fmtHz(f)}</span></label>`).join("");
    }
    $$("#eqBands input").forEach((el, i) => {
      el.value = settings.eqGains[i] || 0;
      const d = +el.value;
      $(`#eqBands [data-db="${i}"]`).textContent = d > 0 ? `+${d}` : String(d);
    });
  }
  function applyEq() {
    player?.setEq(settings.eq, settings.eqGains);
  }
  $("#swEq").addEventListener("click", () => {
    settings.eq = !settings.eq;
    saveSettings();
    applyEq();
    renderEq();
  });
  $("#segEqPreset").addEventListener("click", (e) => {
    const id = e.target.dataset.v;
    if (!id || !EQ_PRESETS[id]) return;
    Object.assign(settings, { eqPreset: id, eqGains: EQ_PRESETS[id].g.slice(), eq: true });
    saveSettings();
    applyEq();
    renderEq();
  });
  $("#eqBands").addEventListener("input", (e) => {
    const i = +e.target.dataset.i;
    if (!Number.isFinite(i)) return;
    settings.eqGains = settings.eqGains.slice();
    settings.eqGains[i] = +e.target.value;
    settings.eqPreset = Object.keys(EQ_PRESETS).find((k) => EQ_PRESETS[k].g.every((g, j) => g === settings.eqGains[j])) || "custom";
    applyEq();
    renderEq();
  });
  $("#eqBands").addEventListener("change", saveSettings);

  function renderLibrary() {
    const sel = settings.wallpaperId || BUILTINS[0].id;
    const tiles = [
      ...BUILTINS.map(
        (b) => `<button class="lib-tile builtin-${b.builtin}${sel === b.id ? " sel" : ""}" data-id="${b.id}" title="${esc(b.name)}"><span>${esc(b.name)}</span></button>`,
      ),
      ...app.library.map((w) => {
        const bg = w.thumb ? ` style="background-image:url('${w.thumb}')"` : "";
        const badge = (w.type || "").startsWith("video/") ? `<i class="lib-badge">▶</i>` : "";
        return `<button class="lib-tile${sel === w.id ? " sel" : ""}" data-id="${esc(w.id)}" title="${esc(w.name)}"${bg}>${badge}<span>${esc(w.name)}</span><i class="lib-del" data-del="${esc(w.id)}" title="Remover">×</i></button>`;
      }),
      `<button class="lib-tile lib-add" data-add="1" title="Adicionar vídeo, GIF ou imagem"><b>+</b><span>Adicionar</span></button>`,
    ];
    $("#lib").innerHTML = tiles.join("");
  }

  $("#btnSettings").addEventListener("click", () => {
    $("#settings").hidden = !$("#settings").hidden;
    $("#btnSettings").classList.toggle("on", !$("#settings").hidden);
    clearInterval(app.discordStatusTimer);
    if (!$("#settings").hidden) {
      refreshDiscordStatus();
      app.discordStatusTimer = setInterval(refreshDiscordStatus, 3000);
    }
  });
  $("#btnCloseSettings").addEventListener("click", () => {
    $("#settings").hidden = true;
    $("#btnSettings").classList.remove("on");
  });
  $("#segBg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    settings.bg = b.dataset.v;
    saveSettings();
    renderSettings();
    applyBackground();
  });
  $("#segLyrics").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    settings.lyricsMode = b.dataset.v;
    app.shownLine = null;
    app.shownText = "";
    $("#lyricChunk").textContent = "";
    saveSettings();
    renderSettings();
  });
  $("#segClock").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    settings.clockStyle = b.dataset.v;
    saveSettings();
    renderSettings();
  });
  $("#segService").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) setService(b.dataset.v);
  });

  $("#lib").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      try { await idb.del("wallpapers", del.dataset.del); } catch {}
      if (settings.wallpaperId === del.dataset.del) settings.wallpaperId = BUILTINS[0].id;
      saveSettings();
      await loadLibrary();
      renderLibrary();
      applyBackground();
      return;
    }
    if (e.target.closest("[data-add]")) return $("#fileInput").click();
    const tile = e.target.closest("[data-id]");
    if (!tile) return;
    settings.wallpaperId = tile.dataset.id;
    settings.bg = "custom"; // mostra no player também, pra ver na hora
    saveSettings();
    renderSettings();
    applyBackground();
  });

  $("#fileInput").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 1024 * 1024 * 1024) return toast("Arquivo grande demais (máx. 1 GB)");
    toast("Adicionando wallpaper…", 6000);
    try {
      await addWallpaperFile(f, f.name.replace(/\.[^.]+$/, ""), f.type || "image/*");
      renderSettings();
      applyBackground();
      toast("Wallpaper adicionado");
    } catch {
      toast("Não deu pra salvar esse arquivo");
    }
  });

  const toggleLyrics = () => {
    settings.lyrics = !settings.lyrics;
    if (!settings.lyrics) showChunk("");
    saveSettings();
    renderSettings();
  };
  $("#swLyrics").addEventListener("click", toggleLyrics);
  $("#swParticles").addEventListener("click", () => {
    settings.particles = !settings.particles;
    saveSettings();
    renderSettings();
    applyFx();
  });
  $("#swDropFx").addEventListener("click", () => {
    settings.dropFx = !settings.dropFx;
    saveSettings();
    renderSettings();
    if (settings.dropFx) dropNow();
  });
  $("#swVisualizer").addEventListener("click", () => {
    settings.visualizer = !settings.visualizer;
    saveSettings();
    renderSettings();
    applyFx();
    api.invoke("set_visualizer", { on: settings.visualizer }).catch(() => {});
  });
  $("#btnLyrics").addEventListener("click", toggleLyrics);
  // ---------- mini player automático ao minimizar ----------
  let miniAuto = false; // o mini atual foi aberto sozinho (então fecha sozinho também)
  if (!IS_WALLPAPER) {
    api.listen("main-minimized", async () => {
      if (!settings.autoMini || miniAuto || $("#btnMini").classList.contains("on")) return;
      if (!keyOf(app.media) || !app.media.playing) return;
      try {
        if (await api.invoke("set_mini", { open: true })) {
          miniAuto = true;
          $("#btnMini").classList.add("on");
        }
      } catch {}
    });
    api.listen("main-restored", () => {
      if (!miniAuto) return;
      miniAuto = false;
      api.invoke("set_mini", { open: false }).catch(() => {});
      $("#btnMini").classList.remove("on");
    });
  }
  $("#swAutoMini").addEventListener("click", () => {
    settings.autoMini = !settings.autoMini;
    saveSettings();
    $("#swAutoMini").classList.toggle("on", settings.autoMini);
  });

  $("#btnMini").addEventListener("click", async () => {
    miniAuto = false; // abriu/fechou na mão: não fecha sozinho
    const open = !$("#btnMini").classList.contains("on");
    try {
      const r = await api.invoke("set_mini", { open });
      $("#btnMini").classList.toggle("on", !!r);
      if (r === undefined) window.open("mini.html", "mini", "width=380,height=120"); // modo demo
    } catch (e) {
      toast(`Não abriu o mini player: ${e}`);
    }
  });

  return {
    get renderSettings() { return renderSettings; },
    get applyTheme() { return applyTheme; },
    get applyEq() { return applyEq; },
    get toggleLyrics() { return toggleLyrics; },
    get miniAuto() { return miniAuto; },
    set miniAuto(v) { miniAuto = v; },
  };
}
