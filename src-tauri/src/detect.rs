//! Descobre em qual serviço a música está tocando.
//!
//! 1. Pelo app de origem (Spotify.exe, YouTube Music Desktop, Apple Music…).
//! 2. Se for navegador, pelo título das janelas abertas
//!    ("… - YouTube Music", "… | SoundCloud", "… - YouTube").
//! Se não der pra saber, devolve "browser" e o front usa a preferência do usuário.

const APP_HINTS: &[(&str, &str)] = &[
    ("spotify", "spotify"),
    ("soundcloud", "soundcloud"),
    ("youtube-music", "ytmusic"),
    ("youtubemusic", "ytmusic"),
    ("youtube music", "ytmusic"),
    ("ytmdesktop", "ytmusic"),
    ("applemusic", "apple"),
    ("apple music", "apple"),
    ("itunes", "apple"),
    ("deezer", "deezer"),
    ("tidal", "tidal"),
];

const BROWSERS: &[&str] = &[
    "chrome", "msedge", "edge", "firefox", "opera", "brave", "vivaldi", "arc", "zen", "browser",
    "308046b0af4a39cb", // ID que o Firefox usa no Windows
];

pub fn service_for(source: &str, title: &str) -> String {
    let src = source.to_lowercase();
    for (needle, svc) in APP_HINTS {
        if src.contains(needle) {
            return svc.to_string();
        }
    }
    let is_browser = src.is_empty() || BROWSERS.iter().any(|b| src.contains(b));

    let track = title.trim().to_lowercase();
    let mut fallback: Option<&str> = None;
    for w in window_titles() {
        let wl = w.to_lowercase();
        let svc = if wl.contains("soundcloud") {
            "soundcloud"
        } else if wl.contains("youtube music") {
            "ytmusic"
        } else if wl.contains("youtube") {
            "youtube"
        } else if wl.contains("deezer") {
            "deezer"
        } else if wl.contains("apple music") {
            "apple"
        } else if wl.contains("spotify") {
            "spotify"
        } else {
            continue;
        };
        // janela com o nome da música = certeza
        if !track.is_empty() && wl.contains(&track) {
            return svc.into();
        }
        fallback.get_or_insert(svc);
    }
    if is_browser {
        fallback.unwrap_or("browser").into()
    } else {
        "other".into()
    }
}


/// Texto genérico que o navegador manda quando não informa a música
/// (visto no Chrome pt-BR com o SoundCloud: "Um site está com mídia aberta").
pub fn is_placeholder(title: &str) -> bool {
    let t = title.trim().to_lowercase();
    ["um site está", "a site is ", "un sitio ", "un site ", "une site "]
        .iter()
        .any(|p| t.starts_with(p))
}

/// Música lida do título da janela do navegador.
#[derive(Debug, PartialEq)]
pub struct BrowserTrack {
    pub title: String,
    pub artist: String,
    pub service: String,
    /// false = palpite pelo formato "Música de Artista" (pode ser outra aba qualquer)
    pub sure: bool,
}

const BROWSER_SUFFIXES: &[&str] = &[
    " - Google Chrome",
    " - Microsoft\u{200b} Edge",
    " - Microsoft Edge",
    " — Mozilla Firefox",
    " - Mozilla Firefox",
    " - Opera",
    " - Brave",
    " - Vivaldi",
];

/// Lê "Música de Artista - Google Chrome" (formato do SoundCloud), "… - YouTube Music", "… - YouTube".
pub fn parse_browser_title(window: &str) -> Option<BrowserTrack> {
    let mut t = window.trim();
    // tira " - Google Chrome" etc. (Edge às vezes adiciona " e mais N páginas")
    let mut is_browser = false;
    for suf in BROWSER_SUFFIXES {
        if let Some(i) = t.find(suf) {
            t = &t[..i];
            is_browser = true;
            break;
        }
    }
    if !is_browser {
        return None;
    }
    let mut t = t.trim_start_matches(['▶', '\u{fe0e}', ' ']).trim();
    // "(3) Título" = contador de notificações da aba
    if let Some(rest) = t.strip_prefix('(') {
        if let Some((n, after)) = rest.split_once(')') {
            if !n.is_empty() && n.len() <= 3 && n.chars().all(|c| c.is_ascii_digit()) {
                t = after.trim();
            }
        }
    }
    if t.is_empty() {
        return None;
    }

    let strip = |s: &str, suf: &str| s.strip_suffix(suf).map(|x| x.trim().to_string());
    if let Some(rest) = strip(t, "- YouTube Music") {
        let (title, artist) = match rest.split_once(" • ") {
            Some((a, b)) => (a.trim().to_string(), b.trim().to_string()),
            None => (rest, String::new()),
        };
        return Some(BrowserTrack { title, artist, service: "ytmusic".into(), sure: true });
    }
    if let Some(rest) = strip(t, "- YouTube") {
        return Some(BrowserTrack { title: rest, artist: String::new(), service: "youtube".into(), sure: true });
    }
    let (t, explicit_sc) = match t.strip_suffix("| Ouça grátis no SoundCloud").or_else(|| t.strip_suffix("| Listen online for free on SoundCloud")) {
        Some(x) => (x.trim(), true),
        None => (t, t.to_lowercase().contains("soundcloud")),
    };
    // SoundCloud tocando: "Música de Artista" (pt) / "Música by Artista" (en)
    for sep in [" de ", " by "] {
        if let Some(i) = t.rfind(sep) {
            let (title, artist) = (t[..i].trim(), t[i + sep.len()..].trim());
            if !title.is_empty() && !artist.is_empty() {
                return Some(BrowserTrack {
                    title: title.to_string(),
                    artist: artist.to_string(),
                    service: "soundcloud".into(),
                    sure: explicit_sc,
                });
            }
        }
    }
    if explicit_sc {
        return Some(BrowserTrack { title: t.to_string(), artist: String::new(), service: "soundcloud".into(), sure: true });
    }
    None
}

