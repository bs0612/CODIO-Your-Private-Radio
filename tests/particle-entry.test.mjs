import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the production canvas effect and cover helpers with isolated media,
// refs and animation frames. No Electron bridge, account or userData is touched.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(), effects = [];
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") effects.push(node.arguments[0].getText(ast));
  ts.forEachChild(node, visit);
})(ast);
function bind(code, context) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function("context", `with(context){${js}}`)(context);
}
function helper(name, context) {
  assert.ok(functions.has(name), `Missing production helper: ${name}`);
  return bind(`${functions.get(name)};return ${name};`, context);
}
function handler(name, context) {
  let initializer;
  (function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  })(ast);
  assert.ok(initializer, `Missing production handler ${name}`);
  return bind(`return ${initializer};`, context);
}
function effect(marker, context, transform = code => code) {
  const matching = effects.filter(code => code.includes(marker));
  assert.equal(matching.length, 1, `Exactly one production effect must contain ${marker}`);
  return bind(`const effect=${transform(matching[0])};return effect;`, context);
}
function originalWaveFormula(code) {
  const effectAst = ts.createSourceFile("particle-effect.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = [], framePhaseStatements = [];
  (function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(effectAst) === "wave") declarations.push(node);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ["timePhase", "sinTime", "sinBeat"].includes(declaration.name.getText(effectAst)))) framePhaseStatements.push(node);
    ts.forEachChild(node, visit);
  })(effectAst);
  assert.equal(declarations.length, 1, "Compare the actual particle wave, not a separately reimplemented field");
  let original = code.replace(declarations[0].getText(effectAst), `wave = Math.sin(nx * 44 + ny * 31 + time * 0.00022) * (.72 + edge * 2.1) +
            Math.sin(pointRadius * 21 - music.beat) * (1.15 + music.pulse * 8.5)`);
  for (const statement of framePhaseStatements) original = original.replace(statement.getText(effectAst), "");
  return original;
}

function originalPointerFormula(code) {
  const effectAst = ts.createSourceFile("particle-effect.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const branches = [];
  (function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(effectAst) === "distanceSquared < influenceRadiusSquared && !reducedMotion") branches.push(node);
    ts.forEachChild(node, visit);
  })(effectAst);
  assert.equal(branches.length, 1, "Compare the actual production attraction branch");
  return code.replace("const strideSize =", "const influenceRadius = Math.min(126, Math.min(width, height) * .17); const strideSize =")
    .replace(branches[0].getText(effectAst), `if (distanceSquared < influenceRadiusSquared && !reducedMotion) {
      const distance = Math.sqrt(distanceSquared);
      const influence = Math.pow(1 - distance / influenceRadius, 1.72);
      const depthLayer = Math.max(.28, Math.min(1.18, .7 + depth / Math.max(size, 1)));
      const force = influence * (10 + depthLayer * 16 + music.breath * 3);
      x += (deltaX / Math.max(distance, 1)) * force;
      y += (deltaY / Math.max(distance, 1)) * force;
    }`);
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const points = (rgb = [210, 50, 50], count = 64) => Array.from({ length: count }, (_, i) => ({
  nx: (i % 8) / 9 - .4, ny: Math.floor(i / 8) / 9 - .4, rgb, alpha: .9, seed: i / count,
}));
const color = rgb => `rgb(${rgb.join(" ")})`;

