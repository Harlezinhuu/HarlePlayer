//! Login do YouTube pelo "código de TV" (OAuth device flow) e leitura das
//! músicas curtidas e playlists pela API oficial (YouTube Data API v3).
//!
//! - A senha nunca passa pelo app: a pessoa autoriza em google.com/device.
//! - Permissão só de leitura (youtube.readonly).
//! - A chave (refresh token) fica no PC, criptografada pelo Windows (DPAPI),
//!   presa ao usuário: copiada pra outro PC/usuário, não abre.
//! - O id/segredo do app vêm do GitHub Actions na hora do build (não ficam no código).

use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::search::{ImportedPlaylist, Track};

const SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly";
const API: &str = "https://www.googleapis.com/youtube/v3";

fn client() -> Result<(&'static str, &'static str), String> {
    match (option_env!("HP_GOOGLE_CLIENT_ID"), option_env!("HP_GOOGLE_CLIENT_SECRET")) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Ok((id, secret)),
        _ => Err("O login do YouTube não está ativado nesta versão do app".into()),
    }
}

pub fn available() -> bool {
    client().is_ok()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build()
}

/// Erro do Google em texto (o corpo vem em JSON com "error"/"error_description").
fn google_err(e: ureq::Error) -> (u16, String) {
    match e {
        ureq::Error::Status(code, resp) => {
            let body: Value = resp.into_json().unwrap_or(Value::Null);
            let msg = body["error"]["message"].as_str()
                .or_else(|| body["error"].as_str())
                .unwrap_or("erro do Google")
                .to_string();
            (code, msg)
        }
        ureq::Error::Transport(t) => (0, format!("sem conexão ({t})")),
    }
}

// ---------------------------------------------------------------------
// Guardar a chave (DPAPI no Windows)
// ---------------------------------------------------------------------
fn token_file() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("com.harlezinhuu.harleplayer").join("youtube.key")
}

#[cfg(windows)]
mod vault {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    fn run(data: &[u8], protect: bool) -> Option<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            let ok = if protect {
                CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            };
            if ok == 0 || out.pbData.is_null() {
                return None;
            }
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            Some(v)
        }
    }
    pub fn lock(data: &[u8]) -> Option<Vec<u8>> { run(data, true) }
    pub fn unlock(data: &[u8]) -> Option<Vec<u8>> { run(data, false) }
}

#[cfg(not(windows))]
mod vault {
    // fora do Windows (só nos testes): sem criptografia
    pub fn lock(data: &[u8]) -> Option<Vec<u8>> { Some(data.to_vec()) }
    pub fn unlock(data: &[u8]) -> Option<Vec<u8>> { Some(data.to_vec()) }
}

fn save_refresh(token: &str) -> Result<(), String> {
    let f = token_file();
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let locked = vault::lock(token.as_bytes()).ok_or("O Windows não deixou proteger a chave")?;
    std::fs::write(&f, locked).map_err(|e| e.to_string())
}

fn load_refresh() -> Option<String> {
    let raw = std::fs::read(token_file()).ok()?;
    String::from_utf8(vault::unlock(&raw)?).ok()
}

// ---------------------------------------------------------------------
// Login pelo código
// ---------------------------------------------------------------------
struct Pending {
    device_code: String,
    interval: u64,
    until: Instant,
    next_poll: Instant,
}
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static ACCESS: Mutex<Option<(String, Instant)>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginCode {
    pub user_code: String,
    pub verification_url: String,
    pub expires_in: u64,
    pub interval: u64,
}

