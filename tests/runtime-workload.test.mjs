import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(compile(await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8"))).toString("base64")}`);
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const variables = new Map(), functions = new Map();
let memoryEffect, queueAssignment;
(function visit(node) {
  if (ts.isVariableDeclaration(node)) variables.set(node.name.getText(ast), node.initializer?.getText(ast));
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === "queueSelectionRef.current") queueAssignment = node.getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("setLikedTracks")) memoryEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
})(ast);
const bind = (code, c) => new Function("c", `with(c){${compile(code)}}`)(c);
const NOW = Date.UTC(2026, 10, 2, 12);
const unknown = () => ({ value: null, source: "audio_analysis", confidence: 0, profileEligible: false });
function candidate(id, genre = "genre:neo-soul", artist = `artist ${id}`) {
  return { canonicalKey: `qq:${id}`, track: { id, provider: "qq", title: id, artist }, source: "adjacent_discovery", generationReason: "isolated workload fixture",
    sourceConfidence: .95, alreadyHeard: false, alreadyRecommended: false, inLibrary: false, playable: true,
    featureVector: { provider: "qq", trackId: id, artist, tags: [genre, "language:english"].map(value => ({ value, source: "provider_metadata", confidence: .65, profileEligible: true })),
      bpm: unknown(), energy: unknown(), vocalFocus: unknown(), instrumentalFocus: unknown(), transitionFocus: unknown(),
      inLibrary: false, likedInProvider: false, artistFamiliarity: 0, playlistMembership: [], playCount: 0,
      novelty: { value: .8, source: "library_behavior", confidence: .8, profileEligible: false }, metadataConfidence: .95 } };
}
function preference(memory, item, value = "more", now = NOW, scope = "track") {
  return api.recordListeningEvent(memory, { type: "preference_changed", eventId: `${item.track.id}-${value}-${now}`, sessionId: memory.currentSession.sessionId,
    createdAt: now, targetType: "track", targetKey: item.canonicalKey, value, scope, source: "player", title: item.track.title, artist: item.track.artist, features: item.featureVector });
}

test("batch evidence keeps every final contribution/admission identical while avoiding repeated library tag normalization", t => {
  const items = Array.from({ length: 60 }, (_, i) => candidate(`new${i}`, i % 2 ? "genre:neo-soul" : "genre:indie-folk"));
  let reads = 0;
  const library = Array.from({ length: 100 }, (_, i) => {
    const feature = { ...candidate(`library${i}`, i % 2 ? "genre:neo-soul" : "genre:indie-folk").featureVector, inLibrary: true };
    const tags = feature.tags;
    Object.defineProperty(feature, "tags", { get() { reads++; return tags; } }); return feature;
  });
  let memory = api.createEmptyListeningMemory();
  memory = preference(memory, candidate("liked")); memory = preference(memory, candidate("less", "genre:indie-folk"), "less");
  const profile = api.deriveListeningProfile(memory, NOW);
  const options = { libraryFeatures: library, timeBucket: "evening", weather: "Rain" };
  reads = 0;
  const unbatched = ["match", "frontier"].flatMap(lane => items.map(item => api.scoreCandidate(item, profile, memory, lane, NOW, options)));
  const before = reads;
  reads = 0;
  const evidence = api.prepareScoringEvidence(profile, memory, NOW, library);
  const batched = ["match", "frontier"].flatMap(lane => items.map(item => api.scoreCandidate(item, profile, memory, lane, NOW, { ...options, evidence })));
  assert.deepEqual(batched, unbatched, "No weight, reason, confidence, lane qualification or final contribution changes");
  assert.ok(reads < before / 20, `${before} -> ${reads} source tag reads`);
  t.diagnostic(`120 candidate scores / 100 library identities: repeated library tag reads ${before} -> ${reads}; all scores identical`);
});

test("shared evidence cannot survive preference withdrawal, new library/profile, backwards clock or session expiry", () => {
  const item = candidate("next"), anchor = candidate("anchor");
  let memory = preference(api.createEmptyListeningMemory(), anchor, "more", NOW, "session");
  memory = api.recordListeningEvent(memory, { type: "session_intent_changed", eventId: "intent", sessionId: memory.currentSession.sessionId,
    createdAt: NOW, intent: { ...api.createSessionIntent({}, NOW), expiresAt: NOW + 1000 } });
  const profile = api.deriveListeningProfile(memory, NOW), library = [anchor.featureVector];
  const evidence = api.prepareScoringEvidence(profile, memory, NOW, library);
  assert.equal(evidence.expiresAt, NOW + 1000);
  const corrected = preference(memory, anchor, "neutral", NOW + 1), newProfile = api.deriveListeningProfile(corrected, NOW + 1);
  for (const [state, reading, time, features] of [
    [corrected, newProfile, NOW + 1, library], [memory, profile, NOW + 1001, library],
    [memory, profile, NOW - 1, library], [memory, profile, NOW, [...library]],
  ]) assert.deepEqual(api.scoreCandidate(item, reading, state, "match", time, { libraryFeatures: features, evidence }),
    api.scoreCandidate(item, reading, state, "match", time, { libraryFeatures: features }));
  assert.equal(api.prepareScoringEvidence(profile, memory, NOW + 1001, library).expiresAt, Infinity,
    "An already expired intent must not force a rebuild on every candidate forever");
});

