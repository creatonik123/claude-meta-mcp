/**
 * The bounded wait for Meta to finish processing an uploaded video.
 *
 * An uploaded video is NOT usable in a creative until Meta has transcoded it; a creative built on a
 * still-processing video is rejected. So one — and only one — place in the publish path is allowed to
 * wait, and this is it. It lives outside meta-publisher.ts on purpose: that module is asserted to
 * contain no loop at all, because a loop there is how one approval becomes two live ads.
 *
 * The bound is total: at most `attempts` polls, `delayMs` apart, and then it refuses. A poll is a READ,
 * so nothing here can create or spend anything, and a refusal leaves the approval unconsumed for the
 * next run to resolve through the ad name's natural key.
 *
 * `sleep` is injected so tests exercise the real bound instantly and make no network call.
 */

export interface ReadyGraph {
  get(path: string): Promise<Record<string, unknown>>;
}

export interface WaitOptions {
  attempts?: number;
  delayMs?: number;
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function videoStatusOf(res: unknown): string {
  const status = (res as { status?: { video_status?: unknown } } | null)?.status;
  const v = status && typeof status === "object" ? (status as { video_status?: unknown }).video_status : undefined;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/**
 * Resolves once Meta reports the video ready. Throws `video_not_ready` when Meta reports an error
 * status, or when the attempt budget runs out — an unreadable or never-finishing video must refuse
 * rather than be pushed into a creative.
 */
export async function waitUntilReady(
  graph: ReadyGraph,
  videoId: string,
  opts: WaitOptions = {}
): Promise<void> {
  const id = typeof videoId === "string" ? videoId.trim() : "";
  if (id === "") throw new Error("video_not_ready: no video id to poll — refusing to build a creative");
  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 3000;
  const sleep = opts.sleep ?? defaultSleep;

  let last = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    const res = await graph.get(`/${id}?fields=status`);
    last = videoStatusOf(res);
    if (last === "ready") return;
    if (last === "error") {
      throw new Error(`video_not_ready: Meta reported an error processing video ${id} — refusing to build a creative`);
    }
  }
  throw new Error(
    `video_not_ready: video ${id} was still '${last || "unknown"}' after ${attempts} checks — refusing to build a creative`
  );
}
