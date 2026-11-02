const MAX_MESSAGES = 24;
const MAX_CONTENT = 4_000;
const MAX_TOOL_RESULT = 8_000;
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_CALL_ID = 128;
const MAX_TOOL_NAME = 64;
const MAX_TOOL_ARGUMENTS = 4_000;
const MAX_CONTEXT = 30_000;

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateToolArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (name === "control_playback") return hasOnlyKeys(args, ["action"]) && ["play", "pause", "next", "previous"].includes(args.action);
  if (name === "seek_playback") return hasOnlyKeys(args, ["position_percent"]) && Number.isFinite(args.position_percent) && args.position_percent >= 0 && args.position_percent <= 100;
  if (name === "adjust_volume") {
    if (!hasOnlyKeys(args, ["operation", "value"]) || !["set", "increase", "decrease"].includes(args.operation) || !Number.isFinite(args.value)) return false;
    return args.operation === "set" ? args.value >= 0 && args.value <= 100 : args.value >= 1 && args.value <= 30;
  }
  if (name === "search_music") return hasOnlyKeys(args, ["query", "limit"]) && typeof args.query === "string" && args.query.trim().length > 0 && args.query.trim().length <= 120 && (args.limit === undefined || Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 10);
  if (name === "play_search_result") return hasOnlyKeys(args, ["track_id"]) && typeof args.track_id === "string" && args.track_id.trim().length > 0 && args.track_id.length <= 128;
  if (name === "set_seamless") return hasOnlyKeys(args, ["enabled"]) && typeof args.enabled === "boolean";
  if (name === "rate_current_track") return hasOnlyKeys(args, ["rating"]) && ["like", "dislike"].includes(args.rating);
  if (name === "record_music_preference") {
    if (!["more", "less"].includes(args.value)) return false;
    if (args.evidence_text !== undefined && (typeof args.evidence_text !== "string" || !args.evidence_text.trim() || args.evidence_text.length > 400)) return false;
    if (args.target_type === "track") return hasOnlyKeys(args, ["target_type", "track_id", "value", "evidence_text"]) && typeof args.track_id === "string" && args.track_id.trim().length > 0 && args.track_id.length <= 128;
    if (args.target_type === "artist") return hasOnlyKeys(args, ["target_type", "artist_name", "value", "evidence_text"]) && typeof args.artist_name === "string" && args.artist_name.trim().length > 0 && args.artist_name.length <= 120;
    if (args.target_type === "feature") return hasOnlyKeys(args, ["target_type", "feature_key", "value", "evidence_text"]) && args.feature_key === "instrumental";
    return false;
  }
  if (name === "set_session_intent") {
    if (!Object.keys(args).length || !hasOnlyKeys(args, ["familiarity", "energy", "flow"])) return false;
    return (!("familiarity" in args) || ["familiar", "balanced", "explore"].includes(args.familiarity))
      && (!("energy" in args) || ["calm", "balanced", "energetic"].includes(args.energy))
      && (!("flow" in args) || ["continuous", "balanced", "varied"].includes(args.flow));
  }
  if (name === "refresh_recommendations") return Object.keys(args).length === 0;
  if (name === "update_interface") {
    const keys = Object.keys(args);
    if (!keys.length || !keys.every((key) => ["theme", "scene", "particles", "lyrics", "panel"].includes(key))) return false;
    if ("theme" in args && args.theme !== "night") return false;
    if ("scene" in args && !["night", "dawn", "deep"].includes(args.scene)) return false;
    if ("particles" in args && (!Number.isInteger(args.particles) || args.particles < 0 || args.particles > 2)) return false;
    if ("lyrics" in args && !["minimal", "cinematic"].includes(args.lyrics)) return false;
    if ("panel" in args && !["profile", "settings", "now_playing", "dj", "close"].includes(args.panel)) return false;
    return true;
  }
  return false;
}

