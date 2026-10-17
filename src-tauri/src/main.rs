// Esconde o console no Windows em release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod detect;
mod discord;
mod ducking;
mod hotkeys;
mod media;
mod mini;
mod net;
mod notify;
mod overlay;
mod party;
mod remote;
mod search;
mod updater;
mod visualizer;
mod volume;
mod wallpaper;
mod ytdlp;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Wry};

/// Guarda o item "Wallpaper animado" da bandeja pra manter ele sincronizado
/// quando o modo é trocado pelas configurações do app.
struct TrayState {
    wallpaper_item: CheckMenuItem<Wry>,
    mini_item: CheckMenuItem<Wry>,
}

// ---------- comandos chamados pelo front ----------

#[tauri::command]
fn get_media() -> media::MediaState {
    media::current()
}

#[tauri::command]
async fn media_control(action: String, position_ms: Option<i64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::control(&action, position_ms))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || net::get_text(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    net::open_url(&url)
}

/// Liga/desliga o wallpaper animado atrás dos ícones.
/// (async: no Windows, criar janela dentro de comando síncrono trava.)
#[tauri::command]
async fn set_wallpaper_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let result = wallpaper::set(&app, enabled);
    let on = result.is_ok() && enabled;
    if let Some(tray) = app.try_state::<TrayState>() {
        let _ = tray.wallpaper_item.set_checked(on);
    }
    result
}

/// Busca direto no SoundCloud ou no YouTube Music.
#[tauri::command]
async fn search_music(service: String, query: String) -> Result<search::SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || search::search(&service, &query))
        .await
        .map_err(|e| e.to_string())?
}

/// Busca completa (aba Músicas/Artistas), página por página.
#[tauri::command]
async fn search_page(service: String, query: String, kind: String, cursor: Option<String>) -> Result<search::SearchPage, String> {
    tauri::async_runtime::spawn_blocking(move || search::search_page(&service, &query, &kind, cursor.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Perfil público do SoundCloud: curtidas e playlists (sem login).
#[tauri::command]
async fn soundcloud_profile(profile: String) -> Result<search::Profile, String> {
    tauri::async_runtime::spawn_blocking(move || search::soundcloud_profile(&profile))
        .await
        .map_err(|e| e.to_string())?
}

/// Importa uma playlist pelo link (Spotify, SoundCloud, YouTube).
#[tauri::command]
async fn import_playlist(url: String) -> Result<search::ImportedPlaylist, String> {
    tauri::async_runtime::spawn_blocking(move || search::import_playlist(&url))
        .await
        .map_err(|e| e.to_string())?
}

/// Baixa o áudio de uma música do SoundCloud pra tocar dentro do app.
/// Volta os bytes crus (ArrayBuffer no JS), sem passar por base64.
#[tauri::command]
async fn soundcloud_audio(url: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || search::soundcloud_audio(&url))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Reserva do YouTube: áudio pelo yt-dlp quando o vídeo bloqueia o player embutido.
#[tauri::command]
async fn youtube_audio(app: AppHandle, url: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || ytdlp::audio(&app, &url))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Confere se tem versão nova nas Releases do GitHub.
#[tauri::command]
async fn check_update() -> Result<updater::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(updater::check)
        .await
        .map_err(|e| e.to_string())?
}

/// Baixa a versão nova, fecha o app e deixa o instalador rodando (ele reabre o app no fim).
#[tauri::command]
async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || updater::download_and_schedule(&url))
        .await
        .map_err(|e| e.to_string())??;
    app.exit(0);
    Ok(())
}

/// Volume do app que está tocando (Spotify, navegador…) pelo mixer do Windows.
#[tauri::command]
async fn get_volume(source: String) -> Result<volume::VolumeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || volume::get(&source))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_volume(source: String, level: f32) -> Result<volume::VolumeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || volume::set(&source, level))
        .await
        .map_err(|e| e.to_string())?
}

/// Abre/fecha o mini player.
#[tauri::command]
async fn set_mini(app: AppHandle, open: bool) -> Result<bool, String> {
    let r = mini::set(&app, open);
    if let Some(tray) = app.try_state::<TrayState>() {
        let _ = tray.mini_item.set_checked(*r.as_ref().unwrap_or(&false));
    }
    r
}

