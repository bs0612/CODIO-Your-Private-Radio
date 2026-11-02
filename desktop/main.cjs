const path = require("node:path");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const {
  normalizeModelReply,
  requestDeepSeek,
  sanitizeMessages,
  serializeContext,
  verifyAndEncryptDeepSeekKey,
} = require("./codio-ai.cjs");
const { readOnboardingState, saveOnboardingState } = require("./codio-onboarding.cjs");
const { createLocalLibrary, serveLocalFile } = require("./codio-local.cjs");
const { readLibrarySnapshot } = require("./codio-qq-library.cjs");
const { decryptQRC, parseQQLyrics } = require("./codio-lyrics.cjs");
const { createSystemVolume } = require("./system-volume.cjs");
const systemVolume = createSystemVolume();
let stopSystemVolumeBroadcast = null;

function handleSystemVolume(event, value, write = false) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return { available: false, volume: null, muted: false, error: "SYSTEM_VOLUME_UNAUTHORIZED" };
  }
  return write ? systemVolume.setVolume(value) : systemVolume.getStatus();
}

function configureCodioDataDirectory() {
  const configuredRoot = String(process.env.CODIO_DATA_DIR || (fsSync.existsSync("D:\\Codio-Data") ? "D:\\Codio-Data" : "")).trim();
  if (!configuredRoot) return null;
  const root = path.resolve(configuredRoot);
  const directories = {
    userData: path.join(root, "user-data"),
    sessionData: path.join(root, "session-data"),
    cache: path.join(root, "cache"),
    logs: path.join(root, "logs"),
    musicAnalysis: path.join(root, "music-analysis"),
    waveforms: path.join(root, "waveforms"),
    models: path.join(root, "models"),
    library: path.join(root, "library"),
  };
  Object.values(directories).forEach((directory) => fsSync.mkdirSync(directory, { recursive: true }));
  app.setPath("userData", directories.userData);
  app.setPath("sessionData", directories.sessionData);
  app.setPath("cache", directories.cache);
  app.setPath("logs", directories.logs);
  return { root, ...directories };
}

const codioDataDirectories = configureCodioDataDirectory();
const localLibrary = createLocalLibrary(path.join(codioDataDirectories?.library || app.getPath("userData"), "local-library-v1.json"));

let localImportPending = null;
async function importLocalFiles(_event, mode) {
  if (!["files", "folder"].includes(mode)) throw Error("LOCAL_SELECTION_INVALID");
  if (localImportPending) throw Error("LOCAL_IMPORT_BUSY");
  localImportPending = (async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Import local WAV music", filters: [{ name: "PCM / Float WAV", extensions: ["wav"] }],
    properties: mode === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
  });
  return localLibrary.importSelected(selection.canceled ? [] : selection.filePaths);
  })();
  try { return await localImportPending; } finally { localImportPending = null; }
}

