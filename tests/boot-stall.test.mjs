import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// Exercise the production IPC metadata scheduler and renderer enrichment with
// an isolated clock. No QQ calls, real library, credentials or storage are used.
const radioSource = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const intelligenceSource = await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8");
const intelligence = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(intelligenceSource,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);
const declarations = new Map(), laneBeginCalls = [];
let startupReleaseEffect,bootProgressInitializer,bootProgressElement,warmSourceProgressBranch,coldSourceProgressBranch,
  learningContextEffect,learningContextDependencies,scoringOptionsFactory;
for (const [file, text, kind] of [["RadioExperience.tsx", radioSource, ts.ScriptKind.TSX], ["main.cjs", mainSource, ts.ScriptKind.JS],
  ["listening-intelligence.ts", intelligenceSource, ts.ScriptKind.TS]]) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast));
    if (ts.isVariableDeclaration(node) && ["connectQQMusic","syncQQTaste"].includes(node.name.getText(ast)) && node.initializer)
      declarations.set(node.name.getText(ast), `const ${node.name.getText(ast)} = ${node.initializer.getText(ast)};`);
    if (file === "RadioExperience.tsx" && ts.isVariableDeclaration(node) && node.name.getText(ast) === "bootProgress") bootProgressInitializer=node.initializer.getText(ast);
    if (file === "RadioExperience.tsx" && ts.isVariableDeclaration(node) && node.name.getText(ast) === "scoringOptions"
      && node.initializer?.getText(ast).includes("weatherSnapshotRef.current.text"))scoringOptionsFactory=node.initializer.getText(ast);
    if (file === "RadioExperience.tsx" && ts.isJsxElement(node)
      && node.openingElement.getText(ast).includes('className="boot-progress-bar"')) bootProgressElement=node.getText(ast);
    if (file === "RadioExperience.tsx" && ts.isIfStatement(node) && node.expression.getText(ast).includes('bootPhase === "playing"')
      && node.thenStatement.getText(ast).includes("setBootPreparedSources")) {
      if(node.expression.getText(ast).includes("useStartupSnapshot"))warmSourceProgressBranch=node.getText(ast);
      else if(node.thenStatement.getText(ast).includes("shown.map"))coldSourceProgressBranch=node.getText(ast);
    }
    if (file === "RadioExperience.tsx" && ts.isCallExpression(node) && node.expression.getText(ast) === "beginRecommendationPoolUpdate") laneBeginCalls.push(node.getText(ast));
    if (file === "RadioExperience.tsx" && ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
      && node.arguments[0]?.getText(ast).includes("Do not start a cold catalogue scan")) startupReleaseEffect = node.arguments[0].getText(ast);
    if (file === "RadioExperience.tsx" && ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
      && node.arguments[0]?.getText(ast).includes("learningContextRef.current")){
      learningContextEffect=node.arguments[0].getText(ast);
      learningContextDependencies=ts.isArrayLiteralExpression(node.arguments[1])?node.arguments[1].elements.map(item=>item.getText(ast)):[];
    }
    ts.forEachChild(node, visit);
  })(ast);
}
function bind(name, context) {
  assert.ok(declarations.has(name), `Missing production function ${name}`);
  context.qqAuthorizationRevisionRef ||= {current:0};
  const js = ts.transpileModule(declarations.get(name).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function("context", `with(context){${js};return ${name};}`)(context);
}
// A real timer turn drains the complete microtask queue. A fixed number of
// awaits advanced fake deadlines while cached slot-release chains were active.
const microtasks = () => new Promise(resolve => setImmediate(resolve));
function scheduler() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = ++sequence; tasks.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    async advance(target) {
      await microtasks();
      while (true) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at; tasks.delete(next[0]); next[1].callback(); await microtasks();
      }
      now = target; await microtasks();
    },
  };
}
function metadataHarness() {
  const clock = scheduler(), requests = [], files = new Map();
  let active = 0, maxActive = 0, ipcCalls = 0;
  const main = {
    URL, QQ_MUSICU_URL: "https://metadata.invalid/", songMetadataCache: new Map(), songMetadataPending: new Map(), songMetadataActive: 0, songMetadataWaiters: [],
    SONG_METADATA_TTL_MS: 7*24*60*60*1000, SONG_METADATA_LIMIT: 400,
    songMetadataDiskLoaded:null,songMetadataWritePending:Promise.resolve(),Date:{now:clock.now},path,process:{pid:1},codioDataDirectories:{cache:"isolated-cache"},
    // The actual cache functions run against in-memory files only. No real
    // userData, credentials, desktop storage, or test-directory writes exist.
    fs:{async stat(file){if(!files.has(file))throw Error("ENOENT");return {size:Buffer.byteLength(files.get(file))};},
      async readFile(file){if(!files.has(file))throw Error("ENOENT");return files.get(file);},async mkdir(){},
      async writeFile(file,value){files.set(file,value);},async rename(from,to){files.set(to,files.get(from));files.delete(from);}},
    requestQQJson(url, options) {
      const id = JSON.parse(url.searchParams.get("data")).req_0.param.song_mid;
      requests.push({ id, at: clock.now(), timeoutMs: options.timeoutMs }); active++; maxActive = Math.max(maxActive, active);
      return new Promise(resolve => clock.setTimeout(() => {
        active--; resolve({ code: 0, req_0: { data: { track_info: { mid: id }, info: { genre: { content: [{ value: "Neo-Soul" }] } } } } });
      }, 3000));
    },
  };
  for(const name of ["qqMetadataCacheFile","normalizeQQMetadata","loadQQMetadataCache","persistQQMetadataCache"])main[name]=bind(name,main);
  const metadata = bind("readQQTrackMetadata", main);
  const renderer = {
    window: { codioDesktop: { qqMusic: { metadata: id => { ipcCalls++; return metadata(null, id); } } } },
    metadataEnrichmentRef: { current: { active: 0, waiters: [], pending: new Map() } },
    analysisLifecycleRef: { current: { mounted: true, generation: 1 } },
    withTimeout(promise, milliseconds, label) {
      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => reject(Error(`${label}_TIMEOUT`)), milliseconds);
        promise.then(value => { clock.clearTimeout(timer); resolve(value); }, error => { clock.clearTimeout(timer); reject(error); });
      });
    },
  };
  const enrich = bind("enrichTrackMetadata", renderer);
  return { clock, main, renderer, enrich, requests, maxActive: () => maxActive, ipcCalls: () => ipcCalls };
}

