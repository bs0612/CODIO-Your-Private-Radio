import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = await build({ entryPoints: [fileURLToPath(new URL("../app/keyboard-shortcuts.ts", import.meta.url))], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
const shortcuts = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

const key = (key, extra = {}) => ({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ...extra });

test("plain keys map to radio actions, in either letter case", () => {
  assert.equal(shortcuts.resolveShortcut(key("ArrowLeft")), "seek-backward");
  assert.equal(shortcuts.resolveShortcut(key("ArrowRight")), "seek-forward");
  assert.equal(shortcuts.resolveShortcut(key("ArrowUp")), "volume-up");
  assert.equal(shortcuts.resolveShortcut(key("ArrowDown")), "volume-down");
  assert.equal(shortcuts.resolveShortcut(key("n")), "next-track");
  assert.equal(shortcuts.resolveShortcut(key("N")), "next-track");
  assert.equal(shortcuts.resolveShortcut(key("p")), "previous-track");
  assert.equal(shortcuts.resolveShortcut(key("l")), "like");
  assert.equal(shortcuts.resolveShortcut(key("d")), "dislike");
  assert.equal(shortcuts.resolveShortcut(key("r")), "toggle-repeat");
  assert.equal(shortcuts.resolveShortcut(key("s")), "toggle-seamless");
  assert.equal(shortcuts.resolveShortcut(key("f")), "toggle-now-playing");
  assert.equal(shortcuts.resolveShortcut(key("/")), "focus-search");
  assert.equal(shortcuts.resolveShortcut(key("Escape")), "close");
  assert.equal(shortcuts.resolveShortcut(key("?", { shiftKey: true })), "toggle-help", "? arrives with shift held");
  assert.equal(shortcuts.resolveShortcut({ key: "/", code: "Slash", shiftKey: true }), "toggle-help", "synthetic shift+/ reports the unshifted key");
  assert.equal(shortcuts.resolveShortcut({ key: "/", code: "Slash" }), "focus-search");
});

test("space, browser chords and IME composition are left alone", () => {
  assert.equal(shortcuts.resolveShortcut({ key: " ", code: "Space" }), null, "space belongs to the dedicated play/pause listener");
  assert.equal(shortcuts.resolveShortcut(key("n", { ctrlKey: true })), null);
  assert.equal(shortcuts.resolveShortcut(key("n", { metaKey: true })), null);
  assert.equal(shortcuts.resolveShortcut(key("n", { altKey: true })), null);
  assert.equal(shortcuts.resolveShortcut(key("N", { shiftKey: true })), null, "shift+letter is reserved");
  assert.equal(shortcuts.resolveShortcut(key("n", { isComposing: true })), null);
  assert.equal(shortcuts.resolveShortcut(key("x")), null);
  assert.equal(shortcuts.resolveShortcut(key("Enter")), null);
});

test("typing targets are recognised through the same selector the player uses", () => {
  const inside = (selector) => ({ closest: (query) => query.includes(selector) ? {} : null });
  assert.equal(shortcuts.isTextEntryTarget(inside("textarea")), true);
  assert.equal(shortcuts.isTextEntryTarget(inside("input:not([type='range'])")), true);
  assert.equal(shortcuts.isTextEntryTarget({ closest: () => null }), false);
  assert.equal(shortcuts.isTextEntryTarget(null), false);
});

test("the on-screen guide documents every resolvable action plus play/pause", () => {
  const documented = new Set(shortcuts.SHORTCUT_GUIDE.map((item) => item.action));
  for (const action of ["toggle-playback", "seek-backward", "volume-up", "next-track", "like", "toggle-repeat", "toggle-seamless", "toggle-now-playing", "focus-search", "toggle-help", "close"])
    assert.ok(documented.has(action), `guide lists ${action}`);
  assert.ok(shortcuts.SHORTCUT_GUIDE.every((item) => item.keys.length > 0 && item.label));
  assert.ok(shortcuts.SHORTCUT_SEEK_SECONDS > 0 && shortcuts.SHORTCUT_VOLUME_STEP > 0);
});
