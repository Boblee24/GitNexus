import { useEffect, useRef, useState } from 'react';
import {
  BackendError,
  fetchAnalyzeJobs,
  getAnalyzeStatus,
  type ActiveAnalyzeJob,
} from '../services/backend-client';

/** `GET /api/analyze` allows 60 requests/min per IP; 3s is 20/min for the visible tab. */
export const ACTIVE_ANALYZE_POLL_MS = 3_000;

/** Pause after a 429 that carries no Retry-After: the limiter's window length. */
const RATE_LIMIT_FALLBACK_MS = 60_000;

/**
 * Poll the server's running analyze jobs while `enabled` (#1584).
 *
 * `readyRepoIds` marks repos whose newest analysis, since polling first ran,
 * completed. Outcomes come from two places: jobs this tab saw running and then
 * looked up, and the server's newest finished job per repo, which also covers
 * a job that started and ended between polls or while the switcher was closed.
 * State survives `enabled` toggling (the dropdown closing).
 */
export function useActiveAnalyzeJobs(enabled: boolean, onJobComplete?: () => void) {
  const [jobs, setJobs] = useState<ActiveAnalyzeJob[]>([]);
  const [readyRepoIds, setReadyRepoIds] = useState<string[]>([]);
  const onJobCompleteRef = useRef(onJobComplete);
  onJobCompleteRef.current = onJobComplete;
  const seenRef = useRef<ActiveAnalyzeJob[]>([]);
  // Jobs that left the list but whose outcome lookup failed; retried next poll.
  const unconfirmedRef = useRef<ActiveAnalyzeJob[]>([]);
  const pausedUntilRef = useRef(0);
  // Per repo, the newest job whose outcome has been applied. A result from an
  // older job (a retried lookup landing late) can't overwrite it, and the same
  // job's outcome is applied only once.
  const appliedRef = useRef(new Map<string, { jobId: string; startedAt: number }>());
  // The first snapshot's outcomes are a baseline: analyses that finished
  // before polling began don't mark repos Ready.
  const baselineTakenRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;

    const applyOutcome = (
      repoId: string | undefined,
      jobId: string,
      startedAt: number,
      complete: boolean,
    ) => {
      const shown = repoId ? appliedRef.current.get(repoId) : undefined;
      if (shown?.jobId === jobId) return; // already applied
      if (complete) onJobCompleteRef.current?.(); // any newly seen completion refreshes repos
      if (!repoId || (shown && startedAt < shown.startedAt)) return;
      appliedRef.current.set(repoId, { jobId, startedAt });
      // A failed or cancelled newest run clears an earlier Ready.
      setReadyRepoIds((ids) =>
        complete
          ? ids.includes(repoId)
            ? ids
            : [...ids, repoId]
          : ids.filter((id) => id !== repoId),
      );
    };

    const poll = async () => {
      // Background tabs skip polling so several open tabs stay under the route's
      // per-IP limit; the visible tab catches up on its next tick.
      if (inFlight || document.hidden || Date.now() < pausedUntilRef.current) return;
      inFlight = true;
      try {
        const snapshot = await fetchAnalyzeJobs().catch((err) => {
          // On a 429, wait out the server's Retry-After instead of polling into
          // the limit again; the first poll after it refreshes the state.
          if (err instanceof BackendError && err.code === 'rate_limited') {
            pausedUntilRef.current = Date.now() + (err.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS);
          }
          return null;
        });
        if (cancelled || !snapshot) return;
        const current = snapshot.jobs;
        for (const outcome of snapshot.latest) {
          if (baselineTakenRef.current) {
            const { repoId, jobId, startedAt, status } = outcome;
            applyOutcome(repoId, jobId, startedAt, status === 'complete');
          } else {
            appliedRef.current.set(outcome.repoId, {
              jobId: outcome.jobId,
              startedAt: outcome.startedAt,
            });
          }
        }
        baselineTakenRef.current = true;
        const finished = [
          ...unconfirmedRef.current,
          ...seenRef.current.filter((job) => !current.some((c) => c.id === job.id)),
        ];
        seenRef.current = current;
        unconfirmedRef.current = [];
        setJobs(current);
        // A job that left the list either completed or failed; look it up in
        // case the server's snapshot can't place it (no repo ID yet).
        for (const [index, job] of finished.entries()) {
          // Closed mid-loop: keep the rest for the next time polling starts.
          if (cancelled) {
            unconfirmedRef.current.push(...finished.slice(index));
            return;
          }
          let final;
          try {
            final = await getAnalyzeStatus(job.id);
          } catch (err) {
            // A 404 means the job is gone (TTL sweep or server restart): drop it.
            if (!(err instanceof BackendError && err.code === 'not_found')) {
              unconfirmedRef.current.push(job);
            }
            continue;
          }
          const repoId = final.repoId ?? job.repoId;
          applyOutcome(repoId, job.id, job.startedAt, final.status === 'complete');
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), ACTIVE_ANALYZE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setJobs([]);
    };
  }, [enabled]);

  return { jobs, readyRepoIds };
}
