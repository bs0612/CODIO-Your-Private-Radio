import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assertKeyStorageAvailable,
  normalizeModelToolCalls,
  normalizeModelReply,
  requestDeepSeek,
  sanitizeMessages,
  serializeContext,
  validateToolArguments,
  verifyAndEncryptDeepSeekKey,
} = require("../desktop/codio-ai.cjs");

const response = (status) => ({ ok: status >= 200 && status < 300, status });

test("preference evidence is bounded at the IPC boundary, not silently filtered", () => {
  const args = { target_type: "artist", artist_name: "Verified Artist", value: "more", evidence_text: "Verified Artist really works for me" };
  assert.equal(validateToolArguments("record_music_preference", args), true);
  assert.equal(validateToolArguments("record_music_preference", { ...args, evidence_text: "x".repeat(401) }), false);
  assert.equal(validateToolArguments("record_music_preference", { ...args, evidence_text: {} }), false);
});

test("DeepSeek deadline covers the response body, not just response headers", async () => {
  await assert.rejects(() => requestDeepSeek(async (_url, options) => ({ ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  }), "sk-test-only", {}, { timeoutMs: 10, readJson: true }), /CODIO_MODEL_TIMEOUT/);
  await assert.rejects(() => requestDeepSeek(async () => ({ ok: true, json: async () => { throw new SyntaxError("bad JSON"); } }),
    "sk-test-only", {}, { timeoutMs: 100, readJson: true }), /CODIO_MODEL_INVALID_RESPONSE/);
});

test("a truncated model response cannot execute even its otherwise complete tool calls", () => {
  const payload = { choices: [{ finish_reason: "length", message: { tool_calls: [{ id: "1", function: { name: "search_music", arguments: '{"query":"风衣"}' } }] } }] };
  assert.throws(() => normalizeModelReply(payload, new Set(["search_music"])), /CODIO_MODEL_TRUNCATED/);
  payload.choices[0].finish_reason = "tool_calls";
  assert.equal(normalizeModelReply(payload, new Set(["search_music"])).toolCalls[0].arguments.query, "风衣");
});

test("DeepSeek retries 429 and 5xx at most once", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    await assert.rejects(() => requestDeepSeek(async () => { calls += 1; return response(status); }, "sk-secret", {}, { prefix: "TEST", timeoutMs: 100 }), new RegExp(status === 429 ? "TEST_RATE_LIMITED" : "TEST_SERVICE_UNAVAILABLE"));
    assert.equal(calls, 2);
  }
});

test("DeepSeek succeeds after the single allowed transient retry", async () => {
  let calls = 0;
  const result = await requestDeepSeek(async () => {
    calls += 1;
    return response(calls === 1 ? 429 : 200);
  }, "sk-secret", {}, { prefix: "TEST", timeoutMs: 100 });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("DeepSeek does not retry 401 or 402 and never reveals the key", async () => {
  for (const status of [401, 402]) {
    let calls = 0;
    const secret = "sk-never-print-this";
    const error = await requestDeepSeek(async () => { calls += 1; return response(status); }, secret, {}, { prefix: "TEST", timeoutMs: 100 }).catch((value) => value);
    assert.equal(calls, 1);
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.match(String(error), new RegExp(status === 401 ? "TEST_UNAUTHORIZED" : "TEST_PAYMENT_REQUIRED"));
  }
});

test("DeepSeek reports stable timeout and network errors", async () => {
  const timeout = await requestDeepSeek((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))), "sk-secret", {}, { prefix: "TEST", timeoutMs: 5 }).catch((value) => value);
  assert.match(String(timeout), /TEST_TIMEOUT/);
  await assert.rejects(() => requestDeepSeek(async () => { throw new Error("offline"); }, "sk-secret", {}, { prefix: "TEST", timeoutMs: 100 }), /TEST_NETWORK/);
});

test("safeStorage unavailable is a stable refusal", () => {
  assert.throws(() => assertKeyStorageAvailable({ isEncryptionAvailable: () => false }), /DEEPSEEK_KEY_STORAGE_UNAVAILABLE/);
  assert.doesNotThrow(() => assertKeyStorageAvailable({ isEncryptionAvailable: () => true }));
});

