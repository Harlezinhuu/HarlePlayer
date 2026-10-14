import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/stats.js";

const at = (iso) => new Date(iso);
const lucid = { key: "lucid|juice", title: "Lucid Dreams", artist: "Juice WRLD", service: "spotify" };
const bandit = { key: "bandit|juice", title: "Bandit", artist: "Juice WRLD, NBA YoungBoy", service: "soundcloud" };
const glass = { key: "glass|kairo", title: "Glass Hours", artist: "Kairo Blue", service: "ytmusic" };

test("soma tempo, vezes, horário e serviço", () => {
  const s = S.emptyStats();
  S.record(s, lucid, 120, at("2026-10-14T22:10:00"));
  S.countPlay(s, lucid.key, at("2026-10-14T22:10:30"));
  S.record(s, lucid, 60, at("2026-10-15T09:00:00"));
  S.countPlay(s, lucid.key, at("2026-10-15T09:00:30"));
  S.record(s, bandit, 200, at("2026-10-15T22:30:00"));
  S.countPlay(s, bandit.key, at("2026-10-15T22:31:00"));
  S.record(s, glass, 30, at("2026-10-15T23:00:00"));
  const r = S.summarize(s);
  assert.equal(r.totalSec, 410);
  assert.equal(r.plays, 3);
  assert.equal(r.activeDays, 2);
  assert.equal(r.tracks[0].title, "Lucid Dreams"); // 2 vezes
  assert.equal(r.tracks[0].plays, 2);
  assert.equal(r.artists[0].name, "Juice WRLD"); // junta "Juice WRLD, NBA YoungBoy"
  assert.equal(r.artists[0].sec, 380);
  assert.equal(r.peakHour, 22);
  assert.deepEqual(r.services.map((x) => x.svc), ["soundcloud", "spotify", "ytmusic"]);
});

test("período filtra os dias", () => {
  const s = S.emptyStats();
  S.record(s, lucid, 100, at("2026-01-02T10:00:00"));
  S.record(s, glass, 50, at("2026-10-14T10:00:00"));
  const { from, to } = S.periodRange("7d", at("2026-10-14T12:00:00"));
  assert.equal(from, "2026-10-08");
  assert.equal(to, "2026-10-14");
  const r = S.summarize(s, from, to);
  assert.equal(r.totalSec, 50);
  assert.equal(S.periodRange("year", at("2026-10-14T12:00:00")).from, "2026-01-01");
});

test("artista principal e limpeza", () => {
  assert.equal(S.mainArtist("Juice WRLD, Marshmello"), "Juice WRLD");
  assert.equal(S.mainArtist("Travis Scott feat. Drake"), "Travis Scott");
  assert.equal(S.mainArtist("Lil Nas X"), "Lil Nas X");
  assert.equal(S.mainArtist("Simon & Garfunkel"), "Simon & Garfunkel");
  assert.equal(S.mainArtist("Juice WRLD x Marshmello"), "Juice WRLD"); // o "X" do nome não é separador
  const s = S.emptyStats();
  S.record(s, lucid, 10, at("2024-01-01T10:00:00"));
  S.record(s, glass, 10, at("2026-10-14T10:00:00"));
  S.prune(s, 400, at("2026-10-14T12:00:00"));
  assert.deepEqual(Object.keys(s.days), ["2026-10-14"]);
  assert.deepEqual(Object.keys(s.meta), [glass.key]);
});
