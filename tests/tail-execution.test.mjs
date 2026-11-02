import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { build } from "esbuild";

// Execute production handlers, not a parallel scheduler. All refs/media are
// isolated; QQ, API keys, userData and the real listening memory are untouched.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer))
    functions.set(node.name.text, `const ${node.getText(ast)};`);
  ts.forEachChild(node, visit);
})(ast);
function bind(name, context, additional = []) {
  const names = [...additional, name];
  names.forEach(item => assert.ok(functions.has(item), `Missing actual handler ${item}`));
  const js = ts.transpileModule(names.map(item => functions.get(item)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function("context", `with(context){${js};return ${name};}`)(context);
}
const compiled = await build({ entryPoints: [new URL("../app/seamless-dj.ts", import.meta.url).pathname.slice(1)], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
const dj = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const pcm = (tail = 15) => {
  const sampleRate = 8000, channel = new Float32Array((3 + tail) * sampleRate);
  for (let i = 0; i < 3 * sampleRate; i++) channel[i] = Math.sin(i / sampleRate * Math.PI * 440) * .06;
  return dj.analyzePcmTrack({ trackId: "out", sampleRate, channels: [channel], sourceSignature: "source-a" });
};

test("tail source validation rejects stale sources and duration before any clipping", () => {
  const a = pcm();
  assert.equal(dj.isTrackAnalysisSourceValid(a, "out", "source-a", 18), true);
  assert.equal(dj.isTrackAnalysisSourceValid(a, "out", "source-b", 18), false);
  assert.equal(dj.isTrackAnalysisSourceValid(a, "out", "source-a", 22), false);
  assert.equal(dj.isTrackAnalysisSourceValid({ ...a, sourceSignature: undefined }, "out", "source-a", 18), false);
});

test("renderer only exposes a matching source-bound analysis to playback control", () => {
  const analysis=pcm(), binding={url:"https://source/a",signature:"source-a",duration:18};
  const context={isTrackAnalysisSourceValid:dj.isTrackAnalysisSourceValid,analysisSourceRef:{current:new Map([["out",binding]])},
    trackAnalysisRef:{current:new Map([["out",analysis]])}};
  const get=bind("analysisForAudio",context),audio={src:binding.url,duration:18,dataset:{}};
  assert.equal(get("out",audio),analysis);
  assert.equal(get("out",{...audio,src:"https://source/new-version"}),null);
  assert.equal(get("out",{...audio,duration:24}),null);
  assert.equal(get("out",{...audio,src:"blob:temporary",dataset:{codioSource:binding.url}}),analysis,
    "a byte-cache blob can retain its verified original source identity");
});

test("only reliable sound end is enough for an original-speed audible intro handoff", () => {
  const a = pcm(), plan = dj.planSilenceHandoff(a, null, "next", "tail-only");
  assert.ok(plan?.boundaryHandoff);
  assert.equal(plan.incomingCue, 0, "unanalysed real intro must not be skipped");
  assert.equal(plan.incomingTempoRatio, 1); assert.equal(plan.outgoingTempoRatio, 1);
  assert.ok(plan.outgoingCue < a.silence.lastAudibleTime);
  assert.ok(plan.outgoingGainCurve[0] > .99);
  assert.ok(plan.incomingGainCurve[0] >= .15, "played intro is not kept at zero gain");
  assert.ok(plan.incomingGainCurve[Math.floor(plan.incomingGainCurve.length / 3)] > .8);
  assert.ok(plan.incomingLowCurve.every(value => value === 1));
  assert.ok(plan.incomingMidCurve.every(value => value === 1));
  assert.ok(plan.incomingHighCurve.every(value => value === 1));
  assert.equal(dj.planSilenceHandoff({ ...a, silence: { ...a.silence, tailConfidence: .4 } }, null, "next"), null);
});

test("production end waiter completes without a single visual animation frame", async () => {
  const audioClock = { currentTime: 0 }, active = { current: { id: "tail" } };
  let timers = 0;
  const context = { activeTransitionRef: active,
    window: { requestAnimationFrame() { throw Error("Control must not depend on rAF"); },
      setTimeout(callback) { timers++; audioClock.currentTime += .08; return setTimeout(callback, 0); }, clearTimeout } };
  await bind("waitForTransitionAudioEnd", context)(audioClock, .24, "tail");
  assert.ok(timers > 0 && timers < 10); assert.ok(audioClock.currentTime >= .24);
});

test("production end waiter cancels when the active transition changes", async () => {
  const context = { activeTransitionRef: { current: { id: "new" } }, window: {
    requestAnimationFrame() { throw Error("No rAF"); }, setTimeout() { throw Error("Stale waiter must return immediately"); } } };
  await bind("waitForTransitionAudioEnd", context)({ currentTime: 0 }, 100, "old");
});

test("production audio-clock waiter commits during the mix with visual frames disabled", async () => {
  const clock={currentTime:0},commits=[];
  const context={activeTransitionRef:{current:{id:"background"}},window:{
    requestAnimationFrame(){throw Error("No visual clock permitted");},setTimeout(callback){clock.currentTime+=.05;return setTimeout(callback,0);}}};
  await bind("waitForTransitionAudioEnd",context)(clock,.3,"background",.15,()=>commits.push(clock.currentTime));
  assert.ok(commits.length);assert.ok(commits[0]>=.15&&commits[0]<.3,"track commits before the audio envelope ends");
});

test("abort invalidates pending preparation even before an active runtime exists", () => {
  const context = { activeTransitionRef: { current: null }, audioContextRef: { current: null },
    pendingTransitionAudioRef: { current: null },
    transitionRequestRef: { current: 3 }, seamlessTransitionRef: { current: true }, pendingAdvanceRef: { current: true },
    seamlessAttemptedRef: { current: "old" }, playbackFadeRef: { current: 2 },
    transitionControlTimerRef: { current: null }, transitionCommitTimerRef: { current: null },
    notifySystem() {}, stopTransitionCoordinator() {}, setTransitionDisplay() {}, window: { clearTimeout, clearInterval } };
  bind("abortActiveTransition", context)("pause");
  assert.ok(context.transitionRequestRef.current > 3, "the awaited old source request is genuinely superseded");
  assert.equal(context.seamlessTransitionRef.current, false);
  assert.equal(context.pendingAdvanceRef.current, false);
});

test("production AudioParam schedules audible full-frequency boundary curves", () => {
  const plan = dj.planSilenceHandoff(pcm(), null, "next"), scheduled = [];
  const parameter = name => ({ value: 1, cancelAndHoldAtTime() {}, setValueCurveAtTime(values, start, duration) {
    scheduled.push({ name, values: [...values], start, duration }); } });
  const chain = { gain: { gain: parameter("gain") }, lowEq: { gain: parameter("low") },
    midEq: { gain: parameter("mid") }, highEq: { gain: parameter("high") } };
  bind("scheduleDeckPlan", {}, ["holdAudioParam", "scheduleCurve"])(chain, plan, "incoming", 2, .9);
  assert.equal(scheduled.length, 4);
  assert.ok(scheduled[0].values[0] >= .15); assert.ok(scheduled[0].values.at(-1) > .99);
  assert.ok(scheduled.slice(1).every(row => row.values.every(value => Math.abs(value) < .00001)));
  assert.ok(scheduled.every(row => row.start === 2 && row.duration === .9));
});

function wireHarness({ paused = false } = {}) {
  const analysis = pcm(), out = { src: "source-a", duration:18,currentTime:.1,paused,ended:false,dataset:{} }, next={mid:"next"};
  let handoffs=0, advances=0;
  const c={...dj,visualActiveRef:{current:true},musicAudioRef:{current:out},userPausedRef:{current:paused},listeningSessionRef:{current:null},
    trackAnalysisRef:{current:new Map([["out",analysis]])},analysisSourceRef:{current:new Map([["out",{url:"source-a",signature:"source-a",duration:18}]])},
    transitionPlansRef:{current:new Map()},playQueueRef:{current:[{mid:"out"},next]},activeQueueIndexRef:{current:0},
    preparedTracksRef:{current:new Map()},seamlessRef:{current:true},seamlessTransitionRef:{current:false},seamlessAttemptedRef:{current:null},
    startingTrackRef:{current:null},volumeRef:{current:70},audioContextRef:{current:null},analyserNodesRef:{current:new Map()},pendingAdvanceRef:{current:false},
    lyricLinesLiveRef:{current:{trackId:"out",lines:[]}},
    window:{setTimeout:()=>1,clearTimeout(){},codioDesktop:{qqMusic:{}}},
    transitionPairKey:(a,b)=>`${a}→${b}`,
    notifySystem(){},setPlaybackTime(){},setProgress(){},setIsPlaying(){},armPlaybackBoundaryCheck(){},recoverCurrentTrack(){},prepareUpcomingTrack(){},
    advanceFromFinishedAudio(){advances++;},beginSeamlessCrossfade(){handoffs++;c.seamlessTransitionRef.current=true;},
    setBoundedCache(cache,key,value){cache.set(key,value);}};
  c.analysisForAudio=bind("analysisForAudio",c);
  c.getAudiblePlaybackTime=bind("getAudiblePlaybackTime",c);
  bind("wireMusicAudio",c)(out,"out");
  return {out,c,analysis,handoffs:()=>handoffs,advances:()=>advances};
}

test("actual timeupdate waits for the sound-boundary cue, even without a cached pair plan", () => {
  const h=wireHarness();h.out.ontimeupdate();
  assert.equal(h.handoffs(),0,"remaining <20 must not cut a short musical outro immediately");
  h.out.currentTime=dj.planSilenceHandoff(h.analysis,null,"next").outgoingCue+.03;h.out.ontimeupdate();
  assert.equal(h.handoffs(),1);h.out.ontimeupdate();assert.equal(h.handoffs(),1);
});

test("actual timeupdate cannot turn an explicit user pause into an automatic handoff", () => {
  const h=wireHarness({paused:true});h.out.currentTime=h.analysis.effectiveEnd-.02;h.out.ontimeupdate();
  assert.equal(h.handoffs(),0);assert.equal(h.advances(),0);
});

test("missing pair analysis still starts an honest original-speed overlap before file end", () => {
  const h=wireHarness();h.c.trackAnalysisRef.current.clear();
  h.out.currentTime=h.out.duration-3.1;h.out.ontimeupdate();
  assert.equal(h.handoffs(),1,"no pair analysis must not disable every automatic mix");
  assert.equal(h.advances(),0);
});

test("one failed automatic attempt can recover, but retries are bounded and honor the latest next track", async () => {
  const h=wireHarness();let now=1000,calls=0;
  h.c.Date={now:()=>now};
  h.c.beginSeamlessCrossfade=async()=>{calls++;return "unavailable";};
  h.out.currentTime=dj.planSilenceHandoff(h.analysis,null,"next").outgoingCue+.03;
  h.out.ontimeupdate();await Promise.resolve();assert.equal(calls,1);
  h.out.ontimeupdate();assert.equal(calls,1,"no busy-loop retry");
  now+=650;h.out.ontimeupdate();await Promise.resolve();assert.equal(calls,2);
  now+=650;h.out.ontimeupdate();await Promise.resolve();assert.equal(calls,3);
  now+=650;h.out.ontimeupdate();assert.equal(calls,3,"three attempts per next-track identity");
  h.c.playQueueRef.current[1]={mid:"new-next"};h.out.ontimeupdate();await Promise.resolve();assert.equal(calls,4);
});

test("actual timeupdate never applies a verified old tail to a replacement media source", () => {
  const h=wireHarness();h.out.currentTime=h.analysis.effectiveEnd+1;h.out.src="source-replacement";
  h.out.ontimeupdate();
  assert.equal(h.handoffs(),0);assert.equal(h.advances(),0,"an unvalidated source keeps its actual duration");
});

test("late verified tail analysis advances once even when the next source is still pending", async () => {
  const h=wireHarness();h.c.trackAnalysisRef.current.clear();h.out.currentTime=h.analysis.effectiveEnd+4;
  h.out.ontimeupdate();assert.equal(h.advances(),0,"there is no permission to crop before source analysis arrives");
  let release,requests=0;const pending=new Promise(resolve=>release=resolve);
  h.c.advancingRef={current:false};h.c.nextTrack=()=>{requests++;return pending;};
  h.c.advanceFromFinishedAudio=bind("advanceFromFinishedAudio",h.c);
  h.c.trackAnalysisRef.current.set("out",h.analysis);
  h.out.ontimeupdate();h.out.ontimeupdate();
  assert.equal(requests,1,"the next-source wait cannot enqueue repeated advances every timeupdate");
  assert.equal(h.handoffs(),0,"a late analysis after sound end uses advance, not a missed crossfade window");
  release("unavailable");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.c.advancingRef.current,false);
});

test("production background boundary timer evaluates the sound cue without visual frames", () => {
  const h=wireHarness(),jobs=[];h.c.audioControlTimerRef={current:null};
  h.c.visualActiveRef.current=false;
  h.c.setPlaybackTime=()=>assert.fail("background audio boundary must not require React clock renders");
  h.c.window.setTimeout=(callback,delay)=>{jobs.push({callback,delay});return jobs.length;};
  h.c.window.requestAnimationFrame=()=>{throw Error("background audio boundary cannot wait for a visual frame");};
  h.out.dispatchEvent=event=>h.out[`on${event.type}`]?.(event);
  bind("armPlaybackBoundaryCheck",h.c)();
  assert.equal(jobs[0].delay,120);
  h.out.currentTime=dj.planSilenceHandoff(h.analysis,null,"next").outgoingCue+.03;
  jobs.shift().callback();assert.equal(h.handoffs(),1);
  jobs.shift().callback();assert.equal(h.handoffs(),1,"the background tick does not repeat an active handoff");
  h.c.userPausedRef.current=true;jobs.shift().callback();assert.equal(jobs.length,0);
});

function pendingTransitionHarness() {
  const outTrack={mid:"out",title:"out",durationSeconds:18},next={mid:"next",title:"next",durationSeconds:8};
  const outgoing={src:"source-a",duration:18,currentTime:2.4,paused:false,ended:false,playbackRate:1,dataset:{}};
  const incoming={src:"source-next",duration:8,currentTime:0,paused:true,ended:false,playbackRate:1,dataset:{},play(){throw Error("Canceled old deck must never play");}};
  let release, released=[];
  const gate=new Promise(resolve=>release=resolve),analysis=pcm();
  const c={...dj,musicAudioRef:{current:outgoing},activeQQTrackLiveRef:{current:outTrack},activeTransitionRef:{current:null},pendingTransitionAudioRef:{current:null},
    userPausedRef:{current:false},playQueueRef:{current:[outTrack,next]},activeQueueIndexRef:{current:0},
    transitionRequestRef:{current:0},transitionSequenceRef:{current:0},playbackFadeRef:{current:0},seamlessTransitionRef:{current:false},
    seamlessAttemptedRef:{current:null},pendingAdvanceRef:{current:false},preparedTracksRef:{current:new Map()},
    transitionPlansRef:{current:new Map()},audioContextRef:{current:{currentTime:1}},analyserRef:{current:null},
    analyserNodesRef:{current:new Map()},currentCoverDataLiveRef:{current:""},lyricLinesLiveRef:{current:{trackId:"out",lines:[]}},
    notifySystem(){},setTransitionDisplay(){},stopTransitionCoordinator(){},resumeMusicAudioGraph:async()=>true,
    prepareTrack:async()=>gate,analysisForAudio:()=>analysis,releaseMusicAudio(audio){released.push(audio);},
    window:{},withTimeout:promise=>promise,advanceFromFinishedAudio(){throw Error("Cancellation must not advance playback");}};
  c.abortActiveTransition=bind("abortActiveTransition",c);
  return {c,outgoing,incoming,next,release:()=>release({playback:{url:"source-next"},audio:incoming,coverData:""}),
    start:()=>bind("transitionToTrack",c)(next,1,"automatic","out"),released:()=>released};
}

test("user pause during source preparation invalidates the actual async transition", async () => {
  const h=pendingTransitionHarness(),turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  h.c.userPausedRef.current=true;h.outgoing.paused=true;h.c.abortActiveTransition("pause");h.release();
  assert.equal(await turn,"unavailable");assert.equal(h.c.musicAudioRef.current,h.outgoing);
  assert.equal(h.outgoing.paused,true);assert.equal(h.incoming.paused,true);
});

test("old prepare completion cannot restore outgoing after the user selects a new song", async () => {
  const h=pendingTransitionHarness(),turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  h.c.abortActiveTransition("manual-track");const newAudio={src:"new-choice",paused:false};
  h.c.musicAudioRef.current=newAudio;h.c.activeQQTrackLiveRef.current={mid:"new-choice"};h.release();
  assert.equal(await turn,"unavailable");assert.equal(h.c.musicAudioRef.current,newAudio);
  assert.equal(h.c.activeQQTrackLiveRef.current.mid,"new-choice");assert.equal(h.incoming.paused,true);
});

test("seek during preparation abandons the old boundary request rather than rewinding the new position", async () => {
  const h=pendingTransitionHarness(),turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  h.c.abortActiveTransition("seek");h.outgoing.currentTime=1.1;h.release();
  assert.equal(await turn,"unavailable");assert.equal(h.outgoing.currentTime,1.1);
  assert.equal(h.c.seamlessTransitionRef.current,false);assert.equal(h.incoming.paused,true);
});

function playingTransitionHarness() {
  const analysis=pcm(), outTrack={mid:"out",title:"out",durationSeconds:18}, next={mid:"next",title:"next",durationSeconds:8};
  let finishPlay, failPlay, playing=true;
  const playGate=new Promise((resolve,reject)=>{finishPlay=resolve;failPlay=reject;}), calls=[];
  const makeAudio=(id,paused)=>({src:`source-${id}`,duration:id==="out"?18:8,currentTime:id==="out"?2.4:0,
    readyState:2,paused,ended:false,volume:1,playbackRate:1,dataset:{},
    pause(){this.paused=true;calls.push(["pause",id]);},
    play(){this.paused=false;calls.push(["play",id]);this.onplay?.();return id==="next"?playGate:Promise.resolve();},
    removeAttribute(name){if(name==="src")this.src="";},load(){},removeEventListener(){},
    dispatchEvent(event){this[`on${event.type}`]?.(event);},addEventListener(){}});
  const outgoing=makeAudio("out",false),incoming=makeAudio("next",true);
  const parameter=()=>({value:1,cancelAndHoldAtTime(){},cancelScheduledValues(){},setValueAtTime(value){this.value=value;},
    setTargetAtTime(value){this.value=value;},linearRampToValueAtTime(value){this.value=value;},disconnect(){}});
  const chain=()=>({gain:{gain:parameter(),disconnect(){}},lowEq:{gain:parameter(),disconnect(){}},
    midEq:{gain:parameter(),disconnect(){}},highEq:{gain:parameter(),disconnect(){}},
    source:{disconnect(){}},highpass:{disconnect(){}},lowpass:{disconnect(){}},analyser:{disconnect(){}}});
  const outgoingChain=chain(),incomingChain=chain();
  const c={...dj,visualActiveRef:{current:true},musicAudioRef:{current:outgoing},activeQQTrack:outTrack,activeQQTrackLiveRef:{current:outTrack},
    activeTransitionRef:{current:null},pendingTransitionAudioRef:{current:null},userPausedRef:{current:false},
    playQueueRef:{current:[outTrack,next]},activeQueueIndexRef:{current:0},transitionRequestRef:{current:0},
    transitionSequenceRef:{current:0},playbackFadeRef:{current:0},playbackFadeCancelRef:{current:null},
    playbackToggleRef:{current:{revision:0,pending:false}},seamlessTransitionRef:{current:false},
    seamlessAttemptedRef:{current:null},pendingAdvanceRef:{current:false},preparedTracksRef:{current:new Map()},
    transitionPlansRef:{current:new Map()},audioContextRef:{current:{currentTime:1,state:"running"}},
    analyserRef:{current:outgoingChain.analyser},analysedAudioRef:{current:outgoing},frequencyDataRef:{current:null},
    analyserNodesRef:{current:new Map([[outgoing,outgoingChain],[incoming,incomingChain]])},audioElementsRef:{current:new Set([outgoing,incoming])},
    currentCoverDataLiveRef:{current:""},lyricLinesLiveRef:{current:{trackId:"out",lines:[]}},listeningSessionRef:{current:null},
    trackAnalysisRef:{current:new Map()},analysisSourceRef:{current:new Map()},volumeRef:{current:70},startingTrackRef:{current:null},
    seamlessRef:{current:true},performance,
    window:{setTimeout,clearTimeout,setInterval,clearInterval,codioDesktop:{qqMusic:{lyrics:async()=>[]}}},
    notifySystem(){},setTransitionDisplay(){},stopTransitionCoordinator(){},resumeMusicAudioGraph:async()=>true,
    prepareTrack:async()=>({playback:{url:incoming.src},audio:incoming,coverData:""}),
    analysisForAudio:id=>id==="out"?analysis:null,transitionPairKey:(a,b)=>`${a}→${b}`,
    connectMusicAnalyser:audio=>c.analyserNodesRef.current.get(audio),setBoundedCache(cache,key,value){cache.set(key,value);},
    setIsPlaying(value){playing=value;calls.push(["ui",value]);},armPlaybackBoundaryCheck(){},setPlaybackTime(){},setProgress(){},
    accumulatePlayingTime:session=>session,recoverCurrentTrack(){},setToast(){},
    advanceFromFinishedAudio(){throw Error("Canceled incoming start must not advance the queue");},
    withTimeout:(promise)=>Promise.resolve(promise)};
  for(const name of ["holdAudioParam","unavailableTransitionAnalysis","releaseMusicAudio","getAudiblePlaybackTime","wireMusicAudio","fadeMusicVolume","abortActiveTransition","togglePlayback"])
    c[name]=bind(name,c,name==="fadeMusicVolume"?["holdAudioParam"]:name==="abortActiveTransition"?["holdAudioParam"]:[]);
  return {c,outgoing,incoming,incomingChain,calls,playing:()=>playing,finishPlay,failPlay,
    start:()=>bind("transitionToTrack",c)(next,1,"automatic","out")};
}

test("outgoing source changed during incoming metadata wait cannot start a stale tail handoff", async () => {
  const h=playingTransitionHarness(),analysis=pcm();let loaded;
  h.c.trackAnalysisRef.current.set("out",analysis);
  h.c.analysisSourceRef.current.set("out",{url:h.outgoing.src,signature:analysis.sourceSignature,duration:h.outgoing.duration});
  h.c.analysisForAudio=bind("analysisForAudio",h.c);
  h.incoming.readyState=0;
  h.incoming.addEventListener=(event,callback)=>{if(event==="loadedmetadata")loaded=callback;};
  const turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof loaded,"function","the real transition is awaiting incoming metadata");
  h.outgoing.src="source-replacement";h.incoming.readyState=2;loaded();
  await new Promise(resolve=>setImmediate(resolve));
  const incomingStarts=h.calls.filter(([action,id])=>action==="play"&&id==="next").length;
  h.finishPlay();assert.equal(await turn,"unavailable");
  assert.equal(incomingStarts,0,"metadata completion must revalidate outgoing before any incoming audio starts");
  assert.equal(h.c.musicAudioRef.current,h.outgoing);assert.equal(h.outgoing.paused,false);
});

test("pause cancels the already-started incoming deck before its play promise settles", async () => {
  const h=playingTransitionHarness(),turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.incoming.paused,false,"reach the actual incoming.play await, not merely source preparation");
  assert.ok(h.incomingChain.gain.gain.value>=.15,"boundary intro already has a nonzero audible gain");
  assert.equal(h.c.activeTransitionRef.current,null,"mixing runtime has not been installed yet");
  await h.c.togglePlayback();
  assert.equal(h.c.userPausedRef.current,true);assert.equal(h.playing(),false);
  assert.equal(h.outgoing.paused,true);
  assert.equal(h.incoming.paused,true,"pause must stop both decks without waiting up to the eight-second media start timeout");
  h.finishPlay();assert.equal(await turn,"unavailable");
  assert.equal(h.c.musicAudioRef.current,h.outgoing);assert.equal(h.outgoing.paused,true);
});

test("quick pause then resume cannot let a delayed incoming rejection undo the resumed current song", async () => {
  const h=playingTransitionHarness(),turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  const pause=h.c.togglePlayback();
  assert.equal(h.incoming.paused,true,"pending deck is stopped synchronously before either fade completes");
  const resume=h.c.togglePlayback();
  h.failPlay(Error("the canceled incoming start rejected late"));
  await Promise.all([turn,pause,resume]);
  assert.equal(h.c.musicAudioRef.current,h.outgoing);assert.equal(h.outgoing.paused,false);
  assert.equal(h.c.userPausedRef.current,false);assert.equal(h.playing(),true);
  assert.equal(h.c.pendingTransitionAudioRef.current,null);
  assert.equal(h.calls.filter(([action,id])=>action==="play"&&id==="next").length,1,"do not retry the canceled deck");
});

test("old incoming completion cannot restore old audio or clear a newer pending transition", async () => {
  const h=playingTransitionHarness(),turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  h.c.abortActiveTransition("manual-track");
  assert.equal(h.incoming.paused,true);
  const newAudio={src:"source-new-choice",paused:false},newPending={requestId:99,audio:{src:"source-new-next",paused:true}};
  h.c.musicAudioRef.current=newAudio;h.c.activeQQTrackLiveRef.current={mid:"new-choice"};
  h.c.pendingTransitionAudioRef.current=newPending;
  h.finishPlay();assert.equal(await turn,"unavailable");
  assert.equal(h.c.musicAudioRef.current,newAudio);assert.equal(h.c.activeQQTrackLiveRef.current.mid,"new-choice");
  assert.equal(h.c.pendingTransitionAudioRef.current,newPending,"old finally only cleans its own request ID");
});

for(const committed of [false,true]) test(`pause stops both registered mixing decks ${committed?"after":"before"} handoff`, async () => {
  const h=playingTransitionHarness();
  h.incoming.paused=false;h.c.seamlessTransitionRef.current=true;
  h.c.activeTransitionRef.current={id:"mixing",state:"mixing",outgoing:h.outgoing,incoming:h.incoming};
  if(committed) {h.c.musicAudioRef.current=h.incoming;h.c.activeQQTrackLiveRef.current={mid:"next"};}
  const current=h.c.musicAudioRef.current;
  await h.c.togglePlayback();
  assert.equal(h.outgoing.paused,true);assert.equal(h.incoming.paused,true);
  assert.equal(h.c.musicAudioRef.current,current);assert.equal(h.c.userPausedRef.current,true);
  assert.equal(h.playing(),false);assert.equal(h.c.activeTransitionRef.current,null);
});

test("the real beat-lock timer converges without seeking or any visual animation frame", () => {
  let outTime=10.17,inTime=.3+.12*(120/123),rate=120/123;
  const analysis={...pcm(),bpm:120,beatOffset:.17,tempoStable:true,beatGridConfidence:.85};
  const outgoing={get currentTime(){return outTime;},paused:false};
  const incoming={get currentTime(){return inTime;},set currentTime(_value){throw Error("Beat locking must not seek the intro");},
    get playbackRate(){return rate;},set playbackRate(value){rate=value;},paused:false};
  const runtime={id:"lock",state:"mixing",outgoing,incoming,plan:{incomingTempoRatio:120/123},
    outgoingSnapshot:{analysis},incomingSnapshot:{analysis:{...analysis,bpm:123,beatOffset:.3}}};
  const jobs=[],c={...dj,activeTransitionRef:{current:runtime},window:{
    setTimeout(callback,delay){assert.equal(delay,50);jobs.push(callback);},
    requestAnimationFrame(){throw Error("No visual frames in background");}}};
  const error=()=>Math.abs((((inTime-.3)/(60/123)-(outTime-.17)/.5+.5)%1+1)%1-.5);
  const before=error();
  bind("lockTransitionBeats",c)(runtime);
  for(let i=0;i<320;i++){outTime+=.05;inTime+=.05*rate;jobs.shift()();}
  assert.ok(error()<before/5,`actual handler phase error ${before} -> ${error()}`);
  c.activeTransitionRef.current={id:"superseding-selection"};
  const beforeStaleRate=rate;jobs.shift()();
  assert.equal(rate,beforeStaleRate);assert.equal(jobs.length,0,"superseded loop releases its final timer");
});

test("rate recovery uses the audio clock in the background and cannot fight a new mix", () => {
  const audio={playbackRate:.975,dataset:{codioTransition:"restore"}},clock={currentTime:4},jobs=[];
  const c={musicAudioRef:{current:audio},audioContextRef:{current:clock},seamlessTransitionRef:{current:false},
    window:{setTimeout(callback,delay){assert.equal(delay,100);jobs.push(callback);},
      requestAnimationFrame(){throw Error("Recovery must run while minimized");}}};
  const restore=bind("relaxPlaybackRate",c);
  restore(audio,.975,"restore",9000);
  let previous=audio.playbackRate;
  for(let i=0;jobs.length&&i<100;i++){
    clock.currentTime+=.1;jobs.shift()();
    assert.ok(audio.playbackRate>=previous&&audio.playbackRate<=1);previous=audio.playbackRate;
  }
  assert.equal(audio.playbackRate,1);assert.equal(jobs.length,0);
  restore(audio,.98,"restore",9000);
  c.seamlessTransitionRef.current=true;
  const beforeNewMix=audio.playbackRate;clock.currentTime+=2;jobs.shift()();
  assert.equal(audio.playbackRate,beforeNewMix);assert.equal(jobs.length,0);
});

test("a complete phrase handoff initializes audible gain before play and never re-seeks the intro", async () => {
  const h=playingTransitionHarness(),scheduled=[],jobs=[],seeks=[];
  let position=0;
  Object.defineProperty(h.incoming,"currentTime",{get:()=>position,set:value=>{seeks.push(value);position=value;}});
  const analysed=id=>({...pcm(),trackId:id,duration:id==="out"?18:8,effectiveStart:0,effectiveEnd:id==="out"?18:8,
    bpm:id==="out"?120:123,tempoStable:true,beatGridConfidence:.85,phraseConfidence:.8,meter:4,analysisConfidence:.85,
    introFocus:"beats",outroFocus:"beats",beatOffset:.2,downbeats:[],safeOutCues:[{time:12,score:.9}],silence:undefined});
  const snapshots=new Map(["out","next"].map(id=>[id,analysed(id)]));
  h.c.analysisForAudio=id=>snapshots.get(id);
  h.c.window.setTimeout=callback=>{jobs.push(callback);return jobs.length;};
  for(const chain of h.c.analyserNodesRef.current.values()) for(const [name,node] of Object.entries(chain)) {
    if(node.gain) node.gain.setValueCurveAtTime=(values,start,duration)=>scheduled.push({name,values:[...values],start,duration});
  }
  h.c.scheduleDeckPlan=bind("scheduleDeckPlan",h.c,["holdAudioParam","scheduleCurve"]);
  h.c.lockTransitionBeats=bind("lockTransitionBeats",h.c);
  h.c.startTransitionCoordinator=()=>{};
  h.c.waitForTransitionAudioEnd=async(clock,end,_id,_commitAt,commit)=>{clock.currentTime=end;commit?.();};
  for(const name of ["setActiveQueueIndex","setActiveQQTrack","setCurrentCoverData","setPlaybackQuality","setLyricLines",
    "rememberPlayedTrack","beginListeningForTrack","settleCurrentListening","holdTransitionDuringSettling","prepareUpcomingTrack"]) h.c[name]=()=>{};
  h.c.lyricAtTime=()=>"";h.c.recommendationSourceForTrack=()=>"search";
  const turn=h.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.incoming.paused,false,"reach the real incoming play call");
  assert.ok(h.incomingChain.gain.gain.value>=.18,"ordinary phrase intro is already audible before play promise resolves");
  assert.deepEqual(seeks,[0],"start at the intact intro once");
  h.finishPlay();assert.equal(await turn,"played");
  assert.deepEqual(seeks,[0],"phase correction cannot skip/replay intro samples after play");
  assert.equal(scheduled.length,8,"both decks receive actual gain and three EQ AudioParam curves");
  assert.equal(h.c.musicAudioRef.current,h.incoming);assert.equal(h.c.activeQueueIndexRef.current,1);
  assert.ok(Math.abs(h.incoming.playbackRate*123-120)<1e-8);
  assert.equal(h.c.activeTransitionRef.current,null);
});

