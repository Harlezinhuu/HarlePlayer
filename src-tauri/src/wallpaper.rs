//! Modo wallpaper: abre uma segunda janela e "cola" ela atrás dos ícones
//! da área de trabalho — o mesmo truque usado pelo Wallpaper Engine e pelo
//! Lively.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "wallpaper";

pub fn set(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        if app.get_webview_window(LABEL).is_some() {
            return Ok(());
        }
        let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Harle Player — Wallpaper")
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .shadow(false)
            .inner_size(1280.0, 720.0)
            .build()
            .map_err(|e| e.to_string())?;
        if let Err(e) = imp::attach(&w) {
            let _ = w.destroy();
            return Err(e);
        }
    } else {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
        imp::refresh_wallpaper();
    }
    Ok(())
}

/// Redesenha o papel de parede original do Windows (limpa o que sobrou da nossa janela).
pub fn refresh_wallpaper() {
    imp::refresh_wallpaper();
}


#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetWindowLongPtrW, GetWindowRect,
        SendMessageTimeoutW, SetParent, SetWindowLongPtrW, SetWindowPos, SystemParametersInfoW,
        GWL_STYLE, SMTO_NORMAL, SPIF_SENDCHANGE, SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, WS_CAPTION, WS_CHILD,
        WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn find_worker(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let defview = wide("SHELLDLL_DefView");
        let worker = wide("WorkerW");
        if !FindWindowExW(hwnd, null_mut(), defview.as_ptr(), null()).is_null() {
            let out = lparam as *mut HWND;
            *out = FindWindowExW(null_mut(), hwnd, worker.as_ptr(), null());
        }
        1
    }

    /// Acha a camada "WorkerW", que fica entre o papel de parede e os ícones.
    unsafe fn worker_w() -> Option<HWND> {
        let progman_cls = wide("Progman");
        let progman = FindWindowW(progman_cls.as_ptr(), null());
        if progman.is_null() {
            return None;
        }
        // Mensagem não documentada que pede pro Explorer criar o WorkerW.
        let mut res: usize = 0;
        SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, &mut res);
        SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, &mut res);

        // Windows 10 / 11 até 23H2: WorkerW é uma janela solta logo depois da dos ícones.
        let mut found: HWND = null_mut();
        EnumWindows(Some(find_worker), &mut found as *mut HWND as LPARAM);

        // Windows 11 24H2+: o WorkerW passou a ser filho do Progman.
        if found.is_null() {
            let worker_cls = wide("WorkerW");
            found = FindWindowExW(progman, null_mut(), worker_cls.as_ptr(), null());
        }
        if found.is_null() {
            None
        } else {
            Some(found)
        }
    }

    unsafe fn monitor_rect(mon: windows_sys::Win32::Graphics::Gdi::HMONITOR) -> RECT {
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(mon, &mut mi);
        mi.rcMonitor
    }

    pub fn attach(win: &tauri::WebviewWindow) -> Result<(), String> {
        let raw = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let hwnd = raw as HWND;
        unsafe {
            let worker = worker_w()
                .ok_or_else(|| "Não achei a camada do papel de parede do Windows".to_string())?;

            // Vira janela "filha" sem borda nenhuma.
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            let strip = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
            let new_style = (style & !strip) | WS_CHILD | WS_VISIBLE;
            SetWindowLongPtrW(hwnd, GWL_STYLE, new_style as isize);

            if SetParent(hwnd, worker).is_null() {
                return Err("Não consegui colocar o wallpaper atrás dos ícones".into());
            }

            // Ocupa o monitor principal. As coordenadas são relativas ao WorkerW.
            let screen = monitor_rect(MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY));
            let mut parent: RECT = std::mem::zeroed();
            GetWindowRect(worker, &mut parent);
            SetWindowPos(
                hwnd,
                null_mut(),
                screen.left - parent.left,
                screen.top - parent.top,
                screen.right - screen.left,
                screen.bottom - screen.top,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
            );
        }
        Ok(())
    }

    pub fn refresh_wallpaper() {
        unsafe {
            let mut buf = [0u16; 520];
            let ok = SystemParametersInfoW(
                SPI_GETDESKWALLPAPER,
                buf.len() as u32,
                buf.as_mut_ptr() as *mut c_void,
                0,
            );
            if ok != 0 {
                SystemParametersInfoW(
                    SPI_SETDESKWALLPAPER,
                    0,
                    buf.as_mut_ptr() as *mut c_void,
                    SPIF_SENDCHANGE,
                );
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn attach(_win: &tauri::WebviewWindow) -> Result<(), String> {
        Err("O modo wallpaper só funciona no Windows por enquanto".into())
    }

    pub fn refresh_wallpaper() {}

}
