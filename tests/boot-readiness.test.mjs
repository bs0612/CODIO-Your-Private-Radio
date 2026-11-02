import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run the actual effect callbacks with deferred resources. These tests neither
// clear real data nor equate a CSS class string with readiness.
const source=await readFile(new URL("../app/RadioExperience.tsx",import.meta.url),"utf8");
const ast=ts.createSourceFile("RadioExperience.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),effects=[],functions=new Map(),callbacks=new Map(),clicks=[],recommendationArticles=[];
let bootElement;
(function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==="useEffect"&&node.arguments[0])effects.push(node.arguments[0].getText(ast));
  if(ts.isFunctionDeclaration(node)&&node.name)functions.set(node.name.text,node.getText(ast));
  if(ts.isVariableDeclaration(node)&&node.initializer){
    const initializer=ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(ast)==="useCallback"?node.initializer.arguments[0]:node.initializer;
    callbacks.set(node.name.getText(ast),initializer.getText(ast));
  }
  if(ts.isJsxAttribute(node)&&node.name.getText(ast)==="onClick"&&node.initializer&&ts.isJsxExpression(node.initializer)){
    const opening=node.parent.parent;
    clicks.push({opening:opening.getText(ast),element:opening.parent.getText(ast),callback:node.initializer.expression.getText(ast)});
  }
  if(ts.isJsxElement(node)&&node.openingElement.getText(ast).includes('className={`codio-boot'))bootElement=node.getText(ast);
  if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==="article"){
    const attribute=node.openingElement.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.getText(ast)==="className");
    if(attribute?.initializer&&ts.isStringLiteral(attribute.initializer)){
      (function findLane(child){
        if(ts.isCallExpression(child)&&child.expression.getText(ast)==="renderRecommendationPages"&&child.arguments[1]&&ts.isStringLiteral(child.arguments[1]))
          recommendationArticles.push({lane:child.arguments[1].text,classes:new Set(attribute.initializer.text.split(/\s+/))});
        ts.forEachChild(child,findLane);
      })(node);
    }
  }
  ts.forEachChild(node,visit);
})(ast);
function bind(code,context){
  const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function("context",`with(context){${js}}`)(context);
}
function handler(name,context){
  if(functions.has(name))return bind(`${functions.get(name)};return ${name};`,context);
  assert.ok(callbacks.has(name),`Missing production callback ${name}`);
  return bind(`const handler=${callbacks.get(name)};return handler;`,context);
}
function effect(marker,context){
  const matching=effects.filter(text=>text.includes(marker));assert.equal(matching.length,1,marker);
  return bind(`const effect=${matching[0]};return effect;`,context);
}
function click(marker,context,matchElement=false){
  const matching=clicks.filter(item=>(!matchElement||item.opening.startsWith("<button"))&&(matchElement?item.element:item.opening).includes(marker));
  assert.equal(matching.length,1,`Exactly one actual click handler must match ${marker}`);
  return bind(`return ${matching[0].callback};`,context);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
function renderBoot(context){
  assert.ok(bootElement,"bind the actual preparation page JSX");
  const stageContext={...context};
  for(const name of ["bootShownTracks","bootLiveSources","bootActiveMusicTask","bootRecommendationsUnavailable","bootPreparationStage"])
    stageContext[name]=bind(`return (${callbacks.get(name)});`,stageContext);
  const js=ts.transpileModule(`const element=${bootElement};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}}).outputText;
  return new Function("context",`with(context){${js};return element;}`)({...stageContext,SafeRecommendationCover:()=>null,
    bootProgress:{value:0,maximum:34},React:{createElement:(type,props,...children)=>({type,props,children})}});
}
function elements(tree,type){
  if(!tree||typeof tree!=="object")return [];
  if(Array.isArray(tree))return tree.flatMap(item=>elements(item,type));
  return [...(tree.type===type?[tree]:[]),...(tree.children||[]).flatMap(item=>elements(item,type))];
}
function matchesArticle(classes,selector){
  const excluded=selector.match(/:not\((\.[\w-]+)\)$/)?.[1],base=selector.replace(/:not\(\.[\w-]+\)$/," ").trim();
  if(!/^(\.[\w-]+)+$/.test(base))return false;
  return [...base.matchAll(/\.([\w-]+)/g)].every(match=>classes.has(match[1]))&&(!excluded||!classes.has(excluded.slice(1)));
}

function readiness(overrides={},resources=[]){
  const frames=[],timers=[],readyValues=[],errors=[],phases=[],selectors=[];let imageReads=0;
  const images=resources.map((resource,index)=>resource.decode?resource:{src:`/fixture-${index}.png`,complete:false,naturalWidth:0,
    decode(){return resource.promise.then(()=>{this.complete=true;this.naturalWidth=300;});}});
  const matched=Array.from({length:12},(_,i)=>({provider:"qq",id:`match-${i}`,title:`Match ${i}`,artist:`Artist ${i}`}));
  const frontier=Array.from({length:12},(_,i)=>({provider:"qq",id:`frontier-${i}`,title:`Frontier ${i}`,artist:`Other ${i}`}));
  const tracks=Object.fromEntries([...matched,...frontier].map(item=>[`qq:${item.id}`,{...item,mid:item.id}]));
  const context={bootPhase:"playing",bootReady:false,bootPainting:true,bootHomeFrameReady:true,bootAnimationDone:true,bootAssetsReady:true,bootAssetCompleted:3,bootLayoutReady:false,bootAssetAttempt:0,
    onboardingChecked:true,aiStatusChecked:true,bootMusicTask:{match:"",frontier:""},
    onboardingFirstRun:true,onboardingQQSkipped:false,tasteSyncing:false,bootResourceError:false,bootSourceError:false,bootRecommendationsUnavailable:false,bootWaveformError:false,
    waveformRevision:0,initialWaveformRef:{current:{trackId:"match-0",waveform:Array.from({length:96},(_,i)=>(i%8)/8)}},
    qqConnection:"needs-auth",qqPlaybackReady:true,qqSyncRevisionRef:{current:1},bootPreparedSources:new Set(),
    preparedTracksRef:{current:new Map(Object.values(tracks).map(track=>[track.mid,{expiresAt:100_000,track,promise:Promise.resolve({track})}]))},
    Date:{now:()=>10_000},listeningMemoryHydratedRef:{current:true},recommendationLoading:{match:false,frontier:false},
    recommendationUpdateRef:{current:{revision:2,timer:null,triggers:new Set(),records:[],latest:{revision:2,status:"completed"}}},
    listeningMemoryRef:{current:{updatedAt:1}},bootRetryRef:{current:0},
    matchedExperiments:matched,visibleExperiments:frontier,recommendationTracks:tracks,recommendationTracksRef:{current:tracks},activeQQTrack:tracks["qq:match-0"],lyricLines:[],lyricLinesLiveRef:{current:{trackId:"match-0",lines:[],settled:true}},
    recommendationPoolsRef:{current:{match:{status:"completed",visible:matched.map(item=>`qq:${item.id}`)},frontier:{status:"completed",visible:frontier.map(item=>`qq:${item.id}`)}}},
    domCounts:{match:12,frontier:12},layout:{".topbar":{width:300,height:50},".dashboard":{width:900,height:700},".player-bar":{width:900,height:90}},
    document:{querySelectorAll(selector){
      selectors.push(selector);
      if(selector.endsWith(" .experiment-card.playable")){
        const articleSelector=selector.slice(0,-" .experiment-card.playable".length);
        return recommendationArticles.filter(article=>matchesArticle(article.classes,articleSelector))
          .flatMap(article=>Array.from({length:context.domCounts[article.lane]},()=>({})));
      }
      if(selector.includes(".experiment-card"))return [];
      imageReads++;return images;
    },querySelector(selector){return context.layout[selector]?{getBoundingClientRect:()=>context.layout[selector]}:null;}},
    window:{requestAnimationFrame(callback){frames.push(callback);return frames.length;},
      setTimeout(callback,delay){timers.push({callback,delay});return timers.length;},clearTimeout(){}},
    canonicalTrackKey:(provider,id)=>`${provider}:${id}`,withTimeout:promise=>promise,
    setBootReady(value){context.bootReady=value;readyValues.push(value);},
    setBootLayoutReady(value){context.bootLayoutReady=value;},
    setBootPainting(value){context.bootPainting=value;},
    setBootAssetAttempt(value){context.bootAssetAttempt=typeof value==="function"?value(context.bootAssetAttempt):value;},
    setBootMusicTask(value){context.bootMusicTask=typeof value==="function"?value(context.bootMusicTask):value;},
    setBootResourceError(value){context.bootResourceError=value;errors.push(value);},
    setBootSourceError(value){context.bootSourceError=value;},
    setBootWaveformError(value){context.bootWaveformError=value;},
    setBootPreparedSources(next){context.bootPreparedSources=typeof next==="function"?next(context.bootPreparedSources):next;},
    setBootPhase(value){context.bootPhase=value;phases.push(value);},
    setRecommendationLoading(value){context.recommendationLoading=typeof value==="function"?value(context.recommendationLoading):value;},...overrides};
  context.recommendationIdentity=handler("recommendationIdentity",context);
  context.bootSourcesUnavailable=handler("bootSourcesUnavailable",context);
  context.homePreparedForBoot=handler("homePreparedForBoot",context);
  context.homeViewReadyForBoot=handler("homeViewReadyForBoot",context);
  context.bootEntryCheckRef={current:()=>context.homePreparedForBoot()&&context.homeViewReadyForBoot()};
  context.requestRecommendationUpdate=handler("requestRecommendationUpdate",context);
  const run=effect("setBootReady(true)",context);
  return {context,run,frames,timers,images,readyValues,errors,phases,selectors,imageReads:()=>imageReads,readyCalls:()=>readyValues.filter(Boolean).length,
    paint(){assert.ok(frames.length,"Expected a real pending frame");frames.shift()();if(frames.length)frames.shift()();},
    tick(){assert.ok(timers.length,"Expected production retry timer");timers.shift().callback();}};
}

test("boot cannot enter before real local, onboarding and AI checks complete",async()=>{
  for(const flag of ["bootAnimationDone","bootAssetsReady","onboardingChecked","aiStatusChecked"]){
    const h=readiness({[flag]:false});h.run();await flush();assert.equal(h.imageReads(),0,flag);assert.equal(h.readyCalls(),0,flag);
  }
  const h=readiness({listeningMemoryHydratedRef:{current:false}});h.run();await flush();assert.equal(h.imageReads(),0);assert.equal(h.readyCalls(),0);
});

test("QQ checking and connected library or lane work remain real entry barriers",async()=>{
  for(const state of [{qqConnection:"checking"},{qqConnection:"syncing"},{qqConnection:"authorizing"},
    {qqConnection:"connected",tasteSyncing:true},{qqConnection:"connected",qqPlaybackReady:false},
    {qqConnection:"connected",recommendationLoading:{match:true,frontier:false}},
    {qqConnection:"connected",recommendationLoading:{match:false,frontier:true}}]){
    const h=readiness(state);h.run();await flush();assert.equal(h.imageReads(),0);assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
  }
});

test("a full cached batch cannot unlock boot during the queued recommendation window",async()=>{
  for(const pending of [{timer:7},{triggers:new Set(["qq_library_synced"])},{latest:{status:"queued"}},{latest:{status:"running"}}]){
    const h=readiness({qqConnection:"connected",bootReady:true});
    Object.assign(h.context.recommendationUpdateRef.current,pending);
    h.run();await flush();
    assert.equal(h.context.bootReady,false);assert.equal(h.frames.length,0);
    click("className={`codio-boot",h.context)();assert.deepEqual(h.phases,[]);
    Object.assign(h.context.recommendationUpdateRef.current,{timer:null,triggers:new Set(),latest:{status:"completed"}});
    h.run();await flush();h.run();await flush();h.paint();
    assert.equal(h.context.bootReady,true,"entry resumes only after the actual queued work has settled");
  }
});