/// Procura nas janelas abertas um navegador mostrando uma música.
pub fn track_from_browser_windows() -> Option<BrowserTrack> {
    let found: Vec<BrowserTrack> = window_titles().iter().filter_map(|w| parse_browser_title(w)).collect();
    // prefere o que tem certeza (YouTube, "…SoundCloud"); senão, o primeiro palpite
    let sure = found.iter().position(|t| t.sure);
    let mut found = found;
    match sure {
        Some(i) => Some(found.swap_remove(i)),
        None => found.into_iter().next(),
    }
}

#[cfg(windows)]
fn window_titles() -> Vec<String> {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) != 0 {
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if n > 0 {
                let out = &mut *(lparam as *mut Vec<String>);
                out.push(String::from_utf16_lossy(&buf[..n as usize]));
            }
        }
        1
    }

    let mut titles: Vec<String> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut titles as *mut Vec<String> as LPARAM);
    }
    titles
}

#[cfg(not(windows))]
fn window_titles() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::service_for;

    #[test]
    fn reconhece_apps_de_desktop() {
        assert_eq!(service_for("Spotify.exe", "x"), "spotify");
        assert_eq!(service_for("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App", "x"), "apple");
        assert_eq!(service_for("com.github.th-ch.youtube-music", "x"), "ytmusic");
        assert_eq!(service_for("Deezer.exe", "x"), "deezer");
    }

    #[test]
    fn app_desconhecido_vira_other() {
        assert_eq!(service_for("vlc.exe", "musica-que-nao-existe-em-janela-nenhuma"), "other");
    }

    #[test]
    fn placeholder_do_chrome() {
        assert!(super::is_placeholder("Um site está com mídia aberta"));
        assert!(super::is_placeholder("A site is playing media"));
        assert!(!super::is_placeholder("Lucid Dreams"));
    }

    #[test]
    fn le_titulo_da_janela_do_soundcloud() {
        // título real visto no teste (Chrome pt-BR, aba do SoundCloud na frente)
        let t = super::parse_browser_title("juice wrld - Codeine cowboy / plane jane de Weed Wrld - Google Chrome").unwrap();
        assert_eq!(t.title, "juice wrld - Codeine cowboy / plane jane");
        assert_eq!(t.artist, "Weed Wrld");
        assert_eq!(t.service, "soundcloud");
        let t = super::parse_browser_title("▶ Lucid Dreams by Juice WRLD - Google Chrome").unwrap();
        assert_eq!((t.title.as_str(), t.artist.as_str()), ("Lucid Dreams", "Juice WRLD"));
    }

    #[test]
    fn le_titulo_do_youtube() {
        let t = super::parse_browser_title("Lucid Dreams • Juice WRLD - YouTube Music - Google Chrome").unwrap();
        assert_eq!((t.title.as_str(), t.artist.as_str(), t.service.as_str()), ("Lucid Dreams", "Juice WRLD", "ytmusic"));
        let t = super::parse_browser_title("(3) Juice WRLD - Lucid Dreams - YouTube - Google Chrome").unwrap();
        assert_eq!((t.title.as_str(), t.service.as_str()), ("Juice WRLD - Lucid Dreams", "youtube"));
    }

    #[test]
    fn nao_corta_numero_do_titulo() {
        let t = super::parse_browser_title("21 Savage - a lot - YouTube - Google Chrome").unwrap();
        assert_eq!(t.title, "21 Savage - a lot");
    }

    #[test]
    fn ignora_janela_que_nao_e_navegador_ou_musica() {
        assert_eq!(super::parse_browser_title("Documento de texto - Bloco de Notas"), None);
        assert_eq!(super::parse_browser_title("Claude - Google Chrome"), None);
    }

    #[test]
    fn navegador_sem_pista_vira_browser() {
        let s = service_for("Chrome", "musica-que-nao-existe-em-janela-nenhuma");
        assert!(["browser", "soundcloud", "ytmusic", "youtube", "deezer", "apple", "spotify"].contains(&s.as_str()));
    }
}
