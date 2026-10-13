// Testes das funções puras do front.  Rode com:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmt, esc, rgbToHsl, hslToRgb, slotOf, cleanTitle, cleanArtist, lyricVariants, parseLrc } from "../src/lib.js";

test("fmt formata milissegundos como m:ss", () => {
  assert.equal(fmt(0), "0:00");
  assert.equal(fmt(61_000), "1:01");
  assert.equal(fmt(239_999), "3:59");
  assert.equal(fmt(-500), "0:00");
});

test("esc escapa HTML", () => {
  assert.equal(esc(`<b>"Tom & Jerry's"</b>`), "&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;");
  assert.equal(esc(null), "");
});

test("rgbToHsl e hslToRgb vão e voltam", () => {
  for (const rgb of [[255, 0, 0], [30, 144, 255], [12, 200, 90], [128, 128, 128]]) {
    assert.deepEqual(hslToRgb(...rgbToHsl(...rgb)), rgb);
  }
});

test("slotOf distribui o carrossel: 0, +1, -1, +2, -2…", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(slotOf), [0, 1, -1, 2, -2, 3]);
});

test("cleanTitle tira o lixo de títulos do YouTube", () => {
  assert.equal(cleanTitle("Lucid Dreams (Official Music Video)"), "Lucid Dreams");
  assert.equal(cleanTitle("Robbery [Official Audio]"), "Robbery");
  assert.equal(cleanTitle("Música (feat. Alguém) (Clipe Oficial)"), "Música");
  assert.equal(cleanTitle("Song | Live at Home"), "Song");
  assert.equal(cleanTitle("Hello (Remix)"), "Hello (Remix)"); // remix fica
});

test("cleanArtist tira '- Topic', VEVO e participações", () => {
  assert.equal(cleanArtist("Juice WRLD - Topic"), "Juice WRLD");
  assert.equal(cleanArtist("JuiceWRLDVEVO"), "JuiceWRLD");
  assert.equal(cleanArtist("Juice WRLD, Halsey"), "Juice WRLD");
  assert.equal(cleanArtist("Juice WRLD feat. Halsey"), "Juice WRLD");
  assert.equal(cleanArtist("Xamã"), "Xamã");
});

test("lyricVariants tenta 'Artista - Música' de vídeo do YouTube", () => {
  const v = lyricVariants({ title: "Juice WRLD - Lucid Dreams (Official Video)", artist: "Juice WRLD" });
  assert.deepEqual(v[0], { title: "Juice WRLD - Lucid Dreams", artist: "Juice WRLD" });
  assert.deepEqual(v[1], { title: "Lucid Dreams", artist: "Juice WRLD" });

  const semArtista = lyricVariants({ title: "Lucid Dreams", artist: "" });
  assert.deepEqual(semArtista, [{ title: "Lucid Dreams", artist: "" }]);
});

test("parseLrc lê tempos e quebra os versos em pedaços", () => {
  const lines = parseLrc(["[00:10.00] I still see your shadows in my room", "[00:14.50]", "[00:15.00][01:00.00] Refrão"].join("\n"));
  assert.equal(lines.length, 4); // linha com 2 tempos vira 2
  assert.equal(lines[0].t, 10_000);
  assert.equal(lines[0].text, "I still see your shadows in my room");
  // pedaços de até 3 palavras / 15 letras, em ordem e dentro do verso
  const chunks = lines[0].chunks.map((c) => c.text);
  assert.deepEqual(chunks.join(" "), lines[0].text);
  assert.ok(chunks.every((c) => c.split(" ").length <= 3));
  assert.equal(lines[0].chunks[0].t, 10_000);
  assert.ok(lines[0].chunks.every((c, i, a) => i === 0 || c.t > a[i - 1].t));
  assert.ok(lines[0].chunks.at(-1).t < lines[1].t);
  // verso vazio (instrumental) não tem pedaços
  assert.equal(lines[1].chunks.length, 0);
  assert.equal(lines.at(-1).t, 60_000);
});

test("parseLrc aceita minutos com 3 dígitos e milissegundos", () => {
  const [l] = parseLrc("[100:02.345] fim");
  assert.equal(l.t, 100 * 60_000 + 2345);
});

import { isPlaceholderTitle } from "../src/lib.js";
test("reconhece o título genérico do navegador", () => {
  assert.ok(isPlaceholderTitle("Um site está com mídia aberta")); // visto no Chrome pt-BR
  assert.ok(isPlaceholderTitle("A site is playing media"));
  assert.ok(!isPlaceholderTitle("Lucid Dreams"));
  assert.ok(!isPlaceholderTitle(""));
});

import { sniffAudioType, youtubeId } from "../src/player.js";
test("player reconhece o formato do áudio baixado", () => {
  assert.equal(sniffAudioType(new Uint8Array([0x49, 0x44, 0x33, 4])), "audio/mpeg"); // ID3
  assert.equal(sniffAudioType(new Uint8Array([0xff, 0xfb, 0x90, 0])), "audio/mpeg");
  assert.equal(sniffAudioType(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69])), "audio/mp4");
  assert.equal(sniffAudioType(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0])), "audio/ogg");
});
test("player tira o id do vídeo do link do YouTube", () => {
  assert.equal(youtubeId("https://music.youtube.com/watch?v=mzB1VGEGcSU"), "mzB1VGEGcSU");
  assert.equal(youtubeId("https://www.youtube.com/watch?v=abc123&t=10"), "abc123");
  assert.equal(youtubeId("https://youtu.be/xyz"), "xyz");
  assert.equal(youtubeId("não é link"), null);
});
