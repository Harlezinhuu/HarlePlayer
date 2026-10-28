// Harle Player — front-end (HTML/CSS/JS puro, sem build).
// Dentro do app, fala com o Rust via window.__TAURI__.
// Aberto direto no navegador, roda em "modo demo" com dados de exemplo.
//
// Aqui fica o núcleo: estado da música, player, fundo, letra, relógio e busca.
// Cada recurso maior mora em features/ (fila, configurações, karaokê,
// freestyle, retrospectiva, ouvir junto, celular…) e recebe o objeto `app`
// com o que precisa daqui.

import { createPlayer } from "./player.js";
import { createDropDetector } from "./drops.js";
import { createFx, paletteOf } from "./fx.js";
import { fmt, esc, rgbToHsl, hslToRgb, slotOf, cleanTitle, cleanArtist, lyricVariants, parseLrc, isPlaceholderTitle, isNonMusic } from "./lib.js";
import { initRemote } from "./features/remote.js";
import { initParty } from "./features/party.js";
import { initFreestyle } from "./features/freestyle.js";
import { initKaraoke } from "./features/karaoke.js";
import { initDesktop } from "./features/desktop.js";
import { initWrapped } from "./features/wrapped.js";
import { initSettings } from "./features/settings.js";
import { initSearch } from "./features/search.js";
import { initLibrary } from "./features/library.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const T = window.__TAURI__;

const api = T
  ? {
      demo: false,
      invoke: (cmd, args) => T.core.invoke(cmd, args),
      listen: (ev, cb) => T.event.listen(ev, (e) => cb(e.payload)),
      emit: (ev, payload) => T.event.emit(ev, payload),
    }
  : (await import("./demo.js")).createDemoApi();

// A mesma página roda em duas janelas: o player ("main") e o wallpaper
// atrás dos ícones ("wallpaper"). No navegador, use ?wallpaper pra ver o layout.
const IS_WALLPAPER = T
  ? T.window.getCurrentWindow().label === "wallpaper"
  : new URLSearchParams(location.search).has("wallpaper");
if (IS_WALLPAPER) document.body.classList.add("mode-wallpaper");

// ===================================================================
// Configurações (salvas no próprio app)
// ===================================================================
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const DEFAULTS = {
  bg: "dynamic", // dynamic | custom | transparent
  service: "soundcloud",
  lyrics: true,
  lyricsMode: "line", // line = verso inteiro (karaokê) | chunks = pedaços grandes
  lyricsOffset: 0, // segundos (+ adianta a letra)
  volume: 0.8, // volume do player interno (0–1)
  queueTab: "fila", // "fila" | "recentes" | "playlists"
  visualizer: true, // fundo/relógio/capa reagem ao grave
  wallpaperVisualizer: true, // ...e no wallpaper também
  particles: true, // partículas no fundo
  dropFx: true, // efeitos no drop
  remote: false, // controle pelo celular (servidor na rede local)
  hotkeys: true, // atalhos globais Ctrl+Alt+…
  layout: "classic", // "classic" | "mirror"
  accent: "cover", // "cover" (cor da capa) ou "#rrggbb"
  lyricFont: "serif", // "serif" | "sans" | "condensed"
  lyricScale: 100, // %
  dim: 0, // escurecer o fundo (%)
  eq: false,
  eqPreset: "flat",
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  notify: true, // aviso de música nova no canto da tela
  autoMini: true, // abre o mini player ao minimizar
  ducking: false, // abaixa a música quando alguém fala no Discord (opcional: o Windows/Discord já podem fazer isso)
  duckLevel: 0.3, // pra quanto abaixa (fração do volume)
  lyricsbar: false, // letra flutuante na parte de baixo da tela
  dj: false, // DJ com voz entre as músicas
  djEvery: "some", // "all" | "some"
  djVoice: "",
  partyName: "",
  partyMode: "harle", // convidado: "harle" (toca aqui) | "spotify" (abre no Spotify, experimental)
  clock24: true,
  clockStyle: "solid", // solid | thin | outline
  wallpaperMode: false, // wallpaper animado atrás dos ícones
  wallpaperId: "builtin:aurora",
  wallFit: "auto", // auto | cover | contain (inteiro, com as laterais desfocadas)
  discord: true, // Rich Presence
  discordSpotify: false, // o Spotify já mostra sozinho no Discord
  discordJoin: true, // com sala aberta: "Pedir para participar" no perfil do Discord
  browserService: "soundcloud", // quando não dá pra saber qual site do navegador está tocando
};
const settings = { ...DEFAULTS, ...store.get("hp.settings", {}) };
delete settings.widget; // opção antiga
const saveSettings = () => store.set("hp.settings", settings);
// 0.11.1: abaixar no Discord virou opcional (vinha ligado e somava com o do Windows/Discord)
if (!settings.duckOptIn && !IS_WALLPAPER) {
  settings.ducking = false;
  settings.duckOptIn = true;
  saveSettings();
}
/** "Reagir ao som" vale nesta janela? (o wallpaper tem chave própria) */
const vizOn = () => settings.visualizer && (!IS_WALLPAPER || settings.wallpaperVisualizer);

// url: abre no app/site · web: link https (usado no botão do Discord)
const enc = encodeURIComponent;
const SERVICES = {
  spotify: { name: "Spotify", color: "#1ed760", url: (q) => `spotify:search:${enc(q)}`, web: (q) => `https://open.spotify.com/search/${enc(q)}` },
  soundcloud: { name: "SoundCloud", color: "#ff7a1a", url: (q) => `https://soundcloud.com/search?q=${enc(q)}` },
  ytmusic: { name: "YouTube Music", color: "#ff3b3b", url: (q) => `https://music.youtube.com/search?q=${enc(q)}` },
  youtube: { name: "YouTube", color: "#ff0033", url: (q) => `https://www.youtube.com/results?search_query=${enc(q)}` },
  apple: { name: "Apple Music", color: "#fa3d5a", url: (q) => `https://music.apple.com/br/search?term=${enc(q)}` },
  deezer: { name: "Deezer", color: "#a238ff", url: (q) => `https://www.deezer.com/search/${enc(q)}` },
};
const serviceWeb = (id, q) => (SERVICES[id]?.web || SERVICES[id]?.url)?.(q);
const SOURCE_NAMES = { tidal: "TIDAL", other: "Outro app", browser: "Navegador" };
const serviceName = (id) => SERVICES[id]?.name || SOURCE_NAMES[id] || "";
if (!SERVICES[settings.service]) settings.service = "spotify";

// ===================================================================
// Estado
// ===================================================================
let media = { available: false, title: "", artist: "", album: "", source: "", playing: false, positionMs: 0, durationMs: 0, updatedAtMs: Date.now(), thumb: null, service: "" };
let history = store.get("hp.history", []).filter((h) => !isNonMusic(h)); // limpa jogos/vídeos que entraram antes
let lastThumb = null;
let focusOffset = 0;
let lyrics = null; // { key, lines: [{ t, end, text, chunks: [{ t, text }] }] }

const keyOf = (s) => (s && s.available && s.title ? `${s.title}␟${s.artist}` : "");

function positionNow() {
  if (!media.available) return 0;
  let p = media.positionMs;
  if (media.playing) {
    const dt = Date.now() - media.updatedAtMs;
    if (dt > 0 && dt < 6 * 3600e3) p += dt;
  }
  return media.durationMs > 0 ? Math.min(Math.max(0, p), media.durationMs) : Math.max(0, p);
}

// ===================================================================
// Utilidades
// ===================================================================
let toastTimer;
function toast(msg, ms = 2400) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

