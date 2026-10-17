import { test } from "node:test";
import assert from "node:assert/strict";
import { RHYMES, createPicker, pickTheme, seeded } from "../src/rhymes.js";
import { detectBpm, barClock } from "../src/bpm.js";

test("bancos de rima: famílias com pelo menos 4 palavras, sem repetição", () => {
  for (const lang of ["pt", "en"]) {
    for (const lvl of ["easy", "hard"]) {
      for (const fam of RHYMES[lang][lvl]) {
        assert.ok(fam.length >= 4, `${lang}/${lvl}: ${fam[0]}`);
        assert.equal(new Set(fam).size, fam.length, `repetida em ${fam[0]}`);
      }
    }
    assert.ok(RHYMES[lang].themes.length >= 10);
  }
});

test("sorteio não repete palavra nem família seguida", () => {
  const p = createPicker("pt", "mix", seeded(7));
  const seen = [];
  let lastFam = null;
  for (let i = 0; i < 30; i++) {
    const { word, family } = p.next();
    assert.ok(family.includes(word));
    assert.notEqual(family, lastFam);
    assert.ok(!seen.slice(-12).includes(word), `repetiu ${word}`);
    seen.push(word);
    lastFam = family;
  }
});

test("inglês sai do banco em inglês, tema muda", () => {
  const p = createPicker("en", "hard", seeded(3));
  const all = RHYMES.en.hard.flat();
  for (let i = 0; i < 10; i++) assert.ok(all.includes(p.next().word));
  const r = seeded(5);
  const a = pickTheme("en", r);
  assert.notEqual(pickTheme("en", r, a), a);
});

function kicks(bpm, secs, sr = 22050, offset = 0.2) {
  const out = new Float32Array(secs * sr);
  const beat = 60 / bpm;
  for (let t = offset; t < secs; t += beat) {
    const i0 = Math.floor(t * sr);
    for (let j = 0; j < sr * 0.08 && i0 + j < out.length; j++) {
      out[i0 + j] += Math.sin((2 * Math.PI * 60 * j) / sr) * Math.exp(-j / (sr * 0.02));
    }
  }
  // chimbal fraquinho no contratempo + ruído
  for (let t = offset + beat / 2; t < secs; t += beat) {
    const i0 = Math.floor(t * sr);
    for (let j = 0; j < 200 && i0 + j < out.length; j++) out[i0 + j] += (Math.random() - 0.5) * 0.15;
  }
  for (let i = 0; i < out.length; i++) out[i] += (Math.random() - 0.5) * 0.01;
  return out;
}

for (const bpm of [85, 92, 120, 140]) {
  test(`detecta ${bpm} BPM e a fase`, () => {
    const r = detectBpm(kicks(bpm, 30), 22050);
    assert.ok(r, "sem resultado");
    assert.ok(Math.abs(r.bpm - bpm) < 2, `achou ${r.bpm}`);
    const beat = 60 / bpm;
    const ph = ((r.offset - 0.2) % beat + beat) % beat;
    assert.ok(Math.min(ph, beat - ph) < 0.05, `fase errada: ${r.offset}`);
  });
}

test("acha o 1 do compasso (bumbo mais forte)", () => {
  const sr = 22050, bpm = 90, beat = 60 / bpm, out = new Float32Array(20 * sr);
  for (let n = 0; n * beat + 0.3 < 20; n++) {
    const amp = n % 4 === 2 ? 1 : 0.35; // o "1" é a 3ª batida a partir de 0,3 s
    const i0 = Math.floor((0.3 + n * beat) * sr);
    for (let j = 0; j < sr * 0.08 && i0 + j < out.length; j++) out[i0 + j] += amp * Math.sin((2 * Math.PI * 60 * j) / sr) * Math.exp(-j / (sr * 0.02));
  }
  const r = detectBpm(out, sr);
  const bar = beat * 4;
  const d = (((r.barOffset - (0.3 + 2 * beat)) % bar) + bar) % bar;
  assert.ok(Math.min(d, bar - d) < 0.05, `1 em ${r.barOffset}`);
});

test("silêncio não inventa BPM", () => {
  assert.equal(detectBpm(new Float32Array(22050 * 10), 22050), null);
});

test("relógio dos compassos", () => {
  const o = { bpm: 90, offset: 1, barsPerWord: 2 };
  assert.equal(barClock(0.5, o).index, -1);
  assert.equal(barClock(1, o).index, 0);
  // 8 tempos a 90 BPM = 5,333 s
  assert.equal(barClock(1 + 5.4, o).index, 1);
  assert.ok(Math.abs(barClock(1 + 4, o).beatsLeft - 2) < 1e-9);
});

import { MODES, levelAt, alignToTap, tapTempo, looksInstrumental, stepTime, STYLES } from "../src/freestyle.js";

test("modos: desafio é mais rápido e endurece", () => {
  assert.ok(MODES.desafio.barsPerWord < MODES.treino.barsPerWord);
  assert.equal(levelAt("treino", 100), "easy");
  assert.equal(levelAt("desafio", 10), "mix");
  assert.equal(levelAt("desafio", 40), "hard");
});

test("aperte no 1: alinha o compasso no toque", () => {
  // 120 BPM → compasso de 2 s; toque em 7,3 s
  const off = alignToTap(7.3, 120, 0);
  assert.ok(Math.abs((((7.3 - off) % 2) + 2) % 2) < 1e-9);
  // toque um pouquinho antes do 1 (5,9 s) corrige pouco, não 1,9 s
  assert.ok(Math.abs(alignToTap(5.9, 120, 0) - -0.1) < 1e-9);
});

test("tap tempo ignora toque errado", () => {
  const taps = [0, 0.5, 1.0, 1.5, 1.8, 2.5, 3.0];
  assert.equal(tapTempo(taps), 120);
  assert.equal(tapTempo([0, 1]), null);
});

test("reconhece instrumental pelo nome", () => {
  assert.ok(looksInstrumental("Racionais - Negro Drama (Instrumental)"));
  assert.ok(looksInstrumental("[FREE] Drake Type Beat 2024"));
  assert.ok(!looksInstrumental("Negro Drama"));
});

test("estilos do beat: 16 passos e swing só no contratempo", () => {
  for (const s of Object.values(STYLES)) for (const k of ["k", "s", "h"]) assert.equal(s[k].length, 16);
  assert.equal(stepTime(4, 120, 0.2), 0.5);
  assert.ok(stepTime(1, 120, 0.2) > 0.125);
});
