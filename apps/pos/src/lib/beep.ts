let ctx: AudioContext | null = null;

/** Bip court (Web Audio) : retour sonore d'un scan refusé ou inconnu. Silencieux si indisponible. */
export function beep(kind: 'error' | 'ok' = 'error'): void {
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = kind === 'error' ? 220 : 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    const now = ctx.currentTime;
    osc.start(now);
    osc.stop(now + (kind === 'error' ? 0.25 : 0.08));
  } catch {
    // audio indisponible (politique d'autoplay, navigateur) : ignoré
  }
}
