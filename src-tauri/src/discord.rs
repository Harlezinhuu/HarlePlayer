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
    /// sala do "ouvir junto" aberta: vira festa no Discord ("Pedir para participar")
    #[serde(default)]
    pub party: Option<Party>,
}

/// Festa no Discord (igual jogo): tamanho da sala e o código pra entrar.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub id: String,
    pub size: u32,
    pub max: u32,
    /// código de convite da sala: o Discord só entrega pra quem for aceito/convidado
    pub secret: String,
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
                    // festa usa sempre o app padrão (é ele que o "ouvinte" escuta)
                    let id = if p.party.is_some() { app_ids().get("default").cloned().or_else(|| app_id_for(&p.service)) } else { app_id_for(&p.service) };
                    let Some(id) = id else {
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

trait Pipe: Read + Write + Send {
    /// Bytes esperando pra ser lidos (sem bloquear).
    fn available(&mut self) -> io::Result<usize>;
}

#[cfg(windows)]
impl Pipe for std::fs::File {
    fn available(&mut self) -> io::Result<usize> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;
        let mut avail: u32 = 0;
        let ok = unsafe {
            PeekNamedPipe(self.as_raw_handle() as _, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut())
        };
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(avail as usize) }
    }
}

#[cfg(unix)]
impl Pipe for std::os::unix::net::UnixStream {
    fn available(&mut self) -> io::Result<usize> {
        self.set_nonblocking(true)?;
        let mut b = [0u8; 1];
        let r = self.peek(&mut b);
        self.set_nonblocking(false)?;
        match r {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(0),
            Err(e) => Err(e),
        }
    }
}

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
        self.send_cmd("SET_ACTIVITY", json!({ "pid": std::process::id(), "activity": activity }), None)
    }

    /// Manda um comando e espera a resposta dele (pelo nonce).
    fn send_cmd(&mut self, cmd: &str, args: Value, evt: Option<&str>) -> Result<(), String> {
        self.nonce += 1;
        let nonce = format!("harle-{}", self.nonce);
        let mut payload = json!({ "cmd": cmd, "args": args, "nonce": nonce });
        if let Some(e) = evt {
            payload["evt"] = json!(e);
        }
        self.write(1, &payload).map_err(|e| e.to_string())?;
        for _ in 0..8 {
            let (_, reply) = self.read().map_err(|e| e.to_string())?;
            if reply["nonce"].as_str() != Some(nonce.as_str()) {
                continue; // evento chegando no meio: ignora aqui
            }
            if reply["evt"] == "ERROR" {
                let msg = reply["data"]["message"].as_str().unwrap_or("erro desconhecido");
                return Err(format!("Discord: {msg}"));
            }
            return Ok(());
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
        // "Ouvindo" (2). Com sala aberta vira "Jogando" (0): o Discord só desenha a festa
        // ("1 de 20") e o botão "Pedir para participar" em atividade de jogo.
        "type": if p.party.is_some() { 0 } else { 2 },
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

    if let Some(party) = &p.party {
        // O Discord não aceita botão de link junto com festa: aqui quem aparece é o
        // botão dele mesmo, "Pedir para participar" (e o convite pelo + do chat).
        let size = party.size.max(1);
        activity["party"] = json!({ "id": fit(&party.id, 128), "size": [size, party.max.max(size)] });
        activity["secrets"] = json!({ "join": fit(&party.secret, 128) });
        activity["instance"] = json!(true);
    } else if let Some(url) = p.url.as_deref().filter(|u| u.starts_with("https://") && u.len() <= 512) {
        activity["buttons"] = json!([{ "label": fit(&format!("Ouvir no {}", p.service_name), 32), "url": url }]);
    }
    activity
}

// ---------- "ouvinte": pedidos pra entrar e convites aceitos ----------
// Conexão separada, com o app padrão, sempre aberta enquanto o Discord estiver
// ligado no app. Recebe:
//   ACTIVITY_JOIN_REQUEST  alguém clicou "Pedir para participar" no seu perfil
//   ACTIVITY_JOIN          você foi aceito/convidado → vem o código da sala
// Por estar sempre conectado, o Discord entrega o convite aqui em vez de abrir
// outra cópia do app.

/// Avisos pro front: ("discord-join", código) e ("discord-join-request", usuário).
pub type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;
static LISTEN_TX: OnceLock<Mutex<Sender<ListenMsg>>> = OnceLock::new();

enum ListenMsg {
    Enable(bool),
    Respond(String, bool),
}

pub fn listen(on: bool) {
    if let Some(tx) = LISTEN_TX.get() {
        let _ = tx.lock().unwrap().send(ListenMsg::Enable(on));
    }
}

/// Aceitar/recusar quem pediu pra entrar.
pub fn respond(user_id: String, accept: bool) {
    if let Some(tx) = LISTEN_TX.get() {
        let _ = tx.lock().unwrap().send(ListenMsg::Respond(user_id, accept));
    }
}

pub fn start_listener(emit: Emit) {
    let Some(id) = app_ids().get("default").cloned() else { return };
    let (tx, rx) = mpsc::channel::<ListenMsg>();
    let _ = LISTEN_TX.set(Mutex::new(tx));
    std::thread::spawn(move || {
        register_launcher(&id);
        let mut enabled = false;
        let mut conn: Option<Conn> = None;
        let mut retry_at = std::time::Instant::now();
        loop {
            let mut inbox: Vec<ListenMsg> = rx.try_iter().collect();
            // desligado: dorme até chegar um comando (sem acordar à toa)
            if !enabled && inbox.is_empty() {
                match rx.recv() {
                    Ok(m) => inbox.push(m),
                    Err(_) => break,
                }
            }
            for m in inbox {
                match m {
                    ListenMsg::Enable(on) => {
                        enabled = on;
                        if !on {
                            if let Some(mut c) = conn.take() {
                                c.close();
                            }
                        }
                    }
                    ListenMsg::Respond(user, accept) => {
                        if let Some(c) = conn.as_mut() {
                            let cmd = if accept { "SEND_ACTIVITY_JOIN_INVITE" } else { "CLOSE_ACTIVITY_REQUEST" };
                            if c.send_cmd(cmd, json!({ "user_id": user }), None).is_err() {
                                conn = None;
                            }
                        }
                    }
                }
            }
            if !enabled {
                continue;
            }
            if conn.is_none() && std::time::Instant::now() >= retry_at {
                match Conn::connect(&id) {
                    Ok(mut c) => {
                        let ok = ["ACTIVITY_JOIN", "ACTIVITY_JOIN_REQUEST"]
                            .iter()
                            .all(|evt| c.send_cmd("SUBSCRIBE", json!({}), Some(evt)).is_ok());
                        if ok {
                            conn = Some(c);
                        } else {
                            retry_at = std::time::Instant::now() + Duration::from_secs(20);
                        }
                    }
                    Err(_) => retry_at = std::time::Instant::now() + Duration::from_secs(20),
                }
            }
            // lê o que chegou sem travar (o pipe do Windows não deixa ler e
            // escrever ao mesmo tempo, então só lê quando já tem dado esperando)
            let mut lost = false;
            if let Some(c) = conn.as_mut() {
                match c.pipe.available() {
                    Ok(0) => {}
                    Ok(_) => match c.read() {
                        Ok((_, v)) => handle_event(&v, &emit),
                        Err(_) => lost = true,
                    },
                    Err(_) => lost = true,
                }
            }
            if lost {
                conn = None;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

fn handle_event(v: &Value, emit: &Emit) {
    if let Some((name, data)) = event_payload(v) {
        emit(name, data);
    }
}

/// Evento do Discord → (nome do aviso pro front, dados). Exposto pros testes.
fn event_payload(v: &Value) -> Option<(&'static str, Value)> {
    match v["evt"].as_str()? {
        "ACTIVITY_JOIN" => Some(("discord-join", json!(v["data"]["secret"].as_str()?))),
        "ACTIVITY_JOIN_REQUEST" => {
            let u = &v["data"]["user"];
            let id = u["id"].as_str()?;
            let name = u["username"].as_str()?;
            let avatar = u["avatar"].as_str().map(|a| format!("https://cdn.discordapp.com/avatars/{id}/{a}.png?size=64"));
            let display = u["global_name"].as_str().filter(|g| !g.is_empty()).unwrap_or(name);
            Some(("discord-join-request", json!({ "id": id, "name": display, "avatar": avatar })))
        }
        _ => None,
    }
}

/// Avisa o Windows como abrir o Harle Player pelo Discord ("discord-<id>://"),
/// pra quem aceitar o convite sem o app aberto (igual a biblioteca discord-rpc).
fn register_launcher(app_id: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let Ok(exe) = std::env::current_exe() else { return };
        let key = format!(r"HKCU\Software\Classes\discord-{app_id}");
        let run = |args: &[&str]| {
            let _ = std::process::Command::new("reg").args(args).creation_flags(0x0800_0000).status();
        };
        run(&["add", &key, "/ve", "/d", &format!("URL:Run game {app_id} protocol"), "/f"]);
        run(&["add", &key, "/v", "URL Protocol", "/d", "", "/f"]);
        run(&["add", &format!(r"{key}\DefaultIcon"), "/ve", "/d", &exe.display().to_string(), "/f"]);
        run(&["add", &format!(r"{key}\shell\open\command"), "/ve", "/d", &format!("\"{}\"", exe.display()), "/f"]);
    }
    #[cfg(not(windows))]
    let _ = app_id;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn exemplo() -> Presence {
        Presence {
            service: "soundcloud".into(),
            service_name: "SoundCloud".into(),
            title: "Lucid Dreams".into(),
            artist: "Juice WRLD".into(),
            album: "".into(),
            cover: Some("https://cdn-images.dzcdn.net/capa.jpg".into()),
            start_ms: 1_700_000_000_000,
            end_ms: Some(1_700_000_239_000),
            url: Some("https://soundcloud.com/search?q=lucid".into()),
            party: None,
        }
    }

    #[test]
    fn festa_troca_o_botao_de_link_pelo_pedir_pra_participar() {
        let mut p = exemplo();
        p.party = Some(Party { id: "harle-abc".into(), size: 2, max: 20, secret: "K7QM-2X9P-RT4W-H8NA".into() });
        let a = build_activity(&p);
        assert_eq!(a["party"]["size"], json!([2, 20]));
        assert_eq!(a["secrets"]["join"], "K7QM-2X9P-RT4W-H8NA");
        assert!(a.get("buttons").is_none(), "o Discord recusa botão de link junto com festa");
        assert_eq!(a["type"], 0, "festa só aparece em atividade de jogo");
        assert_eq!(build_activity(&exemplo())["type"], 2, "sem sala continua \"Ouvindo\"");
    }

    #[test]
    fn eventos_de_entrar_viram_avisos_pro_app() {
        let join = json!({ "evt": "ACTIVITY_JOIN", "data": { "secret": "ABCD-EFGH" } });
        assert_eq!(event_payload(&join), Some(("discord-join", json!("ABCD-EFGH"))));
        let req = json!({ "evt": "ACTIVITY_JOIN_REQUEST", "data": { "user": { "id": "42", "username": "fulano", "global_name": "Fulano", "avatar": "abc" } } });
        let (name, data) = event_payload(&req).unwrap();
        assert_eq!(name, "discord-join-request");
        assert_eq!(data["name"], "Fulano");
        assert_eq!(data["avatar"], "https://cdn.discordapp.com/avatars/42/abc.png?size=64");
        assert_eq!(event_payload(&json!({ "evt": "READY" })), None);
    }

    #[test]
    fn fit_respeita_limites_do_discord() {
        assert_eq!(fit("  oi  ", 128).chars().count(), 2);
        assert_eq!(fit("a", 128).chars().count(), 2); // mínimo 2
        assert_eq!(fit(&"x".repeat(300), 128).chars().count(), 128);
    }

    #[test]
    fn atividade_de_ouvindo() {
        let a = build_activity(&exemplo());
        assert_eq!(a["type"], 2);
        assert_eq!(a["details"], "Lucid Dreams");
        assert_eq!(a["state"], "Juice WRLD");
        // timestamps em segundos
        assert_eq!(a["timestamps"]["start"], 1_700_000_000);
        assert_eq!(a["timestamps"]["end"], 1_700_000_239);
        assert_eq!(a["assets"]["large_image"], "https://cdn-images.dzcdn.net/capa.jpg");
        assert_eq!(a["assets"]["large_text"], "Lucid Dreams"); // sem álbum usa o título
        assert_eq!(a["assets"]["small_text"], "SoundCloud");
        assert_eq!(a["buttons"][0]["label"], "Ouvir no SoundCloud");
    }

    #[test]
    fn sem_capa_https_usa_logo_e_sem_link_sem_botao() {
        let mut p = exemplo();
        p.cover = Some("data:image/png;base64,AAAA".into());
        p.url = Some("spotify:search:x".into());
        p.end_ms = None;
        let a = build_activity(&p);
        assert_eq!(a["assets"]["large_image"], "logo");
        assert!(a.get("buttons").is_none());
        assert!(a["timestamps"].get("end").is_none());
    }

    #[test]
    fn ids_do_json_sao_lidos_sem_erro() {
        // só garante que o discord-apps.json é JSON válido e que IDs inválidos são ignorados
        for (k, v) in app_ids() {
            assert!(!k.starts_with('_'));
            assert!(v.chars().all(|c| c.is_ascii_digit()));
        }
    }
}
