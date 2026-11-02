import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run the renderer's actual queue handlers with a simulated audio/QQ bridge.
// No QQ account, localStorage, or saved listening history is touched.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlerNames = ["selectQQTrack", "enqueueNext", "nextTrack", "advanceFromFinishedAudio"];
const declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && [...handlerNames, "transitionToTrack"].includes(node.name.text)) {
    declarations.set(node.name.text, node.getText(ast));
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "commitIncoming") {
    declarations.set("commitIncoming", node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of [...handlerNames, "commitIncoming", "transitionToTrack"]) assert.ok(declarations.has(name), `Missing renderer handler: ${name}`);
const handlersJs = ts.transpileModule(handlerNames.map((name) => declarations.get(name)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const bindHandlers = new Function("context", `with (context) { ${handlersJs}\nreturn { ${handlerNames.join(", ")} }; }`);
const commitJs = ts.transpileModule(`const commitIncoming = ${declarations.get("commitIncoming")};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const bindCommit = new Function("context", `with (context) { ${commitJs}\nreturn commitIncoming; }`);
const transitionJs = ts.transpileModule(declarations.get("transitionToTrack"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const bindTransition = new Function("context", `with (context) { ${transitionJs.replace(/catch\s*\{/, "catch (error) { context.transitionError = error;")}\nreturn transitionToTrack; }`);

const track = (mid) => ({ id: mid, mid, title: mid, artist: "test", durationSeconds: 2, cover: "" });
const audioFor = (item, paused = false) => ({ src: `test://${item.mid}`, paused, ended: false });

function harness({ active = null, live = active, queue = [], search = [], recommendations = [], extension = [], extensionGate = null, unavailable = [], transitioningTo = null, automaticPending = false } = {}) {
  let activeQQTrack = active;
  let playQueue = [...queue];
  let activeQueueIndex = live ? queue.findIndex((item) => item.mid === live.mid) : -1;
  let isPlaying = Boolean(live);
  let toast = "";
  const calls = [];
  const unavailableIds = new Set(unavailable.map((item) => item.mid));
  const playQueueRef = { current: playQueue };
  const activeQueueIndexRef = { current: activeQueueIndex };
  const activeQQTrackLiveRef = { current: live };
  const musicAudioRef = { current: live ? audioFor(live) : null };
  const seamlessTransitionRef = { current: Boolean(transitioningTo || automaticPending) };
  const activeTransitionRef = { current: transitioningTo ? { incomingSnapshot: { track: transitioningTo } } : null };
  const userPausedRef = { current: false };
  const pendingAdvanceRef = { current: false };
  const advancingRef = { current: false };
  const context = {
    recommendationIdentity: item => `qq:${item.mid || item.id}`,
    playbackRequestRef: { current: null },
    manualQueueIdsRef: { current: new Set() },
    initialRecommendationRef: { current: false },
    activeQQTrackLiveRef, musicAudioRef, playQueueRef, activeQueueIndexRef, activeTransitionRef,
    seamlessTransitionRef, pendingAdvanceRef, advancingRef, userPausedRef,
    manualSelectionRef: { current: null }, seamlessAttemptedRef: { current: automaticPending ? live?.mid : null },
    preparedTracksRef: { current: new Map() }, failedTracksRef: { current: new Map() },
    recommendationTracks: Object.fromEntries(recommendations.map((item) => [item.mid, item])),
    searchResults: search,
    get activeQQTrack() { return activeQQTrack; },
    get isPlaying() { return isPlaying; },
    setPlayQueue(next) { playQueue = next; },
    setActiveQueueIndex(next) { activeQueueIndex = next; },
    setIsPlaying(next) { isPlaying = next; },
    setToast(next) { toast = next; },
    notifySystem() {},
    setSearchOpen() {}, setSearchQuery() {}, setProgress() {}, setTrackIndex() {},
    tracks: [],
    prepareUpcomingTrack(item) { calls.push(["prepare", item]); },
    async togglePlayback() { calls.push(["toggle"]); musicAudioRef.current.paused = !musicAudioRef.current.paused; isPlaying = !musicAudioRef.current.paused; },
    async startQQTrack(item) {
      calls.push(["start", item.mid]);
      if (unavailableIds.has(item.mid)) return "unavailable";
      activeQQTrack = item;
      activeQQTrackLiveRef.current = item;
      musicAudioRef.current = audioFor(item);
      isPlaying = true;
      return "played";
    },
    async transitionToTrack(item) {
      calls.push(["transition", item.mid]);
      if (unavailableIds.has(item.mid)) return "unavailable";
      // The real transitionToTrack pauses its incoming deck when outgoing.paused.
      const paused = musicAudioRef.current?.paused ?? true;
      activeQQTrack = item;
      activeQQTrackLiveRef.current = item;
      musicAudioRef.current = audioFor(item, paused);
      isPlaying = !paused;
      return "played";
    },
    async extendRecommendationQueue() {
      calls.push(["extend"]);
      if (extensionGate) await extensionGate;
      const known = new Set(playQueueRef.current.map((item) => item.mid));
      const expanded = [...playQueueRef.current, ...extension.filter((item) => !known.has(item.mid))];
      playQueueRef.current = expanded;
      playQueue = expanded;
      return expanded;
    },
    withTimeout(promise, timeout, label) { calls.push(["timeout", label, timeout]); return promise; },
  };
  const handlers = bindHandlers(context);
  function signalEnded() {
    const outgoing = musicAudioRef.current;
    assert.ok(outgoing);
    outgoing.paused = true;
    outgoing.ended = true;
    handlers.advanceFromFinishedAudio(outgoing);
  }
  async function waitForAdvance() {
    for (let attempt = 0; attempt < 20 && advancingRef.current; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(advancingRef.current, false, "advance must settle");
  }
  async function finishCurrent() { signalEnded(); await waitForAdvance(); }
  return {
    handlers, signalEnded, waitForAdvance, finishCurrent, calls,
    current: () => activeQQTrack,
    audio: () => musicAudioRef.current,
    queue: () => playQueueRef.current,
    index: () => activeQueueIndexRef.current,
    playing: () => isPlaying,
    toast: () => toast,
    seamlessTransitionRef, pendingAdvanceRef, userPausedRef,
  };
}

test("selecting the current paused search song really resumes media before reporting success", async () => {
  const song=track("same-paused"),h=harness({active:song,queue:[song],search:[song]});
  h.audio().paused=true;
  assert.equal(await h.handlers.selectQQTrack(song),true);
  assert.equal(h.audio().paused,false);assert.equal(h.playing(),true);
  assert.equal(h.calls.filter(x=>x[0]==="toggle").length,1);
});

function transitionHarness({ endDuringPrepare = false, pauseDuringPrepare = false } = {}) {
  const outgoingTrack = track("outgoing");
  const next = track("incoming");
  let incomingPlayCalls = 0;
  let fallbackCalls = 0;
  let playingState = null;
  const outgoing = { ...audioFor(outgoingTrack), currentTime: 8, duration: 10, readyState: 1, playbackRate: 1, volume: 1, dataset: {} };
  const incoming = {
    ...audioFor(next, true), currentTime: 0, duration: 10, readyState: 1, playbackRate: 1, volume: 0, dataset: {},
    async play() { incomingPlayCalls += 1; this.paused = false; },
    pause() { this.paused = true; },
  };
  const analysis = { effectiveStart: 0, effectiveEnd: 10, bpm: 120, beatOffset: 0 };
  const plan = {
    id: "plan", strategy: "downbeat-cut", confidence: .8, incomingCue: 0,
    incomingTempoRatio: 1, outgoingTempoRatio: 1, transitionDuration: 1, switchPoint: .5,
    incomingGainCurve: [.18, 1], incomingLowCurve: [0, 1], incomingMidCurve: [.82, 1], incomingHighCurve: [.88, 1],
  };
  const parameter = () => ({ value: 1, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; }, setTargetAtTime() {}, linearRampToValueAtTime() {} });
  const chain = { analyser: {}, gain: { gain: parameter() }, lowEq: { gain: parameter() }, midEq: { gain: parameter() }, highEq: { gain: parameter() } };
  const activeTransitionRef = { current: null };
  const musicAudioRef = { current: outgoing };
  const activeQQTrackLiveRef = { current: outgoingTrack };
  const userPausedRef = { current: false };
  let display = null;
  const displays = [];
  const lyricWrites = [];
  const context = {
    get isPlaying() { return false; }, // Deliberately stale React state from the audio handler's render.
    window: { codioDesktop: { qqMusic: { lyrics: async () => [] } }, setTimeout() {} },
    musicAudioRef, activeQQTrackLiveRef, activeTransitionRef, pendingTransitionAudioRef: { current: null }, userPausedRef,
    activeQueueIndexRef: { current: 0 }, playQueueRef: { current: [outgoingTrack, next] },
    seamlessTransitionRef: { current: false }, seamlessAttemptedRef: { current: outgoingTrack.mid },
    pendingAdvanceRef: { current: false }, transitionRequestRef: { current: 0 },
    transitionSequenceRef: { current: 0 }, playbackFadeRef: { current: 0 },
    preparedTracksRef: { current: new Map() }, transitionPlansRef: { current: new Map([["outgoing→incoming", plan]]) },
    trackAnalysisRef: { current: new Map([[outgoingTrack.mid, analysis], [next.mid, analysis]]) },
    audioContextRef: { current: { currentTime: 1 } }, analyserRef: { current: null },
    analyserNodesRef: { current: new WeakMap([[outgoing, chain]]) },
    currentCoverDataLiveRef: { current: "" }, lyricLines: [{ time: 0, text: "stale closure" }],
    lyricLinesLiveRef: { current: { trackId: outgoingTrack.mid, lines: [{ time: 7, text: "current live lyric" }] } },
    async resumeMusicAudioGraph() { return true; },
    analysisForAudio(mid) { return context.trackAnalysisRef.current.get(mid) || null; },
    planSilenceHandoff() { return null; },
    planTransition() { return plan; },
    setBoundedCache(cache, key, value) { cache.set(key, value); },
    armPlaybackBoundaryCheck() {},
    async prepareTrack() {
      if (endDuringPrepare) { outgoing.ended = true; outgoing.paused = true; outgoing.currentTime = 10; }
      if (pauseDuringPrepare) { userPausedRef.current = true; outgoing.paused = true; }
      return { playback: { url: "test://incoming", quality: "QQ MUSIC" }, audio: incoming, coverData: "" };
    },
    withTimeout(promise) { return promise; },
    transitionPairKey(a, b) { return `${a}→${b}`; },
    isTransitionPlanUsable() { return true; },
    adaptTransitionPlan(value) { return value; },
    connectMusicAnalyser() { return chain; }, transitionSettlingDuration() { return .5; },
    wireMusicAudio() {}, scheduleDeckPlan() {}, holdAudioParam() {}, holdTransitionDuringSettling() {},
    lyricAtTime(lines, time) { return lines.reduce((text, line) => line.time <= time ? line.text : text, ""); },
    startTransitionCoordinator(_runtime, commit) { commit(); },
    async waitForTransitionAudioEnd() {},
    stopTransitionCoordinator() {}, releaseMusicAudio() {}, relaxPlaybackRate() {}, prepareUpcomingTrack() {},
    advanceFromFinishedAudio() { fallbackCalls += 1; },
    notifySystem() {}, settleCurrentListening() {}, rememberPlayedTrack() {}, beginListeningForTrack() {},
    recommendationSourceForTrack() { return "queue"; },
    setTransitionDisplay(value) {
      display = typeof value === "function" ? value(display) : value;
      if (display) displays.push(display);
    },
    setActiveQueueIndex() {}, setActiveQQTrack() {}, setCurrentCoverData() {}, setPlaybackQuality() {},
    setProgress() {}, setPlaybackTime() {}, setLyricLines(value) { lyricWrites.push(value); }, setIsPlaying(value) { playingState = value; },
  };
  return {
    run: () => bindTransition(context)(next, 1, "automatic", outgoingTrack.mid),
    incoming, current: () => activeQQTrackLiveRef.current,
    incomingPlayCalls: () => incomingPlayCalls,
    fallbackCalls: () => fallbackCalls,
    playingState: () => playingState,
    failure: () => context.transitionError,
    context, initialDisplay: () => displays[0], lyricWrites,
  };
}

test("search direct play continues from the selected queue position while the app is in the background", async () => {
  const [old, chosen, following, recommended] = ["old", "chosen", "following", "recommended"].map(track);
  const h = harness({ active: old, queue: [old], search: [chosen, following], recommendations: [recommended] });
  await h.handlers.selectQQTrack(chosen);
  assert.deepEqual(h.queue().map((item) => item.mid), ["old", "chosen", "following", "recommended"]);
  assert.equal(h.index(), 1);
  // No visibility-dependent callback: audio ended must work while hidden too.
  await h.finishCurrent();
  assert.equal(h.current()?.mid, "following");
  assert.equal(h.index(), 2);
  assert.equal(h.audio()?.paused, false);
  assert.equal(h.playing(), true);
});

test("NEXT never switches or resumes a paused, ended or not-yet-sourced current deck", async () => {
  for (const state of [{paused:true},{ended:true},{src:""}]) {
    const [current, requested, later] = ["current", "requested", "later"].map(track);
    const h = harness({active:current,queue:[current,later]});
    Object.assign(h.audio(), state);
    await h.handlers.enqueueNext(requested);
    assert.deepEqual(h.queue().map(item => item.mid), ["current","requested","later"]);
    assert.equal(h.current().mid, current.mid); assert.equal(h.index(), 0);
    assert.ok(!h.calls.some(([kind]) => ["start","transition","toggle"].includes(kind)));
    for (const [key,value] of Object.entries(state)) assert.equal(h.audio()[key], value);
  }
});

test("NEXT on an empty player only enqueues, without creating playback or consuming the first slot", async () => {
  const h=harness(),requested=track("requested");
  await h.handlers.enqueueNext(requested);
  assert.deepEqual(h.queue().map(item => item.mid), [requested.mid]);
  assert.equal(h.current(), null); assert.equal(h.audio(), null); assert.equal(h.index(), -1);
  assert.ok(!h.calls.some(([kind]) => ["start","transition","toggle"].includes(kind)));
});

test("Add Next stays directly after the current track and starts on natural end", async () => {
  const [current, requested, later] = ["current", "requested", "later"].map(track);
  const h = harness({ active: current, queue: [current, later] });
  await h.handlers.enqueueNext(requested);
  assert.deepEqual(h.queue().map((item) => item.mid), ["current", "requested", "later"]);
  assert.equal(h.index(), 0);
  await h.finishCurrent();
  assert.equal(h.current()?.mid, "requested");
  assert.equal(h.index(), 1);
  assert.equal(h.audio()?.paused, false);
});

test("Add Next follows the live deck when React still shows the outgoing song", async () => {
  const [outgoing, incoming, later, requested] = ["outgoing", "incoming", "later", "requested"].map(track);
  const h = harness({ active: outgoing, live: incoming, queue: [outgoing, incoming, later] });
  await h.handlers.enqueueNext(requested);
  assert.deepEqual(h.queue().map((item) => item.mid), ["outgoing", "incoming", "requested", "later"]);
  assert.equal(h.current()?.mid, "outgoing", "React state is deliberately stale in this fixture");
  assert.equal(h.index(), 1);
});

test("Add Next during a seamless handoff stays behind the incoming song", async () => {
  const [outgoing, incoming, later, requested] = ["outgoing", "incoming", "later", "requested"].map(track);
  for (const options of [{ transitioningTo: incoming }, { automaticPending: true }]) {
    const h = harness({ active: outgoing, queue: [outgoing, incoming, later], ...options });
    await h.handlers.enqueueNext(requested);
    assert.deepEqual(h.queue().map((item) => item.mid), ["outgoing", "incoming", "requested", "later"]);
    assert.equal(h.index(), 0, "the outgoing live deck keeps its index until handoff commits");
  }
});

test("transition commit relocates its queue index after a concurrent insert", () => {
  const [outgoing, inserted, incoming, later] = ["outgoing", "inserted", "incoming", "later"].map(track);
  const queue = [outgoing, inserted, incoming, later];
  const runtime = { committed: false, state: "mixing", incomingSnapshot: { lyrics: [] } };
  const activeQueueIndexRef = { current: 0 };
  const activeQQTrackLiveRef = { current: outgoing };
  const context = {
    runtime, transitionId: "handoff", activeTransitionRef: { current: { id: "handoff" } },
    reason: "automatic", next: incoming, nextIndex: 1,
    musicAudioRef: { current: audioFor(outgoing) }, analyserRef: { current: null },
    incoming: { currentTime: 2 }, incomingChain: { analyser: {} },
    activeQQTrackLiveRef, currentCoverDataLiveRef: { current: "" },
    lyricLinesLiveRef: { current: { trackId: outgoing.mid, lines: [{ time: 0, text: "outgoing lyric" }] } },
    playQueueRef: { current: queue }, activeQueueIndexRef,
    prepared: { coverData: "", playback: { quality: "QQ MUSIC" } },
    incomingSnapshotAnalysis: { effectiveEnd: 120 }, wasPlaying: true,
    seamlessAttemptedRef: { current: outgoing.mid },
    settleCurrentListening() {}, setActiveQueueIndex() {}, setActiveQQTrack() {},
    setCurrentCoverData() {}, setPlaybackQuality() {}, setProgress() {},
    setPlaybackTime() {}, setLyricLines() {}, setIsPlaying() {},
    rememberPlayedTrack() {}, beginListeningForTrack() {}, recommendationSourceForTrack() { return "queue"; },
    armPlaybackBoundaryCheck() {}, record() {}, outgoingSnapshotAnalysis: { effectiveEnd: 180 },
  };
  bindCommit(context)();
  assert.equal(activeQQTrackLiveRef.current.mid, "incoming");
  assert.equal(activeQueueIndexRef.current, 2);
  assert.equal(queue[activeQueueIndexRef.current].mid, "incoming");
  assert.equal(context.lyricLinesLiveRef.current.trackId, "incoming");
  assert.deepEqual(context.lyricLinesLiveRef.current.lines, runtime.incomingSnapshot.lyrics);
});

test("automatic transition snapshots live outgoing lyrics rather than stale render lyrics", async () => {
  const h = transitionHarness();
  assert.equal(await h.run(), "played");
  assert.deepEqual(h.initialDisplay().outgoing.lyrics, [{ time: 7, text: "current live lyric" }]);
  assert.equal(h.initialDisplay().outgoingLyric, "current live lyric");
  assert.equal(h.context.lyricLinesLiveRef.current.trackId, "incoming");
});

test("automatic transition rejects outgoing lyrics belonging to a different track identity", async () => {
  const h = transitionHarness();
  h.context.lyricLinesLiveRef.current = { trackId: "older-track", lines: [{ time: 0, text: "foreign lyric" }] };
  assert.equal(await h.run(), "played");
  assert.deepEqual(h.initialDisplay().outgoing.lyrics, []);
  assert.equal(h.initialDisplay().outgoingLyric, "");
});

test("incoming lyrics arriving after deck commit immediately reach the authoritative lyric clock", async () => {
  const h = transitionHarness(); let lyricsReady, transitionReady;
  const lyrics = new Promise(resolve => { lyricsReady = resolve; });
  const waiting = new Promise(resolve => { transitionReady = resolve; });
  h.context.window.codioDesktop.qqMusic.lyrics = () => lyrics;
  h.context.waitForTransitionAudioEnd = () => waiting;
  const turn = h.run();
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(h.context.activeTransitionRef.current.committed, true);
  assert.equal(h.context.lyricLinesLiveRef.current.trackId, "incoming");
  assert.deepEqual(h.context.lyricLinesLiveRef.current.lines, []);
  const lines = [{ time: .8, text: "the actual incoming lyric" }];
  lyricsReady(lines); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.context.lyricLinesLiveRef.current, { trackId: "incoming", lines });
  assert.deepEqual(h.lyricWrites.at(-1), lines, "no second normal-load request is needed to publish these cues");
  transitionReady(); assert.equal(await turn, "played");
});

test("late incoming lyrics cannot publish to a superseding same-id runtime or another selected song", async () => {
  for (const replacement of ["same-id-runtime", "different-song"]) {
    const h = transitionHarness(); let lyricsReady, transitionReady;
    const lyrics = new Promise(resolve => { lyricsReady = resolve; });
    const waiting = new Promise(resolve => { transitionReady = resolve; });
    h.context.window.codioDesktop.qqMusic.lyrics = () => lyrics;
    h.context.waitForTransitionAudioEnd = () => waiting;
    const turn = h.run();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    assert.equal(h.context.activeTransitionRef.current.committed, true);
    if (replacement === "same-id-runtime") h.context.activeTransitionRef.current = { ...h.context.activeTransitionRef.current };
    else {
      h.context.musicAudioRef.current = { currentTime: 1 };
      h.context.activeQQTrackLiveRef.current = { mid: "new-selection" };
      h.context.lyricLinesLiveRef.current = { trackId: "new-selection", lines: [] };
    }
    const before = h.context.lyricLinesLiveRef.current, writes = h.lyricWrites.length;
    lyricsReady([{ time: .8, text: "old transition lyric" }]); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.context.lyricLinesLiveRef.current, before);
    assert.equal(h.lyricWrites.length, writes);
    h.context.activeTransitionRef.current = null;
    transitionReady(); assert.equal(await turn, "played");
  }
});

test("queue tail awaits recommendation extension and starts the appended song", async () => {
  const [last, appended] = ["last", "appended"].map(track);
  const h = harness({ active: last, queue: [last], extension: [appended] });
  await h.finishCurrent();
  assert.deepEqual(h.queue().map((item) => item.mid), ["last", "appended"]);
  assert.equal(h.current()?.mid, "appended");
  assert.equal(h.index(), 1);
  assert.equal(h.audio()?.paused, false);
});

test("slow queue extension remains pending within the bounded source-check budget", async () => {
  const [last, appended] = ["last", "appended"].map(track);
  let releaseExtension;
  const extensionGate = new Promise((resolve) => { releaseExtension = resolve; });
  const h = harness({ active: last, queue: [last], extension: [appended], extensionGate });
  h.signalEnded();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.current()?.mid, "last");
  assert.equal(h.toast(), "", "the queue is still being checked, not declared exhausted");
  assert.ok(h.calls.some((call) => call[0] === "timeout" && call[1] === "QUEUE_EXTENSION" && call[2] >= 23_000 && call[2] <= 26_000));
  releaseExtension();
  await h.waitForAdvance();
  assert.equal(h.current()?.mid, "appended");
  assert.equal(h.index(), 1);
  assert.equal(h.audio()?.paused, false);
});

test("natural end skips unavailable songs and lands on a playable queue entry", async () => {
  const [current, badOne, badTwo, good] = ["current", "bad-one", "bad-two", "good"].map(track);
  const h = harness({ active: current, queue: [current, badOne, badTwo, good], unavailable: [badOne, badTwo] });
  await h.finishCurrent();
  assert.equal(h.current()?.mid, "good");
  assert.equal(h.index(), 3);
  assert.equal(h.audio()?.paused, false);
  assert.ok(h.calls.filter((call) => call[1] === "bad-one").length <= 2);
});

test("no playable successor stops with a useful message", async () => {
  const [current, bad] = ["current", "bad"].map(track);
  const h = harness({ active: current, queue: [current, bad], unavailable: [bad] });
  await h.finishCurrent();
  assert.equal(h.current()?.mid, "current");
  assert.equal(h.playing(), false);
  assert.match(h.toast(), /不可用|没有|接不上/);
});

test("unavailable queue entries have a finite retry budget", async () => {
  const current = track("current");
  const missing = Array.from({ length: 30 }, (_, index) => track(`missing-${index}`));
  const h = harness({ active: current, queue: [current, ...missing], unavailable: missing });
  await h.finishCurrent();
  assert.equal(h.current()?.mid, "current");
  assert.equal(h.playing(), false);
  assert.ok(h.calls.filter((call) => call[0] === "start").length <= 8);
});

test("an in-progress seamless handoff defers ended advancement, then resumes once released", async () => {
  const [current, next] = ["current", "next"].map(track);
  const h = harness({ active: current, queue: [current, next] });
  h.seamlessTransitionRef.current = true;
  await h.finishCurrent();
  assert.equal(h.current()?.mid, "current");
  assert.equal(h.pendingAdvanceRef.current, true);
  h.seamlessTransitionRef.current = false;
  await h.finishCurrent();
  assert.equal(h.current()?.mid, "next");
  assert.equal(h.audio()?.paused, false);
});

test("manual Next while music is playing still uses the existing transition", async () => {
  const [current, next] = ["current", "next"].map(track);
  const h = harness({ active: current, queue: [current, next] });
  await h.handlers.nextTrack();
  assert.equal(h.current()?.mid, "next");
  assert.equal(h.index(), 1);
  assert.equal(h.audio()?.paused, false);
  assert.ok(h.calls.some((call) => call[0] === "transition" && call[1] === "next"));
});

test("actual automatic transition keeps incoming audio playing despite stale React isPlaying", async () => {
  const h = transitionHarness();
  assert.equal(await h.run(), "played", String(h.failure()));
  assert.equal(h.current()?.mid, "incoming");
  assert.equal(h.incomingPlayCalls(), 1);
  assert.equal(h.incoming.paused, false);
  assert.equal(h.playingState(), true);
});

test("actual automatic transition falls back to direct advance if outgoing ended during preparation", async () => {
  const h = transitionHarness({ endDuringPrepare: true });
  assert.equal(await h.run(), "unavailable");
  assert.equal(h.incomingPlayCalls(), 0);
  assert.equal(h.fallbackCalls(), 1);
});

test("actual automatic transition does not advance after an explicit user pause", async () => {
  const h = transitionHarness({ pauseDuringPrepare: true });
  assert.equal(await h.run(), "unavailable");
  assert.equal(h.incomingPlayCalls(), 0);
  assert.equal(h.fallbackCalls(), 0);
});
