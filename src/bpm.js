// Descobre o BPM e onde cai a primeira batida, a partir das amostras do áudio.
// Ideia: envelope de "ataques" (subidas de energia) → autocorrelação pra achar
// o período → varre a fase pra alinhar com as batidas.

const HOP = 512;

/** Energia por janela e quanto ela subiu (só subidas contam). */
export function onsetEnvelope(samples, sampleRate) {
  const n = Math.floor(samples.length / HOP);
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    const o = i * HOP;
    for (let j = 0; j < HOP; j++) e += samples[o + j] * samples[o + j];
    e = Math.log1p(e * 100);
    env[i] = Math.max(0, e - prev);
    prev = e;
  }
  return { env, rate: sampleRate / HOP };
}

/**
 * { bpm, offset } — offset em segundos da primeira batida.
 * Restringe a 70–180 BPM (rap costuma ficar em 80–100 ou o dobro).
 */
export function detectBpm(samples, sampleRate, { min = 70, max = 180 } = {}) {
  const { env, rate } = onsetEnvelope(samples, sampleRate);
  if (env.length < rate * 4) return null;
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  // suaviza (picos finos + período "quebrado" em janelas não se encontram)
  const sm = new Float32Array(env.length);
  const K = [0.25, 0.6, 1, 0.6, 0.25];
  for (let i = 0; i < env.length; i++) {
    let v = 0;
    for (let k = -2; k <= 2; k++) v += (env[i + k] || 0) * K[k + 2];
    sm[i] = v;
  }
  const x = sm.map((v) => v - mean * 2.7);

  const lagMin = Math.floor((rate * 60) / max);
  const lagMax = Math.ceil((rate * 60) / min);
  const acCache = new Map();
  const ac = (lag) => {
    lag = Math.round(lag);
    if (acCache.has(lag)) return acCache.get(lag);
    let s = 0;
    for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
    s = lag < x.length ? s / (x.length - lag) : 0;
    acCache.set(lag, s);
    return s;
  };
  // tempo certo = o padrão se repete no tempo, a cada 2 tempos E a cada compasso.
  // Só olhar o 1º pico confunde com 3/4, 4/3 e o dobro (síncope do bumbo).
  const sc = (l) => 0.5 * ac(l) + ac(l * 2) + 1.5 * ac(l * 4);
  let best = 0, bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag += 0.25) {
    const s = sc(lag);
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag || best <= 0) return null;
  // 70 ou 140? (loop de 1 compasso a 140 = 2 compassos a 70) — se o dobro
  // explica quase tão bem, fica com o dobro (trap "meio-tempo" é 140)
  if ((60 * rate) / bestLag < 80 && bestLag / 2 >= lagMin && sc(bestLag / 2) >= 0.75 * best) bestLag /= 2;
  const lag = bestLag;
  let bpm = (60 * rate) / lag;
  // fora da faixa comum do rap: usa o dobro/metade
  if (bpm > 165 && bpm / 2 >= min) bpm /= 2;
  if (bpm < 68 && bpm * 2 <= max) bpm *= 2;

  // refino fino: testa BPMs vizinhos junto com a fase (pente de batidas);
  // o que alinhar mais ataques ao longo da música inteira ganha
  const comb = (b, ph) => {
    const period = (60 / b) * rate;
    let sum = 0, n = 0;
    for (let t = ph; t < env.length - 1; t += period) {
      const i = Math.round(t);
      sum += env[i] + 0.5 * ((env[i - 1] || 0) + (env[i + 1] || 0));
      n++;
    }
    return n ? sum / n : 0;
  };
  let bestPh = 0, bestSum = -1, bestBpm = bpm;
  for (let cand = bpm * 0.97; cand <= bpm * 1.03; cand += 0.05) {
    const period = (60 / cand) * rate;
    const steps = Math.max(16, Math.round(period * 2));
    for (let k = 0; k < steps; k++) {
      const ph = (k / steps) * period;
      const sum = comb(cand, ph);
      if (sum > bestSum) { bestSum = sum; bestPh = ph; bestBpm = cand; }
    }
  }
  bpm = bestBpm;
  // qual das 4 batidas é o "1" do compasso? a com ataque mais forte (bumbo)
  const period = (60 / bpm) * rate;
  let bar = 0, barSum = -1;
  for (let k = 0; k < 4; k++) {
    let sum = 0, n = 0;
    for (let t = bestPh + k * period; t < env.length - 1; t += period * 4) {
      const i = Math.round(t);
      sum += Math.max(env[i], env[i - 1] || 0, env[i + 1] || 0);
      n++;
    }
    if (n && sum / n > barSum) { barSum = sum / n; bar = k; }
  }
  return { bpm: Math.round(bpm * 10) / 10, offset: bestPh / rate, barOffset: (bestPh + bar * period) / rate };
}

/** Mistura canais e pega só um pedaço (análise rápida). */
export function monoSlice(audioBuffer, fromSec = 0, secs = 40) {
  const sr = audioBuffer.sampleRate;
  const a = Math.floor(fromSec * sr);
  const b = Math.min(audioBuffer.length, a + Math.floor(secs * sr));
  const out = new Float32Array(Math.max(0, b - a));
  const ch = audioBuffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = a; i < b; i++) out[i - a] += d[i] / ch;
  }
  return out;
}

/**
 * Agenda das palavras: a cada `barsPerWord` compassos (4 tempos) cai uma palavra.
 * Devolve o índice da palavra e quanto falta (em tempos) pra próxima.
 */
export function barClock(t, { bpm, offset = 0, barsPerWord = 2 }) {
  const beat = 60 / bpm;
  const beats = (t - offset) / beat;
  const per = barsPerWord * 4;
  if (beats < 0) return { index: -1, beatInBar: 0, beatsLeft: -beats, beats };
  const index = Math.floor(beats / per);
  const into = beats - index * per;
  return { index, beatInBar: Math.floor(into % 4), beatsLeft: per - into, beats };
}
