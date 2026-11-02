import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import ts from "typescript";
import libraryModule from "../desktop/codio-qq-library.cjs";

// Run the actual main-process functions with isolated providers. Never start
// Electron or access real cookies, credentials, userData or media streams.
const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const metadataLimitDeclaration = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .find(node => node.name.getText(ast) === "SONG_METADATA_LIMIT");
const actualMetadataLimit = new Function(`return (${metadataLimitDeclaration.initializer.getText(ast)});`)();
const functions = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
})(ast);
const bind = (names, context) => {
  if (names.includes("resolveQQPlaybackOnce")) names = [...new Set(["firstReachableQQStream", ...names])];
  if (names.includes("readQQLibraryOnce")) {
    context.loadQQMetadataCache ||= async () => {};
    context.songMetadataCache ||= new Map();
    context.SONG_METADATA_TTL_MS ||= 7 * 24 * 60 * 60 * 1000;
  }
  names.forEach(name => assert.ok(functions.has(name), `Missing actual function ${name}`));
  if (!Object.hasOwn(context, "qqPlaybackAuthorizationFailure")) context.qqPlaybackAuthorizationFailure = null;
  if (!Object.hasOwn(context, "qqPlaybackAuthorizationRevision")) context.qqPlaybackAuthorizationRevision = 0;
  if (!Object.hasOwn(context, "qqPlaybackVerificationUrl")) context.qqPlaybackVerificationUrl = null;
  if (!Object.hasOwn(context, "qqPlaybackAuthorizationTrack")) context.qqPlaybackAuthorizationTrack = null;
  if (!Object.hasOwn(context, "qqPlaybackVerificationBlocked")) context.qqPlaybackVerificationBlocked = null;
  context.crypto ||= crypto;
  context.URL ||= URL;
  for (const helper of ["qqPlaybackKeyHash", "isTrustedQQUrl", "isAllowedQQAuthNavigation", "installQQAuthGuards"])
    if (functions.has(helper) && !context[helper] && !names.includes(helper))
      context[helper] = new Function("context", `with(context){${functions.get(helper)};return ${helper};}`)(context);
  return new Function("context", `with(context){${names.map(name => functions.get(name)).join("\n")};return {${names.join(",")}};}`)(context);
};
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("QQ fetch times out by aborting the native request, not only its caller", async () => {
  let signal;
  const provider = { fetch(_url, options) {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  } };
  const { fetchQQSessionJson } = bind(["fetchQQSessionJson"], { AbortController, setTimeout, clearTimeout });
  await assert.rejects(fetchQQSessionJson(provider, "isolated:search", {}, "QQ_SEARCH", 15), /QQ_SEARCH_TIMEOUT/);
  assert.equal(signal.aborted, true);
});

test("QQ timeout also covers a stuck response body and successful/error paths clear the timer", async () => {
  let signal, cleared = 0;
  const timerContext = { AbortController, setTimeout, clearTimeout(id) { cleared++; clearTimeout(id); } };
  const { fetchQQSessionJson } = bind(["fetchQQSessionJson"], timerContext);
  const body = { async fetch(_url, options) {
    signal = options.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("body aborted")), { once: true })) };
  } };
  await assert.rejects(fetchQQSessionJson(body, "isolated:body", {}, "QQ_PLAYBACK", 15), /QQ_PLAYBACK_TIMEOUT/);
  assert.equal(signal.aborted, true);
  const value = await fetchQQSessionJson({ fetch: async () => ({ ok: true, json: async () => ({ songs: [] }) }) }, "isolated:ok", {}, "QQ_SEARCH", 100);
  assert.deepEqual(value, { songs: [] });
  await assert.rejects(fetchQQSessionJson({ fetch: async () => ({ ok: false, status: 429 }) }, "isolated:rate", {}, "QQ_SEARCH", 100), /QQ_SEARCH_429/);
  assert.equal(cleared, 3);
});

test("production search and playback invoke the native timed fetch while retaining quality order", async () => {
  const values = [], probes = [], tickets = [];
  const auth = { qqSession: {}, uin: "qa-owner", playbackKey: "qa-not-real", cookieHeader: "qa-session-only" };
  const c = {
    QQ_SEARCH_URL: "https://catalog.invalid/search", QQ_MUSICU_URL: "https://catalog.invalid/play", USER_AGENT: "QA",
    QQ_QUALITY_FILES: [{ prefix: "RS01", ext: ".flac", quality: "HI-RES" }, { prefix: "M500", ext: ".mp3", quality: "128K" }],
    URL, readQQAuth: async () => auth, mapQQSearchTrack: value => value,
    fetchQQSessionJson: async (_session, url, options, label) => {
      values.push({ label, url, options });
      return label === "QQ_SEARCH" ? { data: { song: { list: [{ mid: "id-a", title: "QA" }] } } }
        : { req_0: { data: { midurlinfo: [{ filename: "RS01id-a.flac", purl: "high" }, { filename: "M500id-a.mp3", purl: "low" }], sip: ["https://media.invalid/"] } } };
    },
    createMediaTicket: async url => { tickets.push(url); return { url: `isolated:${url}`, expiresAt: 1800000 }; },
    probeMediaStream: async url => { probes.push(url); return { ok: true }; },
    refreshQQPlaybackSession: async () => { throw Error("Successful source must not refresh"); },
  };
  const h = bind(["searchQQMusic", "resolveQQPlaybackOnce"], c);
  assert.equal((await h.searchQQMusic(null, "QA"))[0].mid, "id-a");
  const playback = await h.resolveQQPlaybackOnce(null, { mid: "id-a" }, true, auth);
  assert.equal(playback.quality, "HI-RES"); assert.equal(playback.expiresAt, 1800000);
  assert.deepEqual(values.map(value => value.label), ["QQ_SEARCH", "QQ_PLAYBACK"]);
  assert.equal(probes.length, 2); assert.deepEqual(tickets, ["https://media.invalid/high", "https://media.invalid/low"]);
});

test("a reachable alternate route wins without waiting for a stalled route, whose probe is aborted", async () => {
  const routes=[],aborted=[];let active=0,maximum=0;
  const c={AbortController,setTimeout,clearTimeout,
    createMediaTicket:async url=>({url}),
    probeMediaStream(url,signal) {
      routes.push(url);active++;maximum=Math.max(maximum,active);
      if(url.endsWith("stalled"))return new Promise(resolve=>signal.addEventListener("abort",()=>{
        aborted.push(url);active--;resolve({ok:false});
      },{once:true}));
      active--;return Promise.resolve({ok:true});
    }};
  const {firstReachableQQStream}=bind(["firstReachableQQStream"],c);
  const result=await firstReachableQQStream([{purl:"stalled"},{purl:"reachable"},{purl:"unneeded"}],["isolated:"]);
  assert.equal(result.info.purl,"reachable");assert.equal(result.ticket.url,"isolated:reachable");
  assert.deepEqual(routes,["isolated:stalled","isolated:reachable"]);assert.deepEqual(aborted,["isolated:stalled"]);
  assert.equal(maximum,2);assert.equal(active,0);
});

test("the overall route deadline aborts both outstanding probes and cannot start more routes", async () => {
  let deadline,cleared=0,probed=0,aborted=0;
  const c={AbortController,setTimeout(callback,ms){assert.equal(ms,5000);deadline=callback;return 1;},clearTimeout(){cleared++;},
    createMediaTicket:async url=>({url}),probeMediaStream(_url,signal){
      probed++;return new Promise(resolve=>signal.addEventListener("abort",()=>{aborted++;resolve({ok:false});},{once:true}));
    }};
  const {firstReachableQQStream}=bind(["firstReachableQQStream"],c);
  const pending=firstReachableQQStream([{purl:"a"},{purl:"b"},{purl:"never-start"}],["isolated:"]);
  await Promise.resolve();assert.equal(probed,2);deadline();
  assert.equal(await pending,null);assert.equal(probed,2);assert.equal(aborted,2);assert.equal(cleared,1);
});

test("trickling media bytes cannot extend the absolute probe deadline or leave a request alive", async () => {
  let deadline,cleared=0,destroyed=0,responseCallback,options;
  const request=new EventEmitter();request.setTimeout=()=>{};
  request.destroy=()=>{destroyed++;request.emit("error",Object.assign(Error("aborted"),{code:"ABORT_ERR"}));};
  const c={setTimeout(callback,ms){assert.equal(ms,3000);deadline=callback;return 1;},clearTimeout(){cleared++;},
    http:{get(_url,configuration,callback){options=configuration;responseCallback=callback;return request;}}};
  const {probeMediaStream}=bind(["probeMediaStream"],c),controller=new AbortController();
  const pending=probeMediaStream("http://127.0.0.1/isolated",controller.signal);
  const response=new EventEmitter();Object.assign(response,{headers:{"content-type":"audio/mpeg"},statusCode:206,destroy(){this.emit("close");}});
  responseCallback(response);response.emit("data",Buffer.alloc(100));deadline();response.emit("end");
  assert.deepEqual(await pending,{ok:false,status:0,bytes:0,contentType:"timeout"});
  assert.equal(options.signal,controller.signal);assert.equal(options.headers.Range,"bytes=0-2047");
  assert.equal(destroyed,1);assert.equal(cleared,1);
});

