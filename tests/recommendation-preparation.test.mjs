import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Execute the actual preparation/start handlers. Audio and QQ are isolated;
// these tests neither authenticate nor alter the real userData.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["prepareTrack", "warmRecommendationSources", "startQQTrack", "getPlayerVolumeScalar"];
const declarations = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
})(ast);
names.forEach(name => assert.ok(declarations.has(name), name));
const js = ts.transpileModule([...declarations.values()].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const bind = new Function("context", `with(context){${js};return {${names.join(",")}};}`);
const item = mid => ({ mid, id: mid, title: "same title", artist: "same artist", cover: "", durationSeconds: 240 });
const noop = () => {};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test("newer selection supersedes old source request before it can create or commit media",async()=>{
  const h=harness();let release;
  h.c.playbackRequestRef.current={id:"old",at:performance.now()};
  h.c.window.codioDesktop.qqMusic.play=()=>new Promise(resolve=>release=resolve);
  const old=h.handlers.startQQTrack(item("old"),0);await new Promise(resolve=>setImmediate(resolve));
  h.c.playbackRequestRef.current={id:"new",at:performance.now()};release({playable:true,url:"https://old"});
  assert.equal(await old,"superseded");assert.equal(h.c.activeQQTrackLiveRef.current,null);assert.equal(h.c.audioElementsRef.current.size,0);
});

function harness({ failures = 0, byteSize = 1024, unavailable = false, mediaFailure = false } = {}) {
  let calls = 0, alive = 0, created = 0, revoked = [], state = false;
  const c = {
    bootPhaseRef: { current: "playing" },
    PREPARED_TRACK_TTL_MS: 180000, AbortController, Blob, performance, Date,
    qqAuthorizationRevisionRef: { current: 0 },
    window: { codioDesktop: { qqMusic: { async play(track) {
      calls++;
      if (calls <= failures) throw Error("temporary network failure");
      return { playable: !unavailable, url: unavailable ? "" : `https://source/${track.mid}/${calls}` };
    } } }, setTimeout, clearTimeout },
    URL: { createObjectURL() { return `blob:test-${++created}`; }, revokeObjectURL(url) { revoked.push(url); } },
    async fetch(url, { signal }) {
      alive++; assert.equal(alive, 1, "one byte worker only");
      await Promise.resolve(); alive--;
      if (signal.aborted) throw Error("aborted");
      return new Response(new Uint8Array(byteSize), { headers: { "content-type": "audio/mpeg" } });
    },
    preparedTracksRef: { current: new Map() }, failedTracksRef: { current: new Map() },
    recommendationVisibleRef: { current: { matched: [], frontier: [] } }, recommendationTracksRef: { current: {} },
    recommendationIdentity: track => `${track.provider || "qq"}:${track.mid || track.id}`,
    playQueueRef: { current: [] }, activeQueueIndexRef: { current: 0 },
    preparedDeckTrackRef: { current: "" },
    sourceWarmRef: { current: { revision: 0, controller: null } }, bufferedSourcesRef: { current: new Map() },
    activeQQTrackLiveRef: { current: null }, musicAudioRef: { current: null }, audioElementsRef: { current: new Set() },
    activeTransitionRef: { current: null }, playbackRequestRef: { current: null }, seamlessTransitionRef: { current: false },
    playbackToggleRef: { current: { revision: 0, pending: false } },
    seamlessAttemptedRef: { current: null }, pendingAdvanceRef: { current: false }, startingTrackRef: { current: null },
    currentCoverDataLiveRef: { current: "" }, userPausedRef: { current: true }, volumeRef: { current: 70 }, systemVolumeRef: { current: { available: false, volume: null, muted: false } }, listeningSessionRef: { current: null },
    notifySystem: noop, abortActiveTransition: noop, setToast: noop, setImportSource: noop, setImportState: noop, setImportOpen: noop,
    setQQConnection(value) { c.qqConnection = value; }, setQQPlaybackReady(value) { c.qqPlaybackReady = value; },
    setActiveQQTrack: noop, setCurrentCoverData: noop, setPlaybackQuality: noop, setProgress: noop, setPlaybackTime: noop,
    setIsPlaying(value) { state = value; },
    async resumeMusicAudioGraph() { return false; }, resolveTrackCover: async () => "cover", withTimeout: promise => promise,
    setBoundedCache(cache, key, value, limit) { cache.set(key, value); while (cache.size > limit) cache.delete(cache.keys().next().value); },
    createPreparedAudio(url) { const audio = new c.Audio(); audio.src = url; return audio; },
    discardPreparedEntry: noop, connectMusicAnalyser: noop, wireMusicAudio: noop,
    releaseMusicAudio: noop, settleCurrentListening: noop, beginListeningForTrack: noop,
    recommendationSourceForTrack: () => "match", rememberPlayedTrack: noop,
    analyseTrackWhenBuffered: async () => null, analysisForAudio: () => null, armPlaybackBoundaryCheck: noop,
    fadeMusicVolume: async () => true, prepareUpcomingTrack: noop,
    Audio: class {
      src = ""; paused = true; readyState = 4; currentTime = 0; duration = 240; dataset = {};
      buffered = { length: 1, end: () => 240 };
      async play() { if (!this.src || mediaFailure) throw Error("no source"); this.paused = false; }
    },
  };
  const handlers = bind(c);
  c.prepareTrack = handlers.prepareTrack;
  return { c, handlers, calls: () => calls, state: () => state, created: () => created, revoked: () => revoked };
}

test("URL-only preparation starts a real selected media element, including same-title versions", async () => {
  const h = harness(); const first = item("VersionA"), second = item("VersionB");
  await h.handlers.prepareTrack(first); await h.handlers.prepareTrack(second);
  assert.equal(h.c.audioElementsRef.current.size, 0, "URL caching creates no Audio");
  assert.equal(await h.handlers.startQQTrack(second, 0), "played");
  assert.match(h.c.musicAudioRef.current.src, /VersionB/);
  assert.equal(h.c.activeQQTrackLiveRef.current.mid, "VersionB");
  assert.equal(h.state(), true); assert.equal(h.calls(), 2);
});

test("an authorization failure while preparing boot cannot masquerade as a settled disconnected homepage",async()=>{
  const h=harness();h.c.qqConnection="connected";h.c.qqPlaybackReady=true;
  h.c.window.codioDesktop.qqMusic.play=async()=>({playable:false,requiresLogin:true,failureKind:"AUTHORIZATION_REQUIRED"});
  assert.equal(await h.handlers.prepareTrack(item("authorization")),null);
  assert.equal(h.c.qqConnection,"error","boot requires a real connection recheck before deciding offline entry");
  assert.equal(h.c.qqPlaybackReady,false);assert.equal(h.c.preparedTracksRef.current.size,0);
  assert.equal(h.c.failedTracksRef.current.size,0,"session errors are not permanent song bans");
  h.c.bootPhaseRef.current="leaving";
  await h.handlers.prepareTrack(item("entry-fade"));assert.equal(h.c.qqConnection,"error","entry fade cannot bypass the latest boot recheck");
  h.c.bootPhaseRef.current="done";
  await h.handlers.prepareTrack(item("reconnect"));assert.equal(h.c.qqConnection,"needs-auth");
});

test("pending artwork never blocks a prepared URL or its eager media deck", async () => {
  const h = harness(), cover = deferred(), track = { ...item("pending-cover"), cover: "provider-cover" };
  h.c.resolveTrackCover = () => cover.promise;
  let prepared;
  const task = h.handlers.prepareTrack(track, true).then(result => { prepared = result; return result; });
  await flush();
  assert.ok(prepared, "The actual prepareTrack must resolve while its artwork request is still pending");
  assert.equal(prepared.playback.playable, true);
  assert.match(prepared.audio.src, /pending-cover/);
  assert.equal(prepared.coverData, "provider-cover");
  assert.ok(prepared.coverPromise instanceof Promise);
  cover.resolve("decoded-cover"); await flush(); await task;
  assert.equal(await prepared.coverPromise, "decoded-cover");
  assert.equal(prepared.coverData, "decoded-cover", "Late artwork must still enrich the same prepared entry");
});

test("first playback starts while artwork is pending and late artwork does not restart audio", async () => {
  const h = harness(), cover = deferred(), track = { ...item("start-cover"), cover: "provider-cover" };
  const history = [], covers = [];
  h.c.resolveTrackCover = () => cover.promise;
  h.c.setCurrentCoverData = value => covers.push(value);
  h.c.rememberPlayedTrack = (selected, resolved) => history.push([selected.mid, resolved]);
  let outcome;
  const task = h.handlers.startQQTrack(track, 0).then(result => { outcome = result; return result; });
  await flush();
  assert.equal(outcome, "played", "The actual source-start handler must not await the cover");
  const audio = h.c.musicAudioRef.current;
  assert.equal(audio.paused, false);
  assert.equal(h.c.currentCoverDataLiveRef.current, "provider-cover");
  cover.resolve("decoded-cover"); await flush(); await task;
  assert.strictEqual(h.c.musicAudioRef.current, audio);
  assert.equal(h.c.audioElementsRef.current.size, 1);
  assert.equal(h.calls(), 1);
  assert.equal(h.c.currentCoverDataLiveRef.current, "decoded-cover");
  assert.deepEqual(covers, ["provider-cover", "decoded-cover"]);
  assert.deepEqual(history, [[track.mid, "provider-cover"], [track.mid, "decoded-cover"]]);
});

test("prepared playback reuses its pending cover request rather than downloading twice", async () => {
  const h = harness(), cover = deferred(), track = item("shared-cover"); let coverCalls = 0;
  h.c.resolveTrackCover = () => { coverCalls++; return cover.promise; };
  const prepared = await h.handlers.prepareTrack(track);
  assert.equal(await h.handlers.startQQTrack(track, 0), "played");
  assert.equal(coverCalls, 1);
  cover.resolve("shared-decoded-cover"); await flush();
  assert.equal(prepared.coverData, "shared-decoded-cover");
  assert.equal(h.c.currentCoverDataLiveRef.current, "shared-decoded-cover");
});

test("a replaced song's delayed cover cannot overwrite the current song, even with identical titles", async () => {
  const h = harness(), oldCover = deferred(), nextCover = deferred();
  const oldTrack = { ...item("cover-version-a"), cover: "a-provider-cover" };
  const nextTrack = { ...item("cover-version-b"), cover: "b-provider-cover" };
  h.c.resolveTrackCover = track => track.mid === oldTrack.mid ? oldCover.promise : nextCover.promise;
  h.c.playbackRequestRef.current = { id: oldTrack.mid, at: performance.now() };
  assert.equal(await h.handlers.startQQTrack(oldTrack, 0), "played");
  h.c.playbackRequestRef.current = { id: nextTrack.mid, at: performance.now() };
  assert.equal(await h.handlers.startQQTrack(nextTrack, 0), "played");
  const currentAudio = h.c.musicAudioRef.current;
  oldCover.resolve("old-decoded-cover"); await flush();
  assert.equal(h.c.currentCoverDataLiveRef.current, "b-provider-cover");
  // Pause changes transport intent, not the identity of the currently selected
  // artwork. The safe late visual update must not resume that paused media.
  currentAudio.paused = true; h.c.userPausedRef.current = true; h.c.playbackToggleRef.current.revision++;
  nextCover.resolve("current-decoded-cover"); await flush();
  assert.equal(h.c.currentCoverDataLiveRef.current, "current-decoded-cover");
  assert.strictEqual(h.c.musicAudioRef.current, currentAudio);
  assert.equal(currentAudio.paused, true);
});

test("repeated next preparation retains one idle media deck, not dozens of long-lived Audio elements",async()=>{
  const h=harness();h.c.releaseMusicAudio=audio=>h.c.audioElementsRef.current.delete(audio);
  h.c.createPreparedAudio=url=>{const audio=new h.c.Audio();audio.src=url;h.c.audioElementsRef.current.add(audio);return audio;};
  for(let i=0;i<24;i++)await h.handlers.prepareTrack(item(`next-${i}`),true);
  await Promise.resolve();assert.equal(h.c.audioElementsRef.current.size,1);
  assert.equal([...h.c.preparedTracksRef.current.values()].length,24,"24 URLs are not 24 Audio elements");
  assert.equal([...h.c.audioElementsRef.current][0].src.includes("next-23"),true);
});

test("expired prepared links re-resolve instead of reusing a stale source", async () => {
  const h = harness(); const track = item("expired");
  await h.handlers.prepareTrack(track);
  h.c.preparedTracksRef.current.get(track.mid).createdAt = Date.now() - 180001;
  h.c.preparedTracksRef.current.get(track.mid).expiresAt = Date.now() - 1;
  assert.equal(await h.handlers.startQQTrack(track, 0), "played");
  assert.equal(h.calls(), 2); assert.match(h.c.musicAudioRef.current.src, /\/2$/);
});

test("a valid actual desktop ticket and its buffered bytes survive a three-minute idle wait", async () => {
  const h = harness(), track = item("idle-ticket"); let now = Date.now(), calls = 0;
  h.c.Date = { now: () => now };
  h.c.window.codioDesktop.qqMusic.play = async () => {
    calls++; return { playable: true, url: `isolated-ticket/${calls}`, expiresAt: now + 30 * 60 * 1000 };
  };
  await h.handlers.warmRecommendationSources([track]);
  assert.equal(h.c.preparedTracksRef.current.get(track.mid).expiresAt, now + 30 * 60 * 1000 - 30000);
  assert.equal(h.c.audioElementsRef.current.size, 0);
  now += 4 * 60 * 1000;
  assert.equal(await h.handlers.startQQTrack(track, 0), "played");
  assert.equal(calls, 1, "Idle time does not force a new QQ URL request before a valid local ticket expires");
  assert.match(h.c.musicAudioRef.current.src, /^blob:/);
  assert.equal(h.c.window.codioPlaybackDiagnostics.at(-1).byteCacheHit, true);
});

test("expired actual tickets re-resolve and never reuse mismatched buffered bytes", async () => {
  const h = harness(), track = item("expired-ticket"); let now = Date.now(), calls = 0;
  h.c.Date = { now: () => now };
  h.c.window.codioDesktop.qqMusic.play = async () => {
    calls++; return { playable: true, url: `isolated-ticket/${calls}`, expiresAt: now + 30 * 60 * 1000 };
  };
  await h.handlers.warmRecommendationSources([track]); now += 30 * 60 * 1000;
  assert.equal(await h.handlers.startQQTrack(track, 0), "played");
  assert.equal(calls, 2); assert.equal(h.c.musicAudioRef.current.src, "isolated-ticket/2");
  assert.equal(h.c.window.codioPlaybackDiagnostics.at(-1).byteCacheHit, false);
});

test("malformed or implausibly long expiry cannot create an unbounded prepared cache", async () => {
  for (const expiry of [Number.NaN, Number.POSITIVE_INFINITY, Date.now() + 365 * 24 * 60 * 60 * 1000]) {
    const h = harness(), track = item("bounded-ticket"), before = Date.now();
    h.c.window.codioDesktop.qqMusic.play = async () => ({ playable: true, url: "isolated-ticket", expiresAt: expiry });
    const prepared = await h.handlers.prepareTrack(track);
    assert.ok(prepared.expiresAt <= before + 30 * 60 * 1000 + 10);
    if (!Number.isFinite(expiry)) assert.ok(prepared.expiresAt <= before + 180000 + 10);
  }
  const h = harness();
  h.c.window.codioDesktop.qqMusic.play = async () => ({ playable: true, url: "expired", expiresAt: Date.now() - 100 });
  assert.equal(await h.handlers.prepareTrack(item("already-expired")), null);
});

test("a failed preparation is removed and the same identity can recover immediately", async () => {
  const h = harness({ failures: 1 }); const track = item("recover");
  assert.equal(await h.handlers.prepareTrack(track), null);
  assert.equal(h.c.preparedTracksRef.current.has(track.mid), false);
  assert.ok(await h.handlers.prepareTrack(track)); assert.equal(h.calls(), 2);
});

test("upcoming-deck preparation renews a nearly expired ticket before the mix and reuses the renewal",async()=>{
  const h=harness(),track=item("renew-before-cue");let now=100000;
  h.c.Date={now:()=>now};
  const old=await h.handlers.prepareTrack(track,true);
  now=old.expiresAt-20000;
  const renewed=await h.handlers.prepareTrack(track,true,45000);
  assert.equal(h.calls(),2);assert.notEqual(renewed.playback.url,old.playback.url);assert.ok(renewed.expiresAt>old.expiresAt);
  assert.equal(await h.handlers.prepareTrack(track,true,45000),renewed);assert.equal(h.calls(),2,"reuse the renewed request");
});

test("old failed requests cannot delete a newer preparation entry", async () => {
  const h = harness(); const track = item("revision"); let reject;
  h.c.window.codioDesktop.qqMusic.play = () => new Promise((_, r) => { reject = r; });
  const older = h.handlers.prepareTrack(track);
  const newer = { createdAt: Date.now(), promise: Promise.resolve({ playback: { playable: true, url: "new" } }) };
  h.c.preparedTracksRef.current.set(track.mid, newer); reject(Error("old failed")); await older;
  assert.strictEqual(h.c.preparedTracksRef.current.get(track.mid), newer);
});

test("72 extra source checks retain visible 24, current, manual next and promised decks inside the same 30-entry cache", async () => {
  const h = harness(), visible = Array.from({ length: 24 }, (_, i) => item(`visible${i}`));
  h.c.recommendationVisibleRef.current = { matched: visible.slice(0, 12), frontier: visible.slice(12) };
  h.c.recommendationTracksRef.current = Object.fromEntries(visible.map(track => [h.c.recommendationIdentity(track), track]));
  const active = item("current"), prepared = item("preparedNext"), manual = item("manualNext"), outgoing = item("outgoing"), incoming = item("incoming");
  h.c.activeQQTrackLiveRef.current = active;
  h.c.preparedDeckTrackRef.current = prepared.mid;
  h.c.playQueueRef.current = [active, manual];
  h.c.activeTransitionRef.current = { outgoingSnapshot: { track: outgoing }, incomingSnapshot: { track: incoming } };
  const protectedTracks = [...visible, active, prepared, manual, outgoing, incoming];
  for (const track of protectedTracks) await h.handlers.prepareTrack(track);
  const retained = new Map(protectedTracks.map(track => [track.mid, h.c.preparedTracksRef.current.get(track.mid)]));
  for (let i = 0; i < 72; i++) {
    await h.handlers.prepareTrack(item(`unshown${i}`));
    assert.ok(h.c.preparedTracksRef.current.size <= 30, "Protection must not grow the URL cache");
  }
  assert.equal(h.c.preparedTracksRef.current.size, 30);
  for (const [mid, entry] of retained) assert.strictEqual(h.c.preparedTracksRef.current.get(mid), entry, `Keep the actual prepared source ${mid}`);
  const callsBeforeWarm = h.calls();
  await h.handlers.warmRecommendationSources(visible);
  assert.equal(h.calls(), callsBeforeWarm, "Rechecking the actual visible batch reuses every retained live ticket without another QQ IPC");
  assert.equal(h.c.audioElementsRef.current.size, 0, "URL protection does not create an Audio element per candidate");
  assert.deepEqual(h.c.playQueueRef.current, [active, manual]);
  assert.equal(h.c.activeTransitionRef.current.incomingSnapshot.track.mid, incoming.mid);
});

test("protection cannot retain an expired visible playback ticket", async () => {
  const h = harness(), track = item("expiredVisible");
  h.c.recommendationVisibleRef.current.matched = [track];
  h.c.recommendationTracksRef.current[h.c.recommendationIdentity(track)] = track;
  await h.handlers.prepareTrack(track);
  h.c.preparedTracksRef.current.get(track.mid).expiresAt = Date.now() - 1;
  const refreshed = await h.handlers.prepareTrack(track);
  assert.equal(h.calls(), 2);
  assert.match(refreshed.playback.url, /\/2$/);
});

test("the actual visible-source effect keeps byte warming off the boot critical path", async () => {
  let callback;
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
      && node.arguments[0]?.getText(ast).includes("Resolve all 24 playback URLs and covers ahead of time")) callback = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  })(ast);
  assert.ok(callback);
  const code = ts.transpileModule(`const effect = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const phase of ["playing", "done"]) {
    const h = harness(), tracks = Array.from({ length: 24 }, (_, i) => item(`effect${i}`)), calls = [];
    let preparedSources = new Set();
    h.c.bootPhase = phase;
    h.c.matchedExperiments = tracks.slice(0, 12); h.c.visibleExperiments = tracks.slice(12);
    h.c.recommendationTracks = Object.fromEntries(tracks.map(track => [h.c.recommendationIdentity(track), track]));
    h.c.activeQQTrack = null;
    h.c.setBootPreparedSources = next => { preparedSources = typeof next === "function" ? next(preparedSources) : next; };
    h.c.setBootSourceError = value => { h.c.bootSourceError = value; };
    h.c.prepareTrack = async track => {
      calls.push(`source:${track.mid}`);
      // Isolated cache evidence distinguishes completed, expired and pending
      // requests; merely finding a cache key is not source readiness.
      const entry = { promise: Promise.resolve({ playback: { playable: true, url: `isolated:${track.mid}` } }), createdAt: Date.now() };
      if (track.mid === "effect23") entry.promise = new Promise(() => {});
      if (track.mid !== "effect23") entry.expiresAt = Date.now() + (track.mid === "effect22" ? -1 : 180000);
      h.c.preparedTracksRef.current.set(track.mid, entry);
      return { playback: { playable: true } };
    };
    h.c.prepareUpcomingTrack = mid => calls.push(`deck:${mid}`);
    h.c.warmRecommendationSources = async selected => { calls.push(`bytes:${selected.length}`); };
    const effect = new Function("c", `with(c){${code};return effect;}`)(h.c);
    const dispose = effect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(call => call.startsWith("source:")).length, 24);
    assert.deepEqual(calls.filter(call => !call.startsWith("source:")), phase === "done" ? ["deck:effect0", "bytes:24"] : [],
      "Playback source readiness is mandatory before entry; optional full audio bytes start only after entry");
    assert.deepEqual([...preparedSources].sort(), phase === "playing" ? tracks.slice(0, 22).map(h.c.recommendationIdentity).sort() : [],
      "Only non-expired completed source entries may be published to real boot progress");
    if (phase === "playing") assert.equal(h.c.bootSourceError, true, "missing or expired cache entries cannot leave boot waiting without a retry state");
    dispose();
  }
});

test("byte warming is bounded, cancellable, and creates no media elements", async () => {
  const h = harness({ byteSize: 5 * 1024 * 1024 });
  await h.handlers.warmRecommendationSources(Array.from({ length: 24 }, (_, i) => item(`warm-${i}`)));
  assert.ok(h.c.bufferedSourcesRef.current.size <= 6);
  assert.ok([...h.c.bufferedSourcesRef.current.values()].reduce((s, x) => s + x.bytes, 0) <= 24 * 1024 * 1024);
  assert.equal(h.calls(), 6); assert.equal(h.c.audioElementsRef.current.size, 0);
  assert.ok(h.revoked().length > 0);
  const track = item("warm-5");
  assert.equal(await h.handlers.startQQTrack(track, 0), "played");
  assert.match(h.c.musicAudioRef.current.src, /^blob:/);
  assert.equal(h.c.window.codioPlaybackDiagnostics.at(-1).byteCacheHit, true);
  assert.equal(h.c.sourceWarmRef.current.controller.signal.aborted, true);
});

test("oversized sources are discarded, and active playback prevents warming", async () => {
  const h = harness({ byteSize: 9 * 1024 * 1024 });
  await h.handlers.warmRecommendationSources([item("too-large")]); assert.equal(h.created(), 0);
  h.c.musicAudioRef.current = { paused: false, src: "active" };
  await h.handlers.warmRecommendationSources([item("dont-warm")]); assert.equal(h.calls(), 1);
});

test("unavailable source and media failure cannot claim successful playback", async () => {
  for (const options of [{ unavailable: true }, { mediaFailure: true }]) {
    const h = harness(options);
    assert.equal(await h.handlers.startQQTrack(item("bad"), 0), "unavailable");
    assert.equal(h.state(), false);
    assert.equal(h.c.window.codioPlaybackDiagnostics, undefined);
  }
});

test("song metadata checks exact identity, limits concurrency, caches by provider ID, and retries failures", async () => {
  const desktop = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const functions = desktop.slice(desktop.indexOf("const songMetadataCache ="), desktop.indexOf("async function readQQLibrary"));
  let active = 0, maximum = 0, calls = 0, mismatch = false;
  const get = new Function("requestQQJson", "QQ_MUSICU_URL", `${functions};return readQQTrackMetadata;`)(async url => {
    const id = JSON.parse(url.searchParams.get("data")).req_0.param.song_mid;
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(r => setImmediate(r)); active--;
    return { code: 0, req_0: { data: { track_info: { mid: mismatch ? "wrong" : id }, info: {
      genre: { content: [{ value: "Pop" }] }, lan: { content: [{ value: "国语" }] }, pub_time: { content: [{ value: "2017-06-08" }] },
    } } } };
  }, "https://u.y.qq.com/cgi-bin/musicu.fcg");
  assert.equal((await get(null, "../invalid")).error, "TRACK_ID_INVALID");
  const results = await Promise.all(["VersionA", "VersionB", "VersionC", "VersionD"].map(id => get(null, id)));
  assert.equal(maximum, 2); assert.equal(calls, 4);
  assert.deepEqual(results.map(r => r.mid), ["VersionA", "VersionB", "VersionC", "VersionD"]);
  assert.equal(results[0].source, "provider_metadata"); assert.deepEqual(results[0].genres, ["Pop"]);
  assert.equal(results[0].releaseDate, "2017-06-08");
  await get(null, "VersionA"); assert.equal(calls, 4);
  mismatch = true; assert.equal((await get(null, "retry")).ok, false);
  mismatch = false; assert.equal((await get(null, "retry")).ok, true); assert.equal(calls, 6);
});

test("renderer consumes verified song metadata in the same final scorer and rejects foreign identities", async () => {
  const declarations = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && ["enrichTrackMetadata", "featureVectorForTrack"].includes(node.name?.text)) declarations.push(node.getText(ast));
    ts.forEachChild(node, visit);
  })(ast);
  const moduleSource = await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8");
  const moduleJs = ts.transpileModule(moduleSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const api = await import(`data:text/javascript;base64,${Buffer.from(moduleJs).toString("base64")}`);
  const now = Date.now(), memory = api.createEmptyListeningMemory(now);
  let wrong = false;
  // Pop / 国语 / 2017-06-08 are actual QQ detail values verified for this ID.
  // The behavior below is isolated, not the user's actual listening history.
  const c = { window: { codioDesktop: { qqMusic: { metadata: async mid => ({ ok: true, mid: wrong ? "foreign" : mid,
    genres: ["Pop"], language: "国语", releaseDate: "2017-06-08", source: "provider_metadata", confidence: .65 }) } } },
    withTimeout: p => p, experimentPool: [], artistTasteHints: [], trackAnalysisRef: { current: new Map() }, bootPhase: "done",
    recommendationAudioRef: { current: new Map() }, qqTasteSnapshotRef: { current: null },
    metadataEnrichmentRef: { current: { active: 0, waiters: [], pending: new Map() } }, analysisLifecycleRef: { current: { mounted: true, generation: 1 } },
    listeningMemoryRef: { current: memory }, listeningStatus: api.listeningStatus, canonicalTrackKey: api.canonicalTrackKey };
  const functions = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { enrichTrackMetadata, featureVectorForTrack } = new Function("c", `with(c){${functions};return {enrichTrackMetadata,featureVectorForTrack}}`)(c);
  const verified = { ...item("0037ke650vg5J1"), title: "火鸟功 + 我太傻 + Melody (Live)", artist: "陶喆" };
  const enriched = await enrichTrackMetadata(verified), features = featureVectorForTrack(enriched);
  assert.equal(features.tags[0].value, "genre:pop"); assert.equal(features.tags[0].confidence, .65);
  assert.equal(features.bpm.value, null); assert.equal(features.energy.value, null);
  const candidate = { canonicalKey: api.canonicalTrackKey("qq", verified.mid), track: { provider: "qq", id: verified.mid,
    title: verified.title, artist: verified.artist }, featureVector: features, sourceConfidence: .95, source: "adjacent_discovery",
    generationReason: "isolated behavior test", alreadyHeard: false, alreadyRecommended: false, inLibrary: false, playable: true };
  const before = api.scoreCandidate(candidate, api.deriveListeningProfile(memory, now), memory, "match", now);
  const learned = api.recordListeningEvent(memory, { type: "preference_changed", eventId: "isolated-detail",
    targetType: "track", targetKey: candidate.canonicalKey, value: "more", scope: "track", source: "dj", createdAt: now,
    sessionId: memory.currentSession.sessionId, features });
  const after = api.scoreCandidate(candidate, api.deriveListeningProfile(learned, now), learned, "match", now);
  const part = score => score.contributions.find(x => x.key === "verified_track_similarity").signedWeight;
  assert.equal(part(before), 0);
  assert.equal(part(after), 0, "an exact like is not counted again as similarity to itself");
  assert.ok(after.contributions.find(x => x.key === "explicit_track").signedWeight > 0);
  // This second identity is a scoring-only fixture, not a real QQ song claim.
  const probe = { ...candidate, canonicalKey: "qq:isolated-metadata-probe", track: { ...candidate.track, id: "isolated-metadata-probe" } };
  const related = api.scoreCandidate(probe, api.deriveListeningProfile(learned, now), learned, "match", now);
  assert.ok(part(related) > 0, "verified provider detail enters a different work's final score");
  assert.equal(related.laneEvidence.match, false, "broad Pop alone does not establish close fit");
  wrong = true; assert.strictEqual(await enrichTrackMetadata(verified), verified);
});

function metadataHarness() {
  const functions = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "enrichTrackMetadata") functions.push(node.getText(ast));
    ts.forEachChild(node, visit);
  })(ast);
  let calls = 0;
  const c = {
    window: { codioDesktop: { qqMusic: { metadata: async mid => {
      calls++;
      return { ok: true, mid, source: "provider_metadata", genres: ["Neo-Soul"], language: "英语", releaseDate: "2023-03-31" };
    } } } },
    withTimeout: promise => promise,
    metadataEnrichmentRef: { current: { active: 0, waiters: [], pending: new Map() } },
    analysisLifecycleRef: { current: { mounted: true } },
  };
  const code = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const enrich = new Function("c", `with(c){${code};return enrichTrackMetadata;}`)(c);
  return { c, enrich, calls: () => calls };
}

test("retained complete QQ detail facts do not make another metadata request or lose their values", async () => {
  const h = metadataHarness();
  const retained = { ...item("003J8Wu943h8Lb"), provider: "qq", genres: ["Neo-Soul"], language: "英语", releaseDate: "2023-03-31" };
  assert.strictEqual(await h.enrich(retained), retained);
  assert.strictEqual(await h.enrich(retained, Date.now() - 1), retained);
  assert.equal(h.calls(), 0, "Completeness is real retained provider data, not a network delay or fabricated musical feature");
  assert.equal(h.c.metadataEnrichmentRef.current.active, 0);
  assert.equal(h.c.metadataEnrichmentRef.current.pending.size, 0);
});

test("incomplete or malformed QQ details still require exact-ID provider confirmation", async () => {
  const complete = { ...item("003J8Wu943h8Lb"), provider: "qq", genres: ["Neo-Soul"], language: "英语", releaseDate: "2023-03-31" };
  for (const change of [{ genres: [] }, { genres: [" "] }, { language: " " }, { releaseDate: undefined }, { releaseDate: "unknown" }]) {
    const h = metadataHarness(), track = { ...complete, ...change };
    const result = await h.enrich(track);
    assert.equal(h.calls(), 1);
    assert.equal(result.mid, track.mid);
    assert.deepEqual(result.genres, ["Neo-Soul"]);
    assert.equal(result.releaseDate, "2023-03-31");
  }
  const h = metadataHarness(), track = { ...complete, genres: [] };
  h.c.window.codioDesktop.qqMusic.metadata = async () => ({ ok: true, mid: "foreign", source: "provider_metadata", genres: ["Classical"] });
  assert.strictEqual(await h.enrich(track), track, "Warm-path optimization never relaxes a fetched result's identity check");
});

test("warm owner-checked batches verify all 24 actual sources without waiting for unrelated library metadata", async () => {
  const names = ["readStartupRecommendationSnapshot", "buildStartupRecommendationSnapshot", "enrichTrackMetadata", "featureVectorForTrack", "candidateForExperiment", "refreshRecommendationLane"];
  const definitions = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) definitions.push(node.getText(ast));
    ts.forEachChild(node, visit);
  })(ast);
  const moduleSource = await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8");
  const api = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(moduleSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText).toString("base64")}`);
  let memory = api.createEmptyListeningMemory();
  const owner = "isolated-owner", storage = new Map(), checked = [];
  const completedSources = new Set(), progressCounts = [];
  let progressSources = new Set();
  let metadataCalls = 0, searchCalls = 0;
  const prepared = deferred(), lastOriginal = deferred();
  const identity = track => api.canonicalTrackKey(track.provider || "qq", track.mid || track.id);
  const c = {
    ...api, bootPhase: "playing",
    bootMusicTask: { match: "", frontier: "" },
    setBootMusicTask(next) { c.bootMusicTask = typeof next === "function" ? next(c.bootMusicTask) : next; },
    window: { localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      codioDesktop: { qqMusic: {
        getStatus: async () => ({ loggedIn: true, playbackReady: true, userId: owner }),
        metadata: async () => { metadataCalls++; return new Promise(() => {}); },
        search: async () => { searchCalls++; return []; },
      } } },
    recommendationIdentity: identity,
    recommendationUpdateRef: { current: { revision: 0, records: [] } },
    recommendationPoolsRef: { current: { match: api.createRecommendationPool("match"), frontier: api.createRecommendationPool("frontier") } },
    listeningMemoryRef: { current: memory },
    recommendationVisibleRef: { current: { matched: [], frontier: [] } },
    qqTasteSnapshotRef: { current: { tracks: Array.from({ length: 12 }, (_, i) => ({ ...item(`library${i}`), provider: "qq" })), topArtists: [] } },
    experimentPool: [], artistTasteHints: [], recommendationAudioRef: { current: new Map() }, trackAnalysisRef: { current: new Map() },
    metadataEnrichmentRef: { current: { active: 0, waiters: [], pending: new Map() } }, analysisLifecycleRef: { current: { mounted: true } },
    recommendationTracksRef: { current: {} }, discoveryTracksRef: { current: {} }, discoveryPoolRef: { current: [] }, failedTracksRef: { current: new Map() },
    activeQQTrackLiveRef: { current: null }, activeTransitionRef: { current: null }, seamlessTransitionRef: { current: false },
    recommendationCatalogRef: { current: [] }, recommendationScoresRef: { current: new Map() },
    weatherSnapshotRef: { current: { text: "Clear" } }, weatherContext: "Clear", manualQueueIdsRef: { current: new Set() },
    playQueueRef: { current: [] }, activeQueueIndexRef: { current: 0 }, bufferedSourcesRef: { current: new Map() }, audioElementsRef: { current: new Set() },
    withTimeout: promise => promise, setRecommendationLoading: noop, setRecommendationTracks: noop, setToast: noop,
    setBootPreparedSources(next) {
      const updated = typeof next === "function" ? next(progressSources) : next;
      assert.ok([...updated].every(key => completedSources.has(key)), "A progress unit must correspond to a completed real source");
      if (updated.size !== progressSources.size) progressCounts.push(updated.size);
      progressSources = updated;
    },
    setMatchedExperiments: items => { c.recommendationVisibleRef.current.matched = items; },
    setVisibleExperiments: items => { c.recommendationVisibleRef.current.frontier = items; },
    prepareTrack: async track => { checked.push(track.mid); await prepared.promise;
      if (track.mid === "close11") await lastOriginal.promise;
      completedSources.add(identity(track));
      return { playback: { playable: true, url: `isolated:${track.mid}` }, coverData: "" }; },
  };
  const code = ts.transpileModule(definitions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handlers = new Function("c", `with(c){${code};return {${names.join(",")}};}`)(c);
  // Synthetic provider facts exercise admission math, not real QQ sound claims.
  // The close pool has a specific recorded style; frontier has only a credible
  // broad-genre bridge and must not gain close-match eligibility from novelty.
  for (const genre of ["Neo-Soul", "Pop"]) {
    const anchor = { ...item(`known-${genre}`), provider: "qq", artist: `Known ${genre}`,
      genres: [genre], language: "英语", releaseDate: "2023-03-31" };
    memory = api.recordListeningEvent(memory, { type: "preference_changed", eventId: `known-like-${genre}`,
      targetType: "track", targetKey: identity(anchor), title: anchor.title, artist: anchor.artist,
      value: "more", scope: "track", source: "player", features: handlers.featureVectorForTrack(anchor),
      createdAt: Date.now(), sessionId: memory.currentSession.sessionId });
  }
  c.listeningMemoryRef.current = memory;
  for (const [lane, prefix] of [["match", "close"], ["frontier", "far"]]) {
    const tracks = Array.from({ length: 132 }, (_, i) => ({ ...item(`${prefix}${i}`), provider: "qq", artist: `Artist ${i}`,
      genres: [lane === "match" ? "Neo-Soul" : "Pop"], language: "英语", releaseDate: "2023-03-31" }));
    const candidate = handlers.candidateForExperiment({ ...tracks[0], lane, tags: [] }, new Set(), tracks[0]);
    const evidence = api.scoreCandidate(candidate, api.deriveListeningProfile(memory), memory, lane).laneEvidence;
    assert.equal(evidence[lane], true, "Each retained batch must qualify using actual recorded evidence, not only source URLs");
    if (lane === "frontier") assert.equal(evidence.match, false, "Broad exploration evidence is not a close-match claim");
    const snapshot = handlers.buildStartupRecommendationSnapshot(tracks, tracks.slice(0, 12).map(identity), lane, owner);
    storage.set(`codio-recommendation-pool-v1-${lane}`, JSON.stringify({ cursor: 4, exposure: [], snapshot }));
  }
  const pending = Promise.all(["match", "frontier"].map(lane => handlers.refreshRecommendationLane(lane, "feedback", 0, ["startup_ready"])));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checked.length, 8, "Four real source workers per lane must start before any unrelated library metadata could finish");
  assert.equal(metadataCalls, 0, "Twelve unknown library details do not hold the retained, complete own-lane batch hostage");
  assert.equal(c.recommendationVisibleRef.current.matched.length, 0);
  assert.equal(c.recommendationVisibleRef.current.frontier.length, 0, "Snapshot presence alone is never readiness");
  assert.equal(progressSources.size, 0, "Starting eight requests is not completing eight sources");
  prepared.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checked.length, 24, "A slow last original must not start backup source scans while its real request is still pending");
  assert.ok(checked.every(mid => Number(mid.replace(/^(close|far)/, "")) < 12));
  assert.equal(progressSources.size, 23, "The pending last original cannot be counted or skip directly to 24");
  assert.equal(c.recommendationVisibleRef.current.matched.length, 0, "The whole original page is validated before choosing backups or committing it");
  lastOriginal.resolve();
  const result = await pending;
  assert.ok(result.every(lane => lane.status === "completed"), JSON.stringify(result.map(lane => ({ status: lane.status, error: lane.error }))));
  assert.equal(new Set(checked).size, 24, "Every displayed song still requires its real playability check");
  assert.equal(metadataCalls, 0); assert.equal(searchCalls, 0);
  assert.equal(c.recommendationVisibleRef.current.matched.length, 12);
  assert.equal(c.recommendationVisibleRef.current.frontier.length, 12);
  assert.equal(c.audioElementsRef.current.size, 0, "Readiness does not create 24 media decks or start playback");
  assert.ok(result.every(lane => lane.startupSnapshotUsed && lane.visibleCount === 12));
  assert.equal(progressSources.size, 24);
  assert.deepEqual(progressCounts, Array.from({ length: 24 }, (_, i) => i + 1), "Actual source completions advance individually without fake elapsed-time ticks");
});
