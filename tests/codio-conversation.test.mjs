import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import vm from "node:vm";

const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const agent = await import(`data:text/javascript;base64,${Buffer.from(compile(await readFile(new URL("../app/codio-agent.ts", import.meta.url), "utf8"))).toString("base64")}`);
const call = (target_type, target, value = "more") => ({ id: target, name: "record_music_preference", arguments: {
  target_type, ...(target_type === "artist" ? { artist_name: target } : { track_id: target }), value,
} });
const tracks = [{ id: "fixture-wind", title: "风衣", artist: "孙燕姿" }, { id: "fixture-vortex", title: "漩涡", artist: "孙燕姿" }];
const text = "I recently fell in love with 孙燕姿's music, especially the 风衣 and 漩涡, it felt like stepping into gorgeous stories";
const policy = userText => ({ userText, qqConnected: true, playbackReady: true, searchResultIds: tracks.map(t => t.id),
  searchResultArtists: ["孙燕姿"], searchResultTracks: tracks, interface: { theme: "night", scene: "night", particles: 2, lyrics: "cinematic", panel: "dj" } });

test("model-selected preferences use a verified verbatim span instead of demanding a fixed phrase", () => {
  for (const text of ["孙燕姿的歌太对我胃口了", "I keep coming back to 孙燕姿's music; her voice just works for me"]) {
    const request = call("artist", "孙燕姿");
    assert.equal(agent.validateCodioToolCall(request, policy(text)), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT", "reproduces the old synonym gate");
    request.arguments.evidence_text = text;
    assert.equal(agent.validateCodioToolCall(request, policy(text)), null);
    assert.equal(agent.validateCodioToolCall({ id: "play", name: "control_playback", arguments: { action: "play" } }, policy(text)), "PLAYBACK_REQUIRES_USER_INTENT");
  }
  const text = "风衣这首越听越合我心意";
  const request = call("track", "fixture-wind"); request.arguments.evidence_text = text;
  assert.equal(agent.validateCodioToolCall(request, policy(text)), null);
  request.arguments.track_id = "invented";
  assert.equal(agent.validateCodioToolCall(request, policy(text)), "TRACK_ID_NOT_FROM_THIS_TURN");
});

test("evidence cannot invent a quote, reverse a direction or expand a song into an artist", () => {
  const request = call("artist", "孙燕姿");
  request.arguments.evidence_text = "我喜欢孙燕姿";
  assert.equal(agent.validateCodioToolCall(request, policy("我在听孙燕姿")), "INVALID_PREFERENCE_EVIDENCE");
  for (const text of ["我不喜欢孙燕姿", "我喜欢风衣 by 孙燕姿", "今晚想听孙燕姿", "朋友说孙燕姿很好听", "孙燕姿的歌适合我吗？", "我正在听孙燕姿", "I am listening to 孙燕姿"]) {
    request.arguments.evidence_text = text;
    assert.notEqual(agent.validateCodioToolCall(request, policy(text)), null, text);
  }
  assert.equal(agent.validateCodioToolCall({id:"intent",name:"set_session_intent",arguments:{energy:"calm"}}, policy("I'm in the mood for something calm tonight")), null);
});

test("mixed-language explicit artist preference and especially song list pass verified scope checks", () => {
  for (const request of [call("artist", "孙燕姿"), ...tracks.map(track => call("track", track.id))])
    assert.equal(agent.validateCodioToolCall(request, policy(text)), null);
  assert.equal(agent.validateCodioToolCall({ id: "p", name: "control_playback", arguments: { action: "play" } }, policy(text)), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(agent.validateCodioToolCall(call("track", "invented"), policy(text)), "TRACK_ID_NOT_FROM_THIS_TURN");
});

test("the reported addicted/style/flow wording records verified artist scope without a remember command", () => {
  for (const userText of ["I am addicted to 孙燕姿 recently, I really like her style and flow", "I really like 孙燕姿's style and flow", "I am addicted to 孙燕姿 lately"]) {
    assert.equal(agent.validateCodioToolCall(call("artist","孙燕姿"),policy(userText)),null,userText);
    assert.equal(agent.validateCodioToolCall({id:"p",name:"control_playback",arguments:{action:"play"}},policy(userText)),"PLAYBACK_REQUIRES_USER_INTENT");
  }
  assert.equal(agent.validateCodioToolCall(call("artist","孙燕姿"),policy("I really like 风衣 by 孙燕姿")),"PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT");
});

test("connection confirmations resume only a recent unresolved explicit preference, not an unrelated/expired request", () => {
  const original="I am addicted to 孙燕姿 recently, I really like her style and flow";
  const first=agent.preferencePermissionForTurn(original,null,1000);
  assert.equal(first.pending.text,original);
  for (const text of ["我已经连上了啊","QQ音乐已经连上了","现在可以了","I have connected to QQ Music now"]) {
    assert.equal(agent.preferencePermissionForTurn(text,first.pending,2000).text,original,text);
  }
  for (const text of ["我不想记录了","我今天在学习","暂停","继续","还没有连上"]) {
    const next=agent.preferencePermissionForTurn(text,first.pending,2000);
    assert.equal(next.text,text);assert.equal(next.pending,null);
  }
  assert.equal(agent.preferencePermissionForTurn("我已经连上了啊",first.pending,700000).pending,null);
  assert.equal(agent.preferencePermissionForTurn("我已经连上了啊",null,2000).pending,null);
});

test("the actual preload and main IPC route can read current QQ state without invoking recovery", async () => {
  const preload=await readFile(new URL("../desktop/preload.cjs",import.meta.url),"utf8");
  const calls=[];let bridge;
  vm.runInNewContext(preload,{require:name=>{assert.equal(name,"electron");return{contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},
    ipcRenderer:{invoke(...args){calls.push(args);return Promise.resolve({loggedIn:true,playbackReady:true});}}};}});
  await bridge.qqMusic.getStatus({recover:false});await bridge.qqMusic.getStatus();
  assert.equal(calls[0][0],"codio:qq-status");assert.equal(calls[0][1].recover,false);assert.equal(calls[1][1].recover,true);
  const main=await readFile(new URL("../desktop/main.cjs",import.meta.url),"utf8");
  const expression=main.match(/ipcMain\.handle\("codio:qq-status", ([^\n]+)\);/)[1];let reads=0,restores=0;
  const route=new Function("readQQStatus","refreshQQPlaybackSession",`return (${expression});`)(
    async()=>{reads++;return{loggedIn:true,playbackReady:false};},async()=>{restores++;return{loggedIn:true,playbackReady:true};});
  assert.equal((await route({},calls[0][1])).playbackReady,false);assert.equal(reads,1);assert.equal(restores,0);
  assert.equal((await route({},calls[1][1])).playbackReady,true);assert.equal(restores,1);
});

test("English scope support does not turn a single song, negation, quote, question or temporary desire into an artist preference", () => {
  for (const userText of ["I love 风衣", "I don't love 孙燕姿's music", "She said I love 孙燕姿's music", "Do I love 孙燕姿's music?", "Tonight I love 孙燕姿's music", "I love 孙燕姿's music, but don't save this preference"])
    assert.equal(agent.validateCodioToolCall(call("artist", "孙燕姿"), policy(userText)), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT", userText);
  assert.equal(agent.validateCodioToolCall(call("track", tracks[0].id), policy("I love 孙燕姿's music, especially not 风衣")), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT");
});

test("model failure preserves stable error distinctions without exposing raw Electron errors", () => {
  for (const [code, phrase] of [["CODIO_MODEL_TIMEOUT", "超时"], ["CODIO_MODEL_NETWORK", "无法连接"], ["CODIO_MODEL_UNAUTHORIZED", "认证"],
    ["CODIO_MODEL_PAYMENT_REQUIRED", "余额"], ["CODIO_MODEL_RATE_LIMITED", "受限"], ["CODIO_CONTEXT_TOO_LARGE", "上限"]]) {
    const message = agent.codioRequestFailure(new Error(`Error invoking remote method 'codio:ai-step': Error: ${code}`));
    assert.ok(message.includes(phrase)); assert.match(message, /没有执行任何操作/); assert.doesNotMatch(message, /remote method|CODIO_/);
  }
});

test("a natural model answer cannot claim saved preferences or changed recommendations without any tool result", async () => {
  const result = await agent.runCodioAgentLoop({ messages: [{ role: "user", content: text }], context: () => ({}),
    step: async () => ({ content: "已记下你的偏好，推荐队列已经更新了。", toolCalls: [] }), execute: async () => { throw Error("must not execute"); } });
  assert.match(result.content, /没有操作生效/);
  assert.doesNotMatch(result.content, /已记下你的偏好|已经更新了/);
});

test("completed hidden queue is observed after preference save, while an older refresh cannot upgrade queued facts", async () => {
  for (const revision of [4, 6]) {
    let round = 0;
    const result = await agent.runCodioAgentLoop({ messages: [{ role: "user", content: text }],
      context: () => ({ recommendations: { latestUpdate: { status: "completed", revision, hiddenQueueCommitted: true } } }),
      step: async () => { if (round++) throw Error("network"); return { content: "", toolCalls: [call("track", tracks[0].id)] }; },
      execute: async () => ({ ok: true, persisted: true, profileUpdated: true, targetType: "track", title: "风衣", value: "more", recommendationEffect: "queued", recommendationUpdate: { status: "queued", revision: 5, hiddenQueueCommitted: false } }),
    });
    assert.equal(result.successfulActions, 1);
    assert.match(result.content, revision >= 5 ? /未展示的推荐队列已提交/ : /尚未确认队列提交/);
    assert.match(result.content, /不会重复执行/);
  }
});

test("production context remains within the wire limit with a large library profile and full feature snapshots", async () => {
  const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "buildCodioContext") declaration = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(declaration);
  const affinity = Object.fromEntries(Array.from({ length: 849 }, (_, i) => [`Fixture artist ${i}`, i / 849]));
  const layer = { artistAffinities: affinity, tagAffinities: affinity, evidenceCount: 1000, distinctTrackCount: 849 };
  const profile = { lifetimeProfile: layer, recentProfile: layer, sessionProfile: layer,
    contextualProfiles: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`context-${i}`, { ...layer, reliability: .6 }])),
    confidence: "growing", hypotheses: [], recentEffects: [], sessionIntent: null };
  const context = { listeningMemoryRef: { current: { trackMemories: {}, corrections: [] } }, deriveListeningProfile: () => profile,
    activeQQTrackLiveRef: { current: null }, playQueueRef: { current: [] }, activeQueueIndexRef: { current: 0 }, musicAudioRef: { current: null },
    recommendationScoresRef: { current: new Map() }, recommendationUpdateRef: { current: { latest: { status: "completed", revision: 3, lanes: [{ lane: "match", status: "completed", privateLargeCandidateExport: "x".repeat(100000) }] } } },
    activePreferences: () => Array.from({ length: 100 }, (_, i) => ({ targetType: "track", targetKey: `fixture-${i}`, title: `Track ${i}`, value: "more", features: { huge: "x".repeat(100000) } })),
    matchedExperiments: [], visibleExperiments: [], recommendationVisibleRef: { current: { matched: [], frontier: [] } }, volumeRef: { current: 30 }, seamlessRef: { current: true }, progress: 0,
    qqConnection: "connected", qqTasteSnapshotRef: { current: null }, timeContext: {}, weatherContext: {}, scene: "night", particleLevel: 2, lyricMode: "cinematic", nowPlayingOpen: false };
  const factory = new Function("context", `with(context){ ${compile(`const ${declaration};`)} return buildCodioContext(); }`);
  const snapshot = factory(context);
  assert.ok(JSON.stringify(snapshot).length < 15000);
  assert.equal(Object.keys(snapshot.listening.lifetimeProfile.artistAffinities).length, 8);
  assert.equal(snapshot.listening.activeFeedbackScopes.length, 12);
  assert.equal(snapshot.listening.activeFeedbackScopes[0].features, undefined);
  assert.equal(snapshot.recommendations.latestUpdate.lanes[0].privateLargeCandidateExport, undefined);
});
