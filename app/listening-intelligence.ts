export const LISTENING_MEMORY_KEY = "codio-listening-memory-v2";
export const LISTENING_MEMORY_VERSION = 2 as const;
export const MAX_RAW_EVENTS = 1200;
export const RECENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
export const LIFETIME_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
export const SESSION_INTENT_TTL_MS = 18 * 60 * 60 * 1000;

export type ConfidenceLevel = "insufficient" | "growing" | "reliable";
export type PreferenceValue = "more" | "less" | "neutral";
export type PreferenceScope = "track" | "style" | "artist" | "session";
export type RecommendationLane = "match" | "frontier";
export type FeatureSource =
  | "provider_metadata"
  | "audio_analysis"
  | "library_behavior"
  | "playlist_name_hint"
  | "artist_hint"
  | "recommendation_heuristic";

export type FeatureEvidence<T> = {
  value: T | null;
  source: FeatureSource;
  confidence: number;
  profileEligible: boolean;
};

export type TrackFeatureVector = {
  provider: string;
  trackId: string;
  artist: string;
  album?: string;
  tags: Array<FeatureEvidence<string>>;
  bpm: FeatureEvidence<number>;
  energy: FeatureEvidence<number>;
  vocalFocus: FeatureEvidence<number>;
  instrumentalFocus: FeatureEvidence<number>;
  transitionFocus: FeatureEvidence<"beats" | "vocal" | "full">;
  inLibrary: boolean;
  likedInProvider: boolean;
  artistFamiliarity: number;
  playlistMembership: string[];
  firstSeenAt?: number;
  lastPlayedAt?: number;
  playCount: number;
  novelty: FeatureEvidence<number>;
  metadataConfidence: number;
};

export type SessionIntent = {
  familiarity: "familiar" | "balanced" | "explore";
  energy: "calm" | "balanced" | "energetic";
  flow: "continuous" | "balanced" | "varied";
  createdAt: number;
  expiresAt: number;
};

export type PlaySettledEvent = {
  type: "play_settled";
  eventId: string;
  sessionId: string;
  trackKey: string;
  provider: string;
  providerTrackId: string;
  title: string;
  artist: string;
  album?: string;
  features?: TrackFeatureVector;
  startedAt: number;
  settledAt: number;
  listenedSeconds: number;
  durationSeconds: number;
  completionRatio: number;
  exitReason: "ended" | "skip" | "switch" | "dislike" | "error";
  source: "recommendation_match" | "recommendation_frontier" | "search" | "library" | "queue" | "manual";
  previousTrackKey?: string;
  queuePosition?: number;
  timeBucket?: string;
  weatherContext?: string;
  sessionIntent?: SessionIntent;
  metadataConfidence: number;
  replay?: boolean;
};

export type PreferenceChangedEvent = {
  type: "preference_changed";
  eventId: string;
  targetType: "track" | "artist" | "feature" | "session";
  targetKey: string;
  value: PreferenceValue;
  scope: PreferenceScope;
  reason?: string;
  title?: string;
  artist?: string;
  source?: "dj" | "player" | "legacy";
  createdAt: number;
  supersedesEventId?: string;
  sessionId: string;
  features?: TrackFeatureVector;
};

export type ProfileCorrectedEvent = {
  type: "profile_corrected";
  eventId: string;
  hypothesisId: string;
  verdict: "confirm" | "reject" | "session-only" | "ignore-behavior";
  correction?: string;
  createdAt: number;
};

export type SessionIntentChangedEvent = {
  type: "session_intent_changed";
  eventId: string;
  sessionId: string;
  intent: SessionIntent;
  createdAt: number;
};

export type ManualIntentEvent = {
  type: "manual_intent";
  eventId: string;
  sessionId: string;
  trackKey?: string;
  action: "search" | "play" | "repeat" | "recommendation_select" | "history_select";
  query?: string;
  createdAt: number;
};

export type ListeningEvent = PlaySettledEvent | PreferenceChangedEvent | ProfileCorrectedEvent | SessionIntentChangedEvent | ManualIntentEvent;

export type TrackMemory = {
  trackKey: string;
  title: string;
  artist: string;
  playCount: number;
  settledPlayCount: number;
  completionCount: number;
  replayCount: number;
  listenedSeconds: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastExitReason?: PlaySettledEvent["exitReason"];
  features?: TrackFeatureVector;
  effectivePlayCount?: number;
  lastEffectiveAt?: number;
};

export type AggregateEvidence = {
  positive: number;
  negative: number;
  evidenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  // Only evicted settlements enter these decayed summaries. Explicit feedback
  // remains in explicitPreferences and is never folded into this history.
  profile?: {
    at: number;
    artist: string;
    lifetime: ProfileLayer;
    recent: ProfileLayer;
    sessionId: string;
    session: ProfileLayer;
    contexts: Record<string, ProfileLayer>;
    positiveTotal: number;
    trackPositive: number;
    trackNegative: number;
  };
};

export type ListeningMemory = {
  version: typeof LISTENING_MEMORY_VERSION;
  rawEvents: ListeningEvent[];
  trackMemories: Record<string, TrackMemory>;
  explicitPreferences: PreferenceChangedEvent[];
  corrections: ProfileCorrectedEvent[];
  longTermAggregates: Record<string, AggregateEvidence>;
  sessionIntent: SessionIntent | null;
  currentSession: { sessionId: string; startedAt: number };
  migratedEventIds: string[];
  migratedAt: number | null;
  processedEventIds?: string[];
  updatedAt: number;
};

export type ListeningSession = {
  sessionId: string;
  trackKey: string;
  startedAt: number;
  lastMediaTime: number;
  listenedSeconds: number;
  settled: boolean;
};

export type ProfileLayer = {
  tagAffinities: Record<string, number>;
  artistAffinities: Record<string, number>;
  evidenceCount: number;
  distinctTrackCount: number;
  tempoAffinities?: Record<string, number>;
  effectiveEvidenceWeight?: number;
};

export type ListeningHypothesis = {
  hypothesisId: string;
  statement: string;
  confidence: number;
  evidenceCount: number;
  sources: string[];
  applicableContext: string;
  effectOnRecommendations: string;
};

export type DerivedListeningProfile = {
  meaningfulSignalCount: number;
  distinctTrackCount: number;
  explicitFeedbackCount: number;
  implicitFeedbackCount: number;
  confidence: ConfidenceLevel;
  lifetimeProfile: ProfileLayer;
  recentProfile: ProfileLayer;
  contextualProfiles: Record<string, ProfileLayer & { reliability: number }>;
  sessionProfile: ProfileLayer;
  sessionIntent: SessionIntent | null;
  anchorArtists: Array<{ name: string; score: number }>;
  hypotheses: ListeningHypothesis[];
  recentEffects: string[];
  historicalInterests: string[];
  recentChanges: string[];
  returningInterests: string[];
};

export type CandidateTrack = {
  canonicalKey: string;
  track: { provider: string; id: string; title: string; artist: string };
  source: "familiar_anchor" | "adjacent_discovery" | "returning_interest" | "uncertainty_exploration" | "session_intent";
  generationReason: string;
  featureVector: TrackFeatureVector;
  sourceConfidence: number;
  alreadyHeard: boolean;
  inLibrary: boolean;
  alreadyRecommended: boolean;
  playable: boolean;
};

export type ScoreContribution = {
  key: string;
  signedWeight: number;
  rawValue: number;
  confidence: number;
  evidenceCount: number;
  reason: string;
  source: string;
};

export type RecommendationScore = {
  candidateKey: string;
  lane: RecommendationLane;
  totalScore: number;
  contributions: ScoreContribution[];
  topReasons: string[];
  penalties: string[];
  uncertainty: number;
  laneEvidence?: { calibrated: boolean; match: boolean; frontier: boolean; strength: number; artistLinked: boolean; reason: string };
};

const clamp = (value: number, min = -1, max = 1) => Math.max(min, Math.min(max, value));
const normalize = (value: string) => value.trim().toLocaleLowerCase();
const stableHash = (value: string) => [...value].reduce((hash, character) => ((hash * 33) ^ character.charCodeAt(0)) >>> 0, 5381).toString(36);

export function canonicalTrackKey(provider: string, providerTrackId: string) {
  return `${normalize(provider)}:${providerTrackId.trim()}`;
}

export function createSessionIntent(partial: Partial<Pick<SessionIntent, "familiarity" | "energy" | "flow">> = {}, now = Date.now()): SessionIntent {
  return {
    familiarity: partial.familiarity || "balanced",
    energy: partial.energy || "balanced",
    flow: partial.flow || "balanced",
    createdAt: now,
    expiresAt: now + SESSION_INTENT_TTL_MS,
  };
}

export function createEmptyListeningMemory(now = Date.now()): ListeningMemory {
  return {
    version: LISTENING_MEMORY_VERSION,
    rawEvents: [],
    trackMemories: {},
    explicitPreferences: [],
    corrections: [],
    longTermAggregates: {},
    sessionIntent: null,
    currentSession: { sessionId: `session-${now.toString(36)}`, startedAt: now },
    migratedEventIds: [],
    migratedAt: null,
    processedEventIds: [],
    updatedAt: now,
  };
}

function safeArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function sanitizeMemory(value: unknown, now: number): ListeningMemory {
  const empty = createEmptyListeningMemory(now);
  if (!value || typeof value !== "object") return empty;
  const record = value as Partial<ListeningMemory>;
  const explicitPreferences = Array.isArray(record.explicitPreferences) ? record.explicitPreferences : [];
  // Old player buttons used a temporary scope for an explicit single-track choice.
  // Repair the same evidence ID; DJ/tonight choices and later withdrawals stay intact.
  const playerDislikeIds = new Set(explicitPreferences.filter(event => event?.type === "preference_changed"
    && event.source === "player" && event.reason === "player_less" && event.targetType === "track"
    && event.value === "less" && event.scope === "session").map(event => event.eventId));
  const restorePlayerDislike = (event: PreferenceChangedEvent): PreferenceChangedEvent => playerDislikeIds.has(event.eventId) ? { ...event, scope: "track" } : event;
  return {
    ...empty,
    ...record,
    version: LISTENING_MEMORY_VERSION,
    rawEvents: Array.isArray(record.rawEvents) ? record.rawEvents.filter((event) => event && typeof event === "object" && typeof event.eventId === "string").slice(-MAX_RAW_EVENTS)
      .map(event => event.type === "preference_changed" ? restorePlayerDislike(event) : event) : [],
    trackMemories: record.trackMemories && typeof record.trackMemories === "object" ? record.trackMemories : {},
    explicitPreferences: explicitPreferences.map(restorePlayerDislike),
    corrections: Array.isArray(record.corrections) ? record.corrections : [],
    longTermAggregates: record.longTermAggregates && typeof record.longTermAggregates === "object" ? record.longTermAggregates : {},
    migratedEventIds: Array.isArray(record.migratedEventIds) ? record.migratedEventIds.filter((id): id is string => typeof id === "string") : [],
    processedEventIds: Array.isArray(record.processedEventIds) ? record.processedEventIds : [],
  };
}