function musicAnalysisFile(trackId, version) {
  const safeTrackId = String(trackId || "").trim();
  const safeVersion = Number(version);
  if (!safeTrackId || safeTrackId.length > 512 || !Number.isInteger(safeVersion) || safeVersion < 1 || safeVersion > 100) throw new Error("ANALYSIS_KEY_INVALID");
  const directory = codioDataDirectories?.musicAnalysis || path.join(app.getPath("userData"), "music-analysis");
  fsSync.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${crypto.createHash("sha256").update(`timeline-v3-r2:${safeVersion}:${safeTrackId}`).digest("hex")}.json`);
}

async function readMusicAnalysis(trackId, version) {
  try {
    const value = JSON.parse(await fs.readFile(musicAnalysisFile(trackId, version), "utf8"));
    return value && value.version === version && value.trackId === trackId ? value : null;
  } catch {
    return null;
  }
}

async function saveMusicAnalysis(trackId, analysis) {
  if (!analysis || typeof analysis !== "object" || analysis.trackId !== trackId || analysis.version !== 3) throw new Error("ANALYSIS_VALUE_INVALID");
  const payload = JSON.stringify(analysis);
  if (payload.length > 5_000_000) throw new Error("ANALYSIS_VALUE_TOO_LARGE");
  const target = musicAnalysisFile(trackId, analysis.version);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, payload, "utf8");
  await fs.rename(temporary, target);
  return true;
}

// Windows can close the launcher's output pipe while Electron keeps running.
// A late diagnostic must never take down the radio.
[process.stdout, process.stderr].forEach((stream) => stream?.on("error", (error) => {
  if (error?.code !== "EPIPE") process.exitCode = 1;
}));

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const APP_ICON = path.join(__dirname, "..", "build", "icon.png");
const QQ_LOGIN_URL = "https://y.qq.com/n/ryqq/profile";
const QQ_LOGIN_FALLBACK_URL = "https://y.qq.com/";
const QQ_PLAYER_URL = "https://y.qq.com/n/ryqq/player";
const QQ_SEARCH_URL = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const QQ_LYRIC_URL = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
const QQ_MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const QQ_PARTITION = "persist:codio-qqmusic-login";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

let mainWindow = null;
let loginPromise = null;
let mediaServer = null;
let mediaServerPort = 0;
let appServerProcess = null;
let appServerUrl = "";
const mediaTickets = new Map();
const qqPlaybackPending = new Map();
const qqCoverPending = new Map();
const qqCoverCache = new Map();
const qqLyricCache = new Map();
const qqLyricPending = new Map();
let qqPlaybackRefreshPending = null;
// Memory-only negative capability evidence; never deletes persisted QQ cookies.
let qqPlaybackAuthorizationFailure = null;
let qqPlaybackAuthorizationRevision = 0;
// QQ's opaque verification address stays in this process, never in renderer status or logs.
let qqPlaybackVerificationUrl = null;
let qqPlaybackAuthorizationTrack = null;
let qqPlaybackVerificationBlocked = null;

function qqPlaybackKeyHash(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex");
}

const CODIO_AI_INSTRUCTIONS = `You are Codio, the private music DJ inside a desktop radio and you can operate the radio with tools.
Reply mainly in natural Simplified Chinese. Sound calm, perceptive, warm, and concise.
Lead with the answer. Usually reply in two to five short sentences unless the user explicitly asks for detail.
Understand intent directly, remember the recent conversation, and use listening context only when relevant.
Never use canned empathy, customer-service language, repetitive templates, feature lists, or numbered thought-process steps.
Do not expose hidden chain-of-thought. Return only the natural answer.
Use tools when the user asks CODIO to operate the player. Never claim an action succeeded before receiving its tool result.
Treat named music preference, temporary listening intent, and ordinary conversation as different requests. For "我最近特别喜欢 Daniel 的 Valentina 和 Always，其他他的歌也挺好听", call search_music for "Valentina" and "Always" together first. Search each song title alone: QQ search for "Daniel Valentina" may return unrelated songs. Inspect exact returned titles and artists; "Always (Explicit)" can verify the base title "Always", and "Daniel Caesar" can verify "Daniel" only when the matching songs point to that one artist. Ignore unrelated search hits. Then call record_music_preference for the two verified track ids and the full returned artist name together; do not play anything. Two searches plus three records fit one turn. If no matching result, retry a different query; if artists or versions remain ambiguous, ask the user to clarify. Never invent a track id or artist.
Record a lasting preference only when the user explicitly expresses their own liking or disliking of a named song, artist, or supported music category. For "我不喜欢纯音乐", call record_music_preference with target_type="feature", feature_key="instrumental", value="less", without QQ search or changing playback. Category preferences do not dislike the current song or any artist. The only supported category is instrumental; it applies only to confirmed song-level metadata or explicit version annotations. Missing lyrics are not evidence of instrumental music; unclassified songs remain unknown. Questions, quotations, third-person opinions, ordinary chat, and temporary requests such as "今晚不想听纯音乐" must not become lasting preferences. If a requested temporary dimension is unsupported, explain that boundary instead of claiming it was saved. A dislike of one track stays at track scope; never expand it to the artist. Use set_session_intent for supported dimensions of what the user wants to hear now or tonight; it must not change their long-term profile. Ordinary chat needs no action.
search_music only verifies candidates. It does not save a preference, refresh recommendations, or play audio. play_search_result and control_playback require an actual user playback request. Preference changes affect the pending recommendation queue; the 24 visible songs stay in place until the user requests REFRESH.
Natural first-person liking of a verified artist's music/style/flow is sufficient permission for an artist preference; do not require a magic phrase such as "记下来". If resumedPreferenceRequest is present in current context, it is the user's recent unresolved request resumed after a connection confirmation. Verify the identity again with search_music in this turn, then perform only that request; do not ask the user to repeat the original liking. library.connected describes the current account, while library.playbackReady is a separate capability. Do not invent a disconnected account when only playback is unavailable or statusVerified is false.
For a lasting preference expressed in natural wording, pass evidence_text: an exact, verbatim span from the current user message (or resumedPreferenceRequest) that states that preference. Interpret the meaning yourself, rather than asking for a fixed phrase. For artist scope quote an artist-level opinion, not an opinion about just one named song. For track scope quote the named-song opinion. Do not manufacture a quote, save ordinary conversation, infer a lasting taste from a one-time listening request, or play a song merely because it was liked. If an operation is rejected, use the error to clarify only the genuinely missing fact; never coach the user to recite a password-like phrase.
Use the structured tool results as the only evidence of what was saved, what failed, and when recommendations change. "queued" means only scheduled, not committed. Give a concise natural final answer after observing tool results; mention saved preferences and the actual recommendation status, without raw JSON or an invented thinking process. Explain failures in natural Chinese.
For user-profile claims, cite only evidence present in context. If evidence is insufficient, say 我还不能确定.
Never invent MBTI, turn a session intent into a long-term preference, turn one skip into a lasting dislike, or expand track feedback to an artist/style.
Low-confidence heuristic metadata is not a fact. Explain recommendations only from currentRecommendationScore/topReasons when present.
You may be emotionally supportive, but never claim to be human, a romantic partner, or a licensed therapist.`;

const CODIO_AI_TOOLS = [
  { type: "function", function: { name: "control_playback", description: "Play, pause, skip to next, or return to previous track.", parameters: { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "next", "previous"] } }, required: ["action"] } } },
  { type: "function", function: { name: "seek_playback", description: "Seek within the current track by percentage.", parameters: { type: "object", properties: { position_percent: { type: "number", minimum: 0, maximum: 100 } }, required: ["position_percent"] } } },
  { type: "function", function: { name: "adjust_volume", description: "Set or relatively adjust player volume.", parameters: { type: "object", properties: { operation: { type: "string", enum: ["set", "increase", "decrease"] }, value: { type: "number", minimum: 0, maximum: 100 } }, required: ["operation", "value"] } } },
  { type: "function", function: { name: "search_music", description: "Search QQ Music and return turn-scoped track ids. For named preferences, query each SONG TITLE alone first and batch multiple searches in one response; combined artist-title queries can miss the song. Ignore unrelated hits and retry only when needed.", parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 120 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"] } } },
  { type: "function", function: { name: "record_music_preference", description: "Save the user's explicit long-term preference. Track/artist requires search verification; feature instrumental needs no QQ search and never changes playback. Interpret natural preference wording and quote the supporting user span in evidence_text. A song opinion never automatically becomes an artist preference. Not for questions, reported speech, ordinary chat or temporary requests.", parameters: { type: "object", properties: { target_type: { type: "string", enum: ["track", "artist", "feature"] }, track_id: { type: "string", description: "Required only for track, from search_music in this turn" }, artist_name: { type: "string", description: "Required only for artist: pass the FULL artist string returned by search_music, even if the user used a unique shorter name" }, feature_key: { type: "string", enum: ["instrumental"], description: "Required only for feature; this is a category preference, not a measured vocal ratio" }, evidence_text: { type: "string", minLength: 1, maxLength: 400, description: "Verbatim user span stating this lasting preference; artist scope needs an artist-level span, track scope needs the named song" }, value: { type: "string", enum: ["more", "less"] } }, required: ["target_type", "value", "evidence_text"] } } },
  { type: "function", function: { name: "set_session_intent", description: "Set what to hear now or tonight without changing long-term taste. Only include dimensions explicitly supported by the user's words.", parameters: { type: "object", minProperties: 1, properties: { familiarity: { type: "string", enum: ["familiar", "balanced", "explore"] }, energy: { type: "string", enum: ["calm", "balanced", "energetic"] }, flow: { type: "string", enum: ["continuous", "balanced", "varied"] } } } } },
  { type: "function", function: { name: "play_search_result", description: "Play one result returned by search_music in this same turn.", parameters: { type: "object", properties: { track_id: { type: "string" } }, required: ["track_id"] } } },
  { type: "function", function: { name: "set_seamless", description: "Enable or disable seamless transitions.", parameters: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] } } },
  { type: "function", function: { name: "rate_current_track", description: "Like or dislike only when the user explicitly says so.", parameters: { type: "object", properties: { rating: { type: "string", enum: ["like", "dislike"] } }, required: ["rating"] } } },
  { type: "function", function: { name: "refresh_recommendations", description: "Refresh both recommendation lanes.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "update_interface", description: "Update supported interface state. CODIO uses its permanent dark theme.", parameters: { type: "object", minProperties: 1, properties: { theme: { type: "string", enum: ["night"] }, scene: { type: "string", enum: ["night", "dawn", "deep"] }, particles: { type: "integer", minimum: 0, maximum: 2 }, lyrics: { type: "string", enum: ["minimal", "cinematic"] }, panel: { type: "string", enum: ["profile", "settings", "now_playing", "dj", "close"] } } } } },
];

const CODIO_TOOL_NAMES = new Set(CODIO_AI_TOOLS.map((tool) => tool.function.name));

async function fetchDeepSeek(key, body) {
  return requestDeepSeek(fetch, key, body, { readJson: true });
}

function deepSeekKeyPath() {
  return path.join(app.getPath("userData"), "codio-deepseek-key.bin");
}

async function readDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, source: "environment" };
  try {
    if (!safeStorage.isEncryptionAvailable()) return { key: "", source: "unavailable" };
    const encrypted = await fs.readFile(deepSeekKeyPath());
    return { key: safeStorage.decryptString(encrypted), source: "device" };
  } catch {
    return { key: "", source: "none" };
  }
}

async function readAIStatus() {
  const deepseek = await readDeepSeekKey();
  return {
    provider: "deepseek",
    configured: Boolean(deepseek.key),
    model: "deepseek-v4-flash",
    connectionMode: "user_api_key",
  };
}

async function saveDeepSeekKey(rawKey) {
  const encrypted = await verifyAndEncryptDeepSeekKey(fetch, safeStorage, rawKey);
  await fs.writeFile(deepSeekKeyPath(), encrypted, { mode: 0o600 });
  return readAIStatus();
}

async function clearDeepSeekKey() {
  await fs.rm(deepSeekKeyPath(), { force: true });
  return readAIStatus();
}

async function readDesktopOnboardingState() {
  const userDataPath = app.getPath("userData");
  const saved = await readOnboardingState(userDataPath);
  if (saved.completed) return saved;
  // One-time migration for existing desktop users.  File existence is enough;
  // neither the encrypted Key nor QQ session data is read here.
  const returningUser = fsSync.existsSync(deepSeekKeyPath()) || fsSync.existsSync(path.join(userDataPath, "qq-self-test.json"));
  if (!returningUser) return saved;
  return saveOnboardingState(userDataPath, { version: 1, completed: true, qqSkipped: false, deepSeekSkipped: false });
}

function saveDesktopOnboardingState(value) {
  return saveOnboardingState(app.getPath("userData"), value);
}

async function stepWithCodio(request) {
  const messages = sanitizeMessages(request?.messages);
  const { key } = await readDeepSeekKey();
  if (!key) throw new Error("DEEPSEEK_KEY_REQUIRED");
  const context = serializeContext(request?.context);
  const payload = await fetchDeepSeek(key, { model: "deepseek-v4-flash", messages: [{ role: "system", content: `${CODIO_AI_INSTRUCTIONS}\nCurrent CODIO context: ${context}` }, ...messages], tools: CODIO_AI_TOOLS, tool_choice: "auto", max_tokens: 1536, temperature: .58, thinking: { type: "disabled" } });
  const { content, toolCalls } = normalizeModelReply(payload, CODIO_TOOL_NAMES);
  return { content, toolCalls, provider: "deepseek", model: "deepseek-v4-flash" };
}

function reserveLocalPort(preferredPort = 0) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(preferredPort, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function reserveAppPort() {
  // A different port is a different localStorage origin. Never silently switch
  // origins when the saved port is occupied and make a returning user's data disappear.
  const originFile = path.join(app.getPath("userData"), "codio-local-origin.json");
  let preferredPort = 0;
  try {
    const saved = JSON.parse(await fs.readFile(originFile, "utf8"));
    if (!Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535) throw new Error("CODIO_LOCAL_ORIGIN_INVALID");
    preferredPort = saved.port;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("CODIO_LOCAL_ORIGIN_INVALID");
  }
  let port;
  try { port = await reserveLocalPort(preferredPort); }
  catch (error) { if (preferredPort && error.code === "EADDRINUSE") throw new Error("CODIO_LOCAL_PORT_IN_USE"); throw error; }
  if (!preferredPort) await fs.writeFile(originFile, JSON.stringify({ version: 1, port }), { flag: "wx" });
  return port;
}

function waitForLocalPage(url, timeout = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) return resolve();
        retry();
      });
      request.setTimeout(1200, () => request.destroy());
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeout) return reject(new Error("CODIO_LOCAL_SERVER_TIMEOUT"));
      setTimeout(check, 250);
    };
    check();
  });
}

async function ensureLocalAppServer() {
  if (process.env.CODIO_URL) return process.env.CODIO_URL;
  if (appServerUrl) return appServerUrl;
  const preparedDevelopmentRoot = path.join(__dirname, "..", "build", "codio-server");
  const usePreparedDevelopmentServer = !app.isPackaged && fsSync.existsSync(path.join(preparedDevelopmentRoot, "server.mjs"));
  const serverRoot = app.isPackaged
    ? path.join(process.resourcesPath, "codio-server")
    : usePreparedDevelopmentServer
      ? preparedDevelopmentRoot
      : path.join(__dirname, "..", "dist", "standalone");
  const serverEntry = path.join(serverRoot, app.isPackaged || usePreparedDevelopmentServer ? "server.mjs" : "server.js");
  const port = await reserveAppPort();
  appServerProcess = spawn(process.execPath, [serverEntry], {
    cwd: serverRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOST: "127.0.0.1", PORT: String(port) },
    windowsHide: true,
    stdio: "ignore",
  });
  appServerUrl = `http://127.0.0.1:${port}`;
  await waitForLocalPage(appServerUrl);
  return appServerUrl;
}