test("a late connection downgrade cannot bypass in-flight lane or library preparation",async()=>{
  for(const pending of [{tasteSyncing:true},{recommendationLoading:{match:true,frontier:false}},{recommendationLoading:{match:false,frontier:true}}]){
    const h=readiness({qqConnection:"needs-auth",bootReady:true,...pending});
    h.run();await flush();assert.equal(h.context.bootReady,false);assert.equal(h.frames.length,0);
  }
});

test("connected empty, failed, insufficient and partial batches cannot grant entry",async()=>{
  for(const status of ["failed","insufficient_candidates"]){
    const h=readiness({qqConnection:"connected",matchedExperiments:[],visibleExperiments:[],
      recommendationPoolsRef:{current:{match:{status,visible:[]},frontier:{status,visible:[]}}}});
    h.run();await flush();assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
    assert.deepEqual(h.context.matchedExperiments,[]);assert.deepEqual(h.context.visibleExperiments,[]);
    assert.equal(h.context.recommendationPoolsRef.current.match.status,status);
  }
  for(const lane of ["matchedExperiments","visibleExperiments"]){
    const h=readiness({qqConnection:"connected"});h.context[lane]=h.context[lane].slice(0,11);h.run();await flush();
    assert.equal(h.context.homePreparedForBoot(),false);assert.equal(h.readyCalls(),0);assert.equal(h.frames.length,0);
  }
});

test("both first visits and returning disconnected users can enter without a QQ-skip choice",async()=>{
  for(const choice of [{onboardingFirstRun:true},{onboardingQQSkipped:true},{onboardingFirstRun:false,onboardingQQSkipped:false}]){
    const h=readiness({onboardingFirstRun:false,qqConnection:"needs-auth",matchedExperiments:[],visibleExperiments:[],...choice});
    h.run();await flush();assert.equal(h.frames.length,1);h.paint();assert.equal(h.readyCalls(),1);
  }
  for(const qqConnection of ["needs-auth","unavailable"]){
    const h=readiness({onboardingFirstRun:false,qqConnection});h.run();await flush();
    assert.equal(h.frames.length,1);h.paint();assert.equal(h.readyCalls(),1);
    assert.equal(h.context.qqConnection,qqConnection,"local entry cannot imply successful QQ authorization");
  }
});

test("a failed QQ check with zero songs cannot impersonate a prepared disconnected homepage",async()=>{
  const h=readiness({qqConnection:"error",qqPlaybackReady:false,matchedExperiments:[],visibleExperiments:[],bootReady:true});
  assert.equal(h.context.homePreparedForBoot(),false);h.run();await flush();
  assert.equal(h.context.bootReady,false);assert.equal(h.frames.length,0);assert.equal(h.imageReads(),0);
  const view=renderBoot(h.context);
  assert.equal(elements(view,"p")[0].children[0],"Music connection check failed. Please try again.");
  const calls=[];h.context.connectQQMusic=request=>calls.push(request);
  click(">TRY AGAIN</button>",h.context,true)({stopPropagation(){}});
  assert.deepEqual(calls,[false],"retry only checks the existing session, never opens login or clears data");
  assert.deepEqual(h.phases,[]);
});

function connectHarness(response){
  const h=readiness({qqConnection:"checking"}),states=[],timeouts=[];
  Object.assign(h.context,{notifySystem(){},setOnboardingQQSkipped(){},syncQQTaste:async()=>null,
    setQQConnection(value){h.context.qqConnection=value;states.push(value);},
    setQQPlaybackReady(value){h.context.qqPlaybackReady=value;},setImportState(){},
    withTimeout(promise,ms,label){timeouts.push({ms,label});return promise;}});
  h.context.window.codioDesktop={qqMusic:{getStatus:()=>response}};
  h.context.window.localStorage={setItem(){}};
  return {...h,states,timeouts,connect:()=>handler("connectQQMusic",h.context)(false)};
}