async function httpJson(url) {
  try {
    const text = await api.invoke("http_get", { url });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function openInService(query, directLink) {
  const svc = SERVICES[settings.service];
  const url = settings.service === "deezer" && directLink ? directLink : svc.url(query);
  api
    .invoke("open_url", { url })
    .then(() => toast(`Abrindo no ${svc.name}…`))
    .catch((e) => toast(String(e)));
}

/** Sessão de mídia do próprio Harle Player vista pelo Windows (o player do YouTube
 *  escondido também se anuncia lá, com o nome do vídeo e do canal). */
const isOwnSession = (s) => /harle/i.test(s?.source || "");

function control(action, positionMs) {
  // Música tocando no player interno → controla ele; senão, o app de música do Windows.
  if (player?.active && (local || isOwnSession(media))) {
    if (action === "toggle") return player.toggle();
    if (action === "next") return player.next();
    if (action === "prev") return player.prev();
    if (action === "seek") return player.seek(positionMs);
  }
  return api.invoke("media_control", { action, positionMs }).catch((e) => toast(String(e)));
}

// ===================================================================
// Player interno (toca SoundCloud e YouTube dentro do app)
// ===================================================================
const PLAYABLE = { soundcloud: true, ytmusic: true, youtube: true };
let local = null; // estado do player interno enquanto ele tem música
const player = IS_WALLPAPER
  ? null
  : createPlayer({
      api,
      toast,
      resolve: (t) => libraryUi.resolveTrack(t),
      onQueue: () => libraryUi.renderQueue(),
      onState: (st) => {
        local = st.available ? st : null;
        if (local) onMedia(st, true);
        else api.invoke("get_media").then((x) => onMedia(x)).catch(() => {});
      },
    });

player?.setVolume(settings.volume);

function toTrack(t, service) {
  const url = service === "youtube" && t.url ? t.url.replace("://music.youtube.com/", "://www.youtube.com/") : t.url;
  return { title: t.title, artist: t.artist || "", cover: t.cover || null, url, service, durationMs: t.durationMs || 0 };
}

/** Procura no serviço escolhido e toca o primeiro resultado (sem abrir navegador). */
async function playQuery(q) {
  if (!player || !PLAYABLE[settings.service]) return openInService(q);
  const svc = settings.service;
  toast(`Procurando no ${SERVICES[svc].name}…`, 2500);
  try {
    const res = await api.invoke("search_music", { service: svc === "soundcloud" ? "soundcloud" : "ytmusic", query: q });
    const tracks = (res?.tracks || []).map((t) => toTrack(t, svc));
    if (!tracks.length) return toast("Não achei essa música");
    player.playQueue(tracks, 0);
  } catch (e) {
    toast(String(e?.message || e));
  }
}

/** Toca um item do histórico/carrossel: direto se já tocou aqui, senão procura. */
function playItem(item) {
  if (player && item.play?.url) return player.playQueue([item.play], 0);
  return playQuery(`${item.title} ${item.artist}`.trim());
}

function shrinkImage(src, size = 220) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const r = Math.min(1, size / Math.max(img.width, img.height));
        c.width = Math.max(1, Math.round(img.width * r));
        c.height = Math.max(1, Math.round(img.height * r));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.86));
      } catch {
        resolve(src);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ---------- cor da capa ----------
let coverAccent = [120, 170, 255];
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function setAccent(rgb, fromCover = true) {
  if (fromCover) coverAccent = rgb;
  if (settings.accent && settings.accent !== "cover" && /^#[0-9a-f]{6}$/i.test(settings.accent)) rgb = hexToRgb(settings.accent);
  const [h, s] = rgbToHsl(...rgb);
  accentHue = h;
  const accent = hslToRgb(h, Math.max(0.55, Math.min(s, 0.9)), 0.64);
  const lyric = hslToRgb(h, Math.max(0.6, Math.min(s, 0.95)), 0.8);
  document.documentElement.style.setProperty("--accent", accent.join(", "));
  document.documentElement.style.setProperty("--lyric", lyric.join(", "));
}
function accentFrom(src) {
  if (!src) return setAccent([120, 170, 255]);
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 24;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const max = Math.max(d[i], d[i + 1], d[i + 2]);
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        const sat = max ? (max - min) / max : 0;
        const wt = sat * sat * (max / 255) + 0.004;
        r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
      }
      setAccent([r / w, g / w, b / w]);
    } catch {
      setAccent([120, 170, 255]);
    }
  };
  img.src = src;
}

// ===================================================================
// Relógio
// ===================================================================
function tickClock() {
  const d = new Date();
  let h = d.getHours();
  if (!settings.clock24) h = h % 12 || 12;
  $("#time").textContent = `${h}:${String(d.getMinutes()).padStart(2, "0")}`;
  const date = d
    .toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" })
    .replace(/\./g, "");
  $("#date").textContent = date.charAt(0).toUpperCase() + date.slice(1);
}
tickClock();
setInterval(tickClock, 1000);

// ===================================================================
// Fundo
// ===================================================================
let artFlip = false;
function updateArt(thumb) {
  lastThumb = thumb;
  const next = artFlip ? $("#bgArtA") : $("#bgArtB");
  const prev = artFlip ? $("#bgArtB") : $("#bgArtA");
  artFlip = !artFlip;
  if (thumb) {
    next.style.backgroundImage = `url("${thumb}")`;
    next.classList.add("show");
  } else {
    next.classList.remove("show");
  }
  prev.classList.remove("show");
  accentFrom(thumb);
}

// ---------- banco local (IndexedDB) com os arquivos de wallpaper ----------
const idb = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((res, rej) => {
      const r = indexedDB.open("harle-player", 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
        if (!db.objectStoreNames.contains("wallpapers")) db.createObjectStore("wallpapers", { keyPath: "id" });
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        res(r.result);
      };
      r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async req(storeName, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, mode);
      const q = fn(tx.objectStore(storeName));
      tx.oncomplete = () => res(q?.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  get: (s, k) => idb.req(s, "readonly", (st) => st.get(k)),
  all: (s) => idb.req(s, "readonly", (st) => st.getAll()),
  put: (s, v) => idb.req(s, "readwrite", (st) => st.put(v)),
  del: (s, k) => idb.req(s, "readwrite", (st) => st.delete(k)),
};

// ---------- biblioteca de wallpapers ----------
const BUILTINS = [
  { id: "builtin:aurora", name: "Aurora", builtin: "aurora" },
  { id: "builtin:cover", name: "Capa da música", builtin: "cover" },
  { id: "builtin:clip", name: "Clipe da música", builtin: "clip" },
];
let library = [];

async function loadLibrary() {
  try {
    library = (await idb.all("wallpapers")) || [];
  } catch {
    library = [];
  }
  library.sort((a, b) => b.added - a.added);
}

function videoThumb(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    let done = false;
    const finish = (val) => {
      if (!done) {
        done = true;
        resolve(val);
      }
    };
    v.muted = true;
    v.preload = "auto";
    v.onloadeddata = () => (v.currentTime = Math.min(1, (v.duration || 2) / 2));
    v.onseeked = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * 320) || 180;
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL("image/jpeg", 0.8));
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
    v.src = url;
  });
}

async function addWallpaperFile(blob, name, type) {
  const url = URL.createObjectURL(blob);
  const isVideo = (type || "").startsWith("video/");
  const thumb = isVideo ? await videoThumb(url) : await shrinkImage(url, 320);
  URL.revokeObjectURL(url);
  const rec = { id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, type, blob, thumb, added: Date.now() };
  await idb.put("wallpapers", rec);
  await loadLibrary();
  settings.wallpaperId = rec.id;
  settings.bg = "custom";
  saveSettings();
}

// Versão anterior guardava um único fundo; move ele pra biblioteca.
async function migrateOldBackground() {
  try {
    const old = await idb.get("files", "bg");
    if (!old?.blob) return;
    await addWallpaperFile(old.blob, old.name || "Fundo", old.type || "image/*");
    await idb.req("files", "readwrite", (st) => st.delete("bg"));
  } catch {}
}

// ---------- "Aurora": wallpaper animado embutido (canvas) ----------
let auroraRaf = 0;
let accentHue = 0.6;
let paused = false;
const auroraCanvas = $("#bgCanvas");
const fitAurora = () => {
  auroraCanvas.width = Math.ceil(innerWidth / 8);
  auroraCanvas.height = Math.ceil(innerHeight / 8);
};
window.addEventListener("resize", fitAurora);

function startAurora() {
  stopAurora();
  auroraCanvas.hidden = false;
  fitAurora();
  const ctx = auroraCanvas.getContext("2d");
  const blobs = Array.from({ length: 6 }, (_, i) => ({
    px: Math.random() * 6.28,
    py: Math.random() * 6.28,
    sp: 0.6 + Math.random() * 0.8,
    r: 0.35 + Math.random() * 0.35,
    dh: (i - 2.5) * 0.05,
    l: 0.42 + Math.random() * 0.2,
  }));
  let last = 0;
  const draw = (t) => {
    auroraRaf = requestAnimationFrame(draw);
    if (paused || t - last < (beat > 0.02 ? 33 : 40)) return; // ~25–30 fps: leve pra GPU
    last = t;
    const w = auroraCanvas.width, h = auroraCanvas.height, s = t / 1000;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#04060d";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const x = (0.5 + 0.42 * Math.sin(s * 0.11 * b.sp + b.px)) * w;
      const y = (0.5 + 0.38 * Math.cos(s * 0.09 * b.sp + b.py)) * h;
      const r = b.r * Math.max(w, h) * (0.9 + 0.1 * Math.sin(s * 0.4 + b.px)) * (1 + beat * 0.28);
      const [R, G, B] = hslToRgb((((accentHue + b.dh) % 1) + 1) % 1, 0.75, b.l);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${R},${G},${B},${(0.55 + beat * 0.3).toFixed(3)})`);
      g.addColorStop(1, `rgba(${R},${G},${B},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  };
  auroraRaf = requestAnimationFrame(draw);
}
function stopAurora() {
  cancelAnimationFrame(auroraRaf);
  auroraRaf = 0;
  auroraCanvas.hidden = true;
}

// ---------- encaixe: vídeo/imagem que não tem o formato da tela ----------
// "Inteiro": mostra tudo (object-fit: contain) e preenche as sobras com uma
// miniatura do próprio fundo, bem desfocada (atualizada ~10×/s no vídeo).
const fitter = (() => {
  const canvas = $("#bgFill");
  const ctx = canvas.getContext("2d");
  let timer = 0, el = null;
  function shouldContain(w, h) {
    if (settings.wallFit === "contain") return true;
    if (settings.wallFit === "cover" || !w || !h) return false;
    // automático: só quando o formato é bem diferente da tela (ex.: vídeo de celular)
    const ratio = w / h / (innerWidth / innerHeight);
    return ratio < 0.75 || ratio > 1.6;
  }
  function draw() {
    try { if (el) ctx.drawImage(el, 0, 0, canvas.width, canvas.height); } catch {}
  }
  function update() {
    clearInterval(timer);
    const w = el?.videoWidth || el?.naturalWidth, h = el?.videoHeight || el?.naturalHeight;
    const on = !!el && !el.hidden && shouldContain(w, h);
    $("#bg").classList.toggle("fit-contain", on);
    canvas.hidden = !on;
    if (!on) return;
    draw();
    if (el.tagName === "VIDEO") timer = setInterval(() => !el.paused && draw(), 100);
  }
  window.addEventListener("resize", () => el && update());
  return {
    attach(node) {
      el = node;
      if (!node) return update();
      const ev = node.tagName === "VIDEO" ? "loadeddata" : "load";
      if (node.tagName === "VIDEO" ? node.readyState >= 2 : node.complete && node.naturalWidth) update();
      else node.addEventListener(ev, update, { once: true });
    },
    update,
  };
})();