function completeHandoff(analyses) {
  const h=playingTransitionHarness(),scheduled=[],seeks=[];
  let position=0;
  Object.defineProperty(h.incoming,"currentTime",{get:()=>position,set:value=>{seeks.push(value);position=value;}});
  h.c.analysisForAudio=(id,audio)=>audio.readyState<1?null:analyses.get(id)||null;
  h.c.startTransitionCoordinator=()=>{};
  h.c.waitForTransitionAudioEnd=async(clock,end,_id,_commitAt,commit)=>{
    const delta=end-clock.currentTime;clock.currentTime=end;
    if(!h.outgoing.paused)h.outgoing.currentTime+=delta;
    if(!h.incoming.paused)position+=delta*h.incoming.playbackRate;
    commit?.();
  };
  for(const chain of h.c.analyserNodesRef.current.values())for(const [name,node] of Object.entries(chain))
    if(node.gain)node.gain.setValueCurveAtTime=(values,start,duration)=>scheduled.push({name,values:[...values],start,duration});
  h.c.scheduleDeckPlan=bind("scheduleDeckPlan",h.c,["holdAudioParam","scheduleCurve"]);
  h.c.lockTransitionBeats=()=>{};
  for(const name of ["setActiveQueueIndex","setActiveQQTrack","setCurrentCoverData","setPlaybackQuality","setLyricLines",
    "rememberPlayedTrack","beginListeningForTrack","settleCurrentListening","holdTransitionDuringSettling","prepareUpcomingTrack"])h.c[name]=()=>{};
  h.c.lyricAtTime=()=>"";h.c.recommendationSourceForTrack=()=>"search";
  return {...h,scheduled,seeks};
}

