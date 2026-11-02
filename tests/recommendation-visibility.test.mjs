import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Execute actual renderer functions with isolated QQ/storage/timers.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlerNames = ["readStartupRecommendationSnapshot", "buildStartupRecommendationSnapshot", "recommendationIdentity", "recommendationArtistMatches", "updateListeningMemory", "requestRecommendationUpdate", "releaseStartupRecommendations", "enrichTrackMetadata", "featureVectorForTrack", "writeTrackPreference", "candidateForExperiment",
  "rememberExperiment", "recordCurrentPreference", "updateTonightIntent", "correctProfileHypothesis", "withdrawPreference", "refreshRecommendationLane", "refreshRecommendations", "recommendationQueueFor", "recommendationSourceForTrack", "syncQQTaste", "executeCodioTool", "waitForRecommendationUpdate"];
const declarations = new Map();
let memoryEffect, startupReleaseEffect;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && handlerNames.includes(node.name.text)) declarations.set(node.name.text, node.getText(ast));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && handlerNames.includes(node.name.text)) declarations.set(node.name.text, `const ${node.getText(ast)};`);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[1]?.getText(ast) === "[listeningMemory]") {
    if (node.arguments[0].getText(ast).includes("setLikedTracks")) memoryEffect = node.arguments[0].getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[0]?.getText(ast).includes("Do not start a cold catalogue scan")) startupReleaseEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of handlerNames) assert.ok(declarations.has(name), name);
assert.ok(startupReleaseEffect, "actual QQ/library startup barrier");
const transpile = (code, module = ts.ModuleKind.None) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module } }).outputText;
const bindHandlers = new Function("context", `with(context){${transpile(handlerNames.map(name=>declarations.get(name)).join("\n") + "\nconst hydratePreferences=" + memoryEffect + ";\nconst releaseStartupEffect=" + startupReleaseEffect + ";")} return {${handlerNames.join(",")},hydratePreferences,releaseStartupEffect};}`);
const intelligence = await import(`data:text/javascript;base64,${Buffer.from(transpile(await readFile(new URL("../app/listening-intelligence.ts",import.meta.url),"utf8"),ts.ModuleKind.ES2022)).toString("base64")}`);
const agent = await import(`data:text/javascript;base64,${Buffer.from(transpile(await readFile(new URL("../app/codio-agent.ts",import.meta.url),"utf8"),ts.ModuleKind.ES2022)).toString("base64")}`);
const identity = item => item.mid || item.id ? intelligence.canonicalTrackKey(item.provider || "qq", item.mid || item.id) : `${item.title.trim().toLowerCase()}::${item.artist.trim().toLowerCase()}`;
const fixtures = Array.from({length:72},(_,index)=>({title:`Track ${index}`,artist:`Artist ${index}`,reason:"Test candidate",color:"blue",cover:"",tags:[`tag-${index%8}`],energy:.3,novelty:.2,night:.5}));
const qqTrack = item => ({provider:"qq",id:item.title,mid:item.title,title:item.title,artist:item.artist,durationSeconds:240,cover:""});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function retainedEvidenceMemory() {
  const memory=intelligence.createEmptyListeningMemory(),now=Date.now();
  const layer={tagAffinities:{"genre:neo-soul":.8,"genre:pop":.7},artistAffinities:{"known artist":.8},evidenceCount:2,distinctTrackCount:2};
  const features={provider:"qq",trackId:"Known retained",artist:"Known Artist",tags:["genre:neo-soul","genre:pop"].map(value=>({value,source:"provider_metadata",confidence:.65,profileEligible:true})),
    bpm:{value:null,source:"audio_analysis",confidence:0,profileEligible:false},energy:{value:null,source:"audio_analysis",confidence:0,profileEligible:false},vocalFocus:{value:null,source:"audio_analysis",confidence:0,profileEligible:false},instrumentalFocus:{value:null,source:"audio_analysis",confidence:0,profileEligible:false},transitionFocus:{value:null,source:"audio_analysis",confidence:0,profileEligible:false},inLibrary:false,likedInProvider:false,artistFamiliarity:0,playlistMembership:[],playCount:1,novelty:{value:0,source:"library_behavior",confidence:.8,profileEligible:false},metadataConfidence:.95};
  memory.trackMemories["qq:Known retained"]={trackKey:"qq:Known retained",title:"Known retained",artist:"Known Artist",playCount:1,settledPlayCount:1,completionCount:1,replayCount:0,listenedSeconds:220,firstSeenAt:now,lastSeenAt:now,effectivePlayCount:1,features};
  memory.longTermAggregates["track:qq:Known retained"]={positive:.8,negative:0,evidenceCount:2,firstSeenAt:now,lastSeenAt:now,profile:{at:now,artist:"Known Artist",lifetime:layer,recent:layer,sessionId:"previous-session",session:{tagAffinities:{},artistAffinities:{},evidenceCount:0,distinctTrackCount:0},contexts:{},positiveTotal:.8,trackPositive:.8,trackNegative:0}};
  return memory;
}
function harness({unavailable=[],memory=retainedEvidenceMemory()}={}) {
  let matched=fixtures.slice(0,12),frontier=fixtures.slice(12,24),tracks=Object.fromEntries([...matched,...frontier].map(item=>[identity(item),qqTrack(item)]));
  let liked=new Set(),disliked=new Set(),likedExperiments=new Set(),listeningMemory=memory, memoryDirty=false;
  let resolutionGate,releaseResolution;
  const storage=new Map([["codio-recommendation-history",JSON.stringify([...matched,...frontier].map(identity))]]);
  const searchCalls=[],timers=[],visibleWrites=[],pendingRuns=[],bootTaskUpdates=[];
  const unavailableKeys=new Set(unavailable.map(item => identity(qqTrack(item))));
  const active=qqTrack(matched[0]);
  const context={
    crypto: { randomUUID: () => crypto.randomUUID() }, bootPhase: "done", bootPreparedSources: new Set(),
    setBootPreparedSources(next) { context.bootPreparedSources = typeof next === "function" ? next(context.bootPreparedSources) : next; },
    bootMusicTask:{match:"",frontier:""},
    setBootMusicTask(next){context.bootMusicTask=typeof next==="function"?next(context.bootMusicTask):next;bootTaskUpdates.push({...context.bootMusicTask});},
    onboardingChecked: true, qqConnection: "connected", tasteSyncing: false,
    ...intelligence,window:{localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
      codioDesktop:{qqMusic:{async getStatus(){return {loggedIn:true,playbackReady:true};},
        async metadata(mid){return {ok:true,mid,source:"provider_metadata",genres:[Number(mid.replace("Track ",""))<48?"neo-soul":"pop"]};},
        async search(query,page){searchCalls.push({query,page}); const items=context.experimentPool;
          return items.filter(item=>query==="neo-soul"?Number(item.title.replace("Track ",""))<48:query==="pop"?Number(item.title.replace("Track ",""))>=48:query===item.artist||query===`${item.title} ${item.artist}`).map(item=>context.discoveryTracksRef.current[identity(item)]||qqTrack(item));}}},
      setTimeout(callback,delay){timers.push({callback,delay,cancelled:false});return timers.length;},
      clearTimeout(id){if(timers[id-1])timers[id-1].cancelled=true;}},
    experimentPool:fixtures,artistTasteHints:[],playlistTasteHints:[],discoveryBridgeArtists:{adjacent:["Adjacent bridge"]},searchResults:[],
    qqSyncRevisionRef:{current:0},recommendationSessionRef:{current:1},
    setTasteSyncing(){},setQQTasteSnapshot(){},setTasteTagWeights(){},setQQSummary(){},coverFallback:"test:cover",
    discoveryPoolRef:{current:[]},discoveryTracksRef:{current:Object.fromEntries(fixtures.map(item=>[identity(item),qqTrack(item)]))},
    recommendationTracksRef:{current:tracks},recommendationCatalogRef:{current:[...fixtures]},recommendationRoundRef:{current:0},
    recommendationScoresRef:{current:new Map()},recommendationUpdateRef:{current:{revision:0,timer:null,startupReady:true,triggers:new Set(),latest:{},records:[]}},
    recommendationAudioRef:{current:new Map()},setBoundedCache(cache,key,value,limit){cache.set(key,value);while(cache.size>limit)cache.delete(cache.keys().next().value);},
    metadataEnrichmentRef:{current:{active:0,waiters:[],pending:new Map()}},analysisLifecycleRef:{current:{mounted:true,generation:1}},
    recommendationVisibleRef:{current:{matched,frontier}},recommendationRefreshRef:{current:null},manualQueueIdsRef:{current:new Set()},
    recommendationPoolsRef:{current:{match:{...intelligence.createRecommendationPool("match"),visible:matched.map(identity)},frontier:{...intelligence.createRecommendationPool("frontier"),visible:frontier.map(identity)}}},
    bufferedSourcesRef:{current:new Map()},audioElementsRef:{current:new Map()},
    activeTransitionRef:{current:null},seamlessTransitionRef:{current:false},
    listeningMemoryRef:{current:memory},listeningMemoryHydratedRef:{current:true},dislikeAdvanceTrackRef:{current:""},
    tasteTagWeightsRef:{current:{}},qqTasteSnapshotRef:{current:null},trackAnalysisRef:{current:new Map()},failedTracksRef:{current:new Map()},
    playQueueRef:{current:[...matched,...frontier].map(qqTrack)},activeQueueIndexRef:{current:0},activeQQTrack:active,activeQQTrackLiveRef:{current:active},
    currentTrack:{...active,bpm:96},currentPreferenceKey:intelligence.canonicalTrackKey("qq",active.mid),weatherContext:"Clear · 18°C",timeContext:"22:00",
    weatherSnapshotRef:{current:{text:"Clear · 18°C",at:0,revision:0}},
    get likedExperiments(){return likedExperiments;}, get listeningMemory(){return listeningMemory;},
    get matchedExperiments(){return matched;},get visibleExperiments(){return frontier;},
    get recommendationTracks(){return tracks;},
    setMatchedExperiments(next){matched=next;context.recommendationVisibleRef.current={matched,frontier};context.recommendationPoolsRef.current.match.visible=matched.map(identity);visibleWrites.push("matched");},
    setVisibleExperiments(next){frontier=next;context.recommendationVisibleRef.current={matched,frontier};context.recommendationPoolsRef.current.frontier.visible=frontier.map(identity);visibleWrites.push("frontier");},
    setRecommendationTracks(next){tracks=typeof next==="function"?next(tracks):next;},
    setLikedTracks(next){liked=typeof next==="function"?next(liked):next;},setDislikedTracks(next){disliked=typeof next==="function"?next(disliked):next;},
    setLikedExperiments(next){likedExperiments=typeof next==="function"?next(likedExperiments):next;},
    setListeningMemory(next){listeningMemory=next;memoryDirty=true;},setPlayQueue(next){context.playQueueRef.current=next;},
    setActiveQueueIndex(){},setRecommendationLoading(){},setToast(){},notifySystem(){},
    settleCurrentListening(){},prepareUpcomingTrack(){},async nextTrack(){},
    async prepareTrack(track){if(resolutionGate)await resolutionGate;return unavailableKeys.has(identity(track))?null:{coverData:`test:${track.mid}`};},
    withTimeout:promise=>promise,
  };
  const handlers=bindHandlers(context);
  context.recommendationRefreshRef.current=(...args)=>{const promise=handlers.refreshRecommendations(...args);pendingRuns.push(promise);return promise;};
  return {handlers:{...handlers,resolveCatalog(){handlers.requestRecommendationUpdate("initial");}},context,searchCalls,storage,timers,visibleWrites,bootTaskUpdates,
    shown:()=>({matched,frontier}),catalog:()=>context.recommendationCatalogRef.current,memory:()=>context.listeningMemoryRef.current,preferences:()=>({liked,disliked,likedExperiments}),
    makeUnavailable(items){items.forEach(item=>unavailableKeys.add(identity(qqTrack(item))));},
    runEffects(){if(memoryDirty){memoryDirty=false;handlers.hydratePreferences();}},
    holdResolution(){resolutionGate=new Promise(resolve=>{releaseResolution=resolve;});return ()=>{resolutionGate=null;releaseResolution();};},
    async flush(){for(let i=0;i<12;i++){if(memoryDirty){memoryDirty=false;handlers.hydratePreferences();}for(const timer of timers){if(!timer.cancelled&&!timer.ran){timer.ran=true;timer.callback();}}await Promise.all(pendingRuns.splice(0));await turn();}}
  };
}

function qualifiedLaneHarness({memory:restoredMemory}={}) {
  // Isolated, synthetic provider metadata tests lane policy, not real music.
  const now=Date.now(); const base=intelligence.createEmptyListeningMemory(now);
  const memory=intelligence.recordListeningEvent(base,{type:"preference_changed",eventId:"verified-style-fixture",targetType:"track",targetKey:"qq:Known",value:"more",scope:"track",createdAt:now,sessionId:base.currentSession.sessionId,
    title:"Known",artist:"Known Artist",features:{...retainedEvidenceMemory().trackMemories["qq:Known retained"].features,trackId:"Known",tags:["genre:neo-soul","genre:pop"].map(value=>({value,source:"provider_metadata",confidence:.65,profileEligible:true}))}});
  const h=harness({memory:restoredMemory||memory});
  h.context.window.codioDesktop.qqMusic.metadata=async mid=>({ok:true,mid,source:"provider_metadata",genres:[Number(mid.replace("Track ",""))<48?"neo-soul":"pop"]});
  return h;
}

test("qualified manual refresh separates close new songs from credible broader exploration and their hidden continuations",async()=>{
  const h=qualifiedLaneHarness(); const old=h.shown();
  const result=await h.handlers.refreshRecommendations("manual");
  assert.equal(result.visibleCommitted,true); assert.equal(h.shown().matched.length,12); assert.equal(h.shown().frontier.length,12);
  const id=item=>h.context.recommendationTracks[identity(item)].mid;
  assert.ok(h.shown().matched.every(item=>Number(id(item).replace("Track ",""))<48));
  assert.ok(h.shown().frontier.every(item=>Number(id(item).replace("Track ",""))>=48));
  assert.ok(h.shown().matched.every(item=>!old.matched.includes(item)));
  for(const lane of ["matched","frontier"]){
    const shown=h.shown()[lane]; const queue=h.handlers.recommendationQueueFor(h.context.recommendationTracks[identity(shown[0])]);
    assert.ok(queue.length>12,"qualified future candidates must extend their own lane");
    assert.deepEqual(queue.slice(0,12).map(track=>track.mid),shown.map(id));
    assert.ok(queue.every(track=>(Number(track.mid.replace("Track ",""))<48)===(lane==="matched")));
  }
  const before=h.shown(); h.visibleWrites.length=0; h.handlers.recordCurrentPreference("like");await h.flush();assertStable(h,{...before});
});