// ---------- aplica o fundo ----------
let bgObjectUrl = null;
async function applyBackground() {
  const img = $("#bgImage"), vid = $("#bgVideo");
  img.hidden = vid.hidden = true;
  fitter.attach(null);
  vid.pause();
  stopAurora();

  // Na área de trabalho vale sempre o wallpaper escolhido;
  // no player vale a opção "Fundo do player".
  let mode = IS_WALLPAPER ? "custom" : settings.bg;
  let rec = null;
  if (mode === "custom") {
    const id = settings.wallpaperId || BUILTINS[0].id;
    rec = BUILTINS.find((b) => b.id === id) || null;
    if (!rec) {
      try { rec = await idb.get("wallpapers", id); } catch {}
    }
    if (!rec) rec = BUILTINS[0];
    if (rec.builtin === "cover") mode = "dynamic";
    if (rec.builtin === "clip") mode = "clip";
  }

  document.body.classList.remove("bg-dynamic", "bg-custom", "bg-transparent", "bg-clip");
  // clipe: por baixo fica a capa (aparece até o clipe carregar, ou se não achar clipe)
  document.body.classList.add(mode === "clip" ? "bg-dynamic" : `bg-${mode}`);
  if (mode === "clip") document.body.classList.add("bg-clip");
  clipBg.setEnabled(mode === "clip");
  if (bgObjectUrl) {
    URL.revokeObjectURL(bgObjectUrl);
    bgObjectUrl = null;
  }
  if (mode !== "custom" || !rec) return;
  if (rec.builtin === "aurora") return startAurora();

  bgObjectUrl = URL.createObjectURL(rec.blob);
  if ((rec.type || "").startsWith("video/")) {
    vid.src = bgObjectUrl;
    vid.hidden = false;
    if (!paused) vid.play().catch(() => {});
    fitter.attach(vid);
  } else {
    img.src = bgObjectUrl;
    img.hidden = false;
    fitter.attach(img);
  }
}

// ---------- "Clipe da música": o clipe oficial no fundo, mudo e sincronizado ----------
const clipBg = (() => {
  let enabled = false;
  let yt = null, ytReady = null;
  let curKey = "", curVid = null;
  const cache = new Map(Object.entries(store.get("hp.clips", {})));
  const saveCache = () => {
    const obj = Object.fromEntries([...cache.entries()].slice(-300));
    store.set("hp.clips", obj);
  };
  function loadApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const sc = document.createElement("script");
      sc.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(sc);
    }
    // espera o YT ficar pronto sem trocar o callback que o player já usa
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window.YT?.Player) { clearInterval(iv); res(); }
        else if (Date.now() - t0 > 15000) { clearInterval(iv); rej(new Error("YouTube não carregou")); }
      }, 200);
    });
  }
  async function findVideo(key) {
    if (cache.has(key)) return cache.get(key);
    const q = `${cleanTitle(media.title || "")} ${cleanArtist(media.artist || "")}`.trim();
    let vid = null;
    try {
      const r = await api.invoke("search_page", { service: "ytmusic", query: q, kind: "videos", cursor: null });
      const want = cleanTitle(media.title || "").toLowerCase().slice(0, 12);
      const tracks = r?.tracks || [];
      const best = tracks.find((t) => t.title.toLowerCase().includes(want)) || tracks[0];
      vid = best ? youtubeIdOf(best.url) : null;
    } catch {}
    cache.set(key, vid);
    saveCache();
    return vid;
  }
  const youtubeIdOf = (u) => { try { return new URL(u).searchParams.get("v"); } catch { return null; } };
  function show(on) {
    document.body.classList.toggle("clip-on", on);
  }
  async function load(key) {
    curKey = key;
    show(false);
    if (!enabled || !key) return yt?.stopVideo?.();
    const vid = await findVideo(key);
    if (curKey !== key || !enabled) return;
    curVid = vid;
    if (!vid) return yt?.stopVideo?.(); // sem clipe: fica a capa
    try { await loadApi(); } catch { return; }
    if (curKey !== key) return;
    const start = Math.max(0, positionNow() / 1000);
    if (!yt) {
      ytReady = new Promise((res) => {
        yt = new YT.Player("bgClipHost", {
          videoId: vid,
          playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, playsinline: 1, rel: 0, start: Math.floor(start), origin: location.origin },
          events: {
            onReady: (e) => { e.target.mute(); res(); },
            onStateChange: (e) => { if (e.data === 1) show(true); },
            onError: () => { cache.set(curKey, null); saveCache(); show(false); },
          },
        });
      });
    } else {
      await ytReady;
      yt.loadVideoById({ videoId: vid, startSeconds: start });
      yt.mute();
    }
  }
  // mantém o clipe no mesmo ponto da música (a cada 2 s)
  setInterval(() => {
    if (!enabled || !yt?.getPlayerState) return;
    const key = keyOf(media);
    if (key !== curKey) return load(key);
    if (!curVid) return;
    const st = yt.getPlayerState();
    if (!media.playing || paused) {
      if (st === 1) yt.pauseVideo();
      return;
    }
    if (st !== 1 && st !== 3) yt.playVideo();
    const drift = yt.getCurrentTime() * 1000 - positionNow();
    if (Math.abs(drift) > 1200 && positionNow() / 1000 < (yt.getDuration?.() || 1e9)) yt.seekTo(positionNow() / 1000, true);
  }, 2000);
  return {
    setEnabled(on) {
      if (enabled === on) return;
      enabled = on;
      if (on) load(keyOf(media));
      else { show(false); try { yt?.stopVideo(); } catch {} curKey = ""; }
    },
    trackChanged(key) {
      if (enabled && key !== curKey) load(key);
    },
  };
})();

// ===================================================================
// Histórico + "Continuar ouvindo"
// ===================================================================
function saveHistory() {
  if (IS_WALLPAPER) return; // só o player grava o histórico
  store.set("hp.history", history.slice(0, 24));
}

function upsertHistory(s) {
  const key = keyOf(s);
  if (!key) return;
  const i = history.findIndex((h) => h.key === key);
  const entry = i >= 0 ? history[i] : { key, title: s.title, artist: s.artist, album: s.album, thumb: null };
  if (i >= 0) history.splice(i, 1);
  if (s.local && s.link) {
    entry.play = { title: s.title, artist: s.artist, cover: s.coverUrl, url: s.link, service: s.service, durationMs: s.durationMs };
  }
  history.unshift(entry);
  history = history.slice(0, 24);
  saveHistory();
  if (s.thumb && entry.thumbOf !== s.thumb.length) {
    const target = s.thumb.length;
    shrinkImage(s.thumb).then((small) => {
      if (!small) return;
      entry.thumb = small;
      entry.thumbOf = target;
      saveHistory();
      render();
    });
  }
}

function queueItemHtml(item, now, extra = "") {
  const src = item.thumb || item.cover;
  const cover = src ? `<img class="q-cover" src="${esc(src)}" alt="" draggable="false">` : `<div class="q-cover"></div>`;
  const eq = now ? `<div class="eq"><i></i><i></i><i></i></div>` : "";
  return `${cover}<div class="q-text"><div class="q-title">${esc(item.title)}</div><div class="q-artist">${esc(item.artist || "—")}</div></div>${eq}${extra}`;
}

// ===================================================================
// O que as partes em features/ usam daqui. Getters = sempre o valor atual
// (media, local… mudam o tempo todo); os setters deixam elas atualizarem.
// ===================================================================
const app = {
  get $() { return $; },
  get $$() { return $$; },
  get BUILTINS() { return BUILTINS; },
  get ICON() { return libraryUi.ICON; },
  get IS_WALLPAPER() { return IS_WALLPAPER; },
  get NATIVE_SEARCH() { return NATIVE_SEARCH; },
  get PLAYABLE() { return PLAYABLE; },
  get SERVICES() { return SERVICES; },
  get addWallpaperFile() { return addWallpaperFile; },
  get api() { return api; },
  get applyBackground() { return applyBackground; },
  get applyFx() { return applyFx; },
  get closeSearch() { return closeSearch; },
  get control() { return control; },
  get coverAccent() { return coverAccent; }, set coverAccent(v) { coverAccent = v; },
  get discordStatusTimer() { return discordStatusTimer; }, set discordStatusTimer(v) { discordStatusTimer = v; },
  get dropNow() { return dropNow; },
  get enc() { return enc; },
  get fitter() { return fitter; },
  get history() { return history; }, set history(v) { history = v; },
  get httpJson() { return httpJson; },
  get idb() { return idb; },
  get importPlaylistUrl() { return libraryUi.importPlaylistUrl; },
  get isLocalVol() { return isLocalVol; },
  get isPlaylistLink() { return libraryUi.isPlaylistLink; },
  get isSongLink() { return libraryUi.isSongLink; },
  get kOn() { return karaokeUi.kOn; },
  get karaoke() { return karaokeUi.karaoke; },
  get keyOf() { return keyOf; },
  get library() { return library; }, set library(v) { library = v; },
  get loadLibrary() { return loadLibrary; },
  get local() { return local; }, set local(v) { local = v; },
  get lyrics() { return lyrics; }, set lyrics(v) { lyrics = v; },
  get media() { return media; }, set media(v) { media = v; },
  get nextRepeat() { return nextRepeat; },
  get notifyNow() { return desktop.notifyNow; },
  get openInService() { return openInService; },
  get openTrackMenu() { return libraryUi.openTrackMenu; },
  get partyUi() { return partyUi; },
  get playAlbum() { return libraryUi.playAlbum; },
  get playItem() { return playItem; },
  get playLink() { return libraryUi.playLink; },
  get playModes() { return playModes; },
  get playQuery() { return playQuery; },
  get player() { return player; },
  get playingService() { return playingService; },
  get positionNow() { return positionNow; },
  get queueItemHtml() { return queueItemHtml; },
  get refreshDiscordStatus() { return refreshDiscordStatus; },
  get remoteUi() { return remoteUi; },
  get renderQueue() { return libraryUi.renderQueue; },
  get runSearch() { return runSearch; },
  get saveHistory() { return saveHistory; },
  get saveRecording() { return karaokeUi.saveRecording; },
  get saveSettings() { return saveSettings; },
  get scheduleDiscord() { return scheduleDiscord; },
  get searchTimer() { return searchTimer; }, set searchTimer(v) { searchTimer = v; },
  get serviceName() { return serviceName; },
  get setAccent() { return setAccent; },
  get setKaraokeMode() { return karaokeUi.setKaraokeMode; },
  get setLyricsBar() { return desktop.setLyricsBar; },
  get setRepeatMode() { return setRepeatMode; },
  get setService() { return searchUi.setService; },
  get setShuffleMode() { return setShuffleMode; },
  get setVolumeLevel() { return setVolumeLevel; },
  get settings() { return settings; },
  get showChunk() { return showChunk; },
  get shownLine() { return shownLine; }, set shownLine(v) { shownLine = v; },
  get shownText() { return shownText; }, set shownText(v) { shownText = v; },
  get shrinkImage() { return shrinkImage; },
  get skeleton() { return skeleton; },
  get stats() { return wrapped.stats; },
  get stepVolume() { return desktop.stepVolume; },
  get store() { return store; },
  get syncVisualizer() { return syncVisualizer; },
  get toTrack() { return toTrack; },
  get toast() { return toast; },
  get toggleLyrics() { return settingsUi.toggleLyrics; },
  get trackFrom() { return libraryUi.trackFrom; },
  get vizOn() { return vizOn; },
  get vol() { return vol; },
};

