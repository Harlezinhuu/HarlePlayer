// Retrospectiva em vídeo (1080×1920, ~22 s), estilo stories do Wrapped:
// cenas animadas num <canvas> + música (trecho da sua nº 1, ou uma batida
// gerada na hora), gravadas com MediaRecorder.

export const DURATION = 22;

const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3));
const clamp01 = (t) => Math.max(0, Math.min(1, t));
/** 0→1 entre a e b (segundos). */
const seg = (t, a, b) => clamp01((t - a) / (b - a));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function cover(ctx, im, x, y, s, r) {
  ctx.save();
  roundRect(ctx, x, y, s, s, r);
  ctx.clip();
  if (im) {
    const m = Math.min(im.width, im.height);
    ctx.drawImage(im, (im.width - m) / 2, (im.height - m) / 2, m, m, x, y, s, s);
  } else {
    ctx.fillStyle = "rgba(255,255,255,.12)";
    ctx.fillRect(x, y, s, s);
  }
  ctx.restore();
}
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** Batida lo-fi gerada (sem direitos autorais), caso a nº 1 não possa tocar. */
export function synthBeat(actx, dest, seconds) {
  const t0 = actx.currentTime + 0.05;
  const bpm = 92, beat = 60 / bpm;
  const master = actx.createGain();
  master.gain.value = 0.6;
  master.connect(dest);
  const chords = [[220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 311.1]];
  for (let i = 0; t0 + i * beat < t0 + seconds; i++) {
    const t = t0 + i * beat;
    // bumbo nos tempos 1 e 3, caixa (ruído) no 2 e 4
    if (i % 2 === 0) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.25);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.4);
    } else {
      const n = actx.createBufferSource(), g = actx.createGain(), f = actx.createBiquadFilter();
      const b = actx.createBuffer(1, actx.sampleRate * 0.2, actx.sampleRate);
      const d = b.getChannelData(0);
      for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
      n.buffer = b;
      f.type = "highpass";
      f.frequency.value = 1800;
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      n.connect(f).connect(g).connect(master);
      n.start(t);
    }
    // acorde a cada 2 compassos
    if (i % 8 === 0) {
      const ch = chords[(i / 8) % chords.length];
      const lp = actx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 900;
      lp.connect(master);
      for (const f of ch) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = "triangle";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.07, t + 0.4);
        g.gain.linearRampToValueAtTime(0, t + beat * 8);
        o.connect(g).connect(lp);
        o.start(t);
        o.stop(t + beat * 8 + 0.1);
      }
    }
  }
  return master;
}

/**
 * Grava o vídeo. data: { summary, label, accent:[r,g,b], images: { artist, tracks[] }, audio: AudioBuffer|null, serviceName(id) }
 * onProgress(segundos). Devolve { blob, mime }.
 */
