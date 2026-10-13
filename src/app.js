// Harle Player — front-end (HTML/CSS/JS puro, sem build).
// Dentro do app, fala com o Rust via window.__TAURI__.
// Aberto direto no navegador, roda em "modo demo" com dados de exemplo.

import { createPlayer } from "./player.js";
import { fmt, esc, rgbToHsl, hslToRgb, slotOf, cleanTitle, cleanArtist, lyricVariants, parseLrc, isPlaceholderTitle } from "./lib.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const T = window.__TAURI__;

const api = T
  ? {
      demo: false,
      invoke: (cmd, args) => T.core.invoke(cmd, args),
      listen: (ev, cb) => T.event.listen(ev, (e) => cb(e.payload)),
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
function setAccent(rgb) {
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
    if (paused || t - last < 40) return; // ~25 fps: leve pra GPU
    last = t;
    const w = auroraCanvas.width, h = auroraCanvas.height, s = t / 1000;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#04060d";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const x = (0.5 + 0.42 * Math.sin(s * 0.11 * b.sp + b.px)) * w;
      const y = (0.5 + 0.38 * Math.cos(s * 0.09 * b.sp + b.py)) * h;
      const r = b.r * Math.max(w, h) * (0.9 + 0.1 * Math.sin(s * 0.4 + b.px));
      const [R, G, B] = hslToRgb((((accentHue + b.dh) % 1) + 1) % 1, 0.75, b.l);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${R},${G},${B},0.55)`);
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
  const sig = JSON.stringify([tab, curKey, media.playing, info && [info.index, info.repeat, info.tracks.map((t) => t.qid + (t.user ? "u" : "") + (t.url ? "" : "?"))],
    tab === "recentes" && history.map((h) => h.key + !!h.thumb), tab === "playlists" && (pl ? [pl.id, pl.name, pl.tracks.length, pl.tracks.map((t) => t.title)] : playlists.map((p) => [p.id, p.name, p.tracks.length])), creatingPlaylist]);
  if ((!force && sig === queueSig) || dragging || document.activeElement?.closest?.("#queue input")) return;
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
        <button class="q-tool" data-act="shuffle" title="Embaralhar as próximas">${ICON.shuffle}</button>
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
  } else if (pl) {
    tools.innerHTML = `
      <button class="q-tool" data-act="back" title="Voltar">${ICON.back}</button>
      <input class="pl-name" value="${esc(pl.name)}" maxlength="40" spellcheck="false" title="Clique pra renomear" />
      <button class="q-tool play" data-act="plplay" title="Tocar">${ICON.play}</button>
      <button class="q-tool" data-act="plshuffle" title="Tocar embaralhado">${ICON.shuffle}</button>
      <button class="q-tool" data-act="pldelete" title="Apagar playlist">${ICON.trash}</button>`;
    html = pl.tracks.length
      ? pl.tracks.map((t, i) => `<li data-pi="${i}" class="sortable" title="Tocar">${queueItemHtml(t, false, rmBtn(`data-prm="${i}"`))}</li>`).join("")
      : `<li class="q-empty">Playlist vazia.<br>Na busca, use <b>⋯</b> → <b>Adicionar à playlist</b>.</li>`;
    list.dataset.kind = "playlist";
  } else {
    tools.innerHTML = creatingPlaylist
      ? `<input class="pl-name" id="newPlName" placeholder="Nome da playlist" maxlength="40" spellcheck="false" />
         <button class="q-tool txt" data-act="create">Criar</button>`
      : `<button class="q-tool txt wide" data-act="new">${ICON.plus}Nova playlist</button>`;
    html = playlists.length
      ? playlists
          .map((p) => {
            const covers = p.tracks.map((t) => t.cover).filter(Boolean).slice(0, 4);
            const art = covers.length >= 4
              ? `<div class="q-cover mosaic">${covers.map((c) => `<img src="${esc(c)}" alt="" draggable="false">`).join("")}</div>`
              : covers.length ? `<img class="q-cover" src="${esc(covers[0])}" alt="" draggable="false">` : `<div class="q-cover pl-blank">${ICON.play}</div>`;
            return `<li data-pl="${esc(p.id)}" title="Abrir">${art}<div class="q-text"><div class="q-title">${esc(p.name)}</div><div class="q-artist">${p.tracks.length} ${p.tracks.length === 1 ? "música" : "músicas"}</div></div></li>`;
          })
          .join("")
      : creatingPlaylist ? "" : `<li class="q-empty">Nenhuma playlist ainda.</li>`;
    if (creatingPlaylist) setTimeout(() => $("#newPlName")?.focus(), 0);
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
    case "shuffle": q?.shuffle(); toast("Próximas embaralhadas"); break;
    case "repeat": {
      const r = q?.info().repeat;
      const nx = r === "off" ? "all" : r === "all" ? "one" : "off";
      q?.setRepeat(nx);
      toast(nx === "all" ? "Repetir a fila" : nx === "one" ? "Repetir esta música" : "Repetir desligado");
      break;
    }
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
  if (e.target.id === "newPlName") {
    if (e.key === "Enter") $("#qTools [data-act=create]")?.click();
    if (e.key === "Escape") { creatingPlaylist = false; e.target.blur(); renderQueue(true); }
  } else if (e.target.classList.contains("pl-name") && (e.key === "Enter" || e.key === "Escape")) e.target.blur();
});
$("#qTools").addEventListener("focusout", (e) => {
  if (!e.target.classList.contains("pl-name") || e.target.id === "newPlName") return;
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
});
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
    ${playlists.map((p) => `<button data-c="pl" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join("")}
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
      return;
    }
  }
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
function frame() {
  requestAnimationFrame(frame);
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
  searchTimer = setTimeout(() => runSearch(input.value), 380);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return;
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
  $("#swDiscordSpotify").classList.toggle("on", settings.discordSpotify);
  $("#segBrowser").innerHTML = ["soundcloud", "ytmusic", "youtube"]
    .map((id) => `<button data-v="${id}" class="${id === settings.browserService ? "sel" : ""}">${esc(SERVICES[id].name)}</button>`)
    .join("");
  renderLibrary();
}

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
$("#btnLyrics").addEventListener("click", toggleLyrics);

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
  } else if (e.key === "Escape") {
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
applyBackground();
render();

api.listen("media-update", onMedia);
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

if (!IS_WALLPAPER) {
  setTimeout(() => checkUpdate(false), 4000);
  setInterval(() => checkUpdate(false), 6 * 3600e3);
}

requestAnimationFrame(frame);