// Painel da esquerda: Fila (estilo Spotify) · Recentes · Playlists → features/library.js
const libraryUi = initLibrary(app);

// ===================================================================
// Carrossel 3D
// ===================================================================
const carousel = $("#carousel");
const cardEls = new Map();
let carouselItems = [];


function renderCarousel() {
  const curKey = keyOf(media);
  const items = [];
  if (curKey) {
    const h = history.find((x) => x.key === curKey);
    items.push({ key: curKey, title: media.title, artist: media.artist, thumb: media.thumb || h?.thumb, current: true });
  }
  for (const h of history) {
    if (h.key !== curKey && items.length < 9) items.push({ ...h, current: false });
  }
  if (!items.length) {
    items.push({ key: "__empty", placeholder: true, title: "Nada tocando", artist: "Abra o Spotify, YouTube Music, SoundCloud…" });
  }
  items.forEach((it, i) => (it.slot = slotOf(i)));
  carouselItems = items;

  const slots = items.map((i) => i.slot);
  focusOffset = Math.max(Math.min(...slots), Math.min(Math.max(...slots), focusOffset));

  const seen = new Set();
  const cw = carousel.offsetWidth || 220;
  for (const it of items) {
    seen.add(it.key);
    let el = cardEls.get(it.key);
    if (!el) {
      el = document.createElement("div");
      el.className = "card";
      el.style.opacity = "0";
      carousel.appendChild(el);
      cardEls.set(it.key, el);
    }
    const art = it.placeholder
      ? `<div class="ph">♪</div>`
      : it.thumb
        ? `<img src="${esc(it.thumb)}" alt="" draggable="false">`
        : `<div class="ph">${esc(it.title)}</div>`;
    const html = `${art}<div class="cap"><b>${esc(it.title)}</b><span>${esc(it.artist || "")}</span></div>`;
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    el.dataset.key = it.key;

    const e = it.slot - focusOffset;
    const a = Math.abs(e), s = Math.sign(e);
    el.classList.toggle("focus", e === 0);
    if (a === 0) {
      el.style.transform = "translateX(0) translateZ(70px) rotateY(0deg) scale(1.06)";
      el.style.filter = "none";
    } else {
      const x = s * (cw * 0.66 + (a - 1) * cw * 0.44);
      el.style.transform = `translateX(${x}px) translateZ(${-a * 110}px) rotateY(${-s * 42}deg) scale(${1 - a * 0.05})`;
      el.style.filter = `brightness(${1 - a * 0.14})`;
    }
    el.style.zIndex = String(100 - a);
    el.style.opacity = a > 3 ? "0" : String(1 - a * 0.16);
    el.style.pointerEvents = a > 3 ? "none" : "auto";
  }
  for (const [k, el] of cardEls) {
    if (!seen.has(k)) {
      el.remove();
      cardEls.delete(k);
    }
  }
}

carousel.addEventListener("click", (e) => {
  const el = e.target.closest(".card");
  if (!el) return;
  const it = carouselItems.find((x) => x.key === el.dataset.key);
  if (!it || it.placeholder) return;
  if (it.slot !== focusOffset) {
    focusOffset = it.slot;
    renderCarousel();
  } else if (it.current) {
    control("toggle");
  } else {
    playItem(it);
  }
});

let wheelLock = 0;
$("#stage").addEventListener("wheel", (e) => {
  if ($("#stage").classList.contains("searching")) return;
  const now = performance.now();
  if (now - wheelLock < 140) return;
  wheelLock = now;
  focusOffset += (e.deltaY || e.deltaX) > 0 ? 1 : -1;
  renderCarousel();
}, { passive: true });

window.addEventListener("resize", () => renderCarousel());

// ===================================================================
// Mini player + progresso
// ===================================================================
function renderMini() {
  const curKey = keyOf(media);
  const h = curKey ? history.find((x) => x.key === curKey) : null;
  const generic = !curKey && media.available && media.generic;
  $("#miniTitle").textContent = curKey ? media.title : generic ? "Música no navegador" : "Nada tocando";
  const svc = curKey ? playingService() : "";
  const via = svc && svc !== "other" ? serviceName(svc) : "";
  $("#miniArtist").textContent = curKey
    ? media.loading
      ? `Carregando do ${via || "serviço"}…`
      : [media.artist || media.album, via].filter(Boolean).join(" · ")
    : generic
      ? "O site não informou o nome da música"
      : "Abra o SoundCloud, YouTube Music, Spotify…";
  const cover = curKey ? media.thumb || h?.thumb || "" : "";
  const mc = $("#miniCover");
  if (cover) mc.src = cover;
  else mc.removeAttribute("src");
  $("#tDur").textContent = fmt(media.durationMs);
  // cartão "tocando agora" do wallpaper
  document.body.classList.toggle("has-media", !!curKey);
  $("#ncTitle").textContent = curKey ? media.title : "";
  $("#ncArtist").textContent = curKey ? media.artist || media.album || "" : "";
  const nc = $("#ncCover");
  if (cover) nc.src = cover;
  else nc.removeAttribute("src");
  document.body.classList.toggle("playing", !!(media.available && media.playing));
  renderModes();
  publishNow();
}

// ---------- aleatório / repetir: player interno ou o app de origem (se ele deixar) ----------
function playModes() {
  if (player?.active && local) {
    const i = player.queue.info();
    return { local: true, repeat: i.repeat, shuffle: i.shuffle, canRepeat: true, canShuffle: true };
  }
  const has = !!keyOf(media);
  return {
    local: false,
    repeat: media.repeat || "off",
    shuffle: !!media.shuffle,
    canRepeat: has && media.repeat != null,
    canShuffle: has && media.shuffle != null,
  };
}
function renderModes() {
  const m = playModes();
  const app = serviceName(playingService()) || "app";
  const sb = $("#btnShuffle"), rb = $("#btnRepeat");
  sb.disabled = !m.canShuffle;
  sb.classList.toggle("on", m.canShuffle && m.shuffle);
  sb.title = m.canShuffle ? `Aleatório: ${m.shuffle ? "ligado" : "desligado"}` : `O ${app} não deixa mudar o aleatório daqui`;
  rb.disabled = !m.canRepeat;
  rb.classList.toggle("on", m.canRepeat && m.repeat !== "off");
  rb.classList.toggle("one", m.canRepeat && m.repeat === "one");
  rb.title = m.canRepeat ? `Repetir: ${m.repeat === "one" ? "esta música" : m.repeat === "all" ? (m.local ? "a fila" : "a playlist") : "desligado"}` : `O ${app} não deixa mudar o repetir daqui`;
}
function setShuffleMode(on) {
  const m = playModes();
  if (!m.canShuffle) return;
  if (m.local) player.queue.setShuffle(on);
  else {
    media = { ...media, shuffle: on }; // mostra na hora; o Windows confirma em seguida
    api.invoke("media_control", { action: on ? "shuffle:on" : "shuffle:off" }).catch((e) => toast(String(e)));
  }
  renderModes();
  libraryUi.renderQueue(true);
  toast(on ? "Aleatório ligado" : "Aleatório desligado");
}
function setRepeatMode(r) {
  const m = playModes();
  if (!m.canRepeat) return;
  if (m.local) player.queue.setRepeat(r);
  else {
    media = { ...media, repeat: r };
    api.invoke("media_control", { action: `repeat:${r}` }).catch((e) => toast(String(e)));
  }
  renderModes();
  libraryUi.renderQueue(true);
  toast(r === "all" ? (m.local ? "Repetir a fila" : "Repetir a playlist") : r === "one" ? "Repetir esta música" : "Repetir desligado");
}
const nextRepeat = (r) => (r === "off" ? "all" : r === "all" ? "one" : "off");
$("#btnShuffle").addEventListener("click", () => setShuffleMode(!playModes().shuffle));
$("#btnRepeat").addEventListener("click", () => setRepeatMode(nextRepeat(playModes().repeat)));

