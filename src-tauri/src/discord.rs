//! Discord Rich Presence feito na mão, sem crate externo.
//!
//! O Discord aberto no PC escuta num "named pipe" local
//! (`\\.\pipe\discord-ipc-0` no Windows). O protocolo é simples:
//! cada mensagem = [opcode u32][tamanho u32][JSON], tudo little-endian.
//!   op 0 = handshake (manda o client_id do app)
//!   op 1 = comando (SET_ACTIVITY)
//!   op 2 = fechar   ·   op 3/4 = ping/pong
//!
//! Cada serviço (SoundCloud, YouTube Music…) pode usar um app diferente
//! do Discord, assim o perfil mostra "Ouvindo SoundCloud", por exemplo.
//! Os IDs ficam em `discord-apps.json`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// O que o front manda pra aparecer no perfil.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    /// chave do serviço: soundcloud, ytmusic, youtube, spotify, apple, deezer…
    pub service: String,
    pub service_name: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// URL https da capa (o Discord não aceita imagem em base64)
    pub cover: Option<String>,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    /// link pro botão "Ouvir no …"
    pub url: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub connected: bool,
    pub message: String,
}

enum Msg {
    Set(Presence),
    Clear,
}

static TX: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();
static STATUS: OnceLock<Mutex<Status>> = OnceLock::new();

fn status() -> &'static Mutex<Status> {
    STATUS.get_or_init(|| Mutex::new(Status::default()))
}

fn set_status(connected: bool, message: impl Into<String>) {
    let mut s = status().lock().unwrap();
    s.configured = !app_ids().is_empty();
    s.connected = connected;
    s.message = message.into();
}

pub fn current_status() -> Status {
    let mut s = status().lock().unwrap().clone();
    s.configured = !app_ids().is_empty();
    if !s.configured {
        s.message = "Coloque o ID do seu app do Discord em src-tauri/discord-apps.json".into();
    }
    s
}

// ---------- IDs dos apps ----------

fn app_ids() -> &'static HashMap<String, String> {
    static IDS: OnceLock<HashMap<String, String>> = OnceLock::new();
    IDS.get_or_init(|| {
        let raw: HashMap<String, Value> =
            serde_json::from_str(include_str!("../discord-apps.json")).unwrap_or_default();
        raw.into_iter()
            .filter_map(|(k, v)| {
                let id = v.as_str()?.trim().to_string();
                let valid = !k.starts_with('_') && !id.is_empty() && id.chars().all(|c| c.is_ascii_digit());
                valid.then_some((k, id))
            })
            .collect()
    })
}

fn app_id_for(service: &str) -> Option<String> {
    let ids = app_ids();
    ids.get(service).or_else(|| ids.get("default")).cloned()
}

// ---------- API pública ----------

pub fn start() {
    let (tx, rx) = mpsc::channel::<Msg>();
    let _ = TX.set(Mutex::new(tx));
    set_status(false, "Desconectado");

    std::thread::spawn(move || {
        let mut conn: Option<Conn> = None;
        let mut desired: Option<Presence> = None;
        let mut sent: Option<Presence> = None;

        loop {
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(m) => apply_msg(&mut desired, m),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            // pega só a mensagem mais recente (o Discord limita ~5 updates / 20 s)
            std::thread::sleep(Duration::from_millis(300));
            while let Ok(m) = rx.try_recv() {
                apply_msg(&mut desired, m);
            }

            if desired == sent && (desired.is_none() || conn.is_some()) {
                continue; // nada mudou e continua conectado
            }

            match &desired {
                None => {
                    if let Some(c) = conn.as_mut() {
                        if c.clear().is_err() {
                            conn = None;
                        }
                    }
                    sent = None;
                }
                Some(p) => {
                    let Some(id) = app_id_for(&p.service) else {
                        set_status(false, "Nenhum ID de app do Discord configurado");
                        sent = desired.clone();
                        continue;
                    };
                    if conn.as_ref().map(|c| c.client_id != id).unwrap_or(true) {
                        if let Some(mut old) = conn.take() {
                            old.close();
                        }
                        match Conn::connect(&id) {
                            Ok(c) => conn = Some(c),
                            Err(e) => {
                                set_status(false, e);
                                sent = None; // tenta de novo no próximo ciclo
                                continue;
                            }
                        }
                    }
                    let c = conn.as_mut().unwrap();
                    match c.set_activity(p) {
                        Ok(()) => {
                            set_status(true, format!("Mostrando no Discord: {}", p.service_name));
                            sent = desired.clone();
                        }
                        Err(e) => {
                            set_status(false, e);
                            conn = None;
                            sent = None;
                        }
                    }
                }
            }
        }
    });
}

fn apply_msg(desired: &mut Option<Presence>, m: Msg) {
    match m {
        Msg::Set(p) => *desired = Some(p),
        Msg::Clear => *desired = None,
    }
}

pub fn set(p: Presence) {
    send(Msg::Set(p));
}

pub fn clear() {
    send(Msg::Clear);
}

fn send(m: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().unwrap().send(m);
    }
}

// ---------- conexão ----------

