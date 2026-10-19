// Busca completa: abas Tudo · Músicas · Artistas, com "carregar mais"

import { fmt, esc } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initSearch(app) {
  const { $, $$, api, settings, saveSettings, enc, SERVICES, toast, httpJson, openInService, PLAYABLE, player, toTrack, playQuery, ICON, trackFrom, renderQueue, isPlaylistLink, importPlaylistUrl, openTrackMenu, skeleton, closeSearch, NATIVE_SEARCH, runSearch } = app;
  let resTab = "all";
  const full = { q: "", svc: "", kind: "", items: [], next: null, loading: false, done: false, seq: 0, source: "", error: "" };

  function setResTab(tab) {
    resTab = tab;
    for (const b of $$("#resTabs button")) b.classList.toggle("sel", b.dataset.rt === tab);
    $("#resAll").hidden = tab !== "all";
    $("#resFull").hidden = tab === "all";
    $("#results").scrollTop = 0;
    if (tab !== "all") loadFull(true);
  }
  $("#results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rt]");
    if (b) setResTab(b.dataset.rt);
  });

  async function deezerPage(q, kind, cursor) {
    const index = +(cursor || 0);
    const url = kind === "artists"
      ? `https://api.deezer.com/search/artist?q=${enc(q)}&limit=40&index=${index}`
      : `https://api.deezer.com/search?q=${enc(q)}&limit=40&index=${index}`;
    const r = await httpJson(url);
    const data = r?.data || [];
    return {
      source: "deezer",
      tracks: kind === "artists" ? [] : data.map((t) => ({ title: t.title_short || t.title, artist: t.artist?.name || "", cover: t.album?.cover_medium || "", url: t.link, durationMs: (t.duration || 0) * 1000 })),
      artists: kind === "artists" ? data.map((a) => ({ name: a.name, picture: a.picture_medium || "", url: a.link })) : [],
      next: r?.next && data.length ? String(index + data.length) : null,
    };
  }

  async function loadFull(reset = false) {
    const q = input.value.trim();
    const kind = resTab;
    const svc = settings.service;
    if (!q || kind === "all") return;
    if (reset || full.q !== q || full.kind !== kind || full.svc !== svc) {
      Object.assign(full, { q, kind, svc, items: [], next: null, loading: false, done: false, seq: full.seq + 1, source: "", error: "" });
      $("#fullList").innerHTML = ""; // limpa sem mostrar "Nada encontrado" antes de buscar
    }
    if (full.loading || full.done) return;
    full.loading = true;
    full.error = "";
    renderFullMore();
    const my = full.seq;
    try {
      let page;
      if (NATIVE_SEARCH[svc] && full.source !== "deezer") {
        try {
          page = await Promise.race([
            api.invoke("search_page", { service: NATIVE_SEARCH[svc], query: q, kind, cursor: full.next }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("demorou demais (15 s)")), 15000)),
          ]);
          if (!page) throw new Error("sem resposta");
        } catch (e) {
          if (full.items.length) throw e; // no meio da lista: só mostra o erro
          $("#fullNote").textContent = `${SERVICES[svc].name} não respondeu (${String(e?.message || e)}). Mostrando resultados do Deezer.`;
          page = await deezerPage(q, kind, null);
        }
      } else {
        page = await deezerPage(q, kind, full.next);
      }
      if (my !== full.seq) return;
      if (!full.source) full.source = page.source;
      const got = kind === "artists" ? page.artists || [] : page.tracks || [];
      // a mesma música pode voltar em duas páginas
      const have = new Set(full.items.map((x) => x.url));
      full.items.push(...got.filter((x) => !have.has(x.url)));
      full.next = page.next || null;
      full.done = !full.next;
    } catch (e) {
      if (my !== full.seq) return;
      full.error = String(e?.message || e);
    } finally {
      if (my === full.seq) {
        full.loading = false;
        renderFull();
      }
    }
  }

  function fullTrack(i) {
    const t = full.items[i];
    const svcOk = PLAYABLE[full.svc] ? full.svc : "ytmusic";
    return full.source === "deezer" ? { ...trackFrom(t, svcOk), url: null } : toTrack(t, svcOk);
  }

  function renderFull() {
    const list = $("#fullList");
    if (full.kind === "artists") {
      list.className = "fl-grid artists";
      list.innerHTML = full.items
        .map((a, i) => `<div class="res-tile" data-fa="${i}" title="Ver músicas">${a.picture ? `<img src="${esc(a.picture)}" alt="" loading="lazy" draggable="false">` : `<div class="sk"></div>`}<b>${esc(a.name)}</b></div>`)
        .join("");
    } else {
      list.className = "fl-list";
      const playingUrl = app.local?.link;
      list.innerHTML = full.items
        .map((t, i) => {
          const now = playingUrl && (t.url === playingUrl || toTrack(t, full.svc).url === playingUrl);
          return `<div class="fl-row${now ? " now" : ""}" data-fi="${i}">
            <span class="fl-n">${now ? `<span class="eq"><i></i><i></i><i></i></span>` : i + 1}</span>
            ${t.cover ? `<img class="fl-cover" src="${esc(t.cover)}" alt="" loading="lazy" draggable="false">` : `<div class="fl-cover"></div>`}
            <div class="fl-text"><b>${esc(t.title)}</b><span>${esc(t.artist || "—")}</span></div>
            <span class="fl-dur">${t.durationMs ? fmt(t.durationMs) : ""}</span>
            <button class="fl-more" data-fmore="${i}" title="Fila e playlists">${ICON.more}</button>
          </div>`;
        })
        .join("");
    }
    if (!full.items.length && full.loading) list.innerHTML = "";
    if (!full.items.length && !full.loading) {
      list.innerHTML = full.error
        ? `<div class="res-empty">Não deu pra buscar: ${esc(full.error)}</div>`
        : `<div class="res-empty">Nada encontrado.</div>`;
    }
    renderFullMore();
  }

  function renderFullMore() {
    const el = $("#fullMore");
    if (full.loading) {
      el.innerHTML = full.kind === "artists"
        ? `<div class="fl-grid artists">${skeleton(full.items.length ? 6 : 12, "round")}</div>`
        : Array.from({ length: full.items.length ? 3 : 10 }, () => `<div class="fl-row sk-row"><span class="fl-n"></span><div class="fl-cover sk"></div><div class="fl-text"><i></i><i></i></div></div>`).join("");
    } else if (full.error && full.items.length) {
      el.innerHTML = `<button class="btn" data-fretry>Tentar de novo</button> <small class="muted">${esc(full.error)}</small>`;
    } else if (!full.done && full.items.length) {
      el.innerHTML = `<button class="btn" data-fretry>Carregar mais</button>`;
    } else {
      el.innerHTML = full.items.length ? `<small class="muted">${full.items.length} ${full.kind === "artists" ? "artistas" : "músicas"}</small>` : "";
    }
  }

  $("#fullMore").addEventListener("click", (e) => {
    if (e.target.closest("[data-fretry]")) loadFull();
  });
  // rolou até perto do fim → carrega mais sozinho
  $("#results").addEventListener("scroll", () => {
    if (resTab === "all") return;
    const r = $("#results");
    if (r.scrollTop + r.clientHeight > r.scrollHeight - 400) loadFull();
  }, { passive: true });

  $("#fullList").addEventListener("click", (e) => {
    const more = e.target.closest("[data-fmore]");
    if (more) {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      return openTrackMenu(r.right - 210, r.bottom + 4, fullTrack(+more.dataset.fmore));
    }
    const row = e.target.closest("[data-fi]");
    if (row) {
      const i = +row.dataset.fi;
      const t = full.items[i];
      if (player && PLAYABLE[full.svc]) {
        // toca a partir dela, com a lista inteira carregada como fila
        return player.playQueue(full.items.map((_, k) => fullTrack(k)), i);
      }
      if (full.source !== "deezer" || full.svc === "deezer") {
        return api.invoke("open_url", { url: t.url }).then(() => toast(`Abrindo no ${SERVICES[full.svc].name}…`)).catch((err) => toast(String(err)));
      }
      return openInService(`${t.title} ${t.artist}`);
    }
    const art = e.target.closest("[data-fa]");
    if (art) {
      const a = full.items[+art.dataset.fa];
      if (player && PLAYABLE[full.svc]) {
        input.value = a.name;
        runSearch(a.name);
        return setResTab("tracks");
      }
      if (full.source !== "deezer" || full.svc === "deezer") return api.invoke("open_url", { url: a.url }).catch(() => {});
      openInService(a.name);
    }
  });
  $("#fullList").addEventListener("contextmenu", (e) => {
    const row = e.target.closest("[data-fi]");
    if (!row) return;
    e.preventDefault();
    openTrackMenu(e.clientX, e.clientY, fullTrack(+row.dataset.fi));
  });

  const input = $("#searchInput");
  input.addEventListener("input", () => {
    clearTimeout(app.searchTimer);
    if (app.isSongLink(input.value)) {
      $("#resNote").textContent = "";
      return toast("Link de música: aperte Enter pra tocar", 2500);
    }
    if (isPlaylistLink(input.value)) {
      $("#resNote").textContent = "";
      return toast("Link de playlist: aperte Enter pra importar", 2500);
    }
    app.searchTimer = setTimeout(() => runSearch(input.value), 380);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(app.searchTimer);
      const q = input.value.trim();
      if (!q) return;
      if (app.isSongLink(q)) {
        input.value = "";
        closeSearch();
        input.blur();
        return app.playLink(q);
      }
      if (isPlaylistLink(q)) {
        input.value = "";
        closeSearch();
        input.blur();
        return importPlaylistUrl(q);
      }
      if (!$("#results").hidden && $("#resTracks .res-empty")) playQuery(q);
      else runSearch(q);
    } else if (e.key === "Escape") {
      input.value = "";
      closeSearch();
      input.blur();
    }
  });

  // ---------- seletor de serviço ----------
  function renderService() {
    const svc = SERVICES[settings.service];
    $("#btnService").innerHTML = `<span class="service-dot" style="background:${svc.color}"></span>${esc(svc.name)}`;
    input.placeholder = `Pesquisar no ${svc.name}… ou colar um link`;
    $("#segService").innerHTML = Object.entries(SERVICES)
      .map(([id, s]) => `<button data-v="${id}" class="${id === settings.service ? "sel" : ""}">${esc(s.name)}</button>`)
      .join("");
  }
  function setService(id) {
    settings.service = id;
    saveSettings();
    renderService();
    renderQueue();
  }
  $("#btnService").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#serviceMenu");
    if (!menu.hidden) return (menu.hidden = true);
    menu.innerHTML = Object.entries(SERVICES)
      .map(([id, s]) => `<button data-v="${id}" class="${id === settings.service ? "sel" : ""}"><span class="service-dot" style="background:${s.color}"></span>${esc(s.name)}</button>`)
      .join("");
    menu.hidden = false;
    const r = $("#btnService").getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.top - menu.offsetHeight - 10}px`;
  });
  $("#serviceMenu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    setService(b.dataset.v);
    $("#serviceMenu").hidden = true;
    if (input.value.trim()) runSearch(input.value);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#serviceMenu")) $("#serviceMenu").hidden = true;
  });

  return {
    get setService() { return setService; },
    get resTab() { return resTab; },
    get full() { return full; },
    get setResTab() { return setResTab; },
    get loadFull() { return loadFull; },
    get renderFull() { return renderFull; },
    get input() { return input; },
    get renderService() { return renderService; },
  };
}