function startupHarness() {
  assert.ok(startupReleaseEffect,"the actual startup release effect must be exercised");
  const timers=[],runs=[];
  const context={bootPhase:"playing",onboardingChecked:true,qqConnection:"connected",tasteSyncing:false,
    listeningMemoryHydratedRef:{current:true},listeningMemoryRef:{current:{updatedAt:42}},qqSyncRevisionRef:{current:1},
    recommendationVisibleRef:{current:{matched:[],frontier:[]}},
    recommendationUpdateRef:{current:{revision:0,timer:null,startupReady:false,triggers:new Set(),latest:{},records:[]}},
    setRecommendationLoading(){},
    recommendationRefreshRef:{current:(...args)=>{runs.push(args);}},
    window:{codioDesktop:{qqMusic:{}},setTimeout(callback,delay){timers.push({callback,delay,cancelled:false});return timers.length;},
      clearTimeout(id){timers[id-1].cancelled=true;}},
  };
  context.requestRecommendationUpdate=bind("requestRecommendationUpdate",context);
  context.releaseStartupRecommendations=bind("releaseStartupRecommendations",context);
  const js=ts.transpileModule(`const run=${startupReleaseEffect};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const run=new Function("context",`with(context){${js};return run;}`)(context);
  return {context,timers,runs,run};
}

test("startup queues initial, library and context evidence once until the real release effect settles",()=>{
  const h=startupHarness(),update=h.context.recommendationUpdateRef.current;
  for(const trigger of ["initial","context_changed","qq_library_synced"])h.context.requestRecommendationUpdate(trigger);
  assert.equal(update.startupReady,false);assert.equal(update.timer,null);assert.equal(h.timers.length,0);assert.equal(h.runs.length,0);
  for(const block of [c=>{c.onboardingChecked=false;},c=>{c.listeningMemoryHydratedRef.current=false;},c=>{c.tasteSyncing=true;},
    c=>{c.qqSyncRevisionRef.current=0;},c=>{c.qqConnection="checking";},c=>{c.qqConnection="authorizing";},c=>{c.qqConnection="needs-auth";}]){
    const waiting=startupHarness();waiting.context.requestRecommendationUpdate("initial");block(waiting.context);waiting.run();
    assert.equal(waiting.context.recommendationUpdateRef.current.startupReady,false);assert.equal(waiting.timers.length,0);assert.equal(waiting.runs.length,0);
  }
  h.run();h.run();h.run();
  assert.equal(update.startupReady,true);assert.equal(h.timers.length,1);assert.equal(h.timers[0].delay,240);assert.equal(h.runs.length,0);
  h.timers[0].callback();
  assert.equal(h.runs.length,1);assert.equal(h.runs[0][0],"feedback");assert.equal(h.runs[0][1],update.revision);
  assert.deepEqual(h.runs[0][2],["initial","context_changed","qq_library_synced","startup_ready"]);
  assert.equal(update.timer,null);assert.equal(update.triggers.size,0);
  h.run();assert.equal(h.timers.length,1,"repeat effect renders cannot start a second initial catalogue batch");
});

test("a settled failed library attempt releases startup but changing weather cannot supersede its incomplete catalogue",()=>{
  const h=startupHarness(),update=h.context.recommendationUpdateRef.current;
  h.context.qqTasteSnapshotRef={current:null};h.context.qqSyncRevisionRef.current=1;
  h.context.requestRecommendationUpdate("initial");h.run();
  const revision=update.revision,queued=update.latest;
  h.context.requestRecommendationUpdate("context_changed");
  assert.equal(update.revision,revision);assert.strictEqual(update.latest,queued);assert.equal(h.timers.length,1);
  assert.equal(h.timers[0].cancelled,false,"weather cannot cancel the already queued initial scan");
  h.timers[0].callback();assert.equal(h.runs.length,1);
  h.context.recommendationVisibleRef.current={matched:Array(12).fill({}),frontier:Array(12).fill({})};
  h.context.requestRecommendationUpdate("context_changed");
  assert.equal(update.revision,revision+1,"a complete real homepage retains ordinary later context reranking");assert.equal(h.timers.length,2);
});

test("the actual weak-context effect defers changed weather and time until entry without cancelling preparation or losing the latest context",()=>{
  assert.ok(learningContextEffect&&scoringOptionsFactory,"bind the actual context effect and shared scoring-options factory");
  assert.deepEqual(learningContextDependencies,["timeContext","weatherContext","bootPhase"],"each real context signal and entry completion must wake the effect");
  const compile=code=>new Function("context",`with(context){${ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText}}`);
  for(const visibleCount of [0,12]){
    const h=startupHarness(),c=h.context,update=c.recommendationUpdateRef.current;let hour=10;
    const contextCalls=[],request=c.requestRecommendationUpdate;
    Object.assign(c,{learningContextRef:{current:""},weatherContext:"unknown",timeContext:"10:00",
      weatherSnapshotRef:{current:{text:"",at:0,revision:0}},Date:class{getHours(){return hour;}}});
    c.requestRecommendationUpdate=trigger=>{contextCalls.push(trigger);return request(trigger);};
    const run=compile(`const effect=${learningContextEffect};effect();`);
    run(c);assert.equal(c.learningContextRef.current,"morning|unknown");assert.deepEqual(contextCalls,[]);
    c.requestRecommendationUpdate("initial");h.run();
    c.recommendationVisibleRef.current={matched:Array(visibleCount).fill({}),frontier:Array(visibleCount).fill({})};
    const initialRevision=update.revision,initialLatest=update.latest,initialTimer=update.timer;
    c.weatherContext="Clear · 18°C";c.weatherSnapshotRef.current={text:c.weatherContext,at:1,revision:1};run(c);
    hour=15;c.timeContext="15:00";c.weatherContext="Rain · 11°C";c.weatherSnapshotRef.current={text:c.weatherContext,at:2,revision:2};run(c);run(c);
    c.bootPhase="leaving";run(c);
    assert.equal(c.learningContextRef.current,"morning|unknown","boot must retain the last applied key, not silently acknowledge deferred changes");
    assert.equal(update.revision,initialRevision);assert.strictEqual(update.latest,initialLatest);assert.equal(update.timer,initialTimer);
    assert.equal(h.timers.length,1);assert.equal(h.timers[0].cancelled,false);assert.equal(h.runs.length,0);
    assert.deepEqual(contextCalls,["initial","startup_ready"],`visible count ${visibleCount}: weak context cannot queue a second catalogue`);
    assert.equal(c.weatherSnapshotRef.current.text,"Rain · 11°C","real context continues updating while preparation is protected");
    let scoreHour=hour;
    const scoreMemory=intelligence.createEmptyListeningMemory();
    const scoreContext={activeQQTrackLiveRef:{current:null},libraryFeatures:[],memory:scoreMemory,
      profile:{...intelligence.deriveListeningProfile(scoreMemory,1000),meaningfulSignalCount:1},library:[],
      prepareScoringEvidence:intelligence.prepareScoringEvidence,scoringEvidence:undefined,
      Date:class{static now(){return 1000;}getHours(){return scoreHour;}},weatherSnapshotRef:{current:{...c.weatherSnapshotRef.current}},weatherContext:"Clear · 18°C"};
    const factoryJS=ts.transpileModule(`const factory=${scoringOptionsFactory};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
    const scoreOptions=new Function("context",`with(context){${factoryJS};return factory;}`)(scoreContext);
    const options=scoreOptions();
    assert.equal(options.weather,"Rain · 11°C","the shared warm-preview/final scoring factory reads the latest real snapshot, not a stale closed-over render");
    assert.equal(options.timeBucket,"day");
    scoreHour=20;scoreContext.weatherSnapshotRef.current={text:"Cloudy · 16°C",at:3,revision:3};
    const laterOptions=scoreOptions();assert.equal(laterOptions.timeBucket,"evening");assert.equal(laterOptions.weather,"Cloudy · 16°C");
    // The real initial catalogue can finish without a weak-context cancellation.
    h.timers[0].callback();assert.equal(h.runs.length,1);
    c.recommendationVisibleRef.current={matched:Array(12).fill({}),frontier:Array(12).fill({})};
    c.bootPhase="done";run(c);run(c);run(c);
    assert.equal(c.learningContextRef.current,"day|Rain · 11°C");assert.equal(update.revision,initialRevision+1);
    assert.deepEqual(contextCalls,["initial","startup_ready","context_changed"]);assert.equal(h.timers.length,2);
    assert.equal(h.timers[1].cancelled,false);assert.equal(h.timers[1].delay,240);
    h.timers[1].callback();assert.equal(h.runs.length,2);assert.deepEqual(h.runs[1][2],["context_changed"]);
    run(c);assert.equal(h.timers.length,2,"the same latest key cannot rerun after the deferred event was applied");
  }
});

