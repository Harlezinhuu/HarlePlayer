//! Volume de quem está tocando, pelo mixer do Windows (WASAPI):
//! muda só o app (Spotify, Chrome…) e não o volume do PC inteiro.
//! Se o app não for achado no mixer, cai pro volume geral do sistema.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// 0.0 – 1.0
    pub level: f32,
    /// nome mostrado ("Spotify", "Sistema"…)
    pub target: String,
}

/// Nomes de processo (sem ".exe", minúsculo) que podem ser o app que o Windows informou no SMTC.
pub fn process_stems(source: &str) -> Vec<String> {
    let s = source.to_lowercase();
    let known: &[(&str, &[&str])] = &[
        ("spotify", &["spotify"]),
        ("applemusic", &["applemusic", "amplibraryagent"]),
        ("308046b0af4a39cb", &["firefox"]),
        ("firefox", &["firefox"]),
        ("msedge", &["msedge"]),
        ("edge", &["msedge"]),
        ("chrome", &["chrome"]),
        ("opera", &["opera"]),
        ("brave", &["brave"]),
        ("vivaldi", &["vivaldi"]),
        ("deezer", &["deezer"]),
        ("tidal", &["tidal"]),
        ("youtube-music", &["youtube music", "youtube-music"]),
        ("harle", &["harle player", "harle-player"]),
    ];
    for (needle, stems) in known {
        if s.contains(needle) {
            return stems.iter().map(|x| x.to_string()).collect();
        }
    }
    // genérico: "Algo.exe" → "algo"; "Empresa.App_hash!App" → "app"
    let base = s.split('!').next().unwrap_or("");
    let base = base.split('_').next().unwrap_or("");
    let base = base.rsplit(['\\', '/']).next().unwrap_or("");
    let base = base.strip_suffix(".exe").unwrap_or(base);
    let base = base.rsplit('.').next().unwrap_or(base).trim();
    if base.is_empty() {
        Vec::new()
    } else {
        vec![base.to_string()]
    }
}

/// Nome bonitinho do app pro usuário.
pub fn pretty(stem: &str) -> String {
    match stem {
        "spotify" => "Spotify".into(),
        "chrome" => "Chrome".into(),
        "msedge" => "Edge".into(),
        "firefox" => "Firefox".into(),
        "applemusic" => "Apple Music".into(),
        _ => {
            let mut c = stem.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{pretty, process_stems, VolumeInfo};
    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn process_stem(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
            let file = path.rsplit('\\').next().unwrap_or(&path).to_string();
            Some(file.strip_suffix(".exe").unwrap_or(&file).to_string())
        }
    }

    /// Faz `f` em todos os volumes do mixer que são do app; devolve o nome achado.
    fn with_app_sessions(source: &str, mut f: impl FnMut(&ISimpleAudioVolume)) -> windows::core::Result<Option<String>> {
        let stems = process_stems(source);
        if stems.is_empty() {
            return Ok(None);
        }
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let mgr: IAudioSessionManager2 = dev.Activate(CLSCTX_ALL, None)?;
            let list = mgr.GetSessionEnumerator()?;
            let mut found = None;
            for i in 0..list.GetCount()? {
                let Ok(ctl) = list.GetSession(i) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let Some(stem) = ctl2.GetProcessId().ok().and_then(process_stem) else { continue };
                if !stems.iter().any(|s| stem == *s || stem.starts_with(s.as_str())) {
                    continue;
                }
                if let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() {
                    f(&vol);
                    found.get_or_insert(pretty(&stem));
                }
            }
            Ok(found)
        }
    }

    fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            dev.Activate(CLSCTX_ALL, None)
        }
    }

    pub fn get(source: &str) -> Result<VolumeInfo, String> {
        let mut level = None;
        if let Ok(Some(target)) = with_app_sessions(source, |v| {
            if level.is_none() {
                level = unsafe { v.GetMasterVolume().ok() };
            }
        }) {
            if let Some(level) = level {
                return Ok(VolumeInfo { level, target });
            }
        }
        let ep = endpoint().map_err(|e| e.to_string())?;
        let level = unsafe { ep.GetMasterVolumeLevelScalar() }.map_err(|e| e.to_string())?;
        Ok(VolumeInfo { level, target: "Sistema".into() })
    }

    pub fn set(source: &str, level: f32) -> Result<VolumeInfo, String> {
        let level = level.clamp(0.0, 1.0);
        if let Ok(Some(target)) = with_app_sessions(source, |v| unsafe {
            let _ = v.SetMasterVolume(level, std::ptr::null());
            if level > 0.0 {
                let _ = v.SetMute(false, std::ptr::null());
            }
        }) {
            return Ok(VolumeInfo { level, target });
        }
        let ep = endpoint().map_err(|e| e.to_string())?;
        unsafe { ep.SetMasterVolumeLevelScalar(level, std::ptr::null()) }.map_err(|e| e.to_string())?;
        Ok(VolumeInfo { level, target: "Sistema".into() })
    }
}

#[cfg(windows)]
pub use imp::{get, set};

#[cfg(not(windows))]
pub fn get(_source: &str) -> Result<VolumeInfo, String> {
    Err("Volume só no Windows".into())
}
#[cfg(not(windows))]
pub fn set(_source: &str, _level: f32) -> Result<VolumeInfo, String> {
    Err("Volume só no Windows".into())
}

#[cfg(test)]
mod tests {
    use super::{pretty, process_stems};

    #[test]
    fn acha_o_processo_pelo_nome_do_smtc() {
        assert_eq!(process_stems("Spotify.exe"), vec!["spotify"]);
        assert_eq!(process_stems("Chrome"), vec!["chrome"]);
        assert_eq!(process_stems("308046b0af4a39cb"), vec!["firefox"]);
        assert_eq!(process_stems("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App")[0], "applemusic");
        assert_eq!(process_stems("C:\\Apps\\Foobar2000.exe"), vec!["foobar2000"]);
        assert!(process_stems("").is_empty());
        assert_eq!(pretty("spotify"), "Spotify");
        assert_eq!(pretty("vlc"), "Vlc");
    }
}
