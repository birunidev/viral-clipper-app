/**
 * TimelineMapper — canonical source ⇄ output mapping after removals.
 * All A/V sync (captions, camera, zoom, audio) must go through this.
 * Electron only — no backend/web mirror.
 */
export type Removal = { start: number; end: number; type?: string };

export class TimelineMapper {
  private removals: Removal[];
  private prefix: number[]; // cumulative removed before each removal
  private total: number;

  constructor(removals: Removal[] = []) {
    this.removals = [...removals]
      .filter((r) => r.end > r.start && r.start >= 0)
      .sort((a, b) => a.start - b.start);
    // merge overlaps (same as editPlan normalizeRemovals)
    const merged: Removal[] = [];
    for (const r of this.removals) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    this.removals = merged;
    this.prefix = [];
    let acc = 0;
    for (let i = 0; i < this.removals.length; i++) {
      this.prefix.push(acc);
      acc += this.removals[i].end - this.removals[i].start;
    }
    this.total = acc;
  }

  /** Total removed duration */
  totalRemoved(): number {
    return this.total;
  }

  /** Output duration given source duration */
  outputDuration(sourceDuration: number): number {
    return Math.max(0, sourceDuration - this.total);
  }

  /** Is source time inside a removal (gap)? */
  isRemoved(t: number): boolean {
    for (const r of this.removals) {
      if (t >= r.start && t < r.end) return true;
      if (t < r.start) break;
    }
    return false;
  }

  /** source → output (null if inside removal) */
  sourceToOutput(t: number): number | null {
    if (this.isRemoved(t)) return null;
    let removedBefore = 0;
    for (const r of this.removals) {
      if (t < r.start) break;
      if (t >= r.end) removedBefore += r.end - r.start;
    }
    return t - removedBefore;
  }

  /** output → source */
  outputToSource(tPrime: number): number {
    // invert: find segment where output falls
    let acc = 0;
    let lastEnd = 0;
    for (const r of this.removals) {
      const gap = r.end - r.start;
      const outStart = r.start - acc;
      const outEnd = outStart; // removal collapses to point in output
      if (tPrime < outStart) return tPrime + acc;
      acc += gap;
      lastEnd = r.end;
      void outEnd;
    }
    return tPrime + acc;
  }

  /** Filter words that fall inside removals and re-anchor to output timeline (clip-relative) */
  mapWords<T extends { start_ms: number; end_ms: number }>(words: T[]): T[] {
    const out: T[] = [];
    for (const w of words) {
      const sSec = w.start_ms / 1000;
      const eSec = w.end_ms / 1000;
      // if word overlaps removal, drop (spec: no blind filler keep)
      // We drop if start inside removal; words spanning a cut are clipped to remaining part.
      const sOut = this.sourceToOutput(sSec);
      const eOut = this.sourceToOutput(eSec);
      if (sOut === null && eOut === null) continue;
      // If partially inside, map start to next valid (end of removal)
      const mappedStart = sOut ?? this.sourceToOutput((this.removals.find((r) => sSec >= r.start && sSec < r.end)?.end ?? sSec)) ?? 0;
      const mappedEnd = eOut ?? mappedStart + (eSec - sSec);
      out.push({
        ...w,
        start_ms: Math.round(mappedStart * 1000),
        end_ms: Math.round(mappedEnd * 1000),
      });
    }
    return out;
  }

  /** Shift camera/visual events */
  mapEvents<T extends { time: number }>(events: T[]): T[] {
    return events
      .map((e) => {
        const out = this.sourceToOutput(e.time);
        if (out === null) return null;
        return { ...e, time: out };
      })
      .filter((e): e is T => e !== null)
      .sort((a, b) => a.time - b.time);
  }
}