// ---------- mini player: manda o que está tocando pra janelinha ----------
let lastNowSig = "";
let lastNowCover = null;
function publishNow(full = false) {
  if (IS_WALLPAPER || !api.emit) return;
  const curKey = keyOf(media);
  const h = curKey ? history.find((x) => x.key === curKey) : null;
  const cover = curKey ? media.coverUrl || media.thumb || h?.thumb || null : null;
  const pos = Math.round(positionNow());
  const msg = {
    title: curKey ? media.title : "",
    artist: curKey ? media.artist || media.album || "" : "",
    playing: !!(media.available && media.playing),
    positionMs: pos,
    durationMs: media.durationMs || 0,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  };
  const sig = JSON.stringify([msg.title, msg.artist, msg.playing, msg.durationMs, Math.round(pos / 2000), msg.accent]);
  if (!full && sig === lastNowSig && cover === lastNowCover) return;
  lastNowSig = sig;
  if (full || cover !== lastNowCover) msg.cover = cover;
  lastNowCover = cover;
  api.emit("hp-now", msg).catch?.(() => {});
  remoteUi.pushRemote();
}

$("#progress").addEventListener("click", (e) => {
  if (!media.available || !media.durationMs) return;
  const r = e.currentTarget.getBoundingClientRect();
  const ms = Math.round(((e.clientX - r.left) / r.width) * media.durationMs);
  media = { ...media, positionMs: ms, updatedAtMs: Date.now() };
  control("seek", ms);
});

$("#btnPlay").addEventListener("click", () => {
  if (media.available) {
    media = { ...media, positionMs: positionNow(), updatedAtMs: Date.now(), playing: !media.playing };
    renderMini();
  }
  control("toggle");
});
$("#btnNext").addEventListener("click", () => control("next"));
$("#btnPrev").addEventListener("click", () => control("prev"));

// ===================================================================
// Letras sincronizadas (LRCLIB)
// ===================================================================
async function loadLyrics(s) {
  const key = keyOf(s);
  lyrics = null;
  remoteUi.pushRemoteLyrics();
  if (!key) return;
  for (const v of lyricVariants(s)) {
    if (!v.title) continue;
    const p = new URLSearchParams({ track_name: v.title, artist_name: v.artist });
    if (s.durationMs > 0) p.set("duration", String(Math.round(s.durationMs / 1000)));
    let res = await httpJson(`https://lrclib.net/api/get?${p}`);
    if (!res?.syncedLyrics) {
      const q = new URLSearchParams({ track_name: v.title, artist_name: v.artist });
      const list = await httpJson(`https://lrclib.net/api/search?${q}`);
      if (Array.isArray(list)) {
        const dur = s.durationMs / 1000;
        const synced = list.filter((x) => x.syncedLyrics);
        synced.sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur));
        res = synced[0] || null;
      }
    }
    if (keyOf(media) !== key) return; // trocou de música no meio
    if (res?.syncedLyrics) {
      lyrics = { key, lines: parseLrc(res.syncedLyrics) };
      remoteUi.pushRemoteLyrics();
      return;
    }
  }
  remoteUi.pushRemoteLyrics();
}

// ---------- modo "verso inteiro": a frase toda, acendendo palavra por palavra ----------
let shownLine = null;
let shownLit = -1;
function showLine(line, pos) {
  const el = $("#lyricChunk");
  if (line !== shownLine) {
    shownLine = line;
    shownLit = -1;
    shownText = "";
    clearTimeout(swapTimer);
    el.classList.remove("in");
    el.classList.add("out");
    swapTimer = setTimeout(() => {
      el.innerHTML = line ? line.chunks.map((c, i) => `<span data-i="${i}">${esc(c.text)}</span>`).join(" ") : "";
      el.classList.remove("out");
      void el.offsetWidth;
      if (line) el.classList.add("in");
      shownLit = -1;
    }, 200);
    return;
  }
  if (!line) return;
  let lit = -1;
  line.chunks.forEach((c, i) => {
    if (c.t <= pos) lit = i;
  });
  if (lit === shownLit) return;
  shownLit = lit;
  el.querySelectorAll("span[data-i]").forEach((sp) => sp.classList.toggle("lit", +sp.dataset.i <= lit));
}

function currentLine(pos) {
  if (!lyrics || lyrics.key !== keyOf(media)) return null;
  const L = lyrics.lines;
  let lo = 0, hi = L.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].t <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return null;
  const line = L[idx];
  if (pos > line.end + 300 || !line.chunks.length) return null;
  return line;
}

let shownText = "";
let swapTimer;
function showChunk(text) {
  if (text === shownText) return;
  shownLine = null;
  shownText = text;
  const el = $("#lyricChunk");
  clearTimeout(swapTimer);
  el.classList.remove("in");
  el.classList.add("out");
  swapTimer = setTimeout(() => {
    el.textContent = text;
    el.classList.remove("out");
    void el.offsetWidth;
    if (text) el.classList.add("in");
  }, 200);
}

function currentChunk(pos) {
  if (!lyrics || lyrics.key !== keyOf(media)) return "";
  const L = lyrics.lines;
  let lo = 0, hi = L.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].t <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return "";
  const line = L[idx];
  if (pos > line.end + 300 || !line.chunks.length) return "";
  let c = line.chunks[0];
  for (const ch of line.chunks) if (ch.t <= pos) c = ch;
  return c.text;
}

// ===================================================================
// Loop de animação: progresso + letra
// ===================================================================
let lastSec = -1;
// ---------- visualizador: suaviza o grave que vem do Rust ----------
let beat = 0;
let beatTarget = 0;
let beatShown = -1;
let beatTargets = null;
const beatEls = () => (beatTargets ||= ["#bg", "#clock", "#carousel"].map((s) => $(s)).filter(Boolean));
function updateBeat() {
  const on = vizOn() && media.available && media.playing;
  const target = on ? beatTarget : 0;
  beat += (target - beat) * (target > beat ? 0.55 : 0.12); // sobe rápido, desce devagar
  if (beat < 0.004) beat = 0;
  fx.setLevel(settings.particles ? beat : 0);
  if (Math.abs(beat - beatShown) > 0.004) {
    beatShown = beat;
    // só nos 3 lugares que pulsam: na raiz, cada pulso recalculava o estilo da tela inteira
    const v = beat.toFixed(3);
    for (const el of beatEls()) el.style.setProperty("--beat", v);
  }
}
// ---------- efeitos: partículas, ondas nas batidas e explosão no drop ----------
const drops = createDropDetector();
const fx = createFx($("#fxCanvas"), {
  getAccent: () => getComputedStyle(document.documentElement).getPropertyValue("--accent").split(",").map((x) => +x || 0),
});
function fxOrigin() {
  const el = IS_WALLPAPER ? $("#ncCover") : $("#carousel .card.focus img, #carousel .card.focus");
  const r = el?.getBoundingClientRect();
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2, el } : { x: innerWidth / 2, y: innerHeight / 2, el: null };
}
function onBeatLevel(v) {
  if (!vizOn() || !media.playing) return;
  const r = drops.feed(v, performance.now());
  if (!settings.particles) return;
  const o = fxOrigin();
  if (r.beat) fx.beat(o.x, o.y, Math.min(1, v));
  if (r.drop && settings.dropFx) dropNow(o);
}
function dropNow(o = fxOrigin()) {
  const img = o.el?.tagName === "IMG" ? o.el : o.el?.querySelector?.("img");
  fx.explode(o.x, o.y, img ? paletteOf(img) : null);
  const flash = $("#fxFlash");
  flash.classList.remove("go");
  void flash.offsetWidth;
  flash.classList.add("go");
  document.body.classList.add("fx-shake");
  setTimeout(() => document.body.classList.remove("fx-shake"), 560);
  const card = $("#carousel .card.focus");
  card?.classList.remove("drop-pop");
  void card?.offsetWidth;
  card?.classList.add("drop-pop");
}
function applyFx() {
  if (vizOn() && settings.particles) fx.start();
  else fx.stop();
}

api.listen("audio-level", (lv) => {
  // grave pesa mais; o volume geral ajuda em música sem grave
  beatTarget = Math.min(1, Math.max(0, (lv?.[0] || 0) * 0.85 + (lv?.[1] || 0) * 0.25) ** 1.6);
  onBeatLevel(beatTarget);
});
if (api.demo) {
  // modo demo: 120 bpm, com uma "subida" calma e um drop a cada 24 s
  setInterval(() => {
    const t = Date.now() % 24000;
    const kick = Date.now() % 500 < 120;
    beatTarget = !media.playing ? 0 : t > 15000 && t < 19500 ? 0.08 + Math.random() * 0.05 : kick ? (t >= 19500 ? 1 : 0.85) : 0.15 + Math.random() * 0.1;
    onBeatLevel(beatTarget);
  }, 33);
}

let lastFrame = 0;
function frame(t) {
  requestAnimationFrame(frame);
  if (t - lastFrame < 31) return; // ~30 fps chega pra barra, letra e pulso
  lastFrame = t;
  updateBeat();
  if (paused) return;
  if (!keyOf(media)) return; // nada tocando: nada pra mover
  const pos = positionNow();
  const pct = media.durationMs > 0 ? (pos / media.durationMs) * 100 : 0;
  // scaleX em vez de width: não recalcula o layout da tela
  const sx = `scaleX(${Math.min(1, Math.max(0, pct / 100)).toFixed(4)})`;
  $("#progressFill").style.transform = sx;
  $("#ncFill").style.transform = sx;
  const sec = Math.floor(pos / 1000);
  if (sec !== lastSec) {
    lastSec = sec;
    $("#tCur").textContent = fmt(pos);
  }
  if (settings.lyrics) {
    const p = pos + settings.lyricsOffset * 1000;
    if (settings.lyricsMode === "chunks") showChunk(currentChunk(p));
    else showLine(currentLine(p), p);
  }
  desktop.feedLyricsBar(pos + settings.lyricsOffset * 1000);
}

