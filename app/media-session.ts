// Media Session integration: hardware media keys, the Windows media overlay and
// Bluetooth/headset controls follow the radio. Everything takes the session as
// an argument so the behaviour can be exercised without a browser.

export type MediaSessionTrack = { title: string; artist: string; album?: string; artwork?: string };

export type MediaSessionTransport = {
  play: () => void;
  pause: () => void;
  previoustrack: () => void;
  nexttrack: () => void;
  seekto?: (seconds: number) => void;
  seekbackward?: (seconds: number) => void;
  seekforward?: (seconds: number) => void;
};

type MediaMetadataLike = { title: string; artist: string; album: string; artwork: Array<{ src: string; sizes?: string; type?: string }> };
type MediaMetadataConstructor = new (init: MediaMetadataLike) => unknown;
// Method syntax keeps these bivariant so the real MediaSession, with its
// narrower action and detail types, satisfies the shape.
type ActionDetails = { seekTime?: number | null; seekOffset?: number | null };
type SessionLike = {
  metadata?: unknown;
  playbackState?: "none" | "paused" | "playing";
  setActionHandler?(action: string, handler: ((details: ActionDetails) => void) | null): void;
  setPositionState?(state?: { duration: number; playbackRate: number; position: number }): void;
};

export const MEDIA_SESSION_SEEK_SECONDS = 10;

export function mediaSessionArtwork(source: string | undefined) {
  if (!source) return [];
  const type = source.startsWith("data:") ? source.slice(5, source.indexOf(";")) : source.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1];
  const mime = type?.includes("/") ? type : type ? `image/${type.toLowerCase() === "jpg" ? "jpeg" : type.toLowerCase()}` : undefined;
  return [{ src: source, sizes: "300x300", ...(mime ? { type: mime } : {}) }];
}

export function applyMediaSessionMetadata(session: SessionLike | undefined, track: MediaSessionTrack | null, Metadata: MediaMetadataConstructor | undefined) {
  if (!session) return false;
  if (!track || !Metadata) {
    session.metadata = null;
    return false;
  }
  try {
    session.metadata = new Metadata({ title: track.title, artist: track.artist, album: track.album || "", artwork: mediaSessionArtwork(track.artwork) });
    return true;
  } catch {
    session.metadata = null;
    return false;
  }
}

export function applyMediaSessionPlaybackState(session: SessionLike | undefined, playing: boolean, hasTrack: boolean) {
  if (!session) return;
  session.playbackState = hasTrack ? (playing ? "playing" : "paused") : "none";
}

export function applyMediaSessionPosition(session: SessionLike | undefined, duration: number, position: number, playbackRate = 1) {
  if (!session?.setPositionState) return false;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || position < 0) {
    try { session.setPositionState(); } catch { /* Older runtimes reject an empty state. */ }
    return false;
  }
  try {
    session.setPositionState({ duration, playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1, position: Math.min(position, duration) });
    return true;
  } catch {
    return false;
  }
}

// Returns the function that clears every handler again.
export function bindMediaSessionTransport(session: SessionLike | undefined, transport: MediaSessionTransport) {
  if (!session?.setActionHandler) return () => {};
  const set = session.setActionHandler.bind(session);
  const bound: string[] = [];
  const register = (action: string, handler: ((details: ActionDetails) => void) | null) => {
    if (!handler) return;
    try { set(action, handler); bound.push(action); } catch { /* Unsupported action on this platform. */ }
  };
  register("play", () => transport.play());
  register("pause", () => transport.pause());
  register("previoustrack", () => transport.previoustrack());
  register("nexttrack", () => transport.nexttrack());
  register("seekto", transport.seekto ? (details) => {
    const seconds = Number(details.seekTime);
    if (Number.isFinite(seconds) && seconds >= 0) transport.seekto!(seconds);
  } : null);
  register("seekbackward", transport.seekbackward ? (details) => transport.seekbackward!(Number(details.seekOffset) > 0 ? Number(details.seekOffset) : MEDIA_SESSION_SEEK_SECONDS) : null);
  register("seekforward", transport.seekforward ? (details) => transport.seekforward!(Number(details.seekOffset) > 0 ? Number(details.seekOffset) : MEDIA_SESSION_SEEK_SECONDS) : null);
  return () => {
    for (const action of bound) {
      try { set(action, null); } catch { /* Already gone. */ }
    }
  };
}