test("invalid probe URLs release the deadline and return a fact instead of leaking a timer", async () => {
  let cleared=0;
  const c={setTimeout:()=>1,clearTimeout(){cleared++;},http:{get(){throw Error("Invalid URL");}}};
  const {probeMediaStream}=bind(["probeMediaStream"],c);
  assert.deepEqual(await probeMediaStream("not-a-url"),{ok:false,status:0,bytes:0,contentType:"network"});assert.equal(cleared,1);
});

function credentialPlaybackHarness() {
  const calls=[],probes=[],tickets=[];
  const qqSession={async fetch(url,options) {
    const request=new Request(url,options),origin=request.headers.get("origin");
    // Electron 42.4.1 net-fetch.ts only converts the default same-origin to
    // include when no Origin is supplied. This isolated provider models that
    // credential boundary, not QQ membership or a live network acceptance.
    const credentials=request.credentials==="same-origin"&&!origin?"include":request.credentials;
    const cookieSent=credentials==="include"||credentials==="same-origin"&&origin===new URL(url).origin;
    const payload=JSON.parse(options.body);
    calls.push({url,origin,credentials,cookieSent,method:request.method,signal:options.signal});
    return {ok:true,json:async()=>cookieSent
      ? {code:0,req_0:{code:0,data:{midurlinfo:[{filename:payload.req_0.param.filename[0],purl:"isolated-playback"}],sip:["https://media.invalid/"]}}}
      : {code:0,req_0:{code:1000,data:{midurlinfo:payload.req_0.param.filename.map(filename=>({filename,result:1000,purl:""})),sip:[]}}}};
  }};
  const c={AbortController,setTimeout,clearTimeout,QQ_MUSICU_URL:"https://u.y.qq.com/cgi-bin/musicu.fcg",USER_AGENT:"QA",
    QQ_QUALITY_FILES:[{prefix:"M500",ext:".mp3",quality:"128K"}],
    createMediaTicket:async url=>{tickets.push(url);return{url:"http://127.0.0.1:5277/qq-stream/isolated",expiresAt:1800000};},
    probeMediaStream:async url=>{probes.push(url);return{ok:true};},
    refreshQQPlaybackSession:async()=>{throw Error("This test must not refresh or use real session state");}};
  c.fetchQQSessionJson=bind(["fetchQQSessionJson"],c).fetchQQSessionJson;
  const {resolveQQPlaybackOnce}=bind(["resolveQQPlaybackOnce"],c);
  return{c,calls,probes,tickets,run:()=>resolveQQPlaybackOnce(null,{mid:"identity-a",mediaMid:"media-b"},false,
    {qqSession,uin:"100",playbackKey:"isolated-key-not-real"})};
}

test("actual cross-subdomain VKey POST includes session credentials and resolves a playable ticket", async () => {
  const h=credentialPlaybackHarness(),result=await h.run();
  assert.equal(h.calls.length,1);
  const call=h.calls[0];
  assert.equal(call.url,"https://u.y.qq.com/cgi-bin/musicu.fcg");assert.equal(call.origin,"https://y.qq.com");
  assert.notEqual(new URL(call.url).origin,call.origin,"exercise the real cross-subdomain boundary");
  assert.equal(call.method,"POST");assert.equal(call.credentials,"include");assert.equal(call.cookieSent,true);
  assert.equal(call.signal.aborted,false);assert.equal(result.playable,true);assert.equal(result.quality,"128K");
  assert.equal(h.probes.length,1);assert.deepEqual(h.tickets,["https://media.invalid/isolated-playback"]);
});

test("removing only the include option restores the old missing-cookie VKey failure", async () => {
  const h=credentialPlaybackHarness();
  const functionAst=ts.createSourceFile("fetch-before-fix.cjs",functions.get("fetchQQSessionJson"),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let removed=0;
  const transformed=ts.transform(functionAst,[context=>root=>{
    const visit=node=>{
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(functionAst)==="qqSession"
        &&node.expression.name.text==="fetch"&&ts.isObjectLiteralExpression(node.arguments[1])) {
        const options=node.arguments[1],properties=options.properties.filter(property=>{
          if(ts.isPropertyAssignment(property)&&property.name.getText(functionAst)==="credentials") {removed++;return false;}
          return true;
        });
        return ts.factory.updateCallExpression(node,node.expression,node.typeArguments,
          [node.arguments[0],ts.factory.updateObjectLiteralExpression(options,properties),...node.arguments.slice(2)]);
      }
      return ts.visitEachChild(node,visit,context);
    };
    return ts.visitNode(root,visit);
  }]);
  const legacySource=ts.createPrinter().printFile(transformed.transformed[0]);transformed.dispose();
  assert.equal(removed,1,"the counterfactual removes exactly one production credential setting, not playback checks");
  h.c.fetchQQSessionJson=new Function("context",`with(context){${legacySource};return fetchQQSessionJson;}`)(h.c);
  const legacy=await h.run();
  assert.equal(h.calls[0].credentials,"same-origin");assert.equal(h.calls[0].cookieSent,false);
  assert.equal(legacy.playable,false);assert.equal(legacy.failureKind,"SOURCE_UNAVAILABLE");
  assert.equal(legacy.providerStatus.requestCode,1000);assert.equal(h.probes.length,0);assert.equal(h.tickets.length,0);
  h.c.fetchQQSessionJson=bind(["fetchQQSessionJson"],h.c).fetchQQSessionJson;
  const fixed=await h.run();
  assert.equal(fixed.playable,true);assert.equal(h.calls[1].cookieSent,true);assert.equal(h.probes.length,1);
});

test("empty VKey URLs expose only bounded numeric provider status, never auth or response secrets", async () => {
  const secret="isolated-sensitive-marker-not-a-real-credential";
  const infos=[...Array.from({length:8},(_,index)=>({filename:`secret-file-${secret}-${index}`,result:100+index,purl:"",vkey:secret})),
    {filename:secret,result:100,purl:""},{result:`99-${secret}`,purl:""},{result:1.5,purl:""},{result:null,purl:""}];
  const c={QQ_MUSICU_URL:"https://u.y.qq.com/cgi-bin/musicu.fcg",USER_AGENT:"QA",QQ_QUALITY_FILES:[{prefix:"M500",ext:".mp3",quality:"128K"}],
    fetchQQSessionJson:async()=>({code:17,cookie:secret,req_0:{code:23,headers:{Cookie:secret},data:{midurlinfo:infos,sip:[`https://private.invalid/${secret}`],token:secret}}}),
    createMediaTicket:async()=>{throw Error("Empty URLs must not create a ticket");},probeMediaStream:async()=>{throw Error("No source to probe");}};
  const {resolveQQPlaybackOnce}=bind(["resolveQQPlaybackOnce"],c);
  const result=await resolveQQPlaybackOnce(null,{mid:"identity-a"},false,{qqSession:{},uin:"100",playbackKey:secret,cookieHeader:secret});
  assert.equal(result.playable,false);assert.equal(result.failureKind,"SOURCE_UNAVAILABLE");
  assert.deepEqual(result.providerStatus,{code:17,requestCode:23,entryCount:12,resultCodes:[100,101,102,103,104,105]});
  assert.ok(result.providerStatus.resultCodes.every(Number.isInteger));
  const serialized=JSON.stringify(result);
  assert.equal(serialized.includes(secret),false);assert.equal(serialized.includes("private.invalid"),false);
  for(const property of ["Cookie","headers","playbackKey","cookieHeader","authst","filename","sip","token","vkey"])
    assert.equal(Object.hasOwn(result,property),false,`do not return ${property}`);
  c.fetchQQSessionJson=async()=>({code:"17",req_0:{code:2.5,data:{midurlinfo:[{result:"100",purl:""}]}}});
  const invalid=await resolveQQPlaybackOnce(null,{mid:"identity-a"},false,{qqSession:{},uin:"100",playbackKey:secret});
  assert.deepEqual(invalid.providerStatus,{code:null,requestCode:null,entryCount:1,resultCodes:[]},"do not coerce untrusted diagnostic fields into numeric evidence");
});

test("the renderer receives the same bounded expiry the media server enforces, without the remote URL", async () => {
  const now = 100000, tickets = new Map([["expired", { expiresAt: now - 1 }]]);
  const { createMediaTicket } = bind(["createMediaTicket"], {
    ensureMediaServer: async () => 5277, crypto: { randomUUID: () => "isolated-ticket" },
    mediaTickets: tickets, Date: { now: () => now },
  });
  const ticket = await createMediaTicket("https://media.invalid/opaque", null);
  assert.equal(ticket.url, "http://127.0.0.1:5277/qq-stream/isolated-ticket");
  assert.equal(ticket.expiresAt, now + 30 * 60 * 1000);
  assert.equal(tickets.get("isolated-ticket").expiresAt, ticket.expiresAt);
  assert.equal(tickets.has("expired"), false);
  assert.equal(JSON.stringify(ticket).includes("media.invalid"), false);
});