test("QQ restoration waits for the main process recovery deadline and failure stays distinct from no account",async()=>{
  const request=deferred(),h=connectHarness(request.promise),pending=h.connect();await flush();
  assert.equal(h.context.qqConnection,"checking");assert.equal(h.context.homePreparedForBoot(),false);
  assert.deepEqual(h.timeouts,[{ms:16000,label:"BOOT_QQ_STATUS"}]);
  const main=await readFile(new URL("../desktop/main.cjs",import.meta.url),"utf8");
  const recovery=main.slice(main.indexOf("async function refreshQQPlaybackSessionOnce("),main.indexOf("async function openQQLogin("));
  const deadline=Number(recovery.match(/\},\s*(\d+)\);/)?.[1]);
  assert.ok(Number.isFinite(deadline)&&h.timeouts[0].ms>deadline,"the renderer must not abandon an active main-process recovery first");
  request.resolve({loggedIn:true,playbackReady:true});await pending;
  assert.deepEqual(h.states,["checking","connected"]);
  for(const status of [{loggedIn:true,playbackReady:false},{loggedIn:true,playbackReady:false,authorizationRequired:true},{loggedIn:false,playbackReady:false}]){
    const c=connectHarness(Promise.resolve(status));await c.connect();
    assert.equal(c.context.qqConnection,status.authorizationRequired||!status.loggedIn?"needs-auth":"error");
  }
  const failed=connectHarness(Promise.reject(Error("network")));await failed.connect();
  assert.equal(failed.context.qqConnection,"error");assert.equal(failed.context.homePreparedForBoot(),false);
});

