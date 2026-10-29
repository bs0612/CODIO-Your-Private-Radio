"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activePreferences,
  accumulatePlayingTime,
  beginListeningSession,
  canonicalTrackKey,
  createEmptyListeningMemory,
  createSessionIntent,
  deriveListeningProfile,
  loadListeningMemory,
  recordListeningEvent,
  recommendationExplanation,
  saveListeningMemory,
  supplementPreferenceFeatures,
  scoreCandidate,
  createRecommendationPool,
  recommendationAcquisitionSeeds,
  interleaveRecommendationSources,
  beginRecommendationPoolUpdate,
  commitRecommendationPoolUpdate,
  failRecommendationPoolUpdate,
  isLearningEvent,
  mergeHiddenRecommendations,
  listeningStatus,
  migrateRecommendationExposure,
  type CandidateTrack,
  type ListeningMemory,
  type ListeningSession,
  type PlaySettledEvent,
  type PreferenceScope,
  type RecommendationScore,
  type RecommendationLane,
  type SessionIntent,
  type TrackFeatureVector,
} from "./listening-intelligence";
import { codioRequestFailure, didRequestedTrackStart, isOfflineCodioShortcut, runCodioAgentLoop, validateCodioToolCall, verifyNamedTrackPreference } from "./codio-agent";
import LyricsScroller from "./LyricsScroller";
import { buildListeningPresentation } from "./listening-presentation";
import { loadLyricsWithRetry } from "./codio-requests";
import { readCodioOnboarding, saveCodioOnboarding } from "./codio-onboarding";
import {
  analyzePcmTrack,
  adaptTransitionPlan,
  beatMatchingRate,
  createNeutralTransitionPlan,
  getMusicVisualFrame,
  getTransitionChoreography,
  getTransitionVisualFrame,
  isTransitionPlanUsable,
  isTrackAnalysisSourceValid,
  planSilenceHandoff,
  planTransition,
  transitionSettlingDuration,
  type TrackAnalysis,
  type TransitionPlan,
  type TransitionVisualFrame,
} from "./seamless-dj";
import { acquireParticleGlRenderer, hasAcceleratedWebGl } from "./particle-gl";
import { acquireAuroraRenderer, parseCssColor } from "./aurora-gl";
import { applyMediaSessionMetadata, applyMediaSessionPlaybackState, applyMediaSessionPosition, bindMediaSessionTransport, MEDIA_SESSION_SEEK_SECONDS } from "./media-session";
import { createClockSleepTimer, createTrackSleepTimer, formatSleepRemaining, SLEEP_FADE_MS, SLEEP_TIMER_MINUTES, sleepTimerRemaining, sleepTimerTrackChanged, type SleepTimer } from "./sleep-timer";
import { applyListeningBackup, backupFileName, buildListeningBackup, describeListeningBackup, ListeningBackupError, parseListeningBackup, serializeListeningBackup } from "./listening-backup";
import { isTextEntryTarget, resolveShortcut, SHORTCUT_GUIDE, SHORTCUT_SEEK_SECONDS, SHORTCUT_VOLUME_STEP } from "./keyboard-shortcuts";
import type { CodioAIMessage, CodioDesktopBridge, CodioToolCall, LyricLine, QQPlaybackResult, QQTasteSnapshot, QQTrack, SystemVolumeStatus } from "./radio-types";

type Message = {
  id: number;
  from: "dj" | "user";
  text: string;
};

type Scene = "night" | "dawn" | "deep";
type VisualMode = "album";
type EdgeZone = "top" | "right" | "bottom" | "left" | null;
type LyricMode = "minimal" | "cinematic";
type QQConnectionStatus = "checking" | "unavailable" | "needs-auth" | "authorizing" | "syncing" | "connected" | "error";

const NOW_INITIAL_RX = -7;
const NOW_INITIAL_RY = 9;

const lyricAtTime = (lines: LyricLine[], time: number) => lines.reduce((current, line) => line.time <= time ? line.text : current, "");

function bootPreparationProgress(state: {
  assetCompleted: number; memoryHydrated: boolean; layoutReady: boolean;
  animationDone: boolean; ready: boolean; onboardingChecked: boolean; aiStatusChecked: boolean;
  qqConnection: string; librarySettled: boolean; preparedSources: number;
}) {
  const needsMusic = !["needs-auth", "unavailable"].includes(state.qqConnection);
  const maximum = needsMusic ? 34 : 9;
  const assets = Number.isFinite(state.assetCompleted) ? Math.min(3, Math.max(0, Math.floor(state.assetCompleted))) : 0;
  const sources = Number.isFinite(state.preparedSources) ? Math.min(24, Math.max(0, Math.floor(state.preparedSources))) : 0;
  // Completed work only: no elapsed-time growth. The final DOM/source gate
  // still decides readiness; a counter alone cannot publish a prepared home.
  const settled = assets + [state.memoryHydrated, state.layoutReady, state.animationDone, state.onboardingChecked,
    state.aiStatusChecked, !["checking", "syncing", "authorizing"].includes(state.qqConnection)].filter(Boolean).length
    + (needsMusic ? Number(state.librarySettled) + sources : 0);
  const value = Math.min(state.ready ? maximum : maximum - 1, settled);
  return { value, maximum };
}

function readStartupRecommendationSnapshot(raw: unknown, lane: RecommendationLane, owner: string, now = Date.now()) {
  const empty = { tracks: [] as QQTrack[], visible: [] as string[] };
  if (!raw || typeof raw !== "object" || !owner || owner.length > 80) return empty;
  const saved = raw as { lane?: string; owner?: string; savedAt?: number; tracks?: QQTrack[]; visible?: string[] };
  if (saved.lane !== lane || saved.owner !== owner || !Number.isFinite(saved.savedAt)
    || now < saved.savedAt! || now - saved.savedAt! >= 6 * 60 * 60 * 1000 || !Array.isArray(saved.tracks)) return empty;
  const tracks = new Map<string, QQTrack>();
  for (const input of saved.tracks.slice(0, 132)) {
    if (!input || input.provider !== "qq" || typeof input.mid !== "string" || !/^[a-zA-Z0-9]{1,80}$/.test(input.mid)
      || typeof input.title !== "string" || !input.title.trim() || typeof input.artist !== "string" || !input.artist.trim()
      || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 24 * 60 * 60) continue;
    const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : undefined;
    const image = (value: unknown) => typeof value === "string" && /^https:\/\/[^\s]+$/.test(value) ? value.slice(0, 1000) : undefined;
    const albumMid = typeof input.albumMid === "string" && /^[a-zA-Z0-9]{1,80}$/.test(input.albumMid) ? input.albumMid : undefined;
    const mediaMid = typeof input.mediaMid === "string" && /^[a-zA-Z0-9]{1,80}$/.test(input.mediaMid) ? input.mediaMid : undefined;
    // Catalog facts only. Playback tickets, audio bytes, credentials, arbitrary
    // provider fields and large decoded image data never enter this snapshot.
    tracks.set(`qq:${input.mid}`, { provider: "qq", id: input.mid, mid: input.mid, mediaMid,
      title: input.title.trim().slice(0, 300), artist: input.artist.trim().slice(0, 500),
      durationSeconds: input.durationSeconds, album: text(input.album, 300), albumMid,
      cover: image(input.cover) || (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumMid}.jpg` : undefined),
      fallbackCover: image(input.fallbackCover), language: text(input.language, 60), releaseDate: text(input.releaseDate, 20),
      genres: Array.isArray(input.genres) ? input.genres.filter(value => typeof value === "string").map(value => value.slice(0, 60)).slice(0, 8) : [] });
  }
  const visible = Array.isArray(saved.visible) ? [...new Set(saved.visible.filter(id => typeof id === "string" && tracks.has(id)))].slice(0, 12) : [];
  return { tracks: [...tracks.values()], visible };
}

function buildStartupRecommendationSnapshot(tracks: QQTrack[], visible: string[], lane: RecommendationLane, owner: string, now = Date.now()) {
  const clean = readStartupRecommendationSnapshot({ lane, owner, savedAt: now, tracks, visible }, lane, owner, now);
  return { lane, owner, savedAt: now, ...clean };
}

type ProfileView = "overview" | "taste" | "rhythm" | "context";
type MusicAudioChain = {
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  highpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  lowEq: BiquadFilterNode;
  midEq: BiquadFilterNode;
  highEq: BiquadFilterNode;
  gain: GainNode;
};

type MusicMasterChain = { gain: GainNode; compressor: DynamicsCompressorNode };
type TransitionTrackSnapshot = { track: QQTrack; cover: string; lyrics: LyricLine[]; analysis: TrackAnalysis };
type TransitionRuntime = {
  id: string;
  state: "preparing" | "planned" | "preroll" | "phase-locking" | "mixing" | "committed" | "settling" | "completed" | "aborted" | "fallback";
  plan: TransitionPlan;
  outgoing: HTMLAudioElement;
  incoming: HTMLAudioElement;
  outgoingSnapshot: TransitionTrackSnapshot;
  incomingSnapshot: TransitionTrackSnapshot;
  audioStartAt: number;
  duration: number;
  switchPoint: number;
  settlingDuration: number;
  reason: "automatic" | "manual-next" | "manual-previous" | "manual-select";
  committed: boolean;
};
type TransitionDisplay = {
  id: string;
  outgoing: TransitionTrackSnapshot;
  incoming: TransitionTrackSnapshot;
  outgoingLyric: string;
  incomingLyric: string;
};

type SystemNoticeTone = "listening" | "analysis" | "ready" | "success" | "warning" | "error";

type PreparedTrack = {
  track: QQTrack;
  playback: QQPlaybackResult;
  coverData: string;
  coverPromise: Promise<string>;
  audio: HTMLAudioElement | null;
  preparedAt: number;
  expiresAt: number;
};

const PREPARED_TRACK_TTL_MS = 3 * 60 * 1000;

type CoverPoint = { nx: number; ny: number; rgb: [number, number, number]; alpha: number; seed: number; radius?: number; angle?: number };
type CoverPointPair = { from: CoverPoint; to: CoverPoint };

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value as K);
}

function sampleCoverPointCloud(source: string, grid: number): Promise<CoverPoint[]> {
  if (!source) return Promise.resolve([]);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        const sample = document.createElement("canvas");
        sample.width = grid;
        sample.height = grid;
        const sampleContext = sample.getContext("2d", { willReadFrequently: true });
        if (!sampleContext) return resolve([]);
        sampleContext.drawImage(image, 0, 0, grid, grid);
        const pixels = sampleContext.getImageData(0, 0, grid, grid).data;
        const points: CoverPoint[] = [];
        for (let row = 0; row < grid; row += 1) {
          for (let column = 0; column < grid; column += 1) {
            const offset = (row * grid + column) * 4;
            const alpha = pixels[offset + 3] / 255;
            const edge = Math.max(Math.abs(column / (grid - 1) - .5), Math.abs(row / (grid - 1) - .5)) * 2;
            const density = .998 - Math.pow(edge, 1.7) * .25;
            const seed = ((row * 73 + column * 151) % 101) / 100;
            if (alpha < .1 || seed > density) continue;
            const nx = column / (grid - 1) - .5;
            const ny = row / (grid - 1) - .5;
            points.push({
              nx,
              ny,
              rgb: [
                Math.min(255, 44 + pixels[offset] * 1.04),
                Math.min(255, 44 + pixels[offset + 1] * 1.04),
                Math.min(255, 44 + pixels[offset + 2] * 1.04),
              ],
              alpha: .62 + alpha * .38,
              seed,
              radius: Math.hypot(nx, ny),
              angle: Math.atan2(ny, nx),
            });
          }
        }
        resolve(points);
      } catch {
        resolve([]);
      }
    };
    image.onerror = () => resolve([]);
    image.src = source;
  });
}

function spatiallyPairCoverPoints(from: CoverPoint[], to: CoverPoint[]): CoverPointPair[] {
  if (!from.length || !to.length) return [];
  const count = Math.max(from.length, to.length);
  const bucketCount = 14;
  const buckets = new Map<number, CoverPoint[]>();
  const expandedTargets = Array.from({ length: count }, (_, index) => to[Math.min(to.length - 1, Math.floor(index * to.length / count))]);
  for (const point of expandedTargets) {
    const column = Math.max(0, Math.min(bucketCount - 1, Math.floor((point.nx + .5) * bucketCount)));
    const row = Math.max(0, Math.min(bucketCount - 1, Math.floor((point.ny + .5) * bucketCount)));
    const key = row * bucketCount + column;
    const bucket = buckets.get(key) || [];
    bucket.push(point);
    buckets.set(key, bucket);
  }
  const takeNearestBucketPoint = (source: CoverPoint) => {
    const sourceColumn = Math.max(0, Math.min(bucketCount - 1, Math.floor((source.nx + .5) * bucketCount)));
    const sourceRow = Math.max(0, Math.min(bucketCount - 1, Math.floor((source.ny + .5) * bucketCount)));
    for (let radius = 0; radius < bucketCount; radius += 1) {
      for (let row = Math.max(0, sourceRow - radius); row <= Math.min(bucketCount - 1, sourceRow + radius); row += 1) {
        for (let column = Math.max(0, sourceColumn - radius); column <= Math.min(bucketCount - 1, sourceColumn + radius); column += 1) {
          if (radius && row !== sourceRow - radius && row !== sourceRow + radius && column !== sourceColumn - radius && column !== sourceColumn + radius) continue;
          const bucket = buckets.get(row * bucketCount + column);
          if (bucket?.length) return bucket.pop()!;
        }
      }
    }
    return to[0];
  };
  return Array.from({ length: count }, (_, index) => {
    const source = from[Math.min(from.length - 1, Math.floor(index * from.length / count))];
    return { from: source, to: takeNearestBucketPoint(source) };
  });
}

const qqCoverUrl = (albumMid: string) => `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg?max_age=2592000`;
const coverFallback = "/codio-icon.png";

function SafeRecommendationCover({ src, fallbackSrc, className }: { src?: string; fallbackSrc?: string; className?: string }) {
  const [currentSource, setCurrentSource] = useState(src || fallbackSrc || coverFallback);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setCurrentSource(src || fallbackSrc || coverFallback);
  }, [src, fallbackSrc]);

  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth === 0) {
      if (fallbackSrc && currentSource !== fallbackSrc) setCurrentSource(fallbackSrc);
      else if (currentSource !== coverFallback) setCurrentSource(coverFallback);
    }
    if (!image || currentSource === coverFallback) return;
    // A stalled remote cover must settle to a decoded local placeholder before
    // boot can reveal the page, rather than leaving a blank pending image.
    const timer = window.setTimeout(() => {
      if (!image.complete || image.naturalWidth === 0) setCurrentSource(coverFallback);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [currentSource, fallbackSrc]);

  return <img ref={imageRef} className={className} src={currentSource} alt="" onError={() => {
    if (fallbackSrc && currentSource !== fallbackSrc) setCurrentSource(fallbackSrc);
    else if (currentSource !== coverFallback) setCurrentSource(coverFallback);
  }} />;
}

const tracks = [
  {
    title: "After Hours",
    artist: "The Weeknd",
    note: "暗夜合成器 · 缓慢升温",
    lyric: "Where are you now when I need you most?",
    lyricNext: "I gave you everything I had",
    duration: "6:01",
    color: "violet",
    bpm: 107,
    cover: qqCoverUrl("004ZFMF50m1Jg1"),
  },
  {
    title: "Space Song",
    artist: "Beach House",
    note: "梦幻流行 · 柔软失重",
    lyric: "Fall back into place",
    lyricNext: "It was late at night",
    duration: "5:20",
    color: "blue",
    bpm: 80,
    cover: qqCoverUrl("001926Yn1kFpCN"),
  },
  {
    title: "Apocalypse",
    artist: "Cigarettes After Sex",
    note: "朦胧人声 · 深夜低语",
    lyric: "Your lips, my lips, apocalypse",
    lyricNext: "Go and sneak us through the rivers",
    duration: "4:50",
    color: "rose",
    bpm: 94,
    cover: qqCoverUrl("003KcZIl1dD1yg"),
  },
  {
    title: "Intro",
    artist: "The xx",
    note: "极简器乐 · 留白呼吸",
    lyric: "Instrumental · let the silence speak",
    lyricNext: "No words, only the room between notes",
    duration: "2:07",
    color: "silver",
    bpm: 100,
    cover: qqCoverUrl("001ayzkJ0cso5l"),
  },
];

type Experiment = {
  lane?: RecommendationLane;
  provider?: string;
  id?: string;
  title: string;
  artist: string;
  reason: string;
  color: string;
  cover: string;
  tags: string[];
};

type PlayedTrack = {
  id: string;
  title: string;
  artist: string;
  cover?: string;
  fallbackCover?: string;
};

const experimentPool: Experiment[] = [
  { title: "Kerala", artist: "Bonobo", reason: "Organic pulse", color: "amber", cover: qqCoverUrl("001C5Lyf4EN1yp"), tags: ["electronic", "organic", "downtempo"] },
  { title: "An Ending", artist: "Brian Eno", reason: "Ambient · no beat", color: "mist", cover: qqCoverUrl("001Frvoh4E456m"), tags: ["ambient", "instrumental", "soft"] },
  { title: "Time Moves Slow", artist: "BADBADNOTGOOD", reason: "Soul · warmer grain", color: "green", cover: qqCoverUrl("004cObQM4CvPRo"), tags: ["soul", "jazz", "warm"] },
  { title: "Come Back to Earth", artist: "Mac Miller", reason: "Soft jazz haze", color: "plum", cover: qqCoverUrl("001O47z62sDQN6"), tags: ["soul", "jazz", "intimate"] },
  { title: "Nangs", artist: "Tame Impala", reason: "Psychedelic drift", color: "cobalt", cover: qqCoverUrl("000vMMsI2LnZO4"), tags: ["psychedelic", "electronic", "dream"] },
  { title: "Weightless", artist: "Marconi Union", reason: "Ambient calm", color: "graphite", cover: qqCoverUrl("000odXoV1ngP47"), tags: ["ambient", "instrumental", "calm"] },
  { title: "Space Song", artist: "Beach House", reason: "Dream-pop gravity", color: "plum", cover: qqCoverUrl("003mAMzt5aR23G"), tags: ["dream", "indie", "soft"] },
  { title: "Retrograde", artist: "James Blake", reason: "Electronic soul", color: "cobalt", cover: qqCoverUrl("003I3ICg2IDYxI"), tags: ["electronic", "soul", "intimate"] },
  { title: "Angels", artist: "The xx", reason: "Minimal intimacy", color: "graphite", cover: qqCoverUrl("004H6jqD2LbzaS"), tags: ["minimal", "indie", "intimate"] },
  { title: "Pink + White", artist: "Frank Ocean", reason: "Sunlit R&B", color: "amber", cover: qqCoverUrl("002OBFhJ2OxUVd"), tags: ["soul", "rnb", "warm"] },
  { title: "Wait", artist: "M83", reason: "Slow cinematic lift", color: "mist", cover: qqCoverUrl("002W8gci19EbKP"), tags: ["ambient", "cinematic", "dream"] },
  { title: "Apocalypse", artist: "Cigarettes After Sex", reason: "Velvet nocturne", color: "graphite", cover: qqCoverUrl("003UWxVx4C0BqR"), tags: ["dream", "indie", "intimate"] },
  { title: "Delilah (pull me out of this)", artist: "Fred again..", reason: "Human club pulse", color: "cobalt", cover: qqCoverUrl("0024MgeF2u5gYk"), tags: ["electronic", "dance", "emotive"] },
  { title: "Show Me How", artist: "Men I Trust", reason: "Soft-focus indie", color: "green", cover: qqCoverUrl("001xoezz3oIqq0"), tags: ["indie", "dream", "soft"] },
  { title: "Teardrop", artist: "Massive Attack", reason: "Trip-hop tension", color: "plum", cover: qqCoverUrl("002MIPPN4SkfAx"), tags: ["electronic", "trip-hop", "dark"] },
  { title: "Awake", artist: "Tycho", reason: "Open-air instrumental", color: "mist", cover: qqCoverUrl("000DNMtz2Qq1Wd"), tags: ["instrumental", "electronic", "warm"] },
  { title: "No Ordinary Love", artist: "Sade", reason: "Deep slow-burn soul", color: "green", cover: qqCoverUrl("001QzFz62LpwVU"), tags: ["soul", "slow", "intimate"] },
  { title: "Weird Fishes/Arpeggi", artist: "Radiohead", reason: "Restless immersion", color: "cobalt", cover: qqCoverUrl("003Qcf2G0Jx9FA"), tags: ["alternative", "organic", "immersive"] },
];

const artistTasteHints: Array<[RegExp, string[]]> = [
  [/the weeknd|frank ocean|sade|陈奕迅|林俊杰|邓紫棋/i, ["soul", "rnb", "intimate"]],
  [/beach house|cigarettes after sex|the xx|men i trust|王菲/i, ["dream", "indie", "soft"]],
  [/bonobo|tycho|fred again|james blake|massive attack/i, ["electronic", "downtempo", "immersive"]],
  [/brian eno|marconi union|m83/i, ["ambient", "instrumental", "cinematic"]],
  [/radiohead|coldplay|五月天|逃跑计划/i, ["alternative", "rock", "organic"]],
  [/周杰伦|王力宏|陶喆/i, ["rnb", "pop", "hip-hop"]],
  [/毛不易|赵雷|陈粒|房东的猫/i, ["folk", "soft", "intimate"]],
];

const playlistTasteHints: Array<[RegExp, string[]]> = [
  [/电子|electronic|电音/i, ["electronic", "dance"]],
  [/氛围|睡眠|冥想|ambient|study|学习/i, ["ambient", "calm", "instrumental"]],
  [/爵士|jazz|灵魂|soul|r&b/i, ["jazz", "soul", "rnb", "warm"]],
  [/独立|indie|梦幻|dream/i, ["indie", "dream", "soft"]],
  [/摇滚|rock|另类|alternative/i, ["rock", "alternative", "organic"]],
  [/说唱|hip.?hop|rap/i, ["hip-hop", "urban", "rhythmic"]],
  [/夜|night|深夜/i, ["night", "intimate", "dark"]],
  [/古典|classical|纯音乐|器乐/i, ["instrumental", "cinematic", "calm"]],
];


const suggestions = ["周杰伦", "The Weeknd", "陈奕迅", "Beach House"];
const FULL_AI_REQUIRED = "连接自己的 DeepSeek Key 后可使用完整 AI DJ。";

const recommendationIdentity = (item: Pick<Experiment, "title" | "artist" | "provider" | "id"> & { mid?: string }) =>
  item.mid || item.id ? canonicalTrackKey(item.provider || "qq", item.mid || item.id!)
    : `${item.title.trim().toLowerCase()}::${item.artist.trim().toLowerCase()}`;
const recommendationArtistMatches = (artist: string, query: string) =>
  artist.trim().toLowerCase() === query.trim().toLowerCase()
  || artist.split(/\s*(?:\/|;|,|、|&|feat\.)\s*/i).some((name) => name.trim().toLowerCase() === query.trim().toLowerCase());

const visualModes: Array<{ id: VisualMode; label: string; note: string }> = [
  { id: "album", label: "ALBUM DUST", note: "封面粒子 · 默认" },
];

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatProgress(percent: number) {
  const seconds = Math.round((percent / 100) * 361);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), milliseconds);
    promise.then((value) => {
      window.clearTimeout(timer);
      resolve(value);
    }, (error) => {
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

function countQQItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  for (const key of ["List", "Items", "SongList", "Data", "DissList"]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  return 0;
}

export function RadioExperience() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [bootPhase, setBootPhase] = useState<"playing" | "leaving" | "done">("playing");
  const [bootReady, setBootReady] = useState(false);
  const [bootAssetsReady, setBootAssetsReady] = useState(false);
  const [bootAssetCompleted, setBootAssetCompleted] = useState(0);
  const [bootAssetAttempt, setBootAssetAttempt] = useState(0);
  const [bootLayoutReady, setBootLayoutReady] = useState(false);
  const [bootPainting, setBootPainting] = useState(false);
  const [bootHomeFrameReady, setBootHomeFrameReady] = useState(false);
  const homeCanvasResumeRef = useRef<() => void>(() => {});
  const homeCanvasPaintedRef = useRef(false);
  const bootEntryCheckRef = useRef<() => boolean>(() => false);
  const bootPhaseRef = useRef(bootPhase);
  bootPhaseRef.current = bootPhase;
  const [bootPreparedSources, setBootPreparedSources] = useState<Set<string>>(new Set());
  const [bootSourceError, setBootSourceError] = useState(false);
  const [bootMusicTask, setBootMusicTask] = useState({ match: "", frontier: "" });
  const [bootAnimationDone, setBootAnimationDone] = useState(false);
  const [bootResourceError, setBootResourceError] = useState(false);
  const bootRetryRef = useRef(0);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [trackIndex, setTrackIndex] = useState(1);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(68);
  const [systemVolume, setSystemVolume] = useState<SystemVolumeStatus | null>(null);
  const [seamless, setSeamless] = useState(true);
  const [djOpen, setDjOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileView, setProfileView] = useState<ProfileView>("overview");
  const [modelConfigured, setModelConfigured] = useState(false);
  const [aiStatusChecked, setAIStatusChecked] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<QQTrack[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [searchPage, setSearchPage] = useState(1);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [activeQQTrack, setActiveQQTrack] = useState<QQTrack | null>(null);
  const [playQueue, setPlayQueue] = useState<QQTrack[]>([]);
  const [activeQueueIndex, setActiveQueueIndex] = useState(-1);
  const [playbackTime, setPlaybackTime] = useState({ current: 0, duration: 0 });
  const [playbackQuality, setPlaybackQuality] = useState("");
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([]);
  const lyricLinesLiveRef = useRef<{ trackId: string; lines: LyricLine[]; settled?: boolean; failed?: boolean }>({ trackId: "", lines: [] });
  const [currentCoverData, setCurrentCoverData] = useState("");
  const [matchedExperiments, setMatchedExperiments] = useState<Experiment[]>([]);
  const [visibleExperiments, setVisibleExperiments] = useState<Experiment[]>([]);
  const [recommendationTracks, setRecommendationTracks] = useState<Record<string, QQTrack>>({});
  const recommendationTracksRef = useRef<Record<string, QQTrack>>({});
  const [recommendationLoading, setRecommendationLoading] = useState({ match: false, frontier: false });
  const recommendationPoolsRef = useRef({ match: createRecommendationPool("match"), frontier: createRecommendationPool("frontier") });
  const recommendationCatalogRef = useRef<Experiment[]>(experimentPool);
  const queueExtensionPromiseRef = useRef<Promise<QQTrack[]> | null>(null);
  const recommendationScoresRef = useRef(new Map<string, RecommendationScore>());
  const recommendationAudioRef = useRef(new Map<string, Pick<TrackAnalysis, "bpm" | "tempoConfidence" | "outroFocus">>());
  const metadataEnrichmentRef = useRef({ active: 0, waiters: [] as Array<() => void>,
    pending: new Map<string, ReturnType<NonNullable<CodioDesktopBridge["qqMusic"]["metadata"]>>>() });
  const recommendationUpdateRef = useRef({ revision: 0, timer: null as number | null, triggers: new Set<string>(), startupReady: false, latest: {} as Record<string, unknown>, records: [] as Record<string, unknown>[] });
  const recommendationVisibleRef = useRef({ matched: matchedExperiments, frontier: visibleExperiments });
  const manualQueueIdsRef = useRef(new Set<string>());
  const recommendationRefreshRef = useRef<(trigger: "manual" | "feedback" | "sync", revision?: number, triggers?: string[], lane?: RecommendationLane) => Promise<Record<string, unknown>>>(async () => ({}));
  const [playedHistory, setPlayedHistory] = useState<PlayedTrack[]>([]);
  const [likedTracks, setLikedTracks] = useState<Set<string>>(new Set());
  const [dislikedTracks, setDislikedTracks] = useState<Set<string>>(new Set());
  const [, setTasteSignals] = useState<Array<Record<string, unknown>>>([]);
  const [listeningMemory, setListeningMemory] = useState<ListeningMemory>(() => createEmptyListeningMemory());
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [thinkingCue, setThinkingCue] = useState("等待 DeepSeek 响应");
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
  const [greetingVisible, setGreetingVisible] = useState(false);
  const [greetingAnswered, setGreetingAnswered] = useState(false);
  const [scene, setScene] = useState<Scene>("night");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [particleLevel, setParticleLevel] = useState(2);
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<"qq" | "local">("qq");
  const [localTracks, setLocalTracks] = useState<QQTrack[]>([]);
  const [localImportResult, setLocalImportResult] = useState({ imported: 0, duplicates: 0, failed: 0 });
  const [importState, setImportState] = useState<"idle" | "scanning" | "ready">("idle");
  const [qqConnection, setQQConnection] = useState<QQConnectionStatus>("checking");
  const [qqPlaybackReady, setQQPlaybackReady] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [onboardingFirstRun, setOnboardingFirstRun] = useState(false);
  const [onboardingQQSkipped, setOnboardingQQSkipped] = useState(false);
  const [onboardingDeepSeekSkipped, setOnboardingDeepSeekSkipped] = useState(false);
  const [qqSummary, setQQSummary] = useState({ playlists: 0, recent: 0 });
  const [qqTasteSnapshot, setQQTasteSnapshot] = useState<QQTasteSnapshot | null>(null);
  const [, setTasteTagWeights] = useState<Record<string, number>>({});
  const [tasteSyncing, setTasteSyncing] = useState(false);
  const qqTasteSnapshotRef = useRef<QQTasteSnapshot | null>(null);
  const qqSyncRevisionRef = useRef(0);
  const qqAuthorizationRevisionRef = useRef(0);
  const qqConnectionNoticeRef = useRef(false);
  const tasteTagWeightsRef = useRef<Record<string, number>>({});
  const discoveryPoolRef = useRef<Experiment[]>([]);
  const discoveryTracksRef = useRef<Record<string, QQTrack>>({});
  useEffect(() => () => {
    if (audioControlTimerRef.current !== null) window.clearTimeout(audioControlTimerRef.current);
    const update = recommendationUpdateRef.current;
    update.revision += 1;
    if (update.timer !== null) window.clearTimeout(update.timer);
  }, []);
  const [, setLikedExperiments] = useState<Set<string>>(new Set());
  const [timeContext, setTimeContext] = useState("");
  const [profileClock, setProfileClock] = useState(() => Date.now());
  const [weatherContext, setWeatherContext] = useState("Weather off");
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingEdge, setNowPlayingEdge] = useState<EdgeZone>(null);
  const [lyricMode, setLyricMode] = useState<LyricMode>("cinematic");
  const [visualMode, setVisualMode] = useState<VisualMode>("album");
  const [toast, setToast] = useState("");
  const [noticeTone, setNoticeTone] = useState<SystemNoticeTone>("listening");
  const [noticeDetail, setNoticeDetail] = useState("");
  const noticeTitleRef = useRef("");
  const [transitionDisplay, setTransitionDisplay] = useState<TransitionDisplay | null>(null);
  const weatherAutoStartedRef = useRef(false);
  const weatherSnapshotRef = useRef({ text: "", at: 0, revision: 0 });
  const [messages, setMessages] = useState<Message[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualActiveRef = useRef(true);
  const nowCanvasRef = useRef<HTMLCanvasElement>(null);
  const parallaxPointerRef = useRef({ clientX: 0, clientY: 0, frame: 0 });
  const progressWaveRef = useRef<HTMLCanvasElement>(null);
  const nowProgressWaveRef = useRef<HTMLCanvasElement>(null);
  const displayedWaveformRef = useRef<number[]>([]);
  const initialWaveformRef = useRef({ trackId: "", waveform: [] as number[] });
  const [waveformRevision, setWaveformRevision] = useState(0);
  const [bootWaveformError, setBootWaveformError] = useState(false);
  const progressValueRef = useRef(progress);
  const searchRequestRef = useRef(0);
  const conversationRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchShellRef = useRef<HTMLDivElement>(null);
  const nowStageRef = useRef<HTMLDivElement>(null);
  const nowPointerRef = useRef({
    x: 0, y: 0, visualX: 0, visualY: 0,
    rx: NOW_INITIAL_RX, ry: NOW_INITIAL_RY, zoom: 1,
    dragging: false, returning: false,
    velocityX: 0, velocityY: 0, velocityZoom: 0,
    startX: 0, startY: 0,
    lastReleaseAt: 0,
  });
  const edgeIntentRef = useRef<{ zone: EdgeZone; timer: number | null }>({ zone: null, timer: null });
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const musicMasterRef = useRef<MusicMasterChain | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const frequencyDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const analysedAudioRef = useRef<HTMLAudioElement | null>(null);
  const analyserNodesRef = useRef(new WeakMap<HTMLAudioElement, MusicAudioChain>());
  const audioElementsRef = useRef(new Set<HTMLAudioElement>());
  const seamlessTransitionRef = useRef(false);
  const playbackFadeRef = useRef(0);
  const playbackFadeCancelRef = useRef<(() => void) | null>(null);
  const playbackToggleRef = useRef({ revision: 0, pending: false });
  useEffect(() => () => {
    playbackToggleRef.current.revision += 1;
    playbackFadeCancelRef.current?.();
    playbackFadeRef.current += 1;
  }, []);
  const trackAnalysisRef = useRef(new Map<string, TrackAnalysis>());
  const analysisPromiseRef = useRef(new Map<string, Promise<TrackAnalysis | null>>());
  const analysisSourceRef = useRef(new Map<string, { url: string; signature: string; duration: number }>());
  const analysisLifecycleRef = useRef({ mounted: true, generation: 0 });
  const analysisRequestsRef = useRef(new Map<string, { controller: AbortController; timer: number | null }>());
  const analysisBufferWaitRef = useRef(new Map<string, { audio: HTMLAudioElement; url: string; promise: Promise<TrackAnalysis | null>; cancel: () => void }>());
  const analysisWorkerRef = useRef<Worker | null>(null);
  const analysisWorkerPendingRef = useRef(new Map<string, { resolve: (analysis: TrackAnalysis | null) => void; timer: number }>());
  const transitionPlansRef = useRef(new Map<string, TransitionPlan>());
  const activeTransitionRef = useRef<TransitionRuntime | null>(null);
  const pendingTransitionAudioRef = useRef<{ requestId: number; audio: HTMLAudioElement } | null>(null);
  const transitionVisualFrameRef = useRef<TransitionVisualFrame | null>(null);
  const transitionCoordinatorRef = useRef<number | null>(null);
  const transitionSequenceRef = useRef(0);
  const transitionRequestRef = useRef(0);
  const audioControlTimerRef = useRef<number | null>(null);
  const preparedTracksRef = useRef(new Map<string, { createdAt: number; expiresAt?: number; authorizationRevision?: number; promise: Promise<PreparedTrack | null> }>());
  const preparedDeckTrackRef = useRef("");
  const bufferedSourcesRef = useRef(new Map<string, { source: string; url: string; bytes: number; at: number; expiresAt: number }>());
  const sourceWarmRef = useRef<{ revision: number; controller: AbortController | null }>({ revision: 0, controller: null });
  const playbackRequestRef = useRef<{ id: string; at: number } | null>(null);
  const previousCoverPointsRef = useRef<CoverPoint[]>([]);
  const previousCoverSourceRef = useRef("");
  const coverPointPromisesRef = useRef(new Map<string, Promise<CoverPoint[]>>());
  const coverPointCloudsRef = useRef(new Map<string, CoverPoint[]>());
  const coverPointPairsRef = useRef(new Map<string, CoverPointPair[]>());
  const particleRenderStridesRef = useRef(new Map<string, number>());
  const activeQQTrackLiveRef = useRef<QQTrack | null>(null);
  const currentCoverDataLiveRef = useRef("");
  const currentTrackCoverLiveRef = useRef("");
  const reducedMotionLiveRef = useRef(false);
  const initialRecommendationRef = useRef(false);
  const recoveringTrackRef = useRef<string | null>(null);
  const seamlessAttemptedRef = useRef<string | null>(null);
  const pendingAdvanceRef = useRef(false);
  const userPausedRef = useRef(false);
  const manualSelectionRef = useRef<string | null>(null);
  const advancingRef = useRef(false);
  const startingTrackRef = useRef<string | null>(null);
  const failedTracksRef = useRef(new Map<string, number>());
  const dislikeAdvanceTrackRef = useRef("");
  const playQueueRef = useRef<QQTrack[]>([]);
  const activeQueueIndexRef = useRef(-1);
  const seamlessRef = useRef(seamless);
  const volumeRef = useRef(volume);
  const systemVolumeRef = useRef<SystemVolumeStatus>({ available: false, volume: null, muted: false });
  const systemVolumeRequestRef = useRef(0);
  const systemVolumePendingRef = useRef(0);
  const messageId = useRef(1);
  const listeningMemoryRef = useRef(listeningMemory);
  const listeningMemoryHydratedRef = useRef(false);
  const listeningSessionRef = useRef<{ session: ListeningSession; track: QQTrack; source: PlaySettledEvent["source"]; stalled: boolean } | null>(null);

  const currentTrack = activeQQTrack ? {
    ...activeQQTrack,
    note: activeQQTrack.album || "QQ Music",
    lyric: activeQQTrack.album || playbackQuality || "QQ Music",
    duration: activeQQTrack.durationSeconds > 0
      ? `${Math.floor(activeQQTrack.durationSeconds / 60)}:${String(activeQQTrack.durationSeconds % 60).padStart(2, "0")}`
      : "--:--",
    color: "violet",
    bpm: 96,
  } : tracks[trackIndex];
  const titleSizeFor = (title: string) => {
    const units = [...title].reduce((total, character) => total + (/[^\u0000-\u00ff]/.test(character) ? 1 : .56), 0);
    return units > 34 ? "extra-long" : units > 24 ? "long" : units > 14 ? "medium" : "short";
  };
  const atmosphereTitleSize = titleSizeFor(currentTrack.title);
  const currentTempo = trackAnalysisRef.current.get(activeQQTrack?.mid || "");
  const currentBpm = currentTempo && currentTempo.tempoConfidence >= .5 ? Math.round(currentTempo.bpm) : "—";
  const lyricClock = activeQQTrack ? playbackTime.current : 0;
  const activeLyricIndex = lyricLines.length
    ? lyricLines.reduce((selected, line, index) => line.time <= lyricClock ? index : selected, -1)
    : -1;
  const activeLyric = lyricLines[activeLyricIndex]?.text || "";
  const displayedLyrics = lyricLines.length ? lyricLines : [{ time: 0, text: activeQQTrack
    ? lyricLinesLiveRef.current.failed ? "Lyrics could not be loaded" : lyricLinesLiveRef.current.settled ? "Lyrics unavailable" : "Loading lyrics…"
    : currentTrack.lyric || "No track selected" }];
  const displayedLyricIndex = lyricLines.length ? activeLyricIndex : 0;
  const currentPreferenceKey = activeQQTrack ? canonicalTrackKey(activeQQTrack.provider || "qq", activeQQTrack.mid) : canonicalTrackKey("local", currentTrack.title);
  const nextQueuedTrack = playQueue.length > 1 && activeQueueIndex >= 0 && activeQueueIndex < playQueue.length - 1
    ? playQueue[activeQueueIndex + 1]
    : null;
  const nowPlayingQueue = activeQQTrack && playQueue.length ? playQueue : tracks;
  const djLibraryCount = qqTasteSnapshot?.tracks.length || qqSummary.recent;
  const derivedProfile = useMemo(() => deriveListeningProfile(listeningMemory, Math.max(profileClock, listeningMemory.updatedAt)), [listeningMemory, profileClock]);
  const listeningPresentation = useMemo(() => buildListeningPresentation(listeningMemory, derivedProfile, {
    now: Math.max(profileClock, listeningMemory.updatedAt),
    recommendationUpdate: recommendationLoading.match || recommendationLoading.frontier
      ? { ...recommendationUpdateRef.current.latest, status: "running" } : recommendationUpdateRef.current.latest,
  }), [listeningMemory, derivedProfile, profileClock, recommendationLoading]);
  const evidenceTime = (at: number) => at > 0 ? new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "等待第一条有效证据";
  const tasteLeaders = useMemo(() => {
    return Object.entries(derivedProfile.lifetimeProfile.tagAffinities).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [derivedProfile]);
  const momentContext = (() => {
    return timeContext || "Reading local time…";
  })();
  const profileFeedback = (limit = 8) => <div className="profile-feedback-list">
    {listeningPresentation.recentFeedback.slice(0, limit).map((row) => <div className="profile-feedback-row" key={row.eventId} data-event-id={row.eventId} data-state={row.state}>
      <div><strong>{row.title}</strong><span>{row.artist}{row.artist ? " / " : ""}{row.actionLabel}</span><small>{row.sourceLabel} / {row.scopeLabel} / {evidenceTime(row.createdAt)}</small></div>
      {row.active ? <button onClick={() => {
        const preference = activePreferences(listeningMemoryRef.current).find(item => item.eventId === row.eventId);
        if (preference) withdrawPreference(preference);
      }}>撤回</button> : <em>{row.state === "withdrawn" ? "已撤回" : row.state === "superseded" ? "已替换" : "已到期"}</em>}
    </div>)}
    {!listeningPresentation.recentFeedback.length && <p className="profile-empty-note">还没有明确偏好。播放栏的喜欢／少听，和你向 DJ 明确表达的偏好，都会记在这里。</p>}
  </div>;

  useEffect(() => {
    let disposed = false;
    if (!activeQQTrack) {
      const lines = [{ time: 0, text: tracks[trackIndex].lyric }];
      lyricLinesLiveRef.current = { trackId: `demo:${trackIndex}`, lines };
      setLyricLines(lines);
      return () => { disposed = true; };
    }
    if (lyricLinesLiveRef.current.trackId === activeQQTrack.mid && lyricLinesLiveRef.current.lines.length) {
      setLyricLines(lyricLinesLiveRef.current.lines);
      return () => { disposed = true; };
    }
    lyricLinesLiveRef.current = { trackId: activeQQTrack.mid, lines: [] };
    const lyrics = activeQQTrack.provider === "local" ? undefined : window.codioDesktop?.qqMusic.lyrics;
    if (!lyrics) {
      lyricLinesLiveRef.current = { trackId: activeQQTrack.mid, lines: [], settled: true };
      setLyricLines([]);
      return () => { disposed = true; };
    }
    setLyricLines([]);
    const controller = new AbortController();
    let requesting = false;
    const retry = () => {
      if (requesting || disposed) return;
      requesting = true;
      void loadLyricsWithRetry(() => withTimeout(lyrics(activeQQTrack), 8000, "LYRICS_REQUEST"), controller.signal).then(result => {
        if (disposed || controller.signal.aborted) return;
        lyricLinesLiveRef.current = { trackId: activeQQTrack.mid, lines: result.lines, settled: true, failed: result.status === "failed" };
        setLyricLines(result.lines);
        if (result.status === "failed") notifySystem("歌词请求暂未成功", "warning", "有限重试已结束；连接恢复后按需重试，不会影响播放");
        else if (result.status === "unavailable") notifySystem("未提供时间轴歌词", "warning", "不据此判断这首歌是纯音乐");
      }).finally(() => { requesting = false; });
    };
    retry(); window.addEventListener("online", retry);
    return () => { disposed = true; controller.abort(); window.removeEventListener("online", retry); };
  }, [activeQQTrack, qqConnection, trackIndex]);

  useEffect(() => {
    const reduce = reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setBootAnimationDone(true); return; }
    const doneTimer = window.setTimeout(() => {
      setBootAnimationDone(true);
    }, 3060);
    return () => {
      window.clearTimeout(doneTimer);
    };
  }, [reducedMotion]);

  useEffect(() => {
    let disposed = false;
    let completed = 0;
    setBootAssetsReady(false);
    setBootAssetCompleted(0);
    const image = new Image(); image.src = "/codio-orb.webp";
    const fallbackImage = new Image(); fallbackImage.src = coverFallback;
    void Promise.all([
      withTimeout(document.fonts.ready, 5000, "BOOT_FONTS"),
      withTimeout(image.decode(), 5000, "BOOT_ORB"),
      withTimeout(fallbackImage.decode(), 5000, "BOOT_COVER_FALLBACK"),
    ].map(async task => {
      await task;
      if (!disposed) setBootAssetCompleted(++completed);
    })).then(() => {
      if (!disposed) { setBootResourceError(false); setBootAssetsReady(true); }
    }).catch(() => { if (!disposed) setBootResourceError(true); });
    return () => { disposed = true; };
  }, [bootAssetAttempt]);

  useEffect(() => {
    const ai = window.codioDesktop?.ai;
    if (!ai) {
      setModelConfigured(false);
      setAIStatusChecked(true);
      return;
    }
    let disposed = false;
    const refresh = () => void withTimeout(ai.getStatus(), 6000, "BOOT_AI_STATUS").then((status) => {
      if (disposed) return;
      setModelConfigured(status.configured);
      setAIStatusChecked(true);
      if (status.configured) setOnboardingDeepSeekSkipped(false);
    }).catch(() => {
      if (!disposed) {
        setModelConfigured(false);
        setAIStatusChecked(true);
      }
    });
    refresh();
    const timer = window.setInterval(refresh, 8000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const local = readCodioOnboarding(window.localStorage);
      const onboarding = window.codioDesktop?.onboarding
        ? await withTimeout(window.codioDesktop.onboarding.get(), 6000, "BOOT_ONBOARDING").catch(() => local)
        : local;
      if (!disposed) {
        setOnboardingQQSkipped(onboarding.qqSkipped);
        setOnboardingDeepSeekSkipped(onboarding.deepSeekSkipped);
        setOnboardingChecked(true);
      }
      if (disposed || onboarding.completed) return;
      setOnboardingFirstRun(true);
      setOnboardingOpen(true);
      setOnboardingQQSkipped(onboarding.qqSkipped);
      setOnboardingDeepSeekSkipped(onboarding.deepSeekSkipped);
    })();
    return () => { disposed = true; };
  }, []);

  const filteredTracks = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return tracks.slice(0, 3);
    return tracks.filter((track) =>
      `${track.title} ${track.artist} ${track.note}`.toLowerCase().includes(needle),
    );
  }, [searchQuery]);

  function bootSourcesUnavailable() {
    const update = recommendationUpdateRef.current;
    return update.records.slice(-2).some(record => record.evidenceRevision === update.revision
      && Number(record.candidateCount) > 0 && Number(record.checkedCandidateCount) > 0 && record.playableCandidateCount === 0);
  }

  const homePreparedForBoot = useCallback(() => {
    if (!bootAnimationDone || !bootAssetsReady || !bootHomeFrameReady || !listeningMemoryHydratedRef.current || !onboardingChecked || !aiStatusChecked) return false;
    if (["checking", "syncing", "authorizing", "error"].includes(qqConnection)) return false;
    if (tasteSyncing || recommendationLoading.match || recommendationLoading.frontier) return false;
    // An unavailable connection is a real homepage state, not a login barrier
    // on the opening screen. Connected listeners wait for the actual full batch.
    if (qqConnection !== "connected") return true;
    const update = recommendationUpdateRef.current;
    // The coalescing window is real pending work, even before either lane sets
    // its loading flag. Entry must use the latest evidence, not the prior batch.
    if (!qqPlaybackReady || update.timer !== null || update.triggers.size > 0
      || update.latest.status === "queued" || update.latest.status === "running") return false;
    if (matchedExperiments.length !== 12 || visibleExperiments.length !== 12) return false;
    if (!activeQQTrack || lyricLinesLiveRef.current.trackId !== activeQQTrack.mid
      || (!lyricLinesLiveRef.current.settled && (!lyricLines.length || !lyricLinesLiveRef.current.lines.length))) return false;
    if (initialWaveformRef.current.trackId !== activeQQTrack.mid || initialWaveformRef.current.waveform.length < 32) return false;
    const shown = [...matchedExperiments, ...visibleExperiments];
    return new Set(shown.map(recommendationIdentity)).size === 24 && shown.every(item => {
      const track = recommendationTracksRef.current[recommendationIdentity(item)];
      const prepared = track && preparedTracksRef.current.get(track.mid);
      return Boolean(prepared && typeof prepared.expiresAt === "number" && Date.now() < prepared.expiresAt);
    });
  }, [bootAnimationDone, bootAssetsReady, bootHomeFrameReady, onboardingChecked, aiStatusChecked, qqConnection, qqPlaybackReady,
    tasteSyncing, recommendationLoading, matchedExperiments, visibleExperiments, activeQQTrack, lyricLines]);

  const homeViewReadyForBoot = useCallback(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>(".topbar img,.boot-lockup img,.dashboard img,.boundary-section img,.player-bar img")];
    const mounted = [".topbar", ".dashboard", ".player-bar"].every(selector => {
      const bounds = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
    });
    const completeCards = qqConnection !== "connected" || [".match-section", ".boundary-section:not(.match-section)"].every(selector =>
      document.querySelectorAll(`${selector} .experiment-card.playable`).length === 12);
    return mounted && completeCards && images.every(image => image.complete && image.naturalWidth > 0);
  }, [qqConnection]);
  bootEntryCheckRef.current = () => homePreparedForBoot() && homeViewReadyForBoot();

  useEffect(() => {
    if (bootPhase !== "playing") return;
    if (!homePreparedForBoot()) { if (bootReady) setBootReady(false); if (bootPainting) setBootPainting(false); return; }
    if (!bootPainting) { setBootPainting(true); return; }
    if (bootReady) {
      if (homeViewReadyForBoot()) return;
      setBootReady(false); setBootLayoutReady(false);
    }
    let disposed = false;
    // Decode the actual homepage artwork before revealing it, after the full
    // playable batch has been committed. Missing remote artwork uses the local fallback.
    void Promise.all([...document.querySelectorAll<HTMLImageElement>(".topbar img,.boot-lockup img,.dashboard img,.boundary-section img,.player-bar img")].map(async image => {
      for (let attempt = 0; attempt < 3 && !disposed; attempt += 1) {
        const source = image.src;
        if (image.complete && image.naturalWidth > 0) return;
        try { await withTimeout(image.decode(), 3500, "BOOT_VISIBLE_IMAGE"); }
        catch { /* SafeRecommendationCover switches to its local fallback. */ }
        if (image.src === source && image.complete && image.naturalWidth > 0) return;
        await new Promise<void>(resolve => window.setTimeout(resolve, 60));
      }
      if (!disposed) throw new Error("BOOT_VISIBLE_IMAGE_NOT_READY");
    })).then(() => {
      if (!disposed) window.requestAnimationFrame(() => {
        if (disposed) return;
        window.requestAnimationFrame(() => {
        if (disposed || !homePreparedForBoot()) return;
        if (!homeViewReadyForBoot()) { setBootResourceError(true); return; }
        setBootLayoutReady(true); setBootResourceError(false); setBootReady(true);
        });
      });
    }).catch(() => {
      if (!disposed) { setBootReady(false); setBootResourceError(true); }
    });
    return () => { disposed = true; };
  }, [bootPhase, bootReady, bootPainting, homePreparedForBoot, homeViewReadyForBoot, bootAssetAttempt, bootPreparedSources, currentCoverData, waveformRevision]);

  useEffect(() => {
    if (bootPhase !== "playing" || !bootReady || !rootRef.current) return;
    const invalidateArtwork = () => {
      if (!homeViewReadyForBoot()) { setBootReady(false); setBootLayoutReady(false); }
    };
    const observer = new MutationObserver(invalidateArtwork);
    observer.observe(rootRef.current, { subtree: true, attributes: true, attributeFilter: ["src"] });
    invalidateArtwork();
    return () => observer.disconnect();
  }, [bootPhase, bootReady, homeViewReadyForBoot]);

  useEffect(() => {
    if (qqConnection !== "connected" || tasteSyncing
      || recommendationLoading.match || recommendationLoading.frontier || recommendationUpdateRef.current.timer !== null) return;
    // More search pages cannot repair a batch whose sources all failed.
    if (bootSourcesUnavailable()) return;
    const missing = matchedExperiments.length < 12 || visibleExperiments.length < 12;
    const terminal = Object.values(recommendationPoolsRef.current).every(pool => ["failed", "insufficient_candidates", "completed"].includes(pool.status));
    if (missing && terminal && bootRetryRef.current < 3) {
      bootRetryRef.current += 1;
      // Existing per-pool cursor expansion; never replaces already visible cards.
      requestRecommendationUpdate("continuation");
    }
  }, [qqConnection, tasteSyncing, recommendationLoading, matchedExperiments, visibleExperiments]);

  useEffect(() => {
    const saved = window.localStorage.getItem("tide-preferences");
    if (saved) {
      try {
        const preferences = JSON.parse(saved) as {
          scene?: Scene;
          reducedMotion?: boolean;
          particleLevel?: number;
          seamless?: boolean;
          visualMode?: VisualMode;
        };
        if (preferences.scene) setScene(preferences.scene);
        if (typeof preferences.reducedMotion === "boolean") setReducedMotion(preferences.reducedMotion);
        if (typeof preferences.particleLevel === "number") setParticleLevel(preferences.particleLevel);
        if (typeof preferences.seamless === "boolean") setSeamless(preferences.seamless);
        if (preferences.visualMode === "album") setVisualMode("album");
      } catch {
        // Keep calm defaults if a stale preference cannot be read.
      }
    }

    try {
      const history = JSON.parse(window.localStorage.getItem("codio-played-history") || "[]") as PlayedTrack[];
      setPlayedHistory(history.slice(-5));
      const signals = JSON.parse(window.localStorage.getItem("codio-taste-signals") || "[]") as Array<Record<string, unknown>>;
      setTasteSignals(signals);
      setLikedTracks(new Set(signals.filter((signal) => signal.type === "playback_like").map((signal) => String(signal.id || signal.title || ""))));
      setDislikedTracks(new Set(signals.filter((signal) => signal.type === "playback_dislike").map((signal) => String(signal.id || signal.title || ""))));
      setRecentSearches((JSON.parse(window.localStorage.getItem("codio-search-history") || "[]") as string[]).filter(Boolean).slice(0, 8));
      const migratedMemory = loadListeningMemory(window.localStorage);
      listeningMemoryRef.current = migratedMemory;
      listeningMemoryHydratedRef.current = true;
      setListeningMemory(migratedMemory);
      saveListeningMemory(window.localStorage, migratedMemory);
    } catch {
      // A stale listening history should never hold up the radio.
      listeningMemoryHydratedRef.current = true;
    }

    if (!window.sessionStorage.getItem("tide-dj-welcomed")) {
      const reveal = window.setTimeout(() => {
        setGreetingVisible(true);
        setMessages([
          {
            id: messageId.current++,
            from: "dj",
            text: "晚上好。今天想让音乐抱住你，还是带你离开一会儿？",
          },
        ]);
        window.sessionStorage.setItem("tide-dj-welcomed", "true");
      }, 900);
      const soften = window.setTimeout(() => setGreetingVisible(false), 14000);
      return () => {
        window.clearTimeout(reveal);
        window.clearTimeout(soften);
      };
    }
  }, []);

  useEffect(() => {
    listeningMemoryRef.current = listeningMemory;
    if (listeningMemoryHydratedRef.current) saveListeningMemory(window.localStorage, listeningMemory);
    const preferences = activePreferences(listeningMemory);
    setLikedTracks(new Set(preferences.filter((item) => item.targetType === "track" && item.value === "more").map((item) => item.targetKey)));
    setDislikedTracks(new Set(preferences.filter((item) => item.targetType === "track" && item.value === "less").map((item) => item.targetKey)));
    setLikedExperiments(new Set(preferences.filter((item) => item.targetType === "track" && item.value === "more" && item.title).map((item) => item.title!)));
  }, [listeningMemory]);

  useEffect(() => {
    window.localStorage.setItem(
      "tide-preferences",
      JSON.stringify({ scene, reducedMotion, particleLevel, seamless, visualMode }),
    );
  }, [scene, reducedMotion, particleLevel, seamless, visualMode]);

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setProfileClock(now.getTime());
      const hour = now.getHours();
      const period = hour < 6 ? "Late night" : hour < 11 ? "Morning" : hour < 17 ? "Afternoon" : hour < 22 ? "Evening" : "Late night";
      setTimeContext(`${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · ${period}`);
    };
    updateClock();
    const clock = window.setInterval(updateClock, 60000);
    return () => window.clearInterval(clock);
  }, []);

  const learningContextRef = useRef("");
  useEffect(() => {
    const hour = new Date().getHours();
    const bucket = hour < 7 ? "late-night" : hour < 12 ? "morning" : hour < 18 ? "day" : "evening";
    const reliableWeather = /^(Clear|Cloudy|Rain) · -?\d+°C$/.test(weatherContext) ? weatherContext : "unknown";
    const key = `${bucket}|${reliableWeather}`;
    // Keep the newest real context visible, without invalidating the full
    // startup batch while it is being checked. Leaving the previous key here
    // makes entry schedule one hidden-queue update, not a second cold startup.
    if (learningContextRef.current && learningContextRef.current !== key && bootPhase !== "done") return;
    if (learningContextRef.current && learningContextRef.current !== key) requestRecommendationUpdate("context_changed");
    learningContextRef.current = key;
  }, [timeContext, weatherContext, bootPhase]);

  useEffect(() => {
    const now = Date.now();
    const expiry = Math.min(...[
      listeningMemory.sessionIntent?.expiresAt || Infinity,
      ...activePreferences(listeningMemory, now).filter((item) => item.scope === "session").map((item) => item.createdAt + 18 * 60 * 60 * 1000),
    ].filter((value) => value > now));
    if (!Number.isFinite(expiry)) return;
    const timer = window.setTimeout(() => {
      setListeningMemory({ ...listeningMemoryRef.current });
      requestRecommendationUpdate("temporary_intent_expired");
    }, expiry - now + 10);
    return () => window.clearTimeout(timer);
  }, [listeningMemory]);

  const applySystemVolumeStatus = useCallback((status: SystemVolumeStatus): boolean => {
    if (!status || typeof status.available !== "boolean" || typeof status.muted !== "boolean") return false;
    const before = systemVolumeRef.current;
    if (status.revision !== undefined && (!Number.isSafeInteger(status.revision) || status.revision < (before.revision ?? 0))) return false;
    if (!status.available) {
      // A transient native failure must not add a second player-volume layer.
      if (!before.available) { systemVolumeRef.current = status; setSystemVolume(status); }
      return false;
    }
    if (typeof status.volume !== "number" || !Number.isFinite(status.volume) || status.volume < 0 || status.volume > 100) return false;
    systemVolumeRef.current = status;
    setSystemVolume(status);
    if (systemVolumePendingRef.current) return true;
    volumeRef.current = status.volume;
    setVolume(status.volume);
    return true;
  }, []);

  useEffect(() => {
    const bridge = window.codioDesktop?.systemVolume;
    if (!bridge) return;
    let disposed = false;
    const initialRevision = systemVolumeRequestRef.current;
    const unsubscribe = bridge.subscribe((status) => { if (!disposed) applySystemVolumeStatus(status); });
    void bridge.getStatus().then((status) => {
      if (!disposed && systemVolumeRequestRef.current === initialRevision) applySystemVolumeStatus(status);
    }).catch(() => {
      if (!disposed && systemVolumeRequestRef.current === initialRevision)
        applySystemVolumeStatus({ available: false, volume: null, muted: false, error: "SYSTEM_VOLUME_UNAVAILABLE" });
    });
    return () => {
      disposed = true;
      unsubscribe();
      systemVolumeRequestRef.current += 1;
      systemVolumePendingRef.current = 0;
    };
  }, [applySystemVolumeStatus]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    const context = audioContextRef.current;
    const master = musicMasterRef.current;
    const scalar = systemVolume?.available ? 1 : volume / 100;
    if (context && master) {
      const now = context.currentTime;
      master.gain.gain.cancelScheduledValues(now);
      master.gain.gain.setTargetAtTime(scalar * .82, now, .035);
    } else if (audio) audio.volume = scalar;
    volumeRef.current = volume;
  }, [volume, systemVolume]);

  useEffect(() => { seamlessRef.current = seamless; }, [seamless]);
  useEffect(() => { playQueueRef.current = playQueue; }, [playQueue]);
  useEffect(() => { activeQueueIndexRef.current = activeQueueIndex; }, [activeQueueIndex]);
  useEffect(() => { progressValueRef.current = progress; }, [progress]);
  useEffect(() => { activeQQTrackLiveRef.current = activeQQTrack; }, [activeQQTrack]);
  useEffect(() => { currentCoverDataLiveRef.current = currentCoverData; }, [currentCoverData]);
  useEffect(() => { currentTrackCoverLiveRef.current = currentTrack.cover || ""; }, [currentTrack.cover]);
  useEffect(() => { reducedMotionLiveRef.current = reducedMotion; }, [reducedMotion]);
  useEffect(() => {
    rootRef.current?.setAttribute("data-render-tier", hasAcceleratedWebGl() ? "gpu" : "software");
  }, []);

  const transitionDisplayId = transitionDisplay?.id;
  useEffect(() => {
    if (!transitionDisplayId) return;
    const update = () => {
      if (!visualActiveRef.current) return;
      const runtime = activeTransitionRef.current;
      if (!runtime || runtime.id !== transitionDisplayId) return;
      const outgoingLyric = lyricAtTime(runtime.outgoingSnapshot.lyrics, getAudiblePlaybackTime(runtime.outgoing));
      const incomingLyric = lyricAtTime(runtime.incomingSnapshot.lyrics, getAudiblePlaybackTime(runtime.incoming));
      setTransitionDisplay((current) => current && current.id === runtime.id
        && (current.outgoing !== runtime.outgoingSnapshot || current.incoming !== runtime.incomingSnapshot
          || current.outgoingLyric !== outgoingLyric || current.incomingLyric !== incomingLyric)
        ? { ...current, outgoing: runtime.outgoingSnapshot, incoming: runtime.incomingSnapshot, outgoingLyric, incomingLyric } : current);
    };
    update();
    const timer = window.setInterval(update, 90);
    return () => window.clearInterval(timer);
  }, [transitionDisplayId]);

  useEffect(() => {
    const lifecycle = analysisLifecycleRef.current;
    const requests = analysisRequestsRef.current;
    const promises = analysisPromiseRef.current;
    const bufferWaits = analysisBufferWaitRef.current;
    const warming = sourceWarmRef.current;
    const sources = bufferedSourcesRef.current;
    const workerPending = analysisWorkerPendingRef.current;
    const audioElements = audioElementsRef.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation += 1;
      for (const request of requests.values()) {
        request.controller.abort();
        if (request.timer !== null) window.clearTimeout(request.timer);
      }
      requests.clear();
      promises.clear();
      for (const wait of bufferWaits.values()) wait.cancel();
      bufferWaits.clear();
      warming.controller?.abort();
      warming.revision += 1;
      for (const source of sources.values()) URL.revokeObjectURL(source.url);
      sources.clear();
      for (const audio of audioElements) releaseMusicAudio(audio);
      audioElements.clear();
      void audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
      musicMasterRef.current = null;
      analysisWorkerRef.current?.terminate();
      analysisWorkerRef.current = null;
      for (const pending of workerPending.values()) {
        window.clearTimeout(pending.timer);
        pending.resolve(null);
      }
      workerPending.clear();
    };
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    const requestId = ++searchRequestRef.current;
    if (!query) {
      setSearchResults([]);
      setSearchStatus("idle");
      setSearchPage(1);
      setSearchHasMore(false);
      return;
    }
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop) {
      setSearchResults([]);
      setSearchStatus("ready");
      return;
    }
    let cancelled = false;
    setSearchResults([]);
    setSearchStatus("loading");
    const timer = window.setTimeout(async () => {
      try {
        const results = await withTimeout(desktop.search(query, 1), 10000, "SEARCH_INITIAL");
        if (!cancelled && searchRequestRef.current === requestId) {
          const uniqueResults = [...new Map(results.map((track) => [
            recommendationIdentity(track),
            track,
          ])).values()];
          setSearchResults(uniqueResults);
          setSearchPage(1);
          setSearchHasMore(results.length >= 20);
          setSearchStatus("ready");
        }
      } catch {
        if (!cancelled && searchRequestRef.current === requestId) setSearchStatus("error");
      }
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  const loadMoreSearchResults = async () => {
    const query = searchQuery.trim();
    const desktop = window.codioDesktop?.qqMusic;
    if (!query || !desktop || searchLoadingMore || !searchHasMore || searchStatus !== "ready") return;
    const nextPage = searchPage + 1;
    setSearchLoadingMore(true);
    try {
      const results = await withTimeout(desktop.search(query, nextPage), 10000, "SEARCH_MORE");
      if (searchQuery.trim() !== query) return;
      const existingKeys = new Set(searchResults.map(recommendationIdentity));
      const newUniqueCount = results.filter((track) => !existingKeys.has(recommendationIdentity(track))).length;
      setSearchResults((current) => {
        const merged = new Map(current.map((track) => [recommendationIdentity(track), track]));
        results.forEach((track) => merged.set(recommendationIdentity(track), track));
        return [...merged.values()];
      });
      setSearchPage(nextPage);
      setSearchHasMore(results.length >= 20 && newUniqueCount > 0 && nextPage < 20);
    } catch {
      setSearchHasMore(false);
    } finally {
      setSearchLoadingMore(false);
    }
  };

  function rememberSearch(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query) return;
    setRecentSearches((current) => {
      const next = [query, ...current.filter((item) => item.toLocaleLowerCase() !== query.toLocaleLowerCase())].slice(0, 8);
      window.localStorage.setItem("codio-search-history", JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    // Initial fill uses the same checked/scored/committed path as later updates.
    requestRecommendationUpdate("initial");
  }, []);

  useEffect(() => {
    // Do not start a cold catalogue scan while QQ/library restoration is still
    // changing the evidence. A failed library attempt also settles this gate.
    if (recommendationUpdateRef.current.startupReady) return;
    if (!onboardingChecked || !listeningMemoryHydratedRef.current || qqConnection !== "connected" || tasteSyncing
      || (window.codioDesktop?.qqMusic && qqSyncRevisionRef.current === 0)) return;
    releaseStartupRecommendations();
  }); // One-shot ref guard also observes hydration refs without another timer.

  async function resolveTrackCover(track: QQTrack, desktop: CodioDesktopBridge["qqMusic"]) {
    const sources = [...new Set([
      track.cover,
      track.albumMid ? qqCoverUrl(track.albumMid) : "",
      track.fallbackCover,
    ].filter(Boolean) as string[])];
    for (const source of sources) {
      if (source.startsWith("data:")) return source;
      const resolved = await desktop.cover(source).catch(() => "");
      if (resolved) return resolved;
    }
    return sources[0] || coverFallback;
  }

  useEffect(() => {
    if (initialRecommendationRef.current || activeQQTrack) return;
    const first = matchedExperiments.map((item) => recommendationTracks[recommendationIdentity(item)]).find(Boolean);
    if (!first) return;
    initialRecommendationRef.current = true;
    const queue = recommendationQueueFor(first);
    const index = Math.max(0, queue.findIndex((item) => item.mid === first.mid));
    setActiveQQTrack(first);
    setPlayQueue(queue);
    playQueueRef.current = queue;
    setActiveQueueIndex(index);
    activeQueueIndexRef.current = index;
    setCurrentCoverData(first.cover || "");
    setPlaybackTime({ current: 0, duration: first.durationSeconds });
    setProgress(0);
    setIsPlaying(false);
    void prepareTrack(first, true);
  }, [activeQQTrack, matchedExperiments, recommendationTracks]);

  const prepareInitialWaveformRef = useRef(prepareInitialWaveform);
  prepareInitialWaveformRef.current = prepareInitialWaveform;
  useEffect(() => {
    if (bootPhase !== "playing" || !activeQQTrack || initialWaveformRef.current.trackId === activeQQTrack.mid) return;
    let disposed = false;
    setBootWaveformError(false);
    void withTimeout(prepareInitialWaveformRef.current(activeQQTrack), 32000, "INITIAL_WAVEFORM").then(waveform => {
      if (disposed) return;
      if (!waveform) { setBootWaveformError(true); return; }
      initialWaveformRef.current = { trackId: activeQQTrack.mid, waveform };
      displayedWaveformRef.current = [];
      setWaveformRevision(revision => revision + 1);
    }).catch(() => { if (!disposed) setBootWaveformError(true); });
    return () => { disposed = true; };
  }, [activeQQTrack, bootPhase, bootAssetAttempt]);

  useEffect(() => {
    const tracksToWarm = [...matchedExperiments, ...visibleExperiments]
      .map((item) => recommendationTracks[recommendationIdentity(item)])
      .filter((track): track is QQTrack => Boolean(track));
    let cancelled = false;
    // Resolve all 24 playback URLs and covers ahead of time, but keep only the
    // actual next deck buffered as media. Holding 24 auto-buffering audio
    // elements was the main source of long-session memory and decoder pressure.
    let cursor = 0;
    if (bootPhase === "playing") setBootSourceError(false);
    void Promise.all(Array.from({ length: 2 }, async () => {
      while (!cancelled && cursor < tracksToWarm.length) {
        const track = tracksToWarm[cursor++];
        await withTimeout(prepareTrack(track, false), 6500, "VISIBLE_SOURCE_PREPARATION").catch(() => null);
      }
    })).then(() => {
      if (!cancelled && bootPhase === "playing") {
        const checked = tracksToWarm.filter(track => {
          const entry = preparedTracksRef.current.get(track.mid);
          return entry && typeof entry.expiresAt === "number" && Date.now() < entry.expiresAt;
        });
        setBootPreparedSources(previous => new Set([...previous, ...checked.map(recommendationIdentity)]));
        setBootSourceError(checked.length !== tracksToWarm.length);
      }
      if (!cancelled && bootPhase === "done") {
        prepareUpcomingTrack(activeQQTrack?.mid || tracksToWarm[0]?.mid || "");
        // Full bytes are bounded to six sources / 24 MiB, not 24 Audio decoders.
        if (!musicAudioRef.current || musicAudioRef.current.paused) void warmRecommendationSources(tracksToWarm);
      }
    });
    return () => { cancelled = true; };
  }, [matchedExperiments, visibleExperiments, recommendationTracks, bootPhase, bootAssetAttempt]);

  useEffect(() => {
    if (!nowPlayingOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [nowPlayingOpen]);

  useEffect(() => {
    const closeSearch = (event: PointerEvent) => {
      if (!searchShellRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", closeSearch);
    return () => document.removeEventListener("pointerdown", closeSearch);
  }, []);

  useEffect(() => () => {
    if (edgeIntentRef.current.timer) window.clearTimeout(edgeIntentRef.current.timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!typing) return;
    const startedAt = performance.now();
    setThinkingElapsed(0);
    const clock = window.setInterval(() => setThinkingElapsed((performance.now() - startedAt) / 1000), 100);
    return () => {
      window.clearInterval(clock);
    };
  }, [typing]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [messages, typing, thinkingCue, reducedMotion]);

  useEffect(() => {
    // A visible window behind another application is not document.hidden.
    // Suspend visuals separately; audio clocks, learning and next-deck work stay live.
    const updateVisualActivity = () => {
      visualActiveRef.current = !document.hidden && document.hasFocus();
      rootRef.current?.setAttribute("data-visual-active", String(visualActiveRef.current));
      if (visualActiveRef.current) musicAudioRef.current?.dispatchEvent(new Event("timeupdate"));
    };
    updateVisualActivity();
    window.addEventListener("focus", updateVisualActivity);
    window.addEventListener("blur", updateVisualActivity);
    document.addEventListener("visibilitychange", updateVisualActivity);
    return () => {
      window.removeEventListener("focus", updateVisualActivity);
      window.removeEventListener("blur", updateVisualActivity);
      document.removeEventListener("visibilitychange", updateVisualActivity);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    // The opaque Now Playing field covers this canvas. Do not composite an
    // invisible second background while keeping audio scheduling independent.
    if (nowPlayingOpen) { context.clearRect(0, 0, canvas.width, canvas.height); return; }

    let frame = 0;
    let width = 0;
    let height = 0;
    const pointer = { x: 0, y: 0, clientX: 0, clientY: 0, velocityX: 0, velocityY: 0, active: false };
    const count = particleLevel === 0 ? 24 : particleLevel === 1 ? 64 : 112;
    const particles = Array.from({ length: count }, () => ({
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
      z: Math.random() * 0.88 + 0.12,
      size: Math.random() * 1.8 + 0.6,
    }));

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const onPointer = (event: PointerEvent) => {
      pointer.velocityX = event.clientX - pointer.clientX;
      pointer.velocityY = event.clientY - pointer.clientY;
      pointer.clientX = event.clientX;
      pointer.clientY = event.clientY;
      pointer.x = event.clientX / Math.max(width, 1) - 0.5;
      pointer.y = event.clientY / Math.max(height, 1) - 0.5;
      pointer.active = true;
    };

    const draw = () => {
      frame = 0;
      if (document.hidden || (!visualActiveRef.current && homeCanvasPaintedRef.current)) return;
      context.clearRect(0, 0, width, height);
      particles.forEach((particle, index) => {
        if (!reducedMotion) {
          particle.z -= 0.00045 + (index % 5) * 0.00004;
          if (particle.z < 0.1) {
            particle.z = 1;
            particle.x = Math.random() * 2 - 1;
            particle.y = Math.random() * 2 - 1;
          }
        }
        const perspective = 1 / particle.z;
        let x = width / 2 + particle.x * width * 0.42 * perspective + pointer.x * 104;
        let y = height / 2 + particle.y * height * 0.42 * perspective + pointer.y * 78;
        const radius = Math.min(3.8, particle.size * perspective * 0.78);
        const mouseX = (pointer.x + 0.5) * width;
        const mouseY = (pointer.y + 0.5) * height;
        const pointerDistance = Math.hypot(x - mouseX, y - mouseY);
        if (pointer.active && pointerDistance < 360 && !reducedMotion) {
          const influence = Math.pow(1 - pointerDistance / 360, 1.45);
          const pull = influence * 62;
          x += ((mouseX - x) / Math.max(pointerDistance, 1)) * pull;
          y += ((mouseY - y) / Math.max(pointerDistance, 1)) * pull;
          x += pointer.velocityX * influence * 0.48;
          y += pointer.velocityY * influence * 0.48;
        }
        context.beginPath();
        context.fillStyle = `rgba(205, 228, 255, ${Math.min(0.62, 0.08 + (1 - particle.z) * 0.5)})`;
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        if (pointer.active && !reducedMotion) {
          const distance = Math.hypot(x - mouseX, y - mouseY);
          if (distance < 255) {
            context.beginPath();
            context.moveTo(x, y);
            context.lineTo(mouseX, mouseY);
            context.strokeStyle = `rgba(190, 210, 255, ${(1 - distance / 255) * 0.34})`;
            context.lineWidth = 0.7;
            context.stroke();
          }
        }
      });
      pointer.velocityX *= 0.82;
      pointer.velocityY *= 0.82;
      if (width > 0 && height > 0 && !homeCanvasPaintedRef.current) {
        homeCanvasPaintedRef.current = true;
        setBootHomeFrameReady(true);
      }
      // Prepare one real frame behind the opening screen. Do not run an
      // invisible animation loop or recreate this field when entry completes.
      if (visualActiveRef.current && bootPhaseRef.current !== "playing") frame = window.requestAnimationFrame(draw);
    };

    resize();
    const suspendVisual = () => { window.cancelAnimationFrame(frame); frame = 0; };
    const resumeVisible = () => { if (!document.hidden && visualActiveRef.current && !frame) draw(); };
    const resizeVisible = () => { resize(); resumeVisible(); };
    homeCanvasResumeRef.current = resumeVisible;
    document.addEventListener("visibilitychange", resumeVisible);
    window.addEventListener("focus", resumeVisible);
    window.addEventListener("blur", suspendVisual);
    window.addEventListener("resize", resizeVisible);
    window.addEventListener("pointermove", onPointer, { passive: true });
    draw();
    return () => {
      window.cancelAnimationFrame(frame);
      homeCanvasResumeRef.current = () => {};
      document.removeEventListener("visibilitychange", resumeVisible);
      window.removeEventListener("focus", resumeVisible);
      window.removeEventListener("blur", suspendVisual);
      window.removeEventListener("resize", resizeVisible);
      window.removeEventListener("pointermove", onPointer);
    };
  }, [particleLevel, reducedMotion, nowPlayingOpen]);

  useEffect(() => {
    if (bootPhase !== "playing") homeCanvasResumeRef.current();
  }, [bootPhase]);

  useEffect(() => {
    const canvas = nowPlayingOpen ? nowProgressWaveRef.current : progressWaveRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let width = 0;
    let height = 0;
    let lastDrawnProgress = -1;
    const waveformKey = activeQQTrack?.mid || currentTrack.title;
    // Flat neutral preparation state, not a hash masquerading as measured volume.
    const fallbackWaveform = Array.from({ length: 96 }, () => 0);

    const sampleWaveform = (source: number[], length = 96) => Array.from({ length }, (_, index) => {
      const sourceIndex = index / Math.max(1, length - 1) * Math.max(0, source.length - 1);
      const left = Math.floor(sourceIndex);
      const right = Math.min(source.length - 1, left + 1);
      const mix = sourceIndex - left;
      return (source[left] || 0) * (1 - mix) + (source[right] || source[left] || 0) * mix;
    });
    if (!displayedWaveformRef.current.length) displayedWaveformRef.current = sampleWaveform(trackAnalysisRef.current.get(waveformKey)?.waveform
      || (initialWaveformRef.current.trackId === waveformKey ? initialWaveformRef.current.waveform : fallbackWaveform));
    // Analysis waveforms are replaced, never mutated, so a resampled copy can be
    // reused across frames instead of allocating several arrays per frame.
    const sampledWaveforms = new WeakMap<number[], number[]>();
    const sampledWaveform = (source: number[]) => {
      let sampled = sampledWaveforms.get(source);
      if (!sampled) { sampled = sampleWaveform(source); sampledWaveforms.set(source, sampled); }
      return sampled;
    };
    const mixedWaveform: number[] = [];

    const resize = () => {
      lastDrawnProgress = -1;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const drawWave = () => {
      frame = 0;
      if (document.hidden || !visualActiveRef.current) return;
      const runtime = activeTransitionRef.current;
      const transitionFrame = transitionVisualFrameRef.current;
      const ordinaryWaveform = sampledWaveform(trackAnalysisRef.current.get(waveformKey)?.waveform
        || (initialWaveformRef.current.trackId === waveformKey ? initialWaveformRef.current.waveform : fallbackWaveform));
      const outgoingWaveform = runtime ? sampledWaveform(runtime.outgoingSnapshot.analysis.waveform || fallbackWaveform) : ordinaryWaveform;
      const incomingWaveform = runtime ? sampledWaveform(runtime.incomingSnapshot.analysis.waveform || fallbackWaveform) : ordinaryWaveform;
      const waveformMix = runtime && transitionFrame ? transitionFrame.waveformMix : 0;
      let targetWaveform = ordinaryWaveform;
      if (runtime) {
        mixedWaveform.length = outgoingWaveform.length;
        for (let index = 0; index < outgoingWaveform.length; index += 1) mixedWaveform[index] = outgoingWaveform[index] * (1 - waveformMix) + incomingWaveform[index] * waveformMix;
        targetWaveform = mixedWaveform;
      }
      const waveform = displayedWaveformRef.current;
      let changed = Boolean(runtime) || lastDrawnProgress !== progressValueRef.current;
      for (let index = 0; index < targetWaveform.length; index += 1) {
        if (Math.abs(targetWaveform[index] - (waveform[index] ?? targetWaveform[index])) > .0005) changed = true;
        waveform[index] = (waveform[index] ?? targetWaveform[index]) + (targetWaveform[index] - (waveform[index] ?? targetWaveform[index])) * (runtime ? .055 : .014);
      }
      // A settled, paused waveform is static. Repainting it at display refresh
      // rate needlessly invalidates both full-width glass playback bars.
      if (!changed) { frame = window.requestAnimationFrame(drawWave); return; }
      lastDrawnProgress = progressValueRef.current;
      context.clearRect(0, 0, width, height);
      const progressX = width * Math.max(0, Math.min(1, progressValueRef.current / 100));
      const makePath = (values: number[], offsetY = 0) => {
        const path = new Path2D();
        values.forEach((sample, index) => {
          const x = index / Math.max(1, values.length - 1) * width;
          const shapedSample = Math.pow(Math.max(.035, sample), 1.08);
          const y = height * .9 - shapedSample * height * .84 + offsetY;
          if (!index) path.moveTo(x, y); else path.lineTo(x, y);
        });
        return path;
      };
      const path = makePath(waveform);
      /* Each deck keeps its own real playhead during a handoff. */
      const outgoingPath = runtime ? makePath(outgoingWaveform, -1.4) : path;
      const incomingPath = runtime ? makePath(incomingWaveform, 1.4) : path;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 1.05;
      context.strokeStyle = "rgba(255,255,255,.2)";
      context.stroke(path);
      const drawProgressPath = (progressWidth: number, progressPath: Path2D, alpha: number, incoming = false) => {
        context.save();
        context.beginPath();
        context.rect(0, 0, progressWidth, height);
        context.clip();
        context.globalAlpha = alpha;
        context.strokeStyle = incoming ? "rgba(211,226,255,.96)" : "rgba(195,210,255,.9)";
        context.shadowBlur = 6;
        context.shadowColor = "rgba(185,201,255,.26)";
        context.lineWidth = 1.4;
        context.stroke(progressPath);
        context.restore();
      };
      if (runtime && transitionFrame) {
        const outgoingProgress = width * Math.max(0, Math.min(1, runtime.outgoing.currentTime / Math.max(.1, runtime.outgoingSnapshot.analysis.effectiveEnd)));
        const incomingProgress = width * Math.max(0, Math.min(1, runtime.incoming.currentTime / Math.max(.1, runtime.incomingSnapshot.analysis.effectiveEnd)));
        drawProgressPath(outgoingProgress, outgoingPath, transitionFrame.outgoingWeight);
        drawProgressPath(incomingProgress, incomingPath, transitionFrame.incomingWeight, true);
      } else drawProgressPath(progressX, path, 1);
      frame = window.requestAnimationFrame(drawWave);
    };

    resize();
    const suspendVisual = () => { window.cancelAnimationFrame(frame); frame = 0; };
    const resumeVisible = () => { if (!document.hidden && visualActiveRef.current && !frame) frame = window.requestAnimationFrame(drawWave); };
    document.addEventListener("visibilitychange", resumeVisible);
    window.addEventListener("focus", resumeVisible);
    window.addEventListener("blur", suspendVisual);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frame = window.requestAnimationFrame(drawWave);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", resumeVisible);
      window.removeEventListener("focus", resumeVisible);
      window.removeEventListener("blur", suspendVisual);
    };
  }, [activeQQTrack?.mid, currentTrack.title, nowPlayingOpen, waveformRevision]);

  useEffect(() => {
    // Warm the exact current cloud while the main page is visible. Reuse the
    // bounded cover cache; opening the field must not replay a cover change.
    const source = currentCoverData || activeQQTrack?.cover || currentTrack.cover || "";
    const grid = particleLevel === 0 ? 120 : particleLevel === 1 ? 164 : window.innerWidth < 720 ? 180 : 192;
    if (source) void prepareCoverPointCloud(source, grid);
  }, [currentCoverData, activeQQTrack?.cover, currentTrack.cover, particleLevel]);

  useEffect(() => {
    const canvas = nowCanvasRef.current;
    if (!canvas || !nowPlayingOpen) return;
    const glRenderer = typeof WebGLRenderingContext !== "undefined" ? acquireParticleGlRenderer(canvas) : null;
    const context = glRenderer ? null : canvas.getContext("2d");
    if (!glRenderer && !context) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    let disposed = false;
    let smoothedBass = 0;
    // Halo strength for the GPU pass: a quiet base that swells with the beat.
    let fieldGlow = 0;
    const grid = particleLevel === 0 ? 120 : particleLevel === 1 ? 164 : window.innerWidth < 720 ? 180 : 192;
    const coverSource = currentCoverDataLiveRef.current || activeQQTrackLiveRef.current?.cover || currentTrackCoverLiveRef.current || "";
    const trackKey = () => activeQQTrackLiveRef.current?.mid || currentTrackCoverLiveRef.current;
    let coverPoints: CoverPoint[] = coverPointCloudsRef.current.get(`${grid}:${coverSource}`) || [];
    if (coverPoints.length) {
      previousCoverPointsRef.current = coverPoints;
      previousCoverSourceRef.current = coverSource;
    }
    let particleTransition: CoverPointPair[] = [];
    let particleTransitionStartedAt = 0;
    let particleTransitionRuntimeId = "";
    let particleStride = 1;
    let renderQualityKey = "";
    let renderQualitySelected = false;
    let smoothedBurstEnvelope = 0;
    let suppressDramaticUntil = 0;
    let paintDirty = true;
    let pausedFrame: { audio: HTMLAudioElement | null; time: number; track: string; cover: string; analysis: TrackAnalysis | undefined; x: number; y: number; rx: number; ry: number; zoom: number } | null = null;
    const pointRenderCache = new WeakMap<CoverPoint, { color: string; edgeFalloff: number; scatterJitter: number; scatterDepth: number; spatialSin: number; spatialCos: number; radialSin: number; radialCos: number }>();
    const rhythm = () => {
      const runtime = activeTransitionRef.current;
      const transitionFrame = transitionVisualFrameRef.current;
      const authoritativeAudio = runtime && transitionFrame?.beforeSwitch ? runtime.outgoing : runtime && transitionFrame ? runtime.incoming : musicAudioRef.current;
      const authoritativeAnalysis = runtime && transitionFrame?.beforeSwitch ? runtime.outgoingSnapshot.analysis : runtime && transitionFrame ? runtime.incomingSnapshot.analysis : trackAnalysisRef.current.get(activeQQTrackLiveRef.current?.mid || "") || null;
      const playbackSeconds = getAudiblePlaybackTime(authoritativeAudio);
      const visual = getMusicVisualFrame(authoritativeAnalysis, playbackSeconds);
      // Preparing the next deck changes the global analyser pointer before the
      // visual handoff. Read the same deck as the playhead and timeline instead.
      const analyser = authoritativeAudio ? analyserNodesRef.current.get(authoritativeAudio)?.analyser : null;
      if (analyser && frequencyDataRef.current?.length !== analyser.frequencyBinCount) frequencyDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      const frequency = frequencyDataRef.current;
      let realtimeTexture = 0;
      const playing = Boolean(authoritativeAudio && !authoritativeAudio.paused && !userPausedRef.current);
      if (analyser && frequency && playing) {
        analyser.getByteFrequencyData(frequency);
        const average = (start: number, end: number) => {
          let sum = 0;
          for (let index = start; index < Math.min(end, frequency.length); index += 1) sum += frequency[index];
          return sum / Math.max(1, Math.min(end, frequency.length) - start) / 255;
        };
        const bass = average(1, 18);
        const mid = average(18, 72);
        smoothedBass += (bass - smoothedBass) * (bass > smoothedBass ? 0.38 : 0.075);
        realtimeTexture = Math.min(.18, Math.max(0, (bass - smoothedBass) * .55 + mid * .06));
      }
      const pulse = playing ? visual.beatEnvelope * .2 + visual.downbeatEnvelope * .34 + realtimeTexture : 0;
      const breath = playing ? Math.max(.12, Math.min(1, visual.continuousEnergy * .58 + visual.phraseEnvelope * .16)) : .2;
      return { beat: visual.beatPhase * Math.PI * 2, pulse, energy: visual.continuousEnergy, breath, visual };
    };

    let renderedCoverSource = coverPoints.length ? coverSource : "";
    let renderedTrackKey = trackKey();
    let requestedCoverSource = "";
    let failedCoverSource = "";
    let coverRequest = 0;
    const queueCoverTransition = (nextSource: string, runtimeId = "", nextTrackKey = trackKey()) => {
      if (!nextSource) return;
      if (nextSource === renderedCoverSource) {
        if (requestedCoverSource && requestedCoverSource !== nextSource) {
          coverRequest += 1;
          requestedCoverSource = "";
        }
        return;
      }
      if (nextSource === requestedCoverSource) return;
      if (nextSource === failedCoverSource) return;
      requestedCoverSource = nextSource;
      const request = ++coverRequest;
      void prepareCoverPointCloud(nextSource, grid).then((points) => {
        if (disposed || request !== coverRequest) return;
        requestedCoverSource = "";
        if (!points.length) { failedCoverSource = nextSource; return; }
        paintDirty = true;
        if (coverPoints.length && renderedCoverSource && renderedTrackKey !== nextTrackKey) {
          const pairKey = `${grid}:${renderedCoverSource}→${nextSource}`;
          particleTransition = coverPointPairsRef.current.get(pairKey) || spatiallyPairCoverPoints(coverPoints, points);
          setBoundedCache(coverPointPairsRef.current, pairKey, particleTransition, 3);
          // A track change is one continuous gesture: the old cover scatters while
          // becoming the new cover, then the same particles converge.  Clear any
          // beat burst still in flight so it cannot create a second explosion.
          particleTransitionStartedAt = performance.now();
          particleTransitionRuntimeId = runtimeId;
          suppressDramaticUntil = particleTransitionStartedAt + 3200;
        } else {
          particleTransition = [];
          coverPoints = points;
          previousCoverPointsRef.current = points;
        }
        renderedTrackKey = nextTrackKey;
        renderedCoverSource = nextSource;
        previousCoverSourceRef.current = nextSource;
      });
    };
    if (coverSource) {
      queueCoverTransition(coverSource);
    }

    const resize = () => {
      paintDirty = true;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.6);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      if (glRenderer) glRenderer.resize(canvas.width, canvas.height, ratio);
      else context?.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderQualityKey = `${grid}:${width}:${height}:${ratio}`;
      const cachedStride = particleRenderStridesRef.current.get(renderQualityKey);
      particleStride = cachedStride || 1;
      renderQualitySelected = cachedStride !== undefined;
    };

    const drawAlbum = (time: number) => {
      const pointer = nowPointerRef.current;
      const music = rhythm();
      fieldGlow = reducedMotion ? 0 : Math.min(1, .18 + music.pulse * .95 + music.breath * .12);
      const transitionRuntime = activeTransitionRef.current;
      const transitionFrame = transitionVisualFrameRef.current;
      const liveTrack = activeQQTrackLiveRef.current;
      const liveCoverSource = transitionRuntime?.incomingSnapshot.cover || currentCoverDataLiveRef.current || liveTrack?.cover || liveTrack?.fallbackCover || currentTrackCoverLiveRef.current || "";
      queueCoverTransition(liveCoverSource, transitionRuntime?.id || "", transitionRuntime?.incomingSnapshot.track.mid || trackKey());
      const size = Math.min(width, height) * (0.68 + music.breath * 0.03) * pointer.zoom;
      const gap = size / grid;
      const rx = (pointer.rx + pointer.visualY * 7.5) * Math.PI / 180;
      const ry = (pointer.ry - pointer.visualX * 9.5) * Math.PI / 180;
      const cosRx = Math.cos(rx);
      const sinRx = Math.sin(rx);
      const cosRy = Math.cos(ry);
      const sinRy = Math.sin(ry);
      const mouseX = width / 2 + pointer.visualX * width * 0.5;
      const mouseY = height / 2 + pointer.visualY * height * 0.5;
      const analysis = trackAnalysisRef.current.get(activeQQTrackLiveRef.current?.mid || "");
      const bpm = analysis?.bpm || currentTrack.bpm;
      const rawBurstEnvelope = !reducedMotion && time >= suppressDramaticUntil && !particleTransition.length && !transitionVisualFrameRef.current
        ? music.visual.dramaticEnvelope
        : 0;
      // Keep the onset attached to the beat, then give the field a slower,
      // critically-damped return instead of a one-frame-looking snap.
      const burstSmoothing = rawBurstEnvelope > smoothedBurstEnvelope ? .34 : .065;
      smoothedBurstEnvelope += (rawBurstEnvelope - smoothedBurstEnvelope) * burstSmoothing;
      if (smoothedBurstEnvelope < .002) smoothedBurstEnvelope = 0;
      const burstEnvelope = smoothedBurstEnvelope;
      const transitionDuration = Math.max(1100, Math.min(1700, 120000 / Math.max(72, bpm)));
      const coordinatedParticleProgress = particleTransitionRuntimeId && transitionRuntime?.id === particleTransitionRuntimeId && transitionFrame
        ? transitionFrame.particleMix
        : null;
      const transitionProgress = particleTransition.length
        ? coordinatedParticleProgress ?? Math.min(1, (time - particleTransitionStartedAt) / transitionDuration)
        : 1;
      const peakAt = .46;
      const outwardProgress = Math.min(1, transitionProgress / peakAt);
      const morphEase = outwardProgress * outwardProgress * (3 - 2 * outwardProgress);
      const scatterEnvelope = transitionProgress < peakAt
        ? 1 - Math.pow(1 - outwardProgress, 3)
        : Math.pow(1 - (transitionProgress - peakAt) / (1 - peakAt), 1.35);
      const transitionChoreography = transitionRuntime && transitionFrame
        ? getTransitionChoreography(transitionRuntime.plan.strategy, transitionProgress)
        : null;
      if (particleTransition.length && transitionProgress >= 1) {
        coverPoints = particleTransition.map(({ to }) => to);
        previousCoverPointsRef.current = coverPoints;
        particleTransition = [];
        suppressDramaticUntil = Math.max(suppressDramaticUntil, time + 1100);
      }
      const fallbackPoints = coverPoints;
      const pointCount = particleTransition.length ? particleTransition.length : fallbackPoints.length;
      if (context) context.globalCompositeOperation = "source-over";
      const visualCenterX = width >= 900 && lyricMode === "minimal" ? width * .3 : width / 2;
      const influenceRadius = Math.min(126, Math.min(width, height) * .17);
      const influenceRadiusSquared = influenceRadius * influenceRadius;
      const strideSize = gap * Math.sqrt(particleStride);
      const timePhase = time * .00022;
      const sinTime = Math.sin(timePhase), cosTime = Math.cos(timePhase);
      const sinBeat = Math.sin(music.beat), cosBeat = Math.cos(music.beat);
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex += particleStride) {
          const transition = particleTransition[pointIndex];
          const point = transition?.to || fallbackPoints[pointIndex];
          let cached = pointRenderCache.get(point);
          if (!cached) {
            const spatialPhase = point.nx * 44 + point.ny * 31;
            const radialPhase = (point.radius ?? Math.hypot(point.nx, point.ny)) * 21;
            cached = { color: `rgb(${Math.round(point.rgb[0])} ${Math.round(point.rgb[1])} ${Math.round(point.rgb[2])})`, edgeFalloff: Math.pow(Math.min(1, Math.max(Math.abs(point.nx), Math.abs(point.ny)) * 2), 1.45), scatterJitter: Math.sin(point.seed * 91) * .42, scatterDepth: Math.sin(point.seed * 113), spatialSin: Math.sin(spatialPhase), spatialCos: Math.cos(spatialPhase), radialSin: Math.sin(radialPhase), radialCos: Math.cos(radialPhase) };
            pointRenderCache.set(point, cached);
          }
          let nx = point.nx;
          let ny = point.ny;
          let pointRgb: [number, number, number] = point.rgb;
          let pointAlpha = point.alpha;
          const pointSeed = point.seed;
          if (transition) {
            if (transitionChoreography && pointSeed > transitionChoreography.density) continue;
            const scatterSeed = ((pointIndex * 47) % 997) / 997;
            const baseX = transition.from.nx + (point.nx - transition.from.nx) * morphEase;
            const baseY = transition.from.ny + (point.ny - transition.from.ny) * morphEase;
            const scatterStrength = (transitionChoreography?.displacement ?? .08) * (.72 + scatterSeed * .56);
            const scatterAngle = Math.atan2(baseY, baseX) + cached.scatterJitter;
            nx = baseX + Math.cos(scatterAngle) * scatterStrength * scatterEnvelope;
            ny = baseY + Math.sin(scatterAngle) * scatterStrength * scatterEnvelope;
            pointRgb = [
              transition.from.rgb[0] + (point.rgb[0] - transition.from.rgb[0]) * morphEase,
              transition.from.rgb[1] + (point.rgb[1] - transition.from.rgb[1]) * morphEase,
              transition.from.rgb[2] + (point.rgb[2] - transition.from.rgb[2]) * morphEase,
            ];
            pointAlpha = transition.from.alpha + (point.alpha - transition.from.alpha) * morphEase;
          }
          const edge = Math.max(Math.abs(nx), Math.abs(ny)) * 2;
          const pointRadius = transition ? Math.hypot(nx, ny) : point.radius ?? Math.hypot(nx, ny);
          const pointAngle = transition ? Math.atan2(ny, nx) : point.angle ?? Math.atan2(ny, nx);
          // Static phases do not change between frames: use the same sine sum
          // without two expensive trigonometric calls per point. Morphing
          // coordinates still use the original expression directly.
          const wave = (transition ? Math.sin(nx * 44 + ny * 31 + timePhase) : cached.spatialSin * cosTime + cached.spatialCos * sinTime) * (.72 + edge * 2.1) +
            (transition ? Math.sin(pointRadius * 21 - music.beat) : cached.radialSin * cosBeat - cached.radialCos * sinBeat) * (1.15 + music.pulse * 8.5);
          const scatterDistance = burstEnvelope * size * (.17 + pointSeed * .18);
          const x3 = nx * size;
          const y3 = ny * size;
          const z3 = wave - pointer.visualX * nx * 34 + pointer.visualY * ny * 28 + cached.scatterDepth * scatterDistance * .48;
          const rotatedX = x3 * cosRy + z3 * sinRy;
          const rotatedZ = -x3 * sinRy + z3 * cosRy;
          const rotatedY = y3 * cosRx - rotatedZ * sinRx;
          const depth = rotatedZ * cosRx + y3 * sinRx;
          let x = visualCenterX + rotatedX;
          let y = height / 2 + rotatedY;
          if (scatterDistance > 0) {
            const scatterAngle = pointAngle + cached.scatterJitter;
            x += Math.cos(scatterAngle) * scatterDistance;
            y += Math.sin(scatterAngle) * scatterDistance;
          }
          const deltaX = mouseX - x;
          const deltaY = mouseY - y;
          const distanceSquared = deltaX * deltaX + deltaY * deltaY;
          if (distanceSquared < influenceRadiusSquared && !reducedMotion) {
            const distance = Math.sqrt(distanceSquared);
            const influence = Math.pow(1 - distance / influenceRadius, 1.72);
            const depthLayer = Math.max(.28, Math.min(1.18, .7 + depth / Math.max(size, 1)));
            const force = influence * (10 + depthLayer * 16 + music.breath * 3);
            x += (deltaX / Math.max(distance, 1)) * force;
            y += (deltaY / Math.max(distance, 1)) * force;
          }
          const edgeFalloff = transition ? Math.pow(Math.min(1, edge), 1.45) : cached.edgeFalloff;
          const particleAlpha = Math.max(0.24, pointAlpha * 1.08 - edgeFalloff * 0.25 + depth / 500);
          const particleSize = Math.max(1.22, strideSize * (0.58 + (depth / size + 0.5) * 0.14 + music.pulse * 0.064) * (1 - edgeFalloff * 0.045));
          if (glRenderer) {
            glRenderer.push(x, y, particleSize, pointRgb, particleAlpha);
            continue;
          }
          if (!context) continue;
          context.fillStyle = transition ? `rgb(${Math.round(pointRgb[0])} ${Math.round(pointRgb[1])} ${Math.round(pointRgb[2])})` : cached.color;
          context.globalAlpha = particleAlpha;
          context.fillRect(x, y, particleSize, particleSize);
      }
      if (context) {
        context.globalCompositeOperation = "source-over";
        context.globalAlpha = 1;
      }
    };
    // Paint one complete field: Canvas 2D draws while iterating, WebGL submits
    // the collected points in a single call.
    const paintAlbum = (time: number) => {
      if (glRenderer) {
        glRenderer.begin();
        drawAlbum(time);
        glRenderer.flush(fieldGlow);
        return;
      }
      context?.clearRect(0, 0, width, height);
      drawAlbum(time);
    };

    const draw = (time: number) => {
      frame = 0;
      if (document.hidden || !visualActiveRef.current) return;
      const pointer = nowPointerRef.current;
      const follow = reducedMotion ? 1 : pointer.dragging ? 0.5 : 0.18;
      pointer.visualX += (pointer.x - pointer.visualX) * follow;
      pointer.visualY += (pointer.y - pointer.visualY) * follow;
      if (!pointer.dragging && !pointer.returning) {
        pointer.rx = Math.max(-62, Math.min(62, pointer.rx + pointer.velocityX));
        pointer.ry += pointer.velocityY;
        pointer.velocityX *= 0.91;
        pointer.velocityY *= 0.91;
        if (Math.abs(pointer.velocityX) < .015) pointer.velocityX = 0;
        if (Math.abs(pointer.velocityY) < .015) pointer.velocityY = 0;
      }
      if (pointer.returning && !pointer.dragging) {
        pointer.velocityX = (pointer.velocityX + (NOW_INITIAL_RX - pointer.rx) * 0.028) * 0.8;
        pointer.velocityY = (pointer.velocityY + (NOW_INITIAL_RY - pointer.ry) * 0.028) * 0.8;
        pointer.velocityZoom = (pointer.velocityZoom + (1 - pointer.zoom) * 0.032) * 0.78;
        pointer.rx += pointer.velocityX;
        pointer.ry += pointer.velocityY;
        pointer.zoom += pointer.velocityZoom;
        if (
          Math.abs(pointer.rx - NOW_INITIAL_RX) < 0.04 &&
          Math.abs(pointer.ry - NOW_INITIAL_RY) < 0.04 &&
          Math.abs(pointer.zoom - 1) < 0.002 &&
          Math.abs(pointer.velocityX) < 0.02 &&
          Math.abs(pointer.velocityY) < 0.02
        ) {
          pointer.rx = NOW_INITIAL_RX;
          pointer.ry = NOW_INITIAL_RY;
          pointer.zoom = 1;
          pointer.velocityX = 0;
          pointer.velocityY = 0;
          pointer.velocityZoom = 0;
          pointer.returning = false;
        }
      }
      const runtime = activeTransitionRef.current;
      const transitionFrame = transitionVisualFrameRef.current;
      const audio = runtime && transitionFrame?.beforeSwitch ? runtime.outgoing : runtime && transitionFrame ? runtime.incoming : musicAudioRef.current;
      const playing = Boolean(audio && !audio.paused && !userPausedRef.current);
      const currentKey = trackKey();
      const liveTrack = activeQQTrackLiveRef.current;
      const liveCover = runtime?.incomingSnapshot.cover || currentCoverDataLiveRef.current || liveTrack?.cover || liveTrack?.fallbackCover || currentTrackCoverLiveRef.current || "";
      // Cover completions, a seek, and pointer changes must wake a paused field.
      // Observe them cheaply without rebuilding tens of thousands of points.
      queueCoverTransition(liveCover, runtime?.id || "", runtime?.incomingSnapshot.track.mid || currentKey);
      const analysis = trackAnalysisRef.current.get(liveTrack?.mid || "");
      const pointerSettled = !pointer.dragging && !pointer.returning && !pointer.velocityX && !pointer.velocityY && !pointer.velocityZoom &&
        Math.abs(pointer.x - pointer.visualX) < .0001 && Math.abs(pointer.y - pointer.visualY) < .0001;
      if (!playing && pointerSettled && !runtime && !transitionFrame && !particleTransition.length && !paintDirty && pausedFrame &&
        pausedFrame.audio === audio && pausedFrame.time === (audio?.currentTime || 0) && pausedFrame.track === currentKey &&
        pausedFrame.cover === liveCover && pausedFrame.analysis === analysis && pausedFrame.x === pointer.x && pausedFrame.y === pointer.y &&
        pausedFrame.rx === pointer.rx && pausedFrame.ry === pointer.ry && pausedFrame.zoom === pointer.zoom) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      let startedAt = performance.now();
      paintAlbum(time);
      if (!renderQualitySelected && coverPoints.length) {
        // On the GPU path the first pass is mostly cold-JIT point math; time a
        // warm pass instead so a capable machine keeps its full density.
        if (glRenderer) {
          startedAt = performance.now();
          paintAlbum(time);
        }
        // Decide the draw budget before this first frame is presented, then
        // freeze it for this viewport. Never halve visible density twice later.
        const drawingMs = performance.now() - startedAt;
        particleStride = drawingMs > 26 ? 4 : drawingMs > 13 ? 2 : 1;
        setBoundedCache(particleRenderStridesRef.current, renderQualityKey, particleStride, 6);
        renderQualitySelected = true;
        if (particleStride > 1) paintAlbum(time);
      }
      paintDirty = false;
      pausedFrame = playing ? null : { audio, time: audio?.currentTime || 0, track: currentKey, cover: liveCover, analysis,
        x: pointer.x, y: pointer.y, rx: pointer.rx, ry: pointer.ry, zoom: pointer.zoom };
      frame = window.requestAnimationFrame(draw);
    };

    resize();
    const suspendVisual = () => { window.cancelAnimationFrame(frame); frame = 0; };
    const resumeVisible = () => { if (!document.hidden && visualActiveRef.current && !frame) frame = window.requestAnimationFrame(draw); };
    document.addEventListener("visibilitychange", resumeVisible);
    window.addEventListener("focus", resumeVisible);
    window.addEventListener("blur", suspendVisual);
    window.addEventListener("resize", resize);
    const repaintRestored = () => { paintDirty = true; };
    if (glRenderer) canvas.addEventListener("webglcontextrestored", repaintRestored);
    frame = window.requestAnimationFrame(draw);
    return () => {
      disposed = true;
      if (glRenderer) canvas.removeEventListener("webglcontextrestored", repaintRestored);
      if (particleTransition.length) previousCoverPointsRef.current = particleTransition.map(({ to }) => to);
      else if (coverPoints.length) previousCoverPointsRef.current = coverPoints;
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", resumeVisible);
      window.removeEventListener("focus", resumeVisible);
      window.removeEventListener("blur", suspendVisual);
      window.removeEventListener("resize", resize);
    };
  }, [nowPlayingOpen, visualMode, currentTrack.color, currentTrack.bpm, reducedMotion, particleLevel, lyricMode]);

  const addDjReply = (text: string) => {
    setMessages((items) => [...items, { id: messageId.current++, from: "dj", text }]);
    setTyping(false);
    setThinkingElapsed(0);
  };

  function notifySystem(title: string, tone: SystemNoticeTone = "listening", detail = "") {
    noticeTitleRef.current = title;
    setNoticeTone(tone);
    setNoticeDetail(detail);
    setToast(title);
  }

  function getPlayerVolumeScalar() {
    return systemVolumeRef.current.available ? 1 : volumeRef.current / 100;
  }

  async function changeVolume(value: number) {
    const before = volumeRef.current;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
      return { ok: false, before, after: before, error: "INVALID_VOLUME" };
    const revision = ++systemVolumeRequestRef.current;
    const bridge = window.codioDesktop?.systemVolume;
    if (!bridge) {
      volumeRef.current = value;
      setVolume(value);
      return { ok: true, before, after: value, scope: "player" };
    }
    systemVolumePendingRef.current = revision;
    volumeRef.current = value;
    setVolume(value);
    try {
      const status = await bridge.setVolume(value);
      if (revision !== systemVolumeRequestRef.current)
        return { ok: false, before, after: volumeRef.current, error: "SYSTEM_VOLUME_SUPERSEDED" };
      systemVolumePendingRef.current = 0;
      // A callback may already have supplied a newer actual OS state.
      if (status.error) throw new Error(status.error);
      const confirmed = systemVolumeRef.current;
      const latest = status.available && status.revision !== undefined && status.revision < (confirmed.revision ?? 0)
        ? confirmed : status;
      if (!applySystemVolumeStatus(latest)) throw new Error(status.error || "SYSTEM_VOLUME_UNAVAILABLE");
      const actual = systemVolumeRef.current;
      return { ok: true, before, after: actual.volume, muted: actual.muted, scope: "system" };
    } catch {
      if (revision !== systemVolumeRequestRef.current)
        return { ok: false, before, after: volumeRef.current, error: "SYSTEM_VOLUME_SUPERSEDED" };
      systemVolumePendingRef.current = 0;
      const confirmed = systemVolumeRef.current;
      const restored = confirmed.available && typeof confirmed.volume === "number" ? confirmed.volume : before;
      setSystemVolume(confirmed);
      volumeRef.current = restored;
      setVolume(restored);
      setToast("没有确认电脑音量已改变，请检查声音设备后再试。");
      return { ok: false, before, after: restored, scope: "system", error: "SYSTEM_VOLUME_UNAVAILABLE" };
    }
  }

  function getMusicMaster(context: AudioContext) {
    if (musicMasterRef.current) return musicMasterRef.current;
    const gain = context.createGain();
    gain.gain.value = getPlayerVolumeScalar() * .82;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -3.2;
    compressor.knee.value = 5;
    compressor.ratio.value = 12;
    compressor.attack.value = .003;
    compressor.release.value = .18;
    gain.connect(compressor);
    compressor.connect(context.destination);
    const master = { gain, compressor };
    musicMasterRef.current = master;
    return master;
  }

  function connectMusicAnalyser(audio: HTMLAudioElement) {
    if (analysedAudioRef.current === audio && analyserRef.current) return analyserNodesRef.current.get(audio) || null;
    try {
      const audioContext = audioContextRef.current || new AudioContext();
      audioContextRef.current = audioContext;
      const existingChain = analyserNodesRef.current.get(audio);
      if (existingChain) {
        analyserRef.current = existingChain.analyser;
        frequencyDataRef.current = new Uint8Array(existingChain.analyser.frequencyBinCount);
        analysedAudioRef.current = audio;
        void audioContext.resume();
        return existingChain;
      }
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      const highpass = audioContext.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 20;
      highpass.Q.value = .7;
      const lowpass = audioContext.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 20000;
      lowpass.Q.value = .7;
      const lowEq = audioContext.createBiquadFilter();
      lowEq.type = "lowshelf";
      lowEq.frequency.value = 140;
      lowEq.gain.value = 0;
      const midEq = audioContext.createBiquadFilter();
      midEq.type = "peaking";
      midEq.frequency.value = 1650;
      midEq.Q.value = .82;
      midEq.gain.value = 0;
      const highEq = audioContext.createBiquadFilter();
      highEq.type = "highshelf";
      highEq.frequency.value = 6800;
      highEq.gain.value = 0;
      const gain = audioContext.createGain();
      gain.gain.value = Math.max(0, Math.min(1, audio.volume));
      const master = getMusicMaster(audioContext);
      const source = audioContext.createMediaElementSource(audio);
      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(lowEq);
      lowEq.connect(midEq);
      midEq.connect(highEq);
      highEq.connect(analyser);
      analyser.connect(gain);
      gain.connect(master.gain);
      audio.volume = 1;
      const chain = { source, analyser, highpass, lowpass, lowEq, midEq, highEq, gain };
      analyserRef.current = analyser;
      analyserNodesRef.current.set(audio, chain);
      frequencyDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      analysedAudioRef.current = audio;
      void audioContext.resume();
      return chain;
    } catch {
      return null;
    }
  }

  async function resumeMusicAudioGraph() {
    try {
      const context = audioContextRef.current || new AudioContext();
      audioContextRef.current = context;
      if (context.state !== "running") await withTimeout(context.resume(), 1500, "AUDIO_CONTEXT_RESUME");
      return context.state === "running";
    } catch {
      return false;
    }
  }

  function getAudiblePlaybackTime(audio: HTMLAudioElement | null) {
    if (!audio) return 0;
    const mediaTime = Math.max(0, Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    const context = audioContextRef.current;
    // Operational cues/queue control still use native currentTime. This shared
    // display clock compensates only the connected output path, never seek or
    // a stopped media element, and does not invent an offset for direct audio.
    if (audio.paused || audio.ended || !context || context.state !== "running" || !analyserNodesRef.current.has(audio)) return mediaTime;
    const base = Number.isFinite(context.baseLatency) ? Math.max(0, context.baseLatency) : 0;
    const output = Number.isFinite(context.outputLatency) ? Math.max(0, context.outputLatency) : 0;
    const rate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1;
    return Math.max(0, mediaTime - (base + output) * rate);
  }

  function releaseMusicAudio(audio: HTMLAudioElement) {
    audio.oncanplay = null;
    audio.onended = null;
    audio.onerror = null;
    audio.onpause = null;
    audio.onplay = null;
    audio.onplaying = null;
    audio.onseeked = null;
    audio.onstalled = null;
    audio.ontimeupdate = null;
    audio.onwaiting = null;
    const chain = analyserNodesRef.current.get(audio);
    if (chain) {
      for (const node of [chain.source, chain.highpass, chain.lowpass, chain.lowEq, chain.midEq, chain.highEq, chain.analyser, chain.gain]) {
        try { node.disconnect(); } catch { /* The node may already be detached. */ }
      }
      analyserNodesRef.current.delete(audio);
    }
    if (analysedAudioRef.current === audio) {
      analysedAudioRef.current = null;
      analyserRef.current = null;
      frequencyDataRef.current = null;
    }
    if (musicAudioRef.current === audio) musicAudioRef.current = null;
    try { audio.pause(); } catch { /* The media element may already be closed. */ }
    audio.removeAttribute("src");
    audio.load();
    audio.playbackRate = 1;
    delete audio.dataset.codioTransition;
    audioElementsRef.current.delete(audio);
  }

  function discardPreparedEntry(entry: { promise: Promise<PreparedTrack | null> }) {
    void entry.promise.then((prepared) => {
      if (!prepared?.audio) return;
      const runtime = activeTransitionRef.current;
      if (musicAudioRef.current !== prepared.audio && runtime?.incoming !== prepared.audio && runtime?.outgoing !== prepared.audio) {
        releaseMusicAudio(prepared.audio);
      }
    });
  }

  function createPreparedAudio(sourceUrl: string) {
    const audio = new Audio();
    audioElementsRef.current.add(audio);
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.src = sourceUrl;
    audio.dataset.codioSource = sourceUrl;
    audio.volume = 0;
    audio.load();
    return audio;
  }

  function analyzeDecodedBuffer(trackKey: string, buffer: AudioBuffer, sourceSignature: string, signal?: AbortSignal, generation = analysisLifecycleRef.current.generation) {
    if (!analysisLifecycleRef.current.mounted || generation !== analysisLifecycleRef.current.generation || signal?.aborted) return Promise.resolve(null);
    if (typeof Worker === "undefined") {
      const channels = Array.from({ length: Math.min(8, buffer.numberOfChannels) }, (_, index) => new Float32Array(buffer.getChannelData(index)));
      return Promise.resolve(analyzePcmTrack({ trackId: trackKey, sampleRate: buffer.sampleRate, channels, sourceSignature }));
    }
    if (!analysisWorkerRef.current) {
      const worker = new Worker(new URL("./audio-analysis-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ id: string; analysis: TrackAnalysis | null }>) => {
        const pending = analysisWorkerPendingRef.current.get(event.data.id);
        if (!pending) return;
        pending.resolve(event.data.analysis);
      };
      worker.onerror = () => {
        if (analysisWorkerRef.current !== worker) return;
        for (const pending of analysisWorkerPendingRef.current.values()) {
          pending.resolve(null);
        }
        analysisWorkerPendingRef.current.clear();
        worker.terminate();
        analysisWorkerRef.current = null;
      };
      analysisWorkerRef.current = worker;
    }
    const id = `analysis-${trackKey}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channelBuffers = Array.from({ length: Math.min(8, buffer.numberOfChannels) }, (_, index) => new Float32Array(buffer.getChannelData(index)).buffer);
    return new Promise<TrackAnalysis | null>((resolve) => {
      const finish = (analysis: TrackAnalysis | null) => {
        const pending = analysisWorkerPendingRef.current.get(id);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        analysisWorkerPendingRef.current.delete(id);
        signal?.removeEventListener("abort", cancel);
        resolve(analysis);
      };
      const cancel = () => finish(null);
      const timer = window.setTimeout(cancel, 45_000);
      analysisWorkerPendingRef.current.set(id, { resolve: finish, timer });
      signal?.addEventListener("abort", cancel, { once: true });
      if (!analysisLifecycleRef.current.mounted || generation !== analysisLifecycleRef.current.generation || signal?.aborted) { cancel(); return; }
      try {
        analysisWorkerRef.current!.postMessage({ id, trackId: trackKey, sampleRate: buffer.sampleRate, channels: channelBuffers, sourceSignature }, channelBuffers);
      } catch { cancel(); }
    });
  }

  function supplementAnalyzedPreferences(trackKey: string, analysis: TrackAnalysis) {
    let updated = listeningMemoryRef.current;
    for (const preference of activePreferences(updated)) {
      if (preference.targetType !== "track" || preference.features?.trackId !== trackKey) continue;
      const confidence = Math.min(.82, analysis.tempoConfidence);
      updated = supplementPreferenceFeatures(updated, preference.eventId, { ...preference.features,
        bpm: { value: analysis.bpm || null, source: "audio_analysis", confidence, profileEligible: confidence >= .5 && analysis.bpm > 0 } });
    }
    if (updated !== listeningMemoryRef.current) {
      if (listeningMemoryHydratedRef.current) saveListeningMemory(window.localStorage, updated);
      listeningMemoryRef.current = updated; setListeningMemory(updated); requestRecommendationUpdate("preference_audio_evidence_supplemented");
    }
  }

  function analysisForAudio(trackKey: string, audio: HTMLAudioElement) {
    const binding = analysisSourceRef.current.get(trackKey);
    const analysis = trackAnalysisRef.current.get(trackKey);
    if (!binding || !analysis || binding.url !== (audio.dataset.codioSource || audio.src)) return null;
    return isTrackAnalysisSourceValid(analysis, trackKey, binding.signature, audio.duration) ? analysis : null;
  }

  function analyseTrackSource(trackKey: string, sourceUrl: string, mediaDuration = 0, sourceMediaId = "") {
    if (!analysisLifecycleRef.current.mounted) return Promise.resolve(null);
    const cached = trackAnalysisRef.current.get(trackKey), binding = analysisSourceRef.current.get(trackKey);
    if (cached && binding?.url === sourceUrl && isTrackAnalysisSourceValid(cached, trackKey, binding.signature, mediaDuration || binding.duration)) return Promise.resolve(cached);
    const pending = analysisPromiseRef.current.get(trackKey);
    if (pending && binding?.url === sourceUrl) return pending;
    const active = activeQQTrackLiveRef.current;
    const next = playQueueRef.current[activeQueueIndexRef.current + 1];
    const runtime = activeTransitionRef.current;
    const protectedIds = new Set([active?.mid, next?.mid, runtime?.outgoingSnapshot.track.mid, runtime?.incomingSnapshot.track.mid].filter(Boolean));
    if (protectedIds.has(trackKey)) {
      // Old selections must not consume the two analysis slots indefinitely.
      // Keep current/next/committed transition work; cancel only superseded jobs.
      for (const [id, job] of analysisRequestsRef.current) if (!protectedIds.has(id)) {
        job.controller.abort();
        if (job.timer !== null) window.clearTimeout(job.timer);
        analysisRequestsRef.current.delete(id);
        analysisPromiseRef.current.delete(id);
      }
    }
    if (analysisPromiseRef.current.size >= 2 && !pending) return Promise.resolve(null);
    const identity = active?.mid === trackKey ? active : playQueueRef.current.find(track => track.mid === trackKey);
    if (!sourceMediaId && identity) sourceMediaId = `${identity.provider}:${identity.mid}:${identity.mediaMid || identity.mid}`;
    const previous = analysisRequestsRef.current.get(trackKey);
    previous?.controller.abort();
    if (previous?.timer !== null && previous?.timer !== undefined) window.clearTimeout(previous.timer);
    const request = { controller: new AbortController(), timer: null as number | null };
    analysisRequestsRef.current.set(trackKey, request);
    const generation = analysisLifecycleRef.current.generation;
    const sourceBinding = { url: sourceUrl, signature: "", duration: 0 };
    setBoundedCache(analysisSourceRef.current, trackKey, sourceBinding, 48);
    const isCurrent = () => analysisLifecycleRef.current.mounted && generation === analysisLifecycleRef.current.generation
      && !request.controller.signal.aborted && analysisSourceRef.current.get(trackKey) === sourceBinding;

    const workerAnalysis = (async () => {
      const analysisStartedAt = performance.now();
      try {
        const controller = request.controller;
        request.timer = window.setTimeout(() => controller.abort(), 25000);
        let bytes: ArrayBuffer;
        try {
          const response = await fetch(sourceUrl, { signal: controller.signal });
          if (!isCurrent()) { await response.body?.cancel(); return null; }
          if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 48 * 1024 * 1024) return null;
          const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (!isCurrent()) { await reader.cancel(); return null; }
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 48 * 1024 * 1024) { await reader.cancel(); return null; }
            chunks.push(new Uint8Array(part.value));
          }
          const complete = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { complete.set(chunk, offset); offset += chunk.byteLength; }
          bytes = complete.buffer;
        } finally { if (request.timer !== null) window.clearTimeout(request.timer); request.timer = null; }
        if (!isCurrent()) return null;
        sourceBinding.signature = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
        if (!isCurrent()) return null;
        const diskCached = await withTimeout(window.codioDesktop?.analysis?.get(trackKey, 3) || Promise.resolve(null), 1200, "ANALYSIS_CACHE").catch(() => null);
        if (!isCurrent()) return null;
        if (diskCached && isTrackAnalysisSourceValid(diskCached, trackKey, sourceBinding.signature, mediaDuration || diskCached.duration)) {
          sourceBinding.duration = diskCached.duration;
          setBoundedCache(trackAnalysisRef.current, trackKey, diskCached, 48);
          supplementAnalyzedPreferences(trackKey, diskCached);
          if (sourceMediaId) void window.codioDesktop?.analysis?.save(trackKey, { ...diskCached, sourceMediaId } as TrackAnalysis).catch(() => false);
          if (activeQQTrackLiveRef.current?.mid === trackKey) notifySystem("V3 音乐时间线已从缓存恢复", "ready", `${Math.max(1, Math.round(performance.now() - analysisStartedAt))}ms · 未重复解码`);
          return diskCached;
        }
        const context = audioContextRef.current || new AudioContext();
        audioContextRef.current = context;
        const buffer = await context.decodeAudioData(bytes.slice(0));
        if (!isCurrent()) return null;
        const result = await analyzeDecodedBuffer(trackKey, buffer, sourceBinding.signature, controller.signal, generation);
        if (!result || !isCurrent() || !isTrackAnalysisSourceValid(result, trackKey, sourceBinding.signature, mediaDuration || buffer.duration)) return null;
        sourceBinding.duration = buffer.duration;
        setBoundedCache(trackAnalysisRef.current, trackKey, result, 48);
        supplementAnalyzedPreferences(trackKey, result);
        if (activeQQTrackLiveRef.current?.mid === trackKey) notifySystem("V3 音乐时间线分析完成", "ready", `${Math.round(performance.now() - analysisStartedAt)}ms · ${result.tempoConfidence >= .5 ? `${result.bpm} BPM` : "节拍低置信估计"} · ${Math.round(result.analysisConfidence * 100)}% confidence`);
        void window.codioDesktop?.analysis?.save(trackKey, sourceMediaId ? { ...result, sourceMediaId } as TrackAnalysis : result).then((saved) => {
          if (saved && isCurrent() && activeQQTrackLiveRef.current?.mid === trackKey) notifySystem("音乐时间线已写入 D 盘缓存", "success", `${result.beats.length} beats · ${result.phraseBoundaries.length} phrases · audio 未缓存`);
        }).catch(() => false);
        return result;
      } catch {
        return null;
      } finally {
        if (request.timer !== null) window.clearTimeout(request.timer);
        if (analysisRequestsRef.current.get(trackKey) === request) analysisRequestsRef.current.delete(trackKey);
        if (analysisSourceRef.current.get(trackKey) === sourceBinding) analysisPromiseRef.current.delete(trackKey);
      }
    })();
    analysisPromiseRef.current.set(trackKey, workerAnalysis);
    return workerAnalysis;
  }

  async function prepareInitialWaveform(track: QQTrack): Promise<number[] | null> {
    const sourceMediaId = `${track.provider}:${track.mid}:${track.mediaMid || track.mid}`;
    const validWave = (analysis: TrackAnalysis | null | undefined) => analysis?.version === 3 && analysis.trackId === track.mid
      && Math.abs(analysis.duration - track.durationSeconds) <= 1 && Array.isArray(analysis.waveform) && analysis.waveform.length >= 32
      && analysis.waveform.every(value => Number.isFinite(value) && value >= 0 && value <= 1);
    const cached = await withTimeout(window.codioDesktop?.analysis?.get(track.mid, 3) || Promise.resolve(null), 1200, "INITIAL_WAVEFORM_CACHE").catch(() => null);
    // This bounded cache preview is for the static volume curve only. It must
    // never install unverified cached analysis into the DJ/transition timeline.
    if (validWave(cached) && (cached as TrackAnalysis & { sourceMediaId?: string }).sourceMediaId === sourceMediaId) return cached!.waveform!;
    const prepared = await prepareTrack(track, false);
    if (!prepared?.playback.url) return null;
    const analysis = await analyseTrackSource(track.mid, prepared.playback.url, track.durationSeconds, sourceMediaId);
    return validWave(analysis) ? analysis!.waveform! : null;
  }

  function prepareTrack(track: QQTrack, eager = false) {
    const now = Date.now();
    const authorizationRevision = qqAuthorizationRevisionRef.current;
    const cache = preparedTracksRef.current;
    if (eager) {
      preparedDeckTrackRef.current = track.mid;
      for (const [mid, entry] of cache) if (mid !== track.mid) void entry.promise.then(prepared => {
        const audio = prepared?.audio, runtime = activeTransitionRef.current;
        if (audio && audio !== musicAudioRef.current && audio !== runtime?.incoming && audio !== runtime?.outgoing && !seamlessTransitionRef.current) {
          releaseMusicAudio(audio); prepared!.audio = null;
        }
      });
    }
    for (const [mid, entry] of cache) {
      if (now >= (entry.expiresAt ?? entry.createdAt + PREPARED_TRACK_TTL_MS)
        || (entry.expiresAt === undefined && entry.authorizationRevision !== undefined && entry.authorizationRevision !== authorizationRevision)) {
        cache.delete(mid);
        discardPreparedEntry(entry);
      }
    }
    const cached = cache.get(track.mid);
    if (cached) {
      if (!eager) return cached.promise;
      return cached.promise.then((prepared) => {
        if (!prepared?.playback.url) return null;
        if (!prepared.audio && preparedDeckTrackRef.current === track.mid) prepared.audio = createPreparedAudio(prepared.playback.url);
        return prepared;
      });
    }
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop) return Promise.resolve(null);
    const createdAt = now;
    const promise = (async () => {
      try {
        const coverPromise = withTimeout(resolveTrackCover(track, desktop), 2200, "PREPARE_COVER").catch(() => track.cover || "");
        const playback = await withTimeout(desktop.play(track), 12000, "PREPARE_PLAYBACK");
        if (authorizationRevision !== qqAuthorizationRevisionRef.current) return null;
        if (!playback.playable || !playback.url) {
          if (playback.requiresLogin) {
            setQQPlaybackReady(false);
            // A failed prefetch is not a settled disconnected first visit.
            // Keep boot closed until an explicit status recheck resolves it.
            setQQConnection(bootPhaseRef.current !== "done" ? "error" : "needs-auth");
          }
          if (!playback.requiresLogin) setBoundedCache(failedTracksRef.current, track.mid, Date.now(), 64);
          return null;
        }
        // Reuse the actual desktop ticket, with a safety margin and a hard cap.
        // An older bridge without expiry still uses the conservative 3-minute TTL.
        const expiresAt = typeof playback.expiresAt === "number" && Number.isFinite(playback.expiresAt)
          ? Math.min(playback.expiresAt - 30_000, createdAt + 30 * 60 * 1000)
          : createdAt + PREPARED_TRACK_TTL_MS;
        if (expiresAt <= Date.now()) return null;
        failedTracksRef.current.delete(track.mid);
        const audio = eager && preparedDeckTrackRef.current === track.mid ? createPreparedAudio(playback.url) : null;
        const prepared: PreparedTrack = { track, playback, coverData: track.cover || "", coverPromise, audio, preparedAt: createdAt, expiresAt };
        // Artwork is independent of media readiness. Keep the shared preparation
        // updated without making a playable source wait for a cover request.
        void coverPromise.then(coverData => { if (coverData) prepared.coverData = coverData; });
        return prepared;
      } catch {
        return null;
      }
    })().then(prepared => {
      // A failed pending request is not a three-minute cached failure. A newer
      // request must not be removed by this one's completion.
      const entry = cache.get(track.mid);
      if (entry?.promise === promise) {
        if (!prepared) cache.delete(track.mid);
        else entry.expiresAt = prepared.expiresAt;
      }
      return prepared;
    });
    cache.set(track.mid, { createdAt, authorizationRevision, promise });
    if (cache.size > 30) {
      // Catalogue validation must not evict sources already promised to the
      // homepage. Retain the same bound and evict an unshown candidate first.
      const protectedIds = new Set([
        ...recommendationVisibleRef.current.matched, ...recommendationVisibleRef.current.frontier,
      ].map(item => recommendationTracksRef.current[recommendationIdentity(item)]?.mid).filter(Boolean));
      const active = activeQQTrackLiveRef.current?.mid;
      if (active) protectedIds.add(active);
      if (preparedDeckTrackRef.current) protectedIds.add(preparedDeckTrackRef.current);
      const next = playQueueRef.current[activeQueueIndexRef.current + 1]?.mid;
      if (next) protectedIds.add(next);
      const transition = activeTransitionRef.current;
      if (transition) { protectedIds.add(transition.outgoingSnapshot.track.mid); protectedIds.add(transition.incomingSnapshot.track.mid); }
      const oldestKey = [...cache.keys()].find(mid => !protectedIds.has(mid)) ?? track.mid;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest) discardPreparedEntry(oldest);
    }
    return promise;
  }

  async function warmRecommendationSources(tracks: QQTrack[]) {
    const warm = sourceWarmRef.current;
    warm.controller?.abort();
    const revision = ++warm.revision;
    const controller = new AbortController(); warm.controller = controller;
    const entries = bufferedSourcesRef.current;
    const priority = [...new Map([activeQQTrackLiveRef.current, ...tracks].filter((track): track is QQTrack => Boolean(track)).map(track => [track.mid, track])).values()].slice(0, 6);
    for (const track of priority) {
      if (revision !== warm.revision || controller.signal.aborted || musicAudioRef.current && !musicAudioRef.current.paused) break;
      const existing = entries.get(track.mid);
      if (existing && (existing.url === musicAudioRef.current?.src || Date.now() < existing.expiresAt)) continue;
      const prepared = await prepareTrack(track, false);
      if (!prepared?.playback.url || controller.signal.aborted) continue;
      const timer = window.setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(prepared.playback.url, { signal: controller.signal });
        if (!response.ok || !response.body) continue;
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
        while (!controller.signal.aborted) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 8 * 1024 * 1024) { await reader.cancel(); bytes = 0; break; }
          chunks.push(new Uint8Array(part.value));
        }
        if (!bytes || controller.signal.aborted || revision !== warm.revision) continue;
        while (entries.size >= 6 || [...entries.values()].reduce((sum, item) => sum + item.bytes, 0) + bytes > 24 * 1024 * 1024) {
          const removable = [...entries].find(([, item]) => item.url !== musicAudioRef.current?.src);
          if (!removable) break;
          URL.revokeObjectURL(removable[1].url); entries.delete(removable[0]);
        }
        if ([...entries.values()].reduce((sum, item) => sum + item.bytes, 0) + bytes > 24 * 1024 * 1024) continue;
        const previous = entries.get(track.mid); if (previous && previous.url !== musicAudioRef.current?.src) URL.revokeObjectURL(previous.url);
        const blob = new Blob(chunks, { type: response.headers.get("content-type") || "audio/mpeg" });
        entries.set(track.mid, { source: prepared.playback.url, url: URL.createObjectURL(blob), bytes, at: Date.now(), expiresAt: prepared.expiresAt });
      } catch { /* Byte warming is optional; normal source recovery stays available. */ }
      finally { window.clearTimeout(timer); }
    }
    const now = Date.now();
    const prepared = await Promise.all(tracks.map(track => {
      const entry = preparedTracksRef.current.get(track.mid);
      return entry && now < (entry.expiresAt ?? entry.createdAt + PREPARED_TRACK_TTL_MS) ? entry.promise : null;
    }));
    if (revision === warm.revision) window.codioPreparationDiagnostics = {
      visibleTrackCount: tracks.length, urlPreparedCount: prepared.filter(item => item?.playback.playable && item.playback.url).length,
      fullyBufferedSourceCount: entries.size, fullyBufferedBytes: [...entries.values()].reduce((sum, item) => sum + item.bytes, 0),
      mediaElementCount: audioElementsRef.current.size, strategy: "two URL workers; one idle-only byte worker; six sources / 24 MiB; next deck only" };
  }

  function analyseTrackWhenBuffered(trackKey: string, sourceUrl: string, audio: HTMLAudioElement) {
    if (!analysisLifecycleRef.current.mounted) return Promise.resolve(null);
    const existing = analysisForAudio(trackKey, audio);
    if (existing) return Promise.resolve(existing);
    const pending = analysisBufferWaitRef.current.get(trackKey);
    if (pending?.audio === audio && pending.url === sourceUrl) return pending.promise;
    pending?.cancel();
    const generation = analysisLifecycleRef.current.generation;
    let cancel = () => {};
    const promise = new Promise<TrackAnalysis | null>((resolve) => {
      let checks = 0;
      let timer: number | null = null;
      let finished = false;
      const finish = (result: TrackAnalysis | null) => {
        if (finished) return;
        finished = true;
        if (timer !== null) window.clearTimeout(timer);
        if (analysisBufferWaitRef.current.get(trackKey)?.promise === promise) analysisBufferWaitRef.current.delete(trackKey);
        resolve(result);
      };
      cancel = () => {
        if (analysisSourceRef.current.get(trackKey)?.url === sourceUrl) analysisRequestsRef.current.get(trackKey)?.controller.abort();
        finish(null);
      };
      const waitForBuffer = () => {
        timer = null;
        if (!analysisLifecycleRef.current.mounted || generation !== analysisLifecycleRef.current.generation
          || audio.error || musicAudioRef.current !== audio || (audio.dataset.codioSource || audio.src) !== sourceUrl) {
          cancel();
          return;
        }
        let bufferedAhead = 0;
        if (audio.buffered.length) bufferedAhead = Math.max(0, audio.buffered.end(audio.buffered.length - 1) - audio.currentTime);
        checks += 1;
        if (bufferedAhead >= 12 || checks >= 3) {
          void analyseTrackSource(trackKey, sourceUrl, audio.duration).then(finish, () => finish(null));
          return;
        }
        timer = window.setTimeout(waitForBuffer, 900);
      };
      timer = window.setTimeout(waitForBuffer, 500);
    });
    analysisBufferWaitRef.current.set(trackKey, { audio, url: sourceUrl, promise, cancel });
    return promise;
  }

  const transitionPairKey = (outgoingMid: string, incomingMid: string) => `${outgoingMid}→${incomingMid}`;

  function prepareCoverPointCloud(source: string, grid = window.innerWidth < 720 ? 180 : 192) {
    const key = `${grid}:${source}`;
    const resolved = coverPointCloudsRef.current.get(key);
    if (resolved) return Promise.resolve(resolved);
    const pending = coverPointPromisesRef.current.get(key);
    if (pending) return pending;
    const promise = sampleCoverPointCloud(source, grid)
      .then((points) => {
        if (points.length) setBoundedCache(coverPointCloudsRef.current, key, points, 4);
        return points;
      })
      .finally(() => coverPointPromisesRef.current.delete(key));
    coverPointPromisesRef.current.set(key, promise);
    return promise;
  }

  function prepareUpcomingTrack(currentMid: string) {
    const queue = playQueueRef.current;
    if (!queue.length || activeQQTrackLiveRef.current?.mid !== currentMid) return;
    const currentIndex = queue.findIndex((item) => item.mid === currentMid);
    if (currentIndex < 0) return;
    const next = queue[currentIndex + 1];
    if (next && next.mid !== currentMid) {
      const pairIsCurrent = () => activeQQTrackLiveRef.current?.mid === currentMid && playQueueRef.current[activeQueueIndexRef.current + 1]?.mid === next.mid;
      const pairKey = transitionPairKey(currentMid, next.mid);
      const preparedPromise = prepareTrack(next, true);
      void preparedPromise.then(async (prepared) => {
        if (!prepared?.coverData || !pairIsCurrent()) return;
        const grid = window.innerWidth < 720 ? 180 : 192;
        const targetPoints = await prepareCoverPointCloud(prepared.coverData, grid);
        const outgoingSource = previousCoverSourceRef.current || currentCoverDataLiveRef.current;
        const outgoingPoints = coverPointCloudsRef.current.get(`${grid}:${outgoingSource}`);
        if (outgoingSource && outgoingPoints?.length && targetPoints.length) {
          setBoundedCache(coverPointPairsRef.current, `${grid}:${outgoingSource}→${prepared.coverData}`, spatiallyPairCoverPoints(outgoingPoints, targetPoints), 3);
        }
      });
      if (!transitionPlansRef.current.has(pairKey)) {
        notifySystem("正在预读下一首", "analysis", `${next.title} · 播放连接、前奏与节拍`);
        void Promise.all([
          musicAudioRef.current ? Promise.resolve(analysisForAudio(currentMid, musicAudioRef.current)) : Promise.resolve(null),
          preparedPromise.then((prepared) => prepared?.playback.url && pairIsCurrent() ? analyseTrackSource(next.mid, prepared.playback.url, prepared.audio?.duration || next.durationSeconds) : null),
        ]).then(([outgoingAnalysis, incomingAnalysis]) => {
          if (!outgoingAnalysis || !incomingAnalysis || activeQQTrackLiveRef.current?.mid !== currentMid || playQueueRef.current[activeQueueIndexRef.current + 1]?.mid !== next.mid) return;
          const plan = planTransition(outgoingAnalysis, incomingAnalysis, `transition-${++transitionSequenceRef.current}`);
          setBoundedCache(transitionPlansRef.current, pairKey, plan, 36);
          seamlessAttemptedRef.current = null;
          if (activeQQTrack?.mid === currentMid) notifySystem(
            "下一首衔接方案已准备",
            "ready",
            `${plan.strategy === "phrase-eq-blend" ? "BEAT BLEND" : plan.strategy === "downbeat-cut" ? "PHRASE CUT" : "AMBIENT BRIDGE"} · ${next.title}`,
          );
        }).catch(() => {
          if (activeQQTrack?.mid === currentMid) notifySystem("下一首将使用安全衔接", "warning", "分析暂不可用，播放不会中断");
        });
      }
    }
    if (currentIndex >= queue.length - 3) {
      const current = queue[currentIndex];
      if (current) void extendRecommendationQueue(current).then((expanded) => {
        const upcoming = expanded[currentIndex + 1];
        if (upcoming && upcoming.mid !== currentMid && activeQQTrackLiveRef.current?.mid === currentMid
          && playQueueRef.current[activeQueueIndexRef.current + 1]?.mid === upcoming.mid) void prepareTrack(upcoming, true);
      });
    }
  }

  function updateListeningMemory(event: Parameters<typeof recordListeningEvent>[1]) {
    const next = recordListeningEvent(listeningMemoryRef.current, event);
    if (next === listeningMemoryRef.current) return next;
    if (listeningMemoryHydratedRef.current) saveListeningMemory(window.localStorage, next);
    listeningMemoryRef.current = next;
    setListeningMemory(next);
    if (listeningMemoryHydratedRef.current && isLearningEvent(event)) requestRecommendationUpdate(event.type === "play_settled" ? `play_settled:${event.exitReason}` : event.type);
    return next;
  }

  function requestRecommendationUpdate(trigger: string) {
    const update = recommendationUpdateRef.current;
    // Weather is weak context, not a reason to discard an in-flight startup
    // catalogue. The final scorer reads the latest weather snapshot instead.
    if (trigger === "context_changed" && update.startupReady === true
      && (recommendationVisibleRef.current.matched.length < 12 || recommendationVisibleRef.current.frontier.length < 12)) return update.latest;
    update.revision += 1;
    update.triggers.add(trigger);
    update.latest = { status: "queued", revision: update.revision, profileVersion: listeningMemoryRef.current.updatedAt, hiddenQueueCommitted: false, visibleBatchPreserved: true };
    // Publish queued state too: otherwise the 240ms coalescing window can unlock boot.
    setRecommendationLoading(current => ({ ...current }));
    if (update.timer !== null) window.clearTimeout(update.timer);
    if (update.startupReady === false) { update.timer = null; return update.latest; }
    update.timer = window.setTimeout(() => {
      update.timer = null;
      const triggers = [...update.triggers];
      update.triggers.clear();
      void recommendationRefreshRef.current("feedback", update.revision, triggers);
    }, 240);
    return update.latest;
  }

  function releaseStartupRecommendations() {
    const update = recommendationUpdateRef.current;
    if (update.startupReady) return;
    update.startupReady = true;
    if (update.triggers.size) requestRecommendationUpdate("startup_ready");
  }

  async function enrichTrackMetadata(track: QQTrack, deadline = Infinity): Promise<QQTrack> {
    if (track.provider === "local") return track;
    // QQ detail facts already retained by an owner/TTL-checked snapshot do not
    // need another provider round trip. Missing facts remain unknown until the
    // exact-ID metadata endpoint confirms them; playability is still rechecked.
    if (track.genres?.some(value => typeof value === "string" && value.trim())
      && typeof track.language === "string" && track.language.trim()
      && typeof track.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(track.releaseDate)) return track;
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop?.metadata) return track;
    const work = metadataEnrichmentRef.current;
    let pending = work.pending.get(track.mid);
    if (!pending) {
      pending = (async () => {
        if (work.active >= 2) await new Promise<void>(resolve => work.waiters.push(resolve));
        else work.active += 1;
        try {
          if (!analysisLifecycleRef.current.mounted || Date.now() >= deadline) return { ok: false };
          // Queue wait is not provider time. Start the deadline only once this
          // request owns a slot; QQ's own bounded request has a 3.5s timeout.
          return await withTimeout(desktop.metadata!(track.mid), 5000, "SONG_METADATA");
        } catch {
          return { ok: false };
        } finally {
          const next = work.waiters.shift();
          if (next) next(); else work.active -= 1;
        }
      })();
      work.pending.set(track.mid, pending);
      void pending.finally(() => { if (work.pending.get(track.mid) === pending) work.pending.delete(track.mid); });
    }
    const data = await pending;
    return data?.ok && data.mid === track.mid && data.source === "provider_metadata"
      ? { ...track, genres: data.genres || track.genres, language: data.language || track.language, releaseDate: data.releaseDate || track.releaseDate } : track;
  }

  function featureVectorForTrack(track: QQTrack): TrackFeatureVector {
    const curated = experimentPool.find((item) => item.title.trim().toLowerCase() === track.title.trim().toLowerCase() && item.artist.trim().toLowerCase() === track.artist.trim().toLowerCase());
    const inferred = artistTasteHints.flatMap(([pattern, tags]) => pattern.test(track.artist) ? tags : []);
    const analysis = trackAnalysisRef.current.get(track.mid) || recommendationAudioRef.current.get(track.mid);
    const tags: TrackFeatureVector["tags"] = [...new Set(curated?.tags || inferred)].map((tag) => ({
      value: tag,
      source: curated ? "recommendation_heuristic" as const : "artist_hint" as const,
      confidence: curated ? .35 : .3,
      profileEligible: false,
    }));
    // Only explicit song-level provider strings, not undocumented numeric codes.
    (track.genres || []).forEach(value => tags.push({ value: `genre:${value.trim().toLowerCase()}`, source: "provider_metadata", confidence: .65, profileEligible: true }));
    if (track.language) tags.push({ value: `language:${track.language.trim().toLowerCase()}`, source: "provider_metadata", confidence: .65, profileEligible: true });
    const audioConfidence = analysis ? Math.min(.82, analysis.tempoConfidence) : 0;
    const nullAudio = <T,>(value: T | null) => ({ value, source: "audio_analysis" as const, confidence: value === null ? 0 : audioConfidence, profileEligible: value !== null && audioConfidence >= .5 });
    const libraryTrack = track.provider === "local" ? undefined : qqTasteSnapshotRef.current?.tracks.find(item => item.mid === track.mid);
    const knownLibrary = Boolean(libraryTrack);
    const status = listeningStatus(listeningMemoryRef.current, canonicalTrackKey(track.provider || "qq", track.mid));
    return {
      provider: track.provider || "qq",
      trackId: track.mid,
      artist: track.artistKnown === false ? "" : track.artist,
      album: track.album,
      tags,
      bpm: nullAudio(analysis?.bpm || null),
      // Within-song RMS normalization and spectral vocal proxies are not calibrated
      // cross-song energy or a measured vocal/instrumental proportion.
      energy: nullAudio<number>(null),
      vocalFocus: nullAudio<number>(null),
      instrumentalFocus: nullAudio<number>(null),
      transitionFocus: nullAudio(analysis?.outroFocus || null),
      inLibrary: knownLibrary,
      likedInProvider: Boolean(libraryTrack?.likedInProvider),
      artistFamiliarity: qqTasteSnapshotRef.current?.topArtists.some((item) => recommendationArtistMatches(track.artist, item.name)) ? .8 : 0,
      playlistMembership: (libraryTrack?.playlistMembership || track.playlistMembership || []).map(item => item.id),
      lastPlayedAt: status.lastEffectiveAt || undefined,
      playCount: status.effectivePlays,
      novelty: { value: knownLibrary || status.effective || status.liked ? 0 : .8, source: "library_behavior", confidence: knownLibrary || status.effective || status.liked ? .95 : .8, profileEligible: false },
      metadataConfidence: track.mid && track.title ? (track.artistKnown === false ? .65 : .95) : 0,
    };
  }

  function writeTrackPreference(track: QQTrack, value: "more" | "less" | "neutral", scope: PreferenceScope, source: "dj" | "player", reason: string) {
    const targetKey = canonicalTrackKey(track.provider || "qq", track.mid);
    const previous = activePreferences(listeningMemoryRef.current).find(event => event.targetType === "track" && event.targetKey === targetKey);
    const eventId = `${source}-preference-${crypto.randomUUID()}`;
    const next = updateListeningMemory({ type: "preference_changed", eventId, targetType: "track", targetKey, value, scope, source, reason,
      title: track.title, artist: track.artistKnown === false ? "" : track.artist, features: featureVectorForTrack(track), supersedesEventId: previous?.eventId,
      createdAt: Date.now(), sessionId: listeningMemoryRef.current.currentSession.sessionId });
    if (value !== "neutral") void enrichTrackMetadata(track).then(enriched => {
      const updated = supplementPreferenceFeatures(listeningMemoryRef.current, eventId, featureVectorForTrack(enriched));
      if (updated !== listeningMemoryRef.current) {
        if (listeningMemoryHydratedRef.current) saveListeningMemory(window.localStorage, updated);
        listeningMemoryRef.current = updated; setListeningMemory(updated); requestRecommendationUpdate("preference_evidence_supplemented");
      }
    }).catch(() => {});
    return next;
  }

  function candidateForExperiment(item: Experiment, recentKeys: Set<string>, resolvedTrack?: QQTrack): CandidateTrack | null {
    const identity = recommendationIdentity(item);
    const track = resolvedTrack || recommendationTracksRef.current[identity] || discoveryTracksRef.current[identity];
    if (!track?.mid) return null;
    const base = featureVectorForTrack(track);
    const curated = experimentPool.some((entry) => recommendationIdentity(entry) === identity);
    const featureVector: TrackFeatureVector = {
      ...base,
      tags: [...base.tags.filter(tag => tag.profileEligible), ...item.tags.map((tag) => ({ value: tag, source: "recommendation_heuristic" as const, confidence: curated ? .35 : .28, profileEligible: false }))],
      energy: base.energy,
      novelty: base.novelty,
    };
    const trackKey = canonicalTrackKey("qq", track.mid);
    const status = listeningStatus(listeningMemoryRef.current, trackKey);
    const alreadyHeard = status.effective || status.liked || base.inLibrary;
    return {
      canonicalKey: trackKey,
      track: { provider: "qq", id: track.mid, title: track.title, artist: track.artist },
      source: alreadyHeard ? "familiar_anchor" : "adjacent_discovery",
      generationReason: item.reason,
      featureVector,
      sourceConfidence: featureVector.metadataConfidence,
      alreadyHeard,
      inLibrary: base.inLibrary,
      alreadyRecommended: recentKeys.has(identity),
      playable: Date.now() - (failedTracksRef.current.get(track.mid) || 0) >= 75_000,
    };
  }

  function recommendationSourceForTrack(track: QQTrack): PlaySettledEvent["source"] {
    const identity = recommendationIdentity(track);
    if (matchedExperiments.some((item) => recommendationIdentity(item) === identity)) return "recommendation_match";
    if (visibleExperiments.some((item) => recommendationIdentity(item) === identity)) return "recommendation_frontier";
    const lane = recommendationCatalogRef.current.find(item => recommendationIdentity(item) === identity)?.lane;
    if (lane) return lane === "match" ? "recommendation_match" : "recommendation_frontier";
    if (searchResults.some((item) => item.mid === track.mid)) return "search";
    if (qqTasteSnapshotRef.current?.tracks.some((item) => item.mid === track.mid)) return "library";
    return "queue";
  }

  function beginListeningForTrack(track: QQTrack, source = recommendationSourceForTrack(track)) {
    listeningSessionRef.current = {
      session: beginListeningSession(canonicalTrackKey(track.provider || "qq", track.mid)),
      track,
      source,
      stalled: false,
    };
  }

  function settleCurrentListening(exitReason: PlaySettledEvent["exitReason"]) {
    const active = listeningSessionRef.current;
    if (!active || active.session.settled) return;
    const audio = musicAudioRef.current;
    const duration = Number.isFinite(audio?.duration) && (audio?.duration || 0) > 0 ? Number(audio?.duration) : active.track.durationSeconds;
    const completionRatio = duration > 0 ? Math.max(0, Math.min(1, active.session.listenedSeconds / duration)) : 0;
    active.session.settled = true;
    updateListeningMemory({
      type: "play_settled",
      eventId: `settled-${active.session.sessionId}`,
      sessionId: listeningMemoryRef.current.currentSession.sessionId,
      trackKey: canonicalTrackKey(active.track.provider || "qq", active.track.mid),
      provider: active.track.provider || "qq",
      providerTrackId: active.track.mid,
      title: active.track.title,
      artist: active.track.artistKnown === false ? "" : active.track.artist,
      album: active.track.album,
      features: featureVectorForTrack(active.track),
      startedAt: active.session.startedAt,
      settledAt: Date.now(),
      listenedSeconds: active.session.listenedSeconds,
      durationSeconds: duration,
      completionRatio,
      exitReason,
      source: active.source,
      queuePosition: activeQueueIndexRef.current,
      timeBucket: new Date().getHours() < 7 ? "late-night" : new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "day" : "evening",
      weatherContext,
      sessionIntent: listeningMemoryRef.current.sessionIntent || undefined,
      metadataConfidence: featureVectorForTrack(active.track).metadataConfidence,
    });
    listeningSessionRef.current = null;
  }

  function wireMusicAudio(audio: HTMLAudioElement, trackKey: string) {
    let stallTimer: number | null = null;
    let lastObservedTime = audio.currentTime;
    let lastUiTime = -1, lastUiDuration = -1, lastUiLyricIndex = -1;
    let plannedOutgoing: TrackAnalysis | null = null, plannedIncoming: TrackAnalysis | null = null;
    let plannedNext = "", cachedPlan: TransitionPlan | null = null;
    const clearStallTimer = () => {
      if (stallTimer !== null) window.clearTimeout(stallTimer);
      stallTimer = null;
      if (listeningSessionRef.current?.track.mid === trackKey) listeningSessionRef.current.stalled = false;
    };
    const watchForStall = () => {
      if (musicAudioRef.current !== audio || audio.paused || audio.ended) return;
      if (listeningSessionRef.current?.track.mid === trackKey) listeningSessionRef.current.stalled = true;
      clearStallTimer();
      const stalledAt = audio.currentTime;
      stallTimer = window.setTimeout(() => {
        stallTimer = null;
        if (musicAudioRef.current !== audio || audio.paused || audio.ended) return;
        if (Math.abs(audio.currentTime - stalledAt) < .08) {
          recoverCurrentTrack(audio, trackKey);
        }
      }, 8500);
    };
    audio.ontimeupdate = () => {
      if (musicAudioRef.current !== audio) return;
      const listening = listeningSessionRef.current;
      if (listening?.track.mid === trackKey) listening.session = accumulatePlayingTime(listening.session, audio.currentTime, !audio.paused, listening.stalled);
      if (audio.currentTime > lastObservedTime + .04) clearStallTimer();
      lastObservedTime = audio.currentTime;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const outgoingAnalysis = analysisForAudio(trackKey, audio);
        const analysedEnd = outgoingAnalysis?.effectiveEnd;
        const effectiveDuration = analysedEnd && analysedEnd > 0 ? Math.min(audio.duration, analysedEnd) : audio.duration;
        // Native timeupdate and the background-safe boundary timer can report
        // the same playhead. Only commit meaningful UI changes; still evaluate
        // audio cues on every boundary tick, including while minimized.
        const liveLyrics = lyricLinesLiveRef.current;
        const displayTime = getAudiblePlaybackTime(audio);
        const lyricIndex = liveLyrics.trackId === trackKey
          ? liveLyrics.lines.reduce((selected, line, index) => line.time <= displayTime ? index : selected, -1) : -1;
        if (visualActiveRef.current && (Math.abs(audio.currentTime - lastUiTime) >= .12 || effectiveDuration !== lastUiDuration || lyricIndex !== lastUiLyricIndex)) {
          lastUiTime = audio.currentTime; lastUiDuration = effectiveDuration;
          lastUiLyricIndex = lyricIndex;
          setPlaybackTime({ current: Math.min(displayTime, effectiveDuration), duration: effectiveDuration });
          setProgress(Math.min(100, (displayTime / effectiveDuration) * 100));
        }
        const remaining = effectiveDuration - audio.currentTime;
        const upcoming = playQueueRef.current[activeQueueIndexRef.current + 1];
        let plan: TransitionPlan | null = null;
        if (upcoming && outgoingAnalysis) {
          const incoming = trackAnalysisRef.current.get(upcoming.mid), source = analysisSourceRef.current.get(upcoming.mid);
          const trustedIncoming = incoming && source && isTrackAnalysisSourceValid(incoming, upcoming.mid, source.signature, source.duration) ? incoming : null;
          if (plannedOutgoing !== outgoingAnalysis || plannedIncoming !== trustedIncoming || plannedNext !== upcoming.mid) {
            plannedOutgoing = outgoingAnalysis; plannedIncoming = trustedIncoming; plannedNext = upcoming.mid;
            cachedPlan = trustedIncoming ? planTransition(outgoingAnalysis, trustedIncoming, `planned-${trackKey}-${upcoming.mid}`)
              : planSilenceHandoff(outgoingAnalysis, null, upcoming.mid, `tail-${trackKey}-${upcoming.mid}`);
          }
          plan = cachedPlan;
        }
        const reachedPlannedCue = Boolean(plan && audio.currentTime >= plan.outgoingCue - .08);
        if (seamlessRef.current && !audio.loop && !userPausedRef.current && !audio.paused && remaining > 0.35 && reachedPlannedCue && activeQueueIndexRef.current >= 0 && activeQueueIndexRef.current < playQueueRef.current.length - 1 && !seamlessTransitionRef.current && seamlessAttemptedRef.current !== trackKey) {
          seamlessAttemptedRef.current = trackKey;
          void beginSeamlessCrossfade(trackKey);
        }
        if (remaining <= 0.16 && audio.currentTime > .8 && !audio.paused && !audio.loop && !userPausedRef.current && !seamlessTransitionRef.current) advanceFromFinishedAudio(audio);
      }
    };
    audio.onplay = () => {
      clearStallTimer();
      if (musicAudioRef.current === audio && userPausedRef.current) { audio.pause(); return; }
      if (musicAudioRef.current === audio) { setIsPlaying(true); armPlaybackBoundaryCheck(); }
    };
    audio.onplaying = () => {
      clearStallTimer();
      const fadeRevision = playbackFadeRef.current;
      window.setTimeout(() => {
        const chain = analyserNodesRef.current.get(audio);
        if (fadeRevision === playbackFadeRef.current && !userPausedRef.current && musicAudioRef.current === audio && !audio.paused && !seamlessTransitionRef.current && volumeRef.current > 0 && chain && chain.gain.gain.value < .01) {
          const now = audioContextRef.current?.currentTime || 0;
          chain.gain.gain.setTargetAtTime(1, now, .05);
        }
      }, 760);
    };
    audio.oncanplay = clearStallTimer;
    audio.onwaiting = watchForStall;
    audio.onstalled = watchForStall;
    audio.onpause = () => {
      clearStallTimer();
      if (musicAudioRef.current === audio && !seamlessTransitionRef.current) {
        setIsPlaying(false);
        lastUiTime = -1;
        audio.dispatchEvent(new Event("timeupdate"));
      }
    };
    audio.onseeked = () => {
      if (musicAudioRef.current !== audio) return;
      lastUiTime = -1;
      audio.dispatchEvent(new Event("timeupdate"));
    };
    audio.onended = () => {
      clearStallTimer();
      if (musicAudioRef.current !== audio) return;
      settleCurrentListening("ended");
      if (seamlessTransitionRef.current) pendingAdvanceRef.current = true;
      else advanceFromFinishedAudio(audio);
    };
    audio.onerror = () => {
      clearStallTimer();
      if (musicAudioRef.current !== audio) return;
      if (startingTrackRef.current === trackKey) {
        notifySystem("正在更换播放连接", "analysis", "当前连接不可用，队列不会丢失");
        return;
      }
      recoverCurrentTrack(audio, trackKey);
    };
  }

  function armPlaybackBoundaryCheck() {
    if (audioControlTimerRef.current !== null) window.clearTimeout(audioControlTimerRef.current);
    const check = () => {
      audioControlTimerRef.current = null;
      const audio = musicAudioRef.current;
      if (!audio || audio.paused || userPausedRef.current || audio.ended) return;
      // Audio control is independent of Canvas/rAF, including minimized windows.
      audio.dispatchEvent(new Event("timeupdate"));
      audioControlTimerRef.current = window.setTimeout(check, 120);
    };
    audioControlTimerRef.current = window.setTimeout(check, 120);
  }

  function recoverCurrentTrack(audio: HTMLAudioElement, trackKey: string) {
    if (userPausedRef.current || musicAudioRef.current !== audio || recoveringTrackRef.current || startingTrackRef.current) return;
    const track = playQueueRef.current.find((item) => item.mid === trackKey);
    if (!track) {
      settleCurrentListening("error");
      setIsPlaying(false);
      notifySystem("播放连接已中断", "error", "点播放后会从当前进度重新连接");
      return;
    }
    recoveringTrackRef.current = trackKey;
    const resumeAt = audio.currentTime;
    releaseMusicAudio(audio);
    preparedTracksRef.current.delete(trackKey);
    notifySystem("正在续接当前歌曲", "analysis", "保留当前进度，不会把这次波动记成跳过");
    void startQQTrack(track, 1, resumeAt).finally(() => {
      recoveringTrackRef.current = null;
    });
  }

  function advanceFromFinishedAudio(audio: HTMLAudioElement) {
    if (musicAudioRef.current !== audio) return;
    if (userPausedRef.current) return;
    if (seamlessTransitionRef.current) {
      pendingAdvanceRef.current = true;
      return;
    }
    if (advancingRef.current) return;
    advancingRef.current = true;
    void nextTrack(true).finally(() => {
      advancingRef.current = false;
    });
  }

  function fadeMusicVolume(audio: HTMLAudioElement, target: number, duration: number) {
    playbackFadeCancelRef.current?.();
    const fadeId = ++playbackFadeRef.current;
    const context = audioContextRef.current;
    const chain = analyserNodesRef.current.get(audio);
    if (context && chain) {
      const now = context.currentTime;
      const parameter = chain.gain.gain;
      holdAudioParam(parameter, now);
      parameter.linearRampToValueAtTime(Math.max(0, Math.min(1, target)), now + duration / 1000);
      return new Promise<boolean>((resolve) => {
        const finish = (completed: boolean) => {
          window.clearTimeout(timer);
          if (playbackFadeCancelRef.current === cancel) playbackFadeCancelRef.current = null;
          resolve(completed);
        };
        const cancel = () => { holdAudioParam(parameter, context.currentTime); finish(false); };
        const timer = window.setTimeout(() => finish(fadeId === playbackFadeRef.current), duration + 20);
        playbackFadeCancelRef.current = cancel;
      });
    }
    const from = audio.volume;
    const startedAt = performance.now();
    return new Promise<boolean>((resolve) => {
      const finish = (completed: boolean) => {
        window.clearInterval(timer);
        if (playbackFadeCancelRef.current === cancel) playbackFadeCancelRef.current = null;
        resolve(completed);
      };
      const cancel = () => finish(false);
      const step = () => {
        if (fadeId !== playbackFadeRef.current) {
          finish(false);
          return;
        }
        const now = performance.now();
        const amount = Math.min(1, (now - startedAt) / duration);
        const eased = amount * amount * (3 - 2 * amount);
        audio.volume = Math.max(0, Math.min(1, from + (target - from) * eased));
        if (amount >= 1) {
          finish(true);
        }
      };
      const timer = window.setInterval(step, 16);
      playbackFadeCancelRef.current = cancel;
      step();
    });
  }

  function holdAudioParam(parameter: AudioParam, time: number) {
    const holdable = parameter as AudioParam & { cancelAndHoldAtTime?: (at: number) => void };
    if (typeof holdable.cancelAndHoldAtTime === "function") holdable.cancelAndHoldAtTime(time);
    else {
      parameter.cancelScheduledValues(time);
      parameter.setValueAtTime(parameter.value, time);
    }
  }

  function scheduleCurve(parameter: AudioParam, values: number[], start: number, duration: number, map = (value: number) => value) {
    holdAudioParam(parameter, start);
    parameter.setValueCurveAtTime(Float32Array.from(values, map), start, Math.max(.05, duration));
  }

  function scheduleDeckPlan(chain: MusicAudioChain, plan: TransitionPlan, side: "outgoing" | "incoming", start: number, duration: number) {
    const gain = side === "outgoing" ? plan.outgoingGainCurve : plan.incomingGainCurve;
    const low = side === "outgoing" ? plan.outgoingLowCurve : plan.incomingLowCurve;
    const mid = side === "outgoing" ? plan.outgoingMidCurve : plan.incomingMidCurve;
    const high = side === "outgoing" ? plan.outgoingHighCurve : plan.incomingHighCurve;
    scheduleCurve(chain.gain.gain, gain, start, duration);
    scheduleCurve(chain.lowEq.gain, low, start, duration, (value) => -16 * (1 - value));
    scheduleCurve(chain.midEq.gain, mid, start, duration, (value) => -9 * (1 - value));
    scheduleCurve(chain.highEq.gain, high, start, duration, (value) => -8 * (1 - value));
  }

  function stopTransitionCoordinator() {
    if (transitionCoordinatorRef.current !== null) window.cancelAnimationFrame(transitionCoordinatorRef.current);
    transitionCoordinatorRef.current = null;
    transitionVisualFrameRef.current = null;
    const style = rootRef.current?.style;
    if (!style) return;
    for (const name of ["--transition-progress", "--transition-outgoing", "--transition-incoming", "--transition-outgoing-cover", "--transition-incoming-cover", "--transition-identity", "--transition-background", "--transition-particles", "--transition-waveform", "--transition-lyrics", "--transition-displacement", "--transition-density", "--transition-luminance", "--transition-energy"]) style.removeProperty(name);
    rootRef.current?.removeAttribute("data-transition-strategy");
    rootRef.current?.removeAttribute("data-transition-phase");
  }

  function startTransitionCoordinator(runtime: TransitionRuntime, commit: () => void) {
    stopTransitionCoordinator();
    const tick = () => {
      if (activeTransitionRef.current?.id !== runtime.id || !audioContextRef.current) {
        stopTransitionCoordinator();
        return;
      }
      const visual = getTransitionVisualFrame(runtime.plan.strategy, runtime.audioStartAt, runtime.duration, runtime.switchPoint, audioContextRef.current.currentTime);
      const choreography = getTransitionChoreography(runtime.plan.strategy, visual.progress);
      transitionVisualFrameRef.current = visual;
      const style = visualActiveRef.current ? rootRef.current?.style : null;
      if (style) {
        const visualTotal = Math.max(.0001, visual.outgoingWeight + visual.incomingWeight);
        const visualOut = visual.outgoingWeight / visualTotal;
        const visualIn = visual.incomingWeight / visualTotal;
        style.setProperty("--transition-progress", visual.progress.toFixed(4));
        style.setProperty("--transition-outgoing", visualOut.toFixed(4));
        style.setProperty("--transition-incoming", visualIn.toFixed(4));
        style.setProperty("--transition-outgoing-cover", (visualOut * .25).toFixed(4));
        style.setProperty("--transition-incoming-cover", (visualIn * .25).toFixed(4));
        style.setProperty("--transition-identity", visual.identityMix.toFixed(4));
        style.setProperty("--transition-background", visual.backgroundMix.toFixed(4));
        style.setProperty("--transition-particles", visual.particleMix.toFixed(4));
        style.setProperty("--transition-waveform", visual.waveformMix.toFixed(4));
        style.setProperty("--transition-lyrics", visual.lyricMix.toFixed(4));
        style.setProperty("--transition-displacement", choreography.displacement.toFixed(4));
        style.setProperty("--transition-density", choreography.density.toFixed(4));
        style.setProperty("--transition-luminance", choreography.luminance.toFixed(4));
        style.setProperty("--transition-energy", choreography.energy.toFixed(4));
      }
      rootRef.current?.setAttribute("data-transition-strategy", runtime.plan.strategy);
      rootRef.current?.setAttribute("data-transition-phase", visual.phase);
      if (!visual.beforeSwitch && !runtime.committed) commit();
      if (visual.phase !== "complete") transitionCoordinatorRef.current = window.requestAnimationFrame(tick);
      else transitionCoordinatorRef.current = null;
    };
    transitionCoordinatorRef.current = window.requestAnimationFrame(tick);
  }

  function holdTransitionDuringSettling(runtime: TransitionRuntime) {
    runtime.state = "settling";
    const visual = getTransitionVisualFrame(runtime.plan.strategy, runtime.audioStartAt, runtime.duration, runtime.switchPoint, runtime.audioStartAt + runtime.duration);
    transitionVisualFrameRef.current = { ...visual, phase: "settling", outgoingWeight: 0, incomingWeight: 1, identityMix: 1, backgroundMix: 1, particleMix: 1, waveformMix: 1, lyricMix: 1 };
    const style = rootRef.current?.style;
    if (style) {
      style.setProperty("--transition-progress", "1");
      style.setProperty("--transition-outgoing", "0");
      style.setProperty("--transition-incoming", "1");
      style.setProperty("--transition-outgoing-cover", "0");
      style.setProperty("--transition-incoming-cover", ".25");
      style.setProperty("--transition-identity", "1");
      style.setProperty("--transition-background", "1");
      style.setProperty("--transition-particles", "1");
      style.setProperty("--transition-waveform", "1");
      style.setProperty("--transition-lyrics", "1");
      style.setProperty("--transition-displacement", "0");
      style.setProperty("--transition-density", "1");
      style.setProperty("--transition-luminance", "1");
      style.setProperty("--transition-energy", "1");
    }
    rootRef.current?.setAttribute("data-transition-strategy", runtime.plan.strategy);
    rootRef.current?.setAttribute("data-transition-phase", "settling");
  }

  function waitForTransitionAudioEnd(context: AudioContext, endAt: number, transitionId: string, commitAt?: number, onCommit?: () => void) {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (activeTransitionRef.current?.id === transitionId && commitAt !== undefined && context.currentTime >= commitAt) onCommit?.();
        if (activeTransitionRef.current?.id !== transitionId || context.currentTime >= endAt) {
          resolve();
          return;
        }
        window.setTimeout(check, 25);
      };
      check();
    });
  }

  function relaxPlaybackRate(audio: HTMLAudioElement, from: number, transitionId: string, duration: number) {
    if (Math.abs(from - 1) < .002) return;
    const context = audioContextRef.current;
    if (!context) return;
    const startedAt = context.currentTime;
    const step = () => {
      if (musicAudioRef.current !== audio || audio.dataset.codioTransition !== transitionId || seamlessTransitionRef.current) return;
      const amount = Math.min(1, (context.currentTime - startedAt) * 1000 / duration);
      const eased = amount * amount * (3 - 2 * amount);
      audio.playbackRate = from + (1 - from) * eased;
      if (amount < 1) window.setTimeout(step, 100);
    };
    step();
  }

  function lockTransitionBeats(runtime: TransitionRuntime) {
    const step = () => {
      if (activeTransitionRef.current !== runtime || runtime.state === "aborted" || runtime.state === "settling" || runtime.state === "completed" || runtime.outgoing.paused || runtime.incoming.paused) return;
      const rate = beatMatchingRate(runtime.outgoingSnapshot.analysis, runtime.incomingSnapshot.analysis,
        runtime.outgoing.currentTime, runtime.incoming.currentTime, runtime.plan.incomingTempoRatio);
      runtime.incoming.playbackRate += (rate - runtime.incoming.playbackRate) * .2;
      window.setTimeout(step, 50);
    };
    step();
  }

  function abortActiveTransition(reason: "manual-track" | "seek" | "pause") {
    transitionRequestRef.current += 1;
    seamlessTransitionRef.current = false;
    pendingAdvanceRef.current = false;
    seamlessAttemptedRef.current = null;
    // The incoming deck can already be starting before mixing has a runtime.
    // Stop it now, not only after its play promise resolves or times out.
    const pending = pendingTransitionAudioRef.current;
    pendingTransitionAudioRef.current = null;
    if (pending && pending.audio !== musicAudioRef.current) releaseMusicAudio(pending.audio);
    const runtime = activeTransitionRef.current;
    const context = audioContextRef.current;
    if (!runtime || !context) return;
    runtime.state = "aborted";
    const current = musicAudioRef.current;
    for (const audio of [runtime.outgoing, runtime.incoming]) {
      const chain = analyserNodesRef.current.get(audio);
      if (!chain) continue;
      const now = context.currentTime;
      for (const parameter of [chain.gain.gain, chain.lowEq.gain, chain.midEq.gain, chain.highEq.gain]) holdAudioParam(parameter, now);
      chain.gain.gain.setTargetAtTime(audio === current ? 1 : 0, now, .04);
      chain.lowEq.gain.setTargetAtTime(0, now, .05);
      chain.midEq.gain.setTargetAtTime(0, now, .05);
      chain.highEq.gain.setTargetAtTime(0, now, .05);
    }
    if (runtime.incoming !== current) {
      releaseMusicAudio(runtime.incoming);
    }
    if (runtime.outgoing !== current) {
      releaseMusicAudio(runtime.outgoing);
    }
    activeTransitionRef.current = null;
    setTransitionDisplay(null);
    stopTransitionCoordinator();
    seamlessTransitionRef.current = false;
    pendingAdvanceRef.current = false;
    notifySystem(reason === "seek" ? "已按新的进度重算潜流" : reason === "pause" ? "潜流已随播放暂停" : "旧的衔接计划已取消", "warning", "不会让过期计划影响当前歌曲");
  }

  const unavailableTransitionAnalysis = (trackId: string, duration: number): TrackAnalysis => ({
    version: 3, trackId, duration, effectiveStart: 0, effectiveEnd: Math.max(.1, duration), bpm: 0,
    tempoConfidence: 0, tempoStable: false, beats: [], downbeats: [], meter: null, beatGridConfidence: 0,
    phraseBoundaries: [], phraseConfidence: 0, sections: [], key: null, keyConfidence: 0, chromaByBar: [],
    integratedLufs: null, truePeakDb: null, shortTermLoudnessByBar: [], energyByBar: [], bassEnergyByBar: [],
    vocalProbabilityByBar: [], spectralFluxByBar: [], safeInCues: [], safeOutCues: [], analysisConfidence: 0,
    visualCues: [], featureFrames: [], waveform: [], introFocus: "full", outroFocus: "full", introConfidence: 0,
    outroConfidence: 0, beatOffset: 0,
  });

  async function transitionToTrack(next: QQTrack, nextIndex: number, reason: TransitionRuntime["reason"], outgoingTrackKey = activeQQTrackLiveRef.current?.mid || "") {
    const outgoing = musicAudioRef.current;
    const outgoingTrack = activeQQTrackLiveRef.current;
    if (!outgoing || !outgoingTrack || !outgoing.src || !outgoingTrackKey) return startQQTrack(next);
    if (activeTransitionRef.current || seamlessTransitionRef.current) abortActiveTransition("manual-track");
    const requestId = ++transitionRequestRef.current;
    const requestedTransitionId = `transition-${++transitionSequenceRef.current}`;
    const wasPlaying = !outgoing.paused;
    seamlessTransitionRef.current = true;
    playbackFadeRef.current += 1;
    let incoming: HTMLAudioElement | null = null;
    let runtime: TransitionRuntime | null = null;
    let transitionId = requestedTransitionId;
    notifySystem(reason === "automatic" ? "潜流正在准备交接" : "正在接住你的选择", "analysis", `${outgoingTrack.title} → ${next.title}`);
    try {
      if (reason === "automatic" && (userPausedRef.current || outgoing.paused || outgoing.ended)) throw new Error("TRANSITION_WINDOW_MISSED");
      await resumeMusicAudioGraph();
      const prepared = await prepareTrack(next, true);
      if (requestId !== transitionRequestRef.current) throw new Error("STALE_TRANSITION");
      if (!prepared?.playback.url || !prepared.audio) throw new Error("TRANSITION_SOURCE_UNAVAILABLE");
      if (reason === "automatic" && playQueueRef.current[nextIndex]?.mid !== next.mid) throw new Error("STALE_TRANSITION_PLAN");
      incoming = prepared.audio;
      pendingTransitionAudioRef.current = { requestId, audio: incoming };
      preparedTracksRef.current.delete(next.mid);
      const incomingLyricsPromise = window.codioDesktop?.qqMusic.lyrics(next).catch(() => [] as LyricLine[]) || Promise.resolve([] as LyricLine[]);
      const outgoingAnalysis = analysisForAudio(outgoingTrackKey, outgoing);
      // Next analysis was already requested at track start. Do not start a late
      // full decode in the last second; a verified tail can bridge without BPM.
      const incomingAnalysis = analysisForAudio(next.mid, incoming);
      const boundaryPlan = outgoingAnalysis ? planSilenceHandoff(outgoingAnalysis, incomingAnalysis, next.mid, requestedTransitionId) : null;
      if (reason === "automatic" && (!outgoingAnalysis || !incomingAnalysis) && !boundaryPlan) throw new Error("TRANSITION_ANALYSIS_UNAVAILABLE");
      const outgoingSnapshotAnalysis = outgoingAnalysis || unavailableTransitionAnalysis(outgoingTrackKey, outgoing.duration || outgoingTrack.durationSeconds);
      const incomingSnapshotAnalysis = incomingAnalysis || unavailableTransitionAnalysis(next.mid, next.durationSeconds);
      const pairKey = transitionPairKey(outgoingTrackKey, next.mid);
      let plan = null as TransitionPlan | null;
      if (outgoingAnalysis && incomingAnalysis) {
        plan = planTransition(outgoingAnalysis, incomingAnalysis, requestedTransitionId);
        setBoundedCache(transitionPlansRef.current, pairKey, plan, 36);
      }
      plan = plan || boundaryPlan;
      plan = plan
        ? adaptTransitionPlan(plan, reason, !wasPlaying)
        : createNeutralTransitionPlan(outgoingTrackKey, next.mid, requestedTransitionId, reason === "automatic" ? "manual-next" : reason, !wasPlaying);
      if (!isTransitionPlanUsable({ ...plan, confidence: Math.max(.18, plan.confidence) }, outgoingTrackKey, next.mid)) throw new Error("STALE_TRANSITION_PLAN");
      transitionId = `${plan.id}-${requestId}`;
      plan = { ...plan, id: transitionId };
      incoming.preservesPitch = true;
      outgoing.preservesPitch = true;
      incoming.volume = 0;
      const outgoingChain = connectMusicAnalyser(outgoing);
      const incomingChain = connectMusicAnalyser(incoming);
      const context = audioContextRef.current;
      if (!outgoingChain || !incomingChain || !context) throw new Error("AUDIO_GRAPH_UNAVAILABLE");
      incomingChain.gain.gain.value = 0;
      incoming.volume = 1;
      wireMusicAudio(incoming, next.mid);
      if (incoming.readyState < 1) await withTimeout(new Promise<void>((resolve, reject) => {
        incoming?.addEventListener("loadedmetadata", () => resolve(), { once: true });
        incoming?.addEventListener("error", () => reject(new Error("TRANSITION_METADATA_ERROR")), { once: true });
      }), 3500, "TRANSITION_METADATA");
      if (requestId !== transitionRequestRef.current) throw new Error("STALE_TRANSITION");
      const validatedOutgoing = analysisForAudio(outgoingTrackKey, outgoing);
      if (outgoingAnalysis && validatedOutgoing !== outgoingAnalysis) throw new Error("TRANSITION_SOURCE_CHANGED");
      const validatedIncoming = analysisForAudio(next.mid, incoming);
      if (incomingAnalysis && !validatedIncoming) throw new Error("TRANSITION_SOURCE_CHANGED");
      incoming.currentTime = reason === "automatic" ? Math.max(0, plan.incomingCue) : Math.max(0, incomingSnapshotAnalysis.effectiveStart);
      incoming.dataset.codioTransition = transitionId;
      incoming.playbackRate = plan.incomingTempoRatio;
      outgoing.playbackRate = plan.outgoingTempoRatio;
      if (reason === "automatic" && (userPausedRef.current || outgoing.paused || outgoing.ended)) throw new Error("TRANSITION_WINDOW_MISSED");
      // The first intro samples must already be audible while play() settles.
      incomingChain.gain.gain.setValueAtTime(plan.incomingGainCurve[0], context.currentTime);
      incomingChain.lowEq.gain.setValueAtTime(-16 * (1 - plan.incomingLowCurve[0]), context.currentTime);
      incomingChain.midEq.gain.setValueAtTime(-9 * (1 - plan.incomingMidCurve[0]), context.currentTime);
      incomingChain.highEq.gain.setValueAtTime(-8 * (1 - plan.incomingHighCurve[0]), context.currentTime);
      await withTimeout(incoming.play(), 8000, "TRANSITION_AUDIO_START");
      if (!wasPlaying) incoming.pause();
      if (requestId !== transitionRequestRef.current) throw new Error("STALE_TRANSITION");
      const duration = reason === "automatic"
        ? Math.min(plan.transitionDuration, Math.max(.1, outgoingSnapshotAnalysis.effectiveEnd - outgoing.currentTime - .04))
        : plan.transitionDuration;
      if (duration < .25) throw new Error("TRANSITION_WINDOW_MISSED");
      const startAt = context.currentTime + .02;
      runtime = {
        id: transitionId, state: "phase-locking", plan, outgoing, incoming,
        outgoingSnapshot: { track: outgoingTrack, cover: currentCoverDataLiveRef.current || outgoingTrack.cover || "", lyrics: lyricLinesLiveRef.current.trackId === outgoingTrack.mid ? lyricLinesLiveRef.current.lines : [], analysis: outgoingSnapshotAnalysis },
        incomingSnapshot: { track: next, cover: prepared.coverData || next.cover || "", lyrics: [], analysis: incomingSnapshotAnalysis },
        audioStartAt: startAt, duration, switchPoint: plan.switchPoint, settlingDuration: transitionSettlingDuration(plan.strategy),
        reason, committed: false,
      };
      activeTransitionRef.current = runtime;
      if (pendingTransitionAudioRef.current?.requestId === requestId) pendingTransitionAudioRef.current = null;
      setTransitionDisplay({ id: runtime.id, outgoing: runtime.outgoingSnapshot, incoming: runtime.incomingSnapshot, outgoingLyric: lyricAtTime(runtime.outgoingSnapshot.lyrics, outgoing.currentTime), incomingLyric: "" });
      void incomingLyricsPromise.then((lines) => {
        if (activeTransitionRef.current?.id !== transitionId) return;
        runtime!.incomingSnapshot.lyrics = lines;
        // Lyrics may arrive after the deck commits. Publish only to the still
        // authoritative incoming song, never a superseding selection/runtime.
        if (runtime!.committed && activeTransitionRef.current === runtime && musicAudioRef.current === incoming && activeQQTrackLiveRef.current?.mid === next.mid) {
          lyricLinesLiveRef.current = { trackId: next.mid, lines };
          setLyricLines(lines);
        }
        setTransitionDisplay((current) => current?.id === transitionId ? { ...current, incoming: runtime!.incomingSnapshot, incomingLyric: lyricAtTime(lines, incoming!.currentTime) } : current);
      });
      runtime.state = "mixing";
      if (wasPlaying) {
        scheduleDeckPlan(outgoingChain, plan, "outgoing", startAt, duration);
        scheduleDeckPlan(incomingChain, plan, "incoming", startAt, duration);
        if (plan.strategy === "phrase-eq-blend") lockTransitionBeats(runtime);
      }
      const commitIncoming = () => {
        if (!runtime || runtime.committed || activeTransitionRef.current?.id !== transitionId) return;
        runtime.committed = true;
        runtime.state = "committed";
        settleCurrentListening(reason === "automatic" ? "ended" : "switch");
        musicAudioRef.current = incoming;
        analyserRef.current = incomingChain.analyser;
        activeQQTrackLiveRef.current = next;
        currentCoverDataLiveRef.current = prepared.coverData;
        const committedIndex = playQueueRef.current.findIndex((item) => item.mid === next.mid);
        const queueIndex = committedIndex >= 0 ? committedIndex : nextIndex;
        setActiveQueueIndex(queueIndex);
        activeQueueIndexRef.current = queueIndex;
        setActiveQQTrack(next);
        setCurrentCoverData(prepared.coverData);
        setPlaybackQuality(prepared.playback.quality || "QQ MUSIC");
        setProgress(Math.min(100, (incoming!.currentTime / Math.max(.1, incomingSnapshotAnalysis.effectiveEnd)) * 100));
        setPlaybackTime({ current: incoming!.currentTime, duration: incomingSnapshotAnalysis.effectiveEnd });
        lyricLinesLiveRef.current = { trackId: next.mid, lines: runtime.incomingSnapshot.lyrics };
        setLyricLines(runtime.incomingSnapshot.lyrics);
        setIsPlaying(wasPlaying);
        rememberPlayedTrack(next, prepared.coverData);
        beginListeningForTrack(next, recommendationSourceForTrack(next));
        seamlessAttemptedRef.current = null;
        armPlaybackBoundaryCheck();
      };
      startTransitionCoordinator(runtime, commitIncoming);
      await waitForTransitionAudioEnd(context, startAt + duration + .02, transitionId, startAt + duration * plan.switchPoint, commitIncoming);
      commitIncoming();
      if (activeTransitionRef.current?.id !== transitionId) return "played" as const;
      releaseMusicAudio(outgoing);
      incoming.playbackRate = plan.incomingTempoRatio;
      const finishAt = context.currentTime;
      for (const parameter of [incomingChain.lowEq.gain, incomingChain.midEq.gain, incomingChain.highEq.gain]) {
        holdAudioParam(parameter, finishAt);
        parameter.linearRampToValueAtTime(0, finishAt + Math.min(.8, runtime.settlingDuration));
      }
      incomingChain.gain.gain.cancelScheduledValues(finishAt);
      incomingChain.gain.gain.setTargetAtTime(wasPlaying ? 1 : 0, finishAt, .04);
      holdTransitionDuringSettling(runtime);
      const recoveryDuration = Math.max(9000, Math.min(24000, 32 * 60 / Math.max(70, incomingSnapshotAnalysis.bpm || 96) * 1000));
      if (wasPlaying) window.setTimeout(() => relaxPlaybackRate(incoming!, plan!.incomingTempoRatio, transitionId, recoveryDuration), 1800);
      await waitForTransitionAudioEnd(context, finishAt + runtime.settlingDuration, transitionId);
      if (activeTransitionRef.current?.id === transitionId) runtime.state = "completed";
      stopTransitionCoordinator();
      prepareUpcomingTrack(next.mid);
      notifySystem(`${next.title} · 已接稳`, "success", plan.boundaryHandoff ? "已按确认的有声尾端交接；下一首前奏从可闻增益进入" : reason === "automatic" ? "结构、节拍与视觉已完成交接" : "你的选择已成为当前播放");
      return "played" as const;
    } catch {
      if (requestId !== transitionRequestRef.current) {
        if (incoming && incoming !== musicAudioRef.current && incoming !== activeTransitionRef.current?.incoming && incoming !== activeTransitionRef.current?.outgoing) releaseMusicAudio(incoming);
        return "unavailable" as const;
      }
      const committed = runtime?.committed && musicAudioRef.current === incoming;
      if (!committed) {
        if (incoming) {
          releaseMusicAudio(incoming);
        }
        musicAudioRef.current = outgoing;
        analyserRef.current = analyserNodesRef.current.get(outgoing)?.analyser || analyserRef.current;
        outgoing.playbackRate = 1;
        const chain = connectMusicAnalyser(outgoing);
        const context = audioContextRef.current;
        if (chain && context) {
          const now = context.currentTime;
          holdAudioParam(chain.gain.gain, now);
          chain.gain.gain.linearRampToValueAtTime(wasPlaying ? 1 : 0, now + .12);
          for (const parameter of [chain.lowEq.gain, chain.midEq.gain, chain.highEq.gain]) {
            holdAudioParam(parameter, now);
            parameter.linearRampToValueAtTime(0, now + .2);
          }
        }
      }
      if (runtime && activeTransitionRef.current?.id === transitionId) runtime.state = "fallback";
      notifySystem("这次切换没有接管当前播放", "warning", "原歌曲、封面、歌词和进度都已保留");
      return "unavailable" as const;
    } finally {
      if (pendingTransitionAudioRef.current?.requestId === requestId) pendingTransitionAudioRef.current = null;
      if (activeTransitionRef.current?.id === transitionId) activeTransitionRef.current = null;
      setTransitionDisplay((current) => current?.id === transitionId ? null : current);
      if (requestId === transitionRequestRef.current) seamlessTransitionRef.current = false;
      if (!activeTransitionRef.current) stopTransitionCoordinator();
      const outgoingEnd = analysisForAudio(outgoingTrackKey, outgoing)?.effectiveEnd || outgoing.duration;
      const needsFallback = requestId === transitionRequestRef.current && reason === "automatic" && !userPausedRef.current && (pendingAdvanceRef.current || outgoing.ended || outgoing.currentTime >= outgoingEnd - .16);
      if (requestId === transitionRequestRef.current) pendingAdvanceRef.current = false;
      if (needsFallback && musicAudioRef.current === outgoing) advanceFromFinishedAudio(outgoing);
    }
  }

  async function beginSeamlessCrossfade(outgoingTrackKey: string) {
    const queue = playQueueRef.current;
    if (seamlessTransitionRef.current || queue.length < 2) return;
    const nextIndex = activeQueueIndexRef.current + 1;
    const next = queue[nextIndex];
    if (!next) return;
    await transitionToTrack(next, nextIndex, "automatic", outgoingTrackKey);
  }

  function rememberPlayedTrack(track: QQTrack, resolvedCover?: string) {
    const item: PlayedTrack = {
      id: track.mid || track.id,
      title: track.title,
      artist: track.artist,
      cover: resolvedCover || track.cover,
      fallbackCover: track.fallbackCover,
    };
    setPlayedHistory((history) => {
      const next = [...history.filter((entry) => entry.id !== item.id), item].slice(-5);
      window.localStorage.setItem("codio-played-history", JSON.stringify(next));
      return next;
    });
  }

  async function startQQTrack(track: QQTrack, retries = 1, resumeAt = 0): Promise<"played" | "unavailable" | "auth" | "superseded"> {
    const selectionRequest = playbackRequestRef.current;
    const transportRevision = playbackToggleRef.current.revision;
    const currentRequest = () => selectionRequest === playbackRequestRef.current && transportRevision === playbackToggleRef.current.revision && !userPausedRef.current;
    if (activeTransitionRef.current || seamlessTransitionRef.current) abortActiveTransition("manual-track");
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop) {
      setToast("请在 CODIO 桌面版中连接 QQ 音乐后播放");
      return "unavailable";
    }
    userPausedRef.current = false;
    playbackToggleRef.current.pending = true;
    sourceWarmRef.current.controller?.abort();
    const requestedAt = playbackRequestRef.current?.id === track.mid ? playbackRequestRef.current.at : performance.now();
    const audioGraphReady = await resumeMusicAudioGraph();
    const cachedEntry = preparedTracksRef.current.get(track.mid);
    notifySystem(cachedEntry ? `${track.title} · READY` : "正在请求播放连接", cachedEntry ? "ready" : "analysis", cachedEntry ? "已准备播放 URL；不代表整首音频已缓冲" : "QQ Music · 保留你的选择顺序");
    seamlessAttemptedRef.current = null;
    pendingAdvanceRef.current = false;
    let attemptedAudio: HTMLAudioElement | null = null;
    startingTrackRef.current = track.mid;
    try {
      const preparedEntry = cachedEntry && Date.now() < (cachedEntry.expiresAt ?? cachedEntry.createdAt + PREPARED_TRACK_TTL_MS) ? cachedEntry : null;
      if (cachedEntry && !preparedEntry) discardPreparedEntry(cachedEntry);
      const prepared = preparedEntry ? await withTimeout(preparedEntry.promise, 12500, "PREPARED_TRACK") : null;
      preparedTracksRef.current.delete(track.mid);
      const coverPromise = prepared?.coverPromise || withTimeout(resolveTrackCover(track, desktop), 2200, "TRACK_COVER").catch(() => track.cover || "");
      const playback = prepared?.playback || await withTimeout(desktop.play(track), 12000, "TRACK_PLAYBACK");
      let coverData = prepared?.coverData || track.cover || "";
      void coverPromise.then(resolved => { if (resolved) coverData = resolved; });
      if (!currentRequest()) {
        if (prepared?.audio && prepared.audio !== musicAudioRef.current) releaseMusicAudio(prepared.audio);
        return "superseded";
      }
      if (!playback.playable || !playback.url) {
        if (playback.requiresLogin) {
          setQQConnection("needs-auth");
          setImportSource("qq");
          setImportState("idle");
          setImportOpen(true);
        }
        setBoundedCache(failedTracksRef.current, track.mid, Date.now(), 64);
        notifySystem("这首歌暂时无法播放", "error", playback.message || "不会把不可播放歌曲继续留在当前队列");
        if (!musicAudioRef.current?.src) setIsPlaying(false);
        return playback.requiresLogin ? "auth" : "unavailable";
      }
      const previousAudio = musicAudioRef.current;
      const audio = prepared?.audio || new Audio();
      audioElementsRef.current.add(audio);
      attemptedAudio = audio;
      audio.preload = "auto";
      audio.crossOrigin = "anonymous";
      const buffered = bufferedSourcesRef.current.get(track.mid);
      const byteCacheHit = Boolean(buffered && buffered.source === playback.url && Date.now() < buffered.expiresAt);
      if (byteCacheHit) audio.src = buffered!.url;
      else if (!prepared?.audio) audio.src = playback.url;
      audio.dataset.codioSource = playback.url;
      audio.volume = 0;
      if (audioGraphReady) connectMusicAnalyser(audio);
      wireMusicAudio(audio, track.mid);
      if (resumeAt > .5) {
        await withTimeout(new Promise<void>((resolve) => {
          if (audio.readyState >= 1) resolve();
          else audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
        }), 4500, "AUDIO_METADATA").catch(() => {});
        if (Number.isFinite(audio.duration) && audio.duration > 1) audio.currentTime = Math.min(resumeAt, audio.duration - 1);
      }
      await withTimeout(audio.play(), 10000, "AUDIO_START");
      if (!currentRequest()) { releaseMusicAudio(audio); attemptedAudio = null; return "superseded"; }
      const mediaStartedMs = Math.max(0, performance.now() - requestedAt);
      window.codioPlaybackDiagnostics = [...(window.codioPlaybackDiagnostics || []), {
        trackId: track.mid, outcome: "media_started", mediaStartedMs: Math.round(mediaStartedMs), byteCacheHit,
        preparedUrlHit: Boolean(prepared), readyState: audio.readyState,
        bufferedSeconds: audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0,
        measurement: "play promise resolved, not a microphone measurement of speaker output" }].slice(-24);
      userPausedRef.current = false;
      if (previousAudio && previousAudio !== audio) {
        if (listeningSessionRef.current?.track.mid !== track.mid) settleCurrentListening("switch");
        releaseMusicAudio(previousAudio);
      }
      musicAudioRef.current = audio;
      activeQQTrackLiveRef.current = track;
      currentCoverDataLiveRef.current = coverData;
      setActiveQQTrack(track);
      setCurrentCoverData(coverData);
      setPlaybackQuality(playback.quality || "QQ MUSIC");
      setProgress(resumeAt > .5 && Number.isFinite(audio.duration) ? Math.min(100, audio.currentTime / audio.duration * 100) : 0);
      setPlaybackTime({ current: audio.currentTime, duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : track.durationSeconds });
      setIsPlaying(true);
      armPlaybackBoundaryCheck();
      if (!listeningSessionRef.current || listeningSessionRef.current.track.mid !== track.mid) beginListeningForTrack(track, recommendationSourceForTrack(track));
      failedTracksRef.current.delete(track.mid);
      rememberPlayedTrack(track, coverData);
      void coverPromise.then(resolved => {
        // A transport pause must not discard this song's artwork. Selection
        // revision, exact media and identity reject results for replaced songs.
        if (!resolved || selectionRequest !== playbackRequestRef.current || musicAudioRef.current !== audio
          || activeQQTrackLiveRef.current?.mid !== track.mid || currentCoverDataLiveRef.current === resolved) return;
        currentCoverDataLiveRef.current = resolved;
        setCurrentCoverData(resolved);
        rememberPlayedTrack(track, resolved);
      });
      const analysisPromise = analyseTrackWhenBuffered(track.mid, playback.url, audio);
      void analysisPromise.then((result) => {
        if (result && musicAudioRef.current === audio && analysisForAudio(track.mid, audio)) {
          setPlaybackTime({ current: audio.currentTime, duration: result.effectiveEnd });
          prepareUpcomingTrack(track.mid);
        }
      });
      const targetVolume = getPlayerVolumeScalar();
      const faded = await fadeMusicVolume(audio, audioGraphReady ? 1 : targetVolume, 620);
      if (!faded && currentRequest() && musicAudioRef.current === audio && !seamlessTransitionRef.current && !audioGraphReady) audio.volume = targetVolume;
      if (currentRequest()) notifySystem(`${track.title} · ${playback.quality || "QQ MUSIC"}`, "success", byteCacheHit ? "已复用完整音频字节缓存" : prepared ? "已复用可用播放连接" : "播放连接已稳定");
      prepareUpcomingTrack(track.mid);
      return "played";
    } catch {
      if (attemptedAudio) {
        releaseMusicAudio(attemptedAudio);
      }
      if (!currentRequest()) return "superseded";
      if (retries > 0) {
        preparedTracksRef.current.delete(track.mid);
        setToast("第一次连接没有响应，正在重新接入这一首");
        await new Promise((resolve) => window.setTimeout(resolve, 320));
        return startQQTrack(track, retries - 1, resumeAt);
      }
      setBoundedCache(failedTracksRef.current, track.mid, Date.now(), 64);
      if (listeningSessionRef.current?.track.mid === track.mid) settleCurrentListening("error");
      if (!musicAudioRef.current?.src) setIsPlaying(false);
      setToast("这首暂时接不上，Codio 会继续找下一首");
      return "unavailable";
    } finally {
      if (startingTrackRef.current === track.mid) startingTrackRef.current = null;
      if (transportRevision === playbackToggleRef.current.revision) playbackToggleRef.current.pending = false;
    }
  }

  async function selectQQTrack(track: QQTrack, queueOverride?: QQTrack[]) {
    playbackRequestRef.current = { id: track.mid, at: performance.now() };
    initialRecommendationRef.current = true;
    const sourceQueue = queueOverride?.length ? queueOverride : searchResults.length ? searchResults : [track];
    const candidateQueue = [activeQQTrackLiveRef.current, ...sourceQueue, ...(queueOverride?.length ? [] : Object.values(recommendationTracks))].filter((item): item is QQTrack => Boolean(item));
    const selectedKey = recommendationIdentity(track);
    const uniqueQueue = new Map<string, QQTrack>();
    candidateQueue.forEach((item) => {
      const key = recommendationIdentity(item);
      if (key === selectedKey) uniqueQueue.set(key, track);
      else if (!uniqueQueue.has(key)) uniqueQueue.set(key, item);
    });
    if (!uniqueQueue.has(selectedKey)) uniqueQueue.set(selectedKey, track);
    const queue = [...uniqueQueue.values()];
    setPlayQueue(queue);
    playQueueRef.current = queue;
    const selectedIndex = Math.max(0, queue.findIndex((item) => recommendationIdentity(item) === selectedKey));
    setSearchOpen(false);
    setSearchQuery("");
    manualSelectionRef.current = track.mid;
    notifySystem("正在选择歌曲", "analysis", "准备播放连接；尚未确认播放成功");
    try {
      if (activeQQTrackLiveRef.current?.mid === track.mid && musicAudioRef.current?.src) {
        if (musicAudioRef.current.paused) await togglePlayback();
        return Boolean(musicAudioRef.current?.src && !musicAudioRef.current.paused && !musicAudioRef.current.ended && !musicAudioRef.current.error);
      }
      const activeAudio = musicAudioRef.current;
      let result = activeAudio?.src && !activeAudio.paused && activeQQTrackLiveRef.current
        ? await transitionToTrack(track, selectedIndex, "manual-select")
        : await startQQTrack(track);
      // A stale prepared URL or an unavailable transition analysis must not
      // turn a deliberate selection into a dead click. Retry the same song
      // once through the fresh direct playback path before reporting failure.
      if (result === "unavailable") {
        preparedTracksRef.current.delete(track.mid);
        result = await startQQTrack(track, 1);
      }
      if (result === "played") {
        setActiveQueueIndex(selectedIndex);
        activeQueueIndexRef.current = selectedIndex;
      } else if (result === "unavailable") {
        setToast("这首歌暂时没有可用播放连接，当前播放没有被替换");
      }
      return result === "played";
    } finally {
      if (manualSelectionRef.current === track.mid) manualSelectionRef.current = null;
    }
  }

  function recommendationQueueFor(selected: QQTrack) {
    const seen = new Set<string>();
    const songKey = recommendationIdentity;
    const lane = visibleExperiments.some(item => recommendationIdentity(item) === songKey(selected)
      || recommendationTracks[recommendationIdentity(item)]?.mid === selected.mid) ? "frontier" : "match";
    const visible = lane === "match" ? matchedExperiments : visibleExperiments;
    const catalogQueue = [...visible, ...recommendationCatalogRef.current.filter(item => item.lane === lane)]
      .map((item) => recommendationTracks[recommendationIdentity(item)])
      .filter((track): track is QQTrack => Boolean(track))
      .filter((track) => {
        const key = songKey(track);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!seen.has(songKey(selected))) catalogQueue.unshift(selected);
    return catalogQueue;
  }

  async function extendRecommendationQueue(seed: QQTrack) {
    if (queueExtensionPromiseRef.current) return queueExtensionPromiseRef.current;
    const lane: RecommendationLane = recommendationSourceForTrack(seed) === "recommendation_frontier" ? "frontier" : "match";
    const currentId = activeQQTrackLiveRef.current?.mid, revision = recommendationUpdateRef.current.revision;
    const extension = (async () => {
      await refreshRecommendationLane(lane, "feedback", revision, ["continuation"]);
      if (revision !== recommendationUpdateRef.current.revision || activeQQTrackLiveRef.current?.mid !== currentId) return playQueueRef.current;
      return playQueueRef.current;
    })().finally(() => { if (queueExtensionPromiseRef.current === extension) queueExtensionPromiseRef.current = null; });
    queueExtensionPromiseRef.current = extension;
    return extension;
  }

  async function enqueueNext(track: QQTrack) {
    const current = activeQQTrackLiveRef.current || activeQQTrack;
    const transitioningTo = activeTransitionRef.current?.incomingSnapshot.track;
    const automaticPending = seamlessTransitionRef.current && seamlessAttemptedRef.current === current?.mid
      ? playQueueRef.current[activeQueueIndexRef.current + 1] : null;
    if (current?.mid === track.mid || transitioningTo?.mid === track.mid || automaticPending?.mid === track.mid) {
      setToast("This song is already playing");
      return;
    }
    const requestedKey = recommendationIdentity(track);
    const base = playQueueRef.current.filter((item) => recommendationIdentity(item) !== requestedKey);
    let currentIndex = current ? base.findIndex((item) => item.mid === current.mid) : -1;
    if (current && currentIndex < 0) {
      base.unshift(current);
      currentIndex = 0;
    }
    const automaticIncoming = automaticPending ? base.find((item) => item.mid === automaticPending.mid) : null;
    const insertionAnchor = transitioningTo || automaticIncoming || current;
    const insertionIndex = insertionAnchor ? base.findIndex((item) => item.mid === insertionAnchor.mid) : -1;
    base.splice(Math.max(currentIndex, insertionIndex) + 1, 0, track);
    manualQueueIdsRef.current.add(track.mid);
    setPlayQueue(base);
    playQueueRef.current = base;
    setActiveQueueIndex(currentIndex);
    activeQueueIndexRef.current = currentIndex;
    setToast(`UP NEXT · ${track.title}`);
    seamlessAttemptedRef.current = null;
    const audio = musicAudioRef.current;
    if (!activeQQTrackLiveRef.current || !audio?.src || audio.paused || audio.ended) {
      const selectedIndex = Math.max(0, base.findIndex((item) => item.mid === track.mid));
      manualSelectionRef.current = track.mid;
      setSearchOpen(false);
      setSearchQuery("");
      try {
        const result = await startQQTrack(track, 1);
        if (result === "played") {
          setActiveQueueIndex(selectedIndex);
          activeQueueIndexRef.current = selectedIndex;
        }
      } finally {
        manualSelectionRef.current = null;
      }
      return;
    }
    prepareUpcomingTrack(activeQQTrackLiveRef.current.mid);
  }

  async function nextTrack(fromEnded = false) {
    if (fromEnded && userPausedRef.current) return;
    let queue = playQueueRef.current;
    const currentTrack = activeQQTrackLiveRef.current || activeQQTrack;
    if (queue.length && currentTrack && activeQueueIndexRef.current >= queue.length - 3) {
      void extendRecommendationQueue(currentTrack);
    }
    let attempted = 0;
    const maxAttempts = 8;
    const tryQueue = async (candidates: QQTrack[], startIndex: number) => {
      const now = Date.now();
      for (let nextIndex = Math.max(0, startIndex + 1); nextIndex < candidates.length && attempted < maxAttempts; nextIndex += 1) {
        if (fromEnded && userPausedRef.current) return "superseded" as const;
        const candidate = candidates[nextIndex];
        if (!candidate || candidate.mid === currentTrack?.mid) continue;
        const failedAt = failedTracksRef.current.get(candidate.mid) || 0;
        if (now - failedAt < 75_000) continue;
        attempted += 1;
        let result = !fromEnded && musicAudioRef.current?.src && activeQQTrackLiveRef.current && !musicAudioRef.current.ended
          ? await transitionToTrack(candidate, nextIndex, "manual-next")
          : await startQQTrack(candidate);
        if (result === "unavailable" && !fromEnded) {
          preparedTracksRef.current.delete(candidate.mid);
          result = await startQQTrack(candidate, 1);
        }
        if (result === "played") {
          setActiveQueueIndex(nextIndex);
          activeQueueIndexRef.current = nextIndex;
        }
        if (result === "played" || result === "auth" || result === "superseded") return result;
      }
      return "unavailable" as const;
    };
    if (queue.length > 1) {
      const result = await tryQueue(queue, activeQueueIndexRef.current);
      if (result === "played" || result === "auth" || result === "superseded") return;
    }
    if (currentTrack && attempted < maxAttempts) {
      const previousLength = queue.length;
      // Search (8.5s) plus source and cover checks (12s + 2.2s) must finish before this bound.
      queue = await withTimeout(extendRecommendationQueue(currentTrack), 26000, "QUEUE_EXTENSION").catch(() => playQueueRef.current);
      if (fromEnded && userPausedRef.current) return;
      if (queue.length > previousLength) {
        const result = await tryQueue(queue, Math.max(-1, previousLength - 1));
        if (result === "played" || result === "auth" || result === "superseded") return;
      }
    }
    if (queue.length) {
      setIsPlaying(false);
      setToast("接下来的歌曲暂时没有可用音源，播放已暂停");
      return;
    }
    setActiveQQTrack(null);
    setTrackIndex((index) => (index + 1) % tracks.length);
    setProgress(0);
    setIsPlaying(false);
  }

  async function previousTrack() {
    const queue = playQueueRef.current;
    if (queue.length) {
      const previousIndex = (activeQueueIndexRef.current - 1 + queue.length) % queue.length;
      const candidate = queue[previousIndex];
      const result = musicAudioRef.current?.src && activeQQTrackLiveRef.current
        ? await transitionToTrack(candidate, previousIndex, "manual-previous")
        : await startQQTrack(candidate);
      if (result === "played") {
        setActiveQueueIndex(previousIndex);
        activeQueueIndexRef.current = previousIndex;
      }
      return;
    }
    setActiveQQTrack(null);
    setTrackIndex((index) => (index - 1 + tracks.length) % tracks.length);
    setProgress(0);
    setIsPlaying(false);
  }

  async function togglePlayback() {
    if (activeTransitionRef.current || pendingTransitionAudioRef.current || seamlessTransitionRef.current) abortActiveTransition("pause");
    const audio = musicAudioRef.current;
    const transport = playbackToggleRef.current;
    const resume = transport.pending ? userPausedRef.current : Boolean(!audio?.src || audio.paused || audio.ended);
    const revision = ++transport.revision;
    transport.pending = true;
    userPausedRef.current = !resume;
    setIsPlaying(resume);
    playbackFadeCancelRef.current?.();
    playbackFadeRef.current += 1;
    const currentRequest = () => transport.revision === revision && musicAudioRef.current === audio;
    if (audio?.src && activeQQTrack) {
      try {
        if (resume) {
          const chain = analyserNodesRef.current.get(audio);
          // Start both within this user gesture. Waiting for context.resume()
          // first used to block media.play indefinitely and lose activation.
          const graphReady = chain ? resumeMusicAudioGraph() : Promise.resolve(true);
          const mediaReady = withTimeout(audio.play(), 4000, "AUDIO_RESUME");
          const [ready] = await Promise.all([graphReady, mediaReady]);
          if (!currentRequest() || userPausedRef.current) return;
          if (!ready) throw new Error("AUDIO_CONTEXT_RESUME_FAILED");
          await fadeMusicVolume(audio, chain ? 1 : getPlayerVolumeScalar(), 180);
          if (currentRequest() && !userPausedRef.current) armPlaybackBoundaryCheck();
        } else {
          const faded = await fadeMusicVolume(audio, 0, 120);
          if (faded && currentRequest() && userPausedRef.current) audio.pause();
        }
      } catch {
        if (currentRequest()) {
          userPausedRef.current = true;
          audio.pause();
          setIsPlaying(false);
          setToast("暂时无法恢复声音，请检查播放连接后再试；当前进度已保留");
        }
      } finally {
        if (transport.revision === revision) transport.pending = false;
      }
      return;
    }
    // A second click while the initial URL is loading cancels that start;
    // its old promise is not allowed to autoplay after this pause intention.
    if (!resume) { transport.pending = false; return; }
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop) {
      transport.pending = false;
      userPausedRef.current = true;
      setIsPlaying(false);
      setImportSource("qq");
      setImportState("idle");
      setImportOpen(true);
      setToast("连接 QQ 音乐后即可播放完整歌曲");
      return;
    }
    if (activeQQTrack) {
      await startQQTrack(activeQQTrack);
      if (transport.revision === revision) transport.pending = false;
      return;
    }
    try {
      const results = await desktop.search(`${currentTrack.title} ${currentTrack.artist}`);
      if (transport.revision !== revision || userPausedRef.current) return;
      if (results[0]) await selectQQTrack(results[0]);
      else setToast("QQ 音乐中没有找到这首歌");
    } catch {
      setToast("搜索失败，请检查 QQ 音乐连接");
    } finally {
      if (transport.revision === revision) { transport.pending = false; setIsPlaying(Boolean(musicAudioRef.current && !musicAudioRef.current.paused)); }
    }
  }

  useEffect(() => {
    const handlePlaybackShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== " ") || bootPhase !== "done") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input:not([type='range']), textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      void togglePlayback();
    };
    const blockSpaceRelease = (event: globalThis.KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== " ") || bootPhase !== "done") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input:not([type='range']), textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handlePlaybackShortcut, true);
    window.addEventListener("keyup", blockSpaceRelease, true);
    return () => {
      window.removeEventListener("keydown", handlePlaybackShortcut, true);
      window.removeEventListener("keyup", blockSpaceRelease, true);
    };
  }, [activeQQTrack?.mid, bootPhase, isPlaying]);

  function seekPlayback(value: number) {
    abortActiveTransition("seek");
    setProgress(value);
    const audio = musicAudioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      const effectiveDuration = playbackTime.duration > 0 ? Math.min(playbackTime.duration, audio.duration) : audio.duration;
      audio.currentTime = (value / 100) * effectiveDuration;
      setPlaybackTime({ current: audio.currentTime, duration: effectiveDuration });
    }
  }

  async function replyTo(value: string) {
    if (!isOfflineCodioShortcut(value)) return FULL_AI_REQUIRED;
    const text = value.trim().toLowerCase();
    const amount = text.match(/^(?:音量|声音)\s*(?:调到|设为|到)?\s*(\d{1,3})%?$/);
    const action = /^(暂停|暂停一下|停一下|先停|pause)$/.test(text) ? "pause"
      : /^(继续|继续播放|接着放|播放|play)$/.test(text) ? "play"
      : text === "上一首" ? "previous" : /下一首|换一首|换首歌|跳过/.test(text) ? "next" : null;
    const call: CodioToolCall = action ? { id: "offline-control", name: "control_playback", arguments: { action } }
      : { id: "offline-volume", name: "adjust_volume", arguments: amount ? { operation: "set", value: Number(amount[1]) }
        : { operation: /声音大|大一点|响一点/.test(text) ? "increase" : "decrease", value: 10 } };
    try {
      const result = await executeCodioTool(call, new Map(), value);
      if (!result.ok) return action ? "操作没有完成：还没有确认可播放的音源，请检查连接或选择歌曲。" : "没有确认电脑音量已改变，请检查声音设备后再试。";
      return action === "pause" ? "已暂停。" : action ? "已确认播放。" : `音量已设为 ${volumeRef.current}%。`;
    } catch { return "本地操作没有完成，当前状态已保留。"; }
  }


  const buildCodioContext = () => {
    const memory = listeningMemoryRef.current;
    const profile = deriveListeningProfile(memory);
    const active = activeQQTrackLiveRef.current;
    const queue = playQueueRef.current;
    const index = activeQueueIndexRef.current;
    const next = queue[index + 1];
    const audio = musicAudioRef.current;
    const activeScore = active ? recommendationScoresRef.current.get(canonicalTrackKey("qq", active.mid)) : undefined;
    const strongest = (values: Record<string, number> = {}, count = 8) => Object.fromEntries(
      Object.entries(values).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, count),
    );
    const layerSummary = (layer: typeof profile.lifetimeProfile) => ({
      evidenceCount: layer.evidenceCount, distinctTrackCount: layer.distinctTrackCount,
      artistAffinities: strongest(layer.artistAffinities), tagAffinities: strongest(layer.tagAffinities),
      tempoAffinities: strongest(layer.tempoAffinities, 4),
    });
    const latest = recommendationUpdateRef.current.latest;
    return {
      playback: {
        currentTrack: active ? { id: active.mid, title: active.title, artist: active.artist, album: active.album } : null,
        nextTrack: next ? { id: next.mid, title: next.title, artist: next.artist } : null,
        queue: queue.slice(Math.max(0, index), Math.max(0, index) + 12).map(({ mid, title, artist }) => ({ id: mid, title, artist })),
        playing: Boolean(audio && !audio.paused && !audio.ended),
        progressPercent: audio && audio.duration > 0 ? Math.round(audio.currentTime / audio.duration * 100) : Math.round(progress),
        volume: volumeRef.current,
        seamless: seamlessRef.current,
      },
      recommendations: {
        closeMatch: matchedExperiments.map(({ title, artist, reason }) => ({ title, artist, reason })),
        frontier: visibleExperiments.map(({ title, artist, reason }) => ({ title, artist, reason })),
        currentRecommendationScore: activeScore ? { candidateKey: activeScore.candidateKey, totalScore: activeScore.totalScore,
          contributions: activeScore.contributions.filter(item => item.signedWeight !== 0).slice(0, 12) } : null,
        currentRecommendationReasons: activeScore?.topReasons || [],
        latestUpdate: { status: latest.status, revision: latest.revision, profileVersion: latest.profileVersion,
          hiddenQueueCommitted: latest.hiddenQueueCommitted, visibleBatchPreserved: latest.visibleBatchPreserved,
          lanes: Array.isArray(latest.lanes) ? latest.lanes.map((lane: Record<string, unknown>) => ({ lane: lane.lane,
            status: lane.status, hiddenQueueCommitted: lane.hiddenQueueCommitted, error: lane.error })) : [] },
      },
      listening: {
        musicEvidenceCapabilities: { providerIdentity: true, verifiedSongGenres: "only explicit QQ song-detail labels; coarse metadata, not a measured sound model", calibratedCrossSongEnergy: false, measuredVocalRatio: false, timbreOrEmotionModel: false, harmonyAnalysis: false, tempo: "only when actual audio analysis has sufficient tempo confidence", artistPreferenceIsNotSoundSimilarity: true },
        profileConfidence: profile.confidence,
        lifetimeProfile: layerSummary(profile.lifetimeProfile),
        recentProfile: layerSummary(profile.recentProfile),
        contextualProfiles: Object.fromEntries(Object.entries(profile.contextualProfiles)
          .sort((a, b) => b[1].reliability - a[1].reliability).slice(0, 4)
          .map(([key, layer]) => [key, { ...layerSummary(layer), reliability: layer.reliability }])),
        sessionProfile: layerSummary(profile.sessionProfile),
        sessionIntent: profile.sessionIntent,
        hypotheses: profile.hypotheses,
        recentEffects: profile.recentEffects,
        recentCorrections: memory.corrections.slice(-12),
        activeFeedbackScopes: activePreferences(memory).slice(-12).map(({ targetType, targetKey, title, artist, value, scope, source, createdAt }) =>
          ({ targetType, targetKey, title, artist, value, scope, source, createdAt })),
        recentPlays: Object.values(memory.trackMemories).filter(item => (item.effectivePlayCount || 0) > 0)
          .sort((a, b) => (b.lastEffectiveAt || 0) - (a.lastEffectiveAt || 0)).slice(0, 6)
          .map(({ title, artist, lastEffectiveAt }) => ({ title, artist, lastEffectiveAt })),
        scope: "Top evidence and recent explicit choices only; not the full collection or raw feature snapshots",
      },
      library: { connected: qqConnection === "connected", trackCount: qqTasteSnapshotRef.current?.tracks.length || 0, likedCount: qqTasteSnapshotRef.current?.likedCount || 0, topArtists: qqTasteSnapshotRef.current?.topArtists.slice(0, 8) || [] },
      environment: { time: timeContext, weather: weatherContext },
        interface: { theme: "night", scene, particles: particleLevel, lyrics: lyricMode, nowPlayingOpen },
    };
  };

  const executeCodioTool = async (call: CodioToolCall, searchWhitelist: Map<string, QQTrack>, userText: string) => {
    const args = call.arguments;
    const policyError = validateCodioToolCall(call, {
      qqConnected: qqConnection === "connected",
      playbackReady: qqPlaybackReady,
      searchResultIds: [...searchWhitelist.keys()],
      searchResultArtists: [...new Set([...searchWhitelist.values()].map((track) => track.artist))],
      searchResultTracks: [...searchWhitelist.values()].map((track) => ({ id: track.mid, title: track.title, artist: track.artist })),
      userText,
      interface: {
        theme: "night",
        scene,
        particles: particleLevel,
        lyrics: lyricMode,
        panel: profileOpen ? "profile" : settingsOpen ? "settings" : nowPlayingOpen ? "now_playing" : djOpen ? "dj" : "close",
      },
    });
    if (policyError) return { ok: false, error: policyError };
    if (call.name === "control_playback") {
      const action = String(args.action || "");
      const before = { playing: Boolean(musicAudioRef.current?.src && !musicAudioRef.current.paused), track: activeQQTrackLiveRef.current?.mid || null };
      const request = playbackRequestRef.current;
      if (action === "play" && !before.playing) await togglePlayback();
      else if (action === "pause" && before.playing) await togglePlayback();
      else if (action === "next") await nextTrack();
      else if (action === "previous") await previousTrack();
      else if (!["play", "pause", "next", "previous"].includes(action)) return { ok: false, error: "INVALID_ACTION" };
      const audio = musicAudioRef.current, current = activeQQTrackLiveRef.current;
      const after = { playing: Boolean(audio?.src && !audio.paused && !audio.ended && !audio.error), track: current?.mid || null, action };
      const ok = action === "pause" ? !after.playing : action === "play" ? after.playing : after.playing && after.track !== before.track;
      const status = ok ? action === "pause" ? "paused" : "played" : startingTrackRef.current ? "preparing"
        : request !== playbackRequestRef.current ? "superseded" : current && !after.playing ? "selected_not_playing" : "no_source";
      return { ok, status, before, after, ...(ok ? {} : { error: current?.provider !== "local" && qqConnection !== "connected" ? "QQ_NOT_CONNECTED" : "PLAYBACK_NOT_CONFIRMED" }) };
    }
    if (call.name === "seek_playback") {
      const position = Number(args.position_percent);
      const audio = musicAudioRef.current;
      if (!audio || !Number.isFinite(position) || position < 0 || position > 100 || !Number.isFinite(audio.duration)) return { ok: false, error: "INVALID_SEEK" };
      const before = audio.currentTime;
      seekPlayback(position);
      return { ok: true, before, after: audio.currentTime };
    }
    if (call.name === "adjust_volume") {
      const operation = String(args.operation || ""); const amount = Number(args.value); const before = volumeRef.current;
      const valid = Number.isFinite(amount) && (operation === "set" ? amount >= 0 && amount <= 100 : ["increase", "decrease"].includes(operation) && amount >= 1 && amount <= 30);
      if (!valid) return { ok: false, error: "INVALID_VOLUME" };
      const after = Math.max(0, Math.min(100, operation === "set" ? amount : operation === "increase" ? before + amount : before - amount));
      return changeVolume(after);
    }
    if (call.name === "search_music") {
      setThinkingCue("正在 QQ 音乐核对歌曲与歌手");
      const query = String(args.query || "").trim(); const limit = args.limit === undefined ? 8 : Number(args.limit);
      if (!query || query.length > 120) return { ok: false, error: "INVALID_SEARCH_QUERY" };
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) return { ok: false, error: "INVALID_SEARCH_LIMIT" };
      if (qqConnection !== "connected") return { ok: false, error: "QQ_NOT_CONNECTED" };
      if (!window.codioDesktop?.qqMusic) return { ok: false, error: "SEARCH_UNAVAILABLE" };
      const results = (await window.codioDesktop.qqMusic.search(query, 1)).slice(0, limit);
      results.forEach((track) => searchWhitelist.set(track.mid, track));
      return { ok: true, query, results: results.map(({ mid, title, artist, album, durationSeconds }) => ({ track_id: mid, title, artist, album, durationSeconds })) };
    }
    if (call.name === "record_music_preference") {
      setThinkingCue("正在保存明确偏好到听歌画像");
      if (!listeningMemoryHydratedRef.current) return { ok: false, error: "PROFILE_NOT_READY" };
      const targetType = String(args.target_type || "");
      const value = String(args.value || "") as "more" | "less";
      const track = targetType === "track" ? searchWhitelist.get(String(args.track_id || "")) : undefined;
      const artist = targetType === "artist"
        ? [...searchWhitelist.values()].find((item) => item.artist.toLocaleLowerCase() === String(args.artist_name || "").toLocaleLowerCase())?.artist
        : track?.artist;
      if (targetType === "track" && !track) return { ok: false, error: "TRACK_ID_NOT_FROM_THIS_TURN" };
      if (targetType === "artist" && !artist) return { ok: false, error: "ARTIST_NOT_FROM_THIS_TURN" };
      if (track) {
        const identityError = verifyNamedTrackPreference(userText,
          { id: track.mid, title: track.title, artist: track.artist },
          [...searchWhitelist.values()].map((item) => ({ id: item.mid, title: item.title, artist: item.artist })),
        );
        if (identityError) return { ok: false, error: identityError };
      }
      const feature = targetType === "feature" && args.feature_key === "instrumental" ? "instrumental" : undefined;
      const targetKey = feature || (track ? canonicalTrackKey(track.provider || "qq", track.mid) : artist!);
      if (track && window.codioDesktop?.analysis && !trackAnalysisRef.current.has(track.mid)) {
        const cached = await withTimeout(window.codioDesktop.analysis.get(track.mid, 3), 1200, "PREFERENCE_ANALYSIS").catch(() => null);
        if (cached?.trackId === track.mid && cached.version === 3) setBoundedCache(recommendationAudioRef.current, track.mid, { bpm: cached.bpm, tempoConfidence: cached.tempoConfidence, outroFocus: cached.outroFocus }, 120);
      }
      const next = track ? writeTrackPreference(await enrichTrackMetadata(track), value, "track", "dj", "explicit_named_track") : updateListeningMemory({
        type: "preference_changed",
        eventId: `dj-preference-${crypto.randomUUID()}`,
        sessionId: listeningMemoryRef.current.currentSession.sessionId,
        targetType: targetType as "track" | "artist" | "feature",
        targetKey,
        value,
        scope: feature ? "style" : targetType as "track" | "artist",
        title: feature ? "纯音乐" : undefined,
        artist,
        source: "dj",
        createdAt: Date.now(),
      });
      if (value === "more") {
        const verified = targetType === "artist"
          ? [...searchWhitelist.values()].filter((item) => item.artist.toLocaleLowerCase() === artist?.toLocaleLowerCase())
          : track ? [track] : [];
        const known = new Set(discoveryPoolRef.current.map(recommendationIdentity));
        const additions: Experiment[] = [];
        verified.forEach((item) => {
          const identity = recommendationIdentity(item);
          discoveryTracksRef.current[identity] = item;
          if (known.has(identity)) return;
          known.add(identity);
          additions.push({
            provider: "qq", id: item.mid,
            title: item.title, artist: item.artist, cover: item.cover || "",
            reason: targetType === "track" ? "You explicitly liked this song" : "Verified artist you explicitly like",
            color: "violet", tags: [],
          });
        });
        if (additions.length) discoveryPoolRef.current = [...discoveryPoolRef.current, ...additions].slice(-260);
      }
      notifySystem("偏好已写入声音画像", "success", "后续重排已排队，尚未确认提交；可见列表保持不变");
      return {
        ok: true, targetType, targetKey, title: feature ? "纯音乐" : track?.title, artist, value,
        scope: feature ? "style" : targetType, persisted: true,
        ...(feature ? { featureKey: feature, evidencePolicy: "provider_annotation_or_metadata_only" } : {}),
        profileUpdated: activePreferences(next).some((item) => item.targetType === targetType && item.targetKey === targetKey && item.value === value),
        recommendationEffect: "queued", recommendationUpdate: recommendationUpdateRef.current.latest,
      };
    }
    if (call.name === "set_session_intent") {
      setThinkingCue("正在更新本次听歌方向");
      const existing = listeningMemoryRef.current.sessionIntent;
      const intent = createSessionIntent({
        familiarity: (args.familiarity || existing?.familiarity || "balanced") as SessionIntent["familiarity"],
        energy: (args.energy || existing?.energy || "balanced") as SessionIntent["energy"],
        flow: (args.flow || existing?.flow || "balanced") as SessionIntent["flow"],
      });
      updateListeningMemory({ type: "session_intent_changed", eventId: `dj-intent-${crypto.randomUUID()}`, sessionId: listeningMemoryRef.current.currentSession.sessionId, intent, createdAt: Date.now() });
      const energyReady = Object.values(recommendationTracksRef.current || {}).some(track => {
        const energy = featureVectorForTrack(track).energy;
        return energy.value !== null && energy.profileEligible && energy.confidence >= .6 && energy.source === "audio_analysis";
      });
      const limitation = intent.energy !== "balanced" && !energyReady ? "意图已保存，但当前候选缺少跨歌曲可比能量证据，无法可靠执行能量调整" : null;
      notifySystem("今晚的听歌意图已保存", "success", limitation || "后续重排已排队；长期画像保持不变");
      return { ok: true, intent, limitation, energyApplied: false, scope: "session", persisted: listeningMemoryHydratedRef.current, profileUpdated: false, lifetimeProfileUpdated: false, expiresAt: intent.expiresAt, recommendationEffect: "queued", recommendationUpdate: recommendationUpdateRef.current.latest };
    }
    if (call.name === "play_search_result") {
      const id = String(args.track_id || ""); const track = searchWhitelist.get(id);
      if (!track) return { ok: false, error: "TRACK_ID_NOT_FROM_THIS_TURN" };
      const selected = await selectQQTrack(track, [track, ...searchWhitelist.values()]);
      if (selected && activeQQTrackLiveRef.current?.mid === id && musicAudioRef.current?.paused) await togglePlayback();
      const playing = didRequestedTrackStart(Boolean(selected), id, activeQQTrackLiveRef.current?.mid, musicAudioRef.current?.paused);
      if (!selected || !playing) return { ok: false, error: "TRACK_PLAYBACK_FAILED" };
      return { ok: true, currentTrack: { id: track.mid, title: track.title, artist: track.artist } };
    }
    if (call.name === "set_seamless") {
      if (typeof args.enabled !== "boolean") return { ok: false, error: "INVALID_SEAMLESS" };
      const before = seamlessRef.current; seamlessRef.current = args.enabled; setSeamless(args.enabled);
      return { ok: true, before, after: args.enabled };
    }
    if (call.name === "rate_current_track") {
      const rating = String(args.rating || "");
      const explicit = rating === "like" ? /喜欢|不错|好听|like/i.test(userText) : /不喜欢|不好听|讨厌|dislike/i.test(userText);
      if (!explicit || !["like", "dislike"].includes(rating)) return { ok: false, error: "RATING_REQUIRES_EXPLICIT_USER_INTENT" };
      const track = activeQQTrackLiveRef.current;
      if (!track) return { ok: false, error: "NO_CURRENT_TRACK" };
      if (!listeningMemoryHydratedRef.current) return { ok: false, error: "PROFILE_NOT_READY" };
      const value = rating === "like" ? "more" : "less";
      const scope: PreferenceScope = rating === "dislike" && /今晚|今天|现在|此刻|暂时|这会儿|\b(?:tonight|today|for now)\b/i.test(userText) ? "session" : "track";
      const next = writeTrackPreference(track, value, scope, "dj", "explicit_current_track");
      const recorded = activePreferences(next).find(event => event.targetKey === canonicalTrackKey(track.provider || "qq", track.mid));
      return { ok: recorded?.value === value, rating, scope, persisted: true, profileUpdated: recorded?.value === value, recommendationEffect: "queued", recommendationUpdate: recommendationUpdateRef.current.latest };
    }
    if (call.name === "refresh_recommendations") { const update = await refreshRecommendations(); return { ok: update.status === "completed", recommendationUpdate: update, visibleCommitted: update.visibleCommitted === true, closeMatch: recommendationVisibleRef.current.matched.length, frontier: recommendationVisibleRef.current.frontier.length }; }
    if (call.name === "update_interface") {
      const keys = Object.keys(args);
      if (!keys.length || !keys.every((key) => ["theme", "scene", "particles", "lyrics", "panel"].includes(key))) return { ok: false, error: "INVALID_INTERFACE_UPDATE" };
      if ("theme" in args && args.theme !== "night") return { ok: false, error: "INVALID_THEME" };
      if ("scene" in args && !["night", "dawn", "deep"].includes(String(args.scene))) return { ok: false, error: "INVALID_SCENE" };
      if ("particles" in args && (!Number.isInteger(args.particles) || Number(args.particles) < 0 || Number(args.particles) > 2)) return { ok: false, error: "INVALID_PARTICLES" };
      if ("lyrics" in args && !["minimal", "cinematic"].includes(String(args.lyrics))) return { ok: false, error: "INVALID_LYRICS" };
      if ("panel" in args && !["profile", "settings", "now_playing", "dj", "close"].includes(String(args.panel))) return { ok: false, error: "INVALID_PANEL" };
      let changed = false;
      if (args.scene === "night" || args.scene === "dawn" || args.scene === "deep") { changed ||= args.scene !== scene; setScene(args.scene); }
      if (Number.isInteger(args.particles)) { const value = Number(args.particles); changed ||= value !== particleLevel; setParticleLevel(value); }
      if (args.lyrics === "minimal" || args.lyrics === "cinematic") { changed ||= args.lyrics !== lyricMode; setLyricMode(args.lyrics); }
      if (args.panel === "profile") { changed ||= !profileOpen; setProfileOpen(true); }
      else if (args.panel === "settings") { changed ||= !settingsOpen; setSettingsOpen(true); }
      else if (args.panel === "now_playing") { changed ||= !nowPlayingOpen; setNowPlayingOpen(true); }
      else if (args.panel === "dj") { changed ||= !djOpen; setDjOpen(true); }
      else if (args.panel === "close") { changed ||= profileOpen || settingsOpen || nowPlayingOpen || djOpen; setProfileOpen(false); setSettingsOpen(false); setNowPlayingOpen(false); setDjOpen(false); }
      if (!changed) return { ok: false, error: "INTERFACE_ALREADY_IN_REQUESTED_STATE" };
      return { ok: true, after: { theme: args.theme, scene: args.scene, particles: args.particles, lyrics: args.lyrics, panel: args.panel } };
    }
    return { ok: false, error: "UNKNOWN_TOOL" };
  };

  const runAgentTurn = async (userText: string, history: CodioAIMessage[]) => {
    const ai = window.codioDesktop?.ai;
    if (!ai) throw new Error("CODIO_MODEL_NOT_READY");
    const searchWhitelist = new Map<string, QQTrack>();
    const result = await runCodioAgentLoop({
      messages: history,
      context: buildCodioContext,
      step: (messages, context) => {
        setThinkingCue("等待 DeepSeek 根据真实状态与工具结果回复");
        return withTimeout(ai.step({ messages, context }), 60000, "CODIO_MODEL");
      },
      execute: (call) => executeCodioTool(call, searchWhitelist, userText),
      maxRounds: 4,
      maxActions: 6,
    });
    return result.content;
  };

  const sendText = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (typing) {
      setToast("我还在接住上一句话，马上回你");
      return;
    }
    setMessages((items) => [...items, { id: messageId.current++, from: "user", text: value }]);
    setGreetingVisible(false);
    setGreetingAnswered(true);
    setTyping(true);

    const isQuickCommand = /^(暂停|停一下|继续|播放|上一首|下一首|换一首|音量|声音大|声音小)/.test(value);
    const isMusicQuestion = /歌|音乐|推荐|歌词|潜流|无缝|音量|播放|界面|粒子|天气|画像/i.test(value);
    const isReflective = /为什么|怎么|觉得|难过|焦虑|烦|睡不着|孤独|关系|工作|家人|选择|怎么办/.test(value);
    setThinkingCue("正在连接 DeepSeek V4 Flash");
    const delay = isQuickCommand ? 680 : isReflective ? Math.min(2600, 1580 + value.length * 20) : isMusicQuestion ? Math.min(1950, 1120 + value.length * 15) : Math.min(1750, 980 + value.length * 13);
    const recentConversation: CodioAIMessage[] = [...messages, { id: -1, from: "user" as const, text: value }]
      .slice(-10)
      .map(({ from, text }) => ({ role: (from === "dj" ? "assistant" : "user") as "assistant" | "user", content: text }));
    let configured = false;
    try {
      const status = await window.codioDesktop?.ai.getStatus();
      configured = Boolean(status?.configured);
      setModelConfigured(configured);
      if (!configured) {
        const localReply = await replyTo(value);
        if (localReply === FULL_AI_REQUIRED) setModelOpen(true);
        window.setTimeout(() => addDjReply(localReply), delay);
        return;
      }
      addDjReply(await runAgentTurn(value, recentConversation));
    } catch (error) {
      const canUseLocalFallback = isOfflineCodioShortcut(value);
      const reply = canUseLocalFallback
        ? await replyTo(value)
        : configured
          ? codioRequestFailure(error)
          : FULL_AI_REQUIRED;
      if (reply === FULL_AI_REQUIRED) setModelOpen(true);
      window.setTimeout(() => addDjReply(reply), delay);
    }
  };

  const submitMessage = (event: FormEvent) => {
    event.preventDefault();
    const value = input;
    setInput("");
    sendText(value);
  };

  const connectDeepSeek = async (event: FormEvent) => {
    event.preventDefault();
    const key = apiKeyInput.trim();
    if (!key) return;
    const ai = window.codioDesktop?.ai;
    if (!ai) {
      setApiKeyError("请在 CODIO 桌面版中连接");
      return;
    }
    setApiKeySaving(true);
    setApiKeyError("");
    try {
      const status = await ai.saveKey(key);
      setModelConfigured(status.configured);
      setAIStatusChecked(true);
      if (status.configured) setOnboardingDeepSeekSkipped(false);
      setApiKeyInput("");
      notifySystem("DEEPSEEK V4 FLASH · CONNECTED", "success", "Codio 已能理解当前电台状态并执行工具");
    } catch (error) {
      const message = String(error);
      setApiKeyError(message.includes("401") || message.includes("KEY_INVALID")
        ? "这个密钥没有通过 DeepSeek 验证，请检查是否复制完整"
        : message.includes("402")
          ? "DeepSeek 账户额度不足，请充值后再连接"
          : "暂时无法连接 DeepSeek，请检查网络后再试一次");
    } finally {
      setApiKeySaving(false);
    }
  };

  const finishOnboarding = async () => {
    const state = saveCodioOnboarding(window.localStorage, onboardingQQSkipped, onboardingDeepSeekSkipped);
    if (window.codioDesktop?.onboarding) {
      try {
        await window.codioDesktop.onboarding.save(state);
      } catch {
        notifySystem("首次使用状态暂未保存", "warning", "请重试一次，现有音乐与账号数据不会受影响");
        return;
      }
    }
    if (onboardingFirstRun) {
      const audio = musicAudioRef.current;
      if (audio) {
        audio.pause();
        if (Number.isFinite(audio.duration)) audio.currentTime = 0;
      }
      setIsPlaying(false);
      setProgress(0);
      setPlaybackTime((current) => ({ ...current, current: 0 }));
    }
    setOnboardingOpen(false);
    setOnboardingFirstRun(false);
    setOnboardingStep(0);
  };

  const reopenOnboarding = () => {
    setOnboardingFirstRun(false);
    setOnboardingQQSkipped(false);
    setOnboardingDeepSeekSkipped(false);
    setOnboardingStep(0);
    setSettingsOpen(false);
    setOnboardingOpen(true);
  };

  const disconnectDeepSeek = async () => {
    const ai = window.codioDesktop?.ai;
    if (!ai) return;
    setApiKeySaving(true);
    try {
      const status = await ai.clearKey();
      setModelConfigured(status.configured);
      setApiKeyInput("");
      setApiKeyError("");
      setToast("DEEPSEEK KEY · REMOVED FROM THIS DEVICE");
    } finally {
      setApiKeySaving(false);
    }
  };

  const answerGreeting = (answer: string) => {
    setDjOpen(true);
    sendText(answer);
  };

  const selectTrack = (index: number) => {
    initialRecommendationRef.current = true;
    setTrackIndex(index);
    setProgress(0);
    setIsPlaying(false);
    setSearchOpen(false);
    setSearchQuery("");
    const selected = tracks[index];
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop) return;
    void desktop.search(`${selected.title} ${selected.artist}`).then((results) => {
      if (results[0]) return selectQQTrack(results[0]);
      setToast("QQ 音乐中没有找到这首歌");
    }).catch(() => setToast("搜索失败，请检查 QQ 音乐连接"));
  };

  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || !searchQuery.trim()) return;
    event.preventDefault();
    rememberSearch(searchQuery);
    setSearchOpen(true);
    if (searchStatus === "loading") setToast("正在找歌，稍等一下再从列表里选");
    else if (!searchResults.length) setToast(window.codioDesktop ? "没有找到相关歌曲" : "请在 CODIO 桌面版中搜索 QQ 音乐");
    else setToast(`找到 ${searchResults.length} 首，从列表里选一首播放`);
  };

  const handleParallax = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rootRef.current) return;
    // Root custom properties restyle the whole tree. High-rate mice can emit
    // several events per frame, so write only the latest position once per frame.
    const pending = parallaxPointerRef.current;
    pending.clientX = event.clientX;
    pending.clientY = event.clientY;
    if (pending.frame) return;
    pending.frame = window.requestAnimationFrame(() => {
      pending.frame = 0;
      const root = rootRef.current;
      if (!root) return;
      root.style.setProperty("--cursor-x", `${pending.clientX}px`);
      root.style.setProperty("--cursor-y", `${pending.clientY}px`);
      if (reducedMotionLiveRef.current) return;
      const x = pending.clientX / window.innerWidth - 0.5;
      const y = pending.clientY / window.innerHeight - 0.5;
      root.style.setProperty("--mx", `${x * 29}px`);
      root.style.setProperty("--my", `${y * 23}px`);
    });
  };

  const handleCloudPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    event.currentTarget.style.setProperty("--cloud-x", `${x * 12}px`);
    event.currentTarget.style.setProperty("--cloud-y", `${y * 9}px`);
    event.currentTarget.style.setProperty("--cloud-x2", `${x * -6}px`);
    event.currentTarget.style.setProperty("--cloud-y2", `${y * -5}px`);
    event.currentTarget.style.setProperty("--cloud-x3", `${x * 8}px`);
    event.currentTarget.style.setProperty("--cloud-y3", `${y * -3}px`);
  };

  const resetCloudPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.style.setProperty("--cloud-x", "0px");
    event.currentTarget.style.setProperty("--cloud-y", "0px");
    event.currentTarget.style.setProperty("--cloud-x2", "0px");
    event.currentTarget.style.setProperty("--cloud-y2", "0px");
    event.currentTarget.style.setProperty("--cloud-x3", "0px");
    event.currentTarget.style.setProperty("--cloud-y3", "0px");
  };

  const handleNowPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = Math.min(72, Math.min(bounds.width, bounds.height) * 0.075);
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const staysInsideOpenPanel =
      (nowPlayingEdge === "bottom" && localY > bounds.height - 132) ||
      (nowPlayingEdge === "left" && localX < 272) ||
      (nowPlayingEdge === "right" && localX > bounds.width - 232);
    let zone: EdgeZone = staysInsideOpenPanel ? nowPlayingEdge : null;
    if (!staysInsideOpenPanel) {
      const horizontalSafe = localX > edge * 1.85 && localX < bounds.width - edge * 1.85;
      const verticalSafe = localY > edge * 1.85 && localY < bounds.height - edge * 1.85;
      if (localY > bounds.height - edge && horizontalSafe) zone = "bottom";
      else if (localX < edge && verticalSafe) zone = "left";
      else if (localX > bounds.width - edge && verticalSafe) zone = "right";
    }
    if (zone !== edgeIntentRef.current.zone) {
      if (edgeIntentRef.current.timer) window.clearTimeout(edgeIntentRef.current.timer);
      edgeIntentRef.current.zone = zone;
      edgeIntentRef.current.timer = window.setTimeout(() => {
        setNowPlayingEdge(zone);
        edgeIntentRef.current.timer = null;
      }, zone ? 460 : 620);
    }

    const pointer = nowPointerRef.current;
    pointer.x = localX / bounds.width * 2 - 1;
    pointer.y = localY / bounds.height * 2 - 1;
    if (pointer.dragging && !zone) {
      const deltaX = event.clientX - pointer.startX;
      const deltaY = event.clientY - pointer.startY;
      // The canvas projection rotates the scene in the opposite mathematical
      // direction, so invert the input once here: the artwork follows the
      // cursor instead of feeling like it is being pulled away from it.
      pointer.velocityY = -deltaX * 0.30;
      pointer.velocityX = -deltaY * 0.27;
      pointer.ry = Math.max(-70, Math.min(70, pointer.ry + pointer.velocityY));
      pointer.rx = Math.max(-62, Math.min(62, pointer.rx + pointer.velocityX));
      pointer.startX = event.clientX;
      pointer.startY = event.clientY;
    }
    nowStageRef.current?.style.setProperty("--np-x", `${pointer.x * 18}px`);
    nowStageRef.current?.style.setProperty("--np-y", `${pointer.y * 14}px`);
  };

  const startNowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (nowPlayingEdge || (event.target as HTMLElement).closest("button,input,.np-edge")) return;
    const pointer = nowPointerRef.current;
    pointer.dragging = true;
    pointer.returning = false;
    pointer.velocityX = 0;
    pointer.velocityY = 0;
    pointer.startX = event.clientX;
    pointer.startY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const closeNowPlaying = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (edgeIntentRef.current.timer) window.clearTimeout(edgeIntentRef.current.timer);
    edgeIntentRef.current = { zone: null, timer: null };
    nowPointerRef.current.dragging = false;
    nowPointerRef.current.returning = false;
    nowPointerRef.current.lastReleaseAt = performance.now();
    setNowPlayingEdge(null);
    setNowPlayingOpen(false);
  };

  const dismissNowEdge = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!nowPlayingEdge || (event.target as HTMLElement).closest(".np-edge")) return;
    if (edgeIntentRef.current.timer) window.clearTimeout(edgeIntentRef.current.timer);
    edgeIntentRef.current = { zone: null, timer: null };
    setNowPlayingEdge(null);
  };

  const stopNowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    nowPointerRef.current.dragging = false;
    nowPointerRef.current.returning = false;
    nowPointerRef.current.lastReleaseAt = performance.now();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const zoomNowPlaying = (event: React.WheelEvent<HTMLDivElement>) => {
    if (nowPlayingEdge) return;
    event.preventDefault();
    nowPointerRef.current.zoom = Math.max(0.7, Math.min(1.55, nowPointerRef.current.zoom - event.deltaY * 0.0008));
  };

  const rememberExperiment = (item: Experiment) => {
    const track = recommendationTracksRef.current[recommendationIdentity(item)];
    if (!track) { setToast("这首歌尚未核对好，暂时没有记录偏好"); return; }
    const targetKey = canonicalTrackKey("qq", track.mid);
    const previous = activePreferences(listeningMemoryRef.current).find((event) => event.targetType === "track" && event.targetKey === targetKey);
    const value = previous?.value === "more" ? "neutral" : "more";
    writeTrackPreference(track, value, "track", "player", "recommendation_card");
    setToast(value === "more" ? "这首已写入听歌画像；当前 24 首保持不变" : "已撤回这首的偏好；当前列表保持不变");
  };

  const recordCurrentPreference = (kind: "like" | "dislike") => {
    const liveTrack = activeQQTrackLiveRef.current;
    if (!liveTrack) { setToast("还没有选择真实歌曲，未记录偏好"); return; }
    const liveTrackKey = liveTrack?.mid || currentTrack.title;
    if (kind === "dislike" && dislikeAdvanceTrackRef.current === liveTrackKey) {
      setToast("正在接下一首，不会重复抢占播放连接");
      return;
    }
    const targetKey = canonicalTrackKey(liveTrack.provider || "qq", liveTrack.mid);
    const current = activePreferences(listeningMemoryRef.current).find((event) => event.targetType === "track" && event.targetKey === targetKey);
    const desired = kind === "like" ? "more" : "less";
    const value = current?.value === desired ? "neutral" : desired;
    const scope: PreferenceScope = "track";
    writeTrackPreference(liveTrack, value, scope, "player", kind === "like" ? "player_more" : "player_less");
    if (value === "neutral") {
      setLikedTracks((items) => { const next = new Set(items); next.delete(targetKey); return next; });
      setDislikedTracks((items) => { const next = new Set(items); next.delete(targetKey); return next; });
      setToast("已撤回。接下来的推荐会恢复，但正在显示的歌曲不会突然变化");
      return;
    }
    if (kind === "like") {
      setLikedTracks((items) => new Set(items).add(targetKey));
      setDislikedTracks((items) => {
        const next = new Set(items);
        next.delete(targetKey);
        return next;
      });
      setToast("记住这首歌；可靠特征只做轻微提升，不会自动收藏到 QQ 音乐");
      return;
    }
    setDislikedTracks((items) => new Set(items).add(targetKey));
    setLikedTracks((items) => {
      const next = new Set(items);
      next.delete(targetKey);
      return next;
    });
    settleCurrentListening("dislike");
    setToast("记下这首歌的选择；下次准备推荐时也会生效，不会屏蔽整位歌手。当前展示的歌曲保持不变");
    dislikeAdvanceTrackRef.current = liveTrackKey;
    window.setTimeout(() => {
      void nextTrack().finally(() => {
        if (dislikeAdvanceTrackRef.current === liveTrackKey) dislikeAdvanceTrackRef.current = "";
      });
    }, 240);
  };

  const updateTonightIntent = (key: "familiarity" | "energy" | "flow", value: SessionIntent[typeof key]) => {
    const current = listeningMemoryRef.current.sessionIntent && listeningMemoryRef.current.sessionIntent.expiresAt > Date.now()
      ? listeningMemoryRef.current.sessionIntent
      : createSessionIntent({}, Date.now());
    const intent = createSessionIntent({ ...current, [key]: value }, Date.now());
    updateListeningMemory({
      type: "session_intent_changed",
      eventId: `intent-${Date.now()}-${key}`,
      sessionId: listeningMemoryRef.current.currentSession.sessionId,
      intent,
      createdAt: Date.now(),
    });
    setToast(key === "energy" && value !== "balanced" ? "意图已保存；目前没有跨歌曲可比的能量证据，暂不能可靠调整能量" : "意图已保存，后续重排已排队；长期画像保持不变");
  };

  const correctProfileHypothesis = (hypothesisId: string, verdict: "confirm" | "reject" | "session-only" | "ignore-behavior") => {
    updateListeningMemory({ type: "profile_corrected", eventId: `correction-${Date.now()}-${hypothesisId}`, hypothesisId, verdict, createdAt: Date.now() });
    setToast(verdict === "confirm" ? "已确认；这条证据会更稳定地参与推荐" : verdict === "session-only" ? "只保留为今晚的线索" : "已纠正；Codio 不会再肯定表达这条判断");
  };

  const withdrawPreference = (preference: ReturnType<typeof activePreferences>[number]) => {
    updateListeningMemory({ ...preference, eventId: `withdraw-${Date.now()}-${preference.eventId}`, value: "neutral", createdAt: Date.now(), supersedesEventId: preference.eventId });
    setToast("已撤回这条影响；未播放的推荐会重新计算");
  };

  async function refreshRecommendationLane(lane: RecommendationLane, trigger: "manual" | "feedback" | "sync", evidenceRevision: number, triggers: string[]): Promise<Record<string, unknown>> {
    const update = recommendationUpdateRef.current, pools = recommendationPoolsRef.current;
    const memory = listeningMemoryRef.current, profileVersion = memory.updatedAt, startedAt = Date.now();
    const timings = { libraryMs: 0, acquisitionMs: 0, validationMs: 0 };
    const historyKey = `codio-recommendation-pool-v1-${lane}`;
    let startupSnapshot: unknown = null;
    if (!pools[lane].revision) {
      try {
        const saved = JSON.parse(window.localStorage.getItem(historyKey) || "{}") as { cursor?: number; exposure?: string[]; snapshot?: unknown };
        if (trigger !== "manual") startupSnapshot = saved.snapshot;
        pools[lane] = { ...pools[lane], cursor: Number.isInteger(saved.cursor) && saved.cursor! >= 0 ? Math.min(1000000, saved.cursor!) : 0,
          exposure: Array.isArray(saved.exposure) ? saved.exposure.filter(key => typeof key === "string").slice(-1200) : [] };
      } catch { /* Corrupt non-sensitive cursor data does not clear listening memory. */ }
    }
    if (trigger === "manual") {
      try { startupSnapshot = JSON.parse(window.localStorage.getItem(historyKey) || "{}").snapshot; }
      catch { /* A missing reserve falls back to the normal acquisition path. */ }
    }
    const shownKeys = (lane === "match" ? recommendationVisibleRef.current.matched : recommendationVisibleRef.current.frontier).map(recommendationIdentity);
    if (shownKeys.length && !pools[lane].visible.length) pools[lane] = { ...pools[lane], visible: shownKeys };
    const begun = beginRecommendationPoolUpdate(pools[lane], profileVersion, trigger === "manual" || triggers.includes("continuation"));
    pools[lane] = begun.pool;
    const request = begun.request;
    const valid = () => pools[lane].revision === request.revision && evidenceRevision === update.revision
      && listeningMemoryRef.current.updatedAt === profileVersion;
    const reportBootTask = (task: string) => {
      if (bootPhase === "playing" && valid()) setBootMusicTask(current => ({ ...current, [lane]: task }));
    };
    const otherLane = lane === "match" ? "frontier" : "match";
    const ownShown = () => lane === "match" ? recommendationVisibleRef.current.matched : recommendationVisibleRef.current.frontier;
    const beforeVisible = ownShown().map(recommendationIdentity);
    const finish = (status: string, facts: Record<string, unknown> = {}) => {
      const result = { lane, status, triggerEvents: triggers, revision: request.revision, evidenceRevision, profileVersion,
        cursor: request.cursor, scoringVersion: "evidence-v7-work-supported-fit", durationMs: Date.now() - startedAt,
        hiddenQueueCommitted: false, visibleBatchPreserved: true, timings, ...facts };
      update.records = [...update.records, result].slice(-24); window.codioRecommendationDiagnostics = update.records;
      if (pools[lane].revision === request.revision) {
        setRecommendationLoading(current => ({ ...current, [lane]: false }));
        if (bootPhase === "playing") setBootMusicTask(current => ({ ...current, [lane]: "" }));
      }
      return result;
    };
    const fail = (error: string) => {
      pools[lane] = failRecommendationPoolUpdate(pools[lane], request, error).pool;
      return finish("failed", { error });
    };
    const stale = () => {
      if (pools[lane].revision === request.revision) pools[lane] = failRecommendationPoolUpdate(pools[lane], request, "NEWER_EVIDENCE_OR_LANE_REQUEST").pool;
      return finish("superseded", { error: "NEWER_EVIDENCE_OR_LANE_REQUEST" });
    };
    setRecommendationLoading(current => ({ ...current, [lane]: true }));
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop) return fail("QQ_UNAVAILABLE");
    try {
      reportBootTask("Checking music availability…");
      const status = desktop.getStatus ? await withTimeout(desktop.getStatus(), 4000, "QQ_STATUS") : null;
      if (!valid()) return stale();
      if (status && (!status.loggedIn || !status.playbackReady)) return fail("QQ_NOT_CONNECTED");
      const owner = status?.userId || "";
      const restored = readStartupRecommendationSnapshot(startupSnapshot, lane, owner);
      const useStartupSnapshot = trigger !== "manual" && restored.tracks.length >= 12 && restored.visible.length === 12;
      const profile = deriveListeningProfile(memory);
      // Metadata is shared; acquisition targets, cursors, membership and commits are not.
      const library = qqTasteSnapshotRef.current?.tracks || [];
      // Use the whole already-known catalogue evidence for scoring; only a
      // small balanced group may cause new metadata requests. Arbitrarily
      // taking the first twelve hid independent works already in the library.
      let libraryFeatures = [...library].sort((a, b) => Number(Boolean(b.genres?.length)) - Number(Boolean(a.genres?.length))).map(featureVectorForTrack);
      const libraryGroups = new Map<string, QQTrack[]>();
      for (const track of library) {
        const key = track.artist.trim().toLowerCase(), group = libraryGroups.get(key) || [];
        if (!group.some(item => item.mid === track.mid)) group.push(track);
        libraryGroups.set(key, group);
      }
      const groupedLibrary = [...libraryGroups.values()].map(group => group.sort((a, b) => Number(Boolean(b.genres?.length)) - Number(Boolean(a.genres?.length))))
        .sort((a, b) => Math.min(2, b.filter(track => track.genres?.length).length) - Math.min(2, a.filter(track => track.genres?.length).length));
      const librarySeeds: QQTrack[] = [];
      for (let round = 0; round < 2; round++) for (const group of groupedLibrary.slice(0, 12)) if (group[round]) librarySeeds.push(group[round]);
      const exposed = new Set(pools[lane].exposure);
      const scoringOptions = () => {
        const active = activeQQTrackLiveRef.current, hour = new Date().getHours();
        return { current: active ? featureVectorForTrack(active) : undefined, libraryFeatures,
          tasteCalibrated: profile.meaningfulSignalCount > 0 || library.length > 0,
          timeBucket: hour < 7 ? "late-night" : hour < 12 ? "morning" : hour < 18 ? "day" : "evening",
          weather: weatherSnapshotRef.current.text || weatherContext };
      };
      const otherOwnedKeys = () => {
        const other = pools[otherLane], otherShown = lane === "match" ? recommendationVisibleRef.current.frontier : recommendationVisibleRef.current.matched;
        return new Set([...other.candidates.map(item => item.canonicalKey), ...other.visible, ...other.hidden, ...otherShown.map(recommendationIdentity)]);
      };
      const retainedTracks = new Map(pools[lane].candidates.flatMap(candidate => {
        const track = recommendationTracksRef.current[candidate.canonicalKey];
        return track ? [[candidate.canonicalKey, track] as const] : [];
      }));
      // Boot verifies only the displayed page. Its owned, TTL-checked catalogue
      // still supplies unshown reserve identities, not ready playback URLs.
      if (trigger === "manual") for (const track of restored.tracks) retainedTracks.set(recommendationIdentity(track), track);
      const retained = [...retainedTracks.values()].flatMap(track => {
        const current = track && candidateForExperiment({ provider: "qq", id: track.mid, title: track.title, artist: track.artist,
          cover: track.cover || "", color: "violet", tags: [], reason: "Retained own-lane catalogue", lane }, exposed, track);
        return current ? [current] : [];
      });
      // The pool is not a set of buffered Audio elements. Preview its latest
      // evidence, then recheck sources for the NEW page before committing it.
      const reserveOptions = scoringOptions();
      const reserveScores = new Map(retained.map(candidate => [candidate.canonicalKey, scoreCandidate(candidate, profile, memory, lane, Date.now(), reserveOptions)]));
      const reserve = trigger === "manual" ? commitRecommendationPoolUpdate(pools[lane], request,
        { candidates: retained, scores: reserveScores, otherOwnedKeys: otherOwnedKeys(), replaceVisible: true, profileVersion, flow: profile.sessionIntent?.flow }) : null;
      const useRetainedPool = Boolean(reserve?.visibleCommitted && reserve.pool.visible.length === 12);
      reportBootTask("Reading your music preferences…");
      // Restoring an owned batch performs no new acquisition. Do not put twelve
      // unrelated library metadata requests in front of its real source checks.
      // Cold/manual acquisition still enriches the same seed facts as before.
      const hasPairedLibraryEvidence = groupedLibrary.filter(group => group.filter(track => track.genres?.length).length >= 2).length >= 6;
      const seedLibrary = useStartupSnapshot || useRetainedPool || hasPairedLibraryEvidence ? librarySeeds
        : await Promise.all(librarySeeds.map(track => track.genres?.length ? track : enrichTrackMetadata(track)));
      if (!valid()) return stale();
      timings.libraryMs = Date.now() - startedAt;
      const acquisitionStartedAt = Date.now();
      const seedFacts = new Map(seedLibrary.map(track => [track.mid, track]));
      libraryFeatures = library.map(track => seedFacts.get(track.mid) || track)
        .sort((a, b) => Number(Boolean(b.genres?.length)) - Number(Boolean(a.genres?.length))).map(featureVectorForTrack);
      // Each retrieval processes eight seeds. Advancing only one seed repeated
      // seven old searches and could leave boot one card short indefinitely.
      const acquisitionCursor = request.cursor * 8;
      const seeds = recommendationAcquisitionSeeds(lane, memory, profile, { libraryFeatures, cursor: acquisitionCursor, limit: 8 });
      if (!pools[lane].exposure.length) {
        let legacy: string[] = [];
        try {
          const savedLegacy: unknown = JSON.parse(window.localStorage.getItem("codio-recommendation-history") || "[]");
          if (Array.isArray(savedLegacy)) legacy = savedLegacy.filter((key): key is string => typeof key === "string");
        } catch { /* Ignore invalid exposure data without clearing any storage or memory. */ }
        pools[lane] = { ...pools[lane], exposure: migrateRecommendationExposure(legacy, Object.values(recommendationTracksRef.current)).slice(-1200) };
      }
      const acquisition: Array<{ seed: typeof seeds[number]; tracks: QQTrack[]; error: string | null; searchedPages: number[] }> = [];
      let seedCursor = 0;
      reportBootTask(useStartupSnapshot
        ? lane === "match" ? "Restoring close matches…" : "Restoring taste frontier…"
        : lane === "match" ? "Finding close matches…" : "Finding taste frontier tracks…");
      const acquire = () => Promise.all(Array.from({ length: 2 }, async () => {
        while (seedCursor < seeds.length && valid()) {
          const seed = seeds[seedCursor++];
          const searchedPages = [seed.page];
          try {
            const accept = (tracks: QQTrack[]) => tracks.filter(track => track.mid && track.title && track.artist
              && (!seed.filterArtists.length || seed.filterArtists.some(artist => recommendationArtistMatches(track.artist, artist)))
              && !seed.excludeArtists.some(artist => recommendationArtistMatches(track.artist, artist)));
            let tracks = accept(await withTimeout(desktop.search(seed.query, seed.page), 7000, "LANE_SEARCH"));
            // A refresh cursor is not the size of an artist's catalogue. A
            // missing high page must not strand startup with a partial lane.
            // Recover the same verified query once; ownership, exposure and
            // song-level qualification still decide whether results may enter.
            if (!tracks.length && seed.page > 1 && valid()) {
              searchedPages.push(1);
              tracks = accept(await withTimeout(desktop.search(seed.query, 1), 7000, "LANE_SEARCH_FIRST_PAGE"));
            }
            acquisition.push({ seed, tracks, searchedPages, error: null });
          } catch { acquisition.push({ seed, tracks: [], searchedPages, error: "SEARCH_UNAVAILABLE" }); }
        }
      }));
      if (!useStartupSnapshot && !useRetainedPool) await acquire();
      if (!valid()) return stale();
      timings.acquisitionMs = Date.now() - acquisitionStartedAt;
      const entries = new Map<string, { item: Experiment; track: QQTrack; acquisition: string[] }>();
      if (useStartupSnapshot) for (const track of restored.tracks) {
        const key = recommendationIdentity(track);
        discoveryTracksRef.current[key] = track;
        entries.set(key, { track, item: { provider: "qq", id: track.mid, title: track.title, artist: track.artist,
          cover: track.cover || "", color: "violet", tags: [], reason: "Revalidated own-lane startup snapshot", lane }, acquisition: ["startup_own_pool"] });
      }
      // Only retain this pool's own acquired members, never the other pool's leftovers.
      for (const candidate of retained) {
        const track = retainedTracks.get(candidate.canonicalKey);
        if (track) entries.set(candidate.canonicalKey, { track, item: { provider: "qq", id: track.mid, title: track.title, artist: track.artist,
          cover: track.cover || "", color: "violet", tags: [], reason: candidate.generationReason, lane }, acquisition: ["retained_own_pool"] });
      }
      const addAcquired = () => { for (const batch of acquisition) for (const track of batch.tracks) {
        const key = recommendationIdentity(track);
        discoveryTracksRef.current[key] = track;
        const found = entries.get(key);
        if (found) found.acquisition.push(batch.seed.key);
        else entries.set(key, { track, item: { provider: "qq", id: track.mid, title: track.title, artist: track.artist, cover: track.cover || "",
          color: "violet", tags: [], reason: `${batch.seed.strategy}: ${batch.seed.basis}`, lane }, acquisition: [batch.seed.key] });
      } };
      addAcquired();
      // A few actual library anchors belong only to match, not exploration.
      if (lane === "match" && !useStartupSnapshot) for (const track of seedLibrary) {
        const key = recommendationIdentity(track);
        if (!entries.has(key)) entries.set(key, { track, item: { provider: "qq", id: track.mid, title: track.title, artist: track.artist,
          cover: track.cover || "", color: "violet", tags: [], reason: "Verified QQ library anchor", lane }, acquisition: ["qq_library_anchor"] });
      }
      const acquiredEntries = () => {
        const fromTracks = (tracks: QQTrack[]) => tracks.map(track => entries.get(recommendationIdentity(track)))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
        // Fair coverage of actual seed results, not the last 120 network replies.
        // Retained candidates and a few library anchors remain separate sources.
        const otherOwned = otherOwnedKeys();
        return interleaveRecommendationSources([
          ...seeds.map(seed => fromTracks(acquisition.find(batch => batch.seed.key === seed.key)?.tracks || [])),
          ...(lane === "match" ? [fromTracks(seedLibrary)] : []), fromTracks([...retainedTracks.values()]),
        ].map(source => source.filter(entry => !exposed.has(recommendationIdentity(entry.track))
          && !otherOwned.has(recommendationIdentity(entry.track)) && !checkedKeys.has(recommendationIdentity(entry.track)))),
        entry => recommendationIdentity(entry.track));
      };
      const resolved: Array<{ item: Experiment; track: QQTrack; acquisition: string[] }> = [];
      const reserveOrder = new Map(reserve?.pool.visible.map((key, index) => [key, index]) || []);
      const checkedKeys = new Set<string>();
      let pending = useStartupSnapshot ? [...entries.values()].slice(0, 120)
        : useRetainedPool ? [...entries.values()].sort((a, b) => (reserveOrder.get(recommendationIdentity(a.track)) ?? 12) - (reserveOrder.get(recommendationIdentity(b.track)) ?? 12)).slice(0, 120)
          : acquiredEntries();
      let cursor = 0;
      const qualificationScores = new Map<string, RecommendationScore>();
      const scoredResolved = (keepReserve = false) => {
        const source = new Map(keepReserve && useRetainedPool ? retained.map(candidate => [candidate.canonicalKey, candidate]) : []);
        // A partially displayed page remains part of composition, even when
        // its cards predate the current pool or no longer qualify for re-entry.
        for (const item of ownShown()) {
          const candidate = candidateForExperiment(item, exposed);
          if (candidate) source.set(candidate.canonicalKey, candidate);
        }
        resolved.forEach(({ item, track }) => {
          const candidate = candidateForExperiment(item, exposed, track);
          if (candidate) source.set(candidate.canonicalKey, candidate);
        });
        // A failed check cannot survive as an old playable hidden candidate.
        const candidates = [...source.values()].filter(candidate => !checkedKeys.has(candidate.canonicalKey)
          || resolved.some(entry => recommendationIdentity(entry.track) === candidate.canonicalKey));
        const now = Date.now(), options = scoringOptions();
        const scores = new Map([...qualificationScores, ...candidates.map(candidate => [candidate.canonicalKey, scoreCandidate(candidate, profile, memory, lane, now, options)] as const)]);
        return { candidates, scores };
      };
      const qualifiedStartupVisible = (scores: Map<string, RecommendationScore>, otherOwned: Set<string>) => restored.visible.filter(key =>
        resolved.some(entry => recommendationIdentity(entry.track) === key) && scores.get(key)?.laneEvidence?.[lane] === true && !otherOwned.has(key));
      const startupPageReady = () => {
        const { candidates, scores } = scoredResolved(), otherOwned = otherOwnedKeys();
        // A previous session's page is not this session's protected display.
        // Preview the SAME final admission/compilation path, including real
        // negative feedback, exposure and diversification, before stopping.
        const preview = commitRecommendationPoolUpdate({ ...pools[lane], visible: qualifiedStartupVisible(scores, otherOwned) }, request,
          { candidates, scores, otherOwnedKeys: otherOwned, replaceVisible: false, profileVersion, flow: profile.sessionIntent?.flow });
        return !preview.stale && preview.pool.visible.length === 12;
      };
      const manualPageReady = () => {
        const { candidates, scores } = scoredResolved();
        const preview = commitRecommendationPoolUpdate(pools[lane], request, { candidates, scores, otherOwnedKeys: otherOwnedKeys(),
          replaceVisible: true, profileVersion, flow: profile.sessionIntent?.flow });
        return !preview.stale && preview.visibleCommitted && preview.pool.visible.length === 12;
      };
      const validationStartedAt = Date.now();
      let validationExcludedMs = 0;
      let deadline = Date.now() + 24000;
      reportBootTask("Checking playback links and covers…");
      const validateCandidates = (visibleOnly: boolean) => Promise.all(Array.from({ length: 4 }, async () => {
        while (cursor < pending.length && valid() && Date.now() < deadline) {
          // A startup snapshot restores the existing page, not a full cold
          // catalogue scan. All twelve visible IDs are dispatched first; only
          // missing/failed slots need its still-unshown backup candidates. A
          // playable backup is not necessarily qualified for this lane, so
          // only stop early when the whole original page has been verified.
          if (useStartupSnapshot && cursor >= 12 && (visibleOnly || startupPageReady())) break;
          if (useRetainedPool && resolved.length >= 12 && manualPageReady()) break;
          const entry = pending[cursor++], track = entry.track;
          checkedKeys.add(recommendationIdentity(track));
          if (Date.now() - (failedTracksRef.current.get(track.mid) || 0) < 75000) continue;
          try {
            let remaining = deadline - Date.now();
            let known = track;
            if (useStartupSnapshot) {
              // These owned catalogue facts were already checked within six
              // hours. Missing language/date must not serialize 24 new detail
              // requests, nor should rejected backups consume playback URLs.
              if (!known.genres?.length) known = await withTimeout(enrichTrackMetadata(track, deadline), remaining, "STARTUP_METADATA");
              const candidate = candidateForExperiment(entry.item, exposed, known);
              if (!candidate) continue;
              const qualification = scoreCandidate(candidate, profile, memory, lane, Date.now(), scoringOptions());
              qualificationScores.set(candidate.canonicalKey, qualification);
              if (!qualification.laneEvidence?.[lane]) continue;
              remaining = deadline - Date.now();
              if (remaining <= 0 || !valid()) continue;
            }
            const [prepared, enriched] = await withTimeout(Promise.all([
              withTimeout(prepareTrack(track, false), Math.min(6500, remaining), "CANDIDATE_PLAYABILITY"),
              useStartupSnapshot ? known : useRetainedPool && track.genres?.length ? track : enrichTrackMetadata(track, deadline),
            ]), remaining, "CANDIDATE_DEADLINE");
            if (!prepared || !valid() || Date.now() >= deadline) continue;
            if (!trackAnalysisRef.current.has(track.mid) && window.codioDesktop?.analysis) {
              const cached = await withTimeout(window.codioDesktop.analysis.get(track.mid, 3), Math.min(1200, deadline - Date.now()), "CACHED_RECOMMENDATION_ANALYSIS").catch(() => null);
              if (cached?.version === 3 && cached.trackId === track.mid && valid()) setBoundedCache(recommendationAudioRef.current, track.mid,
                { bpm: cached.bpm, tempoConfidence: cached.tempoConfidence, outroFocus: cached.outroFocus }, 120);
            }
            if (Date.now() < deadline) resolved.push({ ...entry, track: { ...enriched, cover: prepared.coverData || enriched.cover } });
            if (bootPhase === "playing" && useStartupSnapshot && restored.visible.includes(recommendationIdentity(track))) {
              setBootPreparedSources(previous => new Set([...previous, recommendationIdentity(track)]));
            }
          } catch { /* One source cannot fail its entire lane, or the other lane. */ }
        }
      }));
      // Finish the original page as a group before trying backups. A fast
      // worker must not launch a cold scan while the last original source waits.
      await validateCandidates(useStartupSnapshot);
      if (useStartupSnapshot && valid() && !startupPageReady()) {
        await validateCandidates(false);
      }
      if (useRetainedPool && valid() && !manualPageReady()) {
        // Expired/failed reserve sources fall back to this lane's retrieval,
        // not a false success, an old repeated batch or the other lane's pool.
        const fallbackStartedAt = Date.now();
        await acquire();
        const fallbackMs = Date.now() - fallbackStartedAt;
        timings.acquisitionMs += fallbackMs; validationExcludedMs += fallbackMs;
        if (!valid()) return stale();
        addAcquired();
        pending = acquiredEntries();
        cursor = 0; deadline = Date.now() + 24000;
        await validateCandidates(false);
      }
      if (!valid()) return stale();
      timings.validationMs = Date.now() - validationStartedAt - validationExcludedMs;
      if (seeds.length && acquisition.length > 0 && acquisition.every(batch => batch.error) && !resolved.length) return fail("LANE_ACQUISITION_FAILED");
      const available = { ...recommendationTracksRef.current, ...(useRetainedPool ? Object.fromEntries(retainedTracks) : {}) };
      resolved.forEach(entry => { available[recommendationIdentity(entry.track)] = entry.track; });
      recommendationTracksRef.current = available; setRecommendationTracks(available);
      const { candidates, scores } = scoredResolved(true);
      reportBootTask("Applying your latest preferences…");
      const active = activeQQTrackLiveRef.current;
      const otherOwned = otherOwnedKeys();
      if (useStartupSnapshot) {
        // Preserve the user's last visible batch only after rechecking each
        // actual source AND its latest evidence. Old rejected IDs cannot gain
        // in-session protection merely by coming from a startup snapshot.
        pools[lane] = { ...pools[lane], visible: qualifiedStartupVisible(scores, otherOwned) };
      }
      // Re-read the other pool at commit time, so two concurrent refreshes cannot share IDs.
      const committed = commitRecommendationPoolUpdate(pools[lane], request, { candidates, scores, otherOwnedKeys: otherOwned,
        replaceVisible: trigger === "manual", profileVersion: listeningMemoryRef.current.updatedAt, flow: profile.sessionIntent?.flow,
        displayReadyKeys: new Set(resolved.map(entry => recommendationIdentity(entry.track))) });
      if (!valid() || committed.stale) return stale();
      pools[lane] = committed.pool;
      const byId = new Map([...entries.values(), ...resolved].map(entry => [recommendationIdentity(entry.track), entry]));
      const oldItems = new Map(ownShown().map(item => [recommendationIdentity(item), item]));
      const asExperiment = (key: string) => {
        const entry = byId.get(key);
        return entry ? { ...entry.item, lane, cover: entry.track.cover || entry.item.cover,
          reason: scores.get(key)?.topReasons[0] || oldItems.get(key)?.reason || entry.item.reason } : oldItems.get(key);
      };
      const shown = pools[lane].visible.map(asExperiment).filter((item): item is Experiment => Boolean(item));
      if (committed.visibleCommitted || useStartupSnapshot) {
        recommendationVisibleRef.current = { ...recommendationVisibleRef.current, [lane === "match" ? "matched" : "frontier"]: shown };
        if (lane === "match") setMatchedExperiments(shown); else setVisibleExperiments(shown);
        if (bootPhase === "playing") setBootPreparedSources(previous => new Set([...previous, ...shown.map(recommendationIdentity)]));
      }
      scores.forEach((score, key) => { if (!otherOwned.has(key)) recommendationScoresRef.current.set(key, score); });
      const ownCatalog = [...pools[lane].visible, ...pools[lane].hidden].map(asExperiment).filter((item): item is Experiment => Boolean(item));
      recommendationCatalogRef.current = [...recommendationCatalogRef.current.filter(item => item.lane === otherLane), ...ownCatalog];
      window.localStorage.setItem(historyKey, JSON.stringify({ cursor: pools[lane].cursor, exposure: pools[lane].exposure,
        snapshot: buildStartupRecommendationSnapshot([...pools[lane].visible, ...pools[lane].hidden]
          .map(key => available[key]).filter((track): track is QQTrack => Boolean(track)).concat(useStartupSnapshot ? restored.tracks : []),
          pools[lane].visible, lane, owner) }));
      const protectedIds = new Set([...recommendationVisibleRef.current.matched, ...recommendationVisibleRef.current.frontier]
        .map(item => available[recommendationIdentity(item)]?.mid).filter((id): id is string => Boolean(id)));
      manualQueueIdsRef.current.forEach(id => protectedIds.add(id));
      const promised = activeTransitionRef.current?.incomingSnapshot.track.mid
        || (seamlessTransitionRef.current ? playQueueRef.current[activeQueueIndexRef.current + 1]?.mid : null);
      if (promised) protectedIds.add(promised);
      const activeLane = active && recommendationSourceForTrack(active) === "recommendation_frontier" ? "frontier" : "match";
      let hiddenQueueCommitted = false, hiddenQueueChanged = false;
      if (active && activeLane === lane && playQueueRef.current.length) {
        const adaptive = pools[lane].hidden.map(key => available[key]).filter((track): track is QQTrack => Boolean(track));
        const merged = mergeHiddenRecommendations(playQueueRef.current, adaptive, active.mid, protectedIds, false);
        if (merged.currentIndex >= 0) {
          hiddenQueueChanged = merged.queue.map(track => track.mid).join("|") !== playQueueRef.current.map(track => track.mid).join("|");
          playQueueRef.current = merged.queue; setPlayQueue(merged.queue); activeQueueIndexRef.current = merged.currentIndex; setActiveQueueIndex(merged.currentIndex);
          prepareUpcomingTrack(active.mid); hiddenQueueCommitted = true;
        }
      }
      const visibleAfter = ownShown().map(recommendationIdentity);
      const result = finish(pools[lane].status, { acquisitionCursor, startupSnapshotUsed: useStartupSnapshot, retainedPoolUsed: useRetainedPool,
        restoredVisibleCount: useStartupSnapshot ? qualifiedStartupVisible(scores, otherOwned).length : 0,
        startupRejected: useStartupSnapshot ? restored.visible.filter(key => !qualifiedStartupVisible(scores, otherOwned).includes(key)).map(id => ({
          id, reason: scores.get(id)?.laneEvidence?.[lane] === false ? "LATEST_EVIDENCE_REJECTED"
            : !resolved.some(entry => recommendationIdentity(entry.track) === id) ? "NO_VERIFIED_SOURCE" : otherOwned.has(id) ? "OWNED_BY_OTHER_POOL" : "LATEST_EVIDENCE_REJECTED",
          explicitTrackContribution: scores.get(id)?.contributions.find(item => item.key === "explicit_track")?.signedWeight ?? 0,
        })) : [],
        startupReplacementIds: useStartupSnapshot ? pools[lane].visible.filter(key => !restored.visible.includes(key)) : [],
        seeds: acquisition.map(batch => ({ ...batch.seed, searchedPages: batch.searchedPages, returned: batch.tracks.length, error: batch.error })),
        candidateCount: entries.size, playableCandidateCount: resolved.length, retainedCatalogCandidateCount: retained.length, checkedCandidateCount: checkedKeys.size,
        verifiedDisplaySourceCount: resolved.length, searchSkipped: useRetainedPool && acquisition.length === 0,
        poolCandidateIds: pools[lane].candidates.map(item => item.canonicalKey),
        admission: pools[lane].candidates.slice(0, 48).map(item => ({ id: item.canonicalKey, sources: byId.get(item.canonicalKey)?.acquisition,
          evidence: scores.get(item.canonicalKey)?.laneEvidence, contributions: scores.get(item.canonicalKey)?.contributions })),
        excluded: committed.excluded, otherPoolIntersection: pools[lane].candidates.filter(item => otherOwned.has(item.canonicalKey)).length,
        visibleBefore: beforeVisible, visibleAfter, hiddenIds: pools[lane].hidden, visibleCount: shown.length,
        visibleCommitted: committed.visibleCommitted, visibleBatchPreserved: beforeVisible.every((id, index) => visibleAfter[index] === id),
        hiddenQueueCommitted, hiddenQueueChanged, queueCount: playQueueRef.current.length,
        fullyBufferedSourceCount: bufferedSourcesRef.current.size, mediaElementCount: audioElementsRef.current.size,
        error: pools[lane].error });
      if (trigger === "manual") setToast(committed.visibleCommitted ? "Recommendations refreshed" : "本栏新的可靠候选不足，保留当前歌曲；另一栏不变");
      return result;
    } catch { return valid() ? fail("LANE_UPDATE_FAILED") : stale(); }
  }

  const refreshRecommendations = async (trigger: "manual" | "feedback" | "sync" = "manual", expectedRevision?: number,
    triggers = [trigger as string], lane?: RecommendationLane): Promise<Record<string, unknown>> => {
    const revision = expectedRevision ?? recommendationUpdateRef.current.revision;
    const lanes: RecommendationLane[] = lane ? [lane]
      : triggers.includes("continuation")
        ? (["match", "frontier"] as RecommendationLane[]).filter(selected =>
          (selected === "match" ? recommendationVisibleRef.current.matched : recommendationVisibleRef.current.frontier).length < 12)
        : ["match", "frontier"];
    const results = await Promise.all(lanes.map(selected => refreshRecommendationLane(selected, trigger, revision, triggers)));
    const result = { status: results.some(item => item.status === "completed") ? "completed"
      : results.every(item => item.status === "superseded") ? "superseded" : "insufficient_candidates",
      lanes: results, revision, hiddenQueueCommitted: results.some(item => item.hiddenQueueCommitted),
      visibleCommitted: results.some(item => item.visibleCommitted), visibleBatchPreserved: results.every(item => item.visibleBatchPreserved) };
    if (revision === recommendationUpdateRef.current.revision) {
      recommendationUpdateRef.current.latest = result;
      // Publish the real terminal result through the existing event-driven UI
      // state, not a polling timer or a fabricated "updated" message.
      setRecommendationLoading(current => ({ ...current }));
    }
    return result;
  };
  recommendationRefreshRef.current = refreshRecommendations;

  const loadWeatherAt = async (latitude: number, longitude: number, announce = false) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
    const revision = ++weatherSnapshotRef.current.revision;
    try {
      const endpoint = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,precipitation,cloud_cover&timezone=auto`;
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error("Weather unavailable");
      const data = await response.json() as { current?: { temperature_2m?: number; precipitation?: number; cloud_cover?: number } };
      const current = data.current;
      if (!current || !Number.isFinite(current.temperature_2m)) throw new Error("No current weather");
      const condition = (current.precipitation || 0) > 0 ? "Rain" : (current.cloud_cover || 0) > 65 ? "Cloudy" : "Clear";
      const weather = `${condition} · ${Math.round(current.temperature_2m || 0)}°C`;
      if (revision !== weatherSnapshotRef.current.revision) return false;
      weatherSnapshotRef.current = { text: weather, at: Date.now(), revision };
      setWeatherContext(weather);
      if (announce) notifySystem("天气已自动连入", "ready", weather);
      return true;
    } catch {
      const cached = weatherSnapshotRef.current;
      if (revision === cached.revision && cached.text && Date.now() - cached.at > 60 * 60 * 1000) setWeatherContext(`${cached.text} · stale`);
      return false;
    }
  };

  const enableWeatherContext = () => {
    if (!("geolocation" in navigator)) {
      setWeatherContext("Location unavailable");
      return;
    }
    setWeatherLoading(true);
    const cached = window.localStorage.getItem("codio-weather-location");
    if (cached) {
      try {
        const location = JSON.parse(cached) as { latitude: number; longitude: number };
        void loadWeatherAt(location.latitude, location.longitude);
      } catch {}
    }
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      const location = {
        latitude: Math.round(coords.latitude * 100) / 100,
        longitude: Math.round(coords.longitude * 100) / 100,
      };
      window.localStorage.setItem("codio-weather-location", JSON.stringify(location));
      const connected = await loadWeatherAt(location.latitude, location.longitude, !cached);
      if (!connected && !cached) setWeatherContext("Weather unavailable");
      setWeatherLoading(false);
    }, () => {
      if (!cached) setWeatherContext("Weather permission off");
      setWeatherLoading(false);
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 30 * 60 * 1000 });
  };

  useEffect(() => {
    if (weatherAutoStartedRef.current) return;
    weatherAutoStartedRef.current = true;
    const timer = window.setTimeout(enableWeatherContext, 450);
    const refresh = () => {
      if (Date.now() - weatherSnapshotRef.current.at < 30 * 60 * 1000) return;
      try {
        const location = JSON.parse(window.localStorage.getItem("codio-weather-location") || "null");
        if (location) void loadWeatherAt(location.latitude, location.longitude);
      } catch {}
    };
    const interval = window.setInterval(refresh, 30 * 60 * 1000);
    window.addEventListener("online", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  const syncQQTaste = async (force = true) => {
    const desktop = window.codioDesktop?.qqMusic;
    if (!desktop) return null;
    const revision = ++qqSyncRevisionRef.current;
    setTasteSyncing(true);
    try {
      const snapshot = await withTimeout(desktop.library({ force }), 10000, "QQ_LIBRARY_SYNC");
      if (revision !== qqSyncRevisionRef.current) return null;
      const weights: Record<string, number> = {};
      const addTags = (tags: string[], weight: number) => tags.forEach((tag) => { weights[tag] = (weights[tag] || 0) + weight; });
      snapshot.topArtists.forEach((artist) => {
        artistTasteHints.forEach(([pattern, tags]) => {
          if (pattern.test(artist.name)) addTags(tags, Math.max(.5, Math.log2(artist.weight + 1)));
        });
      });
      snapshot.playlistNames.forEach((name) => {
        playlistTasteHints.forEach(([pattern, tags]) => {
          if (pattern.test(name)) addTags(tags, 1.35);
        });
      });
      const maxWeight = Math.max(1, ...Object.values(weights));
      Object.keys(weights).forEach((tag) => { weights[tag] = weights[tag] / maxWeight; });
      // Library synchronization supplies evidence only. Each lane performs its
      // own seeded acquisition; there is no randomized shared discovery list.
      setQQTasteSnapshot(snapshot);
      setTasteTagWeights(weights);
      qqTasteSnapshotRef.current = snapshot;
      tasteTagWeightsRef.current = weights;
      setQQSummary({ playlists: snapshot.playlists.length, recent: snapshot.tracks.length });
      window.localStorage.setItem("codio-qq-taste-profile", JSON.stringify({
        syncedAt: new Date().toISOString(),
        playlists: snapshot.playlists.length,
        tracks: snapshot.tracks.length,
        liked: snapshot.likedCount,
        topArtists: snapshot.topArtists.slice(0, 20),
        tagWeights: weights,
      }));
      requestRecommendationUpdate("qq_library_synced");
      return snapshot;
    } catch {
      setToast("QQ library analysis needs a fresh authorization check");
      return null;
    } finally {
      if (revision === qqSyncRevisionRef.current) setTasteSyncing(false);
    }
  };

  const connectQQMusic = async (requestAuthorization = false) => {
    const desktop = window.codioDesktop?.qqMusic;
    if (desktop) {
      if (requestAuthorization) qqAuthorizationRevisionRef.current += 1;
      try {
        setQQConnection(requestAuthorization ? "authorizing" : "checking");
        setImportState(requestAuthorization ? "scanning" : "idle");
        notifySystem(requestAuthorization ? "正在打开 QQ 音乐安全授权" : "正在恢复 QQ 音乐会话", "analysis", requestAuthorization ? "只在 QQ 音乐官方页面完成授权" : "优先复用这台电脑已有的长期会话");
        // Main-process recovery has a 12s deadline. A shorter renderer timeout
        // used to turn a still-running recovery into an incorrectly ready home.
        const status = requestAuthorization ? await desktop.login({ forceAuthorization: true }) : await withTimeout(desktop.getStatus(), 16000, "BOOT_QQ_STATUS");
        if (!status.loggedIn || status.authorizationRequired || status.connectionError === "QQ_DESKTOP_AUTH_UNSUPPORTED") {
          setQQPlaybackReady(false);
          setQQConnection("needs-auth");
          setImportState("idle");
          if (status.connectionError === "QQ_DESKTOP_AUTH_UNSUPPORTED") {
            notifySystem("QQ 音乐尚未恢复播放授权", "error", "官方验证转到了手机应用；已拦截下载，登录数据未删除。请先确认 QQ 音乐官方电脑版能否正常播放。");
            setToast("QQ 验证要求手机应用，不能在这台 Windows 中完成。没有安装或下载任何程序。");
          }
          return;
        }
        if (!status.playbackReady) throw new Error("QQ_SESSION_NOT_READY");
        setQQPlaybackReady(true);
        setQQConnection("connected");
        setOnboardingQQSkipped(false);
        setImportState("ready");
        window.localStorage.setItem("codio-qq-music-authorized", "desktop");
        notifySystem("QQ 音乐会话已恢复", "success", "无需重新扫码登录");
        if (requestAuthorization) bootRetryRef.current = 0;
        try { await syncQQTaste(requestAuthorization); }
        finally {
          // Authorization restores media capability even when a forced full
          // library read fails. Coalesce this with qq_library_synced; preserve
          // the already-visible batch and keep the real 24-source boot gate.
          if (requestAuthorization) requestRecommendationUpdate("playback_retry");
        }
      } catch {
        setQQPlaybackReady(false);
        setQQConnection("error");
        setImportState("idle");
      }
      return;
    }

    const sdk = window.h5PanelSdk?.qqMusic;
    if (!sdk) {
      setQQPlaybackReady(false);
      setQQConnection("unavailable");
      setImportState("idle");
      return;
    }

    try {
      setQQConnection("checking");
      const authorized = await sdk.getAuthStatus();
      if (!authorized) {
        setQQPlaybackReady(false);
        if (requestAuthorization) {
          setQQConnection("authorizing");
          setImportState("scanning");
          sdk.goAuthPage();
        } else {
          setQQConnection("needs-auth");
          setImportState("idle");
        }
        return;
      }

      setQQConnection("syncing");
      setImportState("scanning");
      const [playlists, recent] = await Promise.all([
        sdk.describeSelfSongList(),
        sdk.describeRecentPlay?.({ Type: 0, UpdateTime: 0 }) ?? Promise.resolve([]),
      ]);
      setQQSummary({ playlists: countQQItems(playlists), recent: countQQItems(recent) });
      setQQPlaybackReady(true);
      setQQConnection("connected");
      setOnboardingQQSkipped(false);
      setImportState("ready");
      window.localStorage.setItem("codio-qq-music-authorized", "true");
    } catch {
      setQQPlaybackReady(false);
      setQQConnection("error");
      setImportState("idle");
    }
  };

  useEffect(() => {
    if (!window.codioDesktop?.qqMusic) {
      setQQPlaybackReady(false);
      setQQConnection("unavailable");
      setImportState("idle");
      return;
    }
    const timer = window.setTimeout(() => {
      void connectQQMusic(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (bootPhase !== "done" || onboardingOpen || ["checking", "syncing", "authorizing"].includes(qqConnection)) return;
    if (qqConnection === "connected") { qqConnectionNoticeRef.current = false; return; }
    if (qqConnectionNoticeRef.current) return;
    qqConnectionNoticeRef.current = true;
    notifySystem("连接 QQ 音乐后开始收听", "listening", "首页已准备好；点击右上角 QQ MUSIC 恢复会员播放与推荐。登录数据未清除。");
  }, [bootPhase, onboardingOpen, qqConnection]);

  useEffect(() => {
    let disposed = false;
    void window.codioDesktop?.localMusic?.library().then(items => { if (!disposed) setLocalTracks(items); }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  const importLocal = async (mode: "files" | "folder") => {
    const bridge = window.codioDesktop?.localMusic;
    if (!bridge) { notifySystem("本地导入需要桌面版", "warning", "不会模拟导入成功"); return; }
    setImportState("scanning");
    try {
      const result = await bridge.import(mode);
      setLocalTracks(result.tracks); setLocalImportResult(result);
      setImportState(result.ok ? "ready" : "idle");
      notifySystem(result.cancelled ? "已取消选择" : result.ok ? "本地歌曲已保存" : "没有导入可用歌曲", result.ok ? "success" : "warning",
        result.cancelled ? "没有修改音乐库" : `新增 ${result.imported} · 重复 ${result.duplicates} · 失败/不支持 ${result.failed}${result.capped ? " · 已达到扫描上限" : ""}`);
    } catch { setImportState("idle"); notifySystem("本地导入失败", "error", "原音乐库保持不变"); }
  };

  // ---- Playback conveniences: repeat, sleep timer, media keys, shortcuts, queue edits, backup ----
  const [repeatOne, setRepeatOne] = useState(false);
  const [sleepTimer, setSleepTimer] = useState<SleepTimer | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [backupNotice, setBackupNotice] = useState("");
  const sleepTimerRef = useRef<SleepTimer | null>(null);
  const sleepFadeStartedRef = useRef(false);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const auroraCanvasRef = useRef<HTMLCanvasElement>(null);

  const toggleRepeat = () => {
    const next = !repeatOne;
    setRepeatOne(next);
    setToast(next ? "单曲循环已开启，这首歌会一直播下去" : "单曲循环已关闭");
  };
  // Native looping restarts the element gaplessly and never fires `ended`, so
  // the queue, listening session and lyrics clock all keep working unchanged.
  useEffect(() => {
    const audio = musicAudioRef.current;
    if (audio) audio.loop = repeatOne;
    for (const element of audioElementsRef.current) if (element !== audio) element.loop = false;
  }, [repeatOne, activeQQTrack?.mid]);

  const seekToSeconds = (seconds: number) => {
    const duration = playbackTime.duration || musicAudioRef.current?.duration || 0;
    if (!(duration > 0)) return;
    seekPlayback(Math.max(0, Math.min(100, (seconds / duration) * 100)));
  };
  const seekBySeconds = (delta: number) => {
    const audio = musicAudioRef.current;
    if (!audio?.src) return;
    seekToSeconds(audio.currentTime + delta);
  };

  const startSleepTimer = (minutes: number | "track") => {
    const timer = minutes === "track"
      ? createTrackSleepTimer(activeQQTrack?.mid || currentTrack.title)
      : createClockSleepTimer(minutes);
    if (!timer) return;
    if (sleepFadeStartedRef.current) {
      const audio = musicAudioRef.current;
      if (audio && !audio.paused) void fadeMusicVolume(audio, analyserNodesRef.current.get(audio) ? 1 : getPlayerVolumeScalar(), 500);
    }
    sleepTimerRef.current = timer;
    sleepFadeStartedRef.current = false;
    setSleepTimer(timer);
    setSleepRemaining(sleepTimerRemaining(timer) || 0);
    setToast(timer.kind === "track" ? "这首歌结束后电台会停下" : `${minutes} 分钟后电台会轻轻停下`);
  };
  const cancelSleepTimer = (quiet = false) => {
    if (!sleepTimerRef.current) return;
    sleepTimerRef.current = null;
    setSleepTimer(null);
    setSleepRemaining(0);
    if (sleepFadeStartedRef.current) {
      sleepFadeStartedRef.current = false;
      const audio = musicAudioRef.current;
      if (audio && !audio.paused && !userPausedRef.current) void fadeMusicVolume(audio, analyserNodesRef.current.get(audio) ? 1 : getPlayerVolumeScalar(), 600);
    }
    if (!quiet) setToast("睡眠定时已取消");
  };
  const finishSleepTimer = async () => {
    sleepTimerRef.current = null;
    sleepFadeStartedRef.current = false;
    setSleepTimer(null);
    setSleepRemaining(0);
    const audio = musicAudioRef.current;
    if (audio?.src && !audio.paused && !userPausedRef.current) await togglePlayback();
    setToast("晚安。电台已停下，进度已保留");
  };

  // Effects reach the latest handlers through one ref so none of them has to
  // restart when a handler identity changes between renders.
  const transportRef = useRef({ togglePlayback, nextTrack, previousTrack, seekToSeconds, seekBySeconds, changeVolume, recordCurrentPreference, toggleRepeat, finishSleepTimer, fadeMusicVolume });
  transportRef.current = { togglePlayback, nextTrack, previousTrack, seekToSeconds, seekBySeconds, changeVolume, recordCurrentPreference, toggleRepeat, finishSleepTimer, fadeMusicVolume };

  useEffect(() => {
    if (!sleepTimer) return;
    const tick = () => {
      const timer = sleepTimerRef.current;
      if (!timer) return;
      const audio = musicAudioRef.current;
      const remaining = timer.kind === "clock"
        ? sleepTimerRemaining(timer)
        : audio && Number.isFinite(audio.duration) && audio.duration > 0 ? Math.max(0, (audio.duration - audio.currentTime) * 1000) : null;
      if (timer.kind === "clock") setSleepRemaining(remaining ?? 0);
      const playing = Boolean(audio?.src && !audio.paused && !userPausedRef.current);
      if (audio && remaining !== null && remaining <= SLEEP_FADE_MS && playing && !sleepFadeStartedRef.current) {
        sleepFadeStartedRef.current = true;
        void transportRef.current.fadeMusicVolume(audio, 0, Math.max(400, remaining));
      }
      if (remaining !== null && remaining <= (timer.kind === "clock" ? 0 : 1200)) void transportRef.current.finishSleepTimer();
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [sleepTimer]);
  const sleepTrackKey = activeQQTrack?.mid || "";
  useEffect(() => {
    if (sleepTimerTrackChanged(sleepTimerRef.current, sleepTrackKey)) void transportRef.current.finishSleepTimer();
  }, [sleepTrackKey]);

  // Hardware media keys, the Windows media overlay and headset buttons.
  useEffect(() => {
    const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!session) return;
    return bindMediaSessionTransport(session, {
      play: () => { const audio = musicAudioRef.current; if (!audio?.src || audio.paused) void transportRef.current.togglePlayback(); },
      pause: () => { const audio = musicAudioRef.current; if (audio?.src && !audio.paused) void transportRef.current.togglePlayback(); },
      previoustrack: () => void transportRef.current.previousTrack(),
      nexttrack: () => void transportRef.current.nextTrack(),
      seekto: (seconds) => transportRef.current.seekToSeconds(seconds),
      seekbackward: (seconds) => transportRef.current.seekBySeconds(-(seconds || MEDIA_SESSION_SEEK_SECONDS)),
      seekforward: (seconds) => transportRef.current.seekBySeconds(seconds || MEDIA_SESSION_SEEK_SECONDS),
    });
  }, []);
  const mediaArtwork = currentCoverData || currentTrack.cover || activeQQTrack?.fallbackCover || "";
  useEffect(() => {
    const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!session) return;
    const hasTrack = Boolean(activeQQTrack || currentTrack.title);
    applyMediaSessionMetadata(session, hasTrack ? { title: currentTrack.title, artist: currentTrack.artist, album: activeQQTrack?.album, artwork: mediaArtwork } : null,
      typeof MediaMetadata !== "undefined" ? MediaMetadata : undefined);
    applyMediaSessionPlaybackState(session, isPlaying, hasTrack);
  }, [activeQQTrack, currentTrack.title, currentTrack.artist, mediaArtwork, isPlaying]);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    applyMediaSessionPosition(navigator.mediaSession, playbackTime.duration, playbackTime.current, musicAudioRef.current?.playbackRate);
  }, [playbackTime]);

  const leaveNowPlaying = () => {
    if (edgeIntentRef.current.timer) window.clearTimeout(edgeIntentRef.current.timer);
    edgeIntentRef.current = { zone: null, timer: null };
    nowPointerRef.current.dragging = false;
    nowPointerRef.current.returning = false;
    setNowPlayingEdge(null);
    setNowPlayingOpen(false);
  };
  const overlayState = { shortcutsOpen, settingsOpen, djOpen, profileOpen, importOpen, modelOpen, searchOpen, nowPlayingOpen };
  const overlayRef = useRef(overlayState);
  overlayRef.current = overlayState;
  useEffect(() => {
    if (bootPhase !== "done") return;
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (isTextEntryTarget(event.target as HTMLElement | null)) return;
      const action = resolveShortcut(event);
      if (!action) return;
      const overlays = overlayRef.current;
      if (action === "close") {
        if (overlays.shortcutsOpen) setShortcutsOpen(false);
        else if (overlays.settingsOpen) setSettingsOpen(false);
        else if (overlays.djOpen) setDjOpen(false);
        else if (overlays.profileOpen) setProfileOpen(false);
        else if (overlays.importOpen) setImportOpen(false);
        else if (overlays.modelOpen) setModelOpen(false);
        else if (overlays.searchOpen) setSearchOpen(false);
        else if (overlays.nowPlayingOpen) leaveNowPlaying();
        else return;
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const continuous = action === "seek-backward" || action === "seek-forward" || action === "volume-up" || action === "volume-down";
      if (event.repeat && !continuous) return;
      const transport = transportRef.current;
      switch (action) {
        case "seek-backward": transport.seekBySeconds(-SHORTCUT_SEEK_SECONDS); break;
        case "seek-forward": transport.seekBySeconds(SHORTCUT_SEEK_SECONDS); break;
        case "volume-up": void transport.changeVolume(Math.min(100, Math.round(volumeRef.current) + SHORTCUT_VOLUME_STEP)); break;
        case "volume-down": void transport.changeVolume(Math.max(0, Math.round(volumeRef.current) - SHORTCUT_VOLUME_STEP)); break;
        case "next-track": void transport.nextTrack(); break;
        case "previous-track": void transport.previousTrack(); break;
        case "like": transport.recordCurrentPreference("like"); break;
        case "dislike": transport.recordCurrentPreference("dislike"); break;
        case "toggle-repeat": transport.toggleRepeat(); break;
        case "toggle-seamless": setSeamless((value) => !value); break;
        case "toggle-now-playing": if (overlays.nowPlayingOpen) leaveNowPlaying(); else setNowPlayingOpen(true); break;
        case "focus-search":
          setSearchOpen(true);
          window.setTimeout(() => searchShellRef.current?.querySelector<HTMLInputElement>("input")?.focus(), 0);
          break;
        case "toggle-help": setShortcutsOpen((open) => !open); break;
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [bootPhase]);

  const removeFromQueue = (mid: string) => {
    const queue = playQueueRef.current;
    const index = queue.findIndex((item) => item.mid === mid);
    if (index < 0 || index === activeQueueIndexRef.current) return;
    if (activeTransitionRef.current?.incomingSnapshot.track.mid === mid) {
      setToast("这首歌已经在衔接中，无法移出");
      return;
    }
    const next = queue.filter((_, position) => position !== index);
    playQueueRef.current = next;
    setPlayQueue(next);
    if (index < activeQueueIndexRef.current) {
      activeQueueIndexRef.current -= 1;
      setActiveQueueIndex(activeQueueIndexRef.current);
    }
    manualQueueIdsRef.current.delete(mid);
    seamlessAttemptedRef.current = null;
    const current = activeQQTrackLiveRef.current;
    if (current && index === activeQueueIndexRef.current + 1) prepareUpcomingTrack(current.mid);
    setToast("已移出队列");
  };

  const exportListeningData = () => {
    try {
      const backup = buildListeningBackup(window.localStorage);
      const blob = new Blob([serializeListeningBackup(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = backupFileName();
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      setBackupNotice(`已导出 ${anchor.download} · ${describeListeningBackup(backup)}`);
    } catch {
      setBackupNotice("导出失败：无法读取本机记录");
    }
  };
  const importListeningData = async (file: File | undefined) => {
    if (!file) return;
    try {
      const backup = parseListeningBackup(await file.text());
      const { applied } = applyListeningBackup(window.localStorage, backup);
      setBackupNotice(`已恢复 ${applied} 项 · ${describeListeningBackup(backup)} · 正在重新载入`);
      setToast("听歌记忆已恢复，电台正在重新载入");
      // Reload before any in-memory state can write over the restored records.
      listeningMemoryHydratedRef.current = false;
      window.setTimeout(() => window.location.reload(), 400);
    } catch (error) {
      const code = error instanceof ListeningBackupError ? error.code : "";
      setBackupNotice(code === "BACKUP_NOT_CODIO" ? "这不是 CODIO 备份文件"
        : code === "BACKUP_VERSION" ? "备份版本与当前程序不兼容"
        : code === "BACKUP_EMPTY" ? "备份里没有可恢复的记录"
        : "无法读取这个文件");
    }
  };

  // A slow aurora behind the dashboard, lit by the bass. GPU tier only; the
  // software tier keeps the CSS washes, and the opaque Now Playing hides it.
  useEffect(() => {
    const canvas = auroraCanvasRef.current;
    if (!canvas || nowPlayingOpen || particleLevel === 0 || bootPhase === "playing" || !hasAcceleratedWebGl()) return;
    const sky = acquireAuroraRenderer(canvas);
    if (!sky) return;
    let frame = 0;
    let energy = 0;
    let lastPaint = 0;
    let frequency: Uint8Array<ArrayBuffer> | null = null;
    const startedAt = performance.now();
    const style = rootRef.current ? getComputedStyle(rootRef.current) : null;
    const palette = {
      a: parseCssColor(style?.getPropertyValue("--scene-a"), [.47, .51, .78]),
      b: parseCssColor(style?.getPropertyValue("--scene-b"), [.15, .18, .32]),
      c: parseCssColor(style?.getPropertyValue("--scene-c"), [.66, .52, .56]),
      accent: parseCssColor(style?.getPropertyValue("--accent"), [.73, .79, 1]),
    };
    const opacity = particleLevel === 1 ? .55 : .8;
    const resize = () => {
      // A quarter-resolution buffer is plenty for a blurred sky.
      const ratio = Math.min(window.devicePixelRatio || 1, 1) * .5;
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      sky.resize(canvas.width, canvas.height);
    };
    const paint = (now: number) => {
      frame = 0;
      if (document.hidden || !visualActiveRef.current) return;
      // Half the display rate is invisible on a feature this soft and halves its cost.
      if (now - lastPaint < 30) { frame = window.requestAnimationFrame(paint); return; }
      lastPaint = now;
      const audio = musicAudioRef.current;
      const analyser = audio ? analyserNodesRef.current.get(audio)?.analyser : null;
      let target = 0;
      if (audio && analyser && !audio.paused && !userPausedRef.current) {
        if (!frequency || frequency.length !== analyser.frequencyBinCount) frequency = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(frequency);
        const bins = Math.min(20, frequency.length);
        let sum = 0;
        for (let index = 1; index < bins; index += 1) sum += frequency[index];
        target = sum / Math.max(1, bins - 1) / 255;
      }
      energy += (target - energy) * (target > energy ? .12 : .04);
      const pointer = parallaxPointerRef.current;
      sky.render({
        time: (now - startedAt) / 1000,
        energy,
        pointerX: pointer.clientX / Math.max(1, window.innerWidth) - .5,
        pointerY: .5 - pointer.clientY / Math.max(1, window.innerHeight),
        opacity,
        palette,
      });
      if (!reducedMotion) frame = window.requestAnimationFrame(paint);
    };
    resize();
    const suspend = () => { window.cancelAnimationFrame(frame); frame = 0; };
    const resume = () => { if (!document.hidden && visualActiveRef.current && !frame) frame = window.requestAnimationFrame(paint); };
    const resizeVisible = () => { resize(); lastPaint = 0; resume(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("blur", suspend);
    window.addEventListener("resize", resizeVisible);
    frame = window.requestAnimationFrame(paint);
    return () => {
      suspend();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", suspend);
      window.removeEventListener("resize", resizeVisible);
    };
  }, [nowPlayingOpen, particleLevel, reducedMotion, scene, bootPhase]);

  const startImport = () => {
    if (importSource === "qq") {
      if (qqConnection === "connected") {
        setImportOpen(false);
        setToast("QQ Music is connected. Codio is shaping your station.");
        return;
      }
      if (qqConnection === "unavailable" && !window.codioDesktop) {
        window.location.href = "codio://qq-login";
        setToast("Open CODIO Desktop to connect QQ Music securely.");
        return;
      }
      void connectQQMusic(qqConnection === "needs-auth" || qqConnection === "checking");
      return;
    }
    if (importState === "ready") {
      setImportOpen(false);
      setToast("Codio 已开始用你的听歌线索准备电台");
      return;
    }
    void importLocal("files");
  };

  const renderRecommendationCards = (items: Experiment[], mode: "match" | "frontier") => items.filter((track) => recommendationTracks[recommendationIdentity(track)]).map((track) => {
    const resolved = recommendationTracks[recommendationIdentity(track)];
    const score = resolved ? recommendationScoresRef.current.get(canonicalTrackKey("qq", resolved.mid)) : undefined;
    const cover = resolved?.cover || (resolved?.albumMid ? qqCoverUrl(resolved.albumMid) : "") || track.cover || coverFallback;
    return (
      <div
        className={`experiment-card ${resolved ? "playable" : ""}`}
        key={`${mode}-${track.title}-${track.artist}`}
        role={resolved ? "button" : undefined}
        title={score ? recommendationExplanation(score) : track.reason}
        tabIndex={resolved ? 0 : undefined}
        onClick={() => resolved && void selectQQTrack(resolved, recommendationQueueFor(resolved))}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && resolved) void selectQQTrack(resolved, recommendationQueueFor(resolved));
        }}
      >
        <span className={`experiment-diffusion ${track.color}`} style={cover ? { backgroundImage: `url("${cover}")` } : undefined} aria-hidden="true" />
        <span className={`experiment-art ${track.color}`}>
          <SafeRecommendationCover src={cover} fallbackSrc={resolved?.fallbackCover} />
        </span>
        <span className="experiment-copy"><strong>{track.title}</strong><small>{track.artist} · {track.reason}</small></span>
        <span className="edge-distance">{listeningStatus(listeningMemory, canonicalTrackKey("qq", resolved.mid)).effective || listeningStatus(listeningMemory, canonicalTrackKey("qq", resolved.mid)).liked || qqTasteSnapshotRef.current?.tracks.some((item) => item.mid === resolved.mid) ? "FAMILIAR" : "NEW"}</span>
        <button className={likedTracks.has(canonicalTrackKey("qq", resolved.mid)) ? "noted" : ""} title="这首不错，只用于理解你的品味" onClick={(event) => { event.stopPropagation(); rememberExperiment(track); }}>
          {likedTracks.has(canonicalTrackKey("qq", resolved.mid)) ? "NOTED" : "THIS ONE"}
        </button>
      </div>
    );
  });

  const renderRecommendationPages = (items: Experiment[], mode: "match" | "frontier") => {
    const playable = items.filter((track) => recommendationTracks[recommendationIdentity(track)]).slice(0, 12);
    const pool = recommendationPoolsRef.current[mode];
    const preparation = qqConnection === "checking" || qqConnection === "authorizing" ? "Restoring your music connection…"
      : qqConnection !== "connected" ? "Connect QQ Music at the top right to prepare this station."
      : tasteSyncing ? "Restoring your library…"
      : recommendationLoading[mode] || ["idle", "pending"].includes(pool.status) ? "Preparing checked, playable recommendations…"
      : pool.status === "failed" ? "The music service could not complete this batch. Your saved preferences are safe; try REFRESH."
      : "More reliable candidates are needed. Try REFRESH; existing songs will stay.";
    return (
      <div
        className="recommendation-viewport"
        aria-label={mode === "match" ? "熟悉方向的十二首推荐，横向滑动查看更多" : "未听过的新方向十二首推荐，横向滑动查看更多"}
        onWheel={(event) => {
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.stopPropagation();
        }}
      >
        {!playable.length && <p className="recommendation-preparation" role="status">{preparation}</p>}
        <div className="recommendation-track">
          {[playable.slice(0, 6), playable.slice(6, 12)].filter((page) => page.length).map((page, index) => (
            <div className="experiment-list recommendation-page" key={`${mode}-page-${index}`}>
              {renderRecommendationCards(page, mode)}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const bootProgress = bootPreparationProgress({
    assetCompleted: bootAssetCompleted,
    memoryHydrated: listeningMemoryHydratedRef.current,
    layoutReady: bootLayoutReady, animationDone: bootAnimationDone,
    onboardingChecked, aiStatusChecked, qqConnection, librarySettled: !tasteSyncing && qqSyncRevisionRef.current > 0,
    preparedSources: bootPreparedSources.size,
    ready: bootReady,
  });
  const bootShownTracks = [...matchedExperiments, ...visibleExperiments]
    .map(item => recommendationTracksRef.current[recommendationIdentity(item)]).filter(Boolean);
  const bootLiveSources = bootShownTracks.filter(track => {
    const entry = preparedTracksRef.current.get(track.mid);
    return entry && typeof entry.expiresAt === "number" && Date.now() < entry.expiresAt;
  }).length;
  const bootActiveMusicTask = [...new Set([bootMusicTask.match, bootMusicTask.frontier].filter(Boolean))].join(" · ");
  const bootRecommendationsUnavailable = qqConnection === "connected" && bootRetryRef.current >= 3
    && !recommendationLoading.match && !recommendationLoading.frontier && recommendationUpdateRef.current.timer === null
    && (matchedExperiments.length < 12 || visibleExperiments.length < 12);
  const bootPreparationStage = bootResourceError ? "Retrying artwork and layout checks…"
    : bootSourceError ? "Some playback links could not be prepared. Please try again."
    : bootWaveformError ? "The first track's waveform could not be prepared. Please try again."
    : bootRecommendationsUnavailable ? "Not enough verified matches yet. Please try again."
    : qqConnection === "error" ? "Music connection check failed. Please try again."
    : bootSourcesUnavailable() ? "The music sources need another check…"
    : !bootAssetsReady ? "Loading fonts and interface artwork…"
    : !listeningMemoryHydratedRef.current ? "Loading your listening memory…"
    : !onboardingChecked ? "Restoring your saved setup…"
    : !aiStatusChecked ? "Checking your AI DJ connection…"
    : ["checking", "syncing", "authorizing"].includes(qqConnection) ? "Checking your music connection…"
    : tasteSyncing ? "Restoring your music library…"
    : qqConnection === "connected" && bootActiveMusicTask ? bootActiveMusicTask
    : qqConnection === "connected" && (matchedExperiments.length < 12 || visibleExperiments.length < 12)
      ? "Preparing close matches and taste frontier…"
    : qqConnection === "connected" && bootLiveSources < 24 ? "Checking the playback sources…"
    : recommendationLoading.match || recommendationLoading.frontier ? "Confirming your recommendations…"
    : qqConnection === "connected" && (!activeQQTrack || lyricLinesLiveRef.current.trackId !== activeQQTrack.mid
      || (!lyricLinesLiveRef.current.settled && !lyricLinesLiveRef.current.lines.length)) ? "Loading the first track and its lyrics…"
    : qqConnection === "connected" && activeQQTrack && initialWaveformRef.current.trackId !== activeQQTrack.mid ? "Preparing the first track's waveform…"
    : !bootHomeFrameReady ? "Drawing the homepage background…"
    : !bootLayoutReady ? "Loading homepage covers and checking the layout…"
    : !bootAnimationDone ? "Finishing the opening animation…"
    : "Finishing the homepage…";

  return (
    <div
      ref={rootRef}
      className={`radio-app scene-${scene} night-mode ${reducedMotion ? "reduced-motion" : ""}`}
      data-theme="night"
      data-startup={bootPhase}
      data-home-paint={bootPainting}
      onPointerMove={handleParallax}
    >
      {bootPhase !== "done" && (
        <div
          className={`codio-boot ${bootPhase} ${bootReady ? "ready" : ""}`}
          role="status"
          aria-label="CODIO 正在准备你的电台"
          onClick={() => {
            if (!bootReady || !homePreparedForBoot()) return;
            if (!homeViewReadyForBoot()) {
              setBootReady(false); setBootLayoutReady(false); setBootAssetAttempt(attempt => attempt + 1);
              return;
            }
            setBootPhase("leaving");
            window.setTimeout(() => {
              if (!bootEntryCheckRef.current()) {
                setBootReady(false); setBootLayoutReady(false); setBootPhase("playing");
                return;
              }
              setBootPhase("done");
            }, 640);
          }}
        >
          <span className="boot-atmosphere" aria-hidden="true" />
          <div className="boot-lockup" aria-hidden="true">
            <div className="boot-orb">
              <span className="boot-mist" />
              <SafeRecommendationCover src="/codio-orb.webp" />
              <span className="boot-sheen" />
            </div>
            <div className="boot-wordmark">
              {"CODIO".split("").map((letter, index) => <span key={`${letter}-${index}`}>{letter}</span>)}
            </div>
          </div>
          {bootReady && <button className="boot-enter" type="button">CLICK ANYWHERE TO ENTER</button>}
          <div className={`boot-progress ${bootReady ? "completed" : ""}`} aria-live="polite">
            <p>{bootPreparationStage}</p>
            <div className="boot-progress-bar" role="progressbar" aria-valuenow={bootProgress.value} aria-valuemax={bootProgress.maximum} aria-valuemin={0}
              aria-label="电台真实准备进度">
              <span className="boot-progress-fill" aria-hidden="true" style={{ transform: `scaleX(${bootProgress.value / bootProgress.maximum})` }} />
            </div>
            {!bootReady && (bootResourceError || bootSourceError || bootWaveformError || bootRecommendationsUnavailable || bootSourcesUnavailable() || qqConnection === "error") &&
              <button type="button" onClick={(event) => {
                event.stopPropagation();
                if (qqConnection === "error") void connectQQMusic(false);
                if (bootSourceError) {
                  setBootSourceError(false);
                  setBootAssetAttempt(attempt => attempt + 1);
                }
                if (bootWaveformError) {
                  setBootWaveformError(false);
                  setBootAssetAttempt(attempt => attempt + 1);
                }
                if (bootResourceError) {
                  setBootResourceError(false);
                  setBootAssetAttempt(attempt => attempt + 1);
                }
                if (bootSourcesUnavailable() || bootRecommendationsUnavailable) {
                  bootRetryRef.current = 0;
                  requestRecommendationUpdate("playback_retry");
                }
              }}>TRY AGAIN</button>}
          </div>
        </div>
      )}
      {bootPhase === "done" && onboardingOpen && (
        <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="CODIO 首次使用引导">
          <section className="onboarding-card">
            <header>
              <div><small>CODIO · FIRST LISTEN</small><h2>{onboardingStep === 0 ? "Welcome to your radio." : onboardingStep === 1 ? "Connect your music." : onboardingStep === 2 ? "Connect AI DJ." : "Ready when you are."}</h2></div>
              <span>{onboardingStep + 1} / 4</span>
            </header>
            {onboardingStep === 0 && <div className="onboarding-copy">
              <SafeRecommendationCover src="/codio-orb.webp" />
              <p>CODIO 会从你的真实聆听、明确反馈和当下情境开始认识你。这里不需要注册 CODIO 账户。</p>
              <button type="button" onClick={() => setOnboardingStep(1)}>BEGIN</button>
            </div>}
            {onboardingStep === 1 && <div className="onboarding-step">
              <div className={`onboarding-status-card qq ${qqConnection === "connected" ? "connected" : ""}`}>
                <span><small>QQ MUSIC</small><strong>{qqConnection === "connected" ? "CONNECTED ON THIS DEVICE" : qqConnection === "authorizing" ? "AUTHORIZE IN QQ MUSIC" : qqConnection === "syncing" || qqConnection === "checking" ? "CHECKING CONNECTION" : "CONNECT YOUR LIBRARY"}</strong></span>
                <p>{qqConnection === "connected" ? `${qqSummary.playlists} playlists · playback ${qqPlaybackReady ? "ready" : "checking"}` : "登录由 QQ 音乐完成；CODIO 只在这台电脑保留会话并读取歌单与播放权限。"}</p>
              </div>
              <div className="onboarding-actions">
                <button type="button" onClick={() => qqConnection === "connected" ? setOnboardingStep(2) : void connectQQMusic(true)} disabled={qqConnection === "checking" || qqConnection === "syncing"}>{qqConnection === "connected" ? "CONTINUE" : qqConnection === "authorizing" ? "CHECK AUTHORIZATION" : "CONNECT QQ MUSIC"}</button>
                <button type="button" className="quiet" onClick={() => { setOnboardingQQSkipped(true); setOnboardingStep(2); }}>SKIP FOR NOW</button>
              </div>
            </div>}
            {onboardingStep === 2 && <div className="onboarding-step">
              <form className={`model-key-card ${modelConfigured ? "connected" : ""}`} onSubmit={connectDeepSeek}>
                <span><small>DEEPSEEK V4 FLASH</small><strong>{modelConfigured ? "CONNECTED ON THIS DEVICE" : aiStatusChecked ? "CONNECT AI DJ" : "CHECKING CONNECTION"}</strong></span>
                <p>{modelConfigured ? "DeepSeek 已能读取当前 CODIO 状态，并通过受限工具执行播放、搜索和界面操作。" : "使用你自己的 DeepSeek API Key。它只由 Electron 加密保存在这台设备，不会进入 localStorage。"}</p>
                {!modelConfigured && <input type="password" autoComplete="off" spellCheck={false} value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} placeholder="sk-••••••••••••••••" aria-label="DeepSeek API key" />}
                {apiKeyError && <em>{apiKeyError}</em>}
                {!modelConfigured && <button type="submit" disabled={apiKeySaving || !apiKeyInput.trim()}>{apiKeySaving ? "CONNECTING…" : "CONNECT DEEPSEEK"}</button>}
              </form>
              <div className="onboarding-actions">
                {modelConfigured && <button type="button" onClick={() => setOnboardingStep(3)}>CONTINUE</button>}
                <button type="button" className="quiet" onClick={() => { setOnboardingDeepSeekSkipped(true); setOnboardingStep(3); }}>SKIP FOR NOW</button>
              </div>
            </div>}
            {onboardingStep === 3 && <div className="onboarding-step final">
              <div className="onboarding-connection-summary">
                <span className={qqConnection === "connected" ? "connected" : "skipped"}><small>QQ MUSIC</small><strong>{qqConnection === "connected" ? "CONNECTED" : onboardingQQSkipped ? "SKIPPED" : "NOT CONNECTED"}</strong></span>
                <span className={modelConfigured ? "connected" : "skipped"}><small>DEEPSEEK V4 FLASH</small><strong>{modelConfigured ? "CONNECTED" : onboardingDeepSeekSkipped ? "SKIPPED" : "NOT CONNECTED"}</strong></span>
              </div>
              <p>两项连接都可以稍后在 CODIO 内完成。进入后第一首歌会停在 0:00，不会自动播放。</p>
              <button type="button" onClick={() => void finishOnboarding()}>ENTER CODIO</button>
            </div>}
          </section>
        </div>
      )}
      <canvas ref={auroraCanvasRef} className="aurora-field" aria-hidden="true" />
      <canvas ref={canvasRef} className="particle-field" aria-hidden="true" />
      <div className="cursor-field" aria-hidden="true" />
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar" inert={bootPhase !== "done"}>
        <button className="brand" aria-label="返回 CODIO 首页">
          <span>CODIO</span>
          <small>PRIVATE RADIO</small>
        </button>

        <div ref={searchShellRef} className={`search-shell ${searchOpen ? "active" : ""}`}>
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={handleSearchKey}
            placeholder="Search songs, artists, albums"
            aria-label="搜索歌曲、歌手或专辑"
          />
          <kbd>⌘ K</kbd>
          {searchOpen && (
            <div className="search-popover" onWheel={(event) => event.stopPropagation()} onScroll={(event) => {
              const panel = event.currentTarget;
              if (panel.scrollHeight - panel.scrollTop - panel.clientHeight < 84) void loadMoreSearchResults();
            }}>
              <div className="search-label-row">
                <div className="search-label">{searchQuery ? "SEARCH RESULTS" : recentSearches.length ? "RECENT SEARCHES" : "TRY A SEARCH"}</div>
                {!searchQuery && recentSearches.length > 0 && <button className="clear-search-history" onClick={() => {
                  setRecentSearches([]);
                  window.localStorage.removeItem("codio-search-history");
                }}>CLEAR</button>}
              </div>
              {!searchQuery && (
                <div className="search-suggestions">
                  {(recentSearches.length ? recentSearches : suggestions).map((item) => (
                    <button key={item} onClick={() => setSearchQuery(item)}>{item}</button>
                  ))}
                </div>
              )}
              {searchStatus === "loading" && <div className="search-state">Searching QQ Music…</div>}
              {searchResults.map((track) => (
                <div className="search-result" key={track.mid}>
                  <button className="search-result-main" onClick={() => {
                    rememberSearch(searchQuery);
                    void selectQQTrack(track);
                  }}>
                    <SafeRecommendationCover className="mini-cover search-cover" src={track.cover} fallbackSrc={track.fallbackCover} />
                    <span><strong>{track.title}</strong><small>{track.artist}{track.album ? ` · ${track.album}` : ""}</small></span>
                    {track.vipRequired && <em className="vip-mark">VIP</em>}
                    <span className="result-play">PLAY</span>
                  </button>
                  <button className="queue-next" title="Add to play next" aria-label={`Add ${track.title} to play next`} onClick={(event) => {
                    event.stopPropagation();
                    rememberSearch(searchQuery);
                    void enqueueNext(track);
                  }}>+ NEXT</button>
                </div>
              ))}
              {searchLoadingMore && <div className="search-state search-more">Loading more songs…</div>}
              {!searchLoadingMore && searchResults.length > 0 && searchHasMore && <button className="search-load-more" onClick={() => void loadMoreSearchResults()}>MORE RESULTS</button>}
              {searchQuery && searchStatus === "ready" && !searchResults.length && (
                <div className="search-state">No songs found. Try another title or artist.</div>
              )}
              {searchQuery && searchStatus === "error" && (
                <div className="search-state error">QQ Music search is unavailable. Check the desktop connection.</div>
              )}
              {false && filteredTracks.map((track) => {
                const index = tracks.indexOf(track);
                return (
                  <button className="search-result" key={track.title} onMouseDown={() => selectTrack(index)}>
                    <span className={`mini-cover ${track.color}`} />
                    <span><strong>{track.title}</strong><small>{track.artist}</small></span>
                    <span className="result-play">播放</span>
                  </button>
                );
              })}
              {false && searchQuery && !filteredTracks.length && (
                <button className="ask-dj-result" onMouseDown={() => {
                  setDjOpen(true);
                  sendText(searchQuery);
                  setSearchOpen(false);
                  setSearchQuery("");
                }}>
                  <span className="dj-mini-orb" />
                  <span><strong>告诉 Codio</strong><small>“{searchQuery}”</small></span>
                  <span>↗</span>
                </button>
              )}
            </div>
          )}
        </div>

        <nav className="top-actions" aria-label="主导航">
          <button
            className={`source-pill qq-connect-pill ${qqConnection === "connected" ? "connected" : ""}`}
            onClick={() => {
              setImportSource("qq");
              setImportState(qqConnection === "connected" ? "ready" : "idle");
              setImportOpen(true);
              if (qqConnection !== "connected") void connectQQMusic(false);
            }}
          >
            <span className="source-dot" />
            <span className="qq-connect-copy"><strong>{qqConnection === "connected" ? "QQ CONNECTED" : "QQ MUSIC"}</strong><small>{qqConnection === "connected" ? "MEMBER ACCESS READY" : "CONNECT MEMBERSHIP"}</small></span>
            <span>↗</span>
          </button>
          {sleepTimer && <button className="sleep-pill" title="点击取消睡眠定时" aria-label="取消睡眠定时" onClick={() => cancelSleepTimer()}>☾ {sleepTimer.kind === "track" ? "END OF SONG" : formatSleepRemaining(sleepRemaining)}</button>}
          <button className="icon-button settings-button" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>⌘</button>
        </nav>
      </header>

      <main className="dashboard" inert={bootPhase !== "done"}>
        <section className="radio-feature glass-card">
          <div className="feature-copy">
            <div className="section-kicker">TONIGHT&apos;S RADIO <span>为你准备</span></div>
            <h1>NIGHT<br />DRIFT</h1>
            <p>Familiar enough to stay.<br />New enough to feel alive.</p>
            <div className="feature-listening">
              <div className="played-history">
                <small>RECENTLY PLAYED · {djLibraryCount > 0 ? `LEARNED FROM ${djLibraryCount} TRACKS` : "LEARNING AS YOU LISTEN"}</small>
                <div onWheel={(event) => event.stopPropagation()}>
                  {playedHistory.length ? [...playedHistory].reverse().slice(0, 6).map((track) => (
                    <span className="played-history-item" key={track.id} title={`${track.title} · ${track.artist}`}>
                      <SafeRecommendationCover src={track.cover} fallbackSrc={track.fallbackCover} />
                      <span className="played-history-copy"><strong>{track.title}</strong><em>{track.artist}</em></span>
                    </span>
                  )) : <em>Your listening trail will appear here.</em>}
                </div>
              </div>
            </div>
            <div className="feature-actions">
              <button className="feature-play" onClick={() => void togglePlayback()}>
                <i>{isPlaying ? "Ⅱ" : "▶"}</i>
                <span><strong>LISTEN</strong><small>听会儿</small></span>
              </button>
              <button className={`seamless-main ${seamless ? "active" : ""}`} onClick={() => {
                setSeamless((value) => !value);
                setToast(seamless ? "已回到自然切换" : "无缝衔接已开启");
              }}>
                <span className="seamless-wave"><i /><i /></span>
                <span><strong>SEAMLESS</strong><small>无缝衔接 · {seamless ? "ON" : "OFF"}</small></span>
              </button>
            </div>
          </div>
          <div className="feature-visual" aria-label="Codio 为今晚生成的沉浸空间">
            <div className={`night-atmosphere scene-${scene}`}>
              <div className="atmosphere-field" aria-hidden="true"><i /><i /><i /><i /></div>
              {transitionDisplay ? <div className="atmosphere-transition-stack" aria-hidden="true">
                <SafeRecommendationCover className="atmosphere-cover transition-outgoing" src={transitionDisplay.outgoing.cover || transitionDisplay.outgoing.track.cover} fallbackSrc={transitionDisplay.outgoing.track.fallbackCover} />
                <SafeRecommendationCover className="atmosphere-cover transition-incoming" src={transitionDisplay.incoming.cover || transitionDisplay.incoming.track.cover} fallbackSrc={transitionDisplay.incoming.track.fallbackCover} />
              </div> : <SafeRecommendationCover className="atmosphere-cover" src={currentCoverData || currentTrack.cover} fallbackSrc={activeQQTrack?.fallbackCover} />}
              <div className={`atmosphere-horizon ${isPlaying ? "playing" : ""}`} aria-hidden="true">
                {Array.from({ length: 24 }, (_, index) => <i key={index} style={{ "--signal-index": index } as React.CSSProperties} />)}
              </div>
              {transitionDisplay ? <>
                <div className="atmosphere-now transition-outgoing"><small>HANDING OFF</small><strong data-title-size={titleSizeFor(transitionDisplay.outgoing.track.title)}>{transitionDisplay.outgoing.track.title}</strong><span>{transitionDisplay.outgoing.track.artist}</span></div>
                <div className="atmosphere-now transition-incoming"><small>BECOMING NOW</small><strong data-title-size={titleSizeFor(transitionDisplay.incoming.track.title)}>{transitionDisplay.incoming.track.title}</strong><span>{transitionDisplay.incoming.track.artist}</span></div>
                <div className="atmosphere-lyrics transition-outgoing"><div className="atmosphere-lyric-track"><strong>{transitionDisplay.outgoingLyric || "\u00a0"}</strong></div></div>
                <div className="atmosphere-lyrics transition-incoming"><div className="atmosphere-lyric-track"><strong>{transitionDisplay.incomingLyric || "\u00a0"}</strong></div></div>
              </> : <>
                <div className="atmosphere-now">
                  <small>{isPlaying ? "LIVE NOW" : "PAUSED"}</small>
                  <strong data-title-size={atmosphereTitleSize}>{currentTrack.title}</strong>
                  <span>{currentTrack.artist}</span>
                  <em>{currentBpm} BPM&nbsp;&nbsp;{seamless ? "BEAT FLOW ON" : "NATURAL FLOW"}</em>
                </div>
                <div className="atmosphere-lyrics">
                  <LyricsScroller
                    lines={displayedLyrics}
                    activeIndex={displayedLyricIndex}
                    variant="feature"
                    enabled={!nowPlayingOpen}
                    reducedMotion={reducedMotion}
                    trackKey={currentPreferenceKey}
                  />
                </div>
              </>}
              <button className="atmosphere-next-card" onClick={() => void nextTrack()}>
                {transitionDisplay ? <span className="flow-transition"><span className="transition-outgoing"><small>NEXT BECOMING NOW</small><strong>{transitionDisplay.incoming.track.title}</strong><em>{transitionDisplay.incoming.track.artist}</em></span><span className="transition-incoming"><small>NEXT IN FLOW</small><strong>{nextQueuedTrack?.title || "LET CODIO CHOOSE"}</strong><em>{nextQueuedTrack?.artist || "继续今晚的方向"}</em></span></span> : <span><small>NEXT IN FLOW</small><strong>{nextQueuedTrack?.title || "LET CODIO CHOOSE"}</strong><em>{nextQueuedTrack?.artist || "继续今晚的方向"}</em></span>}
                <i aria-hidden="true">›</i>
              </button>
            </div>
          </div>
        </section>

        <section className="side-stack">
          <aside className={`dj-feature glass-card ${greetingVisible ? "greeting" : ""}`}>
            <div className="dj-feature-head">
              <button
                className="dj-cloud-button"
                onClick={() => setDjOpen(true)}
                onPointerMove={handleCloudPointer}
                onPointerLeave={resetCloudPointer}
                aria-label="点击 Codio 光团进入聊天"
              >
                <span className="dj-cloud large"><i /><i /><i /><i /></span>
              </button>
              <span className="dj-title"><small>AI DJ</small><strong>CODIO</strong><em><b>DEEPSEEK V4 FLASH</b><span>理解并控制你的电台</span></em></span>
              <span className="cloud-guide"><i /> TOUCH THE LIGHT<small>点一下光团</small></span>
            </div>
            {greetingVisible && !greetingAnswered ? (
              <div className="dj-question">
                <p>晚上好。今天想让音乐抱住你，还是带你离开一会儿？</p>
                <div className="greeting-answers">
                  <button onClick={() => answerGreeting("想被音乐抱住")}>Stay with me</button>
                  <button onClick={() => answerGreeting("带我离开一会儿")}>Take me away</button>
                </div>
              </div>
            ) : (
              <div className="dj-workspace">
                <div className="dj-signal-thread" aria-label="Codio 当前聆听线索">
                  <span className="dj-thread-wave" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</span>
                  <span className="dj-thread-copy">
                    <small>TONIGHT&apos;S THREAD</small>
                    <strong>{activeQQTrack ? `${currentTrack.title} / ${currentTrack.artist}` : "No track playing"}</strong>
                    <em>{listeningPresentation.recommendation.label}</em>
                  </span>
                </div>
                <div className="dj-readout">
                  <small>LATEST FROM YOU</small>
                  <p>{listeningPresentation.companionLine}</p>
                  <span title="最近一次真实证据的时间，不是页面打开时间">{evidenceTime(listeningPresentation.lastEvidenceAt)}</span>
                </div>
                <div className="dj-context-grid" aria-label="Codio 当前使用的情境">
                  <span><small>MOMENT</small><strong>{momentContext}</strong></span>
                  <button onClick={enableWeatherContext}><small>WEATHER</small><strong>{weatherLoading ? "Reading the sky…" : weatherContext === "Weather off" ? "Add local weather" : weatherContext}</strong></button>
                  <span><small>NEXT THREAD</small><strong>{nextQueuedTrack ? `${nextQueuedTrack.title} / ${nextQueuedTrack.artist}` : "Building a fresh continuation"}</strong></span>
                  <button onClick={() => setProfileOpen(true)}><small>YOUR MEMORY</small><strong>{listeningPresentation.stats.effectiveListens} effective listens / {listeningPresentation.stats.activeFeedback} active choices</strong></button>
                </div>
              </div>
            )}
          </aside>

          <div className="quick-cards">
            <button className="profile-card glass-card" onClick={() => setProfileOpen(true)}>
              <div className="profile-art"><i /><i /><i /><i /></div>
              <span><small>YOUR LISTENING SELF</small><strong>PROFILE</strong><em>你的听歌画像</em></span>
            </button>
          </div>
        </section>

        <section className="insight-row">
          <article className="boundary-section match-section glass-card">
            <header>
              <div><small>FOR YOU · CLOSE MATCH</small><h2>Right where you are. <span>完全贴合此刻的你</span></h2></div>
              <div className="boundary-header-actions">
                <em>Drawn from your library, full listens, likes, skips and tonight&apos;s context.</em>
                <button className={`recommendation-refresh ${recommendationLoading.match ? "loading" : ""}`} disabled={recommendationLoading.match} onClick={() => void refreshRecommendations("manual", undefined, ["manual"], "match")}>
                  <i aria-hidden="true">↻</i><span><strong>{recommendationLoading.match ? "TUNING" : "REFRESH"}</strong><small>{matchedExperiments.length === 12 ? "6 + 6 READY" : "PREPARING CLOSE MATCHES"}</small></span>
                </button>
              </div>
            </header>
            {renderRecommendationPages(matchedExperiments, "match")}
          </article>

          <article className="boundary-section glass-card">
            <header>
              <div><small>FOR YOU · TASTE FRONTIER</small><h2>A little further. <span>稍微走远一点</span></h2></div>
              <div className="boundary-header-actions">
                <em>Codio is testing the edge, not changing your taste.</em>
                <button className={`recommendation-refresh ${recommendationLoading.frontier ? "loading" : ""}`} disabled={recommendationLoading.frontier} onClick={() => void refreshRecommendations("manual", undefined, ["manual"], "frontier")}>
                  <i aria-hidden="true">↻</i><span><strong>{recommendationLoading.frontier ? "TUNING" : "REFRESH"}</strong><small>{visibleExperiments.length === 12 ? "6 + 6 READY" : "PREPARING TASTE FRONTIER"}</small></span>
                </button>
              </div>
            </header>
            {renderRecommendationPages(visibleExperiments, "frontier")}
          </article>
        </section>
      </main>

      <footer className="player-bar" inert={bootPhase !== "done"}>
        <div className="playing-track-shell">
          <button className="playing-track" aria-label="进入沉浸式 Now Playing" onClick={() => setNowPlayingOpen(true)}>
            {transitionDisplay ? <span className="player-identity-transition">
              <span className="player-identity-layer transition-outgoing"><span className="player-cover"><SafeRecommendationCover src={transitionDisplay.outgoing.cover || transitionDisplay.outgoing.track.cover} fallbackSrc={transitionDisplay.outgoing.track.fallbackCover} /></span><span className="playing-meta"><strong>{transitionDisplay.outgoing.track.title}</strong><span className="playing-subline"><small>{transitionDisplay.outgoing.track.artist}</small><i aria-hidden="true" /><em>{transitionDisplay.outgoingLyric}</em></span></span></span>
              <span className="player-identity-layer transition-incoming"><span className="player-cover"><SafeRecommendationCover src={transitionDisplay.incoming.cover || transitionDisplay.incoming.track.cover} fallbackSrc={transitionDisplay.incoming.track.fallbackCover} /></span><span className="playing-meta"><strong>{transitionDisplay.incoming.track.title}</strong><span className="playing-subline"><small>{transitionDisplay.incoming.track.artist}</small><i aria-hidden="true" /><em>{transitionDisplay.incomingLyric}</em></span></span></span>
            </span> : <><span className={`player-cover ${currentTrack.color}`}><SafeRecommendationCover src={currentCoverData || currentTrack.cover} fallbackSrc={activeQQTrack?.fallbackCover} /></span><span className="playing-meta"><strong>{currentTrack.title}</strong><span className="playing-subline"><small>{currentTrack.artist}</small><i aria-hidden="true" /><em>{currentTrack.lyric}</em></span></span></>}
          </button>
        </div>
        <div className={`transport ${isPlaying ? "playing" : ""}`}>
          <div className="transport-buttons">
            <button className={`track-dislike ${dislikedTracks.has(currentPreferenceKey) ? "active" : ""}`} aria-label="不喜欢当前歌曲" title="少一点这样的歌" onClick={() => recordCurrentPreference("dislike")}>−</button>
            <button className={`track-heart ${likedTracks.has(currentPreferenceKey) ? "active" : ""}`} aria-label="这首不错" title="多一点这样的歌" onClick={() => recordCurrentPreference("like")}>{likedTracks.has(currentPreferenceKey) ? "♥" : "♡"}</button>
            <button aria-label="上一首" onClick={() => void previousTrack()}>‹</button>
            <button className="play-pause" aria-label={isPlaying ? "暂停" : "播放"} onClick={() => void togglePlayback()}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <button aria-label="下一首" onClick={() => void nextTrack()}>›</button>
            <button className={`repeat-toggle ${repeatOne ? "active" : ""}`} aria-label={repeatOne ? "关闭单曲循环" : "单曲循环"} aria-pressed={repeatOne} title="单曲循环 (R)" onClick={toggleRepeat}>↻</button>
          </div>
          <div className="progress-row" style={{ "--progress": `${progress}%` } as React.CSSProperties}>
            {transitionDisplay && activeTransitionRef.current?.id === transitionDisplay.id ? <span className="transition-time-stack"><span className="transition-outgoing">{formatTime(activeTransitionRef.current.outgoing.currentTime)}</span><span className="transition-incoming">{formatTime(activeTransitionRef.current.incoming.currentTime)}</span></span> : <span>{activeQQTrack ? formatTime(playbackTime.current) : formatProgress(progress)}</span>}
            <div className="progress-wave">
              <canvas ref={progressWaveRef} aria-hidden="true" />
              <input type="range" min="0" max="100" step="0.1" value={progress} onChange={(event) => seekPlayback(Number(event.target.value))} aria-label="播放进度" />
            </div>
            {transitionDisplay && activeTransitionRef.current?.id === transitionDisplay.id ? <span className="transition-time-stack"><span className="transition-outgoing">{formatTime(activeTransitionRef.current.outgoingSnapshot.analysis.effectiveEnd)}</span><span className="transition-incoming">{formatTime(activeTransitionRef.current.incomingSnapshot.analysis.effectiveEnd)}</span></span> : <span>{activeQQTrack ? formatTime(playbackTime.duration || activeQQTrack.durationSeconds) : currentTrack.duration}</span>}
          </div>
        </div>
        <div className="player-tools">
          <button className="np-lyric-toggle np-layout-toggle" onClick={() => setLyricMode((mode) => mode === "minimal" ? "cinematic" : "minimal")} aria-label={lyricMode === "cinematic" ? "切换到左右分栏" : "切换到大字模式"}>VIEW</button>
          <button className={`seamless-mini ${seamless ? "active" : ""}`} onClick={() => setSeamless((value) => !value)}><i /> 潜流</button>
          <input type="range" min="0" max="100" value={volume} onChange={(event) => { void changeVolume(Number(event.target.value)); }} aria-label={systemVolume?.available ? "电脑系统音量" : "音量"} aria-valuetext={`${Math.round(volume)}%${systemVolume?.muted ? "，已静音" : ""}`} title={systemVolume?.available ? "与 Windows 系统音量同步" : systemVolume ? "系统音量连接尚未就绪" : "播放器音量"} />
        </div>
      </footer>

      <section
        ref={nowStageRef}
        className={`now-playing ${nowPlayingOpen ? "open" : ""} ${transitionDisplay ? "transitioning" : ""} mode-${visualMode}`}
        data-edge={nowPlayingEdge || "none"}
        data-lyrics-mode={lyricMode}
        aria-hidden={!nowPlayingOpen}
        onPointerMove={handleNowPointerMove}
        onPointerDown={startNowDrag}
        onClick={dismissNowEdge}
        onPointerUp={stopNowDrag}
        onPointerCancel={stopNowDrag}
        onPointerLeave={() => {
          setNowPlayingEdge(null);
          nowPointerRef.current.dragging = false;
          nowPointerRef.current.returning = false;
        }}
        onWheel={zoomNowPlaying}
        onDoubleClick={(event) => {
          event.preventDefault();
          const pointer = nowPointerRef.current;
          pointer.ry += 720;
          pointer.returning = true;
          pointer.velocityX = 0;
          pointer.velocityY = -12;
          pointer.velocityZoom = 0;
          setToast("视角已回到初始位置");
        }}
      >
        <canvas ref={nowCanvasRef} className="now-canvas" aria-hidden="true" />
        {(currentCoverData || currentTrack.cover) && <div className="now-cover-wash" style={{ backgroundImage: `url(${currentCoverData || currentTrack.cover})` }} aria-hidden="true" />}
        {transitionDisplay && <div className="transition-visual-stack" aria-hidden="true">
          <div className="transition-cover outgoing" style={{ backgroundImage: `url(${transitionDisplay.outgoing.cover || transitionDisplay.outgoing.track.cover || coverFallback})` }} />
          <div className="transition-cover incoming" style={{ backgroundImage: `url(${transitionDisplay.incoming.cover || transitionDisplay.incoming.track.cover || coverFallback})` }} />
          <div className="transition-identity outgoing"><small>NOW PLAYING</small><strong>{transitionDisplay.outgoing.track.title}</strong><span>{transitionDisplay.outgoing.track.artist}</span></div>
          <div className="transition-identity incoming"><small>NEXT BECOMES NOW</small><strong>{transitionDisplay.incoming.track.title}</strong><span>{transitionDisplay.incoming.track.artist}</span></div>
          {transitionDisplay.outgoingLyric && <p className="transition-lyric outgoing">{transitionDisplay.outgoingLyric}</p>}
          {transitionDisplay.incomingLyric && <p className="transition-lyric incoming">{transitionDisplay.incomingLyric}</p>}
        </div>}
        <div className="now-ambient" aria-hidden="true" />
        <div className="now-grain" aria-hidden="true" />
        <div className="np-reading-plane">
          <div className="np-track-identity">
            <small>NOW PLAYING</small>
            <strong>{currentTrack.title}</strong>
            <span>{currentTrack.artist}</span>
          </div>
          <div className={`np-lyric ${lyricMode === "cinematic" ? "cinematic" : "minimal"}`}>
            <LyricsScroller
              lines={displayedLyrics}
              activeIndex={displayedLyricIndex}
              variant="fullscreen"
              enabled={nowPlayingOpen}
              reducedMotion={reducedMotion}
              trackKey={currentPreferenceKey}
            />
          </div>
        </div>
        <div className="np-gesture-hint"><span>DRAG</span> rotate · <span>SCROLL</span> depth</div>

        <header className="np-edge np-edge-top">
          <button className="np-back" onPointerDown={(event) => event.stopPropagation()} onClick={closeNowPlaying}>← <span>BACK TO CODIO</span></button>
          <div className="np-mode-title"><small>VISUAL FIELD</small><strong>{visualModes.find((item) => item.id === visualMode)?.label}</strong></div>
          <span className="np-top-tools">
            {sleepTimer && <button className="sleep-pill" title="点击取消睡眠定时" aria-label="取消睡眠定时" onClick={() => cancelSleepTimer()}>☾ {sleepTimer.kind === "track" ? "END OF SONG" : formatSleepRemaining(sleepRemaining)}</button>}
            <button className="np-settings" onClick={() => setSettingsOpen(true)}>VISUALS <span>⌘</span></button>
          </span>
        </header>

        <aside className="np-edge np-edge-left" onWheel={(event) => event.stopPropagation()}>
          <small>UP NEXT</small>
          <div className="np-queue-list">
            {nowPlayingQueue.map((track, index) => {
              const isQQTrack = "mid" in track;
              const active = isQQTrack ? index === activeQueueIndex : index === trackIndex;
              const upNext = isQQTrack && index === activeQueueIndex + 1;
              return (
                <div key={isQQTrack ? track.mid : track.title} className={`np-queue-item ${active ? "active" : ""} ${transitionDisplay && isQQTrack && track.mid === transitionDisplay.incoming.track.mid ? "transition-target" : ""}`}>
                  <button
                    className={`np-queue-main ${active ? "active" : ""}`}
                    onClick={() => isQQTrack ? void selectQQTrack(track, playQueue) : selectTrack(index)}
                  >
                    <span>{active ? "▶" : String(index + 1).padStart(2, "0")}</span>
                    <strong>{track.title}</strong>
                    <small>{track.artist}</small>
                  </button>
                  {isQQTrack && !active && <span className="np-queue-actions">
                    {!upNext && <button type="button" aria-label={`下一首播放 ${track.title}`} title="下一首播放" onClick={() => void enqueueNext(track)}>⤴</button>}
                    <button type="button" aria-label={`移出队列 ${track.title}`} title="移出队列" onClick={() => removeFromQueue(track.mid)}>×</button>
                  </span>}
                </div>
              );
            })}
          </div>
        </aside>

        <aside className="np-edge np-edge-right" aria-hidden="true">
          <button className="np-codio" onClick={() => setDjOpen(true)}>
            <span className="dj-cloud small"><i /><i /><i /><i /></span>
            <span><small>YOUR DJ</small><strong>CODIO</strong><em>点一下光团</em></span>
          </button>
          <button onClick={() => setSeamless((value) => !value)} className={seamless ? "active" : ""}><span className="seamless-wave"><i /><i /></span><strong>SEAMLESS</strong><small>{seamless ? "ON" : "OFF"}</small></button>
        </aside>

        <footer className="np-edge np-edge-bottom">
          <div className="playing-track-shell">
            <button className="playing-track" aria-label="返回 CODIO 主页面" onClick={closeNowPlaying}>
              {transitionDisplay ? <span className="player-identity-transition">
                <span className="player-identity-layer transition-outgoing"><span className="player-cover"><SafeRecommendationCover src={transitionDisplay.outgoing.cover || transitionDisplay.outgoing.track.cover} fallbackSrc={transitionDisplay.outgoing.track.fallbackCover} /></span><span className="playing-meta"><strong>{transitionDisplay.outgoing.track.title}</strong><span className="playing-subline"><small>{transitionDisplay.outgoing.track.artist}</small><i aria-hidden="true" /><em>{transitionDisplay.outgoingLyric}</em></span></span></span>
                <span className="player-identity-layer transition-incoming"><span className="player-cover"><SafeRecommendationCover src={transitionDisplay.incoming.cover || transitionDisplay.incoming.track.cover} fallbackSrc={transitionDisplay.incoming.track.fallbackCover} /></span><span className="playing-meta"><strong>{transitionDisplay.incoming.track.title}</strong><span className="playing-subline"><small>{transitionDisplay.incoming.track.artist}</small><i aria-hidden="true" /><em>{transitionDisplay.incomingLyric}</em></span></span></span>
              </span> : <><span className={`player-cover ${currentTrack.color}`}><SafeRecommendationCover src={currentCoverData || currentTrack.cover} fallbackSrc={activeQQTrack?.fallbackCover} /></span><span className="playing-meta"><strong>{currentTrack.title}</strong><span className="playing-subline"><small>{currentTrack.artist}</small><i aria-hidden="true" /><em>{activeLyric || currentTrack.lyric}</em></span></span></>}
            </button>
          </div>
          <div className={`transport ${isPlaying ? "playing" : ""}`}>
            <div className="transport-buttons">
              <button className={`track-dislike ${dislikedTracks.has(currentPreferenceKey) ? "active" : ""}`} aria-label="不喜欢当前歌曲" onClick={() => recordCurrentPreference("dislike")}>−</button>
              <button className={`track-heart ${likedTracks.has(currentPreferenceKey) ? "active" : ""}`} aria-label="喜欢当前歌曲" onClick={() => recordCurrentPreference("like")}>{likedTracks.has(currentPreferenceKey) ? "♥" : "♡"}</button>
              <button aria-label="上一首" onClick={() => void previousTrack()}>‹</button>
              <button className="play-pause" aria-label={isPlaying ? "暂停" : "播放"} onClick={() => void togglePlayback()}>{isPlaying ? "Ⅱ" : "▶"}</button>
              <button aria-label="下一首" onClick={() => void nextTrack()}>›</button>
              <button className={`repeat-toggle ${repeatOne ? "active" : ""}`} aria-label={repeatOne ? "关闭单曲循环" : "单曲循环"} aria-pressed={repeatOne} title="单曲循环 (R)" onClick={toggleRepeat}>↻</button>
            </div>
            <div className="progress-row" style={{ "--progress": `${progress}%` } as React.CSSProperties}>
              {transitionDisplay && activeTransitionRef.current?.id === transitionDisplay.id ? <span className="transition-time-stack"><span className="transition-outgoing">{formatTime(activeTransitionRef.current.outgoing.currentTime)}</span><span className="transition-incoming">{formatTime(activeTransitionRef.current.incoming.currentTime)}</span></span> : <span>{activeQQTrack ? formatTime(playbackTime.current) : formatProgress(progress)}</span>}
              <div className="progress-wave">
                <canvas ref={nowProgressWaveRef} aria-hidden="true" />
                <input type="range" min="0" max="100" step="0.1" value={progress} onChange={(event) => seekPlayback(Number(event.target.value))} aria-label="播放进度" />
              </div>
              {transitionDisplay && activeTransitionRef.current?.id === transitionDisplay.id ? <span className="transition-time-stack"><span className="transition-outgoing">{formatTime(activeTransitionRef.current.outgoingSnapshot.analysis.effectiveEnd)}</span><span className="transition-incoming">{formatTime(activeTransitionRef.current.incomingSnapshot.analysis.effectiveEnd)}</span></span> : <span>{activeQQTrack ? formatTime(playbackTime.duration || activeQQTrack.durationSeconds) : currentTrack.duration}</span>}
            </div>
          </div>
          <div className="player-tools">
          <button className="np-lyric-toggle np-layout-toggle" onClick={() => setLyricMode((mode) => mode === "minimal" ? "cinematic" : "minimal")} aria-label={lyricMode === "cinematic" ? "切换到左右分栏" : "切换到大字模式"}>VIEW</button>
            <button className={`seamless-mini ${seamless ? "active" : ""}`} onClick={() => setSeamless((value) => !value)}><i /> 潜流</button>
            <input type="range" min="0" max="100" value={volume} onChange={(event) => { void changeVolume(Number(event.target.value)); }} aria-label={systemVolume?.available ? "电脑系统音量" : "音量"} aria-valuetext={`${Math.round(volume)}%${systemVolume?.muted ? "，已静音" : ""}`} title={systemVolume?.available ? "与 Windows 系统音量同步" : systemVolume ? "系统音量连接尚未就绪" : "播放器音量"} />
          </div>
        </footer>
      </section>

      <div className={`dj-panel-backdrop ${djOpen ? "visible" : ""}`} onClick={() => setDjOpen(false)} />
      <aside className={`dj-panel ${djOpen ? "open" : ""}`} aria-hidden={!djOpen}>
        <header className="dj-panel-header">
          <div className="panel-person">
            <span className="dj-cloud small"><i /><i /><i /><i /></span>
            <div><strong>CODIO</strong><small><span /> 在这里，听你说</small></div>
          </div>
          <div className="panel-actions">
            <button className="close-panel" onClick={() => setDjOpen(false)} aria-label="关闭对话">×</button>
          </div>
        </header>

        <div ref={conversationRef} className="conversation">
          {!messages.length && (
            <div className="empty-conversation">
              <span className="quiet-wave"><i /><i /><i /><i /><i /></span>
              <p>I&apos;m here.</p><small>想从音乐开始，还是先说说今天？</small>
            </div>
          )}
          {messages.map((message) => (
            <div className={`message ${message.from}`} key={message.id}>
              {message.from === "dj" && <span className="message-name">CODIO</span>}
              <div className="message-bubble">
                <p>{message.text}</p>
              </div>
            </div>
          ))}
          {typing && (
            <div className="message dj typing-message">
              <span className="message-name">CODIO</span>
              <div className="typing-presence">
                <div className="message-bubble"><i /><i /><i /></div>
                <div className="thinking-trace">
                  <small>WITH YOU · {thinkingElapsed.toFixed(1)}s</small>
                  <span className="active"><i />{thinkingCue}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="quick-requests">
          {["换一首，但别跳出这个氛围", "刷新六首推荐", "分析我的 QQ 歌单", "暂停一下"].map((item) => (
            <button key={item} onClick={() => sendText(item)}>{item}</button>
          ))}
        </div>

        <form className="message-composer" onSubmit={submitMessage}>
          <button type="button" className={`ai-connection-entry ${modelConfigured ? "ready" : ""}`} onClick={() => setModelOpen(true)} aria-label={modelConfigured ? "DeepSeek AI DJ 已连接" : "连接 DeepSeek AI DJ"}>
            <small>DEEPSEEK V4 FLASH</small><strong>{modelConfigured ? "CONNECTED ON THIS DEVICE" : "CONNECT AI DJ"}</strong>
          </button>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const value = input;
                setInput("");
                sendText(value);
              }
            }}
            rows={1}
            placeholder="不用想好怎么说，慢慢来"
          />
          <button type="submit" className="send-button" disabled={!input.trim()}>↑</button>
          <small>Enter 发送 · Shift + Enter 换行</small>
        </form>
      </aside>

      <div className={`modal-backdrop profile-backdrop ${profileOpen ? "visible" : ""}`} onClick={() => setProfileOpen(false)} />
      <section className={`profile-modal ${profileOpen ? "open" : ""}`} aria-hidden={!profileOpen} aria-label="Your listening profile">
        <header className="profile-modal-head">
          <div><small>YOUR LISTENING SELF</small><h2>What stays with you. <span>你的听歌画像</span></h2></div>
          <button onClick={() => setProfileOpen(false)} aria-label="关闭声音侧写">×</button>
        </header>
        <div className="profile-modal-body">
          <nav className="profile-tabs" aria-label="声音侧写栏目">
            {(["overview", "taste", "rhythm", "context"] as ProfileView[]).map((view) => <button key={view} className={profileView === view ? "active" : ""} onClick={() => setProfileView(view)}>{view === "rhythm" ? "listening" : view === "context" ? "tonight" : view}</button>)}
          </nav>
          {profileView === "overview" && <>
            <section className="profile-type-stage">
              <div className="profile-type-mark"><small>PROFILE STATE</small><strong>{derivedProfile.confidence === "insufficient" ? "LEARNING" : derivedProfile.confidence.toUpperCase()}</strong><em>{derivedProfile.meaningfulSignalCount} VALID SIGNALS</em></div>
              <div className="profile-type-copy"><p>{listeningPresentation.summary}</p><small>LAST EVIDENCE / {evidenceTime(listeningPresentation.lastEvidenceAt)}<br />由真实收听与明确反馈更新，不根据音乐猜测人格。</small></div>
            </section>
            <section className="profile-evidence">
              <button data-tone="blue" onClick={() => setProfileView("rhythm")}><small>EFFECTIVE LISTENS</small><strong>{listeningPresentation.stats.effectiveListens}</strong><em>实际有效收听</em></button>
              <button data-tone="rose" onClick={() => setProfileView("context")}><small>EXPLICIT CHOICES</small><strong>{listeningPresentation.stats.activeFeedback}</strong><em>当前生效的明确偏好</em></button>
              <button data-tone="amber" onClick={() => setProfileView("taste")}><small>TRACKS EXPLORED</small><strong>{listeningPresentation.stats.effectiveTracks}</strong><em>不是零秒启动或导入数量</em></button>
              <button data-tone="green" onClick={() => setProfileView("taste")}><small>IMPORTED LIBRARY</small><strong>{djLibraryCount || 0}</strong><em>收藏线索，不等于实际听过</em></button>
            </section>
            <section className="profile-live-trail">
              <div><small>NEXT RECOMMENDATIONS</small><strong>{listeningPresentation.recommendation.label}</strong><p>{listeningPresentation.recommendation.detail}</p></div>
              <button onClick={() => setProfileView("context")}>SET TONIGHT</button>
            </section>
            <section className="profile-calibration profile-feedback-section"><header><h3>What you told me.</h3><p>歌曲、歌手、来源和记录时间都在这里；不再适合的偏好可以直接撤回。</p></header>{profileFeedback(4)}</section>
            <section className="profile-calibration profile-hypotheses"><header><h3>What I can support.</h3><p>这是有依据、可纠正的判断，不是人格测试。</p></header><div className="profile-question-list">{derivedProfile.hypotheses.length ? derivedProfile.hypotheses.map((hypothesis) => <div className="profile-question" key={hypothesis.hypothesisId}><span>{hypothesis.statement}<small>{hypothesis.evidenceCount} 条证据 / {hypothesis.sources.join(" / ")}</small></span><div><button onClick={() => correctProfileHypothesis(hypothesis.hypothesisId, "confirm")}><span>准确</span></button><button onClick={() => correctProfileHypothesis(hypothesis.hypothesisId, "reject")}><span>不太对</span></button><button onClick={() => correctProfileHypothesis(hypothesis.hypothesisId, "session-only")}><span>只适合今晚</span></button></div></div>) : <p className="profile-empty-note">证据还不足。你已经说过的偏好仍然有效，但我不会补上默认的性格结论。</p>}</div></section>
          </>}
          {profileView === "taste" && <section className="profile-detail-view"><header><small>LONG TERM / RECENT</small><h3>What you keep coming back to.</h3><p>{listeningPresentation.artistComparison.summary}</p></header>
            <div className="profile-artist-layers">{([['长期线索', listeningPresentation.lifetimeArtists], ['近期线索', listeningPresentation.recentArtists]] as const).map(([label, artists]) => <section key={label}><h4>{label}</h4>{artists.length ? artists.map((artist, index) => <div key={artist.name}><small>{String(index + 1).padStart(2, '0')}</small><strong>{artist.name}</strong></div>) : <p className="profile-empty-note">还没有足够的正向证据。</p>}</section>)}</div>
            <h4>有可靠歌曲证据的方向</h4><div className="taste-thread-list">{tasteLeaders.length ? tasteLeaders.map(([tag, weight]) => <span key={tag}><i style={{ width: `${Math.max(0, Math.min(100, weight / tasteLeaders[0][1] * 100))}%` }} /><strong>{tag.replace(/^genre:/, '')}</strong><em>相对支持 {weight.toFixed(2)}</em></span>) : <p className="profile-empty-note">声音特征证据不足时只展示实际歌手与收听线索，不猜测音色、情绪或编曲。</p>}</div>
            <p className="profile-empty-note">歌手倾向不代表其所有作品声音相同；这些是来自同一听歌记忆的长期与近期线索。</p>
          </section>}
          {profileView === "rhythm" && <section className="profile-detail-view"><header><small>ACTUAL LISTENING</small><h3>What held your attention.</h3><p>实际播放时间与明确反馈分开看；暂停、缓冲、拖动和播放错误不算不喜欢。</p></header>
            <div className="profile-mini-grid"><span><small>有效收听</small><strong>{listeningPresentation.stats.effectiveListens}</strong></span><span><small>听过至少 80%</small><strong>{listeningPresentation.stats.completedListens}</strong></span><span><small>喜欢 / 少听</small><strong>{listeningPresentation.stats.activeLikes} / {listeningPresentation.stats.activeDislikes}</strong></span><span><small>留存记录中的早切</small><strong>{listeningPresentation.stats.earlySkips}</strong></span></div>
            <div className="profile-listening-list">{listeningPresentation.recentListening.map(row => <div className="profile-listening-row" key={row.eventId}><div><strong>{row.title}</strong><span>{row.artist} / {row.sourceLabel}</span></div><div><strong>{Math.floor(row.listenedSeconds / 60)}:{String(Math.floor(row.listenedSeconds % 60)).padStart(2, '0')}</strong><span>{row.outcomeLabel}</span><small>{evidenceTime(row.settledAt)}</small></div></div>)}{!listeningPresentation.recentListening.length && <p className="profile-empty-note">还没有已结算的收听。歌曲结束或你主动切歌后，这里会显示真实听了多久。</p>}</div>
            <details className="profile-evidence-limits"><summary>这些数字如何计算</summary>{listeningPresentation.limitations.map(note => <p key={note}>{note}</p>)}</details>
          </section>}
          {profileView === "context" && <>
            <section className="profile-calibration"><header><h3>今晚想怎么听</h3><p>只影响这次会话，过期后归零，不改写长期画像。</p></header><div className="profile-question-list"><div className="profile-question"><span>熟悉度</span><div>{(["familiar", "balanced", "explore"] as const).map((value) => <button key={value} className={(derivedProfile.sessionIntent?.familiarity || "balanced") === value ? "selected" : ""} onClick={() => updateTonightIntent("familiarity", value)}><span>{value}</span></button>)}</div></div><div className="profile-question"><span>能量</span><div>{(["calm", "balanced", "energetic"] as const).map((value) => <button key={value} className={(derivedProfile.sessionIntent?.energy || "balanced") === value ? "selected" : ""} onClick={() => updateTonightIntent("energy", value)}><span>{value}</span></button>)}</div></div><div className="profile-question"><span>走向</span><div>{(["continuous", "balanced", "varied"] as const).map((value) => <button key={value} className={(derivedProfile.sessionIntent?.flow || "balanced") === value ? "selected" : ""} onClick={() => updateTonightIntent("flow", value)}><span>{value}</span></button>)}</div></div></div></section>
            <aside className="profile-context-note"><small>LOCAL CONTEXT</small><strong>{momentContext}</strong><p>{weatherSnapshotRef.current.at > 0 ? `天气：${weatherContext}。这是弱情境，不会覆盖你的明确偏好。` : "还没有可用的天气数据；不把未知天气当作推荐依据。"}</p><p>{derivedProfile.sessionIntent ? `这次意图有效至 ${evidenceTime(derivedProfile.sessionIntent.expiresAt)}。能量是你提出的愿望，不是已测量的声音特征。` : "未设置临时意图，沿用有证据的总体画像。"}</p>{!weatherSnapshotRef.current.at && <button onClick={enableWeatherContext}>{weatherLoading ? "READING…" : "CONNECT WEATHER"}</button>}</aside>
            <section className="profile-calibration profile-feedback-section"><header><h3>Your choices, editable.</h3><p>只撤回选择的这一条，不删除历史，也不影响 QQ 登录或 DeepSeek Key。</p></header>{profileFeedback()}<details className="profile-evidence-limits"><summary>管理画像数据</summary><button onClick={() => { if (!window.confirm("只清除 CODIO 的听歌画像和推荐记忆。QQ 登录、主题、音量和 API Key 都会保留。继续吗？")) return; const empty = createEmptyListeningMemory(); listeningMemoryRef.current = empty; setListeningMemory(empty); saveListeningMemory(window.localStorage, empty); setToast("画像已清除；QQ 登录和应用设置保持不变"); }}>清除全部画像</button></details></section>
          </>}
        </div>
        <footer className="profile-modal-actions">
          <button onClick={() => {
            if (qqConnection === "connected") void syncQQTaste();
            else {
              setProfileOpen(false);
              setImportSource("qq");
              setImportOpen(true);
            }
          }}>READ MY LIBRARY</button>
          <button onClick={() => {
            setProfileOpen(false);
            setDjOpen(true);
            sendText("只根据有证据的听歌画像，告诉我你目前最确定什么、依据是什么、还不确定什么，以及我可以怎样纠正你");
          }}>ASK CODIO ABOUT ME</button>
        </footer>
      </section>

      <div className={`modal-backdrop import-backdrop ${importOpen ? "visible" : ""}`} onClick={() => setImportOpen(false)} />
      <section className={`import-modal ${importOpen ? "open" : ""}`} aria-hidden={!importOpen}>
        <header>
          <div><small>START WITH YOUR HISTORY</small><h2>Bring your music in. <span>先让 Codio 认识你</span></h2></div>
          <button onClick={() => setImportOpen(false)}>×</button>
        </header>
        <div className="source-tabs">
          {(["qq", "local"] as const).map((source) => (
            <button key={source} className={importSource === source ? "active" : ""} onClick={() => {
              setImportSource(source);
              setImportState("idle");
              if (source === "qq") void connectQQMusic(false);
            }}>
              <i className={source} />
              <span><strong>{source === "qq" ? "QQ MUSIC" : "LOCAL FILES"}</strong><small>{source === "local" ? "PCM / Float WAV" : "Playlists & library"}</small></span>
            </button>
          ))}
        </div>
        <div className={`import-stage state-${importState} ${importSource === "qq" ? `qq-state-${qqConnection}` : ""}`}>
          {importState === "idle" && importSource !== "qq" && (
            <>
              <div className="bridge-visual"><i /><i /><i /><span>CODIO<br />BRIDGE</span></div>
              <div className="import-explanation">
                <small>{importSource === "local" ? "ON-DEVICE SCAN" : "LOCAL ACCOUNT BRIDGE"}</small>
                <h3>{importSource === "local" ? "Choose your music folders." : "Your login stays on this computer."}</h3>
                <p>PCM / Float WAV only. Unknown artist and album stay unknown. Other formats are reported as unsupported, not silently imported.</p>
                <button onClick={() => void importLocal("folder")}>CHOOSE A FOLDER</button>
                {localTracks.length > 0 && <button onClick={() => setImportState("ready")}>SAVED LOCAL MUSIC · {localTracks.length}</button>}
              </div>
            </>
          )}
          {importSource === "qq" && importState === "idle" && (
            <div className="qq-connection-state">
              <div className="bridge-visual qq-bridge"><i /><i /><i /><span>QQ MUSIC<br />AUTH</span></div>
              <div className="import-explanation">
                <small>OFFICIAL QQ MUSIC CONNECTION</small>
                <h3>{qqConnection === "unavailable" ? "Continue in CODIO Desktop." : qqConnection === "error" ? "QQ Music did not answer." : qqConnection === "needs-auth" ? "Authorize CODIO in QQ Music." : "Checking the music account…"}</h3>
                <p>{qqConnection === "unavailable" ? "A normal browser cannot safely keep the QQ Music playback ticket. CODIO Desktop opens the official QQ Music page and keeps that session only on this computer." : qqConnection === "error" ? "The local QQ Music bridge is present, but the authorization check failed. Nothing was imported." : "Your password stays with QQ Music. After approval, CODIO keeps the private session on this device and returns only account status to this page."}</p>
                <div className="qq-capabilities">
                  <span><i className={qqConnection === "needs-auth" ? "ready" : ""} /><strong>MUSIC AUTH</strong><small>{qqConnection === "needs-auth" ? "ready" : "waiting for official access"}</small></span>
                  <span><i /><strong>PLAYLIST LIBRARY</strong><small>coverage checked after approval</small></span>
                  <span><i /><strong>MEMBER PLAYBACK</strong><small>verified by QQ Music</small></span>
                </div>
                {qqConnection === "unavailable" && <span className="qq-requirements">DESKTOP BRIDGE REQUIRED · LOCAL SESSION ONLY</span>}
              </div>
            </div>
          )}
          {importState === "scanning" && <div className="import-scanning"><span className="scan-orb"><i /><i /></span><small>{importSource === "qq" ? (qqConnection === "authorizing" ? "AUTHORIZATION OPENED IN QQ MUSIC" : "SYNCING YOUR MUSIC SHAPE") : "READING SELECTED WAV FILES"}</small><strong>{importSource === "qq" ? (qqConnection === "authorizing" ? "Approve there, then come back." : "Reading playlist tracks and coverage.") : "Reading file identities and supported tags."}</strong>{importSource === "qq" && qqConnection === "authorizing" && <p>When QQ Music returns you to CODIO, choose “CHECK AUTHORIZATION”.</p>}<div><i /><i /><i /></div></div>}
          {importState === "ready" && (importSource === "qq" ? <div className="import-ready qq-ready"><span>✓</span><small>AUTHORIZED BY QQ MUSIC</small><h3>Your synced music library.</h3><div><strong>{qqSummary.playlists}<small>playlists found</small></strong><strong>{qqSummary.recent}<small>synced playlist tracks</small></strong><strong>{qqTasteSnapshot?.coverage?.partial ? "PARTIAL" : "READ"}<small>library coverage</small></strong></div><p>QQ owns playback rights. CODIO recent plays are recorded separately; a partial sync retains previous valid relationships.</p></div> : <div className="import-ready"><span>✓</span><small>LOCAL WAV LIBRARY</small><h3>{localTracks.length} playable file identities.</h3><div><strong>{localImportResult.imported}<small>new</small></strong><strong>{localImportResult.duplicates}<small>duplicates</small></strong><strong>{localImportResult.failed}<small>failed / unsupported</small></strong></div><div className="np-queue-items" style={{ maxHeight: 160, overflowY: "auto" }}>{localTracks.slice(0, 100).map(track => <button key={track.mid} onClick={() => void selectQQTrack(track, localTracks)}><strong>{track.title}</strong><small>{track.artist} · {Math.round(track.durationSeconds)}s</small></button>)}</div><p>Only listening and explicit feedback build taste. Unknown tags remain unknown.</p></div>)}
        </div>
        <footer>
          <span><i /> {importSource === "qq" ? (qqConnection === "unavailable" ? "OFFICIAL MUSIC ACCESS REQUIRED" : "PASSWORD STAYS IN QQ MUSIC") : "LOCAL-FIRST · PRIVATE BY DEFAULT"}</span>
          <button onClick={startImport} disabled={importState === "scanning" && importSource !== "qq"}>{importState === "ready" ? "ENTER YOUR RADIO" : importSource === "qq" ? (qqConnection === "needs-auth" ? "AUTHORIZE IN QQ MUSIC" : qqConnection === "authorizing" ? "CHECK AUTHORIZATION" : qqConnection === "unavailable" ? "OPEN CODIO DESKTOP" : qqConnection === "error" ? "TRY AGAIN" : "CHECKING…") : importState === "scanning" ? "ANALYZING…" : importSource === "local" ? "CHOOSE FOLDERS" : "START LOCAL IMPORT"}</button>
        </footer>
      </section>

      <div className={`modal-backdrop ${settingsOpen ? "visible" : ""}`} onClick={() => setSettingsOpen(false)} />
      <section className={`settings-modal ${settingsOpen ? "open" : ""}`} aria-hidden={!settingsOpen}>
        <header><div><small>MAKE IT YOURS</small><h2>Personalize <span>个性设置</span></h2></div><button onClick={() => setSettingsOpen(false)}>×</button></header>
        <div className="setting-group">
          <div className="setting-title"><strong>ATMOSPHERE</strong><small>空间气氛也可以直接告诉 Codio 调整</small></div>
          <div className="scene-options">
            {(["night", "dawn", "deep"] as Scene[]).map((key) => (
              <button key={key} className={`${key} ${scene === key ? "selected" : ""}`} onClick={() => setScene(key)}><i /><span>{key === "night" ? "夜潮" : key === "dawn" ? "余晖" : "深海"}</span></button>
            ))}
          </div>
          <div className="range-setting"><span><strong>粒子密度</strong><small>{particleLevel === 0 ? "安静" : particleLevel === 1 ? "轻柔" : "丰盈"}</small></span><input type="range" min="0" max="2" step="1" value={particleLevel} onChange={(event) => setParticleLevel(Number(event.target.value))} /></div>
          <label className="switch-row"><span><strong>减少动态效果</strong><small>保留层次，降低移动幅度</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /><i /></label>
        </div>
        <div className="setting-group">
          <div className="setting-title"><strong>NOW PLAYING FIELD</strong><small>中央区域只负责视觉互动，功能只在四边缘出现</small></div>
          <div className="visual-mode-grid">
            {visualModes.map((mode) => (
              <button key={mode.id} className={`${mode.id} ${visualMode === mode.id ? "selected" : ""}`} onClick={() => setVisualMode(mode.id)}>
                <i><span /><span /><span /></i>
                <span><strong>{mode.label}</strong><small>{mode.note}</small></span>
              </button>
            ))}
          </div>
        </div>
        <div className="setting-group compact">
          <label className="switch-row"><span><strong>潜流 · 无缝电台</strong><small>让相近的歌曲自然连成一段旅程</small></span><input type="checkbox" checked={seamless} onChange={(event) => setSeamless(event.target.checked)} /><i /></label>
          <label className="switch-row"><span><strong>单曲循环</strong><small>这首歌会一直播下去，潜流衔接暂停</small></span><input type="checkbox" checked={repeatOne} onChange={toggleRepeat} /><i /></label>
        </div>
        <div className="setting-group">
          <div className="setting-title"><strong>SLEEP TIMER</strong><small>{sleepTimer ? (sleepTimer.kind === "track" ? "这首歌结束后停止" : `${formatSleepRemaining(sleepRemaining)} 后轻轻停下`) : "到点后在最后 20 秒慢慢淡出，不会突然中断"}</small></div>
          <div className="sleep-options">
            {SLEEP_TIMER_MINUTES.map((minutes) => (
              <button key={minutes} type="button" className={sleepTimer?.kind === "clock" && sleepTimer.minutes === minutes ? "selected" : ""} onClick={() => startSleepTimer(minutes)}>{minutes}<small>MIN</small></button>
            ))}
            <button type="button" className={sleepTimer?.kind === "track" ? "selected" : ""} onClick={() => startSleepTimer("track")}>本曲<small>结束</small></button>
            {sleepTimer && <button type="button" className="sleep-cancel" onClick={() => cancelSleepTimer()}>取消</button>}
          </div>
        </div>
        <div className="setting-group">
          <div className="setting-title"><strong>KEYBOARD</strong><small>按 ? 随时查看；在输入框里打字不会触发</small></div>
          <ul className="shortcut-list">
            {SHORTCUT_GUIDE.map((item) => <li key={item.label}><span>{item.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span><small>{item.label}</small></li>)}
          </ul>
        </div>
        <div className="setting-group">
          <div className="setting-title"><strong>YOUR DATA</strong><small>听歌记忆、画像、历史和设置只在这台电脑。备份文件可以带到新电脑；不包含 QQ 登录和 DeepSeek Key</small></div>
          <div className="backup-row">
            <button type="button" onClick={exportListeningData}>EXPORT BACKUP</button>
            <button type="button" onClick={() => backupInputRef.current?.click()}>RESTORE FROM FILE</button>
            <input ref={backupInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void importListeningData(file); }} />
          </div>
          {backupNotice && <p className="backup-notice">{backupNotice}</p>}
        </div>
        <div className="setting-group compact onboarding-reopen-row">
          <span><strong>FIRST LISTEN GUIDE</strong><small>重新查看连接步骤；不会清除 QQ 登录、DeepSeek Key、画像或历史</small></span>
          <button type="button" onClick={reopenOnboarding}>OPEN GUIDE</button>
        </div>
      </section>

      <div className={`modal-backdrop ${shortcutsOpen ? "visible" : ""}`} onClick={() => setShortcutsOpen(false)} />
      <section className={`settings-modal shortcuts-modal ${shortcutsOpen ? "open" : ""}`} aria-hidden={!shortcutsOpen} aria-label="键盘快捷键">
        <header><div><small>KEYBOARD</small><h2>Shortcuts <span>快捷键</span></h2></div><button onClick={() => setShortcutsOpen(false)}>×</button></header>
        <div className="setting-group compact">
          <ul className="shortcut-list">
            {SHORTCUT_GUIDE.map((item) => <li key={item.label}><span>{item.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span><small>{item.label}</small></li>)}
          </ul>
        </div>
      </section>

      <div className={`modal-backdrop model-backdrop ${modelOpen ? "visible" : ""}`} onClick={() => setModelOpen(false)} />
      <section className={`model-modal ${modelOpen ? "open" : ""}`} aria-hidden={!modelOpen} aria-label="DeepSeek AI DJ connection">
        <header><div><small>DEEPSEEK V4 FLASH</small><h2>Connect AI DJ. <span>仅保存在这台设备</span></h2></div><button onClick={() => setModelOpen(false)}>×</button></header>
        <div className="model-modal-body">
          <form className={`model-key-card ${modelConfigured ? "connected" : ""}`} onSubmit={connectDeepSeek}>
            <span><small>LOCAL CONNECTION</small><strong>{modelConfigured ? "CONNECTED ON THIS DEVICE" : "CONNECT YOUR API KEY"}</strong></span>
            <p>{modelConfigured ? "Codio 现在会把对话和当前电台状态交给 DeepSeek V4 Flash 理解。" : "粘贴你保存的完整 sk- 密钥。输入内容不会离开本机，直到你主动发起对话。"}</p>
            {!modelConfigured && <input type="password" autoComplete="off" spellCheck={false} value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} placeholder="sk-••••••••••••••••" aria-label="DeepSeek API key" />}
            {apiKeyError && <em>{apiKeyError}</em>}
            {modelConfigured
              ? <button className="remove-key" type="button" onClick={disconnectDeepSeek} disabled={apiKeySaving}>REMOVE FROM THIS DEVICE</button>
              : <button type="submit" disabled={apiKeySaving || !apiKeyInput.trim()}>{apiKeySaving ? "CONNECTING…" : "CONNECT DEEPSEEK"}</button>}
          </form>
        </div>
      </section>

      {toast && <div className={`toast tone-${toast === noticeTitleRef.current ? noticeTone : "listening"}`} role="status" aria-live="polite">
        <span aria-hidden="true"><i /></span>
        <div><strong>{toast}</strong>{toast === noticeTitleRef.current && noticeDetail && <small>{noticeDetail}</small>}</div>
      </div>}
    </div>
  );
}
