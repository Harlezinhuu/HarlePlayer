// Mini player: janelinha sempre por cima. Quem sabe o que está tocando é a
// janela principal — ela manda "hp-now" e recebe os comandos por "hp-control".
const T = window.__TAURI__;
const $ = (s) => document.querySelector(s);
const fmt = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

let now = { title: "", artist: "", playing: false, positionMs: 0, durationMs: 0, at: Date.now() };
let beat = 0, beatTarget = 0;

function apply(n) {
  if (!n) return;
  if (n.cover !== undefined) {
    if (n.cover) {
      $("#cover").src = n.cover;
      $("#bgArt").style.backgroundImage = `url("${n.cover.replace(/"/g, "%22")}")`;
    } else {
      $("#cover").removeAttribute("src");
      $("#bgArt").style.backgroundImage = "";
    }
  }
  if (n.accent) document.documentElement.style.setProperty("--accent", n.accent);
  now = { ...now, ...n, at: Date.now() };
  $("#title").textContent = now.title || "Nada tocando";
  $("#artist").textContent = now.title ? now.artist || "" : "Toque algo no Spotify, SoundCloud…";
  document.body.classList.toggle("playing", !!now.playing);
}

// O mini fica por cima do jogo: ~30 atualizações por segundo e só mexe no que mudou
// (antes rodava na taxa do monitor, 144x/s, e reescrevia tudo todo quadro).
let lastT = 0, lastTime = "", lastBeat = -1;
function frame(t) {
  requestAnimationFrame(frame);
  if (t - lastT < 31) return;
  lastT = t;
  const pos = now.playing ? now.positionMs + (Date.now() - now.at) : now.positionMs;
  const p = now.durationMs > 0 ? Math.min(1, pos / now.durationMs) : 0;
  $("#fill").style.transform = `scaleX(${p.toFixed(4)})`;
  const time = now.durationMs ? `${fmt(Math.min(pos, now.durationMs))} / ${fmt(now.durationMs)}` : "";
  if (time !== lastTime) $("#time").textContent = lastTime = time;
  beat += (beatTarget - beat) * (beatTarget > beat ? 0.5 : 0.12);
  if (beat < 0.004) beat = 0;
  if (Math.abs(beat - lastBeat) > 0.004) {
    lastBeat = beat;
    document.documentElement.style.setProperty("--beat", beat.toFixed(3));
  }
}
requestAnimationFrame(frame);

const send = (action) => T?.event.emit("hp-control", { action });
$("#play").onclick = () => send("toggle");
$("#next").onclick = () => send("next");
$("#prev").onclick = () => send("prev");
$("#expand").onclick = () => T?.core.invoke("show_main_window");
$("#close").onclick = () => T?.core.invoke("set_mini", { open: false });

if (T) {
  T.event.listen("hp-now", (e) => apply(e.payload));
  T.event.listen("audio-level", (e) => (beatTarget = Math.min(1, (e.payload?.[0] || 0) * 1.1)));
  T.event.emit("hp-mini-ready", {});
} else {
  // aberto no navegador: dados de exemplo
  apply({ title: "Neon Rain", artist: "Lumen Vale", playing: true, positionMs: 42000, durationMs: 196000, cover: null });
  setInterval(() => (beatTarget = Math.random() ** 3), 120);
}