function harness({ cover = "a", mid = "a", previous = "", cached = [], oldPoints = [], samples = new Map(), costPerDot = 0, math = Math, originalWave = false, originalPointer = false } = {}) {
  const frames = new Map(), fills = [], requested = [], visibilityListeners = new Set(), resizeListeners = new Set(), focusListeners = new Set(), blurListeners = new Set();
  const calls = { clear: 0, fill: 0, pointerStyles: 0 };
  let nextFrame = 0, clock = 1000, workMs = 0;
  const ctx = {
    setTransform() {}, clearRect() { calls.clear++; fills.length = 0; },
    fillRect(x, y, width, height) { calls.fill++; workMs += costPerDot; fills.push({ color: this.fillStyle, alpha: this.globalAlpha, x, y, width, height }); },
  };
  const c = {
    visualActiveRef: { current: true },
    Math: math,
    document: { hidden: false, addEventListener(name, callback) { if (name === "visibilitychange") visibilityListeners.add(callback); },
      removeEventListener(name, callback) { if (name === "visibilitychange") visibilityListeners.delete(callback); } },
    window: {
      innerWidth: 1200, devicePixelRatio: 1,
      requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
      cancelAnimationFrame(id) { frames.delete(id); },
      addEventListener(name, listener) { ({resize:resizeListeners,focus:focusListeners,blur:blurListeners})[name]?.add(listener); },
      removeEventListener(name, listener) { ({resize:resizeListeners,focus:focusListeners,blur:blurListeners})[name]?.delete(listener); },
    },
    performance: { now: () => clock + workMs },
    nowCanvasRef: { current: { clientWidth: 1200, clientHeight: 800, getContext: () => ctx } },
    nowStageRef: { current: { style: { setProperty() { calls.pointerStyles++; } } } },
    nowPlayingOpen: true, visualMode: "particles", particleLevel: 2, reducedMotion: false, lyricMode: "full", isPlaying: false,
    currentTrack: { color: "violet", bpm: 90, cover }, NOW_INITIAL_RX: -7, NOW_INITIAL_RY: 9,
    nowPointerRef: { current: { x: 0, y: 0, visualX: 0, visualY: 0, rx: -7, ry: 9, zoom: 1,
      dragging: false, returning: false, velocityX: 0, velocityY: 0, velocityZoom: 0 } },
    previousCoverSourceRef: { current: previous }, previousCoverPointsRef: { current: oldPoints },
    particleRenderStridesRef: { current: new Map() },
    pointerAttractionTableRef: { current: null },
    coverPointCloudsRef: { current: new Map(cached.map(([key, value]) => [`192:${key}`, value])) },
    coverPointPromisesRef: { current: new Map() }, coverPointPairsRef: { current: new Map() },
    currentCoverData: cover, activeQQTrack: { mid, cover },
    currentCoverDataLiveRef: { current: cover }, currentTrackCoverLiveRef: { current: cover },
    activeQQTrackLiveRef: { current: { mid, cover } }, activeTransitionRef: { current: null }, transitionVisualFrameRef: { current: null },
    musicAudioRef: { current: null }, userPausedRef: { current: false }, audioContextRef: { current: null }, analyserRef: { current: null }, frequencyDataRef: { current: null },
    analyserNodesRef: { current: new WeakMap() },
    trackAnalysisRef: { current: new Map() },
    getMusicVisualFrame: () => ({ beatEnvelope: 0, downbeatEnvelope: 0, beatPhase: 0, continuousEnergy: .2, phraseEnvelope: 0, dramaticEnvelope: 0 }),
    getTransitionChoreography: () => null,
    sampleCoverPointCloud(source) { requested.push(source); return samples.get(source)?.promise || Promise.resolve([]); },
  };
  c.setBoundedCache = helper("setBoundedCache", c);
  c.spatiallyPairCoverPoints = helper("spatiallyPairCoverPoints", c);
  c.prepareCoverPointCloud = helper("prepareCoverPointCloud", c);
  c.getAudiblePlaybackTime = helper("getAudiblePlaybackTime", c);
  c.createPointerAttractionTable = helper("createPointerAttractionTable", c);
  const run = () => effect("const drawAlbum", c, code => {
    if (originalWave) code = originalWaveFormula(code);
    return originalPointer ? originalPointerFormula(code) : code;
  })();
  function draw(at = clock) {
    clock = at; workMs = 0;
    const entry = frames.entries().next().value;
    assert.ok(entry, "Production effect must schedule a real canvas frame");
    frames.delete(entry[0]); entry[1](clock);
    return [...fills];
  }
  function change(nextCover, nextMid = mid) {
    c.currentCoverDataLiveRef.current = nextCover;
    c.activeQQTrackLiveRef.current = { mid: nextMid, cover: nextCover };
  }
  return { c, run, draw, change, requested, frames, visibilityListeners, resizeListeners, calls,
    focus(active) { c.visualActiveRef.current=active; for(const callback of active?focusListeners:blurListeners)callback(); },
    focusListeners,blurListeners };
}

test("unfocused Now Playing stops the particle loop without pausing audio or resampling on return",()=>{
  const h=harness({cached:[["a",points()]]}),cleanup=h.run();h.draw();
  const audio={paused:false,currentTime:15};h.c.musicAudioRef.current=audio;
  h.focus(false);assert.equal(h.c.document.hidden,false);assert.equal(h.frames.size,0);
  const painted=h.calls.fill;audio.currentTime=30;
  for(const callback of h.visibilityListeners)callback();
  assert.equal(h.frames.size,0);assert.equal(h.calls.fill,painted);assert.equal(audio.paused,false);
  h.focus(true);h.focus(true);assert.equal(h.frames.size,1);h.draw(2000);
  assert.ok(h.calls.fill>painted);assert.equal(audio.currentTime,30);assert.equal(audio.paused,false);
  assert.deepEqual(h.requested,[]);cleanup();h.focus(true);assert.equal(h.frames.size,0);
  assert.equal(h.focusListeners.size+h.blurListeners.size,0);
});

test("cached current cover is the first rendered field, including reopen after a hidden song change", () => {
  const current = points([50, 190, 90]);
  for (const previous of ["", "a"]) {
    const h = harness({ cover: "b", mid: "b", previous, oldPoints: previous ? points() : [], cached: [["b", current]] });
    const cleanup = h.run(), first = h.draw();
    assert.ok(first.length, "A prepared current cover must draw immediately");
    assert.ok(first.every(dot => dot.color === color(current[0].rgb)), "Never paint the stale cover or palette grid on entry");
    assert.equal(h.requested.length, 0, "Cached entry must not resample the image");
    cleanup();
  }
});

test("cold entry waits for its exact cover and settles without an entry morph", async () => {
  const sample = deferred(), current = points([50, 190, 90]);
  const h = harness({ cover: "b", mid: "b", previous: "a", oldPoints: points(), samples: new Map([["b", sample]]) });
  const cleanup = h.run();
  assert.equal(h.draw().length, 0, "Unknown current cover must not briefly show an unrelated old/fallback field");
  sample.resolve(current); await flush();
  assert.ok(h.draw(1100).every(dot => dot.color === color(current[0].rgb)), "Entry sample applies directly instead of scattering old particles");
  assert.equal(h.c.previousCoverSourceRef.current, "b"); cleanup();
});

test("same-song cover URL replacement does not masquerade as a song transition", async () => {
  const decoded = points([50, 190, 90]);
  const h = harness({ cached: [["a", points()], ["a-data", decoded]] });
  const cleanup = h.run(); await flush(); h.draw();
  h.change("a-data", "a"); h.draw(1100); await flush();
  const field = h.draw(1150);
  assert.ok(field.length && field.every(dot => dot.color === color(decoded[0].rgb)));
  cleanup();
});

