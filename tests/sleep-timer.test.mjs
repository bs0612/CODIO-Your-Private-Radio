import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = await build({ entryPoints: [fileURLToPath(new URL("../app/sleep-timer.ts", import.meta.url))], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
const sleep = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

test("clock timers count down from the chosen minutes and reject nonsense", () => {
  const timer = sleep.createClockSleepTimer(30, 1_000_000);
  assert.equal(timer.kind, "clock");
  assert.equal(timer.endsAt, 1_000_000 + 30 * 60_000);
  assert.equal(sleep.sleepTimerRemaining(timer, 1_000_000 + 10 * 60_000), 20 * 60_000);
  assert.equal(sleep.sleepTimerRemaining(timer, timer.endsAt + 5000), 0, "never negative");
  assert.equal(sleep.createClockSleepTimer(0), null);
  assert.equal(sleep.createClockSleepTimer(Number.NaN), null);
  assert.equal(sleep.createClockSleepTimer(48 * 60), null);
  assert.equal(sleep.sleepTimerRemaining(null), null);
});

test("track-end timers fire only when a different song becomes current", () => {
  const timer = sleep.createTrackSleepTimer("song-a", 5);
  assert.equal(sleep.sleepTimerRemaining(timer), null, "no clock on a track timer");
  assert.equal(sleep.sleepTimerTrackChanged(timer, "song-a"), false);
  assert.equal(sleep.sleepTimerTrackChanged(timer, ""), false, "losing the track is not a change");
  assert.equal(sleep.sleepTimerTrackChanged(timer, "song-b"), true);
  assert.equal(sleep.sleepTimerTrackChanged(null, "song-b"), false);
  assert.equal(sleep.createTrackSleepTimer(""), null);
  assert.equal(sleep.describeSleepTimer(timer), "本曲结束后停止");
});

test("the fade is silent at zero, full outside the window and eases in between", () => {
  assert.equal(sleep.sleepFadeGain(0), 0);
  assert.equal(sleep.sleepFadeGain(-5), 0);
  assert.equal(sleep.sleepFadeGain(sleep.SLEEP_FADE_MS), 1);
  assert.equal(sleep.sleepFadeGain(sleep.SLEEP_FADE_MS * 3), 1);
  let previous = 0;
  for (let remaining = 0; remaining <= sleep.SLEEP_FADE_MS; remaining += 500) {
    const gain = sleep.sleepFadeGain(remaining);
    assert.ok(gain >= previous && gain <= 1, "monotonic");
    previous = gain;
  }
  assert.ok(Math.abs(sleep.sleepFadeGain(sleep.SLEEP_FADE_MS / 2) - .5) < 1e-9, "smoothstep midpoint");
});

test("remaining time reads like a clock", () => {
  assert.equal(sleep.formatSleepRemaining(0), "0:00");
  assert.equal(sleep.formatSleepRemaining(61_000), "1:01");
  assert.equal(sleep.formatSleepRemaining(29 * 60_000 + 400), "29:01", "rounds up so the display never shows 0:00 while running");
  assert.equal(sleep.formatSleepRemaining(90 * 60_000), "1:30:00");
  assert.equal(sleep.describeSleepTimer(sleep.createClockSleepTimer(15, 0), 60_000), "14:00 后停止");
  assert.equal(sleep.describeSleepTimer(null), "");
});
