//! Atualizador: confere a última Release no GitHub e, se for mais nova,
//! baixa o instalador, fecha o app, instala e abre de novo.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const REPO: &str = "Harlezinhuu/HarlePlayer";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub url: Option<String>,
    pub page: String,
}

/// "0.10.1" > "0.9.3"; aceita "v0.3.0".
pub fn newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split(['.', '-', '+'])
            .take(3)
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(latest), parse(current));
    (0..3).map(|i| (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0)))
        .find(|(x, y)| x != y)
        .map(|(x, y)| x > y)
        .unwrap_or(false)
}

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn check() -> Result<UpdateInfo, String> {
    let current = current_version();
    let resp = ureq::get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .set("User-Agent", "HarlePlayer-updater")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .call();
    let text = match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(404, _)) => {
            return Ok(UpdateInfo { current, ..Default::default() });
        }
        Err(e) => return Err(e.to_string()),
    };
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let latest = v["tag_name"].as_str().unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    let url = v["assets"]
        .as_array()
        .and_then(|a| {
            a.iter().find(|x| x["name"].as_str().map(|n| n.ends_with("_x64-setup.exe")).unwrap_or(false))
        })
        .and_then(|x| x["browser_download_url"].as_str())
        .map(String::from);
    Ok(UpdateInfo {
        available: url.is_some() && newer(&latest, &current),
        current,
        latest,
        url,
        page: v["html_url"].as_str().unwrap_or("").to_string(),
    })
}

/// Baixa o instalador e deixa um comando esperando o app fechar pra instalar.
/// Quem chama deve fechar o app logo depois.
pub fn download_and_schedule(url: &str) -> Result<(), String> {
    let allowed = format!("https://github.com/{REPO}/releases/download/");
    if !url.starts_with(&allowed) {
        return Err("Link de atualização não permitido".into());
    }
    let bytes = crate::search::http_bytes(url)?;
    if bytes.len() < 500_000 || !bytes.starts_with(b"MZ") {
        return Err("O instalador baixado veio estranho; tente de novo".into());
    }
    let setup = std::env::temp_dir().join("HarlePlayer-atualizacao-setup.exe");
    std::fs::write(&setup, &bytes).map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // espera ~2 s o app fechar, instala em modo "passivo" (só a barra de progresso)
        // e abre o Harle Player de novo
        let line = format!(
            "/C ping -n 3 127.0.0.1 >nul & start \"\" /wait \"{}\" /P & start \"\" \"{}\"",
            setup.display(),
            exe.display()
        );
        std::process::Command::new("cmd")
            .raw_arg(line)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Atualização automática só no Windows por enquanto".into())
    }
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn compara_versoes() {
        assert!(newer("0.3.0", "0.2.0"));
        assert!(newer("v0.10.0", "0.9.9"));
        assert!(newer("1.0.0", "0.99.99"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert!(!newer("0.1.9", "0.2.0"));
        assert!(!newer("", "0.2.0"));
    }
}
