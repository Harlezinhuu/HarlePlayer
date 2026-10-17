//! Busca direto no SoundCloud e no YouTube Music.
//!
//! Nenhum dos dois tem API pública aberta pra apps novos, então usamos as
//! APIs internas que os próprios sites usam (o mesmo caminho de projetos como
//! `ytmusicapi` e `yt-dlp`). Se o site mudar algo, a busca pode falhar — aí
//! o front cai pro Deezer automaticamente.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub source: String,
    pub tracks: Vec<Track>,
    pub artists: Vec<Artist>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub cover: Option<String>,
    /// link direto pra faixa
    pub url: String,
    pub duration_ms: Option<i64>,
    /// ordem: 0 = melhor resultado, 1 = música, 2 = vídeo
    #[serde(skip)]
    pub(crate) rank: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub name: String,
    pub picture: Option<String>,
    pub url: String,
}

/// Uma página da busca completa (aba "Músicas" ou "Artistas"), com cursor pra "carregar mais".
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub source: String,
    pub tracks: Vec<Track>,
    pub artists: Vec<Artist>,
    /// passa de volta pra pegar a próxima página; None = acabou
    pub next: Option<String>,
}

/// kind: "tracks" | "artists". cursor: o `next` da página anterior.
pub fn search_page(service: &str, query: &str, kind: &str, cursor: Option<&str>) -> Result<SearchPage, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchPage::default());
    }
    let artists = kind == "artists";
    match service {
        "soundcloud" => soundcloud::page(q, artists, cursor),
        "ytmusic" => ytmusic::page(q, kind, cursor),
        other => Err(format!("Busca não disponível para {other}")),
    }
}

// =====================================================================
// Importar playlist por link (Spotify, SoundCloud, YouTube / YouTube Music)
// =====================================================================
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPlaylist {
    /// "spotify" | "soundcloud" | "youtube"
    pub source: String,
    pub name: String,
    pub cover: Option<String>,
    /// link pra abrir no serviço (no Spotify: spotify:playlist:… abre o app)
    pub open_url: String,
    pub tracks: Vec<Track>,
}

/// Qual serviço e qual id/tipo um link aponta. Exposto pros testes.
pub fn classify_link(url: &str) -> Option<(&'static str, String, String)> {
    let u = url.trim();
    let lower = u.to_lowercase();
    if lower.starts_with("spotify:") {
        let mut parts = u.split(':').skip(1);
        let kind = parts.next()?.to_lowercase();
        let id = parts.next()?.to_string();
        return matches!(kind.as_str(), "playlist" | "album").then(|| ("spotify", kind, id));
    }
    if lower.contains("open.spotify.com/") {
        let path = u.split("open.spotify.com/").nth(1)?.split(['?', '#']).next()?;
        let segs: Vec<&str> = path.split('/').filter(|x| !x.is_empty() && !x.starts_with("intl-") && *x != "embed").collect();
        let (kind, id) = (segs.first()?.to_lowercase(), segs.get(1)?.to_string());
        return matches!(kind.as_str(), "playlist" | "album").then(|| ("spotify", kind, id));
    }
    if lower.contains("soundcloud.com/") && !lower.contains("api-v2.") {
        return Some(("soundcloud", "set".into(), u.split(['?', '#']).next()?.to_string()));
    }
    if lower.contains("youtube.com/") || lower.contains("youtu.be/") {
        let q = u.split('?').nth(1)?;
        let list = q.split('&').find_map(|kv| kv.strip_prefix("list="))?;
        let list = list.split('#').next()?.to_string();
        return (!list.is_empty()).then(|| ("youtube", "playlist".into(), list));
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePlaylist {
    pub name: String,
    pub url: String,
    pub cover: Option<String>,
    pub count: i64,
    /// playlist de outra pessoa que você curtiu
    pub liked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub avatar: Option<String>,
    pub url: String,
    pub likes_url: String,
    pub likes_count: i64,
    pub playlists: Vec<ProfilePlaylist>,
}

/// Perfil público do SoundCloud: curtidas e playlists, sem login.
pub fn soundcloud_profile(profile: &str) -> Result<Profile, String> {
    soundcloud::profile(profile)
}

pub fn import_playlist(url: &str) -> Result<ImportedPlaylist, String> {
    let (svc, kind, id) = classify_link(url)
        .ok_or("Esse link não parece de playlist do Spotify, SoundCloud ou YouTube")?;
    match svc {
        "spotify" => spotify::import(&kind, &id),
        "soundcloud" => soundcloud::import(&id),
        _ => ytmusic::import(&id),
    }
}

// ---------- Spotify (página pública de "embed", sem login) ----------
mod spotify {
    use super::*;

    pub fn import(kind: &str, id: &str) -> Result<ImportedPlaylist, String> {
        let html = http_get(&format!("https://open.spotify.com/embed/{kind}/{id}"))
            .map_err(|e| format!("Spotify: {}", err_text(e)))?;
        let v = next_data(&html).ok_or("Spotify: não consegui ler a playlist (ela é pública?)")?;
        parse(&v, kind, id).ok_or_else(|| "Spotify: a playlist veio vazia ou é privada".into())
    }

    /// O embed traz os dados num <script id="__NEXT_DATA__" type="application/json">.
    pub(crate) fn next_data(html: &str) -> Option<Value> {
        let i = html.find("id=\"__NEXT_DATA__\"")?;
        let start = i + html[i..].find('>')? + 1;
        let end = start + html[start..].find("</script>")?;
        serde_json::from_str(&html[start..end]).ok()
    }

    fn find_entity(v: &Value) -> Option<&Value> {
        match v {
            Value::Object(m) => {
                if m.get("trackList").map(|t| t.is_array()).unwrap_or(false) {
                    return Some(v);
                }
                m.values().find_map(find_entity)
            }
            Value::Array(a) => a.iter().find_map(find_entity),
            _ => None,
        }
    }

    fn best_image(v: &Value) -> Option<String> {
        let list = v["coverArt"]["sources"].as_array().or_else(|| v["images"].as_array())?;
        list.iter()
            .max_by_key(|x| x["width"].as_i64().or_else(|| x["maxWidth"].as_i64()).unwrap_or(0))
            .and_then(|x| x["url"].as_str())
            .map(String::from)
    }

    pub(crate) fn parse(v: &Value, kind: &str, id: &str) -> Option<ImportedPlaylist> {
        let e = find_entity(v)?;
        let cover = best_image(e);
        let tracks: Vec<Track> = e["trackList"]
            .as_array()?
            .iter()
            .filter_map(|t| {
                let title = t["title"].as_str()?.trim().to_string();
                let uri = t["uri"].as_str().unwrap_or("");
                let tid = uri.strip_prefix("spotify:track:")?;
                Some(Track {
                    title,
                    artist: t["subtitle"].as_str().unwrap_or("").replace('\u{a0}', " ").trim().to_string(),
                    cover: None,
                    url: format!("https://open.spotify.com/track/{tid}"),
                    duration_ms: t["duration"].as_i64(),
                    rank: 1,
                })
            })
            .collect();
        if tracks.is_empty() {
            return None;
        }
        let name = e["name"].as_str().or_else(|| e["title"].as_str()).unwrap_or("Playlist do Spotify").to_string();
        Some(ImportedPlaylist {
            source: "spotify".into(),
            name,
            cover,
            open_url: format!("spotify:{kind}:{id}"),
            tracks,
        })
    }
}

pub fn search(service: &str, query: &str) -> Result<SearchResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult::default());
    }
    match service {
        "soundcloud" => soundcloud::search(q),
        "ytmusic" => ytmusic::search(q),
        other => Err(format!("Busca não disponível para {other}")),
    }
}

