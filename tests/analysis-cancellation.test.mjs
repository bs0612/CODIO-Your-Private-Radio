import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Execute the production download/Worker lifecycle, not a parallel cancellation
// implementation. These fixtures never read QQ, keys or persisted user data.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["analyseTrackSource", "analyseTrackWhenBuffered", "analyzeDecodedBuffer", "prepareInitialWaveform", "prepareUpcomingTrack"];
const functions = new Map();
let resourceEffect;
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") {
    const callback = node.arguments[0]?.getText(ast);
    if (callback?.includes("const lifecycle = analysisLifecycleRef.current") && callback.includes("lifecycle.mounted = true")) resourceEffect = callback;
  }
  ts.forEachChild(node, visit);
})(ast);
for (const name of names) assert.ok(functions.has(name), `Missing production analysis function: ${name}`);
assert.ok(resourceEffect, "Missing mounted analysis resource lifecycle");
const javascript = ts.transpileModule(`${[...functions.values()].join("\n")}\nconst setupResources = ${resourceEffect};`.replaceAll("import.meta.url", '"file:///D:/CODIO/app/RadioExperience.tsx"'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const bind = new Function("context", `with(context) { ${javascript}; return { ${names.join(",")}, setupResources }; }`);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clock() {
  let now = 0, sequence = 0; const jobs = new Map();
  return {
    jobs, now: () => now,
    setTimeout(fn, delay) { const id = ++sequence; jobs.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => jobs.delete(id),
    async advance(amount) {
      const end = now + amount;
      for (;;) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, job] = next; jobs.delete(id); now = job.at; job.fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
const signature = "00".repeat(32);
const dsp = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(
  await readFile(new URL("../app/seamless-dj.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
).outputText).toString("base64")}`);
const analysis = trackId => ({ version: 3, trackId, sourceSignature: signature, duration: 240, waveform: Array(96).fill(.2), tempoConfidence: .7, bpm: 100, beats: [], phraseBoundaries: [], analysisConfidence: .7 });
function response() {
  let done = false;
  return { ok: true, headers: { get: () => "4" }, body: { cancelled: false, cancel() { this.cancelled = true; return Promise.resolve(); },
    getReader() { return { read: async () => done ? { done: true } : (done = true, { done: false, value: new Uint8Array([1, 2, 3, 4]) }), cancel: async () => {} }; } } };
}
function harness({ deferFetch = false, ignoreAbort = false, diskGate, decodeGate, worker = false } = {}) {
  const time = clock(), fetches = [], workers = [], calls = [], revoked = [];
  const buffer = { sampleRate: 12000, numberOfChannels: 1, duration: 240, getChannelData: () => new Float32Array(8) };
  class FakeContext {
    constructor() { calls.push(["context-created"]); }
    decodeAudioData() { calls.push(["decode"]); return decodeGate?.promise || Promise.resolve(buffer); }
    close() { calls.push(["context-closed"]); return Promise.resolve(); }
  }
  class FakeWorker {
    constructor() { workers.push(this); this.messages = []; this.terminated = false; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  class FakeURL extends URL { static revokeObjectURL(url) { revoked.push(url); } }
  const context = {
    window: { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, codioDesktop: { analysis: {
      get: () => diskGate?.promise || Promise.resolve(null), save: async (id, value) => { calls.push(["save", id, value]); return true; },
    } } },
    performance: { now: time.now }, crypto: { subtle: { digest: async () => new ArrayBuffer(32) } }, AbortController,
    Worker: worker ? FakeWorker : undefined, URL: FakeURL, AudioContext: FakeContext,
    analysisLifecycleRef: { current: { mounted: true, generation: 0 } },
    analysisRequestsRef: { current: new Map() }, analysisBufferWaitRef: { current: new Map() },
    analysisPromiseRef: { current: new Map() }, analysisSourceRef: { current: new Map() }, trackAnalysisRef: { current: new Map() },
    analysisWorkerRef: { current: null }, analysisWorkerPendingRef: { current: new Map() },
    audioContextRef: { current: null }, musicMasterRef: { current: null }, musicAudioRef: { current: null },
    audioElementsRef: { current: new Set() }, sourceWarmRef: { current: { revision: 0, controller: new AbortController() } },
    bufferedSourcesRef: { current: new Map() }, activeQQTrackLiveRef: { current: null },
    playQueueRef: { current: [] }, activeQueueIndexRef: { current: 0 }, activeTransitionRef: { current: null },
    releaseMusicAudio: audio => calls.push(["release-audio", audio]),
    setBoundedCache(map, key, value, limit) { map.set(key, value); while (map.size > limit) map.delete(map.keys().next().value); },
    isTrackAnalysisSourceValid: (item, id, expected) => item?.trackId === id && item.sourceSignature === expected,
    analyzePcmTrack: input => analysis(input.trackId),
    supplementAnalyzedPreferences: (id, result) => calls.push(["supplement", id, result]),
    notifySystem: (...args) => calls.push(["notice", ...args]),
    fetch(url, { signal }) {
      const gate = deferred(), entry = { url, signal, gate }; fetches.push(entry);
      if (!ignoreAbort) signal.addEventListener("abort", () => gate.reject(new DOMException("Cancelled", "AbortError")), { once: true });
      if (!deferFetch) gate.resolve(response());
      return gate.promise;
    },
    analysisForAudio: () => null,
    withTimeout(promise, milliseconds, label) {
      return new Promise((resolve, reject) => {
        const timer = time.setTimeout(() => reject(Error(label)), milliseconds);
        promise.then(value => { time.clearTimeout(timer); resolve(value); }, error => { time.clearTimeout(timer); reject(error); });
      });
    },
  };
  const handlers = bind(context); Object.assign(context, handlers);
  const cleanup = handlers.setupResources();
  return { context, handlers, cleanup, time, fetches, workers, calls, revoked, buffer };
}

test("a newer source for the same track aborts the old download, keeping the newer promise", async () => {
  const h = harness({ deferFetch: true });
  const old = h.handlers.analyseTrackSource("track", "qa://old");
  const latest = h.handlers.analyseTrackSource("track", "qa://new");
  assert.equal(h.fetches[0].signal.aborted, true); assert.equal(h.fetches[1].signal.aborted, false);
  assert.equal(await old, null);
  assert.equal(h.context.analysisPromiseRef.current.get("track"), latest, "old finally must not delete the latest job");
  h.fetches[1].gate.resolve(response());
  assert.equal((await latest).trackId, "track");
  assert.equal(h.context.analysisSourceRef.current.get("track").url, "qa://new");
  assert.equal(h.calls.filter(([name]) => name === "supplement").length, 1);
  h.cleanup();
});

test("same-source analysis deduplicates and the existing two-job limit remains intact", async () => {
  const h = harness({ deferFetch: true });
  const first = h.handlers.analyseTrackSource("one", "qa://one");
  assert.equal(h.handlers.analyseTrackSource("one", "qa://one"), first);
  const second = h.handlers.analyseTrackSource("two", "qa://two");
  assert.equal(await h.handlers.analyseTrackSource("three", "qa://three"), null);
  assert.equal(h.fetches.length, 2); h.cleanup(); await Promise.all([first, second]);
});

test("current and next analysis evict stale jobs without exceeding two live downloads", async () => {
  const h = harness({ deferFetch: true });
  const stale = [h.handlers.analyseTrackSource("old-one", "qa://old-one"), h.handlers.analyseTrackSource("old-two", "qa://old-two")];
  const current = { provider: "qq", mid: "current", mediaMid: "media-current" }, next = { provider: "qq", mid: "next" };
  h.context.activeQQTrackLiveRef.current = current; h.context.playQueueRef.current = [current, next];
  const currentJob = h.handlers.analyseTrackSource("current", "qa://current");
  const nextJob = h.handlers.analyseTrackSource("next", "qa://next");
  assert.equal(h.fetches.filter(item => !item.signal.aborted).length, 2);
  assert.ok(h.fetches.slice(0, 2).every(item => item.signal.aborted));
  assert.deepEqual(await Promise.all(stale), [null, null]);
  assert.equal(h.context.analysisPromiseRef.current.get("current"), currentJob);
  for (const item of h.fetches.slice(2)) item.gate.resolve(response());
  assert.deepEqual((await Promise.all([currentJob, nextJob])).map(item => item.trackId), ["current", "next"]);
  assert.equal(h.calls.find(([name, id]) => name === "save" && id === "current")[2].sourceMediaId, "qq:current:media-current");
  assert.equal(h.calls.find(([name, id]) => name === "save" && id === "next")[2].sourceMediaId, "qq:next:next");
  h.cleanup();
});

test("priority analysis never cancels the committed outgoing or incoming deck", async () => {
  const h = harness({ deferFetch: true });
  const jobs = [h.handlers.analyseTrackSource("out", "qa://out"), h.handlers.analyseTrackSource("in", "qa://in")];
  h.context.activeTransitionRef.current = { outgoingSnapshot: { track: { mid: "out" } }, incomingSnapshot: { track: { mid: "in" } } };
  h.context.activeQQTrackLiveRef.current = { mid: "in" };
  h.context.playQueueRef.current = [{ mid: "in" }, { mid: "later" }];
  assert.equal(await h.handlers.analyseTrackSource("later", "qa://later"), null);
  assert.equal(h.fetches.length, 2); assert.ok(h.fetches.every(item => !item.signal.aborted));
  h.cleanup(); await Promise.all(jobs);
});

test("playback analysis persists reusable initial-waveform identity across a restart without re-downloading", async () => {
  const h = harness(), track = { provider: "qq", mid: "song", mediaMid: "actual-file", durationSeconds: 240 };
  h.context.activeQQTrackLiveRef.current = track; h.context.playQueueRef.current = [track];
  await h.handlers.analyseTrackSource(track.mid, "qa://source", track.durationSeconds);
  const saved = h.calls.find(([name]) => name === "save")[2]; h.cleanup();
  const restarted = harness(); restarted.context.window.codioDesktop.analysis.get = async () => saved;
  restarted.context.prepareTrack = () => { throw Error("must not download the same media for the static waveform"); };
  assert.deepEqual(await restarted.handlers.prepareInitialWaveform(track), saved.waveform);
  assert.equal(restarted.fetches.length, 0); assert.equal(restarted.calls.length, 0);
  assert.equal(restarted.context.trackAnalysisRef.current.size, 0, "preview cache must not authorize a DJ endpoint before signature validation");
  restarted.cleanup();
});

test("integer catalogue duration cannot reject the real fractional PCM duration or force a second download", async () => {
  const h=harness(),rate=12000,length=Math.round(2.814*rate),pcm=new Float32Array(length);
  for(let i=0;i<length;i++)pcm[i]=(.1+.6*i/length)*Math.sin(i/rate*Math.PI*440);
  const track={provider:"qq",mid:"fractional-fixture",mediaMid:"same-file",durationSeconds:2};
  h.buffer.duration=length/rate;h.buffer.sampleRate=rate;h.buffer.getChannelData=()=>pcm;
  h.context.activeQQTrackLiveRef.current=track;h.context.playQueueRef.current=[track];
  h.context.analyzePcmTrack=dsp.analyzePcmTrack;h.context.isTrackAnalysisSourceValid=dsp.isTrackAnalysisSourceValid;
  const result=await h.handlers.analyseTrackSource(track.mid,"qa://fractional",track.durationSeconds);
  assert.ok(result,"use the decoded file duration, not the rounded catalogue hint");
  assert.equal(result.duration,length/rate);assert.equal(result.waveform.length,96);
  assert.equal(dsp.isTrackAnalysisSourceValid(result,track.mid,signature,result.duration),true);
  assert.equal(dsp.isTrackAnalysisSourceValid(result,track.mid,signature,2),false,"actual deck duration checks must remain strict");
  assert.equal(dsp.isTrackAnalysisSourceValid(result,track.mid,"wrong-source",result.duration),false);
  assert.equal(await h.handlers.analyseTrackSource(track.mid,"qa://fractional",track.durationSeconds),result);
  assert.equal(h.fetches.length,1,"the same verified bytes and actual duration are reusable");
  const saved=h.calls.find(([name])=>name==="save")[2];h.cleanup();
  const restarted=harness();restarted.context.window.codioDesktop.analysis.get=async()=>saved;
  restarted.context.prepareTrack=()=>assert.fail("valid media-bound waveform must survive restart without downloading again");
  assert.deepEqual(await restarted.handlers.prepareInitialWaveform(track),result.waveform);restarted.cleanup();
});

test("disk analysis with an exact byte digest is checked against its decoded duration, with the catalogue only a coarse guard", async () => {
  const h=harness(),rate=12000,pcm=Float32Array.from({length:33768},(_,i)=>.4*Math.sin(i/rate*Math.PI*440));
  const cached=dsp.analyzePcmTrack({trackId:"disk-fractional",sampleRate:rate,channels:[pcm],sourceSignature:signature});
  h.context.isTrackAnalysisSourceValid=dsp.isTrackAnalysisSourceValid;
  h.context.window.codioDesktop.analysis.get=async()=>cached;
  const result=await h.handlers.analyseTrackSource("disk-fractional","qa://same-bytes",2);
  assert.equal(result,cached);assert.ok(!h.calls.some(([name])=>name==="decoded"));
  assert.equal(h.context.analysisSourceRef.current.get("disk-fractional").duration,cached.duration);h.cleanup();
});

test("stalled disk cache lookup falls back to bounded analysis instead of occupying a slot forever", async () => {
  const h = harness({ diskGate: deferred() }), pending = h.handlers.analyseTrackSource("song", "qa://source");
  await flush(); await h.time.advance(1200);
  assert.equal((await pending).trackId, "song");
  assert.equal(h.context.analysisPromiseRef.current.size, 0); assert.equal(h.time.jobs.size, 0); h.cleanup();
});

test("a late next-source response after manual selection cannot schedule stale audio analysis", async () => {
  const h = harness(), source = deferred(), current = { mid: "current" }, next = { mid: "next" };
  h.context.activeQQTrackLiveRef.current = current;
  h.context.playQueueRef.current = [current, next, { mid: "third" }, { mid: "fourth" }];
  h.context.prepareTrack = () => source.promise;
  h.context.transitionPairKey = (a, b) => `${a}:${b}`;
  h.context.transitionPlansRef = { current: new Map() };
  h.handlers.prepareUpcomingTrack(current.mid);
  h.context.activeQQTrackLiveRef.current = { mid: "manual-choice" };
  source.resolve({ playback: { url: "qa://stale-next" }, coverData: "qa://cover" }); await flush();
  assert.equal(h.fetches.length, 0); assert.equal(h.context.transitionPlansRef.current.size, 0); h.cleanup();
});

test("an adopted deck obtains its own timeline and pair planning waits for its real analysis", async()=>{
  const h=harness(),current={mid:"adopted"},next={mid:"next"};
  const audio={src:"qa://adopted",dataset:{codioSource:"qa://adopted"},duration:240,currentTime:0,error:null,buffered:{length:1,end:()=>20}};
  h.context.activeQQTrackLiveRef.current=current;h.context.musicAudioRef.current=audio;
  h.context.playQueueRef.current=[current,next,{mid:"third"},{mid:"fourth"}];
  h.context.prepareTrack=async()=>({playback:{url:"qa://next"},audio:{duration:240},coverData:""});
  h.context.transitionPairKey=(a,b)=>`${a}:${b}`;h.context.transitionPlansRef={current:new Map()};
  h.context.transitionSequenceRef={current:0};h.context.seamlessAttemptedRef={current:"adopted"};
  const plans=[];h.context.planTransition=(a,b)=>{plans.push([a.trackId,b.trackId]);return{id:"pair"};};
  h.handlers.prepareUpcomingTrack(current.mid);await flush();
  assert.deepEqual(plans,[],"do not snapshot a null current analysis while the job is pending");
  await h.time.advance(500);await flush();
  assert.ok(h.fetches.some(entry=>entry.url==="qa://adopted"));assert.ok(h.fetches.some(entry=>entry.url==="qa://next"));
  assert.deepEqual(plans,[["adopted","next"]]);h.cleanup();
});

test("unmount aborts pending downloads and prevents late context or Worker creation", async () => {
  const h = harness({ deferFetch: true, worker: true });
  const first = h.handlers.analyseTrackSource("one", "qa://one");
  const second = h.handlers.analyseTrackSource("two", "qa://two");
  h.cleanup(); assert.ok(h.fetches.every(entry => entry.signal.aborted));
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(await h.handlers.analyseTrackSource("late", "qa://late"), null);
  assert.equal(h.workers.length, 0); assert.equal(h.calls.some(([name]) => name === "context-created"), false);
  assert.equal(h.time.jobs.size, 0); assert.equal(h.context.analysisRequestsRef.current.size, 0);
});

test("a non-cooperative fetch returning after cancellation cannot decode or commit", async () => {
  const h = harness({ deferFetch: true, ignoreAbort: true });
  const request = h.handlers.analyseTrackSource("old", "qa://old"); h.cleanup();
  const lateResponse = response(); h.fetches[0].gate.resolve(lateResponse);
  assert.equal(await request, null); assert.equal(lateResponse.body.cancelled, true);
  assert.equal(h.calls.length, 0); assert.equal(h.context.trackAnalysisRef.current.size, 0);
});

test("late disk-cache lookup after unmount cannot recreate AudioContext", async () => {
  const diskGate = deferred(), h = harness({ diskGate });
  const request = h.handlers.analyseTrackSource("track", "qa://track"); await flush();
  h.cleanup(); diskGate.resolve(null);
  assert.equal(await request, null); assert.equal(h.calls.some(([name]) => name === "context-created"), false);
  assert.equal(h.context.trackAnalysisRef.current.size, 0);
});

test("a superseded disk-cache result cannot overwrite or supplement the new source", async () => {
  const diskGate = deferred(), h = harness({ diskGate, deferFetch: true });
  const old = h.handlers.analyseTrackSource("track", "qa://old"); h.fetches[0].gate.resolve(response()); await flush();
  const latest = h.handlers.analyseTrackSource("track", "qa://new");
  diskGate.resolve(analysis("track")); assert.equal(await old, null);
  assert.equal(h.context.trackAnalysisRef.current.size, 0); assert.equal(h.context.analysisPromiseRef.current.get("track"), latest);
  h.cleanup(); assert.equal(await latest, null);
});

test("decode completing after unmount cannot create a new Worker or publish analysis", async () => {
  const decodeGate = deferred(), h = harness({ decodeGate, worker: true });
  const request = h.handlers.analyseTrackSource("track", "qa://track"); await flush();
  assert.ok(h.calls.some(([name]) => name === "decode")); h.cleanup(); decodeGate.resolve(h.buffer);
  assert.equal(await request, null); assert.equal(h.workers.length, 0);
  assert.equal(h.context.audioContextRef.current, null); assert.equal(h.context.trackAnalysisRef.current.size, 0);
});

test("decode completing for a replaced source does not post stale PCM to the Worker", async () => {
  const decodeGate = deferred(), h = harness({ decodeGate, worker: true, deferFetch: true });
  const old = h.handlers.analyseTrackSource("track", "qa://old"); h.fetches[0].gate.resolve(response()); await flush();
  const latest = h.handlers.analyseTrackSource("track", "qa://new"); decodeGate.resolve(h.buffer);
  assert.equal(await old, null); assert.equal(h.workers.length, 0);
  h.cleanup(); assert.equal(await latest, null);
});

test("cancelling posted Worker analysis resolves the job and removes its timeout", async () => {
  const h = harness({ worker: true }), request = h.handlers.analyseTrackSource("track", "qa://track"); await flush();
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].messages.length, 1);
  h.cleanup(); assert.equal(await request, null); assert.equal(h.workers[0].terminated, true);
  assert.equal(h.context.analysisWorkerPendingRef.current.size, 0); assert.equal(h.time.jobs.size, 0);
});

test("Strict Mode cleanup generation prevents old completion from affecting a remounted Worker", async () => {
  const h = harness({ worker: true }), oldRequest = h.handlers.analyseTrackSource("old", "qa://old"); await flush();
  const oldWorker = h.workers[0]; h.cleanup(); await oldRequest;
  const remountCleanup = h.handlers.setupResources();
  const latest = h.handlers.analyseTrackSource("new", "qa://new"); await flush();
  assert.equal(h.workers.length, 2); oldWorker.onerror();
  assert.equal(h.context.analysisWorkerRef.current, h.workers[1], "old worker error cannot terminate the new worker");
  const message = h.workers[1].messages[0]; h.workers[1].onmessage({ data: { id: message.id, analysis: analysis("new") } });
  assert.equal((await latest).trackId, "new"); remountCleanup();
});

test("buffer waiting deduplicates, and a replaced source cancels its old timer", async () => {
  const h = harness(); const audio = { src: "qa://old", dataset: { codioSource: "qa://old" }, duration: 240, currentTime: 0, error: null, buffered: { length: 1, end: () => 20 } };
  h.context.musicAudioRef.current = audio;
  const old = h.handlers.analyseTrackWhenBuffered("track", "qa://old", audio);
  assert.equal(h.handlers.analyseTrackWhenBuffered("track", "qa://old", audio), old);
  audio.src = audio.dataset.codioSource = "qa://new";
  const latest = h.handlers.analyseTrackWhenBuffered("track", "qa://new", audio);
  assert.equal(await old, null); assert.equal(h.time.jobs.size, 1);
  await h.time.advance(500); assert.equal((await latest).trackId, "track");
  assert.deepEqual(h.fetches.map(entry => entry.url), ["qa://new"]); h.cleanup();
});

test("buffer wait unmount clears its timer and never starts a download", async () => {
  const h = harness(); const audio = { src: "qa://track", dataset: {}, error: null, buffered: { length: 0 } };
  h.context.musicAudioRef.current = audio;
  const request = h.handlers.analyseTrackWhenBuffered("track", "qa://track", audio);
  h.cleanup(); assert.equal(await request, null); await h.time.advance(5000);
  assert.equal(h.fetches.length, 0); assert.equal(h.time.jobs.size, 0); assert.equal(h.context.analysisBufferWaitRef.current.size, 0);
});

test("audio no longer current while buffering cannot start stale analysis", async () => {
  const h = harness(); const audio = { src: "qa://track", dataset: {}, error: null, buffered: { length: 0 } };
  h.context.musicAudioRef.current = audio; const request = h.handlers.analyseTrackWhenBuffered("track", "qa://track", audio);
  h.context.musicAudioRef.current = null; await h.time.advance(500);
  assert.equal(await request, null); assert.equal(h.fetches.length, 0); h.cleanup();
});

test("the bounded fetch timeout aborts without creating audio resources", async () => {
  const h = harness({ deferFetch: true }), request = h.handlers.analyseTrackSource("track", "qa://track");
  await h.time.advance(25000); assert.equal(await request, null); assert.equal(h.fetches[0].signal.aborted, true);
  assert.equal(h.context.analysisRequestsRef.current.size, 0); assert.equal(h.context.analysisPromiseRef.current.size, 0);
  assert.equal(h.calls.length, 0); h.cleanup();
});

test("unmount cancels source warming and releases blob URLs, preserving external files and cache", () => {
  const h = harness(), warm = h.context.sourceWarmRef.current;
  h.context.bufferedSourcesRef.current.set("one", { url: "blob:one" }); h.context.bufferedSourcesRef.current.set("two", { url: "blob:two" });
  h.cleanup(); assert.equal(warm.controller.signal.aborted, true); assert.equal(warm.revision, 1);
  assert.deepEqual(h.revoked, ["blob:one", "blob:two"]); assert.equal(h.context.bufferedSourcesRef.current.size, 0);
});

test("cancelling all posted analysis interrupts abandoned Worker CPU work, but one valid shared job keeps it alive", async () => {
  const h = harness({ worker: true }), a = new AbortController(), b = new AbortController();
  const first = h.handlers.analyzeDecodedBuffer("old", h.buffer, signature, a.signal);
  const second = h.handlers.analyzeDecodedBuffer("needed", h.buffer, signature, b.signal);
  const worker = h.workers[0]; assert.equal(worker.messages.length, 2);
  a.abort(); assert.equal(await first, null); assert.equal(worker.terminated, false);
  assert.equal(h.context.analysisWorkerPendingRef.current.size, 1);
  b.abort(); assert.equal(await second, null); assert.equal(worker.terminated, true);
  assert.equal(h.context.analysisWorkerRef.current, null); assert.equal(h.time.jobs.size, 0);
  const next = h.handlers.analyzeDecodedBuffer("new", h.buffer, signature);
  assert.equal(h.workers.length, 2); const current = h.workers[1], message = current.messages[0];
  worker.onmessage({ data: { id: worker.messages[0].id, analysis: analysis("old") } });
  assert.equal(h.context.analysisWorkerPendingRef.current.size, 1, "Late retired-worker output cannot finish the new job");
  current.onmessage({ data: { id: message.id, analysis: analysis("new") } });
  assert.equal((await next).trackId, "new"); assert.equal(current.terminated, false, "Successful work retains the reusable Worker");
  h.cleanup();
});

test("the last posted analysis deadline terminates the otherwise orphaned Worker and removes its timers", async () => {
  const h = harness({ worker: true });
  const pending = h.handlers.analyzeDecodedBuffer("timeout", h.buffer, signature);
  await h.time.advance(45_000); assert.equal(await pending, null);
  assert.equal(h.workers[0].terminated, true); assert.equal(h.context.analysisWorkerPendingRef.current.size, 0);
  assert.equal(h.context.analysisWorkerRef.current, null); assert.equal(h.time.jobs.size, 0); h.cleanup();
});
