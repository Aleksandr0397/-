import type { RosskoOffer } from "./rossko";

export type RosskoSearchResult = { offers: RosskoOffer[]; checkedAt: string; query: string; supplierName: string };
export type RosskoSearchState = { phase: "idle" | "waiting" | "searching" | "success" | "error"; query: string; result: RosskoSearchResult | null; error: string };
type Input = { supplierId: string; query: string };
type Options = {
  request: (input: Input, signal: AbortSignal) => Promise<RosskoSearchResult>;
  changed: (state: RosskoSearchState) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

// One input drives both automatic and explicit searches. Superseded requests
// cannot replace newer offers; typing never bypasses the supplier rate guard.
export function createRosskoSearchController(options: Options) {
  const now = options.now ?? Date.now, setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null, controller: AbortController | null = null;
  let generation = 0, lastStarted: number | null = null, disposed = false, activeKey = "", phase: RosskoSearchState["phase"] = "idle";
  let cached: { key: string; at: number; result: RosskoSearchResult } | null = null;
  function cancel() {
    generation++; if (timer !== null) clearTimer(timer); timer = null;
    controller?.abort(); controller = null; activeKey = "";
  }
  function emit(next: RosskoSearchState["phase"], query: string, result: RosskoSearchResult | null = null, error = "") {
    phase = next; options.changed({ phase, query, result, error });
  }
  const remaining = () => lastStarted === null ? 0 : Math.max(0, 3200 - (now() - lastStarted));
  function queue(input: Input, immediate = false, force = false) {
    if (disposed) return;
    const query = input.query.trim();
    if (!input.supplierId || query.length < 2) { cancel(); emit("idle", query); return; }
    if (query.length > 160) { cancel(); emit("error", query, null, "Артикул или запрос должен содержать не больше 160 символов."); return; }
    const key = input.supplierId + "\0" + query.toLocaleLowerCase("ru");
    if (activeKey === key && (phase === "searching" || phase === "waiting" && !immediate || phase === "error" && !force)) return;
    cancel(); activeKey = key;
    if (!force && cached?.key === key && now() - cached.at < 30000) { emit("success", query, cached.result); return; }
    const token = generation; emit("waiting", query);
    timer = setTimer(() => {
      timer = null; if (disposed || token !== generation) return;
      lastStarted = now(); const current = new AbortController(); controller = current; emit("searching", query);
      void options.request({ supplierId: input.supplierId, query }, current.signal).then(result => {
        if (disposed || token !== generation || current.signal.aborted) return;
        cached = { key, at: now(), result }; emit("success", query, result);
      }).catch(error => {
        if (disposed || token !== generation || current.signal.aborted) return;
        emit("error", query, null, error instanceof Error ? error.message : "Не удалось получить предложения поставщика.");
      }).finally(() => { if (token === generation) controller = null; });
    }, Math.max(immediate ? 0 : 750, remaining()));
  }
  return {
    queue, remaining,
    recordRequest() { lastStarted = now(); },
    reset() { if (!disposed) { cancel(); cached = null; emit("idle", ""); } },
    dispose() { disposed = true; cancel(); cached = null; },
  };
}
