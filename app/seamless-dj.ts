export type AudioFocus = "beats" | "vocal" | "full";

export type TrackSection = {
  start: number;
  end: number;
  label: "intro" | "verse" | "chorus" | "breakdown" | "build" | "drop" | "outro" | "unknown";
  energy: number;
  bassEnergy: number;
  vocalProbability: number;
  confidence: number;
};

export type CuePoint = { time: number; score: number; reason: string };
export type VisualCueType = "beat" | "downbeat" | "low-transient" | "high-transient" | "accent" | "phrase" | "section-enter" | "build" | "breakdown" | "drop" | "outro";
export type VisualCue = { time: number; type: VisualCueType; strength: number; confidence: number; low: number; mid: number; high: number; sectionIndex?: number };
export type MusicFeatureFrame = { time: number; energy: number; bass: number; brightness: number; spectralFlux: number; vocalProbability: number };

export type TrackAnalysis = {
  version: number;
  trackId: string;
  duration: number;
  effectiveStart: number;
  effectiveEnd: number;
  sourceSignature?: string;
  silence?: {
    version: 1;
    windowSeconds: number;
    noiseFloorRms: number;
    thresholdRms: number;
    leadingSeconds: number;
    trailingSeconds: number;
    lastAudibleTime: number;
    guardSeconds: number;
    startConfidence: number;
    tailConfidence: number;
    channels: number;
  };
  bpm: number;
  tempoConfidence: number;
  tempoStable: boolean;
  beats: number[];
  downbeats: number[];
  meter: 3 | 4 | null;
  beatGridConfidence: number;
  phraseBoundaries: number[];
  phraseConfidence: number;
  sections: TrackSection[];
  key: string | null;
  keyConfidence: number;
  chromaByBar: number[][];
  integratedLufs: number | null;
  truePeakDb: number | null;
  shortTermLoudnessByBar: Array<number | null>;
  energyByBar: number[];
  bassEnergyByBar: number[];
  vocalProbabilityByBar: number[];
  spectralFluxByBar: number[];
  safeInCues: CuePoint[];
  safeOutCues: CuePoint[];
  analysisConfidence: number;
  visualCues: VisualCue[];
  featureFrames: MusicFeatureFrame[];
  waveform: number[];
  introFocus: AudioFocus;
  outroFocus: AudioFocus;
  introConfidence: number;
  outroConfidence: number;
  beatOffset: number;
};

export type TransitionStrategy = "phrase-eq-blend" | "downbeat-cut" | "breakdown-bridge";
export type TransitionPlan = {
  id: string;
  strategy: TransitionStrategy;
  outgoingTrackId: string;
  incomingTrackId: string;
  outgoingCue: number;
  incomingCue: number;
  transitionBars: 4 | 8 | 16 | 32;
  transitionDuration: number;
  switchPoint: number;
  targetBpm: number | null;
  outgoingTempoRatio: number;
  incomingTempoRatio: number;
  outgoingGainCurve: number[];
  incomingGainCurve: number[];
  outgoingLowCurve: number[];
  incomingLowCurve: number[];
  outgoingMidCurve: number[];
  incomingMidCurve: number[];
  outgoingHighCurve: number[];
  incomingHighCurve: number[];
  confidence: number;
  reasons: string[];
  fallback: "downbeat-cut" | "breakdown-bridge";
  boundaryHandoff?: boolean;
};

export type TransitionVisualFrame = {
  progress: number;
  beforeSwitch: boolean;
  outgoingWeight: number;
  incomingWeight: number;
  identityMix: number;
  backgroundMix: number;
  particleMix: number;
  waveformMix: number;
  lyricMix: number;
  phase: "hidden" | "opening" | "handoff" | "settling" | "complete";
};

export type MusicVisualFrame = {
  time: number;
  beatIndex: number;
  beatPhase: number;
  barIndex: number;
  cue: VisualCue | null;
  beatEnvelope: number;
  downbeatEnvelope: number;
  phraseEnvelope: number;
  dramaticEnvelope: number;
  continuousEnergy: number;
};

export type PcmTrackInput = { trackId: string; sampleRate: number; channels: Float32Array[]; sourceSignature?: string };

export const TRANSITION_WEIGHTS = {
  phraseMisalignment: 2.5,
  vocalConflict: 2.3,
  bassConflict: 2,
  beatPhaseError: 1.8,
  timeStretchAmount: 1.4,
  harmonicConflict: 1.2,
  loudnessJump: 1,
  energyTrajectoryMismatch: 1,
  analysisUncertainty: 2,
} as const;

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (value: number) => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
const curve = (length: number, sample: (x: number) => number) => Array.from({ length }, (_, index) => sample(index / (length - 1)));
const nearestTempo = (source: number, target: number) => [source * .5, source, source * 2].reduce((best, value) => Math.abs(Math.log(target / value)) < Math.abs(Math.log(target / best)) ? value : best);
const reliableCue = (cues: CuePoint[], fallback: number) => [...cues].filter((cue) => Number.isFinite(cue.time)).sort((a, b) => b.score - a.score)[0]?.time ?? fallback;
const finalValue = (values: number[], fallback: number) => values.length ? values[values.length - 1] : fallback;
const lowerBound = <T,>(items: T[], value: number, time: (item: T) => number) => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (time(items[middle]) < value) low = middle + 1;
    else high = middle;
  }
  return low;
};

export function getTransitionVisualFrame(strategy: TransitionStrategy, audioStartAt: number, duration: number, switchPoint: number, audioContextTime: number): TransitionVisualFrame {
  const raw = (audioContextTime - audioStartAt) / Math.max(.05, duration);
  const progress = clamp(raw);
  if (raw < 0) return { progress: 0, beforeSwitch: true, outgoingWeight: 1, incomingWeight: 0, identityMix: 0, backgroundMix: 0, particleMix: 0, waveformMix: 0, lyricMix: 0, phase: "hidden" };
  const beforeSwitch = progress < switchPoint;
  const equalPowerIn = Math.sin(smooth(progress) * Math.PI / 2);
  const equalPowerOut = Math.cos(smooth(progress) * Math.PI / 2);
  let identityMix = smooth(clamp((progress - switchPoint + .13) / .26));
  let backgroundMix = equalPowerIn;
  let particleMix = smooth(progress);
  let waveformMix = equalPowerIn;
  let lyricMix = identityMix;
  if (strategy === "downbeat-cut") {
    identityMix = smooth(clamp((progress - switchPoint + .08) / .16));
    backgroundMix = smooth(clamp((progress - switchPoint + .2) / .4));
    particleMix = smooth(clamp((progress - switchPoint + .12) / .24));
    waveformMix = identityMix;
    lyricMix = smooth(clamp((progress - switchPoint + .04) / .08));
  } else if (strategy === "breakdown-bridge") {
    identityMix = smooth(clamp((progress - switchPoint + .18) / .36));
    backgroundMix = smooth(progress);
    particleMix = smooth(clamp((progress - .12) / .76));
    waveformMix = smooth(clamp((progress - .2) / .62));
    lyricMix = smooth(clamp((progress - switchPoint + .08) / .28));
  }
  const phase = raw >= 1 ? "complete" : progress < .08 ? "opening" : beforeSwitch ? "handoff" : "settling";
  return { progress, beforeSwitch, outgoingWeight: equalPowerOut, incomingWeight: equalPowerIn, identityMix, backgroundMix, particleMix, waveformMix, lyricMix, phase };
}