test("a real song change while open still morphs and then converges", async () => {
  const incoming = points([50, 190, 90]);
  const h = harness({ cached: [["a", points()], ["b", incoming]] });
  const cleanup = h.run(); await flush(); h.draw();
  h.change("b", "b"); h.draw(1100); await flush();
  const moving = h.draw(1250);
  assert.ok(moving.length && moving.some(dot => dot.color !== color(incoming[0].rgb)), "Actual song changes retain the scatter/morph gesture");
  h.draw(3000);
  const settled = h.draw(3016);
  assert.ok(settled.length && settled.every(dot => dot.color === color(incoming[0].rgb)));
  cleanup();
});

test("late cover samples cannot replace a newer song or publish after close", async () => {
  const b = deferred(), d = deferred(), incoming = points([50, 190, 90]);
  const h = harness({ cached: [["a", points()]], samples: new Map([["b", b], ["c", d]]) });
  const cleanup = h.run(); await flush(); h.draw();
  h.change("b", "b"); h.draw(1100);
  h.change("c", "c"); h.draw(1200); d.resolve(incoming); await flush();
  assert.equal(h.c.previousCoverSourceRef.current, "c");
  b.resolve(points()); await flush();
  assert.equal(h.c.previousCoverSourceRef.current, "c", "Old completion must not revert the current source");
  cleanup();
  const late = deferred(), closed = harness({ cover: "late", samples: new Map([["late", late]]) });
  closed.run()(); late.resolve(incoming); await flush();
  assert.equal(closed.c.previousCoverSourceRef.current, "", "Disposed canvas cannot publish its sampled result");
  const returnedSample = deferred(), original = points();
  const returned = harness({ cached: [["a", original]], samples: new Map([["b", returnedSample]]) });
  const disposeReturned = returned.run(); returned.draw();
  returned.change("b", "b"); returned.draw(1100);
  returned.change("a", "a"); returned.draw(1200);
  returnedSample.resolve(incoming); await flush();
  assert.notEqual(returned.c.previousCoverSourceRef.current, "b", "Returning to the rendered source must invalidate the pending other cover");
  assert.ok(returned.draw(1250).every(dot => dot.color === color(original[0].rgb)));
  disposeReturned();
});

test("particle density starts at its settled value and does not step down twice on slow frames", async () => {
  const h = harness({ cached: [["a", points()]] }), cleanup = h.run(); await flush();
  const first = h.draw(), count = first.length;
  assert.ok(count);
  for (let i = 1; i <= 80; i++) assert.equal(h.draw(1000 + i * 45).length, count, `No delayed density transformation at frame ${i}`);
  cleanup();
});

test("first-frame quality calibration is already settled when presented and survives reopening", () => {
  for (const [costPerDot, stride] of [[.25, 2], [.5, 4]]) {
    const h = harness({ cached: [["a", points()]], costPerDot });
    const cleanup = h.run(), first = h.draw();
    assert.equal(first.length, 64 / stride, "Slow full-quality trial is replaced within the same presented frame");
    for (let i = 1; i <= 80; i++) assert.equal(h.draw(1000 + i * 45).length, first.length);
    cleanup(); const reopen = h.run();
    assert.equal(h.draw(5000).length, first.length, "Reopen starts at the previously settled viewport quality");
    reopen();
  }
});

test("settled entry retains real beat response and pointer rotation/zoom", async () => {
  const h = harness({ cached: [["a", points()]] }), cleanup = h.run(); await flush();
  const still = h.draw();
  h.c.isPlaying = true;
  h.c.musicAudioRef.current = { paused: false, currentTime: 42 };
  h.c.getMusicVisualFrame = () => ({ beatEnvelope: 1, downbeatEnvelope: 1, beatPhase: .5,
    continuousEnergy: .8, phraseEnvelope: .7, dramaticEnvelope: 0 });
  const beat = h.draw();
  assert.ok(beat.some((dot, i) => dot.width !== still[i].width || dot.y !== still[i].y), "Music still affects the settled field");
  Object.assign(h.c.nowPointerRef.current, { x: .3, y: -.2, rx: 22, ry: 35, zoom: 1.25, dragging: true });
  const pointer = h.draw();
  assert.ok(pointer.some((dot, i) => dot.x !== beat[i].x || dot.y !== beat[i].y), "Existing pointer/pose controls still affect particles");
  cleanup();
});

test("hidden particle canvas stops scheduling and resumes its same settled cover when visible", () => {
  const h = harness({ cached: [["a", points()]] }), cleanup = h.run();
  const first = h.draw();
  h.c.document.hidden = true;
  h.draw(1100);
  assert.equal(h.frames.size, 0, "No invisible canvas rAF should remain queued");
  h.c.document.hidden = false;
  for (const listener of h.visibilityListeners) listener();
  assert.equal(h.frames.size, 1);
  const resumed = h.draw(1200);
  assert.equal(resumed.length, first.length);
  assert.deepEqual(h.requested, [], "Visibility does not resample or reconstruct the cover");
  cleanup();
  assert.equal(h.frames.size, 0);
  assert.equal(h.visibilityListeners.size, 0);
});

