// Karaokê: microfone nos fones (com eco e reverb), mixado com o instrumental,
// e gravação das duas coisas juntas. Usa o mesmo AudioContext do player.

/** Resposta de impulso "de sala" gerada na hora (ruído que vai sumindo). */
export function makeImpulse(ctx, seconds = 2.2, decay = 3) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export function createKaraoke(getGraph) {
  let g = null; // { ctx, out }
  let stream = null, micSrc = null;
  let micGain, echoWet, echoDelay, echoFb, revWet, bus, recDest, recorder, chunks = [];
  const levels = { mic: 0.9, echo: 0.2, reverb: 0.35 };

  function build() {
    if (bus) return true;
    g = getGraph();
    if (!g) return false;
    const { ctx } = g;
    micGain = ctx.createGain();
    bus = ctx.createGain();
    // eco: atraso com realimentação
    echoDelay = ctx.createDelay(1);
    echoDelay.delayTime.value = 0.28;
    echoFb = ctx.createGain();
    echoFb.gain.value = 0.32;
    echoWet = ctx.createGain();
    micGain.connect(echoDelay);
    echoDelay.connect(echoFb);
    echoFb.connect(echoDelay);
    echoDelay.connect(echoWet);
    echoWet.connect(bus);
    // reverb
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx);
    revWet = ctx.createGain();
    micGain.connect(conv);
    conv.connect(revWet);
    revWet.connect(bus);
    // voz "seca"
    micGain.connect(bus);
    bus.connect(ctx.destination);
    apply();
    return true;
  }

  function apply() {
    if (!bus) return;
    micGain.gain.value = levels.mic * 1.4;
    echoWet.gain.value = levels.echo * 0.9;
    revWet.gain.value = levels.reverb * 1.2;
  }

  return {
    get micOn() {
      return !!stream;
    },
    get recording() {
      return recorder?.state === "recording";
    },
    levels,
    set(key, value) {
      levels[key] = value;
      apply();
    },
    async micStart() {
      if (stream) return;
      if (!build()) throw new Error("O player não está pronto");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 },
      });
      micSrc = g.ctx.createMediaStreamSource(stream);
      micSrc.connect(micGain);
      await g.ctx.resume();
    },
    micStop() {
      micSrc?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      stream = micSrc = null;
    },
    /** Grava a música (do jeito que sai) + a sua voz com efeitos. */
    recStart() {
      if (!build()) throw new Error("O player não está pronto");
      recDest = recDest || g.ctx.createMediaStreamDestination();
      g.out.connect(recDest);
      bus.connect(recDest);
      chunks = [];
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
      recorder = new MediaRecorder(recDest.stream, type ? { mimeType: type } : undefined);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(1000);
    },
    recStop() {
      return new Promise((resolve) => {
        if (!recorder || recorder.state !== "recording") return resolve(null);
        recorder.onstop = () => {
          try { g.out.disconnect(recDest); } catch {}
          try { bus.disconnect(recDest); } catch {}
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        };
        recorder.stop();
      });
    },
  };
}