test("Key verification uses stable errors and encrypts only after success", async () => {
  const secret = `sk-${"s".repeat(24)}`;
  let encrypted = 0;
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      encrypted += 1;
      assert.equal(value, secret);
      return Buffer.from("ciphertext");
    },
  };

  for (const [status, code, expectedCalls] of [[401, "DEEPSEEK_KEY_UNAUTHORIZED", 1], [402, "DEEPSEEK_KEY_PAYMENT_REQUIRED", 1], [429, "DEEPSEEK_KEY_RATE_LIMITED", 2], [503, "DEEPSEEK_KEY_SERVICE_UNAVAILABLE", 2]]) {
    let calls = 0;
    const error = await verifyAndEncryptDeepSeekKey(async () => {
      calls += 1;
      return response(status);
    }, storage, secret, { timeoutMs: 100 }).catch((value) => value);
    assert.equal(calls, expectedCalls);
    assert.match(String(error), new RegExp(code));
    assert.doesNotMatch(String(error), new RegExp(secret));
  }
  assert.equal(encrypted, 0);

  const ciphertext = await verifyAndEncryptDeepSeekKey(async () => response(200), storage, secret, { timeoutMs: 100 });
  assert.deepEqual(ciphertext, Buffer.from("ciphertext"));
  assert.equal(encrypted, 1);
});

test("Key verification distinguishes network, timeout, and safeStorage failures", async () => {
  const secret = `sk-${"s".repeat(24)}`;
  const storage = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from("ciphertext") };
  await assert.rejects(() => verifyAndEncryptDeepSeekKey(async () => { throw new Error(secret); }, storage, secret, { timeoutMs: 100 }), /DEEPSEEK_KEY_NETWORK/);
  const timeout = verifyAndEncryptDeepSeekKey((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))), storage, secret, { timeoutMs: 5 });
  await assert.rejects(() => timeout, /DEEPSEEK_KEY_TIMEOUT/);
  await assert.rejects(() => verifyAndEncryptDeepSeekKey(async () => response(200), { isEncryptionAvailable: () => false }, secret), /DEEPSEEK_KEY_STORAGE_UNAVAILABLE/);
});

