// Esconde o console no Windows em release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod media;
mod net;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Guarda o item "Modo widget" da bandeja pra manter ele sincronizado
/// quando o modo é trocado pelas configurações do app.
struct TrayState {
    widget_item: CheckMenuItem<Wry>,
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

#[tauri::command]
fn set_widget_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_widget_mode(&app, enabled)?;
    if let Some(tray) = app.try_state::<TrayState>() {
        let _ = tray.widget_item.set_checked(enabled);
    }
    Ok(())
}

#[tauri::command]
fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    let w = main_window(&app)?;
    w.hide().map_err(|e| e.to_string())
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

/// Modo widget: a janela ocupa a tela, fica atrás de todas as outras
/// (por cima do papel de parede) e some da barra de tarefas.
fn apply_widget_mode(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let w = main_window(app)?;
    let r = |res: tauri::Result<()>| res.map_err(|e| e.to_string());
    if enabled {
        r(w.set_always_on_top(false))?;
        r(w.set_always_on_bottom(true))?;
        r(w.set_skip_taskbar(true))?;
        r(w.maximize())?;
        r(w.show())?;
    } else {
        r(w.set_always_on_bottom(false))?;
        r(w.set_skip_taskbar(false))?;
        r(w.unmaximize())?;
        r(w.show())?;
        let _ = w.set_focus();
    }
    Ok(())
}

// ---------- bandeja ----------

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Mostrar Harle Player", true, None::<&str>)?;
    let widget = CheckMenuItem::with_id(
        app,
        "widget",
        "Modo widget (fixar na área de trabalho)",
        true,
        false,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &widget, &sep, &quit])?;

    app.manage(TrayState {
        widget_item: widget.clone(),
    });

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Harle Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "widget" => {
                let on = widget.is_checked().unwrap_or(false);
                let _ = apply_widget_mode(app, on);
                let _ = app.emit("widget-mode", on);
            }
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
    tauri::Builder::default()
        .setup(|app| {
            build_tray(app)?;
            media::start_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_media,
            media_control,
            http_get,
            open_url,
            set_widget_mode,
            hide_to_tray,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Harle Player");
}
