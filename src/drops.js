// Detecta batidas e o "drop" da música a partir do nível de grave (0–1, ~30x/s).
// Drop = o grave volta forte logo depois de um trecho bem mais calmo
// (a "subida"/breakdown), com um intervalo mínimo entre um drop e outro.

export function createDropDetector({ cooldownMs = 9000 } = {}) {
  const hist = []; // { t, v }
  let lastBeat = -1e9;
  let lastDrop = -1e9;
  const avg = (from, to) => {
    let s = 0, n = 0;
    for (const h of hist) if (h.t >= from && h.t < to) { s += h.v; n++; }
    return n ? s / n : 0;
  };
  return {
    /** Recebe o nível e a hora (ms); diz se foi batida e/ou drop. */
    feed(v, t) {
      hist.push({ t, v });
      while (hist.length && hist[0].t < t - 12000) hist.shift();
      const short = avg(t - 250, t + 1);
      const before = avg(t - 4500, t - 600); // o trecho logo antes
      const out = { beat: false, drop: false, short, before };
      if (short > 0.35 && short > before * 1.35 && t - lastBeat > 260) {
        out.beat = true;
        lastBeat = t;
      }
      const enoughHistory = hist.length && t - hist[0].t > 4000;
      if (enoughHistory && t - lastDrop > cooldownMs && short >= 0.55 && before < 0.4 && short > before * 2.2) {
        out.drop = true;
        lastDrop = t;
      }
      return out;
    },
  };
}