// ---------- HTTP ----------

enum HttpErr {
    Status(u16),
    Other(String),
}

fn err_text(e: HttpErr) -> String {
    match e {
        HttpErr::Status(c) => format!("o servidor respondeu {c}"),
        HttpErr::Other(m) => m,
    }
}

fn http_get(url: &str) -> Result<String, HttpErr> {
    match ureq::get(url)
        .set("User-Agent", BROWSER_UA)
        .set("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8")
        .timeout(Duration::from_secs(12))
        .call()
    {
        Ok(r) => r.into_string().map_err(|e| HttpErr::Other(e.to_string())),
        Err(ureq::Error::Status(c, _)) => Err(HttpErr::Status(c)),
        Err(e) => Err(HttpErr::Other(e.to_string())),
    }
}

/// Limite de tamanho de um áudio baixado (mixes longas de DJ cabem).
const MAX_AUDIO: usize = 250 * 1024 * 1024;

pub(crate) fn http_bytes(url: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let resp = ureq::get(url)
        .set("User-Agent", BROWSER_UA)
        .timeout(Duration::from_secs(180))
        .call()
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_AUDIO as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > MAX_AUDIO {
        return Err("Arquivo de áudio grande demais".into());
    }
    Ok(buf)
}

/// Prepara a busca do SoundCloud em segundo plano (chamado quando o app abre).
pub fn warm_up() {
    std::thread::spawn(soundcloud::warm_up);
}

/// Baixa o áudio de uma música do SoundCloud (link da faixa) pra tocar dentro do app.
pub fn soundcloud_audio(permalink: &str) -> Result<Vec<u8>, String> {
    soundcloud::audio(permalink)
}

fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// =====================================================================
// SoundCloud — api-v2.soundcloud.com com o client_id público do site
// =====================================================================
mod soundcloud {
    use super::*;

    static CLIENT_ID: Mutex<Option<String>> = Mutex::new(None);

