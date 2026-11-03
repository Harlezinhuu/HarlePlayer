//! Reserva do YouTube: quando um vídeo bloqueia tocar fora do YouTube, o áudio
//! vem pelo yt-dlp (o mesmo que bots de música do Discord usam).
//!
//! O `yt-dlp.exe` é baixado do GitHub oficial do projeto na primeira vez que
//! precisa e se atualiza sozinho uma vez por dia (o YouTube muda direto).
//!
//! Desde o fim de 2025 o yt-dlp precisa de um "motor de JavaScript" pra
//! resolver o desafio do YouTube (sem ele, quase nenhum vídeo toca). O app
//! baixa o Deno (o motor recomendado pelo yt-dlp) do GitHub oficial do Deno,
//! uma vez só, na mesma pasta.

use std::io::Read;
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

#[cfg(windows)]
const DENO_URL: &str = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";
#[cfg(windows)]
const DENO_EXE: &str = "deno.exe";
#[cfg(not(windows))]
const DENO_URL: &str = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip";
#[cfg(not(windows))]
const DENO_EXE: &str = "deno";

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

/// Baixa direto pro disco (o Deno tem dezenas de MB, não cabe no limite de áudio).
fn download_to(url: &str, dest: &Path) -> Result<(), String> {
    let resp = ureq::get(url)
        .set("User-Agent", "HarlePlayer")
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut resp.into_reader().take(400 * 1024 * 1024), &mut file).map_err(|e| e.to_string())?;
    Ok(())
}

/// Garante o Deno na pasta `dir`. `None` se não deu (aí o yt-dlp tenta sem).
pub fn ensure_deno(dir: &Path) -> Option<PathBuf> {
    let exe = dir.join(DENO_EXE);
    if exe.exists() {
        return Some(exe);
    }
    std::fs::create_dir_all(dir).ok()?;
    let zip = dir.join("deno.zip");
    let ok = (|| -> Result<(), String> {
        download_to(DENO_URL, &zip)?;
        // o Windows 10/11 já vem com tar.exe, que abre .zip
        let status = command(Path::new("tar"))
            .arg("-xf")
            .arg(&zip)
            .arg("-C")
            .arg(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("não consegui extrair o Deno".into());
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&zip);
    match ok {
        Ok(()) if exe.exists() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
            }
            Some(exe)
        }
        _ => None,
    }
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
pub fn audio_with(exe: &Path, deno: Option<&Path>, url: &str) -> Result<Vec<u8>, String> {
    if !is_youtube(url) {
        return Err("Link do YouTube inválido".into());
    }
    let mut cmd = command(exe);
    if let Some(d) = deno {
        cmd.arg("--js-runtimes").arg(format!("deno:{}", d.display()));
    }
    let out = cmd
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
        } else if err.contains("Requested format is not available") || err.contains("Only images are available") {
            "O YouTube não liberou o áudio (falta o motor de JavaScript do yt-dlp?)".to_string()
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
    let dir = bin_dir(app)?;
    let exe = ensure_in(&dir)?;
    let deno = ensure_deno(&dir);
    audio_with(&exe, deno.as_deref(), url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_aceita_link_do_youtube() {
        assert!(is_youtube("https://music.youtube.com/watch?v=abc"));
        assert!(is_youtube("https://youtu.be/abc"));
        assert!(!is_youtube("https://evil.com/?https://www.youtube.com/"));
        assert!(audio_with(Path::new("nao-existe"), None, "file:///C:/x").is_err());
    }

    /// Roda na mão: cargo test manual_ytdlp -- --ignored --nocapture
    /// (YouTube costuma bloquear IP de servidor, então fica fora da checagem diária)
    #[test]
    #[ignore = "usa a internet e o YouTube bloqueia servidores"]
    fn manual_ytdlp() {
        let dir = std::env::temp_dir().join("harle-ytdlp-teste");
        let exe = ensure_in(&dir).expect("baixar yt-dlp");
        println!("yt-dlp em {}", exe.display());
        let deno = ensure_deno(&dir);
        println!("yt-dlp: deno {}", deno.as_ref().map_or("não baixou".into(), |d| d.display().to_string()));
        match audio_with(&exe, deno.as_deref(), "https://www.youtube.com/watch?v=jNQXAC9IVRw") {
            Ok(b) => println!("yt-dlp: áudio de {} KB, começa com {:02X?}", b.len() / 1024, &b[..8]),
            Err(e) => panic!("yt-dlp falhou: {e}"),
        }
    }
}
