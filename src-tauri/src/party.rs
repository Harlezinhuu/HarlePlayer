//! "Ouvir junto": as mensagens da sala passam pelo ntfy.sh (serviço público e
//! gratuito de pub/sub, sem conta). O conteúdo já chega aqui criptografado pelo
//! front (AES-GCM, com a chave que só existe no código de convite), então o
//! servidor só vê texto embaralhado. Aqui é só o "carteiro": publica e escuta.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const BASE: &str = "https://ntfy.sh";
static GEN: AtomicU64 = AtomicU64::new(0);

/// Nome de sala válido: só letras, números, - e _ (8 a 64).
pub fn valid_topic(t: &str) -> bool {
    (8..=64).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn publish(topic: &str, body: &str) -> Result<(), String> {
    if !valid_topic(topic) {
        return Err("Sala inválida".into());
    }
    if body.len() > 3500 {
        return Err("Mensagem grande demais".into());
    }
    ureq::post(&format!("{BASE}/{topic}"))
        .set("User-Agent", "HarlePlayer")
        .set("Content-Type", "text/plain")
        .timeout(Duration::from_secs(10))
        .send_string(body)
        .map(|_| ())
        .map_err(|e| match e {
            ureq::Error::Status(429, _) => "Muitas mensagens seguidas; espere um pouco".to_string(),
            other => other.to_string(),
        })
}

/// Tira o texto da mensagem de uma linha do stream JSON do ntfy.
pub fn message_of(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v["event"].as_str()? != "message" {
        return None;
    }
    v["message"].as_str().map(String::from)
}

/// Entra na sala: uma thread fica escutando e manda cada mensagem pro front ("party-msg").
pub fn join(app: &AppHandle, topic: &str) -> Result<(), String> {
    if !valid_topic(topic) {
        return Err("Sala inválida".into());
    }
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let topic = topic.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(90)) // o ntfy manda "keepalive" a cada ~45 s
            .build();
        let mut first = true;
        while GEN.load(Ordering::SeqCst) == gen {
            // na primeira conexão pega os últimos 2 min (pra quem entra achar o estado da sala)
            let url = format!("{BASE}/{topic}/json{}", if first { "?since=2m" } else { "" });
            first = false;
            match agent.get(&url).set("User-Agent", "HarlePlayer").call() {
                Ok(resp) => {
                    let _ = app.emit("party-status", "online");
                    let reader = BufReader::new(resp.into_reader());
                    for line in reader.lines() {
                        if GEN.load(Ordering::SeqCst) != gen {
                            return;
                        }
                        let Ok(line) = line else { break };
                        if let Some(m) = message_of(&line) {
                            let _ = app.emit("party-msg", m);
                        }
                    }
                }
                Err(_) => {
                    let _ = app.emit("party-status", "offline");
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
    Ok(())
}

pub fn leave() {
    GEN.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valida_sala_e_le_mensagem() {
        assert!(valid_topic("harle-abc12345"));
        assert!(!valid_topic("curta"));
        assert!(!valid_topic("tem espaço aqui!"));
        assert_eq!(message_of(r#"{"id":"x","event":"message","topic":"t","message":"oi"}"#), Some("oi".into()));
        assert_eq!(message_of(r#"{"event":"keepalive"}"#), None);
        assert_eq!(message_of("lixo"), None);
    }

    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_sala() {
        // igual o app: alguém já está escutando a sala quando a mensagem chega
        let topic = format!("harle-teste-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let t2 = topic.clone();
        std::thread::spawn(move || {
            let agent = ureq::AgentBuilder::new().timeout_read(Duration::from_secs(20)).build();
            if let Ok(resp) = agent.get(&format!("{BASE}/{t2}/json")).set("User-Agent", "HarlePlayer").call() {
                for line in BufReader::new(resp.into_reader()).lines().map_while(Result::ok) {
                    if let Some(m) = message_of(&line) {
                        let _ = tx.send(m);
                    }
                }
            }
        });
        std::thread::sleep(Duration::from_millis(1500));
        publish(&topic, "ola-sala").expect("Sala: não publicou");
        let got = rx.recv_timeout(Duration::from_secs(15));
        println!("Sala ntfy (ao vivo): recebeu {:?}", got);
        assert_eq!(got.ok().as_deref(), Some("ola-sala"));
    }
}
