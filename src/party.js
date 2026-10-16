// "Ouvir junto": código de convite, sala e criptografia.
// O código (ex.: K7QM-2X9P-RT4W-H8NA) gera duas coisas diferentes:
//  - o nome da sala no ntfy (um hash, então o código em si nunca vai pro servidor)
//  - a chave AES-GCM que embaralha cada mensagem
// Sem o código, ninguém entra nem lê o que passa pela sala.

const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: sem I, L, O, U

export function makeCode(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = rand(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += ALPHA[bytes[i] % 32];
  return out.match(/.{4}/g).join("-");
}

/** Aceita minúscula, sem traços, com espaços, O no lugar de 0… */
export function normalizeCode(s) {
  const clean = String(s || "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-Z]/g, "");
  if (clean.length !== 16 || [...clean].some((c) => !ALPHA.includes(c))) return null;
  return clean.match(/.{4}/g).join("-");
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Sala (nome no ntfy) + chave a partir do código. */
export async function roomFromCode(code) {
  const topicHash = await crypto.subtle.digest("SHA-256", enc.encode(`harle-room:${code}`));
  const keyBytes = await crypto.subtle.digest("SHA-256", enc.encode(`harle-key:${code}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { code, topic: `harle-${hex(topicHash).slice(0, 24)}`, key };
}

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
  const all = new Uint8Array(12 + data.length);
  all.set(iv);
  all.set(data, 12);
  return "hp1:" + b64(all);
}

/** null se não for da sala (chave errada, mensagem adulterada, lixo). */
export async function open(key, text) {
  try {
    if (!String(text).startsWith("hp1:")) return null;
    const all = unb64(text.slice(4));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

/** Mesma música? (ignora maiúsculas, "(Official Video)", "feat."…) */
export function sameSong(a, b) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, "")
      .replace(/\b(feat|ft)\.?.*$/, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return !!a && !!b && norm(a.title) === norm(b.title) && norm(a.artist).split(" ")[0] === norm(b.artist).split(" ")[0];
}

/** Onde o anfitrião está agora (ms), contando o tempo desde a mensagem. */
export function expectedPosition(state, now = Date.now()) {
  if (!state) return 0;
  const p = state.positionMs + (state.playing ? Math.max(0, now - state.at) : 0);
  return state.durationMs ? Math.min(p, state.durationMs) : p;
}
