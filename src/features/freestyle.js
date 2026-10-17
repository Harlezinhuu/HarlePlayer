// Freestyle: beat + palavra pra rimar no fim de cada frase (Treino / Desafio)

import * as Stats from "../stats.js";
import { createPicker, pickTheme } from "../rhymes.js";
import { detectBpm, barClock } from "../bpm.js";
import * as FS from "../freestyle.js";
import { fmt, esc, cleanTitle } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initFreestyle(app) {
  const { $, api, settings, saveSettings, keyOf, toast, control, player, toTrack, karaoke, setKaraokeMode, saveRecording } = app;
  const fs = {
    open: false, running: false, mode: "treino", lang: "pt", source: "app", style: "boombap", bpm: 90,
    pick: null, beat: null, clock: null, offset: 0, idx: -1, words: [], hits: 0, theme: "", startedAt: 0,
    raf: 0, tap: [], analyzer: null, chosen: null, results: [], prevRepeat: null, recTimer: 0, recAt: 0, inst: true,
  };
  {
    const saved = settings.freestyle || {};
    Object.assign(fs, { mode: saved.mode || "treino", lang: saved.lang || "pt", source: saved.source || "app", style: saved.style || "boombap", bpm: saved.bpm || 90 });
  }
  if (api.demo) window.__fs = fs;
  function fsSave() {
    settings.freestyle = { mode: fs.mode, lang: fs.lang, source: fs.source, style: fs.style, bpm: fs.bpm };
    saveSettings();
  }
  function fsRenderSetup() {
    for (const [id, v] of [["#fsMode", fs.mode], ["#fsLang", fs.lang], ["#fsSource", fs.source], ["#fsStyle", fs.style]]) {
      for (const b of $(id).querySelectorAll("button")) b.classList.toggle("sel", b.dataset.v === v);
    }
    $("#fsAppBeat").hidden = fs.source !== "app";
    $("#fsSongBeat").hidden = fs.source !== "song";
    const r = $("#fsBpm");
    r.value = fs.bpm;
    r.style.setProperty("--p", `${((fs.bpm - 70) / 80) * 100}%`);
    $("#fsBpmVal").textContent = fs.bpm;
    $("#fsStart").disabled = fs.source === "song" && !fs.chosen;
    $("#fsStart").textContent = fs.source === "song" && !fs.chosen ? "Escolha um beat na lista" : fs.mode === "desafio" ? "Começar desafio (1 min)" : "Começar treino";
  }
  function fsShow(which) {
    $("#fsSetup").hidden = which !== "setup";
    $("#fsStage").hidden = which !== "stage";
    $("#fsEnd").hidden = which !== "end";
  }
  function openFreestyle() {
    if (app.kOn) setKaraokeMode(false);
    fs.open = true;
    $("#freestyle").hidden = false;
    $("#btnFreestyle").classList.add("on");
    if (!$("#fsQuery").value && keyOf(app.media)) $("#fsQuery").value = cleanTitle(app.media.title || "");
    fsShow("setup");
    fsRenderSetup();
  }
  async function closeFreestyle() {
    await fsStop();
    fs.open = false;
    $("#freestyle").hidden = true;
    $("#btnFreestyle").classList.remove("on");
  }
  $("#btnFreestyle").addEventListener("click", () => (fs.open ? closeFreestyle() : openFreestyle()));
  $("#fsClose").addEventListener("click", closeFreestyle);
  for (const [id, key] of [["#fsMode", "mode"], ["#fsLang", "lang"], ["#fsSource", "source"], ["#fsStyle", "style"]]) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      fs[key] = b.dataset.v;
      if (key === "style") fs.bpm = FS.STYLES[fs.style].bpm;
      fsSave();
      fsRenderSetup();
    });
  }
  $("#fsBpm").addEventListener("input", (e) => {
    fs.bpm = +e.target.value;
    fsRenderSetup();
  });
  $("#fsBpm").addEventListener("change", fsSave);

  // busca do instrumental: YouTube Music + SoundCloud ao mesmo tempo
  $("#fsSearch").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#fsQuery").value.trim();
    if (!q) return;
    const box = $("#fsResults");
    box.innerHTML = `<p class="muted small">Procurando o instrumental…</p>`;
    fs.chosen = null;
    fsRenderSetup();
    const query = /instrumental|beat|base/i.test(q) ? q : `${q} instrumental`;
    const get = (svc) => api.invoke("search_music", { service: svc, query }).then((r) => (r?.tracks || []).slice(0, 6).map((t) => toTrack(t, svc))).catch(() => []);
    const [yt, sc] = await Promise.all([get("ytmusic"), get("soundcloud")]);
    const all = [...yt, ...sc];
    // instrumentais de verdade primeiro
    all.sort((a, b) => FS.looksInstrumental(b.title) - FS.looksInstrumental(a.title));
    fs.results = all.slice(0, 8);
    if (!fs.results.length) {
      box.innerHTML = `<p class="muted small">Não achei. Tenta outro nome, ou usa o beat do app.</p>`;
      return;
    }
    box.innerHTML = fs.results
      .map((t, i) => {
        const inst = FS.looksInstrumental(t.title);
        return `<button data-i="${i}">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ""}<span><b>${esc(t.title)}</b><br><span class="muted">${esc(t.artist)} · ${t.service === "soundcloud" ? "SoundCloud" : "YouTube"}</span></span><span class="tag${inst ? " inst" : ""}">${inst ? "instrumental" : "tira a voz"}</span></button>`;
      })
      .join("");
  });
  $("#fsResults").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    fs.chosen = fs.results[+b.dataset.i];
    for (const x of $("#fsResults").querySelectorAll("button")) x.classList.toggle("sel", x === b);
    fsRenderSetup();
  });
  $("#fsQuery").addEventListener("keydown", (e) => e.stopPropagation());

  /** Tempo atual (s) no relógio do beat. */
  function fsNow() {
    if (fs.source === "app") {
      const g = player?.audioGraph();
      if (!g || !fs.beat) return 0;
      return g.ctx.currentTime - (g.ctx.outputLatency || 0) - (g.ctx.baseLatency || 0) - fs.beat.startAt;
    }
    return (player?.state().positionMs || 0) / 1000;
  }

  /** Ouve o instrumental tocando e descobre BPM + onde cai a batida. */
  function fsStartAnalyzer() {
    const g = player.audioGraph();
    if (!g) return;
    const sr = g.ctx.sampleRate;
    const node = g.ctx.createScriptProcessor(4096, 1, 1);
    const mute = g.ctx.createGain();
    mute.gain.value = 0;
    const chunks = [];
    let startPos = null, total = 0, tries = 0;
    node.onaudioprocess = (ev) => {
      const st = player.state();
      if (!st.playing) return;
      const data = ev.inputBuffer.getChannelData(0);
      // descarta se pulou (pausa/seek) — recomeça a coleta
      const pos = st.positionMs / 1000 - data.length / sr;
      if (startPos !== null && Math.abs(pos - (startPos + total / sr)) > 0.6) {
        chunks.length = 0;
        total = 0;
        startPos = null;
      }
      if (startPos === null) startPos = pos;
      chunks.push(new Float32Array(data));
      total += data.length;
      const want = tries === 0 ? 8 : 24;
      if (total / sr >= want) {
        tries++;
        const all = new Float32Array(total);
        let o = 0;
        for (const c of chunks) { all.set(c, o); o += c.length; }
        // reduz a taxa pra análise ficar leve
        const step = Math.max(1, Math.round(sr / 22050));
        const small = new Float32Array(Math.floor(all.length / step));
        for (let i = 0; i < small.length; i++) small[i] = all[i * step];
        const r = detectBpm(small, sr / step);
        if (r) {
          const first = !fs.clock;
          fs.clock = { bpm: r.bpm, offset: startPos + r.barOffset };
          if (first) fsStartWords();
          fsRenderBpm();
        } else if (tries === 1) {
          $("#fsCount").textContent = "Não achei o ritmo sozinho: aperte T 4 vezes no tempo";
        }
        if (tries >= 2) fsStopAnalyzer();
      }
    };
    g.out.connect(node);
    node.connect(mute).connect(g.ctx.destination);
    fs.analyzer = { node, mute, out: g.out };
  }
  function fsStopAnalyzer() {
    const a = fs.analyzer;
    if (!a) return;
    fs.analyzer = null;
    a.node.onaudioprocess = null;
    try { a.out.disconnect(a.node); } catch {}
    try { a.node.disconnect(); a.mute.disconnect(); } catch {}
  }

  async function fsStart() {
    if (!player) return toast("O freestyle precisa do player interno");
    const m = FS.MODES[fs.mode];
    fs.pick = createPicker(fs.lang, m.level);
    fs.words = [];
    fs.hits = 0;
    fs.idx = -1;
    fs.clock = null;
    fs.tap = [];
    fs.theme = m.themeEvery ? pickTheme(fs.lang) : "";
    fs.level = FS.levelAt(fs.mode, 0);
    fs.running = true;
    fsRenderBpm();
    fs.startedAt = 0;
    fsShow("stage");
    $("#fsWord").textContent = fs.lang === "en" ? "Get ready" : "Prepara";
    $("#fsHints").textContent = "";
    $("#fsNext").textContent = "";
    $("#fsInfo").textContent = "";
    $("#fsTheme").innerHTML = fs.theme ? `${fs.lang === "en" ? "Topic" : "Tema"}: <b>${esc(fs.theme)}</b>` : "";
    // pausa o que estiver tocando fora (Spotify etc.) pra não embolar
    if (app.media.available && app.media.playing && !app.local) control("toggle");
    if (fs.source === "app") {
      if (player.active && app.local?.playing) player.toggle();
      const g = player.audioGraph();
      if (!g) return toast("Não consegui abrir o áudio");
      await g.ctx.resume();
      fs.beat = FS.createBeat(g.ctx, g.out);
      fs.beat.start(fs.style, fs.bpm);
      fs.clock = { bpm: fs.bpm, offset: 0 };
      if (!FS.MODES[fs.mode].roundSec) $("#fsInfo").textContent = `${FS.STYLES[fs.style].name} · ${fs.bpm} BPM`;
      fsStartWords();
    } else {
      const t = fs.chosen;
      fs.inst = FS.looksInstrumental(t.title);
      $("#fsCount").textContent = fs.lang === "en" ? "Loading the beat…" : "Carregando o beat…";
      await player.setKaraoke(true, fs.inst ? 1 : 0); // áudio passa pelo app (dá pra medir o ritmo)
      fs.prevRepeat = player.queue.info().repeat;
      player.playQueue([t], 0);
      player.queue.setRepeat("one"); // o beat fica em loop
      const until = Date.now() + 40000;
      while (fs.running && !player.state().playing && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      if (!fs.running) return;
      if (!player.state().playing) {
        toast("O beat não carregou. Tenta outro da lista ou o beat do app.", 4500);
        return fsStop().then(() => fsShow("setup"));
      }
      $("#fsCount").textContent = fs.lang === "en" ? "Listening to the beat…" : "Ouvindo o beat pra pegar o tempo…";
      fsStartAnalyzer();
    }
    cancelAnimationFrame(fs.raf);
    fs.raf = requestAnimationFrame(fsFrame);
  }
  function fsStartWords() {
    fs.startedAt = performance.now();
    fs.nextWord = fs.pick.next();
  }
  function fsNewWord(i) {
    const m = FS.MODES[fs.mode];
    const elapsed = (performance.now() - fs.startedAt) / 1000;
    const lvl = FS.levelAt(fs.mode, elapsed);
    if (lvl !== fs.level) {
      fs.level = lvl;
      const keep = fs.nextWord;
      fs.pick = createPicker(fs.lang, lvl);
      fs.nextWord = keep;
    }
    if (!fs.words.length) fs.startedAt = performance.now(); // o minuto do desafio conta da 1ª palavra
    const cur = fs.nextWord || fs.pick.next();
    // nunca a mesma da atual nem das últimas (o sorteador novo não lembra o histórico)
    const recent = fs.words.slice(-10).map((w) => w.word).concat(cur.word);
    let nx = fs.pick.next();
    for (let k = 0; k < 20 && recent.includes(nx.word); k++) nx = fs.pick.next();
    fs.nextWord = nx;
    fs.words.push({ word: cur.word, hit: false });
    fs.idx = i;
    const w = $("#fsWord");
    w.textContent = cur.word;
    w.classList.remove("pop", "hit");
    void w.offsetWidth;
    w.classList.add("pop");
    $("#fsHints").textContent = m.hints ? cur.family.filter((x) => x !== cur.word).slice(0, 4).join(" · ") : "";
    $("#fsNext").textContent = `${fs.lang === "en" ? "Next" : "Próxima"}: ${fs.nextWord.word}`;
    if (m.themeEvery && fs.words.length > 1 && (fs.words.length - 1) % m.themeEvery === 0) {
      fs.theme = pickTheme(fs.lang, Math.random, fs.theme);
      $("#fsTheme").innerHTML = `${fs.lang === "en" ? "New topic" : "Novo tema"}: <b>${esc(fs.theme)}</b>`;
    }
  }
  function fsFrame() {
    if (!fs.running) return;
    fs.raf = requestAnimationFrame(fsFrame);
    if (!fs.clock) return;
    const m = FS.MODES[fs.mode];
    const t = fsNow();
    const c = barClock(t, { ...fs.clock, barsPerWord: m.barsPerWord });
    const per = m.barsPerWord * 4;
    // contagem antes da primeira palavra: 1 compasso de aviso
    if (fs.idx < 0 && fs.words.length === 0) {
      const firstIdx = Math.max(1, c.index + 1);
      fs.firstIdx ??= firstIdx;
    }
    if (c.index >= (fs.firstIdx ?? 1) && c.index !== fs.idx) fsNewWord(c.index);
    const into = per - c.beatsLeft;
    const beatIn = Math.floor(((c.beats % 4) + 4) % 4);
    [...$("#fsBeats").children].forEach((d, i) => d.classList.toggle("on", i === beatIn && c.beats - Math.floor(c.beats) < 0.35));
    if (fs.idx < 0) {
      const left = Math.ceil(((fs.firstIdx ?? 1) * per - c.beats));
      $("#fsCount").textContent = left > 0 && left <= 4 ? `${fs.lang === "en" ? "Starts in" : "Começa em"} ${left}` : fs.lang === "en" ? "Feel the beat…" : "Sente o beat…";
      $("#fsBar i").style.width = "0%";
      return;
    }
    $("#fsBar i").style.width = `${Math.min(100, (into / per) * 100)}%`;
    $("#fsBar").classList.toggle("last", c.beatsLeft <= 4);
    $("#fsCount").textContent = c.beatsLeft <= 4 ? (fs.lang === "en" ? "Close it with:" : "Feche a frase com:") : fs.lang === "en" ? "Rhyme with:" : "Rime com:";
    if (m.roundSec) {
      const left = Math.max(0, m.roundSec - (performance.now() - fs.startedAt) / 1000);
      $("#fsInfo").textContent = `⏱ ${Math.ceil(left)}s · ${fs.hits}/${fs.words.length} ${fs.lang === "en" ? "rhymed" : "rimadas"}`;
      if (left <= 0) fsEnd();
    }
  }
  function fsHit() {
    const w = fs.words[fs.words.length - 1];
    if (!fs.running || !w || w.hit) return;
    w.hit = true;
    fs.hits++;
    $("#fsWord").classList.add("hit");
  }
  function fsTap() {
    if (!fs.running) return;
    const t = fsNow();
    const wall = performance.now() / 1000;
    // toques seguidos no tempo (4+) redefinem o BPM; um toque só acerta o "1"
    if (fs.tap.length && wall - fs.tap[fs.tap.length - 1].wall > 2.5) fs.tap = [];
    fs.tap.push({ t, wall });
    if (fs.tap.length > 8) fs.tap.shift();
    const bpm = FS.tapTempo(fs.tap.map((x) => x.t));
    if (!fs.clock) {
      $("#fsCount").textContent = bpm ? `${bpm} BPM` : `${fs.tap.length}/4…`;
      if (bpm) {
        fs.clock = { bpm, offset: fs.tap[0].t };
        fsStopAnalyzer();
        fsStartWords();
        fsRenderBpm();
      }
      return;
    }
    if (bpm && Math.abs(bpm - fs.clock.bpm) / fs.clock.bpm > 0.04) {
      fs.clock = { bpm, offset: fs.tap[0].t };
      fsStopAnalyzer();
      fsRenderBpm();
      toast(`${bpm} BPM ${fs.lang === "en" ? "from your taps" : "pelos seus toques"}`, 1600);
      return;
    }
    fs.clock = { ...fs.clock, offset: FS.alignToTap(t, fs.clock.bpm, fs.clock.offset) };
    if (fs.tap.length === 1) toast(fs.lang === "en" ? "Synced to your tap" : "Tempo acertado no seu toque", 1400);
  }
  /** ×2 / ÷2: detector confunde 70 com 140 (é o mesmo loop) */
  function fsScale(f) {
    if (!fs.clock || fs.source === "app") return;
    const bpm = Math.round(fs.clock.bpm * f * 10) / 10;
    if (bpm < 50 || bpm > 200) return;
    fs.clock = { ...fs.clock, bpm };
    fsStopAnalyzer();
    fsRenderBpm();
  }
  function fsRenderBpm() {
    $("#fsTempo").hidden = fs.source === "app" || !fs.clock;
    if (fs.clock) $("#fsBpmNow").textContent = `${fs.clock.bpm} BPM`;
  }
  async function fsEnd() {
    const words = fs.words.slice();
    const hits = fs.hits;
    await fsStop();
    fsShow("end");
    $("#fsEndTitle").textContent = fs.lang === "en" ? "Challenge over!" : "Fim do desafio!";
    const pct = words.length ? Math.round((hits / words.length) * 100) : 0;
    $("#fsEndStats").innerHTML = `
      <div><b>${hits}</b><span>${fs.lang === "en" ? "rhymed" : "rimadas"}</span></div>
      <div><b>${words.length}</b><span>${fs.lang === "en" ? "words" : "palavras"}</span></div>
      <div><b>${pct}%</b><span>${fs.lang === "en" ? "hit rate" : "aproveitamento"}</span></div>
      <div class="words">${words.map((w) => `<em class="${w.hit ? "ok" : ""}">${esc(w.word)}</em>`).join("")}</div>`;
  }
  /** Para tudo. keepOpen = continua na tela do freestyle. */
  async function fsStop() {
    const was = fs.running;
    fs.running = false;
    cancelAnimationFrame(fs.raf);
    fsStopAnalyzer();
    if (karaoke?.recording) await fsStopRec();
    if (fs.beat) { fs.beat.stop(); fs.beat = null; }
    if (was && fs.source === "song" && player) {
      if (player.state().playing) player.toggle();
      if (fs.prevRepeat) player.queue.setRepeat(fs.prevRepeat);
      await player.setKaraoke(false);
    }
    karaoke?.micStop();
    fsRenderStage();
    fs.firstIdx = undefined;
  }
  function fsRenderStage() {
    if (!karaoke) return;
    $("#fsMic").classList.toggle("on", karaoke.micOn);
    $("#fsMic span").textContent = karaoke.micOn ? "Microfone ligado" : "Ligar microfone";
    $("#fsRec").classList.toggle("on", karaoke.recording);
  }
  async function fsStopRec() {
    clearInterval(fs.recTimer);
    const blob = await karaoke.recStop();
    $("#fsRecTime").textContent = "Gravar";
    fsRenderStage();
    if (blob && blob.size > 2000) await saveRecording(blob, `freestyle-${fs.mode}-${Stats.dayKey(new Date())}-${Date.now().toString(36).slice(-4)}`);
  }
  $("#fsStart").addEventListener("click", fsStart);
  $("#fsStop").addEventListener("click", () => (FS.MODES[fs.mode].roundSec && fs.words.length ? fsEnd() : fsStop().then(() => fsShow("setup"))));
  $("#fsAgain").addEventListener("click", fsStart);
  $("#fsBack").addEventListener("click", () => fsShow("setup"));
  $("#fsHit").addEventListener("click", fsHit);
  $("#fsTap").addEventListener("click", fsTap);
  $("#fsHalf").addEventListener("click", () => fsScale(0.5));
  $("#fsDouble").addEventListener("click", () => fsScale(2));
  $("#fsMic").addEventListener("click", async () => {
    try {
      if (karaoke.micOn) karaoke.micStop();
      else {
        await karaoke.micStart();
        toast("Microfone ligado: use fone de ouvido 🎧", 3000);
      }
    } catch (e) {
      toast(/denied|NotAllowed/i.test(String(e)) ? "O Windows não deixou usar o microfone. Libere em Configurações do Windows → Privacidade → Microfone." : `Microfone: ${e?.message || e}`, 6000);
    }
    fsRenderStage();
  });
  $("#fsRec").addEventListener("click", () => {
    if (karaoke.recording) return fsStopRec();
    try {
      karaoke.recStart();
      fs.recAt = Date.now();
      fs.recTimer = setInterval(() => ($("#fsRecTime").textContent = fmt(Date.now() - fs.recAt)), 500);
      $("#fsRecTime").textContent = "0:00";
    } catch (e) {
      toast(`Não deu pra gravar: ${e?.message || e}`);
    }
    fsRenderStage();
  });
  // atalhos enquanto o freestyle está aberto (antes dos atalhos normais)
  document.addEventListener(
    "keydown",
    (e) => {
      if (!fs.open || e.target.matches?.("input, textarea")) return;
      if (e.key === " ") { e.preventDefault(); e.stopImmediatePropagation(); fsHit(); }
      else if (e.key.toLowerCase() === "t") { e.stopImmediatePropagation(); fsTap(); }
      else if (e.key === "Escape") { e.stopImmediatePropagation(); closeFreestyle(); }
    },
    true,
  );

  return {};
}
