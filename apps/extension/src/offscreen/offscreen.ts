/**
 * Offscreen document for playing audio (beep alert).
 *
 * Service workers cannot use AudioContext, so we create this offscreen
 * document from the background and send it a message to play the beep.
 */

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "PLAY_BEEP") {
    playBeep();
  }
});

function playBeep(): void {
  try {
    const ctx = new AudioContext();
    const beepCount = 9; // 3 sequences × 3 notes
    const beepDuration = 0.12;
    const beepGap = 0.1;
    const sequenceGap = 0.18;
    const frequencies = [1046, 1318, 1568]; // C6, E6, G6

    for (let i = 0; i < beepCount; i++) {
      const seqIndex = Math.floor(i / 3);
      const start =
        ctx.currentTime + i * (beepDuration + beepGap) + seqIndex * sequenceGap;
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(frequencies[i % 3]!, start);
      gainNode.gain.setValueAtTime(0, start);
      gainNode.gain.linearRampToValueAtTime(0.25, start + 0.01);
      gainNode.gain.setValueAtTime(0.25, start + beepDuration - 0.02);
      gainNode.gain.linearRampToValueAtTime(0, start + beepDuration);
      oscillator.start(start);
      oscillator.stop(start + beepDuration);
    }

    // Close context after all beeps finish
    const totalDuration =
      beepCount * (beepDuration + beepGap) + 2 * sequenceGap;
    setTimeout(() => void ctx.close(), totalDuration * 1000 + 200);
  } catch (e) {
    console.warn("[Offscreen] Could not play beep:", e);
  }
}
