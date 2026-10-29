import type { CodioOnboardingState } from "./codio-onboarding";
import type { TrackAnalysis } from "./seamless-dj";

// Shared shapes for the renderer, the Electron bridge and the feature modules.
// Keeping them here lets smaller modules type against the bridge without
// importing the whole radio component.

export type QQMusicSdk = {
  getAuthStatus: () => Promise<boolean>;
  goAuthPage: () => void;
  describeSelfSongList: () => Promise<unknown>;
  describeRecentPlay?: (params: { Type: number; UpdateTime: number }) => Promise<unknown>;
};

export type QQDesktopStatus = {
  available: boolean;
  loggedIn: boolean;
  playbackReady: boolean;
  authorizationRequired?: boolean;
  connectionError?: "QQ_DESKTOP_AUTH_UNSUPPORTED";
  userId?: string;
};

export type QQTasteSnapshot = {
  playlists: Array<{ id: string; name: string; trackCount: number }>;
  tracks: QQTrack[];
  playlistNames: string[];
  likedCount: number;
  topArtists: Array<{ name: string; weight: number }>;
  coverage?: { partial: boolean; readPlaylistCount: number; completePlaylists: number; retainedPlaylists: number; syncedAt: number };
};

export type QQTrack = {
  provider: "qq" | "local";
  id: string;
  mid: string;
  mediaMid?: string;
  title: string;
  artist: string;
  album?: string;
  albumMid?: string;
  cover?: string;
  fallbackCover?: string;
  durationSeconds: number;
  vipRequired?: boolean;
  language?: string;
  releaseDate?: string;
  genres?: string[];
  artistKnown?: boolean;
  likedInProvider?: boolean;
  likedEvidence?: { source: string; confidence: number; confirmed: boolean };
  playlistMembership?: Array<{ id: string; name: string }>;
};

export type QQPlaybackResult = {
  playable: boolean;
  url?: string;
  expiresAt?: number;
  quality?: string;
  requiresLogin?: boolean;
  failureKind?: string;
  vipRequired?: boolean;
  message?: string;
};

export type LyricLine = { time: number; text: string };

export type AIStatus = {
  provider: "deepseek";
  configured: boolean;
  model: "deepseek-v4-flash";
  connectionMode: "user_api_key";
};

export type CodioToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type CodioAIMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: CodioToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export type SystemVolumeStatus = { available: boolean; volume: number | null; muted: boolean; error?: string; revision?: number };

export type CodioDesktopBridge = {
  isDesktop: true;
  systemVolume?: {
    getStatus: () => Promise<SystemVolumeStatus>;
    setVolume: (value: number) => Promise<SystemVolumeStatus>;
    subscribe: (listener: (status: SystemVolumeStatus) => void) => () => void;
  };
  localMusic: {
    import: (mode: "files" | "folder") => Promise<{ ok: boolean; cancelled?: boolean; scanned?: number; imported: number; duplicates: number; failed: number; capped?: boolean; tracks: QQTrack[] }>;
    library: () => Promise<QQTrack[]>;
  };
  qqMusic: {
    getStatus: () => Promise<QQDesktopStatus>;
    login: (options?: { forceAuthorization?: boolean }) => Promise<QQDesktopStatus>;
    logout: () => Promise<QQDesktopStatus>;
    search: (query: string, page?: number) => Promise<QQTrack[]>;
    metadata?: (trackId: string) => Promise<{ ok: boolean; mid?: string; genres?: string[]; language?: string; releaseDate?: string; source?: string; confidence?: number }>;
    lyrics: (track: QQTrack) => Promise<LyricLine[]>;
    library: (options?: { force?: boolean }) => Promise<QQTasteSnapshot>;
    play: (track: QQTrack) => Promise<QQPlaybackResult>;
    cover: (url: string) => Promise<string>;
  };
  ai: {
    getStatus: () => Promise<AIStatus>;
    saveKey: (key: string) => Promise<AIStatus>;
    clearKey: () => Promise<AIStatus>;
    step: (request: { messages: CodioAIMessage[]; context: Record<string, unknown> }) => Promise<{ content: string; toolCalls: CodioToolCall[] }>;
  };
  onboarding: {
    get: () => Promise<CodioOnboardingState>;
    save: (state: CodioOnboardingState) => Promise<CodioOnboardingState>;
  };
  analysis: {
    get: (trackId: string, version?: number) => Promise<TrackAnalysis | null>;
    save: (trackId: string, analysis: TrackAnalysis) => Promise<boolean>;
  };
};

declare global {
  interface Window {
    h5PanelSdk?: { qqMusic?: QQMusicSdk };
    codioDesktop?: CodioDesktopBridge;
    codioRecommendationDiagnostics?: Record<string, unknown>[];
    codioPlaybackDiagnostics?: Record<string, unknown>[];
    codioPreparationDiagnostics?: Record<string, unknown>;
  }
}