test("third and later refresh replenish the same lane beyond exhausted search pages without recycling exposure", async () => {
  const h=qualifiedLaneHarness(),other=h.shown().frontier,batches=[];
  const makePage=page=>Array.from({length:24},(_,i)=>({provider:"qq",id:`page-${page}-${i}`,mid:`page-${page}-${i}`,title:`Work ${page}-${i}`,artist:`Page artist ${i%12}`,
    genres:["neo-soul"],language:"英语",releaseDate:"2024-01-01",durationSeconds:240,cover:"test:cover"}));
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{
    h.searchCalls.push({query,page});
    return query==="neo-soul"?makePage(page<10?0:page):[];
  };
  for(let i=0;i<5;i++){
    const result=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
    const record=result.lanes[0];
    assert.equal(record.status,"completed",`refresh ${i+1}`);assert.equal(record.visibleCommitted,true);
    const ids=h.shown().matched.map(identity);assert.equal(ids.length,12);batches.push(ids);
    assert.strictEqual(h.shown().frontier,other,"only this lane may refresh");
    if(i===2)assert.ok(record.acquisitionPasses>=2,"the exhausted third request must actually retrieve another seed window");
  }
  assert.equal(new Set(batches.flat()).size,60,"no old page or exposure is silently recycled");
  assert.ok(h.context.recommendationPoolsRef.current.match.cursor>5,"persist the refill cursor, not just the click count");
});

test("real DJ preference saves, changes final scores and commits the hidden queue even when provider search is offline", async () => {
  const h=qualifiedLaneHarness();
  await h.handlers.refreshRecommendations("manual");
  const shown=h.shown();
  const prefix=[h.context.activeQQTrackLiveRef.current,...[...shown.matched,...shown.frontier].map(item=>h.context.recommendationTracksRef.current[identity(item)])].map(track=>track.mid);
  h.context.playQueueRef.current=prefix.map(mid=>h.context.recommendationTracksRef.current[`qq:${mid}`]);
  h.visibleWrites.length=0;
  const key=h.context.recommendationPoolsRef.current.match.hidden[0],track=h.context.recommendationTracksRef.current[key];
  assert.ok(track,"use an actual source-checked hidden candidate");
  Object.assign(h.context,agent,{setThinkingCue(){},qqConnection:"connected",qqPlaybackReady:true,
    scene:"night",particleLevel:2,lyricMode:"cinematic",profileOpen:false,settingsOpen:false,nowPlayingOpen:false,djOpen:true,
    crypto:{randomUUID:()=>`dj-${Math.random()}`}});
  const before=h.context.recommendationScoresRef.current.get(key).totalScore;
  const text=`${track.title}这首不合我口味`;
  const result=await h.handlers.executeCodioTool({id:"saved",name:"record_music_preference",arguments:{target_type:"track",track_id:track.mid,value:"less",evidence_text:text}},new Map([[track.mid,track]]),text);
  assert.equal(result.persisted,true);assert.equal(result.profileUpdated,true);assert.equal(result.recommendationUpdate.status,"queued");
  let attemptedSearches=0;
  h.context.window.codioDesktop.qqMusic.search=async()=>{attemptedSearches++;throw Error("offline retrieval must not block re-ranking owned candidates");};
  await h.flush();
  const update=h.context.recommendationUpdateRef.current.latest;
  assert.equal(attemptedSearches,0);assert.equal(update.status,"completed");
  assert.ok(update.lanes.every(lane=>lane.rerankOwnedPool===true));
  assert.equal(update.hiddenPoolCommitted,true);assert.equal(update.hiddenQueueCommitted,true);assert.equal(update.hiddenPoolChanged,true);
  assert.ok(h.context.recommendationScoresRef.current.get(key).totalScore<before);
  assert.ok(h.context.recommendationScoresRef.current.get(key).contributions.find(item=>item.key==="explicit_track").signedWeight<0);
  assert.ok(!h.context.recommendationPoolsRef.current.match.hidden.includes(key));
  assert.ok(!h.context.playQueueRef.current.slice(prefix.length).some(item=>item.mid===track.mid));
  assert.deepEqual(h.context.playQueueRef.current.slice(0,prefix.length).map(track=>track.mid),prefix);
  assertStable(h,shown);
  const saved=intelligence.activePreferences(intelligence.loadListeningMemory(h.context.window.localStorage));
  assert.equal(saved.find(event=>event.targetKey===key).source,"dj");
});

test("DJ completion observes the real update event, with bounded wait and no polling", async () => {
  const h=qualifiedLaneHarness(),update=h.context.recommendationUpdateRef.current;
  update.waiters=new Set();update.latest={revision:1,status:"queued"};
  let completed=false;const wait=h.handlers.waitForRecommendationUpdate(1).then(()=>{completed=true;});
  await turn();assert.equal(completed,false);assert.equal(update.waiters.size,1);
  update.latest={revision:1,status:"completed",hiddenPoolCommitted:true};update.waiters.forEach(done=>done());await wait;
  assert.equal(completed,true);assert.equal(update.waiters.size,0);
  assert.equal(h.timers.at(-1).cancelled,true);
  update.latest={revision:2,status:"queued"};const slow=h.handlers.waitForRecommendationUpdate(2);
  h.timers.at(-1).callback();await slow;
  assert.equal(update.latest.status,"queued","timeout is not fabricated completion");assert.equal(update.waiters.size,0);
});

test("a newly declared artist has a real bounded exploration acquisition route, not just a chat memory", async () => {
  const h=qualifiedLaneHarness();await h.handlers.refreshRecommendations("manual");
  const shown=h.shown();h.visibleWrites.length=0;
  Object.assign(h.context,agent,{setThinkingCue(){},qqConnection:"connected",qqPlaybackReady:true,
    scene:"night",particleLevel:2,lyricMode:"cinematic",profileOpen:false,settingsOpen:false,nowPlayingOpen:false,djOpen:true,
    crypto:{randomUUID:()=>`artist-${Math.random()}`}});
  const track={provider:"qq",mid:"new-artist-verified-work",id:"new-artist-verified-work",title:"Verified new work",artist:"Verified New Artist",durationSeconds:240,cover:"test:cover"};
  const text="Verified New Artist的歌太对我胃口了";
  const saved=await h.handlers.executeCodioTool({id:"artist",name:"record_music_preference",arguments:{target_type:"artist",artist_name:track.artist,value:"more",evidence_text:text}},new Map([[track.mid,track]]),text);
  assert.equal(saved.persisted,true);
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{h.searchCalls.push({query,page});return query===track.artist?[track]:[];};
  h.context.window.codioDesktop.qqMusic.metadata=async mid=>({ok:true,mid,source:"provider_metadata",genres:[]});
  await h.flush();
  const record=h.context.recommendationUpdateRef.current.latest.lanes.find(item=>item.lane==="frontier");
  assert.ok(record.seeds.some(seed=>seed.strategy==="explicit_artist_trial"&&seed.query===track.artist));
  assert.ok(record.hiddenIds.includes(`qq:${track.mid}`));
  const score=h.context.recommendationScoresRef.current.get(`qq:${track.mid}`);
  assert.equal(score.laneEvidence.match,false,"an artist name does not prove close sonic match");
  assert.equal(score.laneEvidence.frontier,true);assert.ok(score.contributions.find(item=>item.key==="explicit_artist").signedWeight>0);
  assertStable(h,shown);
});

test("a qualified repeated refresh produces disjoint batches and preserves the last full batch on exhaustion",async()=>{
  const h=qualifiedLaneHarness(); const batches=[];
  for(let i=0;i<2;i++){const result=await h.handlers.refreshRecommendations("manual");assert.equal(result.visibleCommitted,true);batches.push([...h.shown().matched,...h.shown().frontier].map(identity));}
  assert.equal(new Set(batches.flat()).size,48);
  const before=h.shown();const result=await h.handlers.refreshRecommendations("manual");
  assert.equal(result.visibleCommitted,false);assert.equal(result.status,"insufficient_candidates");
  assert.strictEqual(h.shown().matched,before.matched);assert.strictEqual(h.shown().frontier,before.frontier);
});

test("first empty calibrated lists fill qualified slots despite one metadata failure and never backfill with unrelated songs",async()=>{
  const h=qualifiedLaneHarness();h.context.setMatchedExperiments([]);h.context.setVisibleExperiments([]);h.storage.set("codio-recommendation-history","[]");
  const metadata=h.context.window.codioDesktop.qqMusic.metadata;
  h.context.window.codioDesktop.qqMusic.metadata=async mid=>{if(mid==="Track 0")throw new Error("one temporary metadata failure");return metadata(mid);};
  const result=await h.handlers.refreshRecommendations("sync");
  assert.equal(h.shown().matched.length,12);assert.equal(h.shown().frontier.length,12);
  assert.ok(!h.shown().matched.some(item=>h.context.recommendationTracks[identity(item)].mid==="Track 0"));
  assert.equal(result.visibleCommitted,true);
});

test("a four-card close-match batch fills to twelve using independent collected-song metadata without replacing those four",async()=>{
  const h=harness({memory:intelligence.createEmptyListeningMemory()}),old=h.shown().matched.slice(0,4);
  h.context.setMatchedExperiments(old);h.visibleWrites.length=0;
  const library=Array.from({length:6},(_,artist)=>Array.from({length:2},(_,work)=>({provider:"qq",mid:`known-${artist}-${work}`,title:`Known ${artist}-${work}`,artist:`Collected artist ${artist}`,
    durationSeconds:240,genres:["Pop"],playlistMembership:[{id:"curated",name:"User playlist"}],cover:""}))).flat();
  const fresh=Array.from({length:6},(_,artist)=>Array.from({length:4},(_,work)=>({provider:"qq",mid:`fresh-${artist}-${work}`,title:`Fresh ${artist}-${work}`,artist:`Collected artist ${artist}`,
    durationSeconds:240,genres:["Pop"],language:"英语",releaseDate:"2024-01-01",cover:""}))).flat();
  h.context.qqTasteSnapshotRef.current={tracks:library,topArtists:Array.from({length:6},(_,i)=>({name:`Collected artist ${i}`,weight:2}))};
  h.context.window.codioDesktop.qqMusic.search=async query=>fresh.filter(track=>track.artist===query);
  h.context.window.codioDesktop.qqMusic.metadata=async mid=>({ok:true,mid,source:"provider_metadata",genres:["Pop"]});
  const other=h.shown().frontier,record=(await h.handlers.refreshRecommendations("sync",undefined,["continuation"],"match")).lanes[0];
  assert.equal(record.status,"completed");assert.equal(h.shown().matched.length,12);
  assert.deepEqual(h.shown().matched.slice(0,4),old);assert.strictEqual(h.shown().frontier,other);
  assert.ok(h.shown().matched.slice(4).every(item=>item.id.startsWith("fresh-")));
  assert.equal(library.some(track=>track.likedInProvider),false,"a renameable playlist is not falsely marked as QQ's official likes");
  assert.deepEqual(h.memory().explicitPreferences,[]);
});

test("actual lane checks the same candidate's source and verified metadata concurrently",async()=>{
  const h=qualifiedLaneHarness(),sources=[],metadata=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  h.context.prepareTrack=async track=>{sources.push(track.mid);await gate;return {playback:{playable:true,url:`isolated:${track.mid}`},expiresAt:Date.now()+180000,coverData:`test:${track.mid}`};};
  const read=h.context.window.codioDesktop.qqMusic.metadata;
  h.context.window.codioDesktop.qqMusic.metadata=async mid=>{metadata.push(mid);return read(mid);};
  const pending=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
  await turn();
  const first=sources[0],concurrent=metadata.includes(first);
  release();const result=await pending;
  assert.ok(first,"the actual production lane must start real candidate source preparation");
  assert.equal(concurrent,true,"provider metadata starts before the same candidate's source promise settles");
  assert.equal(result.lanes[0].status,"completed","the test must reach a real checked/scored commit, not a caught missing-context failure");
});

test("manual refresh uses its qualified reserve without searches, unrelated metadata or a full source scan",async()=>{
  const h=qualifiedLaneHarness();
  await h.handlers.refreshRecommendations("feedback",undefined,["initial"],"match");
  const before=h.shown(),other=JSON.stringify(h.context.recommendationPoolsRef.current.frontier),prepared=[];
  const previousPool=h.context.recommendationPoolsRef.current.match;
  assert.ok(previousPool.hidden.length>=24,"the actual prior acquisition must leave a reserve");
  let searches=0,metadata=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  h.context.qqTasteSnapshotRef.current={tracks:Array.from({length:12},(_,i)=>({...qqTrack(fixtures[i]),mid:`unrelated-${i}`})),topArtists:[]};
  h.context.window.codioDesktop.qqMusic.search=async()=>{searches++;throw Error("reserve refresh must not wait for retrieval");};
  h.context.window.codioDesktop.qqMusic.metadata=async()=>{metadata++;throw Error("retained provider facts are already known");};
  h.context.prepareTrack=async track=>{prepared.push(track.mid);await gate;return {coverData:`test:${track.mid}`};};
  const pending=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
  await turn();
  assert.strictEqual(h.shown().matched,before.matched,"not displayed until source checks finish");
  assert.equal(prepared.length,4,"only four bounded source workers, not twelve Audio instances");
  release();const result=await pending,record=result.lanes[0];
  assert.equal(record.status,"completed");assert.equal(record.searchSkipped,true);assert.equal(record.retainedPoolUsed,true);
  assert.equal(searches,0);assert.equal(metadata,0);
  assert.ok(prepared.length>=12&&prepared.length<=15,`twelve ready candidates plus at most three in flight, got ${prepared.length}`);
  assert.ok(h.shown().matched.every(item=>prepared.includes(item.id)));
  assert.ok(h.shown().matched.every(item=>!before.matched.some(old=>identity(old)===identity(item))));
  assert.strictEqual(h.shown().frontier,before.frontier);assert.equal(JSON.stringify(h.context.recommendationPoolsRef.current.frontier),other);
  assert.ok(h.context.recommendationPoolsRef.current.match.hidden.some(key=>!prepared.some(mid=>key===`qq:${mid}`)),
    "unchecked reserve identities remain hidden; they are not claimed to be buffered audio");
});

