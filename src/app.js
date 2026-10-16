// Harle Player — front-end (HTML/CSS/JS puro, sem build).
// Dentro do app, fala com o Rust via window.__TAURI__.
// Aberto direto no navegador, roda em "modo demo" com dados de exemplo.

import { createPlayer, EQ_FREQS } from "./player.js";
import * as Stats from "./stats.js";
import { drawQr } from "./qr.js";
import { createKaraoke } from "./karaoke.js";
import { fmt, esc, rgbToHsl, hslToRgb, slotOf, cleanTitle, cleanArtist, lyricVariants, parseLrc, isPlaceholderTitle } from "./lib.js";

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
  ducking: true, // abaixa a música quando alguém fala no Discord
  duckLevel: 0.3, // pra quanto abaixa (fração do volume)
  lyricsbar: false, // letra flutuante na parte de baixo da tela
  dj: false, // DJ com voz entre as músicas
  djEvery: "some", // "all" | "some"
  djVoice: "",
  clock24: true,
  clockStyle: "solid", // solid | thin | outline
  wallpaperMode: false, // wallpaper animado atrás dos ícones
  wallpaperId: "builtin:aurora",
  discord: true, // Rich Presence
  discordSpotify: false, // o Spotify já mostra sozinho no Discord
  browserService: "soundcloud", // quando não dá pra saber qual site do navegador está tocando
};
const settings = { ...DEFAULTS, ...store.get("hp.settings", {}) };
delete settings.widget; // opção antiga
const saveSettings = () => store.set("hp.settings", settings);

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
let history = store.get("hp.history", []);
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

function control(action, positionMs) {
  // Música tocando no player interno → controla ele; senão, o app de música do Windows.
  if (player?.active && local) {
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
      resolve: (t) => resolveTrack(t),
      onQueue: () => renderQueue(),
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

// ---------- aplica o fundo ----------
let bgObjectUrl = null;
async function applyBackground() {
  const img = $("#bgImage"), vid = $("#bgVideo");
  img.hidden = vid.hidden = true;
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
  }

  document.body.classList.remove("bg-dynamic", "bg-custom", "bg-transparent");
  document.body.classList.add(`bg-${mode}`);
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
  } else {
    img.src = bgObjectUrl;
    img.hidden = false;
  }
}

// Pausa tudo (vídeo, aurora, animações).
function setPaused(on) {
  if (paused === on) return;
  paused = on;
  document.body.classList.toggle("paused", on);
  const vid = $("#bgVideo");
  if (!vid.hidden) on ? vid.pause() : vid.play().catch(() => {});
}

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
// Painel da esquerda: Fila (estilo Spotify) · Recentes · Playlists
// ===================================================================
let playlists = store.get("hp.playlists", []);
const savePlaylists = () => store.set("hp.playlists", playlists);
let openPlaylistId = null;
let creatingPlaylist = false;
let importingPlaylist = false; // mostrando a caixa de link
let importBusy = false;
const SRC = {
  spotify: { name: "Spotify", color: "#1ed760" },
  soundcloud: { name: "SoundCloud", color: "#ff7a1a" },
  youtube: { name: "YouTube", color: "#ff3b3b" },
};
const isSpotifyPl = (p) => p?.source === "spotify";
let queueSig = "";
let dragging = false;

const ICON = {
  shuffle: `<svg viewBox="0 0 24 24"><path d="M3 7h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6c1 1.7 2.3 2.7 4.3 2.7H21M3 17h3.5c1.4 0 2.4-.5 3.2-1.4M14.3 8.4c.8-.9 1.8-1.4 3.2-1.4H21M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/></svg>`,
  repeat: `<svg viewBox="0 0 24 24"><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19M16 3l3 3-3 3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5M8 21l-3-3 3-3"/></svg>`,
  plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  back: `<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>`,
  play: `<svg viewBox="0 0 24 24" class="fill"><path d="M7 4.5v15l13-7.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>`,
  x: `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4.5V8h3.5M4 13a8 8 0 0 0 14.6 4.5M20 19.5V16h-3.5"/></svg>`,
  link: `<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
  more: `<svg viewBox="0 0 24 24" class="fill"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
};
const rmBtn = (attr) => `<button class="q-rm" ${attr} title="Tirar">${ICON.x}</button>`;

/** Qualquer música da tela vira um item que dá pra tocar/guardar. */
function trackFrom(t, svc = settings.service) {
  const service = PLAYABLE[t.service || svc] ? t.service || svc : "ytmusic";
  return {
    title: t.title || "",
    artist: t.artist || "",
    cover: t.cover || t.coverUrl || (typeof t.thumb === "string" && t.thumb.startsWith("http") ? t.thumb : null) || t.thumb || null,
    url: t.url || t.link || null,
    service,
    durationMs: t.durationMs || 0,
  };
}

/** Acha o link de uma música salva só com nome (usado pela fila e pelas playlists). */
async function resolveTrack(t) {
  const res = await api.invoke("search_music", {
    service: t.service === "soundcloud" ? "soundcloud" : "ytmusic",
    query: `${t.title} ${t.artist}`.trim(),
  });
  const f = res?.tracks?.[0];
  if (!f) return null;
  const tt = toTrack(f, t.service);
  return { url: tt.url, cover: t.cover || tt.cover, durationMs: tt.durationMs || t.durationMs };
}

function setTab(tab) {
  settings.queueTab = tab;
  saveSettings();
  openPlaylistId = null;
  creatingPlaylist = false;
  importingPlaylist = false;
  renderQueue(true);
}
$("#qTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) setTab(b.dataset.tab);
});