test("same song/current session playback is single-flight; finished or failed requests are not cached", async () => {
  let calls = 0;
  const pending = gate();
  const c = { crypto, qqPlaybackPending: new Map(), readQQAuth: async () => ({ uin: "QA", cookieHeader: "qa-session" }),
    resolveQQPlaybackOnce: async () => { calls++; return pending.promise; } };
  const { resolveQQPlayback } = bind(["resolveQQPlayback"], c);
  const first = resolveQQPlayback(null, { mid: "same" });
  const second = resolveQQPlayback(null, { mid: "same" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1); assert.equal(c.qqPlaybackPending.size, 1);
  pending.resolve({ playable: true, url: "isolated:source" });
  assert.deepEqual(await first, await second); assert.equal(c.qqPlaybackPending.size, 0);
  await resolveQQPlayback(null, { mid: "same" }); assert.equal(calls, 2);
  c.resolveQQPlaybackOnce = async () => { calls++; throw Error("temporary provider failure"); };
  await assert.rejects(resolveQQPlayback(null, { mid: "same" }), /temporary/);
  assert.equal(c.qqPlaybackPending.size, 0);
  c.resolveQQPlaybackOnce = async () => ({ playable: true });
  assert.equal((await resolveQQPlayback(null, { mid: "same" })).playable, true);
});

test("different source versions or changed account/session credentials never share playback work", async () => {
  const pending = gate(); let owner = "session-a", calls = 0;
  const c = { crypto, qqPlaybackPending: new Map(), readQQAuth: async () => ({ uin: "QA", cookieHeader: owner }),
    resolveQQPlaybackOnce: async () => { calls++; return pending.promise; } };
  const { resolveQQPlayback } = bind(["resolveQQPlayback"], c);
  const first = resolveQQPlayback(null, { mid: "same", mediaMid: "version-a" });
  const second = resolveQQPlayback(null, { mid: "same", mediaMid: "version-b" });
  await Promise.resolve(); owner = "session-b";
  const third = resolveQQPlayback(null, { mid: "same", mediaMid: "version-a" });
  await Promise.resolve(); assert.equal(calls, 3);
  assert.ok([...c.qqPlaybackPending.keys()].every(key => !key.includes("session-a") && !key.includes("session-b")));
  pending.resolve({ playable: false }); await Promise.all([first, second, third]);
  assert.equal(c.qqPlaybackPending.size, 0);
});

test("same URL cover download deduplicates; successful data is reused and failure is retryable", async () => {
  let calls = 0;
  const pending = gate();
  const c = { qqCoverPending: new Map(), qqCoverCache: new Map(),
    loadRemoteBuffer: async () => { calls++; return pending.promise; } };
  const { loadQQCover } = bind(["loadQQCover"], c);
  const first = loadQQCover(null, "isolated:cover"), second = loadQQCover(null, "isolated:cover");
  assert.equal(calls, 1);
  pending.resolve({ buffer: Buffer.from("jpeg"), contentType: "image/jpeg" });
  const value = await first; assert.equal(await second, value); assert.equal(c.qqCoverPending.size, 0);
  assert.equal(await loadQQCover(null, "isolated:cover"), value); assert.equal(calls, 1);
  c.loadRemoteBuffer = async () => { calls++; throw Error("temporary cover failure"); };
  assert.equal(await loadQQCover(null, "isolated:failed"), ""); assert.equal(c.qqCoverCache.has("isolated:failed"), false);
  c.loadRemoteBuffer = async () => ({ buffer: Buffer.from("recovered"), contentType: "image/jpeg" });
  assert.match(await loadQQCover(null, "isolated:failed"), /^data:image/);
});

test("cover LRU has both count/UTF-16 byte bounds and expires without touching persistent data", async () => {
  let clock = 0, byteSize = 32;
  const c = { qqCoverPending: new Map(), qqCoverCache: new Map(), Date: { now: () => clock },
    loadRemoteBuffer: async () => ({ buffer: Buffer.alloc(byteSize), contentType: "image/jpeg" }) };
  const { loadQQCover } = bind(["loadQQCover"], c);
  for (let i = 0; i < 65; i++) await loadQQCover(null, `isolated:${i}`);
  assert.equal(c.qqCoverCache.size, 64); assert.equal(c.qqCoverCache.has("isolated:0"), false);
  await loadQQCover(null, "isolated:1"); await loadQQCover(null, "isolated:new");
  assert.equal(c.qqCoverCache.has("isolated:1"), true); assert.equal(c.qqCoverCache.has("isolated:2"), false);
  byteSize = 1024 * 1024;
  for (let i = 0; i < 12; i++) await loadQQCover(null, `isolated:large-${i}`);
  assert.ok([...c.qqCoverCache.values()].reduce((sum, item) => sum + item.bytes, 0) <= 12 * 1024 * 1024);
  const old = c.qqCoverCache.get("isolated:large-11"); clock += 7 * 60 * 60 * 1000;
  await loadQQCover(null, "isolated:large-11");
  assert.notEqual(c.qqCoverCache.get("isolated:large-11"), old);
});

test("forced QQ refresh shares one warm-up and releases single-flight state after failure", async () => {
  const pending = gate(); let calls = 0;
  const status = { loggedIn: true, playbackReady: true };
  const c = { qqPlaybackRefreshPending: null, readQQStatus: async () => status,
    refreshQQPlaybackSessionOnce: async () => { calls++; return pending.promise; } };
  const { refreshQQPlaybackSession } = bind(["refreshQQPlaybackSession"], c);
  const first = refreshQQPlaybackSession(true), second = refreshQQPlaybackSession(true);
  await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve(status); assert.deepEqual(await first, await second); assert.equal(c.qqPlaybackRefreshPending, null);
  assert.deepEqual(await refreshQQPlaybackSession(false), status); assert.equal(calls, 1);
  c.refreshQQPlaybackSessionOnce = async () => { calls++; throw Error("temporary refresh failure"); };
  await assert.rejects(refreshQQPlaybackSession(true), /temporary/); assert.equal(c.qqPlaybackRefreshPending, null);
});

test("a known rejected authorization returns immediately without hidden warm-up even when forced", async () => {
  for (const force of [false, true]) {
    let reads = 0, warmups = 0;
    const status = { loggedIn: true, playbackReady: false, authorizationRequired: true };
    const c = {
      qqPlaybackRefreshPending: null,
      readQQStatus: async () => { reads++; return status; },
      refreshQQPlaybackSessionOnce: async () => { warmups++; throw Error("Known authorization rejection cannot be fixed by hidden warm-up"); },
    };
    const { refreshQQPlaybackSession } = bind(["refreshQQPlaybackSession"], c);
    assert.equal(await refreshQQPlaybackSession(force), status);
    assert.equal(reads, 1); assert.equal(warmups, 0); assert.equal(c.qqPlaybackRefreshPending, null);
  }
});

test("a stuck warm-up navigation is actually destroyed at its bounded timeout", async () => {
  let rejectNavigation, timeoutCallback, destroyed = false, clearCalls = 0, destroyCalls = 0;
  const initial = { loggedIn: true, playbackReady: false };
  const c = { QQ_PLAYER_URL: "isolated:player", USER_AGENT: "QA", Date,
    createQQWindow: () => ({ isDestroyed: () => destroyed, destroy() { destroyed = true; destroyCalls++; rejectNavigation(Error("closed")); },
      loadURL: () => new Promise((_resolve, reject) => { rejectNavigation = reject; }) }),
    setTimeout(callback, delay) { assert.equal(delay, 12000); timeoutCallback = callback; return 1; },
    clearTimeout() { clearCalls++; }, readQQStatus: async () => { throw Error("No status polling after timeout"); } };
  const { refreshQQPlaybackSessionOnce } = bind(["refreshQQPlaybackSessionOnce"], c);
  const pending = refreshQQPlaybackSessionOnce(initial); timeoutCallback();
  assert.equal(await pending, initial); assert.equal(destroyCalls, 1); assert.equal(clearCalls, 1);
});

function authorizationHarness() {
  let key = "isolated-rejected-playback-key", providerReply;
  const calls = { fetch: 0, refresh: 0, ticket: 0, probe: 0, flush: 0, remove: 0 };
  const cookies = () => [
    { name: "wxuin", value: "100001", domain: ".qq.com" },
    { name: "wxopenid", value: "isolated-identity-not-a-real-token", domain: ".qq.com" },
    { name: "qm_keyst", value: key, domain: ".qq.com" },
    { name: "qqmusic_key", value: key, domain: ".qq.com" },
  ];
  const qqSession = Object.assign(new EventEmitter(), {
    cookies: { get: async () => cookies(), remove: async () => { calls.remove++; } },
    flushStorageData: async () => { calls.flush++; },
    clearStorageData: async () => { calls.remove++; },
  });
  const c = {
    QQ_PARTITION: "persist:isolated-qq", session: { fromPartition: partition => {
      assert.equal(partition, "persist:isolated-qq"); return qqSession;
    } },
    QQ_MUSICU_URL: "https://u.y.qq.com/cgi-bin/musicu.fcg", USER_AGENT: "QA",
    QQ_QUALITY_FILES: [{ prefix: "M500", ext: ".mp3", quality: "128K" }],
    fetchQQSessionJson: async () => { calls.fetch++; return providerReply; },
    refreshQQPlaybackSession: async () => { calls.refresh++; throw Error("Rejected authorization must not warm up in a loop"); },
    createMediaTicket: async () => { calls.ticket++; return { url: "isolated:ticket", expiresAt: 1800000 }; },
    probeMediaStream: async () => { calls.probe++; return { ok: true }; },
  };
  Object.assign(c, bind(["readQQStatus", "readQQAuth", "resolveQQPlaybackOnce"], c));
  const verificationReply = (validUrl = "https://c.y.qq.com/isolated-authorization?opaque=isolated-sensitive-marker") => ({
    code: 0, req_0: { code: 104009, data: {
      retcode: 104009, validUrl, verify_type: 0,
      msg: "isolated-sensitive-marker invalidq", validTitle: "", validText: "",
      midurlinfo: [{ filename: "M500media-a.mp3", result: 0, purl: "" }],
    } },
  });
  providerReply = verificationReply();
  return { c, calls, verificationReply, setReply: value => { providerReply = value; }, setKey: value => { key = value; },
    resolve: (allowRefresh = true) => c.resolveQQPlaybackOnce(null, { mid: "identity-a", mediaMid: "media-a", vipRequired: true }, allowRefresh) };
}

test("provider-rejected playback key keeps identity logged in but is not a ready authorization", async () => {
  const h = authorizationHarness();
  const before = await h.c.readQQStatus();
  assert.equal(before.loggedIn, true); assert.equal(before.playbackReady, true);
  const result = await h.resolve();
  assert.equal(result.playable, false); assert.equal(result.requiresLogin, true);
  assert.equal(result.failureKind, "AUTHORIZATION_REQUIRED");
  const after = await h.c.readQQStatus();
  assert.equal(after.loggedIn, true, "do not erase a known identity because playback authorization was rejected");
  assert.equal(after.playbackReady, false); assert.equal(after.authorizationRequired, true);
  assert.equal(h.c.qqPlaybackAuthorizationFailure, crypto.createHash("sha256").update("isolated-rejected-playback-key").digest("hex"),
    "remember only a rejected key hash, never its plaintext");
  assert.equal(h.c.qqPlaybackVerificationUrl, h.verificationReply().req_0.data.validUrl,
    "retain the provider's trusted recovery destination in main-process memory only");
  assert.equal(h.calls.fetch, 1); assert.equal(h.calls.refresh, 0);
  assert.equal(h.calls.remove, 0, "never clear real or fixture cookie state to manufacture reconnection");
  assert.equal(h.calls.ticket, 0); assert.equal(h.calls.probe, 0);
  const serialized = JSON.stringify(result);
  for (const secret of ["isolated-sensitive-marker", "c.y.qq.com", "invalidq", "validUrl", "validTitle", "validText", "isolated-rejected-playback-key"])
    assert.equal(serialized.includes(secret), false, `do not expose provider verification/private data: ${secret}`);
});

test("rejected credential calls are bounded without repeated requests or refresh; a new credential can recover", async () => {
  const h = authorizationHarness();
  await h.resolve();
  for (let i = 0; i < 24; i++) {
    const result = await h.resolve();
    assert.equal(result.playable, false); assert.equal(result.requiresLogin, true);
    assert.equal(result.failureKind, "AUTHORIZATION_REQUIRED");
  }
  assert.equal(h.calls.fetch, 1, "one rejected key must not be retried for all 24 startup sources");
  assert.equal(h.calls.refresh, 0);
  h.setKey("isolated-new-playback-key");
  const recovered = await h.c.readQQStatus();
  assert.equal(recovered.loggedIn, true); assert.equal(recovered.playbackReady, true);
  assert.equal(recovered.authorizationRequired, false); assert.equal(h.c.qqPlaybackAuthorizationFailure, null);
  assert.equal(h.c.qqPlaybackVerificationUrl, null, "a new key must discard the previous key's verification destination");
  h.setReply({ code: 0, req_0: { code: 0, data: { midurlinfo: [{ filename: "M500media-a.mp3", purl: "isolated-audio" }], sip: ["https://media.invalid/"] } } });
  const result = await h.resolve();
  assert.equal(result.playable, true); assert.equal(h.calls.fetch, 2); assert.equal(h.calls.probe, 1);
  assert.equal(h.c.qqPlaybackAuthorizationFailure, null);
  assert.equal(h.calls.remove, 0);
});

test("untrusted verification URLs cannot authorize navigation or poison the saved session capability", async () => {
  for (const url of ["https://qq.com.attacker.invalid/verify", "http://c.y.qq.com/verify", "javascript:alert(1)", "not a url"]) {
    const h = authorizationHarness(); h.setReply(h.verificationReply(url));
    const result = await h.resolve(false);
    assert.equal(result.playable, false); assert.notEqual(result.failureKind, "AUTHORIZATION_REQUIRED");
    assert.equal(h.c.qqPlaybackAuthorizationFailure, null);
    assert.equal(h.c.qqPlaybackVerificationUrl, null, "do not save an untrusted recovery destination");
    assert.equal((await h.c.readQQStatus()).playbackReady, true);
    assert.equal(h.calls.remove, 0); assert.equal(h.calls.ticket, 0);
    assert.equal(JSON.stringify(result).includes(url), false);
  }
});

test("a bounded explicit source revalidation clears a rejection only after the playable stream probe succeeds", async () => {
  const h = authorizationHarness(); await h.resolve();
  h.setReply({ code: 0, req_0: { code: 0, data: { midurlinfo: [{ filename: "M500media-a.mp3", purl: "isolated-audio" }], sip: ["https://media.invalid/"] } } });
  h.c.probeMediaStream = async () => { h.calls.probe++; return { ok: false }; };
  const notAudible = await h.resolve(false);
  assert.equal(notAudible.playable, false); assert.equal(notAudible.failureKind, "STREAM_UNREACHABLE");
  assert.equal((await h.c.readQQStatus()).authorizationRequired, true);
  assert.equal(h.c.qqPlaybackVerificationUrl, h.verificationReply().req_0.data.validUrl,
    "a failed stream probe must not discard the still-required recovery destination");
  h.c.probeMediaStream = async () => { h.calls.probe++; return { ok: true }; };
  const validated = await h.resolve(false);
  assert.equal(validated.playable, true); assert.equal(h.c.qqPlaybackAuthorizationFailure, null);
  assert.equal(h.c.qqPlaybackVerificationUrl, null, "a successful stream probe clears both pieces of rejection evidence");
  assert.equal((await h.c.readQQStatus()).playbackReady, true);
  assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
});

function loginHarness(h) {
  const windows = [], timeouts = new Map(), intervals = new Map(); let timerId = 0;
  const c = h.c;
  Object.assign(c, {
    loginPromise: null, QQ_LOGIN_URL: "https://y.qq.com/n/ryqq/profile", QQ_LOGIN_FALLBACK_URL: "https://y.qq.com/isolated-login-fallback",
    QQ_PLAYER_URL: "https://y.qq.com/n/ryqq/player", shell: { openExternal: async () => { throw Error("No external URLs in isolated login"); } },
    createQQWindow: options => {
      const window = new EventEmitter(); window.webContents = new EventEmitter();
      window.webContents.session = c.session.fromPartition(c.QQ_PARTITION);
      window.webContents.setWindowOpenHandler = handler => { window.windowOpenHandler = handler; };
      window.destroyed = false; window.options = options; window.loaded = [];
      window.webContents.getURL = () => window.currentURL || window.loaded.at(-1) || "";
      window.isDestroyed = () => window.destroyed;
      window.destroy = () => { if (!window.destroyed) { window.destroyed = true; window.webContents.emit("destroyed"); window.emit("closed"); } };
      window.show = () => {}; window.focus = () => {};
      window.loadURL = async url => { window.currentURL = url; window.loaded.push(url); };
      windows.push(window); return window;
    },
    setTimeout: (callback, delay) => { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (callback, delay) => { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
  });
  Object.assign(c, bind(["openQQLogin"], c));
  return { c, windows, timeouts, intervals,
    settle: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    navigate: (url, index = 0) => {
      const window = windows[index]; window.currentURL = url;
      window.webContents.emit("did-navigate", {}, url, 200, "OK");
      window.webContents.emit("did-navigate-in-page", {}, url, true);
      window.webContents.emit("did-finish-load");
    },
    poll: async () => { for (const callback of intervals.values()) await callback.callback(); },
    runTimeout: async delay => {
      const entry = [...timeouts].find(([, value]) => value.delay === delay);
      assert.ok(entry, `expected actual scheduled ${delay}ms callback`);
      timeouts.delete(entry[0]); await entry[1].callback();
    },
  };
}

test("rejected key opens the provider's exact trusted verification URL instead of a profile-only recovery", async () => {
  const h = authorizationHarness();
  const verificationUrl = "https://c.y.qq.com/isolated-authorization?opaque=isolated-recovery-only";
  h.setReply(h.verificationReply(verificationUrl)); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true });
  await login.settle();
  assert.equal(login.windows.length, 1);
  assert.deepEqual(login.windows[0].loaded, [verificationUrl], "open the provider's exact URL, including its opaque query");
  assert.notEqual(login.windows[0].loaded[0], login.c.QQ_LOGIN_URL);
  for (let i = 0; i < 4; i++) await login.poll();
  assert.equal(login.windows.length, 1); assert.equal(login.timeouts.size, 0);
  assert.equal(login.windows[0].isDestroyed(), false, "the unchanged rejected key cannot end required verification");
  login.windows[0].destroy(); const status = await pending;
  assert.equal(status.authorizationRequired, true); assert.equal(status.playbackReady, false);
  assert.equal(JSON.stringify(status).includes("isolated-recovery-only"), false, "never return the provider verification URL to the renderer");
  assert.equal(h.calls.fetch, 2, "closing rejected verification explicitly revalidates the source once"); assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
});

test("a changed key discards a stale verification URL before force login falls back to the profile", async () => {
  const h = authorizationHarness(); await h.resolve();
  const oldVerificationUrl = h.c.qqPlaybackVerificationUrl;
  h.setKey("isolated-replacement-key");
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true });
  await login.settle();
  assert.equal(h.c.qqPlaybackAuthorizationFailure, null); assert.equal(h.c.qqPlaybackVerificationUrl, null);
  assert.equal(login.windows.length, 1); assert.deepEqual(login.windows[0].loaded, [login.c.QQ_LOGIN_URL]);
  assert.equal(login.windows[0].loaded.includes(oldVerificationUrl), false);
  login.windows[0].destroy(); const status = await pending;
  assert.equal(status.authorizationRequired, false); assert.equal(status.playbackReady, true);
  assert.equal(h.calls.fetch, 1); assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
});

