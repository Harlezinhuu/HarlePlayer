// Freestyle: regras dos modos, acerto do tempo e o beat próprio do app
// (bateria + baixo sintetizados na hora, sem arquivo nenhum).

export const MODES = {
  treino: { barsPerWord: 2, level: "easy", hints: true, roundSec: 0, themeEvery: 0 },
  desafio: { barsPerWord: 1, level: "mix", hints: false, roundSec: 60, themeEvery: 8 },
};

/** Desafio fica mais difícil com o tempo: depois de 30 s só rima difícil. */
export function levelAt(mode, elapsedSec) {
  const m = MODES[mode] || MODES.treino;
  if (mode === "desafio" && elapsedSec >= 30) return "hard";
  return m.level;
}

/**
 * "Aperte no 1": a pessoa toca no começo de um compasso; ajusta o offset
 * pra esse instante virar o início de um compasso (sem mudar o BPM).
 */
export function alignToTap(tapSec, bpm, offset) {
  const bar = (60 / bpm) * 4;
  const into = (((tapSec - offset) % bar) + bar) % bar;
  // tocou um pouco antes do 1 → puxa pra frente; um pouco depois → pra trás
  return into > bar / 2 ? offset + (into - bar) : offset + into;
}

/** BPM pelos toques (média dos intervalos, descarta toques muito fora). */
export function tapTempo(taps) {
  if (taps.length < 4) return null;
  const gaps = [];
  for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const ok = gaps.filter((g) => Math.abs(g - med) < med * 0.25);
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  return Math.round((60 / avg) * 10) / 10;
}

/** Instrumental de verdade? (senão o app tira a voz) */
export function looksInstrumental(title = "") {
  return /instrumental|type beat|\bbeat\b|karaok|playback|base de rap|\bbase\b|backing track|no vocals|sem voz/i.test(title);
}

// ---------------- beat do app ----------------
// 16 passos por compasso. k = bumbo, s = caixa, h = chimbal, b = baixo (grau da escala)
export const STYLES = {
  boombap: {
    name: "Boom bap", bpm: 90, swing: 0.12,
    k: "x.....x...x.....", s: "....x.......x...", h: "x.x.x.x.x.x.x.x.",
    bass: [[0, 0], [6, 0], [10, -2]], chords: [0, -4, -2, -5], wave: "triangle", bassLen: 0.35,
  },
  trap: {
    name: "Trap", bpm: 140, swing: 0,
    // meio-tempo: caixa só no 3º tempo; chimbal com "rolls"
    k: "x......x..x.....", s: "........x.......", h: "x.x.x.xxx.x.x.xx",
    bass: [[0, 0], [7, 0], [10, -2]], chords: [0, 0, -4, -2], wave: "sine", bassLen: 0.9,
  },
  lofi: {
    name: "Lo-fi", bpm: 80, swing: 0.2,
    k: "x.......x.x.....", s: "....x.......x..x", h: "x.xxx.x.x.xxx.x.",
    bass: [[0, 0], [8, 3], [11, -2]], chords: [0, -3, -5, -7], wave: "triangle", bassLen: 0.5,
  },
};

const ROOT = 55; // Lá (A1)
const MINOR = [0, 2, 3, 5, 7, 8, 10];
function degreeToSemis(d) {
  const o = Math.floor(d / 7);
  return MINOR[((d % 7) + 7) % 7] + o * 12;
}

/** Quando cai cada passo (s) a partir do início, com swing nos contratempos. */
export function stepTime(step, bpm, swing = 0) {
  const sixteenth = 60 / bpm / 4;
  const base = step * sixteenth;
  return step % 2 ? base + swing * sixteenth : base;
}

export function createBeat(ctx, dest) {
  let timer = 0, startAt = 0, nextStep = 0, style = STYLES.boombap, bpm = style.bpm;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(dest);
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  function env(g, t, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    env(g, t, 1, 0.42);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.45);
  }
  function snare(t) {
    const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = noise;
    f.type = "highpass";
    f.frequency.value = 1400;
    env(g, t, 0.55, 0.2);
    n.connect(f).connect(g).connect(out);
    n.start(t, Math.random() * 0.5, 0.25);
    const o = ctx.createOscillator(), g2 = ctx.createGain();
    o.frequency.value = 185;
    env(g2, t, 0.35, 0.09);
    o.connect(g2).connect(out);
    o.start(t);
    o.stop(t + 0.1);
  }
  function hat(t, accent) {
    const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = noise;
    f.type = "highpass";
    f.frequency.value = 7500;
    env(g, t, accent ? 0.2 : 0.09, 0.045);
    n.connect(f).connect(g).connect(out);
    n.start(t, Math.random() * 0.5, 0.06);
  }
  function bass(t, semis, len) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = style.wave;
    o.frequency.value = ROOT * Math.pow(2, semis / 12);
    f.type = "lowpass";
    f.frequency.value = 420;
    env(g, t, 0.5, len);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.05);
  }
  function pad(t, deg, len) {
    // acorde menor bem baixinho (dá "harmonia" pra rimar em cima)
    for (const d of [0, 2, 4]) {
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = "sawtooth";
      o.frequency.value = ROOT * 4 * Math.pow(2, degreeToSemis(deg + d) / 12);
      f.type = "lowpass";
      f.frequency.value = 900;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.028, t + 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + len);
      o.connect(f).connect(g).connect(out);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }

  function schedule(ahead = ctx.currentTime + 0.15) {
    const bar = (60 / bpm) * 4;
    for (;;) {
      const barIdx = Math.floor(nextStep / 16);
      const s = nextStep % 16;
      const t = startAt + barIdx * bar + stepTime(s, bpm, style.swing);
      if (t > ahead) break;
      if (t >= ctx.currentTime - 0.02) {
        const chord = style.chords[barIdx % style.chords.length];
        if (style.k[s] === "x") kick(t);
        if (style.s[s] === "x") snare(t);
        if (style.h[s] === "x") hat(t, s % 4 === 0);
        for (const [st, deg] of style.bass) if (st === s) bass(t, degreeToSemis(chord + deg), style.bassLen * (60 / bpm) * 2);
        if (s === 0) pad(t, chord, bar * 0.95);
      }
      nextStep++;
    }
  }

  return {
    /** Começa; devolve o instante (ctx) do primeiro compasso. */
    start(styleKey = "boombap", customBpm) {
      style = STYLES[styleKey] || STYLES.boombap;
      bpm = customBpm || style.bpm;
      clearInterval(timer);
      startAt = ctx.currentTime + 0.12;
      nextStep = 0;
      schedule();
      timer = setInterval(schedule, 25);
      return startAt;
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      setTimeout(() => out.disconnect(), 400);
    },
    /** Agenda tudo até `sec` de uma vez (render offline / testes). */
    fill(sec) { schedule(startAt + sec); },
    get bpm() { return bpm; },
    get startAt() { return startAt; },
  };
}