/// Liga/desliga a escuta do som pro visualizador.
#[tauri::command]
fn set_visualizer(app: AppHandle, on: bool) {
    visualizer::set(&app, on);
}

/// Baixa uma imagem (capa) pra desenhar no card do Wrapped sem "sujar" o canvas.
#[tauri::command]
async fn image_bytes(url: String) -> Result<tauri::ipc::Response, String> {
    if !url.starts_with("https://") {
        return Err("Só imagens https".into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || search::http_bytes(&url))
        .await
        .map_err(|e| e.to_string())??;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Imagem grande demais".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Salva o card do Wrapped em Imagens\Harle Player e mostra no Explorer.
#[tauri::command]
async fn save_image(name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| e.to_string())?;
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("Imagem inválida".into());
    }
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(60).collect();
    let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = home.join("Pictures").join("Harle Player");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.png", if safe.is_empty() { "wrapped".into() } else { safe }));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn();
    }
    Ok(path.display().to_string())
}

/// Controle pelo celular: liga o servidor na rede local e devolve o link do QR.
#[tauri::command]
async fn remote_start(app: AppHandle) -> Result<remote::RemoteInfo, String> {
    remote::start(&app)
}

#[tauri::command]
fn remote_stop() {
    remote::stop();
}

#[tauri::command]
async fn remote_new_code() -> Result<remote::RemoteInfo, String> {
    remote::regenerate()
}

/// O que está tocando (o celular lê isso).
#[tauri::command]
fn remote_update(now: serde_json::Value) {
    remote::set_now(&now);
}

#[tauri::command]
fn remote_lyrics(lyrics: serde_json::Value) {
    remote::set_lyrics(&lyrics);
}

/// Liga/desliga os atalhos globais; devolve os que outro programa já usa.
#[tauri::command]
async fn set_hotkeys(app: AppHandle, on: bool) -> Result<Vec<String>, String> {
    hotkeys::set(&app, on)
}

/// Mostra o aviso de música nova no canto da tela.
#[tauri::command]
async fn notify_show(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    notify::show(&app, payload)
}

#[tauri::command]
fn notify_last() -> Option<serde_json::Value> {
    notify::last()
}

/// Liga/desliga a escuta da voz no Discord (pra abaixar a música).
#[tauri::command]
fn set_ducking(app: AppHandle, on: bool) {
    ducking::set(&app, on);
}

/// Mostra/esconde a letra flutuante.
#[tauri::command]
async fn set_lyricsbar(app: AppHandle, on: bool) -> Result<bool, String> {
    overlay::set(&app, on)
}

/// Salva a gravação do karaokê em Músicas\Harle Player e mostra no Explorer.
#[tauri::command]
async fn save_audio(name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;
    let b64 = data_base64.split_once("base64,").map(|x| x.1).unwrap_or(&data_base64);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    let ext = if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        "webm"
    } else if bytes.starts_with(b"OggS") {
        "ogg"
    } else if bytes.len() > 8 && &bytes[4..8] == b"ftyp" {
        "m4a"
    } else {
        return Err("Áudio inválido".into());
    };
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(60).collect();
    let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = home.join("Music").join("Harle Player");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{ext}", if safe.is_empty() { "karaoke".into() } else { safe }));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn();
    }
    Ok(path.display().to_string())
}

/// Ouvir junto: entra numa sala (escuta) / sai / manda mensagem.
#[tauri::command]
fn party_join(app: AppHandle, topic: String) -> Result<(), String> {
    party::join(&app, &topic)
}

#[tauri::command]
fn party_leave() {
    party::leave();
}

#[tauri::command]
async fn party_send(topic: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || party::publish(&topic, &body))
        .await
        .map_err(|e| e.to_string())?
}

/// Salva o vídeo da retrospectiva em Vídeos\Harle Player e mostra no Explorer.
#[tauri::command]
async fn save_video(name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;
    let b64 = data_base64.split_once("base64,").map(|x| x.1).unwrap_or(&data_base64);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    let ext = if bytes.len() > 8 && &bytes[4..8] == b"ftyp" {
        "mp4"
    } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        "webm"
    } else {
        return Err("Vídeo inválido".into());
    };
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(60).collect();
    let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = home.join("Videos").join("Harle Player");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{ext}", if safe.is_empty() { "retrospectiva".into() } else { safe }));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn();
    }
    Ok(path.display().to_string())
}