test("force login rejects an untrusted memory-only verification destination even for the rejected key", async () => {
  for (const verificationUrl of ["https://qq.com.attacker.invalid/verify", "http://c.y.qq.com/verify", "javascript:alert(1)", "not a url"]) {
    const h = authorizationHarness(); await h.resolve();
    // Exercise the recovery navigation guard independently of the provider guard.
    h.c.qqPlaybackVerificationUrl = verificationUrl;
    const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true });
    await login.settle();
    assert.equal(login.windows.length, 1); assert.deepEqual(login.windows[0].loaded, [login.c.QQ_LOGIN_URL]);
    assert.equal(login.windows[0].loaded.includes(verificationUrl), false);
    login.windows[0].destroy(); const status = await pending;
    assert.equal(status.authorizationRequired, true); assert.equal(status.playbackReady, false);
    assert.equal(h.calls.fetch, 2, "closing rejected verification performs one bounded source check"); assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
  }
});

test("force authorization opens official login even with cookie-ready identity, and unchanged key cannot finish", async () => {
  const h = authorizationHarness(), login = loginHarness(h);
  const pending = login.c.openQQLogin(null, { forceAuthorization: true }); let finished = false;
  pending.then(() => { finished = true; }); await login.settle();
  assert.equal(login.windows.length, 1); assert.equal(login.windows[0].loaded[0], login.c.QQ_LOGIN_URL);
  for (let i = 0; i < 30; i++) await login.poll();
  await login.settle();
  assert.equal(finished, false); assert.equal(login.windows[0].isDestroyed(), false);
  assert.equal(login.windows.length, 1); assert.equal(login.timeouts.size, 0);
  assert.equal(login.intervals.size, 1, "repeat status polls do not create warm-up windows or extra polling loops");
  assert.equal([...login.timeouts.values()].some(value => value.delay === 450), false,
    "unchanged cookie presence cannot schedule a false successful login");
  h.setKey("isolated-authorized-new-key"); await login.poll(); await login.runTimeout(450); await login.settle();
  const result = await pending;
  assert.equal(result.loggedIn, true); assert.equal(result.playbackReady, true);
  assert.equal(login.windows[0].isDestroyed(), true); assert.equal(login.c.loginPromise, null);
  assert.equal(h.calls.remove, 0);
});

