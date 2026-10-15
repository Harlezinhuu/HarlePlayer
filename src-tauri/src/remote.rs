//! Controle pelo celular: um servidor HTTP bem pequeno na rede local (Wi-Fi).
//! O celular abre a página pelo QR code; tudo passa por um código secreto (k=…)
//! que só quem vê o QR tem. Sem dependências: só std::net.

use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const PAGE: &str = include_str!("../../src/remote.html");
const ICON: &[u8] = include_bytes!("../icons/128x128.png");
const FIRST_PORT: u16 = 47800;

static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static PORT: Mutex<u16> = Mutex::new(0);
static TOKEN: Mutex<String> = Mutex::new(String::new());
static NOW: Mutex<Option<(Value, std::time::Instant)>> = Mutex::new(None);
static COVER: Mutex<(u64, String)> = Mutex::new((0, String::new()));
static LYRICS: Mutex<String> = Mutex::new(String::new());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub url: String,
    pub ip: String,
    pub port: u16,
}

fn token_file() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.harlezinhuu.harleplayer").join("remote_token.txt")
}

/// 32 caracteres hex "aleatórios" (sem crate de random: hash do relógio + RandomState).
fn new_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u64(i ^ std::process::id() as u64);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn token() -> String {
    let mut t = TOKEN.lock().unwrap();
    if t.is_empty() {
        let saved = std::fs::read_to_string(token_file()).unwrap_or_default().trim().to_string();
        *t = if saved.len() == 32 && saved.chars().all(|c| c.is_ascii_hexdigit()) {
            saved
        } else {
            let n = new_token();
            let _ = std::fs::create_dir_all(token_file().parent().unwrap());
            let _ = std::fs::write(token_file(), &n);
            n
        };
    }
    t.clone()
}

/// Troca o código (quem tinha o link antigo perde o acesso).
pub fn regenerate() -> Result<RemoteInfo, String> {
    let n = new_token();
    let _ = std::fs::create_dir_all(token_file().parent().unwrap());
    std::fs::write(token_file(), &n).map_err(|e| e.to_string())?;
    *TOKEN.lock().unwrap() = n;
    info()
}

/// IP do PC na rede local (não manda nada pra internet: o "connect" de UDP só escolhe a rota).
fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn info() -> Result<RemoteInfo, String> {
    let port = *PORT.lock().unwrap();
    if port == 0 {
        return Err("Controle pelo celular desligado".into());
    }
    let ip = lan_ip();
    Ok(RemoteInfo { url: format!("http://{ip}:{port}/?k={}", token()), ip, port })
}

pub fn start(app: &AppHandle) -> Result<RemoteInfo, String> {
    if RUNNING.load(Ordering::SeqCst) {
        return info();
    }
    let mut listener = None;
    for p in FIRST_PORT..FIRST_PORT + 10 {
        if let Ok(l) = TcpListener::bind(("0.0.0.0", p)) {
            listener = Some((l, p));
            break;
        }
    }
    let (listener, port) = listener.ok_or("Não consegui abrir uma porta pro controle")?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    *PORT.lock().unwrap() = port;
    token();
    STOP.store(false, Ordering::SeqCst);
    RUNNING.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        while !STOP.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let _ = handle(&app, stream);
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(60)),
            }
        }
        *PORT.lock().unwrap() = 0;
        RUNNING.store(false, Ordering::SeqCst);
    });
    info()
}

pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

/// Guarda o estado; a capa (pode ser uma imagem grande em base64) fica separada
/// e o celular só baixa de novo quando "coverRev" muda.
pub fn set_now(v: &Value) {
    let mut v = v.clone();
    if let Some(c) = v.as_object_mut().and_then(|o| o.remove("cover")) {
        let c = c.as_str().unwrap_or("").to_string();
        let mut cur = COVER.lock().unwrap();
        if cur.1 != c {
            cur.0 += 1;
            cur.1 = c;
        }
    }
    v["coverRev"] = COVER.lock().unwrap().0.into();
    *NOW.lock().unwrap() = Some((v, std::time::Instant::now()));
}

pub fn set_lyrics(v: &Value) {
    *LYRICS.lock().unwrap() = v.to_string();
}

// ---------- HTTP ----------

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn param(&self, k: &str) -> Option<&str> {
        self.query.iter().find(|(a, _)| a == k).map(|(_, b)| b.as_str())
    }
}