/** Resolve old lowercased IDs only when retained provider evidence is unambiguous. */
function migrateProviderIdentities(memory: ListeningMemory, verified?: TrackFeatureVector): ListeningMemory {
  const identities = new Map<string, Set<string>>();
  const register = (provider: string, id: string) => {
    if (!provider || !id) return;
    const key = canonicalTrackKey(provider, id);
    const legacy = key.toLowerCase();
    const matches = identities.get(legacy) || new Set<string>();
    matches.add(key); identities.set(legacy, matches);
  };
  if (verified) register(verified.provider, verified.trackId);
  memory.rawEvents.forEach(event => {
    if (event.type === "play_settled") register(event.provider, event.providerTrackId);
    if (event.type === "preference_changed" && event.features) register(event.features.provider, event.features.trackId);
  });
  Object.values(memory.trackMemories).forEach(track => {
    if (track.features) register(track.features.provider, track.features.trackId);
  });
  const resolve = (key: string) => {
    const matches = identities.get(key.toLowerCase());
    return matches?.size === 1 ? [...matches][0] : key;
  };
  const migrateEvent = (event: ListeningEvent): ListeningEvent => event.type === "play_settled"
    ? { ...event, trackKey: canonicalTrackKey(event.provider, event.providerTrackId), previousTrackKey: event.previousTrackKey ? resolve(event.previousTrackKey) : undefined }
    : event.type === "preference_changed" && event.targetType === "track" ? { ...event, targetKey: resolve(event.targetKey) }
      : event.type === "manual_intent" && event.trackKey ? { ...event, trackKey: resolve(event.trackKey) } : event;
  const tracks: Record<string, TrackMemory> = {};
  for (const [key, track] of Object.entries(memory.trackMemories)) {
    const nextKey = resolve(key);
    // Ambiguous legacy collisions remain separate, rather than inventing an identity.
    if (tracks[nextKey]) tracks[key] = track;
    else tracks[nextKey] = { ...track, trackKey: nextKey };
  }
  const aggregates: Record<string, AggregateEvidence> = {};
  for (const [key, aggregate] of Object.entries(memory.longTermAggregates)) {
    const nextKey = key.startsWith("track:") ? `track:${resolve(key.slice(6))}` : key;
    aggregates[aggregates[nextKey] ? key : nextKey] = aggregate;
  }
  return { ...memory, trackMemories: tracks, longTermAggregates: aggregates,
    rawEvents: memory.rawEvents.map(migrateEvent), explicitPreferences: memory.explicitPreferences.map(event => migrateEvent(event) as PreferenceChangedEvent) };
}

export type LegacyListeningData = { tasteSignals?: string | null; playedHistory?: string | null; profileAnswers?: string | null };

export function migrateLegacyListeningData(memory: ListeningMemory, legacy: LegacyListeningData, now = Date.now()): ListeningMemory {
  let next = sanitizeMemory(memory, now);
  const migrated = new Set(next.migratedEventIds);
  for (const rawSignal of safeArray(legacy.tasteSignals)) {
    if (!rawSignal || typeof rawSignal !== "object") continue;
    const signal = rawSignal as Record<string, unknown>;
    const type = String(signal.type || "");
    if (!['playback_like', 'playback_dislike', 'discovery_like'].includes(type)) continue;
    const providerId = String(signal.id || signal.mid || `${signal.title || "unknown"}:${signal.artist || "unknown"}`);
    const eventId = `legacy-signal-${stableHash(JSON.stringify(signal))}`;
    if (migrated.has(eventId)) continue;
    const event: PreferenceChangedEvent = {
      type: "preference_changed",
      eventId,
      targetType: "track",
      targetKey: canonicalTrackKey(String(signal.provider || "qq"), providerId),
      value: type === "playback_dislike" ? "less" : "more",
      scope: type === "playback_dislike" ? "session" : "track",
      reason: "migrated_legacy_signal",
      title: String(signal.title || ""),
      artist: String(signal.artist || ""),
      source: "legacy",
      createdAt: Number.isFinite(Date.parse(String(signal.time || ""))) ? Date.parse(String(signal.time)) : now,
      sessionId: next.currentSession.sessionId,
    };
    next = recordListeningEvent(next, event);
    migrated.add(eventId);
  }
  for (const rawTrack of safeArray(legacy.playedHistory)) {
    if (!rawTrack || typeof rawTrack !== "object") continue;
    const track = rawTrack as Record<string, unknown>;
    const providerId = String(track.mid || track.id || `${track.title || "unknown"}:${track.artist || "unknown"}`);
    const eventId = `legacy-history-${stableHash(JSON.stringify(track))}`;
    if (migrated.has(eventId)) continue;
    const event: ManualIntentEvent = {
      type: "manual_intent",
      eventId,
      sessionId: next.currentSession.sessionId,
      trackKey: canonicalTrackKey(String(track.provider || "qq"), providerId),
      action: "history_select",
      createdAt: now,
    };
    next = recordListeningEvent(next, event);
    migrated.add(eventId);
  }
  let profileAnswers: Record<string, unknown> = {};
  try { profileAnswers = JSON.parse(legacy.profileAnswers || "{}"); } catch { profileAnswers = {}; }
  if (profileAnswers && Object.keys(profileAnswers).length) {
    const eventId = `legacy-calibration-${stableHash(JSON.stringify(profileAnswers))}`;
    if (!migrated.has(eventId)) {
      next = recordListeningEvent(next, {
        type: "manual_intent",
        eventId,
        sessionId: next.currentSession.sessionId,
        action: "search",
        query: `legacy-calibration:${JSON.stringify(profileAnswers)}`,
        createdAt: now,
      });
      migrated.add(eventId);
    }
  }
  return { ...next, migratedEventIds: [...migrated], migratedAt: next.migratedAt || now, updatedAt: now };
}

export function loadListeningMemory(storage: Pick<Storage, "getItem">, now = Date.now()): ListeningMemory {
  let parsed: unknown = null;
  try { parsed = JSON.parse(storage.getItem(LISTENING_MEMORY_KEY) || "null"); } catch { parsed = null; }
  return migrateProviderIdentities(migrateLegacyListeningData(sanitizeMemory(parsed, now), {
    tasteSignals: storage.getItem("codio-taste-signals"),
    playedHistory: storage.getItem("codio-played-history"),
    profileAnswers: storage.getItem("codio-profile-answers"),
  }, now));
}

export function saveListeningMemory(storage: Pick<Storage, "setItem">, memory: ListeningMemory) {
  storage.setItem(LISTENING_MEMORY_KEY, JSON.stringify(memory));
}

const emptyLayer = (): ProfileLayer => ({ tagAffinities: {}, artistAffinities: {}, tempoAffinities: {}, evidenceCount: 0, distinctTrackCount: 0, effectiveEvidenceWeight: 0 });

function scaleLayer(layer: ProfileLayer, weight: number): ProfileLayer {
  const scale = (values: Record<string, number> = {}) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value * weight]));
  return { ...layer, tagAffinities: scale(layer.tagAffinities), artistAffinities: scale(layer.artistAffinities), tempoAffinities: scale(layer.tempoAffinities), effectiveEvidenceWeight: (layer.effectiveEvidenceWeight ?? layer.evidenceCount) * weight };
}

function mergeLayer(target: ProfileLayer, source: ProfileLayer) {
  for (const field of ["tagAffinities", "artistAffinities", "tempoAffinities"] as const) {
    target[field] ||= {};
    for (const [key, value] of Object.entries(source[field] || {})) target[field]![key] = (target[field]![key] || 0) + value;
  }
  target.evidenceCount += source.evidenceCount;
  target.effectiveEvidenceWeight = (target.effectiveEvidenceWeight || 0) + (source.effectiveEvidenceWeight ?? source.evidenceCount);
}

function addBehavior(layer: ProfileLayer, event: PlaySettledEvent, strength: number, weight = 1, sessionNegative = false) {
  layer.evidenceCount += 1;
  layer.effectiveEvidenceWeight = (layer.effectiveEvidenceWeight || 0) + weight;
  if (strength > 0) addLayerValue(layer, "artist", normalize(event.artist), strength * weight);
  const eligible = event.features?.tags.filter(tag => tag.value && tag.profileEligible && tag.confidence >= .45) || [];
  if (strength > 0 || sessionNegative) eligible.forEach(tag => addLayerValue(layer, "tag", normalize(tag.value!), strength * tag.confidence * weight));
  const bpm = event.features?.bpm;
  if (strength > 0 && reliableTempo(bpm)) {
    layer.tempoAffinities ||= {};
    const key = String(Math.round(bpm!.value! * 10) / 10);
    layer.tempoAffinities[key] = (layer.tempoAffinities[key] || 0) + strength * bpm!.confidence * weight;
  }
}

function aggregateOldEvent(aggregates: Record<string, AggregateEvidence>, event: ListeningEvent, sessionId: string) {
  if (event.type !== "play_settled" || event.exitReason === "error") return aggregates;
  const strength = implicitSignalStrength(event);
  if (!strength) return aggregates;
  const key = `track:${event.trackKey}`;
  const current = aggregates[key] || { positive: 0, negative: 0, evidenceCount: 0, firstSeenAt: event.settledAt, lastSeenAt: event.settledAt };
  const previous = current.profile;
  const at = Math.max(previous?.at || event.settledAt, event.settledAt);
  const lifetime = previous ? scaleLayer(previous.lifetime, eventAgeWeight(previous.at, at, LIFETIME_WINDOW_MS)) : emptyLayer();
  const recent = previous ? scaleLayer(previous.recent, eventAgeWeight(previous.at, at)) : emptyLayer();
  const session = previous?.sessionId === sessionId ? scaleLayer(previous.session, eventAgeWeight(previous.at, at, SESSION_INTENT_TTL_MS)) : emptyLayer();
  const contexts = Object.fromEntries(Object.entries(previous?.contexts || {}).map(([name, layer]) => [name, scaleLayer(layer, eventAgeWeight(previous!.at, at))]));
  addBehavior(lifetime, event, strength, eventAgeWeight(event.settledAt, at, LIFETIME_WINDOW_MS));
  addBehavior(recent, event, strength, eventAgeWeight(event.settledAt, at));
  if (event.sessionId === sessionId) addBehavior(session, event, strength, eventAgeWeight(event.settledAt, at, SESSION_INTENT_TTL_MS), true);
  if (strength > 0 && event.timeBucket) {
    const keys = [event.timeBucket];
    if (event.weatherContext && !/off|unavailable/i.test(event.weatherContext)) keys.push(`${event.timeBucket}|${event.weatherContext.split("·")[0].trim().toLowerCase()}`);
    keys.forEach(name => { contexts[name] ||= emptyLayer(); addBehavior(contexts[name], event, strength, eventAgeWeight(event.settledAt, at)); });
  }
  return {
    ...aggregates,
    [key]: {
      positive: current.positive + Math.max(0, strength),
      negative: current.negative + Math.max(0, -strength),
      evidenceCount: current.evidenceCount + 1,
      firstSeenAt: Math.min(current.firstSeenAt, event.settledAt),
      lastSeenAt: Math.max(current.lastSeenAt, event.settledAt),
      profile: { at, artist: event.artist, lifetime, recent, sessionId, session, contexts,
        positiveTotal: (previous?.positiveTotal || 0) + Math.max(0, strength),
        trackPositive: (previous?.trackPositive || 0) * eventAgeWeight(previous?.at || at, at, LIFETIME_WINDOW_MS) + Math.max(0, strength) * eventAgeWeight(event.settledAt, at, LIFETIME_WINDOW_MS),
        trackNegative: (previous?.trackNegative || 0) * eventAgeWeight(previous?.at || at, at, LIFETIME_WINDOW_MS) + Math.max(0, -strength) * eventAgeWeight(event.settledAt, at, LIFETIME_WINDOW_MS) },
    },
  };
}