for(const tail of [5,15,30])test(`complete production handoff releases a ${tail}s silent file tail at the verified sound end`, async()=>{
  const a=pcm(tail),h=completeHandoff(new Map([["out",a]]));
  h.outgoing.duration=a.duration;h.outgoing.currentTime=dj.planSilenceHandoff(a,null,"next").outgoingCue+.02;
  const pending=h.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.incoming.paused,false);assert.ok(h.incomingChain.gain.gain.value>=.15);
  h.finishPlay();assert.equal(await pending,"played");
  assert.equal(h.c.musicAudioRef.current,h.incoming);assert.equal(h.c.activeQueueIndexRef.current,1);
  assert.deepEqual(h.seeks,[0],"no skipped or restarted intro");
  const start=h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="incoming_started");
  assert.equal(start.analysisMode,"tail_only");assert.ok(start.outgoingTime<a.silence.lastAudibleTime);
  const committed=h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="committed");
  assert.ok(committed.outgoingTime<a.effectiveEnd+.1);assert.ok(a.duration-committed.outgoingTime>tail-a.silence.guardSeconds-.1);
  assert.equal(h.scheduled.length,8,"actual gain and EQ automation for both decks");
});

test("no analysis uses an actual scheduled neutral mix, without claiming beat lock or seeking the intro",async()=>{
  const h=completeHandoff(new Map());h.outgoing.currentTime=h.outgoing.duration-3.1;
  const pending=h.start();await new Promise(resolve=>setImmediate(resolve));h.finishPlay();
  assert.equal(await pending,"played");assert.equal(h.scheduled.length,8);assert.deepEqual(h.seeks,[0]);
  assert.equal(h.c.activeQueueIndexRef.current,1);assert.equal(h.incoming.playbackRate,1);
  assert.equal(h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="incoming_started").analysisMode,"neutral");
  assert.ok(h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="scheduled").duration>2.8);
});

