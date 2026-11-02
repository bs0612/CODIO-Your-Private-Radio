import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const directory = new URL("../.test-build/tail-silence/", import.meta.url);
let dj;
before(async () => {
  await mkdir(directory, { recursive: true });
  const output = new URL("seamless.mjs", directory);
  await build({ entryPoints: [new URL("../app/seamless-dj.ts", import.meta.url).pathname.slice(1)], outfile: output.pathname.slice(1), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  dj = await import(`${output.href}?${Date.now()}`);
});
after(async () => rm(directory, { recursive: true, force: true }));

const sampleRate = 8000;
const signature = "a".repeat(64);
const pcm = (duration, amplitude = () => .15) => Float32Array.from({ length: duration * sampleRate }, (_, index) => Math.sin(index / sampleRate * 2 * Math.PI * 173) * amplitude(index / sampleRate));
const analyze = (channels, trackId = "test-tail", sourceSignature = signature) => dj.analyzePcmTrack({ trackId, sampleRate, channels, sourceSignature });
const close = (actual, expected, tolerance = .021) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

for (const seconds of [5, 15, 30]) test(`${seconds}s true terminal silence shortens the actual handoff window, not the music`, () => {
  const result = analyze([pcm(20 + seconds, time => time < 20 ? .15 : 0)]);
  assert.ok(result);
  close(result.duration, 20 + seconds);
  close(result.silence.lastAudibleTime, 20);
  close(result.silence.trailingSeconds, seconds);
  close(result.effectiveEnd, 20.28);
  assert.equal(result.silence.tailConfidence >= .9, true);
  const plan = dj.planSilenceHandoff(result, null, "next-real-source", "tail-plan");
  close(plan.outgoingCue + plan.transitionDuration, result.effectiveEnd);
  assert.ok(plan.outgoingCue < 20 && plan.outgoingCue > 19);
  assert.equal(plan.incomingCue, 0);
  assert.equal(plan.incomingTempoRatio, 1);
  assert.equal(plan.targetBpm, null);
});

test("slow fade and very quiet vocals remain until the last genuinely audible sample", () => {
  const result = analyze([pcm(45, time => time < 20 ? .15 : time < 30 ? .15 * Math.exp(-(time - 20) * .75) + .00008 : 0)]);
  close(result.silence.lastAudibleTime, 30);
  close(result.effectiveEnd, 30.28);
  const quiet = analyze([pcm(30, time => time < 20 ? .15 : .00003)]);
  assert.equal(quiet.effectiveEnd, 30);
  assert.equal(quiet.silence.tailConfidence, 0);
});

test("a quiet reverb tail is preserved instead of classified with the former -56dB threshold", () => {
  const result = analyze([pcm(32, time => time < 20 ? .15 : .00016 * Math.exp(-(time - 20) * .1))]);
  assert.equal(result.effectiveEnd, 32);
  assert.equal(result.silence.tailConfidence, 0);
});

test("mono, one-sided stereo, antiphase stereo and a third sounding channel are not silent", () => {
  const sound = pcm(30), zero = new Float32Array(sound.length);
  const antiphase = Float32Array.from(sound, value => -value);
  for (const channels of [[sound], [zero, sound], [sound, antiphase], [zero, zero, sound]]) {
    const result = analyze(channels);
    assert.ok(result);
    assert.equal(result.effectiveEnd, 30);
    assert.equal(result.silence.tailConfidence, 0);
    assert.ok(result.waveform.some(value => value > .5));
  }
});

test("an intermediate twenty-second pause cannot truncate later resumed music", () => {
  const result = analyze([pcm(45, time => time >= 10 && time < 30 ? 0 : .15)]);
  assert.equal(result.effectiveEnd, 45);
  assert.equal(result.silence.lastAudibleTime, 45);
});

test("live applause and occasional audible tail events retain their full region", () => {
  const result = analyze([pcm(35, time => time < 20 ? .15 : time % .8 < .15 ? .0004 : 0)]);
  assert.equal(result.effectiveEnd, 35);
  assert.equal(result.silence.tailConfidence, 0);
});

test("sustained near-digital noise is distinguishable from quiet music; all-silent PCM is not a musical endpoint", () => {
  const result = analyze([pcm(35, time => time < 20 ? .15 : .0000004)]);
  close(result.silence.lastAudibleTime, 20);
  assert.equal(result.silence.tailConfidence >= .9, true);
  assert.equal(analyze([new Float32Array(30 * sampleRate)]), null);
  const invalid = pcm(30); invalid[100] = NaN;
  assert.equal(analyze([invalid]), null);
});

test("source signature and actual media duration must match the cached endpoint evidence", () => {
  const result = analyze([pcm(35, time => time < 20 ? .15 : 0)]);
  assert.equal(dj.isTrackAnalysisSourceValid(result, "test-tail", signature, 35), true);
  assert.equal(dj.isTrackAnalysisSourceValid(result, "other-version", signature, 35), false);
  assert.equal(dj.isTrackAnalysisSourceValid(result, "test-tail", "b".repeat(64), 35), false);
  assert.equal(dj.isTrackAnalysisSourceValid(result, "test-tail", signature, 36), false);
  assert.equal(dj.isTrackAnalysisSourceValid({ ...result, silence: undefined }, "test-tail", signature, 35), false);
  assert.equal(dj.isTrackAnalysisSourceValid({ ...result, effectiveEnd: 19 }, "test-tail", signature, 35), false);
  assert.equal(dj.isTrackAnalysisSourceValid({ ...result, silence: { ...result.silence, windowSeconds: NaN } }, "test-tail", signature, 35), false);
});

test("a reliable sound endpoint still provides a short safe handoff when incoming analysis is absent", () => {
  const outgoing = analyze([pcm(35, time => time < 20 ? .15 : 0)]);
  const incoming = analyze([pcm(30)]);
  const weak = { tempoStable: false, beatGridConfidence: .1, phraseConfidence: 0, analysisConfidence: .1 };
  const plan = dj.planSilenceHandoff({ ...outgoing, ...weak }, null, incoming.trackId, "safe-boundary");
  assert.equal(plan.boundaryHandoff, true);
  assert.equal(dj.isTransitionPlanUsable(plan, outgoing.trackId, incoming.trackId), true);
  assert.equal(plan.incomingCue, 0);
  assert.equal(plan.incomingTempoRatio, 1);
  assert.ok(plan.incomingGainCurve[0] >= .18);
  assert.ok(plan.incomingGainCurve[Math.floor(plan.incomingGainCurve.length * .3)] > .95);
  const lastSoundIndex = Math.floor((outgoing.silence.lastAudibleTime - plan.outgoingCue) / plan.transitionDuration * 63);
  assert.ok(plan.outgoingGainCurve[lastSoundIndex - 1] > .999);
  for (const field of ["incomingLowCurve", "incomingMidCurve", "incomingHighCurve", "outgoingLowCurve", "outgoingMidCurve", "outgoingHighCurve"]) assert.ok(plan[field].every(value => value === 1));
});

test("two analysed songs without a beat lock blend rather than always collapsing into a subsecond tail handoff", () => {
  const outgoing=analyze([pcm(35,time=>time<20?.15:0)]),incoming=analyze([pcm(30)],"incoming");
  const weak={tempoStable:false,beatGridConfidence:.1,phraseConfidence:0,analysisConfidence:.1};
  const plan=dj.planTransition({...outgoing,...weak},{...incoming,...weak});
  assert.equal(plan.strategy,"breakdown-bridge");assert.notEqual(plan.boundaryHandoff,true);
  assert.ok(plan.transitionDuration>1);close(plan.outgoingCue+plan.transitionDuration,outgoing.effectiveEnd);
  assert.equal(plan.incomingCue,0);assert.equal(plan.incomingTempoRatio,1);
});

test("only measured leading silence is removed: late musical safeIn cues never eat an intro", () => {
  const outgoing = analyze([pcm(35, time => time < 20 ? .15 : 0)]);
  const incoming = analyze([pcm(30, time => time < 2 ? 0 : .15)], "intro");
  const plan = dj.planSilenceHandoff(outgoing, { ...incoming, safeInCues: [{ time: 8, score: 1, reason: "musical boundary" }] }, incoming.trackId);
  close(plan.incomingCue, 1.96);
  const noBoundaryEvidence = { ...incoming, silence: undefined, effectiveStart: 5 };
  assert.equal(dj.planSilenceHandoff(outgoing, noBoundaryEvidence, "intro").incomingCue, 0);
});

test("missing or low-confidence silence evidence cannot crop a song or claim a safe boundary plan", () => {
  const outgoing = analyze([pcm(35, time => time < 20 ? .15 : 0)]);
  assert.equal(dj.planSilenceHandoff({ ...outgoing, silence: undefined }, null, "next"), null);
  assert.equal(dj.planSilenceHandoff({ ...outgoing, silence: { ...outgoing.silence, tailConfidence: .4 } }, null, "next"), null);
  assert.equal(dj.planSilenceHandoff({ ...outgoing, effectiveEnd: outgoing.duration }, null, "next"), null);
});
