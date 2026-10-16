// Efeitos que reagem à música: partículas no fundo (dançam no grave),
// ondas nas batidas e, no drop, a tela pisca, treme e a capa "explode".

export function createFx(canvas, { getAccent }) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  const ambient = [];
  const burst = [];
  const rings = [];
  let level = 0;
  let running = false;
  let raf = 0;
  let last = 0;

  function fit() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", fit);

  function seedAmbient(n = 70) {
    ambient.length = 0;
    for (let i = 0; i < n; i++) {
      ambient.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 0.6 + Math.random() * 2.2,
        vy: 6 + Math.random() * 18,
        vx: (Math.random() - 0.5) * 6,
        a: 0.15 + Math.random() * 0.45,
        ph: Math.random() * 6.28,
      });
    }
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    ctx.clearRect(0, 0, W, H);
    const [r, g, b] = getAccent();
    ctx.globalCompositeOperation = "lighter";

    // partículas de fundo: sobem devagar e "acendem" com o grave
    for (const p of ambient) {
      p.y -= p.vy * dt * (1 + level * 4);
      p.x += (p.vx + Math.sin(t / 900 + p.ph) * 8) * dt;
      if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
      const rr = p.r * (1 + level * 1.8);
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, p.a * (0.5 + level * 1.4))})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, 6.283);
      ctx.fill();
    }

    // ondas das batidas
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.life -= dt;
      if (ring.life <= 0) { rings.splice(i, 1); continue; }
      const k = 1 - ring.life / ring.max;
      ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - k) * ring.a})`;
      ctx.lineWidth = 2 + (1 - k) * 4;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.r0 + k * ring.grow, 0, 6.283);
      ctx.stroke();
    }

    // estilhaços do drop
    for (let i = burst.length - 1; i >= 0; i--) {
      const p = burst[i];
      p.life -= dt;
      if (p.life <= 0) { burst.splice(i, 1); continue; }
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 160 * dt; // gravidade
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      ctx.fillStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${k})`;
      ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s * (0.5 + k), p.s * (0.5 + k));
    }
    ctx.globalCompositeOperation = "source-over";

    if (!burst.length && !rings.length && level < 0.01 && !running) cancelAnimationFrame(raf);
  }

  return {
    start() {
      if (running) return;
      running = true;
      fit();
      if (!ambient.length) seedAmbient();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, W, H);
    },
    setLevel(v) {
      level = v;
    },
    /** Onda saindo de um ponto (centro da capa). */
    beat(x, y, strength = 1) {
      if (!running || rings.length > 6) return;
      rings.push({ x, y, r0: 40, grow: 260 + strength * 200, life: 0.9, max: 0.9, a: 0.55 * strength });
    },
    /** A capa explode em pedacinhos com as cores dela. */
    explode(x, y, colors) {
      if (!running) return;
      const cs = colors?.length ? colors : [getAccent()];
      for (let i = 0; i < 280; i++) {
        const ang = Math.random() * 6.283;
        const sp = 220 + Math.random() * 760;
        const life = 0.9 + Math.random() * 1.1;
        burst.push({
          x: x + (Math.random() - 0.5) * 120,
          y: y + (Math.random() - 0.5) * 120,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 120,
          s: 2 + Math.random() * 6,
          c: cs[(Math.random() * cs.length) | 0],
          life,
          max: life,
        });
      }
      for (let k = 0; k < 3; k++) rings.push({ x, y, r0: 60 + k * 30, grow: 900, life: 1.1 + k * 0.2, max: 1.1 + k * 0.2, a: 0.9 });
    },
  };
}

/** Cores de uma imagem (pra explosão ter as cores da capa). */
export function paletteOf(img, n = 8) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0, 16, 16);
    const d = x.getImageData(0, 0, 16, 16).data;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = ((Math.random() * 256) | 0) * 4;
      out.push([d[p], d[p + 1], d[p + 2]].map((v) => Math.min(255, v + 40)));
    }
    return out;
  } catch {
    return null; // imagem de outro site ("canvas sujo"): usa a cor de destaque
  }
}