test("first track selection and its settled lyric result are real startup barriers",async()=>{
  for(const state of [{activeQQTrack:null},{lyricLinesLiveRef:{current:{trackId:"old-track",lines:[{time:0,text:"old"}]}}},
    {lyricLinesLiveRef:{current:{trackId:"match-0",lines:[]}}},{bootHomeFrameReady:false}]){
    const h=readiness({qqConnection:"connected",...state});h.run();await flush();
    assert.equal(h.readyCalls(),0);assert.equal(h.imageReads(),0);
  }
  const request=deferred(),h=readiness({qqConnection:"connected"});
  const requestSource=await readFile(new URL("../app/codio-requests.ts",import.meta.url),"utf8");
  const js=ts.transpileModule(requestSource,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
  const {loadLyricsWithRetry}=await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  Object.assign(h.context,{trackIndex:0,tracks:[],loadLyricsWithRetry:(read,signal)=>loadLyricsWithRetry(read,signal,async()=>{}),notifySystem(){},
    setLyricLines(lines){h.context.lyricLines=lines;}});
  Object.assign(h.context.window,{codioDesktop:{qqMusic:{lyrics:()=>request.promise}},addEventListener(){},removeEventListener(){}});
  const cleanup=effect("const lyrics = activeQQTrack.provider",h.context)();
  assert.equal(h.context.homePreparedForBoot(),false,"pending lyrics are not empty/instrumental lyrics");
  request.resolve([{time:0,text:"first line"}]);await flush();await flush();
  assert.equal(h.context.lyricLinesLiveRef.current.settled,true);assert.equal(h.context.homePreparedForBoot(),true);cleanup();
  for(const fails of [false,true]){
    h.context.window.codioDesktop.qqMusic.lyrics=async()=>{if(fails)throw Error("network");return [];};
    h.context.lyricLinesLiveRef.current={trackId:"match-0",lines:[]};
    const dispose=effect("const lyrics = activeQQTrack.provider",h.context)();
    for(let i=0;i<8;i++)await flush();
    assert.equal(h.context.lyricLinesLiveRef.current.settled,true);assert.equal(h.context.lyricLinesLiveRef.current.failed,fails);
    assert.equal(h.context.homePreparedForBoot(),true,"a bounded, settled unavailable/error view is not a permanently pending UI");dispose();
  }
});

test("an absent or previous-song waveform cannot unlock a connected complete homepage",()=>{
  for(const waveform of [{trackId:"",waveform:[]},{trackId:"another",waveform:Array(96).fill(.2)},{trackId:"match-0",waveform:[]}]){
    const h=readiness({qqConnection:"connected",initialWaveformRef:{current:waveform}});
    assert.equal(h.context.homePreparedForBoot(),false);
    assert.ok(elements(renderBoot(h.context),"p")[0].children[0].includes("waveform")||waveform.trackId==="match-0");
  }
});

test("initial waveform accepts exact media-bound cache only, otherwise prepares real audio without autoplay",async()=>{
  const h=readiness(),c=h.context,track={provider:"qq",mid:"real-track-fixture",mediaMid:"file-a",durationSeconds:240},wave=Array.from({length:96},(_,i)=>(i%9)/9);
  const cached={version:3,trackId:track.mid,duration:240,waveform:wave,sourceMediaId:"qq:real-track-fixture:file-a"};
  let prepares=0,analyses=0;
  c.window.codioDesktop={analysis:{get:async()=>cached}};
  c.prepareTrack=async()=>{prepares++;return{playback:{url:"isolated:checked-source"}};};
  c.analyseTrackSource=async(id,url,duration,identity)=>{analyses++;assert.equal(id,track.mid);assert.equal(url,"isolated:checked-source");assert.equal(identity,"qq:real-track-fixture:file-a");return{...cached};};
  const prepare=handler("prepareInitialWaveform",c);
  assert.deepEqual(await prepare(track),wave);assert.equal(prepares,0);assert.equal(analyses,0);
  cached.sourceMediaId="qq:real-track-fixture:different-file";
  assert.deepEqual(await prepare(track),wave);assert.equal(prepares,1);assert.equal(analyses,1);
  c.analyseTrackSource=async()=>null;assert.equal(await prepare(track),null,"failed analysis cannot fabricate a decorative curve");
  c.analyseTrackSource=async()=>({...cached,waveform:Array(96).fill(NaN)});assert.equal(await prepare(track),null);
});

test("the actual waveform preparation effect waits for real samples before unlocking the homepage and never starts playback",async()=>{
  const h=readiness({qqConnection:"connected",initialWaveformRef:{current:{trackId:"",waveform:[]}}}),c=h.context,pending=deferred();
  c.prepareInitialWaveformRef={current:track=>{assert.equal(track.mid,"match-0");return pending.promise;}};
  c.displayedWaveformRef={current:[]};c.setWaveformRevision=update=>{c.waveformRevision=update(c.waveformRevision);};
  c.togglePlayback=()=>assert.fail("startup must remain paused");
  const cleanup=effect("INITIAL_WAVEFORM",c)();
  assert.equal(c.homePreparedForBoot(),false);assert.equal(c.waveformRevision,0);
  const waveform=Array.from({length:96},(_,i)=>(i%11)/11);pending.resolve(waveform);await flush();
  assert.deepEqual(c.initialWaveformRef.current,{trackId:"match-0",waveform});
  assert.equal(c.waveformRevision,1);assert.equal(c.bootWaveformError,false);assert.equal(c.homePreparedForBoot(),true);cleanup();
});

test("failed or cancelled initial waveform preparation cannot claim ready or install stale samples",async()=>{
  for(const cancelled of [false,true]){
    const h=readiness({qqConnection:"connected",initialWaveformRef:{current:{trackId:"",waveform:[]}}}),c=h.context,pending=deferred();
    c.prepareInitialWaveformRef={current:()=>pending.promise};c.displayedWaveformRef={current:[]};
    c.setWaveformRevision=()=>assert.fail("failed/cancelled preparation cannot change the displayed waveform");
    const cleanup=effect("INITIAL_WAVEFORM",c)();if(cancelled)cleanup();
    pending.resolve(cancelled?Array(96).fill(.3):null);await flush();
    assert.equal(c.homePreparedForBoot(),false);assert.equal(c.initialWaveformRef.current.trackId,"");
    assert.equal(c.bootWaveformError,!cancelled);cleanup();
  }
});

test("waveform preparation still runs after entry and after connecting QQ on the homepage", async () => {
  const h=readiness({bootPhase:"done",qqConnection:"connected",initialWaveformRef:{current:{trackId:"",waveform:[]}}}),c=h.context;
  const wave=Array.from({length:96},(_,i)=>(i%9)/9);let calls=0;
  c.prepareInitialWaveformRef={current:async()=>{calls++;return wave;}};
  c.displayedWaveformRef={current:[]};c.setWaveformRevision=update=>{c.waveformRevision=update(c.waveformRevision);};
  const cleanup=effect("INITIAL_WAVEFORM",c)();await flush();
  assert.equal(calls,1);assert.deepEqual(c.initialWaveformRef.current.waveform,wave);assert.equal(c.waveformRevision,1);cleanup();
});

test("a later real waveform preserves the current curve for the existing smooth morph", async () => {
  const h=readiness({bootPhase:"done",qqConnection:"connected",initialWaveformRef:{current:{trackId:"",waveform:[]}}}),c=h.context;
  const oldCurve=Array(96).fill(.25),newCurve=Array(96).fill(.7);
  c.prepareInitialWaveformRef={current:async()=>newCurve};c.displayedWaveformRef={current:oldCurve};c.setWaveformRevision=()=>{};
  const cleanup=effect("INITIAL_WAVEFORM",c)();await flush();
  assert.equal(c.displayedWaveformRef.current,oldCurve);assert.deepEqual(c.initialWaveformRef.current.waveform,newCurve);cleanup();
});

test("a real waveform completing after the UI deadline still finishes startup without a second job", async () => {
  const h=readiness({qqConnection:"connected",initialWaveformRef:{current:{trackId:"",waveform:[]}}}),c=h.context,pending=deferred();
  let expire,calls=0;
  c.prepareInitialWaveformRef={current:()=>{calls++;return pending.promise;}};
  c.withTimeout=(_promise,ms,label)=>{assert.equal(ms,32000);return new Promise((_resolve,reject)=>{expire=()=>reject(Error(label));});};
  c.displayedWaveformRef={current:[]};c.setWaveformRevision=update=>{c.waveformRevision=update(c.waveformRevision);};
  const cleanup=effect("INITIAL_WAVEFORM",c)();expire();await flush();
  assert.equal(c.bootWaveformError,true,"retry is available while the original job remains observed");
  assert.equal(c.homePreparedForBoot(),false);assert.equal(calls,1);
  pending.resolve(Array(96).fill(.4));await flush();
  assert.equal(c.initialWaveformRef.current.trackId,"match-0");assert.equal(c.waveformRevision,1);
  assert.equal(c.bootWaveformError,false);assert.equal(c.homePreparedForBoot(),true);assert.equal(calls,1);cleanup();
});

test("a truly failed late waveform still blocks entry instead of fabricating ready", async () => {
  const h=readiness({qqConnection:"connected",initialWaveformRef:{current:{trackId:"",waveform:[]}}}),c=h.context,pending=deferred();let expire;
  c.prepareInitialWaveformRef={current:()=>pending.promise};c.withTimeout=()=>new Promise((_resolve,reject)=>{expire=()=>reject(Error("deadline"));});
  c.displayedWaveformRef={current:[]};c.setWaveformRevision=()=>assert.fail("no measured waveform means no ready revision");
  const cleanup=effect("INITIAL_WAVEFORM",c)();expire();await flush();pending.resolve(null);await flush();
  assert.equal(c.bootWaveformError,true);assert.equal(c.homePreparedForBoot(),false);cleanup();
});

test("home paints behind the opening screen before two separate final frame checks",async()=>{
  const h=readiness({qqConnection:"connected",bootPainting:false});
  h.run();assert.equal(h.context.bootPainting,true);assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
  h.run();await flush();assert.equal(h.frames.length,1);
  h.frames.shift()();assert.equal(h.readyCalls(),0,"the first frame cannot publish ready");assert.equal(h.frames.length,1);
  h.frames.shift()();assert.equal(h.readyCalls(),1);
  const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
  assert.match(css,/\[data-startup="playing"\]\[data-home-paint="false"\][^{]+\{\s*visibility:hidden/);
});

test("entry rechecks late artwork and the latest state at the end of its fade",async()=>{
  const cover={src:"/ready.jpg",complete:true,naturalWidth:300,decode:async()=>{}};
  const h=readiness({qqConnection:"connected"},[cover]);h.run();await flush();h.paint();
  assert.equal(h.context.bootReady,true);
  cover.complete=false;cover.naturalWidth=0;
  click("className={`codio-boot",h.context)();
  assert.equal(h.context.bootReady,false);assert.equal(h.context.bootLayoutReady,false);assert.deepEqual(h.phases,[]);
  const c=readiness({qqConnection:"connected",bootReady:true});click("className={`codio-boot",c.context)();
  c.context.recommendationLoading.match=true;c.tick();
  assert.deepEqual(c.phases,["leaving","playing"]);assert.equal(c.context.bootReady,false,"late work cannot be ignored by an old timer closure");
});

test("a late cover source change revokes the enter prompt without polling and disposes its observer",async()=>{
  const h=readiness({qqConnection:"connected",bootReady:true}),observers=[];
  h.context.rootRef={current:{}};
  h.context.MutationObserver=class {
    constructor(callback){this.callback=callback;observers.push(this);}
    observe(node,options){this.node=node;this.options=options;}
    disconnect(){this.disconnected=true;}
  };
  const dispose=effect("new MutationObserver(invalidateArtwork)",h.context)();
  assert.equal(observers.length,1);assert.deepEqual(observers[0].options.attributeFilter,["src"]);
  assert.equal(h.context.bootReady,true);assert.equal(h.timers.length,0);
  h.context.domCounts.match=11;observers[0].callback();
  assert.equal(h.context.bootReady,false);assert.equal(h.context.bootLayoutReady,false);
  dispose();assert.equal(observers[0].disconnected,true);
});

test("retired offline flags cannot bypass unfinished local preparation",async()=>{
  assert.equal(clicks.filter(item=>item.element.includes(">CONTINUE WITHOUT MUSIC</button>")).length,0);
  assert.ok(![...callbacks.keys()].some(name=>name.includes("bootOffline")),"the retired state must not retain a hidden entry path");
  for(const qqConnection of ["connected","needs-auth","error"]){
    const h=readiness({qqConnection,onboardingFirstRun:false,onboardingQQSkipped:false,bootOffline:true,bootAssetsReady:false,
      matchedExperiments:[],visibleExperiments:[],activeQQTrack:null});
    assert.equal(h.context.homePreparedForBoot(),false,"an injected stale flag cannot grant readiness");
    h.run();await flush();assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
    click("className={`codio-boot",h.context)();assert.deepEqual(h.phases,[]);
  }
});

test("the actual queued update keeps the committed batch, but real running lane work blocks entry",async()=>{
  const h=readiness({qqConnection:"connected",onboardingFirstRun:false}),update=h.context.recommendationUpdateRef.current;
  update.triggers=new Set();h.context.listeningMemoryRef={current:{updatedAt:1}};
  let refreshes=0;
  h.context.recommendationRefreshRef={current:async()=>{
    refreshes++;update.latest={revision:update.revision,status:"completed"};
    h.context.recommendationLoading={match:false,frontier:false};
  }};
  h.context.setRecommendationLoading=value=>{h.context.recommendationLoading=typeof value==="function"?value(h.context.recommendationLoading):value;};
  handler("requestRecommendationUpdate",h.context)("initial");
  const matched=h.context.matchedExperiments,frontier=h.context.visibleExperiments;
  h.context.recommendationLoading={match:true,frontier:true};
  assert.equal(h.timers[0].delay,240);h.run();await flush();
  assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
  assert.strictEqual(h.context.matchedExperiments,matched);assert.strictEqual(h.context.visibleExperiments,frontier);
  assert.equal(update.latest.status,"queued","boot cannot fabricate network completion");
  h.tick();await flush();assert.equal(refreshes,1);
  h.run();h.run();await flush();assert.equal(h.frames.length,1);h.paint();assert.equal(h.readyCalls(),1);
});

test("card state or progress counts cannot bypass missing, duplicate, pending or expired real sources",async()=>{
  const invalid=[
    c=>{c.recommendationTracksRef.current={};},
    c=>{c.preparedTracksRef.current.clear();},
    c=>{c.preparedTracksRef.current.delete("match-0");},
    c=>{c.preparedTracksRef.current.set("match-0",{promise:new Promise(()=>{})});},
    c=>{c.preparedTracksRef.current.set("match-0",{expiresAt:9_999});},
    c=>{c.preparedTracksRef.current.set("match-0",{expiresAt:10_000});},
    c=>{c.preparedTracksRef.current.set("match-0",{expiresAt:"100000"});},
    c=>{c.preparedTracksRef.current.set("match-0",{expiresAt:NaN});},
    c=>{c.visibleExperiments[0]=c.matchedExperiments[0];c.recommendationPoolsRef.current.frontier.visible[0]=c.recommendationIdentity(c.matchedExperiments[0]);},
  ];
  for(const mutate of invalid){
    const h=readiness({qqConnection:"connected",onboardingFirstRun:false,bootPreparedSources:new Set(Array.from({length:24},(_,i)=>`qq:count${i}`))});
    mutate(h.context);h.run();await flush();assert.equal(h.context.homePreparedForBoot(),false);
    assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
    assert.equal(h.context.recommendationUpdateRef.current.triggers.size,0,"a counter cannot create source tickets");
  }
});

test("a 23-of-24 source warmup ends with an honest retry and repairs only the missing source without replacing cards",async()=>{
  const h=readiness({qqConnection:"connected"}),c=h.context,missing="match-0",timers=new Map(),calls=[];let sequence=0,fail=true;
  c.preparedTracksRef.current.delete(missing);
  c.window.setTimeout=(callback,delay)=>{const id=++sequence;timers.set(id,{callback,delay});return id;};
  c.window.clearTimeout=id=>timers.delete(id);
  c.withTimeout=handler("withTimeout",c);
  c.prepareTrack=async track=>{
    const cached=c.preparedTracksRef.current.get(track.mid);if(cached)return cached.promise;
    calls.push(track.mid);if(fail)return new Promise(()=>{});
    const prepared={track,expiresAt:100_000};c.preparedTracksRef.current.set(track.mid,{expiresAt:100_000,promise:Promise.resolve(prepared)});return prepared;
  };
  const warm=effect("Resolve all 24 playback URLs",c),before=[c.matchedExperiments,c.visibleExperiments],revision=c.recommendationUpdateRef.current.revision;
  const dispose=warm();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(timers.size,1,"only the actually stalled source retains a timeout");
  const timer=[...timers.values()][0];assert.equal(timer.delay,6500);timer.callback();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.bootSourceError,true);assert.equal(c.bootPreparedSources.size,23);assert.equal(c.homePreparedForBoot(),false);
  assert.match(elements(renderBoot(c),"p")[0].children[0],/playback links could not/);
  assert.ok(elements(renderBoot(c),"button").some(button=>button.children.includes("TRY AGAIN")));
  click(">TRY AGAIN</button>",c,true)({stopPropagation(){}});
  assert.equal(c.bootAssetAttempt,1);assert.equal(c.recommendationUpdateRef.current.revision,revision,"source repair must not start another catalogue acquisition");
  fail=false;dispose();warm();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[missing,missing]);assert.equal(c.bootSourceError,false);assert.equal(c.bootPreparedSources.size,24);
  assert.strictEqual(c.matchedExperiments,before[0]);assert.strictEqual(c.visibleExperiments,before[1]);
  h.run();await flush();h.paint();assert.equal(c.bootReady,true,"the genuine repaired source can unlock the normal final DOM gate");
});

test("a cancelled warmup cannot publish a late source failure into a newer startup",async()=>{
  const h=readiness({qqConnection:"connected"}),c=h.context;let reject;
  c.prepareTrack=async()=>new Promise(()=>{});
  c.withTimeout=()=>new Promise((resolve,failed)=>{reject=failed;});
  const dispose=effect("Resolve all 24 playback URLs",c)();dispose();reject(Error("old timeout"));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.bootSourceError,false);assert.equal(c.bootPreparedSources.size,0);assert.equal(h.readyCalls(),0);
});