export function getTransitionChoreography(strategy: TransitionStrategy, progress: number) {
  const p = clamp(progress);
  const arch = Math.sin(p * Math.PI);
  if (strategy === "downbeat-cut") {
    const compression = smooth(clamp((p - .34) / .16));
    const release = smooth(clamp((p - .5) / .22));
    return {
      displacement: .035 * compression + .1 * release * (1 - release),
      density: 1 - .16 * compression + .16 * release,
      luminance: 1 - .05 * compression + .035 * release,
      energy: .92 + .2 * release,
    };
  }
  if (strategy === "breakdown-bridge") {
    return {
      displacement: .055 * arch,
      density: 1 - .38 * arch,
      luminance: 1 - .2 * arch,
      energy: 1 - .32 * arch,
    };
  }
  return {
    displacement: .08 * arch,
    density: 1 - .07 * arch,
    luminance: 1 - .035 * arch,
    energy: .98 + .04 * Math.sin(p * Math.PI * 2),
  };
}

export function transitionSettlingDuration(strategy: TransitionStrategy) {
  return strategy === "phrase-eq-blend" ? .78 : strategy === "downbeat-cut" ? .32 : .9;
}

export function adaptTransitionPlan(
  plan: TransitionPlan,
  reason: "automatic" | "manual-next" | "manual-previous" | "manual-select",
  paused = false,
): TransitionPlan {
  if (reason === "automatic") return plan;
  const transitionDuration = paused
    ? .36
    : reason === "manual-next"
      ? clamp(plan.transitionDuration, .6, 1.4)
      : clamp(plan.transitionDuration, .4, .9);
  const strategy = paused ? "breakdown-bridge" : plan.strategy;
  return {
    ...plan,
    strategy,
    transitionDuration,
    switchPoint: paused ? .5 : clamp(plan.switchPoint, .46, .58),
    incomingCue: paused ? 0 : plan.incomingCue,
    outgoingTempoRatio: paused ? 1 : plan.outgoingTempoRatio,
    incomingTempoRatio: paused ? 1 : plan.incomingTempoRatio,
    ...(paused ? makeCurves("breakdown-bridge") : {}),
    reasons: [...plan.reasons, paused ? "暂停状态使用静态身份交接" : `${reason} 使用压缩过渡计划`],
  };
}

export function createNeutralTransitionPlan(
  outgoingTrackId: string,
  incomingTrackId: string,
  id: string,
  reason: "automatic" | "manual-next" | "manual-previous" | "manual-select",
  paused = false,
): TransitionPlan {
  const transitionDuration = paused ? .36 : reason === "automatic" ? 3.2 : reason === "manual-next" ? .9 : .62;
  return {
    id,
    strategy: "breakdown-bridge",
    outgoingTrackId,
    incomingTrackId,
    outgoingCue: 0,
    incomingCue: 0,
    transitionBars: 4,
    transitionDuration,
    switchPoint: .5,
    targetBpm: null,
    outgoingTempoRatio: 1,
    incomingTempoRatio: 1,
    ...makeCurves("breakdown-bridge"),
    ...(reason === "automatic" ? {
      // Unknown structure is not permission to suppress a real intro's bass.
      outgoingLowCurve: curve(64, () => 1), incomingLowCurve: curve(64, () => 1),
      outgoingMidCurve: curve(64, () => 1), incomingMidCurve: curve(64, () => 1),
      outgoingHighCurve: curve(64, () => 1), incomingHighCurve: curve(64, () => 1),
    } : {}),
    confidence: 0,
    reasons: ["分析不可用，使用 neutral bridge", paused ? "暂停状态不伪造节拍" : "保留歌曲原速"],
    fallback: "breakdown-bridge",
  };
}

export function getMusicVisualFrame(analysis: TrackAnalysis | null, time: number): MusicVisualFrame {
  if (!analysis) return { time, beatIndex: -1, beatPhase: 0, barIndex: -1, cue: null, beatEnvelope: 0, downbeatEnvelope: 0, phraseEnvelope: 0, dramaticEnvelope: 0, continuousEnergy: .18 };
  const beatIndex = Math.max(0, lowerBound(analysis.beats, time + .001, (value) => value) - 1);
  const beatTime = analysis.beats[beatIndex] ?? analysis.effectiveStart;
  const nextBeat = analysis.beats[beatIndex + 1] ?? beatTime + 60 / Math.max(60, analysis.bpm);
  const beatPhase = clamp((time - beatTime) / Math.max(.08, nextBeat - beatTime));
  const cueIndex = lowerBound(analysis.visualCues, time + .001, (cue) => cue.time) - 1;
  const cue = cueIndex >= 0 ? analysis.visualCues[cueIndex] : null;
  const age = cue ? Math.max(0, time - cue.time) : Infinity;
  const pulse = (duration: number) => age < duration ? Math.pow(1 - age / duration, 1.8) : 0;
  const featureIndex = Math.max(0, lowerBound(analysis.featureFrames, time + .001, (frame) => frame.time) - 1);
  const feature = analysis.featureFrames[featureIndex];
  const dramatic = cue && ["drop", "accent", "section-enter"].includes(cue.type) && cue.confidence >= .7 && cue.strength >= .78;
  return {
    time, beatIndex, beatPhase, barIndex: analysis.meter ? Math.floor(beatIndex / analysis.meter) : -1, cue,
    beatEnvelope: cue?.type === "beat" ? pulse(.17) * cue.strength * cue.confidence : 0,
    downbeatEnvelope: cue?.type === "downbeat" ? pulse(.24) * cue.strength * cue.confidence : 0,
    phraseEnvelope: cue && ["phrase", "section-enter", "build", "breakdown"].includes(cue.type) ? pulse(1.1) * cue.strength * cue.confidence : 0,
    dramaticEnvelope: dramatic ? pulse(1.05) * cue.strength * cue.confidence : 0,
    continuousEnergy: feature?.energy ?? .18,
  };
}

