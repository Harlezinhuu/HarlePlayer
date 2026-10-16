import { test } from "node:test";
import assert from "node:assert/strict";
import { createDropDetector } from "../src/drops.js";

// "música" falsa: lista de [segundos, nível]; o detector recebe 30 amostras/s
function run(parts, opts) {
  const d = createDropDetector(opts);
  const drops = [];
  let beats = 0, t = 0;
  for (const [secs, level, wobble = 0] of parts) {
    for (let i = 0; i < secs * 30; i++) {
      const v = Math.max(0, Math.min(1, level + (wobble ? Math.sin(t / 80) * wobble : 0)));
      const r = d.feed(v, t);
      if (r.drop) drops.push(Math.round(t / 100) / 10);
      if (r.beat) beats++;
      t += 1000 / 30;
    }
  }
  return { drops, beats };
}

test("drop depois de um trecho calmo", () => {
  const { drops } = run([[10, 0.6, 0.15], [5, 0.15], [6, 0.9]]);
  assert.equal(drops.length, 1);
  assert.ok(drops[0] >= 15 && drops[0] < 15.6, `drop em ${drops[0]}s`);
});

test("música sempre forte ou sempre calma não tem drop", () => {
  assert.equal(run([[30, 0.7, 0.2]]).drops.length, 0);
  assert.equal(run([[30, 0.15, 0.1]]).drops.length, 0);
});

test("dois drops respeitam o intervalo mínimo", () => {
  const { drops } = run([[6, 0.6], [5, 0.1], [3, 0.95], [1, 0.1], [3, 0.95]], { cooldownMs: 9000 });
  assert.equal(drops.length, 1); // o segundo veio rápido demais
  const two = run([[6, 0.6], [5, 0.1], [4, 0.95], [6, 0.1], [4, 0.95]], { cooldownMs: 9000 }).drops;
  assert.equal(two.length, 2);
});

test("batidas: grave pulsando gera várias", () => {
  const parts = [];
  for (let i = 0; i < 20; i++) parts.push([0.1, 0.9], [0.4, 0.2]);
  assert.ok(run(parts).beats >= 10);
});