test("closing forced official login returns the rejected actual capability, not fabricated success", async () => {
  const h = authorizationHarness(); await h.resolve(); const login = loginHarness(h);
  const pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  assert.equal(login.windows.length, 1); await login.poll();
  login.windows[0].destroy(); const result = await pending;
  assert.equal(result.loggedIn, true); assert.equal(result.playbackReady, false); assert.equal(result.authorizationRequired, true);
  assert.equal(login.c.loginPromise, null); assert.equal(login.intervals.size, 0);
  assert.equal(h.calls.fetch, 2); assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
});

const acceptedSourceReply = () => ({ code: 0, req_0: { code: 0, data: {
  midurlinfo: [{ filename: "M500media-a.mp3", purl: "isolated-authorized-audio" }], sip: ["https://media.invalid/"],
} } });

test("forced verification accepts a same-key status only after the actual source probe has cleared rejection", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  const rejectedTrack = h.c.qqPlaybackAuthorizationTrack;
  h.setReply(acceptedSourceReply());
  assert.equal((await h.c.resolveQQPlaybackOnce(null, rejectedTrack, false)).playable, true);
  assert.equal((await h.c.readQQStatus()).playbackReady, true);
  await login.poll();
  await login.runTimeout(450); await login.settle();
  const status = await pending;
  assert.equal(status.playbackReady, true); assert.equal(status.authorizationRequired, false);
  assert.equal(login.windows[0].isDestroyed(), true); assert.equal(login.c.loginPromise, null);
  assert.equal(h.calls.fetch, 2); assert.equal(h.calls.probe, 1); assert.equal(h.calls.remove, 0);
});

test("an old delayed VKey rejection cannot undo a forced same-key source recovery", async () => {
  const h = authorizationHarness(); await h.resolve();
  const oldReply = gate();
  h.c.fetchQQSessionJson = async () => {
    h.calls.fetch++;
    return h.calls.fetch === 2 ? oldReply.promise : acceptedSourceReply();
  };
  const stalePlayback = h.resolve(false);
  const login = loginHarness(h); await login.settle();
  assert.equal(h.calls.fetch, 2);
  const pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  assert.equal(h.c.qqPlaybackAuthorizationRevision, 1);
  const sameLogin = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  assert.equal(h.c.qqPlaybackAuthorizationRevision, 1, "reusing the open window must not supersede its own source check");
  login.navigate(login.c.QQ_PLAYER_URL); await login.settle();
  assert.equal((await pending).playbackReady, true); assert.equal((await sameLogin).playbackReady, true);
  assert.equal(h.calls.fetch, 3); assert.equal(h.calls.probe, 1);
  oldReply.resolve(h.verificationReply("https://c.y.qq.com/isolated-stale-verification"));
  const stale = await stalePlayback;
  assert.equal(stale.playable, false); assert.equal(stale.requiresLogin, false);
  assert.equal(stale.failureKind, "AUTHORIZATION_SUPERSEDED");
  const status = await h.c.readQQStatus();
  assert.equal(status.playbackReady, true); assert.equal(status.authorizationRequired, false);
  for (const key of ["qqPlaybackAuthorizationFailure", "qqPlaybackVerificationUrl", "qqPlaybackAuthorizationTrack", "qqPlaybackVerificationBlocked"])
    assert.equal(h.c[key], null, `a superseded provider failure must not write ${key}`);
  assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
});

test("new authorization does not reuse old pending playback while same-generation calls still share one actual request", async () => {
  const h = authorizationHarness(); await h.resolve();
  h.c.qqPlaybackPending = new Map(); Object.assign(h.c, bind(["resolveQQPlayback"], h.c));
  const oldReply = gate(), newReply = gate();
  h.c.fetchQQSessionJson = async () => {
    h.calls.fetch++;
    return h.calls.fetch === 2 ? oldReply.promise : newReply.promise;
  };
  const track = { mid: "identity-a", mediaMid: "media-a" };
  const oldPlayback = h.c.resolveQQPlayback(null, track, false);
  const login = loginHarness(h); await login.settle();
  assert.equal(h.calls.fetch, 2); assert.equal(h.c.qqPlaybackPending.size, 1);
  const pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  const currentFirst = h.c.resolveQQPlayback(null, track, false);
  const currentSecond = h.c.resolveQQPlayback(null, track, false); await login.settle();
  assert.equal(h.calls.fetch, 3, "the new epoch needs its own provider request, not the old pending result");
  assert.equal(h.c.qqPlaybackPending.size, 2, "keep one actual provider request per authorization generation");
  newReply.resolve(acceptedSourceReply());
  const first = await currentFirst, second = await currentSecond;
  assert.equal(first.playable, true); assert.deepEqual(first, second); assert.equal(h.calls.probe, 1);
  assert.equal(h.c.qqPlaybackPending.size, 1, "new-generation cleanup must not discard the old pending request");
  await login.poll(); await login.runTimeout(450); assert.equal((await pending).playbackReady, true);
  oldReply.resolve(h.verificationReply());
  assert.equal((await oldPlayback).failureKind, "AUTHORIZATION_SUPERSEDED");
  assert.equal(h.c.qqPlaybackPending.size, 0); assert.equal(h.calls.fetch, 3);
  assert.equal((await h.c.readQQStatus()).authorizationRequired, false); assert.equal(h.calls.remove, 0);
});