test("expired reserve sources fall back to own-lane acquisition and never publish unchecked cache entries",async()=>{
  const h=qualifiedLaneHarness();await h.handlers.refreshRecommendations("feedback",undefined,["initial"],"match");
  const before=h.shown(),pool=h.context.recommendationPoolsRef.current.match;
  h.makeUnavailable(pool.candidates.map(candidate=>({title:candidate.track.id,artist:candidate.track.artist})));
  const newTracks=Array.from({length:16},(_,i)=>({provider:"qq",mid:`replacement-${i}`,title:`Replacement ${i}`,artist:`Replacement artist ${i}`,
    genres:["neo-soul"],language:"英语",releaseDate:"2023-01-01",cover:"",durationSeconds:240}));
  h.context.window.codioDesktop.qqMusic.search=async query=>query==="neo-soul"?newTracks:[];
  const record=(await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match")).lanes[0];
  assert.equal(record.retainedPoolUsed,true);assert.equal(record.searchSkipped,false);assert.equal(record.status,"completed");
  assert.ok(h.shown().matched.every(item=>item.id.startsWith("replacement-")));
  assert.ok(h.context.recommendationPoolsRef.current.match.candidates.every(candidate=>candidate.track.id.startsWith("replacement-")),
    "failed source facts cannot survive in the hidden pool as playable cache entries");
  assert.strictEqual(h.shown().frontier,before.frontier);
});

test("actual candidate batch never waits beyond its remaining deadline or admits a timed-out source",async()=>{
  const h=qualifiedLaneHarness(),base=Date.now(),tasks=new Map(),started=[];let now=base,sequence=0;
  const clock={
    setTimeout(callback,delay){const id=++sequence;tasks.set(id,{at:now+delay,callback});return id;},
    clearTimeout(id){tasks.delete(id);},
    async advance(target){await turn();while(true){const next=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>target)break;
      now=next[1].at;tasks.delete(next[0]);next[1].callback();await turn();}now=target;await turn();},
  };
  h.context.Date=class extends Date{static now(){return now;}};
  h.context.withTimeout=(promise,ms,label)=>new Promise((resolve,reject)=>{
    const id=clock.setTimeout(()=>reject(Error(`${label}_TIMEOUT`)),ms);
    promise.then(value=>{clock.clearTimeout(id);resolve(value);},error=>{clock.clearTimeout(id);reject(error);});
  });
  h.context.prepareTrack=track=>new Promise(resolve=>{
    started.push({id:track.mid,at:now});
    clock.setTimeout(()=>resolve({playback:{playable:true,url:`isolated:${track.mid}`},expiresAt:now+180000,coverData:`test:${track.mid}`}),5500);
  });
  const metadata=h.context.window.codioDesktop.qqMusic.metadata;
  h.context.window.codioDesktop.qqMusic.metadata=mid=>new Promise(resolve=>clock.setTimeout(async()=>resolve(await metadata(mid)),3000));
  const pending=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
  await clock.advance(base+60000);
  const result=await pending,lane=result.lanes[0];
  assert.ok(started.length>4,"exercise several actual production candidate waves, not a one-promise helper");
  assert.ok(lane.durationMs<=24000,`The 24s candidate batch must cap the final in-flight wave too; got ${lane.durationMs}ms`);
  assert.notEqual(lane.status,"failed","deadline verification must reach the real commit instead of a fixture setup failure");
  const admitted=new Set(lane.poolCandidateIds||[]);
  assert.ok(started.filter(item=>item.at+5500>base+24000).every(item=>!admitted.has(`qq:${item.id}`)),
    "a provider source resolving after this batch's deadline is not prepared evidence for its commit");
});

function assertStable(h, before) {
  assert.strictEqual(h.shown().matched, before.matched, "feedback must not replace the matched page");
  assert.strictEqual(h.shown().frontier, before.frontier, "feedback must not replace the frontier page");
  assert.equal(h.shown().matched.length, 12);
  assert.equal(h.shown().frontier.length, 12);
  assert.deepEqual(h.visibleWrites, [], "feedback must not write either visible batch");
}

test("completed reranks retire old disposable caches but preserve both visible batches, committed prefix and transition target", async () => {
  const h = qualifiedLaneHarness(), before = h.shown(), memoryBefore = JSON.stringify(h.memory());
  const active = h.context.activeQQTrackLiveRef.current;
  const manual = { ...active, mid: "manual-protected", title: "Manual" }, promised = { ...active, mid: "promised-protected", title: "Promised" };
  h.context.playQueueRef.current = [active, manual, promised, ...h.context.playQueueRef.current.filter(track => track.mid !== active.mid)];
  h.context.manualQueueIdsRef.current.add(manual.mid);
  h.context.activeTransitionRef.current = { outgoingSnapshot: { track: active }, incomingSnapshot: { track: promised } };
  for (const track of [manual, promised]) h.context.recommendationTracksRef.current[identity(track)] = track;
  for (let i = 0; i < 5000; i++) {
    const track = { ...active, mid: `obsolete${i}` }, key = identity(track);
    h.context.recommendationTracksRef.current[key] = track; h.context.discoveryTracksRef.current[key] = track;
    h.context.recommendationScoresRef.current.set(key, { candidateKey: key, contributions: [] });
  }
  const result = await h.handlers.refreshRecommendations("feedback", undefined, ["runtime-cache-check"]);
  assert.equal(result.status, "completed"); assertStable(h, before);
  assert.deepEqual(h.context.playQueueRef.current.slice(0, 3).map(track => track.mid), [active.mid, manual.mid, promised.mid]);
  for (const track of [active, manual, promised]) assert.equal(h.context.recommendationTracksRef.current[identity(track)].mid, track.mid);
  assert.equal(h.context.recommendationTracksRef.current["qq:obsolete0"], undefined);
  assert.equal(h.context.recommendationScoresRef.current.has("qq:obsolete0"), false);
  assert.ok(Object.keys(h.context.recommendationTracksRef.current).length < 1600);
  assert.ok(h.context.recommendationScoresRef.current.size < 1600);
  assert.ok(Object.keys(h.context.discoveryTracksRef.current).length < 1600);
  assert.equal(JSON.stringify(h.memory()), memoryBefore, "Transient cache retirement cannot edit listening memory");
});

function startupSnapshotHarness({failed=[],bootPhase="playing",memory}={}) {
  const h=qualifiedLaneHarness({memory}),owner="isolatedQQOwner",prepared=[];
  h.context.bootPhase=bootPhase;
  h.context.window.codioDesktop.qqMusic.getStatus=async()=>({loggedIn:true,playbackReady:true,userId:owner});
  h.context.window.codioDesktop.qqMusic.metadata=async mid=>({ok:true,mid,source:"provider_metadata",
    genres:[mid.startsWith("upper")||mid.startsWith("Track ")&&Number(mid.slice(6))<48?"neo-soul":"pop"]});
  h.context.prepareTrack=async track=>{prepared.push(track.mid);return failed.includes(track.mid)?null:
    {playback:{playable:true,url:`isolated:${track.mid}`},coverData:`test:${track.mid}`};};
  h.context.activeQQTrackLiveRef.current=null;h.context.playQueueRef.current=[];
  const snapshots={};
  for(const [lane,prefix] of [["match","upper"],["frontier","lower"]]) {
    const tracks=Array.from({length:132},(_,i)=>({provider:"qq",id:`${prefix}${i}`,mid:`${prefix}${i}`,title:`Isolated ${prefix} ${i}`,
      artist:`Isolated Artist ${i}`,durationSeconds:240,genres:[prefix==="upper"?"neo-soul":"pop"],albumMid:`album${prefix}${i}`,mediaMid:`media${prefix}${i}`,
      cover:"data:image/png;base64,NOT_PERSISTED",playbackUrl:"private-ticket",apiKey:"private-key",cookieHeader:"private-cookie"}));
    const visible=tracks.slice(0,12).map(identity);
    const snapshot=h.handlers.buildStartupRecommendationSnapshot(tracks,visible,lane,owner);
    snapshots[lane]=snapshot;
    h.storage.set(`codio-recommendation-pool-v1-${lane}`,JSON.stringify({cursor:7,exposure:visible,snapshot}));
    h.context.recommendationPoolsRef.current[lane]=intelligence.createRecommendationPool(lane);
  }
  h.context.setMatchedExperiments([]);h.context.setVisibleExperiments([]);h.visibleWrites.length=0;
  return {h,owner,prepared,snapshots};
}

function restartSnapshotHarness(previous){
  const at=Date.now()+1000,loaded=intelligence.loadListeningMemory(previous.context.window.localStorage,at);
  const memory={...loaded,currentSession:intelligence.createEmptyListeningMemory(at).currentSession};
  const restarted=startupSnapshotHarness({memory});
  for(const [key,value] of previous.storage)restarted.h.storage.set(key,value);
  restarted.h.context.Date=class extends Date{static now(){return at;}};
  return restarted;
}

