//! Player do YouTube com uma origem que o YouTube aceita.
//!
//! Desde nov/2026 o YouTube recusa (erro 152/153) o player embutido numa página
//! `http://tauri.localhost`. O app passa a abrir o player dentro de
//! `src/yt-embed.html`, num endereço https (o GitHub do autor). Esse endereço
//! nunca vai pra internet: o WebView2 pergunta pro app antes de buscar, e o app
//! responde com a página embutida no executável (o mesmo mecanismo que o Tauri
//! usa pra servir as páginas do próprio app).

pub const PAGE_URL: &str = "https://harlezinhuu.github.io/HarlePlayer/yt-embed.html";
const PAGE: &str = include_str!("../../src/yt-embed.html");

/// O pedido é da página do player? (ignora `?…`/`#…`)
pub fn is_page(uri: &str) -> bool {
    let base = uri.split(['?', '#']).next().unwrap_or("");
    base == PAGE_URL
}

#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|wv| unsafe {
        if let Err(e) = imp::attach(&wv.controller()) {
            eprintln!("player do YouTube: não deu pra servir a página ({e})");
        }
    });
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {
    let _ = (PAGE, is_page(""));
}

#[cfg(windows)]
mod imp {
    use super::{is_page, PAGE, PAGE_URL};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
    use windows62::Win32::UI::Shell::SHCreateMemStream;
    use windows_core::{Interface, HSTRING, PWSTR};

    pub unsafe fn attach(controller: &ICoreWebView2Controller) -> windows_core::Result<()> {
        let webview = controller.CoreWebView2()?;
        let env = webview.cast::<ICoreWebView2_2>()?.Environment()?;
        let filter = HSTRING::from(format!("{PAGE_URL}*"));
        // a página é aberta num <iframe>: precisa do filtro que vale pra iframes
        match webview.cast::<ICoreWebView2_22>() {
            Ok(w22) => w22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &filter,
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?,
            Err(_) => webview.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?,
        }
        let mut token: i64 = 0;
        webview.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let request = args.Request()?;
                let mut uri = PWSTR::null();
                request.Uri(&mut uri)?;
                if !is_page(&take_pwstr(uri)) {
                    return Ok(());
                }
                let stream = SHCreateMemStream(Some(PAGE.as_bytes()));
                let headers = HSTRING::from(
                    "Content-Type: text/html; charset=utf-8\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nCache-Control: no-store",
                );
                let response = env.CreateWebResourceResponse(stream.as_ref(), 200, &HSTRING::from("OK"), &headers)?;
                args.SetResponse(&response)?;
                Ok(())
            })),
            &mut token,
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_a_pagina_do_player() {
        assert!(is_page(PAGE_URL));
        assert!(is_page(&format!("{PAGE_URL}?x=1")));
        assert!(!is_page("https://harlezinhuu.github.io/HarlePlayer/outra.html"));
        assert!(!is_page("https://harlezinhuu.github.io/HarlePlayer/yt-embed.html.evil.com/"));
        assert!(PAGE.contains("iframe_api"));
    }
}