test("an old reachable-stream probe cannot clear a newer authorization rejection", async () => {
  const h = authorizationHarness(), oldProbe = gate(); h.setReply(acceptedSourceReply());
  h.c.probeMediaStream = async () => { h.calls.probe++; return oldProbe.promise; };
  const oldPlayback = h.resolve(false), login = loginHarness(h); await login.settle();
  assert.equal(h.calls.probe, 1);
  const pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  h.setReply(h.verificationReply("https://c.y.qq.com/isolated-new-verification"));
  assert.equal((await h.resolve(false)).requiresLogin, true);
  const newerFailure = h.c.qqPlaybackAuthorizationFailure, newerUrl = h.c.qqPlaybackVerificationUrl;
  oldProbe.resolve({ ok: true });
  const stale = await oldPlayback;
  assert.equal(stale.playable, false); assert.equal(stale.requiresLogin, false);
  assert.equal(stale.failureKind, "AUTHORIZATION_SUPERSEDED");
  assert.equal(h.c.qqPlaybackAuthorizationFailure, newerFailure); assert.equal(h.c.qqPlaybackVerificationUrl, newerUrl);
  assert.equal((await h.c.readQQStatus()).authorizationRequired, true);
  login.windows[0].destroy(); assert.equal((await pending).playbackReady, false);
  assert.equal(h.calls.fetch, 2); assert.equal(h.calls.probe, 1); assert.equal(h.calls.remove, 0);
});

test("closing a completed same-key captcha revalidates one actual source before returning successful capability", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  h.setReply(acceptedSourceReply());
  login.windows[0].destroy();
  const status = await pending;
  assert.equal(status.playbackReady, true); assert.equal(status.authorizationRequired, false);
  assert.equal(h.calls.fetch, 2); assert.equal(h.calls.probe, 1); assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
  assert.equal(login.c.loginPromise, null); assert.equal(login.intervals.size, 0);
});

test("closing verification with an unreachable stream never fabricates same-key authorization success", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  h.setReply(acceptedSourceReply());
  h.c.probeMediaStream = async () => { h.calls.probe++; return { ok: false }; };
  login.windows[0].destroy();
  const status = await pending;
  assert.equal(status.playbackReady, false); assert.equal(status.authorizationRequired, true);
  assert.equal(h.calls.fetch, 2); assert.equal(h.calls.probe, 1); assert.equal(h.calls.remove, 0); assert.equal(h.calls.refresh, 0);
  assert.equal(login.c.loginPromise, null); assert.equal(login.intervals.size, 0);
});

test("exact trusted HTTPS profile/player returns recover unchanged keys using actual playability", async () => {
  for (const pathname of ["/n/ryqq/profile", "/n/ryqq/player"]) {
    const h = authorizationHarness(); await h.resolve();
    const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
    h.setReply(acceptedSourceReply());
    login.navigate(`https://y.qq.com${pathname}?completed=isolated`); await login.settle();
    const status = await pending;
    assert.equal(status.playbackReady, true); assert.equal(status.authorizationRequired, false);
    assert.equal(h.calls.fetch, 2); assert.equal(h.calls.probe, 1); assert.equal(h.calls.remove, 0);
    assert.equal(login.windows[0].isDestroyed(), true); assert.equal(login.intervals.size, 0);
  }
});

test("unknown trusted-QQ HTTPS pages, lookalike profile paths and non-player origins cannot trigger revalidation", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  for (const url of ["https://y.qq.com/unrelated", "https://y.qq.com/n/ryqq/profile-lookalike", "https://c.y.qq.com/n/ryqq/profile"]) {
    login.navigate(url); await login.poll();
  }
  await login.settle();
  assert.equal(h.calls.fetch, 1); assert.equal(h.calls.probe, 0);
  assert.equal(login.windows[0].isDestroyed(), false);
  login.windows[0].destroy();
  assert.equal((await pending).playbackReady, false);
  assert.equal(h.calls.fetch, 2); assert.equal(h.calls.remove, 0);
});

test("repeated trusted completion events, polls and close share at most one in-flight revalidation", async () => {
  const h = authorizationHarness(); await h.resolve();
  const reply = gate();
  h.c.fetchQQSessionJson = async () => { h.calls.fetch++; return reply.promise; };
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  for (let index = 0; index < 6; index++) {
    login.navigate("https://y.qq.com/n/ryqq/profile");
    await login.poll();
  }
  await login.settle();
  assert.equal(h.calls.fetch, 2, "all completion events own one revalidation, not one request per callback/poll");
  login.windows[0].destroy();
  await login.settle(); assert.equal(h.calls.fetch, 2, "close must not bypass the in-flight single-check guard");
  reply.resolve(acceptedSourceReply()); await login.settle();
  const status = await pending;
  assert.equal(status.playbackReady, true); assert.equal(status.authorizationRequired, false);
  assert.equal(h.calls.probe, 1); assert.equal(h.calls.remove, 0); assert.equal(login.c.loginPromise, null);
});

test("unchanged-key polls and captcha-page reloads never auto-solve or send repeated source probes", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  const initial = login.windows[0].loaded[0];
  for (let index = 0; index < 12; index++) {
    login.navigate(index % 2 ? initial : "https://t.captcha.qq.com/verify?fixture=reload");
    await login.poll();
  }
  await login.settle();
  assert.equal(h.calls.fetch, 1); assert.equal(h.calls.probe, 0);
  assert.equal(login.windows[0].isDestroyed(), false);
  assert.equal((await h.c.readQQStatus()).authorizationRequired, true);
  login.windows[0].destroy(); const status = await pending;
  assert.equal(h.calls.fetch, 2, "an explicit user close makes only one bounded actual check");
  assert.equal(status.playbackReady, false); assert.equal(h.calls.remove, 0);
});

test("forceAuthorization requires literal true; ordinary ready login retains its non-mutating early return", async () => {
  for (const value of [undefined, false, "true", 1]) {
    const h = authorizationHarness(), login = loginHarness(h);
    const result = await login.c.openQQLogin(null, { forceAuthorization: value });
    assert.equal(result.playbackReady, true); assert.equal(login.windows.length, 0);
    assert.equal(h.calls.fetch, 0); assert.equal(h.calls.refresh, 0); assert.equal(h.calls.remove, 0);
  }
});

test("QQ auth navigation permits HTTPS QQ authorization, never mobile schemes, installers or spoofed hosts", () => {
  const { isAllowedQQAuthNavigation } = bind(["isAllowedQQAuthNavigation"], {});
  for (const url of ["https://y.qq.com/n/ryqq/profile", "https://open.weixin.qq.com/connect/qrconnect?state=isolated", "https://t.captcha.qq.com/verify", "about:blank"])
    assert.equal(isAllowedQQAuthNavigation(url), true, url);
  for (const url of ["qqmusic://verify", "intent://qqmusic/verify", "file:///D:/qa.exe", "https://qq.com.attacker.invalid/verify",
    "http://dldir1v6.qq.com/music/clntupate/QQMusic10031709.apk", "https://dldir1v6.qq.com/QQMusic.apk?download=1", "https://y.qq.com/package.EXE", "invalid"])
    assert.equal(isAllowedQQAuthNavigation(url), false, url);
});

test("same-window and iframe mobile jumps are cancelled before a single bounded source recheck", async () => {
  const h = authorizationHarness(); await h.resolve();
  const gateRequest = gate();
  h.c.fetchQQSessionJson = async () => { h.calls.fetch++; return gateRequest.promise; };
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  const contents = login.windows[0].webContents;
  let prevented = 0;
  for (const eventName of ["will-navigate", "will-redirect", "will-frame-navigate"])
    contents.emit(eventName, { url: "qqmusic://isolated-verify", preventDefault() { prevented++; } });
  await login.settle();
  assert.equal(prevented, 3); assert.equal(h.calls.fetch, 2, "all three events share one explicit recovery request");
  gateRequest.resolve(h.verificationReply()); await login.settle();
  const status = await pending;
  assert.equal(status.connectionError, "QQ_DESKTOP_AUTH_UNSUPPORTED"); assert.equal(status.playbackReady, false);
  assert.equal(status.loggedIn, true); assert.equal(h.calls.remove, 0); assert.equal(h.calls.refresh, 0);
  assert.equal(contents.session.listenerCount("will-download"), 0, "closing recovery removes its session download listener");
});

test("unchanged credential may recover after captcha only if the actual source probe succeeds", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  h.setReply({ code: 0, req_0: { code: 0, data: { midurlinfo: [{ filename: "M500media-a.mp3", purl: "isolated-audio" }], sip: ["https://media.invalid/"] } } });
  let prevented = false;
  login.windows[0].webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "qqmusic://return");
  await login.settle(); const status = await pending;
  assert.equal(prevented, true); assert.equal(status.playbackReady, true); assert.equal(status.connectionError, undefined);
  assert.equal(status.authorizationRequired, false); assert.equal(h.calls.fetch, 2); assert.equal(h.calls.probe, 1);
  assert.equal(h.c.qqPlaybackAuthorizationTrack, null); assert.equal(h.c.qqPlaybackVerificationBlocked, null);
  assert.equal(h.calls.remove, 0);
});