function renderQueue(force = false) {
  if (IS_WALLPAPER) return;
  const tab = settings.queueTab || "fila";
  const curKey = keyOf(media);
  const info = player?.active && local ? player.queue.info() : null;
  const pl = openPlaylistId ? playlists.find((p) => p.id === openPlaylistId) : null;
  const sig = JSON.stringify([tab, curKey, media.playing, info && [info.index, info.repeat, info.shuffle, info.tracks.map((t) => t.qid + (t.user ? "u" : "") + (t.url ? "" : "?"))],
    tab === "recentes" && history.map((h) => h.key + !!h.thumb), tab === "playlists" && (pl ? [pl.id, pl.name, pl.tracks.length, pl.tracks.map((t) => t.title)] : playlists.map((p) => [p.id, p.name, p.tracks.length])), creatingPlaylist, importingPlaylist, importBusy]);
  // (sem "force", não redesenha enquanto a pessoa digita no nome da playlist)
  if (dragging || (!force && (sig === queueSig || document.activeElement?.closest?.("#queue input")))) return;
  queueSig = sig;

  for (const b of $$("#qTabs button")) b.classList.toggle("sel", b.dataset.tab === tab);

  // tocando agora (na Fila e em Recentes)
  const nowEl = $("#nowItem");
  if (curKey && tab !== "playlists") {
    const h = history.find((x) => x.key === curKey);
    nowEl.innerHTML = queueItemHtml({ title: media.title, artist: media.artist, thumb: media.thumb || h?.thumb }, true);
  } else nowEl.innerHTML = "";

  const tools = $("#qTools");
  const list = $("#historyList");
  list.dataset.kind = "";
  let html = "";

  if (tab === "fila") {
    if (info) {
      const rep = info.repeat;
      tools.innerHTML = `
        <button class="q-tool ${info.shuffle ? "on" : ""}" data-act="shuffle" title="Aleatório: ${info.shuffle ? "ligado" : "desligado"}">${ICON.shuffle}</button>
        <button class="q-tool ${rep !== "off" ? "on" : ""}" data-act="repeat" title="Repetir: ${rep === "one" ? "esta música" : rep === "all" ? "a fila" : "desligado"}">${ICON.repeat}${rep === "one" ? "<i>1</i>" : ""}</button>
        <span class="q-spacer"></span>
        <button class="q-tool txt" data-act="clear" title="Tirar todas as próximas">Limpar</button>`;
      const up = info.tracks.map((t, i) => ({ t, i })).slice(info.index + 1);
      const user = up.filter((x) => x.t.user);
      const rest = up.filter((x) => !x.t.user);
      const row = ({ t, i }) => `<li data-qi="${i}" class="sortable" title="Tocar">${queueItemHtml(t, false, rmBtn(`data-rm="${i}"`))}</li>`;
      if (user.length) html += `<li class="q-label">Próximas na fila</li>${user.map(row).join("")}`;
      if (rest.length) html += `<li class="q-label">A seguir</li>${rest.map(row).join("")}`;
      if (!up.length) html = `<li class="q-empty">Nada depois desta.<br>Na busca, use <b>⋯</b> → <b>Adicionar à fila</b>.</li>`;
      list.dataset.kind = "fila";
    } else {
      tools.innerHTML = "";
      html = media.available && media.title
        ? `<li class="q-empty">Tocando no <b>${esc(SERVICES[media.service]?.name || media.source || "outro app")}</b> — a fila dele fica no próprio app.<br><br>A fila daqui é do que toca no Harle Player (SoundCloud e YouTube).</li>`
        : `<li class="q-empty">A fila está vazia.<br>Busque uma música e use <b>⋯</b> → <b>Adicionar à fila</b>.</li>`;
    }
  } else if (tab === "recentes") {
    tools.innerHTML = "";
    const items = history.filter((h) => h.key !== curKey).slice(0, 20);
    html = items.length
      ? items.map((h) => `<li data-hk="${esc(h.key)}" title="Tocar">${queueItemHtml(h, false)}</li>`).join("")
      : `<li class="q-empty">O que você ouvir aparece aqui.</li>`;
  } else if (pl && isSpotifyPl(pl)) {
    // Playlist do Spotify: toca no app do Spotify (conta pro Wrapped)
    tools.innerHTML = `
      <button class="q-tool" data-act="back" title="Voltar">${ICON.back}</button>
      <input class="pl-name" value="${esc(pl.name)}" maxlength="60" spellcheck="false" title="Clique pra renomear" />
      <button class="q-tool" data-act="plrefresh" title="Atualizar do Spotify">${ICON.refresh}</button>
      <button class="q-tool" data-act="pldelete" title="Tirar do app">${ICON.trash}</button>`;
    html = `<li class="sp-open"><button class="btn-spotify" data-act-sp="open">${ICON.play}Ouvir no Spotify</button><small>Toca no app do Spotify e conta pro Wrapped</small></li>`;
    html += pl.tracks.map((t, i) => `<li data-spi="${i}" title="Abrir no Spotify">${queueItemHtml({ ...t, cover: t.cover || pl.cover }, false)}</li>`).join("");
    list.dataset.kind = "spotify";
  } else if (pl) {
    const src = SRC[pl.source];
    tools.innerHTML = `
      <button class="q-tool" data-act="back" title="Voltar">${ICON.back}</button>
      <input class="pl-name" value="${esc(pl.name)}" maxlength="60" spellcheck="false" title="Clique pra renomear" />
      <button class="q-tool play" data-act="plplay" title="Tocar">${ICON.play}</button>
      <button class="q-tool" data-act="plshuffle" title="Tocar embaralhado">${ICON.shuffle}</button>
      ${src ? `<button class="q-tool" data-act="plrefresh" title="Atualizar do ${src.name}">${ICON.refresh}</button>` : ""}
      <button class="q-tool" data-act="pldelete" title="Apagar playlist">${ICON.trash}</button>`;
    html = pl.tracks.length
      ? pl.tracks.map((t, i) => `<li data-pi="${i}" class="sortable" title="Tocar">${queueItemHtml(t, false, rmBtn(`data-prm="${i}"`))}</li>`).join("")
      : `<li class="q-empty">Playlist vazia.<br>Na busca, use <b>⋯</b> → <b>Adicionar à playlist</b>.</li>`;
    list.dataset.kind = "playlist";
  } else {
    tools.innerHTML = creatingPlaylist
      ? `<input class="pl-name" id="newPlName" placeholder="Nome da playlist" maxlength="40" spellcheck="false" />
         <button class="q-tool txt" data-act="create">Criar</button>`
      : importingPlaylist
        ? `<input class="pl-name" id="importUrl" placeholder="Link do Spotify, SoundCloud ou YouTube" spellcheck="false" ${importBusy ? "disabled" : ""} />
           <button class="q-tool txt" data-act="doimport" ${importBusy ? "disabled" : ""}>${importBusy ? "…" : "Importar"}</button>`
        : `<button class="q-tool txt wide" data-act="new">${ICON.plus}Nova</button>
           <button class="q-tool txt wide" data-act="import">${ICON.link}Importar</button>`;
    html = playlists.length
      ? playlists
          .map((p) => {
            const covers = p.cover ? [p.cover] : p.tracks.map((t) => t.cover).filter(Boolean).slice(0, 4);
            const src = SRC[p.source];
            const art = covers.length >= 4
              ? `<div class="q-cover mosaic">${covers.map((c) => `<img src="${esc(c)}" alt="" draggable="false">`).join("")}</div>`
              : covers.length ? `<img class="q-cover" src="${esc(covers[0])}" alt="" draggable="false">` : `<div class="q-cover pl-blank">${ICON.play}</div>`;
            return `<li data-pl="${esc(p.id)}" title="Abrir">${art}<div class="q-text"><div class="q-title">${esc(p.name)}</div><div class="q-artist">${src ? `<span class="src-dot" style="background:${src.color}"></span>${src.name} · ` : ""}${p.tracks.length} ${p.tracks.length === 1 ? "música" : "músicas"}</div></div></li>`;
          })
          .join("")
      : creatingPlaylist ? "" : `<li class="q-empty">Nenhuma playlist ainda.</li>`;
    if (creatingPlaylist) setTimeout(() => $("#newPlName")?.focus(), 0);
    if (importingPlaylist && !importBusy) setTimeout(() => $("#importUrl")?.focus(), 0);
  }
  list.innerHTML = html;
}