export function recordListeningEvent(memory: ListeningMemory, event: ListeningEvent): ListeningMemory {
  if (event.type === "preference_changed" && event.features) memory = migrateProviderIdentities(memory, event.features);
  if (memory.rawEvents.some((item) => item.eventId === event.eventId)
    || memory.explicitPreferences.some((item) => item.eventId === event.eventId)
    || memory.corrections.some((item) => item.eventId === event.eventId)
    || memory.processedEventIds?.includes(event.eventId)
    || memory.migratedEventIds.includes(event.eventId)) return memory;
  let rawEvents = [...memory.rawEvents, event];
  let longTermAggregates = { ...memory.longTermAggregates };
  if (rawEvents.length > MAX_RAW_EVENTS) {
    const compacted = rawEvents.slice(0, rawEvents.length - MAX_RAW_EVENTS);
    compacted.forEach((item) => { longTermAggregates = aggregateOldEvent(longTermAggregates, item, memory.currentSession.sessionId); });
    rawEvents = rawEvents.slice(-MAX_RAW_EVENTS);
  }
  let trackMemories = memory.trackMemories;
  if (event.type === "play_settled" && event.exitReason !== "error") {
    const current = memory.trackMemories[event.trackKey];
    trackMemories = {
      ...memory.trackMemories,
      [event.trackKey]: {
        trackKey: event.trackKey,
        title: event.title,
        artist: event.artist,
        playCount: (current?.playCount || 0) + 1,
        settledPlayCount: (current?.settledPlayCount || 0) + 1,
        completionCount: (current?.completionCount || 0) + (event.listenedSeconds >= 3 && event.completionRatio >= .8 ? 1 : 0),
        replayCount: (current?.replayCount || 0) + (event.replay ? 1 : 0),
        listenedSeconds: (current?.listenedSeconds || 0) + event.listenedSeconds,
        firstSeenAt: current?.firstSeenAt || event.startedAt,
        lastSeenAt: event.settledAt,
        lastExitReason: event.exitReason,
        features: event.features || current?.features,
        effectivePlayCount: (current?.effectivePlayCount ?? recoveredEffectiveCount(memory, event.trackKey)) + (isEffectiveListening(event) ? 1 : 0),
        lastEffectiveAt: isEffectiveListening(event) ? event.settledAt : current?.lastEffectiveAt,
      },
    };
  }
  if (event.type === "preference_changed" && event.targetType === "track" && event.features) {
    const current = trackMemories[event.targetKey];
    trackMemories = { ...trackMemories, [event.targetKey]: { trackKey: event.targetKey,
      title: event.title || current?.title || "", artist: event.artist || current?.artist || event.features.artist,
      playCount: current?.playCount || 0, settledPlayCount: current?.settledPlayCount || 0,
      completionCount: current?.completionCount || 0, replayCount: current?.replayCount || 0, listenedSeconds: current?.listenedSeconds || 0,
      firstSeenAt: current?.firstSeenAt || event.createdAt, lastSeenAt: current?.lastSeenAt || 0,
      effectivePlayCount: current?.effectivePlayCount ?? recoveredEffectiveCount(memory, event.targetKey),
      lastEffectiveAt: current?.lastEffectiveAt, features: event.features } };
  }
  let explicitPreferences = memory.explicitPreferences;
  if (event.type === "preference_changed") explicitPreferences = [...explicitPreferences, event];
  let corrections = memory.corrections;
  if (event.type === "profile_corrected") corrections = [...corrections, event];
  const sessionIntent = event.type === "session_intent_changed" ? event.intent : memory.sessionIntent;
  return { ...memory, rawEvents, trackMemories, explicitPreferences, corrections, longTermAggregates, sessionIntent, processedEventIds: [...(memory.processedEventIds || []), event.eventId], updatedAt: event.type === "play_settled" ? event.settledAt : event.createdAt };
}

// The existing 20% neutral-listening boundary and three-second floor distinguish
// a real listen from a start/seek/buffer attempt; media position is not listen time.
export function isEffectiveListening(event: PlaySettledEvent) {
  return event.exitReason !== "error" && event.durationSeconds > 0 && event.listenedSeconds >= 3
    && event.listenedSeconds / event.durationSeconds >= .2;
}

function recoveredEffectiveCount(memory: ListeningMemory, key: string) {
  return memory.rawEvents.filter((event): event is PlaySettledEvent => event.type === "play_settled" && event.trackKey === key && isEffectiveListening(event)).length;
}

export function listeningStatus(memory: ListeningMemory, key: string, now = Date.now()) {
  const track = memory.trackMemories[key];
  const effectivePlays = track?.effectivePlayCount ?? recoveredEffectiveCount(memory, key);
  const effectiveEvents = memory.rawEvents.filter((event): event is PlaySettledEvent => event.type === "play_settled" && event.trackKey === key && isEffectiveListening(event));
  const liked = activePreferences(memory, now).some(event => event.targetType === "track" && event.targetKey === key && event.value === "more");
  return { started: Boolean(track?.settledPlayCount), effectivePlays, effective: effectivePlays > 0, liked,
    completed: effectivePlays > 0 && Boolean(track?.completionCount),
    lastEffectiveAt: track?.lastEffectiveAt || effectiveEvents.at(-1)?.settledAt || 0,
    legacyUncertain: Boolean(track?.settledPlayCount && track.effectivePlayCount === undefined && effectivePlays === 0) };
}

export function migrateRecommendationExposure(history: string[], tracks: Array<{ provider?: string; mid: string; title: string; artist: string }>) {
  const resolved = new Map<string, Set<string>>();
  tracks.forEach(track => {
    const query = `${normalize(track.title)}::${normalize(track.artist)}`;
    const ids = resolved.get(query) || new Set<string>();
    ids.add(canonicalTrackKey(track.provider || "qq", track.mid)); resolved.set(query, ids);
  });
  return [...new Set(history.map(key => {
    const ids = resolved.get(key);
    return ids?.size === 1 ? [...ids][0] : key; // Ambiguity cannot merge versions.
  }))];
}

export function beginListeningSession(trackKey: string, now = Date.now()): ListeningSession {
  return { sessionId: `listen-${now.toString(36)}-${stableHash(trackKey)}`, trackKey, startedAt: now, lastMediaTime: 0, listenedSeconds: 0, settled: false };
}

export function accumulatePlayingTime(session: ListeningSession, mediaTime: number, playing: boolean, stalled = false): ListeningSession {
  if (session.settled || !Number.isFinite(mediaTime)) return session;
  const delta = mediaTime - session.lastMediaTime;
  return {
    ...session,
    lastMediaTime: mediaTime,
    listenedSeconds: playing && !stalled && delta > .03 && delta < 2.5 ? session.listenedSeconds + delta : session.listenedSeconds,
  };
}

export function implicitSignalStrength(event: PlaySettledEvent) {
  if (event.exitReason === "error" || event.listenedSeconds < 3) return 0;
  const ratio = clamp(event.completionRatio, 0, 1);
  const shortFactor = event.durationSeconds < 75 ? .62 : 1;
  if (event.replay && ratio >= .5) return .78 * shortFactor;
  if (ratio >= .8) return .46 * shortFactor;
  if (ratio >= .5) return .08;
  if (ratio >= .2) return 0;
  if (event.exitReason === "skip" || event.exitReason === "switch" || event.exitReason === "dislike") return -.12;
  return 0;
}

export function isLearningEvent(event: ListeningEvent) {
  return event.type === "play_settled" ? implicitSignalStrength(event) !== 0 : event.type !== "manual_intent";
}

/** Preserve the whole committed prefix, including visible songs and manual inserts. */
export function mergeHiddenRecommendations<T extends { mid: string }>(queue: T[], ranked: T[], currentId: string | undefined, protectedIds: Set<string>, retainUnranked = true) {
  const currentIndex = queue.findIndex((track) => track.mid === currentId);
  const lastProtected = queue.reduce((last, track, index) => protectedIds.has(track.mid) ? Math.max(last, index) : last, currentIndex);
  const prefix = queue.slice(0, Math.max(0, lastProtected + 1));
  const seen = new Set(prefix.map((track) => track.mid));
  const tail = [...ranked, ...(retainUnranked ? queue.slice(prefix.length) : [])].filter((track) => {
    if (seen.has(track.mid)) return false;
    seen.add(track.mid);
    return true;
  });
  return { queue: [...prefix, ...tail], currentIndex, protectedPrefixLength: prefix.length };
}

export function activePreferences(memory: ListeningMemory, now = Date.now()) {
  const latest = new Map<string, PreferenceChangedEvent>();
  for (const event of memory.explicitPreferences) {
    const key = `${event.targetType}:${event.targetType === "track" ? event.targetKey : normalize(event.targetKey)}`;
    const current = latest.get(key);
    if (!current || event.createdAt >= current.createdAt) latest.set(key, event);
  }
  return [...latest.values()].filter((event) => event.value !== "neutral" && !(event.scope === "session" && (event.sessionId !== memory.currentSession.sessionId || event.createdAt + SESSION_INTENT_TTL_MS <= now || (memory.sessionIntent && memory.sessionIntent.expiresAt <= now))));
}

// Enrich the SAME still-active event, never create another preference or
// revive a superseded/withdrawn one. All entry points share this evidence.
export function supplementPreferenceFeatures(memory: ListeningMemory, eventId: string, features: TrackFeatureVector) {
  const active = activePreferences(memory).find(event => event.eventId === eventId && event.targetType === "track");
  if (!active || active.targetKey !== canonicalTrackKey(features.provider, features.trackId)) return memory;
  const previous = active.features;
  const tags = new Map((previous?.tags || []).map(tag => [tag.value, tag]));
  features.tags.forEach(tag => { if (tag.value && tag.confidence > (tags.get(tag.value)?.confidence || 0)) tags.set(tag.value, tag); });
  const merged = { ...(previous || features), tags: [...tags.values()], bpm: (previous?.bpm.confidence || 0) > features.bpm.confidence ? previous!.bpm : features.bpm };
  if (JSON.stringify(previous) === JSON.stringify(merged)) return memory;
  const enrich = (event: ListeningEvent) => event.eventId === eventId ? { ...event, features: merged } : event;
  return { ...memory, explicitPreferences: memory.explicitPreferences.map(event => event.eventId === eventId ? { ...event, features: merged } : event),
    rawEvents: memory.rawEvents.map(enrich), updatedAt: Date.now() };
}

function addLayerValue(layer: ProfileLayer, kind: "tag" | "artist", key: string, amount: number) {
  const target = kind === "tag" ? layer.tagAffinities : layer.artistAffinities;
  target[key] = (target[key] || 0) + amount;
}

function eventAgeWeight(timestamp: number, now: number, windowMs = RECENT_WINDOW_MS) {
  return Math.exp(-Math.max(0, now - timestamp) / windowMs);
}

function profileConfidence(signals: number, tracks: number): ConfidenceLevel {
  if (signals >= 20 && tracks >= 10) return "reliable";
  if (signals >= 5 && tracks >= 3) return "growing";
  return "insufficient";
}

