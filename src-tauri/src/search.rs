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
    rank: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub name: String,
    pub picture: Option<String>,
    pub url: String,
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
    fn fetch_client_id() -> Result<String, String> {
        let html = http_get("https://soundcloud.com/").map_err(err_text)?;
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
        // geralmente está num dos últimos scripts
        for src in scripts.iter().rev() {
            if let Ok(js) = http_get(src) {
                if let Some(id) = find_client_id(&js) {
                    return Ok(id);
                }
            }
        }
        Err("Não consegui conectar na busca do SoundCloud".into())
    }

    fn client_id(refresh: bool) -> Result<String, String> {
        let mut guard = CLIENT_ID.lock().unwrap();
        if refresh || guard.is_none() {
            *guard = Some(fetch_client_id()?);
        }
        Ok(guard.clone().unwrap_or_default())
    }

    fn api(path: &str, q: &str, limit: u32) -> Result<Value, String> {
        for attempt in 0..2 {
            let id = client_id(attempt == 1)?;
            let url = format!(
                "https://api-v2.soundcloud.com/{path}?q={}&client_id={id}&limit={limit}&app_locale=pt_BR",
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

    pub fn search(q: &str) -> Result<SearchResult, String> {
        let tracks_json = api("search/tracks", q, 20)?;
        let users_json = api("search/users", q, 10).unwrap_or(Value::Null);
        Ok(parse(&tracks_json, &users_json))
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