function newPlaylist(name, firstTrack) {
  const p = { id: `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: name || `Playlist ${playlists.length + 1}`, tracks: [] };
  if (firstTrack) p.tracks.push(trackFrom(firstTrack));
  playlists.unshift(p);
  savePlaylists();
  return p;
}

function addToPlaylist(id, t) {
  const p = playlists.find((x) => x.id === id);
  if (!p) return;
  const tr = trackFrom(t);
  if (p.tracks.some((x) => x.title === tr.title && x.artist === tr.artist)) return toast(`Já está em "${p.name}"`);
  p.tracks.push(tr);
  savePlaylists();
  toast(`Adicionada em "${p.name}"`);
  renderQueue(true);
}

function playPlaylist(p, start = 0, shuffle = false) {
  if (!player || !p.tracks.length) return;
  let tracks = p.tracks.slice();
  if (shuffle) {
    for (let k = tracks.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [tracks[k], tracks[j]] = [tracks[j], tracks[k]];
    }
    start = 0;
  }
  player.playQueue(tracks, start);
  setTab("fila");
}

$("#qTools").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const q = player?.queue;
  const pl = playlists.find((p) => p.id === openPlaylistId);
  switch (b.dataset.act) {
    case "shuffle": setShuffleMode(!playModes().shuffle); return;
    case "repeat": setRepeatMode(nextRepeat(playModes().repeat)); return;
    case "clear": q?.clearUpcoming(); break;
    case "back": openPlaylistId = null; break;
    case "plplay": if (pl) playPlaylist(pl, 0); return;
    case "plshuffle": if (pl) playPlaylist(pl, 0, true); return;
    case "pldelete":
      if (!pl) break;
      if (b.dataset.confirm !== "1") {
        b.dataset.confirm = "1";
        b.classList.add("danger");
        b.title = "Clique de novo pra apagar";
        toast(`Clique de novo pra apagar "${pl.name}"`);
        return;
      }
      playlists = playlists.filter((p) => p !== pl);
      savePlaylists();
      openPlaylistId = null;
      toast("Playlist apagada");
      break;
    case "new": creatingPlaylist = true; break;
    case "import": importingPlaylist = true; break;
    case "doimport": {
      const url = $("#importUrl")?.value.trim();
      if (url) importPlaylistUrl(url);
      return;
    }
    case "plrefresh": if (pl?.sourceUrl) importPlaylistUrl(pl.sourceUrl); return;
    case "create": {
      const name = $("#newPlName")?.value.trim();
      creatingPlaylist = false;
      const p = newPlaylist(name);
      openPlaylistId = p.id;
      break;
    }
  }
  renderQueue(true);
});
$("#qTools").addEventListener("keydown", (e) => {
  if (e.target.id === "importUrl") {
    if (e.key === "Enter") $("#qTools [data-act=doimport]")?.click();
    if (e.key === "Escape") { importingPlaylist = false; e.target.blur(); renderQueue(true); }
    return;
  }
  if (e.target.id === "newPlName") {
    if (e.key === "Enter") $("#qTools [data-act=create]")?.click();
    if (e.key === "Escape") { creatingPlaylist = false; e.target.blur(); renderQueue(true); }
  } else if (e.target.classList.contains("pl-name") && (e.key === "Enter" || e.key === "Escape")) e.target.blur();
});
$("#qTools").addEventListener("focusout", (e) => {
  if (!e.target.classList.contains("pl-name") || e.target.id === "newPlName" || e.target.id === "importUrl") return;
  const pl = playlists.find((p) => p.id === openPlaylistId);
  const name = e.target.value.trim();
  if (pl && name && name !== pl.name) {
    pl.name = name;
    savePlaylists();
  }
  setTimeout(() => renderQueue(true), 0);
});

$("#historyList").addEventListener("click", (e) => {
  if (e.target.closest(".q-label, .q-empty")) return;
  const li = e.target.closest("li");
  if (!li || li.dataset.dragged) return;
  const rm = e.target.closest("[data-rm], [data-prm]");
  if (rm) {
    if (rm.dataset.rm !== undefined) player?.queue.remove(+rm.dataset.rm);
    else {
      const pl = playlists.find((p) => p.id === openPlaylistId);
      pl?.tracks.splice(+rm.dataset.prm, 1);
      savePlaylists();
    }
    return renderQueue(true);
  }
  if (li.dataset.qi) return player?.queue.jump(+li.dataset.qi);
  if (li.dataset.hk) {
    const h = history.find((x) => x.key === li.dataset.hk);
    return h && playItem(h);
  }
  if (li.dataset.pl) {
    openPlaylistId = li.dataset.pl;
    return renderQueue(true);
  }
  if (li.dataset.pi) {
    const pl = playlists.find((p) => p.id === openPlaylistId);
    if (pl) playPlaylist(pl, +li.dataset.pi);
  }
  if (li.dataset.spi) {
    const t = playlists.find((p) => p.id === openPlaylistId)?.tracks[+li.dataset.spi];
    const id = t?.url?.split("/track/")[1];
    if (id) openSpotify(`spotify:track:${id}`, `"${t.title}"`);
  }
  if (e.target.closest("[data-act-sp=open]")) {
    const pl = playlists.find((p) => p.id === openPlaylistId);
    if (pl?.openUrl) openSpotify(pl.openUrl, "a playlist");
  }
});

function openSpotify(uri, what) {
  api.invoke("open_url", { url: uri })
    .then(() => toast(`Abrindo ${what} no Spotify — é só dar o play lá 🎧`, 3500))
    .catch((err) => toast(`Não consegui abrir o Spotify: ${err}`, 4000));
}

// ---------- importar playlist por link ----------
const PLAYLIST_LINK = /(open\.spotify\.com\/(intl-[a-z-]+\/)?(playlist|album)\/|^spotify:(playlist|album):|soundcloud\.com\/[^/\s]+\/sets\/|[?&]list=)/i;
const isPlaylistLink = (s) => PLAYLIST_LINK.test(s.trim());

async function importPlaylistUrl(url) {
  if (importBusy) return;
  importBusy = true;
  importingPlaylist = true;
  if (settings.queueTab !== "playlists") { settings.queueTab = "playlists"; saveSettings(); openPlaylistId = null; }
  renderQueue(true);
  toast("Importando playlist…", 2500);
  try {
    const r = await api.invoke("import_playlist", { url });
    if (!r) throw new Error("sem resposta");
    const service = r.source === "soundcloud" ? "soundcloud" : "ytmusic";
    const tracks = r.tracks.map((t) => ({
      title: t.title, artist: t.artist || "", cover: t.cover || null, url: t.url,
      service: r.source === "spotify" ? "spotify" : service, durationMs: t.durationMs || 0,
    }));
    let p = playlists.find((x) => x.sourceUrl === url || (x.openUrl && x.openUrl === r.openUrl));
    if (p) {
      Object.assign(p, { tracks, cover: r.cover || p.cover, source: r.source, openUrl: r.openUrl, sourceUrl: url });
      toast(`"${p.name}" atualizada · ${tracks.length} músicas`);
    } else {
      p = { id: `pl${Date.now().toString(36)}`, name: r.name, cover: r.cover || null, source: r.source, openUrl: r.openUrl, sourceUrl: url, tracks };
      playlists.unshift(p);
      toast(`"${p.name}" importada · ${tracks.length} músicas`);
    }
    savePlaylists();
    openPlaylistId = p.id;
    importingPlaylist = false;
  } catch (e) {
    toast(`Não deu pra importar: ${e?.message || e}`, 5000);
  } finally {
    importBusy = false;
    renderQueue(true);
  }
}
$("#nowItem").addEventListener("click", () => control("toggle"));

// ---------- arrastar pra reordenar (com o mouse, sem drag-and-drop do navegador) ----------
(function sortable() {
  const list = $("#historyList");
  let from = null, startY = 0, over = null, li = null;
  list.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".q-rm")) return;
    li = e.target.closest("li.sortable");
    if (!li) return;
    from = li;
    startY = e.clientY;
  });
  window.addEventListener("pointermove", (e) => {
    if (!from) return;
    if (!dragging && Math.abs(e.clientY - startY) < 6) return;
    dragging = true;
    from.classList.add("dragging");
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("li.sortable");
    if (over && over !== el) over.classList.remove("drop-before", "drop-after");
    over = el && el !== from ? el : null;
    if (over) {
      const r = over.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      over.classList.toggle("drop-after", after);
      over.classList.toggle("drop-before", !after);
    }
  });
  window.addEventListener("pointerup", () => {
    if (!from) return;
    const wasDragging = dragging;
    const src = from, dst = over;
    from = null;
    dragging = false;
    src.classList.remove("dragging");
    if (dst) {
      const after = dst.classList.contains("drop-after");
      dst.classList.remove("drop-before", "drop-after");
      const attr = src.dataset.qi !== undefined ? "qi" : "pi";
      const a = +src.dataset[attr];
      let b = +dst.dataset[attr] + (after ? 1 : 0);
      if (b > a) b--;
      if (attr === "qi") {
        const info = player?.queue.info();
        if (info && b <= info.index) b = info.index + 1; // não passa da música atual
        player?.queue.move(a, b);
      } else {
        const pl = playlists.find((p) => p.id === openPlaylistId);
        if (pl) {
          const [it] = pl.tracks.splice(a, 1);
          pl.tracks.splice(b, 0, it);
          savePlaylists();
        }
      }
    }
    over = null;
    if (wasDragging) {
      src.dataset.dragged = "1"; // engole o clique que vem logo depois
      setTimeout(() => renderQueue(true), 0);
    }
  });
})();

// ---------- menu ⋯ / clique direito: fila e playlists ----------
function openTrackMenu(x, y, t) {
  const menu = $("#ctxMenu");
  const canPlay = !!player;
  menu.innerHTML = `
    ${canPlay ? `<button data-c="now">${ICON.play}Tocar agora</button>
    <button data-c="next">${ICON.plus}Tocar a seguir</button>
    <button data-c="queue">${ICON.plus}Adicionar à fila</button><hr>` : ""}
    <div class="ctx-label">Adicionar à playlist</div>
    ${playlists.filter((p) => !isSpotifyPl(p)).map((p) => `<button data-c="pl" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join("")}
    <button data-c="newpl" class="muted-btn">${ICON.plus}Nova playlist</button>`;
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`;
  menu.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, y))}px`;
  menu.onclick = (e) => {
    const b = e.target.closest("button[data-c]");
    if (!b) return;
    menu.hidden = true;
    const tr = trackFrom(t);
    switch (b.dataset.c) {
      case "now": player.playQueue([tr], 0); break;
      case "next": player.queue.playNext(tr); toast("Toca a seguir"); break;
      case "queue": player.queue.add(tr); toast("Adicionada à fila"); break;
      case "pl": addToPlaylist(b.dataset.id, t); break;
      case "newpl": {
        const p = newPlaylist(null, t);
        toast(`Criada "${p.name}" — renomeie em Playlists`);
        break;
      }
    }
    renderQueue(true);
  };
}
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#ctxMenu")) $("#ctxMenu").hidden = true;
});

/** A música que está em um elemento da tela (para o clique direito). */
function trackAt(el) {
  const li = el.closest("#historyList li, #nowItem");
  if (li?.id === "nowItem") {
    if (!keyOf(media)) return null;
    const h = history.find((x) => x.key === keyOf(media));
    return h?.play || { title: media.title, artist: media.artist, cover: media.coverUrl || h?.thumb, url: media.link, service: media.service };
  }
  if (li?.dataset.qi) return player?.queue.info().tracks[+li.dataset.qi];
  if (li?.dataset.pi) return playlists.find((p) => p.id === openPlaylistId)?.tracks[+li.dataset.pi];
  if (li?.dataset.hk) {
    const h = history.find((x) => x.key === li.dataset.hk);
    return h && (h.play || { title: h.title, artist: h.artist, cover: h.thumb });
  }
  return null;
}
$("#queue").addEventListener("contextmenu", (e) => {
  const t = trackAt(e.target);
  if (!t) return;
  e.preventDefault();
  openTrackMenu(e.clientX, e.clientY, t);
});

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
  renderQueue(true);
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
  renderQueue(true);
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
  pushRemote();
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
  pushRemoteLyrics();
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
      pushRemoteLyrics();
      return;
    }
  }
  pushRemoteLyrics();
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
function updateBeat() {
  const on = settings.visualizer && media.available && media.playing;
  const target = on ? beatTarget : 0;
  beat += (target - beat) * (target > beat ? 0.55 : 0.12); // sobe rápido, desce devagar
  if (beat < 0.004) beat = 0;
  if (Math.abs(beat - beatShown) > 0.004) {
    beatShown = beat;
    document.documentElement.style.setProperty("--beat", beat.toFixed(3));
  }
}
api.listen("audio-level", (lv) => {
  // grave pesa mais; o volume geral ajuda em música sem grave
  beatTarget = Math.min(1, Math.max(0, (lv?.[0] || 0) * 0.85 + (lv?.[1] || 0) * 0.25) ** 1.6);
});
if (api.demo) {
  // modo demo: um "bumbo" falso no ritmo de 120 bpm
  setInterval(() => (beatTarget = media.playing ? (Date.now() % 500 < 120 ? 0.9 : 0.15 + Math.random() * 0.1) : 0), 40);
}

