// Banco de rimas do modo Freestyle (português e inglês).
// Cada família termina com o mesmo som; "hard" = rima mais difícil de achar.

export const RHYMES = {
  pt: {
    easy: [
      ["coração", "visão", "missão", "pressão", "chão", "mão", "irmão", "razão", "ilusão", "canção", "emoção", "multidão", "solidão", "verão", "direção", "perdão"],
      ["lugar", "sonhar", "voar", "chegar", "lutar", "mar", "olhar", "brilhar", "ganhar", "cantar", "falar", "mudar", "acreditar", "conquistar"],
      ["passado", "lado", "cansado", "pecado", "guardado", "conquistado", "errado", "chegado", "marcado", "calado", "dobrado", "suado"],
      ["gente", "mente", "frente", "presente", "diferente", "quente", "semente", "corrente", "consciente", "valente", "repente", "urgente"],
      ["dia", "poesia", "alegria", "energia", "magia", "sintonia", "fantasia", "harmonia", "melodia", "rebeldia", "agonia", "maestria"],
      ["vida", "ferida", "saída", "batida", "partida", "corrida", "medida", "querida", "perdida", "subida", "esquecida", "comprida"],
      ["amor", "dor", "flor", "valor", "calor", "cor", "rancor", "sabor", "temor", "favor", "suor", "vencedor"],
      ["momento", "vento", "talento", "pensamento", "sentimento", "movimento", "cimento", "lamento", "tormento", "argumento", "alimento"],
      ["verdade", "saudade", "cidade", "liberdade", "vontade", "metade", "realidade", "maldade", "idade", "humildade", "lealdade"],
      ["loucura", "altura", "cultura", "pintura", "aventura", "procura", "ternura", "armadura", "estrutura", "postura"],
      ["céu", "meu", "seu", "véu", "chapéu", "réu", "troféu", "breu", "judeu", "plebeu"],
      ["fama", "cama", "chama", "drama", "lama", "grama", "trama", "programa", "clama", "reclama"],
      ["escola", "bola", "gaiola", "sacola", "cola", "esmola", "viola", "rola", "consola", "decola"],
      ["vez", "mês", "três", "freguês", "talvez", "português", "xadrez", "fez", "cortês"],
    ],
    hard: [
      ["negócio", "sócio", "ócio", "consórcio"],
      ["espaço", "abraço", "compasso", "aço", "laço", "cansaço", "fracasso", "palhaço", "traço", "passo", "embaraço", "ameaço"],
      ["resto", "gesto", "protesto", "manifesto", "honesto", "modesto", "funesto", "pretexto", "contexto"],
      ["amigo", "perigo", "abrigo", "castigo", "comigo", "contigo", "inimigo", "antigo", "umbigo", "trigo"],
      ["pulso", "impulso", "expulso", "convulso"],
      ["abismo", "egoísmo", "cinismo", "heroísmo", "realismo", "otimismo", "batismo", "racismo", "sismo"],
      ["sonho", "medonho", "risonho", "tristonho", "bisonho", "enfadonho", "proponho", "disponho"],
      ["risco", "petisco", "disco", "cisco", "arisco", "confisco", "asterisco", "corisco"],
      ["derrota", "rota", "nota", "gota", "bota", "frota", "idiota", "cota", "lorota"],
      ["fuga", "ruga", "tartaruga", "sanguessuga", "enxuga", "madruga"],
            ["estrela", "janela", "favela", "panela", "sequela", "querela", "aquarela", "cautela"],
      ["química", "polêmica", "acadêmica", "epidêmica", "endêmica"],
    ],
    themes: ["Sua quebrada", "Dinheiro", "Superação", "Amor", "A noite", "Futebol", "Videogame", "Escola", "Família", "Sonhos", "A cidade", "Festa", "O futuro", "Fé", "Liberdade", "Os haters", "Primeiro show", "Madrugada", "Calor de 40 graus", "Ônibus lotado"],
  },
  en: {
    easy: [
      ["night", "light", "fight", "right", "sight", "bright", "flight", "tight", "height", "might", "white", "write"],
      ["day", "way", "play", "stay", "say", "pay", "okay", "away", "gray", "today", "display", "delay"],
      ["game", "fame", "name", "same", "flame", "shame", "claim", "frame", "aim", "blame"],
      ["flow", "show", "know", "go", "slow", "glow", "grow", "below", "throw", "though"],
      ["king", "ring", "sing", "thing", "bring", "wing", "swing", "sting", "spring", "string"],
      ["beat", "heat", "street", "feet", "seat", "sweet", "complete", "defeat", "repeat", "elite"],
      ["pain", "rain", "chain", "brain", "gain", "train", "main", "lane", "plane", "insane"],
      ["gold", "cold", "bold", "told", "hold", "sold", "fold", "controlled", "untold", "old"],
      ["more", "floor", "door", "war", "core", "score", "store", "before", "explore", "ignore"],
      ["head", "said", "red", "dead", "bread", "spread", "instead", "thread", "ahead", "led"],
      ["dream", "team", "stream", "scream", "beam", "cream", "extreme", "supreme", "theme", "seem"],
      ["time", "rhyme", "climb", "crime", "prime", "dime", "grime", "lime", "chime", "sublime"],
    ],
    hard: [
      ["vision", "decision", "mission", "precision", "division", "collision", "position", "ambition"],
      ["velocity", "ferocity", "atrocity", "reciprocity", "pomposity"],
      ["eternal", "internal", "infernal", "journal", "external", "nocturnal"],
      ["situation", "graduation", "evaluation", "fluctuation", "motivation", "dedication", "nation"],
      ["technology", "apology", "psychology", "biology", "mythology", "astrology"],
      ["perspective", "objective", "detective", "collective", "effective", "selective", "reflective"],
      ["mystic", "ballistic", "statistic", "realistic", "holistic", "futuristic", "artistic", "simplistic"],
      ["surrender", "pretender", "contender", "defender", "offender", "lender", "sender"],
      ["phenomenal", "abdominal", "nominal", "criminal", "minimal", "subliminal"],
      ["catastrophe", "philosophy", "trophy", "atrophy"],
    ],
    themes: ["Your city", "Money", "The come up", "Love", "Late nights", "Sports", "Video games", "School", "Family", "Dreams", "The future", "Faith", "Freedom", "Haters", "The party", "First show", "Rainy day", "The grind", "Old friends", "Summer"],
  },
};

/** Gerador de números "aleatórios" que dá pra repetir (pros testes). */
export function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Sorteia palavras sem repetir as últimas. level: "easy" | "hard" | "mix".
 * Devolve { next(): { word, family } }.
 */
export function createPicker(lang = "pt", level = "easy", rand = Math.random) {
  const bank = RHYMES[lang] || RHYMES.pt;
  const fams = level === "hard" ? bank.hard : level === "mix" ? [...bank.easy, ...bank.hard] : bank.easy;
  const recent = [];
  let lastFam = -1;
  return {
    next() {
      let fi, word, tries = 0;
      do {
        fi = Math.floor(rand() * fams.length);
        const f = fams[fi];
        word = f[Math.floor(rand() * f.length)];
        tries++;
      } while ((recent.includes(word) || fi === lastFam) && tries < 40);
      recent.push(word);
      if (recent.length > 12) recent.shift();
      lastFam = fi;
      return { word, family: fams[fi] };
    },
  };
}

export function pickTheme(lang = "pt", rand = Math.random, avoid = "") {
  const t = (RHYMES[lang] || RHYMES.pt).themes;
  let x;
  do x = t[Math.floor(rand() * t.length)];
  while (x === avoid && t.length > 1);
  return x;
}