export function analyzePcmTrack({ trackId, sampleRate, channels, sourceSignature }: PcmTrackInput): TrackAnalysis | null {
  const usableChannels = channels.filter((channel) => channel?.length).slice(0, 8);
  if (!usableChannels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const length = Math.min(...usableChannels.map((channel) => channel.length));
  const duration = length / sampleRate;
  if (duration < 2) return null;
  const hop = 2048;
  const hopSeconds = hop / sampleRate;
  // Boundary detection uses channel energy, never an L+R mix: antiphase and
  // one-sided recordings must remain audible. A low dBFS threshold only
  // identifies sustained near-digital silence; quiet music is not a stem.
  const boundaryHop = Math.max(1, Math.round(sampleRate * .02));
  const boundaryRms: number[] = [];
  const boundaryPeaks: number[] = [];
  for (let offset = 0; offset < length; offset += boundaryHop) {
    let maxEnergy = 0, peak = 0;
    const end = Math.min(length, offset + boundaryHop);
    for (const channel of usableChannels) {
      let energy = 0;
      for (let index = offset; index < end; index += 1) {
        const value = channel[index];
        if (!Number.isFinite(value)) return null;
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      maxEnergy = Math.max(maxEnergy, energy / Math.max(1, end - offset));
    }
    boundaryRms.push(Math.sqrt(maxEnergy));
    boundaryPeaks.push(peak);
  }
  const terminalFrames = Math.max(1, Math.ceil(1 / .02));
  const terminalRms = boundaryRms.slice(-terminalFrames).sort((a, b) => a - b);
  const noiseFloorRms = terminalRms[Math.floor(terminalRms.length * .2)] || 0;
  const thresholdRms = Math.max(.000001, Math.min(.00001, noiseFloorRms * 2.5));
  const quiet = boundaryRms.map((value, index) => value <= thresholdRms && boundaryPeaks[index] <= thresholdRms * 4);
  const firstSoundFrame = quiet.findIndex((value) => !value);
  // A fully silent or malformed recording has no defensible musical endpoint.
  if (firstSoundFrame < 0) return null;
  let lastSoundFrame = quiet.length - 1;
  while (lastSoundFrame > firstSoundFrame && quiet[lastSoundFrame]) lastSoundFrame -= 1;
  const windowSeconds = boundaryHop / sampleRate;
  const firstAudibleTime = firstSoundFrame * windowSeconds;
  const lastAudibleTime = Math.min(duration, (lastSoundFrame + 1) * windowSeconds);
  const leadingSeconds = firstAudibleTime;
  const trailingSeconds = Math.max(0, duration - lastAudibleTime);
  const guardSeconds = .28;
  const startConfidence = leadingSeconds >= .12 ? .98 : 0;
  const tailConfidence = trailingSeconds >= 2.5 && lastAudibleTime >= .25 ? .98 : 0;
  const effectiveStart = startConfidence >= .9 ? Math.max(0, firstAudibleTime - .04) : 0;
  const effectiveEnd = tailConfidence >= .9 ? Math.min(duration, lastAudibleTime + guardSeconds) : duration;
  const envelope: number[] = [];
  const lowEnvelope: number[] = [];
  const midEnvelope: number[] = [];
  const highEnvelope: number[] = [];
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 220 / sampleRate);
  const midAlpha = 1 - Math.exp(-2 * Math.PI * 2400 / sampleRate);
  let lowState = 0;
  let midState = 0;
  for (let offset = 0; offset < length; offset += hop) {
    let energy = 0;
    let lowEnergy = 0;
    let midEnergy = 0;
    let highEnergy = 0;
    let samples = 0;
    const end = Math.min(length, offset + hop);
    for (let index = offset; index < end; index += 1) {
      let mono = 0, channelEnergy = 0;
      for (const channel of usableChannels) {
        mono += channel[index] || 0;
        channelEnergy += channel[index] ** 2;
      }
      mono /= usableChannels.length;
      lowState += lowAlpha * (mono - lowState);
      midState += midAlpha * (mono - midState);
      const low = lowState;
      const mid = midState - lowState;
      const high = mono - midState;
      // Energy is channel-safe even when the spectral heuristic mixes to mono.
      energy += channelEnergy / usableChannels.length;
      lowEnergy += low * low;
      midEnergy += mid * mid;
      highEnergy += high * high;
      samples += 1;
    }
    envelope.push(Math.sqrt(energy / Math.max(1, samples)));
    lowEnvelope.push(Math.sqrt(lowEnergy / Math.max(1, samples)));
    midEnvelope.push(Math.sqrt(midEnergy / Math.max(1, samples)));
    highEnvelope.push(Math.sqrt(highEnergy / Math.max(1, samples)));
  }

  const firstAudible = Math.floor(firstAudibleTime / hopSeconds);
  const lastAudible = Math.min(envelope.length - 1, Math.floor(lastAudibleTime / hopSeconds));
  const audibleFrames = Math.max(1, Math.min(envelope.length, Math.ceil(effectiveEnd / hopSeconds)));
  const waveformBins = 96;
  const rawWaveform = Array.from({ length: waveformBins }, (_, bin) => {
    const start = Math.floor(bin / waveformBins * audibleFrames);
    const end = Math.max(start + 1, Math.floor((bin + 1) / waveformBins * audibleFrames));
    let sum = 0;
    for (let index = start; index < Math.min(end, audibleFrames); index += 1) sum += envelope[index];
    return sum / Math.max(1, Math.min(end, audibleFrames) - start);
  });
  const waveformScale = [...rawWaveform].sort((a, b) => a - b)[Math.floor(rawWaveform.length * .94)] || 1;
  const waveform = rawWaveform.map((value, index) => {
    const smoothed = ((rawWaveform[Math.max(0, index - 1)] || value) + value * 2 + (rawWaveform[Math.min(rawWaveform.length - 1, index + 1)] || value)) / 4;
    return clamp(smoothed / waveformScale, .05, 1);
  });

  const lowFlux = lowEnvelope.map((value, index) => Math.max(0, value - (lowEnvelope[index - 1] || value)));
  const midFlux = midEnvelope.map((value, index) => Math.max(0, value - (midEnvelope[index - 1] || value)));
  const highFlux = highEnvelope.map((value, index) => Math.max(0, value - (highEnvelope[index - 1] || value)));
  const onset = envelope.map((value, index) => Math.max(0, value - (envelope[index - 1] || value) * 1.03) + lowFlux[index] * .8 + midFlux[index] * .48 + highFlux[index] * .32);
  const analysisFrames = Math.min(onset.length, Math.floor(150 / hopSeconds));
  let bestBpm = 96;
  let bestScore = -1;
  const tempoScores: Array<{ bpm: number; score: number }> = [];
  for (let bpm = 72; bpm <= 152; bpm += 1) {
    const lag = Math.max(1, Math.round((60 / bpm) / hopSeconds));
    let score = 0;
    for (let index = lag; index < analysisFrames; index += 1) score += onset[index] * onset[index - lag];
    tempoScores.push({ bpm, score });
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  const scoreMedian = [...tempoScores].sort((a, b) => a.score - b.score)[Math.floor(tempoScores.length * .5)]?.score || 0;
  const competingScore = tempoScores.filter((candidate) => Math.abs(candidate.bpm - bestBpm) > 3).reduce((maximum, candidate) => Math.max(maximum, candidate.score), 0);
  const tempoProminence = bestScore > 0 ? Math.max(0, (bestScore - scoreMedian) / bestScore) : 0;
  const tempoSeparation = bestScore > 0 ? Math.max(0, (bestScore - competingScore) / bestScore) : 0;
  const tempoConfidence = clamp(.14 + tempoProminence * .5 + tempoSeparation * .34, .12, .86);
  const beatSeconds = 60 / bestBpm;
  const earlyFrames = Math.min(onset.length, Math.floor(12 / hopSeconds));
  const earlyPeak = Math.max(...onset.slice(0, earlyFrames), 0);
  let firstBeatFrame = onset.findIndex((value, index) => index > 1 && index < earlyFrames && value >= earlyPeak * .34);
  if (firstBeatFrame < 0) firstBeatFrame = 0;
  let beatOffset = firstBeatFrame * hopSeconds;
  while (beatOffset > beatSeconds) beatOffset -= beatSeconds;

  const classifySection = (startFrame: number, endFrame: number) => {
    const start = Math.max(0, Math.min(envelope.length - 1, startFrame));
    const end = Math.max(start + 1, Math.min(envelope.length, endFrame));
    const section = envelope.slice(start, end);
    const sectionOnsets = onset.slice(start, end);
    const mean = section.reduce((sum, value) => sum + value, 0) / Math.max(1, section.length);
    const variance = section.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, section.length);
    const variation = Math.min(1.4, Math.sqrt(variance) / Math.max(mean, .0001));
    const continuity = section.filter((value) => value > mean * .52).length / Math.max(1, section.length);
    const onsetStrength = sectionOnsets.reduce((sum, value) => sum + value, 0) / Math.max(mean * sectionOnsets.length, .0001);
    const channel = usableChannels[0];
    const sampleStart = Math.floor(start * hop);
    const sampleEnd = Math.min(channel.length, Math.floor(end * hop));
    let crossings = 0;
    let sampled = 0;
    let previous = channel[sampleStart] || 0;
    for (let index = sampleStart + 12; index < sampleEnd; index += 12) {
      const value = channel[index];
      if ((value >= 0) !== (previous >= 0)) crossings += 1;
      previous = value;
      sampled += 1;
    }
    const zeroCrossing = crossings / Math.max(1, sampled);
    const beatScore = Math.min(2, onsetStrength * 1.7) + Math.min(1, variation) * .58 + Math.min(.3, zeroCrossing * 1.8);
    const vocalBandHint = Math.max(0, 1 - Math.abs(zeroCrossing - .09) / .09);
    const vocalScore = continuity * .92 + Math.max(0, 1 - variation) * .46 + vocalBandHint * .44;
    const distance = Math.abs(beatScore - vocalScore);
    const focus: AudioFocus = beatScore > vocalScore + .16 ? "beats" : vocalScore > beatScore + .12 ? "vocal" : "full";
    return { focus, confidence: Math.min(1, .42 + distance * .46) };
  };
  const introFrames = Math.max(6, Math.round(11 / hopSeconds));
  const outroFrames = Math.max(6, Math.round(12 / hopSeconds));
  const intro = classifySection(firstAudible, firstAudible + introFrames);
  const outro = classifySection(lastAudible - outroFrames, lastAudible + 1);
  const beats: number[] = [];
  for (let time = beatOffset; time <= effectiveEnd; time += beatSeconds) if (time >= effectiveStart) beats.push(time);
  const beatStrengths = beats.map((time) => onset[Math.max(0, Math.min(onset.length - 1, Math.round(time / hopSeconds)))] || 0);
  const meterScores: Array<{ meter: 3 | 4; phase: number; score: number }> = [];
  for (const candidateMeter of [3, 4] as const) {
    for (let phase = 0; phase < candidateMeter; phase += 1) {
      let accent = 0;
      let others = 0;
      let accentCount = 0;
      let otherCount = 0;
      beatStrengths.forEach((strength, index) => {
        if (index % candidateMeter === phase) { accent += strength; accentCount += 1; }
        else { others += strength; otherCount += 1; }
      });
      const accentMean = accent / Math.max(1, accentCount);
      const otherMean = others / Math.max(1, otherCount);
      meterScores.push({ meter: candidateMeter, phase, score: (accentMean - otherMean) / Math.max(.00001, accentMean + otherMean) });
    }
  }
  meterScores.sort((a, b) => b.score - a.score);
  const meterLead = (meterScores[0]?.score || 0) - (meterScores[1]?.score || 0);
  const meterConfidence = clamp((meterScores[0]?.score || 0) * 1.4 + meterLead * 2.2);
  const meter: 3 | 4 | null = tempoConfidence >= .34 && meterConfidence >= .2 ? meterScores[0].meter : null;
  const downbeatPhase = meter ? meterScores.find((candidate) => candidate.meter === meter)?.phase || 0 : 0;
  const downbeats = meter ? beats.filter((_, index) => index % meter === downbeatPhase) : [];
  const framesPerBar = Math.max(1, Math.round(beatSeconds * (meter || 4) / hopSeconds));
  const energyByBar: number[] = [];
  const lowByBar: number[] = [];
  const midByBar: number[] = [];
  const highByBar: number[] = [];
  const spectralFluxByBar: number[] = [];
  for (let frame = firstAudible; frame <= lastAudible; frame += framesPerBar) {
    const end = Math.min(lastAudible + 1, frame + framesPerBar);
    const segment = envelope.slice(frame, end);
    energyByBar.push(segment.reduce((sum, value) => sum + value, 0) / Math.max(1, segment.length));
    lowByBar.push(lowEnvelope.slice(frame, end).reduce((sum, value) => sum + value, 0) / Math.max(1, end - frame));
    midByBar.push(midEnvelope.slice(frame, end).reduce((sum, value) => sum + value, 0) / Math.max(1, end - frame));
    highByBar.push(highEnvelope.slice(frame, end).reduce((sum, value) => sum + value, 0) / Math.max(1, end - frame));
    const bandFlux = lowFlux.slice(frame, end).reduce((sum, value) => sum + value, 0)
      + midFlux.slice(frame, end).reduce((sum, value) => sum + value, 0)
      + highFlux.slice(frame, end).reduce((sum, value) => sum + value, 0);
    spectralFluxByBar.push(bandFlux / Math.max(1, end - frame));
  }
  const energyScale = [...energyByBar].sort((a, b) => a - b)[Math.floor(energyByBar.length * .9)] || 1;
  const lowScale = [...lowByBar].sort((a, b) => a - b)[Math.floor(lowByBar.length * .9)] || 1;
  const midScale = [...midByBar].sort((a, b) => a - b)[Math.floor(midByBar.length * .9)] || 1;
  const highScale = [...highByBar].sort((a, b) => a - b)[Math.floor(highByBar.length * .9)] || 1;
  const normalizedEnergy = energyByBar.map((value) => clamp(value / energyScale));
  const normalizedLow = lowByBar.map((value) => clamp(value / lowScale));
  const normalizedMid = midByBar.map((value) => clamp(value / midScale));
  const normalizedHigh = highByBar.map((value) => clamp(value / highScale));
  const normalizedFlux = spectralFluxByBar.map((value) => clamp(value / Math.max(.0001, (lowScale + midScale + highScale) * .12)));
  const vocalProbabilityByBar = normalizedMid.map((mid, index) => clamp(mid * .62 + normalizedEnergy[index] * .24 - normalizedLow[index] * .2 - normalizedHigh[index] * .08 + .18));
  const barNovelty = normalizedEnergy.map((energy, index) => index ? clamp(
    Math.abs(energy - normalizedEnergy[index - 1]) * .34
      + Math.abs(normalizedLow[index] - normalizedLow[index - 1]) * .24
      + Math.abs(normalizedMid[index] - normalizedMid[index - 1]) * .2
      + Math.abs(normalizedHigh[index] - normalizedHigh[index - 1]) * .12
      + normalizedFlux[index] * .1,
  ) : 0);
  const noveltyThreshold = [...barNovelty].sort((a, b) => a - b)[Math.floor(barNovelty.length * .72)] || 1;
  const phraseBars = barNovelty
    .map((novelty, index) => ({ novelty, index }))
    .filter(({ novelty, index }) => index > 0 && index < barNovelty.length - 1 && novelty >= noveltyThreshold && novelty >= barNovelty[index - 1] && novelty >= barNovelty[index + 1])
    .reduce<number[]>((selected, candidate) => {
      if (!selected.length || candidate.index - selected[selected.length - 1] >= 2) selected.push(candidate.index);
      else if (candidate.novelty > barNovelty[selected[selected.length - 1]]) selected[selected.length - 1] = candidate.index;
      return selected;
    }, []);
  const barSeconds = beatSeconds * (meter || 4);
  const phraseBoundaries = phraseBars.map((bar) => downbeats[bar] ?? effectiveStart + bar * barSeconds).filter((time) => time > effectiveStart + 1 && time < effectiveEnd - 1);
  const phraseConfidence = phraseBoundaries.length ? clamp((meterConfidence + noveltyThreshold) * .58) : 0;
  const sectionTimes = [effectiveStart, ...phraseBoundaries, effectiveEnd].filter((time, index, values) => !index || time - values[index - 1] > .5);
  const globalEnergy = normalizedEnergy.reduce((sum, value) => sum + value, 0) / Math.max(1, normalizedEnergy.length);
  const sections: TrackSection[] = sectionTimes.slice(0, -1).map((start, sectionIndex) => {
    const end = sectionTimes[sectionIndex + 1];
    const startBar = Math.max(0, Math.floor((start - effectiveStart) / barSeconds));
    const endBar = Math.max(startBar + 1, Math.min(normalizedEnergy.length, Math.ceil((end - effectiveStart) / barSeconds)));
    const mean = (values: number[]) => values.slice(startBar, endBar).reduce((sum, value) => sum + value, 0) / Math.max(1, endBar - startBar);
    const energy = mean(normalizedEnergy);
    const bassEnergy = mean(normalizedLow);
    const vocalProbability = mean(vocalProbabilityByBar);
    const trend = (normalizedEnergy[Math.min(normalizedEnergy.length - 1, endBar - 1)] || energy) - (normalizedEnergy[startBar] || energy);
    const previousEnergy = normalizedEnergy[Math.max(0, startBar - 1)] || energy;
    const label: TrackSection["label"] = sectionIndex === 0 ? "intro"
      : sectionIndex === sectionTimes.length - 2 ? "outro"
        : trend > .18 ? "build"
          : energy - previousEnergy > .2 ? "drop"
            : energy < globalEnergy * .7 ? "breakdown"
              : energy > globalEnergy * 1.08 && vocalProbability > .44 ? "chorus"
                : vocalProbability > .42 ? "verse" : "unknown";
    return { start, end, label, energy, bassEnergy, vocalProbability, confidence: clamp(.36 + Math.abs(trend) * .8 + phraseConfidence * .35) };
  });
  let peakAmplitude = 0;
  for (const channel of usableChannels) for (let index = 0; index < channel.length; index += 32) peakAmplitude = Math.max(peakAmplitude, Math.abs(channel[index]));
  const beatGridConfidence = Math.min(.78, tempoConfidence * .72 + meterConfidence * .28);
  const analysisConfidence = Math.min(.78, (tempoConfidence + meterConfidence + phraseConfidence + intro.confidence * .45 + outro.confidence * .45) / 3.5);
  const transitionLead = Math.min(32, Math.max(8, beatSeconds * 32));
  const conservativeOutTime = Math.max(effectiveStart, effectiveEnd - transitionLead);
  const safeOutTime = phraseBoundaries.filter((time) => time <= effectiveEnd - 1.5 && time >= conservativeOutTime - transitionLead).at(-1) ?? conservativeOutTime;
  const onsetScale = [...onset].sort((a, b) => a - b)[Math.floor(onset.length * .96)] || 1;
  const featureFrames: MusicFeatureFrame[] = envelope.slice(0, audibleFrames).map((value, index) => {
    const energy = clamp(value / Math.max(.0001, waveformScale));
    const flux = clamp((lowFlux[index] + midFlux[index] + highFlux[index]) / Math.max(.0001, onsetScale));
    const bass = clamp(lowEnvelope[index] / Math.max(.0001, lowScale));
    const mid = clamp(midEnvelope[index] / Math.max(.0001, midScale));
    const brightness = clamp(highEnvelope[index] / Math.max(.0001, highScale));
    const vocalProbability = clamp(mid * .62 + energy * .24 - bass * .2 - brightness * .08 + .18);
    return { time: index * hopSeconds, energy, bass, brightness, spectralFlux: flux, vocalProbability };
  });
  const frameAt = (time: number) => featureFrames[Math.max(0, Math.min(featureFrames.length - 1, Math.round(time / hopSeconds)))];
  const visualCues: VisualCue[] = beats.map((time, index) => {
    const feature = frameAt(time);
    const downbeat = Boolean(meter && index % meter === downbeatPhase);
    return { time, type: downbeat ? "downbeat" : "beat", strength: clamp(feature?.spectralFlux || .2, .18, 1), confidence: downbeat ? beatGridConfidence * .86 : beatGridConfidence, low: feature?.bass || 0, mid: feature?.energy || 0, high: feature?.brightness || 0 };
  });
  phraseBoundaries.forEach((time) => {
    const feature = frameAt(time);
    visualCues.push({ time, type: "phrase", strength: Math.max(.32, feature?.energy || 0), confidence: phraseConfidence, low: feature?.bass || 0, mid: feature?.energy || 0, high: feature?.brightness || 0 });
  });
  sections.slice(1).forEach((section) => {
    const feature = frameAt(section.start);
    const type: VisualCueType = section.label === "build" ? "build" : section.label === "breakdown" ? "breakdown" : section.label === "drop" ? "drop" : "section-enter";
    visualCues.push({ time: section.start, type, strength: clamp(Math.max(section.energy, feature?.spectralFlux || 0)), confidence: section.confidence, low: feature?.bass || 0, mid: feature?.energy || 0, high: feature?.brightness || 0 });
  });
  const dramaticCandidates = normalizedEnergy.map((energy, barIndex) => {
    const previousEnergy = normalizedEnergy[Math.max(0, barIndex - 1)] || energy;
    const jump = Math.max(0, energy - previousEnergy);
    const flux = normalizedFlux[barIndex] || 0;
    const strength = clamp(jump * 1.45 + flux * .48);
    const confidence = clamp(.38 + jump * .9 + flux * .3, 0, .92);
    return { barIndex, strength, confidence, jump };
  }).filter((candidate) => candidate.strength >= .78 && candidate.confidence >= .7)
    .sort((a, b) => b.strength * b.confidence - a.strength * a.confidence);
  const selectedDramatic: typeof dramaticCandidates = [];
  for (const candidate of dramaticCandidates) {
    if (selectedDramatic.some((selected) => Math.abs(selected.barIndex - candidate.barIndex) < 8)) continue;
    selectedDramatic.push(candidate);
    if (selectedDramatic.length === 3) break;
  }
  selectedDramatic.sort((a, b) => a.barIndex - b.barIndex).forEach((candidate) => {
    const approximateTime = effectiveStart + candidate.barIndex * barSeconds;
    const time = downbeats.reduce((nearest, beat) => Math.abs(beat - approximateTime) < Math.abs(nearest - approximateTime) ? beat : nearest, approximateTime);
    const feature = frameAt(time);
    visualCues.push({ time, type: candidate.jump >= .24 ? "drop" : "accent", strength: candidate.strength, confidence: candidate.confidence, low: feature?.bass || 0, mid: feature?.energy || 0, high: feature?.brightness || 0 });
  });
  const outroTime = Math.max(effectiveStart, effectiveEnd - Math.min(8, beatSeconds * 8));
  visualCues.push({ time: outroTime, type: "outro", strength: .45, confidence: outro.confidence * .7, low: frameAt(effectiveEnd)?.bass || 0, mid: frameAt(effectiveEnd)?.energy || 0, high: frameAt(effectiveEnd)?.brightness || 0 });
  const cuePriority: Record<VisualCueType, number> = { beat: 0, downbeat: 1, "low-transient": 2, "high-transient": 2, phrase: 3, build: 4, breakdown: 4, "section-enter": 5, outro: 5, accent: 6, drop: 7 };
  visualCues.sort((a, b) => a.time - b.time || cuePriority[a.type] - cuePriority[b.type]);
  const deduplicatedVisualCues = [...visualCues.reduce((cuesByMoment, cue) => {
    const moment = Math.round(cue.time * 25);
    const current = cuesByMoment.get(moment);
    if (!current || cuePriority[cue.type] > cuePriority[current.type]) cuesByMoment.set(moment, cue);
    return cuesByMoment;
  }, new Map<number, VisualCue>()).values()].sort((a, b) => a.time - b.time);
  const permittedDramaticCues = new Set(deduplicatedVisualCues
    .filter((cue) => ["drop", "accent", "section-enter"].includes(cue.type) && cue.strength >= .78 && cue.confidence >= .7)
    .sort((a, b) => b.strength * b.confidence - a.strength * a.confidence)
    .reduce<VisualCue[]>((selected, cue) => {
      if (selected.length < 3 && selected.every((current) => Math.abs(current.time - cue.time) >= Math.max(8, beatSeconds * 12))) selected.push(cue);
      return selected;
    }, []));
  const restrainedVisualCues = deduplicatedVisualCues.map((cue) => ["drop", "accent", "section-enter"].includes(cue.type) && cue.strength >= .78 && cue.confidence >= .7 && !permittedDramaticCues.has(cue)
    ? { ...cue, confidence: .69 }
    : cue);
  return {
    version: 3, trackId, duration, effectiveStart, effectiveEnd, sourceSignature,
    silence: { version: 1, windowSeconds, noiseFloorRms, thresholdRms, leadingSeconds, trailingSeconds, lastAudibleTime, guardSeconds, startConfidence, tailConfidence, channels: usableChannels.length },
    bpm: bestBpm, tempoConfidence, tempoStable: tempoConfidence >= .38,
    beats, downbeats, meter, beatGridConfidence, phraseBoundaries, phraseConfidence, sections, key: null, keyConfidence: 0, chromaByBar: [], integratedLufs: null,
    truePeakDb: peakAmplitude > 0 ? 20 * Math.log10(peakAmplitude) : null,
    shortTermLoudnessByBar: energyByBar.map((value) => value > 0 ? 20 * Math.log10(value) : null), energyByBar: normalizedEnergy,
    bassEnergyByBar: normalizedLow,
    vocalProbabilityByBar,
    spectralFluxByBar: normalizedFlux, safeInCues: [{ time: effectiveStart, score: .82, reason: "first audible musical frame" }],
    safeOutCues: [{ time: safeOutTime, score: Math.max(.34, phraseConfidence), reason: phraseBoundaries.includes(safeOutTime) ? "measured novelty phrase boundary before audible end" : "conservative audible outro boundary" }],
    analysisConfidence, visualCues: restrainedVisualCues, featureFrames, beatOffset, waveform, introFocus: intro.focus, outroFocus: outro.focus, introConfidence: intro.confidence, outroConfidence: outro.confidence,
  };
}

function makeCurves(strategy: TransitionStrategy, size = 64, switchPoint = .56, initialGain = .18) {
  const angle = (x: number) => Math.asin(initialGain) + (Math.PI / 2 - Math.asin(initialGain)) * smooth(x);
  if (strategy === "downbeat-cut") {
    return {
      outgoingGainCurve: curve(size, (x) => Math.cos(angle(x))),
      incomingGainCurve: curve(size, (x) => Math.sin(angle(x))),
      outgoingLowCurve: curve(size, (x) => 1 - smooth(clamp((x - .58) / .34))),
      incomingLowCurve: curve(size, (x) => smooth(clamp((x - .56) / .3))),
      outgoingMidCurve: curve(size, (x) => 1 - .18 * smooth(x)),
      incomingMidCurve: curve(size, (x) => .82 + .18 * smooth(x)),
      outgoingHighCurve: curve(size, (x) => 1 - .12 * smooth(x)),
      incomingHighCurve: curve(size, (x) => .88 + .12 * smooth(x)),
    };
  }
  if (strategy === "breakdown-bridge") {
    return {
      outgoingGainCurve: curve(size, (x) => Math.cos(angle(x))),
      incomingGainCurve: curve(size, (x) => Math.sin(angle(x))),
      outgoingLowCurve: curve(size, (x) => 1 - .72 * smooth(clamp((x - .22) / .58))),
      incomingLowCurve: curve(size, (x) => .6 + .4 * smooth(clamp((x - .35) / .5))),
      outgoingMidCurve: curve(size, (x) => 1 - .28 * smooth(x)),
      incomingMidCurve: curve(size, (x) => .84 + .16 * smooth(x)),
      outgoingHighCurve: curve(size, (x) => 1 - .2 * smooth(x)),
      incomingHighCurve: curve(size, (x) => .88 + .12 * smooth(x)),
    };
  }
  return {
    outgoingGainCurve: curve(size, (x) => Math.cos(angle(x))),
    incomingGainCurve: curve(size, (x) => Math.sin(angle(x))),
    outgoingLowCurve: curve(size, (x) => 1 - smooth(clamp((x - switchPoint + .14) / .22))),
    incomingLowCurve: curve(size, (x) => smooth(clamp((x - switchPoint + .08) / .22))),
    outgoingMidCurve: curve(size, (x) => 1 - .22 * smooth(clamp((x - .58) / .38))),
    incomingMidCurve: curve(size, (x) => .72 + .28 * smooth(clamp((x - .08) / .66))),
    outgoingHighCurve: curve(size, (x) => 1 - .16 * smooth(clamp((x - .65) / .3))),
    incomingHighCurve: curve(size, (x) => .8 + .2 * smooth(clamp(x / .72))),
  };
}

// Compare phases in wall-clock seconds, not media seconds at different rates.
// A small temporary speed correction preserves every intro sample; seeking does not.
export function beatMatchingRate(outgoing: TrackAnalysis, incoming: TrackAnalysis, outgoingTime: number, incomingTime: number, baseRate: number) {
  if (!outgoing.tempoStable || !incoming.tempoStable || outgoing.beatGridConfidence < .58 || incoming.beatGridConfidence < .58 || outgoing.bpm <= 0 || incoming.bpm <= 0) return baseRate;
  const incomingBpm = nearestTempo(incoming.bpm, outgoing.bpm);
  const beatSeconds = 60 / outgoing.bpm;
  const outCycles = (outgoingTime - outgoing.beatOffset) / beatSeconds;
  const inCycles = (incomingTime - incoming.beatOffset) / (60 / incomingBpm);
  const errorCycles = ((inCycles - outCycles + .5) % 1 + 1) % 1 - .5;
  return clamp(baseRate * (1 - clamp(errorCycles / 8, -.01, .01)), .96, 1.04);
}

export function isTrackAnalysisSourceValid(analysis: TrackAnalysis | null | undefined, trackId: string, sourceSignature: string, mediaDuration: number) {
  if (!analysis || analysis.version !== 3 || analysis.trackId !== trackId || !sourceSignature || analysis.sourceSignature !== sourceSignature) return false;
  const boundary = analysis.silence;
  if (!boundary || boundary.version !== 1 || !Number.isFinite(mediaDuration) || mediaDuration <= 0 || !Number.isFinite(analysis.duration)) return false;
  const tolerance = Math.max(.35, Math.min(1, mediaDuration * .003));
  if (Math.abs(analysis.duration - mediaDuration) > tolerance) return false;
  if (![analysis.effectiveStart, analysis.effectiveEnd, boundary.lastAudibleTime, boundary.leadingSeconds, boundary.trailingSeconds, boundary.guardSeconds, boundary.tailConfidence, boundary.startConfidence, boundary.windowSeconds, boundary.noiseFloorRms, boundary.thresholdRms, boundary.channels].every(Number.isFinite)) return false;
  if (analysis.effectiveStart < 0 || analysis.effectiveEnd > analysis.duration || analysis.effectiveEnd <= analysis.effectiveStart || boundary.lastAudibleTime < 0 || boundary.lastAudibleTime > analysis.duration) return false;
  if (boundary.guardSeconds < .1 || boundary.guardSeconds > .5 || boundary.leadingSeconds < 0 || boundary.trailingSeconds < 0 || boundary.tailConfidence < 0 || boundary.tailConfidence > 1 || boundary.startConfidence < 0 || boundary.startConfidence > 1) return false;
  if (boundary.windowSeconds <= 0 || boundary.windowSeconds > .03 || boundary.noiseFloorRms < 0 || boundary.thresholdRms < .000001 || boundary.thresholdRms > .00001 || !Number.isInteger(boundary.channels) || boundary.channels < 1 || boundary.channels > 8) return false;
  if (Math.abs(analysis.duration - boundary.lastAudibleTime - boundary.trailingSeconds) > boundary.windowSeconds + .01) return false;
  if (analysis.effectiveEnd < analysis.duration && (boundary.tailConfidence < .9 || boundary.trailingSeconds < 2.5 || Math.abs(analysis.effectiveEnd - boundary.lastAudibleTime - boundary.guardSeconds) > .03)) return false;
  if (analysis.effectiveStart > 0 && (boundary.startConfidence < .9 || Math.abs(analysis.effectiveStart - Math.max(0, boundary.leadingSeconds - .04)) > .03)) return false;
  return true;
}

export function planSilenceHandoff(outgoing: TrackAnalysis, incoming: TrackAnalysis | null, incomingTrackId: string, id = `silence-${Date.now()}`): TransitionPlan | null {
  const boundary = outgoing.silence;
  if (!boundary || boundary.version !== 1 || boundary.tailConfidence < .9 || boundary.trailingSeconds < 2.5 || outgoing.effectiveEnd >= outgoing.duration) return null;
  if (!Number.isFinite(outgoing.effectiveEnd) || !Number.isFinite(boundary.lastAudibleTime) || outgoing.effectiveEnd < boundary.lastAudibleTime || outgoing.effectiveEnd > boundary.lastAudibleTime + .5) return null;
  const transitionDuration = Math.min(.9, Math.max(.35, outgoing.effectiveEnd - outgoing.effectiveStart));
  const lastSoundFraction = clamp((boundary.lastAudibleTime - outgoing.effectiveEnd + transitionDuration) / transitionDuration, .1, .9);
  const incomingCue = incoming?.silence?.startConfidence && incoming.silence.startConfidence >= .9 ? incoming.effectiveStart : 0;
  return {
    id, strategy: "breakdown-bridge", outgoingTrackId: outgoing.trackId, incomingTrackId,
    outgoingCue: Math.max(outgoing.effectiveStart, outgoing.effectiveEnd - transitionDuration), incomingCue,
    transitionBars: 4, transitionDuration, switchPoint: .5, targetBpm: null,
    outgoingTempoRatio: 1, incomingTempoRatio: 1,
    outgoingGainCurve: curve(64, (x) => Math.cos(smooth(clamp((x - lastSoundFraction) / (1 - lastSoundFraction))) * Math.PI / 2)),
    incomingGainCurve: curve(64, (x) => .18 + .82 * Math.sin(smooth(clamp(x / .3)) * Math.PI / 2)),
    outgoingLowCurve: curve(64, () => 1), incomingLowCurve: curve(64, () => 1),
    outgoingMidCurve: curve(64, () => 1), incomingMidCurve: curve(64, () => 1),
    outgoingHighCurve: curve(64, () => 1), incomingHighCurve: curve(64, () => 1),
    confidence: boundary.tailConfidence, boundaryHandoff: true,
    reasons: ["连续近数字静音已确认，按最后有效声音交接", "尾奏结束前保持原增益；下一首只跳过已确认开头静音", "短全频原速桥接，不依赖低置信节拍或乐句"],
    fallback: "breakdown-bridge",
  };
}

function fadeAwareMixLead(analysis: TrackAnalysis) {
  // Relative dynamics INSIDE this song, not cross-song loudness or a new
  // silence boundary. Keep the entire fade/reverb playing to effectiveEnd.
  const end = analysis.effectiveEnd, start = Math.max(analysis.effectiveStart, end - 32), width = .5;
  if (end - start < 8) return 0;
  const bins = Array.from({ length: Math.ceil((end - start) / width) }, () => ({ sum: 0, count: 0 }));
  for (const frame of analysis.featureFrames || []) {
    if (!Number.isFinite(frame.time) || !Number.isFinite(frame.energy) || frame.energy < 0 || frame.energy > 1 || frame.time < start || frame.time >= end) continue;
    const bin = bins[Math.floor((frame.time - start) / width)];
    if (bin) { bin.sum += frame.energy; bin.count++; }
  }
  if (bins.filter(bin => bin.count > 0).length < bins.length * .9) return 0;
  const levels = bins.map(bin => bin.sum / Math.max(1, bin.count));
  const referenceLevels = levels.slice(0, -8).sort((a, b) => a - b);
  const reference = referenceLevels[Math.floor(referenceLevels.length * .7)] || 0;
  if (reference <= 0) return 0;
  let quietTail = 0;
  for (let index = levels.length - 1; index >= 0 && levels[index] < reference * .25; index--) quietTail += width;
  // No late sustained fade, no permission to widen a measured safe window.
  // Leave eight seconds of still-substantial music in front of that fade.
  return quietTail >= 1 ? Math.min(16, end - start, quietTail + 8) : 0;
}

export function planTransition(outgoing: TrackAnalysis, incoming: TrackAnalysis, id = `transition-${Date.now()}`): TransitionPlan {
  const incomingBpm = nearestTempo(incoming.bpm || outgoing.bpm || 96, outgoing.bpm || 96);
  const tempoRatio = outgoing.bpm > 0 && incomingBpm > 0 ? outgoing.bpm / incomingBpm : 1;
  const tempoDistance = Math.abs(tempoRatio - 1);
  const beatReliable = outgoing.tempoStable && incoming.tempoStable && outgoing.beatGridConfidence >= .58 && incoming.beatGridConfidence >= .58;
  const phraseReliable = beatReliable && outgoing.meter === 4 && incoming.meter === 4 && outgoing.phraseConfidence >= .5 && incoming.phraseConfidence >= .5;
  const vocalConflict = outgoing.outroFocus === "vocal" && incoming.introFocus === "vocal";
  const bassConflict = finalValue(outgoing.bassEnergyByBar, outgoing.outroFocus === "beats" ? .72 : .42) > .68 && (incoming.bassEnergyByBar[0] ?? (incoming.introFocus === "beats" ? .72 : .42)) > .68;
  const lowConfidence = Math.min(outgoing.analysisConfidence, incoming.analysisConfidence) < .46;
  const strategy: TransitionStrategy = phraseReliable && tempoDistance <= .04 && !vocalConflict
    ? "phrase-eq-blend"
    : vocalConflict && beatReliable && Math.min(outgoing.outroConfidence, incoming.introConfidence) >= .6
      ? "downbeat-cut"
      : "breakdown-bridge";
  // The outgoing deck stays at 1x. Matching a midpoint tempo would drift against it.
  const targetBpm = strategy === "phrase-eq-blend" ? outgoing.bpm : null;
  const incomingTempoRatio = targetBpm ? clamp(targetBpm / incomingBpm, .96, 1.04) : 1;
  const outgoingTempoRatio = 1;
  const beatSeconds = 60 / Math.max(1, targetBpm || outgoing.bpm || 96);
  const cueAvailable = Math.max(0, outgoing.effectiveEnd - Math.max(outgoing.effectiveStart, reliableCue(outgoing.safeOutCues, outgoing.effectiveEnd - 12)));
  const fadeLead = strategy === "breakdown-bridge" ? fadeAwareMixLead(outgoing) : 0;
  const available = Math.max(cueAvailable, fadeLead);
  const requestedBars: Array<4 | 8 | 16 | 32> = strategy === "phrase-eq-blend" ? [16, 8, 4] : strategy === "breakdown-bridge" ? [8, 4] : [4];
  const transitionBars = requestedBars.find((bars) => bars * 4 * beatSeconds <= available + .35) || 4;
  const musicalDuration = transitionBars * 4 * beatSeconds;
  const requestedDuration = strategy === "downbeat-cut"
    ? clamp(beatSeconds * (vocalConflict ? 2 : 4), .35, 2.6)
    : clamp(Math.min(musicalDuration, available), strategy === "phrase-eq-blend" ? 7.5 : 5.5, strategy === "phrase-eq-blend" ? 28 : 18);
  // Only remove measured leading silence. Musical intros remain audible.
  const incomingCue = incoming.version >= 3
    ? incoming.silence?.startConfidence && incoming.silence.startConfidence >= .9 ? incoming.effectiveStart : 0
    : clamp(reliableCue(incoming.safeInCues, incoming.effectiveStart), incoming.effectiveStart, Math.min(incoming.effectiveEnd - .2, incoming.effectiveStart + 1.25));
  // Preferred mix lengths cannot expand the measured safe outro. Short incoming
  // tracks must also survive the mix and its existing settling phase.
  const incomingAvailable = Math.max(0, (incoming.effectiveEnd - incomingCue) / incomingTempoRatio - transitionSettlingDuration(strategy) - .2);
  let transitionDuration = Math.min(requestedDuration, available, incomingAvailable);
  let outgoingCue = Math.max(outgoing.effectiveStart, outgoing.effectiveEnd - transitionDuration);
  let switchPoint = strategy === "phrase-eq-blend" ? .56 : strategy === "downbeat-cut" ? .5 : .62;
  if (strategy === "phrase-eq-blend") {
    // Launch the intact intro so its first measured downbeat lands on an outgoing
    // downbeat. Move only forwards inside the safe window; never skip intro music.
    const firstDownbeat = incoming.downbeats.find((time) => time >= incomingCue);
    const delay = firstDownbeat === undefined ? null : (firstDownbeat - incomingCue) / incomingTempoRatio;
    const launch = delay !== null && delay <= beatSeconds * 4
      ? outgoing.downbeats.map((time) => time - delay).find((time) => time >= outgoingCue && outgoing.effectiveEnd - time >= Math.min(4, transitionDuration))
      : undefined;
    if (launch !== undefined) {
      outgoingCue = launch;
      transitionDuration = outgoing.effectiveEnd - outgoingCue;
      const exchangeBeat = outgoing.downbeats.filter((time) => time >= outgoingCue + transitionDuration * .35 && time <= outgoingCue + transitionDuration * .75)
        .sort((a, b) => Math.abs(a - outgoingCue - transitionDuration * .56) - Math.abs(b - outgoingCue - transitionDuration * .56))[0];
      if (exchangeBeat !== undefined) switchPoint = (exchangeBeat - outgoingCue) / transitionDuration;
    }
  }
  const confidence = clamp((outgoing.analysisConfidence + incoming.analysisConfidence + outgoing.beatGridConfidence + incoming.beatGridConfidence) / 4 - (vocalConflict ? .08 : 0) - (bassConflict ? .06 : 0) - tempoDistance);
  const reasons = [
    strategy === "phrase-eq-blend" ? "可靠的四拍 beat grid 与乐句边界" : strategy === "downbeat-cut" ? "潜在人声重叠，使用可靠拍点短交接" : "原速渐进融合，不因速度差异直接硬切",
    tempoDistance <= .04 ? `BPM 差异 ${(tempoDistance * 100).toFixed(1)}%，只轻调 incoming` : "保留原速，避免明显拉伸",
    vocalConflict ? "检测到双人声风险" : "未检测到明显双人声冲突",
    bassConflict ? "低频交换在 switch point 完成" : "低频重叠风险较低",
    lowConfidence ? "分析置信度较低，使用保守方案" : "分析置信度足以执行所选策略",
    ...(fadeLead > cueAvailable ? ["根据本曲末端持续渐弱提前叠入，尾奏和混响仍播放至有效结束"] : []),
  ];
  return {
    id, strategy, outgoingTrackId: outgoing.trackId, incomingTrackId: incoming.trackId,
    outgoingCue, incomingCue, transitionBars, transitionDuration,
    switchPoint,
    targetBpm, outgoingTempoRatio, incomingTempoRatio,
    ...makeCurves(strategy, 64, switchPoint, strategy === "breakdown-bridge" ? .26 : .18), confidence, reasons,
    fallback: beatReliable && !lowConfidence ? "downbeat-cut" : "breakdown-bridge",
  };
}

export function isTransitionPlanUsable(plan: TransitionPlan, outgoingTrackId: string, incomingTrackId: string) {
  return plan.outgoingTrackId === outgoingTrackId && plan.incomingTrackId === incomingTrackId && plan.transitionDuration > 0 && plan.confidence >= .18;
}
