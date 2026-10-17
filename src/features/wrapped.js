// Retrospectiva ("seu Wrapped"): conta o que você ouve, de qualquer app

import * as Stats from "../stats.js";
import { recordWrappedVideo, DURATION as VIDEO_SECONDS } from "../wrappedVideo.js";
import { esc, cleanTitle, cleanArtist, isNonMusic } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initWrapped(app) {
  const { $, $$, api, IS_WALLPAPER, store, SERVICES, serviceName, keyOf, toast, shrinkImage, playingService } = app;
  let stats = Stats.emptyStats();
  try {
    stats = { ...Stats.emptyStats(), ...(store.get("hp.stats", null) || {}) };
  } catch {}
  let statsDirty = false;
  // tira o que entrou antes do filtro (gravações de jogo, "Riot Client"…)
  if (!IS_WALLPAPER && Stats.forget(stats, (m) => isNonMusic(m))) {
    try { store.set("hp.stats", stats); } catch {}
  }
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
    const h = app.history.find((x) => x.key === key);
    let c = app.media.coverUrl && /^https:/.test(app.media.coverUrl) ? app.media.coverUrl : null;
    if (!c && (h?.thumb || app.media.thumb)) c = await shrinkImage(h?.thumb || app.media.thumb, 96);
    statsCover.set(key, c);
    return c;
  }

  if (!IS_WALLPAPER) {
    setInterval(async () => {
      const key = keyOf(app.media);
      if (!key || !app.media.playing || app.media.loading) return;
      if (session.key !== key) Object.assign(session, { key, sec: 0, counted: false });
      session.sec++;
      const cover = stats.meta[key]?.cover ? null : await smallCover(key);
      Stats.record(stats, { key, title: app.media.title, artist: app.media.artist, service: playingService(), cover }, 1);
      const need = app.media.durationMs > 0 ? Math.min(30, app.media.durationMs / 2000) : 30;
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

  let shareMode = "image";
  let videoResult = null;
  function setShareMode(mode) {
    shareMode = mode;
    $("#shareSave").textContent = mode === "video" ? "Salvar vídeo" : "Salvar imagem";
    $("#shareCopy").hidden = mode === "video";
    $("#shareStatus").textContent = "";
  }

  /** Trecho da sua música nº 1 (procura no SoundCloud e baixa); null = usa a batida gerada. */
  async function topSongAudio(t) {
    if (!t || api.demo) return null;
    try {
      const res = await api.invoke("search_music", { service: "soundcloud", query: `${cleanTitle(t.title)} ${cleanArtist(t.artist || "")}`.trim() });
      const url = res?.tracks?.[0]?.url;
      if (!url) return null;
      const buf = await api.invoke("soundcloud_audio", { url });
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(new Uint8Array(buf).buffer);
      ctx.close();
      return audio.duration > VIDEO_SECONDS + 5 ? audio : null;
    } catch {
      return null;
    }
  }

  $("#wrVideo").addEventListener("click", async () => {
    const { from, to, label } = Stats.periodRange(wrPeriod);
    const r = Stats.summarize(stats, from, to);
    if (!r.totalSec) return;
    $("#wrVideo").disabled = true;
    setShareMode("video");
    videoResult = null;
    $("#shareModal").hidden = false;
    $("#shareModal").classList.add("recording");
    try {
      $("#shareStatus").textContent = "Preparando (capas e um trecho da sua nº 1)…";
      await document.fonts?.ready;
      const [artistImg, ...trackImgs] = await Promise.all([loadImg(r.artists[0]?.cover), ...r.tracks.slice(0, 5).map((t) => loadImg(t.cover))]);
      const audio = await topSongAudio(r.tracks[0]);
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").split(",").map((x) => +x || 0);
      videoResult = await recordWrappedVideo(
        $("#shareCanvas"),
        { summary: r, label, accent, images: { artist: artistImg, tracks: trackImgs }, audio, serviceName },
        (t) => ($("#shareStatus").textContent = `Gravando o vídeo… ${Math.min(VIDEO_SECONDS, Math.floor(t))}/${VIDEO_SECONDS} s${audio ? " · com a sua nº 1 tocando" : ""}`),
      );
      $("#shareStatus").textContent = `Pronto! ${(videoResult.blob.size / 1048576).toFixed(1)} MB · ${videoResult.mime.includes("mp4") ? "MP4" : "WebM"}`;
    } catch (e) {
      $("#shareStatus").textContent = `Não deu pra gravar o vídeo: ${e?.message || e}`;
    } finally {
      $("#shareModal").classList.remove("recording");
      $("#wrVideo").disabled = false;
    }
  });

  $("#wrShare").addEventListener("click", async () => {
    $("#wrShare").disabled = true;
    setShareMode("image");
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
    if (shareMode === "video") return saveVideo();
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
  async function saveVideo() {
    if (!videoResult) return;
    const ext = videoResult.mime.includes("mp4") ? "mp4" : "webm";
    const name = `harle-wrapped-${Stats.dayKey(new Date())}`;
    const data = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(videoResult.blob);
    });
    if (api.demo) {
      // (link de blob: o tipo "video/mp4;codecs=avc1…,mp4a…" tem vírgula e quebra um link data:)
      const a = document.createElement("a");
      a.href = URL.createObjectURL(videoResult.blob);
      a.download = `${name}.${ext}`;
      a.click();
      return;
    }
    try {
      const path = await api.invoke("save_video", { name, dataBase64: data });
      toast(`Vídeo salvo em ${path}`, 5000);
    } catch (e) {
      toast(`Não consegui salvar: ${e}`, 4000);
    }
  }

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

  return {
    get stats() { return stats; },};
}