test("production preparation reuses pending samples and resolves the same cached cloud", async () => {
  const sample = deferred(), cloud = points(), h = harness({ samples: new Map([["warm", sample]]) });
  const first = h.c.prepareCoverPointCloud("warm", 192), second = h.c.prepareCoverPointCloud("warm", 192);
  assert.equal(first, second); assert.deepEqual(h.requested, ["warm"]);
  sample.resolve(cloud); assert.equal(await first, cloud);
  assert.equal(await h.c.prepareCoverPointCloud("warm", 192), cloud);
  assert.deepEqual(h.requested, ["warm"]); assert.equal(h.c.coverPointPromisesRef.current.size, 0);
});

test("closed-panel warmup prepares the exact current grid for immediate opening", async () => {
  for (const [level, viewportWidth, grid] of [[0, 1200, 120], [1, 1200, 164], [2, 1200, 192], [2, 600, 180]]) {
    const sample = deferred(), cloud = points([50, 190, 90]);
    const h = harness({ cover: "warm", samples: new Map([["warm", sample]]) });
    h.c.nowPlayingOpen = false; h.c.particleLevel = level; h.c.window.innerWidth = viewportWidth;
    h.c.activeQQTrack.cover = "lower-priority-remote-cover";
    effect("Warm the exact current cloud", h.c)();
    assert.deepEqual(h.requested, ["warm"], "Warmup uses resolved current cover ahead of remote track art");
    assert.ok(h.c.coverPointPromisesRef.current.has(`${grid}:warm`));
    sample.resolve(cloud); await flush();
    assert.equal(h.c.coverPointCloudsRef.current.get(`${grid}:warm`), cloud);
    h.c.nowPlayingOpen = true; const cleanup = h.run(), first = h.draw();
    assert.ok(first.length && first.every(dot => dot.color === color(cloud[0].rgb)), "Prewarmed exact grid is available on the first visible frame");
    assert.deepEqual(h.requested, ["warm"], "Opening reuses warmed cloud without a second sample");
    cleanup();
  }
});

test("a steady paused field reuses final pixels while keeping one cheap observer frame", () => {
  const h = harness({ cached: [["a", points()]] });
  h.c.musicAudioRef.current = { paused: true, currentTime: 42 };
  const cleanup = h.run(), first = h.draw(), painted = { ...h.calls };
  assert.equal(first.length, 64);
  for (let i = 1; i <= 300; i++) assert.deepEqual(h.draw(1000 + i * 16), first, "Paused points do not keep drifting or regenerating");
  assert.deepEqual(h.calls, painted, "Do not clear or fill tens of thousands of paused points each frame");
  assert.equal(h.frames.size, 1);
  assert.deepEqual(h.requested, [], "Freezing a cached field does not resample its cover");
  cleanup();
  assert.equal(h.frames.size, 0); assert.equal(h.visibilityListeners.size, 0); assert.equal(h.resizeListeners.size, 0);
});

test("real media resume wakes on the next frame without resetting density or points", () => {
  const h = harness({ cached: [["a", points()]] });
  const audio = { paused: true, currentTime: 42 }; h.c.musicAudioRef.current = audio;
  const cleanup = h.run(), still = h.draw(), strides = [...h.c.particleRenderStridesRef.current];
  h.draw(1100); assert.equal(h.calls.clear, 1);
  h.c.getMusicVisualFrame = () => ({ beatEnvelope: 1, downbeatEnvelope: 1, beatPhase: .5,
    continuousEnergy: .8, phraseEnvelope: .7, dramaticEnvelope: 0 });
  audio.paused = false;
  const playing = h.draw(1116);
  assert.equal(h.calls.clear, 2);
  assert.ok(playing.some((dot, index) => dot.width !== still[index].width || dot.y !== still[index].y));
  h.draw(1132); assert.equal(h.calls.clear, 3, "Playing beat and breath rendering is not throttled");
  assert.deepEqual([...h.c.particleRenderStridesRef.current], strides);
  assert.deepEqual(h.requested, []);
  audio.paused = true; h.draw(1148);
  const pausedPaints = { ...h.calls };
  h.draw(1164); h.draw(1180); assert.deepEqual(h.calls, pausedPaints);
  cleanup();
});

test("paused pointer attraction, drag inertia and return continue, then settle to reused pixels", () => {
  const h = harness({ cached: [["a", points()]] }), cleanup = h.run(), still = h.draw();
  const pointer = h.c.nowPointerRef.current;
  pointer.x = .3; pointer.y = -.2;
  const moved = h.draw(1100);
  assert.equal(h.calls.clear, 2);
  assert.ok(moved.some((dot, index) => dot.x !== still[index].x || dot.y !== still[index].y));
  for (let i = 0; i < 100; i++) h.draw(1116 + i * 16);
  const settledPaints = h.calls.clear; h.draw(2800); assert.equal(h.calls.clear, settledPaints);
  Object.assign(pointer, { dragging: true, rx: 22, ry: 35, zoom: 1.25 });
  h.draw(2816); h.draw(2832); assert.equal(h.calls.clear, settledPaints + 2, "A held drag remains interactive");
  Object.assign(pointer, { dragging: false, velocityX: .5, velocityY: -.7 });
  const rxBefore = pointer.rx; h.draw(2848);
  assert.notEqual(pointer.rx, rxBefore, "The existing inertial rotation must still run while paused");
  for (let i = 0; i < 150; i++) h.draw(2864 + i * 16);
  const inertialSettled = h.calls.clear; h.draw(5300); assert.equal(h.calls.clear, inertialSettled);
  Object.assign(pointer, { returning: true, ry: pointer.ry + 720, velocityY: -12 });
  const beforeReturn = h.calls.clear;
  for (let i = 0; i < 400; i++) h.draw(5316 + i * 16);
  assert.ok(h.calls.clear > beforeReturn);
  assert.equal(pointer.returning, false);
  assert.equal(pointer.rx, h.c.NOW_INITIAL_RX); assert.equal(pointer.ry, h.c.NOW_INITIAL_RY); assert.equal(pointer.zoom, 1);
  const returned = h.calls.clear; h.draw(12000); assert.equal(h.calls.clear, returned);
  cleanup();
});

