//! Reserva do YouTube: quando um vídeo bloqueia tocar fora do YouTube, o áudio
//! vem pelo yt-dlp (o mesmo que bots de música do Discord usam).
//!
//! O `yt-dlp.exe` é baixado do GitHub oficial do projeto na primeira vez que
//! precisa e se atualiza sozinho uma vez por dia (o YouTube muda direto).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const DOWNLOAD_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(windows)]
const EXE_NAME: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const DOWNLOAD_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
#[cfg(not(windows))]
const EXE_NAME: &str = "yt-dlp";

const UPDATE_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

fn command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // sem janela de console
    }
    cmd
}

/// Garante que o yt-dlp está na pasta `dir` (baixa se faltar, atualiza se estiver velho).
pub fn ensure_in(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let exe = dir.join(EXE_NAME);
    let stamp = dir.join("yt-dlp.atualizado");

    if !exe.exists() {
        let bytes = crate::search::http_bytes(DOWNLOAD_URL)
            .map_err(|e| format!("Não consegui baixar o yt-dlp: {e}"))?;
        let tmp = exe.with_extension("part");
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &exe).map_err(|e| e.to_string())?;
        let _ = std::fs::write(&stamp, b"");
        return Ok(exe);
    }

    let stale = std::fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|age| age > UPDATE_EVERY)
        .unwrap_or(true);
    if stale {
        // "-U" troca o próprio executável pela versão mais nova
        let _ = command(&exe).arg("-U").stdout(Stdio::null()).stderr(Stdio::null()).status();
        let _ = std::fs::write(&stamp, b"");
    }
    Ok(exe)
}

fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("bin"))
}

fn is_youtube(url: &str) -> bool {
    ["https://www.youtube.com/", "https://youtube.com/", "https://music.youtube.com/", "https://youtu.be/", "https://m.youtube.com/"]
        .iter()
        .any(|p| url.starts_with(p))
}

/// Baixa só o áudio (m4a de preferência) e devolve os bytes.
pub fn audio_with(exe: &Path, url: &str) -> Result<Vec<u8>, String> {
    if !is_youtube(url) {
        return Err("Link do YouTube inválido".into());
    }
    let out = command(exe)
        .args([
            "-f",
            "bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio",
            "-o",
            "-",
            "--no-playlist",
            "--no-part",
            "--quiet",
            "--no-warnings",
            "--socket-timeout",
            "20",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Não consegui rodar o yt-dlp: {e}"))?;

    if !out.status.success() || out.stdout.len() < 10_000 {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.contains("Sign in to confirm") {
            "O YouTube pediu verificação de robô; tente de novo daqui a pouco".to_string()
        } else if err.contains("Video unavailable") || err.contains("Private video") {
            "Esse vídeo não está disponível".to_string()
        } else {
            let first = err.lines().find(|l| l.contains("ERROR")).unwrap_or("erro desconhecido");
            format!("yt-dlp: {}", first.trim())
        };
        return Err(msg);
    }
    Ok(out.stdout)
}

pub fn audio(app: &AppHandle, url: &str) -> Result<Vec<u8>, String> {
    let exe = ensure_in(&bin_dir(app)?)?;
    audio_with(&exe, url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_aceita_link_do_youtube() {
        assert!(is_youtube("https://music.youtube.com/watch?v=abc"));
        assert!(is_youtube("https://youtu.be/abc"));
        assert!(!is_youtube("https://evil.com/?https://www.youtube.com/"));
        assert!(audio_with(Path::new("nao-existe"), "file:///C:/x").is_err());
    }

    /// Roda na mão: cargo test manual_ytdlp -- --ignored --nocapture
    /// (YouTube costuma bloquear IP de servidor, então fica fora da checagem diária)
    #[test]
    #[ignore = "usa a internet e o YouTube bloqueia servidores"]
    fn manual_ytdlp() {
        let dir = std::env::temp_dir().join("harle-ytdlp-teste");
        let exe = ensure_in(&dir).expect("baixar yt-dlp");
        println!("yt-dlp em {}", exe.display());
        match audio_with(&exe, "https://www.youtube.com/watch?v=jNQXAC9IVRw") {
            Ok(b) => println!("yt-dlp: áudio de {} KB, começa com {:02X?}", b.len() / 1024, &b[..8]),
            Err(e) => panic!("yt-dlp falhou: {e}"),
        }
    }
}
