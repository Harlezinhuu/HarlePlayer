//! Rede: as chamadas HTTP saem pelo Rust (sem problema de CORS no webview)
//! e só pra hosts conhecidos.

use std::time::Duration;

const USER_AGENT: &str = "HarlePlayer/0.1 (https://github.com/Harlezinhuu/HarlePlayer)";

/// APIs públicas e sem chave usadas pelo app:
/// - lrclib.net  → letras sincronizadas
/// - api.deezer.com → busca de músicas/artistas com capas
/// - api.song.link → mesma música em outros serviços (ouvir junto)
const ALLOWED_HTTP: &[&str] = &["https://lrclib.net/api/", "https://api.deezer.com/", "https://api.song.link/"];

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

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "usa a internet"]
    fn ao_vivo_song_link() {
        // acha Lucid Dreams no Deezer e pede os links nos outros serviços
        let d = super::get_text("https://api.deezer.com/search?q=juice%20wrld%20lucid%20dreams&limit=1").expect("deezer falhou");
        let dv: serde_json::Value = serde_json::from_str(&d).unwrap();
        let link = dv["data"][0]["link"].as_str().expect("deezer sem resultado").replace(":", "%3A").replace("/", "%2F");
        let t = super::get_text(&format!("https://api.song.link/v1-alpha.1/links?url={link}&userCountry=BR"))
            .expect("song.link falhou");
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        let sp = v["linksByPlatform"]["spotify"]["nativeAppUriDesktop"].as_str().unwrap_or("");
        println!("song.link: spotify={sp} youtube={}", v["linksByPlatform"]["youtube"]["url"].as_str().unwrap_or("-"));
        assert!(sp.starts_with("spotify:track:"));
    }
}