test("exhausted verified-candidate retries display a terminal explanation rather than a permanent checking caption",()=>{
  const h=readiness({qqConnection:"connected",matchedExperiments:[],visibleExperiments:[]});
  h.context.bootRetryRef.current=3;
  const tree=renderBoot(h.context);
  assert.equal(elements(tree,"p")[0].children[0],"Not enough verified matches yet. Please try again.");
  assert.ok(elements(tree,"button").some(button=>button.children.includes("TRY AGAIN")));
  assert.equal(h.context.homePreparedForBoot(),false);
});

test("a real complete batch still waits for every homepage and playback cover to decode",async()=>{
  const covers=Array.from({length:24},deferred),h=readiness({qqConnection:"connected",onboardingFirstRun:false},covers);
  assert.equal(h.context.homePreparedForBoot(),true);h.run();await flush();
  assert.equal(h.imageReads(),1);assert.equal(h.frames.length,0);
  assert.deepEqual(h.selectors,[".topbar img,.boot-lockup img,.dashboard img,.boundary-section img,.player-bar img"]);
  covers.slice(0,23).forEach(cover=>cover.resolve());await flush();assert.equal(h.frames.length,0);
  covers[23].resolve();await flush();assert.equal(h.frames.length,1);assert.equal(h.readyCalls(),0);
  h.paint();assert.equal(h.readyCalls(),1);assert.ok(h.images.every(image=>image.complete&&image.naturalWidth>0));
});

test("new internal work or expired sources revoke ready and are rechecked at the final rendered frame",async()=>{
  const h=readiness({qqConnection:"connected",onboardingFirstRun:false});h.run();await flush();h.paint();
  assert.equal(h.context.bootReady,true);
  h.context.recommendationPoolsRef.current.match.status="pending";h.context.recommendationLoading.match=true;
  h.run();await flush();assert.equal(h.context.bootReady,false);assert.deepEqual(h.readyValues,[true,false]);
  const late=readiness({qqConnection:"connected",onboardingFirstRun:false});late.run();await flush();
  late.context.preparedTracksRef.current.get("frontier-11").expiresAt=10_000;
  late.paint();assert.equal(late.readyCalls(),0,"source validity must be read again before publishing ready");
  for(const invalidate of [c=>{c.bootAssetsReady=false;},c=>{c.bootAnimationDone=false;},c=>{c.listeningMemoryHydratedRef.current=false;}]){
    const local=readiness();local.run();await flush();invalidate(local.context);local.paint();assert.equal(local.readyCalls(),0);
    local.context.bootReady=true;local.run();assert.equal(local.context.bootReady,false);
  }
});

test("actual entry click rechecks live home readiness rather than trusting a stale ready flag",()=>{
  for(const invalidate of [c=>{c.bootReady=false;},c=>{c.bootAssetsReady=false;},
    c=>{c.bootAnimationDone=false;},c=>{c.listeningMemoryHydratedRef.current=false;},c=>{c.qqConnection="checking";},
    c=>{c.recommendationLoading.frontier=true;},c=>{c.visibleExperiments.pop();},c=>{c.preparedTracksRef.current.get("match-0").expiresAt=10_000;}]){
    const h=readiness({qqConnection:"connected",onboardingFirstRun:false,bootReady:true});invalidate(h.context);
    click("className={`codio-boot",h.context)();assert.deepEqual(h.phases,[]);assert.equal(h.timers.length,0);
  }
  const valid=readiness({qqConnection:"connected",onboardingFirstRun:false,bootReady:true});
  click("className={`codio-boot",valid.context)();assert.deepEqual(valid.phases,["leaving"]);assert.equal(valid.timers[0].delay,640);
  valid.tick();assert.deepEqual(valid.phases,["leaving","done"]);
});

test("artwork-only startup retry decodes resources without a new recommendation request",async()=>{
  const retry=readiness({qqConnection:"connected",onboardingFirstRun:false,bootResourceError:true});let stopped=0;
  const before=retry.context.recommendationUpdateRef.current.latest;
  click(">TRY AGAIN</button>",retry.context,true)({stopPropagation(){stopped++;}});
  assert.equal(stopped,1);assert.equal(retry.context.bootResourceError,false);
  assert.equal(retry.context.bootAssetAttempt,1,"the actual local asset effect is retriggered");
  assert.equal(retry.context.recommendationUpdateRef.current.triggers.size,0);assert.equal(retry.timers.length,0);
  assert.strictEqual(retry.context.recommendationUpdateRef.current.latest,before);assert.deepEqual(retry.phases,[]);
  retry.run();await flush();assert.equal(retry.frames.length,1);assert.equal(retry.readyCalls(),0);
  retry.paint();assert.equal(retry.readyCalls(),1,"the committed homepage still waits for its decoded resource frame");
});

