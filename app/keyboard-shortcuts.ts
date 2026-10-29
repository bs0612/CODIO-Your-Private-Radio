// Keyboard control for the radio. Space (play/pause) is handled by a dedicated
// capture-phase listener in the player; everything else resolves here.

export type ShortcutAction =
  | "seek-backward" | "seek-forward" | "volume-up" | "volume-down"
  | "next-track" | "previous-track" | "like" | "dislike"
  | "toggle-now-playing" | "toggle-seamless" | "toggle-repeat"
  | "focus-search" | "toggle-help" | "close";

export const SHORTCUT_SEEK_SECONDS = 5;
export const SHORTCUT_VOLUME_STEP = 5;

export type ShortcutDescription = { keys: string[]; action: ShortcutAction | "toggle-playback"; label: string };

export const SHORTCUT_GUIDE: ShortcutDescription[] = [
  { keys: ["Space"], action: "toggle-playback", label: "播放 / 暂停" },
  { keys: ["←", "→"], action: "seek-backward", label: `快退 / 快进 ${SHORTCUT_SEEK_SECONDS} 秒` },
  { keys: ["↑", "↓"], action: "volume-up", label: `音量 ± ${SHORTCUT_VOLUME_STEP}` },
  { keys: ["N", "P"], action: "next-track", label: "下一首 / 上一首" },
  { keys: ["L", "D"], action: "like", label: "喜欢 / 不喜欢当前歌曲" },
  { keys: ["R"], action: "toggle-repeat", label: "单曲循环" },
  { keys: ["S"], action: "toggle-seamless", label: "潜流 · 无缝衔接" },
  { keys: ["F"], action: "toggle-now-playing", label: "进入 / 离开 Now Playing" },
  { keys: ["/"], action: "focus-search", label: "搜索" },
  { keys: ["?"], action: "toggle-help", label: "快捷键一览" },
  { keys: ["Esc"], action: "close", label: "关闭面板" },
];

type KeyEventLike = { key: string; code?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean };

export function isTextEntryTarget(target: { closest?: (selector: string) => unknown } | null | undefined) {
  return Boolean(target?.closest?.("input:not([type='range']), textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

const KEY_ACTIONS: Record<string, ShortcutAction> = {
  ArrowLeft: "seek-backward",
  ArrowRight: "seek-forward",
  ArrowUp: "volume-up",
  ArrowDown: "volume-down",
  n: "next-track",
  p: "previous-track",
  l: "like",
  d: "dislike",
  f: "toggle-now-playing",
  s: "toggle-seamless",
  r: "toggle-repeat",
  "/": "focus-search",
  "?": "toggle-help",
  Escape: "close",
};

export function resolveShortcut(event: KeyEventLike): ShortcutAction | null {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === " " || event.code === "Space") return null;
  // "?" is Shift+/ on most layouts; some synthetic events report the unshifted key.
  if (event.key === "?" || (event.shiftKey && (event.code === "Slash" || event.key === "/"))) return "toggle-help";
  if (event.shiftKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return KEY_ACTIONS[key] ?? null;
}