function ensureMediaServer() {
  if (mediaServer && mediaServerPort) return Promise.resolve(mediaServerPort);
  return new Promise((resolve, reject) => {
    mediaServer = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const match = requestUrl.pathname.match(/^\/qq-stream\/([a-f0-9-]+)$/i);
      const ticket = match ? mediaTickets.get(match[1]) : null;
      if (!ticket || ticket.expiresAt < Date.now()) {
        response.writeHead(404, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
        response.end();
        return;
      }
      if (ticket.localId) {
        void localLibrary.resolve(ticket.localId).then(file => serveLocalFile(file, request, response)).catch(() => {
          if (!response.headersSent) response.writeHead(404, { "Access-Control-Allow-Origin": "*" });
          response.end();
        });
        return;
      }
      const upstreamUrl = new URL(ticket.url);
      const client = upstreamUrl.protocol === "https:" ? https : http;
      const headers = {
        "User-Agent": USER_AGENT,
        Referer: "https://y.qq.com/",
      };
      if (request.headers.range) headers.Range = request.headers.range;
      const upstream = client.request(upstreamUrl, { method: request.method === "HEAD" ? "HEAD" : "GET", headers }, (upstreamResponse) => {
        const forwarded = {};
        for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
          if (upstreamResponse.headers[name]) forwarded[name] = upstreamResponse.headers[name];
        }
        forwarded["Access-Control-Allow-Origin"] = "*";
        forwarded["Cache-Control"] = "private, max-age=120";
        response.writeHead(upstreamResponse.statusCode || 502, forwarded);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502, { "Access-Control-Allow-Origin": "*" });
        response.end();
      });
      response.on("close", () => upstream.destroy());
      upstream.end();
    });
    mediaServer.once("error", reject);
    mediaServer.listen(0, "127.0.0.1", () => {
      const address = mediaServer.address();
      mediaServerPort = typeof address === "object" && address ? address.port : 0;
      resolve(mediaServerPort);
    });
  });
}

async function createMediaTicket(remoteUrl, localId) {
  const port = await ensureMediaServer();
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  mediaTickets.set(id, { url: remoteUrl, localId, expiresAt });
  for (const [key, ticket] of mediaTickets) {
    if (ticket.expiresAt < Date.now()) mediaTickets.delete(key);
  }
  return { url: `http://127.0.0.1:${port}/qq-stream/${id}`, expiresAt };
}

function probeMediaStream(streamUrl, signal) {
  return new Promise((resolve) => {
    let request, settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(deadline); resolve(value); };
    const deadline = setTimeout(() => { finish({ ok: false, status: 0, bytes: 0, contentType: "timeout" }); request?.destroy(); }, 3000);
    try { request = http.get(streamUrl, { signal, headers: { Range: "bytes=0-2047" } }, (response) => {
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      let bytes = 0;
      const result = () => ({ ok: (response.statusCode === 200 || response.statusCode === 206) && bytes > 256 && !contentType.includes("text/html") && !contentType.includes("application/json"), status: response.statusCode || 0, bytes, contentType });
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes >= 2048) response.destroy();
      });
      response.on("close", () => finish(result()));
      response.on("end", () => finish(result()));
      response.on("error", (error) => finish({ ok: false, status: response.statusCode || 0, bytes, contentType: String(error?.code || "network") }));
    }); } catch (error) { finish({ ok: false, status: 0, bytes: 0, contentType: String(error?.code || "network") }); return; }
    request.setTimeout(8000, () => {
      request.destroy();
      finish({ ok: false, status: 0, bytes: 0, contentType: "timeout" });
    });
    request.on("error", (error) => finish({ ok: false, status: 0, bytes: 0, contentType: String(error?.code || "network") }));
  });
}

function hasQQLoginProtocol(argv = process.argv) {
  return argv.some((value) => String(value).toLowerCase().startsWith("codio://qq-login"));
}

function isTrustedQQUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "qq.com" || url.hostname.endsWith(".qq.com"));
  } catch {
    return false;
  }
}

