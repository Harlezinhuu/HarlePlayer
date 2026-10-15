import { test } from "node:test";
import assert from "node:assert/strict";
import * as Q from "../src/queue.js";

const T = (...names) => names.map((n) => Q.withQid({ title: n }));
const titles = (q) => q.tracks.map((t) => t.title).join(",");

test("tocar a seguir entra logo depois da atual", () => {
  const q = Q.insertNext({ tracks: T("a", "b", "c"), index: 0 }, { title: "x" });
  assert.equal(titles(q), "a,x,b,c");
  assert.equal(q.index, 0);
});

test("adicionar à fila vai depois das outras adicionadas, antes do resto", () => {
  let q = { tracks: T("a", "b", "c"), index: 0 };
  q = Q.enqueue(q, { title: "x" });
  q = Q.enqueue(q, { title: "y" });
  assert.equal(titles(q), "a,x,y,b,c");
  q = Q.insertNext(q, { title: "z" });
  assert.equal(titles(q), "a,z,x,y,b,c");
});

test("remover e arrastar mantêm a música atual", () => {
  let q = { tracks: T("a", "b", "c", "d"), index: 2 };
  q = Q.removeAt(q, 0);
  assert.equal(titles(q), "b,c,d");
  assert.equal(q.tracks[q.index].title, "c");
  assert.equal(Q.removeAt(q, q.index), q); // a atual não sai
  q = Q.moveItem(q, 2, 0);
  assert.equal(titles(q), "d,b,c");
  assert.equal(q.tracks[q.index].title, "c");
  q = Q.moveItem(q, 2, 0);
  assert.equal(q.tracks[q.index].title, "c");
  assert.equal(q.index, 0);
});

test("embaralhar não mexe na atual nem na fila do usuário", () => {
  let q = { tracks: T("a", "b", "c", "d", "e"), index: 0 };
  q = Q.enqueue(q, { title: "x" });
  const s = Q.shuffleUpcoming(q, () => 0);
  assert.equal(s.tracks[0].title, "a");
  assert.equal(s.tracks[1].title, "x");
  assert.deepEqual(s.tracks.slice(2).map((t) => t.title).sort(), ["b", "c", "d", "e"]);
  assert.notEqual(titles(s), titles(q));
});

test("próxima respeita repetir", () => {
  const q = { tracks: T("a", "b"), index: 1 };
  assert.equal(Q.nextIndex(q, "off", true), -1);
  assert.equal(Q.nextIndex(q, "all", true), 0);
  assert.equal(Q.nextIndex(q, "one", true), 1);
  assert.equal(Q.nextIndex(q, "one", false), -1); // apertar "próxima" pula mesmo no repetir 1
  assert.equal(Q.nextIndex({ tracks: [], index: -1 }), -1);
});

test("desligar o aleatório volta a ordem original", () => {
  const q0 = { tracks: T("a", "b", "c", "d", "e"), index: 0 };
  const order = q0.tracks.map((t) => t.qid);
  const s = Q.shuffleUpcoming(q0, () => 0.3);
  const back = Q.unshuffle(s, order);
  assert.equal(titles(back), "a,b,c,d,e");
  // uma música adicionada no meio do caminho vai pro fim
  const withNew = { tracks: [...s.tracks, ...T("z")], index: 0 };
  assert.equal(titles(Q.unshuffle(withNew, order)), "a,b,c,d,e,z");
});