// ===================================================================
// Busca (Deezer API pública → abre no serviço escolhido)
// ===================================================================
let searchSeq = 0;
let searchTimer;

function skeleton(n, cls = "") {
  return Array.from({ length: n }, () => `<div class="res-tile ${cls}"><div class="sk"></div></div>`).join("");
}

function closeSearch() {
  searchSeq++;
  if (searchUi.resTab !== "all") searchUi.setResTab("all");
  $("#stage").classList.remove("searching");
  $("#results").hidden = true;
}

// Busca nativa: SoundCloud e YouTube Music buscam no próprio serviço (pelo Rust).
// Os outros, ou se a busca nativa falhar, usam o catálogo do Deezer.
const NATIVE_SEARCH = { soundcloud: "soundcloud", ytmusic: "ytmusic", youtube: "ytmusic" };

async function deezerSearch(q) {
  const [tr, ar] = await Promise.all([
    httpJson(`https://api.deezer.com/search?q=${enc(q)}&limit=16`),
    httpJson(`https://api.deezer.com/search/artist?q=${enc(q)}&limit=10`),
  ]);
  return {
    source: "deezer",
    tracks: (tr?.data || []).map((t) => ({ title: t.title_short || t.title, artist: t.artist?.name || "", cover: t.album?.cover_medium || "", url: t.link })),
    artists: (ar?.data || []).map((a) => ({ name: a.name, picture: a.picture_medium || "", url: a.link })),
  };
}

/** Fileira "Álbuns" no "Tudo" (só onde dá pra tocar o álbum aqui dentro). */
async function loadAlbumsRow(q, svc, seq) {
  const head = $("#resAlbumsHead"), row = $("#resAlbums");
  const show = (on) => { head.hidden = row.hidden = !on; };
  if (!NATIVE_SEARCH[svc] || !player) return show(false);
  show(true);
  row.innerHTML = skeleton(6);
  try {
    const page = await Promise.race([
      api.invoke("search_page", { service: NATIVE_SEARCH[svc], query: q, kind: "albums", cursor: null }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("tempo")), 12000)),
    ]);
    if (seq !== searchSeq) return;
    const albums = (page?.albums || []).slice(0, 10);
    if (!albums.length) return show(false);
    row.innerHTML = albums.map((al, i) => searchUi.albumTile(al, `data-ral="${i}"`)).join("");
    row.onclick = (e) => {
      const el = e.target.closest("[data-ral]");
      if (el) searchUi.albumClick(e, albums[+el.dataset.ral], page.source, el);
    };
  } catch {
    if (seq === searchSeq) show(false);
  }
}