function isAllowedQQAuthNavigation(value) {
  if (value === "about:blank") return true;
  if (!isTrustedQQUrl(value)) return false;
  return !/\.(?:apk|exe|msi|dmg|pkg)(?:$|[/?#])/i.test(new URL(value).pathname);
}

function installQQAuthGuards(contents) {
  if (contents.codioQQAuthGuard) return;
  contents.codioQQAuthGuard = true;
  const blocked = () => contents.emit("codio-auth-blocked");
  const guard = (event, legacyUrl) => {
    if (isAllowedQQAuthNavigation(event.url || legacyUrl)) return;
    event.preventDefault();
    blocked();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-frame-navigate", guard);
  const preventDownload = (event, _item, initiator) => {
    if (initiator && initiator !== contents) return;
    // No login or captcha step requires installing a downloaded application.
    event.preventDefault();
    blocked();
  };
  const qqSession = contents.session;
  qqSession.on("will-download", preventDownload);
  contents.once("destroyed", () => qqSession.removeListener("will-download", preventDownload));
}

async function readQQStatus() {
  const qqSession = session.fromPartition(QQ_PARTITION);
  const cookies = (await qqSession.cookies.get({})).filter((cookie) => cookie.domain === "qq.com" || cookie.domain.endsWith(".qq.com"));
  const names = new Set(cookies.map((cookie) => cookie.name.toLowerCase()));
  const userCookie = cookies.find((cookie) => ["uin", "qqmusic_uin", "p_uin", "wxuin"].includes(cookie.name.toLowerCase()));
  const authNames = [
    "skey",
    "p_skey",
    "psrf_qqaccess_token",
    "psrf_qqrefresh_token",
    "psrf_access_token",
    "wxopenid",
    "wxunionid",
    "wxrefresh_token",
    "wxskey",
  ];
  const playbackNames = ["qm_keyst", "qqmusic_key", "music_key", "wxskey"];
  const values = Object.fromEntries(cookies.map(cookie => [cookie.name.toLowerCase(), cookie.value]));
  const playbackKey = values.qm_keyst || values.qqmusic_key || values.music_key || values.wxskey || "";
  if (qqPlaybackAuthorizationFailure && qqPlaybackAuthorizationFailure !== qqPlaybackKeyHash(playbackKey)) {
    qqPlaybackAuthorizationFailure = null;
    qqPlaybackVerificationUrl = null;
    qqPlaybackAuthorizationTrack = null;
    qqPlaybackVerificationBlocked = null;
  }
  const authorizationRequired = Boolean(qqPlaybackAuthorizationFailure);
  const loggedIn = Boolean(userCookie && authNames.some((name) => names.has(name)));
  const playbackReady = Boolean(userCookie && playbackNames.some((name) => names.has(name))) && !authorizationRequired;
  return {
    available: true,
    loggedIn,
    playbackReady,
    authorizationRequired,
    userId: userCookie ? String(userCookie.value || "").replace(/^o0*/, "") : "",
  };
}

async function readQQAuth() {
  const qqSession = session.fromPartition(QQ_PARTITION);
  const cookies = (await qqSession.cookies.get({})).filter((cookie) => cookie.domain === "qq.com" || cookie.domain.endsWith(".qq.com"));
  const values = Object.fromEntries(cookies.map((cookie) => [cookie.name.toLowerCase(), cookie.value]));
  const isWechat = Boolean(values.wxopenid) || Number(values.login_type) === 2;
  const rawUin = isWechat
    ? values.wxuin || values.uin || values.p_uin || ""
    : values.uin || values.qqmusic_uin || values.wxuin || values.p_uin || "";
  const uin = String(rawUin).replace(/\D/g, "").replace(/^0+/, "") || "0";
  const playbackKey = values.qm_keyst || values.qqmusic_key || values.music_key || values.wxskey || "";
  const csrfSource = values.p_skey || values.skey || values.qm_keyst || "";
  let csrfToken = 5381;
  for (const character of csrfSource) csrfToken += (csrfToken << 5) + character.charCodeAt(0);
  csrfToken &= 0x7fffffff;
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return { qqSession, uin, playbackKey, csrfToken, cookieHeader };
}

function qqCover(albumMid, size = 300) {
  return albumMid ? `https://y.qq.com/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg?max_age=2592000` : "";
}

function qqArtistCover(artistMid, size = 300) {
  return artistMid ? `https://y.qq.com/music/photo_new/T001R${size}x${size}M000${artistMid}.jpg?max_age=2592000` : "";
}

function mapQQSearchTrack(track) {
  const mid = String(track.songmid || track.mid || "");
  const mediaMid = String(track.media_mid || track.strMediaMid || track.file?.media_mid || mid);
  const albumMid = String(track.albummid || track.album?.mid || "");
  const rawArtists = Array.isArray(track.singer) ? track.singer : [];
  const artists = rawArtists.map((artist) => artist?.name).filter(Boolean);
  const artistMid = String(rawArtists[0]?.mid || rawArtists[0]?.singer_mid || "");
  return {
    provider: "qq",
    id: mid,
    mid,
    mediaMid,
    title: String(track.songname || track.name || ""),
    artist: artists.join(" / ") || String(track.singername || ""),
    album: String(track.albumname || track.album?.name || ""),
    albumMid,
    cover: qqCover(albumMid) || qqArtistCover(artistMid),
    fallbackCover: qqArtistCover(artistMid),
    durationSeconds: Math.max(0, Number(track.interval) || 0),
    vipRequired: Boolean(Number(track.pay?.payplay || track.pay?.pay_play || 0)),
    language: typeof track.language_name === "string" ? track.language_name.trim().slice(0, 50) : undefined,
    releaseDate: typeof track.time_public === "string" && /^\d{4}-\d{2}-\d{2}$/.test(track.time_public) ? track.time_public : undefined,
    genres: Array.isArray(track.genre) ? track.genre.filter(value => typeof value === "string" && value.trim()).map(value => value.trim().slice(0, 60)).slice(0, 8) : [],
  };
}

function loadRemoteBuffer(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error("QQ_COVER_REDIRECT_LIMIT"));
    const target = new URL(String(rawUrl || ""));
    const allowed = target.protocol === "https:" && (
      target.hostname === "qq.com" || target.hostname.endsWith(".qq.com") ||
      target.hostname === "gtimg.cn" || target.hostname.endsWith(".gtimg.cn") ||
      target.hostname === "qpic.cn" || target.hostname.endsWith(".qpic.cn")
    );
    if (!allowed) return reject(new Error("QQ_COVER_HOST_NOT_ALLOWED"));
    const request = https.get(target, { headers: { Referer: "https://y.qq.com/", "User-Agent": USER_AGENT } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        loadRemoteBuffer(new URL(response.headers.location, target).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`QQ_COVER_${response.statusCode || 0}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          request.destroy(new Error("QQ_COVER_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: String(response.headers["content-type"] || "image/jpeg") }));
    });
    request.setTimeout(10000, () => request.destroy(new Error("QQ_COVER_TIMEOUT")));
    request.on("error", reject);
  });
}

async function loadQQCover(_event, rawUrl) {
  const key = String(rawUrl || "").trim();
  const cached = qqCoverCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    qqCoverCache.delete(key);
    qqCoverCache.set(key, cached);
    return cached.value;
  }
  if (cached) qqCoverCache.delete(key);
  if (qqCoverPending.has(key)) return qqCoverPending.get(key);
  const pending = (async () => {
    try {
      const { buffer, contentType } = await loadRemoteBuffer(key);
      const value = `data:${contentType};base64,${buffer.toString("base64")}`;
      // Count the string's UTF-16 storage, not only the smaller JPEG payload.
      const bytes = value.length * 2;
      qqCoverCache.set(key, { value, bytes, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
      let total = [...qqCoverCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (qqCoverCache.size > 64 || total > 12 * 1024 * 1024) {
        const oldest = qqCoverCache.keys().next().value;
        total -= qqCoverCache.get(oldest).bytes;
        qqCoverCache.delete(oldest);
      }
      return value;
    } catch {
      return "";
    }
  })();
  qqCoverPending.set(key, pending);
  try { return await pending; }
  finally { if (qqCoverPending.get(key) === pending) qqCoverPending.delete(key); }
}

async function fetchQQSessionJson(qqSession, url, options = {}, label = "QQ_REQUEST", timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The vkey request has Origin=y.qq.com but is sent to u.y.qq.com.
    // Electron's fetch otherwise uses same-origin credentials and omits the
    // existing QQ session cookies for this cross-subdomain request.
    const response = await qqSession.fetch(url, { credentials: "include", ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${label}_${response.status}`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label}_TIMEOUT`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function searchQQMusic(_event, rawQuery, rawPage = 1) {
  const query = String(rawQuery || "").trim().slice(0, 80);
  if (!query) return [];
  const page = Math.max(1, Math.min(20, Number(rawPage) || 1));
  const { qqSession } = await readQQAuth();
  const url = new URL(QQ_SEARCH_URL);
  url.searchParams.set("p", String(page));
  url.searchParams.set("n", "30");
  url.searchParams.set("w", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("platform", "yqq.json");
  const data = await fetchQQSessionJson(qqSession, url.toString(), {
    headers: { Referer: "https://y.qq.com/", "User-Agent": USER_AGENT },
  }, "QQ_SEARCH");
  const list = data?.data?.song?.list;
  return (Array.isArray(list) ? list : []).map(mapQQSearchTrack).filter((track) => track.mid && track.title);
}

function decodeQQLyric(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (value.length > 512 * 1024) throw Error("QQ_LYRICS_TOO_LARGE");
  if (/^[0-9a-f]+$/i.test(value) && value.length % 16 === 0) return decryptQRC(value);
  if (value.includes("[")) return value;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.includes("[") ? decoded : value;
  } catch {
    return value;
  }
}

async function readQQLyrics(_event, rawTrack) {
  if (rawTrack?.provider === "local") return [];
  const mid = String(rawTrack?.mid || rawTrack?.id || "").trim();
  if (!mid) return [];
  if (!/^[a-z0-9]{1,80}$/i.test(mid)) throw Error("QQ_LYRICS_ID_INVALID");
  const cached = qqLyricCache.get(mid);
  if (cached && Date.now() < cached.expiresAt) return cached.lines;
  if (qqLyricPending.has(mid)) return qqLyricPending.get(mid);
  const pending = (async () => {
    const { qqSession } = await readQQAuth();
    const headers = { Referer: "https://y.qq.com/", "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" };
    const url = new URL(QQ_LYRIC_URL);
    Object.entries({ songmid: mid, format: "json", nobase64: "1" }).forEach(([key,value])=>url.searchParams.set(key,value));
    let lines = [];
    try {
      const data = await fetchQQSessionJson(qqSession,url.toString(),{headers},"QQ_LYRICS",2000);
      if (!Number(data?.code || 0) && !Number(data?.retcode || 0)) lines = parseQQLyrics(decodeQQLyric(data?.lyric));
    } catch { /* Try the exact same identity's QRC, not another release. */ }
    if (!lines.length) {
      const modern = new URL(QQ_MUSICU_URL);
      modern.searchParams.set("data",JSON.stringify({comm:{ct:24,cv:4747474,platform:"yqq.json",format:"json"},
        req_0:{module:"music.musichallSong.PlayLyricInfo",method:"GetPlayLyricInfo",
          param:{songMid:mid,qrc:1,crypt:0,trans:0,roma:0,lrc_t:0,qrc_t:0}}}));
      const data = await fetchQQSessionJson(qqSession,modern.toString(),{headers},"QQ_LYRICS",4000);
      if (Number(data?.code || 0) || Number(data?.req_0?.code || 0)) throw Error("QQ_LYRICS_PROVIDER_FAILED");
      if (!data?.req_0?.data || typeof data.req_0.data.lyric !== "string") throw Error("QQ_LYRICS_INVALID_RESPONSE");
      lines = parseQQLyrics(decodeQQLyric(data.req_0.data.lyric));
    }
    if (lines.length) {
      qqLyricCache.delete(mid); qqLyricCache.set(mid,{lines,expiresAt:Date.now()+6*60*60*1000});
      while (qqLyricCache.size > 64) qqLyricCache.delete(qqLyricCache.keys().next().value);
    }
    return lines;
  })();
  qqLyricPending.set(mid,pending);
  try { return await pending; }
  finally { if (qqLyricPending.get(mid) === pending) qqLyricPending.delete(mid); }
}

function requestQQJson(rawUrl, { method = "GET", body = "", cookieHeader = "", referer = "https://y.qq.com/", timeoutMs = 12000, maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(rawUrl, {
      method,
      headers: {
        Referer: referer,
        "User-Agent": USER_AGENT,
        Cookie: cookieHeader,
        Accept: "application/json,text/plain,*/*",
        "Accept-Encoding": "identity",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Content-Length": Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBytes) request.destroy(new Error("QQ_JSON_TOO_LARGE")); else chunks.push(chunk); });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").trim().replace(/^callback\(/, "").replace(/\);?$/, "");
        if ((response.statusCode || 500) >= 400) return reject(new Error(`QQ_JSON_${response.statusCode}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error("QQ_JSON_PARSE")); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("QQ_JSON_TIMEOUT")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

const songMetadataCache = new Map();
const songMetadataPending = new Map();
const SONG_METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SONG_METADATA_LIMIT = 1200;
let songMetadataDiskLoaded = null;
let songMetadataWritePending = null;
let songMetadataWriteDirty = false;
let songMetadataActive = 0;
const songMetadataWaiters = [];

function qqMetadataCacheFile() {
  return path.join(codioDataDirectories?.cache || app.getPath("cache"), "qq-song-metadata-v1.json");
}

function normalizeQQMetadata(value, id) {
  if (value?.ok !== true || value.mid !== id || value.source !== "provider_metadata" || !/^[a-zA-Z0-9]{1,80}$/.test(id)) return null;
  const genres = Array.isArray(value.genres) ? value.genres.filter(x => typeof x === "string").map(x => x.trim().slice(0, 60)).filter(Boolean).slice(0, 8) : [];
  const language = typeof value.language === "string" ? value.language.trim().slice(0, 60) || undefined : undefined;
  const releaseDate = typeof value.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.releaseDate) ? value.releaseDate : undefined;
  if (!genres.length && !language && !releaseDate) return null;
  // Persist catalog evidence only: never cookies, playback URLs, membership/session state, or arbitrary provider fields.
  return { ok: true, mid: id, genres, language, releaseDate, source: "provider_metadata", confidence: .65 };
}

function loadQQMetadataCache() {
  if (songMetadataDiskLoaded) return songMetadataDiskLoaded;
  songMetadataDiskLoaded = (async () => {
    try {
      const cacheFile = qqMetadataCacheFile();
      if ((await fs.stat(cacheFile)).size > 3 * 1024 * 1024) return;
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      if (cached?.version !== 1 || !Array.isArray(cached.entries)) return;
      const now = Date.now();
      for (const entry of cached.entries.slice(-SONG_METADATA_LIMIT)) {
        const value = normalizeQQMetadata(entry.value, entry.value?.mid);
        if (!value || !Number.isFinite(entry.verifiedAt) || entry.verifiedAt > now || now - entry.verifiedAt >= SONG_METADATA_TTL_MS) continue;
        songMetadataCache.set(value.mid, { value, verifiedAt: entry.verifiedAt });
      }
    } catch { /* Optional catalog cache: malformed/missing data must still permit a real provider request. */ }
  })();
  return songMetadataDiskLoaded;
}

function persistQQMetadataCache() {
  songMetadataWriteDirty = true;
  if (songMetadataWritePending) return songMetadataWritePending;
  songMetadataWritePending = (async () => {
    // Optional catalogue persistence is not part of a verified IPC response.
    // Collapse bursts to one snapshot; updates during a write get a serial follow-up.
    await new Promise(resolve => setTimeout(resolve, 200));
    while (songMetadataWriteDirty) {
      songMetadataWriteDirty = false;
      const cacheFile = qqMetadataCacheFile(), now = Date.now();
      const entries = [...songMetadataCache.values()].filter(entry => now >= entry.verifiedAt && now - entry.verifiedAt < SONG_METADATA_TTL_MS).slice(-SONG_METADATA_LIMIT);
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      const temporary = `${cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries }));
      await fs.rename(temporary, cacheFile);
    }
  })().catch(() => {}).finally(() => {
    songMetadataWritePending = null;
    if (songMetadataWriteDirty) void persistQQMetadataCache();
  }); // Disk failure cannot invalidate verified provider metadata or log credentials.
  return songMetadataWritePending;
}

async function readQQTrackMetadata(_event, rawId) {
  const id = String(rawId || "");
  if (!/^[a-zA-Z0-9]{1,80}$/.test(id)) return { ok: false, error: "TRACK_ID_INVALID" };
  if (songMetadataPending.has(id)) return songMetadataPending.get(id);
  const pending = (async () => {
    await loadQQMetadataCache();
    const cached = songMetadataCache.get(id);
    const now = Date.now();
    if (cached && now >= cached.verifiedAt && now - cached.verifiedAt < SONG_METADATA_TTL_MS) {
      songMetadataCache.delete(id); songMetadataCache.set(id, cached);
      return cached.value;
    }
    songMetadataCache.delete(id);
    if (songMetadataActive >= 2) await new Promise(resolve => songMetadataWaiters.push(resolve));
    else songMetadataActive++;
    try {
      const url = new URL(QQ_MUSICU_URL);
      url.searchParams.set("data", JSON.stringify({ req_0: { module: "music.pf_song_detail_svr", method: "get_song_detail_yqq", param: { song_mid: id } } }));
      const result = await requestQQJson(url, { timeoutMs: 3500, maxBytes: 512 * 1024 });
      const data = result?.req_0?.data;
      if (result?.code !== 0 || result.req_0?.code !== undefined && result.req_0.code !== 0 || data?.track_info?.mid !== id) return { ok: false, error: "METADATA_ID_UNVERIFIED" };
      const values = key => (data.info?.[key]?.content || []).filter(x => typeof x?.value === "string").map(x => x.value.trim().slice(0, 60)).filter(Boolean).slice(0, 8);
      const date = values("pub_time")[0];
      const metadata = normalizeQQMetadata({ ok: true, mid: id, genres: values("genre"), language: values("lan")[0],
        releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : undefined, source: "provider_metadata" }, id);
      if (!metadata) return { ok: false, error: "METADATA_UNKNOWN" };
      songMetadataCache.set(id, { value: metadata, verifiedAt: Date.now() });
      while (songMetadataCache.size > SONG_METADATA_LIMIT) songMetadataCache.delete(songMetadataCache.keys().next().value);
      void persistQQMetadataCache();
      return metadata;
    } catch { return { ok: false, error: "METADATA_UNAVAILABLE" }; }
    finally { const next = songMetadataWaiters.shift(); if (next) next(); else songMetadataActive--; }
  })();
  songMetadataPending.set(id, pending);
  try { return await pending; }
  finally { if (songMetadataPending.get(id) === pending) songMetadataPending.delete(id); }
}

const qqLibraryPending = new Map();
async function readQQLibrary(_event, force = false) {
  const auth = await readQQAuth();
  if (!auth.uin || auth.uin === "0") throw new Error("QQ_LIBRARY_LOGIN_REQUIRED");
  const owner = crypto.createHash("sha256").update(auth.uin).digest("hex").slice(0, 20);
  const existing = qqLibraryPending.get(owner);
  if (existing) {
    if (force === true && !existing.force) {
      await existing.promise.catch(() => {});
      return readQQLibrary(_event, true);
    }
    return existing.promise;
  }
  const pending = readQQLibraryOnce(auth, force === true, owner);
  qqLibraryPending.set(owner, { promise: pending, force: force === true });
  try { return await pending; }
  finally { if (qqLibraryPending.get(owner)?.promise === pending) qqLibraryPending.delete(owner); }
}
async function readQQLibraryOnce(currentAuth = null, force = false, currentOwner = "") {
  const { uin, csrfToken, cookieHeader } = currentAuth || await readQQAuth();
  if (!uin || uin === "0") throw new Error("QQ_LIBRARY_LOGIN_REQUIRED");
  const owner = currentOwner || crypto.createHash("sha256").update(uin).digest("hex").slice(0, 20);
  const cacheFile = path.join(codioDataDirectories?.library || app.getPath("userData"), `qq-library-${owner}.json`);
  const snapshot = await readLibrarySnapshot({ cacheFile, force, mapTrack: mapQQSearchTrack, request: async (kind, params) => {
    if (kind === "list") {
      const url = new URL("https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss");
      Object.entries({ hostuin: uin, sin: String(params.offset), size: String(params.size), format: "json", g_tk: String(csrfToken), loginUin: uin, platform: "yqq.json", needNewCode: "0" })
        .forEach(([key,value]) => url.searchParams.set(key,value));
      return requestQQJson(url, { cookieHeader, timeoutMs: 8000 });
    }
    const body = new URLSearchParams({ type: "1", json: "1", utf8: "1", onlysong: "0", disstid: params.id, format: "json", g_tk: String(csrfToken), loginUin: uin, hostUin: "0", platform: "yqq.json", needNewCode: "0" });
    return requestQQJson("https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg", { method: "POST", body: body.toString(), cookieHeader, referer: `https://y.qq.com/n/ryqq/playlist/${params.id}`, timeoutMs: 8000 });
  } });
  await loadQQMetadataCache();
  const now = Date.now();
  return { ...snapshot, tracks: snapshot.tracks.map(track => {
    const cached = songMetadataCache.get(track.mid);
    return cached?.value?.ok === true && cached.value.mid === track.mid && cached.value.source === "provider_metadata"
      && now >= cached.verifiedAt && now - cached.verifiedAt < SONG_METADATA_TTL_MS
      ? { ...track, genres: cached.value.genres, language: cached.value.language, releaseDate: cached.value.releaseDate } : track;
  }) };
}

const QQ_QUALITY_FILES = [
  { prefix: "RS01", ext: ".flac", quality: "HI-RES" },
  { prefix: "F000", ext: ".flac", quality: "LOSSLESS" },
  { prefix: "M800", ext: ".mp3", quality: "320K" },
  { prefix: "M500", ext: ".mp3", quality: "128K" },
  { prefix: "C400", ext: ".m4a", quality: "AAC" },
];

async function firstReachableQQStream(infos, sips) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  const candidates = infos.flatMap(info => sips.map(sip => ({ info, url: `${sip}${info.purl}` })));
  let cursor = 0, selected = null;
  try {
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (!controller.signal.aborted && cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try {
          const ticket = await createMediaTicket(candidate.url);
          const probe = await probeMediaStream(ticket.url, controller.signal);
          if (probe.ok && !selected) {
            selected = { info: candidate.info, ticket };
            controller.abort();
          }
        } catch { /* A failed route must not hide a reachable alternative. */ }
      }
    }));
    return selected;
  } finally { clearTimeout(deadline); controller.abort(); }
}