pub fn login_start() -> Result<LoginCode, String> {
    let (id, _) = client()?;
    let v: Value = agent()
        .post("https://oauth2.googleapis.com/device/code")
        .send_form(&[("client_id", id), ("scope", SCOPE)])
        .map_err(|e| format!("Google: {}", google_err(e).1))?
        .into_json()
        .map_err(|e| e.to_string())?;
    let code = LoginCode {
        user_code: v["user_code"].as_str().ok_or("Google não mandou o código")?.to_string(),
        verification_url: v["verification_url"].as_str().or(v["verification_uri"].as_str()).unwrap_or("https://www.google.com/device").to_string(),
        expires_in: v["expires_in"].as_u64().unwrap_or(1800),
        interval: v["interval"].as_u64().unwrap_or(5),
    };
    *PENDING.lock().unwrap() = Some(Pending {
        device_code: v["device_code"].as_str().ok_or("Google não mandou o device_code")?.to_string(),
        interval: code.interval,
        until: Instant::now() + Duration::from_secs(code.expires_in),
        next_poll: Instant::now(),
    });
    Ok(code)
}

/// "pending" enquanto a pessoa não autoriza; "ok" quando entrou.
pub fn login_poll() -> Result<&'static str, String> {
    let (id, secret) = client()?;
    let device_code = {
        let mut g = PENDING.lock().unwrap();
        let p = g.as_mut().ok_or("Nenhum login em andamento")?;
        if Instant::now() > p.until {
            *g = None;
            return Err("O código expirou. Tente de novo.".into());
        }
        if Instant::now() < p.next_poll {
            return Ok("pending");
        }
        p.next_poll = Instant::now() + Duration::from_secs(p.interval);
        p.device_code.clone()
    };
    let res = agent().post("https://oauth2.googleapis.com/token").send_form(&[
        ("client_id", id),
        ("client_secret", secret),
        ("device_code", &device_code),
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
    ]);
    match res {
        Ok(r) => {
            let v: Value = r.into_json().map_err(|e| e.to_string())?;
            let refresh = v["refresh_token"].as_str().ok_or("Google não mandou a chave")?;
            save_refresh(refresh)?;
            if let Some(acc) = v["access_token"].as_str() {
                let ttl = v["expires_in"].as_u64().unwrap_or(3600).saturating_sub(60);
                *ACCESS.lock().unwrap() = Some((acc.to_string(), Instant::now() + Duration::from_secs(ttl)));
            }
            *PENDING.lock().unwrap() = None;
            Ok("ok")
        }
        Err(e) => {
            let (_, msg) = google_err(e);
            match msg.as_str() {
                "authorization_pending" => Ok("pending"),
                "slow_down" => {
                    if let Some(p) = PENDING.lock().unwrap().as_mut() {
                        p.interval += 5;
                    }
                    Ok("pending")
                }
                "access_denied" => {
                    *PENDING.lock().unwrap() = None;
                    Err("Você recusou o acesso no Google".into())
                }
                "expired_token" => {
                    *PENDING.lock().unwrap() = None;
                    Err("O código expirou. Tente de novo.".into())
                }
                other => Err(format!("Google: {other}")),
            }
        }
    }
}

pub fn logged_in() -> bool {
    token_file().exists()
}

/// Sai: avisa o Google (revoga a chave) e apaga do PC.
pub fn logout() {
    if let Some(t) = load_refresh() {
        let _ = agent().post("https://oauth2.googleapis.com/revoke").send_form(&[("token", t.as_str())]);
    }
    let _ = std::fs::remove_file(token_file());
    *ACCESS.lock().unwrap() = None;
}

fn access_token() -> Result<String, String> {
    if let Some((t, until)) = ACCESS.lock().unwrap().as_ref() {
        if Instant::now() < *until {
            return Ok(t.clone());
        }
    }
    let (id, secret) = client()?;
    let refresh = load_refresh().ok_or("Entre com a conta do YouTube de novo")?;
    let v: Value = agent()
        .post("https://oauth2.googleapis.com/token")
        .send_form(&[("client_id", id), ("client_secret", secret), ("refresh_token", &refresh), ("grant_type", "refresh_token")])
        .map_err(|e| {
            let (code, msg) = google_err(e);
            if code == 400 && msg == "invalid_grant" {
                // revogado lá no Google (ou senha trocada): esquece a chave
                let _ = std::fs::remove_file(token_file());
                "O acesso ao YouTube foi cancelado. Entre de novo.".to_string()
            } else {
                format!("Google: {msg}")
            }
        })?
        .into_json()
        .map_err(|e| e.to_string())?;
    let acc = v["access_token"].as_str().ok_or("Google não mandou o acesso")?.to_string();
    let ttl = v["expires_in"].as_u64().unwrap_or(3600).saturating_sub(60);
    *ACCESS.lock().unwrap() = Some((acc.clone(), Instant::now() + Duration::from_secs(ttl)));
    Ok(acc)
}

