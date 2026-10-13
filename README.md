<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Harle Player" />

# Harle Player

**Um player de música estético pro desktop.**
Funciona com Spotify, YouTube Music, SoundCloud, Apple Music, Deezer e o que mais estiver tocando no seu PC.

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust)
![JavaScript](https://img.shields.io/badge/JS-sem%20framework-F7DF1E?logo=javascript&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows)
[![Build](https://github.com/Harlezinhuu/HarlePlayer/actions/workflows/build.yml/badge.svg)](https://github.com/Harlezinhuu/HarlePlayer/actions)

<img src="docs/screenshot.jpg" alt="Harle Player tocando, com relógio, carrossel de capas e letra sincronizada" />

</div>

## ✨ O que ele faz

- **Funciona com qualquer app de música.** Lê o que está tocando pelo sistema de mídia do Windows (o mesmo do controle de volume), sem login e sem chave de API.
- **Carrossel 3D de capas** com o que você ouviu por último. Dá pra girar com a roda do mouse ou com as setas ← →.
- **Letra sincronizada** aparecendo em pedacinhos animados em cima do fundo, via [LRCLIB](https://lrclib.net).
- **Relógio gigante** em fonte condensada, no estilo de tela de bloqueio.
- **Fundo dinâmico** feito com a capa da música. A cor de destaque do app também muda conforme a capa.
- **Busca com capas** (Deezer API): o resultado abre direto no Spotify, YouTube Music, SoundCloud, Apple Music ou Deezer.
- **Controles**: tocar/pausar, próxima, anterior e barra de progresso clicável.
- **Fundo personalizado**: imagem, vídeo (mp4/webm) ou transparente.
- **Modo widget**: fixa o player na área de trabalho, atrás das janelas.
- Fica na **bandeja do sistema** quando você fecha.

<img src="docs/search.jpg" alt="Busca com resultados e artistas" />

## ⌨️ Atalhos

| Tecla | Ação |
|---|---|
| `Espaço` | Tocar / pausar |
| `/` ou `Ctrl+K` | Pesquisar |
| `←` `→` | Girar o carrossel |
| `Esc` | Fechar busca / configurações |

## 📥 Baixar

Vá em [**Releases**](https://github.com/Harlezinhuu/HarlePlayer/releases) e baixe o `Harle Player_x.x.x_x64-setup.exe`.

## 🛠️ Rodando o código

Pré-requisitos: [Node.js](https://nodejs.org), [Rust](https://rustup.rs) e o [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (já vem no Windows 10/11).

```bash
npm install
npm run dev      # abre o app em modo desenvolvimento
npm run build    # gera o instalador em src-tauri/target/release/bundle/nsis
```

Pra mexer só no visual, sem compilar nada, use `npm run demo`. Ele abre o front no navegador com músicas e letra de exemplo.

## 🧩 Como funciona

```
┌────────────── Front (src/) ──────────────┐      ┌────────────── Rust (src-tauri/) ───────────────┐
│ HTML + CSS + JS puro                     │      │ media.rs → GlobalSystemMediaTransportControls │
│ relógio · carrossel 3D · letra · busca   │◀────▶│   lê título/artista/capa/posição a cada 400ms │
│                                          │ IPC  │   e manda play/pause/próxima pro app de música│
│                                          │      │ net.rs   → LRCLIB (letras) e Deezer (busca)   │
└──────────────────────────────────────────┘      │ main.rs  → bandeja, modo widget, janela       │
                                                  └───────────────────────────────────────────────┘
```

A posição da música é medida pelo app de origem e interpolada no front a cada frame. Cada verso da letra (LRC) é quebrado em pedaços de 1–3 palavras, e o tempo do verso é distribuído entre eles pelo tamanho de cada pedaço.

## 🗺️ Próximos passos

- [ ] Suporte a macOS
- [ ] Tocar direto pelo app (Spotify Web API / MusicKit)
- [ ] Iniciar junto com o Windows
- [ ] Temas e posição dos elementos personalizáveis

## 📄 Licença

MIT. Criado por **Harle**.
