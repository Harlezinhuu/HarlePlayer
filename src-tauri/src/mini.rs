//! Mini player: janelinha sempre por cima, no canto da tela.
//! É a mesma página do app em modo "mini" (decide pelo nome da janela).

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "mini";
const W: f64 = 360.0;
const H: f64 = 108.0;

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// Abre ou fecha. Devolve se ficou aberto.
pub fn set(app: &AppHandle, open: bool) -> Result<bool, String> {
    if !open {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
        let _ = app.emit("mini-mode", false);
        return Ok(false);
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        return Ok(true);
    }
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Harle Player — Mini")
        .inner_size(W, H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false);
    // canto de baixo à direita, acima da barra de tarefas
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let pos = m.position().to_logical::<f64>(scale);
        b = b.position(pos.x + size.width - W - 20.0, pos.y + size.height - H - 64.0);
    }
    b.build().map_err(|e| e.to_string())?;
    let _ = app.emit("mini-mode", true);
    Ok(true)
}
