// Harle Player — front-end (HTML/CSS/JS puro, sem build).
// Dentro do app, fala com o Rust via window.__TAURI__.
// Aberto direto no navegador, roda em "modo demo" com dados de exemplo.

const $ = (s) => document.querySelector(s);
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
  lyricsOffset: 0, // segundos (+ adianta a letra)
  clock24: true,
  wallpaperMode: false, // wallpaper animado atrás dos ícones
  wallpaperId: "builtin:aurora",
  pauseFullscreen: true,
  pauseMaximized: false,
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
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
  return api.invoke("media_control", { action, positionMs }).catch((e) => toast(String(e)));
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
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}
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

// Pausa tudo (vídeo, aurora, animações) — usado quando um jogo está em tela cheia.
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

function queueItemHtml(item, now) {
  const cover = item.thumb ? `<img class="q-cover" src="${esc(item.thumb)}" alt="">` : `<div class="q-cover"></div>`;
  const eq = now ? `<div class="eq"><i></i><i></i><i></i></div>` : "";
  return `${cover}<div class="q-text"><div class="q-title">${esc(item.title)}</div><div class="q-artist">${esc(item.artist || "—")}</div></div>${eq}`;
}

function renderQueue() {
  const nowEl = $("#nowItem");
  const curKey = keyOf(media);
  if (curKey) {
    const h = history.find((x) => x.key === curKey);
    nowEl.innerHTML = queueItemHtml({ title: media.title, artist: media.artist, thumb: media.thumb || h?.thumb }, true);
  } else {
    nowEl.innerHTML = "";
  }
  const list = history.filter((h) => h.key !== curKey).slice(0, 14);
  $("#historyList").innerHTML = list
    .map((h, i) => `<li data-i="${i}" title="Abrir no ${esc(SERVICES[settings.service].name)}">${queueItemHtml(h, false)}</li>`)
    .join("");
  $("#historyList").onclick = (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const h = list[+li.dataset.i];
    openInService(`${h.title} ${h.artist}`.trim());
  };
}
$("#nowItem").addEventListener("click", () => control("toggle"));

// ===================================================================
// Carrossel 3D
// ===================================================================
const carousel = $("#carousel");
const cardEls = new Map();
let carouselItems = [];

const slotOf = (i) => (i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2); // 0, +1, -1, +2, -2…

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
    openInService(`${it.title} ${it.artist}`.trim());
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
  $("#miniTitle").textContent = curKey ? media.title : "Nada tocando";
  const svc = curKey ? playingService() : "";
  const via = svc && svc !== "other" ? serviceName(svc) : "";
  $("#miniArtist").textContent = curKey
    ? [media.artist || media.album, via].filter(Boolean).join(" · ")
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
const NOISE = /\s*[\(\[][^\)\]]*\b(official|video|vídeo|audio|áudio|lyrics?|letra|clipe|visuali[sz]er|hd|4k|remaster(ed)?|ao vivo|live|explicit|feat\.?|ft\.?|prod\.?)\b[^\)\]]*[\)\]]/gi;
const cleanTitle = (t) => t.replace(NOISE, "").replace(/\s*\|.*$/, "").replace(/\s+/g, " ").trim();
const cleanArtist = (a) =>
  a.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").replace(/\s+(x|feat\.?|ft\.?)\s+.*$/i, "").replace(/\s*[,&].*$/, "").trim();

function lyricVariants(s) {
  const out = [];
  const base = { title: cleanTitle(s.title), artist: cleanArtist(s.artist || "") };
  // Vídeo do YouTube no navegador costuma vir como "Artista - Música"
  const dash = s.title.indexOf(" - ");
  const split = dash > 0 ? { artist: cleanArtist(s.title.slice(0, dash)), title: cleanTitle(s.title.slice(dash + 3)) } : null;
  if (base.artist) out.push(base);
  if (split) out.push(split);
  if (!base.artist && !split) out.push(base);
  return out;
}

function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!tags.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of tags) {
      lines.push({ t: +m[1] * 60000 + parseFloat(m[2].replace(":", ".")) * 1000, text: body });
    }
  }
  lines.sort((a, b) => a.t - b.t);

  // Quebra cada verso em pedaços de 1–3 palavras (igual o efeito do vídeo),
  // distribuindo o tempo do verso pelo tamanho de cada pedaço.
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1].t : L.t + 5000;
    const span = Math.max(400, Math.min(next - L.t, 8000));
    const words = L.text.split(/\s+/).filter(Boolean);
    const groups = [];
    let cur = [];
    for (const w of words) {
      const len = [...cur, w].join(" ").length;
      if (cur.length && (cur.length >= 3 || len > 15)) {
        groups.push(cur.join(" "));
        cur = [];
      }
      cur.push(w);
    }
    if (cur.length) groups.push(cur.join(" "));
    const total = groups.reduce((n, g) => n + g.length, 0) || 1;
    let acc = 0;
    L.chunks = groups.map((g) => {
      const c = { t: L.t + span * 0.92 * (acc / total), text: g };
      acc += g.length;
      return c;
    });
    L.end = L.t + span;
  }
  return lines;
}

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

