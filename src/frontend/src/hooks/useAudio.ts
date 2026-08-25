import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "audioEnabled";

function createAudioContext(): AudioContext | null {
  try {
    return new AudioContext();
  } catch {
    return null;
  }
}

function playTone(
  ctx: AudioContext,
  frequency: number,
  duration: number,
  type: OscillatorType = "sine",
  gainVal = 0.15,
) {
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();
  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
  gainNode.gain.setValueAtTime(gainVal, ctx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + duration);
}

export interface AudioHook {
  audioEnabled: boolean;
  toggleAudio: () => void;
  playNewBid: () => void;
  playLeading: () => void;
  playExpired: () => void;
}

export function useAudio(): AudioHook {
  const [audioEnabled, setAudioEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });

  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(audioEnabled));
    } catch {
      // ignore
    }
  }, [audioEnabled]);

  const getCtx = useCallback((): AudioContext | null => {
    if (!ctxRef.current) {
      ctxRef.current = createAudioContext();
    }
    if (ctxRef.current?.state === "suspended") {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  const canPlay = useCallback((): boolean => {
    if (!audioEnabled) return false;
    if (document.hidden) return false;
    return true;
  }, [audioEnabled]);

  const toggleAudio = useCallback(() => {
    setAudioEnabled((prev) => !prev);
  }, []);

  // Short beep on new bid
  const playNewBid = useCallback(() => {
    if (!canPlay()) return;
    const ctx = getCtx();
    if (!ctx) return;
    playTone(ctx, 880, 0.12, "square", 0.08);
  }, [canPlay, getCtx]);

  // Ascending chime when current user becomes leader
  const playLeading = useCallback(() => {
    if (!canPlay()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      setTimeout(() => {
        if (!canPlay()) return;
        playTone(ctx, freq, 0.18, "sine", 0.12);
      }, i * 80);
    });
  }, [canPlay, getCtx]);

  // Descending tone on nomination expire
  const playExpired = useCallback(() => {
    if (!canPlay()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const notes = [523, 392, 330, 262];
    notes.forEach((freq, i) => {
      setTimeout(() => {
        if (!canPlay()) return;
        playTone(ctx, freq, 0.25, "sawtooth", 0.1);
      }, i * 100);
    });
  }, [canPlay, getCtx]);

  return { audioEnabled, toggleAudio, playNewBid, playLeading, playExpired };
}