export function deriveListeningProfile(memory: ListeningMemory, now = Date.now()): DerivedListeningProfile {
  const lifetime = emptyLayer();
  const recent = emptyLayer();
  const session = emptyLayer();
  const contexts = new Map<string, { layer: ProfileLayer; tracks: Set<string> }>();
  const distinctTracks = new Set<string>();
  const recentTracks = new Set<string>();
  const sessionTracks = new Set<string>();
  const recentEffects: string[] = [];
  let implicitFeedbackCount = 0;
  for (const [key, aggregate] of Object.entries(memory.longTermAggregates)) {
    if (!key.startsWith("track:")) continue;
    const trackKey = key.slice(6);
    const summary = aggregate.profile;
    if (summary) {
      mergeLayer(lifetime, scaleLayer(summary.lifetime, eventAgeWeight(summary.at, now, LIFETIME_WINDOW_MS)));
      mergeLayer(recent, scaleLayer(summary.recent, eventAgeWeight(summary.at, now)));
      if (summary.sessionId === memory.currentSession.sessionId) {
        mergeLayer(session, scaleLayer(summary.session, eventAgeWeight(summary.at, now, SESSION_INTENT_TTL_MS)));
        if (summary.session.evidenceCount) sessionTracks.add(trackKey);
      }
      Object.entries(summary.contexts).forEach(([name, layer]) => {
        const context = contexts.get(name) || { layer: emptyLayer(), tracks: new Set<string>() };
        mergeLayer(context.layer, scaleLayer(layer, eventAgeWeight(summary.at, now)));
        context.tracks.add(trackKey); contexts.set(name, context);
      });
      implicitFeedbackCount += summary.lifetime.evidenceCount;
      if (summary.lifetime.evidenceCount) distinctTracks.add(trackKey);
      if (eventAgeWeight(summary.at, now) >= .1 && summary.recent.evidenceCount) recentTracks.add(trackKey);
    }
    // Legacy aggregates have verified strength/count/time, but no past tags or
    // weather. Recover only the retained track's artist with conservative decay.
    const unknownCount = Math.max(0, aggregate.evidenceCount - (summary?.lifetime.evidenceCount || 0));
    const positive = Math.max(0, aggregate.positive - (summary?.positiveTotal || 0));
    const artist = memory.trackMemories[trackKey]?.artist;
    if (unknownCount && positive && artist) {
      addLayerValue(lifetime, "artist", normalize(artist), positive * eventAgeWeight(aggregate.firstSeenAt, now, LIFETIME_WINDOW_MS));
      lifetime.evidenceCount += unknownCount; implicitFeedbackCount += unknownCount; distinctTracks.add(trackKey);
    }
  }
  for (const event of memory.rawEvents) {
    if (event.type !== "play_settled" || event.exitReason === "error") continue;
    const strength = implicitSignalStrength(event);
    if (!strength) continue;
    implicitFeedbackCount += 1;
    distinctTracks.add(event.trackKey);
    addBehavior(lifetime, event, strength, eventAgeWeight(event.settledAt, now, LIFETIME_WINDOW_MS));
    const eligibleTags = event.features?.tags.filter((tag) => tag.profileEligible && tag.confidence >= .45) || [];
    const recentWeight = eventAgeWeight(event.settledAt, now);
    if (recentWeight >= .1) {
      recentTracks.add(event.trackKey);
      addBehavior(recent, event, strength, recentWeight);
    }
    if (event.sessionId === memory.currentSession.sessionId) {
      sessionTracks.add(event.trackKey);
      addBehavior(session, event, strength, eventAgeWeight(event.settledAt, now, SESSION_INTENT_TTL_MS), true);
    }
    const contextKey = event.timeBucket || "unknown";
    const context = contexts.get(contextKey) || { layer: { tagAffinities: {}, artistAffinities: {}, evidenceCount: 0, distinctTrackCount: 0 }, tracks: new Set<string>() };
    context.tracks.add(event.trackKey);
    context.layer.evidenceCount += 1;
    if (strength > 0) addLayerValue(context.layer, "artist", normalize(event.artist), strength);
    if (strength > 0) eligibleTags.forEach((tag) => addLayerValue(context.layer, "tag", normalize(tag.value || ""), strength * tag.confidence));
    contexts.set(contextKey, context);
    if (event.weatherContext && !/off|unavailable/i.test(event.weatherContext)) {
      const weatherKey = `${contextKey}|${event.weatherContext.split("·")[0].trim().toLowerCase()}`;
      const weather = contexts.get(weatherKey) || { layer: { tagAffinities: {}, artistAffinities: {}, evidenceCount: 0, distinctTrackCount: 0 }, tracks: new Set<string>() };
      weather.tracks.add(event.trackKey);
      weather.layer.evidenceCount += 1;
      if (strength > 0) {
        addLayerValue(weather.layer, "artist", normalize(event.artist), strength);
        eligibleTags.forEach((tag) => addLayerValue(weather.layer, "tag", normalize(tag.value || ""), strength * tag.confidence));
      }
      contexts.set(weatherKey, weather);
    }
    const action = strength > .3 ? "完整听完" : strength < 0 ? "较早切换" : "听到后半段";
    recentEffects.unshift(`${action} ${event.title} → ${strength < 0 ? "只轻微调整当前会话" : "增加一条有限证据"}`);
  }
  const corrections = new Map<string, ProfileCorrectedEvent>();
  for (const event of memory.corrections) {
    const previous = corrections.get(event.hypothesisId);
    if (!previous || event.createdAt >= previous.createdAt) corrections.set(event.hypothesisId, event);
  }
  for (const event of activePreferences(memory, now)) {
    const direction = event.value === "more" ? .85 : -.68;
    const amount = event.scope === "session" ? direction * .62 : direction;
    const layer = event.scope === "session" ? session : lifetime;
    layer.evidenceCount += 1;
    if (event.targetType === "artist") addLayerValue(layer, "artist", normalize(event.targetKey), amount);
    if (event.targetType === "feature") addLayerValue(layer, "tag", normalize(event.targetKey), amount);
    if (event.targetType === "track") distinctTracks.add(event.targetKey);
  }
  for (const [tag, affinity] of Object.entries(lifetime.tagAffinities)) {
    const correction = corrections.get(`tag-${stableHash(tag)}`);
    if (!correction) continue;
    if (correction.verdict === "confirm") {
      if (affinity > 0) {
        lifetime.tagAffinities[tag] += Math.min(.3, affinity * .2);
        lifetime.evidenceCount += 1;
      }
      continue;
    }
    delete lifetime.tagAffinities[tag];
    delete recent.tagAffinities[tag];
    delete session.tagAffinities[tag];
    contexts.forEach(({ layer }) => { delete layer.tagAffinities[tag]; });
    if (correction.verdict === "session-only" && correction.createdAt >= memory.currentSession.startedAt && correction.createdAt + SESSION_INTENT_TTL_MS > now && affinity > 0) {
      session.tagAffinities[tag] = affinity;
      session.evidenceCount += 1;
    }
  }
  for (const [artist, affinity] of Object.entries(lifetime.artistAffinities)) {
    const correction = corrections.get(`artist-${stableHash(artist)}`);
    if (!correction) continue;
    const explicit = activePreferences(memory, now).filter(event => event.targetType === "artist" && event.scope !== "session" && normalize(event.targetKey) === artist)
      .reduce((sum, event) => sum + (event.value === "more" ? .85 : -.68), 0);
    const behavior = Math.max(0, affinity - explicit);
    if (correction.verdict === "confirm") { lifetime.artistAffinities[artist] += Math.min(.1, behavior * .1); continue; }
    if (explicit) lifetime.artistAffinities[artist] = explicit;
    else delete lifetime.artistAffinities[artist];
    delete recent.artistAffinities[artist]; delete session.artistAffinities[artist];
    contexts.forEach(({ layer }) => { delete layer.artistAffinities[artist]; });
    if (correction.verdict === "session-only" && correction.createdAt >= memory.currentSession.startedAt && correction.createdAt + SESSION_INTENT_TTL_MS > now) session.artistAffinities[artist] = behavior;
  }
  lifetime.distinctTrackCount = distinctTracks.size;
  recent.distinctTrackCount = recentTracks.size;
  session.distinctTrackCount = sessionTracks.size;
  const contextualProfiles: DerivedListeningProfile["contextualProfiles"] = {};
  contexts.forEach(({ layer, tracks }, key) => {
    layer.distinctTrackCount = tracks.size;
    const reliability = clamp(Math.min((layer.effectiveEvidenceWeight ?? layer.evidenceCount) / 8, tracks.size / 5), 0, 1);
    const blendedTags: Record<string, number> = { ...lifetime.tagAffinities };
    for (const tag of new Set([...Object.keys(blendedTags), ...Object.keys(layer.tagAffinities)])) blendedTags[tag] = (layer.tagAffinities[tag] || 0) * reliability + (lifetime.tagAffinities[tag] || 0) * (1 - reliability);
    contextualProfiles[key] = { ...layer, tagAffinities: blendedTags, reliability };
  });
  const anchors = Object.entries(lifetime.artistAffinities).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, score]) => ({ name, score }));
  const tagLeaders = Object.entries(lifetime.tagAffinities).filter(([, score]) => score > .1).sort((a, b) => b[1] - a[1]);
  const hypotheses: ListeningHypothesis[] = tagLeaders.slice(0, 3).map(([tag, score]) => ({
    hypothesisId: `tag-${stableHash(tag)}`,
    statement: `你可能会更愿意留在带有 ${tag} 特征的音乐里。`,
    confidence: clamp(Math.abs(score) / 3, 0, .92),
    evidenceCount: Math.max(1, lifetime.evidenceCount),
    sources: ["真实播放结算", "明确反馈"],
    applicableContext: "长期与近期证据共同支持",
    effectOnRecommendations: `轻微提高可靠 ${tag} 候选，不屏蔽其他方向`,
  })).filter((hypothesis) => corrections.get(hypothesis.hypothesisId)?.verdict !== "reject");
  anchors.filter(anchor => memory.rawEvents.some(event => event.type === "play_settled" && normalize(event.artist) === anchor.name && implicitSignalStrength(event) > 0)
    || Object.values(memory.longTermAggregates).some(value => normalize(value.profile?.artist || "") === anchor.name && value.positive > 0))
    .slice(0, 2).forEach(anchor => {
      const hypothesisId = `artist-${stableHash(anchor.name)}`;
      if (["reject", "ignore-behavior"].includes(corrections.get(hypothesisId)?.verdict || "")) return;
      hypotheses.push({ hypothesisId, statement: `有效收听中出现了对 ${anchor.name} 的行为倾向；这不代表其所有作品声音相同。`,
        confidence: clamp(anchor.score / 5, 0, .8), evidenceCount: lifetime.evidenceCount, sources: ["有效收听", "压缩后的可追溯行为证据"],
        applicableContext: "长期／近期／本次会话分别衰减", effectOnRecommendations: "只作有界歌手行为贡献，歌曲级声音特征独立计分" });
    });
  const activeIntent = memory.sessionIntent && memory.sessionIntent.expiresAt > now ? memory.sessionIntent : null;
  const meaningfulSignalCount = implicitFeedbackCount + activePreferences(memory, now).length + memory.corrections.length;
  const recentTags = Object.entries(recent.tagAffinities).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  const lifetimeTags = tagLeaders.map(([tag]) => tag);
  const returning = lifetimeTags.filter((tag) => (recent.tagAffinities[tag] || 0) > .08 && eventAgeWeight(memory.longTermAggregates[`tag:${tag}`]?.lastSeenAt || now, now) < .5);
  return {
    meaningfulSignalCount,
    distinctTrackCount: distinctTracks.size,
    explicitFeedbackCount: activePreferences(memory, now).length,
    implicitFeedbackCount,
    confidence: profileConfidence(meaningfulSignalCount, distinctTracks.size),
    lifetimeProfile: lifetime,
    recentProfile: recent,
    contextualProfiles,
    sessionProfile: session,
    sessionIntent: activeIntent,
    anchorArtists: anchors,
    hypotheses,
    recentEffects: recentEffects.slice(0, 8),
    historicalInterests: lifetimeTags.slice(0, 6),
    recentChanges: recentTags.filter((tag) => !lifetimeTags.slice(0, 3).includes(tag)).slice(0, 4),
    returningInterests: returning.slice(0, 4),
  };
}

function contribution(key: string, rawValue: number, weight: number, confidence: number, evidenceCount: number, reason: string, source: string): ScoreContribution {
  return { key, rawValue, signedWeight: clamp(rawValue * weight * confidence, -1.15, 1.15), confidence: clamp(confidence, 0, 1), evidenceCount, reason, source };
}

function featureTags(candidate: CandidateTrack) {
  const unique = new Map<string, FeatureEvidence<string> & { value: string }>();
  for (const tag of candidate.featureVector.tags) if (tag.value) {
    const value = normalize(tag.value), previous = unique.get(value);
    if (!previous || Number(tag.profileEligible) > Number(previous.profileEligible)
      || (tag.profileEligible === previous.profileEligible && tag.confidence > previous.confidence)) unique.set(value, { ...tag, value });
  }
  return [...unique.values()];
}

const BROAD_GENRE = /^(?:genre:)?(?:pop|pop\/rock|流行|r&b|rnb|r&b\/soul|rock|摇滚|electronic|electronica|电子|dance|舞曲|hip[ -]?hop|rap(?:\/hip[ -]?hop)?|说唱|jazz|爵士|folk|民谣|classical|古典|soundtrack|原声)$/i;
const tasteTagWeight = (tag: string) => tag.startsWith("language:") ? .02 : BROAD_GENRE.test(tag) ? .15 : 1;

