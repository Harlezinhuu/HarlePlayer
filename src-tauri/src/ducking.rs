//! Percebe quando alguém está falando no Discord: lê o "medidor de volume"
//! das sessões de áudio do Discord no mixer do Windows (em todos os dispositivos
//! de saída) e avisa o front com "voice-activity" true/false. O front decide
//! quanto abaixar a música. Nada é gravado: só o nível do som.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;

static ON: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Nível a partir do qual conta como alguém falando (0–1, pico da amostra).
pub const THRESHOLD: f32 = 0.02;
/// Quanto tempo de silêncio até considerar que a pessoa parou de falar.
pub const RELEASE_MS: u64 = 700;

pub fn set(app: &AppHandle, on: bool) {
    ON.store(on, Ordering::SeqCst);
    if on && !RUNNING.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::spawn(move || {
            while ON.load(Ordering::SeqCst) {
                let _ = imp::run(&app);
                std::thread::sleep(Duration::from_millis(1500));
            }
            RUNNING.store(false, Ordering::SeqCst);
        });
    }
}

/// Máquina de estados "falando / quieto" (separada pra dar pra testar).
pub struct Gate {
    talking: bool,
    quiet_ms: u64,
}

impl Gate {
    pub fn new() -> Self {
        Gate { talking: false, quiet_ms: 0 }
    }
    /// Recebe o pico e quantos ms passaram; devolve Some(novo estado) quando muda.
    pub fn feed(&mut self, peak: f32, dt_ms: u64) -> Option<bool> {
        if peak >= THRESHOLD {
            self.quiet_ms = 0;
            if !self.talking {
                self.talking = true;
                return Some(true);
            }
        } else if self.talking {
            self.quiet_ms += dt_ms;
            if self.quiet_ms >= RELEASE_MS {
                self.talking = false;
                return Some(false);
            }
        }
        None
    }
}

#[cfg(windows)]
mod imp {
    use super::{Gate, ON};
    use crate::volume::imp::process_stem;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows::core::Interface;
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{
        eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    /// Medidores das sessões do Discord (Discord, DiscordPTB, DiscordCanary) em todas as saídas.
    unsafe fn discord_meters() -> windows::core::Result<Vec<IAudioMeterInformation>> {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut out = Vec::new();
        for d in 0..devices.GetCount()? {
            let Ok(dev) = devices.Item(d) else { continue };
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(list) = mgr.GetSessionEnumerator() else { continue };
            for i in 0..list.GetCount().unwrap_or(0) {
                let Ok(ctl) = list.GetSession(i) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let Some(stem) = ctl2.GetProcessId().ok().and_then(process_stem) else { continue };
                if stem.starts_with("discord") {
                    if let Ok(m) = ctl.cast::<IAudioMeterInformation>() {
                        out.push(m);
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn run(app: &AppHandle) -> Result<(), String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let mut meters = Vec::new();
            let mut refreshed = Instant::now() - Duration::from_secs(10);
            let mut gate = Gate::new();
            let step = 50u64;
            while ON.load(Ordering::SeqCst) {
                // a lista de sessões muda (Discord abre/fecha, troca de fone): atualiza a cada 2 s
                if refreshed.elapsed() >= Duration::from_secs(2) {
                    meters = discord_meters().map_err(|e| e.to_string())?;
                    refreshed = Instant::now();
                }
                let peak = meters.iter().filter_map(|m| m.GetPeakValue().ok()).fold(0f32, f32::max);
                if let Some(talking) = gate.feed(peak, step) {
                    let _ = app.emit("voice-activity", talking);
                }
                std::thread::sleep(Duration::from_millis(step));
            }
            if gate.talking {
                let _ = app.emit("voice-activity", false);
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn run(_app: &tauri::AppHandle) -> Result<(), String> {
        Err("Só no Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fala_abaixa_e_silencio_volta_depois_de_um_tempo() {
        let mut g = Gate::new();
        assert_eq!(g.feed(0.001, 50), None);
        assert_eq!(g.feed(0.2, 50), Some(true));
        assert_eq!(g.feed(0.3, 50), None);
        // pausa curta entre palavras não solta
        for _ in 0..(RELEASE_MS / 50 - 1) {
            assert_eq!(g.feed(0.0, 50), None);
        }
        assert_eq!(g.feed(0.0, 50), Some(false));
        assert_eq!(g.feed(0.0, 50), None);
    }
}
