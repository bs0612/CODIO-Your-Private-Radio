import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Backup and restore of the device-local listening records, without a browser.
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../app/listening-backup.ts", import.meta.url))], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
const backup = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function storage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    map,
  };
}

const memory = JSON.stringify({ version: 2, events: [{ type: "play_settled" }, { type: "preference_changed" }] });

test("exports only CODIO listening records, never credentials or unrelated keys", () => {
  const source = storage({
    "codio-listening-memory-v2": memory,
    "codio-played-history": "[]",
    "tide-preferences": JSON.stringify({ scene: "dawn" }),
    "codio-recommendation-pool-v1-match": "{}",
    "codio-qq-music-authorized": "true",
    "codio-deepseek-key": "sk-secret",
    "unrelated": "1",
  });
  const result = backup.buildListeningBackup(source, new Date("2026-10-30T12:00:00Z"));
  assert.equal(result.app, "codio");
  assert.equal(result.version, 1);
  assert.equal(result.exportedAt, "2026-10-30T12:00:00.000Z");
  assert.deepEqual(Object.keys(result.entries).sort(), ["codio-listening-memory-v2", "codio-played-history", "codio-recommendation-pool-v1-match", "tide-preferences"]);
  assert.equal(backup.backupFileName(new Date(2026, 9, 30)), "codio-backup-2026-10-30.json");
});

test("a serialized backup restores on another profile and reports what it carried", () => {
  const source = storage({ "codio-listening-memory-v2": memory, "codio-search-history": JSON.stringify(["周杰伦"]) });
  const text = backup.serializeListeningBackup(backup.buildListeningBackup(source, new Date("2026-10-30T12:00:00Z")));
  const parsed = backup.parseListeningBackup(text);
  const target = storage({});
  const { applied, keys } = backup.applyListeningBackup(target, parsed);
  assert.equal(applied, 2);
  assert.deepEqual(keys.sort(), ["codio-listening-memory-v2", "codio-search-history"]);
  assert.equal(target.getItem("codio-listening-memory-v2"), memory);
  assert.equal(backup.describeListeningBackup(parsed), "2 项记录 · 2 条听歌记忆 · 2026-10-30");
});

test("restore refuses foreign files, other versions, empty and tampered entries", () => {
  const code = (text) => { try { backup.parseListeningBackup(text); return "ok"; } catch (error) { return error.code; } };
  assert.equal(code("not json"), "BACKUP_INVALID_JSON");
  assert.equal(code(JSON.stringify({ app: "other", version: 1, entries: { "tide-preferences": "{}" } })), "BACKUP_NOT_CODIO");
  assert.equal(code(JSON.stringify({ app: "codio", version: 2, entries: { "tide-preferences": "{}" } })), "BACKUP_VERSION");
  assert.equal(code(JSON.stringify({ app: "codio", version: 1, entries: { "codio-deepseek-key": "sk-x", "tide-preferences": "{not json" } })), "BACKUP_EMPTY");
  const parsed = backup.parseListeningBackup(JSON.stringify({ app: "codio", version: 1, entries: { "tide-preferences": "{}", "codio-qq-music-authorized": "true", "codio-played-history": 7 } }));
  assert.deepEqual(Object.keys(parsed.entries), ["tide-preferences"]);
  assert.ok(backup.isBackupKey("codio-recommendation-pool-v1-frontier"));
  assert.ok(!backup.isBackupKey("codio-qq-music-authorized"));
});
