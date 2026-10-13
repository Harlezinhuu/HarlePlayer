//! Rede: as chamadas HTTP saem pelo Rust (sem problema de CORS no webview)
//! e só pra hosts conhecidos.

use std::time::Duration;

const USER_AGENT: &str = "HarlePlayer/0.1 (https://github.com/Harlezinhuu/HarlePlayer)";

/// APIs públicas e sem chave usadas pelo app:
/// - lrclib.net  → letras sincronizadas
/// - api.deezer.com → busca de músicas/artistas com capas
const ALLOWED_HTTP: &[&str] = &["https://lrclib.net/api/", "https://api.deezer.com/"];

pub fn get_text(url: &str) -> Result<String, String> {
    if !ALLOWED_HTTP.iter().any(|p| url.starts_with(p)) {
        return Err("Endereço não permitido".into());
    }
    match ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(12))
        .call()
    {
        Ok(resp) => resp.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(404, _)) => Ok("null".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Abre um link no navegador padrão ou um URI do app (ex.: `spotify:search:...`).
pub fn open_url(url: &str) -> Result<(), String> {
    let allowed = url.starts_with("https://") || url.starts_with("spotify:");
    if !allowed || url.chars().any(|c| c.is_control()) {
        return Err("Link não permitido".into());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