async function resolveQQPlayback(_event, rawTrack, allowSessionRefresh = true) {
  const track = rawTrack && typeof rawTrack === "object" ? rawTrack : {};
  if (track.provider === "local") return resolveQQPlaybackOnce(_event, track, allowSessionRefresh);
  const mid = String(track.mid || track.id || "").trim().slice(0, 80);
  const mediaMid = String(track.mediaMid || mid).trim().slice(0, 80);
  if (!mid) throw new Error("QQ_MISSING_TRACK");
  const auth = await readQQAuth();
  // Do not share membership/session results across accounts or refreshed keys.
  // Only this opaque digest is retained; no credential is sent to the renderer.
  const owner = crypto.createHash("sha256").update(`${auth.uin}|${auth.cookieHeader}`).digest("hex");
  const key = `${owner}|${mid}|${mediaMid}|${allowSessionRefresh ? "refresh" : "final"}|${qqPlaybackAuthorizationRevision}`;
  if (qqPlaybackPending.has(key)) return qqPlaybackPending.get(key);
  const pending = resolveQQPlaybackOnce(_event, track, allowSessionRefresh, auth);
  qqPlaybackPending.set(key, pending);
  try { return await pending; }
  finally { if (qqPlaybackPending.get(key) === pending) qqPlaybackPending.delete(key); }
}