test("actual preparation page has no QQ login actions and the homepage retains its QQ entry",()=>{
  for(const qqConnection of ["checking","needs-auth","error","connected"]){
    for(const bootResourceError of [false,true]){
      const h=readiness({qqConnection,bootResourceError}),buttons=elements(renderBoot(h.context),"button");
      assert.deepEqual(buttons.map(button=>button.children.flat().join("")),bootResourceError||qqConnection==="error"?["TRY AGAIN"]:[]);
    }
  }
  const h=readiness({bootPhase:"done",qqConnection:"needs-auth"}),before=h.context.recommendationTracks;
  const actions=[];Object.assign(h.context,{setImportSource:value=>actions.push(["source",value]),setImportState:value=>actions.push(["state",value]),
    setImportOpen:value=>actions.push(["open",value]),connectQQMusic:value=>actions.push(["connect",value])});
  click("qq-connect-pill",h.context)();
  assert.deepEqual(actions,[["source","qq"],["state","idle"],["open",true],["connect",false]]);
  assert.strictEqual(h.context.recommendationTracks,before);assert.deepEqual(h.phases,[]);
});

test("actual preparation caption describes the current real blocking stage without changing the layout",()=>{
  const cases=[
    [{bootResourceError:true},"Retrying artwork and layout checks…"],
    [{bootAssetsReady:false},"Loading fonts and interface artwork…"],
    [{listeningMemoryHydratedRef:{current:false}},"Loading your listening memory…"],
    [{onboardingChecked:false},"Restoring your saved setup…"],
    [{aiStatusChecked:false},"Checking your AI DJ connection…"],
    [{qqConnection:"checking"},"Checking your music connection…"],
    [{qqConnection:"connected",tasteSyncing:true},"Restoring your music library…"],
    [{qqConnection:"connected",matchedExperiments:[]},"Preparing close matches and taste frontier…"],
    [{qqConnection:"connected",preparedTracksRef:{current:new Map()}},"Checking the playback sources…"],
    [{qqConnection:"connected",recommendationLoading:{match:true,frontier:false}},"Confirming your recommendations…"],
    [{qqConnection:"connected"},"Loading homepage covers and checking the layout…"],
    [{qqConnection:"connected",bootLayoutReady:true,bootAnimationDone:false},"Finishing the opening animation…"],
    [{qqConnection:"connected",bootLayoutReady:true},"Finishing the homepage…"],
  ];
  for(const [state,expected] of cases){
    const h=readiness(state),paragraphs=elements(renderBoot(h.context),"p");
    assert.equal(paragraphs.length,1);assert.equal(paragraphs[0].children[0],expected);
  }
  const h=readiness({qqConnection:"connected"});h.context.recommendationUpdateRef.current.records=[{
    evidenceRevision:2,candidateCount:120,checkedCandidateCount:120,playableCandidateCount:0}];
  assert.equal(elements(renderBoot(h.context),"p")[0].children[0],"The music sources need another check…");
});

test("actual lane task publisher updates the existing caption, deduplicates both lanes and preserves independent work",()=>{
  const h=readiness({qqConnection:"connected"}),c=h.context;let current=true;
  Object.assign(c,{lane:"match",valid:()=>current});
  const report=handler("reportBootTask",c),caption=()=>{
    const paragraphs=elements(renderBoot(c),"p");assert.equal(paragraphs.length,1);return paragraphs[0].children[0];
  };
  for(const task of ["Checking music availability…","Reading your music preferences…","Restoring close matches…",
    "Finding close matches…","Checking playback links and covers…","Applying your latest preferences…"]){
    report(task);assert.equal(caption(),task);assert.equal(c.bootMusicTask.frontier,"");
  }
  c.lane="frontier";report("Applying your latest preferences…");
  assert.equal(caption(),"Applying your latest preferences…","same current task is not repeated for each lane");
  report("Restoring taste frontier…");assert.equal(caption(),"Applying your latest preferences… · Restoring taste frontier…");
  c.lane="match";report("");assert.equal(caption(),"Restoring taste frontier…","one lane finishing cannot clear the other's active task");
  current=false;report("Finding close matches…");assert.equal(c.bootMusicTask.match,"");assert.equal(caption(),"Restoring taste frontier…");
  current=true;c.bootPhase="done";report("Reading your music preferences…");assert.equal(c.bootMusicTask.match,"");
  c.bootPhase="playing";c.lane="frontier";report("Finding taste frontier tracks…");assert.equal(caption(),"Finding taste frontier tracks…");
  c.bootAssetsReady=false;assert.equal(caption(),"Loading fonts and interface artwork…","unfinished local assets remain the true earlier stage");
  c.bootAssetsReady=true;report("");assert.equal(caption(),"Loading homepage covers and checking the layout…");
  assert.equal(c.recommendationUpdateRef.current.revision,2);assert.equal(c.recommendationUpdateRef.current.triggers.size,0);
  assert.equal(h.readyCalls(),0,"task captions cannot publish readiness or start work");
});

test("authorization rejection during source preparation cannot block local entry or fabricate authorization",async()=>{
  const h=readiness({qqConnection:"needs-auth",onboardingFirstRun:false,onboardingQQSkipped:false,bootReady:true});
  h.context.recommendationUpdateRef.current.records=[{evidenceRevision:2,candidateCount:120,checkedCandidateCount:120,playableCandidateCount:0}];
  assert.equal(h.context.bootSourcesUnavailable(),true);assert.equal(h.context.homePreparedForBoot(),true);
  h.run();await flush();assert.equal(h.context.bootReady,true);
  click("className={`codio-boot",h.context)();assert.deepEqual(h.phases,["leaving"]);
  assert.equal(h.context.qqConnection,"needs-auth");assert.equal(h.context.bootSourcesUnavailable(),true);
  assert.equal(h.context.recommendationUpdateRef.current.triggers.size,0);
});

test("actual source-failure retry queues once, preserves 23 cards and never grants entry or opens QQ login",()=>{
  const h=readiness({qqConnection:"connected",onboardingFirstRun:false});h.context.visibleExperiments.pop();
  const matched=h.context.matchedExperiments,frontier=h.context.visibleExperiments,tracks=h.context.recommendationTracksRef.current;
  const update=h.context.recommendationUpdateRef.current;
  update.records=[{evidenceRevision:update.revision,candidateCount:120,checkedCandidateCount:120,playableCandidateCount:0}];
  h.context.bootRetryRef.current=3;h.context.connectQQMusic=()=>assert.fail("source retry must not open authorization");
  const buttons=elements(renderBoot(h.context),"button");assert.deepEqual(buttons.map(button=>button.children[0]),["TRY AGAIN"]);
  const retry=click(">TRY AGAIN</button>",h.context,true);let stopped=0;
  retry({stopPropagation(){stopped++;}});retry({stopPropagation(){stopped++;}});
  assert.equal(stopped,2);assert.equal(update.revision,3);assert.deepEqual([...update.triggers],["playback_retry"]);
  assert.equal(h.timers.length,1);assert.equal(h.timers[0].delay,240);assert.equal(h.context.bootRetryRef.current,0);assert.equal(h.context.bootAssetAttempt,0);
  assert.strictEqual(h.context.matchedExperiments,matched);assert.strictEqual(h.context.visibleExperiments,frontier);
  assert.strictEqual(h.context.recommendationTracksRef.current,tracks);assert.equal(matched.length+frontier.length,23);
  assert.equal(h.context.homePreparedForBoot(),false);assert.deepEqual(h.phases,[]);
});

test("local retry is independent of pending timers, queued work and running music work",()=>{
  for(const pending of [{timer:11,status:"completed"},{timer:null,status:"queued"},{timer:null,status:"running"}]){
    const h=readiness({qqConnection:"connected",onboardingFirstRun:false,bootResourceError:true});
    const update=h.context.recommendationUpdateRef.current;update.timer=pending.timer;update.latest.status=pending.status;
    const beforeRevision=update.revision,beforeLatest=update.latest;
    click(">TRY AGAIN</button>",h.context,true)({stopPropagation(){}});
    assert.equal(update.revision,beforeRevision);assert.strictEqual(update.latest,beforeLatest);
    assert.equal(update.triggers.size,0);assert.equal(h.timers.length,0);assert.deepEqual(h.phases,[]);
    assert.equal(h.context.bootResourceError,false);assert.equal(h.context.bootAssetAttempt,1,"local repair must not be locked behind a network request");
  }
});

