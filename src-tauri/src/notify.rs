//! Aviso de música nova: um cartãozinho no canto da tela que aparece por
//! alguns segundos sem roubar o foco (dá pra continuar jogando/digitando) e
//! deixa o clique passar. Some sozinho; a janela só fica visível nesse tempo.

use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "notify";
const W: f64 = 380.0;
const H: f64 = 112.0;
static GEN: AtomicU64 = AtomicU64::new(0);
static LAST: Mutex<Option<Value>> = Mutex::new(None);

/// O que a página do aviso deve mostrar agora (ela pede ao carregar).
pub fn last() -> Option<Value> {
    LAST.lock().unwrap().clone()
}

pub fn show(app: &AppHandle, payload: Value) -> Result<(), String> {
    *LAST.lock().unwrap() = Some(payload.clone());
    let w = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => {
            let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notify.html".into()))
                .title("Harle Player — Aviso")
                .inner_size(W, H)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false);
            if let Ok(Some(m)) = app.primary_monitor() {
                let scale = m.scale_factor();
                let size = m.size().to_logical::<f64>(scale);
                let pos = m.position().to_logical::<f64>(scale);
                b = b.position(pos.x + size.width - W - 16.0, pos.y + 16.0);
            }
            let w = b.build().map_err(|e| e.to_string())?;
            let _ = w.set_ignore_cursor_events(true);
            w
        }
    };
    imp::show_no_activate(&w);
    let _ = app.emit_to(LABEL, "hp-notify", payload);
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(5200));
        if GEN.load(Ordering::SeqCst) == gen {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.hide();
            }
        }
    });
    Ok(())
}

#[cfg(windows)]
pub(crate) mod imp {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    };

    /// Mostra sem tirar o foco do jogo/app que está na frente.
    pub fn show_no_activate(w: &tauri::WebviewWindow) {
        let Ok(h) = w.hwnd() else { return };
        let hwnd = h.0 as isize as windows_sys::Win32::Foundation::HWND;
        unsafe {
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        }
    }
}

#[cfg(not(windows))]
pub(crate) mod imp {
    pub fn show_no_activate(w: &tauri::WebviewWindow) {
        let _ = w.show();
    }
}