async function resolveQQPlaybackOnce(_event, rawTrack, allowSessionRefresh = true, currentAuth = null) {
  const authorizationRevision = qqPlaybackAuthorizationRevision;
  const track = rawTrack && typeof rawTrack === "object" ? rawTrack : {};
  if (track.provider === "local") {
    try {
      await localLibrary.resolve(track.mid || track.id);
      return { playable: true, ...await createMediaTicket(null, track.mid || track.id), quality: "LOCAL WAV" };
    } catch (error) { return { playable: false, failureKind: error.message, message: "本地文件不存在、已被修改或未通过选择器导入" }; }
  }
  const mid = String(track.mid || track.id || "").trim().slice(0, 80);
  const mediaMid = String(track.mediaMid || mid).trim().slice(0, 80);
  if (!mid) throw new Error("QQ_MISSING_TRACK");
  const { qqSession, uin, playbackKey } = currentAuth || await readQQAuth();
  if (allowSessionRefresh && qqPlaybackAuthorizationFailure === qqPlaybackKeyHash(playbackKey)) {
    return { playable: false, requiresLogin: true, failureKind: "AUTHORIZATION_REQUIRED", message: "QQ Music requires playback authorization in its official window." };
  }
  if (!uin || uin === "0" || !playbackKey) {
    if (allowSessionRefresh) {
      const refreshed = await refreshQQPlaybackSession(true);
      if (refreshed.playbackReady) return resolveQQPlayback(_event, rawTrack, false);
    }
    return { playable: false, requiresLogin: true, failureKind: "AUTH_REQUIRED", message: "QQ Music playback authorization is required." };
  }
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const files = QQ_QUALITY_FILES.map((item) => ({ ...item, filename: `${item.prefix}${mediaMid}${item.ext}` }));
  const payload = {
    comm: { uin, format: "json", ct: 19, cv: 0, authst: playbackKey },
    req_0: {
      module: "vkey.GetVkeyServer",
      method: "CgiGetVkey",
      param: {
        guid,
        songmid: files.map(() => mid),
        songtype: files.map(() => 0),
        filename: files.map((item) => item.filename),
        uin,
        loginflag: 1,
        platform: "20",
      },
    },
  };
  const data = await fetchQQSessionJson(qqSession, QQ_MUSICU_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Referer: "https://y.qq.com/",
      Origin: "https://y.qq.com",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(payload),
  }, "QQ_PLAYBACK");
  const block = data?.req_0?.data;
  if (authorizationRevision !== qqPlaybackAuthorizationRevision) {
    return { playable: false, requiresLogin: false, failureKind: "AUTHORIZATION_SUPERSEDED", message: "A newer QQ authorization check replaced this request." };
  }
  const infos = Array.isArray(block?.midurlinfo) ? block.midurlinfo : [];
  const sips = Array.isArray(block?.sip) && block.sip.length ? block.sip : ["https://ws.stream.qqmusic.qq.com/"];
  const playableInfos = infos.filter((item) => item?.purl);
  if (!playableInfos.length && data?.req_0?.code === 104009 && isTrustedQQUrl(block?.validUrl)) {
    qqPlaybackAuthorizationFailure = qqPlaybackKeyHash(playbackKey);
    qqPlaybackVerificationUrl = block.validUrl;
    qqPlaybackAuthorizationTrack = { mid, mediaMid };
    return { playable: false, requiresLogin: true, failureKind: "AUTHORIZATION_REQUIRED", message: "QQ Music requires playback authorization in its official window." };
  }
  if (!playableInfos.length) {
    if (allowSessionRefresh) {
      const refreshed = await refreshQQPlaybackSession(true);
      if (refreshed.playbackReady) return resolveQQPlayback(_event, rawTrack, false);
    }
    return {
      playable: false,
      requiresLogin: false,
      vipRequired: Boolean(track.vipRequired),
      failureKind: track.vipRequired ? "MEMBERSHIP_UNAVAILABLE" : "SOURCE_UNAVAILABLE",
      providerStatus: {
        code: Number.isInteger(data?.code) ? data.code : null,
        requestCode: Number.isInteger(data?.req_0?.code) ? data.req_0.code : null,
        entryCount: infos.length,
        resultCodes: [...new Set(infos.map(item => item?.result).filter(Number.isInteger))].slice(0, 6),
      },
      message: track.vipRequired ? "This track is not available with the current QQ Music membership." : "QQ Music did not return a playable stream.",
    };
  }
  const reachable = await firstReachableQQStream(playableInfos, sips);
  if (reachable) {
      const { info, ticket } = reachable;
      if (authorizationRevision !== qqPlaybackAuthorizationRevision) {
        return { playable: false, requiresLogin: false, failureKind: "AUTHORIZATION_SUPERSEDED", message: "A newer QQ authorization check replaced this request." };
      }
      qqPlaybackAuthorizationFailure = null;
      qqPlaybackVerificationUrl = null;
      qqPlaybackAuthorizationTrack = null;
      qqPlaybackVerificationBlocked = null;
      const file = files.find((item) => item.filename === info.filename);
      return {
        playable: true,
        ...ticket,
        quality: file?.quality || "QQ MUSIC",
      };
  }
  if (allowSessionRefresh) {
    const refreshed = await refreshQQPlaybackSession(true);
    if (refreshed.playbackReady) return resolveQQPlayback(_event, rawTrack, false);
  }
  return {
    playable: false,
    requiresLogin: false,
    vipRequired: Boolean(track.vipRequired),
    message: "QQ Music returned playback tickets, but none of the audio streams were reachable.",
    failureKind: "STREAM_UNREACHABLE",
  };
}