test("the first REFRESH after warm boot reuses only its owner-checked unseen catalogue and verifies the new page",async()=>{
  const {h,prepared}=startupSnapshotHarness();
  await h.handlers.refreshRecommendations("feedback",undefined,["initial","startup_ready"]);
  assert.equal(h.context.recommendationPoolsRef.current.match.candidates.length,12,"boot only source-checks the displayed page");
  const before=h.shown(),other=JSON.stringify(h.context.recommendationPoolsRef.current.frontier);
  h.context.bootPhase="done";prepared.length=0;
  let searches=0,metadata=0;
  h.context.window.codioDesktop.qqMusic.search=async()=>{searches++;throw Error("owned catalogue should avoid a new search");};
  h.context.window.codioDesktop.qqMusic.metadata=async()=>{metadata++;throw Error("known provider facts should be reused");};
  const record=(await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match")).lanes[0];
  assert.equal(record.status,"completed");assert.equal(record.retainedPoolUsed,true);assert.equal(record.searchSkipped,true);
  assert.equal(searches,0);assert.equal(metadata,0);
  assert.ok(prepared.length>=12&&prepared.length<=15);
  assert.ok(h.shown().matched.every(item=>item.id.startsWith("upper")&&prepared.includes(item.id)));
  assert.ok(h.shown().matched.every(item=>!before.matched.some(old=>identity(old)===identity(item))));
  assert.strictEqual(h.shown().frontier,before.frontier);assert.equal(JSON.stringify(h.context.recommendationPoolsRef.current.frontier),other);
});

test("startup snapshot only retains bounded catalog facts, exact owner/lane and six-hour freshness",()=>{
  const {h,owner,snapshots}=startupSnapshotHarness(),read=h.handlers.readStartupRecommendationSnapshot,now=Date.now();
  const raw={...snapshots.match,savedAt:now};
  const result=read(raw,"match",owner,now);
  assert.equal(result.tracks.length,132);assert.equal(result.visible.length,12);
  assert.doesNotMatch(JSON.stringify(result),/private-ticket|private-key|private-cookie|NOT_PERSISTED|playbackUrl|cookieHeader|apiKey/);
  assert.ok(result.tracks.every(track=>track.cover.startsWith("https://y.gtimg.cn/")));
  assert.equal(result.tracks[0].mediaMid,"mediaupper0","the playback file identity must survive a catalog snapshot");
  assert.equal(read({...raw,tracks:[{...raw.tracks[0],mediaMid:"private?ticket"}]},"match",owner,now).tracks[0].mediaMid,undefined);
  for(const [candidate,lane,id,time] of [[raw,"frontier",owner,now],[raw,"match","another-owner",now],[raw,"match","",now],
    [raw,"match",owner,now+21600000],[{...raw,savedAt:now+1},"match",owner,now]])assert.deepEqual(read(candidate,lane,id,time),{tracks:[],visible:[]});
  const invalid={...raw,tracks:[{...raw.tracks[0],mid:"bad-id"},{...raw.tracks[1],durationSeconds:0},raw.tracks[2],raw.tracks[2]],
    visible:["qq:bad-id",identity(raw.tracks[2]),identity(raw.tracks[2]),"qq:not-present"]};
  assert.deepEqual(read(invalid,"match",owner,now).visible,[identity(raw.tracks[2])]);
  assert.equal(read(invalid,"match",owner,now).tracks.length,1);
});

test("real warm startup revalidates the same disjoint 24 before display without another catalog scan or autoplay",async()=>{
  const {h,prepared,snapshots}=startupSnapshotHarness();let releaseMatch,releaseFrontier;const playbackIdentities=[];
  const gates={match:new Promise(resolve=>{releaseMatch=resolve;}),frontier:new Promise(resolve=>{releaseFrontier=resolve;})},prepare=h.context.prepareTrack;
  const release=()=>{releaseMatch();releaseFrontier();};
  h.context.prepareTrack=async track=>{await gates[track.mid.startsWith("upper")?"match":"frontier"];playbackIdentities.push({mid:track.mid,mediaMid:track.mediaMid});return prepare(track);};
  const pending=h.handlers.refreshRecommendations("feedback",undefined,["initial","startup_ready"]);
  await turn();assert.equal(h.shown().matched.length,0);assert.equal(h.shown().frontier.length,0);
  assert.deepEqual(h.context.bootMusicTask,{match:"Checking playback links and covers…",frontier:"Checking playback links and covers…"});
  await turn();assert.deepEqual(h.context.bootMusicTask,{match:"Checking playback links and covers…",frontier:"Checking playback links and covers…"},"the actual awaited source phase remains active until its promise settles");
  releaseMatch();await turn();assert.equal(h.context.bootMusicTask.match,"");assert.equal(h.context.bootMusicTask.frontier,"Checking playback links and covers…");
  assert.equal(h.shown().matched.length,12);assert.equal(h.shown().frontier.length,0);
  release();const result=await pending;
  assert.equal(result.status,"completed");assert.equal(h.searchCalls.length,0,"cache is its own verified acquisition, not a duplicated cold search");
  assert.deepEqual(h.shown().matched.map(identity),snapshots.match.visible);assert.deepEqual(h.shown().frontier.map(identity),snapshots.frontier.visible);
  for(const lane of result.lanes) {
    assert.equal(lane.startupSnapshotUsed,true);assert.equal(lane.status,"completed");assert.equal(lane.visibleCount,12);
    assert.ok(lane.checkedCandidateCount>=12&&lane.checkedCandidateCount<=15,"validate the page first, not all 132 hidden/catalog entries");
  }
  assert.equal(new Set([...h.shown().matched,...h.shown().frontier].map(identity)).size,24);
  assert.ok([...snapshots.match.visible,...snapshots.frontier.visible].every(key=>prepared.includes(key.slice(3))),
    "132-entry cache must not lose the first twelve visible IDs to slice(-120)");
  assert.ok(playbackIdentities.every(track=>track.mediaMid===`media${track.mid}`),"actual source preparation retains the distinct provider file ID");
  assert.equal(h.context.playQueueRef.current.length,0);assert.equal(h.context.audioElementsRef.current.size,0);
  assert.doesNotMatch([...h.storage.values()].join(""),/private-ticket|private-key|private-cookie|NOT_PERSISTED/);
  assert.deepEqual(h.context.bootMusicTask,{match:"",frontier:""});
  for(const lane of ["match","frontier"]){
    const tasks=[...new Set(h.bootTaskUpdates.map(task=>task[lane]).filter(Boolean))];
    assert.deepEqual(tasks,["Checking music availability…","Reading your music preferences…",
      lane==="match"?"Restoring close matches…":"Restoring taste frontier…","Checking playback links and covers…","Applying your latest preferences…"]);
  }
});

test("after local UI entry cached cards still wait for source verification and weak weather cannot erase their pending request",async()=>{
  const {h,prepared,snapshots}=startupSnapshotHarness({bootPhase:"done"});let release;
  const gate=new Promise(resolve=>{release=resolve;}),prepare=h.context.prepareTrack;
  h.context.prepareTrack=async track=>{await gate;return prepare(track);};
  h.handlers.requestRecommendationUpdate("initial");
  const update=h.context.recommendationUpdateRef.current,queued=update.latest,revision=update.revision;
  const timer=h.timers[0];timer.ran=true;timer.callback();await turn();
  assert.equal(h.shown().matched.length,0);assert.equal(h.shown().frontier.length,0);
  assert.equal(h.searchCalls.length,0,"early entry must not discard the first own-lane snapshot");
  h.handlers.requestRecommendationUpdate("context_changed");
  assert.strictEqual(update.latest,queued);assert.equal(update.latest.status,"queued");assert.equal(update.revision,revision);
  release();await h.flush();
  assert.deepEqual(h.shown().matched.map(identity),snapshots.match.visible);
  assert.deepEqual(h.shown().frontier.map(identity),snapshots.frontier.visible);
  assert.ok(update.latest.lanes.every(lane=>lane.startupSnapshotUsed&&lane.visibleCount===12&&lane.checkedCandidateCount>=12));
  assert.ok([...snapshots.match.visible,...snapshots.frontier.visible].every(id=>prepared.includes(id.slice(3))));
  assert.equal(h.context.audioElementsRef.current.size,0);assert.equal(h.context.playQueueRef.current.length,0,"readiness does not autoplay");
});

test("after local UI entry expired QQ authorization cannot promote cached identities to playable cards",async()=>{
  for(const status of [{loggedIn:false,playbackReady:false},{loggedIn:true,playbackReady:false}]){
    const {h,prepared}=startupSnapshotHarness({bootPhase:"done"});
    const cached=["match","frontier"].map(lane=>h.storage.get(`codio-recommendation-pool-v1-${lane}`));
    h.context.window.codioDesktop.qqMusic.getStatus=async()=>status;
    const result=await h.handlers.refreshRecommendations("feedback",undefined,["initial"]);
    assert.ok(result.lanes.every(lane=>lane.status==="failed"&&lane.error==="QQ_NOT_CONNECTED"));
    assert.deepEqual(prepared,[]);assert.deepEqual(h.searchCalls,[]);
    assert.equal(h.shown().matched.length,0);assert.equal(h.shown().frontier.length,0);
    assert.deepEqual(["match","frontier"].map(lane=>h.storage.get(`codio-recommendation-pool-v1-${lane}`)),cached);
    assert.ok(h.context.recommendationUpdateRef.current.latest.lanes.every(lane=>lane.error==="QQ_NOT_CONNECTED"));
  }
});

test("after local UI entry source failure remains a real terminal diagnostic rather than fabricated music readiness",async()=>{
  const {h}=startupSnapshotHarness({bootPhase:"done"});h.context.prepareTrack=async()=>null;
  const result=await h.handlers.refreshRecommendations("feedback",undefined,["initial"]);
  assert.equal(result.status,"insufficient_candidates");
  assert.ok(result.lanes.every(lane=>lane.checkedCandidateCount>0&&lane.playableCandidateCount===0
    &&lane.error==="INSUFFICIENT_QUALIFIED_CANDIDATES"),JSON.stringify(result.lanes.map(lane=>({lane:lane.lane,
      checked:lane.checkedCandidateCount,playable:lane.playableCandidateCount,error:lane.error,status:lane.status}))));
  assert.equal(h.shown().matched.length,0);assert.equal(h.shown().frontier.length,0);
  const update=h.context.recommendationUpdateRef.current,terminal=update.latest,records=[...update.records],revision=update.revision;
  h.handlers.releaseStartupEffect();h.handlers.requestRecommendationUpdate("context_changed");
  assert.strictEqual(update.latest,terminal);assert.deepEqual(update.records,records);assert.equal(update.revision,revision);
  assert.equal(h.timers.length,0);assert.equal(h.context.audioElementsRef.current.size,0);
});

test("local UI entry does not release QQ/library startup work until the real business prerequisites settle",async()=>{
  const blocked=[context=>{context.onboardingChecked=false;},context=>{context.listeningMemoryHydratedRef.current=false;},
    context=>{context.qqConnection="checking";},context=>{context.qqConnection="needs-auth";},
    context=>{context.tasteSyncing=true;},context=>{context.qqSyncRevisionRef.current=0;}];
  for(const block of blocked){
    const h=qualifiedLaneHarness(),update=h.context.recommendationUpdateRef.current;
    h.context.qqSyncRevisionRef.current=1;update.startupReady=false;block(h.context);
    h.handlers.requestRecommendationUpdate("initial");const waiting=update.latest;
    h.handlers.releaseStartupEffect();h.handlers.releaseStartupEffect();
    assert.equal(h.context.bootPhase,"done");assert.equal(update.startupReady,false);
    assert.strictEqual(update.latest,waiting);assert.equal(update.timer,null);assert.equal(h.timers.length,0);assert.equal(h.searchCalls.length,0);
  }
  const h=qualifiedLaneHarness(),update=h.context.recommendationUpdateRef.current;
  h.context.qqSyncRevisionRef.current=1;update.startupReady=false;
  h.context.setMatchedExperiments([]);h.context.setVisibleExperiments([]);h.storage.set("codio-recommendation-history","[]");
  h.handlers.requestRecommendationUpdate("initial");h.handlers.releaseStartupEffect();h.handlers.releaseStartupEffect();
  assert.equal(update.startupReady,true);assert.equal(h.timers.length,1);
  await h.flush();assert.equal(h.shown().matched.length,12);assert.equal(h.shown().frontier.length,12);
  assert.ok(update.latest.lanes.every(lane=>lane.triggerEvents.includes("initial")&&lane.triggerEvents.includes("startup_ready")));
});

test("one unavailable cached source is not displayed and is replaced only by a rechecked own-lane backup",async()=>{
  const {h,prepared,snapshots}=startupSnapshotHarness({failed:["upper0"]});
  const result=await h.handlers.refreshRecommendations("feedback",undefined,["initial"]);
  assert.equal(result.status,"completed");assert.equal(h.searchCalls.length,0);assert.equal(h.shown().matched.length,12);
  const ids=h.shown().matched.map(identity);
  assert.ok(!ids.includes("qq:upper0"));assert.deepEqual(ids.slice(0,11),snapshots.match.visible.slice(1));
  assert.ok(ids[11].startsWith("qq:upper"));assert.ok(prepared.includes(ids[11].slice(3)));
  assert.deepEqual(h.shown().frontier.map(identity),snapshots.frontier.visible);
});

test("a missing cached card does not stop at playable but unqualified backups",async()=>{
  const {h,snapshots}=startupSnapshotHarness({failed:["upper0"]});
  const saved=JSON.parse(h.storage.get("codio-recommendation-pool-v1-match"));
  saved.snapshot.tracks=saved.snapshot.tracks.map(track=>Number(track.mid.slice(5))>=12&&Number(track.mid.slice(5))<24?{...track,genres:["classical"]}:track);
  h.storage.set("codio-recommendation-pool-v1-match",JSON.stringify(saved));
  const result=await h.handlers.refreshRecommendations("feedback",undefined,["initial"]);
  assert.equal(h.searchCalls.length,0);assert.equal(result.status,"completed");
  assert.equal(h.shown().matched.length,12);
  const replacement=h.shown().matched.map(identity).find(key=>!snapshots.match.visible.includes(key));
  assert.ok(Number(replacement.slice("qq:upper".length))>=24,"later own-lane qualified backup must remain eligible for validation");
  assert.deepEqual(h.shown().frontier.map(identity),snapshots.frontier.visible);
});

test("warm startup uses owned song facts without waiting for missing language/date and never resolves rejected backup sources",async()=>{
  const {h,prepared}=startupSnapshotHarness();
  const key="codio-recommendation-pool-v1-match",saved=JSON.parse(h.storage.get(key));
  // Isolated old batch is no longer a qualified close match. Its genre facts
  // are known; absent language/date must not queue unrelated metadata calls.
  saved.snapshot.tracks=saved.snapshot.tracks.map((track,i)=>i<12?{...track,genres:["classical"]}:track);
  h.storage.set(key,JSON.stringify(saved));
  let metadata=0;
  h.context.window.codioDesktop.qqMusic.metadata=async()=>{metadata++;return new Promise(()=>{});};
  const result=await h.handlers.refreshRecommendations("feedback",undefined,["initial","startup_ready"]);
  assert.equal(result.status,"completed");assert.equal(metadata,0);
  assert.equal(h.shown().matched.length,12);assert.equal(h.shown().frontier.length,12);
  assert.ok(!prepared.some(mid=>mid.startsWith("upper")&&Number(mid.slice(5))<12),
    "known rejected songs cannot fill or evict the bounded prepared-URL cache");
  assert.ok(prepared.length<=30,`only qualified replacement sources and bounded in-flight work; got ${prepared.length}`);
  assert.ok(h.shown().matched.every(item=>Number(item.id.slice(5))>=12));
  assert.equal(h.context.audioElementsRef.current.size,0);
});

for(const source of ["player","dj"])for(const lane of ["match","frontier"]){
  test(`${source} exact-track less survives restart and excludes the rejected ${lane} snapshot slot without rejecting the artist`,async()=>{
    const initial=startupSnapshotHarness(),h=initial.h;
    assert.equal((await h.handlers.refreshRecommendations("feedback",undefined,["initial"])).status,"completed");
    const prefix=lane==="match"?"upper":"lower",otherLane=lane==="match"?"frontier":"match",field=lane==="match"?"matched":"frontier";
    const key=`qq:${prefix}0`,target=h.context.recommendationTracksRef.current[key],before=h.shown();h.visibleWrites.length=0;
    if(source==="player"){
      h.context.activeQQTrackLiveRef.current=target;h.handlers.recordCurrentPreference("dislike");
    }else h.handlers.writeTrackPreference(target,"less","track","dj","explicit_named_track");
    await turn();h.runEffects();await turn();
    const preference=intelligence.activePreferences(h.memory()).find(event=>event.targetKey===key);
    assert.ok(preference);assert.equal(preference.value,"less");assert.equal(preference.scope,"track");assert.equal(preference.source,source);
    assertStable(h,before);assert.ok(h.storage.get(intelligence.LISTENING_MEMORY_KEY),"the actual feedback writer must persist before restarting");
    const restarted=restartSnapshotHarness(h),next=restarted.h;
    assert.notEqual(next.memory().currentSession.sessionId,preference.sessionId);
    assert.ok(intelligence.activePreferences(next.memory()).some(event=>event.targetKey===key&&event.value==="less"),"an exact-track preference must remain active in the new app session");
    const result=await next.handlers.refreshRecommendations("feedback",undefined,["initial","startup_ready"]);
    const score=next.context.recommendationScoresRef.current.get(key);
    assert.ok(score,"the real runner must score the cached, playable rejected song");
    assert.ok(score.contributions.find(item=>item.key==="explicit_track").signedWeight<0);
    assert.equal(score.laneEvidence[lane],false,"the actual current scorer rejects this exact song for its own lane");
    assert.equal(result.status,"completed");assert.ok(result.lanes.every(item=>item.startupSnapshotUsed));
    const restored=next.shown()[field].map(identity);
    assert.ok(!restored.includes(key),"startup cannot inject an already-rejected visible identity around commit qualification");
    assert.equal(restored.length,12);assert.deepEqual(restored.slice(0,11),initial.snapshots[lane].visible.slice(1));
    const replacement=restored[11];assert.ok(replacement.startsWith(`qq:${prefix}`));
    assert.ok(restarted.prepared.includes(replacement.slice(3)));assert.equal(next.context.recommendationScoresRef.current.get(replacement).laneEvidence[lane],true);
    assert.equal(next.searchCalls.length,0,"a qualified own-snapshot backup fills the rejected slot without a new catalogue scan");
    const otherField=otherLane==="match"?"matched":"frontier",sibling=`qq:${otherLane==="match"?"upper":"lower"}0`;
    assert.deepEqual(next.shown()[otherField].map(identity),initial.snapshots[otherLane].visible);
    assert.equal(next.context.recommendationTracksRef.current[sibling].artist,target.artist,"the control is a different real identity by the same artist");
    assert.equal(next.context.recommendationScoresRef.current.get(sibling).laneEvidence[otherLane],true,"one disliked track is not an artist ban");
    assert.equal(new Set([...next.shown().matched,...next.shown().frontier].map(identity)).size,24);
    assert.ok(!JSON.parse(next.storage.get(`codio-recommendation-pool-v1-${lane}`)).snapshot.visible.includes(key));
    assert.equal(next.context.playQueueRef.current.length,0);assert.equal(next.context.audioElementsRef.current.size,0);
  });
}

test("withdrawing an exact-track less before restart restores original snapshot eligibility without changing the current page",async()=>{
  const initial=startupSnapshotHarness(),h=initial.h;
  await h.handlers.refreshRecommendations("feedback",undefined,["initial"]);
  const key="qq:upper0",target=h.context.recommendationTracksRef.current[key],before=h.shown();h.visibleWrites.length=0;
  h.handlers.writeTrackPreference(target,"less","track","dj","explicit_named_track");await turn();h.runEffects();
  const preference=intelligence.activePreferences(h.memory()).find(event=>event.targetKey===key);
  h.handlers.withdrawPreference(preference);await turn();h.runEffects();assertStable(h,before);
  const next=restartSnapshotHarness(h).h;
  assert.ok(!intelligence.activePreferences(next.memory()).some(event=>event.targetKey===key));
  const result=await next.handlers.refreshRecommendations("feedback",undefined,["initial"]);
  assert.equal(result.status,"completed");assert.equal(next.searchCalls.length,0);
  assert.deepEqual(next.shown().matched.map(identity),initial.snapshots.match.visible);
  assert.deepEqual(next.shown().frontier.map(identity),initial.snapshots.frontier.visible);
  const score=next.context.recommendationScoresRef.current.get(key);assert.equal(score.laneEvidence.match,true);
  assert.equal(score.contributions.find(item=>item.key==="explicit_track").signedWeight,0);
});

test("ongoing player and DJ exact-track less rerank hidden work while preserving the already displayed warm 24",async()=>{
  for(const source of ["player","dj"]){
    const {h}=startupSnapshotHarness();await h.handlers.refreshRecommendations("feedback",undefined,["initial"]);
    h.context.bootPhase="done";const before=h.shown(),key="qq:upper0",target=h.context.recommendationTracksRef.current[key];h.visibleWrites.length=0;
    if(source==="player"){h.context.activeQQTrackLiveRef.current=target;h.handlers.recordCurrentPreference("dislike");}
    else h.handlers.writeTrackPreference(target,"less","track","dj","explicit_named_track");
    await h.flush();assertStable(h,before);
    const score=h.context.recommendationScoresRef.current.get(key);
    assert.equal(score.laneEvidence.match,false,"the new current evidence is applied without mutating its already displayed slot");
    assert.ok(score.contributions.find(item=>item.key==="explicit_track").signedWeight<0);
    assert.ok(h.shown().matched.some(item=>identity(item)===key));
    assert.ok(!h.context.recommendationPoolsRef.current.match.hidden.includes(key));
    assert.equal(h.context.recommendationUpdateRef.current.latest.visibleBatchPreserved,true);
  }
});

test("failed cache cannot unlock an empty homepage and continuation returns to actual independent acquisition",async()=>{
  const {h,snapshots}=startupSnapshotHarness();
  const prepare=h.context.prepareTrack;h.context.prepareTrack=async track=>track.mid.startsWith("upper")?null:prepare(track);
  const result=await h.handlers.refreshRecommendations("feedback",undefined,["initial"]);
  assert.equal(h.shown().matched.length,0);assert.equal(h.shown().frontier.length,12);
  assert.notEqual(result.lanes.find(x=>x.lane==="match").status,"completed");
  const beforeFrontier=h.shown().frontier;
  const next=await h.handlers.refreshRecommendations("feedback",undefined,["continuation"]);
  assert.deepEqual(next.lanes.map(x=>x.lane),["match"]);assert.equal(next.lanes[0].startupSnapshotUsed,false);
  assert.ok(h.searchCalls.length>0);assert.equal(h.shown().matched.length,12);assert.strictEqual(h.shown().frontier,beforeFrontier);
  assert.deepEqual(h.shown().frontier.map(identity),snapshots.frontier.visible);
});

test("manual REFRESH selects a new page rather than restoring the cached visible page; newer evidence cancels stale restore",async()=>{
  const manual=startupSnapshotHarness().h;
  const old=JSON.parse(manual.storage.get("codio-recommendation-pool-v1-match")).snapshot.visible;
  const result=await manual.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
  assert.equal(result.lanes[0].startupSnapshotUsed,false);assert.equal(result.lanes[0].searchSkipped,true);
  assert.ok(manual.shown().matched.every(item=>!old.includes(identity(item))));
  const {h}=startupSnapshotHarness();let release;const gate=new Promise(resolve=>{release=resolve;}),prepare=h.context.prepareTrack;
  h.context.prepareTrack=async track=>{await gate;return prepare(track);};
  const stored=h.storage.get("codio-recommendation-pool-v1-match");
  const pending=h.handlers.refreshRecommendations("feedback",undefined,["initial"],"match");await turn();
  h.handlers.requestRecommendationUpdate("preference_changed");release();
  assert.equal((await pending).status,"superseded");assert.equal(h.shown().matched.length,0);
  assert.equal(h.storage.get("codio-recommendation-pool-v1-match"),stored,"old work cannot persist over newer evidence");
});

for(const invalid of ["owner","expired"]){
  test(`manual reserve cannot reuse a snapshot with ${invalid} mismatch`,async()=>{
    const {h}=startupSnapshotHarness();
    const key="codio-recommendation-pool-v1-match",saved=JSON.parse(h.storage.get(key));
    if(invalid==="owner")saved.snapshot.owner="another-owner";
    else saved.snapshot.savedAt=Date.now()-21600001;
    h.storage.set(key,JSON.stringify(saved));
    const record=(await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match")).lanes[0];
    assert.equal(record.retainedPoolUsed,false);assert.ok(h.searchCalls.length>0);
    assert.ok(record.poolCandidateIds.every(id=>!id.startsWith("qq:upper")));
  });
}

test("player like, unlike, dislike, and withdrawal persist feedback without replacing the displayed 12 + 12", async () => {
  const h = harness();
  const before = h.shown();
  const historyBefore = h.storage.get("codio-recommendation-history");
  h.handlers.recordCurrentPreference("like");
  await h.flush();
  assert.equal(intelligence.activePreferences(h.memory())[0].value, "more");
  assert.ok(JSON.parse(h.storage.get(intelligence.LISTENING_MEMORY_KEY)).explicitPreferences.length);
  assertStable(h, before);
  h.handlers.recordCurrentPreference("like");
  await h.flush();
  assert.deepEqual(intelligence.activePreferences(h.memory()), []);
  assertStable(h, before);
  h.handlers.recordCurrentPreference("dislike");
  await h.flush();
  const preference = intelligence.activePreferences(h.memory())[0];
  assert.equal(preference.value, "less");
  assert.equal(preference.scope, "track");
  assert.equal(h.timers.at(-1).delay, 240);
  assertStable(h, before);
  h.handlers.withdrawPreference(preference);
  await h.flush();
  assert.deepEqual(intelligence.activePreferences(h.memory()), []);
  assertStable(h, before);
  assert.equal(h.storage.get("codio-recommendation-history"), historyBefore, "hidden reranking is not a new visible exposure");
  assert.ok(h.catalog().some((item) => ![...before.matched, ...before.frontier].some((shown) => identity(shown) === identity(item))), "future catalog still adapts");
});

test("playback feedback follows the live incoming track instead of stale outgoing React state", async () => {
  const h = harness();
  const before = h.shown();
  const incoming = qqTrack(before.frontier[4]);
  h.context.activeQQTrackLiveRef.current = incoming;
  h.handlers.recordCurrentPreference("like");
  await h.flush();
  const key = intelligence.canonicalTrackKey("qq", incoming.mid);
  assert.equal(intelligence.activePreferences(h.memory())[0].targetKey, key);
  assert.ok(h.preferences().liked.has(key));
  assert.ok(!h.preferences().liked.has(h.context.currentPreferenceKey));
  assertStable(h, before);
});

test("THIS ONE writes and withdraws the resolved QQ preference through v2 memory while visible 24 stay fixed", async () => {
  const h = harness();
  const before = h.shown();
  const item = before.frontier[5];
  const track = qqTrack(item);
  const key = intelligence.canonicalTrackKey("qq", track.mid);
  h.storage.set("codio-taste-signals", "[]");
  const historyBefore = h.storage.get("codio-recommendation-history");
  h.handlers.rememberExperiment(item);
  await h.flush();
  const active = intelligence.activePreferences(h.memory());
  assert.equal(active.length, 1);
  const preference = active[0];
  assert.equal(preference.targetKey, key);
  assert.equal(preference.targetType, "track");
  assert.equal(preference.value, "more");
  assert.equal(preference.scope, "track");
  assert.equal(preference.title, track.title);
  assert.equal(preference.artist, track.artist);
  assert.equal(preference.source, "player");
  assert.equal(preference.reason, "recommendation_card");
  assert.equal(JSON.parse(h.storage.get(intelligence.LISTENING_MEMORY_KEY)).explicitPreferences[0].targetKey, key);
  assert.ok(h.preferences().liked.has(key), "the memory effect must hydrate the card and player from the same canonical key");
  assert.equal(h.preferences().liked.has(track.mid), false);
  assertStable(h, before);
  h.handlers.rememberExperiment(item);
  await h.flush();
  assert.deepEqual(intelligence.activePreferences(h.memory()), []);
  const withdrawal = h.memory().explicitPreferences.at(-1);
  assert.equal(withdrawal.value, "neutral");
  assert.equal(withdrawal.supersedesEventId, preference.eventId);
  assert.equal(h.preferences().liked.has(key), false);
  assertStable(h, before);
  assert.equal(h.storage.get("codio-taste-signals"), "[]", "card feedback must not append a second legacy signal");
  assert.equal(h.storage.get("codio-recommendation-history"), historyBefore);
});

test("THIS ONE refuses unresolved cards instead of guessing a track identity", async () => {
  const h = harness();
  const before = h.shown();
  h.handlers.rememberExperiment(fixtures[24]);
  await h.flush();
  assert.deepEqual(h.memory().explicitPreferences, []);
  assert.equal(h.storage.has(intelligence.LISTENING_MEMORY_KEY), false);
  assert.equal(h.storage.has("codio-recommendation-round"), false);
  assertStable(h, before);
});

test("tonight intent, profile correction, and QQ sync rerank future candidates without changing displayed pages", async () => {
  const h = harness();
  const before = h.shown();
  h.handlers.updateTonightIntent("energy", "calm");
  await h.flush();
  assert.equal(h.memory().sessionIntent.energy, "calm");
  assertStable(h, before);
  h.handlers.correctProfileHypothesis("test-hypothesis", "reject");
  await h.flush();
  assert.equal(h.memory().corrections.at(-1).verdict, "reject");
  assertStable(h, before);
  await h.handlers.refreshRecommendations("sync");
  await h.flush();
  assertStable(h, before);
});

test("only manual refresh publishes a resolved, disjoint replacement 12 + 12 and records their exposures", async () => {
  const h = harness();
  const before = h.shown();
  const oldKeys = new Set([...before.matched, ...before.frontier].map(identity));
  await h.handlers.refreshRecommendations();
  assert.notStrictEqual(h.shown().matched, before.matched, "await refresh resolves only after the real commit");
  await h.flush();
  const shown = h.shown();
  assert.equal(shown.matched.length, 12);
  assert.equal(shown.frontier.length, 12);
  const newKeys = [...shown.matched, ...shown.frontier].map(identity);
  assert.equal(new Set(newKeys).size, 24, "both lanes must be duplicate-free");
  assert.ok(newKeys.every((key) => !oldKeys.has(key)), "refresh must choose a new visible batch");
  assert.deepEqual(h.visibleWrites, ["matched", "frontier"]);
  const exposures = [...new Set(["match","frontier"].flatMap(lane=>JSON.parse(h.storage.get(`codio-recommendation-pool-v1-${lane}`)).exposure))];
  assert.equal(exposures.length, 48);
  assert.ok(newKeys.every((key) => exposures.includes(key)));
});

for (const trigger of ["feedback", "sync"]) {
  test(`a later ${trigger} refresh cancels a still-resolving manual batch without publishing it`, async () => {
    const h = harness();
    const before = h.shown();
    const release = h.holdResolution();
    const older = h.handlers.refreshRecommendations();
    h.runEffects();
    await turn();
    const newer = h.handlers.refreshRecommendations(trigger);
    h.runEffects();
    release();
    assert.equal((await older).status, "superseded");
    await newer;
    await h.flush();
    assertStable(h, before);
    assert.equal(h.context.recommendationUpdateRef.current.latest.visibleBatchPreserved, true);
  });
}

for (const playableCount of [5, 20]) {
  test(`manual refresh with only ${playableCount} match candidates isolates the insufficient frontier`, async () => {
    const h = harness();
    const before = h.shown();
    const historyBefore = h.storage.get("codio-recommendation-history");
    h.makeUnavailable(fixtures.slice(24 + playableCount));
    await h.handlers.refreshRecommendations();
    await h.flush();
    if(playableCount<12)assertStable(h, before);
    else {assert.notStrictEqual(h.shown().matched,before.matched);assert.strictEqual(h.shown().frontier,before.frontier);assert.deepEqual(h.visibleWrites,["matched"]);}
    assert.equal(h.storage.get("codio-recommendation-history"), historyBefore);
  });
}

test("selection retains its own displayed twelve without mixing the other lane into its continuation", async () => {
  const h = harness();
  const before = h.shown();
  const visible = [...before.matched, ...before.frontier].map(qqTrack);
  h.handlers.recordCurrentPreference("like");
  await h.flush();
  const queue = h.handlers.recommendationQueueFor(visible[17]);
  assert.deepEqual(queue.slice(0, 12).map((track) => track.mid), visible.slice(12).map((track) => track.mid));
  assert.ok(queue.every(track => !before.matched.some(item => identity(qqTrack(item)) === identity(track))), "the matching station cannot leak into the exploration station");
  assert.equal(new Set(queue.map(identity)).size, queue.length);
  assertStable(h, before);
});

test("renderer ranking uses active artist preferences, QQ discovery queries, and neutral withdrawal", async () => {
  const target = fixtures[24];
  const event = {
    type: "preference_changed", eventId: "artist-more", targetType: "artist", targetKey: target.artist,
    artist: target.artist, value: "more", scope: "artist", createdAt: Date.now(),
  };
  const empty = retainedEvidenceMemory();
  const more = intelligence.recordListeningEvent(empty, event);
  const less = intelligence.recordListeningEvent(empty, { ...event, eventId: "artist-less", value: "less" });
  const neutral = intelligence.recordListeningEvent(more, { ...event, eventId: "artist-neutral", value: "neutral", createdAt: event.createdAt + 1, supersedesEventId: event.eventId });
  const scores = [];
  for (const memory of [empty, more, less, neutral]) {
    const h = harness({ memory });
    await h.handlers.refreshRecommendations("feedback");
    await h.flush();
    const score = h.context.recommendationScoresRef.current.get(intelligence.canonicalTrackKey("qq", target.title));
    assert.ok(score, "the renderer must use the listening-intelligence ranking path");
    scores.push(score);
    if (memory === more) {
      assert.ok(h.searchCalls.some(({ query }) => query === target.artist), "an explicit artist preference must reach candidate discovery");
      assert.equal(h.context.recommendationPoolsRef.current.match.hidden[0],identity(qqTrack(target)), "positive artist feedback must affect the hidden ordering without moving visible cards");
    }
  }
  const [baseScore, moreScore, lessScore, restoredScore] = scores;
  assert.ok(moreScore.totalScore > baseScore.totalScore);
  assert.ok(lessScore.totalScore < baseScore.totalScore);
  assert.ok(Math.abs(restoredScore.totalScore-baseScore.totalScore)<.000001,"withdrawal restores the same contributions apart from actual millisecond age decay");
  assert.ok(moreScore.contributions.find((item) => item.key === "explicit_artist").signedWeight > 0);
  assert.ok(lessScore.contributions.find((item) => item.key === "explicit_artist").signedWeight < 0);
});

test("explicit artist feedback still changes actual ranking with only eight unseen candidates", async () => {
  const target = fixtures[24];
  const event = {
    type: "preference_changed", eventId: "sparse-artist-more", targetType: "artist", targetKey: target.artist,
    artist: target.artist, value: "more", scope: "artist", createdAt: Date.now(),
  };
  const empty = retainedEvidenceMemory();
  const more = intelligence.recordListeningEvent(empty, event);
  const less = intelligence.recordListeningEvent(empty, { ...event, eventId: "sparse-artist-less", value: "less" });
  const scores = [];
  for (const memory of [empty, more, less]) {
    const h = harness({ memory });
    const before = h.shown();
    h.context.experimentPool = fixtures.slice(0, 32);
    await h.handlers.refreshRecommendations("feedback");
    await h.flush();
    const rankedScores = h.context.recommendationScoresRef.current;
    assert.ok(fixtures.slice(24,32).every(item=>rankedScores.has(identity(qqTrack(item)))), "all eight unseen acquired candidates must use unified scoring");
    const score = rankedScores.get(intelligence.canonicalTrackKey("qq", target.title));
    assert.ok(score);
    scores.push(score.totalScore);
    if (memory === more) assert.equal(h.context.recommendationPoolsRef.current.match.hidden[0],identity(qqTrack(target)));
    assertStable(h, before);
  }
  assert.ok(scores[1] > scores[0], "positive feedback must promote the sparse-catalog candidate");
  assert.ok(scores[2] < scores[0], "negative feedback must demote the sparse-catalog candidate");
});

test("one rejected catalog search does not discard the remaining playable initial batch", async () => {
  const h = harness();
  h.context.setRecommendationTracks({});
  h.context.recommendationTracksRef.current = {};
  h.context.discoveryTracksRef.current = {};
  h.context.setMatchedExperiments([]); h.context.setVisibleExperiments([]); h.visibleWrites.length = 0;
  h.storage.set("codio-recommendation-history", "[]");
  const search=h.context.window.codioDesktop.qqMusic.search;
  h.context.window.codioDesktop.qqMusic.search = async (query,page) => {
    if (query==="Known Artist") throw new Error("one acquisition seed failed temporarily");
    return (await search(query,page)).filter(item=>item.mid!=="Track 0");
  };
  h.handlers.resolveCatalog();
  await h.flush();
  assert.equal(h.shown().matched.length, 12);
  assert.equal(h.shown().frontier.length, 12);
  assert.equal(h.context.recommendationTracks[identity(fixtures[0])], undefined);
  assert.equal(Object.keys(h.context.recommendationTracks).length, 71);
});

test("feedback during first catalog load may fill empty pages but never replaces a displayed batch", async () => {
  const h = harness();
  h.context.setRecommendationTracks({});
  h.context.recommendationTracksRef.current = {};
  h.context.setMatchedExperiments([]); h.context.setVisibleExperiments([]); h.visibleWrites.length = 0;
  h.storage.set("codio-recommendation-history", "[]");
  h.handlers.resolveCatalog();
  await h.flush();
  assert.equal(h.shown().matched.length, 12);
  assert.equal(h.shown().frontier.length, 12);
  assert.deepEqual(h.visibleWrites, ["matched", "frontier"]);
  h.visibleWrites.length = 0;
  const before = h.shown();
  await h.handlers.refreshRecommendations("feedback");
  await h.flush();
  assertStable(h, before);
});

test("automatic sync fills a partial initial frontier without replacing the first eighteen songs", async () => {
  const h = harness();
  const initial = h.shown();
  h.context.setVisibleExperiments(initial.frontier.slice(0, 6));
  h.visibleWrites.length = 0;
  const firstEighteen = [...h.shown().matched, ...h.shown().frontier].map(identity);
  h.handlers.resolveCatalog();
  await h.flush();
  assert.equal(h.shown().matched.length, 12);
  assert.equal(h.shown().frontier.length, 12);
  assert.deepEqual([...h.shown().matched, ...h.shown().frontier.slice(0, 6)].map(identity), firstEighteen);
  assert.equal(new Set([...h.shown().matched, ...h.shown().frontier].map(identity)).size, 24);
});

test("settled completion and active skip schedule learning; failures and manual searches do not", async () => {
  for (const [reason, seconds, learns] of [["ended",220,true],["skip",20,true],["error",20,false],["switch",0,false]]) {
    const h=harness(); const before=h.shown();
    const event={type:"play_settled",eventId:`case-${reason}`,sessionId:h.memory().currentSession.sessionId,trackKey:"qq:heard",provider:"qq",providerTrackId:"heard",title:"Heard",artist:"Singer",startedAt:Date.now()-300000,settledAt:Date.now(),listenedSeconds:seconds,durationSeconds:240,completionRatio:seconds/240,exitReason:reason,source:"queue",metadataConfidence:.95};
    h.handlers.updateListeningMemory(event); h.handlers.updateListeningMemory(event);
    assert.equal(h.memory().rawEvents.length,1,"same settlement must not count twice");
    assert.equal(h.timers.length,learns?1:0);
    await h.flush(); assertStable(h,before);
    if(learns){
      const latest=h.context.recommendationUpdateRef.current.latest;
      assert.ok(latest.lanes.every(lane=>lane.playableCandidateCount>0),"the learning event must trigger actual independent acquisition/scoring");
      assert.ok(latest.lanes.every(lane=>lane.visibleBatchPreserved));
    }
  }
});

test("short bursts debounce once, invalidate old revisions immediately and commit diagnostic facts", async () => {
  const h=harness();const before=h.shown();
  h.handlers.recordCurrentPreference("like");
  h.handlers.updateTonightIntent("familiarity","explore");
  h.handlers.correctProfileHypothesis("unknown","reject");
  assert.equal(h.context.recommendationUpdateRef.current.latest.status,"queued");
  assert.equal(h.context.recommendationUpdateRef.current.latest.hiddenQueueCommitted,false);
  assert.equal(h.timers.filter(timer=>!timer.cancelled).length,1);
  await h.flush();assertStable(h,before);
  const record=h.context.window.codioRecommendationDiagnostics.at(-1);
  assert.equal(record.status,"completed");
  assert.equal(record.visibleBatchPreserved,true);assert.ok(record.playableCandidateCount>0);
  assert.ok(record.admission.every(item=>item.evidence[record.lane]),"coalescing events cannot bypass the real evidence gate");
  assert.ok(h.context.window.codioRecommendationDiagnostics.some(item=>["preference_changed","session_intent_changed","profile_corrected"].every(trigger=>item.triggerEvents.includes(trigger))),"the coalesced request must retain all original learning triggers even if later metadata schedules a new update");
  assert.ok(Number.isFinite(record.durationMs));assert.doesNotMatch(JSON.stringify(record),/api.key|cookie|聊天正文/i);
});

test("background rerank preserves current, played prefix, visible 24, manual Next and promised transition", async () => {
  const h=harness();const before=h.shown();
  const manual=qqTrack({...fixtures[60],title:"Manual request"});const incoming=qqTrack({...fixtures[61],title:"Promised incoming"});
  const prefix=[qqTrack(fixtures[0]),incoming,manual,...[...before.matched.slice(1),...before.frontier].map(qqTrack)];
  h.context.playQueueRef.current=[...prefix,qqTrack(fixtures[24])];h.context.manualQueueIdsRef.current.add(manual.mid);
  h.context.activeTransitionRef.current={incomingSnapshot:{track:incoming}};
  await h.handlers.refreshRecommendations("feedback");
  assert.deepEqual(h.context.playQueueRef.current.slice(0,prefix.length),prefix);assert.equal(h.context.activeQueueIndexRef.current,0);
  assert.ok(h.context.playQueueRef.current.length>prefix.length);assertStable(h,before);
});

test("unknown sound fields remain unknown even when legacy catalog values and artist hints exist", async () => {
  const h=harness();const candidate=h.handlers.candidateForExperiment(fixtures[24],new Set());
  assert.equal(candidate.featureVector.energy.value,null);assert.equal(candidate.featureVector.energy.confidence,0);
  assert.equal(candidate.featureVector.vocalFocus.value,null);assert.equal(candidate.featureVector.instrumentalFocus.value,null);
  assert.equal(candidate.featureVector.novelty.source,"library_behavior");assert.equal(candidate.featureVector.tags.every(tag=>!tag.profileEligible),true);
  await h.handlers.refreshRecommendations("feedback");
  const score=intelligence.scoreCandidate(candidate,intelligence.deriveListeningProfile(h.memory()),h.memory(),"match");
  assert.equal(score.contributions.find(item=>item.key==="sequence_fit").signedWeight,0);
  assert.equal(score.contributions.find(item=>item.key==="long_term_affinity").signedWeight,0);
});

test("repeated manual refresh does not cycle two batches; exhaustion keeps the last good 24", async () => {
  const h=harness();const pages=[h.shown()];
  await h.handlers.refreshRecommendations();pages.push(h.shown());await h.handlers.refreshRecommendations();pages.push(h.shown());
  assert.equal(new Set(pages.flatMap(page=>[...page.matched,...page.frontier].map(identity))).size,72);
  const last=h.shown();const result=await h.handlers.refreshRecommendations();
  assert.strictEqual(h.shown().matched,last.matched);assert.strictEqual(h.shown().frontier,last.frontier);
  assert.equal(result.status,"insufficient_candidates");assert.ok(result.lanes.every(lane=>lane.error==="INSUFFICIENT_QUALIFIED_CANDIDATES"));
});

test("old in-flight request cannot overwrite a just-recorded preference before the debounced rerank", async () => {
  const h=harness();const before=h.shown();const release=h.holdResolution();
  const older=h.handlers.refreshRecommendations();await turn();h.handlers.recordCurrentPreference("like");release();
  assert.equal((await older).status,"superseded");assertStable(h,before);await h.flush();assertStable(h,before);
  assert.ok(h.context.recommendationUpdateRef.current.latest.lanes.every(lane=>lane.profileVersion===h.memory().updatedAt));
});

test("real QQ identity samples do not pretend that Daniel and Frank share measured sound characteristics", () => {
  const samples=[
    {mid:"000KZkOT2dmYNm",title:"Valentina",artist:"Daniel Caesar",album:"Valentina"},
    {mid:"002zuwNj3JoRQk",title:"Always (Explicit)",artist:"Daniel Caesar",album:"NEVER ENOUGH (Explicit)"},
    {mid:"003yZX8R0EU0FG",title:"Pink + White",artist:"Frank Ocean",album:"Blonde"},
    {mid:"002GXR1Z0SGIbD",title:"Ivy (Explicit)",artist:"Frank Ocean",album:"Blonde"},
  ]; // Identified by read-only real QQ search on 2026-09-30. No fabricated audio features.
  const h=harness();const candidates=samples.map(track=>{
    const item={...track,reason:"QQ search verified identity",tags:[],color:"blue"};h.context.discoveryTracksRef.current[identity(item)]=track;
    return h.handlers.candidateForExperiment(item,new Set());
  });
  const before=h.memory();const after=intelligence.recordListeningEvent(before,{type:"preference_changed",eventId:"verified-daniel",targetType:"artist",targetKey:"Daniel Caesar",artist:"Daniel Caesar",value:"more",scope:"artist",createdAt:Date.now(),sessionId:before.currentSession.sessionId});
  const score=(item,memory)=>intelligence.scoreCandidate(item,intelligence.deriveListeningProfile(memory),memory,"match");
  assert.ok(score(candidates[0],after).totalScore>score(candidates[0],before).totalScore);
  assert.equal(score(candidates[2],after).totalScore,score(candidates[2],before).totalScore,"without song-level evidence a cross-artist boost would be fabricated");
  assert.deepEqual(score(candidates[2],after).contributions.map(item=>[item.key,item.signedWeight]),score(candidates[2],before).contributions.map(item=>[item.key,item.signedWeight]));
  candidates.forEach(item=>{
    assert.equal(item.featureVector.energy.value,null);assert.equal(item.featureVector.bpm.value,null);
    assert.equal(score(item,after).contributions.find(x=>x.key==="verified_track_similarity").signedWeight,0);
  });
});

test("new artist preferences beyond eighty candidates are fetched and scored without bypassing song-fit admission", async () => {
  const h=harness();const many=Array.from({length:200},(_,i)=>({...fixtures[0],title:`Large pool ${i}`,artist:`Artist ${i}`}));
  h.context.experimentPool=many;h.context.discoveryTracksRef.current=Object.fromEntries(many.map(item=>[identity(item),qqTrack(item)]));
  const target=many[180];h.handlers.updateListeningMemory({type:"preference_changed",eventId:"late-source",targetType:"artist",targetKey:target.artist,artist:target.artist,value:"more",scope:"artist",createdAt:Date.now(),sessionId:h.memory().currentSession.sessionId});
  await h.flush();
  assert.ok(h.context.recommendationScoresRef.current.has(intelligence.canonicalTrackKey("qq",target.title)));
  assert.ok(h.context.recommendationScoresRef.current.get(identity(qqTrack(target))).contributions.find(item=>item.key==="explicit_artist").signedWeight>0);
  const record=h.context.recommendationUpdateRef.current.latest.lanes.find(item=>item.lane==="match");
  assert.ok(record.seeds.some(seed=>seed.query===target.artist),"the new preference acquires its own exact artist target rather than scanning the old shared pool");
  assert.ok(record.excluded.some(item=>item.key===identity(qqTrack(target))&&item.reason==="INSUFFICIENT_LANE_EVIDENCE"),
    "a newly requested artist with only broad Pop evidence is not promoted into close match");
});

test("existing V3 disk evidence is consumed without decoding or inventing comparable energy", async () => {
  const h=harness();const item=fixtures[24];const track={...qqTrack(item),mid:"000KZkOT2dmYNm"};
  h.context.discoveryTracksRef.current[identity(item)]=track;
  let reads=0;h.context.window.codioDesktop.analysis={async get(id,version){if(id!==track.mid)return null;reads++;assert.equal(version,3);return {version:3,trackId:id,bpm:91,tempoConfidence:.4924254317138334,outroFocus:"full"};}};
  // Recorded Valentina V3 tempo evidence, not a made-up genre/energy fixture.
  await h.handlers.refreshRecommendations("feedback");assert.ok(reads>=1&&reads<=2,"two independently resolving lanes may share the same disk evidence, without unbounded reads");
  const vector=h.handlers.featureVectorForTrack(track);assert.equal(vector.bpm.value,91);assert.equal(vector.bpm.profileEligible,false);
  assert.equal(vector.energy.value,null);assert.equal(vector.vocalFocus.value,null);
  const score=h.context.recommendationScoresRef.current.get(intelligence.canonicalTrackKey("qq",track.mid));
  assert.equal(score.contributions.find(item=>item.key==="sequence_fit").signedWeight,0,"low tempo confidence must not become a strong match");
});

test("artist discovery rejects unrelated title hits but retains the named artist and collaborations", async () => {
  const h=harness();
  h.context.discoveryBridgeArtists={adjacent:["Warpaint"]};
  const actual={...qqTrack(fixtures[0]),mid:"verified-warpaint",title:"Love Is To Die",artist:"Warpaint"};
  const collaboration={...actual,mid:"verified-collaboration",title:"Collaboration",artist:"Warpaint / Another artist"};
  const unrelated={...actual,mid:"wrong-title-match",title:"War Paint",artist:"Smokin Gunn"};
  h.context.window.codioDesktop.qqMusic.search=async query=>query==="Warpaint"?[actual,collaboration,unrelated]:[];
  h.handlers.updateListeningMemory({type:"preference_changed",eventId:"artist-identity-check",targetType:"artist",targetKey:"Warpaint",artist:"Warpaint",value:"more",scope:"artist",createdAt:Date.now(),sessionId:h.memory().currentSession.sessionId});
  await h.flush();
  assert.equal(h.context.discoveryTracksRef.current[identity(unrelated)],undefined);
  assert.equal(h.context.discoveryTracksRef.current[identity(actual)].mid,actual.mid);
  assert.equal(h.context.discoveryTracksRef.current[identity(collaboration)].mid,collaboration.mid);
  assert.equal(h.context.recommendationScoresRef.current.has(intelligence.canonicalTrackKey("qq",unrelated.mid)),false);
});

test("QQ library discovery applies the same artist identity filter before requesting a rerank", async () => {
  const h=harness();h.context.discoveryBridgeArtists={adjacent:["Warpaint"]};
  h.context.qqAuthorizationRevisionRef={current:0};
  const actual={...qqTrack(fixtures[0]),mid:"verified-warpaint",title:"Love Is To Die",artist:"Warpaint"};
  const unrelated={...actual,mid:"unrelated",title:"War Paint",artist:"Smokin Gunn"};
  h.context.window.codioDesktop.qqMusic.library=async()=>({playlists:[],tracks:[actual],playlistNames:[],likedCount:0,topArtists:[{name:"Warpaint",weight:1}]});
  h.context.window.codioDesktop.qqMusic.search=async query=>query.toLowerCase()==="warpaint"?[actual,unrelated]:[];
  assert.ok(await h.handlers.syncQQTaste());
  assert.deepEqual([...h.context.recommendationUpdateRef.current.triggers],["qq_library_synced"]);
  assert.equal(h.searchCalls.length,0,"sync must not populate one randomized shared acquisition list");
  await h.flush();
  assert.equal(h.context.discoveryTracksRef.current[identity(unrelated)],undefined);
  assert.equal(h.context.discoveryTracksRef.current[identity(actual)].mid,actual.mid);
});

test("explicit instrumental version is bounded downranking, not a fabricated vocal ratio or missing-lyrics inference", () => {
  const h=harness();const base=h.handlers.candidateForExperiment(fixtures[24],new Set());
  const score=title=>intelligence.scoreCandidate({...base,track:{...base.track,title}},intelligence.deriveListeningProfile(h.memory()),h.memory(),"match",1000);
  const ordinary=score("Blessed"),instrumental=score("Blessed (纯音乐)");
  assert.equal(base.featureVector.vocalFocus.value,null);
  assert.equal(ordinary.contributions.find(x=>x.key==="instrumental_version").signedWeight,0);
  assert.equal(instrumental.contributions.find(x=>x.key==="instrumental_version").signedWeight,-.765);
  assert.equal(score("Who Hurt You?纯音乐").contributions.find(x=>x.key==="instrumental_version").signedWeight,-.765,"actual QQ title also marks the version without parentheses");
  assert.ok(Number.isFinite(instrumental.totalScore));
  assert.equal(score("A song without fetched lyrics").contributions.find(x=>x.key==="instrumental_version").signedWeight,0);
});

test("actual REFRESH handlers own separate seeds, cursors, exposures, batches and hidden continuations",async()=>{
  const h=harness(),before=h.shown();
  const frontierBefore=JSON.stringify(h.context.recommendationPoolsRef.current.frontier);
  const upper=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
  assert.equal(upper.lanes.length,1);assert.equal(upper.lanes[0].lane,"match");assert.equal(upper.visibleCommitted,true);
  assert.strictEqual(h.shown().frontier,before.frontier);assert.equal(JSON.stringify(h.context.recommendationPoolsRef.current.frontier),frontierBefore);
  assert.ok(upper.lanes[0].seeds.some(seed=>seed.strategy==="verified_artist_works"));
  const matchBefore=JSON.stringify(h.context.recommendationPoolsRef.current.match),shownMatch=h.shown().matched;
  const lower=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"frontier");
  assert.equal(lower.lanes.length,1);assert.equal(lower.visibleCommitted,true);assert.strictEqual(h.shown().matched,shownMatch);
  assert.equal(JSON.stringify(h.context.recommendationPoolsRef.current.match),matchBefore);
  assert.ok(lower.lanes[0].seeds.every(seed=>seed.strategy==="adjacent_verified_style"));
  const pools=h.context.recommendationPoolsRef.current;
  assert.equal(pools.match.cursor,1);assert.equal(pools.frontier.cursor,1);
  assert.equal([...pools.match.visible,...pools.match.hidden].some(key=>[...pools.frontier.visible,...pools.frontier.hidden].includes(key)),false);
  assert.ok(upper.lanes[0].admission.every(item=>item.sources.some(source=>source.startsWith("match:"))));
  assert.ok(lower.lanes[0].admission.every(item=>item.sources.some(source=>source.startsWith("frontier:"))));
});

test("actual acquisition timeout in one lane leaves that batch intact while the other REFRESH succeeds",async()=>{
  const h=harness(),before=h.shown(),search=h.context.window.codioDesktop.qqMusic.search;
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{
    if(query.toLowerCase()==="known artist"||query==="neo-soul")throw new Error("isolated upper seed timeout");
    return search(query,page);
  };
  const result=await h.handlers.refreshRecommendations("manual");
  assert.equal(result.lanes.find(item=>item.lane==="match").status,"failed");
  assert.equal(result.lanes.find(item=>item.lane==="frontier").status,"completed");
  assert.strictEqual(h.shown().matched,before.matched);assert.notStrictEqual(h.shown().frontier,before.frontier);
  assert.deepEqual(h.visibleWrites,["frontier"]);
});

test("concurrent manual REFRESH in different lanes does not supersede the other request",async()=>{
  const h=harness(),release=h.holdResolution();
  const upper=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");await turn();
  const lower=h.handlers.refreshRecommendations("manual",undefined,["manual"],"frontier");await turn();release();
  const results=await Promise.all([upper,lower]);
  assert.ok(results.every(result=>result.status==="completed"));
  assert.ok(results.every(result=>result.visibleCommitted));
  assert.equal(h.context.recommendationPoolsRef.current.match.revision,1);assert.equal(h.context.recommendationPoolsRef.current.frontier.revision,1);
});

test("empty high acquisition pages retry the same query once and still use actual lane qualification",async()=>{
  const h=qualifiedLaneHarness(),before=h.shown(),other=JSON.stringify(h.context.recommendationPoolsRef.current.frontier);
  const search=h.context.window.codioDesktop.qqMusic.search,calls=[];
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{
    calls.push({query,page});return page>1?[]:search(query,page);
  };
  const result=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match"),lane=result.lanes[0];
  assert.equal(lane.acquisitionCursor,8,"one retrieval owns eight seed positions, not one overlapping position");
  assert.equal(lane.visibleCommitted,true);assert.equal(h.shown().matched.length,12);
  assert.ok(lane.seeds.length>0&&lane.seeds.every(seed=>seed.page>1));
  for(const seed of lane.seeds){
    assert.deepEqual(seed.searchedPages,[seed.page,1]);
    assert.equal(calls.filter(call=>call.query===seed.query&&call.page===1).length,1);
  }
  assert.ok(lane.admission.every(item=>item.evidence.match===true),"fallback never bypasses the final evidence gate");
  assert.strictEqual(h.shown().frontier,before.frontier);assert.equal(JSON.stringify(h.context.recommendationPoolsRef.current.frontier),other);
});

test("artist-filtered high-page hits also recover, without admitting unknown or unrelated first-page songs",async()=>{
  const h=qualifiedLaneHarness(),search=h.context.window.codioDesktop.qqMusic.search;
  const unrelated={provider:"qq",mid:"unknown-sound",title:"Known Artist",artist:"Unrelated artist",durationSeconds:240};
  const named={...unrelated,mid:"credited-known",title:"Verified own work",artist:"Known Artist",genres:["neo-soul"]};
  const metadata=h.context.window.codioDesktop.qqMusic.metadata;
  h.context.window.codioDesktop.qqMusic.metadata=async mid=>mid===unrelated.mid?{ok:false}
    :mid===named.mid?{ok:true,mid,source:"provider_metadata",genres:["neo-soul"]}:metadata(mid);
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{
    if(query.toLowerCase()==="known artist")return page>1?[unrelated]:[named,unrelated];
    return page>1?[]:[...await search(query,page),unrelated];
  };
  const result=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match"),lane=result.lanes[0];
  const artistSeed=lane.seeds.find(seed=>seed.query.toLowerCase()==="known artist");
  assert.deepEqual(artistSeed.searchedPages,[artistSeed.page,1]);assert.equal(artistSeed.returned,1);
  assert.ok(lane.excluded.some(item=>item.key==="qq:unknown-sound"&&item.reason==="INSUFFICIENT_LANE_EVIDENCE"));
  assert.ok(!h.context.recommendationPoolsRef.current.match.candidates.some(item=>item.canonicalKey==="qq:unknown-sound"));
  assert.ok(h.context.recommendationPoolsRef.current.match.candidates.some(item=>item.canonicalKey==="qq:credited-known"));
});

test("a nonempty accepted high page is not refetched from page one",async()=>{
  const h=qualifiedLaneHarness(),result=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
  const seed=result.lanes[0].seeds.find(item=>item.query==="neo-soul");
  assert.ok(seed.page>1&&seed.returned>0);assert.deepEqual(seed.searchedPages,[seed.page]);
  assert.equal(h.searchCalls.filter(call=>call.query===seed.query&&call.page===1).length,0);
});

test("a failed first-page recovery cannot clear one lane or block the other lane's refresh",async()=>{
  const h=harness(),before=h.shown(),search=h.context.window.codioDesktop.qqMusic.search;
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{
    if(page>1)return [];
    if(query.toLowerCase()==="known artist"||query==="neo-soul")throw new Error("isolated first-page recovery unavailable");
    return search(query,page);
  };
  const result=await h.handlers.refreshRecommendations("manual");
  assert.equal(result.lanes.find(item=>item.lane==="match").status,"failed");
  assert.equal(result.lanes.find(item=>item.lane==="frontier").status,"completed");
  assert.strictEqual(h.shown().matched,before.matched);assert.equal(h.shown().frontier.length,12);
  assert.notStrictEqual(h.shown().frontier,before.frontier);assert.deepEqual(h.visibleWrites,["frontier"]);
});

test("recovery stays inside the two-worker acquisition limit with at most one retry per seed",async()=>{
  const h=qualifiedLaneHarness(),search=h.context.window.codioDesktop.qqMusic.search,calls=[];let active=0,maximum=0;
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{
    active++;maximum=Math.max(maximum,active);calls.push({query,page});
    try{await turn();return page>1?[]:search(query,page);}finally{active--;}
  };
  const result=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");
  assert.equal(maximum,2);assert.equal(active,0);assert.equal(calls.length,result.lanes[0].seeds.length*2);
  assert.equal(result.lanes[0].status,"completed");
});

test("obsolete high-page work cannot start a first-page retry or commit after newer evidence",async()=>{
  const h=qualifiedLaneHarness(),before=h.shown(),calls=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  h.context.window.codioDesktop.qqMusic.search=async(query,page)=>{calls.push({query,page});await gate;return [];};
  const pending=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");await turn();
  assert.equal(calls.length,2);h.context.recommendationUpdateRef.current.revision++;release();
  const result=await pending;assert.equal(result.status,"superseded");
  assert.ok(calls.every(call=>call.page>1));assert.equal(calls.length,2);assertStable(h,before);
});

test("artist identity matches full collaboration credits as well as an individual credited artist",()=>{
  const h=harness(),matches=h.handlers.recommendationArtistMatches;
  assert.equal(matches("  Yussef Dayes & Rocco Palladino  ","yussef dayes & rocco palladino"),true);
  assert.equal(matches("Yussef Dayes / Rocco Palladino","Rocco Palladino"),true);
  assert.equal(matches("Yussef Dayes & Rocco Palladino","Yussef Dayes"),true);
  assert.equal(matches("Unrelated performer","Yussef Dayes & Rocco Palladino"),false);
});

for(const bootPhase of ["playing","done"]) test(`${bootPhase} continuation only fills the incomplete lane and preserves every already displayed card`,async()=>{
  const h=harness();h.context.bootPhase=bootPhase;
  const prefix=h.shown().matched.slice(0,11);h.context.setMatchedExperiments(prefix);h.visibleWrites.length=0;
  h.context.recommendationPoolsRef.current.match.status="insufficient_candidates";
  const otherBefore=JSON.stringify(h.context.recommendationPoolsRef.current.frontier),otherShown=h.shown().frontier;
  const result=await h.handlers.refreshRecommendations("feedback",undefined,["continuation"]);
  assert.deepEqual(result.lanes.map(lane=>lane.lane),["match"]);assert.equal(h.shown().matched.length,12);
  assert.deepEqual(h.shown().matched.slice(0,11),prefix);assert.strictEqual(h.shown().frontier,otherShown);
  assert.equal(JSON.stringify(h.context.recommendationPoolsRef.current.frontier),otherBefore);
  assert.deepEqual(h.visibleWrites,["matched"]);assert.equal(result.lanes[0].acquisitionCursor,8);
  const searches=h.searchCalls.length,matchPool=JSON.stringify(h.context.recommendationPoolsRef.current.match);
  const complete=await h.handlers.refreshRecommendations("feedback",undefined,["continuation"]);
  assert.deepEqual(complete.lanes,[]);assert.equal(h.searchCalls.length,searches,"a complete startup has no extra acquisition");
  assert.equal(JSON.stringify(h.context.recommendationPoolsRef.current.match),matchPool);
});

export async function runIndependentPoolEvidence() {
  const h=harness();
  const snapshot=()=>Object.fromEntries(["match","frontier"].map(lane=>{const pool=h.context.recommendationPoolsRef.current[lane];return [lane,{
    cursor:pool.cursor,revision:pool.revision,profileVersion:pool.profileVersion,status:pool.status,
    candidateIds:pool.candidates.map(item=>item.canonicalKey),visibleIds:[...pool.visible],hiddenIds:[...pool.hidden],exposureIds:[...pool.exposure],error:pool.error}];}));
  const initial=snapshot();
  const upper=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match"),afterUpper=snapshot();
  assert.deepEqual(afterUpper.frontier,initial.frontier);
  const lower=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"frontier"),afterLower=snapshot();
  assert.deepEqual(afterLower.match,afterUpper.match);
  const intersection=afterLower.match.candidateIds.filter(id=>afterLower.frontier.candidateIds.includes(id));assert.deepEqual(intersection,[]);
  const beforePreference=snapshot();
  h.handlers.updateListeningMemory({type:"preference_changed",eventId:"pool-proof-artist-preference",targetType:"artist",targetKey:"Artist 40",artist:"Artist 40",value:"more",scope:"artist",source:"dj",createdAt:Date.now(),sessionId:h.memory().currentSession.sessionId});
  await h.flush();const afterPreference=snapshot();
  assert.deepEqual(afterPreference.match.visibleIds,beforePreference.match.visibleIds);assert.deepEqual(afterPreference.frontier.visibleIds,beforePreference.frontier.visibleIds);
  assert.equal(afterPreference.match.hiddenIds[0],"qq:Track 40");
  const prefRecords=h.context.window.codioRecommendationDiagnostics.filter(item=>item.profileVersion===h.memory().updatedAt);
  const beforeSecondUpper=snapshot(),secondUpper=await h.handlers.refreshRecommendations("manual",undefined,["manual"],"match"),afterSecondUpper=snapshot();
  assert.deepEqual(afterSecondUpper.frontier,beforeSecondUpper.frontier);assert.notDeepEqual(afterSecondUpper.match.visibleIds,beforeSecondUpper.match.visibleIds);
  const release=h.holdResolution(),older=h.handlers.refreshRecommendations("manual",undefined,["manual"],"frontier");await turn();
  h.handlers.updateTonightIntent("flow","varied");release();const stale=await older;assert.equal(stale.status,"superseded");await h.flush();
  const failureHarness=harness(),failureBefore=JSON.stringify(failureHarness.shown().matched),search=failureHarness.context.window.codioDesktop.qqMusic.search;
  failureHarness.context.window.codioDesktop.qqMusic.search=async(query,page)=>{if(query.toLowerCase()==="known artist"||query==="neo-soul")throw new Error("isolated upper acquisition failure");return search(query,page);};
  const failure=await failureHarness.handlers.refreshRecommendations("manual");
  assert.equal(failure.lanes.find(item=>item.lane==="match").status,"failed");assert.equal(failure.lanes.find(item=>item.lane==="frontier").visibleCommitted,true);
  assert.equal(JSON.stringify(failureHarness.shown().matched),failureBefore);
  const diagnostic=result=>result.lanes.map(lane=>({lane:lane.lane,status:lane.status,seeds:lane.seeds||[],candidateCount:lane.candidateCount||0,
    playableCandidateCount:lane.playableCandidateCount||0,poolCandidateIds:lane.poolCandidateIds||[],admission:lane.admission||[],excluded:lane.excluded||[],
    otherPoolIntersection:lane.otherPoolIntersection??null,visibleBefore:lane.visibleBefore||[],visibleAfter:lane.visibleAfter||[],hiddenIds:lane.hiddenIds||[],
    cursor:lane.cursor,revision:lane.revision,profileVersion:lane.profileVersion,visibleCommitted:lane.visibleCommitted||false,hiddenQueueCommitted:lane.hiddenQueueCommitted||false,error:lane.error||null}));
  return {mode:"isolated_actual_renderer_handlers",scope:"synthetic identity and provider-metadata fixtures; actual RadioExperience handlers and actual intelligence functions; no real QQ, DeepSeek or audio playback acceptance",
    stages:{initial,upperRefresh:{diagnostic:diagnostic(upper),after:afterUpper,otherCompletelyUnchanged:true},
      lowerRefresh:{diagnostic:diagnostic(lower),after:afterLower,otherCompletelyUnchanged:true},candidatePoolIntersection:intersection,
      preferenceUpdate:{before:beforePreference,after:afterPreference,visible24Preserved:true,recordedPreference:intelligence.activePreferences(h.memory()).find(item=>item.eventId==="pool-proof-artist-preference"),
        laneRecords:prefRecords.map(item=>({lane:item.lane,revision:item.revision,profileVersion:item.profileVersion,status:item.status,hiddenIds:item.hiddenIds,hiddenQueueCommitted:item.hiddenQueueCommitted}))},
      secondUpperRefresh:{diagnostic:diagnostic(secondUpper),before:beforeSecondUpper,after:afterSecondUpper,otherCompletelyUnchanged:true},
      failureIsolation:{diagnostic:diagnostic(failure),failedLaneVisiblePreserved:true,otherLaneSucceeded:true},
      staleRequest:{status:stale.status,lanes:stale.lanes.map(item=>({lane:item.lane,status:item.status,error:item.error,revision:item.revision})),newEvidenceRevision:h.context.recommendationUpdateRef.current.revision}},
    note:"candidate count is not buffered audio; prepareTrack and provider services are bounded isolated mocks. No user library, credentials, keys or history were read."};
}