test("paused zoom, seek and late measured analysis invalidate the reused frame", () => {
  const h = harness({ cached: [["a", points()]] });
  h.c.musicAudioRef.current = { paused: true, currentTime: 42 };
  const cleanup = h.run(); h.draw(); h.draw(1100); assert.equal(h.calls.clear, 1);
  h.c.nowPointerRef.current.zoom = 1.2;
  h.draw(1116); assert.equal(h.calls.clear, 2); h.draw(1132); assert.equal(h.calls.clear, 2);
  h.c.musicAudioRef.current.currentTime = 60;
  h.draw(1148); assert.equal(h.calls.clear, 3); h.draw(1164); assert.equal(h.calls.clear, 3);
  h.c.trackAnalysisRef.current.set("a", { bpm: 100 });
  h.draw(1180); assert.equal(h.calls.clear, 4); h.draw(1196); assert.equal(h.calls.clear, 4);
  cleanup();
});

test("a late cover completion wakes a paused blank field and a same-song replacement", async () => {
  const sample = deferred(), replacement = deferred(), cloud = points([50, 190, 90]);
  const h = harness({ samples: new Map([["a", sample], ["decoded-a", replacement]]) }), cleanup = h.run();
  assert.equal(h.draw().length, 0);
  for (let i = 0; i < 20; i++) h.draw(1016 + i * 16);
  assert.equal(h.calls.clear, 1, "Pending decoding does not redraw an unchanged blank field");
  sample.resolve(cloud); await flush();
  assert.equal(h.draw(1400).length, cloud.length); assert.equal(h.calls.clear, 2);
  h.draw(1416); assert.equal(h.calls.clear, 2);
  h.change("decoded-a", "a"); h.draw(1432); await flush();
  const waiting = h.calls.clear;
  h.draw(1448); assert.equal(h.calls.clear, waiting);
  replacement.resolve(points([90, 80, 220])); await flush();
  assert.ok(h.draw(1464).every(dot => dot.color === color([90, 80, 220])));
  assert.equal(h.calls.clear, waiting + 1);
  h.draw(1480); assert.equal(h.calls.clear, waiting + 1);
  cleanup();
});

test("a real paused song morph keeps rendering until its existing choreography finishes", async () => {
  const h = harness({ cached: [["a", points()], ["b", points([50, 190, 90])]] }), cleanup = h.run();
  h.draw(); h.change("b", "b"); h.draw(1100); await flush();
  const start = h.draw(1250), before = h.calls.clear, middle = h.draw(1400);
  assert.equal(h.calls.clear, before + 1);
  assert.ok(middle.some((dot, index) => dot.x !== start[index].x || dot.y !== start[index].y));
  const final = h.draw(3000), settled = { ...h.calls };
  assert.ok(final.every(dot => dot.color === color([50, 190, 90])));
  h.draw(3016); h.draw(3032); assert.deepEqual(h.calls, settled, "Do not add a second morph or a delayed pause rebuild");
  cleanup();
});

test("active audio/visual handoff keeps rendering even when both Decks are paused", async () => {
  const h = harness({ cached: [["a", points()]] }), cleanup = h.run(); h.draw();
  const analysis = { effectiveEnd: 100, waveform: [] };
  h.c.activeTransitionRef.current = {
    id: "handoff-1", plan: { strategy: "phrase_blend" },
    outgoing: { paused: true, currentTime: 90 }, incoming: { paused: true, currentTime: 2 },
    outgoingSnapshot: { analysis, track: { mid: "a" }, cover: "a" },
    incomingSnapshot: { analysis, track: { mid: "a" }, cover: "a" },
  };
  h.c.transitionVisualFrameRef.current = { beforeSwitch: true, particleMix: .3 };
  const before = h.calls.clear;
  for (let i = 0; i < 8; i++) h.draw(1100 + i * 16);
  assert.equal(h.calls.clear, before + 8, "The paused optimization must not short-circuit unified visual handoff");
  h.c.activeTransitionRef.current = null; h.c.transitionVisualFrameRef.current = null;
  h.draw(1300); const after = h.calls.clear;
  h.draw(1316); assert.equal(h.calls.clear, after);
  cleanup();
});

test("resize and DPR repaint a paused field once without cover resampling", () => {
  const h = harness({ cached: [["a", points()]] }), cleanup = h.run(); h.draw(); h.draw(1100);
  h.c.nowCanvasRef.current.clientWidth = 900; h.c.nowCanvasRef.current.clientHeight = 600; h.c.window.devicePixelRatio = 2;
  for (const listener of h.resizeListeners) listener();
  assert.equal(h.calls.clear, 1);
  assert.equal(h.c.nowCanvasRef.current.width, 1440); assert.equal(h.c.nowCanvasRef.current.height, 960);
  h.draw(1116); assert.equal(h.calls.clear, 2);
  h.draw(1132); assert.equal(h.calls.clear, 2); assert.deepEqual(h.requested, []);
  cleanup(); assert.equal(h.resizeListeners.size, 0);
});