function songStyleLink(known: TrackFeatureVector, target: TrackFeatureVector, cache?: WeakMap<TrackFeatureVector, Map<string, number>>) {
  const reliable = (features: TrackFeatureVector) => {
    const cached = cache?.get(features);
    if (cached) return cached;
    const tags = new Map<string, number>();
    features.tags.filter(tag => tag.value && tag.source === "provider_metadata" && tag.profileEligible && tag.confidence >= .6)
      .forEach(tag => tags.set(normalize(tag.value!), Math.max(tag.confidence, tags.get(normalize(tag.value!)) || 0)));
    cache?.set(features, tags);
    return tags;
  };
  const a = reliable(known), b = reliable(target);
  const union = new Set([...a.keys(), ...b.keys()]);
  let matched = 0, overlap = 0, total = 0, sharedSpecific = 0, specificUnion = 0;
  for (const tag of union) {
    const weight = tasteTagWeight(tag);
    total += weight;
    if (a.has(tag) && b.has(tag)) { matched += weight * Math.min(a.get(tag)!, b.get(tag)!); overlap += weight; }
    if (weight === 1) { specificUnion++; if (a.has(tag) && b.has(tag)) sharedSpecific++; }
  }
  // Compare one actual work at a time, not a bag of every genre the user ever
  // heard. Broad labels/language cannot fill the missing song-level evidence.
  return { similarity: matched / Math.max(1, total), overlap: total ? overlap / total : 0,
    close: sharedSpecific > 0 && sharedSpecific / specificUnion >= .5 };
}

function reliableTempo(bpm: FeatureEvidence<number> | undefined) {
  return Boolean(bpm && bpm.source === "audio_analysis" && bpm.profileEligible && bpm.confidence >= .5
    && bpm.value !== null && Number.isFinite(bpm.value) && bpm.value >= 30 && bpm.value <= 300);
}

function tempoSimilarity(a: number, b: number) {
  // BPM similarity describes pulse rate only, not genre, voice or emotion.
  return Math.exp(-Math.abs(Math.log(a / b)) / .28);
}

function tempoAffinity(layer: ProfileLayer, bpm: FeatureEvidence<number>) {
  if (!reliableTempo(bpm)) return 0;
  const entries = Object.entries(layer.tempoAffinities || {}).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  return total ? entries.reduce((sum, [tempo, weight]) => sum + (tempoSimilarity(Number(tempo), bpm.value!) - .5) * weight, 0)
    / total * Math.min(1, total) * bpm.confidence : 0;
}

export function prepareScoringEvidence(profile: DerivedListeningProfile, memory: ListeningMemory, now: number, librarySource?: TrackFeatureVector[]) {
  const preferences = activePreferences(memory, now);
  const trackPreferences = new Map(preferences.filter(event => event.targetType === "track").map(event => [event.targetKey, event]));
  const libraryFeatures = (librarySource || []).filter(item => item.inLibrary || item.likedInProvider)
    .filter(item => trackPreferences.get(canonicalTrackKey(item.provider, item.trackId))?.value !== "less").slice(0, 600);
  const knownTracks = Object.values(memory.trackMemories);
  const examples = new Map<string, { features: TrackFeatureVector; weight: number }>();
  for (const feature of libraryFeatures) examples.set(canonicalTrackKey(feature.provider, feature.trackId), { features: feature, weight: feature.likedInProvider ? .8 : .5 });
  for (const known of knownTracks) if (known.features && (known.effectivePlayCount || 0) > 0 && known.completionCount > 0) {
    const features = { ...known.features, tags: known.features.tags.filter(tag =>
      [profile.lifetimeProfile, profile.recentProfile, profile.sessionProfile].some(layer => (layer.tagAffinities[normalize(tag.value || "")] || 0) > 0)) };
    if (!examples.has(known.trackKey)) examples.set(known.trackKey, { features, weight: .65 });
  }
  for (const [key, event] of trackPreferences) {
    const features = event.features || memory.trackMemories[key]?.features;
    if (event.value === "more" && features) examples.set(key, { features, weight: 1 });
    else examples.delete(key);
  }
  const libraryGenreTracks = new Map<string, Set<string>>();
  for (const feature of libraryFeatures) for (const tag of feature.tags) {
    if (tag.source !== "provider_metadata" || !tag.profileEligible || tag.confidence < .6 || !tag.value || /^language:/i.test(tag.value)) continue;
    const value = normalize(tag.value), tracks = libraryGenreTracks.get(value) || new Set<string>();
    tracks.add(canonicalTrackKey(feature.provider, feature.trackId)); libraryGenreTracks.set(value, tracks);
  }
  const expiresAt = Math.min(memory.sessionIntent && memory.sessionIntent.expiresAt > now ? memory.sessionIntent.expiresAt : Infinity,
    ...preferences.filter(event => event.scope === "session").map(event => event.createdAt + SESSION_INTENT_TTL_MS));
  return { profile, memory, librarySource, preparedAt: now, expiresAt, preferences, trackPreferences, libraryFeatures, knownTracks, examples,
    libraryGenreTracks, styleCache: new WeakMap<TrackFeatureVector, Map<string, number>>() };
}

