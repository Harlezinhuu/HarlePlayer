//! Atalhos globais (funcionam com o app minimizado ou dentro de jogo):
//! Ctrl+Alt+Espaço / → / ← / ↑ / ↓ / M. Usa RegisterHotKey do Windows numa
//! thread própria com fila de mensagens. Cada atalho vira um "hp-control" pro front.

use tauri::AppHandle;

/// (id, ação mandada pro front, nome mostrado nas configurações)
pub const KEYS: &[(i32, &str, &str)] = &[
    (1, "toggle", "Ctrl+Alt+Espaço"),
    (2, "next", "Ctrl+Alt+→"),
    (3, "prev", "Ctrl+Alt+←"),
    (4, "volup", "Ctrl+Alt+↑"),
    (5, "voldown", "Ctrl+Alt+↓"),
    (6, "mini", "Ctrl+Alt+M"),
    (7, "lyricsbar", "Ctrl+Alt+L"),
];

pub fn action_for(id: i32) -> Option<&'static str> {
    KEYS.iter().find(|k| k.0 == id).map(|k| k.1)
}

/// Liga/desliga. Devolve os atalhos que outro programa já estava usando.
pub fn set(app: &AppHandle, on: bool) -> Result<Vec<String>, String> {
    imp::set(app, on)
}

#[cfg(windows)]
mod imp {
    use super::{action_for, KEYS};
    use std::sync::atomic::{AtomicU32, Ordering};
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_DOWN, VK_LEFT, VK_RIGHT, VK_SPACE, VK_UP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT};

    static THREAD: AtomicU32 = AtomicU32::new(0);

    fn vk(id: i32) -> u32 {
        (match id {
            1 => VK_SPACE,
            2 => VK_RIGHT,
            3 => VK_LEFT,
            4 => VK_UP,
            5 => VK_DOWN,
            7 => 0x4C, // L
            _ => 0x4D, // M
        }) as u32
    }

    pub fn set(app: &AppHandle, on: bool) -> Result<Vec<String>, String> {
        let running = THREAD.load(Ordering::SeqCst);
        if !on {
            if running != 0 {
                unsafe { PostThreadMessageW(running, WM_QUIT, 0, 0) };
                THREAD.store(0, Ordering::SeqCst);
            }
            return Ok(Vec::new());
        }
        if running != 0 {
            return Ok(Vec::new());
        }
        let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();
        let app = app.clone();
        std::thread::spawn(move || unsafe {
            let mut msg: MSG = std::mem::zeroed();
            // cria a fila de mensagens da thread antes de qualquer coisa
            PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            let mut failed = Vec::new();
            for (id, _, label) in KEYS {
                if RegisterHotKey(std::ptr::null_mut(), *id, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk(*id)) == 0 {
                    failed.push(label.to_string());
                }
            }
            let _ = tx.send(failed);
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_HOTKEY {
                    if let Some(action) = action_for(msg.wParam as i32) {
                        let _ = app.emit("hp-control", serde_json::json!({ "action": action, "from": "hotkey" }));
                    }
                }
            }
            for (id, _, _) in KEYS {
                UnregisterHotKey(std::ptr::null_mut(), *id);
            }
        });
        rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set(_app: &tauri::AppHandle, _on: bool) -> Result<Vec<String>, String> {
        Err("Atalhos globais só no Windows".into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn todo_atalho_tem_acao() {
        for (id, action, _) in super::KEYS {
            assert_eq!(super::action_for(*id), Some(*action));
        }
        assert_eq!(super::action_for(99), None);
    }
}