test("isolated proof records actual independent acquisition, ownership, refresh, feedback and stale cancellation",async()=>{
  const evidence=await runIndependentPoolEvidence();
  assert.equal(evidence.stages.upperRefresh.otherCompletelyUnchanged,true);assert.equal(evidence.stages.lowerRefresh.otherCompletelyUnchanged,true);
  assert.deepEqual(evidence.stages.candidatePoolIntersection,[]);assert.equal(evidence.stages.preferenceUpdate.visible24Preserved,true);
  assert.equal(evidence.stages.failureIsolation.otherLaneSucceeded,true);assert.equal(evidence.stages.staleRequest.status,"superseded");
});

test("a non-learning memory update ends its superseded pool request instead of leaving boot blocked by pending",async()=>{
  const h=harness(),before=h.shown(),release=h.holdResolution();
  const older=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");await turn();
  const revision=h.context.recommendationUpdateRef.current.revision;
  h.handlers.updateListeningMemory({type:"manual_intent",eventId:"nonlearning-play-during-refresh",sessionId:h.memory().currentSession.sessionId,
    trackKey:"qq:manual-selection",action:"play",createdAt:h.memory().updatedAt+1});
  assert.equal(h.context.recommendationUpdateRef.current.revision,revision,"a manual play is not an automatic preference-learning event");
  assert.equal(h.timers.filter(timer=>!timer.cancelled).length,0,"there is no queued rerank to rescue a stuck pending flag");
  release();const result=await older;
  assert.equal(result.status,"superseded");
  const pool=h.context.recommendationPoolsRef.current.match;
  assert.equal(pool.status,"failed");assert.equal(pool.error,"NEWER_EVIDENCE_OR_LANE_REQUEST");
  assertStable(h,before);
});