    fn find_client_id(text: &str) -> Option<String> {
        for pat in ["client_id:\"", "\"client_id\":\"", "client_id=\"", "client_id="] {
            let mut start = 0;
            while let Some(i) = text[start..].find(pat) {
                let from = start + i + pat.len();
                let id: String = text[from..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                if id.len() == 32 {
                    return Some(id);
                }
                start = from;
            }
        }
        None
    }

    /// O site carrega o client_id dentro de um dos arquivos .js da página inicial.
    /// Baixa todos os .js ao mesmo tempo e fica com o primeiro que tiver o id.
    fn fetch_client_id() -> Result<String, String> {
        let html = http_get("https://soundcloud.com/")
            .map_err(|e| format!("não abriu soundcloud.com ({})", err_text(e)))?;
        if let Some(id) = find_client_id(&html) {
            return Ok(id);
        }
        let mut scripts = Vec::new();
        let mut rest = html.as_str();
        while let Some(i) = rest.find("src=\"https://a-v2.sndcdn.com/assets/") {
            let s = &rest[i + 5..];
            match s.find('"') {
                Some(end) => {
                    scripts.push(s[..end].to_string());
                    rest = &s[end..];
                }
                None => break,
            }
        }
        if scripts.is_empty() {
            return Err("a página do SoundCloud veio sem os scripts (bloqueio ou captcha?)".into());
        }
        // geralmente está num dos últimos; baixa tudo em paralelo
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
        let total = scripts.len();
        for src in scripts.into_iter().rev() {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let found = http_get(&src).ok().and_then(|js| find_client_id(&js));
                let _ = tx.send(found);
            });
        }
        drop(tx);
        for _ in 0..total {
            match rx.recv_timeout(Duration::from_secs(20)) {
                Ok(Some(id)) => return Ok(id),
                Ok(None) => continue,
                Err(_) => break,
            }
        }
        Err("não achei o client_id nos scripts do SoundCloud".into())
    }

    /// Arquivo onde o client_id fica guardado entre uma abertura e outra.
    fn cache_file() -> std::path::PathBuf {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("com.harlezinhuu.harleplayer").join("soundcloud_client_id.txt")
    }

    fn client_id(refresh: bool) -> Result<String, String> {
        let mut guard = CLIENT_ID.lock().unwrap();
        if guard.is_none() && !refresh {
            if let Ok(saved) = std::fs::read_to_string(cache_file()) {
                let saved = saved.trim().to_string();
                if saved.len() == 32 && saved.chars().all(|c| c.is_ascii_alphanumeric()) {
                    *guard = Some(saved);
                }
            }
        }
        if refresh || guard.is_none() {
            let id = fetch_client_id().map_err(|e| format!("SoundCloud: {e}"))?;
            let file = cache_file();
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&file, &id);
            *guard = Some(id);
        }
        Ok(guard.clone().unwrap_or_default())
    }

    /// Deixa o client_id pronto antes da primeira busca.
    pub fn warm_up() {
        let _ = client_id(false);
    }

    fn api(path: &str, q: &str, limit: u32) -> Result<Value, String> {
        api_at(path, q, limit, 0)
    }

    fn api_at(path: &str, q: &str, limit: u32, offset: u32) -> Result<Value, String> {
        for attempt in 0..2 {
            let id = client_id(attempt == 1)?;
            let url = format!(
                "https://api-v2.soundcloud.com/{path}?q={}&client_id={id}&limit={limit}&offset={offset}&app_locale=pt_BR",
                enc(q)
            );
            match http_get(&url) {
                Ok(t) => return serde_json::from_str(&t).map_err(|e| e.to_string()),
                // client_id expirou → pega outro e tenta de novo
                Err(HttpErr::Status(401 | 403)) if attempt == 0 => continue,
                Err(e) => return Err(format!("SoundCloud: {}", err_text(e))),
            }
        }
        Err("SoundCloud recusou a busca".into())
    }

    fn big(url: Option<&str>) -> Option<String> {
        url.filter(|u| !u.is_empty())
            .map(|u| u.replace("-large.", "-t500x500."))
    }

    fn track(v: &Value) -> Option<Track> {
        Some(Track {
            title: v["title"].as_str()?.to_string(),
            artist: v["user"]["username"].as_str().unwrap_or("").to_string(),
            cover: big(v["artwork_url"].as_str()).or_else(|| big(v["user"]["avatar_url"].as_str())),
            url: v["permalink_url"].as_str()?.to_string(),
            duration_ms: v["duration"].as_i64(),
            rank: 1,
        })
    }

    fn user(v: &Value) -> Option<Artist> {
        Some(Artist {
            name: v["username"].as_str()?.to_string(),
            picture: big(v["avatar_url"].as_str()),
            url: v["permalink_url"].as_str()?.to_string(),
        })
    }

    /// GET numa URL da api-v2 acrescentando o client_id (renova se expirou).
    fn api_get(url: &str) -> Result<Value, String> {
        for attempt in 0..2 {
            let id = client_id(attempt == 1)?;
            let sep = if url.contains('?') { '&' } else { '?' };
            match http_get(&format!("{url}{sep}client_id={id}")) {
                Ok(t) => return serde_json::from_str(&t).map_err(|e| e.to_string()),
                Err(HttpErr::Status(401 | 403)) if attempt == 0 => continue,
                Err(HttpErr::Status(404)) => {
                    let path = url.split('?').next().unwrap_or(url).replace("https://api-v2.soundcloud.com", "");
                    return Err(format!("SoundCloud não achou ({path})"));
                }
                Err(e) => return Err(format!("SoundCloud: {}", err_text(e))),
            }
        }
        Err("SoundCloud recusou o pedido".into())
    }

    /// Playlist/álbum do SoundCloud pelo link (até 500 faixas).
    pub fn import(url: &str) -> Result<ImportedPlaylist, String> {
        // soundcloud.com/fulano/likes → curtidas do fulano
        let clean = url.trim().trim_end_matches('/');
        if let Some(profile) = clean.strip_suffix("/likes") {
            return likes(profile);
        }
        let v = api_get(&format!("https://api-v2.soundcloud.com/resolve?url={}", enc(url)))?;
        if v["kind"].as_str() == Some("user") {
            return likes(clean);
        }
        if v["kind"].as_str() != Some("playlist") {
            return Err("Esse link do SoundCloud não é de uma playlist ou álbum".into());
        }
        let list = v["tracks"].as_array().cloned().unwrap_or_default();
        // as primeiras vêm completas; o resto vem só com o id
        let missing: Vec<String> = list
            .iter()
            .filter(|t| t["title"].as_str().is_none())
            .filter_map(|t| t["id"].as_i64().map(|i| i.to_string()))
            .take(500)
            .collect();
        let mut full: std::collections::HashMap<i64, Value> = std::collections::HashMap::new();
        for chunk in missing.chunks(50) {
            if let Ok(Value::Array(a)) = api_get(&format!("https://api-v2.soundcloud.com/tracks?ids={}", chunk.join("%2C"))) {
                for t in a {
                    if let Some(id) = t["id"].as_i64() {
                        full.insert(id, t);
                    }
                }
            }
        }
        let tracks: Vec<Track> = list
            .iter()
            .take(500)
            .filter_map(|t| {
                if t["title"].is_string() {
                    track(t)
                } else {
                    t["id"].as_i64().and_then(|id| full.get(&id)).and_then(track)
                }
            })
            .collect();
        if tracks.is_empty() {
            return Err("A playlist do SoundCloud veio vazia".into());
        }
        Ok(ImportedPlaylist {
            source: "soundcloud".into(),
            name: v["title"].as_str().unwrap_or("Playlist do SoundCloud").to_string(),
            cover: big(v["artwork_url"].as_str()).or_else(|| tracks[0].cover.clone()),
            open_url: v["permalink_url"].as_str().unwrap_or(url).to_string(),
            tracks,
        })
    }

    /// Perfil pelo link (ou só o nome: "fulano" → soundcloud.com/fulano).
    fn resolve_user(profile: &str) -> Result<Value, String> {
        let p = profile.trim().trim_end_matches('/');
        let url = if p.contains("soundcloud.com/") {
            let after = p.split("soundcloud.com/").nth(1).unwrap_or("");
            let name = after.split(['/', '?', '#']).next().unwrap_or("");
            format!("https://soundcloud.com/{name}")
        } else {
            format!("https://soundcloud.com/{}", p.trim_start_matches('@'))
        };
        let v = api_get(&format!("https://api-v2.soundcloud.com/resolve?url={}", enc(&url)))
            .map_err(|e| if e.contains("não achou") { "Não achei esse perfil no SoundCloud".to_string() } else { e })?;
        if v["kind"].as_str() != Some("user") {
            return Err("Esse link não é de um perfil do SoundCloud".into());
        }
        Ok(v)
    }

    /// Segue o "next_href" das listas paginadas da api-v2 até `max` itens.
    fn paged(first: &str, max: usize) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let mut url = first.to_string();
        for _ in 0..20 {
            let v = api_get(&url)?;
            if let Some(a) = v["collection"].as_array() {
                out.extend(a.iter().cloned());
            }
            if out.len() >= max {
                break;
            }
            match v["next_href"].as_str() {
                // o next_href às vezes já vem com um client_id velho: tira pra pôr o atual
                Some(n) if !n.is_empty() => {
                    url = n
                        .split('&')
                        .filter(|kv| !kv.starts_with("client_id="))
                        .collect::<Vec<_>>()
                        .join("&");
                }
                _ => break,
            }
        }
        out.truncate(max);
        Ok(out)
    }

    /// Músicas curtidas de um perfil (são públicas no SoundCloud), até 1000.
    pub fn likes(profile: &str) -> Result<ImportedPlaylist, String> {
        let u = resolve_user(profile)?;
        let id = u["id"].as_i64().ok_or("perfil sem id")?;
        let items = paged(&format!("https://api-v2.soundcloud.com/users/{id}/track_likes?limit=200&linked_partitioning=1"), 1000)?;
        let tracks: Vec<Track> = items.iter().filter_map(|it| track(&it["track"])).collect();
        let name = u["username"].as_str().unwrap_or("você");
        if tracks.is_empty() {
            return Err(format!("{name} ainda não curtiu nenhuma música (ou as curtidas estão escondidas)"));
        }
        Ok(ImportedPlaylist {
            source: "soundcloud".into(),
            name: "Curtidas no SoundCloud".into(),
            cover: big(u["avatar_url"].as_str()),
            open_url: format!("{}/likes", u["permalink_url"].as_str().unwrap_or("https://soundcloud.com")),
            tracks,
        })
    }

    /// Perfil: nome, foto e as playlists (as suas e as que você curtiu).
    pub fn profile(profile: &str) -> Result<Profile, String> {
        let u = resolve_user(profile)?;
        let id = u["id"].as_i64().ok_or("perfil sem id")?;
        let link = u["permalink_url"].as_str().unwrap_or("").to_string();
        let to_pl = |p: &Value, liked: bool| -> Option<ProfilePlaylist> {
            Some(ProfilePlaylist {
                name: p["title"].as_str()?.to_string(),
                url: p["permalink_url"].as_str()?.to_string(),
                cover: big(p["artwork_url"].as_str()),
                count: p["track_count"].as_i64().unwrap_or(0),
                liked,
            })
        };
        let mut playlists: Vec<ProfilePlaylist> = paged(&format!("https://api-v2.soundcloud.com/users/{id}/playlists_without_albums?limit=50&linked_partitioning=1"), 100)
            .or_else(|_| paged(&format!("https://api-v2.soundcloud.com/users/{id}/playlists?limit=50&linked_partitioning=1"), 100))
            .unwrap_or_default()
            .iter()
            .filter_map(|p| to_pl(p, false))
            .collect();
        if let Ok(liked) = paged(&format!("https://api-v2.soundcloud.com/users/{id}/playlist_likes?limit=50&linked_partitioning=1"), 100) {
            playlists.extend(liked.iter().filter_map(|it| to_pl(&it["playlist"], true)));
        }
        Ok(Profile {
            name: u["username"].as_str().unwrap_or("").to_string(),
            avatar: big(u["avatar_url"].as_str()),
            likes_url: format!("{link}/likes"),
            likes_count: u["likes_count"].as_i64().unwrap_or(0),
            url: link,
            playlists,
        })
    }

    /// Formatos tocáveis sem DRM, do melhor pro pior (os "encrypted-hls" ficam de fora).
    pub(super) fn playable_transcodings(track: &Value) -> Vec<&Value> {
        let Some(list) = track["media"]["transcodings"].as_array() else { return Vec::new() };
        let score = |t: &Value| -> Option<u8> {
            let proto = t["format"]["protocol"].as_str()?;
            let mime = t["format"]["mime_type"].as_str().unwrap_or("");
            match proto {
                "progressive" if mime.starts_with("audio/mpeg") => Some(0),
                "hls" if mime.starts_with("audio/mpeg") => Some(1),
                "hls" if mime.starts_with("audio/mp4") => Some(2),
                "hls" if mime.starts_with("audio/ogg") => Some(3),
                _ => None,
            }
        };
        let mut v: Vec<(u8, &Value)> = list
            .iter()
            .filter(|t| t["url"].is_string())
            .filter_map(|t| score(t).map(|s| (s, t)))
            .collect();
        v.sort_by_key(|(s, _)| *s);
        v.into_iter().map(|(_, t)| t).collect()
    }

    #[allow(dead_code)]
    pub(super) fn pick_transcoding(track: &Value) -> Option<&Value> {
        let list = track["media"]["transcodings"].as_array()?;
        let score = |t: &Value| -> Option<u8> {
            let proto = t["format"]["protocol"].as_str()?;
            let mime = t["format"]["mime_type"].as_str().unwrap_or("");
            match proto {
                "progressive" if mime.starts_with("audio/mpeg") => Some(0),
                "hls" if mime.starts_with("audio/mpeg") => Some(1),
                "hls" if mime.starts_with("audio/mp4") => Some(2),
                "hls" if mime.starts_with("audio/ogg") => Some(3),
                _ => None,
            }
        };
        list.iter()
            .filter(|t| t["url"].is_string())
            .filter_map(|t| score(t).map(|s| (s, t)))
            .min_by_key(|(s, _)| *s)
            .map(|(_, t)| t)
    }

    pub fn audio(permalink: &str) -> Result<Vec<u8>, String> {
        if !permalink.starts_with("https://soundcloud.com/") {
            return Err("Link do SoundCloud inválido".into());
        }
        let track = api_get(&format!("https://api-v2.soundcloud.com/resolve?url={}", enc(permalink)))?;
        if track["kind"] != "track" {
            return Err("Esse link não é uma música".into());
        }
        if track["policy"] == "BLOCK" {
            return Err("O SoundCloud bloqueou essa música na sua região".into());
        }
        let options = playable_transcodings(&track);
        if options.is_empty() {
            return Err("Essa música é protegida e só toca no app oficial do SoundCloud".into());
        }
        // tenta cada formato até um funcionar (música de gravadora às vezes
        // lista formatos que respondem 404)
        let mut last_err = String::new();
        for tc in options {
            match download_transcoding(&track, tc) {
                Ok(bytes) => return Ok(bytes),
                Err(e) => last_err = e,
            }
        }
        Err(format!("Essa música não liberou o áudio fora do app oficial do SoundCloud ({last_err})"))
    }

    fn download_transcoding(track: &Value, tc: &Value) -> Result<Vec<u8>, String> {
        let mut stream_api = tc["url"].as_str().unwrap_or_default().to_string();
        if let Some(auth) = track["track_authorization"].as_str() {
            stream_api = format!("{stream_api}?track_authorization={auth}");
        }
        let info = api_get(&stream_api)?;
        let media_url = info["url"].as_str().ok_or("O SoundCloud não mandou o link do áudio")?;

        if tc["format"]["protocol"] == "progressive" {
            return http_bytes(media_url);
        }
        // HLS: baixa a playlist e junta os pedaços num arquivo só
        let playlist = http_get(media_url).map_err(err_text)?;
        let mut out = Vec::new();
        for part in hls_parts(media_url, &playlist) {
            out.extend(http_bytes(&part)?);
            if out.len() > MAX_AUDIO {
                return Err("Música grande demais".into());
            }
        }
        if out.is_empty() {
            return Err("O SoundCloud mandou uma playlist de áudio vazia".into());
        }
        Ok(out)
    }

    /// Pedaços de uma playlist HLS em ordem (o "init" do EXT-X-MAP vem primeiro).
    pub(super) fn hls_parts(base: &str, playlist: &str) -> Vec<String> {
        let mut parts = Vec::new();
        for line in playlist.lines().map(str::trim) {
            if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
                if let Some(i) = rest.find("URI=\"") {
                    let uri = &rest[i + 5..];
                    if let Some(end) = uri.find('"') {
                        parts.push(join_url(base, &uri[..end]));
                    }
                }
            } else if !line.is_empty() && !line.starts_with('#') {
                parts.push(join_url(base, line));
            }
        }
        parts
    }

    fn join_url(base: &str, rel: &str) -> String {
        if rel.starts_with("http://") || rel.starts_with("https://") {
            return rel.to_string();
        }
        let base = base.split('?').next().unwrap_or(base);
        if rel.starts_with('/') {
            let after = base.find("://").map(|i| i + 3).unwrap_or(0);
            let host_end = base[after..].find('/').map(|i| after + i).unwrap_or(base.len());
            return format!("{}{}", &base[..host_end], rel);
        }
        match base.rfind('/') {
            Some(i) => format!("{}/{}", &base[..i], rel),
            None => rel.to_string(),
        }
    }

    /// Página da busca completa: 30 por vez, até ~300 resultados.
    pub fn page(q: &str, artists: bool, cursor: Option<&str>) -> Result<SearchPage, String> {
        const LIMIT: u32 = 30;
        let offset: u32 = cursor.and_then(|c| c.parse().ok()).unwrap_or(0);
        let path = if artists { "search/users" } else { "search/tracks" };
        let v = api_at(path, q, LIMIT, offset)?;
        let empty = Value::Null;
        let r = if artists { parse(&empty, &v) } else { parse(&v, &empty) };
        let got = v["collection"].as_array().map(|a| a.len()).unwrap_or(0) as u32;
        let more = got > 0 && v["next_href"].as_str().is_some() && offset + LIMIT < 300;
        Ok(SearchPage {
            source: "soundcloud".into(),
            tracks: r.tracks,
            artists: r.artists,
            next: more.then(|| (offset + LIMIT).to_string()),
        })
    }

    pub fn search(q: &str) -> Result<SearchResult, String> {
        client_id(false)?; // garante o id antes das duas buscas paralelas
        let q2 = q.to_string();
        let users = std::thread::spawn(move || api("search/users", &q2, 10).unwrap_or(Value::Null));
        let tracks_json = api("search/tracks", q, 20)?;
        let users_json = users.join().unwrap_or(Value::Null);
        Ok(parse(&tracks_json, &users_json))
    }

    #[cfg(test)]
    pub(super) fn client_id_for_test() -> Option<String> {
        client_id(false).ok()
    }

    #[cfg(test)]
    pub(super) fn hls_parts_for_test(base: &str, pl: &str) -> Vec<String> {
        hls_parts(base, pl)
    }

    #[cfg(test)]
    pub(super) fn playable_for_test(t: &Value) -> Vec<&str> {
        playable_transcodings(t).into_iter().filter_map(|x| x["url"].as_str()).collect()
    }

    #[cfg(test)]
    pub(super) fn pick_for_test(t: &Value) -> Option<&str> {
        pick_transcoding(t).and_then(|x| x["url"].as_str())
    }

    #[cfg(test)]
    pub(super) fn find_client_id_for_test(t: &str) -> Option<String> {
        find_client_id(t)
    }

    #[cfg(test)]
    pub(super) fn parse_for_test(tracks_json: &Value, users_json: &Value) -> SearchResult {
        parse(tracks_json, users_json)
    }

    fn parse(tracks_json: &Value, users_json: &Value) -> SearchResult {
        let tracks = tracks_json["collection"]
            .as_array()
            .map(|a| a.iter().filter_map(track).collect())
            .unwrap_or_default();
        let artists = users_json["collection"]
            .as_array()
            .map(|a| a.iter().filter_map(user).collect())
            .unwrap_or_default();
        SearchResult {
            source: "soundcloud".into(),
            tracks,
            artists,
        }
    }
}

