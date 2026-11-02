import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const dir = new URL("../.test-build/seamless-dj/", import.meta.url);
const output = new URL("seamless-dj.mjs", dir);
let dj;
before(async () => { await mkdir(dir, { recursive: true }); await build({ entryPoints: [new URL("../app/seamless-dj.ts", import.meta.url).pathname.slice(1)], outfile: output.pathname.slice(1), bundle: true, platform: "node", format: "esm", logLevel: "silent" }); dj = await import(`${output.href}?${Date.now()}`); });
after(async () => rm(dir, { recursive: true, force: true }));

const analysis = (id, overrides = {}) => ({
  version: 2, trackId: id, duration: 240, effectiveStart: 0, effectiveEnd: 240, bpm: 120,
  tempoConfidence: .9, tempoStable: true, beats: [], downbeats: [], meter: 4, beatGridConfidence: .85,
  phraseBoundaries: [0, 16, 32], phraseConfidence: .8, sections: [], key: null, keyConfidence: 0,
  chromaByBar: [], integratedLufs: -14, truePeakDb: -1.4, shortTermLoudnessByBar: [], energyByBar: [],
  bassEnergyByBar: [.4], vocalProbabilityByBar: [.2], spectralFluxByBar: [], safeInCues: [{ time: 0, score: .9, reason: "start" }],
  safeOutCues: [{ time: 224, score: .9, reason: "phrase" }], analysisConfidence: .86, waveform: [],
  introFocus: "beats", outroFocus: "beats", introConfidence: .8, outroConfidence: .8, beatOffset: 0,
  visualCues: [], featureFrames: [],
  ...overrides,
});

test("stable compatible tracks receive a phrase EQ plan", () => {
  const plan = dj.planTransition(analysis("a"), analysis("b", { bpm: 123 }), "p1");
  assert.equal(plan.strategy, "phrase-eq-blend");
  assert.ok(plan.incomingTempoRatio >= .96 && plan.incomingTempoRatio <= 1.04);
  assert.equal(plan.outgoingTempoRatio, 1);
  assert.equal(plan.incomingCue, 0);
});

test("incoming tempo matches the unchanged outgoing deck instead of drifting at their midpoint", () => {
  for (const bpm of [117, 123, 61.5]) {
    const plan = dj.planTransition(analysis("a"), analysis("b", { bpm }));
    const normalizedBpm = bpm < 90 ? bpm * 2 : bpm;
    assert.equal(plan.targetBpm, 120);
    assert.ok(Math.abs(normalizedBpm * plan.incomingTempoRatio - 120) < 1e-9);
    assert.equal(plan.outgoingTempoRatio, 1);
  }
});

test("measured downbeats place an intact intro and the bass exchange inside the safe outro", () => {
  const outgoing = analysis("a", { downbeats: Array.from({ length: 120 }, (_, i) => .3 + i * 2) });
  const incoming = analysis("b", { version: 3, bpm: 123, beatOffset: .2, downbeats: [.2, .2 + 240 / 123] });
  const plan = dj.planTransition(outgoing, incoming);
  const firstIncomingDownbeat = plan.outgoingCue + (.2 - plan.incomingCue) / plan.incomingTempoRatio;
  const exchange = plan.outgoingCue + plan.transitionDuration * plan.switchPoint;
  assert.equal(plan.incomingCue, 0);
  assert.ok(outgoing.downbeats.some(time => Math.abs(time - firstIncomingDownbeat) < 1e-8));
  assert.ok(outgoing.downbeats.some(time => Math.abs(time - exchange) < 1e-8));
  assert.ok(plan.outgoingCue >= 224);
  assert.ok(Math.abs(plan.outgoingCue + plan.transitionDuration - 240) < 1e-8);
  const swapIndex = Math.round(plan.switchPoint * 63);
  assert.ok(plan.outgoingLowCurve[swapIndex] < .5);
  assert.ok(plan.incomingLowCurve[swapIndex] > .25);
});

test("phase correction converges with bounded speed changes and never changes a media position", () => {
  const outgoing = analysis("a", { beatOffset: .17 });
  const incoming = analysis("b", { bpm: 123, beatOffset: .3 });
  const base = 120 / 123;
  let outTime = 10.17, inTime = .3 + .12 * base, rate = base;
  const phaseError = () => Math.abs((((inTime - .3) / (60 / 123) - (outTime - .17) / .5 + .5) % 1 + 1) % 1 - .5);
  const before = phaseError();
  for (let i = 0; i < 320; i++) {
    const correction = dj.beatMatchingRate(outgoing, incoming, outTime, inTime, base);
    assert.ok(correction >= .96 && correction <= 1.04);
    assert.ok(Math.abs(correction / base - 1) <= .010001);
    rate += (correction - rate) * .2;
    outTime += .05; inTime += .05 * rate;
  }
  assert.ok(phaseError() < before / 5, `phase error ${before} -> ${phaseError()}`);
  assert.equal(dj.beatMatchingRate({ ...outgoing, beatGridConfidence: .2 }, incoming, 10, .4, base), base);
});