function memoContext() {
  let previousDeps, previousValue;
  return { useMemo(callback, deps) {
    if (!previousDeps || deps.some((value, i) => !Object.is(value, previousDeps[i]))) {
      previousDeps = deps; previousValue = callback();
    }
    return previousValue;
  } };
}
test("playback ticks do not rescan displayed recommendation history; real memory/library changes invalidate the projection", () => {
  const c = { ...memoContext(), canonicalTrackKey: api.canonicalTrackKey, recommendationIdentity: item => `qq:${item.id}`,
    listeningMemory: api.createEmptyListeningMemory(), profileClock: NOW, qqTasteSnapshot: { tracks: [] },
    matchedExperiments: Array.from({ length: 12 }, (_, i) => ({ id: `match${i}` })),
    visibleExperiments: Array.from({ length: 12 }, (_, i) => ({ id: `frontier${i}` })), recommendationTracks: {} };
  for (const item of [...c.matchedExperiments, ...c.visibleExperiments]) c.recommendationTracks[`qq:${item.id}`] = { mid: item.id };
  let reads = 0; c.listeningStatus = (...args) => { reads++; return api.listeningStatus(...args); };
  const project = () => bind(`return ${variables.get("familiarRecommendationIds")};`, c);
  const initial = project(); assert.equal(reads, 24);
  for (let i = 0; i < 100; i++) { c.playbackTime = { current: i / 8 }; assert.equal(project(), initial); }
  assert.equal(reads, 24);
  c.listeningMemory = preference(c.listeningMemory, candidate("match0"));
  assert.ok(project().has("qq:match0")); assert.equal(reads, 48);
  c.qqTasteSnapshot = { tracks: [{ mid: "frontier0" }] };
  assert.ok(project().has("qq:frontier0"));
});

test("queue rows are reused across progress/chat ticks but keep latest callbacks, current index and promised target", () => {
  let nodes = 0;
  const calls = [], queue = Array.from({ length: 500 }, (_, i) => ({ mid: `q${i}`, title: `track ${i}`, artist: "fixture" }));
  const c = { ...memoContext(), React: { createElement(type, props, ...children) { nodes++; return { type, props, children }; } },
    nowPlayingQueue: queue, activeQueueIndex: 4, trackIndex: 0, incomingQueueTrackId: "q5", queueSelectionRef: { current: null },
    playQueueRef: { current: queue }, selectQQTrack: (...args) => calls.push(args), selectTrack: index => calls.push(index) };
  const rows = () => bind(`return ${variables.get("nowPlayingQueueRows")};`, c);
  bind(`${queueAssignment};`, c);
  const first = rows(), cost = nodes;
  assert.equal(first[4].props.className.trim(), "active"); assert.equal(first[5].props.className.trim(), "transition-target");
  for (let i = 0; i < 100; i++) { c.playbackTime = { current: i / 8 }; c.thinkingElapsed = i / 10; assert.equal(rows(), first); }
  assert.equal(nodes, cost, "No recreation of 500 hidden queue rows per playback/chat tick");
  const latestQueue = [...queue, { mid: "manual", title: "manual", artist: "fixture" }]; c.playQueueRef.current = latestQueue;
  first[0].props.onClick(); assert.equal(calls[0][1], latestQueue, "Cached UI cannot use an old queue snapshot");
  c.activeQueueIndex = 5; const updated = rows(); assert.notEqual(updated, first); assert.equal(updated[5].props.className, "active transition-target");
  c.nowPlayingQueue = latestQueue; assert.equal(rows().length, 501);
});

test("a persisted learning mutation writes once before state publication, not again in the React mirror effect", () => {
  const storage = new Map(); let writes = 0, updates = 0;
  const c = { ...api, listeningMemoryRef: { current: api.createEmptyListeningMemory() }, listeningMemoryHydratedRef: { current: true },
    window: { localStorage: { setItem(key, value) { writes++; storage.set(key, value); } } },
    setListeningMemory(value) { assert.ok([...storage.values()].some(text => text.includes("durable"))); c.listeningMemory = value; },
    requestRecommendationUpdate() { updates++; }, setLikedTracks() {}, setDislikedTracks() {}, setLikedExperiments() {} };
  const update = bind(`${functions.get("updateListeningMemory")}; return updateListeningMemory;`, c);
  update({ type: "preference_changed", eventId: "durable", sessionId: "fixture", targetType: "track", targetKey: "qq:one", value: "more", scope: "track", source: "player", createdAt: NOW });
  assert.equal(writes, 1); assert.equal(updates, 1);
  bind(`return (${memoryEffect})();`, c); assert.equal(writes, 1); assert.ok(c.listeningMemoryRef.current.explicitPreferences.length);
});