// =====================================================================
// YouTube Music — youtubei/v1/search (a API interna do site)
// =====================================================================
mod ytmusic {
    use super::*;

    static NULL: Value = Value::Null;

    /// Filtros da busca (os mesmos que o site usa nas abas "Músicas" e "Artistas").
    const FILTER_SONGS: &str = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
    const FILTER_ARTISTS: &str = "EgWKAQIgAWoMEA4QChADEAQQCRAF";
    const FILTER_VIDEOS: &str = "EgWKAQIQAWoMEA4QChADEAQQCRAF";

    fn post(url: &str, body: &Value) -> Result<Value, String> {
        let resp = ureq::post(url)
            .set("User-Agent", BROWSER_UA)
            .set("Content-Type", "application/json")
            .set("Origin", "https://music.youtube.com")
            .set("Referer", "https://music.youtube.com/")
            .timeout(Duration::from_secs(12))
            .send_string(&body.to_string());
        let text = match resp {
            Ok(r) => r.into_string().map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(c, _)) => return Err(format!("YouTube Music respondeu {c}")),
            Err(e) => return Err(e.to_string()),
        };
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    fn context() -> Value {
        json!({ "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": "1.20250310.01.00",
            "hl": "pt",
            "gl": "BR"
        }})
    }

    /// Página da busca completa (filtrada em músicas ou artistas), com continuação.
    /// kind: "tracks" | "artists" | "videos" (clipes)
    pub fn page(q: &str, kind: &str, cursor: Option<&str>) -> Result<SearchPage, String> {
        let artists = kind == "artists";
        let base = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
        let v = match cursor {
            Some(c) => post(&format!("{base}&ctoken={0}&continuation={0}&type=next", enc(c)), &json!({ "context": context() }))?,
            None => post(base, &json!({
                "context": context(),
                "query": q,
                "params": match kind { "artists" => FILTER_ARTISTS, "videos" => FILTER_VIDEOS, _ => FILTER_SONGS },
            }))?,
        };
        Ok(page_from(&v, artists))
    }

    pub(super) fn page_from(v: &Value, artists: bool) -> SearchPage {
        let mut out = SearchResult::default();
        let mut seen = HashSet::new();
        walk(v, &mut out, &mut seen);
        let next = find_continuation(v);
        let (tracks, artists_v) = if artists { (Vec::new(), out.artists) } else { (out.tracks, Vec::new()) };
        let got = tracks.len() + artists_v.len();
        SearchPage {
            source: "ytmusic".into(),
            tracks,
            artists: artists_v,
            next: if got > 0 { next } else { None },
        }
    }

    /// Token de "mais resultados" (o nome do campo muda de versão pra versão do site).
    fn find_continuation(v: &Value) -> Option<String> {
        match v {
            Value::Object(m) => {
                for key in ["nextContinuationData", "continuationCommand"] {
                    if let Some(c) = m.get(key) {
                        if let Some(t) = c["continuation"].as_str().or_else(|| c["token"].as_str()) {
                            return Some(t.to_string());
                        }
                    }
                }
                m.values().find_map(find_continuation)
            }
            Value::Array(a) => a.iter().find_map(find_continuation),
            _ => None,
        }
    }

    /// Playlist do YouTube / YouTube Music pelo id (list=…), até 500 faixas.
    pub fn import(list: &str) -> Result<ImportedPlaylist, String> {
        let base = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false";
        let browse_id = if list.starts_with("VL") { list.to_string() } else { format!("VL{list}") };
        let first = post(base, &json!({ "context": context(), "browseId": browse_id }))?;
        let mut out = SearchResult::default();
        let mut seen = HashSet::new();
        walk(&first, &mut out, &mut seen);
        let (name, cover) = header_info(&first);
        let mut next = find_continuation(&first);
        let mut pages = 0;
        while let Some(c) = next.take() {
            pages += 1;
            if pages > 10 || out.tracks.len() >= 500 {
                break;
            }
            let before = out.tracks.len();
            let Ok(v) = post(
                &format!("{base}&ctoken={0}&continuation={0}&type=next", enc(&c)),
                &json!({ "context": context(), "continuation": c }),
            ) else { break };
            walk(&v, &mut out, &mut seen);
            if out.tracks.len() == before {
                break;
            }
            next = find_continuation(&v);
        }
        if out.tracks.is_empty() {
            return Err("A playlist do YouTube veio vazia (ela é pública?)".into());
        }
        out.tracks.truncate(500);
        Ok(ImportedPlaylist {
            source: "youtube".into(),
            name: name.unwrap_or_else(|| "Playlist do YouTube".into()),
            cover: cover.or_else(|| out.tracks[0].cover.clone()),
            open_url: format!("https://music.youtube.com/playlist?list={}", list.trim_start_matches("VL")),
            tracks: out.tracks,
        })
    }

    /// Nome e capa no cabeçalho da playlist (o nome do bloco muda entre versões do site).
    fn header_info(v: &Value) -> (Option<String>, Option<String>) {
        fn find<'a>(v: &'a Value) -> Option<&'a Value> {
            match v {
                Value::Object(m) => {
                    for k in ["musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicEditablePlaylistDetailHeaderRenderer", "musicImmersiveHeaderRenderer"] {
                        if let Some(h) = m.get(k) {
                            return Some(h);
                        }
                    }
                    m.values().find_map(find)
                }
                Value::Array(a) => a.iter().find_map(find),
                _ => None,
            }
        }
        fn thumbs(v: &Value) -> Option<String> {
            match v {
                Value::Object(m) => {
                    if let Some(list) = m.get("thumbnails").and_then(|t| t.as_array()) {
                        if let Some(u) = list.last().and_then(|x| x["url"].as_str()) {
                            return Some(upscale(u));
                        }
                    }
                    m.values().find_map(thumbs)
                }
                Value::Array(a) => a.iter().find_map(thumbs),
                _ => None,
            }
        }
        let Some(h) = find(v) else { return (None, None) };
        let name = Some(text_of(&h["title"])).filter(|t| !t.is_empty());
        (name, thumbs(&h["thumbnail"]).or_else(|| thumbs(h)))
    }

    pub fn search(q: &str) -> Result<SearchResult, String> {
        let body = json!({
            "context": { "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20250310.01.00",
                "hl": "pt",
                "gl": "BR"
            }},
            "query": q
        });
        let resp = ureq::post("https://music.youtube.com/youtubei/v1/search?prettyPrint=false")
            .set("User-Agent", BROWSER_UA)
            .set("Content-Type", "application/json")
            .set("Origin", "https://music.youtube.com")
            .set("Referer", "https://music.youtube.com/")
            .timeout(Duration::from_secs(12))
            .send_string(&body.to_string());
        let text = match resp {
            Ok(r) => r.into_string().map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(c, _)) => return Err(format!("YouTube Music respondeu {c}")),
            Err(e) => return Err(e.to_string()),
        };
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(parse(&v))
    }

    /// Transforma a resposta do YouTube Music em músicas + artistas.
    pub(super) fn parse(v: &Value) -> SearchResult {
        let mut out = SearchResult {
            source: "ytmusic".into(),
            ..Default::default()
        };
        let mut seen = HashSet::new();
        walk(v, &mut out, &mut seen);
        // melhor resultado → músicas → vídeos (sort estável mantém a ordem do site)
        out.tracks.sort_by_key(|t| t.rank);
        out.tracks.truncate(20);
        out.artists.truncate(10);
        out
    }

    /// Percorre o JSON inteiro atrás dos "cards" de resultado. É mais
    /// resistente a mudanças de layout do que seguir um caminho fixo.
    fn walk(v: &Value, out: &mut SearchResult, seen: &mut HashSet<String>) {
        match v {
            Value::Object(map) => {
                for (k, child) in map {
                    match k.as_str() {
                        "musicResponsiveListItemRenderer" => parse_item(child, out, seen),
                        "musicCardShelfRenderer" => {
                            parse_card(child, out, seen);
                            walk(&child["contents"], out, seen);
                        }
                        _ => walk(child, out, seen),
                    }
                }
            }
            Value::Array(a) => {
                for c in a {
                    walk(c, out, seen);
                }
            }
            _ => {}
        }
    }

    fn runs(v: &Value) -> Vec<&Value> {
        v["runs"].as_array().map(|a| a.iter().collect()).unwrap_or_default()
    }

    fn text_of(v: &Value) -> String {
        runs(v).iter().filter_map(|r| r["text"].as_str()).collect()
    }

    fn page_type(nav: &Value) -> &str {
        nav["browseEndpoint"]["browseEndpointContextSupportedConfigs"]["browseEndpointContextMusicConfig"]
            ["pageType"]
            .as_str()
            .unwrap_or("")
    }

    fn upscale(u: &str) -> String {
        if u.contains("googleusercontent.com") {
            if let Some(i) = u.rfind("=w") {
                return format!("{}=w400-h400-l90-rj", &u[..i]);
            }
        }
        u.to_string()
    }

    fn thumb(v: &Value) -> Option<String> {
        let list = v["thumbnail"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"].as_array()?;
        Some(upscale(list.last()?["url"].as_str()?))
    }

    fn find_video_id(v: &Value) -> Option<String> {
        match v {
            Value::Object(m) => {
                if let Some(id) = m.get("videoId").and_then(|x| x.as_str()) {
                    return Some(id.to_string());
                }
                m.values().find_map(find_video_id)
            }
            Value::Array(a) => a.iter().find_map(find_video_id),
            _ => None,
        }
    }

    fn is_label(t: &str) -> bool {
        matches!(
            t.trim(),
            "" | "•" | "Música" | "Song" | "Vídeo" | "Video" | "Episódio" | "Episode" | "Single" | "EP" | "Álbum" | "Album"
        )
    }

    fn parse_duration(t: &str) -> Option<i64> {
        let parts: Vec<&str> = t.trim().split(':').collect();
        if !(2..=3).contains(&parts.len()) {
            return None;
        }
        let mut total = 0i64;
        for p in parts {
            total = total * 60 + p.parse::<i64>().ok()?;
        }
        Some(total * 1000)
    }

    fn artist_from(subtitle: &[&Value]) -> String {
        subtitle
            .iter()
            .find(|r| page_type(&r["navigationEndpoint"]) == "MUSIC_PAGE_TYPE_ARTIST")
            .and_then(|r| r["text"].as_str())
            .or_else(|| {
                subtitle
                    .iter()
                    .filter_map(|r| r["text"].as_str())
                    .find(|t| !is_label(t) && parse_duration(t).is_none())
            })
            .unwrap_or("")
            .to_string()
    }

    fn push_artist(out: &mut SearchResult, seen: &mut HashSet<String>, name: String, nav: &Value, src: &Value) {
        if let Some(id) = nav["browseEndpoint"]["browseId"].as_str() {
            if seen.insert(id.to_string()) {
                out.artists.push(Artist {
                    name,
                    picture: thumb(src),
                    url: format!("https://music.youtube.com/channel/{id}"),
                });
            }
        }
    }

    fn column(cols: &[Value], i: usize) -> &Value {
        cols.get(i)
            .map(|c| &c["musicResponsiveListItemFlexColumnRenderer"]["text"])
            .unwrap_or(&NULL)
    }

    fn parse_item(item: &Value, out: &mut SearchResult, seen: &mut HashSet<String>) {
        let Some(cols) = item["flexColumns"].as_array() else { return };
        let col = |i: usize| column(cols, i);
        let title = text_of(col(0));
        if title.is_empty() {
            return;
        }
        let nav = &item["navigationEndpoint"];
        if page_type(nav) == "MUSIC_PAGE_TYPE_ARTIST" {
            push_artist(out, seen, title, nav, item);
            return;
        }
        if nav.get("browseEndpoint").is_some() {
            return; // álbum, playlist, podcast…
        }
        let vid = item["playlistItemData"]["videoId"]
            .as_str()
            .map(String::from)
            .or_else(|| find_video_id(&item["overlay"]))
            .or_else(|| find_video_id(col(0)));
        let Some(vid) = vid else { return };
        if !seen.insert(vid.clone()) {
            return;
        }
        let sub = runs(col(1));
        let kind = sub.first().and_then(|r| r["text"].as_str()).unwrap_or("").trim();
        if matches!(kind, "Episódio" | "Episode") {
            return; // podcast
        }
        let rank = if matches!(kind, "Vídeo" | "Video") { 2 } else { 1 };
        let duration_ms = sub.iter().rev().filter_map(|r| r["text"].as_str()).find_map(parse_duration);
        out.tracks.push(Track {
            title,
            artist: artist_from(&sub),
            cover: thumb(item),
            url: format!("https://music.youtube.com/watch?v={vid}"),
            duration_ms,
            rank,
        });
    }

    /// "Melhor resultado" grandão no topo da busca.
    fn parse_card(card: &Value, out: &mut SearchResult, seen: &mut HashSet<String>) {
        let first = &card["title"]["runs"][0];
        let Some(title) = first["text"].as_str() else { return };
        let nav = &first["navigationEndpoint"];
        if page_type(nav) == "MUSIC_PAGE_TYPE_ARTIST" {
            push_artist(out, seen, title.to_string(), nav, card);
        } else if let Some(vid) = nav["watchEndpoint"]["videoId"].as_str() {
            if seen.insert(vid.to_string()) {
                let sub = runs(&card["subtitle"]);
                out.tracks.push(Track {
                    title: title.to_string(),
                    artist: artist_from(&sub),
                    cover: thumb(card),
                    url: format!("https://music.youtube.com/watch?v={vid}"),
                    duration_ms: sub.iter().rev().filter_map(|r| r["text"].as_str()).find_map(parse_duration),
                    rank: 0,
                });
            }
        }
    }
}