function frame() {
  requestAnimationFrame(frame);
  updateBeat();
  if (paused) return;
  const pos = positionNow();
  const pct = media.durationMs > 0 ? (pos / media.durationMs) * 100 : 0;
  $("#progressFill").style.width = `${pct}%`;
  $("#ncFill").style.width = `${pct}%`;
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
  feedLyricsBar(pos + settings.lyricsOffset * 1000);
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
  if (resTab !== "all") setResTab("all");
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

async function runSearch(q) {
  q = q.trim();
  if (!q) return closeSearch();
  const seq = ++searchSeq;
  const svc = settings.service;
  $("#stage").classList.add("searching");
  $("#results").hidden = false;
  if (resTab !== "all") loadFull(true);
  $("#resNote").textContent = "";
  $("#resTracks").innerHTML = skeleton(7);
  $("#resArtists").innerHTML = skeleton(7, "round");

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
            `<div class="res-tile" data-t="${i}" title="Tocar">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy" draggable="false">` : `<div class="sk"></div>`}<button class="tile-more" data-more="${i}" title="Fila e playlists">${ICON.more}</button><b>${esc(t.title)}</b><span>${esc(t.artist)}${t.durationMs ? ` · ${fmt(t.durationMs)}` : ""}</span></div>`,
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
    return res.source === "deezer" ? { ...trackFrom(t, svcOk), url: null } : toTrack(t, svcOk);
  };
  $("#resTracks").oncontextmenu = (e) => {
    const el = e.target.closest("[data-t]");
    if (!el) return;
    e.preventDefault();
    openTrackMenu(e.clientX, e.clientY, resultTrack(+el.dataset.t));
  };
  $("#resTracks").onclick = (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      return openTrackMenu(r.right - 4, r.bottom + 4, resultTrack(+more.dataset.more));
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
      input.value = a.name; // busca as músicas do artista
      return runSearch(a.name);
    }
    open(a.name, a.url);
  };
}

// ===================================================================
// Busca completa: abas Tudo · Músicas · Artistas, com "carregar mais"
// ===================================================================
let resTab = "all";
const full = { q: "", svc: "", kind: "", items: [], next: null, loading: false, done: false, seq: 0, source: "", error: "" };

function setResTab(tab) {
  resTab = tab;
  for (const b of $$("#resTabs button")) b.classList.toggle("sel", b.dataset.rt === tab);
  $("#resAll").hidden = tab !== "all";
  $("#resFull").hidden = tab === "all";
  $("#results").scrollTop = 0;
  if (tab !== "all") loadFull(true);
}
$("#results").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rt]");
  if (b) setResTab(b.dataset.rt);
});

async function deezerPage(q, kind, cursor) {
  const index = +(cursor || 0);
  const url = kind === "artists"
    ? `https://api.deezer.com/search/artist?q=${enc(q)}&limit=40&index=${index}`
    : `https://api.deezer.com/search?q=${enc(q)}&limit=40&index=${index}`;
  const r = await httpJson(url);
  const data = r?.data || [];
  return {
    source: "deezer",
    tracks: kind === "artists" ? [] : data.map((t) => ({ title: t.title_short || t.title, artist: t.artist?.name || "", cover: t.album?.cover_medium || "", url: t.link, durationMs: (t.duration || 0) * 1000 })),
    artists: kind === "artists" ? data.map((a) => ({ name: a.name, picture: a.picture_medium || "", url: a.link })) : [],
    next: r?.next && data.length ? String(index + data.length) : null,
  };
}

async function loadFull(reset = false) {
  const q = input.value.trim();
  const kind = resTab;
  const svc = settings.service;
  if (!q || kind === "all") return;
  if (reset || full.q !== q || full.kind !== kind || full.svc !== svc) {
    Object.assign(full, { q, kind, svc, items: [], next: null, loading: false, done: false, seq: full.seq + 1, source: "", error: "" });
    renderFull();
  }
  if (full.loading || full.done) return;
  full.loading = true;
  full.error = "";
  renderFullMore();
  const my = full.seq;
  try {
    let page;
    if (NATIVE_SEARCH[svc] && full.source !== "deezer") {
      try {
        page = await api.invoke("search_page", { service: NATIVE_SEARCH[svc], query: q, kind, cursor: full.next });
        if (!page) throw new Error("sem resposta");
      } catch (e) {
        if (full.items.length) throw e; // no meio da lista: só mostra o erro
        $("#fullNote").textContent = `${SERVICES[svc].name} não respondeu (${String(e?.message || e)}). Mostrando resultados do Deezer.`;
        page = await deezerPage(q, kind, null);
      }
    } else {
      page = await deezerPage(q, kind, full.next);
    }
    if (my !== full.seq) return;
    if (!full.source) full.source = page.source;
    const got = kind === "artists" ? page.artists || [] : page.tracks || [];
    // a mesma música pode voltar em duas páginas
    const have = new Set(full.items.map((x) => x.url));
    full.items.push(...got.filter((x) => !have.has(x.url)));
    full.next = page.next || null;
    full.done = !full.next;
  } catch (e) {
    if (my !== full.seq) return;
    full.error = String(e?.message || e);
  } finally {
    if (my === full.seq) {
      full.loading = false;
      renderFull();
    }
  }
}