test("a superseded old request cannot terminate the newer revision's pending pool or loading state",async()=>{
  const h=harness(),before=h.shown();let releaseOld,releaseNew;
  h.context.bootPhase="playing";h.context.bootMusicTask.frontier="Restoring taste frontier…";
  const oldGate=new Promise(resolve=>{releaseOld=resolve;}),newGate=new Promise(resolve=>{releaseNew=resolve;});
  let loading={match:false,frontier:false};h.context.setRecommendationLoading=next=>{loading=typeof next==="function"?next(loading):next;};
  h.context.prepareTrack=async track=>{const revision=h.context.recommendationPoolsRef.current.match.revision;await (revision===1?oldGate:newGate);return {coverData:`test:${track.mid}`};};
  const older=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");await turn();
  const newer=h.handlers.refreshRecommendations("manual",undefined,["manual"],"match");await turn();
  const tasksBeforeOldFinishes=h.bootTaskUpdates.length;assert.equal(h.context.bootMusicTask.match,"Checking playback links and covers…");
  releaseOld();assert.equal((await older).status,"superseded");
  assert.equal(h.bootTaskUpdates.length,tasksBeforeOldFinishes,"an obsolete revision cannot publish or clear the newer lane task");
  assert.equal(h.context.bootMusicTask.match,"Checking playback links and covers…");assert.equal(h.context.bootMusicTask.frontier,"Restoring taste frontier…");
  assert.equal(h.context.recommendationPoolsRef.current.match.revision,2);
  assert.equal(h.context.recommendationPoolsRef.current.match.status,"pending");assert.equal(loading.match,true);
  assertStable(h,before);
  releaseNew();const result=await newer;assert.equal(result.visibleCommitted,true);
  assert.equal(h.context.recommendationPoolsRef.current.match.status,"completed");assert.equal(loading.match,false);
  assert.equal(h.context.bootMusicTask.match,"");assert.equal(h.context.bootMusicTask.frontier,"Restoring taste frontier…");
});

