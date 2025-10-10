// rewardsAuto.tsx
// All-in-one: auto-poke resolve on expiry, live event syncing for Expired/Replaced/Nuked,
// fast claimable scanning pinned to the current block tip, and one-click "Claim all".
// Adds:
//  - Error sanitization (no huge raw messages)
//  - Header toggle to mount/unmount the rewards panel (+ optional auto-claim)

import * as React from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";
import type { Address } from "viem";
import { GAME, GAME_ABI } from "./abi";

/* ----------------------------- small utilities ----------------------------- */

function useRewardsToggle(): [boolean, () => void] {
  // Read new key, fall back to legacy key ("meowt:rewards:on")
  const readLS = () => {
    try {
      const v = localStorage.getItem("meowt:rewards:enabled");
      if (v != null) return v === "1" || v === "true";
      const legacy = localStorage.getItem("meowt:rewards:on");
      return legacy === "1" || legacy === "true";
    } catch {
      return false;
    }
  };

  const [enabled, setEnabled] = React.useState<boolean>(readLS);

  React.useEffect(() => {
    // One-time upgrade: if only legacy key existed, mirror it into the new key
    try {
      const newKey = localStorage.getItem("meowt:rewards:enabled");
      if (newKey == null) {
        const legacy = localStorage.getItem("meowt:rewards:on");
        if (legacy != null) {
          localStorage.setItem("meowt:rewards:enabled", legacy);
        }
      }
    } catch {}
  }, []);

  React.useEffect(() => {
    const onToggle = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "boolean") setEnabled(detail);
    };
    window.addEventListener("meowt:rewards-toggle", onToggle as any);
    return () => window.removeEventListener("meowt:rewards-toggle", onToggle as any);
  }, []);

  const toggle = React.useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    try {
      const v = next ? "1" : "0";
      localStorage.setItem("meowt:rewards:enabled", v);
      localStorage.setItem("meowt:rewards:on", v);
      // 👇 NEW: tell other components in the same tab
      window.dispatchEvent(new CustomEvent("meowt:rewards-toggle", { detail: next }));
    } catch {}
  }, [enabled]);

  return [enabled, toggle];
}

/** Header button that only shows when a wallet is connected */
export function RewardsHeaderButton() {
  const { status, address } = useAccount();
  const connected = status === "connected" && !!address;
  const [enabled, toggle] = useRewardsToggle();

  if (!connected) return null;

  return (
    <button
      onClick={toggle}
      className="px-3 py-1.5 rounded-md text-sm font-semibold border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10 transition inline-flex items-center gap-2"
      title={enabled ? "Hide rewards panel" : "Show rewards panel"}
    >
      <span>🎁</span>
      <span className="hidden sm:inline">Rewards</span>
      <span className="sm:hidden">Rewards</span>
      {enabled ? (
        <span className="ml-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />
      ) : null}
    </button>
  );
}

/** Dock under the header — mounts only when enabled *and* connected */
export function RewardsDock() {
  const { status, address } = useAccount();
  const connected = status === "connected" && !!address;
  const [enabled] = useRewardsToggle();

  if (!enabled || !connected) return null;

  return (
    <div className="w-full flex justify-center mt-2 md:mt-3">
      <div className="max-w-3xl w-full px-3">
        <RewardsMenu />
      </div>
    </div>
  );
}


/* ======================= Static Rewards Menu ======================= */
type RewardRow = { id: bigint; amount: bigint; voted: 1 | 2 };

function fmtMEOW(x?: bigint) {
  return typeof x === "bigint" ? Number(x) / 1e18 : 0;
}
function two(n?: number) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—";
}

async function findClaimablesSnapshot(
  publicClient: any,
  who: Address,
  depth = 300,
  concurrency = 8
): Promise<bigint[]> {
  async function getLastId(pc: any): Promise<bigint> {
    const next = (await pc.readContract({
      address: GAME as Address,
      abi: GAME_ABI,
      functionName: "nextMessageId",
    })) as bigint;
    return next > 0n ? next - 1n : 0n;
  }
  async function sim(pc: any, id: bigint): Promise<boolean> {
    try {
      await pc.simulateContract({
        address: GAME as Address,
        abi: GAME_ABI,
        functionName: "claim",
        args: [id],
        account: who,
        blockTag: "pending",
      });
      return true;
    } catch {
      return false;
    }
  }
  const last = await getLastId(publicClient);
  if (last <= 0n) return [];
  const start = last;
  const end = last > BigInt(depth) ? last - BigInt(depth) + 1n : 1n;
  const ids: bigint[] = [];
  for (let id = start; id >= end; id--) ids.push(id);
  const out: bigint[] = [];
  let i = 0;
  const workers = new Array(Math.min(concurrency, ids.length)).fill(0).map(
    async () => {
      while (i < ids.length) {
        const idx = i++;
        const id = ids[idx];
        if (await sim(publicClient, id)) out.push(id);
      }
    }
  );
  await Promise.all(workers);
  out.sort((a, b) => (a > b ? -1 : 1));
  return out;
}