async function runSearch(q) {
  q = q.trim();
  if (!q) return closeSearch();
  const seq = ++searchSeq;
  const svc = settings.service;
  $("#stage").classList.add("searching");
  $("#results").hidden = false;
  if (searchUi.resTab !== "all") searchUi.loadFull(true);
  $("#resNote").textContent = "";
  $("#resTracks").innerHTML = skeleton(7);
  $("#resArtists").innerHTML = skeleton(7, "round");
  loadAlbumsRow(q, svc, seq);

  let res = null;
  let note = "";
  if (NATIVE_SEARCH[svc]) {
    // Deezer já vai buscando junto: se o serviço falhar ou demorar, não espera de novo
    const deezer = deezerSearch(q);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("demorou demais (12 s)")), 12000));
    try {
      res = await Promise.race([api.invoke("search_music", { service: NATIVE_SEARCH[svc], query: q }), timeout]);
    } catch (e) {
      note = `${SERVICES[svc].name} não respondeu (${String(e?.message || e)}). Mostrando resultados do Deezer.`;
      console.warn("busca nativa falhou:", e);
      if (seq !== searchSeq) return;
      res = await deezer;
    }
  }
  if (seq !== searchSeq) return;
  if (!res) res = await deezerSearch(q);
  if (seq !== searchSeq) return;

  const tracks = res.tracks || [];
  const artists = res.artists || [];
  // Link direto quando o resultado veio do mesmo serviço escolhido
  const direct = res.source === "deezer" ? svc === "deezer" : true;
  const fixUrl = (u) => (svc === "youtube" && u ? u.replace("://music.youtube.com/", "://www.youtube.com/") : u);

  const svcName = esc(SERVICES[svc].name);
  const fromName = res.source === "deezer" ? "Deezer" : SERVICES[res.source]?.name || "";
  $("#resTitle").innerHTML = `Principais resultados${fromName ? ` <small>· ${esc(fromName)}</small>` : ""}`;
  $("#resNote").textContent = note;

  $("#resTracks").innerHTML = tracks.length
    ? tracks
        .map(
          (t, i) =>
            `<div class="res-tile" data-t="${i}" title="Tocar">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy" draggable="false">` : `<div class="sk"></div>`}<button class="tile-more" data-more="${i}" title="Fila e playlists">${libraryUi.ICON.more}</button><b>${esc(t.title)}</b><span>${esc(t.artist)}${t.durationMs ? ` · ${fmt(t.durationMs)}` : ""}</span></div>`,
        )
        .join("")
    : `<div class="res-empty">Nada encontrado. Enter abre a busca direto no ${svcName}.</div>`;
  $("#resArtists").innerHTML = artists.length
    ? artists
        .map(
          (a, i) =>
            `<div class="res-tile" data-a="${i}" title="Tocar">${a.picture ? `<img src="${esc(a.picture)}" alt="" loading="lazy" draggable="false">` : `<div class="sk"></div>`}<b>${esc(a.name)}</b></div>`,
        )
        .join("")
    : `<div class="res-empty">—</div>`;

  const open = (query, url, i) => {
    // SoundCloud / YouTube: toca aqui dentro, com os resultados como fila
    if (player && PLAYABLE[svc]) {
      if (res.source !== "deezer" && i !== undefined) return player.playQueue(tracks.map((t) => toTrack(t, svc)), i);
      return playQuery(query);
    }
    if (direct && url) {
      api.invoke("open_url", { url: fixUrl(url) }).then(() => toast(`Abrindo no ${SERVICES[svc].name}…`)).catch((e) => toast(String(e)));
    } else {
      openInService(query);
    }
  };
  const resultTrack = (i) => {
    const t = tracks[i];
    const svcOk = PLAYABLE[svc] ? svc : "ytmusic";
    // resultado do Deezer não tem link de SoundCloud/YouTube: acha na hora de tocar
    return res.source === "deezer" ? { ...libraryUi.trackFrom(t, svcOk), url: null } : toTrack(t, svcOk);
  };
  $("#resTracks").oncontextmenu = (e) => {
    const el = e.target.closest("[data-t]");
    if (!el) return;
    e.preventDefault();
    libraryUi.openTrackMenu(e.clientX, e.clientY, resultTrack(+el.dataset.t));
  };
  $("#resTracks").onclick = (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      return libraryUi.openTrackMenu(r.right - 4, r.bottom + 4, resultTrack(+more.dataset.more));
    }
    const el = e.target.closest("[data-t]");
    if (!el) return;
    const t = tracks[+el.dataset.t];
    open(`${t.title} ${t.artist}`, t.url, +el.dataset.t);
  };
  $("#resArtists").onclick = (e) => {
    const el = e.target.closest("[data-a]");
    if (!el) return;
    const a = artists[+el.dataset.a];
    if (player && PLAYABLE[svc]) {
      searchUi.input.value = a.name; // busca as músicas do artista
      return runSearch(a.name);
    }
    open(a.name, a.url);
  };
}

// Busca completa: abas Tudo · Músicas · Artistas, com "carregar mais" → features/search.js
const searchUi = initSearch(app);

// Configurações → features/settings.js
const settingsUi = initSettings(app);

// ===================================================================
// Volume: player interno → volume dele; música de fora (Spotify, navegador…)
// → só o volume daquele app no mixer do Windows (não mexe no PC inteiro)
// ===================================================================
const vol = { level: settings.volume, target: "Harle Player", source: null, sending: false, pending: null };
const isLocalVol = () => !!(player?.active && local);

function paintVolume() {
  const pct = Math.round(vol.level * 100);
  $("#volRange").value = pct;
  $("#volRange").style.setProperty("--p", `${pct}%`);
  $("#volVal").textContent = pct;
  $("#volTarget").textContent = vol.target;
  const b = $("#btnVolume");
  b.classList.toggle("muted", pct === 0);
  b.classList.toggle("low", pct > 0 && pct < 45);
}

async function loadVolume() {
  if (isLocalVol()) {
    Object.assign(vol, { level: settings.volume, target: "Harle Player", source: null });
    return paintVolume();
  }
  const source = media.available ? media.source || "" : "";
  try {
    const info = await api.invoke("get_volume", { source });
    if (!info) throw 0;
    Object.assign(vol, { level: info.level, target: info.target === "Sistema" ? "Volume do PC" : info.target, source });
  } catch {
    Object.assign(vol, { level: settings.volume, target: "Volume", source });
  }
  paintVolume();
}

// manda pro Windows sem enfileirar (só o valor mais recente)
async function sendVolume(level) {
  vol.pending = level;
  if (vol.sending) return;
  vol.sending = true;
  while (vol.pending !== null) {
    const l = vol.pending;
    vol.pending = null;
    try { await api.invoke("set_volume", { source: vol.source || "", level: l }); } catch {}
  }
  vol.sending = false;
}

function setVolumeLevel(level) {
  vol.level = Math.min(1, Math.max(0, level));
  paintVolume();
  if (isLocalVol() || vol.source === null) {
    settings.volume = vol.level;
    player?.setVolume(vol.level);
    clearTimeout(setVolumeLevel.t);
    setVolumeLevel.t = setTimeout(saveSettings, 400);
  } else {
    sendVolume(vol.level);
  }
}

function openVolume() {
  const pop = $("#volumePop");
  if (!pop.hidden) return;
  pop.hidden = false;
  const r = $("#btnVolume").getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  pop.style.top = `${r.top - pop.offsetHeight - 12}px`;
  loadVolume();
}
const closeVolume = () => ($("#volumePop").hidden = true);

$("#btnVolume").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#volumePop").hidden ? openVolume() : closeVolume();
});
$("#volRange").addEventListener("input", (e) => setVolumeLevel(e.target.value / 100));
for (const el of [$("#btnVolume"), $("#volumePop")]) {
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    openVolume();
    setVolumeLevel(vol.level + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: false });
}
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#volumePop, #btnVolume")) closeVolume();
});
paintVolume();
$("#sw24").addEventListener("click", () => {
  settings.clock24 = !settings.clock24;
  saveSettings();
  settingsUi.renderSettings();
  tickClock();
});
const stepOffset = (d) => {
  settings.lyricsOffset = Math.round((settings.lyricsOffset + d) * 10) / 10;
  saveSettings();
  settingsUi.renderSettings();
};
$("#offMinus").addEventListener("click", () => stepOffset(-0.1));
$("#offPlus").addEventListener("click", () => stepOffset(0.1));
$("#swWallpaper").addEventListener("click", () => setWallpaperMode(!settings.wallpaperMode));
$("#lnkGithub").addEventListener("click", (e) => {
  e.preventDefault();
  api.invoke("open_url", { url: "https://github.com/Harlezinhuu" }).catch(() => {});
});

function setWallpaperMode(on, fromTray = false) {
  settings.wallpaperMode = on;
  saveSettings();
  settingsUi.renderSettings();
  syncVisualizer();
  if (fromTray) return;
  api
    .invoke("set_wallpaper_mode", { enabled: on })
    .then(() => on && toast("Wallpaper ligado — minimize as janelas pra ver 👀", 3200))
    .catch((err) => {
      settings.wallpaperMode = false;
      saveSettings();
      settingsUi.renderSettings();
      toast(String(err), 4500);
    });
}

// ===================================================================
// Visualizador (escuta o som do PC) só quando alguém está vendo: janela
// principal aberta, mini player aberto ou wallpaper animado. Minimizado ou
// na bandeja (jogando, por exemplo), ele para e não gasta nada.
// ===================================================================
let mainVisible = !document.hidden;
let vizOnNow = null;
function syncVisualizer() {
  if (IS_WALLPAPER) return;
  const miniOpen = $("#btnMini")?.classList.contains("on");
  const wallpaper = settings.wallpaperMode && settings.wallpaperVisualizer !== false;
  const need = !!(settings.visualizer && (mainVisible || miniOpen || wallpaper));
  if (need === vizOnNow) return;
  vizOnNow = need;
  api.invoke("set_visualizer", { on: need }).catch(() => {});
}
if (!IS_WALLPAPER) {
  document.addEventListener("visibilitychange", () => {
    mainVisible = !document.hidden;
    syncVisualizer();
  });
  api.listen("main-minimized", () => {
    mainVisible = false;
    syncVisualizer();
  });
  api.listen("main-restored", () => {
    mainVisible = true;
    syncVisualizer();
  });
}

// ===================================================================
// Janela
// ===================================================================
// ===================================================================
// Tela cheia: depois de 3 s sem mexer o mouse, sobra só relógio, capa e letra
// ===================================================================
let isFull = false;
let idleTimer = null;
async function setFullscreen(on) {
  isFull = !!on;
  try {
    if (T?.window) await T.window.getCurrentWindow().setFullscreen(isFull);
    else if (isFull) await document.documentElement.requestFullscreen?.();
    else if (document.fullscreenElement) await document.exitFullscreen?.();
  } catch (e) {
    console.warn("tela cheia:", e);
  }
  document.body.classList.toggle("fullscreen", isFull);
  wakeUi();
}
function wakeUi() {
  document.body.classList.remove("ui-idle");
  clearTimeout(idleTimer);
  if (!isFull) return;
  idleTimer = setTimeout(() => {
    // não esconde enquanto tem algo aberto ou o mouse está em cima de um controle
    const busy = !$("#settings").hidden || !$("#results").hidden || !$("#ctxMenu").hidden || !$("#volumePop").hidden ||
      document.activeElement === searchUi.input || document.querySelector("#dock:hover, #queue:hover, #titlebar:hover");
    if (busy) return wakeUi();
    document.body.classList.add("ui-idle");
  }, 3000);
}
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) document.addEventListener(ev, wakeUi, { passive: true });
document.addEventListener("fullscreenchange", () => {
  if (!T && !document.fullscreenElement && isFull) {
    isFull = false;
    document.body.classList.remove("fullscreen", "ui-idle");
  }
});
$("#btnFull").addEventListener("click", () => setFullscreen(!isFull));
$("#titlebar").addEventListener("dblclick", (e) => {
  if (!e.target.closest(".win-controls")) setFullscreen(!isFull);
});

$("#btnMin").addEventListener("click", () => {
  if (T?.window) T.window.getCurrentWindow().minimize();
});
$("#btnClose").addEventListener("click", () => {
  if (!store.get("hp.closedOnce", false)) {
    store.set("hp.closedOnce", true);
    toast("Ele continua tocando na bandeja (perto do relógio do Windows)", 1800);
    setTimeout(() => api.invoke("hide_to_tray").catch(() => {}), 1600);
  } else {
    api.invoke("hide_to_tray").catch(() => {});
  }
});

// ===================================================================
// Atalhos de teclado
// ===================================================================
document.addEventListener("keydown", (e) => {
  const typing = e.target === searchUi.input;
  // digitando em outro campo (link, nome da playlist, código da sala…): atalhos ficam quietos
  const inField = !typing && (e.target.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !/^(range|checkbox|radio|button)$/.test(e.target.type)));
  if (inField) return;
  if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    searchUi.input.focus();
    searchUi.input.select();
    return;
  }
  if (typing) return;
  if (e.key === " ") {
    e.preventDefault();
    $("#btnPlay").click();
  } else if (e.key === "ArrowRight") {
    focusOffset++;
    renderCarousel();
  } else if (e.key === "ArrowLeft") {
    focusOffset--;
    renderCarousel();
  } else if (e.key === "F11") {
    e.preventDefault();
    setFullscreen(!isFull);
  } else if (e.key === "Escape") {
    const somethingOpen = !$("#wrapped").hidden || !$("#settings").hidden || !$("#results").hidden || !$("#serviceMenu").hidden || !$("#ctxMenu").hidden || !$("#volumePop").hidden;
    if (!somethingOpen && isFull) return setFullscreen(false);
    $("#ctxMenu").hidden = true;
    $("#volumePop").hidden = true;
    if (!$("#shareModal").hidden) return ($("#shareModal").hidden = true);
    $("#wrapped").hidden = true;
    $("#settings").hidden = true;
    $("#serviceMenu").hidden = true;
    $("#btnSettings").classList.remove("on");
    closeSearch();
  }
});

// ===================================================================
// Discord Rich Presence
// ===================================================================
function playingService() {
  const s = media.service || "";
  return s === "browser" || s === "" ? settings.browserService : s;
}

// O Discord só aceita capa por link https; a capa do Windows vem em base64.
// Então procura a mesma música no Deezer e usa a capa de lá.
const coverCache = new Map();
async function coverUrlFor(title, artist) {
  const k = `${title}|${artist}`;
  if (coverCache.has(k)) return coverCache.get(k);
  // (a busca avançada `artist:"…" track:"…"` do Deezer voltou 0 resultados no teste real,
  //  então usa a busca simples, que acha a capa certa)
  let r = await httpJson(`https://api.deezer.com/search?q=${enc(`${artist} ${title}`.trim())}&limit=1`);
  if (!r?.data?.length && artist) r = await httpJson(`https://api.deezer.com/search?q=${enc(title)}&limit=1`);
  const url = r?.data?.[0]?.album?.cover_big || null;
  coverCache.set(k, url);
  return url;
}

let discordTimer;
let discordSig = "";
function scheduleDiscord() {
  if (IS_WALLPAPER) return; // só o player fala com o Discord
  clearTimeout(discordTimer);
  discordTimer = setTimeout(updateDiscord, 1200);
}

/** Sala do "ouvir junto" aberta → festa no Discord (o botão "Pedir para participar"). */
function discordParty() {
  const room = partyUi?.party?.room;
  if (!room || settings.discordJoin === false) return null;
  return { id: room.topic, size: Math.max(1, partyUi.party.members.size), max: 20, secret: room.code };
}

