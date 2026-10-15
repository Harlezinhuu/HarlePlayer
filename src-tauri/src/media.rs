//! Lê o que está tocando no Windows (Spotify, YouTube Music no navegador,
//! SoundCloud, Apple Music, etc.) pela API de sessões de mídia do sistema —
//! a mesma que alimenta aquele controle de mídia do volume do Windows.
//! Não precisa de login nem de chave de API.

use serde::Serialize;

#[derive(Serialize, Clone, PartialEq, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub available: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// App de origem (ex.: "Spotify.exe", "chrome", "AppleInc.AppleMusicWin_...")
    pub source: String,
    pub playing: bool,
    pub position_ms: i64,
    pub duration_ms: i64,
    /// Momento (unix ms) em que a posição acima foi medida pelo app de origem.
    pub updated_at_ms: i64,
    /// Capa como data URL (base64).
    pub thumb: Option<String>,
    /// Serviço detectado: soundcloud, ytmusic, youtube, spotify, apple, deezer, browser, other
    pub service: String,
    /// Repetir do app de origem: "off" | "all" | "one"; None = o app não deixa controlar
    pub repeat: Option<String>,
    /// Aleatório do app de origem; None = o app não deixa controlar
    pub shuffle: Option<bool>,
}

pub fn start_watcher(app: tauri::AppHandle) {
    imp::start(app)
}

pub fn current() -> MediaState {
    imp::current()
}

pub fn control(action: &str, position_ms: Option<i64>) -> Result<(), String> {
    imp::control(action, position_ms)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sniff_mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0xFF, 0xD8, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'B', b'M', ..] => "image/bmp",
        _ => "image/png",
    }
}

#[cfg(windows)]
mod imp {
    use super::{now_ms, sniff_mime, MediaState};
    use base64::Engine;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::core::{Interface, Result as WinResult};
    use windows::Foundation::IAsyncOperation;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Media::MediaPlaybackAutoRepeatMode as RepeatMode;
    use windows::Storage::Streams::{DataReader, IInputStream};

    /// Diferença entre a época do Windows (1601) e a do Unix (1970), em ticks de 100ns.
    const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;

    static LAST: OnceLock<Mutex<MediaState>> = OnceLock::new();

