/**
 * Fuzzy matching for the command bar.
 *
 * Subsequence match, scored so that the results a user expects come first:
 * prefix beats a word start, a word start beats an inner match, and closer
 * letters beat scattered ones. Ties fall back to the shorter label.
 *
 * Pure: no DOM, no command table, so it can be tested on its own.
 */

export interface Matchable {
  readonly id: string;
  readonly label: string;
}

export interface Scored<T> {
  readonly item: T;
  /** Higher is better; only meaningful within one query. */
  readonly score: number;
  /** Indices in `label` that matched, for highlighting. */
  readonly hits: readonly number[];
}

const PREFIX_BONUS = 1000;
const WORD_START_BONUS = 160;
const BASE = 10;
/** Penalty per skipped character; smaller than a word-start bonus so structure wins over length. */
const GAP_PENALTY = 1;
/** Small penalty for long labels, so "Redo" beats "Rectangle" when the query is just "re". */
const LENGTH_PENALTY = 10;

/** True when every character of `query` appears in `text`, in order. */
export function isSubsequence(query: string, text: string): boolean {
  if (query.length === 0) return true;
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return false;
}

/**
 * Score one candidate. Returns `null` when it does not match at all.
 * An empty query matches everything with score 0, which is the browse case.
 */
export function scoreMatch(query: string, item: Matchable): Scored<Matchable> | null {
  const q = query.trim().toLowerCase();
  if (q === "") return { item, score: 0, hits: [] };

  const label = item.label.toLowerCase();
  const id = item.id.toLowerCase();

  const labelMatch = matchIn(q, label);
  if (labelMatch) {
    return {
      item,
      score: labelMatch.score + (label.startsWith(q) ? PREFIX_BONUS : 0),
      hits: labelMatch.hits,
    };
  }
  // Fall back to the id, e.g. "rld" never matches but "pu" should still find pushpull.
  const idMatch = matchIn(q, id);
  if (idMatch) return { item, score: idMatch.score - 1, hits: [] };
  return null;
}

function matchIn(query: string, text: string): { score: number; hits: number[] } | null {
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at === -1) return null;
    const atWordStart = at === 0 || /[\s/_-]/.test(text[at - 1]!);
    const adjacent = at === previous + 1;
    score += BASE;
    if (atWordStart) score += WORD_START_BONUS;
    if (adjacent) score += BASE;
    else if (at > previous + 1) score -= GAP_PENALTY * (at - previous - 1);
    hits.push(at);
    previous = at;
    from = at + 1;
  }
  score -= Math.floor((text.length * LENGTH_PENALTY) / 10);
  return { score, hits };
}

/** All matches, best first. Stable: equal scores keep the input order. */
export function rank<T extends Matchable>(query: string, items: readonly T[], limit = 8): Scored<T>[] {
  const scored: Scored<T>[] = [];
  for (const item of items) {
    const hit = scoreMatch(query, item);
    if (hit) scored.push(hit as Scored<T>);
  }
  scored.sort((a, b) => b.score - a.score || a.item.label.length - b.item.label.length);
  return scored.slice(0, limit);
}
