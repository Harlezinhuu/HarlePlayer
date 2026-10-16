import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/party.js";

test("código de convite: formato e leitura flexível", () => {
  const c = P.makeCode();
  assert.match(c, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(P.normalizeCode(c.toLowerCase().replace(/-/g, " ")), c);
  assert.equal(P.normalizeCode("k7qm-2x9p-rt4w-h8na"), "K7QM-2X9P-RT4W-H8NA");
  assert.equal(P.normalizeCode("K7QM-2X9P-RT4W-H8NO"), "K7QM-2X9P-RT4W-H8N0"); // O vira 0
  assert.equal(P.normalizeCode("curto"), null);
});

test("sala e chave saem do código; o código não aparece no nome da sala", async () => {
  const a = await P.roomFromCode("K7QM-2X9P-RT4W-H8NA");
  const b = await P.roomFromCode("K7QM-2X9P-RT4W-H8NA");
  const c = await P.roomFromCode("K7QM-2X9P-RT4W-H8NB");
  assert.equal(a.topic, b.topic);
  assert.notEqual(a.topic, c.topic);
  assert.ok(!a.topic.includes("K7QM"));
  assert.match(a.topic, /^harle-[0-9a-f]{24}$/);
});

test("mensagem criptografada só abre com a chave certa", async () => {
  const room = await P.roomFromCode("K7QM-2X9P-RT4W-H8NA");
  const other = await P.roomFromCode("AAAA-BBBB-CCCC-DDDD");
  const msg = { type: "state", track: { title: "Lucid Dreams" }, playing: true };
  const sealed = await P.seal(room.key, msg);
  assert.ok(sealed.startsWith("hp1:"));
  assert.ok(!sealed.includes("Lucid"));
  assert.deepEqual(await P.open(room.key, sealed), msg);
  assert.equal(await P.open(other.key, sealed), null);
  assert.equal(await P.open(room.key, "lixo"), null);
});

test("mesma música e posição esperada", () => {
  assert.ok(P.sameSong({ title: "Lucid Dreams (Official Video)", artist: "Juice WRLD" }, { title: "lucid dreams", artist: "Juice WRLD, Marshmello" }));
  assert.ok(!P.sameSong({ title: "Bandit", artist: "Juice WRLD" }, { title: "Lucid Dreams", artist: "Juice WRLD" }));
  const st = { positionMs: 10000, playing: true, at: 1000, durationMs: 200000 };
  assert.equal(P.expectedPosition(st, 4000), 13000);
  assert.equal(P.expectedPosition({ ...st, playing: false }, 4000), 10000);
});
