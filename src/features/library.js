// Painel da esquerda: Fila (estilo Spotify) · Recentes · Playlists

import { esc } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initLibrary(app) {
  const { $, $$, api, IS_WALLPAPER, store, settings, saveSettings, SERVICES, keyOf, toast, control, PLAYABLE, player, toTrack, playItem, queueItemHtml, playModes, setShuffleMode, setRepeatMode } = app;
  let playlists = store.get("hp.playlists", []);
  const savePlaylists = () => store.set("hp.playlists", playlists);
  let openPlaylistId = null;
  let creatingPlaylist = false;
  let importingPlaylist = false; // mostrando a caixa de link
  let importBusy = false;
  const SRC = {
    spotify: { name: "Spotify", color: "#1ed760" },
    soundcloud: { name: "SoundCloud", color: "#ff7a1a" },
    youtube: { name: "YouTube", color: "#ff3b3b" },
  };
  const isSpotifyPl = (p) => p?.source === "spotify";
  let queueSig = "";
  let dragging = false;

  const ICON = {
    shuffle: `<svg viewBox="0 0 24 24"><path d="M3 7h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6c1 1.7 2.3 2.7 4.3 2.7H21M3 17h3.5c1.4 0 2.4-.5 3.2-1.4M14.3 8.4c.8-.9 1.8-1.4 3.2-1.4H21M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/></svg>`,
    repeat: `<svg viewBox="0 0 24 24"><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19M16 3l3 3-3 3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5M8 21l-3-3 3-3"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
    back: `<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>`,
    play: `<svg viewBox="0 0 24 24" class="fill"><path d="M7 4.5v15l13-7.5z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>`,
    x: `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4.5V8h3.5M4 13a8 8 0 0 0 14.6 4.5M20 19.5V16h-3.5"/></svg>`,
    link: `<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
    more: `<svg viewBox="0 0 24 24" class="fill"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
  };
  const rmBtn = (attr) => `<button class="q-rm" ${attr} title="Tirar">${ICON.x}</button>`;

  /** Qualquer música da tela vira um item que dá pra tocar/guardar. */
  function trackFrom(t, svc = settings.service) {
    const service = PLAYABLE[t.service || svc] ? t.service || svc : "ytmusic";
    return {
      title: t.title || "",
      artist: t.artist || "",
      cover: t.cover || t.coverUrl || (typeof t.thumb === "string" && t.thumb.startsWith("http") ? t.thumb : null) || t.thumb || null,
      url: t.url || t.link || null,
      service,
      durationMs: t.durationMs || 0,
    };
  }

  /** Acha o link de uma música salva só com nome (usado pela fila e pelas playlists). */
  async function resolveTrack(t) {
    const res = await api.invoke("search_music", {
      service: t.service === "soundcloud" ? "soundcloud" : "ytmusic",
      query: `${t.title} ${t.artist}`.trim(),
    });
    const f = res?.tracks?.[0];
    if (!f) return null;
    const tt = toTrack(f, t.service);
    return { url: tt.url, cover: t.cover || tt.cover, durationMs: tt.durationMs || t.durationMs };
  }

  function setTab(tab) {
    settings.queueTab = tab;
    saveSettings();
    openPlaylistId = null;
    creatingPlaylist = false;
    importingPlaylist = false;
    renderQueue(true);
  }
  $("#qTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) setTab(b.dataset.tab);
  });

  function renderQueue(force = false) {
    if (IS_WALLPAPER) return;
    const tab = settings.queueTab || "fila";
    const curKey = keyOf(app.media);
    const info = player?.active && app.local ? player.queue.info() : null;
    const pl = openPlaylistId ? playlists.find((p) => p.id === openPlaylistId) : null;
    const sig = JSON.stringify([tab, curKey, app.media.playing, info && [info.index, info.repeat, info.shuffle, info.tracks.map((t) => t.qid + (t.user ? "u" : "") + (t.url ? "" : "?"))],
      tab === "recentes" && app.history.map((h) => h.key + !!h.thumb), tab === "playlists" && (pl ? [pl.id, pl.name, pl.tracks.length, pl.tracks.map((t) => t.title)] : playlists.map((p) => [p.id, p.name, p.tracks.length])), creatingPlaylist, importingPlaylist, importBusy]);
    // (sem "force", não redesenha enquanto a pessoa digita no nome da playlist)
    if (dragging || (!force && (sig === queueSig || document.activeElement?.closest?.("#queue input")))) return;
    queueSig = sig;

    for (const b of $$("#qTabs button")) b.classList.toggle("sel", b.dataset.tab === tab);

    // tocando agora (na Fila e em Recentes)
    const nowEl = $("#nowItem");
    if (curKey && tab !== "playlists") {
      const h = app.history.find((x) => x.key === curKey);
      nowEl.innerHTML = queueItemHtml({ title: app.media.title, artist: app.media.artist, thumb: app.media.thumb || h?.thumb }, true);
    } else nowEl.innerHTML = "";

    const tools = $("#qTools");
    const list = $("#historyList");
    list.dataset.kind = "";
    let html = "";

    if (tab === "fila") {
      if (info) {
        const rep = info.repeat;
        tools.innerHTML = `
          <button class="q-tool ${info.shuffle ? "on" : ""}" data-act="shuffle" title="Aleatório: ${info.shuffle ? "ligado" : "desligado"}">${ICON.shuffle}</button>
          <button class="q-tool ${rep !== "off" ? "on" : ""}" data-act="repeat" title="Repetir: ${rep === "one" ? "esta música" : rep === "all" ? "a fila" : "desligado"}">${ICON.repeat}${rep === "one" ? "<i>1</i>" : ""}</button>
          <span class="q-spacer"></span>
          <button class="q-tool txt" data-act="clear" title="Tirar todas as próximas">Limpar</button>`;
        const up = info.tracks.map((t, i) => ({ t, i })).slice(info.index + 1);
        const user = up.filter((x) => x.t.user);
        const rest = up.filter((x) => !x.t.user);
        const row = ({ t, i }) => `<li data-qi="${i}" class="sortable" title="Tocar">${queueItemHtml(t, false, rmBtn(`data-rm="${i}"`))}</li>`;
        if (user.length) html += `<li class="q-label">Próximas na fila</li>${user.map(row).join("")}`;
        if (rest.length) html += `<li class="q-label">A seguir</li>${rest.map(row).join("")}`;
        if (!up.length) html = `<li class="q-empty">Nada depois desta.<br>Na busca, use <b>⋯</b> → <b>Adicionar à fila</b>.</li>`;
        list.dataset.kind = "fila";
      } else {
        tools.innerHTML = "";
        html = app.media.available && app.media.title
          ? `<li class="q-empty">Tocando no <b>${esc(SERVICES[app.media.service]?.name || app.media.source || "outro app")}</b> — a fila dele fica no próprio app.<br><br>A fila daqui é do que toca no Harle Player (SoundCloud e YouTube).</li>`
          : `<li class="q-empty">A fila está vazia.<br>Busque uma música e use <b>⋯</b> → <b>Adicionar à fila</b>.</li>`;
      }
    } else if (tab === "recentes") {
      tools.innerHTML = "";
      const items = app.history.filter((h) => h.key !== curKey).slice(0, 20);
      html = items.length
        ? items.map((h) => `<li data-hk="${esc(h.key)}" title="Tocar">${queueItemHtml(h, false)}</li>`).join("")
        : `<li class="q-empty">O que você ouvir aparece aqui.</li>`;
    } else if (pl && isSpotifyPl(pl)) {
      // Playlist do Spotify: toca no app do Spotify (conta pro Wrapped)
      tools.innerHTML = `
        <button class="q-tool" data-act="back" title="Voltar">${ICON.back}</button>
        <input class="pl-name" value="${esc(pl.name)}" maxlength="60" spellcheck="false" title="Clique pra renomear" />
        <button class="q-tool" data-act="plrefresh" title="Atualizar do Spotify">${ICON.refresh}</button>
        <button class="q-tool" data-act="pldelete" title="Tirar do app">${ICON.trash}</button>`;
      html = `<li class="sp-open"><button class="btn-spotify" data-act-sp="open">${ICON.play}Ouvir no Spotify</button><small>Toca no app do Spotify e conta pro Wrapped</small></li>`;
      html += pl.tracks.map((t, i) => `<li data-spi="${i}" title="Abrir no Spotify">${queueItemHtml({ ...t, cover: t.cover || pl.cover }, false)}</li>`).join("");
      list.dataset.kind = "spotify";
    } else if (pl) {
      const src = SRC[pl.source];
      tools.innerHTML = `
        <button class="q-tool" data-act="back" title="Voltar">${ICON.back}</button>
        <input class="pl-name" value="${esc(pl.name)}" maxlength="60" spellcheck="false" title="Clique pra renomear" />
        <button class="q-tool play" data-act="plplay" title="Tocar">${ICON.play}</button>
        <button class="q-tool" data-act="plshuffle" title="Tocar embaralhado">${ICON.shuffle}</button>
        ${src ? `<button class="q-tool" data-act="plrefresh" title="Atualizar do ${src.name}">${ICON.refresh}</button>` : ""}
        <button class="q-tool" data-act="pldelete" title="Apagar playlist">${ICON.trash}</button>`;
      html = pl.tracks.length
        ? pl.tracks.map((t, i) => `<li data-pi="${i}" class="sortable" title="Tocar">${queueItemHtml(t, false, rmBtn(`data-prm="${i}"`))}</li>`).join("")
        : `<li class="q-empty">Playlist vazia.<br>Na busca, use <b>⋯</b> → <b>Adicionar à playlist</b>.</li>`;
      list.dataset.kind = "playlist";
    } else {
      tools.innerHTML = creatingPlaylist
        ? `<input class="pl-name" id="newPlName" placeholder="Nome da playlist" maxlength="40" spellcheck="false" />
           <button class="q-tool txt" data-act="create">Criar</button>`
        : importingPlaylist
          ? `<input class="pl-name" id="importUrl" placeholder="Link do Spotify, SoundCloud ou YouTube" spellcheck="false" ${importBusy ? "disabled" : ""} />
             <button class="q-tool txt" data-act="doimport" ${importBusy ? "disabled" : ""}>${importBusy ? "…" : "Importar"}</button>`
          : `<button class="q-tool txt wide" data-act="new">${ICON.plus}Nova</button>
             <button class="q-tool txt wide" data-act="import">${ICON.link}Importar</button>`;
      html = playlists.length
        ? playlists
            .map((p) => {
              const covers = p.cover ? [p.cover] : p.tracks.map((t) => t.cover).filter(Boolean).slice(0, 4);
              const src = SRC[p.source];
              const art = covers.length >= 4
                ? `<div class="q-cover mosaic">${covers.map((c) => `<img src="${esc(c)}" alt="" draggable="false">`).join("")}</div>`
                : covers.length ? `<img class="q-cover" src="${esc(covers[0])}" alt="" draggable="false">` : `<div class="q-cover pl-blank">${ICON.play}</div>`;
              return `<li data-pl="${esc(p.id)}" title="Abrir">${art}<div class="q-text"><div class="q-title">${esc(p.name)}</div><div class="q-artist">${src ? `<span class="src-dot" style="background:${src.color}"></span>${src.name} · ` : ""}${p.tracks.length} ${p.tracks.length === 1 ? "música" : "músicas"}</div></div></li>`;
            })
            .join("")
        : creatingPlaylist ? "" : `<li class="q-empty">Nenhuma playlist ainda.</li>`;
      if (creatingPlaylist) setTimeout(() => $("#newPlName")?.focus(), 0);
      if (importingPlaylist && !importBusy) setTimeout(() => $("#importUrl")?.focus(), 0);
    }
    list.innerHTML = html;
  }

  function newPlaylist(name, firstTrack) {
    const p = { id: `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: name || `Playlist ${playlists.length + 1}`, tracks: [] };
    if (firstTrack) p.tracks.push(trackFrom(firstTrack));
    playlists.unshift(p);
    savePlaylists();
    return p;
  }

  function addToPlaylist(id, t) {
    const p = playlists.find((x) => x.id === id);
    if (!p) return;
    const tr = trackFrom(t);
    if (p.tracks.some((x) => x.title === tr.title && x.artist === tr.artist)) return toast(`Já está em "${p.name}"`);
    p.tracks.push(tr);
    savePlaylists();
    toast(`Adicionada em "${p.name}"`);
    renderQueue(true);
  }

  function playPlaylist(p, start = 0, shuffle = false) {
    if (!player || !p.tracks.length) return;
    let tracks = p.tracks.slice();
    if (shuffle) {
      for (let k = tracks.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [tracks[k], tracks[j]] = [tracks[j], tracks[k]];
      }
      start = 0;
    }
    player.playQueue(tracks, start);
    setTab("fila");
  }

  $("#qTools").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const q = player?.queue;
    const pl = playlists.find((p) => p.id === openPlaylistId);
    switch (b.dataset.act) {
      case "shuffle": setShuffleMode(!playModes().shuffle); return;
      case "repeat": setRepeatMode(app.nextRepeat(playModes().repeat)); return;
      case "clear": q?.clearUpcoming(); break;
      case "back": openPlaylistId = null; break;
      case "plplay": if (pl) playPlaylist(pl, 0); return;
      case "plshuffle": if (pl) playPlaylist(pl, 0, true); return;
      case "pldelete":
        if (!pl) break;
        if (b.dataset.confirm !== "1") {
          b.dataset.confirm = "1";
          b.classList.add("danger");
          b.title = "Clique de novo pra apagar";
          toast(`Clique de novo pra apagar "${pl.name}"`);
          return;
        }
        playlists = playlists.filter((p) => p !== pl);
        savePlaylists();
        openPlaylistId = null;
        toast("Playlist apagada");
        break;
      case "new": creatingPlaylist = true; break;
      case "import": importingPlaylist = true; break;
      case "doimport": {
        const url = $("#importUrl")?.value.trim();
        if (url) importPlaylistUrl(url);
        return;
      }
      case "plrefresh": if (pl?.sourceUrl) importPlaylistUrl(pl.sourceUrl); return;
      case "create": {
        const name = $("#newPlName")?.value.trim();
        creatingPlaylist = false;
        const p = newPlaylist(name);
        openPlaylistId = p.id;
        break;
      }
    }
    renderQueue(true);
  });
  $("#qTools").addEventListener("keydown", (e) => {
    if (e.target.id === "importUrl") {
      if (e.key === "Enter") $("#qTools [data-act=doimport]")?.click();
      if (e.key === "Escape") { importingPlaylist = false; e.target.blur(); renderQueue(true); }
      return;
    }
    if (e.target.id === "newPlName") {
      if (e.key === "Enter") $("#qTools [data-act=create]")?.click();
      if (e.key === "Escape") { creatingPlaylist = false; e.target.blur(); renderQueue(true); }
    } else if (e.target.classList.contains("pl-name") && (e.key === "Enter" || e.key === "Escape")) e.target.blur();
  });
  $("#qTools").addEventListener("focusout", (e) => {
    if (!e.target.classList.contains("pl-name") || e.target.id === "newPlName" || e.target.id === "importUrl") return;
    const pl = playlists.find((p) => p.id === openPlaylistId);
    const name = e.target.value.trim();
    if (pl && name && name !== pl.name) {
      pl.name = name;
      savePlaylists();
    }
    setTimeout(() => renderQueue(true), 0);
  });

  $("#historyList").addEventListener("click", (e) => {
    if (e.target.closest(".q-label, .q-empty")) return;
    const li = e.target.closest("li");
    if (!li || li.dataset.dragged) return;
    const rm = e.target.closest("[data-rm], [data-prm]");
    if (rm) {
      if (rm.dataset.rm !== undefined) player?.queue.remove(+rm.dataset.rm);
      else {
        const pl = playlists.find((p) => p.id === openPlaylistId);
        pl?.tracks.splice(+rm.dataset.prm, 1);
        savePlaylists();
      }
      return renderQueue(true);
    }
    if (li.dataset.qi) return player?.queue.jump(+li.dataset.qi);
    if (li.dataset.hk) {
      const h = app.history.find((x) => x.key === li.dataset.hk);
      return h && playItem(h);
    }
    if (li.dataset.pl) {
      openPlaylistId = li.dataset.pl;
      return renderQueue(true);
    }
    if (li.dataset.pi) {
      const pl = playlists.find((p) => p.id === openPlaylistId);
      if (pl) playPlaylist(pl, +li.dataset.pi);
    }
    if (li.dataset.spi) {
      const t = playlists.find((p) => p.id === openPlaylistId)?.tracks[+li.dataset.spi];
      const id = t?.url?.split("/track/")[1];
      if (id) openSpotify(`spotify:track:${id}`, `"${t.title}"`);
    }
    if (e.target.closest("[data-act-sp=open]")) {
      const pl = playlists.find((p) => p.id === openPlaylistId);
      if (pl?.openUrl) openSpotify(pl.openUrl, "a playlist");
    }
  });

  function openSpotify(uri, what) {
    api.invoke("open_url", { url: uri })
      .then(() => toast(`Abrindo ${what} no Spotify — é só dar o play lá 🎧`, 3500))
      .catch((err) => toast(`Não consegui abrir o Spotify: ${err}`, 4000));
  }

  // ---------- importar playlist por link ----------
  const PLAYLIST_LINK = /(open\.spotify\.com\/(intl-[a-z-]+\/)?(playlist|album)\/|^spotify:(playlist|album):|soundcloud\.com\/[^/\s]+\/sets\/|[?&]list=)/i;
  const isPlaylistLink = (s) => PLAYLIST_LINK.test(s.trim());

  async function importPlaylistUrl(url) {
    if (importBusy) return;
    importBusy = true;
    importingPlaylist = true;
    if (settings.queueTab !== "playlists") { settings.queueTab = "playlists"; saveSettings(); openPlaylistId = null; }
    renderQueue(true);
    toast("Importando playlist…", 2500);
    try {
      const r = await api.invoke("import_playlist", { url });
      if (!r) throw new Error("sem resposta");
      const service = r.source === "soundcloud" ? "soundcloud" : "ytmusic";
      const tracks = r.tracks.map((t) => ({
        title: t.title, artist: t.artist || "", cover: t.cover || null, url: t.url,
        service: r.source === "spotify" ? "spotify" : service, durationMs: t.durationMs || 0,
      }));
      let p = playlists.find((x) => x.sourceUrl === url || (x.openUrl && x.openUrl === r.openUrl));
      if (p) {
        Object.assign(p, { tracks, cover: r.cover || p.cover, source: r.source, openUrl: r.openUrl, sourceUrl: url });
        toast(`"${p.name}" atualizada · ${tracks.length} músicas`);
      } else {
        p = { id: `pl${Date.now().toString(36)}`, name: r.name, cover: r.cover || null, source: r.source, openUrl: r.openUrl, sourceUrl: url, tracks };
        playlists.unshift(p);
        toast(`"${p.name}" importada · ${tracks.length} músicas`);
      }
      savePlaylists();
      openPlaylistId = p.id;
      importingPlaylist = false;
    } catch (e) {
      toast(`Não deu pra importar: ${e?.message || e}`, 5000);
    } finally {
      importBusy = false;
      renderQueue(true);
    }
  }
  $("#nowItem").addEventListener("click", () => control("toggle"));

  // ---------- arrastar pra reordenar (com o mouse, sem drag-and-drop do navegador) ----------
  (function sortable() {
    const list = $("#historyList");
    let from = null, startY = 0, over = null, li = null;
    list.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".q-rm")) return;
      li = e.target.closest("li.sortable");
      if (!li) return;
      from = li;
      startY = e.clientY;
    });
    window.addEventListener("pointermove", (e) => {
      if (!from) return;
      if (!dragging && Math.abs(e.clientY - startY) < 6) return;
      dragging = true;
      from.classList.add("dragging");
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("li.sortable");
      if (over && over !== el) over.classList.remove("drop-before", "drop-after");
      over = el && el !== from ? el : null;
      if (over) {
        const r = over.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        over.classList.toggle("drop-after", after);
        over.classList.toggle("drop-before", !after);
      }
    });
    window.addEventListener("pointerup", () => {
      if (!from) return;
      const wasDragging = dragging;
      const src = from, dst = over;
      from = null;
      dragging = false;
      src.classList.remove("dragging");
      if (dst) {
        const after = dst.classList.contains("drop-after");
        dst.classList.remove("drop-before", "drop-after");
        const attr = src.dataset.qi !== undefined ? "qi" : "pi";
        const a = +src.dataset[attr];
        let b = +dst.dataset[attr] + (after ? 1 : 0);
        if (b > a) b--;
        if (attr === "qi") {
          const info = player?.queue.info();
          if (info && b <= info.index) b = info.index + 1; // não passa da música atual
          player?.queue.move(a, b);
        } else {
          const pl = playlists.find((p) => p.id === openPlaylistId);
          if (pl) {
            const [it] = pl.tracks.splice(a, 1);
            pl.tracks.splice(b, 0, it);
            savePlaylists();
          }
        }
      }
      over = null;
      if (wasDragging) {
        src.dataset.dragged = "1"; // engole o clique que vem logo depois
        setTimeout(() => renderQueue(true), 0);
      }
    });
  })();

  // ---------- menu ⋯ / clique direito: fila e playlists ----------
  function openTrackMenu(x, y, t) {
    const menu = $("#ctxMenu");
    const canPlay = !!player;
    menu.innerHTML = `
      ${canPlay ? `<button data-c="now">${ICON.play}Tocar agora</button>
      <button data-c="next">${ICON.plus}Tocar a seguir</button>
      <button data-c="queue">${ICON.plus}Adicionar à fila</button><hr>` : ""}
      ${app.partyUi.party.role === "guest" ? `<button data-c="req">${ICON.plus}Pedir pra sala</button><hr>` : ""}
      <div class="ctx-label">Adicionar à playlist</div>
      ${playlists.filter((p) => !isSpotifyPl(p)).map((p) => `<button data-c="pl" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join("")}
      <button data-c="newpl" class="muted-btn">${ICON.plus}Nova playlist</button>`;
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, y))}px`;
    menu.onclick = (e) => {
      const b = e.target.closest("button[data-c]");
      if (!b) return;
      menu.hidden = true;
      const tr = trackFrom(t);
      switch (b.dataset.c) {
        case "now": player.playQueue([tr], 0); break;
        case "next": player.queue.playNext(tr); toast("Toca a seguir"); break;
        case "queue": player.queue.add(tr); toast("Adicionada à fila"); break;
        case "pl": addToPlaylist(b.dataset.id, t); break;
        case "req":
          app.partyUi.partySend({ type: "req", track: { title: tr.title, artist: tr.artist, url: tr.url, service: tr.service, cover: /^https:/.test(tr.cover || "") ? tr.cover : null } });
          toast("Pedido enviado pro anfitrião");
          break;
        case "newpl": {
          const p = newPlaylist(null, t);
          toast(`Criada "${p.name}" — renomeie em Playlists`);
          break;
        }
      }
      renderQueue(true);
    };
  }
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#ctxMenu")) $("#ctxMenu").hidden = true;
  });

  /** A música que está em um elemento da tela (para o clique direito). */
  function trackAt(el) {
    const li = el.closest("#historyList li, #nowItem");
    if (li?.id === "nowItem") {
      if (!keyOf(app.media)) return null;
      const h = app.history.find((x) => x.key === keyOf(app.media));
      return h?.play || { title: app.media.title, artist: app.media.artist, cover: app.media.coverUrl || h?.thumb, url: app.media.link, service: app.media.service };
    }
    if (li?.dataset.qi) return player?.queue.info().tracks[+li.dataset.qi];
    if (li?.dataset.pi) return playlists.find((p) => p.id === openPlaylistId)?.tracks[+li.dataset.pi];
    if (li?.dataset.hk) {
      const h = app.history.find((x) => x.key === li.dataset.hk);
      return h && (h.play || { title: h.title, artist: h.artist, cover: h.thumb });
    }
    return null;
  }
  $("#queue").addEventListener("contextmenu", (e) => {
    const t = trackAt(e.target);
    if (!t) return;
    e.preventDefault();
    openTrackMenu(e.clientX, e.clientY, t);
  });

  return {
    get isPlaylistLink() { return isPlaylistLink; },
    get importPlaylistUrl() { return importPlaylistUrl; },
    get ICON() { return ICON; },
    get trackFrom() { return trackFrom; },
    get resolveTrack() { return resolveTrack; },
    get renderQueue() { return renderQueue; },
    get openTrackMenu() { return openTrackMenu; },
  };
}
