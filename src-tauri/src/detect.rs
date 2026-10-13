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
    fn navegador_sem_pista_vira_browser() {
        let s = service_for("Chrome", "musica-que-nao-existe-em-janela-nenhuma");
        assert!(["browser", "soundcloud", "ytmusic", "youtube", "deezer", "apple", "spotify"].contains(&s.as_str()));
    }
}