function equalField(actual, original) {
  assert.equal(actual.length, original.length, "Caching cannot change point density");
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].color, original[i].color, `Point ${i} keeps its album color`);
    for (const field of ["x", "y", "width", "height", "alpha"]) {
      assert.ok(Math.abs(actual[i][field] - original[i][field]) <= 1e-8,
        `Point ${i} ${field}: ${actual[i][field]} differs from original ${original[i][field]}`);
    }
  }
}

test("cached static phases preserve actual production coordinates across beats, long clocks and pointer poses", () => {
  const cloud = points().map((point, index) => ({ ...point, radius: Math.hypot(point.nx, point.ny),
    angle: Math.atan2(point.ny, point.nx), rgb: [50 + index * 2, 190 - index, 90 + index] }));
  const actual = harness({ cached: [["a", cloud]] }), original = harness({ cached: [["a", cloud]], originalWave: true });
  const cleanups = [actual.run(), original.run()];
  for (const h of [actual, original]) h.c.musicAudioRef.current = { paused: false, currentTime: 42 };
  for (const [index, time] of [1000, 1016, 24000, 3_600_000, 86_400_000, 100_000_000].entries()) {
    for (const h of [actual, original]) {
      h.c.lyricMode = index % 2 ? "minimal" : "full";
      Object.assign(h.c.nowPointerRef.current, { x: .27, y: -.18, visualX: .27, visualY: -.18,
        rx: index * 8 - 7, ry: index * 40 + 9, zoom: 1 + index * .07, dragging: true });
      h.c.getMusicVisualFrame = () => ({ beatEnvelope: index / 6, downbeatEnvelope: index % 2,
        beatPhase: index * .173, continuousEnergy: .65, phraseEnvelope: .7, dramaticEnvelope: 0 });
    }
    equalField(actual.draw(time), original.draw(time));
  }
  cleanups.forEach(cleanup => cleanup());
});

test("real song morph retains its original dynamic wave, scatter and convergence", async () => {
  const incoming = points([30, 210, 120]).map((point, i) => ({ ...point, nx: point.nx * .7 + .03, ny: point.ny * .85 - .02, seed: (i + 1) / 65 }));
  const actual = harness({ cached: [["a", points()], ["b", incoming]] });
  const original = harness({ cached: [["a", points()], ["b", incoming]], originalWave: true });
  const cleanups = [actual.run(), original.run()];
  equalField(actual.draw(), original.draw());
  for (const h of [actual, original]) { h.change("b", "b"); h.draw(1100); }
  await flush();
  for (const time of [1120, 1250, 1450, 1700, 2050, 2400, 3000, 3016]) equalField(actual.draw(time), original.draw(time));
  cleanups.forEach(cleanup => cleanup());
});

test("warm playing frames reduce two per-point sine calls to fixed frame phases without reducing paints", t => {
  const count = 4096;
  const cloud = Array.from({ length: count }, (_, i) => {
    const nx = (i % 64) / 64 - .5, ny = Math.floor(i / 64) / 64 - .5;
    return { nx, ny, radius: Math.hypot(nx, ny), angle: Math.atan2(ny, nx), rgb: [210, 50, 50], alpha: .9, seed: i / count };
  });
  const observedMath = () => {
    const calls = { sin: 0, cos: 0 }, math = Object.create(Math);
    for (const name of ["sin", "cos"]) math[name] = value => { calls[name]++; return Math[name](value); };
    return { calls, math };
  };
  const actualMath = observedMath(), originalMath = observedMath();
  const actual = harness({ cached: [["a", cloud]], math: actualMath.math });
  const original = harness({ cached: [["a", cloud]], math: originalMath.math, originalWave: true });
  const cleanups = [actual.run(), original.run()];
  for (const h of [actual, original]) h.c.musicAudioRef.current = { paused: false, currentTime: 42 };
  equalField(actual.draw(), original.draw());
  for (const counter of [actualMath.calls, originalMath.calls]) { counter.sin = 0; counter.cos = 0; }
  const frames = 30;
  for (let i = 1; i <= frames; i++) equalField(actual.draw(1000 + i * 16), original.draw(1000 + i * 16));
  assert.equal(actual.calls.fill, original.calls.fill);
  assert.equal(actualMath.calls.sin, 4 * frames, "Only rotation, time and beat phases call sin after the point cache is warm");
  assert.equal(actualMath.calls.cos, 4 * frames);
  assert.equal(originalMath.calls.sin, (2 * count + 2) * frames, "The original field calculates two sines per point plus its two rotation phases");
  assert.equal(originalMath.calls.sin - actualMath.calls.sin, (2 * count - 2) * frames,
    "The production effect replaces per-point sines with two shared frame sine phases");
  t.diagnostic(`${count} points x ${frames} real-effect frames: sine calls ${originalMath.calls.sin} -> ${actualMath.calls.sin}; paints unchanged (${actual.calls.fill})`);
  cleanups.forEach(cleanup => cleanup());
});