export async function recordWrappedVideo(canvas, data, onProgress = () => {}) {
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = 1080), H = (canvas.height = 1920);
  const { summary: r, label, accent: [ar, ag, ab], images } = data;
  const A = (a = 1) => `rgba(${ar},${ag},${ab},${a})`;
  const P = 90;
  const blobs = Array.from({ length: 5 }, (_, i) => ({ x: Math.random(), y: Math.random(), s: 0.35 + Math.random() * 0.3, ph: i * 1.3 }));

  function draw(t) {
    // fundo: manchas de cor andando devagar
    ctx.fillStyle = "#06070d";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const x = (b.x + 0.12 * Math.sin(t * 0.4 + b.ph)) * W, y = (b.y + 0.1 * Math.cos(t * 0.33 + b.ph)) * H;
      const g = ctx.createRadialGradient(x, y, 0, x, y, b.s * W);
      g.addColorStop(0, A(0.32));
      g.addColorStop(1, A(0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.textAlign = "left";

    // 1) abertura
    if (t < 3) {
      const k = ease(seg(t, 0, 1.1)), out = 1 - seg(t, 2.4, 3);
      ctx.globalAlpha = out;
      ctx.fillStyle = "#fff";
      ctx.font = "800 150px Inter, sans-serif";
      ctx.fillText("MEU", P, 760 - (1 - k) * 80);
      ctx.fillText("HARLE", P, 920 - (1 - k) * 60);
      ctx.fillStyle = A();
      ctx.fillText("WRAPPED", P, 1080 - (1 - k) * 40);
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.font = "600 46px Inter, sans-serif";
      ctx.fillText(label, P, 1170);
      ctx.globalAlpha = 1;
    }
    // 2) minutos subindo
    else if (t < 6.5) {
      const k = ease(seg(t, 3, 5.2)), out = 1 - seg(t, 6, 6.5);
      ctx.globalAlpha = out;
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "700 44px Inter, sans-serif";
      ctx.fillText("VOCÊ OUVIU", P, 720);
      ctx.fillStyle = "#fff";
      ctx.font = "800 230px Inter, sans-serif";
      ctx.fillText(Math.round((r.totalSec / 60) * k).toLocaleString("pt-BR"), P - 8, 960);
      ctx.fillStyle = A();
      ctx.font = "700 64px Inter, sans-serif";
      ctx.fillText("minutos de música", P, 1060);
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "500 40px Inter, sans-serif";
      ctx.fillText(`${r.plays.toLocaleString("pt-BR")} plays · ${r.tracks.length} músicas diferentes`, P, 1140);
      ctx.globalAlpha = 1;
    }
    // 3) artista nº 1
    else if (t < 10.5) {
      const a = r.artists[0];
      const k = ease(seg(t, 6.5, 7.6)), out = 1 - seg(t, 10, 10.5);
      ctx.globalAlpha = out;
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "700 44px Inter, sans-serif";
      ctx.fillText("SEU ARTISTA Nº 1", P, 470);
      const s = 560 * (0.7 + 0.3 * k);
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, 880, s / 2, 0, 6.283);
      ctx.clip();
      cover(ctx, images.artist, W / 2 - s / 2, 880 - s / 2, s, 0);
      ctx.restore();
      ctx.strokeStyle = A(0.9 * k);
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(W / 2, 880, s / 2 + 18, 0, 6.283 * k);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.font = "800 100px Inter, sans-serif";
      ctx.fillText(fit(ctx, a?.name || "—", W - P * 2), W / 2, 1310 + (1 - k) * 60);
      ctx.fillStyle = A();
      ctx.font = "600 48px Inter, sans-serif";
      ctx.fillText(a ? `${Math.round(a.sec / 60)} minutos juntos` : "", W / 2, 1390);
      ctx.globalAlpha = 1;
    }
    // 4) top 5 músicas, uma de cada vez
    else if (t < 16.5) {
      const out = 1 - seg(t, 16, 16.5);
      ctx.globalAlpha = out;
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "700 44px Inter, sans-serif";
      ctx.fillText("SUAS MÚSICAS MAIS OUVIDAS", P, 360);
      r.tracks.slice(0, 5).forEach((tr, i) => {
        const k = ease(seg(t, 10.7 + i * 0.75, 11.4 + i * 0.75));
        if (k <= 0) return;
        const y = 440 + i * 250;
        ctx.globalAlpha = out * k;
        const dx = (1 - k) * 300;
        ctx.fillStyle = i === 0 ? A() : "rgba(255,255,255,.55)";
        ctx.font = "800 80px Inter, sans-serif";
        ctx.fillText(String(i + 1), P + dx, y + 140);
        cover(ctx, images.tracks[i], P + 90 + dx, y + 30, 180, 22);
        ctx.fillStyle = "#fff";
        ctx.font = "700 54px Inter, sans-serif";
        ctx.fillText(fit(ctx, tr.title, W - P * 2 - 320), P + 310 + dx, y + 105);
        ctx.fillStyle = "rgba(255,255,255,.65)";
        ctx.font = "500 40px Inter, sans-serif";
        ctx.fillText(fit(ctx, `${tr.artist || "—"} · ${tr.plays}×`, W - P * 2 - 320), P + 310 + dx, y + 165);
      });
      ctx.globalAlpha = 1;
    }
    // 5) onde e quando
    else if (t < 19.8) {
      const k = ease(seg(t, 16.6, 17.8)), out = 1 - seg(t, 19.3, 19.8);
      ctx.globalAlpha = out;
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "700 44px Inter, sans-serif";
      ctx.fillText("ONDE VOCÊ OUVE", P, 560);
      const colors = { spotify: "#1ed760", soundcloud: "#ff7a1a", ytmusic: "#ff3b3b", youtube: "#ff0033", apple: "#fa3d5a", deezer: "#a238ff" };
      let x = P;
      const barW = W - P * 2;
      for (const sv of r.services) {
        const w = (sv.sec / r.totalSec) * barW * k;
        ctx.fillStyle = colors[sv.svc] || "#8b93a7";
        roundRect(ctx, x, 610, Math.max(0, w - 6), 70, 18);
        ctx.fill();
        x += w;
      }
      ctx.font = "600 42px Inter, sans-serif";
      r.services.slice(0, 3).forEach((sv, i) => {
        ctx.fillStyle = colors[sv.svc] || "#8b93a7";
        ctx.fillText(`● ${data.serviceName(sv.svc) || sv.svc}  ${Math.round((sv.sec / r.totalSec) * 100)}%`, P, 770 + i * 64);
      });
      if (r.peakHour >= 0) {
        const k2 = ease(seg(t, 17.6, 18.6));
        ctx.globalAlpha = out * k2;
        ctx.fillStyle = "rgba(255,255,255,.7)";
        ctx.font = "700 44px Inter, sans-serif";
        ctx.fillText("SEU HORÁRIO FAVORITO", P, 1150);
        ctx.fillStyle = "#fff";
        ctx.font = "800 200px Inter, sans-serif";
        ctx.fillText(`${r.peakHour}h`, P - 6, 1360);
      }
      ctx.globalAlpha = 1;
    }
    // 6) final
    else {
      const k = ease(seg(t, 19.8, 20.8));
      ctx.textAlign = "center";
      ctx.globalAlpha = k;
      ctx.fillStyle = "#fff";
      ctx.font = "800 120px Inter, sans-serif";
      ctx.fillText("Harle Player", W / 2, 900);
      ctx.fillStyle = A();
      ctx.font = "600 46px Inter, sans-serif";
      ctx.fillText(`${Math.round(r.totalSec / 60).toLocaleString("pt-BR")} min · ${label.toLowerCase()}`, W / 2, 990);
      ctx.fillStyle = "rgba(255,255,255,.6)";
      ctx.font = "500 38px Inter, sans-serif";
      ctx.fillText("github.com/Harlezinhuu/HarlePlayer", W / 2, 1700);
      ctx.globalAlpha = 1;
    }
    // barrinhas de progresso no topo (igual stories)
    const scenes = [0, 3, 6.5, 10.5, 16.5, 19.8, DURATION];
    const gw = (W - P * 2 - 5 * 10) / 6;
    for (let i = 0; i < 6; i++) {
      const x = P + i * (gw + 10);
      ctx.fillStyle = "rgba(255,255,255,.25)";
      roundRect(ctx, x, 70, gw, 8, 4);
      ctx.fill();
      ctx.fillStyle = "#fff";
      roundRect(ctx, x, 70, gw * seg(t, scenes[i], scenes[i + 1]), 8, 4);
      ctx.fill();
    }
  }

  // ---------- áudio ----------
  const actx = new AudioContext();
  const dest = actx.createMediaStreamDestination();
  const mon = actx.createGain(); // deixa ouvir enquanto grava
  mon.gain.value = 0.8;
  mon.connect(actx.destination);
  if (data.audio) {
    const src = actx.createBufferSource();
    src.buffer = data.audio;
    const g = actx.createGain();
    const now = actx.currentTime;
    const start = Math.min(Math.max(0, data.audio.duration * 0.35), Math.max(0, data.audio.duration - DURATION - 1));
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 1.2);
    g.gain.setValueAtTime(1, now + DURATION - 2);
    g.gain.linearRampToValueAtTime(0, now + DURATION);
    src.connect(g);
    g.connect(dest);
    g.connect(mon);
    src.start(now, start, DURATION + 0.5);
  } else {
    const m = synthBeat(actx, dest, DURATION);
    m.connect(mon);
  }

  // ---------- gravação ----------
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    .find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));
  rec.start(500);
  const t0 = performance.now();
  await new Promise((res) => {
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      draw(Math.min(t, DURATION));
      onProgress(t);
      if (t >= DURATION) return res();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  rec.stop();
  await done;
  actx.close();
  return { blob: new Blob(chunks, { type: rec.mimeType || mime || "video/webm" }), mime: rec.mimeType || mime };
}
