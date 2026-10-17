// Funções puras (sem tela, sem Tauri) — separadas pra poder testar com `node --test`.

export const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function rgbToHsl(r, g, b) {
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
export function hslToRgb(h, s, l) {
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

export const slotOf = (i) => (i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2); // 0, +1, -1, +2, -2…

export const NOISE = /\s*[\(\[][^\)\]]*\b(official|video|vídeo|audio|áudio|lyrics?|letra|clipe|visuali[sz]er|hd|4k|remaster(ed)?|ao vivo|live|explicit|feat\.?|ft\.?|prod\.?)\b[^\)\]]*[\)\]]/gi;
export const cleanTitle = (t) => t.replace(NOISE, "").replace(/\s*\|.*$/, "").replace(/\s+/g, " ").trim();
export const cleanArtist = (a) =>
  a.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").replace(/\s+(x|feat\.?|ft\.?)\s+.*$/i, "").replace(/\s*[,&].*$/, "").trim();

export function lyricVariants(s) {
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

export function parseLrc(text) {
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

// Quando o site não informa a música, o navegador manda um texto genérico.
const PLACEHOLDER = /^(um site está (com mídia aberta|reproduzindo)|a site is (playing|using) (media|audio)|un sitio (está reproduciendo|tiene)|une? site)/i;
export const isPlaceholderTitle = (t) => PLACEHOLDER.test(String(t || "").trim());

// ---------- o que não é música (jogo, gravação de tela, vídeo) ----------
// Jogos, launchers e gravadores: nunca contam como música.
const GAME_APPS = /riot|valorant|league ?of ?legends|leagueclient|steam|epic ?games|battle\.?net|xboxapp|gamebar|medal|\bobs|streamlabs|geforce|nvidia|shadowplay|outplayed|overwolf|minecraft|roblox|fortnite|counter-?strike|\bcs2\b/i;
// Players de vídeo: só contam se o arquivo tiver artista (mp3 no VLC conta; gravação não).
const VIDEO_APPS = /zunevideo|movies|filmes|photos|fotos|clipchamp|vlc|potplayer|mpc-?(hc|be)|\bmpv\b|kmplayer|gom ?player|media ?player ?classic/i;
// Título com cara de arquivo de vídeo/gravação: "Valorant 2026.03.21 - 21.30.45.01", "clip.mp4"…
const FILE_LIKE = /\.(mp4|mkv|mov|avi|webm|wmv|flv|m4v|ts)$|\b(19|20)\d\d[.\-_](0[1-9]|1[0-2])[.\-_](0[1-9]|[12]\d|3[01])\b|^(clip|replay|highlight|recording|gravação|captura)\b/i;

/** Sessão de mídia que não é música (não entra em Recentes, retrospectiva, Discord…). */
export function isNonMusic({ title = "", artist = "", source = "" } = {}) {
  const t = String(title).trim(), a = String(artist || "").trim(), src = String(source || "");
  if (!t) return false;
  if (GAME_APPS.test(src)) return true;
  if (a) return false;
  return VIDEO_APPS.test(src) || FILE_LIKE.test(t) || GAME_APPS.test(t);
}
