// Player interno do Harle Player: toca a música dentro do próprio app.
//
//  • SoundCloud → o Rust baixa o áudio (mp3 / HLS juntado) e o <audio> toca.
//  • YouTube Music / YouTube → player oficial do YouTube (IFrame API) escondido.
//
// Mantém uma fila (resultados da busca), avança sozinho no fim da música e
// avisa a tela via onState(estado) no mesmo formato do leitor de mídia do Windows.

export function sniffAudioType(bytes) {
  const b = bytes;
  if (b.length > 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg"; // "ID3"
  if (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (b.length > 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "audio/mp4"; // "ftyp"
  if (b.length > 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg"; // "OggS"
  if (b.length > 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "audio/wav"; // "RIFF"
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm"; // EBML
  return "audio/mpeg";
}

export function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

import * as Q from "./queue.js";

/** Faixas do equalizador (Hz). */
export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Quanto baixar antes do EQ pra não estourar quando aumenta faixas (0–1). */
export function eqPreamp(gains) {
  const boost = Math.max(0, ...gains);
  return Math.pow(10, (-boost * 0.6) / 20);
}

export function createPlayer({ api, onState, onQueue = () => {}, resolve = null, toast, ytHostId = "ytHost" }) {
  const audio = new Audio();
  audio.preload = "auto";

  let queue = [];
  let index = -1;
  let cur = null; // { title, artist, cover, url, service, durationMs }
  let engine = null; // "audio" | "yt"
  let loading = false;
  let seq = 0;
  let objectUrl = null;
  let volume = 1;
  let repeat = "off"; // "off" | "all" | "one"
  let shuffleOrder = null; // ordem antes de embaralhar (null = aleatório desligado)
  const q = () => ({ tracks: queue, index });
  const setQ = (n) => {
    queue = n.tracks;
    index = n.index;
    if (index >= 0) cur = queue[index];
    onQueue(queueInfo());
  };
  function queueInfo() {
    return { tracks: queue, index, repeat, shuffle: !!shuffleOrder };
  }

  // ---------- estado ----------
  let yt = null;
  let ytReady = null;
  let ytPlaying = false;

  function state() {
    let playing = false, pos = 0, dur = cur?.durationMs || 0;
    if (engine === "audio") {
      playing = !audio.paused && !audio.ended;
      pos = audio.currentTime * 1000;
      if (Number.isFinite(audio.duration) && audio.duration > 0) dur = audio.duration * 1000;
    } else if (engine === "yt" && yt?.getCurrentTime) {
      playing = ytPlaying;
      pos = (yt.getCurrentTime() || 0) * 1000;
      const d = yt.getDuration?.() || 0;
      if (d > 0) dur = d * 1000;
    }
    return {
      local: true,
      available: !!cur,
      title: cur?.title || "",
      artist: cur?.artist || "",
      album: "",
      source: "Harle Player",
      service: cur?.service || "",
      playing: playing && !loading,
      loading,
      positionMs: Math.round(pos),
      durationMs: Math.round(dur),
      updatedAtMs: Date.now(),
      thumb: cur?.cover || null,
      coverUrl: cur?.cover || null,
      link: cur?.url || null,
      hasNext: Q.nextIndex(q(), repeat) >= 0,
    };
  }
  const emit = () => {
    onState(state());
    updateMediaSession();
  };

  // ---------- equalizador (WebAudio): <audio> → 10 filtros → volume → saída ----------
  let actx = null, gainNode = null, filters = [];
  let eqOn = false, eqGains = EQ_FREQS.map(() => 0);
  function ensureGraph() {
    if (actx) return;
    try {
      actx = new AudioContext();
      const src = actx.createMediaElementSource(audio);
      filters = EQ_FREQS.map((f, i) => {
        const b = actx.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
        b.frequency.value = f;
        b.Q.value = 1.1;
        return b;
      });
      gainNode = actx.createGain();
      let node = src;
      for (const f of filters) {
        node.connect(f);
        node = f;
      }
      node.connect(gainNode);
      gainNode.connect(actx.destination);
      applyEq();
    } catch (e) {
      console.warn("equalizador indisponível:", e);
      actx = null;
    }
  }
  function applyEq() {
    if (actx) {
      filters.forEach((f, i) => (f.gain.value = eqOn ? eqGains[i] || 0 : 0));
      audio.volume = 1;
      gainNode.gain.value = volume * volume * (eqOn ? eqPreamp(eqGains) : 1);
    } else {
      audio.volume = volume * volume;
    }
  }

  // ---------- <audio> (SoundCloud) ----------
  for (const ev of ["play", "pause", "playing", "seeked", "loadedmetadata", "waiting"]) audio.addEventListener(ev, emit);
  audio.addEventListener("ended", () => next(true));
  audio.addEventListener("error", () => {
    if (engine !== "audio" || !cur) return;
    toast("Não consegui tocar esse áudio, pulando…");
    next(true);
  });

  // Baixa o áudio pelo Rust (SoundCloud direto; YouTube pelo yt-dlp) e toca no <audio>.
  async function playDownloaded(cmd, track, my) {
    const buf = await api.invoke(cmd, { url: track.url });
    if (my !== seq) return;
    const bytes = new Uint8Array(buf);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: sniffAudioType(bytes) }));
    engine = "audio";
    ensureGraph();
    actx?.resume?.().catch(() => {});
    audio.src = objectUrl;
    loading = false;
    await audio.play();
  }

  // ---------- YouTube (IFrame API) ----------
  function loadYouTube() {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve, reject) => {
      const done = () =>
        (yt = new window.YT.Player(ytHostId, {
          width: 200,
          height: 200,
          playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0, origin: location.origin },
          events: {
            onReady: () => {
              yt.setVolume?.(Math.round(volume * 100));
              resolve();
            },
            onStateChange: (e) => {
              if (engine !== "yt") return;
              ytPlaying = e.data === 1;
              if (e.data === 1) loading = false;
              if (e.data === 0) return next(true);
              emit();
            },
            onError: (e) => youtubeFailed(e.data),
          },
        }));
      if (window.YT?.Player) return done();
      window.onYouTubeIframeAPIReady = done;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => {
        ytReady = null;
        reject(new Error("Sem conexão com o YouTube"));
      };
      document.head.appendChild(s);
    });
    return ytReady;
  }

  // Player oficial recusou (vídeo bloqueia tocar fora do YouTube): tenta pelo yt-dlp.
  async function youtubeFailed(code) {
    if (engine !== "yt" || !cur) return;
    const my = seq;
    try { yt.stopVideo(); } catch {}
    ytPlaying = false;
    engine = null;
    loading = true;
    emit();
    toast("Esse vídeo bloqueia o player do YouTube, tocando pelo modo alternativo… (na 1ª vez demora um pouco)", 4500);
    try {
      await playDownloaded("youtube_audio", cur, my);
      if (my === seq) emit();
    } catch (err) {
      if (my !== seq) return;
      loading = false;
      toast(`Não deu pra tocar (${String(err?.message || err || code)}), pulando…`, 4500);
      next(true);
    }
  }

  async function playYouTube(track, my) {
    const id = youtubeId(track.url);
    if (!id) throw new Error("Link do YouTube inválido");
    await loadYouTube();
    if (my !== seq) return;
    engine = "yt";
    yt.loadVideoById(id);
  }

  // ---------- fila / controles ----------
  function stopEngines() {
    audio.pause();
    if (yt?.stopVideo) {
      try { yt.stopVideo(); } catch {}
    }
    ytPlaying = false;
  }

  async function playIndex(i) {
    if (i < 0 || i >= queue.length) return;
    const my = ++seq;
    if (i !== index) setQ(Q.markPlayed({ tracks: queue, index: i }, i));
    else setQ(q());
    loading = true;
    stopEngines();
    engine = null;
    emit();
    try {
      // música salva só com nome (ex.: veio do Deezer/Spotify): acha o link agora
      if (!cur.url && resolve) {
        const found = await resolve(cur);
        if (my !== seq) return;
        if (!found?.url) throw new Error(`Não achei "${cur.title}"`);
        queue[index] = { ...cur, ...found, qid: cur.qid, user: cur.user };
        cur = queue[index];
        onQueue(queueInfo());
      }
      if (cur.service === "soundcloud") await playDownloaded("soundcloud_audio", cur, my);
      else if (cur.service === "ytmusic" || cur.service === "youtube") {
        try {
          await playYouTube(cur, my);
        } catch {
          // player do YouTube nem carregou → vai direto pelo yt-dlp
          if (my !== seq) return;
          await playDownloaded("youtube_audio", cur, my);
        }
      }
      else throw new Error("Esse serviço não toca dentro do app");
    } catch (e) {
      if (my !== seq) return;
      loading = false;
      toast(String(e?.message || e), 4000);
      if (index + 1 < queue.length) return playIndex(index + 1);
    }
    if (my === seq) emit();
  }

  function next(auto = false) {
    const n = Q.nextIndex(q(), repeat, auto);
    if (n === index && auto) return seek(0), toggleOn();
    if (n >= 0) return playIndex(n);
    if (auto) {
      loading = false;
      emit();
    }
  }

  function prev() {
    const pos = state().positionMs;
    if (pos > 3000 || index <= 0) return seek(0);
    return playIndex(index - 1);
  }

  function toggleOn() {
    if (engine === "audio") audio.play().catch(() => {});
    else if (engine === "yt" && yt) yt.playVideo();
  }

  function toggle() {
    if (!cur) return;
    if (engine === "audio") audio.paused ? audio.play() : audio.pause();
    else if (engine === "yt" && yt) ytPlaying ? yt.pauseVideo() : yt.playVideo();
    setTimeout(emit, 50);
  }

  function seek(ms) {
    if (engine === "audio") audio.currentTime = ms / 1000;
    else if (engine === "yt" && yt) yt.seekTo(ms / 1000, true);
    setTimeout(emit, 80);
  }

  function playQueue(tracks, start = 0) {
    queue = tracks.map((t) => Q.withQid(t));
    index = -1;
    const p = playIndex(start);
    // aleatório ligado: a lista nova já entra embaralhada (a escolhida toca primeiro)
    if (shuffleOrder) {
      shuffleOrder = queue.map((t) => t.qid);
      setQ(Q.shuffleUpcoming(q()));
    }
    return p;
  }

  // ---------- fila estilo Spotify ----------
  const queueApi = {
    info: queueInfo,
    jump: (i) => playIndex(i),
    playNext(track) {
      if (!cur) return playQueue([track], 0);
      setQ(Q.insertNext(q(), track));
      emit();
    },
    add(track) {
      if (!cur) return playQueue([track], 0);
      setQ(Q.enqueue(q(), track));
      emit();
    },
    remove(i) {
      setQ(Q.removeAt(q(), i));
      emit();
    },
    move(from, to) {
      setQ(Q.moveItem(q(), from, to));
    },
    shuffle() {
      setQ(Q.shuffleUpcoming(q()));
    },
    /** Liga/desliga o aleatório (desligando, a ordem original volta). */
    setShuffle(on) {
      if (on && !shuffleOrder) {
        shuffleOrder = queue.map((t) => t.qid);
        setQ(Q.shuffleUpcoming(q()));
      } else if (!on && shuffleOrder) {
        const order = shuffleOrder;
        shuffleOrder = null;
        setQ(Q.unshuffle(q(), order));
      }
      emit();
    },
    clearUpcoming() {
      setQ({ tracks: queue.slice(0, index + 1), index });
      emit();
    },
    setRepeat(r) {
      repeat = r;
      onQueue(queueInfo());
      emit();
    },
  };

  function stop() {
    seq++;
    stopEngines();
    cur = null;
    queue = [];
    index = -1;
    engine = null;
    onQueue(queueInfo());
    loading = false;
    emit();
  }

  // ---------- teclas de mídia / controle do Windows ----------
  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !cur) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cur.title,
        artist: cur.artist,
        artwork: cur.cover ? [{ src: cur.cover, sizes: "500x500" }] : [],
      });
    } catch {}
  }
  if ("mediaSession" in navigator) {
    const h = (a, f) => {
      try { navigator.mediaSession.setActionHandler(a, f); } catch {}
    };
    h("play", toggle);
    h("pause", toggle);
    h("nexttrack", () => next());
    h("previoustrack", prev);
    h("seekto", (d) => seek((d.seekTime || 0) * 1000));
  }

  // volume 0–1 (curva ao quadrado: o meio da barra soa como "metade")
  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    applyEq();
    try { yt?.setVolume?.(Math.round(volume * volume * 100)); } catch {}
  }

  /** Liga/desliga o equalizador e define o ganho (dB) de cada faixa. */
  function setEq(on, gains) {
    eqOn = !!on;
    if (gains) eqGains = gains.slice(0, EQ_FREQS.length);
    if (eqOn) ensureGraph();
    applyEq();
  }

  return { playQueue, queue: queueApi, setVolume, setEq, toggle, next: () => next(), prev, seek, stop, state, get active() { return !!cur; } };
}