test("deferring startup weak context leaves explicit feedback and library updates immediate",()=>{
  const h=startupHarness(),c=h.context,update=c.recommendationUpdateRef.current;
  update.startupReady=true;c.recommendationVisibleRef.current={matched:Array(12).fill({}),frontier:Array(12).fill({})};
  Object.assign(c,{learningContextRef:{current:"morning|unknown"},weatherContext:"Cloudy · 20°C",timeContext:"15:00",Date:class{getHours(){return 15;}}});
  const js=ts.transpileModule(`const effect=${learningContextEffect};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const run=new Function("context",`with(context){${js};return effect;}`)(c);
  run();assert.equal(update.revision,0);assert.equal(h.timers.length,0);
  for(const trigger of ["feedback","qq_library_synced"])c.requestRecommendationUpdate(trigger);
  assert.equal(update.revision,2);assert.equal(h.timers.length,2);assert.equal(h.timers[0].cancelled,true);
  assert.equal(h.timers[1].cancelled,false);assert.deepEqual([...update.triggers],["feedback","qq_library_synced"]);
  run();assert.equal(update.revision,2);assert.equal(c.learningContextRef.current,"morning|unknown");
  h.timers[1].callback();assert.deepEqual(h.runs[0][2],["feedback","qq_library_synced"]);
});

function reconnectHarness(libraryOutcome,{authorized=true,startupReady=true}={}) {
  const h=startupHarness(),c=h.context,calls=[],storage=new Map();
  const matched=Array.from({length:12},(_,i)=>({id:`kept-match-${i}`})),frontier=Array.from({length:11},(_,i)=>({id:`kept-frontier-${i}`}));
  c.recommendationVisibleRef.current={matched,frontier};c.recommendationUpdateRef.current.startupReady=startupReady;
  c.bootRetryRef={current:3};c.qqConnection="needs-auth";
  Object.assign(c,{artistTasteHints:[],playlistTasteHints:[],qqTasteSnapshotRef:{current:null},tasteTagWeightsRef:{current:{}},
    notifySystem(){},setToast(){},setQQPlaybackReady(){},setImportState(){},setOnboardingQQSkipped(){},
    setQQConnection(value){c.qqConnection=value;},setTasteSyncing(value){c.tasteSyncing=value;},
    setQQTasteSnapshot(){},setTasteTagWeights(){},setQQSummary(){},
    setMatchedExperiments(){assert.fail("authorization recovery must not replace the displayed matched batch");},
    setVisibleExperiments(){assert.fail("authorization recovery must not replace the displayed frontier batch");},
    startQQTrack(){assert.fail("authorization recovery must not autoplay");},
  });
  c.window.localStorage={setItem(key,value){storage.set(key,value);}};
  const status={loggedIn:authorized,playbackReady:authorized,userId:"isolated-owner"};
  c.window.codioDesktop.qqMusic={
    async login(options){calls.push(["login",options]);return status;},async getStatus(){calls.push(["getStatus"]);return status;},
    library(options){calls.push(["library",options]);
      if(libraryOutcome==="failed")return Promise.reject(Error("isolated library failure"));
      if(libraryOutcome==="timeout")return new Promise(()=>{});
      return Promise.resolve({topArtists:[],playlistNames:[],playlists:[],tracks:[],likedCount:0});},
  };
  c.withTimeout=bind("withTimeout",c);c.syncQQTaste=bind("syncQQTaste",c);
  const connect=bind("connectQQMusic",c);
  return {...h,calls,connect,matched,frontier,storage};
}

for(const outcome of ["failed","timeout","ready"]){
  test(`successful actual QQ authorization queues one source retry after a ${outcome} library attempt without replacing the existing 23`,async()=>{
    const h=reconnectHarness(outcome);
    const pending=h.connect(true);await microtasks();
    if(outcome==="timeout"){
      assert.equal(h.context.tasteSyncing,true);assert.equal(h.runs.length,0);
      assert.equal(h.timers.filter(timer=>timer.delay===240&&!timer.cancelled).length,0,"source retry waits for the bounded library attempt to settle");
      const timeout=h.timers.find(timer=>timer.delay===10000&&!timer.cancelled);assert.ok(timeout,"exercise the real production library deadline");timeout.callback();
    }
    await pending;await microtasks();
    assert.equal(h.context.qqConnection,"connected");assert.equal(h.context.tasteSyncing,false);
    assert.equal(h.context.bootRetryRef.current,0,"new verified authorization restores a fresh bounded retry budget");
    assert.deepEqual(h.calls,[ ["login",{forceAuthorization:true}],["library",{force:true}] ]);
    assert.strictEqual(h.context.recommendationVisibleRef.current.matched,h.matched);assert.strictEqual(h.context.recommendationVisibleRef.current.frontier,h.frontier);
    assert.equal(h.context.recommendationVisibleRef.current.matched.length+h.context.recommendationVisibleRef.current.frontier.length,23);
    const queued=h.timers.filter(timer=>timer.delay===240&&!timer.cancelled);
    assert.equal(queued.length,1,"library success and source recovery must coalesce into one actual rerank");
    queued[0].callback();assert.equal(h.runs.length,1);
    assert.equal(h.runs[0][2].filter(trigger=>trigger==="playback_retry").length,1);
    assert.equal(h.runs[0][2].includes("qq_library_synced"),outcome==="ready");
  });
}

test("rejected actual QQ authorization cannot reset retry budget, sync the library or queue source recovery",async()=>{
  const h=reconnectHarness("ready",{authorized:false});await h.connect(true);await microtasks();
  assert.equal(h.context.qqConnection,"needs-auth");assert.equal(h.context.bootRetryRef.current,3);
  assert.deepEqual(h.calls,[["login",{forceAuthorization:true}]]);assert.equal(h.runs.length,0);
  assert.equal(h.timers.filter(timer=>timer.delay===240&&!timer.cancelled).length,0);
  assert.equal(h.context.recommendationUpdateRef.current.triggers.size,0);
});

test("ordinary startup connection keeps initial/library/source work behind the existing one-shot readiness barrier",async()=>{
  const h=reconnectHarness("ready",{startupReady:false}),update=h.context.recommendationUpdateRef.current;
  h.context.requestRecommendationUpdate("initial");await h.connect(false);await microtasks();
  assert.deepEqual(h.calls,[["getStatus"],["library",{force:false}]]);
  assert.equal(update.startupReady,false);assert.equal(update.timer,null);assert.equal(h.runs.length,0);
  assert.equal(h.timers.filter(timer=>timer.delay===240&&!timer.cancelled).length,0);
  h.run();assert.equal(update.startupReady,true);
  const queued=h.timers.filter(timer=>timer.delay===240&&!timer.cancelled);assert.equal(queued.length,1);
  queued[0].callback();assert.equal(h.runs.length,1);assert.ok(h.runs[0][2].includes("initial"));assert.ok(h.runs[0][2].includes("qq_library_synced"));
});

test("QQ library completion after the UI deadline still publishes evidence and queues a real fill without touching visible cards", async () => {
  const h=reconnectHarness("ready");let complete;
  h.context.window.codioDesktop.qqMusic.library=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.connect(true);await microtasks();
  const deadline=h.timers.find(timer=>timer.delay===10000&&!timer.cancelled);assert.ok(deadline);deadline.callback();
  await pending;assert.equal(h.context.qqConnection,"connected");assert.equal(h.context.qqTasteSnapshotRef.current,null);
  const snapshot={topArtists:[],playlistNames:[],playlists:[],tracks:[{mid:"late-known-track"}],likedCount:0};
  complete(snapshot);await microtasks();
  assert.equal(h.context.qqTasteSnapshotRef.current,snapshot);
  assert.ok(h.context.recommendationUpdateRef.current.triggers.has("qq_library_synced"));
  const queued=h.timers.filter(timer=>timer.delay===240&&!timer.cancelled);assert.equal(queued.length,1);
  queued[0].callback();assert.equal(h.runs.length,1);assert.ok(h.runs[0][2].includes("qq_library_synced"));
  assert.equal(h.context.recommendationVisibleRef.current.matched,h.matched);assert.equal(h.context.recommendationVisibleRef.current.frontier,h.frontier);
});

test("a late library result from an older account/sync cannot overwrite newer evidence", async () => {
  for(const newer of ["sync","authorization"]){
    const h=reconnectHarness("ready");let complete;
    h.context.window.codioDesktop.qqMusic.library=()=>new Promise(resolve=>{complete=resolve;});
    const pending=h.connect(true);await microtasks();h.timers.find(timer=>timer.delay===10000&&!timer.cancelled).callback();await pending;
    const revision=h.context.recommendationUpdateRef.current.revision;
    if(newer==="sync")h.context.qqSyncRevisionRef.current++;else h.context.qqAuthorizationRevisionRef.current++;
    complete({topArtists:[],playlistNames:[],playlists:[],tracks:[{mid:"stale-track"}],likedCount:0});await microtasks();
    assert.equal(h.context.qqTasteSnapshotRef.current,null);assert.equal(h.context.recommendationUpdateRef.current.revision,revision);
  }
});

test("an older pending source authorization rejection cannot overwrite a newer successful QQ authorization",async()=>{
  const h=reconnectHarness("failed"),c=h.context;let resolveOld;
  c.qqConnection="connected";c.qqPlaybackReady=true;
  Object.assign(c,{Date,PREPARED_TRACK_TTL_MS:180000,preparedTracksRef:{current:new Map()},failedTracksRef:{current:new Map()},
    preparedDeckTrackRef:{current:""},discardPreparedEntry(){},resolveTrackCover:async()=>"",
    createPreparedAudio(){assert.fail("URL-only source validation must not create playback media");},
    setBoundedCache(cache,key,value){cache.set(key,value);},setQQPlaybackReady(value){c.qqPlaybackReady=value;},
  });
  c.window.codioDesktop.qqMusic.play=()=>new Promise(resolve=>{resolveOld=resolve;});
  const track={provider:"qq",id:"oldSource",mid:"oldSource",title:"Isolated old request",artist:"Isolated artist",durationSeconds:240};
  const older=bind("prepareTrack",c)(track,false);await microtasks();assert.ok(resolveOld);
  // Another concurrent startup source has already requested reconnection.
  c.qqConnection="needs-auth";c.qqPlaybackReady=false;
  await h.connect(true);
  assert.equal(c.qqConnection,"connected");assert.equal(c.qqPlaybackReady,true);
  resolveOld({playable:false,requiresLogin:true,failureKind:"AUTHORIZATION_REQUIRED"});await older;
  assert.equal(c.qqConnection,"connected","old-account/source work must not demote a newer verified authorization");
  assert.equal(c.qqPlaybackReady,true,"a stale request cannot remove the new playback capability");
  assert.equal(c.preparedTracksRef.current.has(track.mid),false,"a stale failed source is discarded, not cached as prepared");
});

test("same-identity preparation after successful authorization starts a new request instead of sharing the old pending source",async()=>{
  const h=reconnectHarness("failed"),c=h.context;let resolveOld,calls=0,discarded=0;
  c.qqConnection="connected";c.qqPlaybackReady=true;
  Object.assign(c,{Date,PREPARED_TRACK_TTL_MS:180000,preparedTracksRef:{current:new Map()},failedTracksRef:{current:new Map()},
    preparedDeckTrackRef:{current:""},discardPreparedEntry(){discarded++;},resolveTrackCover:async()=>"",
    createPreparedAudio(){assert.fail("recovery preparation must remain URL-only");},
    setBoundedCache(cache,key,value){cache.set(key,value);},setQQPlaybackReady(value){c.qqPlaybackReady=value;},
  });
  c.window.codioDesktop.qqMusic.play=()=>{calls++;return calls===1?new Promise(resolve=>{resolveOld=resolve;}):
    Promise.resolve({playable:true,url:"isolated:new-authorized-source",expiresAt:Date.now()+1800000});};
  const track={provider:"qq",id:"sameSource",mid:"sameSource",title:"Isolated same identity",artist:"Isolated artist",durationSeconds:240};
  const prepare=bind("prepareTrack",c),older=prepare(track,false);await microtasks();assert.equal(calls,1);
  await h.connect(true);assert.equal(c.qqAuthorizationRevisionRef.current,1);
  const newer=prepare(track,false);assert.notStrictEqual(newer,older,"a new authorization epoch cannot reuse the old pending promise");
  const prepared=await newer;assert.equal(calls,2);assert.equal(discarded,1);assert.equal(prepared.playback.playable,true);
  const currentEntry=c.preparedTracksRef.current.get(track.mid);assert.strictEqual(currentEntry.promise,newer);
  await h.connect(true);assert.equal(c.qqAuthorizationRevisionRef.current,2);
  assert.strictEqual(await prepare(track,false),prepared,"a succeeded, unexpired ticket survives later authorization without another source request");
  assert.equal(calls,2);assert.equal(discarded,1);
  resolveOld({playable:false,requiresLogin:true,failureKind:"AUTHORIZATION_REQUIRED"});assert.equal(await older,null);
  assert.strictEqual(c.preparedTracksRef.current.get(track.mid),currentEntry,"an old failed completion cannot remove a newer verified preparation");
  assert.equal(c.qqConnection,"connected");assert.equal(c.qqPlaybackReady,true);assert.equal(c.failedTracksRef.current.size,0);
});

test("production preparation progress counts real internal tasks and verified sources without timer growth",()=>{
  const progress=bind("bootPreparationProgress",{}),state={assetCompleted:0,memoryHydrated:false,layoutReady:false,animationDone:false,ready:false,
    onboardingChecked:false,aiStatusChecked:false,qqConnection:"checking",librarySettled:false,preparedSources:0};
  assert.deepEqual(progress(state),{value:0,maximum:34});
  for(let completed=1;completed<=3;completed++){
    state.assetCompleted=completed;assert.equal(progress(state).value,completed);
  }
  state.memoryHydrated=true;assert.equal(progress(state).value,4);
  state.animationDone=true;assert.equal(progress(state).value,5);
  state.onboardingChecked=true;assert.equal(progress(state).value,6);
  state.aiStatusChecked=true;assert.equal(progress(state).value,7);
  state.layoutReady=true;assert.equal(progress(state).value,8);
  state.qqConnection="connected";assert.equal(progress(state).value,9);
  state.librarySettled=true;assert.equal(progress(state).value,10);
  for(const preparedSources of [0,1,12,23,24]){
    state.preparedSources=preparedSources;assert.deepEqual(progress(state),{value:Math.min(33,10+preparedSources),maximum:34});
  }
  assert.equal(progress({...state,ready:true}).value,34,"the full task set still waits for actual source, cover and DOM readiness");
  assert.equal(progress({...state,assetCompleted:90,preparedSources:90,ready:true}).value,34);
  for(const assetCompleted of [-5,NaN,Infinity])assert.equal(progress({...state,assetCompleted,ready:true}).value,31);
  for(const preparedSources of [-5,NaN,Infinity])assert.equal(progress({...state,preparedSources,ready:true}).value,10);
  assert.equal(progress({...state,preparedSources:1.9,ready:true}).value,11);
  assert.equal(progress({...state,assetCompleted:0,layoutReady:false,preparedSources:0,ready:true}).value,6,"a ready flag cannot manufacture unfinished internal work");
  for(let render=0;render<100;render++)assert.deepEqual(progress({...state}),{value:33,maximum:34},"elapsed time and rerenders add no units");
  for(const qqConnection of ["needs-auth","unavailable"]){
    assert.deepEqual(progress({...state,qqConnection}),{value:8,maximum:9});
    assert.deepEqual(progress({...state,qqConnection,ready:true}),{value:9,maximum:9});
    assert.equal(progress({...state,qqConnection,layoutReady:false,ready:true}).value,8,"settled disconnected users still need real local layout");
  }
  assert.equal(progress({...state,qqConnection:"error",preparedSources:0}).maximum,34,"a failed check cannot shrink the work into an offline-ready station");
});

test("actual accessible progress and linear fill report internal work and source completion",async()=>{
  assert.ok(bootProgressInitializer&&bootProgressElement,"bind the production initializer and JSX, not a duplicate fixture formula");
  const evaluate=code=>new Function("context",`with(context){${ts.transpileModule(`const result=${code};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}}).outputText};return result;}`);
  const context={bootPreparationProgress:bind("bootPreparationProgress",{}),bootAssetCompleted:0,
    listeningMemoryHydratedRef:{current:false},bootLayoutReady:false,bootAnimationDone:false,bootReady:false,
    onboardingChecked:false,aiStatusChecked:false,qqConnection:"checking",tasteSyncing:true,qqSyncRevisionRef:{current:0},bootPreparedSources:new Set(),
    React:{createElement:(type,props,...children)=>({type,props,children})},
  };
  const initializer=evaluate(bootProgressInitializer),element=evaluate(bootProgressElement);
  const render=()=>{context.bootProgress=initializer(context);return element(context);};
  let native=render();assert.equal(native.type,"div");assert.equal(native.props.role,"progressbar");
  assert.equal(native.props["aria-valuemin"],0);assert.equal(native.props["aria-valuemax"],34);assert.equal(native.props["aria-valuenow"],0);
  assert.equal(native.children[0].props.style.transform,"scaleX(0)");assert.equal(native.children[0].props["aria-hidden"],"true");
  context.bootAssetCompleted=3;context.listeningMemoryHydratedRef.current=true;context.bootAnimationDone=true;
  context.onboardingChecked=true;context.aiStatusChecked=true;
  native=render();assert.equal(native.props["aria-valuenow"],7);assert.equal(native.children[0].props.style.transform,`scaleX(${7/34})`);
  context.qqConnection="connected";assert.equal(render().props["aria-valuenow"],8);
  context.tasteSyncing=false;assert.equal(render().props["aria-valuenow"],8,"a non-running library alone cannot claim a real completed library attempt");
  context.qqSyncRevisionRef.current=1;assert.equal(render().props["aria-valuenow"],9);
  for(let index=0;index<24;index++){
    context.bootPreparedSources.add(`qq:source${index}`);assert.equal(render().props["aria-valuenow"],10+index);
    context.bootPreparedSources.add(`qq:source${index}`);assert.equal(render().props["aria-valuenow"],10+index,"the same source cannot count twice");
  }
  context.bootLayoutReady=true;assert.equal(render().props["aria-valuenow"],33);
  context.bootReady=true;native=render();assert.equal(native.props["aria-valuenow"],34);assert.equal(native.children[0].props.style.transform,"scaleX(1)");
  context.bootPreparedSources.delete("qq:source23");assert.equal(render().props["aria-valuenow"],33,"even a stale ready flag cannot grant a missing source unit");
  context.qqConnection="needs-auth";native=render();assert.equal(native.props["aria-valuemax"],9);assert.equal(native.props["aria-valuenow"],9);
  context.bootAssetCompleted=1;assert.equal(render().props["aria-valuenow"],7,"disconnected local readiness also remains completion-based");
  const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8"),fill=css.match(/\.boot-progress-fill\s*\{([^}]*)\}/)?.[1];
  assert.match(fill||"",/transform-origin\s*:\s*left/);assert.match(fill||"",/transition\s*:\s*transform\s+\.4s\s+linear/);
  assert.match(css,/\.reduced-motion\s+\*[^}]*transition-duration\s*:\s*\.001ms!important/);
});

test("actual warm source completion publishes visible identities individually while cold progress uses the committed visible batch",()=>{
  assert.ok(warmSourceProgressBranch&&coldSourceProgressBranch,"exercise the actual production progress publication branches");
  const compile=code=>new Function("context",`with(context){${ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText}}`);
  const updates=[],context={bootPhase:"playing",useStartupSnapshot:true,restored:{visible:["qq:visible1","qq:visible2"]},track:{mid:"visible1"},shown:[],
    recommendationIdentity:track=>`qq:${track.mid}`,setBootPreparedSources(update){context.sources=update(context.sources);updates.push([...context.sources]);},sources:new Set()};
  const warm=compile(warmSourceProgressBranch),cold=compile(coldSourceProgressBranch);
  warm(context);assert.deepEqual(updates,[["qq:visible1"]]);
  context.track={mid:"hidden"};warm(context);assert.equal(updates.length,1,"a verified hidden backup does not claim a visible source unit");
  context.track={mid:"visible2"};warm(context);assert.deepEqual(updates.at(-1),["qq:visible1","qq:visible2"]);
  context.track={mid:"visible1"};warm(context);assert.equal(context.sources.size,2,"cross-render duplicate completion remains one identity");
  context.useStartupSnapshot=false;warm(context);assert.equal(updates.length,3);
  context.shown=[{mid:"visible2"},{mid:"coldCommitted"}];cold(context);assert.deepEqual([...context.sources],["qq:visible1","qq:visible2","qq:coldCommitted"]);
  context.bootPhase="done";context.track={mid:"visible3"};context.shown=[{mid:"afterEntry"}];warm(context);cold(context);
  assert.equal(context.sources.size,3,"after-entry work does not change preparation progress");
});

test("metadata scheduler is genuinely bounded and late IPC results remain retryable", async () => {
  const h = metadataHarness();
  const tracks = Array.from({ length: 12 }, (_, index) => ({ mid: `id${index}`, title: `QA ${index}`, artist: `QA Artist ${index}`, genres: [] }));
  const first = Promise.all(tracks.map(track=>h.enrich(track)));
  await h.clock.advance(20_000);
  const enriched = await first;
  assert.equal(h.maxActive(), 2, "the production main scheduler permits only two actual provider requests");
  assert.equal(h.requests.length, 12, "read-only requests are completed instead of silently fabricating genres");
  assert.ok(h.requests.every(request => request.timeoutMs === 3500));
  const recovered = Promise.all(tracks.map(track=>h.enrich(track))); await h.clock.advance(40_000);
  assert.ok((await recovered).every(track => track.genres.includes("Neo-Soul")), "late successful metadata is reused on a subsequent enrichment, not lost forever");
  assert.equal(h.requests.length, 12, "successful same-ID provider metadata is not fetched twice");
  // This exposes the pre-fix mismatch without treating synthetic Neo-Soul as a
  // claim about real songs. A follow-up assertion demands first-pass preservation.
  assert.ok(enriched.every(track => track.mid && track.artist));
});

test("valid metadata taking less than the provider deadline must not be discarded during first startup", async () => {
  const h = metadataHarness();
  const first = Promise.all(Array.from({ length: 12 }, (_, index) => h.enrich({ mid: `slow${index}`, title: `QA ${index}`, artist: `QA Artist ${index}`, genres: [] })));
  await h.clock.advance(30_000);
  const enriched = await first;
  assert.equal(enriched.filter(track => track.genres.includes("Neo-Soul")).length, 12,
    "First-pass startup currently times out renderer enrichment before queued/3s provider metadata is ready; don't weaken lane gates to compensate.");
});

test("the same song requested by both lanes shares one renderer IPC and releases pending state", async () => {
  const h = metadataHarness();
  const track = { mid: "shared", title: "QA shared", artist: "QA artist", genres: [] };
  const first = h.enrich(track), second = h.enrich({ ...track });
  await h.clock.advance(10_000);
  assert.ok((await first).genres.includes("Neo-Soul")); assert.ok((await second).genres.includes("Neo-Soul"));
  assert.equal(h.ipcCalls(), 1, "provider single-flight alone is not renderer IPC single-flight");
  assert.equal(h.renderer.metadataEnrichmentRef.current.pending.size, 0);
  assert.equal(h.renderer.metadataEnrichmentRef.current.active, 0);
});

test("queued enrichment does not start new IPC after unmount", async () => {
  const h = metadataHarness();
  const calls = Array.from({ length: 8 }, (_, index) => h.enrich({ mid: `exit${index}`, title: "QA", artist: "QA", genres: [] }));
  await microtasks(); assert.equal(h.requests.length, 2);
  h.renderer.analysisLifecycleRef.current.mounted = false;
  await h.clock.advance(30_000); await Promise.all(calls);
  assert.equal(h.requests.length, 2, "discard queued obsolete work instead of flooding the next renderer session");
  assert.equal(h.renderer.metadataEnrichmentRef.current.pending.size, 0);
  assert.equal(h.renderer.metadataEnrichmentRef.current.active, 0);
});

test("unknown, mismatched identity and unverified-source metadata stay unknown", async () => {
  for (const result of [null, { ok: false },
    { ok: true, mid: "different", source: "provider_metadata", genres: ["Neo-Soul"] },
    { ok: true, mid: "unknown", source: "artist_hint", genres: ["Neo-Soul"] },
    { ok: true, mid: "unknown", source: "provider_metadata", genres: [] }]) {
    const h = metadataHarness(), original = { mid: "unknown", title: "QA", artist: "QA", genres: [] };
    h.renderer.window.codioDesktop.qqMusic.metadata = async () => result;
    const pending = h.enrich(original); await h.clock.advance(10_000);
    assert.deepEqual((await pending).genres, [], "do not infer tags to force the initial 24-card gate open");
    assert.equal(h.renderer.metadataEnrichmentRef.current.pending.size, 0);
  }
});

test("the actual lane begin call retries playback without advancing acquisition or changing either visible batch", () => {
  assert.equal(laneBeginCalls.length, 1, "bind the real renderer cursor condition rather than reimplement it in the fixture");
  const run = new Function("context", `with(context){return ${laneBeginCalls[0]};}`);
  for (const lane of ["match", "frontier"]) {
    const pools = Object.fromEntries(["match", "frontier"].map(name => [name, {
      lane: name, cursor: name === "match" ? 8 : 5, revision: 2, profileVersion: 40, status: "failed", error: "SOURCE_UNAVAILABLE",
      candidates: [], visible: [`qq:${name}-visible`], hidden: [`qq:${name}-hidden`], exposure: [`qq:${name}-exposed`],
    }]));
    const before = JSON.stringify(pools), current = pools[lane];
    const context = { pools, lane, profileVersion: 41, trigger: "feedback", triggers: ["playback_retry"] };
    context.beginRecommendationPoolUpdate = bind("beginRecommendationPoolUpdate", context);
    const result = run(context);
    assert.equal(result.pool.cursor, current.cursor); assert.equal(result.request.cursor, current.cursor);
    assert.equal(result.pool.revision, current.revision + 1); assert.equal(result.pool.profileVersion, 41);
    assert.equal(result.pool.status, "pending"); assert.equal(result.pool.error, null);
    assert.strictEqual(result.pool.visible, current.visible); assert.strictEqual(result.pool.hidden, current.hidden);
    assert.strictEqual(result.pool.exposure, current.exposure); assert.equal(JSON.stringify(pools), before,
      "source retry must not clear exposures, rewrite the displayed songs or mutate the other pool");
    for (const request of [{ trigger: "feedback", triggers: ["continuation"] }, { trigger: "manual", triggers: ["manual"] }]) {
      Object.assign(context, request); const advanced = run(context);
      assert.equal(advanced.pool.cursor, current.cursor + 1, "real acquisition continuation and manual refresh still advance their own cursor");
      assert.equal(JSON.stringify(pools), before);
    }
  }
});

test("actual source authorization rejection restores reconnect state without blacklisting music or creating audio", async () => {
  for (const eager of [false, true]) {
    let calls = 0, audioCreated = 0, failedMarks = 0;
    const state = { connection: "connected", ready: true }, updates = [];
    const failures = new Map([["other-known-failure", 12345]]);
    const track = { provider: "qq", mid: "authorization-fixture", id: "authorization-fixture", title: "Isolated track", artist: "Isolated artist", cover: "", durationSeconds: 240 };
    const context = {
      Date, PREPARED_TRACK_TTL_MS: 180000, preparedTracksRef: { current: new Map() }, failedTracksRef: { current: failures },
      bootPhaseRef: { current: "done" },
      preparedDeckTrackRef: { current: "" }, discardPreparedEntry() {}, resolveTrackCover: async () => "isolated-cover",
      withTimeout: promise => promise, createPreparedAudio(url) { audioCreated++; return { src: url, paused: true }; },
      setBoundedCache(cache, key, value) { failedMarks++; cache.set(key, value); },
      setQQPlaybackReady(value) { state.ready = value; updates.push(["ready", value]); },
      setQQConnection(value) { state.connection = value; updates.push(["connection", value]); },
      window: { codioDesktop: { qqMusic: { async play() {
        calls++; return calls === 1 ? { playable: false, requiresLogin: true, failureKind: "AUTH_REQUIRED" }
          : { playable: true, url: "isolated:authorized-source", expiresAt: Date.now() + 30 * 60 * 1000 };
      } } } },
    };
    const prepare = bind("prepareTrack", context);
    assert.equal(await prepare(track, eager), null);
    assert.deepEqual(updates, [["ready", false], ["connection", "needs-auth"]]);
    assert.deepEqual(state, { connection: "needs-auth", ready: false });
    assert.equal(failedMarks, 0); assert.deepEqual([...failures], [["other-known-failure", 12345]],
      "an account rejection is not a negative music signal or a permanent track failure");
    assert.equal(audioCreated, 0); assert.equal(context.preparedTracksRef.current.has(track.mid), false);
    const recovered = await prepare(track, eager);
    assert.equal(recovered.playback.playable, true); assert.equal(calls, 2, "the same identity can be prepared after authorization without clearing data");
    assert.equal(audioCreated, eager ? 1 : 0); if (recovered.audio) assert.equal(recovered.audio.paused, true);
    assert.equal(failedMarks, 0); assert.equal(failures.has("other-known-failure"), true);
  }
});

test("actual explicit reconnect requests authorization while ordinary startup only checks the existing session", async () => {
  for (const explicit of [false, true]) {
    const calls = [], states = [], sourceSyncs = [];
    const context = {
      window: { codioDesktop: { qqMusic: {
        async getStatus(...args) { calls.push({ method: "getStatus", args }); return { loggedIn: true, playbackReady: true }; },
        async login(...args) { calls.push({ method: "login", args }); return { loggedIn: true, playbackReady: true }; },
      } }, localStorage: { setItem(key, value) { calls.push({ method: "persist-nonsensitive", args: [key, value] }); } } },
      withTimeout: promise => promise, notifySystem() {}, setQQConnection(value) { states.push(value); },
      setQQPlaybackReady() {}, setImportState() {}, setOnboardingQQSkipped() {}, syncQQTaste() { sourceSyncs.push("sync"); },
      bootRetryRef:{current:3},requestRecommendationUpdate(){},
    };
    await bind("connectQQMusic", context)(explicit);
    const providerCalls = calls.filter(call => ["getStatus", "login"].includes(call.method));
    assert.deepEqual(providerCalls, explicit ? [{ method: "login", args: [{ forceAuthorization: true }] }]
      : [{ method: "getStatus", args: [] }]);
    assert.deepEqual(states, [explicit ? "authorizing" : "checking", "connected"]); assert.deepEqual(sourceSyncs, ["sync"]);
    assert.equal(calls.some(call => call.args.some(value => typeof value === "string" && /secret|cookie|key/i.test(value))), false,
      "reconnect does not serialize credentials into renderer storage");
  }
});
