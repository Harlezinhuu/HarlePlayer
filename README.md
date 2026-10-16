<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Harle Player" />

# Harle Player

**Um player de música estético pro desktop.**
Funciona com Spotify, YouTube Music, SoundCloud, Apple Music, Deezer e o que mais estiver tocando no seu PC.

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust)
![JavaScript](https://img.shields.io/badge/JS-sem%20framework-F7DF1E?logo=javascript&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows)
[![Build](https://github.com/Harlezinhuu/HarlePlayer/actions/workflows/build.yml/badge.svg)](https://github.com/Harlezinhuu/HarlePlayer/actions/workflows/build.yml)
[![Busca ao vivo](https://github.com/Harlezinhuu/HarlePlayer/actions/workflows/search-check.yml/badge.svg)](https://github.com/Harlezinhuu/HarlePlayer/actions/workflows/search-check.yml)

<img src="docs/screenshot.jpg" alt="Harle Player tocando, com relógio, carrossel de capas e letra sincronizada" />

</div>

## ✨ O que ele faz

### 🎧 Ouvir
- **Funciona com qualquer app de música.** Lê o que está tocando pelo sistema de mídia do Windows, sem login e sem chave de API. O Spotify continua tocando no próprio Spotify (contando pro Wrapped), e o Harle Player só mostra e controla.
- **Toca SoundCloud e YouTube Music dentro do app**, sem abrir navegador. O áudio do SoundCloud é baixado e tocado aqui. O YouTube toca pelo player oficial, escondido, e se o vídeo bloquear, o áudio vem pelo [yt-dlp](https://github.com/yt-dlp/yt-dlp), baixado e atualizado sozinho.
- **Fila no estilo Spotify**: *Tocar a seguir* e *Adicionar à fila* pelo menu **⋯** ou pelo clique direito, arrastar pra reordenar, embaralhar, repetir (a fila ou uma música) e limpar.
- **Playlists**: crie, renomeie, reordene e toque em ordem ou embaralhado, com músicas do SoundCloud e do YouTube Music.
- **Importar playlist pelo link** (ou colando o link na busca): **Spotify**, **SoundCloud** e **YouTube / YouTube Music**, sem login. As do Spotify abrem no app do Spotify com um clique, então **contam pro Wrapped**. As do SoundCloud e do YouTube tocam aqui dentro.
- **Equalizador de 10 faixas** no player interno, com presets (Grave+, Vocal, Rock, Eletrônica…) ou do seu jeito.
- **Volume**: do player interno, ou só do app que está tocando (o Spotify, por exemplo), pelo mixer do Windows, sem mexer no volume do PC inteiro.
- **Aleatório e repetir** na barra, igual o Spotify: no player interno e também no app de origem, quando ele deixa (o Windows avisa se o app aceita).
- Teclas de mídia, tocar/pausar, próxima, anterior e barra de progresso clicável.

- **Karaokê com a sua voz**: tira a voz da música (no player interno), deixa a letra grande na tela e liga o **microfone nos seus fones**, com eco e reverb de palco. Dá pra **gravar** e salvar a apresentação.
- **DJ com voz**: entre as músicas, uma voz em português anuncia o que vai tocar, tipo rádio, usando a sua retrospectiva ("essa é a 5ª vez que você ouve essa essa semana").

- **Ouvir junto**: crie uma sala, mande o código e o que você tocar toca no app dos seus amigos, no mesmo segundo (pausa, pula e volta junto). Cada um ouve no próprio PC, pelo Harle Player ou abrindo no próprio Spotify. Tem reações com emoji na tela de todo mundo e pedidos de música. As mensagens passam pelo [ntfy.sh](https://ntfy.sh), **criptografadas** (AES-GCM) com uma chave que só existe no código de convite.

### 🔎 Buscar
- **Busca direto no SoundCloud e no YouTube Music**, inclusive faixas que só existem no SoundCloud (remix, unreleased…).
- **Abas Tudo · Músicas · Artistas**: os principais resultados e a lista completa, que carrega mais conforme você rola. Clicou numa música, ela toca e o resto da lista vira a fila.
- Pros outros serviços, ou se a busca do site falhar, os resultados vêm do Deezer.

### 📊 Sua retrospectiva
- **Seu "Wrapped" particular**, de qualquer app (Spotify, SoundCloud, YouTube…): minutos ouvidos, top músicas e artistas, onde você mais ouve e seu horário favorito, em 7 dias, 30 dias, no ano ou desde o começo.
- **Gera uma imagem pros stories** (1080×1920) pra salvar ou copiar e postar. Tudo fica salvo só no seu PC.
- **Retrospectiva em vídeo**: 22 segundos animados, no formato dos stories, com números subindo, seu artista nº 1 e o top 5, tocando um trecho da sua música mais ouvida.

<img src="docs/wrapped.jpg" alt="Retrospectiva com top músicas, artistas, serviços e horário" />

### 🎨 Visual
- **Temas**: layout clássico ou espelhado, cor de destaque da capa ou fixa (qualquer cor), fonte e tamanho da letra e fundo mais escuro.
- **Relógio gigante** em três estilos: Sólido, Fino e Contorno.
- **Letra sincronizada** via [LRCLIB](https://lrclib.net): o verso inteiro com as palavras acendendo no estilo karaokê, ou em pedaços grandes animados.
- **Clipe no fundo**: o clipe oficial da música que está tocando (até no Spotify) aparece no fundo, mudo e sincronizado com a música.
- **Partículas e drop**: partículas dançam no grave e, quando a música "dropa", a tela pisca, treme e a capa explode em pedaços.
- **Reage ao som**: o fundo, o brilho do relógio e a capa pulsam com o grave da música que está tocando, de qualquer app (inclusive no wallpaper).
- **Mini player**: uma janelinha sempre por cima de tudo, no canto da tela, com capa e controles. Abre sozinho quando você minimiza o app com música tocando e some quando você volta. É só arrastar pra onde quiser.
- **Tela cheia** (`F11`): os controles somem sozinhos e fica só o relógio, a capa e a letra, tipo tela de descanso.
- **Carrossel 3D de capas** com o que você ouviu por último. Dá pra girar com a roda do mouse ou com as setas ← →.
- **Fundo dinâmico** feito com a capa da música. A cor de destaque do app também muda conforme a capa.
- **Wallpaper animado atrás dos ícones**, no estilo Wallpaper Engine, com relógio, letra e música tocando direto na área de trabalho.
- **Biblioteca de wallpapers**: vídeo (mp4/webm), GIF ou imagem, mais o **Aurora**, um fundo animado embutido que muda de cor conforme a capa.

### 🔌 Integrações
- **Atalhos globais** que funcionam até dentro de jogo: `Ctrl+Alt+Espaço` (tocar/pausar), `Ctrl+Alt+→/←` (próxima/anterior), `Ctrl+Alt+↑/↓` (volume) e `Ctrl+Alt+M` (mini player).
- **Abaixa a música quando alguém fala no Discord**: o app lê o volume do Discord no mixer do Windows e abaixa a música (até a do Spotify) enquanto o pessoal fala na call, voltando quando param.
- **Letra flutuante** (`Ctrl+Alt+L`): a letra aparece como legenda na parte de baixo da tela, por cima de qualquer coisa, sem atrapalhar o clique.
- **Aviso de música nova**: um cartão aparece no canto da tela quando a música troca (e no volume pelo atalho), sem roubar o foco do jogo.
- **Discord Rich Presence**: "Ouvindo SoundCloud" (ou YouTube Music, YouTube…) no seu perfil, com capa, artista, barra de tempo e botão "Ouvir no …". Detecta sozinho onde a música está tocando, até no navegador.
- **Controle pelo celular**: liga nas configurações, aponta a câmera pro QR code e o celular vira um controle (tocar, pular, volume, letra rolando, fila e busca), sem instalar nada. Funciona em Android e iPhone, na mesma rede Wi-Fi. O acesso é protegido por um código que só o QR tem.
- **Se atualiza sozinho**: avisa quando sai versão nova nas Releases, baixa, instala e abre de novo com um clique.
- Fica na **bandeja do sistema** quando você fecha.

<img src="docs/search.jpg" alt="Busca completa: lista de músicas com a fila ao lado" />

<img src="docs/wallpaper.jpg" alt="Modo wallpaper: relógio, letra e música tocando na área de trabalho" />

## ⌨️ Atalhos

| Tecla | Ação |
|---|---|
| `Espaço` | Tocar / pausar |
| `/` ou `Ctrl+K` | Pesquisar |
| `←` `→` | Girar o carrossel |
| `Ctrl+Alt+Espaço` / `→` / `←` / `↑` / `↓` / `M` / `L` | Atalhos globais: tocar/pausar, próxima, anterior, volume, mini player, letra flutuante |
| `F11` (ou duplo clique no topo) | Tela cheia: depois de 3 s parado, sobra só relógio, capa e letra |
| `Esc` | Fechar busca / configurações / sair da tela cheia |
| Clique direito numa música | Tocar a seguir, adicionar à fila ou a uma playlist |
| Roda do mouse no 🔊 | Ajustar o volume |

## 📥 Baixar

Vá em [**Releases**](https://github.com/Harlezinhuu/HarlePlayer/releases) e baixe o `Harle.Player_x.x.x_x64-setup.exe`. Depois de instalado, as versões novas chegam sozinhas pelo próprio app.

## 🎮 Configurando o Discord

O Discord mostra o **nome do app** no perfil. Por isso dá pra ter um app pra cada serviço, e o perfil fica "Ouvindo **SoundCloud**", "Ouvindo **YouTube Music**" e assim por diante.

1. Entre em [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → dê o nome que deve aparecer (ex.: `SoundCloud`).
2. Copie o **Application ID** e cole no serviço certo em [`src-tauri/discord-apps.json`](src-tauri/discord-apps.json). Se quiser um app só pra tudo, use o `default`.
3. (Opcional) Em **Rich Presence → Art Assets**, suba:
   - `logo`: imagem usada quando a música não tem capa;
   - um ícone com o nome do serviço (`soundcloud`, `ytmusic`, `youtube`…), que aparece pequeno no canto da capa.
4. Compile de novo. Os IDs vão embutidos no app, então quem baixar a Release já recebe tudo pronto.

A capa vem do Deezer (o Discord só aceita imagem por link). Se a música não existir lá, aparece o `logo`.

**Como ele sabe onde está tocando:** apps de desktop (Spotify, YouTube Music Desktop, Apple Music…) se identificam sozinhos. No navegador, ele procura o nome do site nos títulos das janelas abertas. Se não achar, usa a opção *"Música tocando no navegador conta como"* das configurações.

## 🛠️ Rodando o código

Pré-requisitos: [Node.js](https://nodejs.org), [Rust](https://rustup.rs) e o [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (já vem no Windows 10/11).

```bash
npm install
npm run dev      # abre o app em modo desenvolvimento
npm run build    # gera o instalador em src-tauri/target/release/bundle/nsis
```

Pra mexer só no visual, sem compilar nada, use `npm run demo`.

### Testes

```bash
npm test                                              # front: fila, letra, títulos, cores…
cargo test --manifest-path src-tauri/Cargo.toml       # Rust: Discord, detecção, leitura das buscas
cargo test --manifest-path src-tauri/Cargo.toml ao_vivo -- --ignored --nocapture   # busca de verdade
```

O GitHub Actions roda tudo a cada push e gera o instalador. A busca ao vivo também roda todo dia, pra avisar se o SoundCloud ou o YouTube Music mudarem alguma coisa.

O `npm run demo` abre o front no navegador com músicas, letra e busca de exemplo.

## 🧩 Como funciona

```
┌──────────── Front (src/) ────────────┐        ┌──────────────── Rust (src-tauri/src/) ────────────────┐
│ HTML + CSS + JS puro, sem build      │        │ media.rs     SMTC do Windows: o que toca + controles  │
│ app.js     tela, busca, painel       │        │ detect.rs    qual serviço (app ou aba do navegador)   │
│ player.js  player interno + YouTube  │◀──IPC─▶│ search.rs    SoundCloud · YouTube Music · clipes      │
│ queue.js   fila (funções puras)      │        │ net.rs       LRCLIB (letras) e Deezer                 │
│ stats.js   retrospectiva (puras)     │        │ party.rs     salas de ouvir junto (ntfy.sh)           │
│ lib.js     letra, cores, títulos     │        │ ytdlp.rs     reserva do YouTube                       │
│ party.js   ouvir junto (AES-GCM)     │        │ volume.rs    volume por app (WASAPI)                  │
│ drops.js   detector de drop          │        │ visualizer.rs graves do som do PC (WASAPI)            │
│ fx.js      partículas e explosão     │        │ ducking.rs   voz no Discord → abaixar a música        │
│ wrappedVideo.js vídeo dos stories    │        │ discord.rs   Rich Presence (named pipe)               │
│ karaoke.js microfone, efeitos, gravar│        │ wallpaper.rs janela na camada WorkerW                 │
│ mini.js    mini player               │        │ mini.rs      janelinha sempre por cima                │
│ remote.html controle pelo celular    │        │ overlay.rs   letra flutuante por cima de tudo         │
│ qr.js      QR code (sem biblioteca)  │        │ notify.rs    aviso no canto sem roubar o foco         │
└──────────────────────────────────────┘        │ hotkeys.rs   atalhos globais (RegisterHotKey)         │
                                                │ remote.rs    servidor HTTP na rede local (celular)    │
                                                │ updater.rs   Releases do GitHub → instala e reabre    │
                                                └───────────────────────────────────────────────────────┘
```

O modo wallpaper usa o mesmo truque do Wallpaper Engine e do Lively: o Explorer cria uma camada chamada **WorkerW** entre o papel de parede e os ícones, e o app pendura uma segunda janela nela. 

A busca do SoundCloud usa a `api-v2` com o `client_id` público que o próprio site carrega. A do YouTube Music usa a API interna `youtubei/v1/search`, a mesma usada pela [ytmusicapi](https://github.com/sigma67/ytmusicapi). Nenhuma das duas é oficial: se o site mudar, o app mostra um aviso e cai pro Deezer.

A posição da música é medida pelo app de origem e interpolada no front a cada frame. No modo karaokê, o tempo de cada verso da letra (LRC) é distribuído entre as palavras pelo tamanho delas.

A fila guarda quais músicas foram adicionadas por você: elas entram logo depois da atual, antes do resto (resultados da busca ou playlist), igual no Spotify. Música salva só com nome (vinda do Deezer, por exemplo) é procurada no SoundCloud/YouTube na hora de tocar.

## 🗺️ Próximos passos

- [ ] Iniciar junto com o Windows
- [ ] Wallpaper em vários monitores
- [ ] Wallpapers que reagem ao som (visualizador)
- [ ] Temas e posição dos elementos personalizáveis
- [ ] Suporte a macOS

## 📄 Licença

**Todos os direitos reservados.** O código está aberto só para visualização e estudo: não é permitido copiar, modificar ou reutilizar sem autorização. Usar o app pelas [Releases](../../releases) é livre. Detalhes em [LICENSE](LICENSE).

Criado por **Harle**.