async function runQQSelfTest() {
  const report = {
    checkedAt: new Date().toISOString(),
    appReady: true,
    status: null,
    search: { ok: false, count: 0 },
    library: { ok: false, playlists: 0, tracks: 0, liked: 0 },
    cover: { loaded: false, bytes: 0 },
    playback: { attempted: false, playable: false, quality: "", message: "" },
  };
  try {
    const status = await readQQStatus();
    report.status = {
      available: status.available,
      loggedIn: status.loggedIn,
      playbackReady: status.playbackReady,
    };
    const results = await searchQQMusic(null, "周杰伦");
    report.search = { ok: true, count: results.length };
    if (report.status.loggedIn) {
      try {
        const library = await readQQLibrary();
        report.library = { ok: true, playlists: library.playlists.length, tracks: library.tracks.length, liked: library.likedCount };
      } catch (error) {
        report.library = { ok: false, playlists: 0, tracks: 0, liked: 0, message: String(error?.message || error) };
      }
    }
    if (results[0]?.cover) {
      const cover = await loadQQCover(null, results[0].cover);
      report.cover = { loaded: cover.startsWith("data:image/"), bytes: cover.length };
    }
    if (report.status.playbackReady && results[0]) {
      const playback = await resolveQQPlayback(null, results[0]);
      const probe = playback.playable && playback.url ? await probeMediaStream(playback.url) : { ok: false, status: 0, bytes: 0, contentType: "unavailable" };
      report.playback = {
        attempted: true,
        playable: probe.ok,
        quality: playback.quality || "",
        message: playback.message || `${probe.status}:${probe.bytes}:${probe.contentType}`,
      };
    }
  } catch (error) {
    report.error = String(error?.message || error);
  }
  await fs.writeFile(path.join(app.getPath("userData"), "qq-self-test.json"), JSON.stringify(report, null, 2), "utf8");
}