    fn last() -> &'static Mutex<MediaState> {
        LAST.get_or_init(|| Mutex::new(MediaState::default()))
    }

    fn manager() -> WinResult<Manager> {
        Manager::RequestAsync()?.get()
    }

    fn is_playing(s: &Session) -> bool {
        s.GetPlaybackInfo()
            .and_then(|p| p.PlaybackStatus())
            .map(|st| st == Status::Playing)
            .unwrap_or(false)
    }

    /// Prefere a sessão "atual" do Windows se ela estiver tocando; senão,
    /// qualquer sessão que esteja tocando; senão, a atual (pausada).
    fn pick_session(m: &Manager) -> Option<Session> {
        let current = m.GetCurrentSession().ok();
        if let Some(s) = &current {
            if is_playing(s) {
                return current;
            }
        }
        if let Ok(list) = m.GetSessions() {
            let n = list.Size().unwrap_or(0);
            for i in 0..n {
                if let Ok(s) = list.GetAt(i) {
                    if is_playing(&s) {
                        return Some(s);
                    }
                }
            }
        }
        current
    }

    /// Repetir/aleatório, só se o app disser que aceita ser controlado.
    fn read_modes(s: &Session) -> (Option<String>, Option<bool>) {
        let Ok(info) = s.GetPlaybackInfo() else { return (None, None) };
        let ctrls = info.Controls().ok();
        let can_repeat = ctrls.as_ref().and_then(|c| c.IsRepeatEnabled().ok()).unwrap_or(false);
        let can_shuffle = ctrls.as_ref().and_then(|c| c.IsShuffleEnabled().ok()).unwrap_or(false);
        let repeat = if can_repeat {
            let mode = info.AutoRepeatMode().ok().and_then(|r| r.Value().ok());
            Some(
                match mode {
                    Some(RepeatMode::Track) => "one",
                    Some(RepeatMode::List) => "all",
                    _ => "off",
                }
                .to_string(),
            )
        } else {
            None
        };
        let shuffle = if can_shuffle {
            Some(info.IsShuffleActive().ok().and_then(|r| r.Value().ok()).unwrap_or(false))
        } else {
            None
        };
        (repeat, shuffle)
    }

    fn read_state(s: &Session) -> WinResult<MediaState> {
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let (repeat, shuffle) = read_modes(s);
        let tl = s.GetTimelineProperties()?;
        let playing = is_playing(s);

        let start = tl.StartTime()?.Duration / 10_000;
        let pos = tl.Position()?.Duration / 10_000;
        let end = tl.EndTime()?.Duration / 10_000;
        let upd = tl.LastUpdatedTime()?.UniversalTime;
        let updated_at_ms = if upd > EPOCH_DIFF_TICKS {
            (upd - EPOCH_DIFF_TICKS) / 10_000
        } else {
            now_ms()
        };

        Ok(MediaState {
            available: true,
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            album: props.AlbumTitle()?.to_string(),
            source: s.SourceAppUserModelId()?.to_string(),
            playing,
            position_ms: (pos - start).max(0),
            duration_ms: (end - start).max(0),
            updated_at_ms,
            thumb: None,
            service: String::new(),
            repeat,
            shuffle,
        })
    }

    fn read_thumb(s: &Session) -> WinResult<Option<String>> {
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let reference = match props.Thumbnail() {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        let stream = reference.OpenReadAsync()?.get()?;
        let size = stream.Size()? as u32;
        if size == 0 {
            return Ok(None);
        }
        let input: IInputStream = stream.cast()?;
        let reader = DataReader::CreateDataReader(&input)?;
        let load: IAsyncOperation<u32> = reader.LoadAsync(size)?.cast()?;
        let loaded = load.get()? as usize;
        let mut buf = vec![0u8; loaded];
        reader.ReadBytes(&mut buf)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok(Some(format!("data:{};base64,{}", sniff_mime(&buf), b64)))
    }

    pub fn start(app: AppHandle) {
        std::thread::spawn(move || {
            let mut mgr: Option<Manager> = None;
            let mut last_key = String::new();
            let mut thumb: Option<String> = None;
            let mut thumb_tries = 0u32;
            let mut fails = 0u32;
            let mut service = String::new();
            let mut service_checks = 0u32;

            loop {
                if mgr.is_none() {
                    mgr = manager().ok();
                }

                let mut next: Option<MediaState> = None;
                if let Some(m) = &mgr {
                    match pick_session(m) {
                        Some(s) => match read_state(&s) {
                            Ok(mut st) => {
                                fails = 0;
                                // O Chrome às vezes esconde a música ("Um site está com mídia
                                // aberta"); aí o nome vem do título da janela do navegador.
                                let mut from_window = None;
                                if crate::detect::is_placeholder(&st.title) {
                                    if let Some(bt) = crate::detect::track_from_browser_windows() {
                                        st.title = bt.title;
                                        st.artist = bt.artist;
                                        from_window = Some(bt.service);
                                    }
                                }
                                let key = format!("{}\u{1f}{}\u{1f}{}", st.title, st.artist, st.source);
                                if key != last_key {
                                    last_key = key;
                                    thumb = None;
                                    thumb_tries = 0;
                                    service_checks = 0;
                                }
                                // Detecta o serviço na troca de música e confere de novo
                                // algumas vezes (o título da aba pode demorar a atualizar).
                                if let Some(svc) = from_window {
                                    service = svc;
                                } else if service_checks < 6 && (service_checks == 0 || service == "browser" || service_checks % 3 == 0) {
                                    service = crate::detect::service_for(&st.source, &st.title);
                                }
                                service_checks = service_checks.saturating_add(1);
                                st.service = service.clone();
                                // Alguns apps trocam o título antes da capa: lê de novo
                                // uma vez logo depois pra não ficar com a capa antiga.
                                if thumb_tries < 8 {
                                    thumb_tries += 1;
                                    if thumb.is_none() || thumb_tries == 4 {
                                        if let Ok(Some(t)) = read_thumb(&s) {
                                            thumb = Some(t);
                                        }
                                    }
                                }
                                st.thumb = thumb.clone();
                                next = Some(st);
                            }
                            Err(_) => fails += 1,
                        },
                        None => next = Some(MediaState::default()),
                    }
                } else {
                    fails += 1;
                }

                // Erros passageiros não apagam a música da tela.
                if next.is_none() && fails >= 5 {
                    next = Some(MediaState::default());
                    mgr = None;
                }

                if let Some(state) = next {
                    let changed = {
                        let mut l = last().lock().unwrap();
                        if *l != state {
                            *l = state.clone();
                            true
                        } else {
                            false
                        }
                    };
                    if changed {
                        let _ = app.emit("media-update", &state);
                    }
                }

                std::thread::sleep(Duration::from_millis(400));
            }
        });
    }

    pub fn current() -> MediaState {
        last().lock().unwrap().clone()
    }

    pub fn control(action: &str, position_ms: Option<i64>) -> Result<(), String> {
        let m = manager().map_err(|e| e.to_string())?;
        let s = pick_session(&m).ok_or_else(|| "Nada tocando no momento".to_string())?;
        let result = match action {
            "toggle" => s.TryTogglePlayPauseAsync().and_then(|op| op.get()),
            "play" => s.TryPlayAsync().and_then(|op| op.get()),
            "pause" => s.TryPauseAsync().and_then(|op| op.get()),
            "next" => s.TrySkipNextAsync().and_then(|op| op.get()),
            "prev" => s.TrySkipPreviousAsync().and_then(|op| op.get()),
            "seek" => {
                let ms = position_ms.unwrap_or(0).max(0);
                s.TryChangePlaybackPositionAsync(ms * 10_000)
                    .and_then(|op| op.get())
            }
            "repeat:off" => s.TryChangeAutoRepeatModeAsync(RepeatMode::None).and_then(|op| op.get()),
            "repeat:all" => s.TryChangeAutoRepeatModeAsync(RepeatMode::List).and_then(|op| op.get()),
            "repeat:one" => s.TryChangeAutoRepeatModeAsync(RepeatMode::Track).and_then(|op| op.get()),
            "shuffle:on" => s.TryChangeShuffleActiveAsync(true).and_then(|op| op.get()),
            "shuffle:off" => s.TryChangeShuffleActiveAsync(false).and_then(|op| op.get()),
            other => return Err(format!("Ação desconhecida: {other}")),
        };
        match result {
            Ok(true) => Ok(()),
            Ok(false) => Err("O app de música não aceitou esse comando".into()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    //! Em outros sistemas ainda não há leitor de mídia — o app abre, mas
    //! mostra "nada tocando". (macOS/Linux ficam pra uma próxima versão.)
    use super::MediaState;
    use tauri::AppHandle;

    pub fn start(_app: AppHandle) {
        let _ = (super::now_ms(), super::sniff_mime(&[]));
    }

    pub fn current() -> MediaState {
        MediaState::default()
    }

    pub fn control(_action: &str, _position_ms: Option<i64>) -> Result<(), String> {
        Err("Controle de mídia disponível só no Windows por enquanto".into())
    }
}

#[cfg(test)]
mod tests {
    use super::sniff_mime;

    #[test]
    fn reconhece_formato_da_capa() {
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff_mime(b"\x89PNG\r\n"), "image/png");
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8"), "image/webp");
        assert_eq!(sniff_mime(b""), "image/png");
    }
}