fn api(path: &str) -> Result<Value, String> {
    let tok = access_token()?;
    agent()
        .get(&format!("{API}/{path}"))
        .set("Authorization", &format!("Bearer {tok}"))
        .call()
        .map_err(|e| {
            let (code, msg) = google_err(e);
            if code == 403 && msg.to_lowercase().contains("quota") {
                "O YouTube limitou os pedidos por hoje. Tente amanhã.".into()
            } else {
                format!("YouTube: {msg}")
            }
        })?
        .into_json()
        .map_err(|e| e.to_string())
}

/// Lista paginada da API (pageToken), até `max` itens.
fn paged(path: &str, max: usize) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut token = String::new();
    for _ in 0..40 {
        let sep = if path.contains('?') { '&' } else { '?' };
        let url = if token.is_empty() { format!("{path}{sep}maxResults=50") } else { format!("{path}{sep}maxResults=50&pageToken={token}") };
        let v = api(&url)?;
        if let Some(a) = v["items"].as_array() {
            out.extend(a.iter().cloned());
        }
        match v["nextPageToken"].as_str() {
            Some(t) if out.len() < max => token = t.to_string(),
            _ => break,
        }
    }
    out.truncate(max);
    Ok(out)
}

// ---------------------------------------------------------------------
// Conta, curtidas e playlists
// ---------------------------------------------------------------------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtPlaylist {
    pub name: String,
    /// "ytauth:playlist:<id>" (o app sabe importar e manter atualizada)
    pub url: String,
    pub cover: Option<String>,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtAccount {
    pub name: String,
    pub avatar: Option<String>,
    pub likes_url: String,
    pub playlists: Vec<YtPlaylist>,
}

fn best_thumb(sn: &Value) -> Option<String> {
    let t = &sn["thumbnails"];
    ["maxres", "standard", "high", "medium", "default"].iter().find_map(|k| t[k]["url"].as_str()).map(String::from)
}

/// "Fulano - Topic" (canal automático de música) → "Fulano".
pub fn clean_channel(s: &str) -> String {
    s.trim().trim_end_matches(" - Topic").trim_end_matches(" - Tema").trim().to_string()
}

/// "PT3M21S" → 201000 ms
pub fn iso_duration_ms(s: &str) -> Option<i64> {
    let s = s.strip_prefix("PT")?;
    let (mut total, mut num) = (0i64, String::new());
    for c in s.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else {
            let n: i64 = num.parse().ok()?;
            num.clear();
            total += match c { 'H' => n * 3600, 'M' => n * 60, 'S' => n, _ => return None };
        }
    }
    Some(total * 1000)
}

pub fn account() -> Result<YtAccount, String> {
    let me = api("channels?part=snippet&mine=true")?;
    let sn = &me["items"][0]["snippet"];
    let playlists = paged("playlists?part=snippet,contentDetails&mine=true", 200)?
        .iter()
        .filter_map(|p| {
            Some(YtPlaylist {
                name: p["snippet"]["title"].as_str()?.to_string(),
                url: format!("ytauth:playlist:{}", p["id"].as_str()?),
                cover: best_thumb(&p["snippet"]),
                count: p["contentDetails"]["itemCount"].as_i64().unwrap_or(0),
            })
        })
        .collect();
    Ok(YtAccount {
        name: sn["title"].as_str().unwrap_or("Sua conta").to_string(),
        avatar: best_thumb(sn),
        likes_url: "ytauth:likes".into(),
        playlists,
    })
}