trait Pipe: Read + Write + Send {}
impl<T: Read + Write + Send> Pipe for T {}

struct Conn {
    client_id: String,
    pipe: Box<dyn Pipe>,
    nonce: u64,
}

impl Conn {
    fn connect(client_id: &str) -> Result<Conn, String> {
        let pipe = open_pipe().ok_or_else(|| "Discord não está aberto".to_string())?;
        let mut c = Conn {
            client_id: client_id.to_string(),
            pipe,
            nonce: 0,
        };
        c.write(0, &json!({ "v": 1, "client_id": client_id }))
            .map_err(|e| e.to_string())?;
        let (_, reply) = c.read().map_err(|e| e.to_string())?;
        if reply["evt"] != "READY" {
            let msg = reply["message"].as_str().unwrap_or("o Discord recusou a conexão");
            return Err(format!("Discord: {msg}"));
        }
        Ok(c)
    }

    fn write(&mut self, op: u32, payload: &Value) -> io::Result<()> {
        let data = serde_json::to_vec(payload)?;
        let mut buf = Vec::with_capacity(8 + data.len());
        buf.extend_from_slice(&op.to_le_bytes());
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&data);
        self.pipe.write_all(&buf)?;
        self.pipe.flush()
    }

    fn read(&mut self) -> io::Result<(u32, Value)> {
        loop {
            let mut head = [0u8; 8];
            self.pipe.read_exact(&mut head)?;
            let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
            let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
            if len > 1 << 20 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "resposta grande demais"));
            }
            let mut body = vec![0u8; len];
            self.pipe.read_exact(&mut body)?;
            let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            match op {
                3 => self.write(4, &value)?, // ping → pong
                2 => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "Discord fechou a conexão")),
                _ => return Ok((op, value)),
            }
        }
    }

    fn command(&mut self, activity: Value) -> Result<(), String> {
        self.nonce += 1;
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": format!("harle-{}", self.nonce),
        });
        self.write(1, &payload).map_err(|e| e.to_string())?;
        let (_, reply) = self.read().map_err(|e| e.to_string())?;
        if reply["evt"] == "ERROR" {
            let msg = reply["data"]["message"].as_str().unwrap_or("erro desconhecido");
            return Err(format!("Discord: {msg}"));
        }
        Ok(())
    }

    fn set_activity(&mut self, p: &Presence) -> Result<(), String> {
        self.command(build_activity(p))
    }

    fn clear(&mut self) -> Result<(), String> {
        self.command(Value::Null)
    }

    fn close(&mut self) {
        let _ = self.write(2, &json!({}));
    }
}

/// Texto entre 2 e `max` caracteres (regra do Discord).
fn fit(s: &str, max: usize) -> String {
    let mut out: String = s.trim().chars().take(max).collect();
    while out.chars().count() < 2 {
        out.push('\u{2800}'); // caractere "invisível" que o Discord aceita
    }
    out
}

fn build_activity(p: &Presence) -> Value {
    let mut assets = serde_json::Map::new();
    let large = p
        .cover
        .as_deref()
        .filter(|u| u.starts_with("https://"))
        .unwrap_or("logo");
    assets.insert("large_image".into(), json!(large));
    let large_text = if p.album.trim().is_empty() { &p.title } else { &p.album };
    assets.insert("large_text".into(), json!(fit(large_text, 128)));
    assets.insert("small_image".into(), json!(p.service));
    assets.insert("small_text".into(), json!(fit(&p.service_name, 128)));

    let mut activity = json!({
        "type": 2, // "Ouvindo"
        "details": fit(&p.title, 128),
        "state": fit(if p.artist.trim().is_empty() { &p.service_name } else { &p.artist }, 128),
        "assets": Value::Object(assets),
        "instance": false,
    });

    // Com início e fim o Discord mostra a barrinha de progresso.
    // (timestamps em segundos, igual a biblioteca oficial discord-rpc)
    let mut ts = serde_json::Map::new();
    ts.insert("start".into(), json!(p.start_ms / 1000));
    if let Some(end) = p.end_ms.filter(|e| *e > p.start_ms) {
        ts.insert("end".into(), json!(end / 1000));
    }
    activity["timestamps"] = Value::Object(ts);

    if let Some(url) = p.url.as_deref().filter(|u| u.starts_with("https://") && u.len() <= 512) {
        activity["buttons"] = json!([{ "label": fit(&format!("Ouvir no {}", p.service_name), 32), "url": url }]);
    }
    activity
}

fn open_pipe() -> Option<Box<dyn Pipe>> {
    #[cfg(windows)]
    {
        for i in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{i}");
            if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
                return Some(Box::new(f));
            }
        }
        None
    }

    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;
        let mut dirs: Vec<String> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .collect();
        dirs.push("/tmp".into());
        for dir in dirs {
            for sub in ["", "app/com.discordapp.Discord/", "snap.discord/"] {
                for i in 0..10 {
                    let path = format!("{}/{}discord-ipc-{}", dir.trim_end_matches('/'), sub, i);
                    if let Ok(s) = UnixStream::connect(&path) {
                        return Some(Box::new(s));
                    }
                }
            }
        }
        None
    }
}