test("metadata-ready source adopts the existing incoming analysis before deciding the automatic strategy",async()=>{
  const a=pcm(),b={...pcm(0),trackId:"next",duration:8,effectiveEnd:8};
  const h=completeHandoff(new Map([["out",a],["next",b]])),listeners=new Map();
  h.incoming.readyState=0;h.incoming.duration=NaN;
  h.incoming.addEventListener=(name,callback)=>listeners.set(name,callback);
  h.incoming.removeEventListener=(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);};
  const pending=h.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.incoming.paused,true);assert.ok(listeners.has("loadedmetadata"));
  h.incoming.readyState=2;h.incoming.duration=8;listeners.get("loadedmetadata")();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(listeners.size,0);h.finishPlay();
  assert.equal(await pending,"played");
  assert.equal(h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="incoming_started").analysisMode,"pair");
});

test("late play resolution keeps the already-audible intro instead of discarding and restarting it",async()=>{
  const a=pcm(),h=completeHandoff(new Map([["out",a]]));
  const pending=h.start();await new Promise(resolve=>setImmediate(resolve));
  h.outgoing.currentTime=a.effectiveEnd+.4;h.finishPlay();
  assert.equal(await pending,"played");assert.equal(h.c.musicAudioRef.current,h.incoming);
  assert.deepEqual(h.seeks,[0]);assert.equal(h.calls.filter(([name,id])=>name==="play"&&id==="next").length,1);
  assert.ok(h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="scheduled").duration<=.15);
});