async function updateDiscord() {
  const svc = playingService();
  const party = discordParty();
  // na sala, aparece até tocando no Spotify (é por aqui que os amigos pedem pra entrar)
  const show = settings.discord && keyOf(media) && media.playing && (party || !(svc === "spotify" && !settings.discordSpotify));
  if (!show) {
    if (discordSig !== "off") {
      discordSig = "off";
      api.invoke("discord_clear").catch(() => {});
    }
    return;
  }
  const start = Date.now() - positionNow();
  const sig = `${keyOf(media)}|${svc}|${Math.round(start / 3000)}|${party ? `${party.secret}:${party.size}` : ""}`;
  if (sig === discordSig) return;
  discordSig = sig;

  const title = cleanTitle(media.title) || media.title;
  const artist = cleanArtist(media.artist || "");
  const cover = media.coverUrl?.startsWith("https://") ? media.coverUrl : await coverUrlFor(title, artist);
  if (sig !== discordSig) return; // mudou enquanto buscava a capa

  api
    .invoke("discord_set", {
      presence: {
        service: svc,
        serviceName: svc === "other" ? "Harle Player" : serviceName(svc),
        title: media.title,
        artist: media.artist || "",
        album: media.album || "",
        cover,
        startMs: Math.round(start),
        endMs: media.durationMs > 0 ? Math.round(start + media.durationMs) : null,
        url: (media.link?.startsWith("https://") && media.link) || serviceWeb(svc, `${title} ${artist}`.trim()) || null,
        party,
      },
    })
    .catch(() => {});
}

const discordChanged = () => {
  saveSettings();
  settingsUi.renderSettings();
  discordSig = "";
  scheduleDiscord();
  if (!IS_WALLPAPER) api.invoke("discord_listen", { on: !!(settings.discord && settings.discordJoin !== false) }).catch(() => {});
  setTimeout(refreshDiscordStatus, 2500);
};
$("#swDiscord").addEventListener("click", () => {
  settings.discord = !settings.discord;
  discordChanged();
});
$("#swDiscordSpotify").addEventListener("click", () => {
  settings.discordSpotify = !settings.discordSpotify;
  discordChanged();
});
$("#swDiscordJoin").addEventListener("click", () => {
  settings.discordJoin = settings.discordJoin === false;
  discordChanged();
});
$("#segBrowser").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  settings.browserService = b.dataset.v;
  discordChanged();
});

let discordStatusTimer;
async function refreshDiscordStatus() {
  const el = $("#discordStatus");
  try {
    const st = await api.invoke("discord_status");
    if (!st) el.textContent = "Modo demo";
    else if (!settings.discord) el.textContent = "Desligado";
    else el.textContent = `${st.connected ? "🟢" : "⚪"} ${st.message}`;
  } catch {
    el.textContent = "";
  }
}

// ===================================================================
// Mídia
// ===================================================================
function render() {
  if (searchUi.resTab === "tracks" && searchUi.full.items.length && local?.link !== searchUi.full.nowLink) {
    searchUi.full.nowLink = local?.link;
    searchUi.renderFull();
  }
  renderMini();
  libraryUi.renderQueue();
  renderCarousel();
}

function onMedia(s, fromLocal = false) {
  if (!s) return;
  // O Windows também enxerga o próprio player (no YouTube, com o nome do vídeo):
  // isso não é "outro app tocando", então nunca tira o controle do player interno.
  if (!fromLocal && isOwnSession(s)) {
    if (player?.active) return;
    s = { available: false, title: "", artist: "", album: "", playing: false, positionMs: 0, durationMs: 0, updatedAtMs: Date.now() };
  }
  if (!fromLocal && local) {
    // Enquanto o player interno tem música, ignora o Windows (que também enxerga
    // o próprio player) — a não ser que outro app comece a tocar outra coisa.
    const sameTrack = s.title && s.title === local.title;
    if (!s.playing || sameTrack || local.playing || local.loading) return;
    local = null;
  }
  // Site que não informa a música (o navegador manda "Um site está com mídia aberta"):
  // continua dando pra controlar, mas sem nome, letra, histórico ou Discord.
  if (s && isPlaceholderTitle(s.title)) s = { ...s, title: "", artist: "", album: "", generic: true };
  // Jogo, gravação de tela ou vídeo (Riot Client, "Valorant 2026.03.21 - …"): também não é
  // música — dá pra controlar, mas não entra em Recentes, retrospectiva, letra nem Discord.
  else if (s && !s.local && isNonMusic(s)) s = { ...s, title: "", artist: "", album: "", generic: true, notMusic: true };
  const prevKey = keyOf(media);
  media = s;
  const k = keyOf(s);
  if (k && k !== prevKey) {
    focusOffset = 0;
    updateArt(s.thumb);
    upsertHistory(s);
    loadLyrics(s);
    desktop.scheduleNotify(k);
    clipBg.trackChanged(k);
    desktop.djOnTrack(k);
    if (karaokeUi.kOn) setTimeout(karaokeUi.renderKaraoke, 300);
  } else if (k && s.thumb && s.thumb !== lastThumb) {
    updateArt(s.thumb);
    upsertHistory(s);
  } else if (!k && prevKey) {
    lyrics = null;
    showChunk("");
    updateArt(null);
  }
  render();
  scheduleDiscord();
}

// Retrospectiva ("seu Wrapped"): conta o que você ouve, de qualquer app → features/wrapped.js
const wrapped = initWrapped(app);

// Aviso de música nova (cartão no canto da tela) e atalhos globais → features/desktop.js
const desktop = initDesktop(app);

// Karaokê: tira a voz, sua voz nos fones (com efeitos) e gravação → features/karaoke.js
const karaokeUi = initKaraoke(app);

// Freestyle: beat + palavra pra rimar no fim de cada frase (Treino / Desafio) → features/freestyle.js
initFreestyle(app);

// Ouvir junto: salas com código, sincronizadas pelo ntfy.sh (criptografado) → features/party.js
const partyUi = initParty(app);

// Controle pelo celular: o PC vira um servidorzinho na rede Wi-Fi → features/remote.js
const remoteUi = initRemote(app);

// ===================================================================
// Atualizações (GitHub Releases)
// ===================================================================
let pendingUpdate = null;
let checkingUpdate = false;
async function checkUpdate(manual = false) {
  if (checkingUpdate) return;
  checkingUpdate = true;
  try {
    const info = await api.invoke("check_update");
    if (!info) return manual && toast("Modo demo: sem atualizações");
    $("#appVersion").textContent = `v${info.current}`;
    if (info.available) {
      pendingUpdate = info;
      $("#updateText").textContent = `Versão ${info.latest} disponível`;
      $("#updateBar").hidden = false;
    } else if (manual) {
      toast(`Você já está na versão mais nova (v${info.current})`);
    }
  } catch (e) {
    if (manual) toast(`Não consegui procurar atualização: ${e}`);
  } finally {
    checkingUpdate = false;
  }
}
$("#btnUpdate").addEventListener("click", async () => {
  if (!pendingUpdate?.url) return;
  $("#btnUpdate").disabled = true;
  $("#updateText").textContent = `Baixando a versão ${pendingUpdate.latest}…`;
  try {
    await api.invoke("install_update", { url: pendingUpdate.url });
    // o app fecha sozinho, instala e abre de novo
  } catch (e) {
    $("#btnUpdate").disabled = false;
    $("#updateText").textContent = `Versão ${pendingUpdate.latest} disponível`;
    toast(`Falhou ao atualizar: ${e}`, 4500);
  }
});
$("#btnUpdateClose").addEventListener("click", () => ($("#updateBar").hidden = true));
$("#btnCheckUpdate").addEventListener("click", (e) => {
  e.preventDefault();
  checkUpdate(true);
});

// ===================================================================
// Início
// ===================================================================
searchUi.renderService();
if (!IS_WALLPAPER) await migrateOldBackground();
await loadLibrary();
settingsUi.renderSettings();
applyFx();
settingsUi.applyTheme();
settingsUi.applyEq();
applyBackground();
render();

api.listen("media-update", onMedia);
if (!IS_WALLPAPER) {
  api.listen("hp-control", (m) => m?.action && remoteUi.remoteCommand(m));
  api.listen("hp-mini-ready", () => publishNow(true));
  api.listen("mini-mode", (on) => {
    $("#btnMini")?.classList.toggle("on", !!on);
    if (!on) settingsUi.miniAuto = false; // fechou pelo × do próprio mini
    syncVisualizer();
  });
}
if (IS_WALLPAPER) {
  // Janela do wallpaper: recarrega quando o player muda alguma configuração.
  window.addEventListener("storage", (e) => {
    if (e.key === "hp.settings") location.reload();
  });
} else {
  api.listen("wallpaper-mode", (on) => setWallpaperMode(!!on, true));
}
api.invoke("get_media").then(onMedia).catch(() => {});
if (!IS_WALLPAPER && settings.discord && settings.discordJoin !== false) api.invoke("discord_listen", { on: true }).catch(() => {});
if (!IS_WALLPAPER && settings.wallpaperMode) {
  api.invoke("set_wallpaper_mode", { enabled: true }).catch(() => {
    settings.wallpaperMode = false;
    saveSettings();
    settingsUi.renderSettings();
  });
}

syncVisualizer();
if (!IS_WALLPAPER && settings.remote) remoteUi.setRemote(true, true);
if (!IS_WALLPAPER && settings.hotkeys) desktop.setHotkeys(true, true);
if (!IS_WALLPAPER) $("#swNotify").classList.toggle("on", settings.notify);
if (!IS_WALLPAPER) $("#swAutoMini").classList.toggle("on", settings.autoMini);
if (!IS_WALLPAPER) {
  desktop.renderExtras();
  if (settings.ducking) api.invoke("set_ducking", { on: true }).catch(() => {});
  if (settings.lyricsbar) desktop.setLyricsBar(true);
}

if (!IS_WALLPAPER) {
  setTimeout(() => checkUpdate(false), 4000);
  setInterval(() => checkUpdate(false), 6 * 3600e3);
}

requestAnimationFrame(frame);