function assertKeyStorageAvailable(storage) {
  if (!storage?.isEncryptionAvailable?.()) throw new Error("DEEPSEEK_KEY_STORAGE_UNAVAILABLE");
}

async function verifyAndEncryptDeepSeekKey(fetchImpl, storage, rawKey, options = {}) {
  const key = String(rawKey || "").trim();
  if (!key.startsWith("sk-") || key.length < 20) throw new Error("DEEPSEEK_KEY_INVALID");
  assertKeyStorageAvailable(storage);
  await requestDeepSeek(fetchImpl, key, {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Reply only: OK" }],
    max_tokens: 4,
    thinking: { type: "disabled" },
  }, { prefix: "DEEPSEEK_KEY", timeoutMs: 15_000, ...options });
  try {
    return storage.encryptString(key);
  } catch {
    throw new Error("DEEPSEEK_KEY_STORAGE_FAILED");
  }
}

function statusError(prefix, status) {
  if (status === 401) return `${prefix}_UNAUTHORIZED`;
  if (status === 402) return `${prefix}_PAYMENT_REQUIRED`;
  if (status === 429) return `${prefix}_RATE_LIMITED`;
  if (status >= 500) return `${prefix}_SERVICE_UNAVAILABLE`;
  return `${prefix}_HTTP_${status}`;
}