export function scoreCandidate(candidate: CandidateTrack, profile: DerivedListeningProfile, memory: ListeningMemory, lane: RecommendationLane, now = Date.now(), options: { allowRepeat?: boolean; current?: TrackFeatureVector; timeBucket?: string; weather?: string; tasteCalibrated?: boolean; libraryFeatures?: TrackFeatureVector[]; evidence?: ReturnType<typeof prepareScoringEvidence> } = {}): RecommendationScore {
  const tags = featureTags(candidate).filter((tag) => tag.profileEligible && tag.confidence >= .45);
  const supplied = options.evidence;
  const evidence = supplied && supplied.profile === profile && supplied.memory === memory && supplied.librarySource === options.libraryFeatures
    && now >= supplied.preparedAt && now < supplied.expiresAt ? supplied : prepareScoringEvidence(profile, memory, now, options.libraryFeatures);
  const { preferences, trackPreferences, libraryFeatures, knownTracks, examples, libraryGenreTracks, styleCache } = evidence;
  const instrumentalPreferences = preferences.filter(event => event.targetType === "feature" && normalize(event.targetKey) === "instrumental");
  // The controlled category has one explicit contribution. Its profile entry
  // remains visible/withdrawable, but is not counted again as a generic tag.
  const affinityTags = instrumentalPreferences.length ? tags.filter(tag => tag.value !== "instrumental") : tags;
  const tagAffinity = (layer: ProfileLayer) => affinityTags.reduce((sum, tag) => sum
    + Math.tanh((layer.tagAffinities[tag.value] || 0) / 2) * tag.confidence * tasteTagWeight(tag.value), 0)
    / Math.max(1, affinityTags.reduce((sum, tag) => sum + tasteTagWeight(tag.value), 0));
  const tagLifetime = tagAffinity(profile.lifetimeProfile);
  const tagRecent = tagAffinity(profile.recentProfile);
  const tagSession = tagAffinity(profile.sessionProfile);
  const artist = normalize(candidate.track.artist);
  const explicitArtistInProfile = preferences.filter((event) => event.targetType === "artist" && event.scope !== "session" && normalize(event.targetKey) === artist).reduce((sum, event) => sum + (event.value === "more" ? .85 : -.68), 0);
  const artistAffinity = (profile.lifetimeProfile.artistAffinities[artist] || 0) - explicitArtistInProfile;
  const recentArtist = clamp(profile.recentProfile.artistAffinities[artist] || 0, 0, 1);
  const explicitSessionArtist = preferences.filter(event => event.targetType === "artist" && event.scope === "session" && normalize(event.targetKey) === artist)
    .reduce((sum, event) => sum + (event.value === "more" ? .85 : -.68) * .62, 0);
  const sessionArtist = clamp((profile.sessionProfile.artistAffinities[artist] || 0) - explicitSessionArtist, 0, 1);
  const intent = profile.sessionIntent;
  const novelty = candidate.featureVector.novelty.value;
  const energy = candidate.featureVector.energy.value;
  const intentNovelty = intent?.familiarity === "explore" ? novelty ?? .5 : intent?.familiarity === "familiar" ? 1 - (novelty ?? .5) : .5;
  const reliableEnergy = energy !== null && candidate.featureVector.energy.source === "audio_analysis" && candidate.featureVector.energy.profileEligible && candidate.featureVector.energy.confidence >= .6;
  const intentEnergy = reliableEnergy ? intent?.energy === "energetic" ? energy : intent?.energy === "calm" ? 1 - energy : .5 : .5;
  const exact = preferences.filter((event) => event.targetType === "track" && event.targetKey === candidate.canonicalKey).reduce((sum, event) => sum + (event.value === "more" ? 1 : -.8), 0);
  const artistPreference = preferences.filter((event) => event.targetType === "artist" && normalize(event.targetKey) === artist).reduce((sum, event) => sum + (event.value === "more" ? 1 : -.72), 0);
  const stylePreference = preferences.filter((event) => event.targetType === "feature" && tags.some((tag) => tag.value === normalize(event.targetKey) && tag.profileEligible)).reduce((sum, event) => sum + (event.value === "more" ? .7 : -.45), 0);
  const meta = clamp(candidate.sourceConfidence * candidate.featureVector.metadataConfidence, 0, 1);
  const contextKey = `${options.timeBucket || "unknown"}|${(options.weather || "").split("·")[0].trim().toLowerCase()}`;
  const context = profile.contextualProfiles[contextKey] || profile.contextualProfiles[options.timeBucket || "unknown"];
  const contextReliability = context && context.reliability >= .6 ? context.reliability : 0;
  const contextualAffinity = context ? tagAffinity(context) + clamp(context.artistAffinities[artist] || 0) * .2 : 0;
  const aggregate = memory.longTermAggregates[`track:${candidate.canonicalKey}`];
  const aggregateTrack = aggregate?.profile
    ? (aggregate.profile.trackPositive - aggregate.profile.trackNegative) * eventAgeWeight(aggregate.profile.at, now, LIFETIME_WINDOW_MS)
      + Math.max(0, aggregate.positive - aggregate.profile.positiveTotal) * eventAgeWeight(aggregate.firstSeenAt, now, LIFETIME_WINDOW_MS)
    : aggregate ? (aggregate.positive - aggregate.negative) * eventAgeWeight(aggregate.firstSeenAt, now, LIFETIME_WINDOW_MS) : 0;
  const trackBehavior = aggregateTrack + memory.rawEvents.filter((event): event is PlaySettledEvent => event.type === "play_settled" && event.trackKey === candidate.canonicalKey)
    .reduce((sum, event) => sum + implicitSignalStrength(event) * eventAgeWeight(event.settledAt, now, LIFETIME_WINDOW_MS), 0);
  const links = [...examples].filter(([key]) => key !== candidate.canonicalKey).map(([key, example]) => {
    const style = songStyleLink(example.features, candidate.featureVector, styleCache);
    const tempo = reliableTempo(example.features.bpm) && reliableTempo(candidate.featureVector.bpm)
      ? Math.max(0, (tempoSimilarity(example.features.bpm.value!, candidate.featureVector.bpm.value!) - .5) * 2)
        * Math.min(example.features.bpm.confidence, candidate.featureVector.bpm.confidence) * .12 : 0;
    return { key, ...style, similarity: Math.max(style.similarity, tempo) * example.weight };
  }).sort((a, b) => b.similarity - a.similarity);
  // Bounded nearest works preserve several tastes; hundreds of broad Pop
  // matches cannot overwhelm one specific, evidenced song-level relationship.
  const positiveSimilarity = (links[0]?.similarity || 0) * .25 + (links[1]?.similarity || 0) * .05;
  const negativeSimilarity = Math.max(0, ...[...trackPreferences.values()].filter(event => event.value === "less").map(event => {
    const features = event.features || memory.trackMemories[event.targetKey]?.features;
    return features ? songStyleLink(features, candidate.featureVector, styleCache).similarity * .08 : 0;
  }));
  const preferenceSimilarity = positiveSimilarity - negativeSimilarity;
  const verifiedTempo = reliableTempo(options.current?.bpm) && reliableTempo(candidate.featureVector.bpm);
  const transition = verifiedTempo && options.current?.bpm.value && candidate.featureVector.bpm.value
    ? 1 - Math.min(1, Math.abs(options.current.bpm.value - candidate.featureVector.bpm.value) / 45)
    : .5;
  const freshness = options.allowRepeat ? 0 : candidate.alreadyRecommended ? -1 : candidate.alreadyHeard ? -.42 : .42;
  const lastPlayedAt = listeningStatus(memory, candidate.canonicalKey, now).lastEffectiveAt || candidate.featureVector.lastPlayedAt || 0;
  const recentPlayback = !options.allowRepeat && lastPlayedAt > 0 ? Math.exp(-Math.max(0, now - lastPlayedAt) / (7 * 86400000)) : 0;
  const laneFit = lane === "match" ? 1 - (novelty ?? .5) : novelty ?? .5;
  const soundConfidence = Math.max(0, ...tags.map((tag) => tag.confidence), candidate.featureVector.bpm.profileEligible ? candidate.featureVector.bpm.confidence : 0);
  const uncertainty = 1 - soundConfidence;
  // A provider's explicit version annotation is evidence about this version,
  // not a measured vocal ratio. Missing lyrics are never used for this penalty.
  const instrumentalVersion = /\b(?:instrumental|karaoke)\b|纯音乐|伴奏/i.test(candidate.track.title);
  const instrumentalAnnotation = /[（(\[【][^)\]）】]{0,60}(?:\binstrumental\b|\bkaraoke\b|纯音乐(?:版)?|伴奏(?:版)?)[^)\]）】]{0,60}[)\]）】]|\s[-–—]\s(?:instrumental(?:\s+(?:version|mix))?|karaoke(?:\s+version)?|纯音乐版?|伴奏版?)\s*$/i.test(candidate.track.title);
  const instrumentalMetadata = tags.find(tag => tag.source === "provider_metadata" && tag.confidence >= .6
    && /^(?:genre:)?(?:instrumental|karaoke|纯音乐|伴奏)$/.test(normalize(tag.value)));
  const instrumentalEvidenceConfidence = instrumentalMetadata?.confidence || (instrumentalAnnotation ? .9 : 0);
  const instrumentalPreference = instrumentalPreferences.reduce((sum, event) => sum + (event.value === "more" ? .85 : -.68) * (event.scope === "session" ? .62 : 1), 0);
  // Lane admission needs taste evidence, not a high novelty/metadata score.
  // Broad provider genres and BPM alone do not establish a close sonic match.
  const positiveTaste = preferences.some(event => event.value === "more")
    || [profile.lifetimeProfile, profile.recentProfile, profile.sessionProfile].some(layer =>
      Object.values(layer.artistAffinities).some(value => value > 0) || Object.values(layer.tagAffinities).some(value => value > 0));
  const calibrated = options.tasteCalibrated ?? (positiveTaste || candidate.inLibrary || candidate.featureVector.artistFamiliarity > 0 || libraryGenreTracks.size > 0);
  const observedArtist = Math.max(artistAffinity, recentArtist, sessionArtist);
  const artistLinked = artistPreference > 0 || observedArtist >= .25 || candidate.featureVector.artistFamiliarity >= .5;
  const relatedGenres = tags.filter(tag => tag.source === "provider_metadata" && tag.confidence >= .6 && !tag.value.startsWith("language:")
    && (Math.max(profile.lifetimeProfile.tagAffinities[tag.value] || 0, profile.recentProfile.tagAffinities[tag.value] || 0, profile.sessionProfile.tagAffinities[tag.value] || 0) > .1
      || preferences.some(event => event.value === "more" && event.targetType === "track"
        && (event.features || memory.trackMemories[event.targetKey]?.features)?.tags.some(known => known.profileEligible && known.confidence >= .6 && normalize(known.value || "") === tag.value))
      || libraryGenreTracks.has(tag.value)));
  // QQ-library genres are weak acquisition/relationship evidence, not a second
  // preference profile. Do not add another vote for already learned tags.
  const libraryOnlyGenres = relatedGenres.filter(tag => libraryGenreTracks.has(tag.value)
    && Math.max(profile.lifetimeProfile.tagAffinities[tag.value] || 0, profile.recentProfile.tagAffinities[tag.value] || 0, profile.sessionProfile.tagAffinities[tag.value] || 0) <= 0
    && !preferences.some(event => event.value === "more" && event.targetType === "track"
      && (event.features || memory.trackMemories[event.targetKey]?.features)?.tags.some(known => known.profileEligible && known.confidence >= .6 && normalize(known.value || "") === tag.value)));
  const libraryStyleSupport = new Set(libraryOnlyGenres.flatMap(tag => [...libraryGenreTracks.get(tag.value)!])).size;
  const specificStyle = links.some(link => link.close) || relatedGenres.some(tag => !BROAD_GENRE.test(tag.value)
    && preferences.some(event => event.targetType === "feature" && event.value === "more" && normalize(event.targetKey) === tag.value));
  // Familiarity and a broad Pop/R&B label are not song-level fit evidence.
  // Admit this weaker artist/style route only after independent works support
  // it; a declaration, replay of one work, language or BPM cannot supply votes.
  const artistStyleTracks = new Set<string>();
  const supportsArtistStyle = (features?: TrackFeatureVector) => features && normalize(features.artist) === artist
    && songStyleLink(features, candidate.featureVector, styleCache).overlap >= .5
    && features.tags.some(tag => tag.source === "provider_metadata" && tag.profileEligible && tag.confidence >= .6
      && relatedGenres.some(related => related.value === normalize(tag.value || "")));
  const rejectedTracks = new Set(preferences.filter(event => event.targetType === "track" && event.value === "less").map(event => event.targetKey));
  for (const event of preferences) if (event.targetType === "track" && event.value === "more" && !rejectedTracks.has(event.targetKey)
    && supportsArtistStyle(event.features || memory.trackMemories[event.targetKey]?.features)) artistStyleTracks.add(event.targetKey);
  for (const known of knownTracks) if (!rejectedTracks.has(known.trackKey)
    && (known.effectivePlayCount || 0) > 0 && known.completionCount > 0 && supportsArtistStyle(known.features)) artistStyleTracks.add(known.trackKey);
  const collectedStyleTracks = new Set(libraryFeatures.filter(feature => supportsArtistStyle(feature)
    && !rejectedTracks.has(canonicalTrackKey(feature.provider, feature.trackId))).map(feature => canonicalTrackKey(feature.provider, feature.trackId)));
  const trackLinked = exact > 0 || candidate.inLibrary || candidate.featureVector.likedInProvider || trackBehavior >= .5;
  const close = trackLinked || specificStyle || artistStyleTracks.size >= 2 || collectedStyleTracks.size >= 2;
  const related = close || artistLinked || relatedGenres.length > 0;
  const rejected = exact < 0 || artistPreference < 0;
  // A declaration establishes an artist link, not an automatic higher fit tier.
  // Its wider influence grows only with independently observed listening.
  const strength = trackLinked ? 1 : close && artistLinked && (specificStyle || artistStyleTracks.size >= 2) ? .65 + Math.min(.15, Math.max(0, observedArtist) * .05) : specificStyle ? .65 : close ? .55 : related ? .3 : 0;
  const reason = exact > 0 ? "你明确喜欢过的作品"
    : candidate.inLibrary || candidate.featureVector.likedInProvider ? "来自你的收藏与歌单"
      : close && artistPreference > 0 ? `来自你明确喜欢的 ${candidate.track.artist}，并有歌曲级曲风关联`
        : close && !specificStyle && artistStyleTracks.size < 2 ? "你收进歌单的多首独立作品，与这首歌有已核对的歌手和曲风联系；尚不代表音色相同"
          : close && artistLinked && !specificStyle ? "多首独立作品的完整收听或明确喜欢，支持这首歌的歌手与歌曲级曲风联系"
          : specificStyle ? "与喜欢、收藏或完整听过的具体作品有歌曲级曲风关联，不只是同一歌手"
            : close ? "已有曲风与可信节拍两项关联，声音仍需你的反馈确认"
              : artistLinked ? "有歌手行为关联，具体作品声音尚待验证"
                : related ? "在已知曲风旁边尝试一首新作品；不是确定的声音相似"
                : calibrated ? "暂缺口味关联，不作为贴合推荐" : "初次探索，等待你的真实收听反馈";
  const laneEvidence = { calibrated, match: close && !rejected, frontier: related && !rejected && !candidate.alreadyHeard && !candidate.inLibrary
    && (!close || (!artistLinked && collectedStyleTracks.size < 2)), strength, artistLinked, reason };
  const contributions = [
    contribution("long_term_affinity", clamp(tagLifetime, -1, 1) + clamp(artistAffinity, 0, 1) * .55, .9, meta, profile.lifetimeProfile.evidenceCount, "长期有效收听与可靠标签；有界且不重复计入明确歌手反馈", "lifetimeProfile"),
    contribution("recent_affinity", clamp(tagRecent, -1, 1) + recentArtist * .3, .72, meta, profile.recentProfile.evidenceCount, "45 天衰减的真实行为倾向，不代表同歌手声音相同", "recentProfile"),
    contribution("session_affinity", clamp(tagSession, -1, 1) + sessionArtist * .18, .55, meta, profile.sessionProfile.evidenceCount, "本会话有效收听倾向，18 小时衰减且权重受限", "sessionProfile"),
    contribution("acoustic_affinity", tempoAffinity(profile.lifetimeProfile, candidate.featureVector.bpm) * .16
      + tempoAffinity(profile.recentProfile, candidate.featureVector.bpm) * .08
      + tempoAffinity(profile.sessionProfile, candidate.featureVector.bpm) * .05, 1, 1,
      profile.lifetimeProfile.evidenceCount, "已有可靠 BPM 与有效收听的脉冲速度关联；不是音色或情绪相似", "audio_analysis:tempo"),
    contribution("session_intent", (intentNovelty - .5) * candidate.featureVector.novelty.confidence + (intentEnergy - .5) * candidate.featureVector.energy.confidence, .35, intent ? 1 : 0, intent ? 1 : 0, intent ? "采用本次意图，仅使用有证据的维度" : "今晚尚未校准", "sessionIntent"),
    contribution("context_affinity", contextualAffinity, .12, contextReliability, context?.evidenceCount || 0, contextReliability ? "实际同情境收听证据的有限修正" : "同情境证据不足，退回总体画像", "contextualProfiles"),
    contribution("track_behavior", trackBehavior, .22, 1, memory.trackMemories[candidate.canonicalKey]?.settledPlayCount || 0, "这首歌的实际收听结算", "play_settled"),
    contribution("verified_track_similarity", clamp(preferenceSimilarity, -.16, .5), .5, meta, links.filter(link => link.similarity > 0).length,
      "按具体作品的可靠标签比较；最相关的两首有限支持，宽泛标签和节拍只作弱修正", "trackMemories+explicitPreference+library_behavior"),
    contribution("library_affinity", candidate.featureVector.likedInProvider ? 1 : candidate.inLibrary ? .6 + Math.min(.1, candidate.featureVector.playlistMembership.length * .025) : candidate.featureVector.artistFamiliarity * .3, .28, 1, candidate.inLibrary ? candidate.featureVector.playlistMembership.length || 1 : 0, "QQ 收藏或歌单的行为关联，不等同声音相似", "library_behavior"),
    contribution("library_style", libraryStyleSupport ? 1 : 0, .12, .65, libraryStyleSupport, "真实收藏/自建歌单的歌曲级曲风标签仅作弱关系；不是已分析音色", "provider_metadata:qq_library"),
    contribution("explicit_track", exact, 1, 1, Math.abs(exact) ? 1 : 0, exact > 0 ? "你明确喜欢过这首歌" : exact < 0 ? "你只对这首歌或此刻做过降权" : "没有精确歌曲反馈", "explicitPreference"),
    contribution("explicit_artist", artistPreference, .2 + Math.min(.25, Math.max(0, artistAffinity) * .06), 1, Math.abs(artistPreference) ? 1 : 0, artistPreference > 0 ? "明确歌手偏好先小幅影响，实际收听逐步印证后再加强" : artistPreference < 0 ? "只降低这位歌手，不影响相近风格" : "没有歌手级反馈", "explicitPreference"),
    contribution("explicit_style", stylePreference, 0, meta, Math.abs(stylePreference) ? 1 : 0, "明确风格反馈已计入画像项，不重复计权", "explicitPreference"),
    contribution("sequence_fit", transition - .5, .55, verifiedTempo ? .9 : 0, verifiedTempo ? 1 : 0, "已分析节拍支持顺畅衔接", "audio_analysis"),
    contribution("lane_fit", calibrated && related ? (lane === "match" ? strength - .5 : !artistLinked ? close ? .05 : .3 : -.1) : laneFit - .5,
      lane === "frontier" ? .9 : .62, candidate.featureVector.novelty.confidence, 1, reason, "playlist_lane"),
    contribution("freshness", freshness, .78, 1, 1, freshness > 0 ? "最近没有反复出现" : "最近听过或推荐过，降低重复", "exposure_history"),
    contribution("recent_playback", -recentPlayback, 1.1, 1, recentPlayback ? 1 : 0, "最近播放过，暂缓重复推荐", "playback_history"),
    contribution("instrumental_version", instrumentalVersion ? -1 : 0, .85, instrumentalVersion ? .9 : 0, instrumentalVersion ? 1 : 0, "平台曲名明确标注的纯音乐或伴奏版本，适度减少而不封禁；不是由歌词失败推断", "provider_version_annotation"),
    contribution("instrumental_preference", clamp(instrumentalPreference, -1, 1), .65, instrumentalEvidenceConfidence,
      instrumentalEvidenceConfidence ? instrumentalPreferences.length : 0,
      instrumentalPreferences.length ? "你明确表达的纯音乐偏好；仅用于可靠标注的版本或歌曲级元数据，未知作品不猜测" : "没有明确的纯音乐类别反馈",
      instrumentalMetadata ? "provider_metadata:instrumental" : instrumentalAnnotation ? "provider_version_annotation" : "unknown"),
    contribution("metadata_confidence", meta - .5, .4, 1, 1, meta >= .6 ? "平台歌曲身份较可靠，不代表已分析声音" : "歌曲身份仍有不确定性", "metadata"),
    contribution("uncertainty_exploration", uncertainty - .5, lane === "frontier" ? .32 : .08, 1, 1, "保留小比例不确定探索", "exploration_floor"),
  ];
  // The same observed behavior participates at three time scales, but all three
  // positive layer terms share one finite budget; this is not three full votes.
  const layers = contributions.filter(item => ["long_term_affinity", "recent_affinity", "session_affinity"].includes(item.key) && item.signedWeight > 0);
  const combined = layers.reduce((sum, item) => sum + item.signedWeight, 0);
  if (combined > .85) layers.forEach(item => { item.signedWeight *= .85 / combined; });
  const totalScore = contributions.reduce((sum, item) => sum + item.signedWeight, 0);
  const sortedPositive = contributions.filter((item) => item.signedWeight > .05).sort((a, b) => b.signedWeight - a.signedWeight);
  const penalties = contributions.filter((item) => item.signedWeight < -.08).sort((a, b) => a.signedWeight - b.signedWeight).map((item) => item.reason).slice(0, 3);
  const tasteKeys = new Set(["explicit_track", "explicit_artist", "track_behavior", "long_term_affinity", "recent_affinity", "session_affinity", "verified_track_similarity", "acoustic_affinity", "library_affinity", "library_style"]);
  const topReasons = [reason, ...sortedPositive.filter(item => tasteKeys.has(item.key)).map(item => item.reason)].slice(0, 3);
  return { candidateKey: candidate.canonicalKey, lane, totalScore, contributions, topReasons, penalties, uncertainty, laneEvidence };
}