fn video_track(id: &str, title: &str, channel: &str, cover: Option<String>, dur: Option<i64>) -> Track {
    Track {
        title: title.to_string(),
        artist: clean_channel(channel),
        cover,
        url: format!("https://music.youtube.com/watch?v={id}"),
        duration_ms: dur,
        rank: 1,
    }
}

/// "ytauth:likes" ou "ytauth:playlist:<id>" → playlist pronta pra tocar.
pub fn import(url: &str) -> Result<ImportedPlaylist, String> {
    if url == "ytauth:likes" {
        // vídeos curtidos (as curtidas do YouTube Music são as mesmas do YouTube)
        let items = paged("videos?part=snippet,contentDetails&myRating=like", 1000)?;
        let tracks: Vec<Track> = items
            .iter()
            .filter_map(|v| {
                let sn = &v["snippet"];
                Some(video_track(
                    v["id"].as_str()?,
                    sn["title"].as_str()?,
                    sn["channelTitle"].as_str().unwrap_or(""),
                    best_thumb(sn),
                    v["contentDetails"]["duration"].as_str().and_then(iso_duration_ms),
                ))
            })
            .collect();
        if tracks.is_empty() {
            return Err("Nenhuma música curtida nessa conta".into());
        }
        return Ok(ImportedPlaylist {
            source: "youtube".into(),
            name: "Curtidas no YouTube".into(),
            cover: tracks[0].cover.clone(),
            open_url: "https://music.youtube.com/playlist?list=LM".into(),
            tracks,
        });
    }
    let id = url.strip_prefix("ytauth:playlist:").ok_or("link de conta inválido")?;
    let meta = api(&format!("playlists?part=snippet&id={id}"))?;
    let name = meta["items"][0]["snippet"]["title"].as_str().unwrap_or("Playlist do YouTube").to_string();
    let items = paged(&format!("playlistItems?part=snippet&playlistId={id}"), 1000)?;
    let tracks: Vec<Track> = items
        .iter()
        .filter_map(|it| {
            let sn = &it["snippet"];
            let vid = sn["resourceId"]["videoId"].as_str()?;
            let title = sn["title"].as_str()?;
            // vídeo apagado/privado aparece assim
            if title == "Deleted video" || title == "Private video" {
                return None;
            }
            Some(video_track(vid, title, sn["videoOwnerChannelTitle"].as_str().unwrap_or(""), best_thumb(sn), None))
        })
        .collect();
    if tracks.is_empty() {
        return Err(format!("A playlist \"{name}\" está vazia"));
    }
    Ok(ImportedPlaylist {
        source: "youtube".into(),
        cover: best_thumb(&meta["items"][0]["snippet"]).or_else(|| tracks[0].cover.clone()),
        name,
        open_url: format!("https://music.youtube.com/playlist?list={id}"),
        tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duracao_iso() {
        assert_eq!(iso_duration_ms("PT3M21S"), Some(201_000));
        assert_eq!(iso_duration_ms("PT1H2M3S"), Some(3_723_000));
        assert_eq!(iso_duration_ms("PT45S"), Some(45_000));
        assert_eq!(iso_duration_ms("P1D"), None);
    }

    #[test]
    fn canal_topic_vira_artista() {
        assert_eq!(clean_channel("Thiago Kelbert - Topic"), "Thiago Kelbert");
        assert_eq!(clean_channel("Alee"), "Alee");
    }

    #[test]
    fn cofre_ida_e_volta() {
        let locked = vault::lock(b"segredo-123").unwrap();
        assert_eq!(vault::unlock(&locked).unwrap(), b"segredo-123");
        #[cfg(windows)]
        assert_ne!(locked, b"segredo-123"); // no Windows sai criptografado
    }
}