async function enrichRows(
  publicClient: any,
  who: Address,
  ids: bigint[]
): Promise<RewardRow[]> {
  const rows: RewardRow[] = [];
  for (const id of ids) {
    try {
      const [m, voteSide] = await Promise.all([
        publicClient.readContract({
          address: GAME as Address,
          abi: GAME_ABI,
          functionName: "messages",
          args: [id],
          blockTag: "pending",
        }) as Promise<any>,
        publicClient.readContract({
          address: GAME as Address,
          abi: GAME_ABI,
          functionName: "voteOf",
          args: [id, who],
          blockTag: "pending",
        }) as Promise<bigint>,
      ]);
      const share: bigint = (m?.sharePerVote ?? m?.[13] ?? 0n) as bigint;
      if (share <= 0n) continue;
      const voted = Number(voteSide ?? 0n) === 2 ? 2 : 1;
      rows.push({ id, amount: share, voted: voted as 1 | 2 });
    } catch {
      /* ignore */
    }
  }
  return rows;
}

function RewardsMenu() {
  const { status, address } = useAccount();
  const isConnected = status === "connected" && !!address;
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [items, setItems] = React.useState<RewardRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busyAll, setBusyAll] = React.useState(false);
  const [toast, setToast] = React.useState("");

  async function scanOnce() {
    if (!publicClient || !isConnected) return;
    setLoading(true);
    try {
      const ids = await findClaimablesSnapshot(
        publicClient,
        address as Address,
        300,
        8
      );
      const rows = await enrichRows(publicClient, address as Address, ids);
      setItems(rows);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    scanOnce();
  }, []);

  async function claimOne(id: bigint) {
    if (!publicClient || !address) return;
    try {
      try {
        await publicClient.simulateContract({
          address: GAME as Address,
          abi: GAME_ABI,
          functionName: "claim",
          args: [id],
          account: address as Address,
          blockTag: "pending",
        });
      } catch {
        setToast("Already claimed or not claimable.");
        setTimeout(() => setToast(""), 1400);
        return;
      }
      const hash = await writeContractAsync({
        address: GAME as Address,
        abi: GAME_ABI,
        functionName: "claim",
        args: [id],
      });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status === "success") {
        setItems((prev) => prev.filter((x) => x.id !== id));
      } else {
        setToast("Claim failed on chain.");
        setTimeout(() => setToast(""), 1400);
      }
    } catch (e: any) {
      setToast(String(e?.shortMessage || e?.message || "Claim failed."));
      setTimeout(() => setToast(""), 1600);
    }
  }

  async function claimAll() {
    if (!publicClient || items.length === 0) return;
    setBusyAll(true);
    try {
      for (const it of [...items]) {
        try {
          await claimOne(it.id);
        } catch {}
      }
    } finally {
      setBusyAll(false);
    }
  }

  return (
    <div className="rounded-2xl p-3 md:p-4 bg-emerald-50/80 dark:bg-emerald-900/20 ring-1 ring-emerald-300/50 dark:ring-emerald-700/40 shadow-sm backdrop-blur">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold">Pending rewards</div>
        <div className="flex items-center gap-2">
          <button
            onClick={scanOnce}
            className="px-2 py-1 rounded-md text-xs font-semibold border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10"
            disabled={loading || busyAll}
          >
            Refresh
          </button>
          <button
            onClick={claimAll}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
            disabled={busyAll || items.length === 0}
          >
            {busyAll ? "Claiming…" : "Claim all"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-xs opacity-70">Scanning…</div>
      ) : items.length === 0 ? (
        <div className="text-sm">No rewards found.</div>
      ) : (
        <ul className="divide-y divide-black/10 dark:divide-white/10">
          {items.map((it) => (
            <li
              key={String(it.id)}
              className="py-2 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <div className="text-base font-bold">
                  {two(fmtMEOW(it.amount))} MEOWT
                </div>
                <div className="text-xs opacity-80">
                  You voted {it.voted === 1 ? "😺" : "😾"}
                </div>
              </div>
              <div>
                <button
                  onClick={() => claimOne(it.id)}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Claim
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {toast ? <div className="mt-2 text-xs">{toast}</div> : null}
    </div>
  );
}



function bnMax(a?: bigint, b?: bigint) {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  iter: (t: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await iter(items[idx], idx);
      }
    });
  await Promise.all(workers);
  return out;
}

// Short, friendly error text (no raw JSON/viem dumps)
function tidyError(e: any): string {
  const s =
    e?.shortMessage ||
    e?.message ||
    (typeof e === "string" ? e : "") ||
    "Please retry.";
  const lower = s.toLowerCase();
  if (
    lower.includes("over rate limit") ||
    lower.includes("429") ||
    lower.includes("raw call arguments") ||
    lower.includes("http") ||
    lower.includes("timeout") ||
    lower.includes("internal json-rpc error")
  ) {
    return "Network is busy. Please retry.";
  }
  // Trim to a reasonable size
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? "Please retry." : flat || "Please retry.";
}

/* ------------------------------- block ticker ------------------------------ */

export function useBlockTicker(): bigint {
  const publicClient = usePublicClient();
  const [height, setHeight] = React.useState<bigint>(0n);

  React.useEffect(() => {
    if (!publicClient) return;
    const unwatch = publicClient.watchBlocks?.({
      emitOnBegin: true,
      emitMissed: true,
      onBlock: (b: any) => {
        if (b?.number != null) setHeight(b.number as bigint);
      },
    });
    return () => unwatch?.();
  }, [publicClient]);

  return height;
}

/* ------------------------------- core readers ------------------------------ */

async function getLastId(publicClient: any): Promise<bigint> {
  const next = (await publicClient.readContract({
    address: GAME as Address,
    abi: GAME_ABI,
    functionName: "nextMessageId",
  })) as bigint;
  return next > 0n ? next - 1n : 0n;
}

async function simClaimAtBlock(
  publicClient: any,
  who: Address,
  id: bigint,
  blockNumber?: bigint
): Promise<boolean> {
  try {
    await publicClient.simulateContract({
      address: GAME as Address,
      abi: GAME_ABI,
      functionName: "claim",
      args: [id],
      account: who,
      blockNumber,
    });
    return true;
  } catch {
    return false;
  }
}

/** Scan the last `depth` ids for claimability at a specific block (tip) */
async function findClaimablesBySim(
  publicClient: any,
  who: Address,
  depth = 128,
  concurrency = 6,
  blockNumber?: bigint
): Promise<bigint[]> {
  if (!publicClient || !who) return [];
  const lastId = await getLastId(publicClient);
  if (lastId <= 0n) return [];
  const start = lastId;
  const end = lastId > BigInt(depth) ? lastId - BigInt(depth) + 1n : 1n;

  const ids: bigint[] = [];
  for (let id = start; id >= end; id--) ids.push(id);

  const results = await mapPool(ids, concurrency, async (id) => {
    const ok = await simClaimAtBlock(publicClient, who, id, blockNumber);
    return { id, ok };
  });

  return results.filter((r) => r.ok).map((r) => r.id);
}

/* -------------------------- auto-poke (Expired only) ----------------------- */
// Replacements and Nukes already resolve inside their own txs (replace/vote).
// This ensures Expired is finalized as soon as glory ends.

function useAutoPokeResolve() {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const tip = useBlockTicker();

  // active id
  const { data: activeId } = useReadContract({
    address: GAME as Address,
    abi: GAME_ABI,
    functionName: "activeMessageId",
  }) as { data?: bigint };

  // gloryRemaining()
  const { data: gloryRem } = useReadContract({
    address: GAME as Address,
    abi: GAME_ABI,
    functionName: "gloryRemaining",
  }) as { data?: bigint };

  const lastPokeMsRef = React.useRef(0);

  React.useEffect(() => {
    (async () => {
      if (!publicClient) return;
      if (!activeId || activeId === 0n) return; // nothing active
      if (gloryRem == null || gloryRem > 0n) return; // still in glory

      // throttle pokes
      const now = Date.now();
      if (now - lastPokeMsRef.current < 15000) return;

      // Only send if simulation says it's resolvable (saves gas & clicks)
      try {
        await publicClient.simulateContract({
          address: GAME as Address,
          abi: GAME_ABI,
          functionName: "resolveIfExpired",
        });
      } catch {
        return; // not ready or already resolved
      }

      lastPokeMsRef.current = now;
      try {
        const hash = await writeContractAsync({
          address: GAME as Address,
          abi: GAME_ABI,
          functionName: "resolveIfExpired",
        });
        await publicClient.waitForTransactionReceipt({ hash });
      } catch {
        /* ignore rejections; we'll try again if still needed */
      }
    })();
  }, [publicClient, writeContractAsync, activeId, gloryRem, tip]);
}

/* --------------------------- unified rewards auto -------------------------- */

type AutoState = {
  ids: bigint[];
  scanning: boolean;
  lastResolvedAtTip?: bigint;
  lastClaimSeen?: { id: bigint; voter: Address; amt: bigint };
  hot: boolean;
};

export function useRewardsAuto(options?: {
  windowDepth?: number; // how far back to scan
  hotBlocks?: number; // keep fast updates for this many blocks after a resolution
}) {
  const windowDepth = options?.windowDepth ?? 128;
  const hotBlocks = options?.hotBlocks ?? 80;

  const { address } = useAccount();
  const publicClient = usePublicClient();
  useAutoPokeResolve();
  const tip = useBlockTicker();

  const [state, setState] = React.useState<AutoState>({
    ids: [],
    scanning: false,
    hot: false,
  });

  // Remember a recent resolution tip to run "hot" for a short time window
  React.useEffect(() => {
    const hot =
      state.lastResolvedAtTip != null &&
      tip &&
      tip - (state.lastResolvedAtTip as bigint) <= BigInt(hotBlocks);
    if (hot !== state.hot) {
      setState((s) => ({ ...s, hot: Boolean(hot) }));
    }
  }, [tip, state.lastResolvedAtTip, hotBlocks]); // eslint-disable-line

  // Watch Resolved events (covers Expired, Replaced, Nuked) — triggers hot re-scan
  React.useEffect(() => {
    if (!publicClient) return;
    const unwatch = publicClient.watchContractEvent?.({
      address: GAME as Address,
      abi: GAME_ABI,
      eventName: "Resolved",
      onLogs: async (logs: any[]) => {
        const bn = logs.reduce<bigint | undefined>(
          (acc, l) => bnMax(acc, l.blockNumber),
          undefined
        );
        if (bn != null) {
          setState((s) => ({ ...s, lastResolvedAtTip: bn }));
        }
      },
    });
    return () => unwatch?.();
  }, [publicClient]);

  // Watch Claimed events to prune local claimable set for the connected voter
  React.useEffect(() => {
    if (!publicClient || !address) return;
    const unwatch = publicClient.watchContractEvent?.({
      address: GAME as Address,
      abi: GAME_ABI,
      eventName: "Claimed",
      onLogs: (logs: any[]) => {
        for (const l of logs) {
          const args = l.args as {
            id: bigint;
            voter: Address;
            amount: bigint;
          };
          if (!args) continue;
          if (
            (args.voter?.toLowerCase?.() as string) ===
            (address as string).toLowerCase()
          ) {
            setState((s) => ({
              ...s,
              lastClaimSeen: {
                id: args.id,
                voter: args.voter,
                amt: args.amount,
              },
              ids: s.ids.filter((x) => x !== args.id),
            }));
          }
        }
      },
    });
    return () => unwatch?.();
  }, [publicClient, address]);

  // Scanner: tip-pinned & adaptive (fast during "hot" windows, slower otherwise)
  React.useEffect(() => {
    let stop = false;
    async function scan() {
      if (!publicClient || !address) return;
      setState((s) => ({ ...s, scanning: true }));
      try {
        const tipNow = await publicClient.getBlockNumber();
        const ids = await findClaimablesBySim(
          publicClient,
          address as Address,
          windowDepth,
          6,
          tipNow
        );
        if (!stop) {
          setState((s) => ({ ...s, ids, scanning: false }));
        }
      } catch {
        if (!stop) setState((s) => ({ ...s, scanning: false }));
      }
    }

    if (state.hot) {
      scan(); // run on each block change
    } else {
      scan();
      const iv = setInterval(scan, 15000);
      return () => {
        stop = true;
        clearInterval(iv);
      };
    }

    return () => {
      stop = true;
    };
  }, [publicClient, address, tip, state.hot, windowDepth]);

  // Manual scan trigger
  const scanNow = React.useCallback(async () => {
    if (!publicClient || !address) return;
    setState((s) => ({ ...s, scanning: true }));
    try {
      const tipNow = await publicClient.getBlockNumber();
      const ids = await findClaimablesBySim(
        publicClient,
        address as Address,
        windowDepth,
        6,
        tipNow
      );
      setState((s) => ({ ...s, ids, scanning: false }));
    } catch {
      setState((s) => ({ ...s, scanning: false }));
    }
  }, [publicClient, address, windowDepth]);

  return {
    claimableIds: state.ids,
    scanning: state.scanning,
    hot: state.hot,
    lastResolvedAtTip: state.lastResolvedAtTip,
    scanNow,
  };
}

/* ------------------------------ claim-all hook ----------------------------- */

export function useClaimAllNow() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const claimAllNow = React.useCallback(
    async (idsHint?: bigint[]) => {
      if (!publicClient || !address) throw new Error("Wallet not connected");

      // Discover claimables at the current tip (or use provided hint)
      const tip = await publicClient.getBlockNumber();
      const ids =
        idsHint && idsHint.length
          ? idsHint
          : await findClaimablesBySim(
              publicClient,
              address as Address,
              128,
              6,
              tip
            );

      if (ids.length === 0)
        throw new Error(
          "No claimable rewards found right now. Try again in a moment."
        );

      const txs: `0x${string}`[] = [];
      const claimed: bigint[] = [];

      for (const id of ids) {
        // Recheck at this tip before each send (saves a revert if state raced)
        try {
          await publicClient.simulateContract({
            address: GAME as Address,
            abi: GAME_ABI,
            functionName: "claim",
            args: [id],
            account: address as Address,
            blockNumber: tip,
          });
        } catch {
          continue;
        }

        const hash = await writeContractAsync({
          address: GAME as Address,
          abi: GAME_ABI,
          functionName: "claim",
          args: [id],
        });
        txs.push(hash as `0x${string}`);
        claimed.push(id);
        await publicClient.waitForTransactionReceipt({ hash });
      }

      if (txs.length === 0)
        throw new Error(
          "All claimables vanished by the time transactions were sent. Please retry."
        );

      return { idsClaimed: claimed, txs };
    },
    [publicClient, address, writeContractAsync]
  );

  return { claimAllNow };
}

