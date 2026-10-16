//! Letra flutuante: uma faixa transparente na parte de baixo da tela, por cima
//! de tudo (jogo em janela sem borda, navegador, Discord…), que deixa o clique
//! passar e não rouba o foco. O front manda cada verso por "hp-lyric".

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "lyricsbar";

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

pub fn set(app: &AppHandle, on: bool) -> Result<bool, String> {
    if !on {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
        return Ok(false);
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        crate::notify::imp::show_no_activate(&w);
        return Ok(true);
    }
    let (mut w, mut h, mut x, mut y) = (1100.0, 170.0, 100.0, 600.0);
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let pos = m.position().to_logical::<f64>(scale);
        w = (size.width * 0.72).min(1500.0);
        h = 170.0;
        x = pos.x + (size.width - w) / 2.0;
        y = pos.y + size.height - h - 70.0; // acima da barra de tarefas
    }
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("lyricsbar.html".into()))
        .title("Harle Player — Letra")
        .inner_size(w, h)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_ignore_cursor_events(true);
    crate::notify::imp::show_no_activate(&win);
    Ok(true)
}
