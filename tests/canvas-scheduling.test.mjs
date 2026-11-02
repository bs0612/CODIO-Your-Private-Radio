import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run the actual production effects with isolated Canvas/visibility/rAF. This
// measures scheduled work, not physical compositor/GPU frame time or QQ audio.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = [];
const effectDependencies = new Map();
(function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") {
    const code = node.arguments[0].getText(ast);
    effects.push(code);
    effectDependencies.set(code, node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) ? node.arguments[1].elements.map(element => element.getText(ast)) : []);
  }
  ts.forEachChild(node, visit);
})(ast);
function productionEffect(marker, context) {
  const found = effects.filter(code => code.includes(marker));
  assert.equal(found.length, 1, `Exactly one production effect must contain ${marker}`);
  const js = ts.transpileModule(`const effect = ${found[0]}; return effect;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function("context", `with(context){${js}}`)(context)();
}

function harness() {
  const frames = new Map(), documentListeners = new Map(), windowListeners = new Map(), observers = [];
  let nextFrame = 0;
  const add = (map, name, callback) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(callback);
  };
  const remove = (map, name, callback) => map.get(name)?.delete(callback);
  const emit = (map, name) => [...(map.get(name) || [])].forEach(callback => callback());
  function canvas(width = 800, height = 20) {
    const calls = { context: 0, clear: 0, stroke: 0, fill: 0, copy: 0, clips: [], paths: [] };
    const ctx = {
      setTransform() {}, clearRect() { calls.clear++; }, beginPath() {}, arc() {},
      fill() { calls.fill++; }, moveTo() {}, lineTo() {}, save() {}, restore() {}, clip() {},
      rect(x, y, width, height) { calls.clips.push({ x, y, width, height }); },
      stroke(path) { calls.stroke++; if (path) calls.paths.push(path.points); },
      drawImage() { calls.copy++; },
    };
    return { calls, clientWidth: width, clientHeight: height, width, height, getContext: () => { calls.context++; return ctx; } };
  }
  const home = canvas(1200, 800), main = canvas(), now = canvas();
  const context = {
    visualActiveRef: { current: true },
    document: {
      hidden: false,
      addEventListener: (name, callback) => add(documentListeners, name, callback),
      removeEventListener: (name, callback) => remove(documentListeners, name, callback),
    },
    window: {
      devicePixelRatio: 1,
      requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
      cancelAnimationFrame(id) { frames.delete(id); },
      addEventListener: (name, callback) => add(windowListeners, name, callback),
      removeEventListener: (name, callback) => remove(windowListeners, name, callback),
    },
    Path2D: class {
      points = [];
      moveTo(x, y) { this.points.push([x, y]); }
      lineTo(x, y) { this.points.push([x, y]); }
    },
    ResizeObserver: class {
      observed = []; disconnected = false;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(item) { this.observed.push(item); }
      disconnect() { this.disconnected = true; }
    },
    canvasRef: { current: home }, nowPlayingOpen: false, bootPhase: "done", particleLevel: 0, reducedMotion: true,
    homeCanvasResumeRef: { current: () => {} }, homeCanvasPaintedRef: { current: false },
    bootPhaseRef: { get current() { return context.bootPhase; } },
    setBootHomeFrameReady(value) { context.bootHomeFrameReady = value; },
    progressWaveRef: { current: main }, nowProgressWaveRef: { current: now },
    activeQQTrack: { mid: "current-id" }, currentTrack: { title: "not-the-analysis-key" },
    displayedWaveformRef: { current: Array(96).fill(.2) },
    initialWaveformRef: { current: { trackId: "", waveform: [] } },
    trackAnalysisRef: { current: new Map([["current-id", { waveform: Array(96).fill(.2) }]]) },
    progressValueRef: { current: 10 }, activeTransitionRef: { current: null }, transitionVisualFrameRef: { current: null },
  };
  function step() {
    const entry = frames.entries().next().value;
    assert.ok(entry, "Production effect must have scheduled an animation frame");
    frames.delete(entry[0]); entry[1](nextFrame * 16);
  }
  return {
    context, home, main, now, frames, observers, documentListeners, windowListeners, step,
    homeEffect: () => productionEffect("const canvas = canvasRef.current;", context),
    waveEffect: () => productionEffect("const canvas = nowPlayingOpen ? nowProgressWaveRef.current", context),
    visibility(hidden) { context.document.hidden = hidden; emit(documentListeners, "visibilitychange"); },
    resize() { observers.forEach(observer => { if (!observer.disconnected) observer.callback(); }); },
    focus(active) { context.visualActiveRef.current = active; emit(windowListeners, active ? "focus" : "blur"); },
  };
}

test("Now Playing still suppresses the covered home canvas", () => {
  for (const [bootPhase, nowPlayingOpen] of [["playing", true], ["done", true]]) {
    const h = harness(); Object.assign(h.context, { bootPhase, nowPlayingOpen });
    assert.equal(h.homeEffect(), undefined);
    assert.equal(h.home.calls.clear, 1, "Clear a previously visible background once");
    assert.equal(h.home.calls.fill, 0);
    assert.equal(h.frames.size, 0);
    assert.equal(h.documentListeners.size, 0);
    assert.equal(h.windowListeners.size, 0);
  }
});

test("boot paints one real background frame then resumes the same field on entry", () => {
  const h = harness(); h.context.bootPhase = "playing";
  const cleanup = h.homeEffect();
  assert.equal(h.home.calls.fill,24); assert.equal(h.context.bootHomeFrameReady,true);
  assert.equal(h.frames.size,0,"preparing the home must not start a hidden animation loop");
  const effectCode=effects.find(code=>code.includes("const canvas = canvasRef.current;"));
  assert.ok(!effectDependencies.get(effectCode).includes("bootPhase"),"entry must not recreate the initialized canvas");
  h.context.bootPhase="leaving";
  productionEffect('homeCanvasResumeRef.current();',h.context);
  assert.equal(h.home.calls.fill,48);assert.equal(h.frames.size,1);
  h.context.bootPhase="done";h.step();assert.equal(h.home.calls.fill,72);
  cleanup();assert.equal(h.frames.size,0);
  h.context.homeCanvasResumeRef.current();assert.equal(h.frames.size,0,"unmount removes the resume callback");
});

test("visible home background resumes after visibility and disposes frames/listeners", () => {
  const h = harness(), cleanup = h.homeEffect();
  assert.equal(h.home.calls.fill, 24);
  h.step(); assert.equal(h.home.calls.fill, 48);
  h.visibility(true); h.step();
  assert.equal(h.frames.size, 0); assert.equal(h.home.calls.fill, 48);
  h.visibility(false);
  assert.equal(h.home.calls.fill, 72); assert.equal(h.frames.size, 1);
  cleanup();
  assert.equal(h.frames.size, 0);
  assert.equal(h.documentListeners.get("visibilitychange").size, 0);
  assert.equal(h.windowListeners.get("pointermove").size, 0);
  assert.equal(h.windowListeners.get("resize").size, 0);
  h.visibility(false); assert.equal(h.frames.size, 0);
});

test("visible but unfocused home cancels drawing immediately and resumes the same canvas once", () => {
  const h = harness(), cleanup = h.homeEffect();
  h.step(); const paints = h.home.calls.fill;
  h.focus(false);
  assert.equal(h.context.document.hidden, false, "switching applications need not hide the window");
  assert.equal(h.frames.size, 0); assert.equal(h.home.calls.fill, paints);
  h.focus(true); h.focus(true);
  assert.equal(h.frames.size, 1); assert.equal(h.home.calls.fill, paints + 24);
  assert.equal(h.home.calls.context, 1, "resume without rebuilding the canvas");
  cleanup(); h.focus(true); assert.equal(h.frames.size, 0);
  assert.equal(h.windowListeners.get("focus").size, 0); assert.equal(h.windowListeners.get("blur").size, 0);
});

test("an unfocused boot still paints its required static home once without starting a loop", () => {
  const h = harness(); h.context.bootPhase = "playing"; h.context.visualActiveRef.current = false;
  const cleanup = h.homeEffect();
  assert.equal(h.context.bootHomeFrameReady, true); assert.equal(h.home.calls.fill, 24);
  assert.equal(h.frames.size, 0); cleanup();
});

test("the actual activity observer distinguishes app focus from visibility and never pauses media", () => {
  const h=harness();let focused=true,timeUpdates=0;const attributes={};
  h.context.document.hasFocus=()=>focused;
  h.context.rootRef={current:{setAttribute(name,value){attributes[name]=value;}}};
  h.context.musicAudioRef={current:{paused:false,dispatchEvent(event){assert.equal(event.type,"timeupdate");timeUpdates++;}}};
  const cleanup=productionEffect("const updateVisualActivity",h.context);
  assert.equal(attributes["data-visual-active"],"true");assert.equal(timeUpdates,1);
  focused=false;
  for(const callback of h.windowListeners.get("blur"))callback();
  assert.equal(h.context.document.hidden,false);assert.equal(h.context.visualActiveRef.current,false);
  assert.equal(attributes["data-visual-active"],"false");assert.equal(timeUpdates,1);
  h.visibility(true);focused=true;
  for(const callback of h.windowListeners.get("focus"))callback();
  assert.equal(h.context.visualActiveRef.current,false,"hidden windows do not resume visuals just because of a focus event");
  h.visibility(false);assert.equal(timeUpdates,2);assert.equal(h.context.visualActiveRef.current,true);
  assert.equal(h.context.musicAudioRef.current.paused,false);
  cleanup();assert.equal(h.windowListeners.get("focus").size+h.windowListeners.get("blur").size+h.documentListeners.get("visibilitychange").size,0);
});

test("transition text does not re-render unchanged lines or hidden presentation on every 90ms tick",()=>{
  const h=harness();let tick,writes=0,updates=0,cleared=false;
  const runtime={id:"handoff",outgoing:{currentTime:1},incoming:{currentTime:0},
    outgoingSnapshot:{lyrics:[{time:0,text:"out"}]},incomingSnapshot:{lyrics:[{time:0,text:"in"}]}};
  let display={id:runtime.id,outgoing:runtime.outgoingSnapshot,incoming:runtime.incomingSnapshot,outgoingLyric:"",incomingLyric:""};
  Object.assign(h.context,{transitionDisplayId:runtime.id,activeTransitionRef:{current:runtime},
    lyricAtTime:(lines,time)=>lines.reduce((text,line)=>line.time<=time?line.text:text,""),
    getAudiblePlaybackTime:audio=>audio.currentTime,
    setTransitionDisplay(fn){updates++;const next=fn(display);if(next!==display)writes++;display=next;}});
  h.context.window.setInterval=callback=>{tick=callback;return 1;};h.context.window.clearInterval=()=>{cleared=true;};
  const cleanup=productionEffect("if (!transitionDisplayId)",h.context);
  assert.equal(writes,1);
  for(let i=0;i<100;i++)tick();assert.equal(writes,1,"same snapshot and lyric keep the exact React state object");
  const before=updates;h.context.visualActiveRef.current=false;
  runtime.incomingSnapshot.lyrics.push({time:2,text:"next line"});runtime.incoming.currentTime=3;
  for(let i=0;i<100;i++)tick();assert.equal(updates,before,"no background React updates");
  h.context.visualActiveRef.current=true;tick();assert.equal(writes,2);assert.equal(display.incomingLyric,"next line");
  cleanup();assert.equal(cleared,true);
});

function waveHarness(nowPlayingOpen) {
  const h = harness(); h.context.nowPlayingOpen = nowPlayingOpen;
  return { ...h, visible: nowPlayingOpen ? h.now : h.main, hidden: nowPlayingOpen ? h.main : h.now };
}
function assertHiddenUntouched(h) {
  assert.equal(h.hidden.calls.context, 0, "Do not acquire the hidden canvas context");
  assert.equal(h.hidden.calls.clear, 0);
  assert.equal(h.hidden.calls.stroke, 0);
  assert.equal(h.hidden.calls.copy, 0);
  assert.equal(h.visible.calls.copy, 0, "Draw directly rather than copying between bars");
}

for (const nowPlayingOpen of [false, true]) {
  const mode = nowPlayingOpen ? "Now Playing" : "home";
  test(`${mode}: app switch stops all waveform frames and focus resumes the latest progress`, () => {
    const h = waveHarness(nowPlayingOpen), cleanup = h.waveEffect(); h.step();
    h.focus(false); assert.equal(h.frames.size, 0); assert.equal(h.visible.calls.clear, 1);
    h.context.progressValueRef.current = 80;
    h.visibility(false); assert.equal(h.frames.size, 0, "visibility alone cannot wake an unfocused window");
    h.focus(true); h.focus(true); assert.equal(h.frames.size, 1); h.step();
    assert.equal(h.visible.calls.clips.at(-1).width, 640); assertHiddenUntouched(h);
    cleanup(); h.focus(true); assert.equal(h.frames.size, 0);
  });
  test(`${mode}: settled paused waveform paints only its visible bar once`, () => {
    const h = waveHarness(nowPlayingOpen), cleanup = h.waveEffect(); h.step();
    assert.equal(h.visible.calls.clear, 1);
    const strokes = h.visible.calls.stroke;
    for (let i = 0; i < 120; i++) h.step();
    assert.equal(h.visible.calls.clear, 1); assert.equal(h.visible.calls.stroke, strokes);
    assertHiddenUntouched(h);
    assert.equal(h.frames.size, 1, "Keep one lightweight frame to notice real time/shape changes");
    cleanup(); assert.equal(h.frames.size, 0);
  });

  test(`${mode}: real progress and current-ID analysis repaint only the visible bar`, () => {
    const h = waveHarness(nowPlayingOpen), cleanup = h.waveEffect(); h.step();
    h.context.progressValueRef.current = 35; h.step();
    assert.equal(h.visible.calls.clear, 2);
    assert.equal(h.visible.calls.clips.at(-1).width, h.visible.clientWidth * .35);
    h.step(); assert.equal(h.visible.calls.clear, 2, "Unchanged playhead does not invalidate glass");
    h.context.trackAnalysisRef.current.set("not-the-analysis-key", { waveform: Array(96).fill(1) });
    h.step(); assert.equal(h.visible.calls.clear, 2, "Song title cannot override a reliable current song ID");
    h.context.trackAnalysisRef.current.set("current-id", { waveform: Array(96).fill(.8) }); h.step();
    assert.equal(h.visible.calls.clear, 3);
    assert.ok(h.context.displayedWaveformRef.current.every(value => value > .2 && value < .8), "Keep the existing smooth measured-waveform interpolation");
    for (let i = 0; i < 1000; i++) h.step();
    const settled = h.visible.calls.clear; h.step();
    assert.equal(h.visible.calls.clear, settled, "Stop repainting once the incoming waveform has converged");
    assertHiddenUntouched(h); cleanup();
  });

  test(`${mode}: active transition uses both real Deck playheads without hidden paint`, () => {
    const h = waveHarness(nowPlayingOpen), cleanup = h.waveEffect(); h.step();
    const runtime = {
      outgoing: { currentTime: 90 }, incoming: { currentTime: 2 },
      outgoingSnapshot: { analysis: { waveform: Array(96).fill(.2), effectiveEnd: 100 } },
      incomingSnapshot: { analysis: { waveform: Array(96).fill(.8), effectiveEnd: 200 } },
    };
    h.context.activeTransitionRef.current = runtime;
    h.context.transitionVisualFrameRef.current = { waveformMix: .5, outgoingWeight: .7, incomingWeight: .3 };
    h.step();
    assert.equal(h.visible.calls.clear, 2);
    assert.deepEqual(h.visible.calls.clips.slice(-2).map(clip => clip.width), [720, 8]);
    runtime.incoming.currentTime = 4; h.step();
    assert.equal(h.visible.calls.clear, 3); assert.equal(h.visible.calls.clips.at(-1).width, 16);
    assertHiddenUntouched(h); cleanup();
  });

  test(`${mode}: resize observes and sizes only the visible bar at bounded DPR`, () => {
    const h = waveHarness(nowPlayingOpen); h.context.window.devicePixelRatio = 3;
    const cleanup = h.waveEffect(); h.step(); h.step();
    assert.deepEqual(h.observers[0].observed, [h.visible]);
    h.visible.clientWidth = 1000; h.visible.clientHeight = 24;
    h.hidden.clientWidth = 1100; h.hidden.clientHeight = 25; h.resize();
    assert.equal(h.visible.width, 2000); assert.equal(h.visible.height, 48);
    assert.equal(h.hidden.width, 800); assert.equal(h.hidden.height, 20, "Do not reset a hidden backing store");
    assert.equal(h.visible.calls.clear, 1, "Measure once; leave paint for the next scheduled frame");
    h.step(); assert.equal(h.visible.calls.clear, 2);
    assert.equal(h.visible.calls.clips.at(-1).width, 100);
    h.step(); assert.equal(h.visible.calls.clear, 2);
    assertHiddenUntouched(h); cleanup(); assert.equal(h.observers[0].disconnected, true);
  });

  test(`${mode}: background stops frames then resumes latest real progress exactly once`, () => {
    const h = waveHarness(nowPlayingOpen), cleanup = h.waveEffect(); h.step();
    h.visibility(true); h.step();
    assert.equal(h.frames.size, 0); assert.equal(h.visible.calls.clear, 1);
    h.context.progressValueRef.current = 40;
    h.visibility(false); h.visibility(false);
    assert.equal(h.frames.size, 1); h.step();
    assert.equal(h.visible.calls.clear, 2);
    assert.equal(h.visible.calls.clips.at(-1).width, 320);
    assertHiddenUntouched(h); cleanup();
    assert.equal(h.frames.size, 0); assert.equal(h.documentListeners.get("visibilitychange").size, 0);
    assert.equal(h.observers[0].disconnected, true);
    h.visibility(false); assert.equal(h.frames.size, 0);
  });

  test(`${mode}: missing analysis stays neutral and never draws the hidden bar`, () => {
    const h = waveHarness(nowPlayingOpen); h.context.trackAnalysisRef.current.clear(); h.context.displayedWaveformRef.current = [];
    const cleanup = h.waveEffect(); h.step();
    assert.deepEqual(h.context.displayedWaveformRef.current, Array(96).fill(0));
    assert.equal(new Set(h.visible.calls.paths[0].map(point => point[1])).size, 1);
    for (let i = 0; i < 40; i++) h.step();
    assert.equal(h.visible.calls.clear, 1); assertHiddenUntouched(h); cleanup();
  });
}

test("layout switches retire old loops and draw latest shared progress/shape on the new visible canvas", () => {
  const effect = effects.find(code => code.includes("const canvas = nowPlayingOpen ? nowProgressWaveRef.current"));
  assert.ok(effectDependencies.get(effect).includes("nowPlayingOpen"), "React must restart this effect on actual layout visibility changes");
  const h = harness(), sharedShape = h.context.displayedWaveformRef.current;
  let cleanup = h.waveEffect(); h.step();
  assert.equal(h.main.calls.clear, 1); assert.equal(h.now.calls.context, 0);
  for (const open of [true, false, true, false]) {
    cleanup();
    assert.equal(h.frames.size, 0); assert.equal(h.documentListeners.get("visibilitychange").size, 0);
    h.context.nowPlayingOpen = open; h.context.progressValueRef.current += 10;
    const visible = open ? h.now : h.main, hidden = open ? h.main : h.now;
    const hiddenBefore = { ...hidden.calls }, previousPaints = visible.calls.clear;
    cleanup = h.waveEffect();
    assert.equal(h.frames.size, 1); h.step();
    assert.equal(visible.calls.clear, previousPaints + 1);
    assert.equal(visible.calls.clips.at(-1).width, visible.clientWidth * h.context.progressValueRef.current / 100);
    assert.deepEqual(hidden.calls, hiddenBefore);
    assert.strictEqual(h.context.displayedWaveformRef.current, sharedShape, "Do not restart waveform interpolation when a panel opens");
    assert.equal(h.frames.size, 1); assert.equal(h.documentListeners.get("visibilitychange").size, 1);
    assert.equal(h.main.calls.copy + h.now.calls.copy, 0);
  }
  cleanup();
  assert.ok(h.observers.every(observer => observer.disconnected));
  assert.equal(h.frames.size, 0);
});

test("a prepared real initial waveform is drawn fully on the first frame, not eased up from a flat placeholder",()=>{
  const h=waveHarness(false);h.context.trackAnalysisRef.current.clear();
  const waveform=Array.from({length:96},(_,i)=>(i%12)/12);
  h.context.initialWaveformRef.current={trackId:"current-id",waveform};h.context.displayedWaveformRef.current=[];
  const cleanup=h.waveEffect();h.step();
  assert.equal(h.context.displayedWaveformRef.current.length,waveform.length);
  h.context.displayedWaveformRef.current.forEach((value,index)=>assert.ok(Math.abs(value-waveform[index])<1e-12,
    `First-frame amplitude ${index} must match the prepared curve, allowing only interpolation roundoff`));
  assert.ok(new Set(h.visible.calls.paths[0].map(point=>point[1])).size>5);
  assertHiddenUntouched(h);cleanup();
});

test("an empty analysis waveform cannot mask an already prepared real curve", () => {
  const h=waveHarness(false),wave=Array.from({length:96},(_,i)=>(i%12)/12);
  h.context.trackAnalysisRef.current.set("current-id",{waveform:[]});
  h.context.initialWaveformRef.current={trackId:"current-id",waveform:wave};h.context.displayedWaveformRef.current=[];
  const cleanup=h.waveEffect();h.step();
  h.context.displayedWaveformRef.current.forEach((value,index)=>assert.ok(Math.abs(value-wave[index])<1e-12));
  assert.ok(new Set(h.visible.calls.paths[0].map(point=>point[1])).size>5);cleanup();
});

test("missing visible canvas does not fall back to painting an invisible bar", () => {
  for (const open of [false, true]) {
    const h = waveHarness(open);
    if (open) h.context.nowProgressWaveRef.current = null;
    else h.context.progressWaveRef.current = null;
    assert.equal(h.waveEffect(), undefined);
    assert.equal(h.hidden.calls.context, 0); assert.equal(h.hidden.calls.clear, 0);
    assert.equal(h.frames.size, 0); assert.equal(h.observers.length, 0);
  }
});