async function requestDeepSeek(fetchImpl, key, body, { prefix = "CODIO_MODEL", timeoutMs = 28_000, readJson = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) {
        if (!readJson) return response;
        try { return await response.json(); }
        catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError") throw new Error(`${prefix}_TIMEOUT`);
          throw new Error(`${prefix}_INVALID_RESPONSE`);
        }
      }
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
      throw new Error(statusError(prefix, response.status));
    } catch (error) {
      if (error?.message?.startsWith(`${prefix}_`)) throw error;
      if (error?.name === "AbortError") throw new Error(`${prefix}_TIMEOUT`);
      throw new Error(`${prefix}_NETWORK`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${prefix}_SERVICE_UNAVAILABLE`);
}

function normalizeModelReply(payload, validNames) {
  const choice = payload?.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("CODIO_MODEL_TRUNCATED");
  const assistant = choice?.message || {};
  const toolCalls = normalizeModelToolCalls(assistant.tool_calls, validNames);
  const content = typeof assistant.content === "string" ? assistant.content.trim() : "";
  if (!content && !toolCalls.length) throw new Error("CODIO_MODEL_EMPTY");
  return { content, toolCalls };
}

function boundedText(value, limit, code) {
  if (typeof value !== "string") throw new Error("CODIO_MESSAGE_INVALID");
  const text = value;
  if (text.length > limit) throw new Error(code);
  return text;
}

function stringifyToolArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODIO_TOOL_ARGUMENTS_INVALID");
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error("CODIO_TOOL_ARGUMENTS_INVALID");
  }
  if (text.length > MAX_TOOL_ARGUMENTS) throw new Error("CODIO_TOOL_ARGUMENTS_TOO_LARGE");
  return text;
}

function sanitizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages) || !rawMessages.length) throw new Error("EMPTY_CONVERSATION");
  if (rawMessages.length > MAX_MESSAGES) throw new Error("CODIO_MESSAGES_TOO_MANY");
  const toolCallIds = new Set();
  const toolResultIds = new Set();
  return rawMessages.map((message) => {
    if (message?.role === "tool") {
      const id = boundedText(message.toolCallId, MAX_TOOL_CALL_ID, "CODIO_TOOL_CALL_ID_TOO_LONG");
      if (!id || !toolCallIds.has(id) || toolResultIds.has(id)) throw new Error("CODIO_TOOL_RESULT_INVALID");
      toolResultIds.add(id);
      return { role: "tool", tool_call_id: id, content: boundedText(message.content, MAX_TOOL_RESULT, "CODIO_TOOL_RESULT_TOO_LARGE") };
    }
    if (message?.role === "assistant" && Array.isArray(message.toolCalls)) {
      if (message.toolCalls.length > MAX_TOOL_CALLS) throw new Error("CODIO_TOOL_CALLS_TOO_MANY");
      const calls = message.toolCalls.map((call) => {
        const id = boundedText(call?.id, MAX_TOOL_CALL_ID, "CODIO_TOOL_CALL_ID_TOO_LONG");
        const name = boundedText(call?.name, MAX_TOOL_NAME, "CODIO_TOOL_NAME_TOO_LONG");
        if (!id || !name || toolCallIds.has(id)) throw new Error("CODIO_DUPLICATE_TOOL_CALL_ID");
        toolCallIds.add(id);
        return { id, type: "function", function: { name, arguments: stringifyToolArguments(call.arguments) } };
      });
      return { role: "assistant", content: boundedText(message.content, MAX_CONTENT, "CODIO_MESSAGE_TOO_LARGE"), tool_calls: calls };
    }
    if (message?.role === "user" || message?.role === "assistant") {
      const content = boundedText(message.content, MAX_CONTENT, "CODIO_MESSAGE_TOO_LARGE");
      if (!content.trim()) throw new Error("CODIO_MESSAGE_INVALID");
      return { role: message.role, content };
    }
    throw new Error("CODIO_MESSAGE_INVALID");
  });
}

function normalizeModelToolCalls(rawCalls, validNames) {
  if (rawCalls === undefined || rawCalls === null) return [];
  if (!Array.isArray(rawCalls)) return [{ id: "rejected-tool-calls", name: "invalid_tool", arguments: { __error: "INVALID_TOOL_CALLS" } }];
  const seenRaw = new Set();
  const usedIds = new Set();
  const rejectedId = (index) => {
    let id = `rejected-${index}`;
    while (usedIds.has(id)) id += "-x";
    return id;
  };
  const limited = rawCalls.length > MAX_TOOL_CALLS ? rawCalls.slice(0, MAX_TOOL_CALLS - 1) : rawCalls;
  const normalized = limited.map((call, index) => {
    const rawId = String(call?.id || "");
    const rawName = String(call?.function?.name || "");
    const duplicate = rawId && seenRaw.has(rawId);
    const id = rawId && rawId.length <= MAX_TOOL_CALL_ID && !duplicate && !usedIds.has(rawId) ? rawId : rejectedId(index);
    const name = rawName.slice(0, MAX_TOOL_NAME) || "invalid_tool";
    let args = {};
    let error = "";
    if (!rawId || rawId.length > MAX_TOOL_CALL_ID) error = "INVALID_TOOL_CALL_ID";
    else if (duplicate) error = "DUPLICATE_TOOL_CALL_ID";
    else if (!rawName || rawName.length > MAX_TOOL_NAME || !validNames.has(rawName)) error = "UNKNOWN_TOOL";
    try { args = JSON.parse(call?.function?.arguments || "{}"); } catch { error ||= "INVALID_TOOL_ARGUMENTS"; }
    if (!error && !validateToolArguments(rawName, args)) error = "INVALID_TOOL_ARGUMENTS";
    seenRaw.add(rawId);
    usedIds.add(id);
    return { id, name, arguments: error ? { __error: error } : args };
  });
  if (rawCalls.length > MAX_TOOL_CALLS) {
    const id = rejectedId("overflow");
    normalized.push({ id, name: "invalid_tool", arguments: { __error: "TOO_MANY_TOOL_CALLS" } });
  }
  return normalized;
}

function serializeContext(context) {
  const value = JSON.stringify(context || {});
  if (value.length > MAX_CONTEXT) throw new Error("CODIO_CONTEXT_TOO_LARGE");
  return value;
}

module.exports = {
  assertKeyStorageAvailable,
  normalizeModelToolCalls,
  normalizeModelReply,
  requestDeepSeek,
  sanitizeMessages,
  serializeContext,
  validateToolArguments,
  verifyAndEncryptDeepSeekKey,
};
