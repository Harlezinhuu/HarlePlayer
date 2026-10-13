// Modo demo: usado quando o index.html é aberto direto no navegador
// (fora do app). Simula músicas, letra e busca com dados fictícios,
// só pra visualizar e mexer no visual sem precisar compilar.

function cover(h1, h2, shape, seed) {
  const shapes = {
    sun: `<circle cx="150" cy="170" r="70" fill="url(#g2)"/><rect x="0" y="210" width="300" height="90" fill="rgba(0,0,0,.35)"/>`,
    rings: `<g fill="none" stroke="rgba(255,255,255,.55)" stroke-width="3">${[30, 55, 80, 105, 130].map((r) => `<circle cx="150" cy="150" r="${r}"/>`).join("")}</g>`,
    wave: `<path d="M0 190 Q75 120 150 190 T300 190 V300 H0Z" fill="url(#g2)"/><path d="M0 230 Q75 170 150 230 T300 230 V300 H0Z" fill="rgba(0,0,0,.3)"/>`,
    grid: `<g stroke="rgba(255,255,255,.35)">${Array.from({ length: 9 }, (_, i) => `<line x1="${i * 37.5}" y1="150" x2="${150 + (i - 4) * 90}" y2="300"/>`).join("")}${[170, 200, 240, 290].map((y) => `<line x1="0" y1="${y}" x2="300" y2="${y}"/>`).join("")}</g><circle cx="150" cy="110" r="46" fill="url(#g2)"/>`,
    blob: `<path d="M150 60 C220 60 250 120 230 170 C210 230 160 250 110 230 C60 210 50 150 80 110 C100 80 120 60 150 60Z" fill="url(#g2)"/>`,
    bars: Array.from({ length: 7 }, (_, i) => `<rect x="${40 + i * 33}" y="${200 - ((i * 37 + seed) % 110)}" width="18" height="${60 + ((i * 37 + seed) % 110)}" rx="9" fill="rgba(255,255,255,.8)"/>`).join(""),
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${h1}"/><stop offset="1" stop-color="${h2}"/></linearGradient><linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="${h1}" stop-opacity=".6"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>${shapes[shape]}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const TRACKS = [
  { title: "Neon Rain", artist: "Lumen Vale", album: "Midnight Static", durationMs: 196000, thumb: cover("#1d4ed8", "#0b1230", "rings", 3) },
  { title: "Glass Hours", artist: "Kairo Blue", album: "Glass Hours", durationMs: 172000, thumb: cover("#f97316", "#7c1d6f", "sun", 9) },
  { title: "Paper Satellites", artist: "Mira Sol", album: "Orbit", durationMs: 205000, thumb: cover("#14b8a6", "#0f172a", "grid", 4) },
  { title: "Low Tide Signals", artist: "Nox & Ivy", album: "Shoreline", durationMs: 188000, thumb: cover("#6366f1", "#ec4899", "wave", 7) },
  { title: "Velvet Static", artist: "Juno Park", album: "Velvet", durationMs: 214000, thumb: cover("#e11d48", "#1e1b4b", "blob", 2) },
  { title: "Blue Hour Drive", artist: "Atlas Ren", album: "Night Roads", durationMs: 179000, thumb: cover("#0ea5e9", "#312e81", "bars", 5) },
  { title: "Static Bloom", artist: "Sora Lin", album: "Bloom", durationMs: 201000, thumb: cover("#a3e635", "#14532d", "rings", 8) },
];

const DEMO_LRC = [
  [0, "♪"],
  [4, "City lights are melting in the rain"],
  [9.5, "I keep your echo running through my veins"],
  [15, "Neon signs spelling out your name"],
  [20.5, "Every street feels like a different frame"],
  [26, "Hold on, hold on, don't let the night go"],
  [31.5, "We were glowing brighter than the radio"],
  [37, "Neon rain, neon rain"],
  [42, "Wash me clean and start again"],
];
const lrc = (offset) =>
  DEMO_LRC.map(([t, text]) => {
    const s = t + offset;
    return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}] ${text}`;
  }).join("\n");

// 6 s de um "acorde" baixinho em WAV, pra testar o player interno sem internet.
function toneWav(seconds) {
  const rate = 8000, n = rate * seconds;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const s = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t)) / 3;
    v.setInt16(44 + i * 2, s * 3000, true);
  }
  return buf;
}

export function createDemoApi() {
  const listeners = {};
  let idx = 0;
  let state = {
    available: true, ...TRACKS[0], source: "Chrome", service: "soundcloud", playing: true,
    positionMs: 13000, updatedAtMs: Date.now(),
  };
  const emit = () => (listeners["media-update"] || []).forEach((cb) => cb({ ...state }));
  const pos = () => state.positionMs + (state.playing ? Date.now() - state.updatedAtMs : 0);
  const go = (i) => {
    idx = (i + TRACKS.length) % TRACKS.length;
    state = { ...state, ...TRACKS[idx], positionMs: 0, updatedAtMs: Date.now(), playing: true };
    emit();
  };

  // histórico de exemplo
  try {
    if (!localStorage.getItem("hp.history")) {
      localStorage.setItem("hp.history", JSON.stringify(TRACKS.slice(1).map((t) => ({ key: `${t.title}␟${t.artist}`, title: t.title, artist: t.artist, album: t.album, thumb: t.thumb }))));
    }
  } catch {}

  return {
    demo: true,
    listen(ev, cb) {
      (listeners[ev] ||= []).push(cb);
      return Promise.resolve(() => {});
    },
    async invoke(cmd, args = {}) {
      switch (cmd) {
        case "get_media":
          return { ...state, positionMs: pos(), updatedAtMs: Date.now() };
        case "media_control":
          if (args.action === "toggle") state = { ...state, positionMs: pos(), updatedAtMs: Date.now(), playing: !state.playing };
          if (args.action === "next") go(idx + 1);
          if (args.action === "prev") go(idx - 1);
          if (args.action === "seek") state = { ...state, positionMs: args.positionMs, updatedAtMs: Date.now() };
          emit();
          return;
        case "http_get": {
          await new Promise((r) => setTimeout(r, 450));
          if (args.url.includes("lrclib.net/api/get")) return JSON.stringify({ syncedLyrics: lrc(0) });
          if (args.url.includes("lrclib.net")) return "[]";
          if (args.url.includes("/search/artist")) {
            return JSON.stringify({ data: TRACKS.map((t) => ({ name: t.artist, picture_medium: t.thumb })) });
          }
          if (args.url.includes("api.deezer.com/search")) {
            return JSON.stringify({ data: [...TRACKS, ...TRACKS].map((t) => ({ title: t.title, artist: { name: t.artist }, album: { cover_medium: t.thumb } })) });
          }
          return "null";
        }
        case "search_music": {
          await new Promise((r) => setTimeout(r, 600));
          return {
            source: args.service,
            tracks: [...TRACKS, ...TRACKS].map((t) => ({ title: `${t.title} (remix)`, artist: t.artist, cover: t.thumb, url: args.service === "ytmusic" ? "https://music.youtube.com/" : "https://soundcloud.com/", durationMs: t.durationMs })),
            artists: TRACKS.map((t) => ({ name: t.artist, picture: t.thumb, url: "https://soundcloud.com/" })),
          };
        }
        case "check_update":
          return { available: location.search.includes("update"), current: "0.3.0", latest: "0.4.0", url: "https://github.com/Harlezinhuu/HarlePlayer/releases/download/0.4.0/x_x64-setup.exe" };
        case "install_update":
          await new Promise((r) => setTimeout(r, 800));
          throw new Error("demo: não instala de verdade");
        case "youtube_audio":
        case "soundcloud_audio": {
          await new Promise((r) => setTimeout(r, 500));
          return toneWav(6);
        }
        case "discord_set":
          console.log("[demo] discord", JSON.stringify(args.presence));
          return;
        case "open_url":
          console.log("[demo] abrir", args.url);
          return;
        default:
          return;
      }
    },
  };
}