test("startup retries at most three incomplete terminal batches without an unbounded loop",()=>{
  const h=readiness({qqConnection:"connected",onboardingFirstRun:false,matchedExperiments:[],visibleExperiments:[],
    recommendationPoolsRef:{current:{match:{status:"failed",visible:[]},frontier:{status:"insufficient_candidates",visible:[]}}}});
  const retry=effect("bootRetryRef.current < 3",h.context);
  for(let attempt=1;attempt<=3;attempt++){
    retry();assert.equal(h.context.bootRetryRef.current,attempt);assert.equal(h.timers.length,attempt);
    assert.ok(h.context.recommendationUpdateRef.current.triggers.has("continuation"));
    retry();assert.equal(h.timers.length,attempt,"no duplicate request while a retry is queued");
    h.context.recommendationUpdateRef.current.timer=null;
    h.context.recommendationLoading={match:false,frontier:false};
    h.context.recommendationUpdateRef.current.latest.status="insufficient_candidates";
  }
  retry();retry();assert.equal(h.timers.length,3);assert.equal(h.context.bootRetryRef.current,3);
  assert.equal(h.readyCalls(),0);assert.deepEqual(h.phases,[]);
});

test("all-source failure stops automatic pool expansion and cannot unlock a connected empty homepage",async()=>{
  for(const failedLane of ["match","frontier"]){
    const h=readiness({qqConnection:"connected",onboardingFirstRun:false,matchedExperiments:[],visibleExperiments:[],activeQQTrack:null,
      recommendationPoolsRef:{current:{match:{status:"insufficient_candidates",visible:[]},frontier:{status:"failed",visible:[]}}}});
    const update=h.context.recommendationUpdateRef.current;
    update.records=[{lane:failedLane,evidenceRevision:update.revision,candidateCount:120,checkedCandidateCount:120,playableCandidateCount:0}];
    assert.equal(h.context.bootSourcesUnavailable(),true);
    const retry=effect("bootRetryRef.current < 3",h.context);retry();retry();
    assert.equal(h.timers.length,0);assert.equal(update.triggers.size,0);assert.equal(h.context.bootRetryRef.current,0);
    h.run();await flush();assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);assert.deepEqual(h.phases,[]);
    assert.equal(h.context.bootSourcesUnavailable(),true);assert.deepEqual(h.context.matchedExperiments,[]);assert.deepEqual(h.context.visibleExperiments,[]);
  }
});

test("source failure classification uses current checked evidence, not stale or empty candidate jobs",()=>{
  const h=readiness({qqConnection:"connected",onboardingFirstRun:false});
  const update=h.context.recommendationUpdateRef.current;
  const failed={evidenceRevision:update.revision,candidateCount:120,checkedCandidateCount:120,playableCandidateCount:0};
  for(const record of [{...failed,evidenceRevision:update.revision-1},{...failed,candidateCount:0},
    {...failed,checkedCandidateCount:0},{...failed,playableCandidateCount:1}]){
    update.records=[record];assert.equal(h.context.bootSourcesUnavailable(),false);
  }
  update.records=[failed];assert.equal(h.context.bootSourcesUnavailable(),true);
  update.revision++;assert.equal(h.context.bootSourcesUnavailable(),false,"a previous failed round must not poison a later explicit retry");
  update.records=[{...failed,evidenceRevision:update.revision},
    {...failed,evidenceRevision:update.revision,playableCandidateCount:2},{...failed,evidenceRevision:update.revision,playableCandidateCount:3}];
  assert.equal(h.context.bootSourcesUnavailable(),false,"only the latest two lane records describe current preparation");
});

test("real candidate shortage with some prepared sources may expand while stale source failures do not block it",()=>{
  for(const record of [
    {evidenceRevision:2,candidateCount:120,checkedCandidateCount:120,playableCandidateCount:4},
    {evidenceRevision:1,candidateCount:120,checkedCandidateCount:120,playableCandidateCount:0},
    {evidenceRevision:2,candidateCount:0,checkedCandidateCount:0,playableCandidateCount:0}]){
    const h=readiness({qqConnection:"connected",onboardingFirstRun:false,matchedExperiments:[],visibleExperiments:[],
      recommendationPoolsRef:{current:{match:{status:"insufficient_candidates",visible:[]},frontier:{status:"completed",visible:[]}}}});
    h.context.recommendationUpdateRef.current.records=[record];effect("bootRetryRef.current < 3",h.context)();
    assert.equal(h.context.bootRetryRef.current,1);assert.equal(h.timers.length,1);
    assert.ok(h.context.recommendationUpdateRef.current.triggers.has("continuation"));
  }
});

test("a failed unchanged image decode cannot be counted as a prepared resource",async()=>{
  const image={src:"/broken-fallback.png",complete:false,naturalWidth:0,decode:()=>Promise.reject(Error("broken image"))};
  const h=readiness({},[image]);h.run();await flush();
  for(let i=0;i<3;i++){assert.equal(h.readyCalls(),0);h.tick();await flush();}
  assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);assert.equal(h.context.bootResourceError,true);
});

test("required local artwork decoding must settle before the next rendered frame permits enter",async()=>{
  const cover=deferred(),h=readiness({},[cover]);h.run();await flush();
  assert.equal(h.imageReads(),1);assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
  cover.resolve();await flush();assert.equal(h.frames.length,1);assert.equal(h.readyCalls(),0);
  h.paint();assert.equal(h.readyCalls(),1);
});

test("old readiness effect cannot publish ready after local resource cleanup",async()=>{
  const cover=deferred(),h=readiness({},[cover]),cleanup=h.run();cleanup();cover.resolve();await flush();
  assert.equal(h.frames.length,0);assert.equal(h.readyCalls(),0);
  const second=readiness(),dispose=second.run();await flush();dispose();second.paint();assert.equal(second.readyCalls(),0);
});

test("font, local orb and fallback advance actual completion counts and wait for every required resource",async()=>{
  const fonts=deferred(),cloud=deferred(),fallback=deferred(),assets=[],completed=[],errors=[];
  const context={coverFallback:"/codio-icon.png",document:{fonts:{ready:fonts.promise}},
    Image:class{decode(){return this.src==="/codio-icon.png"?fallback.promise:cloud.promise;}},withTimeout:promise=>promise,
    setBootAssetsReady:value=>assets.push(value),setBootAssetCompleted:value=>completed.push(value),setBootResourceError:value=>errors.push(value)};
  effect("setBootAssetsReady(true)",context)();assert.deepEqual(assets,[false]);assert.deepEqual(completed,[0]);
  fonts.resolve();await flush();assert.deepEqual(assets,[false]);assert.deepEqual(completed,[0,1]);
  cloud.resolve();await flush();assert.deepEqual(assets,[false]);assert.deepEqual(completed,[0,1,2]);
  fallback.resolve();await flush();assert.deepEqual(assets,[false,true]);assert.deepEqual(completed,[0,1,2,3]);assert.deepEqual(errors,[false]);
});

test("a failed required local resource exposes retry without fabricated loading success",async()=>{
  const fonts=deferred(),cloud=deferred(),assets=[],completed=[],errors=[];
  const context={coverFallback:"/codio-icon.png",document:{fonts:{ready:fonts.promise}},Image:class{decode(){return cloud.promise;}},withTimeout:promise=>promise,
    setBootAssetsReady:value=>assets.push(value),setBootAssetCompleted:value=>completed.push(value),setBootResourceError:value=>errors.push(value)};
  effect("setBootAssetsReady(true)",context)();fonts.reject(Error("unavailable"));cloud.reject(Error("unavailable"));await flush();
  assert.deepEqual(assets,[false]);assert.deepEqual(completed,[0]);assert.deepEqual(errors,[true]);
  const h=readiness({bootResourceError:true,bootAssetsReady:false});
  const retry=elements(renderBoot(h.context),"button")[0];assert.equal(retry.children[0],"TRY AGAIN");
  retry.props.onClick({stopPropagation(){}});assert.equal(h.context.bootAssetAttempt,1);assert.equal(h.context.bootResourceError,false);
});