let shownText = "";
let swapTimer;
function showChunk(text) {
  if (text === shownText) return;
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
  if (settings.lyrics) showChunk(currentChunk(pos + settings.lyricsOffset * 1000));
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
  $("#resNote").textContent = "";
  $("#resTracks").innerHTML = skeleton(7);
  $("#resArtists").innerHTML = skeleton(7, "round");

  let res = null;
  let note = "";
  if (NATIVE_SEARCH[svc]) {
    try {
      res = await api.invoke("search_music", { service: NATIVE_SEARCH[svc], query: q });
    } catch (e) {
      note = `${SERVICES[svc].name} não respondeu, mostrando resultados do Deezer.`;
      console.warn("busca nativa falhou:", e);
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
            `<div class="res-tile" data-t="${i}" title="Abrir no ${svcName}">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy" draggable="false">` : `<div class="sk"></div>`}<b>${esc(t.title)}</b><span>${esc(t.artist)}${t.durationMs ? ` · ${fmt(t.durationMs)}` : ""}</span></div>`,
        )
        .join("")
    : `<div class="res-empty">Nada encontrado. Enter abre a busca direto no ${svcName}.</div>`;
  $("#resArtists").innerHTML = artists.length
    ? artists
        .map(
          (a, i) =>
            `<div class="res-tile" data-a="${i}" title="Abrir no ${svcName}">${a.picture ? `<img src="${esc(a.picture)}" alt="" loading="lazy" draggable="false">` : `<div class="sk"></div>`}<b>${esc(a.name)}</b></div>`,
        )
        .join("")
    : `<div class="res-empty">—</div>`;

  const open = (query, url) => {
    if (direct && url) {
      api.invoke("open_url", { url: fixUrl(url) }).then(() => toast(`Abrindo no ${SERVICES[svc].name}…`)).catch((e) => toast(String(e)));
    } else {
      openInService(query);
    }
  };
  $("#resTracks").onclick = (e) => {
    const el = e.target.closest("[data-t]");
    if (!el) return;
    const t = tracks[+el.dataset.t];
    open(`${t.title} ${t.artist}`, t.url);
  };
  $("#resArtists").onclick = (e) => {
    const el = e.target.closest("[data-a]");
    if (!el) return;
    const a = artists[+el.dataset.a];
    open(a.name, a.url);
  };
}

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
    if (!$("#results").hidden && $("#resTracks .res-empty")) openInService(q);
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
  $("#swPauseFull").classList.toggle("on", settings.pauseFullscreen);
  $("#swPauseMax").classList.toggle("on", settings.pauseMaximized);
  $("#offVal").textContent = `${settings.lyricsOffset > 0 ? "+" : ""}${settings.lyricsOffset.toFixed(1).replace(".", ",")} s`;
  $("#btnLyrics").classList.toggle("on", settings.lyrics);
  document.body.classList.toggle("no-lyrics", !settings.lyrics);
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
$("#swPauseFull").addEventListener("click", () => {
  settings.pauseFullscreen = !settings.pauseFullscreen;
  saveSettings();
  renderSettings();
});
$("#swPauseMax").addEventListener("click", () => {
  settings.pauseMaximized = !settings.pauseMaximized;
  saveSettings();
  renderSettings();
});
const discordChanged = () => {
  saveSettings();
  renderSettings();
  renderMini();
  discordSig = "";
  scheduleDiscord();
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
$("#segBrowser").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  settings.browserService = b.dataset.v;
  discordChanged();
});
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
  const strict = artist ? `artist:"${artist}" track:"${title}"` : title;
  let r = await httpJson(`https://api.deezer.com/search?q=${enc(strict)}&limit=1`);
  if (!r?.data?.length) r = await httpJson(`https://api.deezer.com/search?q=${enc(`${artist} ${title}`.trim())}&limit=1`);
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
  const cover = await coverUrlFor(title, artist);
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
        url: serviceWeb(svc, `${title} ${artist}`.trim()) || null,
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
  renderMini();
  renderQueue();
  renderCarousel();
}

function onMedia(s) {
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
  // Janela do wallpaper: pausa com jogo em tela cheia e recarrega quando o player muda algo.
  api.listen("desktop-state", (st) =>
    setPaused(!!((settings.pauseFullscreen && st.fullscreen) || (settings.pauseMaximized && st.maximized))),
  );
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

requestAnimationFrame(frame);
