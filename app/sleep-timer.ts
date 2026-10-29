// Sleep timer: stop the radio after a chosen time or at the end of the current
// song, fading the last seconds instead of cutting the music.

export const SLEEP_TIMER_MINUTES = [15, 30, 45, 60, 90] as const;
export const SLEEP_FADE_MS = 20_000;

export type SleepTimer =
  | { kind: "clock"; minutes: number; startedAt: number; endsAt: number }
  | { kind: "track"; trackKey: string; armedAt: number };

export function createClockSleepTimer(minutes: number, now = Date.now()): SleepTimer | null {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) return null;
  return { kind: "clock", minutes, startedAt: now, endsAt: now + minutes * 60_000 };
}

export function createTrackSleepTimer(trackKey: string, now = Date.now()): SleepTimer | null {
  if (!trackKey) return null;
  return { kind: "track", trackKey, armedAt: now };
}

/** Milliseconds left on a clock timer; null for a track-end timer. */
export function sleepTimerRemaining(timer: SleepTimer | null, now = Date.now()) {
  if (!timer || timer.kind !== "clock") return null;
  return Math.max(0, timer.endsAt - now);
}

/** Gain the music should sit at with `remaining` milliseconds left: 1 until the fade window, then down to 0. */
export function sleepFadeGain(remaining: number, fadeMs = SLEEP_FADE_MS) {
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  if (remaining >= fadeMs) return 1;
  const amount = remaining / fadeMs;
  return amount * amount * (3 - 2 * amount);
}

export function formatSleepRemaining(remaining: number) {
  const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function describeSleepTimer(timer: SleepTimer | null, now = Date.now()) {
  if (!timer) return "";
  if (timer.kind === "track") return "本曲结束后停止";
  return `${formatSleepRemaining(sleepTimerRemaining(timer, now) || 0)} 后停止`;
}

/** A track-end timer fires when a different song becomes current. */
export function sleepTimerTrackChanged(timer: SleepTimer | null, currentTrackKey: string) {
  return Boolean(timer && timer.kind === "track" && currentTrackKey && currentTrackKey !== timer.trackKey);
}
