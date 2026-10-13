// Esconde o console no Windows em release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod detect;
mod discord;
mod media;
mod net;
mod search;
mod updater;
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
    main_window(&app)?.hide().map_err(|e| e.to_string())
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
    let sep1 = PredefinedMenuItem::separator(app)?;
    let play = MenuItem::with_id(app, "playpause", "Tocar / pausar", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Próxima", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Anterior", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &wall, &sep1, &play, &next, &prev, &sep2, &quit],
    )?;

    app.manage(TrayState {
        wallpaper_item: wall.clone(),
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
            soundcloud_audio,
            youtube_audio,
            check_update,
            install_update,
            get_volume,
            set_volume,
            discord_set,
            discord_clear,
            discord_status,
            hide_to_tray,
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