test("an unreachable source after mobile recovery must not fabricate successful playback", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  h.setReply({ code: 0, req_0: { code: 0, data: { midurlinfo: [{ filename: "M500media-a.mp3", purl: "isolated-audio" }], sip: ["https://media.invalid/"] } } });
  h.c.probeMediaStream = async () => { h.calls.probe++; return { ok: false }; };
  login.windows[0].webContents.emit("will-redirect", { url: "qqmusic://return", preventDefault() {} });
  await login.settle(); const status = await pending;
  assert.equal(status.playbackReady, false); assert.equal(status.connectionError, "QQ_DESKTOP_AUTH_UNSUPPORTED");
  assert.equal(h.calls.probe, 1); assert.equal(h.calls.remove, 0);
});

test("auth downloads are cancelled, unrelated contents are untouched, and mobile popup never reaches shell", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  const window = login.windows[0], contents = window.webContents; let cancelled = 0, external = 0;
  login.c.shell.openExternal = async () => { external++; };
  const event = { preventDefault() { cancelled++; } }, item = { getFilename: () => "QQMusic10031709.apk" };
  contents.session.emit("will-download", event, item, new EventEmitter());
  assert.equal(cancelled, 0);
  contents.session.emit("will-download", event, item, contents);
  assert.equal(cancelled, 1);
  assert.deepEqual(window.windowOpenHandler({ url: "qqmusic://return" }), { action: "deny" });
  await login.settle(); await pending;
  assert.equal(external, 0); assert.equal(h.calls.fetch, 2); assert.equal(h.calls.remove, 0);
});

test("a blocked mobile recovery is not reopened on repeat login; the official desktop profile is used", async () => {
  const h = authorizationHarness(); await h.resolve();
  const login = loginHarness(h), pending = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  login.windows[0].webContents.emit("will-frame-navigate", { url: "qqmusic://return", preventDefault() {} });
  await login.settle(); await pending;
  const retry = login.c.openQQLogin(null, { forceAuthorization: true }); await login.settle();
  assert.equal(login.windows.length, 2); assert.deepEqual(login.windows[1].loaded, [login.c.QQ_LOGIN_URL]);
  assert.equal(h.calls.fetch, 2, "opening the desktop login does not automatically send more playback requests");
  login.windows[1].destroy(); await retry;
  assert.equal(login.windows[1].webContents.session.listenerCount("will-download"), 0);
  assert.equal(h.calls.remove, 0);
});

async function isolatedCacheDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codio-native-qq-cache-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function metadataHarness(t, { directory, now = 1000000000, request } = {}) {
  directory ||= await isolatedCacheDirectory(t);
  let clock = now;
  const calls = [];
  const c = {
    fs, path, process, URL, Date: { now: () => clock },
    codioDataDirectories: { cache: directory }, app: { getPath: () => assert.fail("never access real userData/cache") },
    QQ_MUSICU_URL: "https://catalog.invalid/metadata", SONG_METADATA_TTL_MS: 7 * 24 * 60 * 60 * 1000, SONG_METADATA_LIMIT: actualMetadataLimit,
    songMetadataCache: new Map(), songMetadataPending: new Map(), songMetadataDiskLoaded: null,
    songMetadataWritePending: null, songMetadataWriteDirty: false, songMetadataActive: 0, songMetadataWaiters: [],
    requestQQJson: async (url, options) => {
      const id = JSON.parse(new URL(url).searchParams.get("data")).req_0.param.song_mid;
      calls.push({ id, options });
      return request ? request(id) : { code: 0, req_0: { code: 0, data: { track_info: { mid: id }, info: {
        genre: { content: [{ value: "Actual provider fixture genre" }] }, lan: { content: [{ value: "Language" }] },
      } } } };
    },
  };
  const names = ["qqMetadataCacheFile", "normalizeQQMetadata", "loadQQMetadataCache", "persistQQMetadataCache", "readQQTrackMetadata"];
  Object.assign(c, bind(names, c));
  return { c, calls, directory, setTime: value => { clock = value; }, readRaw: id => c.readQQTrackMetadata(null, id), read: async id => {
    const result = await c.readQQTrackMetadata(null, id);
    // Disk assertions explicitly flush optional catalogue work. Production IPC
    // is intentionally tested separately without this fixture-only wait.
    while (c.songMetadataWritePending) await c.songMetadataWritePending;
    return result;
  } };
}

test("verified metadata persists catalog evidence and a new process reads through without a provider call", async (t) => {
  const first = await metadataHarness(t);
  const [one, two] = await Promise.all([first.read("identityA"), first.read("identityA")]);
  assert.deepEqual(one, two);
  assert.equal(one.ok, true);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].options.timeoutMs, 3500);
  const file = path.join(first.directory, "qq-song-metadata-v1.json");
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.entries[0].value.mid, "identityA");
  assert.equal(persisted.entries[0].verifiedAt, 1000000000);
  const returning = await metadataHarness(t, { directory: first.directory, now: 1000000001 });
  assert.deepEqual(await returning.read("identityA"), one);
  assert.equal(returning.calls.length, 0);
  const expired = await metadataHarness(t, { directory: first.directory, now: 1000000000 + returning.c.SONG_METADATA_TTL_MS });
  assert.equal((await expired.read("identityA")).ok, true);
  assert.equal(expired.calls.length, 1);
});

test("unknown, wrong-identity, provider error and transient failure metadata are never cached as ready", async (t) => {
  const variants = [
    { code: 0, req_0: { code: 0, data: { track_info: { mid: "identityA" }, info: {} } } },
    { code: 0, req_0: { code: 0, data: { track_info: { mid: "different" }, info: { genre: { content: [{ value: "genre" }] } } } } },
    { code: 0, req_0: { code: 9, data: { track_info: { mid: "identityA" }, info: { genre: { content: [{ value: "genre" }] } } } } },
    null,
  ];
  for (const result of variants) {
    const h = await metadataHarness(t, { request: () => { if (result === null) throw Error("network"); return result; } });
    assert.equal((await h.read("identityA")).ok, false);
    assert.equal((await h.read("identityA")).ok, false);
    assert.equal(h.calls.length, 2);
    assert.equal(h.c.songMetadataCache.size, 0);
    await assert.rejects(readFile(path.join(h.directory, "qq-song-metadata-v1.json")), { code: "ENOENT" });
  }
});

test("metadata disk cache enforces identity, freshness, field whitelist and 1200-entry cap", async (t) => {
  const h = await metadataHarness(t);
  assert.equal(h.c.SONG_METADATA_LIMIT, 1200, "exercise the production constant, not a more generous fixture-only cap");
  const value = mid => ({ ok: true, mid, genres: ["genre"], source: "provider_metadata", confidence: .65,
    cookieHeader: "must-not-survive", playbackUrl: "https://media.invalid/private-ticket", apiKey: "must-not-survive" });
  const entries = Array.from({ length: 1205 }, (_, index) => ({ verifiedAt: 1000000000, value: value(`id${index}`) }));
  entries.push({ verifiedAt: 1000000001, value: value("future") });
  entries.push({ verifiedAt: 1, value: value("expired") });
  entries.push({ verifiedAt: 1000000000, value: { ...value("unverified"), source: "unknown" } });
  await writeFile(path.join(h.directory, "qq-song-metadata-v1.json"), JSON.stringify({ version: 1, entries }));
  const cached = await h.read("id1204");
  assert.equal(cached.ok, true); assert.equal(h.calls.length, 0);
  assert.equal(cached.cookieHeader, undefined); assert.equal(cached.playbackUrl, undefined); assert.equal(cached.apiKey, undefined);
  assert.ok(h.c.songMetadataCache.size <= 1200);
  await h.read("future"); await h.read("expired"); await h.read("unverified");
  assert.equal(h.calls.length, 3);
  const saved = await readFile(path.join(h.directory, "qq-song-metadata-v1.json"), "utf8");
  assert.doesNotMatch(saved, /must-not-survive|private-ticket|cookieHeader|playbackUrl|apiKey/);
  assert.ok(JSON.parse(saved).entries.length <= 1200);
});

test("a 480-song continuation working set survives a second scan and a new process without provider calls", async t => {
  const first = await metadataHarness(t);
  const entries = Array.from({length:480}, (_,i)=>({verifiedAt:1000000000,
    value:{ok:true,mid:`working${i}`,genres:["Isolated catalog evidence"],source:"provider_metadata",confidence:.65}}));
  await writeFile(path.join(first.directory,"qq-song-metadata-v1.json"),JSON.stringify({version:1,entries}));
  for(let scan=0;scan<2;scan++) for(const entry of entries) assert.equal((await first.read(entry.value.mid)).ok,true);
  assert.equal(first.calls.length,0);assert.equal(first.c.songMetadataCache.size,480);
  const restarted = await metadataHarness(t,{directory:first.directory,now:1000000001});
  for(const entry of entries) assert.equal((await restarted.read(entry.value.mid)).ok,true);
  assert.equal(restarted.calls.length,0);assert.equal(restarted.c.songMetadataPending.size,0);
});

test("metadata memory entries expire, preserve single-flight failure release and bound concurrent providers", async (t) => {
  let active = 0, maximum = 0;
  const h = await metadataHarness(t, { request: async id => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return { code: 0, req_0: { code: 0, data: { track_info: { mid: id }, info: { genre: { content: [{ value: "genre" }] } } } } };
  } });
  await Promise.all(Array.from({ length: 12 }, (_, index) => h.read(`song${index}`)));
  assert.equal(maximum, 2);
  assert.equal(h.c.songMetadataActive, 0);
  assert.equal(h.c.songMetadataPending.size, 0);
  const calls = h.calls.length;
  await h.read("song0"); assert.equal(h.calls.length, calls);
  h.setTime(1000000000 + h.c.SONG_METADATA_TTL_MS);
  await h.read("song0"); assert.equal(h.calls.length, calls + 1);
});