pub fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Lê "GET /api/state?k=… HTTP/1.1" + cabeçalhos + corpo (até 64 KB).
pub fn parse_request(raw: &[u8]) -> Option<(Request, usize)> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?;
    let len = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let (path, qs) = target.split_once('?').unwrap_or((target, ""));
    let query = qs
        .split('&')
        .filter(|x| !x.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (url_decode(k), url_decode(v))
        })
        .collect();
    Some((Request { method, path: path.to_string(), query, body: Vec::new() }, end + 4 + len.min(64 * 1024)))
}

fn respond(s: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes())?;
    s.write_all(body)?;
    s.flush()
}

fn handle(app: &AppHandle, mut s: TcpStream) -> std::io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    s.set_nonblocking(false)?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let (mut req, total) = loop {
        let n = s.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(r) = parse_request(&buf) {
            break r;
        }
        if buf.len() > 16 * 1024 {
            return respond(&mut s, "413 Payload Too Large", "text/plain", b"");
        }
    };
    while buf.len() < total {
        let n = s.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let start = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(buf.len());
    req.body = buf[start..total.min(buf.len())].to_vec();

    // a página e o ícone são públicos (não têm dado nenhum); a API pede o código
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => return respond(&mut s, "200 OK", "text/html; charset=utf-8", PAGE.as_bytes()),
        ("GET", "/icon.png") => return respond(&mut s, "200 OK", "image/png", ICON),
        _ => {}
    }
    if req.param("k") != Some(token().as_str()) {
        return respond(&mut s, "403 Forbidden", "application/json", br#"{"error":"codigo"}"#);
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/state") => {
            // "age": quanto tempo faz que o PC mandou isso (o celular usa pra sincronizar a letra)
            let body = match NOW.lock().unwrap().clone() {
                Some((mut v, at)) => {
                    v["age"] = (at.elapsed().as_millis() as u64).into();
                    v.to_string()
                }
                None => "{}".into(),
            };
            respond(&mut s, "200 OK", "application/json", body.as_bytes())
        }
        ("GET", "/api/cover") => {
            let c = COVER.lock().unwrap().clone();
            let body = serde_json::json!({ "rev": c.0, "cover": c.1 }).to_string();
            respond(&mut s, "200 OK", "application/json", body.as_bytes())
        }
        ("GET", "/api/lyrics") => {
            let l = LYRICS.lock().unwrap().clone();
            respond(&mut s, "200 OK", "application/json", if l.is_empty() { b"{}" } else { l.as_bytes() })
        }
        ("GET", "/api/search") => {
            let q = req.param("q").unwrap_or("").to_string();
            let svc = match req.param("svc") {
                Some("ytmusic") | Some("youtube") => "ytmusic",
                _ => "soundcloud",
            };
            let body = match crate::search::search(svc, &q) {
                Ok(r) => serde_json::to_vec(&r).unwrap_or_default(),
                Err(e) => serde_json::to_vec(&serde_json::json!({ "error": e })).unwrap_or_default(),
            };
            respond(&mut s, "200 OK", "application/json", &body)
        }
        ("POST", "/api/cmd") => {
            let v: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
            if v["action"].is_string() {
                let _ = app.emit("hp-control", v);
                respond(&mut s, "200 OK", "application/json", b"{\"ok\":true}")
            } else {
                respond(&mut s, "400 Bad Request", "application/json", b"{\"ok\":false}")
            }
        }
        _ => respond(&mut s, "404 Not Found", "text/plain", b""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_pedido_http() {
        let raw = b"POST /api/cmd?k=abc&q=l%C3%BAcid+dreams HTTP/1.1\r\nHost: x\r\nContent-Length: 17\r\n\r\n{\"action\":\"next\"}";
        let (r, total) = parse_request(raw).unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/api/cmd");
        assert_eq!(r.param("k"), Some("abc"));
        assert_eq!(r.param("q"), Some("lúcid dreams"));
        assert_eq!(total, raw.len());
        assert!(parse_request(b"GET / HTTP/1.1\r\nHost: x").is_none()); // ainda incompleto
    }

    #[test]
    fn codigo_tem_32_hex() {
        let t = new_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, new_token());
    }
}