test("every automatic strategy starts the musical intro at a nonzero gain", () => {
  for (const overrides of [{}, { outroFocus: "vocal", introFocus: "vocal" }, { tempoStable: false, beatGridConfidence: .2 }]) {
    const plan = dj.planTransition(analysis("a", overrides), analysis("b", { ...overrides, version: 3 }));
    assert.equal(plan.incomingCue, 0);
    assert.ok(plan.incomingGainCurve[0] >= .18);
    assert.ok(plan.incomingGainCurve.every(value => value >= .18 && value <= 1));
    for (let index = 0; index < plan.incomingGainCurve.length; index++) {
      const power = plan.incomingGainCurve[index] ** 2 + plan.outgoingGainCurve[index] ** 2;
      assert.ok(Math.abs(power - 1) < 1e-8, "the audible intro floor must not create a mid-mix power swell");
    }
  }
});

test("dense vocals avoid a long phrase blend", () => {
  const plan = dj.planTransition(analysis("a", { outroFocus: "vocal" }), analysis("b", { introFocus: "vocal" }), "p2");
  assert.equal(plan.strategy, "downbeat-cut");
  assert.ok(plan.transitionDuration <= 2.6);
});

test("uncertain tempo falls back to an ambient bridge without time stretching", () => {
  const weak = { tempoStable: false, beatGridConfidence: .2, phraseConfidence: .1, analysisConfidence: .3, meter: null };
  const plan = dj.planTransition(analysis("a", weak), analysis("b", { ...weak, bpm: 91 }), "p3");
  assert.equal(plan.strategy, "breakdown-bridge");
  assert.equal(plan.targetBpm, null);
  assert.equal(plan.incomingTempoRatio, 1);
});

test("tempo mismatch by itself cannot turn a musical blend into a hard cut",()=>{
  for(const bpm of [72,91,150]){
    const plan=dj.planTransition(analysis("out",{bpm:120}),analysis("in",{bpm}));
    assert.equal(plan.strategy,"breakdown-bridge");assert.equal(plan.incomingTempoRatio,1);
    assert.ok(plan.transitionDuration>=5.5);assert.equal(plan.incomingCue,0);
    assert.ok(plan.incomingGainCurve[0]>=.25);assert.ok(plan.incomingLowCurve[0]>=.6);
    for(let i=0;i<plan.incomingGainCurve.length;i++)assert.ok(Math.abs(plan.incomingGainCurve[i]**2+plan.outgoingGainCurve[i]**2-1)<1e-8);
  }
});

const fadeFrames=(energy,end=240)=>Array.from({length:320},(_,i)=>({time:end-32+i*.1,energy:energy(end-32+i*.1),bass:0,brightness:0,spectralFlux:0,vocalProbability:0}));
test("a measured late fade moves the blend before music disappears but never crops the fade",()=>{
  const out=analysis("unrelated-out",{bpm:72,tempoStable:false,beatGridConfidence:.3,phraseConfidence:.1,
    safeOutCues:[{time:237.4,score:.34,reason:"weak late cue"}],
    featureFrames:fadeFrames(t=>t<234?.7:Math.max(.00008,.7*Math.exp(-(t-234)*1.5)))});
  const incoming=analysis("unrelated-in",{bpm:91});
  const plan=dj.planTransition(out,incoming);
  assert.equal(plan.strategy,"breakdown-bridge");assert.ok(plan.transitionDuration>=10);
  assert.ok(plan.outgoingCue<232,"both songs must overlap before the old music has faded away");
  assert.ok(Math.abs(plan.outgoingCue+plan.transitionDuration-240)<1e-8);
  assert.equal(out.effectiveEnd,240,"a fade-aware overlap is not a silence crop");assert.equal(plan.incomingCue,0);
  assert.ok(plan.reasons.some(reason=>reason.includes("持续渐弱")));
});

test("missing or sparse features, constant quiet music, and a mid-song pause cannot invent a fade window",()=>{
  const safe={safeOutCues:[{time:238,score:.9,reason:"only confirmed window"}],tempoStable:false,beatGridConfidence:.2};
  for(const featureFrames of [[],[{time:239,energy:.001}],fadeFrames(()=>.00008),fadeFrames(t=>t>230&&t<236?0:.7)]){
    const plan=dj.planTransition(analysis("out",{...safe,featureFrames}),analysis("in",{bpm:91}));
    assert.ok(plan.outgoingCue>=238);assert.ok(plan.transitionDuration<=2);
    assert.ok(!plan.reasons.some(reason=>reason.includes("持续渐弱")));
  }
});