test("metadata IPC releases provider slots before optional disk persistence and coalesces a whole burst", async t => {
  const h = await metadataHarness(t), timers = [];
  let writes = 0;
  h.c.setTimeout = callback => { timers.push(callback); return timers.length; };
  h.c.fs = { ...fs, writeFile: async (...args) => { writes++; return fs.writeFile(...args); } };
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => h.readRaw(`burst${i}`)));
  assert.ok(results.every(item => item.ok)); assert.equal(h.c.songMetadataActive, 0);
  assert.equal(writes, 0, "Verified metadata returned without waiting for the debounce or filesystem");
  assert.equal(timers.length, 1); timers[0](); await h.c.songMetadataWritePending;
  assert.equal(writes, 1, "Forty results produce one atomic snapshot, not forty full rewrites");
  const saved = JSON.parse(await readFile(path.join(h.directory, "qq-song-metadata-v1.json"), "utf8"));
  assert.equal(saved.entries.length, 40); assert.equal(h.c.songMetadataWritePending, null);
});

test("metadata arriving during a disk write gets one serial follow-up; disk failure never invalidates verified metadata", async t => {
  const h = await metadataHarness(t), timers = [];
  let release, started, writes = 0, active = 0, maximum = 0;
  const writing = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  h.c.setTimeout = callback => { timers.push(callback); return timers.length; };
  h.c.fs = { ...fs, writeFile: async (...args) => {
    writes++; active++; maximum = Math.max(maximum, active);
    try { if (writes === 1) { started(); await gate; } return await fs.writeFile(...args); }
    finally { active--; }
  } };
  assert.ok((await h.readRaw("first" )).ok); timers[0](); await writing;
  assert.ok((await h.readRaw("duringWrite")).ok); assert.equal(h.c.songMetadataActive, 0);
  release(); await h.c.songMetadataWritePending;
  assert.equal(writes, 2); assert.equal(maximum, 1);
  const saved = JSON.parse(await readFile(path.join(h.directory, "qq-song-metadata-v1.json"), "utf8"));
  assert.deepEqual(saved.entries.map(item => item.value.mid), ["first", "duringWrite"]);
  h.c.fs.writeFile = async () => { throw Error("isolated disk unavailable"); };
  assert.ok((await h.readRaw("diskFailure")).ok); timers.at(-1)(); await h.c.songMetadataWritePending;
  assert.equal(h.c.songMetadataWritePending, null); assert.ok((await h.readRaw("diskFailure")).ok);
});

test("actual library IPC isolates owner snapshots/single-flight and explicit force bypasses returning-user cache", async (t) => {
  const directory = await isolatedCacheDirectory(t);
  let owner = "1001";
  const calls = [];
  const c = {
    fs, path, crypto, URL, URLSearchParams, codioDataDirectories: { library: directory },
    app: { getPath: () => assert.fail("never access real userData") }, qqLibraryPending: new Map(),
    readQQAuth: async () => ({ uin: owner, csrfToken: 17, cookieHeader: `isolated-owner=${owner}` }),
    readLibrarySnapshot: libraryModule.readLibrarySnapshot,
    mapQQSearchTrack: value => value,
    requestQQJson: async (rawUrl, options) => {
      calls.push({ rawUrl: String(rawUrl), options });
      const id = options.method === "POST" ? new URLSearchParams(options.body).get("loginUin") : new URL(rawUrl).searchParams.get("hostuin");
      await new Promise(resolve => setImmediate(resolve));
      return options.method === "POST" ? { code: 0, cdlist: [{ songlist: [{ mid: `song${id}`, title: `Owned ${id}`, artist: "Artist" }] }] }
        : { code: 0, data: { disslist: [{ tid: `playlist${id}`, name: `Owned ${id}`, song_cnt: 1 }] } };
    },
  };
  Object.assign(c, bind(["readQQLibrary", "readQQLibraryOnce"], c));
  const [one, duplicate] = await Promise.all([c.readQQLibrary(null, false), c.readQQLibrary(null, false)]);
  assert.equal(one.tracks[0].mid, "song1001"); assert.deepEqual(one, duplicate); assert.equal(calls.length, 2);
  const returning = await c.readQQLibrary(null, false);
  assert.equal(returning.cache.source, "snapshot"); assert.equal(calls.length, 2);
  owner = "2002";
  const other = await c.readQQLibrary(null, false);
  assert.equal(other.tracks[0].mid, "song2002"); assert.equal(calls.length, 4);
  owner = "1001";
  assert.equal((await c.readQQLibrary(null, false)).tracks[0].mid, "song1001"); assert.equal(calls.length, 4);
  const [forced, sameForce] = await Promise.all([c.readQQLibrary(null, true), c.readQQLibrary(null, true)]);
  assert.equal(forced.cache.source, "provider"); assert.deepEqual(forced, sameForce); assert.equal(calls.length, 6);
  assert.equal(c.qqLibraryPending.size, 0);
  const files = await fs.readdir(directory);
  assert.equal(files.length, 2); assert.ok(files.every(file => /^qq-library-[a-f0-9]{20}\.json$/.test(file)));
  for (const file of files) assert.doesNotMatch(await readFile(path.join(directory, file), "utf8"), /isolated-owner|cookieHeader|csrfToken|private-ticket/);
});

test("library IPC enriches exact identities with fresh verified cached facts without changing favorites or raw snapshot", async () => {
  const tracks=["ready","expired","wrong-id","future","heuristic","unknown"].map(mid=>Object.freeze({mid,likedInProvider:false,
    likedEvidence:Object.freeze({source:"playlist_name_hint",confirmed:false})}));
  const snapshot=Object.freeze({tracks:Object.freeze(tracks),likedCount:0,playlists:[]}),cache=new Map();let loaded=0;
  const now=100000,ttl=10000;
  for(const mid of ["ready","expired","wrong-id","future","heuristic"])
    cache.set(mid,{verifiedAt:mid==="expired"?now-ttl:mid==="future"?now+1:now-1,value:{ok:true,
      mid:mid==="wrong-id"?"different-song":mid,source:mid==="heuristic"?"artist_rule":"provider_metadata",
      genres:["R&B"],language:"English",releaseDate:"2020-01-01"}});
  const c={path,crypto,URL,URLSearchParams,Date:{now:()=>now},codioDataDirectories:{library:"isolated"},
    readLibrarySnapshot:async()=>snapshot,mapQQSearchTrack:value=>value,loadQQMetadataCache:async()=>{loaded++;},
    songMetadataCache:cache,SONG_METADATA_TTL_MS:ttl};
  const {readQQLibraryOnce}=bind(["readQQLibraryOnce"],c);
  const result=await readQQLibraryOnce({uin:"isolated",csrfToken:1,cookieHeader:"not-real"},false,"isolated-owner");
  assert.equal(loaded,1);assert.deepEqual(result.tracks[0].genres,["R&B"]);assert.equal(result.tracks[0].language,"English");
  for(const track of result.tracks.slice(1))assert.equal(track.genres,undefined,`${track.mid} is not verified usable evidence`);
  assert.equal(result.likedCount,0);assert.ok(result.tracks.every(track=>track.likedInProvider===false));
  assert.ok(snapshot.tracks.every(track=>track.genres===undefined));assert.deepEqual(result.tracks.map(track=>track.mid),tracks.map(track=>track.mid));
});

test("manual force is not swallowed by a concurrent normal snapshot lookup", async () => {
  const c = {
    crypto, qqLibraryPending: new Map(), readQQAuth: async () => ({ uin: "1111" }),
    readQQLibraryOnce: async (_auth, force) => ({ cache: { source: force ? "provider" : "snapshot" } }),
  };
  Object.assign(c, bind(["readQQLibrary"], c));
  const normal = c.readQQLibrary(null, false);
  const forced = c.readQQLibrary(null, true);
  assert.equal((await normal).cache.source, "snapshot");
  assert.equal((await forced).cache.source, "provider");
});

test("a changed account while library work is pending cannot receive the previous owner's snapshot", async () => {
  let owner = "1111";
  const firstGate = gate();
  const owners = [];
  const c = {
    crypto, qqLibraryPending: new Map(), readQQAuth: async () => ({ uin: owner }),
    readQQLibraryOnce: async auth => {
      owners.push(auth.uin);
      if (auth.uin === "1111") await firstGate.promise;
      return { tracks: [{ mid: `realfixture${auth.uin}` }] };
    },
  };
  Object.assign(c, bind(["readQQLibrary"], c));
  const previous = c.readQQLibrary(null, false);
  await Promise.resolve();
  owner = "2222";
  const current = await c.readQQLibrary(null, false);
  assert.equal(current.tracks[0].mid, "realfixture2222");
  assert.deepEqual(owners, ["1111", "2222"]);
  firstGate.resolve();
  assert.equal((await previous).tracks[0].mid, "realfixture1111");
  assert.equal(c.qqLibraryPending.size, 0);
});