test("a failed cover replaced with a fallback must decode the new source before enter",async()=>{
  const fallback=deferred();let reads=0;
  const image={src:"https://example.invalid/cover.jpg",complete:false,naturalWidth:0,
    decode(){reads++;return reads===1?Promise.reject(Error("stalled source")):fallback.promise.then(()=>{image.complete=true;image.naturalWidth=300;});}};
  const h=readiness({},[image]);h.run();await flush();
  assert.equal(h.readyCalls(),0);assert.equal(h.timers.length,1,"wait for the cover component to render its fallback");
  image.src="/codio-icon.png";h.tick();await flush();assert.equal(reads,2);
  assert.equal(h.readyCalls(),0);assert.equal(h.frames.length,0);
  fallback.resolve();await flush();assert.equal(h.frames.length,1);h.paint();assert.equal(h.readyCalls(),1);
});

test("stalled remote covers settle to a local fallback and clean up their timer",()=>{
  for(const loaded of [false,true]){
    const sources=[];let timer,delay,cleared;
    const image={complete:loaded,naturalWidth:loaded?300:0};
    const context={imageRef:{current:image},currentSource:"https://example.invalid/cover.jpg",fallbackSrc:undefined,coverFallback:"/codio-icon.png",
      setCurrentSource:value=>sources.push(value),window:{setTimeout(fn,ms){timer=fn;delay=ms;return 7;},clearTimeout(id){cleared=id;}}};
    const cleanup=effect("A stalled remote cover",context)();assert.equal(delay,3000);timer();
    assert.deepEqual(sources,loaded?[]:["/codio-icon.png"]);cleanup();assert.equal(cleared,7);
  }
});

test("animation completion is independent and reduced motion uses the short path",()=>{
  for(const [reducedMotion,systemReduce] of [[false,false],[false,true],[true,false]]){
    let done=0,callback,delay,cleared;
    const context={reducedMotion,window:{matchMedia:()=>({matches:systemReduce}),setTimeout(fn,ms){callback=fn;delay=ms;return 5;},clearTimeout(id){cleared=id;}},
      setBootAnimationDone(value){if(value)done++;}};
    const cleanup=effect("setBootAnimationDone(true)",context)();
    if(reducedMotion||systemReduce){assert.equal(done,1);assert.equal(callback,undefined);assert.equal(cleanup,undefined);}
    else{assert.equal(done,0);assert.equal(delay,3060);callback();assert.equal(done,1);cleanup();assert.equal(cleared,5);}
  }
});

test("the actual final frame requires positive dimensions for the mounted local homepage shell",async()=>{
  for(const selector of [".topbar",".dashboard",".player-bar"])for(const bounds of [null,{width:0,height:100},{width:100,height:0}]){
    const h=readiness();h.run();await flush();h.context.layout[selector]=bounds;
    h.paint();assert.equal(h.readyCalls(),0,`${selector}/${JSON.stringify(bounds)}`);
    assert.equal(h.context.bootLayoutReady,false);assert.equal(h.context.bootResourceError,true);
  }
  const h=readiness();h.run();await flush();assert.equal(h.context.bootLayoutReady,false);h.paint();
  assert.equal(h.context.bootLayoutReady,true);assert.equal(h.readyCalls(),1);
});

test("QQ status restoration silently starts on mount and its timer is cleaned up",()=>{
  for(const bootPhase of ["playing","leaving","done"]){
    const calls=[],states=[],timers=[];let cleared;
    const context={bootPhase,window:{codioDesktop:{qqMusic:{}},setTimeout(fn,ms){timers.push({fn,ms});return 7;},clearTimeout(id){cleared=id;}},
      connectQQMusic:request=>calls.push(request),setQQPlaybackReady:value=>states.push(value),setQQConnection:value=>states.push(value),setImportState:value=>states.push(value)};
    const cleanup=effect("void connectQQMusic(false);",context)();assert.deepEqual(calls,[]);assert.deepEqual(states,[]);
    assert.equal(timers.length,1);assert.equal(timers[0].ms,0);timers[0].fn();assert.deepEqual(calls,[false]);cleanup();assert.equal(cleared,7);
  }
});

test("connected card state must also be mounted as twelve playable DOM cards in both lanes",async()=>{
  for(const lane of ["match","frontier"])for(const count of [0,11,13]){
    const h=readiness({qqConnection:"connected"});h.run();await flush();h.context.domCounts[lane]=count;h.paint();
    assert.equal(h.readyCalls(),0,`${lane}/${count}`);assert.equal(h.context.bootLayoutReady,false);assert.equal(h.context.bootResourceError,true);
  }
  const h=readiness({qqConnection:"connected"});h.run();await flush();h.paint();assert.equal(h.readyCalls(),1);
  assert.ok(h.selectors.includes(".match-section .experiment-card.playable"));
  assert.ok(h.selectors.includes(".boundary-section:not(.match-section) .experiment-card.playable"));
});

test("the actual recommendation article classes provide distinct lanes and unknown selectors cannot fabricate DOM cards",async()=>{
  assert.equal(recommendationArticles.length,2,"read real article markup rather than assuming two fixture selectors");
  assert.deepEqual(recommendationArticles.map(article=>article.lane).sort(),["frontier","match"]);
  const h=readiness({qqConnection:"connected"}),query=selector=>h.context.document.querySelectorAll(`${selector} .experiment-card.playable`).length;
  assert.equal(query(".match-section"),12);assert.equal(query(".boundary-section:not(.match-section)"),12);
  assert.equal(query(".boundary-section"),24,"a shared parent class cannot masquerade as just the frontier lane");
  assert.equal(query(".recommendation-section"),0,"the prior native-stall typo does not exist in actual JSX");
  assert.equal(query(".match-sectoin"),0);assert.equal(query(".boundary-section:not(.match-sectoin)"),24);
  h.context.domCounts.frontier=11;assert.equal(query(".match-section"),12);assert.equal(query(".boundary-section:not(.match-section)"),11);
  const actual=callbacks.get("homeViewReadyForBoot"),misspelled=actual.replace('[".match-section",','[".recommendation-section",');
  assert.notEqual(misspelled,actual,"inject the exact old typo into the actual final-frame effect as a regression proof");
  const regression=readiness({qqConnection:"connected"});
  regression.context.homeViewReadyForBoot=bind(`return (${misspelled});`,regression.context);
  regression.run();await flush();regression.paint();assert.equal(regression.readyCalls(),0);assert.equal(regression.context.bootResourceError,true);
});

test("a settled missing QQ connection is reminded once on the homepage, never during preparation or onboarding",()=>{
  const notifications=[],context={bootPhase:"playing",onboardingOpen:false,qqConnection:"needs-auth",qqConnectionNoticeRef:{current:false},
    notifySystem:(...args)=>notifications.push(args)};
  const notice=effect("qqConnectionNoticeRef.current",context);
  for(const bootPhase of ["playing","leaving"]){context.bootPhase=bootPhase;notice();assert.equal(notifications.length,0);}
  context.bootPhase="done";context.onboardingOpen=true;notice();assert.equal(notifications.length,0);
  context.onboardingOpen=false;
  for(const qqConnection of ["checking","syncing","authorizing"]){context.qqConnection=qqConnection;notice();assert.equal(notifications.length,0);}
  context.qqConnection="needs-auth";notice();notice();assert.equal(notifications.length,1);assert.match(notifications[0][2],/首页已准备好/);
  context.qqConnection="error";notice();assert.equal(notifications.length,1,"settled error rerenders must not repeat the same reminder");
  context.qqConnection="connected";notice();assert.equal(context.qqConnectionNoticeRef.current,false);assert.equal(notifications.length,1);
  context.qqConnection="needs-auth";notice();assert.equal(notifications.length,2,"a later real disconnect can be reminded once again");
});