test("the actual handoff field reads the authoritative Deck analyser and the same audible clock on both sides", () => {
  const h = harness({ cached: [["a", points()]] }), cleanup = h.run();
  const outgoing = { paused: false, currentTime: 90, playbackRate: 1 };
  const incoming = { paused: false, currentTime: 2, playbackRate: 1.03 };
  const outgoingAnalysis = { bpm: 94 }, incomingAnalysis = { bpm: 96 };
  const calls = { outgoing: [], incoming: [], global: 0 }, observed = [];
  h.c.musicAudioRef.current = outgoing;
  h.c.audioContextRef.current = { state: "running", baseLatency: .025, outputLatency: .07 };
  h.c.analyserNodesRef.current.set(outgoing, { analyser: { frequencyBinCount: 8,
    getByteFrequencyData(buffer) { calls.outgoing.push(buffer.length); buffer.fill(20); } } });
  h.c.analyserNodesRef.current.set(incoming, { analyser: { frequencyBinCount: 16,
    getByteFrequencyData(buffer) { calls.incoming.push(buffer.length); buffer.fill(200); } } });
  h.c.analyserRef.current = { getByteFrequencyData() { calls.global++; } };
  h.c.getMusicVisualFrame = (analysis, time) => {
    observed.push({ analysis, time });
    return { beatEnvelope: .5, downbeatEnvelope: .4, beatPhase: .2, continuousEnergy: .5, phraseEnvelope: .3, dramaticEnvelope: 0 };
  };
  h.c.activeTransitionRef.current = {
    id: "real-deck-handoff", plan: { strategy: "phrase_blend" }, outgoing, incoming,
    outgoingSnapshot: { analysis: outgoingAnalysis, track: { mid: "a" }, cover: "a" },
    incomingSnapshot: { analysis: incomingAnalysis, track: { mid: "b" }, cover: "a" },
  };
  h.c.transitionVisualFrameRef.current = { beforeSwitch: true, particleMix: .2 };
  h.draw();
  assert.deepEqual(calls.outgoing, [8]); assert.deepEqual(calls.incoming, []);
  assert.equal(observed[0].analysis, outgoingAnalysis);
  assert.ok(Math.abs(observed[0].time - (90 - .095)) < 1e-10);
  h.c.transitionVisualFrameRef.current = { beforeSwitch: false, particleMix: .7 };
  h.draw(1016);
  assert.deepEqual(calls.outgoing, [8]); assert.deepEqual(calls.incoming, [16]);
  assert.equal(observed[1].analysis, incomingAnalysis);
  assert.ok(Math.abs(observed[1].time - (2 - .095 * 1.03)) < 1e-10);
  assert.equal(calls.global, 0, "Preparing an incoming global analyser must not animate the still-authoritative outgoing Deck");
  assert.equal(h.c.frequencyDataRef.current.length, 16, "Buffers follow the selected analyser's bin count");
  cleanup();
});

test("the bounded radial table preserves attraction through the centre and radius without colour changes", t => {
  const makeTable = helper("createPointerAttractionTable", { Math });
  assert.deepEqual([...makeTable(0)], [0, 0]);
  let maximumError = 0;
  for (const radius of [1, 17.37, 68, 126]) {
    const table = makeTable(radius);
    assert.ok(table.byteLength <= 254020, "One table, not a screen-position by particle matrix");
    for (let i = 0; i < 20000; i++) {
      const distance = i / 20000 * radius, squaredIndex = distance * distance * (table.length - 1) / (radius * radius);
      const index = Math.floor(squaredIndex), fraction = squaredIndex - index;
      const factor = table[index] + (table[index + 1] - table[index]) * fraction;
      const expected = Math.pow(1 - distance / radius, 1.72) * distance / Math.max(distance, 1);
      const error = Math.abs(factor * distance - expected) * 32;
      maximumError = Math.max(maximumError, error);
      assert.ok(Number.isFinite(factor) && factor >= 0);
      assert.ok(error < .16, `${radius}px radius, ${distance}px distance: ${error}px displacement error`);
    }
  }
  t.diagnostic(`Maximum attraction displacement approximation error: ${maximumError.toFixed(4)} CSS px (32px force bound)`);
});

test("all pointer positions reuse one table across beats, modes, covers and reopen; only a changed radius rebuilds", async () => {
  const h = harness({ cached: [["a", points()], ["b", points([40, 180, 90])]] });
  let builds = 0;
  const build = h.c.createPointerAttractionTable;
  h.c.createPointerAttractionTable = radius => { builds++; return build(radius); };
  let cleanup = h.run(); h.draw();
  const original = h.c.pointerAttractionTableRef.current;
  for (let i = 0; i < 80; i++) {
    Object.assign(h.c.nowPointerRef.current, { x: i / 40 - 1, y: Math.sin(i), dragging: true });
    h.draw(1016 + i * 16);
  }
  h.change("b", "b"); h.draw(2400); await flush(); h.draw(2600); h.draw(5000);
  cleanup(); h.c.lyricMode = "minimal"; cleanup = h.run(); h.draw(5100);
  assert.equal(h.c.pointerAttractionTableRef.current, original);
  assert.equal(builds, 1, "Pointer events, cover morph and layout/reopen must not regenerate the table");
  h.c.nowCanvasRef.current.clientHeight = 600;
  for (const listener of h.resizeListeners) listener();
  assert.equal(builds, 2); assert.notEqual(h.c.pointerAttractionTableRef.current, original);
  for (const listener of h.resizeListeners) listener();
  assert.equal(builds, 2); assert.ok(h.draw(5200).every(dot => Number.isFinite(dot.x) && Number.isFinite(dot.y)));
  cleanup(); h.c.reducedMotion = true; cleanup = h.run(); h.draw(5300);
  assert.equal(builds, 2, "Reduced motion needs no force table rebuild"); cleanup();
});

