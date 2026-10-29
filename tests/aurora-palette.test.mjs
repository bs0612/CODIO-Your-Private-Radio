import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The aurora reads scene colours from CSS custom properties; parse every form
// the stylesheet uses. The WebGL renderer itself needs a GPU and is not run here.
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../app/aurora-gl.ts", import.meta.url))], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
const aurora = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

const near = (actual, expected) => actual.every((channel, index) => Math.abs(channel - expected[index]) < 1e-6);

test("hex, rgb() and bare channel lists become unit floats", () => {
  assert.ok(near(aurora.parseCssColor("#7781c7", [0, 0, 0]), [0x77 / 255, 0x81 / 255, 0xc7 / 255]));
  assert.ok(near(aurora.parseCssColor(" #FFF ", [0, 0, 0]), [1, 1, 1]));
  assert.ok(near(aurora.parseCssColor("rgb(185, 201, 255)", [0, 0, 0]), [185 / 255, 201 / 255, 1]));
  assert.ok(near(aurora.parseCssColor("rgba(10 20 30 / .5)", [0, 0, 0]), [10 / 255, 20 / 255, 30 / 255]));
  assert.ok(near(aurora.parseCssColor("185, 201, 255", [0, 0, 0]), [185 / 255, 201 / 255, 1]));
});

test("anything unreadable falls back to the scene default", () => {
  for (const value of ["", undefined, null, "transparent", "#12", "rgb(300, 0, 0)", "var(--scene-a)"])
    assert.deepEqual(aurora.parseCssColor(value, [.1, .2, .3]), [.1, .2, .3], String(value));
});

test("the renderer factory is exported and refuses a canvas without WebGL", () => {
  assert.equal(typeof aurora.createAuroraRenderer, "function");
  assert.equal(aurora.createAuroraRenderer({ getContext: () => null, addEventListener() {} }), null);
  assert.equal(aurora.acquireAuroraRenderer({ getContext: () => null, addEventListener() {} }), null);
});
