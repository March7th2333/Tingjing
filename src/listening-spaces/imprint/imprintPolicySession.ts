import {
  ImprintTimeline,
  type ImprintTrack,
} from "./imprintTimeline.ts";

export interface ImprintPolicyPlan {
  fingerprint: string;
  track: ImprintTrack;
  timeline: ImprintTimeline;
}

interface ImprintPolicySession {
  committed: ImprintPolicyPlan;
  pending?: ImprintPolicyPlan;
  pendingCommitAtMs?: number;
}

const sessions = new Map<string, ImprintPolicySession>();
const sessionLimit = 12;
const boundaryProbeLimits = { historyLimit: 0 } as const;

function lyricScaffold(plan: ImprintPolicyPlan) {
  return JSON.stringify(plan.track.lyrics.map((line) => [
    line.sourceIndex,
    line.text,
    line.startMs,
  ]));
}

function isPrecisionRegression(
  candidate: ImprintPolicyPlan,
  reference: ImprintPolicyPlan,
) {
  return candidate.track.lyricsStatus === "ready"
    && reference.track.lyricsStatus === "ready"
    && lyricScaffold(candidate) === lyricScaffold(reference)
    && candidate.timeline.analysis.exactLineCount
      < reference.timeline.analysis.exactLineCount;
}

function trimSessions() {
  while (sessions.size > sessionLimit) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) return;
    sessions.delete(oldest);
  }
}

function lineBoundaryForUpdate(
  committed: ImprintPolicyPlan,
  candidate: ImprintPolicyPlan,
  positionMs: number,
) {
  const committedFrame = committed.timeline.derive(
    positionMs,
    boundaryProbeLimits,
  );
  const frame = committedFrame.activeLine
    ? committedFrame
    : candidate.timeline.derive(positionMs, boundaryProbeLimits);
  if (!frame.activeLine) return undefined;
  // An update arriving on the first compositor frame of a line is already at a
  // safe typesetting boundary. Otherwise the existing line owns the plate
  // until its full interval completes.
  if (positionMs - frame.activeLine.startMs <= 24) return undefined;
  return frame.activeLine.endMs;
}

export function createImprintPolicyPlan(
  track: ImprintTrack,
  fingerprint: string,
): ImprintPolicyPlan {
  return {
    fingerprint,
    track,
    timeline: new ImprintTimeline(track),
  };
}

export function stageImprintPolicyPlan(
  sessionId: string,
  candidate: ImprintPolicyPlan,
  positionMs: number,
) {
  const current = sessions.get(sessionId);
  if (!current || current.committed.track.id !== candidate.track.id) {
    sessions.set(sessionId, { committed: candidate });
    trimSessions();
    return candidate;
  }

  if (current.committed.fingerprint === candidate.fingerprint) {
    if (current.pending && isPrecisionRegression(candidate, current.pending)) {
      return current.committed;
    }
    current.pending = undefined;
    current.pendingCommitAtMs = undefined;
    return current.committed;
  }
  if (current.pending?.fingerprint === candidate.fingerprint) {
    const boundary = current.pendingCommitAtMs;
    // A listening space can unmount while playback keeps advancing. When the
    // same pending plan is staged after remount, commit it if the safe line
    // boundary has already passed instead of leaving the old visual policy
    // locked for the rest of the session.
    if (positionMs <= 150 || (boundary !== undefined && positionMs >= boundary)) {
      current.committed = current.pending;
      current.pending = undefined;
      current.pendingCommitAtMs = undefined;
      return current.committed;
    }
    return current.committed;
  }

  // Never replace usable lyrics with a transient loading shell for the same
  // request. Provider updates are monotonic in normal playback, but this guard
  // also prevents an out-of-order event from blanking the active plate.
  if (
    current.committed.track.lyricsStatus === "ready"
    && candidate.track.lyricsStatus === "loading"
  ) {
    return current.committed;
  }
  if (
    isPrecisionRegression(candidate, current.committed)
    || (current.pending && isPrecisionRegression(candidate, current.pending))
  ) {
    return current.committed;
  }

  const commitAtMs = lineBoundaryForUpdate(
    current.committed,
    candidate,
    positionMs,
  );
  if (commitAtMs === undefined) {
    current.committed = candidate;
    current.pending = undefined;
    current.pendingCommitAtMs = undefined;
    return candidate;
  }

  current.pending = candidate;
  current.pendingCommitAtMs = commitAtMs;
  return current.committed;
}

export function readImprintPolicyPlan(sessionId: string) {
  return sessions.get(sessionId)?.committed;
}

export function commitPendingImprintPolicyPlan(
  sessionId: string,
  positionMs: number,
  previousPositionMs: number,
  allowSeekCommit = false,
) {
  const session = sessions.get(sessionId);
  if (!session?.pending) return undefined;

  const boundary = session.pendingCommitAtMs;
  const restarted = positionMs <= 150 && previousPositionMs > 150;
  const seekedToSafePosition = allowSeekCommit
    && (
      positionMs <= 150
      || (boundary !== undefined && positionMs >= boundary)
    );
  const crossedBoundary = boundary !== undefined
    && previousPositionMs < boundary
    && positionMs >= boundary;
  if (!restarted && !seekedToSafePosition && !crossedBoundary) return undefined;

  session.committed = session.pending;
  session.pending = undefined;
  session.pendingCommitAtMs = undefined;
  return session.committed;
}

export function clearImprintPolicySessionsForTests() {
  sessions.clear();
}