test("production lookup retains hover, 3D poses, beat bursts and song morph without extra paints", async t => {
  const cloud = points().map(point => ({ ...point, radius: Math.hypot(point.nx, point.ny), angle: Math.atan2(point.ny, point.nx) }));
  const actual = harness({ cached: [["a", cloud], ["b", points([40, 180, 90])]] });
  const original = harness({ cached: [["a", cloud], ["b", points([40, 180, 90])]], originalPointer: true });
  const cleanups = [actual.run(), original.run()];
  let maximumError = 0;
  for (let frame = 0; frame < 80; frame++) {
    for (const h of [actual, original]) {
      h.c.musicAudioRef.current = { paused: false, currentTime: frame / 10 };
      h.c.lyricMode = frame % 2 ? "full" : "minimal";
      Object.assign(h.c.nowPointerRef.current, { x: Math.sin(frame * .23), y: Math.cos(frame * .17), dragging: true,
        rx: frame % 80 - 40, ry: frame * 3, zoom: .8 + frame % 10 * .04 });
      h.c.getMusicVisualFrame = () => ({ beatEnvelope: .8, downbeatEnvelope: .6, beatPhase: frame % 9 / 9,
        continuousEnergy: .7, phraseEnvelope: .5, dramaticEnvelope: frame < 15 ? .8 : 0 });
      if (frame === 30) h.change("b", "b");
    }
    const a = actual.draw(1000 + frame * 40), b = original.draw(1000 + frame * 40);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      for (const field of ["color", "alpha", "width", "height"]) assert.equal(a[i][field], b[i][field]);
      maximumError = Math.max(maximumError, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
    }
    await flush();
  }
  assert.ok(maximumError < .16); assert.equal(actual.calls.fill, original.calls.fill);
  t.diagnostic(`Actual Canvas effect: max coordinate difference ${maximumError.toFixed(4)} CSS px; colours, alpha, density and paints unchanged`);
  cleanups.forEach(cleanup => cleanup());
});

test("warm actual pointer frames no longer call per-nearby-point sqrt/pow", t => {
  const count = 4096, cloud = Array.from({ length: count }, (_, i) => {
    const nx = i % 64 / 64 - .5, ny = Math.floor(i / 64) / 64 - .5;
    return { nx, ny, radius: Math.hypot(nx, ny), angle: Math.atan2(ny, nx), rgb: [120, 180, 230], alpha: .9, seed: i / count };
  });
  const measured = originalPointer => {
    const counts = { sqrt: 0, pow: 0 }, math = Object.create(Math);
    for (const name of ["sqrt", "pow"]) math[name] = (...args) => { counts[name]++; return Math[name](...args); };
    const h = harness({ cached: [["a", cloud]], math, originalPointer }), cleanup = h.run();
    h.c.musicAudioRef.current = { paused: false, currentTime: 42 }; h.draw();
    counts.sqrt = 0; counts.pow = 0;
    for (let i = 0; i < 30; i++) {
      Object.assign(h.c.nowPointerRef.current, { x: Math.sin(i * .1) * .3, y: Math.cos(i * .1) * .3 });
      h.draw(1016 + i * 16);
    }
    cleanup(); return { counts, paints: h.calls.fill };
  };
  const before = measured(true), after = measured(false);
  assert.equal(after.paints, before.paints);
  assert.equal(after.counts.sqrt, 30, "Only one fixed stride square root per frame remains");
  assert.equal(after.counts.pow, 30, "Only the existing frame-level choreography power remains");
  assert.ok(before.counts.sqrt > 10000 && before.counts.pow > 10000);
  t.diagnostic(`${count} points x 30 moving-pointer frames: sqrt ${before.counts.sqrt} -> ${after.counts.sqrt}; pow ${before.counts.pow} -> ${after.counts.pow}; paints ${before.paints} unchanged`);
});

test("high-rate pointer input does not repaint the hidden home or write background styles between frames", () => {
  const h = harness({ cached: [["a", points()]] });
  const homeStyles = [], sceneStyles = new Map();
  h.c.nowPlayingEdge = null; h.c.edgeIntentRef = { current: { zone: null, timer: null } };
  h.c.rootRef = { current: { style: { setProperty: (...args) => homeStyles.push(args) } } };
  h.c.window.innerHeight = 800;
  const style = h.c.nowStageRef.current.style.setProperty;
  h.c.nowStageRef.current.style.setProperty = (key, value) => { style(key, value); sceneStyles.set(key, value); };
  const move = handler("handleNowPointerMove", h.c), home = handler("handleParallax", h.c);
  const cleanup = h.run(); h.draw(); const before = h.calls.pointerStyles;
  const currentTarget = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) };
  for (let i = 0; i < 1000; i++) {
    const event = { clientX: 500 + i / 10, clientY: 380 + i / 100, currentTarget };
    move(event); home(event);
  }
  assert.equal(h.calls.pointerStyles, before); assert.equal(homeStyles.length, 0);
  assert.equal(h.frames.size, 1, "Input must not schedule its own competing loop");
  h.draw(1100); assert.equal(h.calls.pointerStyles, before + 2);
  assert.equal(sceneStyles.get("--np-x"), `${h.c.nowPointerRef.current.x * 18}px`);
  assert.equal(sceneStyles.get("--np-y"), `${h.c.nowPointerRef.current.y * 14}px`);
  h.draw(1116); assert.equal(h.calls.pointerStyles, before + 2, "No style churn when the input is unchanged");
  h.c.nowPlayingOpen = false; home({ clientX: 600, clientY: 400 });
  assert.equal(homeStyles.length, 4, "The visible home keeps its original pointer parallax");
  cleanup();
});