export function composeRecommendations(candidates: CandidateTrack[], scores: Map<string, RecommendationScore>, lane: RecommendationLane, count = 12, options: { enforceLane?: boolean; maxAnchors?: number; maxPerArtist?: number; flow?: SessionIntent["flow"]; prefix?: CandidateTrack[] } = {}) {
  // Visible previews and hidden queues share scores. Composition is a result,
  // not fresh preference evidence: never feed the previous penalty back in.
  const baseScores = new Map([...scores].map(([key, score]) => {
    const composed = score.contributions.filter(item => item.key === "composition_diversity" || item.key === "session_flow");
    return [key, { ...score, totalScore: score.totalScore - composed.reduce((sum, item) => sum + item.signedWeight, 0),
      contributions: score.contributions.filter(item => item.key !== "composition_diversity" && item.key !== "session_flow") }];
  }));
  const eligible = candidates.filter((candidate) => {
    const evidence = scores.get(candidate.canonicalKey)?.laneEvidence;
    return candidate.playable && !candidate.alreadyRecommended && (lane !== "frontier" || (!candidate.alreadyHeard && !candidate.inLibrary)) && scores.has(candidate.canonicalKey)
      && (options.enforceLane === false || !evidence?.calibrated || evidence[lane]);
  });
  const selected = [...(options.prefix || [])];
  const prefixKeys = new Set(selected.map(candidate => candidate.canonicalKey));
  const remaining = eligible.filter(candidate => !prefixKeys.has(candidate.canonicalKey));
  const artistCounts = new Map<string, number>();
  selected.forEach(candidate => { const artist = normalize(candidate.track.artist); artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1); });
  let anchorCount = selected.filter(candidate => candidate.alreadyHeard || candidate.inLibrary).length;
  while (selected.length < count && remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    let chosenFlow = 0;
    let bestIntroducesArtist = false;
    const page = selected.slice(Math.floor(selected.length / 6) * 6);
    const pageArtists = new Map<string, number>();
    const pageTags = new Map<string, number>();
    const albumKey = (item: CandidateTrack) => item.featureVector.album?.trim() && item.featureVector.metadataConfidence >= .6
      ? `${normalize(item.track.artist)}:${normalize(item.featureVector.album)}` : "";
    const pageAlbums = new Set(page.map(albumKey).filter(Boolean));
    page.forEach(item => {
      const artist = normalize(item.track.artist);
      pageArtists.set(artist, (pageArtists.get(artist) || 0) + 1);
      featureTags(item).filter(tag => tag.profileEligible && tag.confidence >= .45)
        .forEach(tag => pageTags.set(tag.value, (pageTags.get(tag.value) || 0) + 1));
    });
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const artist = normalize(candidate.track.artist);
      const score = baseScores.get(candidate.canonicalKey)!;
      const artistLimit = options.maxPerArtist ?? (score.laneEvidence?.calibrated ? Math.max(2, Math.ceil(count / 6)) : count);
      if ((artistCounts.get(artist) || 0) >= artistLimit) continue;
      if ((pageArtists.get(artist) || 0) >= 2 || (albumKey(candidate) && pageAlbums.has(albumKey(candidate)))) continue;
      if ((candidate.alreadyHeard || candidate.inLibrary) && anchorCount >= (options.maxAnchors ?? count)) continue;
      const tags = featureTags(candidate).filter((tag) => tag.profileEligible && tag.confidence >= .45).map((tag) => tag.value);
      // Diversity breaks ties within a fit level; it cannot promote an unrelated
      // artist over a close match. Broad genres/language must not punish all R&B.
      const artistFatigue = (pageArtists.get(artist) || 0) * (score.laneEvidence?.calibrated && lane === "match" ? .35 : 1.2);
      const featureFatigue = Math.min(.36, tags.filter(tag => tasteTagWeight(tag) === 1)
        .reduce((sum, tag) => sum + Math.max(0, (pageTags.get(tag) || 0) - 1) * .12, 0));
      const previous = selected.at(-1)?.featureVector;
      const tempoKnown = reliableTempo(previous?.bpm) && reliableTempo(candidate.featureVector.bpm);
      // Tempo is a bounded sequencing hint, never a taste veto or a reason to
      // prefer a weaker song by an entire score point. Audio mixing is separate.
      const bpmJump = tempoKnown ? Math.min(.12, Math.abs(Math.log(previous!.bpm.value! / candidate.featureVector.bpm.value!)) * .12) : 0;
      const sharedStyle = previous?.tags.some(tag => tag.source === "provider_metadata" && tag.profileEligible && tag.confidence >= .6 && !/^language:/.test(tag.value || "") && tags.includes(tag.value!)) ? 1 : 0;
      const continuity = sharedStyle * .12 + (tempoKnown ? .12 - bpmJump * 2 : 0);
      const flow = options.flow === "continuous" ? continuity : options.flow === "varied" ? -continuity : 0;
      const value = score.totalScore - artistFatigue - featureFatigue - bpmJump + flow;
      // Qualification was already enforced. Spread each six-card page across
      // at least four artists when available, without importing unrelated songs.
      const introducesArtist = pageArtists.size < Math.min(4, count) && !pageArtists.has(artist);
      if (bestScore !== -Infinity && !introducesArtist && bestIntroducesArtist) continue;
      if (bestScore !== -Infinity && introducesArtist && !bestIntroducesArtist) bestScore = -Infinity;
      if (value > bestScore) { bestScore = value; bestIndex = index; chosenFlow = flow; bestIntroducesArtist = introducesArtist; }
    }
    if (bestScore === -Infinity) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    const score = baseScores.get(chosen.canonicalKey)!;
    const diversity = bestScore - score.totalScore - chosenFlow;
    scores.set(chosen.canonicalKey, { ...score, totalScore: bestScore, contributions: [...score.contributions,
      ...(diversity ? [{ key: "composition_diversity", rawValue: diversity, signedWeight: diversity, confidence: 1, evidenceCount: selected.length, reason: "每组六首内的歌手分散、有限曲风重复与可靠节拍连续性", source: "composition" }] : []),
      ...(chosenFlow ? [{ key: "session_flow", rawValue: chosenFlow, signedWeight: chosenFlow, confidence: .65, evidenceCount: 1, reason: "本次连续/变化意图，仅用可靠节拍或平台歌曲级标签", source: "sessionIntent" }] : [])] });
    selected.push(chosen);
    if (chosen.alreadyHeard || chosen.inLibrary) anchorCount++;
    const artist = normalize(chosen.track.artist);
    artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
  }
  return selected.slice(options.prefix?.length || 0);
}

export function recommendationExplanation(score: RecommendationScore) {
  if (!score.topReasons.length) return "我还没有足够证据确定原因，这首只占一个小比例探索位。";
  const reasons = score.topReasons.slice(0, 3).join("；");
  const limitation = score.penalties[0] ? ` 同时我也考虑了：${score.penalties[0]}。` : "";
  return `${reasons}。${limitation}`;
}

// Pools own acquisition and exposure, while identity, memory, scoring and media
// caches stay shared. A lane is never populated from the other lane's leftovers.
export function createRecommendationPool(lane: RecommendationLane) {
  return {
    lane, cursor: 0, revision: 0, profileVersion: 0,
    status: "idle" as "idle" | "pending" | "completed" | "insufficient_candidates" | "failed",
    error: null as string | null,
    candidates: [] as CandidateTrack[], visible: [] as string[], hidden: [] as string[], exposure: [] as string[],
    acquiredPreferenceIds: [] as string[],
  };
}

/** Bound retrieval fairly before expensive source checks, independent of reply order. */
export function interleaveRecommendationSources<T>(sources: T[][], identity: (item: T) => string, limit = 120) {
  const selected: T[] = [], seen = new Set<string>();
  const longest = Math.max(0, ...sources.map(source => source.length));
  for (let row = 0; row < longest && selected.length < limit; row++) for (const source of sources) {
    const item = source[row];
    if (!item || selected.length >= limit) continue;
    const key = identity(item);
    if (!seen.has(key)) { seen.add(key); selected.push(item); }
  }
  return selected;
}

