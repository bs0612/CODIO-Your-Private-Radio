export type AgentToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type SearchedTrack = { id: string; title: string; artist: string };
export type AgentMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export function isOfflineCodioShortcut(value: string) {
  const text = value.trim().toLowerCase();
  return /^(暂停|暂停一下|停一下|先停|pause|继续|继续播放|接着放|播放|play|上一首|下一首|换一首|换首歌|跳过|声音大|大一点|响一点|声音小|轻一点|小一点)$/.test(text)
    || /^(?:音量|声音)\s*(?:调到|设为|到)?\s*(?:100|[1-9]?\d)%?$/.test(text);
}

export type CodioToolPolicyState = {
  qqConnected: boolean;
  playbackReady: boolean;
  searchResultIds: string[];
  searchResultArtists?: string[];
  searchResultTracks?: SearchedTrack[];
  userText: string;
  interface: {
    theme: "night";
    scene: "night" | "dawn" | "deep";
    particles: number;
    lyrics: "minimal" | "cinematic";
    panel: "profile" | "settings" | "now_playing" | "dj" | "close";
  };
};

function hasExplicitRatingIntent(value: string, rating: "like" | "dislike") {
  const text = value.trim().toLowerCase();
  if (!text || /[?？]|(?:你觉得|是否|是不是|会不会|能不能|该不该|如果|假如)/.test(text)) return false;
  if (/(?:不要|别(?:把|给|再|将|去|标记|设为|记录)|取消|撤销).{0,8}(?:喜欢|不喜欢|收藏|点赞|like|dislike)/i.test(text)) return false;
  const dislikes = /(?:不喜欢|不好听|讨厌|难听|\b(?:dislike|hate)\b|\b(?:don't|do not|never)\s+(?:really\s+)?(?:like|love|enjoy)\b)/i.test(text);
  if (rating === "dislike") return dislikes;
  if (dislikes || /(?:不|没|并不|不是|不太|谈不上|说不上).{0,5}(?:喜欢|好听|不错|爱|\blike\b)/i.test(text)) return false;
  return /(?:喜欢|不错|好听|收藏|点赞|迷上|沉迷|上头|\b(?:like|love|enjoy|prefer|favo[u]?rite)\b|\baddicted\s+to\b|\bfell\s+in\s+love\s+with\b)/i.test(text);
}

// Conversational permission, not another preference store or local executor.
// A connection confirmation can resume only one recent, unresolved request.
export function preferencePermissionForTurn(text: string, pending: { text: string; expiresAt: number } | null, now = Date.now()) {
  const compact = text.trim().replace(/[\s！!。.,，]+/g, "").replace(/[啊呀呢吧]$/, "");
  const reconnectReply = /^(?:我)?(?:已经|现在|刚刚|刚才)?(?:连上|连接好|登录|登陆)(?:了)?(?:QQ音乐|QQ|音乐)?(?:了)?$/i.test(compact)
    || /^(?:QQ音乐|QQ)(?:已经|现在)?(?:连上|连接好|登录|登陆)了$/i.test(compact)
    || /^(?:现在|这次)?(?:可以了|好了|再试一次|再试试|继续刚才的|继续刚才的偏好)$/.test(compact)
    || /^(?:(?:i(?:'ve| have)?|it(?:'s| is))\s+)?(?:(?:already|now)\s+)?(?:connected|logged in)(?:\s+(?:to\s+)?qq(?: music)?)?(?:\s+now)?[.!]*$|^(?:try again|retry)[.!]*$/i.test(text.trim());
  if (reconnectReply && pending && pending.expiresAt > now) return { text: pending.text, pending };
  const personal = /(?:我|本人)|\bi(?:'m| am)?\b/i.test(text)
    && !/[?？“”「」『』"]|(?:他说|她说|朋友说|别人说)|\b(?:he|she|they|my friend)\b/i.test(text)
    && !/(?:别|不要|取消|撤销).{0,8}(?:记录|保存|记住)|\b(?:don't|do not)\s+(?:save|record|remember)\b/i.test(text)
    && (hasExplicitRatingIntent(text, "like") || hasExplicitRatingIntent(text, "dislike"));
  return { text, pending: personal ? { text, expiresAt: now + 10 * 60 * 1000 } : null };
}

function hasPlaybackIntent(value: string, action: "play" | "pause" | "next" | "previous") {
  if (/(?:不要|别|不用|无需|不想|没让|没有要求|没要求).{0,12}(?:播放|听|放|切歌|跳过|暂停|换)/.test(value)) return false;
  if (action === "pause") return /暂停|停一下|先停|\bpause\b/i.test(value);
  if (action === "next") return !/下一首.{0,6}(?:什么|是啥|叫啥)/.test(value) && /下一首|换一首|换首歌|切歌|跳过|\bnext\b|\bskip\b/i.test(value);
  if (action === "previous") return /上一首|\bprevious\b|\bback\b/i.test(value);
  if (/(?:现在|正在|当前)播放的/.test(value) && !/继续|帮我|给我|想听/.test(value)) return false;
  return /^(?:请|帮我|给我|现在|马上)?\s*(?:播放|放一首|继续|接着放|\bplay\b|\bresume\b)|(?:想|要|帮我|给我|请|现在|马上).{0,12}(?:听|放|播放)/i.test(value);
}

function preferenceClauses(value: string) {
  return value.split(/[，,；;。]|但是|不过|(?<!特)但/).map((clause) => clause.trim()).filter(Boolean);
}

function baseTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().trim()
    .replace(/(?:\s*[([]\s*(?:explicit|clean|radio edit|single version|album version|instrumental|acoustic|demo|live|remaster(?:ed)?(?:\s+\d{4})?)\s*[)\]])+\s*$/i, "")
    .replace(/\s+/g, " ").trim();
}

function mentions(text: string, name: string) {
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  const needle = name.normalize("NFKC").toLocaleLowerCase().trim();
  if (!needle) return false;
  if (!/^[a-z0-9]/i.test(needle)) return lower.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(lower);
}

function artistPrefixInText(text: string, artist: string) {
  const normalized = artist.normalize("NFKC").replace(/\s+/g, " ").trim();
  const parts = normalized.split(" ");
  const collaborative = /(?:\s(?:&|\/|,|feat\.?|ft\.?|with)\s|、|和)/i.test(normalized);
  const prefixes = collaborative ? [normalized] : parts.map((_, index) => parts.slice(0, index + 1).join(" ")).reverse();
  return prefixes.find((prefix) => mentions(text, prefix)) || "";
}

function matchingArtistsForPrefix(text: string, artist: string, tracks: SearchedTrack[]) {
  const prefix = artistPrefixInText(text, artist);
  if (!prefix) return [];
  const lower = prefix.toLocaleLowerCase();
  return [...new Set(tracks.map((track) => track.artist.toLocaleLowerCase()))]
    .filter((name) => name === lower || name.startsWith(`${lower} `));
}

function uniquelyNamedArtist(text: string, artist: string, tracks: SearchedTrack[]) {
  const matching = matchingArtistsForPrefix(text, artist, tracks);
  return matching.length === 1 && matching[0] === artist.toLocaleLowerCase();
}

export function verifyNamedTrackPreference(userText: string, selected: SearchedTrack, searchResults: SearchedTrack[]) {
  const title = baseTitle(selected.title);
  if (!title || !mentions(userText, title)) return "TRACK_NOT_NAMED_BY_USER";
  const sameTitle = searchResults.filter((item) => baseTitle(item.title) === title);
  if (!sameTitle.some((item) => item.id === selected.id)) return "TRACK_ID_NOT_FROM_THIS_TURN";
  const claimedArtist = /([a-z][\w.'-]*)\s*的\s*[a-z]/i.exec(userText)?.[1];
  if (claimedArtist && matchingArtistsForPrefix(userText, selected.artist, sameTitle).length > 1) return "AMBIGUOUS_TRACK";
  if (claimedArtist && !uniquelyNamedArtist(userText, selected.artist, sameTitle)) return "TRACK_ARTIST_MISMATCH";
  if (uniquelyNamedArtist(userText, selected.artist, sameTitle)) return null;
  if (new Set(sameTitle.map((item) => item.artist.toLocaleLowerCase())).size > 1) return "AMBIGUOUS_TRACK";
  return null;
}

function hasTargetPreferenceIntent(text: string, target: string, value: "more" | "less") {
  const title = baseTitle(target);
  const clauses = preferenceClauses(text);
  return Boolean(title) && clauses.some((clause, index) => {
    if (!mentions(clause, title)) return false;
    if (hasExplicitRatingIntent(clause, value === "more" ? "like" : "dislike")) return true;
    // An explicit first-person preference may introduce an "especially" list.
    // Do not carry it past contrast, negation, a question or quoted speech.
    return value === "more" && /^especially\b/i.test(clause)
      && /^i\s+(?:(?:recently|really|particularly|have|always)\s+)*(?:like|love|enjoy|prefer|fell\s+in\s+love\s+with)\b/i.test(clauses[index - 1] || "")
      && hasExplicitRatingIntent(clauses[index - 1], "like")
      && !/[?？]|\b(?:not|don't|but|except|hate|dislike|said|says)\b/i.test(clause);
  });
}

function hasInstrumentalPreferenceIntent(text: string, value: "more" | "less") {
  // This is a permission check after the model selects a tool, not a local
  // intent executor. Ambiguous, quoted, or temporary requests remain chat.
  if (/[?？“”「」『』‘’"]|(?:你觉得|是否|是不是|会不会|能不能|该不该|如果|假如|他说|她说|朋友说|别人说|转述|这句话|例如|比如)|\b(?:if|said|says|suppose)\b/i.test(text)) return false;
  if (/(?:今晚|现在|今天|此刻|暂时|这次|这会|接下来|只在)|\b(?:tonight|today|now|temporarily)\b/i.test(text)) return false;
  if (/(?:不要|别|不用|无需|取消|撤销).{0,12}(?:记录|保存|记住|偏好)|(?:不是|并非|没有说).{0,4}(?:不喜欢|讨厌|喜欢)|\b(?:do not|don't)\s+(?:save|record|remember)\b/i.test(text)) return false;
  const category = "(?:纯音乐|器乐(?:曲|音乐)|(?:没有|无)人声的(?:音乐|歌)|instrumental(?:s| music)?)";
  const self = "(?:我|本人)(?:最近|一直|平时|通常|其实|真的|比较|特别|很|也|更|个人|完全|一点也|\\s)*";
  const rating = value === "less" ? "(?:不(?:太|怎么|是很)?喜欢|讨厌|不爱)" : "(?:喜欢|喜爱|偏爱|爱)";
  const direct = new RegExp(`^${self}${rating}(?:听)?\\s*${category}(?:$|[\\s！!]|这类|这种|一些|一点)`, "i");
  const reverse = new RegExp(`^${self}(?:对)?${category}\\s*${rating}(?:$|[\\s！!])`, "i");
  const english = value === "less"
    ? /^i\s+(?:(?:really|usually|generally|always)\s+)*(?:don't like|do not like|dislike|hate)\s+(?:listening to\s+)?instrumental(?:s| music)?\s*[.!]*$/i
    : /^i\s+(?:(?:really|usually|generally|always)\s+)*(?:like|love|prefer)\s+(?:listening to\s+)?instrumental(?:s| music)?\s*[.!]*$/i;
  return preferenceClauses(text).some(clause => direct.test(clause) || reverse.test(clause) || english.test(clause));
}

function hasArtistPreferenceIntent(text: string, artist: string, value: "more" | "less", searchResults: SearchedTrack[]) {
  const namedTracks = searchResults.filter((track) => mentions(text, baseTitle(track.title)));
  const verifiedTracks = namedTracks.length ? namedTracks : searchResults;
  if (!uniquelyNamedArtist(text, artist, verifiedTracks)) return false;
  const clauses = preferenceClauses(text);
  return clauses.some((clause, index) => {
    const prefix = artistPrefixInText(clause, artist);
    const directName = prefix && new RegExp(`(?:喜欢|爱|讨厌)\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:$|[.!?。！？])`, "i").test(clause);
    const englishScope = prefix && (new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['’]s)?\\s+(?:music|songs|work|style|sound|flow)\\b`, "i").test(clause)
      || new RegExp(`\\b(?:like|love|enjoy|prefer|addicted\\s+to|fell\\s+in\\s+love\\s+with)\\s+${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+(?:recently|lately))?\\s*[.!]*$`, "i").test(clause));
    const referringStyle = index > 0 && artistPrefixInText(clauses[index - 1], artist)
      && /\b(?:her|his|their)\s+(?:music|songs|style|sound|flow)\b|(?:他|她|他们|她们)的(?:歌|音乐|作品|风格|唱腔|声音)/i.test(clause);
    const broadScope = englishScope || /(?:的歌|的作品|这个歌手|这位歌手|这名歌手)|(?:其他|别的).{0,4}(?:他|她|其)(?:的)?歌/.test(clause)
      || (artistPrefixInText(clause, artist) && /(?:其他|别的|所有|全部|每首).{0,4}歌/.test(clause))
      || /(?:喜欢|爱|讨厌).{0,8}(?:这个歌手|这位歌手|这名歌手)/.test(clause)
      || directName || referringStyle;
    return broadScope && hasExplicitRatingIntent(clause, value === "more" ? "like" : "dislike");
  });
}

// Let the model interpret natural wording, but require a verbatim user span.
// This is provenance/scope validation, not another synonym-based intent model.
function preferenceEvidence(text: string, evidence: unknown) {
  if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 400 || !text.includes(evidence)) return false;
  return !/[?？“”「」『』"]|(?:他说|她说|朋友说|别人说|如果|假如|例如|比如|转述)|\b(?:if|said|says|suppose|my friend)\b/i.test(evidence)
    && !/^(?:我(?:刚刚|刚才|现在|最近)?(?:正在听|在听|听了|播放了|搜了|搜索了)|i\s+(?:(?:am|was|just|have|been|currently)\s+)*(?:listening to|listened to|played|searched for))[^，,；;。.!?？]+[。.!]*$/i.test(evidence.trim())
    && !/(?:不要|别|不用|无需|取消|撤销).{0,12}(?:记录|保存|记住|偏好)|\b(?:don't|do not)\s+(?:save|record|remember)\b/i.test(text);
}

export function validateCodioToolCall(call: AgentToolCall, state: CodioToolPolicyState) {
  const args = call.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "INVALID_TOOL_ARGUMENTS";
  if (typeof args.__error === "string") return args.__error;
  if (call.name === "control_playback") {
    const action = String(args.action || "");
    if (!["play", "pause", "next", "previous"].includes(action)) return "INVALID_ACTION";
    return hasPlaybackIntent(state.userText, action as "play" | "pause" | "next" | "previous") ? null : "PLAYBACK_REQUIRES_USER_INTENT";
  }
  if (call.name === "seek_playback") {
    const value = args.position_percent;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? null : "INVALID_SEEK";
  }
  if (call.name === "adjust_volume") {
    const operation = String(args.operation || "");
    const value = args.value;
    const valid = typeof value === "number" && Number.isFinite(value) && (operation === "set"
      ? value >= 0 && value <= 100
      : ["increase", "decrease"].includes(operation) && value >= 1 && value <= 30);
    return valid ? null : "INVALID_VOLUME";
  }
  if (call.name === "search_music") {
    const query = String(args.query || "").trim();
    const limit = args.limit === undefined ? 8 : Number(args.limit);
    if (!query || query.length > 120) return "INVALID_SEARCH_QUERY";
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) return "INVALID_SEARCH_LIMIT";
    if (!state.qqConnected) return "QQ_NOT_CONNECTED";
    return null;
  }
  if (call.name === "play_search_result") {
    if (!hasPlaybackIntent(state.userText, "play")) return "PLAYBACK_REQUIRES_USER_INTENT";
    if (!state.qqConnected) return "QQ_NOT_CONNECTED";
    if (!state.playbackReady) return "QQ_PLAYBACK_NOT_READY";
    return typeof args.track_id === "string" && state.searchResultIds.includes(args.track_id) ? null : "TRACK_ID_NOT_FROM_THIS_TURN";
  }
  if (call.name === "set_seamless") return typeof args.enabled === "boolean" ? null : "INVALID_SEAMLESS";
  if (call.name === "rate_current_track") {
    const rating = String(args.rating || "");
    return (rating === "like" || rating === "dislike") && /这首|当前|正在播放|现在放/i.test(state.userText) && hasExplicitRatingIntent(state.userText, rating)
      ? null
      : "RATING_REQUIRES_EXPLICIT_USER_INTENT";
  }
  if (call.name === "record_music_preference") {
    const type = String(args.target_type || "");
    const value = String(args.value || "");
    const artistName = typeof args.artist_name === "string" ? args.artist_name.toLocaleLowerCase() : "";
    if (/[?？]|(?:他说|她说|朋友说|别人说|转述|这句话)|\b(?:he|she|they|my friend)\s+(?:said|says|likes|loves)\b|\b(?:don't|do not)\s+(?:save|record|remember)\b/i.test(state.userText)) return "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
    const temporaryOnly = /(?:今晚|这会|暂时|这次|接下来|此刻)|\b(?:tonight|today|right now|for now|temporarily)\b/i.test(state.userText);
    const evidence = args.evidence_text;
    if (evidence !== undefined && !preferenceEvidence(state.userText, evidence)) return "INVALID_PREFERENCE_EVIDENCE";
    if (typeof evidence === "string" && hasExplicitRatingIntent(evidence, value === "more" ? "dislike" : "like")
      && !hasExplicitRatingIntent(evidence, value === "more" ? "like" : "dislike")) return "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
    if (!["more", "less"].includes(value)) return "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
    if (type === "feature") {
      if (Object.keys(args).some(key => !["target_type", "feature_key", "value", "evidence_text"].includes(key)) || args.feature_key !== "instrumental") return "INVALID_PREFERENCE_FEATURE";
      if (!temporaryOnly && typeof evidence === "string" && /纯音乐|器乐|无(?:人声|演唱)|\binstrumental(?:s| music)?\b/i.test(evidence)) return null;
      return hasInstrumentalPreferenceIntent(state.userText, value as "more" | "less") ? null : "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
    }
    if (type === "track") {
      if (Object.keys(args).some(key => !["target_type", "track_id", "value", "evidence_text"].includes(key)) || typeof args.track_id !== "string" || !args.track_id.trim() || args.track_id.length > 128) return "INVALID_TOOL_ARGUMENTS";
      const track = state.searchResultTracks?.find((item) => item.id === args.track_id);
      if (!track || !state.searchResultIds.includes(track.id)) return "TRACK_ID_NOT_FROM_THIS_TURN";
      if (temporaryOnly) return "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
      const verificationError = verifyNamedTrackPreference(state.userText, track, state.searchResultTracks || []);
      if (verificationError) return verificationError;
      if (typeof evidence === "string" && mentions(evidence, baseTitle(track.title))) return null;
      return hasTargetPreferenceIntent(state.userText, track.title, value as "more" | "less") ? null : "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
    }
    if (type === "artist") {
      if (Object.keys(args).some(key => !["target_type", "artist_name", "value", "evidence_text"].includes(key)) || typeof args.artist_name !== "string" || !args.artist_name.trim() || args.artist_name.length > 120) return "INVALID_TOOL_ARGUMENTS";
      if (!artistName || !(state.searchResultArtists || []).some((name) => name.toLocaleLowerCase() === artistName)) return "ARTIST_NOT_FROM_THIS_TURN";
      if (temporaryOnly) return "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
      const namedTracks = (state.searchResultTracks || []).filter((track) => mentions(state.userText, baseTitle(track.title)));
      const verifiedTracks = namedTracks.length ? namedTracks : state.searchResultTracks || [];
      if (matchingArtistsForPrefix(state.userText, String(args.artist_name), verifiedTracks).length > 1) return "AMBIGUOUS_ARTIST";
      // A song-only opinion cannot be promoted to the whole artist merely by
      // quoting the sentence. Artist-level wording must itself be in the span.
      if (typeof evidence === "string" && uniquelyNamedArtist(evidence, String(args.artist_name), verifiedTracks)
        && !verifiedTracks.some(track => mentions(evidence, baseTitle(track.title)))) return null;
      return hasArtistPreferenceIntent(state.userText, String(args.artist_name), value as "more" | "less", state.searchResultTracks || []) ? null : "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT";
    }
    return "INVALID_PREFERENCE_TARGET";
  }
  if (call.name === "set_session_intent") {
    const keys = Object.keys(args);
    if (!keys.length || !keys.every((key) => ["familiarity", "energy", "flow"].includes(key))) return "INVALID_SESSION_INTENT";
    if ("familiarity" in args && !["familiar", "balanced", "explore"].includes(String(args.familiarity))) return "INVALID_SESSION_INTENT";
    if ("energy" in args && !["calm", "balanced", "energetic"].includes(String(args.energy))) return "INVALID_SESSION_INTENT";
    if ("flow" in args && !["continuous", "balanced", "varied"].includes(String(args.flow))) return "INVALID_SESSION_INTENT";
    return /现在|今晚|此刻|这会|今天|当前|接下来|想听|来点|放点|\b(?:tonight|today|right now|for now|want to hear|want to listen|in the mood)\b/i.test(state.userText) ? null : "SESSION_INTENT_REQUIRES_USER_INTENT";
  }
  if (call.name === "refresh_recommendations") return Object.keys(args).length ? "INVALID_RECOMMENDATION_REFRESH" : /(?:不要|别|不用|无需|不想).{0,8}(?:刷新|换一批|重新推荐)/.test(state.userText) || !/刷新|换一批|重新推荐|\brefresh\b/i.test(state.userText) ? "REFRESH_REQUIRES_USER_INTENT" : null;
  if (call.name === "update_interface") {
    const keys = Object.keys(args);
    if (!keys.length || !keys.every((key) => ["theme", "scene", "particles", "lyrics", "panel"].includes(key))) return "INVALID_INTERFACE_UPDATE";
    if ("theme" in args && args.theme !== "night") return "INVALID_THEME";
    if ("scene" in args && !["night", "dawn", "deep"].includes(String(args.scene))) return "INVALID_SCENE";
    if ("particles" in args && (!Number.isInteger(args.particles) || Number(args.particles) < 0 || Number(args.particles) > 2)) return "INVALID_PARTICLES";
    if ("lyrics" in args && !["minimal", "cinematic"].includes(String(args.lyrics))) return "INVALID_LYRICS";
    if ("panel" in args && !["profile", "settings", "now_playing", "dj", "close"].includes(String(args.panel))) return "INVALID_PANEL";
    const changed = ("theme" in args && args.theme !== state.interface.theme)
      || ("scene" in args && args.scene !== state.interface.scene)
      || ("particles" in args && args.particles !== state.interface.particles)
      || ("lyrics" in args && args.lyrics !== state.interface.lyrics)
      || ("panel" in args && args.panel !== state.interface.panel);
    return changed ? null : "INTERFACE_ALREADY_IN_REQUESTED_STATE";
  }
  return "UNKNOWN_TOOL";
}

export function codioRequestFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/\b(?:CODIO_MODEL_[A-Z_0-9]+|CODIO_CONTEXT_TOO_LARGE|CODIO_MESSAGE_TOO_LARGE|CODIO_MESSAGES_TOO_MANY|DEEPSEEK_KEY_REQUIRED)\b/)?.[0];
  const reason: Record<string, string> = {
    CODIO_MODEL_TIMEOUT: "DeepSeek 请求超时",
    CODIO_MODEL_NETWORK: "暂时无法连接 DeepSeek",
    CODIO_MODEL_UNAUTHORIZED: "DeepSeek Key 未通过认证，请检查自己的 Key",
    CODIO_MODEL_PAYMENT_REQUIRED: "DeepSeek 账户余额不足，请到服务商账户检查余额",
    CODIO_MODEL_RATE_LIMITED: "DeepSeek 请求受限，请稍后再试",
    CODIO_MODEL_SERVICE_UNAVAILABLE: "DeepSeek 服务暂时不可用",
    CODIO_MODEL_HTTP_400: "DeepSeek 拒绝了本次请求参数",
    CODIO_MODEL_EMPTY: "DeepSeek 没有返回有效回复",
    CODIO_MODEL_TRUNCATED: "DeepSeek 的工具回复不完整，已阻止执行",
    CODIO_MODEL_INVALID_RESPONSE: "DeepSeek 返回的数据不完整",
    CODIO_CONTEXT_TOO_LARGE: "电台状态超过请求上限",
    CODIO_MESSAGE_TOO_LARGE: "这条消息超过长度上限，请分成两条发送",
    CODIO_MESSAGES_TOO_MANY: "本轮工具消息超过安全上限",
    DEEPSEEK_KEY_REQUIRED: "请连接自己的 DeepSeek Key",
  };
  return `${reason[code || ""] || "AI DJ 请求未完成"}；这次没有执行任何操作，偏好和推荐均未改变。`;
}

export function didRequestedTrackStart(selected: boolean, requestedId: string, activeId: string | undefined, paused: boolean | undefined) {
  return selected && activeId === requestedId && paused === false;
}

type ToolOutcome = { name: string; result: Record<string, unknown> };

function toolFailureMessage(error: unknown) {
  switch (error) {
    case "PLAYBACK_REQUIRES_USER_INTENT": return "你没有要求播放，所以没有动播放状态";
    case "TRACK_ID_NOT_FROM_THIS_TURN":
    case "ARTIST_NOT_FROM_THIS_TURN": return "歌曲或歌手还没核对清楚，相关偏好没有保存";
    case "AMBIGUOUS_TRACK": return "找到不止一个同名版本，请告诉我具体是哪一首；偏好没有保存";
    case "AMBIGUOUS_ARTIST": return "找到多位名字相近的歌手，请告诉我具体是哪一位；偏好没有保存";
    case "TRACK_ARTIST_MISMATCH":
    case "TRACK_NOT_NAMED_BY_USER": return "搜索结果与提到的歌曲没有对上，偏好没有保存";
    case "PROFILE_NOT_READY": return "声音画像还没加载好，偏好没有保存";
    case "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT": return "这句话没有明确的喜欢或不喜欢，相关偏好没有保存";
    case "INVALID_PREFERENCE_EVIDENCE": return "偏好的依据没有与原话核对上，相关偏好没有保存";
    case "INVALID_PREFERENCE_FEATURE": return "这类偏好目前没有可靠的歌曲分类支持，偏好没有保存";
    case "INVALID_PREFERENCE_TARGET":
    case "INVALID_TOOL_ARGUMENTS": return "偏好操作的参数没有通过校验，相关偏好没有保存";
    case "REFRESH_REQUIRES_USER_INTENT": return "你没有要求刷新，所以当前推荐没有更换";
    case "TRACK_PLAYBACK_FAILED": return "歌曲没有成功开始播放";
    case "QQ_NOT_CONNECTED": return "QQ 音乐尚未连接，无法核对歌曲";
    case "QQ_STATUS_UNAVAILABLE": return "暂时无法确认 QQ 音乐的当前状态，相关偏好没有保存；不是已确认掉线，也不需要先重新登录";
    case "SEARCH_UNAVAILABLE": return "当前无法搜索歌曲，偏好没有保存";
    case "TOOL_EXECUTION_FAILED": return "本地操作失败，没有确认生效";
    case "DUPLICATE_TOOL_CALL_ID": return "重复操作已拦截";
    default: return "有一步操作没能确认生效";
  }
}

function summarizeToolOutcomes(outcomes: ToolOutcome[], disconnected = false, userText = "") {
  const saved = outcomes.filter(({ name, result }) => name === "record_music_preference" && result.ok === true && result.persisted === true);
  const temporary = outcomes.find(({ name, result }) => name === "set_session_intent" && result.ok === true);
  const failed = outcomes.filter(({ result }) => result.ok !== true);
  const parts: string[] = [];
  if (saved.length) {
    const describe = ({ result }: ToolOutcome) => result.targetType === "artist"
      ? `歌手 ${String(result.artist || result.targetKey || "")}`
      : result.targetType === "feature" ? result.targetKey === "instrumental" ? "纯音乐" : "音乐类别"
        : `《${String(result.title || "已核对的歌曲")}》${result.artist ? `（${String(result.artist)}）` : ""}`;
    const liked = saved.filter(({ result }) => result.value === "more").map(describe);
    const disliked = saved.filter(({ result }) => result.value === "less").map(describe);
    const feedback = [liked.length ? `喜欢 ${liked.join("、")}` : "", disliked.length ? `不喜欢 ${disliked.join("、")}` : ""].filter(Boolean).join("；");
    const allUpdated = saved.every(({ result }) => result.profileUpdated === true && ["queued", "pending_queue"].includes(String(result.recommendationEffect)));
    const latest = saved.map(({ result }) => result.recommendationUpdate as Record<string, unknown> | undefined);
    const committed = latest.some(update => update?.hiddenQueueCommitted === true);
    const poolCommitted = latest.some(update => update?.hiddenPoolCommitted === true && Number(update.hiddenCandidateCount) > 0);
    const terminal = latest.some(update => ["completed", "failed", "insufficient_candidates"].includes(String(update?.status)));
    parts.push(committed && saved.every(({ result }) => result.profileUpdated === true)
      ? `已记下你${feedback}，画像已更新；未展示的推荐队列已提交。当前可见的 24 首保持不变，按 REFRESH 才换一批。`
      : poolCommitted && saved.every(({ result }) => result.profileUpdated === true)
      ? `已记下你${feedback}，画像已更新；未展示的推荐候选已按最新偏好重排。当前播放队列没有改动，可见的 24 首按 REFRESH 才更换。`
      : terminal && saved.every(({ result }) => result.profileUpdated === true)
      ? `已记下你${feedback}，画像已更新；这次重排未能提交新的待播队列，偏好仍会保留。当前可见的 24 首没有更换。`
      : allUpdated
      ? `已记下你${feedback}，画像已更新；后续推荐重排已排队，尚未确认队列提交。可见的 24 首要等你按 REFRESH 才更换。`
      : `已保存你${feedback}，但画像或推荐更新还没有得到确认。`);
  }
  if (temporary) parts.push("已保存这次听歌的方向，长期画像不变；后续重排已排队，尚未确认提交。");
  if (failed.length) parts.push([...new Set(failed.map(({ result }) => toolFailureMessage(result.error)))].join("；") + "。");
  if (!parts.length) {
    const playback = outcomes.find(({ name, result }) => name === "play_search_result" && result.ok === true);
    const searches = outcomes.filter(({ name, result }) => name === "search_music" && result.ok === true);
    if (playback) {
      const track = playback.result.currentTrack && typeof playback.result.currentTrack === "object" ? playback.result.currentTrack as Record<string, unknown> : {};
      parts.push(`已开始播放《${String(track.title || "这首歌")}》。`);
    } else if (searches.length) {
      const allResults = searches.flatMap(({ result }) => Array.isArray(result.results) ? result.results : []);
      const namedResults = allResults.filter((item) => item && typeof item === "object" && mentions(userText, baseTitle(String((item as Record<string, unknown>).title || ""))));
      const results = namedResults.length ? namedResults : allResults;
      parts.push(results.length ? `找到了${results.slice(0, 3).map((item) => {
        const track = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return `《${String(track.title || "未知歌曲")}》${track.artist ? `（${String(track.artist)}）` : ""}`;
      }).join("、")}；这次只完成了搜索，偏好和播放都没有改变。` : "没有找到可核对的歌曲，偏好和播放都没有改变。");
    } else {
      const rating = outcomes.find(({ name, result }) => name === "rate_current_track" && result.ok === true);
      if (rating) parts.push(rating.result.rating === "dislike" ? "已给当前歌曲记下一次负反馈，只降低这首歌在本次会话中的权重。" : "已记下你喜欢当前歌曲，会影响后续推荐。");
      else if (outcomes.some(({ result }) => result.ok === true)) parts.push("已执行刚才的本地操作。");
      else parts.push("这次没有操作生效。");
    }
  }
  if (disconnected) parts.push("DeepSeek 随后断开了；我不会重复执行这些操作。");
  return parts.join("");
}

function finalAgentReply(content: string, outcomes: ToolOutcome[], userText: string) {
  const text = content.trim();
  const summary = () => summarizeToolOutcomes(outcomes, false, userText);
  if (!outcomes.length && !text) return "我在。";
  const persisted = outcomes.some(({ name, result }) => name === "record_music_preference" && result.ok === true && result.persisted === true);
  const profileUpdated = outcomes.some(({ result }) => result.ok === true && result.profileUpdated === true);
  const played = outcomes.some(({ name, result }) => result.ok === true && (name === "play_search_result" || name === "control_playback" && (result.after as Record<string, unknown> | undefined)?.playing === true));
  const committed = outcomes.some(({ result }) => result.ok === true && ((result.recommendationUpdate as Record<string, unknown> | undefined)?.hiddenQueueCommitted === true
    || (result.recommendationUpdate as Record<string, unknown> | undefined)?.hiddenPoolCommitted === true));
  const contradiction = !persisted && /(?:已(?:经)?|成功).{0,8}(?:保存|记下|记住|记录).{0,8}(?:偏好|喜欢|不喜欢)|偏好.{0,6}(?:已(?:经)?|成功)(?:保存|更新|调整)/.test(text)
    || !profileUpdated && /画像.{0,6}(?:已(?:经)?|成功)(?:保存|更新|调整)|(?:已(?:经)?|成功).{0,5}(?:更新|调整).{0,5}画像/.test(text)
    || !played && /(?:已(?:经)?|成功).{0,6}(?:开始播放|播放了|播放歌曲)/.test(text)
    || !committed && /(?:推荐|队列).{0,8}(?:已经|已|成功).{0,5}(?:调整好|更新好|更新了|提交|更换)|(?:已(?:经)?|成功).{0,5}(?:提交|更新|调整好).{0,6}(?:推荐|队列)/.test(text);
  if (!text || /\{\s*"(?:ok|error)"|\b(?:TOOL_[A-Z_]+|INVALID_[A-Z_]+|TRACK_[A-Z_]+)\b/.test(text) || contradiction) return summary();
  if (outcomes.some(({ result }) => result.ok !== true)) return `${text}\n\n${summary()}`;
  if (persisted && (!/(?:保存|记下|记住)/.test(text) || !/(?:排队|尚未|还没|后续候选|后续推荐)/.test(text))) return `${text}\n\n${summary()}`;
  return text;
}

export async function runCodioAgentLoop(options: {
  messages: AgentMessage[];
  step: (messages: AgentMessage[], context: Record<string, unknown>) => Promise<{ content: string; toolCalls: AgentToolCall[] }>;
  execute: (call: AgentToolCall) => Promise<Record<string, unknown>>;
  context: () => Record<string, unknown>;
  maxRounds?: number;
  maxActions?: number;
}) {
  const messages = [...options.messages];
  const userText = [...options.messages].reverse().find((message) => message.role === "user")?.content || "";
  const maxRounds = options.maxRounds ?? 4;
  const maxActions = options.maxActions ?? 6;
  let attemptedActions = 0;
  let successfulActions = 0;
  const outcomes: ToolOutcome[] = [];
  const seenToolCallIds = new Set<string>();
  const wireToolCallIds = new Set<string>();
  const finish = (content = "", disconnected = false) => {
    // Observe the real terminal update if it completed during the model round.
    // Never upgrade a queued result based on an older, unrelated refresh.
    let latest: Record<string, unknown> | undefined;
    try { latest = (options.context().recommendations as Record<string, unknown> | undefined)?.latestUpdate as Record<string, unknown> | undefined; } catch { /* Saved tool facts remain authoritative. */ }
    const observed = outcomes.map(outcome => {
      const requested = outcome.result.recommendationUpdate as Record<string, unknown> | undefined;
      return outcome.result.persisted === true && typeof requested?.revision === "number"
        && typeof latest?.revision === "number" && latest.revision >= requested.revision
        ? { ...outcome, result: { ...outcome.result, recommendationUpdate: latest } } : outcome;
    });
    return { content: disconnected || !content && outcomes.length > 0 ? summarizeToolOutcomes(observed, disconnected, userText)
      : finalAgentReply(content, observed, userText), attemptedActions, successfulActions, executedActions: attemptedActions, messages };
  };
  let rejectionSequence = 0;
  const nextRejectionId = () => {
    let id = "";
    do { id = `codio-rejected-${rejectionSequence += 1}`; } while (wireToolCallIds.has(id));
    wireToolCallIds.add(id);
    return id;
  };
  for (let round = 0; round < maxRounds; round += 1) {
    let response;
    try {
      response = await options.step(messages, options.context());
    } catch (error) {
      if (attemptedActions) return finish("", true);
      throw error;
    }
    if (!response.toolCalls?.length) return finish(response.content || "");
    const accepted = response.toolCalls.slice(0, Math.max(0, maxActions - attemptedActions));
    if (!accepted.length) return finish();
    const prepared = accepted.map((call) => {
      const duplicate = seenToolCallIds.has(call.id) || wireToolCallIds.has(call.id);
      if (!duplicate) {
        seenToolCallIds.add(call.id);
        wireToolCallIds.add(call.id);
      }
      return { call, duplicate, wireId: duplicate ? nextRejectionId() : call.id };
    });
    messages.push({ role: "assistant", content: response.content || "", toolCalls: prepared.map(({ call, wireId }) => ({ ...call, id: wireId })) });
    for (const { call, duplicate, wireId } of prepared) {
      attemptedActions += 1;
      let result: Record<string, unknown>;
      if (duplicate) result = { ok: false, error: "DUPLICATE_TOOL_CALL_ID", rejectedToolCallId: call.id };
      else {
        try { result = await options.execute(call); }
        catch { result = { ok: false, error: "TOOL_EXECUTION_FAILED" }; }
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) result = { ok: false, error: "TOOL_RESULT_INVALID" };
      if (result.ok === true) successfulActions += 1;
      outcomes.push({ name: call.name, result });
      let content;
      try { content = JSON.stringify(result); }
      catch { content = JSON.stringify({ ok: result.ok === true, error: "TOOL_RESULT_SERIALIZATION_FAILED" }); }
      messages.push({ role: "tool", toolCallId: wireId, content });
    }
  }
  return finish();
}
