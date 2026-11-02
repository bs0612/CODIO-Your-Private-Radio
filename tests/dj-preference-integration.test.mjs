import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run the actual DJ executor and memory writer with the real policy/reducer.
// QQ, storage, timers, and React state are isolated: no user data is touched.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlerNames = ["recommendationIdentity", "enrichTrackMetadata", "featureVectorForTrack", "writeTrackPreference", "supplementAnalyzedPreferences", "updateListeningMemory", "requestRecommendationUpdate", "executeCodioTool", "replyTo", "withdrawPreference", "buildCodioContext", "runAgentTurn"];
const declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && handlerNames.includes(node.name.text)) {
    declarations.set(node.name.text, node.getText(ast));
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && handlerNames.includes(node.name.text)) {
    declarations.set(node.name.text, `const ${node.getText(ast)};`);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of handlerNames) assert.ok(declarations.has(name), `Missing renderer handler: ${name}`);
const transpile = (code, module = ts.ModuleKind.None) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module },
}).outputText;
const handlersJs = transpile(handlerNames.map((name) => declarations.get(name)).join("\n"));
const bindHandlers = new Function("context", `with (context) { ${handlersJs}\nreturn { ${handlerNames.join(", ")} }; }`);
async function importTypescript(relativePath) {
  const code = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(transpile(code, ts.ModuleKind.ES2022)).toString("base64")}`);
}
const [intelligence, agent] = await Promise.all([
  importTypescript("../app/listening-intelligence.ts"),
  importTypescript("../app/codio-agent.ts"),
]);
const presentationSource = await readFile(new URL("../app/listening-presentation.ts", import.meta.url), "utf8");
const presentation = new Function("require", "exports", `${transpile(presentationSource, ts.ModuleKind.CommonJS)}\nreturn exports;`)(
  (path) => { assert.equal(path, "./listening-intelligence"); return intelligence; }, {},
);

const track = (mid, title, artist = "Daniel") => ({ id: mid, mid, title, artist, album: "Test album", durationSeconds: 240, cover: "" });
const valentina = track("valentina-id", "Valentina");
const always = track("always-id", "Always");
const preferenceText = "我最近特别喜欢 Daniel 的 Valentina 和 Always，其他他的歌也挺好听";
const tool = (id, name, args = {}) => ({ id, name, arguments: args });
const search = (id = "search") => tool(id, "search_music", { query: "Daniel Valentina Always", limit: 8 });
const preferTrack = (id, trackId) => tool(id, "record_music_preference", { target_type: "track", track_id: trackId, value: "more" });
const preferArtist = (id, artistName = "Daniel") => tool(id, "record_music_preference", { target_type: "artist", artist_name: artistName, value: "more" });
const preferInstrumental = (id = "instrumental", value = "less") => tool(id, "record_music_preference", { target_type: "feature", feature_key: "instrumental", value });
const response = (...toolCalls) => ({ content: "", toolCalls });
const toolResults = (result) => result.messages.filter(({ role }) => role === "tool").map(({ content }) => JSON.parse(content));

function harness({ results = [valentina, always], hydrated = true } = {}) {
  const storage = new Map([["codio-recommendation-history", "visible-history"], ["codio-taste-signals", "legacy-history"]]);
  const storageWrites = [];
  const playbackCalls = [];
  const searchCalls = [];
  const refreshes = [];
  const notifications = [];
  const executions = [];
  const timers = new Map();
  const visibleWrites = [];
  let timerId = 0;
  let eventId = 0;
  let matched = Array.from({ length: 12 }, (_, index) => track(`matched-${index}`, `Matched ${index}`, "Visible artist"));
  let frontier = Array.from({ length: 12 }, (_, index) => track(`frontier-${index}`, `Frontier ${index}`, "Visible artist"));
  const active = track("current-id", "Current song", "Current artist");
  const audio = {
    src: "test:audio", paused: false, ended: false, currentTime: 30, duration: 240,
    async play() { playbackCalls.push("audio.play"); },
  };
  const context = {
    ...intelligence, ...agent, bootPhase: "done",
    FULL_AI_REQUIRED: "连接自己的 DeepSeek Key 后可使用完整 AI DJ。",
    playbackRequestRef: { current: null }, startingTrackRef: { current: null }, recommendationTracksRef: { current: {} },
    experimentPool: [], artistTasteHints: [], qqTasteSnapshotRef: { current: null },
    trackAnalysisRef: { current: new Map() }, recommendationAudioRef: { current: new Map() },
    metadataEnrichmentRef: { current: { active: 0, waiters: [], pending: new Map() } }, analysisLifecycleRef: { current: { mounted: true, generation: 1 } },
    withTimeout: promise => promise,
    crypto: { randomUUID: () => `test-${eventId += 1}` },
    window: {
      localStorage: {
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storageWrites.push(key); storage.set(key, String(value)); },
      },
      codioDesktop: { qqMusic: { async search(query, page) { searchCalls.push({ query, page }); return results; } } },
      setTimeout(callback, delay) { const id = timerId += 1; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    listeningMemoryRef: { current: intelligence.createEmptyListeningMemory() },
    listeningMemoryHydratedRef: { current: hydrated },
    preferenceRefreshTimerRef: { current: null },
    recommendationUpdateRef: { current: { revision: 0, timer: null, triggers: new Set(), latest: {}, records: [] } },
    recommendationRefreshRef: { current: async (mode) => { refreshes.push(mode); return { status: "completed" }; } },
    discoveryPoolRef: { current: [] },
    discoveryTracksRef: { current: {} },
    activeQQTrackLiveRef: { current: active },
    musicAudioRef: { current: audio },
    playQueueRef: { current: [active] },
    activeQueueIndexRef: { current: 0 },
    qqConnection: "connected", qqPlaybackReady: true,
    scene: "night", particleLevel: 2, lyricMode: "cinematic",
    profileOpen: false, settingsOpen: false, nowPlayingOpen: false, djOpen: true,
    activeQQTrack: active, isPlaying: true,
    get matchedExperiments() { return matched; },
    get visibleExperiments() { return frontier; },
    setMatchedExperiments(next) { visibleWrites.push("matched"); matched = next; },
    setVisibleExperiments(next) { visibleWrites.push("frontier"); frontier = next; },
    setListeningMemory(next) { context.listeningMemory = next; },
    setRecommendationLoading() {},
    setThinkingCue() {},
    setToast() {},
    notifySystem(...args) { notifications.push(args); },
    async refreshRecommendations(mode) { refreshes.push(mode); },
    async selectQQTrack() { playbackCalls.push("selectQQTrack"); return true; },
    async togglePlayback() { playbackCalls.push("togglePlayback"); },
    async nextTrack() { playbackCalls.push("nextTrack"); },
    async previousTrack() { playbackCalls.push("previousTrack"); },
    async waitForRecommendationUpdate() { /* This harness tests Agent permission; real completion is covered by the queue harness. */ },
  };
  const handlers = bindHandlers(context);
  return {
    context, handlers, storage, storageWrites, playbackCalls, searchCalls, refreshes, notifications, executions, timers, visibleWrites,
    memory: () => context.listeningMemoryRef.current,
    shown: () => ({ matched, frontier }),
    async flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const { callback, delay } of pending) { assert.equal(delay, 240); callback(); }
      await Promise.resolve();
    },
    async run(userText, steps) {
      const whitelist = new Map();
      let round = 0;
      return agent.runCodioAgentLoop({
        messages: [{ role: "user", content: userText }],
        context: () => ({ listening: intelligence.deriveListeningProfile(context.listeningMemoryRef.current) }),
        step: async (messages, freshContext) => {
          const next = steps[round++];
          return typeof next === "function" ? next(messages, freshContext) : next || response();
        },
        execute: async (call) => {
          executions.push(call.name);
          return handlers.executeCodioTool(call, whitelist, userText);
        },
      });
    },
  };
}

function assertVisibleAndPlaybackStable(h, before) {
  assert.strictEqual(h.shown().matched, before.matched);
  assert.strictEqual(h.shown().frontier, before.frontier);
  assert.equal(before.matched.length + before.frontier.length, 24);
  assert.deepEqual(h.visibleWrites, [], "DJ feedback must not publish a replacement recommendation page");
  assert.deepEqual(h.playbackCalls, [], "preference-only speech must not select or play a song");
  assert.equal(h.context.activeQQTrackLiveRef.current.mid, "current-id");
  assert.equal(h.context.musicAudioRef.current.paused, false);
  assert.equal(h.context.musicAudioRef.current.currentTime, 30);
  assert.equal(h.context.musicAudioRef.current.src, "test:audio");
  assert.deepEqual(h.context.playQueueRef.current.map(item => item.mid), ["current-id"]);
  assert.equal(h.context.activeQueueIndexRef.current, 0);
  assert.equal(h.storage.get("codio-recommendation-history"), "visible-history");
  assert.equal(h.storage.get("codio-taste-signals"), "legacy-history");
}

test("production Agent rechecks actual QQ status and resumes the earlier style preference after a connection confirmation", async () => {
  const h=harness({results:[track("verified-sun-song","Known song","孙燕姿")]}),before=h.shown();
  const original="I am addicted to 孙燕姿 recently, I really like her style and flow";
  Object.assign(h.context,{qqConnection:"needs-auth",qqPlaybackReady:false,pendingDjPreferenceRef:{current:null},
    recommendationVisibleRef:{current:before},recommendationScoresRef:{current:new Map()},volumeRef:{current:35},seamlessRef:{current:true},
    progress:0,timeContext:"Evening",weatherContext:"Weather off",nowPlayingOpen:false});
  let connected=false,round=0;const snapshots=[],statusCalls=[];
  h.context.window.codioDesktop.qqMusic.getStatus=async options=>{statusCalls.push(options);return{loggedIn:connected,playbackReady:connected};};
  h.context.window.codioDesktop.ai={step:async request=>{
    snapshots.push(request.context);
    if(!connected)return round++===0?response(search("before-connect")):{content:"搜索暂时不可用；偏好没有保存。",toolCalls:[]};
    assert.equal(request.context.library.connected,true,"must not reuse the old renderer needs-auth closure");
    assert.equal(request.context.resumedPreferenceRequest,original);
    if(round++===0)return response(search("after-connect"));
    if(round===2)return response(preferArtist("save-artist","孙燕姿"));
    assert.equal(request.context.listening.activeFeedbackScopes[0].artist,"孙燕姿");
    return{content:"已记下你喜欢孙燕姿，后续推荐重排已排队，当前列表保持不变。",toolCalls:[]};
  }};
  await h.handlers.runAgentTurn(original,[{role:"user",content:original}]);
  assert.equal(intelligence.activePreferences(h.memory()).length,0);assert.equal(h.context.pendingDjPreferenceRef.current.text,original);
  connected=true;round=0;
  const reply=await h.handlers.runAgentTurn("我已经连上了啊",[{role:"user",content:original},{role:"assistant",content:"偏好尚未保存"},{role:"user",content:"我已经连上了啊"}]);
  const saved=intelligence.activePreferences(h.memory());assert.equal(saved.length,1);assert.equal(saved[0].targetKey,"孙燕姿");assert.equal(saved[0].source,"dj");
  assert.equal(h.context.pendingDjPreferenceRef.current,null);assert.match(reply,/已记下/);
  assert.ok(statusCalls.every(options=>options.recover===false),"chat status reads must not open login/recovery windows");
  assert.equal(snapshots[0].library.connected,false);assert.equal(snapshots.at(-1).library.connected,true);
  assertVisibleAndPlaybackStable(h,before);await h.flushTimers();assert.deepEqual(h.refreshes,["feedback"]);
  assertVisibleAndPlaybackStable(h,before);
});

test("mixed-language preference uses the production executor and shared persisted memory without playback or replacing the visible batch", async () => {
  const songs = [track("fixture-wind", "风衣", "孙燕姿"), track("fixture-vortex", "漩涡", "孙燕姿")];
  const h = harness({ results: songs }), before = h.shown();
  const userText = "I recently fell in love with 孙燕姿's music, especially the 风衣 and 漩涡, it felt like stepping into gorgeous stories";
  const result = await h.run(userText, [response(search()), response(...songs.map((song, index) => preferTrack(`save-${index}`, song.mid)), preferArtist("save-artist", "孙燕姿")), { content: "", toolCalls: [] }]);
  const active = intelligence.activePreferences(h.memory());
  assert.equal(active.length, 3);
  assert.ok(active.every(item => item.source === "dj"));
  assert.deepEqual(intelligence.activePreferences(intelligence.loadListeningMemory(h.context.window.localStorage)), JSON.parse(JSON.stringify(active)));
  assert.equal(toolResults(result).filter(item => item.persisted === true && item.profileUpdated === true).length, 3);
  assertVisibleAndPlaybackStable(h, before);
  await h.flushTimers();
  assert.deepEqual(h.refreshes, ["feedback"]);
  assertVisibleAndPlaybackStable(h, before);
});

test("an unavailable live status check is not reported as proof of a disconnected QQ account", async () => {
  const h=harness();h.context.qqConnection="needs-auth";
  const result=await h.handlers.executeCodioTool(search(),new Map(),"我喜欢 Daniel 的歌",{loggedIn:false,playbackReady:false,statusVerified:false});
  assert.equal(result.ok,false);assert.equal(result.error,"QQ_STATUS_UNAVAILABLE");assert.equal(h.searchCalls.length,0);
  assert.equal(intelligence.activePreferences(h.memory()).length,0);
});

test("playback tool rejects requested-success fiction: unconnected, no source, and all failed successors",async()=>{
  const h=harness();h.context.musicAudioRef.current=null;h.context.activeQQTrackLiveRef.current=null;h.context.qqConnection="needs-auth";
  const play=await h.handlers.executeCodioTool(tool("play","control_playback",{action:"play"}),new Map(),"播放");
  assert.equal(play.ok,false);assert.equal(play.error,"QQ_NOT_CONNECTED");assert.equal(play.after.playing,false);
  h.context.qqConnection="connected";
  const next=await h.handlers.executeCodioTool(tool("next","control_playback",{action:"next"}),new Map(),"下一首");
  assert.equal(next.ok,false);assert.equal(next.status,"no_source");
  h.context.musicAudioRef.current={src:"valid:media",paused:false,ended:false};h.context.activeQQTrackLiveRef.current={mid:"same-track"};
  const unchanged=await h.handlers.executeCodioTool(tool("next2","control_playback",{action:"next"}),new Map(),"下一首");
  assert.equal(unchanged.ok,false);assert.equal(unchanged.after.track,unchanged.before.track);
});
test("multiple playback tools inspect live media rather than stale React isPlaying",async()=>{
  const h=harness();h.context.musicAudioRef.current.paused=true;
  h.context.togglePlayback=async()=>{h.context.musicAudioRef.current.paused=!h.context.musicAudioRef.current.paused;};
  const play=await h.handlers.executeCodioTool(tool("p","control_playback",{action:"play"}),new Map(),"播放");
  const pause=await h.handlers.executeCodioTool(tool("s","control_playback",{action:"pause"}),new Map(),"暂停");
  assert.equal(play.ok,true);assert.equal(play.after.playing,true);assert.equal(pause.before.playing,true);assert.equal(pause.ok,true);assert.equal(pause.after.playing,false);
});
test("no-Key chat refuses fake empathy and local shortcuts wait for actual result",async()=>{
  const h=harness();assert.equal(await h.handlers.replyTo("我今天有点难过"),h.context.FULL_AI_REQUIRED);assert.deepEqual(h.playbackCalls,[]);
  h.context.togglePlayback=async()=>{h.playbackCalls.push("pause");h.context.musicAudioRef.current.paused=true;};
  assert.equal(await h.handlers.replyTo("暂停"),"已暂停。");assert.deepEqual(h.playbackCalls,["pause"]);
  await h.handlers.replyTo("暂停");assert.deepEqual(h.playbackCalls,["pause"],"idempotent pause");
  h.context.togglePlayback=async()=>{};assert.match(await h.handlers.replyTo("继续"),/操作没有完成/);
});
test("the same player and DJ preference preserve identical reliable feature contributions",async()=>{
  const a=harness(),b=harness();const song={...valentina,genres:["R&B"],language:"英语"};
  a.handlers.writeTrackPreference(song,"more","track","player","player_more");
  b.handlers.writeTrackPreference(song,"more","track","dj","explicit_named_track");
  const pa=intelligence.activePreferences(a.memory())[0],pb=intelligence.activePreferences(b.memory())[0];
  assert.deepEqual(pa.features,pb.features);assert.equal(pa.source,"player");assert.equal(pb.source,"dj");
  const c={canonicalKey:`qq:${song.mid}`,track:{provider:"qq",id:song.mid,title:song.title,artist:song.artist},featureVector:pa.features,sourceConfidence:.95,alreadyHeard:false,inLibrary:false,alreadyRecommended:false,playable:true};
  const scores=h=>intelligence.scoreCandidate(c,intelligence.deriveListeningProfile(h.memory()),h.memory(),"match").contributions.map(x=>[x.key,x.signedWeight]);
  assert.deepEqual(scores(a),scores(b));
});

test("late measured tempo supplements one active preference and cannot revive withdrawal",()=>{
  const h=harness();h.handlers.writeTrackPreference(valentina,"more","track","player","explicit");
  const before=h.memory().explicitPreferences.length;
  h.handlers.supplementAnalyzedPreferences(valentina.mid,{bpm:91,tempoConfidence:.75});
  assert.equal(h.memory().explicitPreferences.length,before);assert.equal(intelligence.activePreferences(h.memory())[0].features.bpm.value,91);
  assert.equal(intelligence.activePreferences(h.memory())[0].features.energy.value,null);
  h.handlers.writeTrackPreference(valentina,"neutral","track","player","withdraw");const withdrawn=h.memory();
  h.handlers.supplementAnalyzedPreferences(valentina.mid,{bpm:92,tempoConfidence:.8});
  assert.strictEqual(h.memory(),withdrawn);assert.equal(intelligence.activePreferences(h.memory()).length,0);
});

test("AI rating requires a real track and repeating explicit like is not a UI toggle",async()=>{
  const h=harness(),call=tool("like","rate_current_track",{rating:"like"});
  h.context.activeQQTrackLiveRef.current=null;
  assert.equal((await h.handlers.executeCodioTool(call,new Map(),"我喜欢这首")).error,"NO_CURRENT_TRACK");
  h.context.activeQQTrackLiveRef.current=valentina;
  assert.equal((await h.handlers.executeCodioTool(call,new Map(),"我喜欢这首")).ok,true);
  assert.equal((await h.handlers.executeCodioTool(call,new Map(),"我喜欢这首")).ok,true);
  assert.equal(intelligence.activePreferences(h.memory()).length,1);
  assert.equal(intelligence.activePreferences(h.memory())[0].value,"more");
});

test("Daniel's two verified songs and artist preference persist in unified v2 memory without playback or replacing 24 visible songs", async () => {
  const h = harness();
  const before = h.shown();
  const result = await h.run(preferenceText, [
    response(search()),
    (messages) => {
      assert.deepEqual(JSON.parse(messages.at(-1).content).results.map(({ track_id }) => track_id), [valentina.mid, always.mid]);
      return response(preferTrack("valentina", valentina.mid), preferTrack("always", always.mid), preferArtist("artist"));
    },
    { content: "这两首听起来很对你的胃口，我们就从这里慢慢往外找。", toolCalls: [] },
  ]);
  assert.equal(result.successfulActions, 4);
  assert.deepEqual(h.searchCalls, [{ query: "Daniel Valentina Always", page: 1 }]);
  const saved = toolResults(result).slice(1);
  assert.ok(saved.every(({ ok, persisted, profileUpdated, recommendationEffect, recommendationUpdate }) => ok && persisted && profileUpdated && recommendationEffect === "queued" && recommendationUpdate.status === "queued" && recommendationUpdate.hiddenQueueCommitted === false));
  const preferences = intelligence.activePreferences(h.memory());
  assert.deepEqual(preferences.map(({ targetType, targetKey, value, scope, source }) => ({ targetType, targetKey, value, scope, source })), [
    { targetType: "track", targetKey: "qq:valentina-id", value: "more", scope: "track", source: "dj" },
    { targetType: "track", targetKey: "qq:always-id", value: "more", scope: "track", source: "dj" },
    { targetType: "artist", targetKey: "Daniel", value: "more", scope: "artist", source: "dj" },
  ]);
  assert.deepEqual(preferences.map(({ title, artist }) => ({ title, artist })), [
    { title: "Valentina", artist: "Daniel" }, { title: "Always", artist: "Daniel" }, { title: undefined, artist: "Daniel" },
  ]);
  assert.equal(new Set(preferences.map(({ eventId }) => eventId)).size, 3);
  assert.ok(preferences.every(({ eventId, sessionId, createdAt }) => eventId.startsWith("dj-preference-") && sessionId === h.memory().currentSession.sessionId && Number.isFinite(createdAt)));
  assert.deepEqual(h.storageWrites, Array(3).fill(intelligence.LISTENING_MEMORY_KEY));
  const persisted = JSON.parse(h.storage.get(intelligence.LISTENING_MEMORY_KEY));
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted, JSON.parse(JSON.stringify(h.memory())));
  assert.deepEqual(intelligence.activePreferences(intelligence.loadListeningMemory(h.context.window.localStorage)), persisted.explicitPreferences);
  assert.equal(intelligence.deriveListeningProfile(h.memory()).lifetimeProfile.artistAffinities.daniel, .85);
  assert.equal(h.context.discoveryPoolRef.current.length, 2, "verified songs become future candidates without duplicates");
  assert.equal(h.timers.size, 1, "one debounced hidden rerank covers all saved preferences");
  assertVisibleAndPlaybackStable(h, before);
  await h.flushTimers();
  assert.deepEqual(h.refreshes, ["feedback"]);
  assertVisibleAndPlaybackStable(h, before);
  assert.match(result.content, /Valentina/);
  assert.match(result.content, /Always/);
  assert.match(result.content, /歌手 Daniel/);
  assert.match(result.content, /24 首.*REFRESH/);
  assert.match(result.content, /这两首听起来很对你的胃口/);
  assert.doesNotMatch(result.content, /推荐已经调整好了|\{"ok"/);
});

test("real QQ metadata accepts Daniel Caesar and Always Explicit without selecting audio", async () => {
  const original = track("000KZkOT2dmYNm", "Valentina", "Daniel Caesar");
  const explicit = track("002zuwNj3JoRQk", "Always (Explicit)", "Daniel Caesar");
  const unrelated = track("other-valentina", "Valentina", "Fulano y Mengano");
  const bonus = track("bonus-valentina", "Valentina (Bonus|Explicit)", "Daniel Caesar / Rick Ross");
  const h = harness({ results: [original, explicit, unrelated, bonus] });
  const before = h.shown();
  const result = await h.run(preferenceText, [
    response(search()),
    response(preferTrack("original", original.mid), preferTrack("explicit", explicit.mid), preferArtist("artist", "Daniel Caesar")),
    { content: "done", toolCalls: [] },
  ]);
  assert.deepEqual(toolResults(result).slice(1).map(({ ok }) => ok), [true, true, true]);
  assert.deepEqual(intelligence.activePreferences(h.memory()).map(({ targetKey }) => targetKey), [intelligence.canonicalTrackKey("qq", original.mid), intelligence.canonicalTrackKey("qq", explicit.mid), "Daniel Caesar"]);
  assertVisibleAndPlaybackStable(h, before);
});

test("unknown or previous-turn IDs and unverified artist names cannot write preferences", async () => {
  const h = harness();
  const before = h.shown();
  const rejected = await h.run(preferenceText, [response(search()), response(preferTrack("invented", "invented-id"), preferArtist("unverified", "Other"))]);
  assert.deepEqual(toolResults(rejected).slice(1).map(({ error }) => error), ["TRACK_ID_NOT_FROM_THIS_TURN", "ARTIST_NOT_FROM_THIS_TURN"]);
  const previousTurn = await h.run(preferenceText, [response(preferTrack("stale", valentina.mid), preferArtist("stale-artist"))]);
  assert.deepEqual(toolResults(previousTurn).map(({ error }) => error), ["TRACK_ID_NOT_FROM_THIS_TURN", "ARTIST_NOT_FROM_THIS_TURN"]);
  assert.deepEqual(h.memory().explicitPreferences, []);
  assert.deepEqual(h.storageWrites, []);
  assert.equal(h.timers.size, 0);
  assertVisibleAndPlaybackStable(h, before);
});

test("same-title ambiguity and a mismatched named artist are rejected before persistence", async () => {
  const other = track("other-valentina", "Valentina", "Other singer");
  for (const [userText, selectedId, expected] of [
    ["我很喜欢 Valentina", valentina.mid, "AMBIGUOUS_TRACK"],
    ["我很喜欢 Daniel 的 Valentina", other.mid, "TRACK_ARTIST_MISMATCH"],
  ]) {
    const h = harness({ results: [valentina, other] });
    const result = await h.run(userText, [response(search()), response(preferTrack("ambiguous", selectedId))]);
    assert.equal(toolResults(result).at(-1).error, expected);
    assert.deepEqual(h.memory().explicitPreferences, []);
    assert.deepEqual(h.storageWrites, []);
    assert.deepEqual(h.playbackCalls, []);
    assert.match(result.content, /偏好没有保存/);
  }
});

test("unsolicited search-result and control playback are rejected for a preference-only sentence", async () => {
  const h = harness();
  const before = h.shown();
  const result = await h.run(preferenceText, [response(search()), response(
    tool("play-result", "play_search_result", { track_id: valentina.mid }),
    tool("play-control", "control_playback", { action: "play" }),
  )]);
  assert.deepEqual(toolResults(result).slice(1).map(({ error }) => error), ["PLAYBACK_REQUIRES_USER_INTENT", "PLAYBACK_REQUIRES_USER_INTENT"]);
  assert.equal(result.successfulActions, 1, "only search succeeded");
  assert.deepEqual(h.storageWrites, []);
  assertVisibleAndPlaybackStable(h, before);
  assert.match(result.content, /没有动播放状态/);
  assert.doesNotMatch(result.content, /已记下|已保存|已开始播放|\{"ok"/);
});

test("disconnect after a real saved preference reports facts without exposing JSON or repeating the write", async () => {
  const h = harness();
  const before = h.shown();
  const result = await h.run("我很喜欢 Daniel 的 Valentina", [
    response(search()), response(preferTrack("save", valentina.mid)),
    () => { throw new Error("simulated model disconnect"); },
  ]);
  assert.deepEqual(h.executions, ["search_music", "record_music_preference"]);
  assert.equal(result.successfulActions, 2);
  assert.equal(h.memory().explicitPreferences.length, 1);
  assert.deepEqual(h.storageWrites, [intelligence.LISTENING_MEMORY_KEY]);
  assert.match(result.content, /已记下.*Valentina/);
  assert.match(result.content, /后续推荐/);
  assert.match(result.content, /不会重复执行/);
  assert.doesNotMatch(result.content, /\{"|persisted|targetKey|simulated model disconnect/);
  assertVisibleAndPlaybackStable(h, before);
});

test("session intent persists separately and leaves existing lifetime preferences and visible pages intact", async () => {
  const h = harness();
  await h.run(preferenceText, [response(search()), response(preferTrack("track", valentina.mid), preferArtist("artist"))]);
  const before = h.shown();
  const preferences = h.memory().explicitPreferences;
  const lifetime = intelligence.deriveListeningProfile(h.memory()).lifetimeProfile;
  const result = await h.run("今晚想听安静一点的新歌，接下来连续听", [response(
    tool("intent", "set_session_intent", { energy: "calm", familiarity: "explore", flow: "continuous" }),
  )]);
  const intent = toolResults(result)[0];
  assert.equal(intent.ok, true);
  assert.equal(intent.energyApplied,false);
  assert.match(intent.limitation,/缺少跨歌曲可比能量证据/);
  assert.equal(intent.scope, "session");
  assert.equal(intent.persisted, true);
  assert.equal(intent.profileUpdated, false);
  assert.equal(intent.lifetimeProfileUpdated, false);
  assert.equal(intent.expiresAt - intent.intent.createdAt, intelligence.SESSION_INTENT_TTL_MS);
  assert.deepEqual(h.memory().sessionIntent, intent.intent);
  assert.strictEqual(h.memory().explicitPreferences, preferences);
  assert.deepEqual(intelligence.deriveListeningProfile(h.memory()).lifetimeProfile, lifetime);
  assert.deepEqual(JSON.parse(h.storage.get(intelligence.LISTENING_MEMORY_KEY)).sessionIntent, intent.intent);
  await h.flushTimers();
  assert.deepEqual(h.refreshes, ["feedback"]);
  assertVisibleAndPlaybackStable(h, before);
  assert.match(result.content, /长期画像不变/);
});

test("unhydrated memory cannot claim a saved DJ preference", async () => {
  const h = harness({ hydrated: false });
  const result = await h.run(preferenceText, [response(search()), response(preferTrack("save", valentina.mid))]);
  assert.equal(toolResults(result).at(-1).error, "PROFILE_NOT_READY");
  assert.deepEqual(h.storageWrites, []);
  assert.deepEqual(h.memory().explicitPreferences, []);
  assert.match(result.content, /偏好没有保存/);
});

test("a second artist's actual QQ identities use the same policy and persistent memory, not a Daniel special case", async () => {
  const pink=track("003yZX8R0EU0FG","Pink + White","Frank Ocean");
  const ivy=track("002GXR1Z0SGIbD","Ivy (Explicit)","Frank Ocean");
  const h=harness({results:[pink,ivy]});const before=h.shown();
  const result=await h.run("我喜欢 Frank Ocean 的 Pink + White 和 Ivy，其他他的歌也不错",[
    response(search()),response(preferTrack("pink",pink.mid),preferTrack("ivy",ivy.mid),preferArtist("frank","Frank Ocean")),{content:"ok",toolCalls:[]}]);
  assert.deepEqual(intelligence.activePreferences(h.memory()).map(x=>x.targetKey),[intelligence.canonicalTrackKey("qq",pink.mid),intelligence.canonicalTrackKey("qq",ivy.mid),"Frank Ocean"]);
  assertVisibleAndPlaybackStable(h,before);assert.match(result.content,/尚未确认队列提交/);
  assert.deepEqual(intelligence.activePreferences(intelligence.loadListeningMemory(h.context.window.localStorage)),JSON.parse(JSON.stringify(intelligence.activePreferences(h.memory()))));
});

test("explicit instrumental dislike saves one unified, visible and durable style preference without searching or touching playback", async () => {
  const h = harness(), before = h.shown();
  h.context.qqConnection = "needs-auth";
  h.context.qqPlaybackReady = false;
  const result = await h.run("我不喜欢纯音乐", [response(preferInstrumental()), { content: "已了解", toolCalls: [] }]);
  const saved = toolResults(result)[0];
  assert.equal(saved.ok, true);
  assert.deepEqual([saved.targetType, saved.targetKey, saved.featureKey, saved.title, saved.value, saved.scope], ["feature", "instrumental", "instrumental", "纯音乐", "less", "style"]);
  assert.equal(saved.persisted, true);
  assert.equal(saved.profileUpdated, true);
  assert.equal(saved.evidencePolicy, "provider_annotation_or_metadata_only");
  assert.equal(saved.recommendationEffect, "queued");
  assert.equal(saved.recommendationUpdate.hiddenQueueCommitted, false, "a queued task is not a committed recommendation result");
  const active = intelligence.activePreferences(h.memory());
  assert.equal(active.length, 1);
  assert.deepEqual([active[0].targetType, active[0].targetKey, active[0].scope, active[0].source], ["feature", "instrumental", "style", "dj"]);
  assert.ok(intelligence.deriveListeningProfile(h.memory()).lifetimeProfile.tagAffinities.instrumental < 0);
  const restored = intelligence.loadListeningMemory(h.context.window.localStorage);
  assert.deepEqual(intelligence.activePreferences(restored), JSON.parse(JSON.stringify(active)));
  const row = presentation.buildListeningPresentation(restored).recentFeedback.find(item => item.eventId === active[0].eventId);
  assert.deepEqual([row.title, row.sourceLabel, row.actionLabel, row.active, row.scopeLabel], ["纯音乐", "CODIO DJ 明确记录", "少听一点", true, "长期偏好"]);
  assert.deepEqual(h.executions, ["record_music_preference"]);
  assert.deepEqual(h.searchCalls, []);
  assert.deepEqual(h.storageWrites, [intelligence.LISTENING_MEMORY_KEY]);
  assertVisibleAndPlaybackStable(h, before);
  assert.match(result.content, /纯音乐/);
  assert.doesNotMatch(result.content, /《纯音乐》|有一步操作没能确认生效|\{"ok"/);
  await h.flushTimers();
  assert.deepEqual(h.refreshes, ["feedback"]);
  assertVisibleAndPlaybackStable(h, before);
});

test("instrumental preference cannot be fabricated from an ordinary question or contradictory direction", async () => {
  for (const [userText, args] of [
    ["纯音乐是什么？", { target_type: "feature", feature_key: "instrumental", value: "less" }],
    ["我不喜欢纯音乐", { target_type: "feature", feature_key: "instrumental", value: "more" }],
    ["我不喜欢纯音乐", { target_type: "feature", feature_key: "unknown-genre", value: "less" }],
  ]) {
    const h = harness(), before = h.shown();
    const result = await h.run(userText, [response(tool("bad-feature", "record_music_preference", args)), { content: "done", toolCalls: [] }]);
    assert.equal(toolResults(result)[0].ok, false);
    assert.deepEqual(h.memory().explicitPreferences, []);
    assert.deepEqual(h.storageWrites, []);
    assert.deepEqual(h.searchCalls, []);
    assert.equal(h.timers.size, 0);
    assertVisibleAndPlaybackStable(h, before);
  }
});

test("category speech never becomes a current-track rating or an unsolicited skip", async () => {
  const h = harness(), before = h.shown();
  const result = await h.run("我不喜欢纯音乐", [response(
    tool("wrong-rate", "rate_current_track", { rating: "dislike" }),
    tool("wrong-next", "control_playback", { action: "next" }),
    preferInstrumental("right-feature"),
  ), { content: "done", toolCalls: [] }]);
  assert.deepEqual(toolResults(result).map(item => item.ok), [false, false, true]);
  assert.deepEqual(intelligence.activePreferences(h.memory()).map(item => [item.targetType, item.targetKey]), [["feature", "instrumental"]]);
  assertVisibleAndPlaybackStable(h, before);
});

test("saved instrumental preference survives a final model disconnect and duplicate tool ID without a second write", async () => {
  for (const duplicate of [false, true]) {
    const h = harness(), before = h.shown();
    const steps = [response(preferInstrumental("one-save"))];
    if (duplicate) steps.push(response(preferInstrumental("one-save")));
    steps.push(() => { throw new Error("simulated final response disconnect"); });
    const result = await h.run("我不喜欢纯音乐", steps);
    assert.deepEqual(h.executions, ["record_music_preference"]);
    assert.equal(h.memory().explicitPreferences.length, 1);
    assert.deepEqual(h.storageWrites, [intelligence.LISTENING_MEMORY_KEY]);
    assert.match(result.content, /纯音乐/);
    assert.doesNotMatch(result.content, /\{"|simulated final response disconnect|TOOL_/);
    if (duplicate) assert.ok(toolResults(result).some(item => item.ok === false && /DUPLICATE/.test(item.error)));
    assertVisibleAndPlaybackStable(h, before);
  }
});

test("the existing Profile withdrawal removes instrumental preference and its final score effect after reload", async () => {
  const h = harness(), before = h.shown();
  await h.run("我不喜欢纯音乐", [response(preferInstrumental()), { content: "done", toolCalls: [] }]);
  const active = intelligence.activePreferences(h.memory())[0];
  assert.ok(active, "category preference must be saved before withdrawal");
  h.handlers.withdrawPreference(active);
  assert.deepEqual(intelligence.activePreferences(h.memory()), []);
  assert.equal(intelligence.deriveListeningProfile(h.memory()).lifetimeProfile.tagAffinities.instrumental, undefined);
  const restored = intelligence.loadListeningMemory(h.context.window.localStorage);
  assert.deepEqual(intelligence.activePreferences(restored), []);
  const row = presentation.buildListeningPresentation(restored).recentFeedback.find(item => item.eventId === active.eventId);
  assert.equal(row.state, "withdrawn");
  assert.equal(row.active, false);
  assert.equal(h.memory().explicitPreferences.length, 2, "withdrawal preserves the earlier record as history rather than deleting data");
  assert.equal(h.timers.size, 1, "save and withdrawal coalesce into one rerank using the newest memory");
  assertVisibleAndPlaybackStable(h, before);
});

test("instrumental dislike is consumed by final ranking only for explicit provider evidence, never missing lyrics or artist hints", async () => {
  // Synthetic metadata fixtures verify the evidence boundary, not a claim about real-song sonic understanding.
  const h = harness();
  const candidates = [
    { ...track("instrumental-version", "Example (Instrumental)", "Same artist"), genres: [] },
    { ...track("instrumental-metadata", "Provider category example", "Other artist"), genres: ["Instrumental"] },
    { ...track("unknown", "Unknown voice content", "Same artist"), genres: [], lyrics: "", lyricStatus: "missing" },
    { ...track("heuristic", "Unverified artist guess", "Hinted artist"), genres: [], lyrics: "" },
  ];
  h.context.artistTasteHints = [[/Hinted artist/, ["instrumental", "ambient"]]];
  const candidate = song => ({ canonicalKey: `qq:${song.mid}`, track: { provider: "qq", id: song.mid, title: song.title, artist: song.artist }, featureVector: h.handlers.featureVectorForTrack(song), sourceConfidence: .95, alreadyHeard: false, inLibrary: false, alreadyRecommended: false, playable: true });
  const score = (song, memory) => intelligence.scoreCandidate(candidate(song), intelligence.deriveListeningProfile(memory), memory, "match");
  const baselineMemory = h.memory();
  const before = candidates.map(song => score(song, baselineMemory));
  await h.run("我不喜欢纯音乐", [response(preferInstrumental()), { content: "done", toolCalls: [] }]);
  const savedMemory = intelligence.loadListeningMemory(h.context.window.localStorage);
  const after = candidates.map(song => score(song, savedMemory));
  for (const index of [0, 1]) {
    assert.ok(after[index].totalScore < before[index].totalScore, candidates[index].title);
    const changed = after[index].contributions.filter((item, part) => item.signedWeight !== before[index].contributions[part].signedWeight);
    assert.ok(changed.length > 0);
    assert.ok(changed.every(item => item.signedWeight <= before[index].contributions.find(previous => previous.key === item.key).signedWeight));
  }
  for (const index of [2, 3]) {
    assert.equal(after[index].totalScore, before[index].totalScore, `${candidates[index].title}: unknown is not instrumental`);
    assert.deepEqual(after[index].contributions.map(item => [item.key, item.signedWeight || 0]), before[index].contributions.map(item => [item.key, item.signedWeight || 0]));
  }
  assert.equal(intelligence.deriveListeningProfile(savedMemory).lifetimeProfile.artistAffinities["same artist"], undefined, "a category dislike must not become an artist ban");
  h.handlers.withdrawPreference(intelligence.activePreferences(h.memory())[0]);
  const withdrawn = intelligence.loadListeningMemory(h.context.window.localStorage);
  assert.deepEqual(candidates.map(song => score(song, withdrawn).totalScore), before.map(item => item.totalScore));
});

test("no-Key instrumental preference speech does not pretend that a preference was saved", async () => {
  const h = harness(), before = h.shown();
  assert.equal(await h.handlers.replyTo("我不喜欢纯音乐"), h.context.FULL_AI_REQUIRED);
  assert.deepEqual(h.memory().explicitPreferences, []);
  assert.deepEqual(h.storageWrites, []);
  assertVisibleAndPlaybackStable(h, before);
});

test("instrumental preference storage failure cannot claim persistence or trigger offline actions", async () => {
  const h = harness(), before = h.shown();
  h.context.window.localStorage.setItem = () => { throw new Error("simulated unavailable storage"); };
  const result = await h.run("我不喜欢纯音乐", [response(preferInstrumental()), { content: "done", toolCalls: [] }]);
  assert.equal(toolResults(result)[0].error, "TOOL_EXECUTION_FAILED");
  assert.equal(result.successfulActions, 0);
  assert.deepEqual(h.memory().explicitPreferences, []);
  assert.equal(h.timers.size, 0);
  assert.doesNotMatch(result.content, /已(?:保存|记下).*纯音乐|simulated unavailable storage|\{"/);
  assertVisibleAndPlaybackStable(h, before);
});

test("repeated instrumental feedback is one active scoring contribution and low-confidence tags remain unknown", async () => {
  const h = harness();
  const song = track("annotated", "An example (Instrumental)", "Any artist");
  const item = { canonicalKey: `qq:${song.mid}`, track: { provider: "qq", id: song.mid, title: song.title, artist: song.artist }, featureVector: h.handlers.featureVectorForTrack(song), sourceConfidence: .95, alreadyHeard: false, inLibrary: false, alreadyRecommended: false, playable: true };
  const scored = candidate => intelligence.scoreCandidate(candidate, intelligence.deriveListeningProfile(h.memory()), h.memory(), "match");
  const part = candidate => scored(candidate).contributions.find(value => value.key === "instrumental_preference");
  await h.run("我不喜欢纯音乐", [response(preferInstrumental("save-once")), { content: "done", toolCalls: [] }]);
  const first = part(item);
  assert.ok(Math.abs(first.signedWeight - (-.68 * .65 * .9)) < 1e-12);
  assert.equal(first.source, "provider_version_annotation");
  await h.run("我还是不喜欢纯音乐", [response(preferInstrumental("save-again")), { content: "done", toolCalls: [] }]);
  assert.equal(intelligence.activePreferences(h.memory()).length, 1);
  assert.equal(part(item).signedWeight, first.signedWeight, "history of repeated statements does not double count the preference");
  const unknown = { ...item, track: { ...item.track, title: "Unannotated" }, featureVector: { ...item.featureVector, tags: [{ value: "instrumental", source: "provider_metadata", confidence: .59, profileEligible: true }] } };
  assert.equal(part(unknown).confidence, 0);
  assert.equal(part(unknown).signedWeight || 0, 0);
  for (const key of ["long_term_affinity", "explicit_style"]) assert.equal(scored(unknown).contributions.find(value => value.key === key).signedWeight || 0, 0, "uncertain instrumental tag cannot sneak through the generic style score");
  const reliable = { ...unknown, featureVector: { ...unknown.featureVector, tags: [{ value: "instrumental", source: "provider_metadata", confidence: .8, profileEligible: true }] } };
  assert.equal(part(reliable).source, "provider_metadata:instrumental");
  assert.ok(Math.abs(part(reliable).signedWeight - (-.68 * .65 * .8)) < 1e-12);
  for (const key of ["long_term_affinity", "explicit_style"]) assert.equal(scored(reliable).contributions.find(value => value.key === key).signedWeight || 0, 0, "controlled category is consumed only once");
});

test("a word in a plain song title is not an instrumental version annotation; explicit brackets and version suffixes are", async () => {
  const h = harness();
  const titles = [
    ["Instrumental Love", false], ["纯音乐世界", false], ["Karaoke Tonight", false], ["我们的伴奏", false],
    ["Example (Instrumental)", true], ["Example（纯音乐版）", true], ["Example【伴奏】", true],
    ["Example - Instrumental Version", true], ["Example – Karaoke Version", true], ["Example — 伴奏版", true],
  ];
  const candidates = titles.map(([title], index) => {
    const song = track(`annotation-${index}`, title, "Any artist");
    return { canonicalKey: `qq:${song.mid}`, track: { provider: "qq", id: song.mid, title: song.title, artist: song.artist }, featureVector: h.handlers.featureVectorForTrack(song), sourceConfidence: .95, alreadyHeard: false, inLibrary: false, alreadyRecommended: false, playable: true };
  });
  const score = item => intelligence.scoreCandidate(item, intelligence.deriveListeningProfile(h.memory()), h.memory(), "match");
  const before = candidates.map(score);
  await h.run("我不喜欢纯音乐", [response(preferInstrumental()), { content: "done", toolCalls: [] }]);
  for (const [index, [title, annotated]] of titles.entries()) {
    const after = score(candidates[index]);
    const contribution = after.contributions.find(item => item.key === "instrumental_preference");
    assert.equal(contribution.confidence, annotated ? .9 : 0, title);
    assert.equal(contribution.source, annotated ? "provider_version_annotation" : "unknown", title);
    assert.ok(Math.abs((after.totalScore - before[index].totalScore) - (annotated ? -.68 * .65 * .9 : 0)) < 1e-12, title);
  }
});