export function recommendationAcquisitionSeeds(lane: RecommendationLane, memory: ListeningMemory, profile: DerivedListeningProfile,
  options: { libraryFeatures?: TrackFeatureVector[]; cursor?: number; now?: number; limit?: number } = {}) {
  const now = options.now ?? Date.now();
  const preferences = activePreferences(memory, now).filter(event => event.value === "more");
  const features = [...preferences.filter(event => event.targetType === "track").map(event => event.features || memory.trackMemories[event.targetKey]?.features),
    ...Object.values(memory.trackMemories).filter(track => (track.effectivePlayCount || 0) > 0 && (profile.lifetimeProfile.artistAffinities[normalize(track.artist)] || 0) > 0).map(track => track.features),
    ...(options.libraryFeatures || []).filter(item => item.inLibrary || item.likedInProvider)].filter((item): item is TrackFeatureVector => Boolean(item));
  const supportedArtists = new Map<string, Set<string>>();
  for (const feature of features) if (feature.tags.some(tag => tag.source === "provider_metadata" && tag.profileEligible && tag.confidence >= .6 && !/^language:/.test(tag.value || ""))) {
    const key = normalize(feature.artist), tracks = supportedArtists.get(key) || new Set<string>();
    tracks.add(canonicalTrackKey(feature.provider, feature.trackId)); supportedArtists.set(key, tracks);
  }
  features.sort((a, b) => Number((supportedArtists.get(normalize(b.artist))?.size || 0) >= 2) - Number((supportedArtists.get(normalize(a.artist))?.size || 0) >= 2));
  const artists = [...new Set([...preferences.filter(event => event.targetType === "artist").map(event => event.artist || event.targetKey),
    ...preferences.filter(event => event.targetType === "track").map(event => event.artist || event.features?.artist || ""),
    ...profile.anchorArtists.filter(item => item.score > 0).map(item => item.name),
    ...features.map(item => item.artist)].filter(Boolean))];
  const trustedGenres = new Map<string, { count: number; trackIds: string[] }>();
  for (const feature of features) for (const tag of feature.tags) {
    if (tag.source !== "provider_metadata" || !tag.profileEligible || tag.confidence < .6 || !tag.value || /^language:/i.test(tag.value)) continue;
    const key = normalize(tag.value);
    const entry = trustedGenres.get(key) || { count: 0, trackIds: [] };
    const identity = canonicalTrackKey(feature.provider, feature.trackId);
    if (!entry.trackIds.includes(identity)) { entry.count++; entry.trackIds.push(identity); }
    trustedGenres.set(key, entry);
  }
  const genreOrder = [...trustedGenres].sort((a, b) => b[1].count - a[1].count
    || (profile.recentProfile.tagAffinities[b[0]] || 0) - (profile.recentProfile.tagAffinities[a[0]] || 0));
  const seeds: Array<{ key: string; query: string; page: number; strategy: string; basis: string; evidenceKeys: string[]; filterArtists: string[]; excludeArtists: string[] }> = [];
  const add = (query: string, strategy: string, basis: string, evidenceKeys: string[], filterArtists: string[] = [], excludeArtists: string[] = []) => {
    query = query.trim(); if (!query || seeds.some(seed => normalize(seed.query) === normalize(query))) return;
    seeds.push({ key: `${lane}:${strategy}:${normalize(query)}`, query, page: 1, strategy, basis, evidenceKeys: evidenceKeys.slice(0, 12), filterArtists, excludeArtists });
  };
  if (lane === "match") {
    // Artist searches obtain works to verify, not a claim that a discography is
    // one sound. Every result still passes the song-level close-match gate.
    const hasPairedEvidence = [...supportedArtists.values()].some(tracks => tracks.size >= 2);
    const matchArtists = artists.filter(artist => !hasPairedEvidence || (supportedArtists.get(normalize(artist))?.size || 0) >= 2
      || preferences.some(event => event.targetType === "artist" && normalize(event.artist || event.targetKey) === normalize(artist)));
    for (const artist of matchArtists.slice(0, 40)) {
      const artistKey = normalize(artist);
      const evidenceKeys = [...preferences.filter(event => normalize(event.artist || event.targetKey) === artistKey).map(event => event.targetType === "artist" ? `artist:${artistKey}` : event.targetKey),
        ...features.filter(feature => normalize(feature.artist) === artistKey).map(feature => canonicalTrackKey(feature.provider, feature.trackId))];
      add(artist, "verified_artist_works", "explicit preference, effective listening or library artist; song evidence still required", evidenceKeys.length ? evidenceKeys : [`behavior-artist:${artistKey}`], [artist]);
    }
    for (const event of preferences.filter(event => event.targetType === "track" && event.title && event.artist
      && !(options.libraryFeatures || []).some(feature => canonicalTrackKey(feature.provider, feature.trackId) === event.targetKey)).slice(-12))
      add(`${event.title} ${event.artist}`, "exact_favorite_anchor", "a small, identity-verified favorite anchor", [event.targetKey]);
    for (const [genre, evidence] of genreOrder.filter(([genre]) => !BROAD_GENRE.test(genre)).slice(0, 16))
      add(genre.replace(/^genre:/, ""), "specific_verified_style", "specific provider metadata on positively evidenced works", evidence.trackIds);
  } else {
    // Independent genre/credit retrieval, never the unselected artist results
    // from match. Exclude established artists to seek adjacent new directions.
    for (const [genre, evidence] of genreOrder.slice(0, 16))
      add(genre.replace(/^genre:/, ""), "adjacent_verified_style", "provider genre on positively evidenced works; a bounded exploration bridge, not measured sound similarity", evidence.trackIds, [], artists);
    // A verified artist declaration is a real relationship, but not proof of
    // this artist's whole sound. Acquire bounded trials for frontier explicitly;
    // otherwise an artist-only preference has no viable acquisition route.
    for (const event of preferences.filter(event => event.targetType === "artist")) {
      const artist = event.artist || event.targetKey;
      if ((supportedArtists.get(normalize(artist))?.size || 0) >= 2) continue;
      add(artist, "explicit_artist_trial", "explicit artist preference; unheard work is an uncertain artist trial, not proven sound similarity",
        [`artist:${normalize(artist)}`], [artist], artists.filter(other => normalize(other) !== normalize(artist)));
    }
    const established = new Set(artists.map(normalize));
    for (const feature of features) {
      const credits = feature.artist.split(/\s*(?:\/|;|、|,|\s&\s|\sfeat\.?\s|\sft\.?\s)\s*/i).filter(Boolean);
      if (credits.length < 2) continue;
      for (const credit of credits.slice(1).filter(credit => !established.has(normalize(credit))))
        add(credit, "verified_collaboration_credit", "actual credited collaborator of a positively evidenced work; individual song fit must be checked", [canonicalTrackKey(feature.provider, feature.trackId)], [credit], artists);
    }
  }
  const cursor = Math.max(0, Math.floor(options.cursor || 0));
  const limit = Math.max(1, Math.min(16, options.limit ?? 8));
  // Artist, verified style and favorite-anchor retrieval all get a turn. A
  // newly mentioned artist must not push every established source out of eight slots.
  const strategies = lane === "match" ? ["verified_artist_works", "specific_verified_style", "exact_favorite_anchor"]
    : ["adjacent_verified_style", "verified_collaboration_credit", "explicit_artist_trial"];
  const groups = strategies.map(strategy => seeds.filter(seed => seed.strategy === strategy));
  const ordered: typeof seeds = [];
  for (let index = 0; ordered.length < seeds.length; index++) groups.forEach(group => { if (group[index]) ordered.push(group[index]); });
  const offset = ordered.length ? cursor % ordered.length : 0;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(0, limit)
    .map((seed, index) => ({ ...seed, page: 1 + (Math.floor((cursor + index) / ordered.length) % 12) }));
}

export function beginRecommendationPoolUpdate(pool: ReturnType<typeof createRecommendationPool>, profileVersion: number, advanceCursor = false) {
  const next = { ...pool, revision: pool.revision + 1, profileVersion, cursor: pool.cursor + (advanceCursor ? 1 : 0), status: "pending" as const, error: null };
  return { pool: next, request: { lane: next.lane, revision: next.revision, profileVersion, cursor: next.cursor } };
}

export function failRecommendationPoolUpdate(pool: ReturnType<typeof createRecommendationPool>, request: ReturnType<typeof beginRecommendationPoolUpdate>["request"], error: string) {
  if (request.lane !== pool.lane || request.revision !== pool.revision || request.profileVersion !== pool.profileVersion) return { pool, committed: false, stale: true };
  // Preserve all previously usable entries; a failed acquisition is not a
  // successful empty refresh and cannot clear either lane.
  return { pool: { ...pool, status: "failed" as const, error }, committed: false, stale: false };
}

export function commitRecommendationPoolUpdate(pool: ReturnType<typeof createRecommendationPool>, request: ReturnType<typeof beginRecommendationPoolUpdate>["request"],
  options: { candidates: CandidateTrack[]; scores: Map<string, RecommendationScore>; otherOwnedKeys: Set<string>; replaceVisible: boolean; profileVersion: number; count?: number; flow?: SessionIntent["flow"]; displayReadyKeys?: Set<string> }) {
  if (request.lane !== pool.lane || request.revision !== pool.revision || request.profileVersion !== options.profileVersion || pool.profileVersion !== options.profileVersion)
    return { pool, committed: false, visibleCommitted: false, stale: true, excluded: [] as Array<{ key: string; reason: string }> };
  const count = Math.max(1, Math.min(12, options.count ?? 12));
  const excluded: Array<{ key: string; reason: string }> = [];
  const unique = new Map<string, CandidateTrack>();
  for (const candidate of options.candidates) {
    const score = options.scores.get(candidate.canonicalKey);
    const reason = options.otherOwnedKeys.has(candidate.canonicalKey) ? "OWNED_BY_OTHER_POOL"
      : !candidate.playable ? "NO_PLAYABLE_SOURCE"
        : !score || score.lane !== pool.lane ? "MISSING_OWN_LANE_SCORE"
          : !score.laneEvidence?.[pool.lane] ? "INSUFFICIENT_LANE_EVIDENCE"
            : pool.lane === "frontier" && (candidate.alreadyHeard || candidate.inLibrary) ? "NOT_UNHEARD_EXPLORATION" : null;
    if (reason) excluded.push({ key: candidate.canonicalKey, reason });
    else unique.set(candidate.canonicalKey, candidate);
  }
  const candidates = [...unique.values()].slice(0, 360);
  const visibleKeys = new Set(pool.visible);
  const exposed = new Set(pool.exposure);
  const fresh = candidates.filter(candidate => !visibleKeys.has(candidate.canonicalKey) && !exposed.has(candidate.canonicalKey) && !candidate.alreadyRecommended
    && (!options.displayReadyKeys || options.displayReadyKeys.has(candidate.canonicalKey)));
  const composition = { maxAnchors: 2, maxPerArtist: 2, flow: options.flow };
  const known = new Map([...pool.candidates, ...options.candidates].map(candidate => [candidate.canonicalKey, candidate]));
  // Legacy displayed cards used a title/artist identity. Resolve only their
  // composition constraints; do not migrate or rewrite a protected display.
  for (const candidate of known.values()) known.set(`${candidate.track.title.trim().toLowerCase()}::${candidate.track.artist.trim().toLowerCase()}`, candidate);
  const prefix = pool.visible.map(key => known.get(key)).filter((candidate): candidate is CandidateTrack => Boolean(candidate));
  const fill = () => prefix.length === pool.visible.length
    ? composeRecommendations(fresh, options.scores, pool.lane, count, { ...composition, prefix }) : [];
  const selected = options.replaceVisible ? composeRecommendations(fresh, options.scores, pool.lane, count, composition) : fill();
  let visible = pool.visible;
  if (options.replaceVisible && selected.length === count) visible = selected.map(candidate => candidate.canonicalKey);
  else if (pool.visible.length < count) visible = [...pool.visible, ...(options.replaceVisible ? fill() : selected).map(candidate => candidate.canonicalKey)];
  const visibleCommitted = visible.join("|") !== pool.visible.join("|");
  const hidden = composeRecommendations(candidates.filter(candidate => !visible.includes(candidate.canonicalKey) && !exposed.has(candidate.canonicalKey) && !candidate.alreadyRecommended),
    options.scores, pool.lane, 120, { maxAnchors: 2, maxPerArtist: 12, flow: options.flow }).map(candidate => candidate.canonicalKey);
  const insufficient = visible.length < count || (options.replaceVisible && selected.length < count);
  const next = { ...pool, candidates, visible, hidden, exposure: [...new Set([...pool.exposure, ...visible])].slice(-1200),
    status: (insufficient ? "insufficient_candidates" : "completed") as "completed" | "insufficient_candidates",
    error: insufficient ? "INSUFFICIENT_QUALIFIED_CANDIDATES" : null };
  return { pool: next, committed: true, visibleCommitted, stale: false, excluded };
}
