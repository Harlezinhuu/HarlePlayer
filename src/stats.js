// Estatísticas de escuta ("seu Wrapped") — funções puras, guardadas no próprio PC.
// Formato: { v, days: { "2026-10-14": { t: { key: [segundos, vezes] }, h: [24 × segundos], s: { serviço: segundos } } },
//            meta: { key: { title, artist, cover, service } } }

export const emptyStats = () => ({ v: 1, days: {}, meta: {} });

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function day(stats, date) {
  const k = dayKey(date);
  return (stats.days[k] ||= { t: {}, h: Array(24).fill(0), s: {} });
}

/** Soma `seconds` de escuta da música agora. */
export function record(stats, track, seconds, date = new Date()) {
  if (!track?.key || !(seconds > 0)) return stats;
  const d = day(stats, date);
  const row = (d.t[track.key] ||= [0, 0]);
  row[0] += seconds;
  d.h[date.getHours()] += seconds;
  const svc = track.service || "other";
  d.s[svc] = (d.s[svc] || 0) + seconds;
  const m = (stats.meta[track.key] ||= { title: track.title, artist: track.artist || "" });
  m.title = track.title || m.title;
  m.artist = track.artist || m.artist;
  if (track.service) m.service = track.service;
  if (track.cover) m.cover = track.cover;
  return stats;
}

/** Conta uma "vez que ouviu" (chamado depois de 30 s na mesma música). */
export function countPlay(stats, key, date = new Date()) {
  const d = day(stats, date);
  (d.t[key] ||= [0, 0])[1] += 1;
  return stats;
}

/** Primeiro artista de "A, B & C feat. D". */
export function mainArtist(a) {
  // "&" não separa (dupla tipo "Simon & Garfunkel"); "x" só com nome dos dois lados ("Lil Nas X" fica inteiro)
  return (a || "").split(/\s*(?:,|;|\/|\bfeat\.?\s|\bft\.?\s|\bwith\s)\s*|\s+x\s+(?=\S)/i)[0].trim();
}

/** Resumo de um período (datas inclusivas, "AAAA-MM-DD"). */
export function summarize(stats, from = "0000-00-00", to = "9999-99-99") {
  const tracks = new Map();
  const hours = Array(24).fill(0);
  const services = {};
  let totalSec = 0, plays = 0, activeDays = 0;
  for (const [k, d] of Object.entries(stats.days)) {
    if (k < from || k > to) continue;
    activeDays++;
    for (const [key, [sec, n]] of Object.entries(d.t)) {
      const t = tracks.get(key) || { key, sec: 0, plays: 0 };
      t.sec += sec;
      t.plays += n;
      tracks.set(key, t);
      totalSec += sec;
      plays += n;
    }
    d.h.forEach((s, i) => (hours[i] += s));
    for (const [svc, s] of Object.entries(d.s)) services[svc] = (services[svc] || 0) + s;
  }
  const list = [...tracks.values()]
    .map((t) => ({ ...t, ...(stats.meta[t.key] || { title: t.key, artist: "" }) }))
    // mais vezes primeiro; empate → mais tempo
    .sort((a, b) => b.plays - a.plays || b.sec - a.sec);
  const artists = new Map();
  for (const t of list) {
    const name = mainArtist(t.artist);
    if (!name) continue;
    const a = artists.get(name.toLowerCase()) || { name, sec: 0, plays: 0, cover: null, tracks: 0 };
    a.sec += t.sec;
    a.plays += t.plays;
    a.tracks++;
    if (!a.cover && t.cover) a.cover = t.cover;
    artists.set(name.toLowerCase(), a);
  }
  const peakHour = totalSec ? hours.indexOf(Math.max(...hours)) : -1;
  return {
    totalSec,
    plays,
    activeDays,
    tracks: list,
    artists: [...artists.values()].sort((a, b) => b.sec - a.sec || b.plays - a.plays),
    services: Object.entries(services).map(([svc, sec]) => ({ svc, sec })).sort((a, b) => b.sec - a.sec),
    hours,
    peakHour,
  };
}

/** Tira dias velhos e músicas que não aparecem mais em nenhum dia. */
export function prune(stats, keepDays = 400, today = new Date()) {
  const limit = new Date(today);
  limit.setDate(limit.getDate() - keepDays);
  const min = dayKey(limit);
  for (const k of Object.keys(stats.days)) if (k < min) delete stats.days[k];
  const used = new Set();
  for (const d of Object.values(stats.days)) for (const key of Object.keys(d.t)) used.add(key);
  for (const key of Object.keys(stats.meta)) if (!used.has(key)) delete stats.meta[key];
  return stats;
}

/** Intervalo de datas de cada período da tela. */
export function periodRange(period, today = new Date()) {
  const to = dayKey(today);
  const back = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (n - 1));
    return dayKey(d);
  };
  if (period === "7d") return { from: back(7), to, label: "Últimos 7 dias" };
  if (period === "30d") return { from: back(30), to, label: "Últimos 30 dias" };
  if (period === "year") return { from: `${today.getFullYear()}-01-01`, to, label: `${today.getFullYear()}` };
  return { from: "0000-00-00", to, label: "Desde o começo" };
}
