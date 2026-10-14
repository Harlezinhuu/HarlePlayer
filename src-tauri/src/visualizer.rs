//! Visualizador: escuta o som que está saindo do PC (WASAPI "loopback", o mesmo
//! que gravadores de tela usam) e manda pro front, ~30x por segundo, quanto de
//! grave e de volume tem agora. Funciona com qualquer app: Spotify, navegador,
//! o próprio player… Nada é gravado: só dois números por quadro.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;

static ON: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn set(app: &AppHandle, on: bool) {
    ON.store(on, Ordering::SeqCst);
    if on && !RUNNING.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::spawn(move || {
            while ON.load(Ordering::SeqCst) {
                // erro = trocou o fone/caixa de som, driver reiniciou… tenta de novo
                let _ = imp::run(&app);
                std::thread::sleep(Duration::from_millis(1500));
            }
            RUNNING.store(false, Ordering::SeqCst);
        });
    }
}

/// Mede graves (dois filtros passa-baixa em ~150 Hz) e volume geral, com ganho
/// automático: o pico vai caindo devagar, então música baixa também mexe.
pub struct Analyzer {
    alpha: f32,
    lp1: f32,
    lp2: f32,
    bass_acc: f32,
    lvl_acc: f32,
    n: u32,
    bass_peak: f32,
    lvl_peak: f32,
}

impl Analyzer {
    pub fn new(rate: u32) -> Self {
        let dt = 1.0 / rate.max(8000) as f32;
        let rc = 1.0 / (2.0 * std::f32::consts::PI * 150.0);
        Analyzer {
            alpha: dt / (rc + dt),
            lp1: 0.0,
            lp2: 0.0,
            bass_acc: 0.0,
            lvl_acc: 0.0,
            n: 0,
            bass_peak: 0.02,
            lvl_peak: 0.02,
        }
    }

    pub fn push(&mut self, s: f32) {
        self.lp1 += self.alpha * (s - self.lp1);
        self.lp2 += self.alpha * (self.lp1 - self.lp2);
        self.bass_acc += self.lp2 * self.lp2;
        self.lvl_acc += s * s;
        self.n += 1;
    }

    /// (graves, volume), cada um de 0 a 1.
    pub fn take(&mut self) -> (f32, f32) {
        let (b, l) = if self.n == 0 {
            (0.0, 0.0)
        } else {
            ((self.bass_acc / self.n as f32).sqrt(), (self.lvl_acc / self.n as f32).sqrt())
        };
        self.bass_acc = 0.0;
        self.lvl_acc = 0.0;
        self.n = 0;
        self.bass_peak = (self.bass_peak * 0.997).max(b).max(0.02);
        self.lvl_peak = (self.lvl_peak * 0.997).max(l).max(0.02);
        ((b / self.bass_peak).min(1.0), (l / self.lvl_peak).min(1.0))
    }
}

#[cfg(windows)]
mod imp {
    use super::{Analyzer, ON};
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

    pub fn run(app: &AppHandle) -> Result<(), String> {
        unsafe { run_inner(app).map_err(|e| e.to_string()) }
    }

    unsafe fn run_inner(app: &AppHandle) -> windows::core::Result<()> {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
        let fmt = client.GetMixFormat()?;
        let channels = ((*fmt).nChannels as usize).max(1);
        let bits = (*fmt).wBitsPerSample;
        let rate = (*fmt).nSamplesPerSec;
        let block = ((*fmt).nBlockAlign as usize).max(1);
        let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None);
        CoTaskMemFree(Some(fmt as *const _));
        init?;
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let mut an = Analyzer::new(rate);
        let mut last = Instant::now();
        let result = (|| -> windows::core::Result<()> {
            while ON.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(10));
                let mut packet = cap.GetNextPacketSize()?;
                while packet > 0 {
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                    let silent = flags & 2 != 0; // AUDCLNT_BUFFERFLAGS_SILENT
                    for f in 0..frames as usize {
                        if silent || data.is_null() {
                            an.push(0.0);
                            continue;
                        }
                        let p = data.add(f * block);
                        let mut sum = 0f32;
                        for c in 0..channels {
                            sum += match bits {
                                32 => (p.add(c * 4) as *const f32).read_unaligned(),
                                16 => (p.add(c * 2) as *const i16).read_unaligned() as f32 / 32768.0,
                                _ => 0.0,
                            };
                        }
                        an.push(sum / channels as f32);
                    }
                    cap.ReleaseBuffer(frames)?;
                    packet = cap.GetNextPacketSize()?;
                }
                if last.elapsed() >= Duration::from_millis(33) {
                    last = Instant::now();
                    let (b, l) = an.take();
                    let _ = app.emit("audio-level", [b, l]);
                }
            }
            Ok(())
        })();
        let _ = client.Stop();
        let _ = app.emit("audio-level", [0.0f32, 0.0f32]);
        result
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn run(_app: &tauri::AppHandle) -> Result<(), String> {
        Err("Visualizador só no Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::Analyzer;

    fn feed(freq: f32, secs: f32) -> (f32, f32) {
        let rate = 48_000u32;
        let mut a = Analyzer::new(rate);
        // primeiro um trecho de referência com grave forte, pra calibrar o pico
        for i in 0..(rate / 2) {
            a.push((i as f32 * 60.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5);
        }
        a.take();
        // descarta 20 ms (o filtro ainda está "saindo" do grave anterior)
        let skip = rate / 50;
        for i in 0..skip {
            a.push((i as f32 * freq * std::f32::consts::TAU / rate as f32).sin() * 0.5);
        }
        a.take();
        for i in skip..skip + (rate as f32 * secs) as u32 {
            a.push((i as f32 * freq * std::f32::consts::TAU / rate as f32).sin() * 0.5);
        }
        a.take()
    }

    #[test]
    fn grave_mexe_e_agudo_nao() {
        let (bass_low, lvl_low) = feed(60.0, 0.05);
        let (bass_high, lvl_high) = feed(5000.0, 0.05);
        assert!(bass_low > 0.8, "60 Hz deveria dar grave alto: {bass_low}");
        assert!(bass_high < 0.1, "5 kHz não deveria dar grave: {bass_high}");
        assert!(lvl_low > 0.8 && lvl_high > 0.8, "volume parecido: {lvl_low} {lvl_high}");
    }

    #[test]
    fn silencio_da_zero() {
        let mut a = Analyzer::new(44_100);
        for _ in 0..1000 {
            a.push(0.0);
        }
        assert_eq!(a.take(), (0.0, 0.0));
        assert_eq!(a.take(), (0.0, 0.0)); // sem amostras
    }
}
