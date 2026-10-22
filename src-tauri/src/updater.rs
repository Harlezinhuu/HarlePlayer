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
    match check_api() {
        Ok(info) => Ok(info),
        // API sem resposta (ex.: limite de 60 consultas/hora estourado): usa o redirecionamento do site
        Err(api_err) => check_site().map_err(|e| format!("{api_err} / {e}")),
    }
}

fn check_api() -> Result<UpdateInfo, String> {
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
    let tag = v["tag_name"].as_str().unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    let asset = v["assets"].as_array().and_then(|a| {
        a.iter().find(|x| x["name"].as_str().map(|n| n.ends_with("_x64-setup.exe")).unwrap_or(false))
    });
    let url = asset.and_then(|x| x["browser_download_url"].as_str()).map(String::from);
    // vale a versão escrita no instalador (Harle.Player_0.14.2_x64-setup.exe), não a da tag:
    // se a tag estiver diferente do código, não fica oferecendo a mesma versão pra sempre
    let latest = asset
        .and_then(|x| x["name"].as_str())
        .and_then(version_in_asset)
        .unwrap_or(tag);
    Ok(UpdateInfo {
        available: url.is_some() && newer(&latest, &current),
        current,
        latest,
        url,
        page: v["html_url"].as_str().unwrap_or("").to_string(),
    })
}

/// github.com/…/releases/latest redireciona pra …/releases/tag/<versão> (sem limite de consultas).
fn check_site() -> Result<UpdateInfo, String> {
    let current = current_version();
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(15)).build();
    let resp = match agent
        .get(&format!("https://github.com/{REPO}/releases/latest"))
        .set("User-Agent", "HarlePlayer-updater")
        .call()
    {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(e.to_string()),
    };
    let location = resp.header("location").unwrap_or("").to_string();
    let tag = tag_from_location(&location).ok_or("GitHub não informou a versão")?;
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let url = format!(
        "https://github.com/{REPO}/releases/download/{tag}/Harle.Player_{latest}_x64-setup.exe"
    );
    Ok(UpdateInfo {
        available: newer(&latest, &current),
        current,
        latest,
        url: Some(url),
        page: location,
    })
}

/// "Harle.Player_0.14.2_x64-setup.exe" → "0.14.2"
pub fn version_in_asset(name: &str) -> Option<String> {
    let v = name.strip_suffix("_x64-setup.exe")?.rsplit('_').next()?;
    (v.split('.').count() == 3 && v.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())))
        .then(|| v.to_string())
}

fn tag_from_location(loc: &str) -> Option<String> {
    let tag = loc.split("/releases/tag/").nth(1)?.split(['?', '#', '/']).next()?;
    (!tag.is_empty()).then(|| tag.to_string())
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

    #[test]
    fn versao_vem_do_nome_do_instalador() {
        assert_eq!(version_in_asset("Harle.Player_0.14.0_x64-setup.exe").as_deref(), Some("0.14.0"));
        assert_eq!(version_in_asset("Harle.Player_1.2.10_x64-setup.exe").as_deref(), Some("1.2.10"));
        assert_eq!(version_in_asset("outro.exe"), None);
        // tag 0.14.1 com instalador 0.14.0 → quem tem a 0.14.0 não vê atualização
        assert!(!newer(&version_in_asset("Harle.Player_0.14.0_x64-setup.exe").unwrap(), "0.14.0"));
    }

    use super::{newer, tag_from_location, version_in_asset};

    #[test]
    fn le_versao_do_redirecionamento() {
        assert_eq!(
            tag_from_location("https://github.com/Harlezinhuu/HarlePlayer/releases/tag/0.3.1").as_deref(),
            Some("0.3.1")
        );
        assert_eq!(tag_from_location("https://github.com/Harlezinhuu/HarlePlayer/releases"), None);
    }

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