test("message boundary limits count, content, tool result, ids, names, and duplicates", () => {
  assert.throws(() => sanitizeMessages(Array.from({ length: 25 }, () => ({ role: "user", content: "x" }))), /CODIO_MESSAGES_TOO_MANY/);
  assert.throws(() => sanitizeMessages([{ role: "user", content: "x".repeat(4001) }]), /CODIO_MESSAGE_TOO_LARGE/);
  assert.throws(() => sanitizeMessages([{ role: "assistant", content: "", toolCalls: [{ id: "x".repeat(129), name: "a", arguments: {} }] }]), /CODIO_TOOL_CALL_ID_TOO_LONG/);
  assert.throws(() => sanitizeMessages([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "x".repeat(65), arguments: {} }] }]), /CODIO_TOOL_NAME_TOO_LONG/);
  assert.throws(() => sanitizeMessages([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", arguments: {} }, { id: "1", name: "x", arguments: {} }] }]), /CODIO_DUPLICATE_TOOL_CALL_ID/);
  assert.throws(() => sanitizeMessages([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", arguments: {} }] }, { role: "tool", toolCallId: "1", content: "x".repeat(8001) }]), /CODIO_TOOL_RESULT_TOO_LARGE/);
  assert.throws(() => sanitizeMessages([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", arguments: { value: "x".repeat(4001) } }] }]), /CODIO_TOOL_ARGUMENTS_TOO_LARGE/);
  assert.throws(() => sanitizeMessages([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", arguments: "not-an-object" }] }]), /CODIO_TOOL_ARGUMENTS_INVALID/);
  assert.throws(() => sanitizeMessages([{ role: "user", content: " " }]), /CODIO_MESSAGE_INVALID/);
  assert.throws(() => sanitizeMessages([{ role: "tool", toolCallId: "missing", content: "{}" }]), /CODIO_TOOL_RESULT_INVALID/);
});

test("invalid model tool calls remain structured rejections", () => {
  const valid = new Set(["adjust_volume"]);
  const calls = normalizeModelToolCalls([
    { id: "1", function: { name: "delete_data", arguments: "{}" } },
    { id: "2", function: { name: "adjust_volume", arguments: "{bad" } },
    { id: "2", function: { name: "adjust_volume", arguments: "{}" } },
  ], valid);
  assert.deepEqual(calls.map((call) => call.arguments.__error), ["UNKNOWN_TOOL", "INVALID_TOOL_ARGUMENTS", "DUPLICATE_TOOL_CALL_ID"]);
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);
  assert.doesNotThrow(() => sanitizeMessages([
    { role: "user", content: "test" },
    { role: "assistant", content: "", toolCalls: calls },
    ...calls.map((call) => ({ role: "tool", toolCallId: call.id, content: JSON.stringify(call.arguments) })),
  ]));
});

test("malformed and excessive model tool calls are structured rejections", () => {
  assert.equal(normalizeModelToolCalls({ bad: true }, new Set())[0].arguments.__error, "INVALID_TOOL_CALLS");
  const calls = normalizeModelToolCalls(Array.from({ length: 9 }, (_, index) => ({ id: String(index), function: { name: "control_playback", arguments: JSON.stringify({ action: "pause" }) } })), new Set(["control_playback"]));
  assert.equal(calls.length, 8);
  assert.equal(calls.at(-1).arguments.__error, "TOO_MANY_TOOL_CALLS");
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);
});

test("tool argument and context validation enforce strict bounds", () => {
  assert.equal(validateToolArguments("adjust_volume", { operation: "set", value: 100 }), true);
  assert.equal(validateToolArguments("adjust_volume", { operation: "increase", value: 31 }), false);
  assert.equal(validateToolArguments("search_music", { query: " ", limit: 5 }), false);
  assert.equal(validateToolArguments("search_music", { query: "song", limit: 11 }), false);
  assert.equal(validateToolArguments("update_interface", {}), false);
  assert.equal(validateToolArguments("update_interface", { theme: "white" }), false);
  assert.equal(validateToolArguments("update_interface", { theme: "day" }), false);
  assert.equal(validateToolArguments("control_playback", { action: "pause", extra: true }), false);
  assert.equal(validateToolArguments("play_search_result", { track_id: " " }), false);
  assert.throws(() => serializeContext({ value: "x".repeat(30001) }), /CODIO_CONTEXT_TOO_LARGE/);
});

test("desktop normalization accepts verified preference and temporary intent calls", () => {
  const values = [
    ["record_music_preference", { target_type: "track", track_id: "qq:valentina", value: "more" }],
    ["record_music_preference", { target_type: "artist", artist_name: "Daniel Caesar", value: "more" }],
    ["record_music_preference", { target_type: "feature", feature_key: "instrumental", value: "less" }],
    ["set_session_intent", { familiarity: "explore", energy: "calm", flow: "continuous" }],
  ];
  const calls = normalizeModelToolCalls(values.map(([name, args], index) => ({ id: `preference-${index}`, function: { name, arguments: JSON.stringify(args) } })), new Set(values.map(([name]) => name)));
  assert.deepEqual(calls.map(({ name, arguments: args }) => [name, args]), values);
  assert.doesNotThrow(() => sanitizeMessages([
    { role: "user", content: "我最近特别喜欢 Daniel 的 Valentina 和 Always，其他他的歌也挺好听" },
    { role: "assistant", content: "", toolCalls: calls },
    ...calls.map(({ id }) => ({ role: "tool", toolCallId: id, content: '{"ok":true}' })),
  ]));
});

test("desktop preference boundary rejects ambiguous scopes, blank ids and invalid intent", () => {
  const invalidPreferences = [
    { target_type: "album", track_id: "qq:1", value: "more" },
    { target_type: "track", track_id: " ", value: "more" },
    { target_type: "track", track_id: "x".repeat(129), value: "more" },
    { target_type: "track", track_id: "qq:1", artist_name: "Daniel", value: "more" },
    { target_type: "artist", artist_name: " ", value: "more" },
    { target_type: "artist", artist_name: "x".repeat(121), value: "more" },
    { target_type: "artist", artist_name: "Daniel", value: "like" },
    { target_type: "feature", feature_key: "vocal", value: "less" },
    { target_type: "feature", value: "less" },
    { target_type: "feature", feature_key: "instrumental", value: "like" },
    { target_type: "feature", feature_key: "instrumental", value: "less", track_id: "qq:1" },
    { target_type: "feature", feature_key: "instrumental", value: "less", artist_name: "Daniel" },
    { target_type: "feature", feature_key: "instrumental", value: "less", scope: "session" },
  ];
  for (const args of invalidPreferences) assert.equal(validateToolArguments("record_music_preference", args), false);
  for (const args of [{}, { mood: "calm" }, { energy: "loud" }, { flow: 1 }, { familiarity: null }]) assert.equal(validateToolArguments("set_session_intent", args), false);
  assert.equal(validateToolArguments("set_session_intent", { energy: "calm" }), true);
});