// =====================================================================
// Testes:  cargo test            (rápidos, sem internet)
//          cargo test -- --ignored   (busca de verdade nos sites)
// =====================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enc_codifica_url() {
        assert_eq!(enc("juice wrld"), "juice%20wrld");
        assert_eq!(enc("ação & co"), "a%C3%A7%C3%A3o%20%26%20co");
        assert_eq!(enc("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn soundcloud_acha_client_id() {
        let js = r#"x={client_id:"AbCdEfGhIjKlMnOpQrStUvWxYz012345",env:"prod"}"#;
        assert_eq!(soundcloud_find(js).as_deref(), Some("AbCdEfGhIjKlMnOpQrStUvWxYz012345"));
        let url = "https://api-v2.soundcloud.com/x?client_id=ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ&y=1";
        assert_eq!(soundcloud_find(url).as_deref(), Some("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
        assert_eq!(soundcloud_find("client_id:\"curto\""), None);
    }

    fn soundcloud_find(t: &str) -> Option<String> {
        soundcloud::find_client_id_for_test(t)
    }

    #[test]
    fn soundcloud_le_resposta() {
        let v: Value = serde_json::from_str(include_str!("../tests/fixtures/soundcloud_tracks.json")).unwrap();
        let r = soundcloud::parse_for_test(&v, &Value::Null);
        assert!(!r.tracks.is_empty(), "nenhuma faixa lida");
        for t in &r.tracks {
            assert!(!t.title.is_empty());
            assert!(t.url.starts_with("https://soundcloud.com/"), "url estranha: {}", t.url);
        }
        // capa grande em vez da miniatura
        assert!(r.tracks.iter().filter_map(|t| t.cover.as_deref()).all(|c| !c.contains("-large.")));
    }

    #[test]
    fn ytmusic_le_resposta() {
        let v: Value = serde_json::from_str(include_str!("../tests/fixtures/ytmusic_search.json")).unwrap();
        let r = ytmusic::parse(&v);
        assert!(r.tracks.len() >= 3, "poucas músicas: {}", r.tracks.len());
        let first = &r.tracks[0];
        assert!(first.url.starts_with("https://music.youtube.com/watch?v="));
        assert!(!first.artist.is_empty(), "primeira música sem artista");
        assert!(r.tracks.iter().all(|t| !t.title.is_empty()));
        // sem podcast e com músicas antes dos vídeos
        assert!(r.tracks.iter().all(|t| t.rank <= 2));
        assert!(r.tracks.windows(2).all(|w| w[0].rank <= w[1].rank));
        assert!(r.tracks.iter().filter(|t| t.cover.is_some()).count() >= r.tracks.len() / 2);
        // sem repetidas
        let mut urls: Vec<_> = r.tracks.iter().map(|t| &t.url).collect();
        urls.sort();
        urls.dedup();
        assert_eq!(urls.len(), r.tracks.len());
    }

    #[test]
    fn hls_monta_lista_de_pedacos() {
        let pl = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:10,\nseg1.m4s\n#EXTINF:10,\n/abs/seg2.m4s\n#EXTINF:5,\nhttps://cdn.x/seg3.m4s\n#EXT-X-ENDLIST\n";
        let parts = soundcloud::hls_parts_for_test("https://media.sc/a/b/playlist.m3u8?sig=1", pl);
        assert_eq!(parts, vec![
            "https://media.sc/a/b/init.mp4",
            "https://media.sc/a/b/seg1.m4s",
            "https://media.sc/abs/seg2.m4s",
            "https://cdn.x/seg3.m4s",
        ]);
    }

    #[test]
    fn escolhe_formato_sem_drm() {
        let t: Value = serde_json::json!({ "media": { "transcodings": [
            { "url": "a", "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mp4" } },
            { "url": "b", "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } },
            { "url": "c", "format": { "protocol": "hls", "mime_type": "audio/mpeg" } }
        ]}});
        assert_eq!(soundcloud::pick_for_test(&t), Some("c"));
        assert_eq!(soundcloud::playable_for_test(&t), vec!["c", "b"]);
        let so_drm: Value = serde_json::json!({ "media": { "transcodings": [
            { "url": "a", "format": { "protocol": "cbc-encrypted-hls", "mime_type": "audio/mp4" } }
        ]}});
        assert_eq!(soundcloud::pick_for_test(&so_drm), None);
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_soundcloud_audio() {
        let mut tracks = search("soundcloud", "juice wrld").expect("busca no SoundCloud falhou").tracks;
        tracks.truncate(4);
        tracks.extend(search("soundcloud", "lofi beat").expect("busca no SoundCloud falhou").tracks.into_iter().take(3));
        let mut tocou = false;
        for t in tracks.iter() {
            match soundcloud_audio(&t.url) {
                Ok(bytes) => {
                    println!("áudio de '{}': {} KB, começa com {:02X?}", t.title, bytes.len() / 1024, &bytes[..8.min(bytes.len())]);
                    assert!(bytes.len() > 100 * 1024, "áudio pequeno demais");
                    tocou = true;
                    break;
                }
                Err(e) => println!("'{}' não tocou: {e}", t.title),
            }
        }
        assert!(tocou, "nenhuma das músicas pôde ser baixada");
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_soundcloud() {
        let r = search("soundcloud", "juice wrld").expect("busca no SoundCloud falhou");
        println!("SoundCloud: {} faixas, {} artistas", r.tracks.len(), r.artists.len());
        for t in r.tracks.iter().take(3) {
            println!("  {} — {} ({})", t.title, t.artist, t.url);
        }
        assert!(!r.tracks.is_empty());
        assert!(r.tracks[0].url.starts_with("https://soundcloud.com/"));
        assert!(!r.artists.is_empty());
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_clipe() {
        let p = search_page("ytmusic", "Juice WRLD Lucid Dreams", "videos", None).expect("busca de clipes falhou");
        println!("Clipe: {} vídeos, 1º: {} — {}", p.tracks.len(), p.tracks.first().map(|t| t.title.as_str()).unwrap_or("-"),
            p.tracks.first().map(|t| t.url.as_str()).unwrap_or("-"));
        assert!(!p.tracks.is_empty(), "nenhum clipe");
        assert!(p.tracks[0].url.contains("watch?v="));
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_importar_playlists() {
        // Spotify: "Today's Top Hits" (pública, do próprio Spotify)
        match import_playlist("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M") {
            Ok(p) => println!("Importar spotify: '{}' com {} faixas, capa={}, 1ª: {} — {}", p.name, p.tracks.len(), p.cover.is_some(),
                p.tracks[0].title, p.tracks[0].artist),
            Err(e) => panic!("Importar spotify falhou: {e}"),
        }
        // YouTube Music: playlist pública
        match import_playlist("https://music.youtube.com/playlist?list=PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i") {
            Ok(p) => println!("Importar youtube: '{}' com {} faixas, capa={}, 1ª: {} — {}", p.name, p.tracks.len(), p.cover.is_some(),
                p.tracks[0].title, p.tracks[0].artist),
            Err(e) => panic!("Importar youtube falhou: {e}"),
        }
        // SoundCloud: pega uma playlist qualquer da busca e importa
        let found = soundcloud_any_playlist().expect("não achei playlist no SoundCloud pra testar");
        match import_playlist(&found) {
            Ok(p) => println!("Importar soundcloud: '{}' com {} faixas ({found})", p.name, p.tracks.len()),
            Err(e) => panic!("Importar soundcloud falhou: {e} ({found})"),
        }
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_soundcloud_perfil() {
        // acha um perfil com curtidas públicas pela busca de usuários
        let id = soundcloud::client_id_for_test().expect("sem client_id");
        let t = http_get(&format!("https://api-v2.soundcloud.com/search/users?q=dj&limit=30&client_id={id}")).ok().expect("busca de perfis");
        let v: Value = serde_json::from_str(&t).unwrap();
        let link = v["collection"].as_array().unwrap().iter()
            .find(|u| u["likes_count"].as_i64().unwrap_or(0) > 30 && u["playlist_count"].as_i64().unwrap_or(0) > 0)
            .or_else(|| v["collection"].as_array().unwrap().iter().find(|u| u["likes_count"].as_i64().unwrap_or(0) > 30))
            .and_then(|u| u["permalink_url"].as_str()).map(String::from)
            .expect("nenhum perfil com curtidas na busca");
        let p = soundcloud_profile(&link).unwrap_or_else(|e| panic!("perfil falhou: {e} ({link})"));
        println!("Perfil SoundCloud: '{}' · {} curtidas · {} playlists ({link})", p.name, p.likes_count, p.playlists.len());
        for pl in p.playlists.iter().take(3) { println!("  playlist: {} ({} faixas, curtida={})", pl.name, pl.count, pl.liked); }
        // pelo link do perfil, pelo /likes e só pelo nome
        let name = link.trim_end_matches('/').rsplit('/').next().unwrap().to_string();
        for entrada in [link.clone(), format!("{link}/likes"), name] {
            let l = import_playlist(&entrada).or_else(|_| soundcloud::likes(&entrada)).unwrap_or_else(|e| panic!("curtidas falharam: {e} ({entrada})"));
            assert!(!l.tracks.is_empty());
            println!("Curtidas via '{entrada}': {} faixas, 1ª: {} — {}", l.tracks.len(), l.tracks[0].title, l.tracks[0].artist);
        }
    }

    fn soundcloud_any_playlist() -> Option<String> {
        let id = soundcloud::client_id_for_test()?;
        let t = http_get(&format!("https://api-v2.soundcloud.com/search/playlists?q=juice%20wrld&limit=5&client_id={id}")).ok()?;
        let v: Value = serde_json::from_str(&t).ok()?;
        v["collection"].as_array()?.iter().find(|p| p["track_count"].as_i64().unwrap_or(0) > 10)
            .and_then(|p| p["permalink_url"].as_str()).map(String::from)
    }

    #[test]
    fn reconhece_links_de_playlist() {
        assert_eq!(classify_link("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"),
            Some(("spotify", "playlist".into(), "37i9dQZF1DXcBWIGoYBM5M".into())));
        assert_eq!(classify_link("https://open.spotify.com/intl-pt/album/4yP0hdKOZPNshxUOjY0cZj").map(|x| x.1), Some("album".into()));
        assert_eq!(classify_link("spotify:playlist:abc").map(|x| x.2), Some("abc".into()));
        assert_eq!(classify_link("https://open.spotify.com/track/xyz"), None);
        assert_eq!(classify_link("https://music.youtube.com/playlist?list=PLabc&si=1").map(|x| x.2), Some("PLabc".into()));
        assert_eq!(classify_link("https://www.youtube.com/watch?v=x&list=PLz").map(|x| x.2), Some("PLz".into()));
        assert_eq!(classify_link("https://soundcloud.com/user/sets/minha?si=1").map(|x| x.2), Some("https://soundcloud.com/user/sets/minha".into()));
        assert_eq!(classify_link("bom dia"), None);
    }

    #[test]
    fn le_embed_do_spotify() {
        let html = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{
            "name":"Minha playlist","coverArt":{"sources":[{"url":"https://i.scdn.co/a","width":300},{"url":"https://i.scdn.co/b","width":640}]},
            "trackList":[{"uri":"spotify:track:111","title":"Lucid Dreams","subtitle":"Juice WRLD","duration":239836},
                         {"uri":"spotify:episode:9","title":"podcast","subtitle":"x"}]}}}}}}</script></html>"#;
        let v = spotify::next_data(html).unwrap();
        let p = spotify::parse(&v, "playlist", "abc").unwrap();
        assert_eq!(p.name, "Minha playlist");
        assert_eq!(p.cover.as_deref(), Some("https://i.scdn.co/b"));
        assert_eq!(p.tracks.len(), 1);
        assert_eq!(p.tracks[0].url, "https://open.spotify.com/track/111");
        assert_eq!(p.tracks[0].duration_ms, Some(239836));
        assert_eq!(p.open_url, "spotify:playlist:abc");
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_busca_completa() {
        for svc in ["soundcloud", "ytmusic"] {
            let p1 = search_page(svc, "juice wrld", "tracks", None).expect("busca completa falhou");
            let mut total = p1.tracks.len();
            let mut next = p1.next.clone();
            if let Some(c) = &next {
                let p2 = search_page(svc, "juice wrld", "tracks", Some(c)).expect("página 2 falhou");
                total += p2.tracks.len();
                next = p2.next;
            }
            let a = search_page(svc, "juice wrld", "artists", None).expect("artistas falhou");
            println!(
                "Busca completa {svc}: {} faixas na 1ª página, {total} em 2 páginas, {} artistas, mais={}",
                p1.tracks.len(),
                a.artists.len(),
                next.is_some()
            );
            assert!(p1.tracks.len() >= 10, "{svc}: poucas faixas");
            assert!(p1.next.is_some(), "{svc}: sem 'carregar mais'");
            assert!(total > p1.tracks.len(), "{svc}: página 2 vazia");
            assert!(!a.artists.is_empty(), "{svc}: sem artistas");
        }
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_ytmusic() {
        let r = search("ytmusic", "juice wrld lucid dreams").expect("busca no YouTube Music falhou");
        println!("YouTube Music: {} faixas, {} artistas", r.tracks.len(), r.artists.len());
        for t in r.tracks.iter().take(3) {
            println!("  {} — {} ({})", t.title, t.artist, t.url);
        }
        assert!(r.tracks.len() >= 3);
        assert!(r.tracks.iter().any(|t| t.artist.to_lowercase().contains("juice")));
        assert!(r.tracks.iter().any(|t| t.cover.is_some()));
    }
}