test("verified tail arriving during metadata preparation replaces the neutral file-end plan",async()=>{
  const analyses=new Map(),a=pcm(),h=completeHandoff(analyses),listeners=new Map();
  h.incoming.readyState=0;h.incoming.duration=NaN;
  h.incoming.addEventListener=(name,callback)=>listeners.set(name,callback);
  h.incoming.removeEventListener=(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);};
  const pending=h.start();await new Promise(resolve=>setImmediate(resolve));
  analyses.set("out",a);h.incoming.readyState=2;h.incoming.duration=8;listeners.get("loadedmetadata")();
  await new Promise(resolve=>setImmediate(resolve));h.finishPlay();assert.equal(await pending,"played");
  const start=h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="incoming_started");
  assert.equal(start.analysisMode,"tail_only");assert.equal(start.effectiveEnd,a.effectiveEnd);
});

test("automatic source/start waits are bounded by the real sound end, not the silent file duration",async()=>{
  const a=pcm(30),h=completeHandoff(new Map([["out",a]])),budgets=[];
  h.outgoing.duration=a.duration;
  h.c.withTimeout=(promise,ms,label)=>{budgets.push({ms,label});return Promise.resolve(promise);};
  const pending=h.start();await new Promise(resolve=>setImmediate(resolve));h.finishPlay();
  assert.equal(await pending,"played");
  for(const label of ["TRANSITION_SOURCE","TRANSITION_AUDIO_START"]){
    const budget=budgets.find(item=>item.label===label);assert.ok(budget);assert.ok(budget.ms>0&&budget.ms<=1300,label);
  }
});

