// Cartão do artista (clicar num artista na busca): foto, resumo, Tocar /
// Aleatório e as músicas mais tocadas, que tocam aqui dentro como fila.

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initArtist(app) {
  const { $, api, player, settings, toTrack, toast, esc, NATIVE_SEARCH } = app;
  const card = $("#artistCard");
  let seq = 0;
  let songs = [];

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  /** Foto maior (o YouTube Music manda miniatura de 120px). */
  const bigPicture = (u) => (u || "").replace(/=w\d+-h\d+[^&?#]*$/, "=w544-h544-l90-rj").replace(/-t\d+x\d+(\.\w+)$/, "-t500x500$1");

  /** Resumo da Wikipédia (pt, senão en) — só se for mesmo sobre música. */
  async function bio(name) {
    const MUSIC = /cantor|cantora|rapper|rapista|m[úu]sic|banda|compositor|produtor|DJ|singer|songwriter|band|musician|record producer|hip hop|trap|funk|sertanej|pagode|rock|pop|MC\b/i;
    for (const lang of ["pt", "en"]) {
      try {
        const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}`, { headers: { accept: "application/json" } });
        if (!r.ok) continue;
        const j = await r.json();
        if (j.type === "disambiguation" || !j.extract || !MUSIC.test(`${j.description || ""} ${j.extract}`)) continue;
        return j.extract;
      } catch {}
    }
    return "";
  }

  /** Músicas do artista: busca pelo nome e fica com as que são dele. */
  async function topSongs(name) {
    const svc = NATIVE_SEARCH[settings.service] || "ytmusic";
    const page = await api.invoke("search_page", { service: svc, query: name, kind: "tracks", cursor: null }).catch(() => null);
    const all = (page?.tracks || []).map((t) => toTrack(t, settings.service in NATIVE_SEARCH ? settings.service : svc));
    const n = norm(name);
    const mine = all.filter((t) => norm(t.artist).includes(n));
    return (mine.length >= 3 ? mine : all).slice(0, 10);
  }

  function render({ name, picture, text = null, list = null }) {
    card.innerHTML = `
      <button class="ac-close" data-ac="close" title="Fechar" aria-label="Fechar">✕</button>
      <div class="ac-left">
        <div class="ac-photo">${picture ? `<img src="${esc(bigPicture(picture))}" alt="" draggable="false" onerror="this.src='${esc(picture)}'">` : ""}</div>
        <h2>${esc(name)}</h2>
        <p class="ac-bio">${text === null ? `<span class="sk-line"></span><span class="sk-line short"></span>` : esc(text)}</p>
        <div class="ac-btns">
          <button class="ac-play" data-ac="play" ${list?.length ? "" : "disabled"}>▶ Tocar</button>
          <button class="ac-shuffle" data-ac="shuffle" ${list?.length ? "" : "disabled"}>⤨ Aleatório</button>
        </div>
      </div>
      <div class="ac-right">
        <h3>Top músicas</h3>
        <ol class="ac-songs">${
          list === null
            ? Array.from({ length: 7 }, () => `<li class="sk-row"><i></i><span class="sk-line"></span></li>`).join("")
            : list.length
              ? list.map((t, i) => `<li data-i="${i}" title="Tocar"><img src="${esc(t.cover || "")}" alt="" loading="lazy" draggable="false"><div><b>${esc(t.title)}</b><span>${esc(t.album || t.artist || "")}</span></div></li>`).join("")
              : `<li class="ac-empty">Não achei músicas desse artista aqui.</li>`
        }</ol>
      </div>`;
  }

  async function open(a) {
    if (!a?.name) return;
    const my = ++seq;
    songs = [];
    let text = null;
    card.hidden = false;
    document.body.classList.add("artist-open");
    render({ name: a.name, picture: a.picture });
    const [list, b] = await Promise.all([topSongs(a.name).catch(() => []), bio(a.name).catch(() => "")]);
    if (my !== seq) return;
    songs = list;
    text = b;
    render({ name: a.name, picture: a.picture || list[0]?.cover, text, list });
  }

  function close() {
    seq++;
    card.hidden = true;
    document.body.classList.remove("artist-open");
  }

  function play(from = 0, shuffle = false) {
    if (!songs.length) return;
    if (!player) return toast("O player não está disponível aqui");
    let list = songs.slice();
    if (shuffle) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      from = 0;
    }
    player.playQueue(list, from);
  }

  card.addEventListener("click", (e) => {
    const act = e.target.closest("[data-ac]")?.dataset.ac;
    if (act === "close") return close();
    if (act === "play") return play(0);
    if (act === "shuffle") return play(0, true);
    const li = e.target.closest("li[data-i]");
    if (li) play(+li.dataset.i);
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !card.hidden) {
      e.stopPropagation();
      close();
    }
  }, true);

  return { open, close };
}
