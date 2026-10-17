// Ouvir junto: salas com código, sincronizadas pelo ntfy.sh (criptografado)

import * as Party from "../party.js";
import { esc, cleanTitle, cleanArtist } from "../lib.js";

/** `app` = o que esta parte usa do resto do app (ver app.js). */
export function initParty(app) {
  const { $, $$, api, settings, saveSettings, enc, keyOf, positionNow, toast, control, player, toTrack, trackFrom } = app;
  const EMOJIS = ["🔥", "❤️", "😂", "👏", "🕺", "😭"];
  const party = {
    room: null, role: null, status: "", hostState: null, applying: "",
    myId: Math.random().toString(36).slice(2, 10),
    members: new Map(), requests: [], lastSent: null, lastSentAt: 0, lastReact: 0,
  };
  const myName = () => (settings.partyName || "").trim() || "Alguém";

  async function partySend(obj) {
    if (!party.room) return;
    const body = await Party.seal(party.room.key, { ...obj, id: party.myId, name: myName(), role: party.role, t: Date.now() });
    try {
      await api.invoke("party_send", { topic: party.room.topic, body });
    } catch (e) {
      if (!/Muitas/.test(String(e))) toast(`Sala: ${e}`, 3000);
    }
  }

  async function partyEnter(code, role) {
    if (party.room) await partyLeave(true);
    party.room = await Party.roomFromCode(code);
    party.role = role;
    party.members = new Map([[party.myId, { name: myName(), role, me: true, at: Date.now() }]]);
    party.requests = [];
    party.hostState = null;
    party.applying = "";
    party.lastSent = null;
    try {
      await api.invoke("party_join", { topic: party.room.topic });
    } catch (e) {
      party.room = null;
      return toast(`Não deu pra entrar na sala: ${e}`, 4000);
    }
    await partySend({ type: "hello" });
    if (role === "host") partyHostTick(true);
    renderParty();
    toast(role === "host" ? "Sala criada! Mande o código pros amigos" : "Entrou na sala 🎧");
  }
  async function partyLeave(quiet = false) {
    if (!party.room) return;
    await partySend({ type: "bye" });
    api.invoke("party_leave").catch(() => {});
    party.room = null;
    party.role = null;
    party.members.clear();
    renderParty();
    if (!quiet) toast("Você saiu da sala");
  }

  api.listen("party-status", (st) => {
    party.status = st;
    renderParty();
  });
  api.listen("party-msg", async (text) => {
    if (!party.room) return;
    const m = await Party.open(party.room.key, text);
    if (!m || m.id === party.myId) return;
    const fresh = Date.now() - (m.t || 0) < 15000; // o ntfy reenvia os últimos 2 min ao entrar
    if (m.type === "bye") {
      party.members.delete(m.id);
      if (fresh) toast(`${m.name} saiu da sala`);
    } else {
      const had = party.members.has(m.id);
      party.members.set(m.id, { name: m.name, role: m.role, at: m.t });
      if (m.type === "hello" && fresh && !had) {
        toast(`${m.name} entrou na sala`);
        if (party.role === "host") setTimeout(() => partyHostTick(true), 400);
      }
    }
    if (m.type === "state" && m.role === "host" && party.role === "guest") {
      if (!party.hostState || m.t >= party.hostState.t) {
        party.hostState = m;
        partyApplyHost();
      }
    }
    if (m.type === "react" && fresh) showReaction(m.emoji, m.name);
    if (m.type === "req" && fresh && party.role === "host" && m.track?.title) {
      party.requests.unshift({ ...m.track, from: m.name });
      party.requests = party.requests.slice(0, 8);
      toast(`${m.name} pediu: ${m.track.title}`, 4000);
    }
    renderParty();
  });

  // ---------- anfitrião: manda o que está tocando quando muda (e de 25 em 25 s) ----------
  function partyHostTick(force = false) {
    if (party.role !== "host") return;
    const key = keyOf(app.media);
    const pos = Math.round(positionNow());
    const last = party.lastSent;
    const now = Date.now();
    const jumped = last && last.key === key && Math.abs(Party.expectedPosition(last, now) - pos) > 3000;
    const changed = !last || last.key !== key || last.playing !== !!app.media.playing || jumped;
    if (!force && !changed && now - party.lastSentAt < 25000) return;
    if (now - party.lastSentAt < 1200 && !force) return;
    const h = key ? app.history.find((x) => x.key === key) : null;
    const playLink = app.local?.link && /soundcloud\.com|youtube\.com|youtu\.be/.test(app.local.link) ? app.local.link : null;
    const st = {
      type: "state",
      key,
      track: key ? {
        title: app.media.title, artist: app.media.artist || "", durationMs: app.media.durationMs || 0,
        cover: /^https:/.test(app.media.coverUrl || "") ? app.media.coverUrl : null,
        url: playLink, service: playLink ? (playLink.includes("soundcloud") ? "soundcloud" : "ytmusic") : null,
      } : null,
      playing: !!app.media.playing,
      positionMs: pos,
      durationMs: app.media.durationMs || 0,
      at: now,
    };
    party.lastSent = st;
    party.lastSentAt = now;
    partySend(st);
    void h;
  }
  setInterval(() => {
    partyHostTick();
    if (party.room && Date.now() % 60000 < 1000) partySend({ type: "ping" });
  }, 1000);

  // ---------- convidado: segue o anfitrião ----------
  async function partyApplyHost() {
    const st = party.hostState;
    if (!st?.track?.title) return;
    const exp = Party.expectedPosition(st);
    if (!Party.sameSong({ title: app.media.title, artist: app.media.artist }, st.track)) {
      if (party.applying === st.track.title) return;
      party.applying = st.track.title;
      toast(`Sala: tocando ${st.track.title}`, 2500);
      if (settings.partyMode === "spotify") await partyOpenInSpotify(st);
      else await partyPlayHere(st);
      // espera a música começar e pula pro mesmo ponto do anfitrião
      for (let i = 0; i < (settings.partyMode === "spotify" ? 120 : 40); i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (Party.sameSong({ title: app.media.title, artist: app.media.artist }, st.track) && app.media.playing) {
          control("seek", Party.expectedPosition(party.hostState || st));
          break;
        }
      }
      party.applying = "";
      return;
    }
    if (!!app.media.playing !== st.playing) control("toggle");
    else if (st.playing && Math.abs(positionNow() - exp) > 3000) control("seek", exp);
  }
  async function partyPlayHere(st) {
    if (!player) return;
    const t = st.track;
    if (t.url) return player.playQueue([toTrack({ title: t.title, artist: t.artist, cover: t.cover, url: t.url, durationMs: t.durationMs }, t.service || "ytmusic")], 0);
    try {
      const res = await api.invoke("search_music", { service: "ytmusic", query: `${cleanTitle(t.title)} ${cleanArtist(t.artist)}`.trim() });
      const f = res?.tracks?.[0];
      if (f) player.playQueue([toTrack(f, "ytmusic")], 0);
      else toast(`Não achei "${t.title}" pra tocar aqui`);
    } catch (e) {
      toast(String(e));
    }
  }
  /** Experimental: abre a busca da música no app do Spotify (conta pro seu Wrapped).
   *  O Spotify não deixa dar o play sozinho de fora, então você clica na primeira;
   *  assim que ela começar, o app acerta o ponto com o anfitrião. */
  async function partyOpenInSpotify(st) {
    try {
      await api.invoke("open_url", { url: `spotify:search:${enc(`${cleanTitle(st.track.title)} ${cleanArtist(st.track.artist)}`.trim())}` });
      toast(`Abri "${st.track.title}" no Spotify: dá o play na primeira 🎧`, 5000);
    } catch (e) {
      toast(`Spotify: ${e?.message || e}. Tocando aqui no app.`, 3500);
      return partyPlayHere(st);
    }
  }

  // ---------- reações (emoji subindo na tela de todo mundo) ----------
  function showReaction(emoji, name) {
    if (!EMOJIS.includes(emoji)) return;
    const el = document.createElement("div");
    el.className = "reaction";
    el.style.left = `${12 + Math.random() * 76}%`;
    el.innerHTML = `<b>${emoji}</b><span>${esc(name || "")}</span>`;
    $("#reactLayer").appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  function react(emoji) {
    if (!party.room || Date.now() - party.lastReact < 1500) return;
    party.lastReact = Date.now();
    showReaction(emoji, myName());
    partySend({ type: "react", emoji });
  }

  // ---------- painel ----------
  function renderParty() {
    const inRoom = !!party.room;
    $("#btnParty").classList.toggle("on", inRoom);
    $("#btnParty").dataset.count = inRoom ? party.members.size : "";
    $("#partyOut").hidden = inRoom;
    $("#partyIn").hidden = !inRoom;
    $("#partyName").value = settings.partyName || "";
    if (!inRoom) return;
    $("#partyCode").textContent = party.room.code;
    $("#partyRole").textContent = party.role === "host" ? "Você é o anfitrião: o que você tocar, toca pra todo mundo." : "Seguindo o anfitrião da sala.";
    $("#partyDot").className = `dot ${party.status === "offline" ? "off" : "on"}`;
    $("#partyMembers").innerHTML = [...party.members.values()]
      .sort((a, b) => (b.role === "host") - (a.role === "host"))
      .map((m) => `<li><span class="av">${esc((m.name || "?")[0].toUpperCase())}</span>${esc(m.name)}${m.me ? " <small>(você)</small>" : ""}${m.role === "host" ? ` <small class="host">anfitrião</small>` : ""}</li>`)
      .join("");
    $("#partyGuestOpts").hidden = party.role !== "guest";
    $$("#segPartyMode button").forEach((b) => b.classList.toggle("sel", b.dataset.v === settings.partyMode));
    $("#partyReqs").hidden = party.role !== "host" || !party.requests.length;
    $("#partyReqList").innerHTML = party.requests
      .map((r, i) => `<li><div><b>${esc(r.title)}</b><span>${esc(r.artist || "")} · pedido por ${esc(r.from)}</span></div><button class="btn" data-req="${i}">Tocar a seguir</button></li>`)
      .join("");
  }
  $("#btnParty").addEventListener("click", () => {
    $("#partyPanel").hidden = !$("#partyPanel").hidden;
    renderParty();
  });
  $("#partyClose").addEventListener("click", () => ($("#partyPanel").hidden = true));
  $("#partyName").addEventListener("change", (e) => {
    settings.partyName = e.target.value.trim().slice(0, 24);
    saveSettings();
  });
  $("#partyCreate").addEventListener("click", () => {
    if (!settings.partyName) settings.partyName = $("#partyName").value.trim().slice(0, 24);
    saveSettings();
    partyEnter(Party.makeCode(), "host");
  });
  $("#partyJoinBtn").addEventListener("click", () => {
    const code = Party.normalizeCode($("#partyJoinCode").value);
    if (!code) return toast("Código inválido: são 16 letras/números, tipo K7QM-2X9P-RT4W-H8NA");
    settings.partyName = $("#partyName").value.trim().slice(0, 24) || settings.partyName;
    saveSettings();
    partyEnter(code, "guest");
  });
  $("#partyJoinCode").addEventListener("keydown", (e) => e.key === "Enter" && $("#partyJoinBtn").click());
  $("#partyLeave").addEventListener("click", () => partyLeave());
  $("#partyCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(party.room.code);
      toast("Código copiado: mande pros amigos 📋");
    } catch {
      toast(party.room.code, 6000);
    }
  });
  $("#partyReacts").addEventListener("click", (e) => e.target.dataset.e && react(e.target.dataset.e));
  $("#segPartyMode").addEventListener("click", (e) => {
    if (!e.target.dataset.v) return;
    settings.partyMode = e.target.dataset.v;
    saveSettings();
    renderParty();
  });
  $("#partyReqList").addEventListener("click", async (e) => {
    const i = e.target.dataset.req;
    if (i === undefined) return;
    const r = party.requests.splice(+i, 1)[0];
    renderParty();
    if (!player) return;
    if (r.url) player.queue.playNext(toTrack(r, r.service === "soundcloud" ? "soundcloud" : "ytmusic"));
    else player.queue.playNext({ ...trackFrom(r, "ytmusic"), url: null });
    toast(`"${r.title}" toca a seguir`);
  });
  window.addEventListener("beforeunload", () => party.room && partySend({ type: "bye" }));

  return {
    get party() { return party; },
    get partySend() { return partySend; },
  };
}
