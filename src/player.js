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

export function createPlayer({ api, onState, toast, ytHostId = "ytHost" }) {
  const audio = new Audio();
  audio.preload = "auto";

  let queue = [];
  let index = -1;
  let cur = null; // { title, artist, cover, url, service, durationMs }
  let engine = null; // "audio" | "yt"
  let loading = false;
  let seq = 0;
  let objectUrl = null;

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
      hasNext: index + 1 < queue.length,
    };
  }
  const emit = () => {
    onState(state());
    updateMediaSession();
  };

  // ---------- <audio> (SoundCloud) ----------
  for (const ev of ["play", "pause", "playing", "seeked", "loadedmetadata", "waiting"]) audio.addEventListener(ev, emit);
  audio.addEventListener("ended", () => next(true));
  audio.addEventListener("error", () => {
    if (engine !== "audio" || !cur) return;
    toast("Não consegui tocar esse áudio, pulando…");
    next(true);
  });

  async function playSoundCloud(track, my) {
    const buf = await api.invoke("soundcloud_audio", { url: track.url });
    if (my !== seq) return;
    const bytes = new Uint8Array(buf);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: sniffAudioType(bytes) }));
    engine = "audio";
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
            onReady: () => resolve(),
            onStateChange: (e) => {
              if (engine !== "yt") return;
              ytPlaying = e.data === 1;
              if (e.data === 1) loading = false;
              if (e.data === 0) return next(true);
              emit();
            },
            onError: (e) => {
              if (engine !== "yt") return;
              const embedBlocked = e.data === 101 || e.data === 150 || e.data === 153;
              toast(embedBlocked ? "Esse vídeo não deixa tocar fora do YouTube, pulando…" : "Não consegui tocar esse vídeo, pulando…", 3500);
              next(true);
            },
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
    index = i;
    cur = queue[i];
    loading = true;
    stopEngines();
    engine = null;
    emit();
    try {
      if (cur.service === "soundcloud") await playSoundCloud(cur, my);
      else if (cur.service === "ytmusic" || cur.service === "youtube") await playYouTube(cur, my);
      else throw new Error("Esse serviço não toca dentro do app");
    } catch (e) {
      if (my !== seq) return;
      loading = false;
      toast(String(e?.message || e), 4000);
      if (index + 1 < queue.length) return next(true);
    }
    if (my === seq) emit();
  }

  function next(auto = false) {
    if (index + 1 < queue.length) return playIndex(index + 1);
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
    queue = tracks.slice();
    return playIndex(start);
  }

  function stop() {
    seq++;
    stopEngines();
    cur = null;
    queue = [];
    index = -1;
    engine = null;
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

  return { playQueue, toggle, next: () => next(), prev, seek, stop, state, get active() { return !!cur; } };
}