function fullTrack(i) {
  const t = full.items[i];
  const svcOk = PLAYABLE[full.svc] ? full.svc : "ytmusic";
  return full.source === "deezer" ? { ...trackFrom(t, svcOk), url: null } : toTrack(t, svcOk);
}

function renderFull() {
  const list = $("#fullList");
  if (full.kind === "artists") {
    list.className = "fl-grid artists";
    list.innerHTML = full.items
      .map((a, i) => `<div class="res-tile" data-fa="${i}" title="Ver músicas">${a.picture ? `<img src="${esc(a.picture)}" alt="" loading="lazy" draggable="false">` : `<div class="sk"></div>`}<b>${esc(a.name)}</b></div>`)
      .join("");
  } else {
    list.className = "fl-list";
    const playingUrl = local?.link;
    list.innerHTML = full.items
      .map((t, i) => {
        const now = playingUrl && (t.url === playingUrl || toTrack(t, full.svc).url === playingUrl);
        return `<div class="fl-row${now ? " now" : ""}" data-fi="${i}">
          <span class="fl-n">${now ? `<span class="eq"><i></i><i></i><i></i></span>` : i + 1}</span>
          ${t.cover ? `<img class="fl-cover" src="${esc(t.cover)}" alt="" loading="lazy" draggable="false">` : `<div class="fl-cover"></div>`}
          <div class="fl-text"><b>${esc(t.title)}</b><span>${esc(t.artist || "—")}</span></div>
          <span class="fl-dur">${t.durationMs ? fmt(t.durationMs) : ""}</span>
          <button class="fl-more" data-fmore="${i}" title="Fila e playlists">${ICON.more}</button>
        </div>`;
      })
      .join("");
  }
  if (!full.items.length && !full.loading) {
    list.innerHTML = full.error
      ? `<div class="res-empty">Não deu pra buscar: ${esc(full.error)}</div>`
      : `<div class="res-empty">Nada encontrado.</div>`;
  }
  renderFullMore();
}

function renderFullMore() {
  const el = $("#fullMore");
  if (full.loading) {
    el.innerHTML = full.kind === "artists"
      ? `<div class="fl-grid artists">${skeleton(full.items.length ? 6 : 12, "round")}</div>`
      : Array.from({ length: full.items.length ? 3 : 10 }, () => `<div class="fl-row sk-row"><span class="fl-n"></span><div class="fl-cover sk"></div><div class="fl-text"><i></i><i></i></div></div>`).join("");
  } else if (full.error && full.items.length) {
    el.innerHTML = `<button class="btn" data-fretry>Tentar de novo</button> <small class="muted">${esc(full.error)}</small>`;
  } else if (!full.done && full.items.length) {
    el.innerHTML = `<button class="btn" data-fretry>Carregar mais</button>`;
  } else {
    el.innerHTML = full.items.length ? `<small class="muted">${full.items.length} ${full.kind === "artists" ? "artistas" : "músicas"}</small>` : "";
  }
}

$("#fullMore").addEventListener("click", (e) => {
  if (e.target.closest("[data-fretry]")) loadFull();
});
// rolou até perto do fim → carrega mais sozinho
$("#results").addEventListener("scroll", () => {
  if (resTab === "all") return;
  const r = $("#results");
  if (r.scrollTop + r.clientHeight > r.scrollHeight - 400) loadFull();
}, { passive: true });

$("#fullList").addEventListener("click", (e) => {
  const more = e.target.closest("[data-fmore]");
  if (more) {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    return openTrackMenu(r.right - 210, r.bottom + 4, fullTrack(+more.dataset.fmore));
  }
  const row = e.target.closest("[data-fi]");
  if (row) {
    const i = +row.dataset.fi;
    const t = full.items[i];
    if (player && PLAYABLE[full.svc]) {
      // toca a partir dela, com a lista inteira carregada como fila
      return player.playQueue(full.items.map((_, k) => fullTrack(k)), i);
    }
    if (full.source !== "deezer" || full.svc === "deezer") {
      return api.invoke("open_url", { url: t.url }).then(() => toast(`Abrindo no ${SERVICES[full.svc].name}…`)).catch((err) => toast(String(err)));
    }
    return openInService(`${t.title} ${t.artist}`);
  }
  const art = e.target.closest("[data-fa]");
  if (art) {
    const a = full.items[+art.dataset.fa];
    if (player && PLAYABLE[full.svc]) {
      input.value = a.name;
      runSearch(a.name);
      return setResTab("tracks");
    }
    if (full.source !== "deezer" || full.svc === "deezer") return api.invoke("open_url", { url: a.url }).catch(() => {});
    openInService(a.name);
  }
});
$("#fullList").addEventListener("contextmenu", (e) => {
  const row = e.target.closest("[data-fi]");
  if (!row) return;
  e.preventDefault();
  openTrackMenu(e.clientX, e.clientY, fullTrack(+row.dataset.fi));
});

const input = $("#searchInput");
input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  if (isPlaylistLink(input.value)) {
    $("#resNote").textContent = "";
    return toast("Link de playlist: aperte Enter pra importar", 2500);
  }
  searchTimer = setTimeout(() => runSearch(input.value), 380);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return;
    if (isPlaylistLink(q)) {
      input.value = "";
      closeSearch();
      input.blur();
      return importPlaylistUrl(q);
    }
    if (!$("#results").hidden && $("#resTracks .res-empty")) playQuery(q);
    else runSearch(q);
  } else if (e.key === "Escape") {
    input.value = "";
    closeSearch();
    input.blur();
  }
});