test("automatic plans never stretch a short safe outro into earlier musical material", () => {
  const shortOutro = { safeOutCues: [{ time: 238, score: .9, reason: "last safe musical window" }] };
  for (const overrides of [
    {},
    { tempoStable: false, beatGridConfidence: .2, phraseConfidence: .1, analysisConfidence: .3, meter: null },
    { outroFocus: "vocal", introFocus: "vocal", bpm: 70 },
  ]) {
    const plan = dj.planTransition(analysis("a", { ...overrides, ...shortOutro }), analysis("b", overrides));
    assert.ok(plan.outgoingCue >= 238, `${plan.strategy} starts before the measured safe outro: ${plan.outgoingCue}`);
    assert.ok(plan.transitionDuration <= 2, `${plan.strategy} exceeds the two-second window`);
    assert.ok(Math.abs(plan.outgoingCue + plan.transitionDuration - 240) < .001);
  }
});

test("a short incoming song is not consumed before the automatic mix can commit", () => {
  const incoming = analysis("short", { duration: 3, effectiveEnd: 3 });
  const plan = dj.planTransition(analysis("a"), incoming);
  assert.ok(plan.transitionDuration * plan.incomingTempoRatio <= 3, "the transition must finish while the incoming song still exists");
});

test("measured silence may be skipped but musical intro remains", () => {
  const plan = dj.planTransition(analysis("a"), analysis("b", { effectiveStart: 2.2, safeInCues: [{ time: 8, score: 1, reason: "late cue" }] }), "p4");
  assert.ok(plan.incomingCue >= 2.2 && plan.incomingCue <= 3.45);
});

test("plan validation rejects stale track pairs", () => {
  const plan = dj.planTransition(analysis("a"), analysis("b"), "p5");
  assert.equal(dj.isTransitionPlanUsable(plan, "a", "b"), true);
  assert.equal(dj.isTransitionPlanUsable(plan, "old", "b"), false);
});

test("visual handoff is bounded, monotonic and switches identity once", () => {
  const times = Array.from({ length: 41 }, (_, index) => 10 + index * .1);
  const frames = times.map((time) => dj.getTransitionVisualFrame("phrase-eq-blend", 10, 4, .52, time));
  for (const frame of frames) {
    for (const value of [frame.progress, frame.outgoingWeight, frame.incomingWeight, frame.identityMix, frame.backgroundMix, frame.particleMix, frame.waveformMix, frame.lyricMix]) {
      assert.ok(value >= 0 && value <= 1);
    }
  }
  for (let index = 1; index < frames.length; index += 1) {
    assert.ok(frames[index].progress >= frames[index - 1].progress);
    assert.ok(frames[index].identityMix >= frames[index - 1].identityMix);
  }
  assert.equal(frames.filter((frame, index) => index && frame.beforeSwitch !== frames[index - 1].beforeSwitch).length, 1);
});

test("visual handoff follows AudioContext time and remains hidden before its scheduled start", () => {
  const early = dj.getTransitionVisualFrame("downbeat-cut", 20, 1.2, .5, 19.9);
  const middle = dj.getTransitionVisualFrame("downbeat-cut", 20, 1.2, .5, 20.6);
  const done = dj.getTransitionVisualFrame("downbeat-cut", 20, 1.2, .5, 21.4);
  assert.equal(early.phase, "hidden");
  assert.equal(early.incomingWeight, 0);
  assert.ok(middle.progress > 0 && middle.progress < 1);
  assert.equal(done.progress, 1);
  assert.equal(done.phase, "complete");
});

test("manual transitions reuse the plan with bounded product response times", () => {
  const base = dj.planTransition(analysis("a"), analysis("b", { bpm: 122 }), "manual");
  const next = dj.adaptTransitionPlan(base, "manual-next", false);
  const previous = dj.adaptTransitionPlan(base, "manual-previous", false);
  const selected = dj.adaptTransitionPlan(base, "manual-select", false);
  const paused = dj.adaptTransitionPlan(base, "manual-select", true);
  assert.ok(next.transitionDuration >= .6 && next.transitionDuration <= 1.4);
  assert.ok(previous.transitionDuration >= .4 && previous.transitionDuration <= .9);
  assert.ok(selected.transitionDuration >= .4 && selected.transitionDuration <= .9);
  assert.ok(paused.transitionDuration >= .25 && paused.transitionDuration <= .5);
  assert.equal(paused.incomingTempoRatio, 1);
  assert.equal(paused.outgoingTempoRatio, 1);
});

