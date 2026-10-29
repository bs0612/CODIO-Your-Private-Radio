import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the Media Session glue against a fake session: no browser needed.
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../app/media-session.ts", import.meta.url))], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
const media = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

class Metadata { constructor(init) { Object.assign(this, init); } }
function session() {
  const handlers = new Map(), positions = [];
  return {
    metadata: undefined, playbackState: "none", handlers, positions,
    setActionHandler(action, handler) { if (action === "seekforward") throw new TypeError("unsupported"); handlers.set(action, handler); },
    setPositionState(state) { positions.push(state); },
  };
}

test("track metadata reaches the OS with typed artwork, and clears without a track", () => {
  const s = session();
  assert.equal(media.applyMediaSessionMetadata(s, { title: "夜曲", artist: "周杰伦", album: "十一月的萧邦", artwork: "data:image/webp;base64,AAAA" }, Metadata), true);
  assert.equal(s.metadata.title, "夜曲");
  assert.deepEqual(s.metadata.artwork, [{ src: "data:image/webp;base64,AAAA", sizes: "300x300", type: "image/webp" }]);
  assert.deepEqual(media.mediaSessionArtwork("https://y.qq.com/cover.jpg?max_age=1"), [{ src: "https://y.qq.com/cover.jpg?max_age=1", sizes: "300x300", type: "image/jpeg" }]);
  assert.deepEqual(media.mediaSessionArtwork("/codio-icon"), [{ src: "/codio-icon", sizes: "300x300" }]);
  assert.deepEqual(media.mediaSessionArtwork(""), []);
  assert.equal(media.applyMediaSessionMetadata(s, null, Metadata), false);
  assert.equal(s.metadata, null);
  assert.equal(media.applyMediaSessionMetadata(undefined, { title: "x", artist: "y" }, Metadata), false, "no session is not an error");
});

test("playback and position state follow the player and never send invalid numbers", () => {
  const s = session();
  media.applyMediaSessionPlaybackState(s, true, true); assert.equal(s.playbackState, "playing");
  media.applyMediaSessionPlaybackState(s, false, true); assert.equal(s.playbackState, "paused");
  media.applyMediaSessionPlaybackState(s, true, false); assert.equal(s.playbackState, "none");
  assert.equal(media.applyMediaSessionPosition(s, 240, 12.5, 1), true);
  assert.deepEqual(s.positions.at(-1), { duration: 240, playbackRate: 1, position: 12.5 });
  assert.equal(media.applyMediaSessionPosition(s, 240, 300, 0), true, "position is clamped and a bad rate becomes 1");
  assert.deepEqual(s.positions.at(-1), { duration: 240, playbackRate: 1, position: 240 });
  assert.equal(media.applyMediaSessionPosition(s, Number.NaN, 3), false, "unknown duration resets the state");
  assert.equal(s.positions.at(-1), undefined);
  assert.equal(media.applyMediaSessionPosition(s, 0, 3), false);
});

test("media keys drive the transport, unsupported actions are skipped, and unbinding clears everything", () => {
  const s = session(), calls = [];
  const unbind = media.bindMediaSessionTransport(s, {
    play: () => calls.push("play"), pause: () => calls.push("pause"),
    previoustrack: () => calls.push("prev"), nexttrack: () => calls.push("next"),
    seekto: (seconds) => calls.push(`seekto:${seconds}`),
    seekbackward: (seconds) => calls.push(`back:${seconds}`),
    seekforward: (seconds) => calls.push(`forward:${seconds}`),
  });
  assert.deepEqual([...s.handlers.keys()], ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward"]);
  s.handlers.get("play")({}); s.handlers.get("nexttrack")({});
  s.handlers.get("seekto")({ seekTime: 42 }); s.handlers.get("seekto")({ seekTime: -1 });
  s.handlers.get("seekbackward")({}); s.handlers.get("seekbackward")({ seekOffset: 30 });
  assert.deepEqual(calls, ["play", "next", "seekto:42", `back:${media.MEDIA_SESSION_SEEK_SECONDS}`, "back:30"]);
  unbind();
  assert.ok([...s.handlers.values()].every((handler) => handler === null));
  assert.doesNotThrow(() => media.bindMediaSessionTransport({}, { play() {}, pause() {}, previoustrack() {}, nexttrack() {} })());
});