for(const [name,poolHistory,legacyHistory] of [
  ["malformed pool JSON","{broken", "[]"],
  ["non-array object exposure",JSON.stringify({cursor:4,exposure:{unexpected:true}}),"[]"],
  ["non-array string exposure",JSON.stringify({cursor:3,exposure:"qq:Track 1"}),"[]"],
  ["malformed legacy exposure",JSON.stringify({cursor:0,exposure:[]}),"{broken-legacy"],
  ["non-array legacy exposure",JSON.stringify({cursor:0,exposure:[]}),JSON.stringify({unexpected:true})],
]) {
  test(`${name} cannot permanently fail an initial independent candidate acquisition`,async()=>{
    const h=harness(),memoryBefore=JSON.stringify(h.memory());
    h.context.setMatchedExperiments([]);h.context.setVisibleExperiments([]);h.visibleWrites.length=0;
    h.storage.set("codio-recommendation-pool-v1-match",poolHistory);h.storage.set("codio-recommendation-pool-v1-frontier",poolHistory);
    h.storage.set("codio-recommendation-history",legacyHistory);
    const result=await h.handlers.refreshRecommendations("sync");
    assert.equal(result.status,"completed");assert.ok(result.lanes.every(lane=>lane.status==="completed"));
    assert.equal(h.shown().matched.length,12);assert.equal(h.shown().frontier.length,12);
    assert.equal(JSON.stringify(h.memory()),memoryBefore,"history parsing cannot reset or rewrite the listening evidence");
    assert.equal(h.storage.get("codio-recommendation-history"),legacyHistory,"the old source record is not cleared or overwritten");
    for(const lane of ["match","frontier"]) {
      const saved=JSON.parse(h.storage.get(`codio-recommendation-pool-v1-${lane}`));
      assert.ok(Array.isArray(saved.exposure));assert.ok(saved.exposure.every(key=>typeof key==="string"));
      assert.equal(saved.exposure.length,12);assert.ok(Number.isInteger(saved.cursor));
    }
  });
}