/* -------------------- rewards panel + auto-claim toggleable ---------------- */


/** Header button to show/hide the rewards dock (and its auto wallet behavior) */

/* ------------------------------ ready-made UI ------------------------------ */

export function ClaimAllButton({ auto = false }: { auto?: boolean }) {
  const { claimableIds, scanning, hot } = useRewardsAuto();
  const { claimAllNow } = useClaimAllNow();
  const [msg, setMsg] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const idsKey = React.useMemo(
    () => (claimableIds.length ? claimableIds.join(",") : ""),
    [claimableIds]
  );
  const lastAutoKeyRef = React.useRef<string>("");

  async function runClaim(hint?: bigint[]) {
    setMsg("");
    setBusy(true);
    try {
      const { idsClaimed, txs } = await claimAllNow(hint);
      setMsg(
        `Claimed ${idsClaimed.length} reward${
          idsClaimed.length === 1 ? "" : "s"
        } • ${txs.length} tx${txs.length === 1 ? "" : "s"}`
      );
    } catch (e: any) {
      setMsg(tidyError(e));
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(""), 6000);
    }
  }

  // Auto wallet opening when enabled and new claimables appear
  React.useEffect(() => {
    if (!auto) return;
    if (busy) return;
    if (!claimableIds.length) return;

    // Avoid firing twice for the same set
    if (idsKey && idsKey !== lastAutoKeyRef.current) {
      lastAutoKeyRef.current = idsKey;
      // fire and let the wallet prompt
      runClaim(claimableIds).catch(() => {
        /* message set in runClaim */
      });
    }
  }, [auto, busy, idsKey, claimableIds]);

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={() => runClaim(claimableIds)}
        disabled={busy}
        className="px-4 py-2 rounded-full font-semibold border border-transparent bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95 transition shadow-sm disabled:opacity-60"
      >
        {busy ? "Claiming…" : scanning ? "Scanning…" : "Claim all"}
      </button>
      <div className="text-xs opacity-70">
        {claimableIds.length > 0
          ? `Ready: ${claimableIds.length}${hot ? " • live" : ""}`
          : scanning
          ? "Looking for fresh rewards…"
          : "No rewards yet"}
      </div>
      {msg && <div className="text-xs text-center">{msg}</div>}
    </div>
  );
}