test("the actual two-deck runtime schedules substantial shared music before a measured fade, not only two play calls",async()=>{
  const rate=8000;
  const make=(id,fade)=>{
    const samples=Float32Array.from({length:30*rate},(_,i)=>Math.sin(i/rate*Math.PI*440)*
      (fade&&i/rate>22?.15*Math.exp(-(i/rate-22)*1.2)+.00004:.15));
    return {...dj.analyzePcmTrack({trackId:id,sampleRate:rate,channels:[samples],sourceSignature:`synth-${id}`}),
      bpm:id==="out"?72:91,tempoStable:false,beatGridConfidence:.25,phraseConfidence:.1,meter:null,introFocus:"beats",outroFocus:"beats"};
  };
  const a=make("out",true),b=make("next",false),plan=dj.planTransition(a,b),h=completeHandoff(new Map([["out",a],["next",b]]));
  h.outgoing.duration=a.duration;h.incoming.duration=b.duration;h.outgoing.currentTime=plan.outgoingCue+.02;
  const pending=h.start();await new Promise(resolve=>setImmediate(resolve));h.finishPlay();assert.equal(await pending,"played");
  const timing=h.c.window.codioPlaybackDiagnostics.find(item=>item.stage==="scheduled");
  assert.equal(timing.strategy,"breakdown-bridge");assert.ok(timing.duration>9);assert.ok(timing.plannedDuration>9);
  const gains=h.scheduled.filter(item=>item.name==="gain");assert.equal(gains.length,2);
  const at=(curve,p)=>curve[Math.min(curve.length-1,Math.floor(p*(curve.length-1)))];
  const energy=(analysis,t)=>analysis.featureFrames.reduce((last,frame)=>frame.time<=t?frame:last,{energy:0}).energy;
  let shared=0;
  for(let t=0;t<timing.duration;t+=.05){
    if(energy(a,plan.outgoingCue+t)*at(gains[0].values,t/timing.duration)>.1
      &&energy(b,plan.incomingCue+t)*at(gains[1].values,t/timing.duration)>.1)shared+=.05;
  }
  assert.ok(shared>4,`Only ${shared}s of normalized-envelope co-presence; an empty-tail fade is not a musical blend`);
  assert.equal(h.c.musicAudioRef.current,h.incoming);assert.equal(h.incoming.playbackRate,1);assert.deepEqual(h.seeks,[0]);
});