test("neutral bridge carries no invented tempo when analysis is unavailable", () => {
  const plan = dj.createNeutralTransitionPlan("a", "b", "neutral", "manual-select", false);
  assert.equal(plan.strategy, "breakdown-bridge");
  assert.equal(plan.targetBpm, null);
  assert.equal(plan.incomingTempoRatio, 1);
  assert.equal(plan.outgoingTempoRatio, 1);
  assert.equal(plan.confidence, 0);
});

test("each strategy has a distinct visual envelope and a real settling window", () => {
  const phrase = dj.getTransitionVisualFrame("phrase-eq-blend", 10, 1, .55, 10.35);
  const cut = dj.getTransitionVisualFrame("downbeat-cut", 10, 1, .55, 10.35);
  const bridge = dj.getTransitionVisualFrame("breakdown-bridge", 10, 1, .55, 10.35);
  assert.notDeepEqual(
    [phrase.particleMix, phrase.backgroundMix, phrase.identityMix],
    [cut.particleMix, cut.backgroundMix, cut.identityMix],
  );
  assert.notDeepEqual(
    [phrase.particleMix, phrase.backgroundMix, phrase.identityMix],
    [bridge.particleMix, bridge.backgroundMix, bridge.identityMix],
  );
  assert.ok(dj.transitionSettlingDuration("phrase-eq-blend") >= .5);
  assert.ok(dj.transitionSettlingDuration("downbeat-cut") >= .22);
  assert.ok(dj.transitionSettlingDuration("breakdown-bridge") >= .6);
  const phraseMotion = dj.getTransitionChoreography("phrase-eq-blend", .5);
  const cutMotion = dj.getTransitionChoreography("downbeat-cut", .5);
  const bridgeMotion = dj.getTransitionChoreography("breakdown-bridge", .5);
  assert.notDeepEqual(phraseMotion, cutMotion);
  assert.notDeepEqual(phraseMotion, bridgeMotion);
  assert.ok(bridgeMotion.density < phraseMotion.density);
  assert.ok(bridgeMotion.luminance < phraseMotion.luminance);
  assert.ok(cutMotion.energy !== bridgeMotion.energy);
});

test("music visual cues fire only from the analyzed song timeline", () => {
  const withCues = analysis("cue", {
    beats: [0, .5, 1, 1.5, 2],
    visualCues: [{ time: 1, type: "drop", strength: .92, confidence: .88 }],
    featureFrames: [{ time: 0, energy: .2, bassEnergy: .2, vocalProbability: .1, spectralFlux: .1 }, { time: 1, energy: .86, bassEnergy: .8, vocalProbability: .25, spectralFlux: .9 }],
  });
  const frame = dj.getMusicVisualFrame(withCues, 1.02);
  assert.equal(frame.beatIndex, 2);
  assert.ok(frame.dramaticEnvelope > .5);
  assert.ok(frame.continuousEnergy > .8);
  assert.equal(dj.getMusicVisualFrame(withCues, .2).dramaticEnvelope, 0);
});

test("PCM analysis emits one unified cached timeline with restrained dramatic cues", () => {
  const sampleRate = 8000;
  const duration = 48;
  const channel = new Float32Array(sampleRate * duration);
  for (let index = 0; index < channel.length; index += 1) {
    const time = index / sampleRate;
    const sectionGain = time < 16 ? .035 : time < 32 ? .11 : .055;
    channel[index] = Math.sin(time * Math.PI * 2 * 110) * sectionGain;
  }
  for (let time = .5; time < duration; time += .5) {
    const start = Math.floor(time * sampleRate);
    for (let index = 0; index < 90 && start + index < channel.length; index += 1) channel[start + index] += .65 * (1 - index / 90);
  }
  const result = dj.analyzePcmTrack({ trackId: "synthetic", sampleRate, channels: [channel] });
  assert.ok(result);
  assert.equal(result.version, 3);
  assert.equal(result.trackId, "synthetic");
  assert.ok(result.beats.length > 20);
  assert.equal(result.featureFrames.length > 100, true);
  const dramatic = result.visualCues.filter((cue) => ["drop", "accent", "section-enter"].includes(cue.type) && cue.strength >= .78 && cue.confidence >= .7);
  assert.ok(dramatic.length <= 3);
  for (let index = 1; index < dramatic.length; index += 1) {
    assert.ok(dramatic[index].time > dramatic[index - 1].time);
  }
});