// ---------- seletor de serviço ----------
function renderService() {
  const svc = SERVICES[settings.service];
  $("#btnService").innerHTML = `<span class="service-dot" style="background:${svc.color}"></span>${esc(svc.name)}`;
  input.placeholder = `Pesquisar no ${svc.name}…`;
  $("#segService").innerHTML = Object.entries(SERVICES)
    .map(([id, s]) => `<button data-v="${id}" class="${id === settings.service ? "sel" : ""}">${esc(s.name)}</button>`)
    .join("");
}
function setService(id) {
  settings.service = id;
  saveSettings();
  renderService();
  renderQueue();
}
$("#btnService").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#serviceMenu");
  if (!menu.hidden) return (menu.hidden = true);
  menu.innerHTML = Object.entries(SERVICES)
    .map(([id, s]) => `<button data-v="${id}" class="${id === settings.service ? "sel" : ""}"><span class="service-dot" style="background:${s.color}"></span>${esc(s.name)}</button>`)
    .join("");
  menu.hidden = false;
  const r = $("#btnService").getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.top - menu.offsetHeight - 10}px`;
});
$("#serviceMenu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  setService(b.dataset.v);
  $("#serviceMenu").hidden = true;
  if (input.value.trim()) runSearch(input.value);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#serviceMenu")) $("#serviceMenu").hidden = true;
});

// ===================================================================
// Configurações
// ===================================================================
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
  setAccent(coverAccent, false);
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
    ...library.map((w) => {
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
  clearInterval(discordStatusTimer);
  if (!$("#settings").hidden) {
    refreshDiscordStatus();
    discordStatusTimer = setInterval(refreshDiscordStatus, 3000);
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
  shownLine = null;
  shownText = "";
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
$("#swVisualizer").addEventListener("click", () => {
  settings.visualizer = !settings.visualizer;
  saveSettings();
  renderSettings();
  api.invoke("set_visualizer", { on: settings.visualizer }).catch(() => {});
});
$("#btnLyrics").addEventListener("click", toggleLyrics);
// ---------- mini player automático ao minimizar ----------
let miniAuto = false; // o mini atual foi aberto sozinho (então fecha sozinho também)
if (!IS_WALLPAPER) {
  api.listen("main-minimized", async () => {
    if (!settings.autoMini || miniAuto || $("#btnMini").classList.contains("on")) return;
    if (!keyOf(media) || !media.playing) return;
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
  renderSettings();
  tickClock();
});
const stepOffset = (d) => {
  settings.lyricsOffset = Math.round((settings.lyricsOffset + d) * 10) / 10;
  saveSettings();
  renderSettings();
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
  renderSettings();
  if (fromTray) return;
  api
    .invoke("set_wallpaper_mode", { enabled: on })
    .then(() => on && toast("Wallpaper ligado — minimize as janelas pra ver 👀", 3200))
    .catch((err) => {
      settings.wallpaperMode = false;
      saveSettings();
      renderSettings();
      toast(String(err), 4500);
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
      document.activeElement === input || document.querySelector("#dock:hover, #queue:hover, #titlebar:hover");
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
  const typing = e.target === input;
  if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    input.focus();
    input.select();
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

async function updateDiscord() {
  const svc = playingService();
  const show = settings.discord && keyOf(media) && media.playing && !(svc === "spotify" && !settings.discordSpotify);
  if (!show) {
    if (discordSig !== "off") {
      discordSig = "off";
      api.invoke("discord_clear").catch(() => {});
    }
    return;
  }
  const start = Date.now() - positionNow();
  const sig = `${keyOf(media)}|${svc}|${Math.round(start / 3000)}`;
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
      },
    })
    .catch(() => {});
}

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
  if (resTab === "tracks" && full.items.length && local?.link !== full.nowLink) {
    full.nowLink = local?.link;
    renderFull();
  }
  renderMini();
  renderQueue();
  renderCarousel();
}

function onMedia(s, fromLocal = false) {
  if (!s) return;
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
  const prevKey = keyOf(media);
  media = s;
  const k = keyOf(s);
  if (k && k !== prevKey) {
    focusOffset = 0;
    updateArt(s.thumb);
    upsertHistory(s);
    loadLyrics(s);
    scheduleNotify(k);
    djOnTrack(k);
    if (kOn) setTimeout(renderKaraoke, 300);
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

// ===================================================================
// Retrospectiva ("seu Wrapped"): conta o que você ouve, de qualquer app
// ===================================================================
let stats = Stats.emptyStats();
try {
  stats = { ...Stats.emptyStats(), ...(store.get("hp.stats", null) || {}) };
} catch {}
let statsDirty = false;
const saveStats = () => {
  if (!statsDirty || IS_WALLPAPER) return;
  statsDirty = false;
  try {
    store.set("hp.stats", stats);
  } catch {
    // localStorage cheio: joga fora o mais velho e tenta de novo
    Stats.prune(stats, 120);
    try { store.set("hp.stats", stats); } catch {}
  }
};
const session = { key: "", sec: 0, counted: false };
const statsCover = new Map(); // capa pequena por música (pra não guardar imagem grande)

async function smallCover(key) {
  if (statsCover.has(key)) return statsCover.get(key);
  const h = history.find((x) => x.key === key);
  let c = media.coverUrl && /^https:/.test(media.coverUrl) ? media.coverUrl : null;
  if (!c && (h?.thumb || media.thumb)) c = await shrinkImage(h?.thumb || media.thumb, 96);
  statsCover.set(key, c);
  return c;
}

if (!IS_WALLPAPER) {
  setInterval(async () => {
    const key = keyOf(media);
    if (!key || !media.playing || media.loading) return;
    if (session.key !== key) Object.assign(session, { key, sec: 0, counted: false });
    session.sec++;
    const cover = stats.meta[key]?.cover ? null : await smallCover(key);
    Stats.record(stats, { key, title: media.title, artist: media.artist, service: playingService(), cover }, 1);
    const need = media.durationMs > 0 ? Math.min(30, media.durationMs / 2000) : 30;
    if (!session.counted && session.sec >= need) {
      session.counted = true;
      Stats.countPlay(stats, key);
    }
    statsDirty = true;
  }, 1000);
  setInterval(saveStats, 20000);
  window.addEventListener("beforeunload", saveStats);
  Stats.prune(stats, 400);
}

// modo demo: inventa um mês de escuta pra tela não ficar vazia
if (api.demo && !Object.keys(stats.days).length && api.sampleTracks) {
  const svcs = ["spotify", "spotify", "soundcloud", "ytmusic", "spotify"];
  for (let d = 0; d < 30; d++) {
    const date = new Date(Date.now() - d * 86400e3);
    api.sampleTracks.forEach((t, i) => {
      const times = Math.max(0, Math.round((8 - i) * Math.random() * 1.4));
      for (let k = 0; k < times; k++) {
        date.setHours([22, 23, 21, 14, 9, 18][(i + k) % 6]);
        const key = `${t.title}␟${t.artist}`;
        Stats.record(stats, { key, title: t.title, artist: t.artist, service: svcs[i % 5], cover: t.thumb }, t.durationMs / 1000, date);
        Stats.countPlay(stats, key, date);
      }
    });
  }
}

let wrPeriod = "30d";
const fmtMin = (sec) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const fmtNum = (n) => n.toLocaleString("pt-BR");

function renderWrapped() {
  saveStats();
  const { from, to, label } = Stats.periodRange(wrPeriod);
  const r = Stats.summarize(stats, from, to);
  for (const b of $$("#wrPeriod button")) b.classList.toggle("sel", b.dataset.p === wrPeriod);
  $("#wrSub").textContent = `${label} · tudo que você ouviu, de qualquer app`;
  $("#wrShare").disabled = !r.totalSec;
  if (r.totalSec < 60) {
    $("#wrBody").innerHTML = `<div class="wr-empty">Ainda não tem muita coisa aqui.<br>Ouça umas músicas (no Spotify, SoundCloud, YouTube…) com o Harle Player aberto e volte depois. 🎧</div>`;
    return;
  }
  const img = (c) => (c ? `<img src="${esc(c)}" alt="" loading="lazy" draggable="false">` : `<div class="ph"></div>`);
  const tracks = r.tracks.slice(0, 10).map((t, i) => `<div class="wr-row"><span class="n">${i + 1}</span>${img(t.cover)}<div class="tx"><b>${esc(t.title)}</b><span>${esc(t.artist || "—")}</span></div><span class="val">${t.plays}× · ${fmtMin(t.sec)}</span></div>`).join("");
  const artists = r.artists.slice(0, 5).map((a, i) => `<div class="wr-row"><span class="n">${i + 1}</span>${img(a.cover)}<div class="tx"><b>${esc(a.name)}</b><span>${a.tracks} ${a.tracks === 1 ? "música" : "músicas"}</span></div><span class="val">${fmtMin(a.sec)}</span></div>`).join("");
  const svcColor = (id) => SERVICES[id]?.color || (id === "browser" ? "#8b93a7" : "#5d6475");
  const svcBar = r.services.map((x) => `<i style="width:${(x.sec / r.totalSec) * 100}%;background:${svcColor(x.svc)}"></i>`).join("");
  const svcLegend = r.services.map((x) => `<span style="--c:${svcColor(x.svc)}">${esc(serviceName(x.svc) || x.svc)} ${Math.round((x.sec / r.totalSec) * 100)}%</span>`).join("");
  const maxH = Math.max(...r.hours, 1);
  const hours = r.hours.map((h, i) => `<i class="${i === r.peakHour ? "peak" : ""}" style="height:${Math.max(3, (h / maxH) * 100)}%" title="${i}h"></i>`).join("");
  $("#wrBody").innerHTML = `
    <div class="wr-stats">
      <div class="wr-stat hero"><b>${fmtNum(Math.round(r.totalSec / 60))}</b><span>minutos ouvindo</span></div>
      <div class="wr-stat"><b>${fmtNum(r.tracks.length)}</b><span>músicas diferentes</span></div>
      <div class="wr-stat"><b>${fmtNum(r.artists.length)}</b><span>artistas</span></div>
      <div class="wr-stat"><b>${fmtNum(r.plays)}</b><span>vezes que deu play</span></div>
    </div>
    <div class="wr-cols">
      <div class="wr-box"><h3>Top 10 músicas</h3>${tracks}</div>
      <div class="wr-side">
        <div class="wr-box wr-artists"><h3>Top artistas</h3>${artists}</div>
        <div class="wr-box"><h3>Onde você ouve</h3><div class="wr-svc">${svcBar}</div><div class="wr-legend">${svcLegend}</div></div>
        <div class="wr-box"><h3>Seu horário${r.peakHour >= 0 ? ` · mais às ${r.peakHour}h` : ""}</h3><div class="wr-hours">${hours}</div><div class="wr-hours-l"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div></div>
      </div>
    </div>`;
}

function openWrapped() {
  $("#settings").hidden = true;
  $("#wrapped").hidden = false;
  renderWrapped();
}
$("#btnWrapped").addEventListener("click", () => ($("#wrapped").hidden ? openWrapped() : ($("#wrapped").hidden = true)));
$("#wrClose").addEventListener("click", () => ($("#wrapped").hidden = true));
$("#wrPeriod").addEventListener("click", (e) => {
  const b = e.target.closest("[data-p]");
  if (!b) return;
  wrPeriod = b.dataset.p;
  renderWrapped();
});

// ---------- card 1080×1920 pra postar nos stories ----------
async function loadImg(src) {
  if (!src) return null;
  let url = src;
  let revoke = null;
  if (/^https:/.test(src) && !api.demo) {
    // baixa pelo Rust: imagem de outro site "sujaria" o canvas e ele não deixaria salvar
    try {
      const buf = await api.invoke("image_bytes", { url: src });
      url = revoke = URL.createObjectURL(new Blob([new Uint8Array(buf)]));
    } catch {
      return null;
    }
  }
  const im = await new Promise((res) => {
    const el = new Image();
    el.onload = () => res(el);
    el.onerror = () => res(null);
    el.src = url;
  });
  if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 5000);
  return im;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawCover(ctx, im, x, y, size, radius) {
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.clip();
  if (im) {
    const s = Math.min(im.width, im.height);
    ctx.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, x, y, size, size);
  } else {
    ctx.fillStyle = "rgba(255,255,255,.12)";
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

async function drawShareCard() {
  const { from, to, label } = Stats.periodRange(wrPeriod);
  const r = Stats.summarize(stats, from, to);
  const c = $("#shareCanvas");
  const ctx = c.getContext("2d");
  const W = 1080, H = 1920;
  await document.fonts?.ready;
  const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "120, 170, 255";
  const [ar, ag, ab] = acc.split(",").map((x) => +x);
  // fundo: degradê com a cor de destaque
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, `rgb(${ar * 0.55 | 0},${ag * 0.55 | 0},${ab * 0.55 | 0})`);
  bg.addColorStop(0.55, "#0a0d1a");
  bg.addColorStop(1, "#05060c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.8, H * 0.12, 0, W * 0.8, H * 0.12, W * 0.9);
  glow.addColorStop(0, `rgba(${ar},${ag},${ab},0.55)`);
  glow.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const P = 90;
  ctx.fillStyle = "rgba(255,255,255,.75)";
  ctx.font = "700 34px Inter, sans-serif";
  ctx.fillText("MEU HARLE WRAPPED", P, 150);
  ctx.fillStyle = `rgb(${ar},${ag},${ab})`;
  ctx.font = "700 34px Inter, sans-serif";
  ctx.fillText(label.toUpperCase(), P, 200);

  ctx.fillStyle = "#fff";
  ctx.font = "800 190px Inter, sans-serif";
  const mins = fmtNum(Math.round(r.totalSec / 60));
  ctx.fillText(mins, P - 6, 400);
  ctx.font = "600 44px Inter, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,.8)";
  ctx.fillText("minutos ouvindo música", P, 470);

  // artista nº 1
  const top = r.artists[0];
  const topIm = await loadImg(top?.cover);
  let y = 580;
  if (top) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(P + 110, y + 110, 110, 0, Math.PI * 2);
    ctx.clip();
    drawCover(ctx, topIm, P, y, 220, 0);
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,.65)";
    ctx.font = "700 30px Inter, sans-serif";
    ctx.fillText("ARTISTA Nº 1", P + 260, y + 80);
    ctx.fillStyle = "#fff";
    ctx.font = "800 68px Inter, sans-serif";
    ctx.fillText(fitText(ctx, top.name, W - P * 2 - 260), P + 260, y + 155);
    ctx.font = "500 32px Inter, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.fillText(`${fmtMin(top.sec)} juntos`, P + 260, y + 205);
  }

  // top 5 músicas
  y = 880;
  ctx.fillStyle = "rgba(255,255,255,.65)";
  ctx.font = "700 30px Inter, sans-serif";
  ctx.fillText("TOP MÚSICAS", P, y);
  y += 40;
  const list = r.tracks.slice(0, 5);
  const ims = await Promise.all(list.map((t) => loadImg(t.cover)));
  list.forEach((t, i) => {
    const rowY = y + i * 150;
    ctx.fillStyle = i === 0 ? `rgb(${ar},${ag},${ab})` : "rgba(255,255,255,.5)";
    ctx.font = "800 48px Inter, sans-serif";
    ctx.fillText(String(i + 1), P, rowY + 80);
    drawCover(ctx, ims[i], P + 70, rowY + 10, 116, 18);
    ctx.fillStyle = "#fff";
    ctx.font = "700 44px Inter, sans-serif";
    ctx.fillText(fitText(ctx, t.title, W - P * 2 - 220), P + 216, rowY + 62);
    ctx.fillStyle = "rgba(255,255,255,.65)";
    ctx.font = "500 34px Inter, sans-serif";
    ctx.fillText(fitText(ctx, `${t.artist || "—"} · ${t.plays}×`, W - P * 2 - 220), P + 216, rowY + 108);
  });

  // rodapé: serviços + horário
  y = 1745;
  const svcs = r.services.slice(0, 3).map((x) => `${serviceName(x.svc) || x.svc} ${Math.round((x.sec / r.totalSec) * 100)}%`).join("  ·  ");
  ctx.fillStyle = "rgba(255,255,255,.7)";
  ctx.font = "600 32px Inter, sans-serif";
  ctx.fillText(fitText(ctx, svcs, W - P * 2), P, y);
  if (r.peakHour >= 0) ctx.fillText(`Horário favorito: ${r.peakHour}h`, P, y + 50);
  ctx.fillStyle = "rgba(255,255,255,.45)";
  ctx.font = "600 28px Inter, sans-serif";
  ctx.fillText("Harle Player", P, H - 55);
  ctx.textAlign = "right";
  ctx.fillText("github.com/Harlezinhuu", W - P, H - 55);
  ctx.textAlign = "left";
}

$("#wrShare").addEventListener("click", async () => {
  $("#wrShare").disabled = true;
  try {
    await drawShareCard();
    $("#shareModal").hidden = false;
  } catch (e) {
    toast(`Não consegui gerar a imagem: ${e?.message || e}`, 4000);
  } finally {
    $("#wrShare").disabled = false;
  }
});
$("#shareClose").addEventListener("click", () => ($("#shareModal").hidden = true));
$("#shareModal").addEventListener("click", (e) => {
  if (e.target.id === "shareModal") $("#shareModal").hidden = true;
});
$("#shareSave").addEventListener("click", async () => {
  const data = $("#shareCanvas").toDataURL("image/png");
  const name = `harle-wrapped-${Stats.dayKey(new Date())}`;
  if (api.demo) {
    const a = document.createElement("a");
    a.href = data;
    a.download = `${name}.png`;
    a.click();
    return;
  }
  try {
    const path = await api.invoke("save_image", { name, dataBase64: data });
    toast(`Salva em ${path}`, 4000);
  } catch (e) {
    toast(`Não consegui salvar: ${e}`, 4000);
  }
});
$("#shareCopy").addEventListener("click", () => {
  $("#shareCanvas").toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Imagem copiada — é só colar (Ctrl+V)");
    } catch (e) {
      toast(`Não deu pra copiar: ${e?.message || e}`, 4000);
    }
  }, "image/png");
});

// ===================================================================
// Aviso de música nova (cartão no canto da tela) e atalhos globais
// ===================================================================
let notifyTimer = 0;
const appFocused = () => !document.hidden && document.hasFocus();
function scheduleNotify(key) {
  if (!settings.notify || IS_WALLPAPER) return;
  clearTimeout(notifyTimer);
  // espera a capa e a cor chegarem; só avisa se o app não está na frente
  notifyTimer = setTimeout(() => {
    if (keyOf(media) === key && !appFocused()) notifyNow();
  }, 900);
}
function notifyNow(label) {
  if (!settings.notify || IS_WALLPAPER || !keyOf(media)) return;
  const h = history.find((x) => x.key === keyOf(media));
  api.invoke("notify_show", {
    payload: {
      label: label || "Tocando agora",
      title: media.title,
      artist: [media.artist, serviceName(playingService())].filter(Boolean).join(" · "),
      cover: media.coverUrl || media.thumb || h?.thumb || null,
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
    vol.source = media.available ? media.source || "" : "";
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
  remoteVol = { level: vol.level, target };
  if (!appFocused() && settings.notify) {
    api.invoke("notify_show", {
      payload: {
        kind: "volume",
        level: vol.level,
        target,
        title: keyOf(media) ? media.title : "Volume",
        cover: media.coverUrl || media.thumb || null,
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
  const source = media.available ? media.source || "" : "";
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
  const line = lyrics && lyrics.key === keyOf(media) ? (() => {
    const L = lyrics.lines;
    let idx = -1;
    for (let i = 0; i < L.length; i++) if (L[i].t <= pos) idx = i; else break;
    return idx >= 0 ? { ...L[idx], idx, next: L[idx + 1]?.text || "" } : null;
  })() : null;
  const text = line && pos <= line.end + 400 ? line.text : "";
  const sig = `${keyOf(media)}|${line?.idx}|${text}`;
  const playing = !!media.playing;
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
  const title = cleanTitle(media.title || "");
  const artist = cleanArtist(media.artist || "") || "artista desconhecido";
  const key = keyOf(media);
  const week = Stats.summarize(stats, Stats.periodRange("7d").from);
  const t = week.tracks.find((x) => x.key === key);
  const a = week.artists.find((x) => x.name.toLowerCase() === Stats.mainArtist(media.artist || "").toLowerCase());
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
  const artist = Stats.mainArtist(media.artist || "").toLowerCase();
  djArtistRun = artist && artist === djLastArtist ? djArtistRun + 1 : 0;
  djLastArtist = artist;
  const speak = settings.djEvery === "all" || djCount === 0 || djArtistRun >= 2 || Math.random() < 0.4;
  djTimer = setTimeout(() => {
    if (keyOf(media) !== key || !media.playing) return;
    if (speak) djSpeak(djLine());
    djCount++;
  }, 1500);
}

// ---------- configurações da aba Extras (Discord, letra flutuante, DJ) ----------
function renderExtras() {
  $("#swDucking").classList.toggle("on", settings.ducking);
  $$("#segDuck button").forEach((b) => b.classList.toggle("sel", +b.dataset.v === settings.duckLevel));
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
  djSpeak(keyOf(media) ? djLine() : "Testando, testando. Som na caixa!");
});

// ===================================================================
// Karaokê: tira a voz, sua voz nos fones (com efeitos) e gravação
// ===================================================================
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
  const localNow = !!(player?.active && local);
  $("#kNotLocal").hidden = localNow || !kOn;
  $("#kControls").hidden = !localNow;
  if (!localNow && keyOf(media)) $("#kNotLocalText").textContent = `"${media.title}" está tocando no ${serviceName(playingService()) || "outro app"}. O karaokê só tira a voz do que toca aqui dentro.`;
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
  const q = `${cleanTitle(media.title || "")} ${cleanArtist(media.artist || "")}`.trim();
  if (media.available && media.playing && !local) control("toggle"); // pausa o app de fora
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
  const name = `karaoke-${cleanTitle(media.title || "musica").replace(/[^\w-]+/g, "-").slice(0, 30)}-${Stats.dayKey(new Date())}`;
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

// ===================================================================
// Controle pelo celular: o PC vira um servidorzinho na rede Wi-Fi
// ===================================================================
let remoteInfo = null;
let remoteCoverSent = null;
let remoteVol = { level: settings.volume, target: "Volume" };

/** Comandos que chegam do mini player e do celular. */
function remoteCommand(m) {
  const t = m.track;
  switch (m.action) {
    case "toggle": case "next": case "prev":
      if (m.from === "hotkey" && m.action === "toggle") setTimeout(() => notifyNow(media.playing ? "Tocando" : "Pausado"), 350);
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
      vol.source = isLocalVol() ? null : media.available ? media.source || "" : "";
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
  const curKey = keyOf(media);
  const h = curKey ? history.find((x) => x.key === curKey) : null;
  const info = player?.active && local ? player.queue.info() : null;
  const cover = curKey ? media.coverUrl || media.thumb || h?.thumb || "" : "";
  const now = {
    key: curKey,
    title: curKey ? media.title : "",
    artist: curKey ? media.artist || media.album || "" : "",
    playing: !!(media.available && media.playing),
    positionMs: Math.round(positionNow()),
    durationMs: media.durationMs || 0,
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
  const l = lyrics ? { key: lyrics.key, lines: lyrics.lines.map((x) => ({ t: x.t, text: x.text })) } : { key: keyOf(media), lines: [] };
  api.invoke("remote_lyrics", { lyrics: l }).catch(() => {});
}
// posição fresquinha a cada 1 s, e o volume do app de fora a cada 5 s
setInterval(() => pushRemote(), 1000);
setInterval(async () => {
  if (!settings.remote || !remoteInfo || isLocalVol()) return;
  try {
    const v = await api.invoke("get_volume", { source: media.available ? media.source || "" : "" });
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
renderService();
if (!IS_WALLPAPER) await migrateOldBackground();
await loadLibrary();
renderSettings();
applyTheme();
applyEq();
applyBackground();
render();

api.listen("media-update", onMedia);
if (!IS_WALLPAPER) {
  api.listen("hp-control", (m) => m?.action && remoteCommand(m));
  api.listen("hp-mini-ready", () => publishNow(true));
  api.listen("mini-mode", (on) => {
    $("#btnMini")?.classList.toggle("on", !!on);
    if (!on) miniAuto = false; // fechou pelo × do próprio mini
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
if (!IS_WALLPAPER && settings.wallpaperMode) {
  api.invoke("set_wallpaper_mode", { enabled: true }).catch(() => {
    settings.wallpaperMode = false;
    saveSettings();
    renderSettings();
  });
}

if (!IS_WALLPAPER && settings.visualizer) api.invoke("set_visualizer", { on: true }).catch(() => {});
if (!IS_WALLPAPER && settings.remote) setRemote(true, true);
if (!IS_WALLPAPER && settings.hotkeys) setHotkeys(true, true);
if (!IS_WALLPAPER) $("#swNotify").classList.toggle("on", settings.notify);
if (!IS_WALLPAPER) $("#swAutoMini").classList.toggle("on", settings.autoMini);
if (!IS_WALLPAPER) {
  renderExtras();
  if (settings.ducking) api.invoke("set_ducking", { on: true }).catch(() => {});
  if (settings.lyricsbar) setLyricsBar(true);
}

if (!IS_WALLPAPER) {
  setTimeout(() => checkUpdate(false), 4000);
  setInterval(() => checkUpdate(false), 6 * 3600e3);
}

requestAnimationFrame(frame);