/// Atualiza o "Ouvindo …" no perfil do Discord.
#[tauri::command]
fn discord_set(presence: discord::Presence) {
    discord::set(presence);
}

#[tauri::command]
fn discord_clear() {
    discord::clear();
}

#[tauri::command]
fn discord_status() -> discord::Status {
    discord::current_status()
}

#[tauri::command]
fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    main_window(&app)?.hide().map_err(|e| e.to_string())?;
    let _ = app.emit("main-minimized", ());
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------- janela ----------

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Janela principal não encontrada".to_string())
}

fn show_main(app: &AppHandle) {
    if let Ok(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Controles de mídia pela bandeja (fora da thread principal, porque a API
/// de mídia do Windows bloqueia enquanto espera a resposta do app).
fn tray_media(action: &'static str) {
    std::thread::spawn(move || {
        let _ = media::control(action, None);
    });
}

// ---------- bandeja ----------

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Abrir Harle Player", true, None::<&str>)?;
    let wall = CheckMenuItem::with_id(
        app,
        "wallpaper",
        "Wallpaper animado na área de trabalho",
        true,
        false,
        None::<&str>,
    )?;
    let mini_item = CheckMenuItem::with_id(app, "mini", "Mini player", true, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let play = MenuItem::with_id(app, "playpause", "Tocar / pausar", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Próxima", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Anterior", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &mini_item, &wall, &sep1, &play, &next, &prev, &sep2, &quit],
    )?;

    app.manage(TrayState {
        wallpaper_item: wall.clone(),
        mini_item: mini_item.clone(),
    });

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Harle Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "wallpaper" => {
                let on = wall.is_checked().unwrap_or(false);
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let ok = wallpaper::set(&handle, on).is_ok();
                    if let Some(tray) = handle.try_state::<TrayState>() {
                        let _ = tray.wallpaper_item.set_checked(ok && on);
                    }
                    let _ = handle.emit("wallpaper-mode", ok && on);
                });
            }
            "mini" => {
                let handle = app.clone();
                let open = !mini::is_open(app);
                tauri::async_runtime::spawn(async move {
                    let ok = mini::set(&handle, open).unwrap_or(false);
                    if let Some(tray) = handle.try_state::<TrayState>() {
                        let _ = tray.mini_item.set_checked(ok);
                    }
                });
            }
            "playpause" => tray_media("toggle"),
            "next" => tray_media("next"),
            "prev" => tray_media("prev"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // avisa o front quando a janela principal é minimizada / volta (mini player automático)
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::Resized(_) => {
                    if window.is_minimized().unwrap_or(false) {
                        let _ = window.emit("main-minimized", ());
                    }
                }
                tauri::WindowEvent::Focused(true) => {
                    let _ = window.emit("main-restored", ());
                }
                _ => {}
            }
        })
        .setup(|app| {
            build_tray(app)?;
            media::start_watcher(app.handle().clone());
            discord::start();
            search::warm_up();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_media,
            media_control,
            http_get,
            open_url,
            set_wallpaper_mode,
            search_music,
            search_page,
            import_playlist,
            soundcloud_profile,
            soundcloud_audio,
            youtube_audio,
            check_update,
            install_update,
            party_join,
            party_leave,
            party_send,
            save_video,
            set_ducking,
            set_lyricsbar,
            save_audio,
            set_hotkeys,
            notify_show,
            notify_last,
            remote_start,
            remote_stop,
            remote_new_code,
            remote_update,
            remote_lyrics,
            set_mini,
            set_visualizer,
            image_bytes,
            save_image,
            get_volume,
            set_volume,
            discord_set,
            discord_clear,
            discord_status,
            hide_to_tray,
            show_main_window,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Harle Player");

    app.run(|_app, event| {
        // Ao sair, devolve o papel de parede normal do Windows.
        if let RunEvent::Exit = event {
            wallpaper::refresh_wallpaper();
        }
    });
}
