/**
 * A sound that can be "primed" synchronously inside a user gesture (click,
 * tap, submit) and played audibly later — even after an `await` — once
 * real business logic (a network call, a hash check) confirms it should
 * actually be heard.
 *
 * Why this exists: browsers require HTMLMediaElement.play() to happen
 * within the same synchronous tick as the user gesture that triggered it,
 * or they silently reject it with no visible error. But "should this
 * sound play" almost always depends on something async (did the login
 * succeed?) — by the time that's known, the gesture window has closed.
 *
 * The fix is the standard "unlock" pattern: call play() muted, synchronously,
 * at the very top of the handler (before any await) — this satisfies the
 * browser's gesture requirement and activates the element for the rest of
 * the call. Immediately pause and rewind it, so nothing audible happens
 * yet. Later, from anywhere — including after an await — call play() again
 * for real; because the element was already activated by the original
 * gesture, this second call is allowed to actually make sound.
 *
 * Usage:
 *   const chime = createPrimeableSound("/login-success.mp3");
 *   function onSubmit() {
 *     chime.prime();        // synchronous, top of handler, before any await
 *     const ok = await login();
 *     if (ok) chime.play(); // plays for real
 *   }
 */
export function createPrimeableSound(src: string) {
  let audio: HTMLAudioElement | null = null;

  function ensure(): HTMLAudioElement | null {
    if (typeof Audio === "undefined") return null;
    if (!audio) audio = new Audio(src);
    return audio;
  }

  function prime() {
    const el = ensure();
    if (!el) return;
    el.muted = true;
    el.play()
      .then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
      })
      .catch(() => {
        // Priming failed (rare) — unmute anyway so a later real play()
        // attempt isn't left silenced.
        el.muted = false;
      });
  }

  function play() {
    const el = ensure();
    if (!el) return;
    el.currentTime = 0;
    void el.play().catch((err) => {
      console.warn("Sound blocked:", src, err);
    });
  }

  return { prime, play };
}
