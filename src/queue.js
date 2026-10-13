// Fila no estilo Spotify — funções puras sobre { tracks, index }.
// Músicas adicionadas pelo usuário ("Adicionar à fila") ficam marcadas com `user: true`
// e entram logo depois da atual, em ordem, antes do resto (resultados da busca, playlist…).

let nextId = 1;
/** Cópia da música com um id único na fila (a mesma música pode entrar duas vezes). */
export const withQid = (t, extra = {}) => ({ ...t, ...extra, qid: nextId++ });

/** "Tocar a seguir": entra logo depois da atual. */
export function insertNext(q, track) {
  const tracks = q.tracks.slice();
  tracks.splice(q.index + 1, 0, withQid(track, { user: true }));
  return { tracks, index: q.index };
}

/** "Adicionar à fila": depois das outras que o usuário já adicionou. */
export function enqueue(q, track) {
  let at = q.index + 1;
  while (at < q.tracks.length && q.tracks[at].user) at++;
  const tracks = q.tracks.slice();
  tracks.splice(at, 0, withQid(track, { user: true }));
  return { tracks, index: q.index };
}

/** Tira uma música (a que está tocando não sai). */
export function removeAt(q, i) {
  if (i === q.index || i < 0 || i >= q.tracks.length) return q;
  const tracks = q.tracks.slice();
  tracks.splice(i, 1);
  return { tracks, index: i < q.index ? q.index - 1 : q.index };
}

/** Arrasta a música `from` pra posição `to`, mantendo a atual apontada certo. */
export function moveItem(q, from, to) {
  const n = q.tracks.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return q;
  const tracks = q.tracks.slice();
  const [it] = tracks.splice(from, 1);
  tracks.splice(to, 0, it);
  let index = q.index;
  if (from === q.index) index = to;
  else if (from < q.index && to >= q.index) index--;
  else if (from > q.index && to <= q.index) index++;
  return { tracks, index };
}

/** Embaralha só o que vem depois da atual (as da fila do usuário continuam na frente). */
export function shuffleUpcoming(q, rand = Math.random) {
  const head = q.tracks.slice(0, q.index + 1);
  let i = q.index + 1;
  const user = [];
  while (i < q.tracks.length && q.tracks[i].user) user.push(q.tracks[i++]);
  const rest = q.tracks.slice(i);
  for (let k = rest.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [rest[k], rest[j]] = [rest[j], rest[k]];
  }
  return { tracks: [...head, ...user, ...rest], index: q.index };
}

/** Qual tocar depois. repeat: "off" | "all" | "one". -1 = acabou. */
export function nextIndex(q, repeat = "off", auto = false) {
  if (!q.tracks.length) return -1;
  if (auto && repeat === "one") return q.index;
  if (q.index + 1 < q.tracks.length) return q.index + 1;
  return repeat === "all" ? 0 : -1;
}

/** Ao passar pra próxima, ela deixa de ser "da fila do usuário". */
export function markPlayed(q, i) {
  if (!q.tracks[i]?.user) return q;
  const tracks = q.tracks.slice();
  tracks[i] = { ...tracks[i], user: false };
  return { tracks, index: q.index };
}
