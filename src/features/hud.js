// Estilos de HUD: Clássica (carrossel), Vinil, Estúdio e Minimal.
// Vinil e Estúdio desenham o "tocando agora" no #hudScene; a Minimal mostra só
// relógio + cartão e revela a fila/barra quando o mouse chega perto.

export const HUDS = ["classic", "vinyl", "studio", "minimal"];

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initHud(app) {
  const { $, settings, esc, IS_WALLPAPER } = app;
  const scene = $("#hudScene");
  const lyr = $("#hsLyrics");
  let hud = "classic";
  let lyricsFor = null; // objeto `lyrics` já desenhado na lista
  let curLine = -2;
  let lastSec = -1;

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function apply() {
    hud = IS_WALLPAPER ? "classic" : HUDS.includes(settings.hud) ? settings.hud : "classic";
    for (const h of HUDS) document.body.classList.toggle(`hud-${h}`, h === hud);
    scene.hidden = !(hud === "vinyl" || hud === "studio");
    lyricsFor = null;
    curLine = -2;
    revealDock(false);
    revealQueue(false);
  }

  /** Troca de música / play / pause (vem do renderMini). */
  function update({ key, title, artist, cover, durationMs, playing }) {
    if (scene.hidden) return;
    $("#hsTitle").textContent = key ? title : "Nada tocando";
    $("#hsArtist").textContent = key ? artist || "" : "Escolha uma música na busca ou na fila";
    for (const id of ["#hsCover", "#hsLabel"]) {
      const img = $(id);
      if (cover) img.src = cover;
      else img.removeAttribute("src");
    }
    scene.classList.toggle("no-cover", !cover);
    $("#hsDur").textContent = key ? fmt(durationMs) : "";
    if (!key) {
      $("#hsCur").textContent = "";
      $("#hsFill").style.transform = "scaleX(0)";
    }
    scene.classList.toggle("is-playing", !!playing);
  }

  function drawLyrics(lyrics) {
    lyricsFor = lyrics;
    curLine = -2;
    const lines = lyrics?.lines?.filter((l) => l.text?.trim()) || [];
    if (!lines.length) {
      lyr.innerHTML = `<li class="hs-nolyr">Sem letra sincronizada pra essa música</li>`;
      lyr.style.transform = "";
      return;
    }
    lyr.innerHTML = lyrics.lines.map((l, i) => `<li data-l="${i}">${esc(l.text || "♪")}</li>`).join("");
  }

  /** ~30x por segundo (vem do frame): barra de progresso e letra do Estúdio. */
  function tick(pos, durationMs, lyrics, lyricsKey) {
    if (scene.hidden) return;
    const pct = durationMs > 0 ? Math.min(1, Math.max(0, pos / durationMs)) : 0;
    $("#hsFill").style.transform = `scaleX(${pct.toFixed(4)})`;
    const sec = Math.floor(pos / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      $("#hsCur").textContent = fmt(pos);
    }
    if (hud !== "studio") return;
    const L = lyrics && lyrics.key === lyricsKey ? lyrics : null;
    if (L !== lyricsFor) drawLyrics(L);
    if (!L) return;
    let idx = -1;
    for (let lo = 0, hi = L.lines.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (L.lines[mid].t <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === curLine) return;
    lyr.querySelector("li.cur")?.classList.remove("cur");
    curLine = idx;
    const li = idx >= 0 ? lyr.querySelector(`li[data-l="${idx}"]`) : null;
    li?.classList.add("cur");
    // centraliza a linha atual (transform: não recalcula o layout da tela)
    const box = lyr.parentElement.clientHeight;
    const y = li ? li.offsetTop + li.offsetHeight / 2 - box * 0.42 : 0;
    lyr.style.transform = `translateY(${-Math.max(0, y)}px)`;
  }

  // ---------- Minimal: fila e barra aparecem com o mouse perto ----------
  let dockTimer = 0, queueTimer = 0;
  function revealDock(on) {
    clearTimeout(dockTimer);
    if (on) document.body.classList.add("reveal-dock");
    else dockTimer = setTimeout(() => document.body.classList.remove("reveal-dock"), on === false ? 0 : 1200);
  }
  function revealQueue(on) {
    clearTimeout(queueTimer);
    if (on) document.body.classList.add("reveal-queue");
    else queueTimer = setTimeout(() => document.body.classList.remove("reveal-queue"), on === false ? 0 : 1200);
  }
  let moveQueued = false;
  addEventListener("mousemove", (e) => {
    if (hud !== "minimal" || moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => {
      moveQueued = false;
      const nearBottom = e.clientY > innerHeight - 150 || !!e.target.closest?.("#dock, #serviceMenu");
      const nearLeft = e.clientX < 90 || !!e.target.closest?.("#queue");
      if (nearBottom) revealDock(true);
      else if (document.body.classList.contains("reveal-dock")) revealDock(null);
      if (nearLeft) revealQueue(true);
      else if (document.body.classList.contains("reveal-queue")) revealQueue(null);
    });
  }, { passive: true });
  document.addEventListener("mouseleave", () => {
    if (hud !== "minimal") return;
    revealDock(null);
    revealQueue(null);
  });

  // clicar no cartão / capa abre o "tocando agora" da fila
  $("#nowCard").addEventListener("click", () => hud === "minimal" && revealQueue(true));

  return { apply, update, tick, get hud() { return hud; } };
}