function createQQWindow(options = {}) {
  const window = new BrowserWindow({
    width: options.width || 920,
    height: options.height || 720,
    minWidth: 760,
    minHeight: 560,
    parent: options.parent || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
    modal: false,
    show: options.show ?? false,
    autoHideMenuBar: true,
    title: "QQ Music · CODIO",
    backgroundColor: "#0b0c0e",
    icon: APP_ICON,
    webPreferences: {
      partition: QQ_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installQQAuthGuards(window.webContents);
  window.webContents.setWindowOpenHandler(({ url }) => ({ action: isAllowedQQAuthNavigation(url) ? "allow" : "deny" }));
  return window;
}

async function refreshQQPlaybackSession(force = false) {
  const initial = await readQQStatus();
  // A provider rejection needs human authorization, not more hidden warmups.
  if (initial.authorizationRequired) return initial;
  if (!initial.loggedIn || (initial.playbackReady && !force)) return initial;
  if (qqPlaybackRefreshPending) return qqPlaybackRefreshPending;
  const pending = refreshQQPlaybackSessionOnce(initial);
  qqPlaybackRefreshPending = pending;
  try { return await pending; }
  finally { if (qqPlaybackRefreshPending === pending) qqPlaybackRefreshPending = null; }
}

async function refreshQQPlaybackSessionOnce(initial) {
  const warmupWindow = createQQWindow({ show: false, width: 760, height: 560 });
  const startedAt = Date.now();
  const timeout = setTimeout(() => {
    if (!warmupWindow.isDestroyed()) warmupWindow.destroy();
  }, 12000);
  try {
    await warmupWindow.loadURL(QQ_PLAYER_URL, { userAgent: USER_AGENT });
    while (Date.now() - startedAt < 12000) {
      const status = await readQQStatus();
      if (status.playbackReady) {
        await session.fromPartition(QQ_PARTITION).flushStorageData();
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return readQQStatus();
  } catch {
    return initial;
  } finally {
    clearTimeout(timeout);
    if (!warmupWindow.isDestroyed()) warmupWindow.destroy();
  }
}

async function openQQLogin(_event, options = {}) {
  let current = await readQQStatus();
  const forceAuthorization = options?.forceAuthorization === true || current.authorizationRequired === true;
  if (!forceAuthorization && current.loggedIn && !current.playbackReady) current = await refreshQQPlaybackSession();
  if (!forceAuthorization && current.playbackReady) return current;
  if (loginPromise) return loginPromise;
  if (forceAuthorization) qqPlaybackAuthorizationRevision += 1;
  const initialPlaybackKeyHash = qqPlaybackKeyHash((await readQQAuth()).playbackKey);
  const playbackRecoveryTrack = qqPlaybackAuthorizationFailure === initialPlaybackKeyHash ? qqPlaybackAuthorizationTrack : null;
  const recoveryUrl = forceAuthorization
    && qqPlaybackAuthorizationFailure === initialPlaybackKeyHash
    && qqPlaybackVerificationBlocked !== initialPlaybackKeyHash
    && isTrustedQQUrl(qqPlaybackVerificationUrl)
    ? qqPlaybackVerificationUrl : QQ_LOGIN_URL;

  loginPromise = new Promise((resolve) => {
    const loginWindow = createQQWindow();
    let pollTimer = null;
    let warmupTimer = null;
    let warmupWindow = null;
    let playbackFinalizePending = false;
    let finished = false;
    let recoveryCheckPending = false;
    let recoveryCheckPromise = null;
    let connectionError;
    const popupWindows = new Set();

    const probePlaybackRecovery = () => {
      if (recoveryCheckPromise) return recoveryCheckPromise;
      if (!playbackRecoveryTrack) return Promise.resolve(false);
      recoveryCheckPending = true;
      recoveryCheckPromise = (async () => {
        try { return (await resolveQQPlaybackOnce(null, playbackRecoveryTrack, false)).playable === true; }
        catch { return false; } // A failed request is not proof of renewed authorization.
      })();
      return recoveryCheckPromise;
    };

    const finish = async () => {
      if (finished) return;
      finished = true;
      if (pollTimer) clearInterval(pollTimer);
      if (warmupTimer) clearTimeout(warmupTimer);
      try { await session.fromPartition(QQ_PARTITION).flushStorageData(); } catch {}
      if (warmupWindow && !warmupWindow.isDestroyed()) warmupWindow.destroy();
      for (const popup of popupWindows) {
        if (!popup.isDestroyed()) popup.destroy();
      }
      popupWindows.clear();
      // QQ can approve the same key and close its verification page without a
      // mobile redirect. Recheck the rejected source once, not cookie presence.
      if (recoveryCheckPromise) await recoveryCheckPromise;
      else if ((await readQQStatus()).authorizationRequired) await probePlaybackRecovery();
      const status = await readQQStatus();
      if (!loginWindow.isDestroyed()) loginWindow.destroy();
      loginPromise = null;
      resolve(connectionError ? { ...status, playbackReady: false, connectionError } : status);
    };

    const blockedRecovery = async () => {
      if (finished || recoveryCheckPending) return;
      // A captcha may authorize the unchanged credential. Check the actual
      // rejected track once; never solve the captcha or repeat source storms.
      if (await probePlaybackRecovery()) { await finish(); return; }
      if (finished) return;
      qqPlaybackVerificationBlocked = initialPlaybackKeyHash;
      connectionError = "QQ_DESKTOP_AUTH_UNSUPPORTED";
      await finish();
    };

    const warmPlaybackSession = () => {
      if (warmupTimer || warmupWindow || finished) return;
      // QQ's OAuth callback writes the generic session first. Give it time to
      // finish, then open the official player in the same persistent session
      // so QQ can issue qm_keyst/qqmusic_key without replacing the callback.
      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        if (finished) return;
        warmupWindow = createQQWindow({ parent: loginWindow, width: 720, height: 560 });
        warmupWindow.webContents.on("did-finish-load", checkStatus);
        warmupWindow.loadURL(QQ_PLAYER_URL, { userAgent: USER_AGENT }).catch(() => {});
      }, 5000);
    };

    const checkStatus = async () => {
      const status = await readQQStatus();
      // An old cookie cannot close a window explicitly opened to renew it.
      if (forceAuthorization && qqPlaybackKeyHash((await readQQAuth()).playbackKey) === initialPlaybackKeyHash
        && (!playbackRecoveryTrack || !status.playbackReady)) return;
      if (status.playbackReady) {
        if (playbackFinalizePending) return;
        playbackFinalizePending = true;
        // QQ writes related refresh/profile cookies in a short burst.
        setTimeout(finish, 450);
        return;
      }
      if (status.loggedIn) warmPlaybackSession();
    };

    const checkTrustedReturn = async (_event, url) => {
      if (finished || !playbackRecoveryTrack || recoveryCheckPending || !isTrustedQQUrl(url) || !isAllowedQQAuthNavigation(url)) return;
      const returned = new URL(url), player = new URL(QQ_PLAYER_URL), profile = new URL(QQ_LOGIN_URL);
      if (returned.origin !== player.origin || ![player.pathname, profile.pathname].includes(returned.pathname) || url === recoveryUrl) return;
      if (await probePlaybackRecovery()) await finish();
    };

    const installQQWindowHandlers = (window, isRoot = false) => {
      if (!window || window.isDestroyed()) return;
      installQQAuthGuards(window.webContents);
      window.webContents.on("codio-auth-blocked", blockedRecovery);
      window.webContents.on("did-navigate", checkTrustedReturn);
      window.webContents.on("did-navigate-in-page", checkTrustedReturn);
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedQQAuthNavigation(url) && isTrustedQQUrl(url)) {
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              width: 760,
              height: 640,
              parent: loginWindow,
              modal: false,
              show: true,
              autoHideMenuBar: true,
              backgroundColor: "#0b0c0e",
              webPreferences: {
                partition: QQ_PARTITION,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            },
          };
        }
        void blockedRecovery();
        return { action: "deny" };
      });
      window.webContents.on("did-create-window", (child) => {
        popupWindows.add(child);
        child.on("closed", () => popupWindows.delete(child));
        installQQWindowHandlers(child, false);
      });
      if (!isRoot) window.webContents.on("did-finish-load", checkStatus);
    };

    installQQWindowHandlers(loginWindow, true);
    loginWindow.webContents.on("did-finish-load", checkStatus);
    loginWindow.once("ready-to-show", () => {
      loginWindow.show();
      loginWindow.focus();
    });
    loginWindow.on("closed", finish);
    pollTimer = setInterval(checkStatus, 1200);
    loginWindow.loadURL(recoveryUrl, { userAgent: USER_AGENT }).catch(async () => {
      try {
        await loginWindow.loadURL(QQ_LOGIN_FALLBACK_URL, { userAgent: USER_AGENT });
      } catch {
        finish();
      }
    });
  });

  return loginPromise;
}

async function createMainWindow() {
  const codioUrl = await ensureLocalAppServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    autoHideMenuBar: true,
    title: "CODIO",
    backgroundColor: "#070809",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  await mainWindow.loadURL(codioUrl, { userAgent: USER_AGENT });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on("second-instance", (_event, argv) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (hasQQLoginProtocol(argv)) openQQLogin().catch(() => {});
});

app.whenReady().then(async () => {
  if (process.argv.includes("--qq-self-test")) {
    runQQSelfTest().finally(() => app.quit());
    return;
  }
  app.setAsDefaultProtocolClient("codio");
  ipcMain.handle("codio:system-volume-get", (event) => handleSystemVolume(event));
  ipcMain.handle("codio:system-volume-set", (event, value) => handleSystemVolume(event, value, true));
  stopSystemVolumeBroadcast = systemVolume.subscribe((status) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("codio:system-volume-changed", status);
    }
  });
  ipcMain.handle("codio:qq-status", (_event, options) => options?.recover === false ? readQQStatus() : refreshQQPlaybackSession(false));
  ipcMain.handle("codio:local-import", importLocalFiles);
  ipcMain.handle("codio:local-library", () => localLibrary.list());
  ipcMain.handle("codio:qq-login", openQQLogin);
  ipcMain.handle("codio:qq-search", searchQQMusic);
  ipcMain.handle("codio:qq-metadata", readQQTrackMetadata);
  ipcMain.handle("codio:qq-lyrics", readQQLyrics);
  ipcMain.handle("codio:qq-library", readQQLibrary);
  ipcMain.handle("codio:qq-play", resolveQQPlayback);
  ipcMain.handle("codio:qq-cover", loadQQCover);
  ipcMain.handle("codio:ai-status", readAIStatus);
  ipcMain.handle("codio:ai-save-key", (_event, key) => saveDeepSeekKey(key));
  ipcMain.handle("codio:ai-clear-key", clearDeepSeekKey);
  ipcMain.handle("codio:ai-step", (_event, request) => stepWithCodio(request));
  ipcMain.handle("codio:onboarding-get", readDesktopOnboardingState);
  ipcMain.handle("codio:onboarding-save", (_event, value) => saveDesktopOnboardingState(value));
  ipcMain.handle("codio:analysis-get", (_event, trackId, version) => readMusicAnalysis(trackId, version));
  ipcMain.handle("codio:analysis-save", (_event, trackId, analysis) => saveMusicAnalysis(trackId, analysis));
  ipcMain.handle("codio:qq-logout", async () => {
    const qqSession = session.fromPartition(QQ_PARTITION);
    await qqSession.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "cachestorage"] });
    return readQQStatus();
  });
  await createMainWindow();
  if (hasQQLoginProtocol()) openQQLogin().catch(() => {});
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
}).catch((error) => {
  dialog.showErrorBox("CODIO 无法启动", error.message === "CODIO_LOCAL_PORT_IN_USE"
    ? "CODIO 的本机端口正被其他程序占用。请关闭旧的 CODIO 窗口后重试；为保护画像和历史，本次没有切换存储地址。"
    : "本机服务无法启动。现有登录、画像和历史未清除，请检查本机服务或配置后重试。");
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopSystemVolumeBroadcast?.();
  systemVolume.dispose();
  appServerProcess?.kill();
  appServerProcess = null;
  mediaServer?.close();
  mediaServer = null;
  mediaServerPort = 0;
});
