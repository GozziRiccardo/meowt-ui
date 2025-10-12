// src/App.tsx — HearMeOwT ($MEOWT) — Base mainnet hardened build
import * as React from "react";
// Ensure tab title is branded even if index.html is stale
function useTitle(title: string) {
  React.useEffect(() => {
    if (typeof document !== "undefined" && document.title !== title) {
      document.title = title;
    }
  }, [title]);
}
import { createPortal } from "react-dom";
import {
  WagmiProvider,
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useDisconnect,
  useWriteContract,
  usePublicClient,
  useWalletClient,
  useConnect,
  useBlockNumber,
} from "wagmi";
import { wagmiConfig, TARGET_CHAIN } from "./wagmi";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { keccak256, toBytes, parseUnits } from "viem";
import { useSafeWeb3Modal } from "./lib/useSafeWeb3Modal";
import { watchAccount, watchChainId } from "wagmi/actions";

// at the top of App.tsx
import { RewardsHeaderButton, RewardsDock } from "./rewardsAuto";
import { NetworkQuietProvider, useQuiet, runQuietly } from "./quiet";
import InstallBanner from "./components/InstallBanner";
import W3MDebug from "./components/W3MDebug";


// --- error tidying + tiny write retry ---

function isTransient(err: any) {
  const m = String(err?.shortMessage || err?.message || "").toLowerCase();
  return (
    m.includes("rate limit") ||
    m.includes("429") ||
    m.includes("status code") ||
    m.includes("timeout") ||
    m.includes("gateway") ||
    m.includes("rpc request failed") ||
    m.includes("json-rpc") ||
    m.includes("replacement underpriced") ||
    m.includes("nonce too low") ||
    m.includes("failed to fetch") ||
    m.includes("internal server error") ||
    m.includes("transaction does not have a transaction hash") ||
    m.includes("network")
  );
}

async function withRetry<T>(fn: () => Promise<T>, tries = 2, delayMs = 350): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i === tries - 1 || !isTransient(e)) break;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}


// Optional alias to catch any leftover calls using a capital W
export const WithRetry = withRetry;


// -------------------- ENV --------------------

const TOKEN = (import.meta.env as any).VITE_TOKEN_ADDRESS as string;

// share GAME + ABI across files
import { GAME, GAME_ABI } from "./abi";

const WHITEPAPER_URL =
  ((import.meta.env as any).VITE_WHITEPAPER_URL as string) ||
  "/HearMeOwT_Whitepaper.html";

// -------------------- ABIs (local) --------------------
const ERC20_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;


// -------------------- Query client --------------------
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // never carry old data into a fresh mount/key
      placeholderData: undefined,
      keepPreviousData: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      // avoid smart structural merge that can preserve old subfields
      structuralSharing: false,
      retry: 2,
    } as any,
  },
});

// -------------------- Small helpers --------------------

function nudgeQueries(
  qc: QueryClient,
  delays: number[] = [0, 350, 1200]
) {
  const tick = () => {
    qc.invalidateQueries({ refetchType: "active" });
    qc.refetchQueries({ type: "active" });
  };
  const seen = new Set<number>();
  for (const delay of delays) {
    if (seen.has(delay)) continue;
    seen.add(delay);
    if (delay <= 0) tick();
    else setTimeout(tick, delay);
  }
}

import { decodeErrorResult } from "viem";

// Better revert reason surfacing
function explainRevert(e: any, abi: any): string | null {
  // viem error shapes vary; try to find the hex revert data
  let data: any = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data;
  if (data && typeof data === "object" && "data" in data) data = data.data;
  if (typeof data === "string" && data.startsWith("0x")) {
    try {
      const dec = decodeErrorResult({ abi, data: data as `0x${string}` });
      const name = dec?.errorName || "Execution reverted";
      const args = (dec?.args ?? []).map((x: any) => String(x)).join(", ");
      return args ? `${name} (${args})` : name;
    } catch { /* fallthrough */ }
  }
  const m = String(e?.shortMessage || e?.message || "");
  if (/execution reverted/i.test(m)) return "Execution reverted";
  return null;
}

// Keep your existing isTransient/withRetry

async function estimateFees(publicClient: any) {
  try {
    const fees = await publicClient.estimateFeesPerGas();
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 100_000n;
    const maxFeePerGas = (fees.maxFeePerGas ?? fees.gasPrice ?? 0n) +
      maxPriorityFeePerGas / 2n;
    return { maxFeePerGas, maxPriorityFeePerGas };
  } catch {
    const gasPrice = await publicClient.getGasPrice().catch(() => 0n);
    return { gasPrice };
  }
}

type HardenedWriteFn = "post" | "replaceMessage" | "vote" | "boost" | "approve";

// -- Chain helpers ------------------------------------------------------------
const TARGET_CHAIN_HEX = `0x${TARGET_CHAIN.id.toString(16)}`;

async function ensureOnTargetChain(): Promise<void> {
  // Try best-effort EIP-1193 switch for injected wallets (MetaMask, Rabby, etc.)
  const eth = (window as any)?.ethereum;
  if (!eth?.request) return; // WalletConnect / CBW handled by connector
  try {
    const current = await eth.request({ method: "eth_chainId" });
    if (typeof current === "string" && current.toLowerCase() === TARGET_CHAIN_HEX.toLowerCase()) {
      return;
    }
  } catch {
    // ignore and attempt a switch anyway
  }
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TARGET_CHAIN_HEX }],
    });
  } catch (e: any) {
    // If the chain is unrecognized, many wallets already have Base; if not, surface a clear error.
    const msg = String(e?.message || "");
    const code = (e && (e as any).code) || 0;
    if (code === 4902 || /unrecognized|not added/i.test(msg)) {
      throw new Error(`Please add & switch to ${TARGET_CHAIN.name} in your wallet, then retry.`);
    }
    throw new Error(`Wrong network. Switch to ${TARGET_CHAIN.name} and retry.`);
  }
}

// Robustly extract a hex tx hash from various wallet return shapes
const HASH_KEYS = [
  "hash",
  "transactionHash",
  "txnHash",
  "txHash",
  "transaction_hash",
  "tx_hash",
];

function normalizeHexMaybe(value: string): `0x${string}` | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("0x")) return undefined;
  if (lower.length !== 66) return undefined;
  for (let i = 2; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    const isHex = (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
    if (!isHex) return undefined;
  }
  return (`0x${lower.slice(2)}`) as `0x${string}`;
}

function extractHash(maybe: any, depth = 0, seen = new Set<any>()): `0x${string}` | undefined {
  try {
    if (maybe == null) return undefined;
    if (seen.has(maybe)) return undefined;
    if (depth > 4) return undefined;
    if (typeof maybe === "string") return normalizeHexMaybe(maybe);
    if (typeof maybe === "object") {
      seen.add(maybe);
      for (const key of HASH_KEYS) {
        if (key in (maybe as any)) {
          const found = extractHash((maybe as any)[key], depth + 1, seen);
          if (found) return found;
        }
      }
      if (Array.isArray(maybe)) {
        for (const item of maybe) {
          const found = extractHash(item, depth + 1, seen);
          if (found) return found;
        }
      } else {
        const extraKeys = ["result", "data", "cause", "error", "receipt", "transaction"];
        for (const key of extraKeys) {
          if (key in (maybe as any)) {
            const found = extractHash((maybe as any)[key], depth + 1, seen);
            if (found) return found;
          }
        }
      }
    }
  } catch {}
  return undefined;
}

const GAS_FALLBACK: Record<HardenedWriteFn, bigint> = {
  post: 400_000n,
  replaceMessage: 420_000n,
  vote: 120_000n,
  boost: 140_000n,
  approve: 80_000n,
};

const FEE_BUMP_STEPS = [100n, 118n, 135n, 160n, 190n, 225n];

function bumpFee(value: bigint | undefined, bump: bigint) {
  if (typeof value !== "bigint" || value <= 0n) return undefined;
  return (value * bump) / 100n;
}

function bumpedFees(base: any, attempt: number) {
  const bump = FEE_BUMP_STEPS[Math.min(attempt, FEE_BUMP_STEPS.length - 1)];
  const maxFee = bumpFee(base?.maxFeePerGas, bump);
  const maxPrio = bumpFee(base?.maxPriorityFeePerGas, bump);
  const gasPrice = bumpFee(base?.gasPrice, bump);

  const out: any = {};
  if (typeof maxPrio === "bigint" && maxPrio > 0n) out.maxPriorityFeePerGas = maxPrio;
  if (typeof maxFee === "bigint" && maxFee > 0n) {
    out.maxFeePerGas = maxFee < (out.maxPriorityFeePerGas ?? 0n) ? out.maxPriorityFeePerGas : maxFee;
  }
  if (!out.maxFeePerGas && !out.maxPriorityFeePerGas && typeof gasPrice === "bigint" && gasPrice > 0n) {
    out.gasPrice = gasPrice;
  }
  return out;
}

async function simThenWrite(opts: {
  publicClient: any;
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"];
  account: `0x${string}`;
  address: `0x${string}`;
  abi: any;
  functionName: HardenedWriteFn;
  args: readonly any[];
  chainId: number;
}): Promise<`0x${string}`> {
  const { publicClient, writeContractAsync, account, address, abi, functionName, args } = opts;

  const baseCall = {
    account,
    address,
    abi,
    functionName,
    args,
    blockTag: "pending" as const,
  };
  const baseWrite = { account, address, abi, functionName, args, chainId: opts.chainId };

  let request: any | undefined;
  async function refreshSimulation() {
    try {
      const simulation = (await withRetry(
        () => publicClient.simulateContract(baseCall),
        2,
        250
      )) as any;
      request = simulation?.request;
    } catch (err) {
      if (!isTransient(err)) throw err;
      request = undefined;
    }
  }

  await refreshSimulation();

  let lastError: any;
  for (let attempt = 0; attempt < FEE_BUMP_STEPS.length; attempt++) {
    if (!request && attempt > 0) {
      await refreshSimulation();
    }

    let gas: bigint = GAS_FALLBACK[functionName] ?? 150_000n;
    if (request?.gas) {
      try { gas = BigInt(request.gas as bigint); } catch {}
    } else {
      try {
        gas = await withRetry(
          () =>
            publicClient.estimateContractGas({
              ...baseCall,
              blockTag: "pending",
            }),
          2,
          250
        );
      } catch {}
    }
    if (!gas || gas <= 0n) gas = GAS_FALLBACK[functionName] ?? 150_000n;

    const rawFees = await estimateFees(publicClient).catch(() => ({} as any));
    const fees = bumpedFees(rawFees, attempt);

    const submission: any = request ? { ...request } : { ...baseWrite };
    submission.account = account;
    submission.chainId = opts.chainId;
    submission.gas = gas;
    if (typeof fees.maxFeePerGas === "bigint") submission.maxFeePerGas = fees.maxFeePerGas;
    if (typeof fees.maxPriorityFeePerGas === "bigint") submission.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    if (!submission.maxFeePerGas && !submission.maxPriorityFeePerGas && typeof fees.gasPrice === "bigint") {
      submission.gasPrice = fees.gasPrice;
    }

    try {
      const res = await writeContractAsync(submission);
      const txHash = extractHash(res);
      if (!txHash) {
        // Some wallets resolve before returning a hash — normalize to a clear error
        throw new Error("Wallet did not return a transaction hash");
      }
      return txHash;
    } catch (err) {
      const recoveredHash = extractHash(err);
      if (recoveredHash) {
        return recoveredHash;
      }
      lastError = err;
      if (!isTransient(err)) throw err;
      request = undefined;
      const waitMs = 350 + attempt * 400;
      await new Promise((res) => setTimeout(res, waitMs));
      continue;
    }
  }

  throw lastError ?? new Error("Please retry.");
}

// Replace your tidyError with this gentler version (keeps your old mapping)
function tidyError(e: any): string {
  const explained = explainRevert(e, GAME_ABI);
  if (explained) return explained;

  const s =
    e?.shortMessage ||
    e?.message ||
    (typeof e === "string" ? e : "") ||
    "Please retry.";
  const lower = String(s).toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("timeout") ||
    lower.includes("gateway") ||
    lower.includes("rpc request failed") ||
    lower.includes("json-rpc") ||
    lower.includes("raw call arguments") ||
    lower.includes("http") ||
    lower.includes("internal json-rpc error")
  ) return "Network is busy. Please retry.";
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > 120 ? "Please retry." : flat || "Please retry.";
}


// robust allowance helper used by post/replace/vote

// robust allowance helper used by post/replace/vote — NO HOOKS HERE
async function ensureAllowanceThenSettle(
  publicClient: any,
  owner: `0x${string}`,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"],
  kick?: () => void,               // <- pass from the caller
): Promise<boolean> {
  // Ensure wallet is on the right chain before any approval
  await ensureOnTargetChain();

  if (!publicClient || !owner || amount === 0n) return false;

  let current: bigint = 0n;
  try {
    current = (await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
      blockTag: "pending",
    })) as bigint;
  } catch { /* treat as 0 */ }

  if (current >= amount) return false; // no approval needed

  const h = await simThenWrite({
    publicClient,
    writeContractAsync,
    account: owner,
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
    chainId: TARGET_CHAIN.id,
  });

  // wait for the approval receipt
  if (h && publicClient?.waitForTransactionReceipt) {
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error("Transaction reverted");
  }

  // Re-validate the allowance a few times to ride out RPC lag
  for (let i = 0; i < 4; i++) {
    try {
      const fresh = (await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, spender],
        blockTag: "pending",
      })) as bigint;
      if (fresh >= amount) break;
    } catch {}
    if (i < 3) await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }

  // nudge reads (provided by caller)
  if (kick) {
    kick(); setTimeout(kick, 300); setTimeout(kick, 1200);
  }
  return true; // approval happened
}

function readMaskUntil(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

const MASK_EVENT = "meowt:mask:update";
type MaskEventDetail = { key: string; until: number };

function emitMaskUpdate(key: string, until: number) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<MaskEventDetail>(MASK_EVENT, { detail: { key, until } })
    );
  } catch {
    // Older browsers might not support the generic signature
    window.dispatchEvent(new CustomEvent(MASK_EVENT, { detail: { key, until } }));
  }
}

function writeMaskUntil(key: string, until: number) {
  try {
    if (until > 0) localStorage.setItem(key, String(Math.floor(until)));
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  emitMaskUpdate(key, until);
}




// Put this near your other hooks / helpers


/**
 * Find claimable message IDs by *only* simulating `claim(id)`.
 * No caches, no multicalls to voteOf/messages/claimed.
 */

function looksAddress(a?: string) {
  return !!a && a.length === 42 && a.startsWith("0x") && a !== "0x0000000000000000000000000000000000000000";
}
function fmtClock(total: number | bigint | null | undefined): string {
  const n = Number(total ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0:00";
  const s = Math.max(0, Math.floor(n));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
function encodeInline(text: string) { return `meow:text:${encodeURIComponent(text || "")}`; }
function fmtMEOW(x?: bigint) { return typeof x === "bigint" ? Number(x) / 1e18 : undefined; }
function two(x?: number) { return typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—"; }

// -------------------- Permanent expiration counter (centered above message) --------------------
/**
 * Always-visible expiration countdown (only tracks exposure/expiration time).
 * - Ignores other windows (boost/glory/immunity) by design.
 * - Consumes `snap.rem` and renders "Time left: M:SS" next to the time-mascot.
 * - Renders above the message box, centered.
 */
function PermanentTimerBar() {
  const snap = useSnap();
  // `rem` is the remaining exposure/expiration seconds returned by GameSnapshot
  const remRaw = (snap as any)?.rem ?? 0n;
  const rem = Number(remRaw);

  if (!Number.isFinite(rem) || rem <= 0) return null;

  // Lightweight tick so the label stays fresh even between query nudges
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => forceTick((x) => x + 1), 500);
    return () => clearInterval(id);
  }, []);

  // Keep it compact but visible; group is centered
  return (
    <div className="w-full flex justify-center">
      <div
        className="flex items-center gap-4"
        role="status"
        aria-live="polite"
        aria-label={`Time left: ${fmtClock(rem)}`}
      >
        <img
          src="/illustrations/time-mascot.png"
          alt=""
          className="h-14 md:h-16 w-auto object-contain pointer-events-none select-none"
          draggable={false}
        />
        <div
          className={[
            "px-4 py-2 rounded-full shadow flex items-center gap-3",
            "bg-rose-600 text-white",
            "text-lg md:text-xl font-extrabold tracking-wide",
            "ring-1 ring-rose-700/40",
          ].join(" ")}
        >
          <span className="tabular-nums">{fmtClock(rem)}</span>
        </div>
      </div>
    </div>
  );
}

// -------------------- Visual skeletons --------------------
function PreviewSkeleton() {
  return (
    <div className="relative rounded-2xl p-6 text-center shadow-sm bg-rose-50/30 dark:bg-rose-950/20 ring-1 ring-rose-300/50 dark:ring-rose-800/40 backdrop-blur-md animate-pulse">
      <div className="h-3 w-44 mx-auto mb-4 rounded bg-black/10 dark:bg-white/10" />
      <div className="mx-auto w-full max-w-[72ch] px-3 py-1 space-y-3">
        <div className="h-4 rounded bg-black/10 dark:bg-white/10" />
        <div className="h-4 rounded bg-black/10 dark:bg-white/10" />
        <div className="h-4 w-2/3 rounded bg-black/10 dark:bg-white/10" />
      </div>
      <div className="mt-3 h-4 w-32 mx-auto rounded bg-black/10 dark:bg-white/10" />
    </div>
  );
}

// -------------------- Monotonic latches to prevent UI regressions --------------------
type LatchKey = string | null;

function useMonotonicPot(msgId?: bigint, rawPot?: bigint, resetKey?: string) {
  const ref = React.useRef(new Map<bigint, { value: bigint; key: LatchKey }>());
  const safe = typeof rawPot === "bigint" ? rawPot : 0n;
  React.useEffect(() => {
    if (!msgId || msgId === 0n) return;
    const key = resetKey ?? null;
    const prev = ref.current.get(msgId);
    if (!prev || prev.key !== key) {
      ref.current.set(msgId, { value: safe, key });
      return;
    }
    if (safe > prev.value) {
      ref.current.set(msgId, { value: safe, key });
    }
  }, [msgId, safe, resetKey]);
  const latched = msgId && msgId !== 0n ? ref.current.get(msgId) : undefined;
  return latched?.value ?? safe;
}
function useMonotonicCount(msgId?: bigint, raw?: bigint, resetKey?: string) {
  const ref = React.useRef(new Map<bigint, { value: bigint; key: LatchKey }>());
  const safe = typeof raw === "bigint" ? raw : 0n;
  React.useEffect(() => {
    if (!msgId || msgId === 0n) return;
    const key = resetKey ?? null;
    const prev = ref.current.get(msgId);
    if (!prev || prev.key !== key) {
      ref.current.set(msgId, { value: safe, key });
      return;
    }
    if (safe > prev.value) {
      ref.current.set(msgId, { value: safe, key });
    }
  }, [msgId, safe, resetKey]);
  const latched = msgId && msgId !== 0n ? ref.current.get(msgId) : undefined;
  return latched?.value ?? safe;
}
function useStableAuthor(msgId?: bigint, rawAuthor?: string, resetKey?: string) {
  const ref = React.useRef(new Map<bigint, { value: string; key: LatchKey }>());
  React.useEffect(() => {
    if (!msgId || msgId === 0n) return;
    const key = resetKey ?? null;
    const prev = ref.current.get(msgId);
    if (!prev || prev.key !== key) {
      if (looksAddress(rawAuthor)) ref.current.set(msgId, { value: rawAuthor!, key });
      else ref.current.delete(msgId);
      return;
    }
    if (looksAddress(rawAuthor) && rawAuthor !== prev.value) {
      ref.current.set(msgId, { value: rawAuthor!, key });
    }
  }, [msgId, rawAuthor, resetKey]);
  const latched = msgId && msgId !== 0n ? ref.current.get(msgId) : undefined;
  return latched?.value;
}
function useLatchedString(msgId?: bigint, raw?: string, resetKey?: string) {
  const ref = React.useRef(new Map<bigint, { value: string; key: LatchKey }>());
  React.useEffect(() => {
    if (!msgId || msgId === 0n) return;
    const key = resetKey ?? null;
    const prev = ref.current.get(msgId);
    if (!prev || prev.key !== key) {
      if (raw && raw.length > 0) ref.current.set(msgId, { value: raw, key });
      else ref.current.delete(msgId);
      return;
    }
    if (raw && raw.length > 0 && raw !== prev.value) {
      ref.current.set(msgId, { value: raw, key });
    }
  }, [msgId, raw, resetKey]);
  const latched = msgId && msgId !== 0n ? ref.current.get(msgId) : undefined;
  if (latched) return latched.value;
  return raw ?? "";
}

// -------------------- Finalizing overlays --------------------
export function FinalizingMask({
  secondsLeft,
  imgUrl,
  message = "Congratulations! But it is now time for the kings of tomorrow..",
}: {
  secondsLeft: number;
  imgUrl?: string;
  message?: string;
}) {
  React.useEffect(() => {
    const scrollY = window.scrollY;
    const prev = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.width = prev.width;
      document.body.style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-[99999] pointer-events-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Finalizing"
    >
      <div className="absolute inset-0 bg-black/90" />
      {imgUrl && (
        <img
          src={imgUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
          draggable={false}
        />
      )}
      <div
        className="absolute left-0 right-0 flex justify-center"
        style={{ top: "calc(16px + env(safe-area-inset-top, 0px))" }}
      >
        <div className="px-3 py-1.5 rounded-full text-sm font-semibold bg-black/85 text-white shadow-md">
          {message} {secondsLeft}s
        </div>
      </div>
    </div>,
    document.body
  );
}

// -------------------- Message preview --------------------

function headlineSize(n: number) {
  if (n <= 120) return "text-[28px] md:text-[32px]";
  if (n <= 240) return "text-[24px] md:text-[28px]";
  if (n <= 360) return "text-[20px] md:text-[24px]";
  return "text-[18px] md:text-[20px]";
}


function MessagePreview({
  msgId,
  uri,
  contentHash,
  author,
  potLabel,
  likes,
  dislikes,
  onLike,
  onDislike,
  canVote = true,
  lockLeft = 0,
  lockKind = "none",
}: {
  msgId?: bigint;
  uri: string;
  contentHash: string;
  author: string;
  potLabel: string;
  likes: string;
  dislikes: string;
  onLike: () => void;
  onDislike: () => void;
  canVote?: boolean;
  lockLeft?: number;
  lockKind?: "boost" | "glory" | "immunity" | "none";
}) {
  const BOOST_IMG = "/mascots/flame.png";
  const GLORY_IMG = "/mascots/crown.png";
  const MAX_RENDER = 420;
  const MAX_FETCH_RENDER = 1400;

  const isZeroHash =
    !contentHash || contentHash === "0x" || contentHash === "0x".padEnd(66, "0");

  // Gate LS by message id so a previous message can’t leak into a fresh load.
  const idPart = msgId && msgId !== 0n ? String(msgId) : "noid";
  const LS_KEY = isZeroHash
    ? `meowt:msg:${idPart}:uri:${uri || ''}`
    : `meowt:msg:${idPart}:hash:${contentHash || '0x'}`;

  const initialFromLS = React.useMemo(() => {
    try {
      if (typeof window === "undefined") return undefined;
      if (!msgId || msgId === 0n) return undefined;
      if (!uri && isZeroHash) return undefined;
      return localStorage.getItem(LS_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }, [LS_KEY, msgId, uri, isZeroHash]);

  const [text, setText] = React.useState<string | undefined>(initialFromLS);
  const cacheRef = React.useRef<Map<string, string>>(new Map());

  const [tick, setTick] = React.useState(0);
  React.useEffect(() => { setTick(0); }, [lockLeft, lockKind]);
  React.useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const left = Math.max(0, Math.floor((lockLeft ?? 0) - tick));
  const isBoost = lockKind === "boost" && left > 0;
  const isGlory = lockKind === "glory" && left > 0;
  const locked = left > 0;

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        if (!uri) return;
        if (cacheRef.current.has(uri)) {
          if (!cancelled) setText(cacheRef.current.get(uri)!);
          return;
        }
        try {
          const ls = localStorage.getItem(LS_KEY);
          if (!cancelled && ls != null) setText(ls);
        } catch {}

        let raw = "";
        if (uri.startsWith("meow:text:")) {
          raw = decodeURIComponent(uri.slice("meow:text:".length));
        } else if (uri.startsWith("data:text/plain;base64,")) {
          raw = atob(uri.slice("data:text/plain;base64,".length));
        } else {
          const toUrl = (u: string) =>
            u.startsWith("ipfs://")
              ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, "")}`
              : u;
          const primary = toUrl(uri);
          const urls = uri.startsWith("ipfs://")
            ? [
                primary,
                primary.replace("ipfs.io", "cloudflare-ipfs.com"),
                primary.replace("ipfs.io", "gateway.pinata.cloud"),
              ]
            : [primary];

          for (const u of urls) {
            try {
              const res = await fetch(u, { mode: "cors", signal: controller.signal });
              if (!res.ok) continue;
              raw = await res.text();
              break;
            } catch {}
          }
        }

        if (raw.length > MAX_FETCH_RENDER) raw = raw.slice(0, MAX_FETCH_RENDER) + "…";

        if (!cancelled) {
          cacheRef.current.set(uri, raw || "");
          setText(raw || "");
          try { localStorage.setItem(LS_KEY, raw || ""); } catch {}
        }

        if (!isZeroHash) {
          try {
            const h = keccak256(toBytes(raw || ""));
            if (h !== contentHash) console.warn("Content hash mismatch (displaying truncated text anyway)");
          } catch {}
        }
      } catch {
        if (!cancelled) setText(initialFromLS ?? "");
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [uri, contentHash, LS_KEY, initialFromLS, isZeroHash]);

  const display = (text ?? "").slice(0, MAX_RENDER);
  const shortAddr = React.useMemo(() => {
    const a = author || "";
    return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  }, [author]);

  const topPad = (isBoost || isGlory) ? "pt-[clamp(64px,12vw,112px)]" : "";
  const bottomPad = (isBoost || isGlory) ? "pb-[clamp(24px,4vw,40px)]" : "";
  const ringColor = isGlory ? "!ring-amber-500" : (locked ? "!ring-red-600" : "");
  const topImg = isGlory ? GLORY_IMG : BOOST_IMG;
  const likeEnabled = canVote;
  const dislikeEnabled = canVote && !isGlory;

  return (
    <div className={[
        "relative rounded-2xl p-6 text-center shadow-sm",
        "bg-rose-50/30 dark:bg-rose-950/20",
        "ring-1 ring-rose-300/50 dark:ring-rose-800/40",
        "backdrop-blur-md",
        locked ? `ring-2 ${ringColor}` : "",
      ].join(" ")}>
      {(isBoost || isGlory) && (
        <div className="absolute left-0 right-0 top-3 md:top-4 z-10 flex justify-center pointer-events-none select-none">
          <img
            src={topImg}
            alt=""
            className="h-[clamp(36px,9vw,88px)] w-auto drop-shadow-[0_0_10px_rgba(234,179,8,0.55)]"
            draggable={false}
          />
        </div>
      )}

      {left > 0 && (
        <div className={`absolute top-2 right-2 z-20 px-2 py-0.5 rounded-md text-xs font-semibold ${
          isGlory ? "bg-amber-500 text-black" : "bg-red-600 text-white"
        } shadow flex items-center gap-1.5`}>
          <span>⏳</span><span>{fmtClock(left)}</span>
        </div>
      )}

      <div className={topPad}>
        <div className="text-xs font-semibold tracking-wide uppercase mb-2 text-rose-600 dark:text-rose-300">
          {shortAddr}’s meowssage to the world
        </div>

        <div className={[
  headlineSize(display.length),
  "leading-relaxed whitespace-pre-wrap break-words break-all text-center mx-auto pb-3",
  "max-h-[48vh] md:max-h-[56vh] overflow-auto",
].join(" ")}>{display || " "}</div>

        {(isBoost || isGlory) && (
          <div className={["flex justify-center pointer-events-none select-none", bottomPad].join(" ")}>
            <img
              src={isGlory ? GLORY_IMG : BOOST_IMG}
              alt=""
              className="h-[clamp(36px,9vw,88px)] w-auto drop-shadow-[0_0_10px_rgba(234,179,8,0.55)]"
              draggable={false}
            />
          </div>
        )}

        <div className="mt-1 text-base font-semibold">{potLabel}</div>
      </div>

      {/* reactions */}
      <div className="absolute left-4 bottom-4 flex items-center gap-2 select-none">
        {likeEnabled ? (
          <>
            <button
              onClick={onLike}
              className="px-3 py-1.5 rounded-full bg-white/90 border hover:bg-rose-50 shadow-sm dark:bg-white/10 dark:hover:bg-white/20 dark:border-white/10 active:scale-95 transition"
              title="Like"
            >
              😺
            </button>
            <span className="text-sm font-medium">{likes}</span>
          </>
        ) : (
          <>
            <span className="text-lg opacity-80" title="Connect wallet to vote">😺</span>
            <span className="text-sm font-medium opacity-80">{likes}</span>
          </>
        )}
      </div>

      <div className="absolute right-4 bottom-4 flex items-center gap-2 select-none">
        {dislikeEnabled ? (
          <>
            <span className="text-sm font-medium">{dislikes}</span>
            <button
              onClick={onDislike}
              className="px-3 py-1.5 rounded-full bg-white/90 border hover:bg-rose-50 shadow-sm dark:bg-white/10 dark:hover:bg-white/20 dark:border-white/10 active:scale-95 transition"
              title="Dislike"
            >
              😾
            </button>
          </>
        ) : (
          <>
            <span className="text-sm font-medium opacity-80">{dislikes}</span>
            <span className="text-lg opacity-80" title={isGlory ? "Crowning period – dislike disabled" : "Connect wallet to vote"}>😾</span>
          </>
        )}
      </div>
    </div>
  );
}

// -------------------- Idle card --------------------
function WaitingCard() {
  return (
    <div className="relative rounded-2xl p-6 text-center shadow-sm bg-rose-50/40 dark:bg-rose-950/20 ring-1 ring-rose-300/50 dark:ring-rose-800/40 backdrop-blur-md">
      <div className="text-xs font-semibold tracking-wide uppercase mb-4 text-rose-600 dark:text-rose-300">
        Waiting for a new meowssage
      </div>
      <img
        src="/illustrations/waiting-mascot.png"
        alt="Waiting cat"
        className="mx-auto h-40 md:h-48 object-contain select-none pointer-events-none"
      />
      <div className="mt-6 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Post something purrfect…
      </div>
    </div>
  );
}

// -------------------- Game snapshot (reads tuned for mainnet) --------------------


// -------------------- Game snapshot (reads tuned for mainnet) --------------------


// -------------------- Game snapshot (reads tuned for mainnet) --------------------
function useGameSnapshot() {
  const INIT_HOLD_MS = 400;           // keep your values
  const ID_CHANGE_HOLD_MS = 700;
  const OPTIMISTIC_SHOW_MS = 1100;
  const SHOW_CUSHION = 1;
  const { quiet } = useQuiet();

  // -------- Boot anti-ghost settings --------
  const BOOT_MODE_MS = 2500; // during first ~2.5s be extra strict
  const APP_BOOT_TS = React.useRef(Date.now()).current;
  const booting = Date.now() - APP_BOOT_TS < BOOT_MODE_MS;

  // --- Active id (stable via placeholderData) + zero-id boot grace ---
  const ZERO_ID_GRACE_MS = 700;
  const zeroIdGraceUntilRef = React.useRef<number>(0);

  const { data: id } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "activeMessageId",
    query: {
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      placeholderData: (prev) => prev,
    },
  });

  React.useEffect(() => {
    if (!zeroIdGraceUntilRef.current) {
      zeroIdGraceUntilRef.current = Date.now() + ZERO_ID_GRACE_MS;
    }
    if (id && id !== 0n) zeroIdGraceUntilRef.current = 0;
  }, [id]);

  const nowMs = Date.now();
  const zeroIdGraceActive =
    id === 0n && zeroIdGraceUntilRef.current > 0 && nowMs < zeroIdGraceUntilRef.current;

  const waitingForId = typeof id === "undefined" || id === null || zeroIdGraceActive;
  const hasId = !!id && id !== 0n;
  const idBig = hasId ? (id as bigint) : 0n;

  // -------- Batched reads --------
  const { data: raw } = useReadContracts({
    allowFailure: true,
    contracts: hasId
      ? [
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "messages", args: [idBig] }, // 0
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "endTime", args: [idBig] }, // 1
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "requiredStakeToReplace" }, // 2
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "voteFeeLike" }, // 3
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "voteFeeDislike" }, // 4
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "boostCost" }, // 5
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "boostedRemaining" }, // 6
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "boostCooldownRemaining" }, // 7
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "isReplaceBlocked" }, // 8
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "windows" }, // 9
        ]
      : [],
    query: {
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      placeholderData: (prev) => prev,
    },
  });

  // -------- Live reads --------
  const { data: remChainBN } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "remainingSeconds",
    args: [idBig],
    query: {
      enabled: hasId && !quiet,
      staleTime: 0,
      refetchOnWindowFocus: false,
      refetchInterval: 1000,
      placeholderData: (p) => p,
    },
  });
  const { data: gloryRemChainBN } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "gloryRemaining",
    query: {
      enabled: hasId && !quiet,
      staleTime: 0,
      refetchOnWindowFocus: false,
      refetchInterval: 1000,
      placeholderData: (p) => p,
    },
  });

  // Live boost cost latch
  const { data: boostCostLive } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "boostCost",
    query: { staleTime: 0, refetchOnWindowFocus: false, placeholderData: (prev) => prev, enabled: !quiet },
  });

  const take = (arr: any[] | undefined, i: number) =>
    arr?.[i] && typeof arr[i] === "object" && "result" in (arr[i] as any)
      ? (arr[i] as any).result
      : undefined;

  const m = hasId ? (take(raw as any[], 0) ?? null) : null;
  const endTsBN = hasId ? ((take(raw as any[], 1) ?? 0n) as bigint) : 0n;
  const feeLike = hasId ? (take(raw as any[], 3) as bigint | undefined) : undefined;
  const feeDislike = hasId ? (take(raw as any[], 4) as bigint | undefined) : undefined;
  const boostCostRead = hasId ? (take(raw as any[], 5) as bigint | undefined) : undefined;
  const boostedRemBN = hasId ? ((take(raw as any[], 6) ?? 0n) as bigint) : 0n;
  const boostCooldownBN = hasId ? ((take(raw as any[], 7) ?? 0n) as bigint) : 0n;
  const replaceBlocked = hasId ? Boolean(take(raw as any[], 8)) : false;
  const winsTuple = hasId ? (take(raw as any[], 9) as readonly [bigint, bigint, bigint] | undefined) : undefined;

  const winPostImm = Number(winsTuple?.[0] ?? 300n);
  const winGlory = Number(winsTuple?.[1] ?? 300n);
  const winFreeze = Number(winsTuple?.[2] ?? 11n);

  const startTime = Number((m?.startTime ?? m?.[3] ?? 0n) as bigint);
  const B0secs = Number((m?.B0 ?? m?.[4] ?? 0n) as bigint);

  // Local ticker (anchored to chain time)
  const chainNowRef = React.useRef<{ epoch: number; fetchedAt: number }>({ epoch: 0, fetchedAt: 0 });
  const computeChainNow = React.useCallback(() => {
    const anchor = chainNowRef.current;
    if (anchor.epoch > 0 && anchor.fetchedAt > 0) {
      const elapsed = Math.floor((Date.now() - anchor.fetchedAt) / 1000);
      return anchor.epoch + Math.max(0, elapsed);
    }
    return Math.floor(Date.now() / 1000);
  }, []);
  const [nowSec, setNowSec] = React.useState(() => computeChainNow());
  React.useEffect(() => {
    const iv = setInterval(() => setNowSec(computeChainNow()), 500);
    return () => clearInterval(iv);
  }, [computeChainNow]);

  // Refs and latches (mostly unchanged)
  const lastIdRef = React.useRef<bigint>(0n);
  const exposureEndRef = React.useRef<number>(0);
  const gloryEndRef = React.useRef<number>(0);
  const boostEndRef = React.useRef<number>(0);
  const cooldownEndRef = React.useRef<number>(0);
  const immEndRef = React.useRef<number>(0);
  const showUntilRef = React.useRef<number>(0);
  const idHoldUntilRef = React.useRef<number>(0);

  // Boot & id-change holds (no optimistic show on boot)
  const bootHold = Date.now() - APP_BOOT_TS < INIT_HOLD_MS;
  React.useEffect(() => {
    if (!hasId) return;
    if (lastIdRef.current !== idBig) {
      lastIdRef.current = idBig;
      exposureEndRef.current = 0;
      gloryEndRef.current = 0;
      boostEndRef.current = 0;
      cooldownEndRef.current = 0;
      immEndRef.current = 0;

      // IMPORTANT: do not create an optimistic show window while booting
      if (!booting) {
        showUntilRef.current = Math.max(
          showUntilRef.current,
          Math.floor(Date.now() / 1000) + Math.ceil(OPTIMISTIC_SHOW_MS / 1000),
        );
      }

      idHoldUntilRef.current = Date.now() + ID_CHANGE_HOLD_MS;
    }
  }, [hasId, idBig, booting]);

  React.useEffect(() => {
    if (hasId) return;
    lastIdRef.current = 0n;
    exposureEndRef.current = 0;
    gloryEndRef.current = 0;
    boostEndRef.current = 0;
    cooldownEndRef.current = 0;
    immEndRef.current = 0;
    showUntilRef.current = 0;
  }, [hasId]);

  const idChangeHold = Date.now() < idHoldUntilRef.current;

  // End/exposure window
  const endTsNum = Number(endTsBN ?? 0n);
  React.useEffect(() => {
    const e = endTsNum > 0 ? endTsNum : startTime && B0secs ? startTime + B0secs : 0;
    if (e > 0) exposureEndRef.current = e;
  }, [endTsNum, startTime, B0secs]);

  React.useEffect(() => {
    const rem = Number(remChainBN ?? 0n);
    if (!Number.isFinite(rem) || rem < 0) return;
    const fallbackEnd =
      exposureEndRef.current > 0
        ? exposureEndRef.current
        : startTime && B0secs
        ? startTime + B0secs
        : 0;
    if (fallbackEnd <= 0) return;
    const anchorEpoch = fallbackEnd - rem;
    if (!Number.isFinite(anchorEpoch)) return;
    chainNowRef.current = { epoch: anchorEpoch, fetchedAt: Date.now() };
    setNowSec(computeChainNow());
  }, [remChainBN, endTsNum, startTime, B0secs, computeChainNow]);

  // Glory window (predict + chain)
  React.useEffect(() => {
    const predicted = startTime && B0secs && winGlory ? startTime + B0secs + winGlory : 0;
    if (predicted > 0) gloryEndRef.current = Math.max(gloryEndRef.current, predicted);
  }, [startTime, B0secs, winGlory]);
  React.useEffect(() => {
    const chainGlory = Number(gloryRemChainBN ?? 0n);
    if (chainGlory > 0) gloryEndRef.current = Math.max(gloryEndRef.current, nowSec + chainGlory);
  }, [gloryRemChainBN, nowSec]);
  React.useEffect(() => {
    const exp = exposureEndRef.current;
    if (exp > 0 && winGlory > 0) {
      const hardEnd = exp + winGlory;
      if (gloryEndRef.current > hardEnd) gloryEndRef.current = hardEnd;
    }
  }, [endTsNum, startTime, B0secs, winGlory]);

  // Boost & cooldown latches
  React.useEffect(() => {
    const boostedRem = Number(boostedRemBN ?? 0n);
    if (boostedRem > 0) boostEndRef.current = Math.max(boostEndRef.current, nowSec + boostedRem);
  }, [boostedRemBN, nowSec]);
  React.useEffect(() => {
    const cooldownRem = Number(boostCooldownBN ?? 0n);
    if (cooldownRem > 0)
      cooldownEndRef.current = Math.max(cooldownEndRef.current, nowSec + cooldownRem);
  }, [boostCooldownBN, nowSec]);

  // Immunity window
  React.useEffect(() => {
    if (startTime && winPostImm) {
      const e = startTime + winPostImm;
      if (e > 0) immEndRef.current = Math.max(immEndRef.current, e);
    }
  }, [startTime, winPostImm]);

  // "Show" gate base window (kept)
  React.useEffect(() => {
    const until = Math.max(exposureEndRef.current, gloryEndRef.current);
    if (until > 0) showUntilRef.current = Math.max(showUntilRef.current, until);
  }, [endTsNum, startTime, B0secs, winGlory, gloryRemChainBN]);

  // Derived clocks
  const exposureLeft = Math.max(0, exposureEndRef.current - nowSec);
  const immLeft = Math.max(0, immEndRef.current - nowSec);
  const boostLeft = Math.max(0, boostEndRef.current - nowSec);
  const cooldownLeft = Math.max(0, cooldownEndRef.current - nowSec);

  const remFallback = Math.max(0, Number(remChainBN ?? 0n));
  const remSec = endTsNum > 0 || exposureEndRef.current > 0 ? exposureLeft : remFallback;

  const resolvedFlag = Boolean((m as any)?.resolved ?? (m as any)?.[10]);
  const nukedFlag = Boolean((m as any)?.nuked ?? (m as any)?.[11]);

  const inGlory = exposureLeft === 0 && gloryEndRef.current > nowSec;
  const gloryLeft = inGlory ? gloryEndRef.current - nowSec : 0;

  let lockKind: "boost" | "glory" | "immunity" | "none" = "none";
  let lockLeft = 0;
  if (inGlory && gloryLeft > 0) {
    lockKind = "glory";
    lockLeft = gloryLeft;
  } else if (boostLeft > 0) {
    lockKind = "boost";
    lockLeft = boostLeft;
  } else if (exposureLeft > 0 && immLeft > 0) {
    lockKind = "immunity";
    lockLeft = immLeft;
  }

  const replaceLocked = Boolean(replaceBlocked) || lockLeft > 0;

  // --------- NEW: proof-of-life and definitely-over guards ----------
  const publicClient = usePublicClient();

  // finalized confirm for the *current* id
  const [idConfirmOk, setIdConfirmOk] = React.useState<bigint | 0n>(0n);
  React.useEffect(() => {
    setIdConfirmOk(0n);
    if (!hasId || !idBig || idBig === 0n || !publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const finalizedId = (await publicClient.readContract({
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "activeMessageId",
          blockTag: "finalized",
        })) as bigint;
        if (!cancelled && finalizedId === idBig) setIdConfirmOk(idBig);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasId, idBig, publicClient]);

  // live timers are also proof-of-life
  const liveProof = Number(remChainBN ?? 0n) > 0 || Number(gloryRemChainBN ?? 0n) > 0;

  // message tuple loaded?
  const mLoaded = !!m && startTime > 0 && B0secs > 0;

  // hard "definitely over" fence: start + B0 + glory + freeze <= now
  const hardOverAt =
    startTime && B0secs ? startTime + B0secs + (winGlory || 0) + (winFreeze || 0) : 0;
  const definitelyOver = !!mLoaded && hardOverAt > 0 && nowSec >= hardOverAt;

  // Only consider confirmed on boot if:
  //  - finalized agrees, OR
  //  - live timer says >0, OR
  //  - tuple is loaded AND it's not definitely over
  const bootConfirmed = idConfirmOk === idBig || liveProof || (mLoaded && !definitelyOver);

  // Final "show" decision:
  //  - never show while booting unless confirmed
  //  - never show if tuple proves it's definitely over
  const untilShow = Math.max(
    showUntilRef.current,
    Math.max(exposureEndRef.current, gloryEndRef.current),
  );
  const baseShow = hasId && nowSec < untilShow + SHOW_CUSHION;
  const effectiveShow =
    baseShow &&
    !definitelyOver &&
    (!booting ? true : bootConfirmed) &&
    !bootHold &&
    !idChangeHold &&
    !waitingForId &&
    !(hasId && !raw); // stillFetchingActive

  // Clear optimistic show once things are resolved to avoid tail flashes
  React.useEffect(() => {
    if (!hasId) return;
    if (!resolvedFlag && !nukedFlag) return;
    const chainRem = Number(remChainBN ?? 0n);
    const chainGlory = Number(gloryRemChainBN ?? 0n);
    const latestWindowEnd = Math.max(exposureEndRef.current, gloryEndRef.current);
    const now = nowSec;
    if (chainRem > 0 || chainGlory > 0) return;
    if (latestWindowEnd > now) return;
    const cutoff = now - (SHOW_CUSHION + 1);
    if (showUntilRef.current > cutoff) showUntilRef.current = cutoff;
  }, [hasId, resolvedFlag, nukedFlag, remChainBN, gloryRemChainBN, nowSec]);

  // === Non-zero latch for boostCost (live > batched > 0) ===
  const boostCostRef = React.useRef<bigint>(0n);
  React.useEffect(() => {
    const v = (boostCostLive ?? boostCostRead ?? 0n) as bigint;
    if (v > 0n) boostCostRef.current = v;
  }, [boostCostLive, boostCostRead]);

  return {
    id: idBig,
    show: effectiveShow,

    // message + clocks
    m,
    rem: BigInt(remSec),
    gloryRem: inGlory ? gloryLeft : 0,

    // fees (from batch)
    feeLike,
    feeDislike,

    // boosts
    boostCost: boostCostRef.current,
    boostedRem: Math.max(0, boostEndRef.current - nowSec),
    boostCooldownRem: cooldownLeft,

    // windows for UI (used by masks etc.)
    winPostImm,
    winGlory,
    winFreeze,

    // locks
    replaceLocked,
    lockKind,
    lockLeft,

    // status
    loading:
      Boolean(bootHold || idChangeHold || waitingForId || (hasId && !raw)),
  } as const;
}





const GameSnapshotContext = React.createContext<ReturnType<typeof useGameSnapshot> | null>(null);
function GameSnapshotProvider({ children }: { children: React.ReactNode }) {
  const snap = useGameSnapshot();
  return <GameSnapshotContext.Provider value={snap}>{children}</GameSnapshotContext.Provider>;
}
function useSnap() {
  const ctx = React.useContext(GameSnapshotContext);
  if (!ctx) throw new Error("useSnap must be used inside GameSnapshotProvider");
  return ctx;
}

// -------------------- Connection helpers --------------------
function useUiConnected(): boolean {
  const { status, address } = useAccount();
  return status === "connected" && !!address;
}
function useLiveChainId() {
  const wagmiChainId = useChainId();
  const onTarget = wagmiChainId === TARGET_CHAIN.id;
  return { wagmiChainId, onTarget, targetName: TARGET_CHAIN.name };
}

// -------------------- Post/Replace/Vote --------------------
function PostBox() {
  const isConnected = useUiConnected();
  const snap = useSnap();
  if (!isConnected) return null;
  if ((snap as any)?.loading) return null;

  const hasActive = Boolean((snap as any)?.show) && (((snap as any)?.rem ?? 0n) > 0n);
  const isCrowning = Number((snap as any)?.gloryRem ?? 0) > 0;
  const anyLock = ((snap as any)?.lockKind ?? "none") !== "none";
  if (hasActive || isCrowning || anyLock) return null;
  return <PostBoxInner />;
}

function PostBoxInner() {
  const MAX_MSG_CHARS = 420;
  const { address } = useAccount();
  const [text, setText] = React.useState("");
  const [stake, setStake] = React.useState("50");
  const [posting, setPosting] = React.useState(false);

  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const qc = useQueryClient();
  const [toast, setToast] = React.useState("");
  const { setQuiet } = useQuiet();

  const { data: decimals } = useReadContract({
    address: TOKEN as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "decimals",
  });

  async function confirmThenRefresh(hash?: `0x${string}`) {
    try {
      if (hash && publicClient) {
        const r = await withRetry(
          () => publicClient.waitForTransactionReceipt({ hash }),
          3,
          300
        );
        if (r.status !== "success") throw new Error("Transaction reverted");
      }
    } finally {
      nudgeQueries(qc);
    }
  }

  async function onPost() {
    if (posting) return;
    setPosting(true);
    let preflightError: string | null = null;
    try {
      // Preflight network switch
      await ensureOnTargetChain().catch((e: any) => {
        preflightError = String(e?.message || e);
        throw e;
      });

      suppressMasksFor(12, [MOD_MASK_KEY, NUKE_MASK_KEY]);
      if (!publicClient || !address) throw new Error("Wallet not connected");
      const dec = Number(decimals ?? 18);
      const stakeWei = parseUnits(stake || "0", dec);

      const trimmed = (text || "").trim();
      if (!trimmed) { setToast("Type something first 😺"); return; }

      const content = trimmed.slice(0, MAX_MSG_CHARS);
      const uriUsed = encodeInline(content);
      const hash = keccak256(toBytes(content));

      writeMaskUntil(MOD_MASK_KEY, 0);
      writeMaskUntil(NUKE_MASK_KEY, 0);

      await runQuietly(setQuiet, async () => {
        await ensureAllowanceThenSettle(
          publicClient,
          address as `0x${string}`,
          TOKEN as `0x${string}`,
          GAME as `0x${string}`,
          stakeWei,
          writeContractAsync
        );

        const txHash = await simThenWrite({
          publicClient,
          writeContractAsync,
          account: address as `0x${string}`,
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "post",
          args: [uriUsed, hash, stakeWei, 0n, 0n, "0x"],
          chainId: TARGET_CHAIN.id,
        });

        await confirmThenRefresh(txHash);

        // Proactively pull the new id, kick queries, and clear any latent glory mask
        try {
          await publicClient.readContract({
            address: GAME as `0x${string}`,
            abi: GAME_ABI,
            functionName: "activeMessageId",
          });
        } catch {}

        nudgeQueries(qc, [0, 200, 800, 1600, 3000]);
        writeMaskUntil(GLORY_MASK_KEY, 0);
      });
      setText("");
      setToast("Post confirmed ✨");
    } catch (e: any) {
      setToast(preflightError || tidyError(e));
    } finally {
      extendMaskSuppression(6);
      setPosting(false);
      setTimeout(() => setToast(""), 1600);
    }
  }

  return (
    <div className="p-4 rounded-2xl shadow-sm bg-rose-50/30 dark:bg-rose-950/20 ring-1 ring-rose-300/50 dark:ring-rose-800/40 backdrop-blur-md flex flex-col gap-2">
      <div className="text-lg font-semibold">Post a message</div>
      <textarea
        className="border rounded p-2 w-full dark:bg-white/5 dark:border-white/10 dark:placeholder-white/50"
        rows={3}
        placeholder="Type your message…"
        value={text}
        maxLength={MAX_MSG_CHARS}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="text-xs text-right opacity-60">
        {text.length} / {MAX_MSG_CHARS}
      </div>
      <div className="flex gap-2">
        <input
          className="border rounded p-2 w-40 dark:bg-white/5 dark:border-white/10 dark:placeholder-white/50"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          placeholder="Stake MEOWT"
          inputMode="decimal"
        />
        <button
          className="px-3 py-2 rounded font-medium border border-transparent transition bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-400 dark:text-black dark:hover:bg-rose-300 disabled:opacity-60"
          onClick={onPost}
          disabled={posting}
        >
          {posting ? "Posting…" : "Post"}
        </button>
      </div>
      <Toast text={toast} />
    </div>
  );
}





function ReplaceBox() {
  const isConnected = useUiConnected();
  const snap = useSnap();
  const hasActive = Boolean((snap as any)?.show);
  const locked = Boolean((snap as any)?.replaceLocked);
  if (!isConnected || !hasActive || locked) return null;
  return <ReplaceBoxInner />;
}

function ReplaceBoxInner() {
  const MAX_MSG_CHARS = 420;

  const [stake, setStake] = React.useState("");
  const [text, setText] = React.useState("my replacement");
  const [replacing, setReplacing] = React.useState(false);

  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const qc = useQueryClient();
  const [toast, setToast] = React.useState("");
  const { setQuiet } = useQuiet();

  // Live "Required now"
  const { data: required } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "requiredStakeToReplace",
    query: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      refetchInterval: 2000,
      placeholderData: (prev) => prev,
    },
  });

  // token decimals
  const { data: decimals } = useReadContract({
    address: TOKEN as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "decimals",
  });

  async function confirmThenRefresh(hash?: `0x${string}`) {
    try {
      if (hash && publicClient) {
        const r = await withRetry(
          () => publicClient.waitForTransactionReceipt({ hash }),
          3,
          300
        );
        if (r.status !== "success") throw new Error("Transaction reverted");
      }
    } finally {
      nudgeQueries(qc);
    }
  }

  async function onReplace() {
    if (replacing) return;
    setReplacing(true);
    let preflightError: string | null = null;
    try {
      // Preflight network switch
      await ensureOnTargetChain().catch((e: any) => {
        preflightError = String(e?.message || e);
        throw e;
      });

      suppressMasksFor(12, [MOD_MASK_KEY, NUKE_MASK_KEY]);
      if (!publicClient || !address) throw new Error("Wallet not connected");

      const dec = Number(decimals ?? 18);
      const stakeWei = parseUnits(stake || "0", dec);

      if ((required ?? 0n) > 0n && stakeWei < (required as bigint)) {
        setToast("Stake below required");
        return;
      }

      const content = (text || "").slice(0, MAX_MSG_CHARS);
      const uriUsed = encodeInline(content);
      const hash = keccak256(toBytes(content));

      writeMaskUntil(MOD_MASK_KEY, 0);
      writeMaskUntil(NUKE_MASK_KEY, 0);

      await runQuietly(setQuiet, async () => {
        await ensureAllowanceThenSettle(
          publicClient,
          address as `0x${string}`,
          TOKEN as `0x${string}`,
          GAME as `0x${string}`,
          stakeWei,
          writeContractAsync
        );

        const h = await simThenWrite({
          publicClient,
          writeContractAsync,
          account: address as `0x${string}`,
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "replaceMessage",
          args: [uriUsed, hash, stakeWei, 0n, 0n, "0x"],
          chainId: TARGET_CHAIN.id,
        });

        await confirmThenRefresh(h);

        // Proactively pull the new id, kick queries, and clear any latent glory mask
        try {
          await publicClient.readContract({
            address: GAME as `0x${string}`,
            abi: GAME_ABI,
            functionName: "activeMessageId",
          });
        } catch {}

        nudgeQueries(qc, [0, 200, 800, 1600, 3000]);
        writeMaskUntil(GLORY_MASK_KEY, 0);
      });
      setToast("Replacement confirmed ✨");
    } catch (e: any) {
      setToast(preflightError || tidyError(e));
    } finally {
      extendMaskSuppression(6);
      setReplacing(false);
      setTimeout(() => setToast(""), 1600);
    }
  }

  return (
    <div className="p-4 rounded-2xl shadow-sm bg-rose-50/30 dark:bg-rose-950/20 ring-1 ring-rose-300/50 dark:ring-rose-800/40 backdrop-blur-md flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Replace current post</div>
        <div className="text-sm">
          Required now: {two(fmtMEOW(required as bigint | undefined))} MEOWT
        </div>
      </div>

      <textarea
        className="border rounded p-2 w-full dark:bg-white/5 dark:border-white/10 dark:placeholder-white/50"
        rows={3}
        value={text}
        maxLength={MAX_MSG_CHARS}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="text-xs text-right opacity-60">
        {text.length} / {MAX_MSG_CHARS}
      </div>

      <div className="flex gap-2">
        <input
          className="border rounded p-2 w-40 dark:bg-white/5 dark:border-white/10 dark:placeholder-white/50"
          placeholder="Stake MEOWT"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          inputMode="decimal"
        />
        <button
          className="px-3 py-2 rounded font-medium border border-transparent transition bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-400 dark:text-black dark:hover:bg-rose-300 disabled:opacity-60"
          onClick={onReplace}
          disabled={replacing}
        >
          {replacing ? "Replacing…" : "Replace"}
        </button>
      </div>

      <Toast text={toast} />
    </div>
  );
}






const GLORY_MASK_KEY = "meowt:mask:glory";
const NUKE_MASK_KEY = "meowt:mask:nuke";
const MOD_MASK_KEY = "meowt:mask:mod";
const GLORY_MASK_LATCH_PAD = 2; // seconds before glory ends to begin masking

let maskSuppressionUntil = 0;
let suppressedMaskTypes = new Set<string>();
function suppressMasksFor(seconds: number, types: string[] = []) {
  const next = Math.floor(Date.now() / 1000) + Math.max(0, seconds);
  maskSuppressionUntil = Math.max(maskSuppressionUntil, next);
  if (types.length === 0) {
    suppressedMaskTypes.add("*");
  } else {
    types.forEach((t) => suppressedMaskTypes.add(t));
  }
}
function extendMaskSuppression(seconds: number) {
  if (maskSuppressionUntil <= 0) return;
  const next = Math.floor(Date.now() / 1000) + Math.max(0, seconds);
  maskSuppressionUntil = Math.max(maskSuppressionUntil, next);
}
function masksSuppressed(type?: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (maskSuppressionUntil <= now) {
    maskSuppressionUntil = 0;
    if (suppressedMaskTypes.size > 0) suppressedMaskTypes.clear();
    return false;
  }
  if (suppressedMaskTypes.has("*")) return true;
  if (!type) return suppressedMaskTypes.size > 0;
  return suppressedMaskTypes.has(type);
}

// -------------------- Active card (with masks & boost) --------------------

function ActiveCard() {
  const snap = useSnap();

  const isConnected = useUiConnected();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const qc = useQueryClient();

  const [toast, setToast] = React.useState("");
  const { quiet, setQuiet } = useQuiet();
  const hasActive = Boolean((snap as any)?.show);

  // --- vote state / gating ---
  const msgId: bigint = (snap as any)?.id ?? 0n;
  const currentMessage = (snap as any)?.m ?? null;
  const [latchedModId, setLatchedModId] = React.useState<bigint>(0n);
  React.useEffect(() => {
    if (msgId && msgId !== 0n) {
      setLatchedModId(msgId);
    }
  }, [msgId]);
  const [hasVotedLocal, setHasVotedLocal] = React.useState(false);
  React.useEffect(() => {
    setHasVotedLocal(false);
  }, [address, msgId]);

  const zeroAddr = "0x0000000000000000000000000000000000000000";
  const { data: voteSide } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "voteOf",
    args: [msgId as bigint, (address ?? zeroAddr) as `0x${string}`],
    query: {
      enabled: Boolean(address && msgId && msgId !== 0n && !quiet),
      refetchOnWindowFocus: false,
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      refetchInterval: 1200,
    },
  });
  const hasVotedOnChain = Number(voteSide ?? 0n) !== 0;

  const { data: modFlaggedLive } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "modFlagged",
    args: [latchedModId as bigint],
    query: {
      enabled: Boolean(latchedModId && latchedModId !== 0n),
      staleTime: 0,
      refetchOnWindowFocus: false,
      placeholderData: (prev) => prev,
    },
  });

  // --- clocks / windows from snap ---
  const remSec = Number((snap as any)?.rem ?? 0n);
  const glorySec = Number((snap as any)?.gloryRem ?? 0);
  const MASK_SECS = Number((snap as any)?.winFreeze ?? 11);

  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
  React.useEffect(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => clearInterval(iv);
  }, []);

  // ========= POST-GLORY FREEZE MASK (clamped & de-flickered) =========
  const GLORY_MAX_SPAN =
    Math.max(0, Number((snap as any)?.winGlory ?? 0) + MASK_SECS + 2);

  const gloryUntilRef = React.useRef(0);
  const gloryMaskMessageIdRef = React.useRef<bigint>(0n);

  // Clamp any persisted "until" so it can't be wildly in the future
  React.useEffect(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const persisted = readMaskUntil(GLORY_MASK_KEY);
    if (persisted > 0) {
      const clipped = Math.min(persisted, nowSec + GLORY_MAX_SPAN);
      gloryUntilRef.current = clipped > nowSec ? clipped : 0;
    }
  }, [GLORY_MAX_SPAN]);

  React.useEffect(() => {
    if (glorySec > 0) {
      // Track the message id to clear mask when a new message arrives
      if (msgId && msgId !== 0n) {
        gloryMaskMessageIdRef.current = msgId;
      }

      // Always align the stored "until" to the current prediction
      const predictedEnd = now + glorySec + MASK_SECS;
      if (
        gloryUntilRef.current === 0 ||
        gloryUntilRef.current > predictedEnd ||
        (gloryMaskMessageIdRef.current !== msgId && msgId && msgId !== 0n)
      ) {
        gloryUntilRef.current = predictedEnd;
        writeMaskUntil(GLORY_MASK_KEY, predictedEnd);
      }
    } else if (
      gloryMaskMessageIdRef.current &&
      msgId &&
      msgId !== 0n &&
      gloryMaskMessageIdRef.current !== msgId
    ) {
      // New message → drop any old latched glory mask
      gloryUntilRef.current = 0;
      gloryMaskMessageIdRef.current = 0n;
      writeMaskUntil(GLORY_MASK_KEY, 0);
    } else if (gloryUntilRef.current > 0 && now >= gloryUntilRef.current) {
      // Timer naturally ended
      gloryUntilRef.current = 0;
      gloryMaskMessageIdRef.current = 0n;
      writeMaskUntil(GLORY_MASK_KEY, 0);
    }
  }, [glorySec, now, MASK_SECS, msgId]);

  // Show the mask slightly before the end, or whenever the timer is latched
  const latchPadStart =
    gloryUntilRef.current > 0
      ? Math.max(0, gloryUntilRef.current - (MASK_SECS + GLORY_MASK_LATCH_PAD))
      : 0;
  const gloryEndingSoon = glorySec > 0 && glorySec <= GLORY_MASK_LATCH_PAD;
  const latchedGloryMask =
    gloryUntilRef.current > 0 && now >= latchPadStart && now < gloryUntilRef.current;

  const showGloryMask = gloryEndingSoon || latchedGloryMask;

  // Remaining seconds come from the *target end*, never a max() of sources
  const targetEnd =
    glorySec > 0 ? now + glorySec + MASK_SECS : gloryUntilRef.current;
  const gloryMaskLeft = showGloryMask ? Math.max(0, targetEnd - now) : 0;

  // ========= MOD / NUKE MASKS =========
  const NUKE_MASK_SECS = MASK_SECS;
  const MOD_RETRIGGER_DEBOUNCE_SECS = 30;
  const nukeMaskUntilRef = React.useRef(0);
  const nukeMaskMessageIdRef = React.useRef<bigint>(0n);
  const modMaskUntilRef = React.useRef(0);
  const modMaskMessageIdRef = React.useRef<bigint>(0n);
  const lastActiveMessageRef = React.useRef<{ id: bigint; message: any } | null>(null);
  const [modFrozenMessage, setModFrozenMessage] =
    React.useState<{ id: bigint; message: any } | null>(null);
  const realtimeNukeIdRef = React.useRef<bigint>(0n);
  const realtimeNukeSeenRef = React.useRef(false);
  const modDisarmIdRef = React.useRef<bigint>(0n);
  const modDisarmUntilRef = React.useRef<number>(0);
  const isActiveRef = React.useRef<boolean>(false);
  function disarmModFor(id: bigint, seconds: number) {
    if (!id || id === 0n) return;
    modDisarmIdRef.current = id;
    modDisarmUntilRef.current = Math.floor(Date.now() / 1000) + Math.max(0, seconds);
  }
  function isModDisarmed(id: bigint) {
    return !!id && id === modDisarmIdRef.current && now < modDisarmUntilRef.current;
  }
  React.useEffect(() => {
    nukeMaskUntilRef.current = Math.max(
      nukeMaskUntilRef.current,
      readMaskUntil(NUKE_MASK_KEY)
    );
    modMaskUntilRef.current = Math.max(modMaskUntilRef.current, readMaskUntil(MOD_MASK_KEY));
  }, []);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<MaskEventDetail>).detail;
      if (!detail || typeof detail.until !== "number") return;
      const normalized = Number.isFinite(detail.until) ? Math.floor(detail.until) : 0;
      if (detail.key === MOD_MASK_KEY) {
        modMaskUntilRef.current = normalized > 0 ? normalized : 0;
        if (normalized <= 0) {
          const prevId = modMaskMessageIdRef.current;
          if (prevId && prevId !== 0n) {
            // Always disarm so the next post won't echo the MOD mask.
            disarmModFor(prevId, MOD_RETRIGGER_DEBOUNCE_SECS);
          }
          modMaskMessageIdRef.current = 0n;
          setModFrozenMessage(null);
        }
      } else if (detail.key === NUKE_MASK_KEY) {
        nukeMaskUntilRef.current = normalized > 0 ? normalized : 0;
        if (normalized <= 0) {
          nukeMaskMessageIdRef.current = 0n;
        }
      } else if (detail.key === GLORY_MASK_KEY) {
        gloryUntilRef.current = normalized > 0 ? normalized : 0;
        if (normalized <= 0) {
          gloryMaskMessageIdRef.current = 0n;
        }
      }
    };
    window.addEventListener(MASK_EVENT, handler as EventListener);
    return () => window.removeEventListener(MASK_EVENT, handler as EventListener);
  }, []);
  React.useEffect(() => {
    if (modMaskUntilRef.current > 0 && now >= modMaskUntilRef.current) {
      const prevId = modMaskMessageIdRef.current;
      if (prevId && prevId !== 0n) {
        // Always disarm on timer-based clear as well.
        disarmModFor(prevId, MOD_RETRIGGER_DEBOUNCE_SECS);
      }
      modMaskUntilRef.current = 0;
      modMaskMessageIdRef.current = 0n;
      writeMaskUntil(MOD_MASK_KEY, 0);
    }
    if (nukeMaskUntilRef.current > 0 && now >= nukeMaskUntilRef.current) {
      nukeMaskUntilRef.current = 0;
      nukeMaskMessageIdRef.current = 0n;
      writeMaskUntil(NUKE_MASK_KEY, 0);
    }
  }, [now, hasActive]);

  React.useEffect(() => {
    isActiveRef.current = hasActive;
  }, [hasActive]);
  React.useEffect(() => {
    if (hasActive && msgId && msgId !== 0n && currentMessage) {
      lastActiveMessageRef.current = { id: msgId, message: { ...currentMessage } };
    }
  }, [hasActive, msgId, currentMessage]);

  React.useEffect(() => {
    if (!modFlaggedLive) return;
    if (!latchedModId || latchedModId === 0n) return;
    if (masksSuppressed(MOD_MASK_KEY)) return;
    // Respect disarm regardless of active/inactive state.
    if (isModDisarmed(latchedModId)) return;

    const until = Math.floor(Date.now() / 1000) + NUKE_MASK_SECS;
    if (until > modMaskUntilRef.current) {
      modMaskUntilRef.current = until;
      writeMaskUntil(MOD_MASK_KEY, until);
    }
    modMaskMessageIdRef.current = latchedModId;

    let latched = lastActiveMessageRef.current;
    if (hasActive && msgId && msgId !== 0n && currentMessage && msgId === latchedModId) {
      latched = { id: msgId, message: { ...(currentMessage as any) } };
    }
    if (latched) {
      setModFrozenMessage({ id: latched.id, message: { ...latched.message } });
    }
  }, [hasActive, currentMessage, latchedModId, modFlaggedLive, msgId, NUKE_MASK_SECS]);
  React.useEffect(() => {
    if (hasActive) setModFrozenMessage(null);
  }, [hasActive]);
  const lastShownIdRef = React.useRef<bigint>(0n);
  const hadActiveRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    if (!hasActive || !currentMessage || !publicClient || !msgId || msgId === 0n) {
      if (realtimeNukeSeenRef.current && msgId && msgId !== realtimeNukeIdRef.current) {
        realtimeNukeSeenRef.current = false;
        realtimeNukeIdRef.current = msgId ?? 0n;
      }
      return;
    }

    const nuked = Boolean(
      (currentMessage as any)?.nuked ?? (currentMessage as any)?.[11] ?? false
    );
    if (!nuked) {
      realtimeNukeSeenRef.current = false;
      realtimeNukeIdRef.current = msgId;
      return;
    }

    if (realtimeNukeSeenRef.current && realtimeNukeIdRef.current === msgId) return;
    if (masksSuppressed(NUKE_MASK_KEY)) return;
    realtimeNukeSeenRef.current = true;
    realtimeNukeIdRef.current = msgId;

    let cancelled = false;

    (async () => {
      let flagged = false;
      try {
        flagged = (await withRetry(
          () =>
            publicClient.readContract({
              address: GAME as `0x${string}`,
              abi: GAME_ABI,
              functionName: "modFlagged",
              args: [msgId],
            }) as Promise<boolean>,
          2,
          200
        )) as boolean;
      } catch {
        flagged = false;
      }
      if (cancelled) return;
      if (masksSuppressed(flagged ? MOD_MASK_KEY : NUKE_MASK_KEY)) return;

      const until = Math.floor(Date.now() / 1000) + NUKE_MASK_SECS;
      if (flagged) {
        if (until > modMaskUntilRef.current) {
          modMaskUntilRef.current = until;
          writeMaskUntil(MOD_MASK_KEY, until);
        }
        if (msgId && msgId !== 0n) {
          modMaskMessageIdRef.current = msgId;
        }
        const latched =
          lastActiveMessageRef.current || {
            id: msgId,
            message: { ...(currentMessage as any) },
          };
        setModFrozenMessage({ id: latched.id, message: { ...latched.message } });
      } else if (until > nukeMaskUntilRef.current) {
        nukeMaskUntilRef.current = until;
        nukeMaskMessageIdRef.current = msgId ?? 0n;
        writeMaskUntil(NUKE_MASK_KEY, until);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasActive, currentMessage, msgId, publicClient, NUKE_MASK_SECS]);

  async function probeResolution(idToCheck: bigint) {
    if (masksSuppressed()) return;
    try {
      let flagged = false;
      try {
        flagged = (await withRetry(
          () =>
            publicClient!.readContract({
              address: GAME as `0x${string}`,
              abi: GAME_ABI,
              functionName: "modFlagged",
              args: [idToCheck],
            }) as Promise<boolean>,
          2,
          200
        )) as boolean;
      } catch {
        flagged = false;
      }

      if (masksSuppressed()) return;
      let mFinal: any = null;
      try {
        mFinal = await withRetry(
          () =>
            publicClient!.readContract({
              address: GAME as `0x${string}`,
              abi: GAME_ABI,
              functionName: "messages",
              args: [idToCheck],
            }) as Promise<any>,
          2,
          200
        );
      } catch {
        mFinal = null;
      }

      const nuked = Boolean(mFinal?.nuked ?? mFinal?.[11] ?? false);
      const until = Math.floor(Date.now() / 1000) + NUKE_MASK_SECS;

      if (flagged) {
        // Respect disarm even if a new post is already active.
        if (isModDisarmed(idToCheck)) return;
        if (masksSuppressed(MOD_MASK_KEY)) return;
        if (until > modMaskUntilRef.current) {
          modMaskUntilRef.current = until;
          writeMaskUntil(MOD_MASK_KEY, until);
        }
        if (idToCheck && idToCheck !== 0n) {
          modMaskMessageIdRef.current = idToCheck;
        }
        let latched = lastActiveMessageRef.current;
        if (!latched || latched.id !== idToCheck) {
          if (mFinal) {
            latched = { id: idToCheck, message: { ...mFinal } };
          }
        }
        if (latched) {
          setModFrozenMessage({ id: latched.id, message: { ...latched.message } });
        }
        return;
      }

      if (!nuked) return;

      if (masksSuppressed(NUKE_MASK_KEY)) return;
      if (until > nukeMaskUntilRef.current) {
        nukeMaskUntilRef.current = until;
        nukeMaskMessageIdRef.current = idToCheck ?? 0n;
        writeMaskUntil(NUKE_MASK_KEY, until);
      }
    } catch {
      /* ignore */
    }
  }

  React.useEffect(() => {
    if (!hasActive || !currentMessage || !msgId || msgId === 0n) return;
    const nuked = Boolean(
      (currentMessage as any)?.nuked ?? (currentMessage as any)?.[11] ?? false
    );
    if (!nuked && nukeMaskMessageIdRef.current && nukeMaskMessageIdRef.current !== msgId) {
      nukeMaskUntilRef.current = 0;
      nukeMaskMessageIdRef.current = 0n;
      writeMaskUntil(NUKE_MASK_KEY, 0);
    }
  }, [hasActive, currentMessage, msgId]);

  React.useEffect(() => {
    if (!hasActive || !msgId || msgId === 0n) return;
    if (modFlaggedLive && latchedModId === msgId) {
      modMaskMessageIdRef.current = msgId;
      return;
    }
    if (modMaskMessageIdRef.current && modMaskMessageIdRef.current !== msgId) {
      modMaskUntilRef.current = 0;
      modMaskMessageIdRef.current = 0n;
      writeMaskUntil(MOD_MASK_KEY, 0);
      setModFrozenMessage(null);
    }
  }, [hasActive, latchedModId, modFlaggedLive, msgId]);

  React.useEffect(() => {
    const wasActive = hadActiveRef.current;
    if (hasActive && msgId && msgId !== 0n) {
      lastShownIdRef.current = msgId;
    }
    if (wasActive && !hasActive) {
      if (masksSuppressed()) {
        hadActiveRef.current = hasActive;
        return;
      }
      const idToCheck = lastShownIdRef.current || msgId;
      if (idToCheck && idToCheck !== 0n) probeResolution(idToCheck);
    }
    hadActiveRef.current = hasActive;
  }, [msgId, hasActive, publicClient, NUKE_MASK_SECS]);

  const showModMask = now < modMaskUntilRef.current;
  const showNukeMask = !showModMask && now < nukeMaskUntilRef.current;
  const modMaskLeft = showModMask ? modMaskUntilRef.current - now : 0;
  const nukeMaskLeft = showNukeMask ? nukeMaskUntilRef.current - now : 0;
  React.useEffect(() => {
    if (!showModMask) setModFrozenMessage(null);
  }, [showModMask]);

  const showingModeratedFreeze = Boolean(!hasActive && showModMask && modFrozenMessage);
  const displayMsgId = showingModeratedFreeze ? (modFrozenMessage!.id ?? 0n) : msgId;
  const messageForUi = showingModeratedFreeze ? modFrozenMessage!.message : currentMessage;

  async function confirmThenRefresh(hash?: `0x${string}`) {
    try {
      if (hash && publicClient) {
        const r = await withRetry(
          () => publicClient!.waitForTransactionReceipt({ hash }),
          3,
          300
        );
        if (r.status !== "success") throw new Error("Transaction reverted");
      }
    } finally {
      nudgeQueries(qc, [0, 400, 1500]);
    }
  }

  const canVoteWindow = remSec > 0 || glorySec > 0;
  const canVote = isConnected && canVoteWindow && !hasVotedLocal && !hasVotedOnChain;

  // ====== Hardened VOTE actions ======
  async function onLike() {
    let preflightError: string | null = null;
    try {
      if (!canVote || !publicClient || !address) return;
      // Preflight network switch
      await ensureOnTargetChain().catch((e: any) => {
        preflightError = String(e?.message || e);
        throw e;
      });

      // fee (live, with fallback)
      let fee = (snap as any)?.feeLike as bigint | undefined;
      if (!fee || fee === 0n) {
        fee = (await publicClient.readContract({
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "voteFeeLike",
        })) as bigint;
      }
      if (!fee || fee === 0n) {
        setToast("Please retry");
        return;
      }

      await runQuietly(setQuiet, async () => {
        await ensureAllowanceThenSettle(
          publicClient,
          address as `0x${string}`,
          TOKEN as `0x${string}`,
          GAME as `0x${string}`,
          fee,
          writeContractAsync
        );

        const h = await simThenWrite({
          publicClient,
          writeContractAsync,
          account: address as `0x${string}`,
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "vote",
          args: [true],
          chainId: TARGET_CHAIN.id,
        });

        setHasVotedLocal(true);
        await confirmThenRefresh(h);
      });
      setToast("Like confirmed ✨");
    } catch (e: any) {
      setHasVotedLocal(false);
      setToast(preflightError || tidyError(e));
    } finally {
      setTimeout(() => setToast(""), 1400);
    }
  }

  async function onDislike() {
    let preflightError: string | null = null;
    try {
      if (!canVote || !publicClient || !address) return;
      // Preflight network switch
      await ensureOnTargetChain().catch((e: any) => {
        preflightError = String(e?.message || e);
        throw e;
      });

      let fee = (snap as any)?.feeDislike as bigint | undefined;
      if (!fee || fee === 0n) {
        fee = (await publicClient.readContract({
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "voteFeeDislike",
        })) as bigint;
      }
      if (!fee || fee === 0n) {
        setToast("Please retry");
        return;
      }

      await runQuietly(setQuiet, async () => {
        await ensureAllowanceThenSettle(
          publicClient,
          address as `0x${string}`,
          TOKEN as `0x${string}`,
          GAME as `0x${string}`,
          fee,
          writeContractAsync
        );

        const h = await simThenWrite({
          publicClient,
          writeContractAsync,
          account: address as `0x${string}`,
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "vote",
          args: [false],
          chainId: TARGET_CHAIN.id,
        });

        setHasVotedLocal(true);
        await confirmThenRefresh(h);
      });
      setToast("Dislike confirmed ✨");
    } catch (e: any) {
      setHasVotedLocal(false);
      setToast(preflightError || tidyError(e));
    } finally {
      setTimeout(() => setToast(""), 1400);
    }
  }

  // ====== Hardened BOOST action ======
  const boostActive = ((snap as any)?.boostedRem ?? 0) > 0;
  const boostCooldown = ((snap as any)?.boostCooldownRem ?? 0) > 0;
  const boostCostWei = ((snap as any)?.boostCost ?? 0n) as bigint;
  const [boostBusy, setBoostBusy] = React.useState(false);

  async function onBoost() {
    if (boostBusy) return;
    let preflightError: string | null = null;
    try {
      // Preflight network switch
      await ensureOnTargetChain().catch((e: any) => {
        preflightError = String(e?.message || e);
        throw e;
      });
      if (!isConnected || !publicClient || !address) return;
      if (boostActive || boostCooldown || glorySec > 0) return;
      setBoostBusy(true);

      // Re-read cost (live) as a safety net
      let costNow = boostCostWei ?? 0n;
      try {
        const freshCost = await withRetry(
          () =>
            publicClient.readContract({
              address: GAME as `0x${string}`,
              abi: GAME_ABI,
              functionName: "boostCost",
            }) as Promise<bigint>,
          2,
          200
        );
        if (typeof freshCost === "bigint" && freshCost > 0n) costNow = freshCost;
      } catch {}

      if (costNow === 0n) {
        setToast("Network busy. Please try again.");
        setTimeout(() => setToast(""), 1400);
        return;
      }

      await runQuietly(setQuiet, async () => {
        await ensureAllowanceThenSettle(
          publicClient,
          address as `0x${string}`,
          TOKEN as `0x${string}`,
          GAME as `0x${string}`,
          costNow,
          writeContractAsync
        );

        const h = await simThenWrite({
          publicClient,
          writeContractAsync,
          account: address as `0x${string}`,
          address: GAME as `0x${string}`,
          abi: GAME_ABI,
          functionName: "boost",
          args: [],
          chainId: TARGET_CHAIN.id,
        });

        await confirmThenRefresh(h);
      });
      setToast("Boost sent 🔥");
    } catch (e: any) {
      setToast(preflightError || tidyError(e));
    } finally {
      setBoostBusy(false);
      setTimeout(() => setToast(""), 1400);
    }
  }

  // --- message fields / latches for stable UI (unchanged) ---
  const m: any = messageForUi || {};
  const rawAuthor = (m.author ?? m[1]) as string | undefined;
  const rawUri = (m.uri ?? m[5] ?? "") as string;
  const rawContentHash = (m.contentHash ?? m[6] ?? "0x") as string;
  const rawStartTime = (m.startTime ?? m[3] ?? 0n) as bigint;

  const messageIdentity = React.useMemo(() => {
    const idPart = displayMsgId ? displayMsgId.toString() : "0";
    const startPart =
      typeof rawStartTime === "bigint" ? rawStartTime.toString() : String(rawStartTime ?? 0);
    return [idPart, startPart, rawContentHash || "0x", rawUri || "", rawAuthor || ""].join("|");
  }, [displayMsgId, rawStartTime, rawContentHash, rawUri, rawAuthor]);

  const stableAuthor = useStableAuthor(displayMsgId, rawAuthor, messageIdentity);
  const authorForUi = stableAuthor || (looksAddress(rawAuthor) ? rawAuthor! : "0x");

  const rawFeePot: bigint = (m.feePot ?? m[9] ?? 0n) as bigint;
  const latchedFeePot = useMonotonicPot(displayMsgId, rawFeePot, messageIdentity);

  const rawLikes: bigint = (m.likes ?? m[7] ?? 0n) as bigint;
  const rawDislikes: bigint = (m.dislikes ?? m[8] ?? 0n) as bigint;
  const likesLatched = useMonotonicCount(displayMsgId, rawLikes, messageIdentity);
  const dislikesLatched = useMonotonicCount(displayMsgId, rawDislikes, messageIdentity);

  const likesStr = likesLatched.toString();
  const dislikesStr = dislikesLatched.toString();
  const contentHash = useLatchedString(displayMsgId, rawContentHash, messageIdentity);
  const uri = useLatchedString(displayMsgId, rawUri, messageIdentity);
  const potLabel = `💰 ${two(fmtMEOW(latchedFeePot))} MEOWT`;

  const previewReady = uri.length > 0;

  const renderActive = hasActive || showingModeratedFreeze;

  return (
    <div className="flex flex-col gap-3 items-stretch">
      {/* overlays */}
      {showModMask && (
        <FinalizingMask
          secondsLeft={modMaskLeft}
          imgUrl="/overlays/moderated.png"
          message="The message has been canceled for violation of our policies"
        />
      )}
      {!showModMask && showNukeMask && (
        <FinalizingMask
          secondsLeft={nukeMaskLeft}
          imgUrl="/overlays/nuked.png"
          message="Too many dislikes! The message has been nuked"
        />
      )}
      {!showModMask && !showNukeMask && showGloryMask && (
        <FinalizingMask secondsLeft={gloryMaskLeft} imgUrl="/overlays/finalizing.png" />
      )}

      {(snap as any).loading ? (
        <div className="p-4 border rounded-2xl text-center bg-white/70 dark:bg-white/10 border-black/10 dark:border-white/10 backdrop-blur-sm">
          Loading…
        </div>
      ) : renderActive ? (
        <div className="mx-auto w-full">
          {previewReady ? (
            <MessagePreview
              msgId={displayMsgId}
              uri={uri}
              contentHash={contentHash}
              author={authorForUi}
              potLabel={potLabel}
              likes={likesStr}
              dislikes={dislikesStr}
              onLike={onLike}
              onDislike={onDislike}
              canVote={isConnected && !hasVotedLocal && !hasVotedOnChain}
              lockLeft={Number((snap as any)?.lockLeft ?? 0)}
              lockKind={(snap as any)?.lockKind as any}
            />
          ) : (
            <PreviewSkeleton />
          )}

          {isConnected && (
            <div className="mt-2 flex flex-col items-center gap-2">
              {((snap as any)?.boostedRem ?? 0) > 0 ? (
                <>
                  <div className="text-xs px-2 py-1 rounded bg-red-600 text-white shadow">
                    🔥 Boost active · {fmtClock((snap as any).boostedRem)}
                  </div>
                  <div className="text-xs opacity-80">
                    Next boost cost (live): <b>{two(fmtMEOW(boostCostWei))}</b> MEOWT
                  </div>
                </>
              ) : glorySec > 0 ? (
                <div className="text-xs px-2 py-1 rounded bg-amber-500 text-black shadow">
                  👑 Crowning — boosting disabled
                </div>
              ) : ((snap as any)?.boostCooldownRem ?? 0) > 0 ? (
                <>
                  <div className="text-xs px-2 py-1 rounded bg-neutral-800 text-white dark:bg-neutral-700 shadow">
                    ⏳ Next boost in {fmtClock((snap as any).boostCooldownRem)}
                  </div>
                  <div className="text-xs opacity-80">
                    Next boost cost (live): <b>{two(fmtMEOW(boostCostWei))}</b> MEOWT
                  </div>
                </>
              ) : (
                <button
                  onClick={onBoost}
                  disabled={boostBusy}
                  className="px-4 py-2 rounded-full font-semibold border border-transparent
                             bg-red-600 text-white hover:bg-red-700 active:scale-95 transition
                             shadow-sm flex items-center gap-2 disabled:opacity-60"
                  title={`Spend ${two(fmtMEOW(boostCostWei))} MEOWT`}
                >
                  <span>🔥</span>
                  <span>{boostBusy ? "Preparing…" : "Boost"}</span>
                  <span className="opacity-80 text-xs">({two(fmtMEOW(boostCostWei))} MEOWT)</span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto w-full">
          <WaitingCard />
        </div>
      )}

      <Toast text={toast} />
    </div>
  );
}





// -------------------- Mascots / theme / header --------------------
function Mascots() {
  return (
    <>
      <div className="pointer-events-none select-none fixed top-1/2 left-0 -translate-y-1/2 z-10 hidden lg:block">
        <img
          src="/mascots/left.png"
          alt=""
          className="object-contain drop-shadow-xl opacity-100 translate-x-[-6%] max-h-[46vh] md:max-h-[54vh] xl:max-h-[60vh] w-auto"
        />
      </div>
      <div className="pointer-events-none select-none fixed top-1/2 right-0 -translate-y-1/2 z-10 hidden lg:block">
        <img
          src="/mascots/right.png"
          alt=""
          className="object-contain drop-shadow-xl opacity-100 translate-x-[6%] max-h-[46vh] md:max-h-[54vh] xl:max-h-[60vh] w-auto"
        />
      </div>
    </>
  );
}
function ThemeToggle() {
  const [dark, setDark] = React.useState(() => {
    const pref = localStorage.getItem("theme");
    if (pref) return pref === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });
  React.useEffect(() => {
    const el = document.documentElement;
    if (dark) { el.classList.add("dark"); localStorage.setItem("theme", "dark"); }
    else { el.classList.remove("dark"); localStorage.setItem("theme", "light"); }
  }, [dark]);
  return (
    <button
      onClick={() => setDark((d) => !d)}
      className="px-3 py-1.5 rounded-lg border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? "☀️" : "🌙"}
    </button>
  );
}
function WhitepaperButton() {
  return (
    <a
      href={WHITEPAPER_URL}
      target="_blank"
      rel="noreferrer"
      className="px-3 py-1.5 rounded-md text-sm font-semibold border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10 transition inline-flex items-center gap-2"
      aria-label="Open the Whitepaper"
    >
      <span>📖</span>
      <span className="hidden sm:inline">Whitepaper</span>
      <span className="sm:hidden">Docs</span>
    </a>
  );
}
function AddMeowtButton() {
  const isConnected = useUiConnected();
  if (!isConnected) return null;
  return <AddMeowtButtonInner />;
}
function AddMeowtButtonInner() {
  const { open } = useSafeWeb3Modal();
  const { data: walletClient } = useWalletClient();
  const [busy, setBusy] = React.useState(false);
  const addToken = React.useCallback(async () => {
    setBusy(true);
    try {
      if (!walletClient) { await open(); return; }
      const req: ((args: any) => Promise<any>) | undefined =
        (walletClient.transport as any)?.request || (window as any)?.ethereum?.request;
      if (!req) throw new Error("Open your wallet then try again.");

      await req({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: import.meta.env.VITE_TOKEN_ADDRESS,
            symbol: "MEOWT",
            decimals: 18,
            image: new URL("/brand/logo-meowt.png", window.location.origin).toString(),
          },
        },
      });
    } catch {
      const a = import.meta.env.VITE_TOKEN_ADDRESS;
      alert(`Add manually:\nToken: ${a}\nSymbol: MEOWT\nDecimals: 18`);
    } finally {
      setBusy(false);
    }
  }, [open, walletClient]);
  return (
    <button
      onClick={addToken}
      disabled={busy}
      className="px-3 py-1.5 rounded-md text-sm font-semibold border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10 transition inline-flex items-center gap-2"
    >
      {busy ? "Adding…" : "Add $MEOWT"}
    </button>
  );
}
function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getInjectedProviders(): any[] {
  if (typeof window === "undefined") return [];
  const { ethereum } = window as any;
  if (!ethereum) return [];

  if (Array.isArray(ethereum?.providers)) {
    return ethereum.providers.filter(Boolean);
  }

  return ethereum ? [ethereum].filter(Boolean) : [];
}

function hasMetaMaskProvider(): boolean {
  return getInjectedProviders().some((provider) => provider?.isMetaMask);
}

function hasInjectedProvider(): boolean {
  const candidates = getInjectedProviders();

  if (!candidates.length) return false;

  const indicators = [
    "isMetaMask",
    "isCoinbaseWallet",
    "isBraveWallet",
    "isRabby",
    "isOkxWallet",
    "isTrust",
    "isFrame",
    "isTally",
    "isImToken",
    "isBitKeep",
    "isTokenPocket",
    "isLedger",
  ];

  return candidates.some((provider) => {
    if (!provider) return false;
    if (indicators.some((key) => provider[key])) return true;
    const name = String(provider?.name || provider?.id || "").toLowerCase();
    return name.includes("wallet") || name.includes("metamask");
  });
}

function isWalletConnectConnector(connector: any): boolean {
  const id = connector?.id;
  const type = connector?.type;
  return id === "walletConnect" || type === "walletConnect";
}

function extractErrorMessage(error: unknown): string {
  if (!error) return "Please try again.";
  const candidate =
    (error as any)?.shortMessage || (error as any)?.message || String(error);
  return candidate || "Please try again.";
}

function ConnectControls() {
  const { status, address } = useAccount();
  const { disconnect } = useDisconnect();
  const { connectAsync, connectors } = useConnect();
  const [connecting, setConnecting] = React.useState(false);
  const [showPicker, setShowPicker] = React.useState(false);
  const [injectedDetected, setInjectedDetected] = React.useState(() => hasInjectedProvider());
  const [metaMaskDetected, setMetaMaskDetected] = React.useState(() => hasMetaMaskProvider());

  const connected = status === "connected" && !!address;
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";

  // Get available connectors
  const injectedConnector = React.useMemo(
    () => connectors.find((c) => c.id === "injected" || c.type === "injected"),
    [connectors]
  );

  const metaMaskConnector = React.useMemo(
    () =>
      connectors.find((c) => {
        const id = typeof c.id === "string" ? c.id : "";
        return id === "metaMask" || id === "metaMaskSDK" || c.type === "metaMask";
      }),
    [connectors]
  );

  const walletConnectConnector = React.useMemo(
    () => connectors.find((c) => c.id === "walletConnect"),
    [connectors]
  );

  const coinbaseConnector = React.useMemo(
    () => connectors.find((c) => c.id === "coinbaseWalletSDK"),
    [connectors]
  );

  const injectedReady = React.useMemo(() => {
    if (!injectedConnector) return false;
    return Boolean(injectedConnector.ready) || injectedDetected;
  }, [injectedConnector, injectedDetected]);

  const metaMaskReady = React.useMemo(() => {
    if (!metaMaskConnector) return false;
    return Boolean(metaMaskConnector.ready) || metaMaskDetected;
  }, [metaMaskConnector, metaMaskDetected]);

  React.useEffect(() => {
    if (injectedConnector?.ready) {
      setInjectedDetected(true);
    }
  }, [injectedConnector?.ready]);

  React.useEffect(() => {
    if (metaMaskConnector?.ready) {
      setMetaMaskDetected(true);
    }
  }, [metaMaskConnector?.ready]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const update = () => {
      if (cancelled) return;
      setInjectedDetected(hasInjectedProvider());
      setMetaMaskDetected(hasMetaMaskProvider());
    };

    update();
    const onEthereumInit = () => update();
    window.addEventListener("ethereum#initialized", onEthereumInit as any);

    const earlyCheck = window.setTimeout(update, 250);
    const lateCheck = window.setTimeout(update, 1200);

    return () => {
      cancelled = true;
      window.removeEventListener("ethereum#initialized", onEthereumInit as any);
      window.clearTimeout(earlyCheck);
      window.clearTimeout(lateCheck);
    };
  }, []);

  const isMobileDevice = React.useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    return /android|iphone|ipad|ipod/i.test(ua);
  }, []);

  React.useEffect(() => {
    if (status !== "connecting") {
      setConnecting(false);
    }
    if (status === "connected") {
      setShowPicker(false);
    }
  }, [status]);

  const handleConnect = React.useCallback(
    async (connector: any) => {
      if (!connector || connecting) return;

      setConnecting(true);
      let rejectedRetries = 0;
      let resetRetries = 0;
      try {
        console.log('[connect] Connecting with:', connector.name);
        const params = { connector, chainId: TARGET_CHAIN.id } as const;

        const attempt = async (): Promise<void> => {
          try {
            await connectAsync(params);
          } catch (error) {
            const message = extractErrorMessage(error);

            if (
              isWalletConnectConnector(connector) &&
              /connection request reset/i.test(message) &&
              resetRetries < 1
            ) {
              resetRetries += 1;
              console.warn('[connect] WalletConnect reset detected, retrying once');
              try {
                await connector.disconnect?.();
              } catch (resetError) {
                console.warn('[connect] WalletConnect reset cleanup failed:', resetError);
              }
              return attempt();
            }

            if (
              !isWalletConnectConnector(connector) &&
              /user rejected/i.test(message) &&
              rejectedRetries < 1
            ) {
              rejectedRetries += 1;
              console.warn('[connect] Received "user rejected" without prompt, retrying');
              await sleep(350);
              return attempt();
            }

            throw error;
          }
        };

        await attempt();
        setShowPicker(false);
        console.log('[connect] Connected successfully');
      } catch (error) {
        console.error('[connect] Connection failed:', error);
        const message = extractErrorMessage(error);
        let friendlyMessage = message;
        if (/provider (?:not\s)?detected/i.test(message) || /provider not found/i.test(message)) {
          friendlyMessage =
            "Provider not detected. Please open your wallet extension or pick another option.";
          setShowPicker(true);
        }
        alert(`Connection failed: ${friendlyMessage}`);
      } finally {
        setConnecting(false);
      }
    },
    [connectAsync, connecting]
  );

  // Auto-connect to injected if available and user clicks connect
  const handleQuickConnect = React.useCallback(async () => {
    if (isMobileDevice) {
      if (walletConnectConnector) {
        await handleConnect(walletConnectConnector);
        return;
      }

      if (metaMaskConnector) {
        await handleConnect(metaMaskConnector);
        return;
      }
    }

    const readyPrimaryCount =
      (metaMaskConnector && metaMaskReady ? 1 : 0) +
      (injectedConnector && injectedReady ? 1 : 0);

    if (!isMobileDevice && readyPrimaryCount > 1) {
      setShowPicker(true);
      return;
    }

    if (metaMaskConnector && metaMaskReady) {
      await handleConnect(metaMaskConnector);
      return;
    }

    if (injectedConnector && injectedReady) {
      await handleConnect(injectedConnector);
      return;
    }

    if (!metaMaskConnector && !injectedConnector && !walletConnectConnector && !coinbaseConnector) {
      alert("No wallet connectors available. Please install a wallet.");
      return;
    }

    setShowPicker(true);
  }, [
    coinbaseConnector,
    handleConnect,
    injectedConnector,
    injectedReady,
    isMobileDevice,
    metaMaskConnector,
    metaMaskReady,
    walletConnectConnector,
  ]);

  return (
    <div className="flex items-center gap-2">
      {!connected ? (
        <>
          <button
            onClick={handleQuickConnect}
            disabled={connecting}
            className="px-3 py-1.5 rounded-md font-medium bg-rose-600 text-white hover:bg-rose-700 border border-transparent disabled:opacity-50"
          >
            {connecting ? 'Connecting...' : 'Connect Wallet'}
          </button>

          {/* Wallet picker modal */}
          {showPicker && (
            <div
              className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
              onClick={() => setShowPicker(false)}
            >
              <div
                className="bg-white dark:bg-neutral-800 rounded-2xl p-6 max-w-sm w-full shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold">Connect Wallet</h3>
                  <button
                    onClick={() => setShowPicker(false)}
                    className="text-2xl leading-none opacity-60 hover:opacity-100"
                  >
                    ×
                  </button>
                </div>

                <div className="space-y-2">
                  {metaMaskConnector && (
                    <button
                      onClick={() => handleConnect(metaMaskConnector)}
                      disabled={connecting || (!metaMaskReady && !isMobileDevice)}
                      className="w-full px-4 py-3 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3 transition disabled:opacity-50"
                    >
                      <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold">
                        🦊
                      </div>
                      <div className="flex flex-col text-left">
                        <span className="font-medium">
                          {metaMaskReady || isMobileDevice
                            ? "MetaMask"
                            : "MetaMask (not detected)"}
                        </span>
                        {!metaMaskReady && !isMobileDevice && (
                          <span className="text-xs opacity-70">
                            Open the extension first, then try again.
                          </span>
                        )}
                      </div>
                    </button>
                  )}

                  {injectedConnector && (
                    <button
                      onClick={() => handleConnect(injectedConnector)}
                      disabled={connecting || !injectedReady}
                      className="w-full px-4 py-3 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3 transition disabled:opacity-50"
                    >
                      <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center text-white font-bold">
                        🧩
                      </div>
                      <div className="flex flex-col text-left">
                        <span className="font-medium">
                          {injectedReady ? "Browser Wallet" : "Browser Wallet (not detected)"}
                        </span>
                        {injectedReady && (
                          <span className="text-xs opacity-70">Rabby, Frame, OKX, …</span>
                        )}
                      </div>
                    </button>
                  )}

                  {walletConnectConnector && (
                    <button
                      onClick={() => handleConnect(walletConnectConnector)}
                      disabled={connecting}
                      className="w-full px-4 py-3 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3 transition disabled:opacity-50"
                    >
                      <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white font-bold">
                        🔗
                      </div>
                      <span className="font-medium">WalletConnect</span>
                    </button>
                  )}

                  {coinbaseConnector && (
                    <button
                      onClick={() => handleConnect(coinbaseConnector)}
                      disabled={connecting}
                      className="w-full px-4 py-3 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3 transition disabled:opacity-50"
                    >
                      <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold">
                        CB
                      </div>
                      <span className="font-medium">Coinbase Wallet</span>
                    </button>
                  )}

                  {!injectedConnector && !walletConnectConnector && !coinbaseConnector && (
                    <p className="text-sm text-center opacity-60 py-4">
                      No wallet connectors available. Please install a wallet extension.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <button
            onClick={() => setShowPicker(true)}
            className="px-3 py-1.5 rounded-md font-medium border border-rose-300/50 bg-rose-50 hover:bg-rose-100 dark:border-rose-300/30 dark:bg-rose-900/30 dark:hover:bg-rose-900/40 text-rose-900 dark:text-rose-100"
          >
            {short}
          </button>
          <button
            onClick={() => disconnect()}
            className="px-3 py-1.5 rounded-md font-medium bg-rose-600 text-white hover:bg-rose-700 border border-transparent"
          >
            Disconnect
          </button>
        </>
      )}
    </div>
  );
}

function ConnectBar() {
  return (
    <div className="w-full flex justify-center">
      <div className="flex items-center gap-3 flex-wrap justify-center max-w-screen-md mx-auto mt-2 md:mt-3">
        <WhitepaperButton />
        <ConnectControls />
        <ThemeToggle />
        <AddMeowtButton />
        <RewardsHeaderButton /> 
      </div>
    </div>
  );
}


// -------------------- Toast --------------------
function Toast({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[100]">
      <div className="px-4 py-2 rounded-full bg-black/90 text-white text-sm shadow-lg">{text}</div>
    </div>
  );
}

// -------------------- Refetchers --------------------
function WalletEventRefetch() {
  const qc = useQueryClient();
  React.useEffect(() => {
    const refresh = () => nudgeQueries(qc);
    const unwatchAcc = watchAccount(wagmiConfig, {
      onChange: refresh,
    });
    const unwatchChain = watchChainId(wagmiConfig, {
      onChange: refresh,
    });
    return () => { unwatchAcc(); unwatchChain(); };
  }, [qc]);
  return null;
}

function BlockRefresher() {
  const qc = useQueryClient();
  const { data: blockNumber } = useBlockNumber({
    watch: true,
    query: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      keepPreviousData: false,
    } as any,
  });

  const lastBlockRef = React.useRef<bigint | null>(null);
  React.useEffect(() => {
    if (blockNumber === undefined || blockNumber === null) return;
    if (lastBlockRef.current === blockNumber) return;
    lastBlockRef.current = blockNumber;
    nudgeQueries(qc, [0, 350, 1400]);
  }, [blockNumber, qc]);

  return null;
}


// -------------------- Claims: Bar + Modal (strict, de-ghosted) --------------------





// -------------------- Prefetch: required stake --------------------
function PrefetchRequired() {
  const snap = useSnap();
  const { status, address } = useAccount();
  const isConnected = status === "connected" && !!address;
  const enabled = isConnected && Boolean((snap as any)?.show);
  useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "requiredStakeToReplace",
    query: {
      enabled,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      placeholderData: (p) => p,
    },
  });
  return null;
}

// -------------------- Page shell --------------------
function AppInner() {
  const { status, address } = useAccount();
  const isConnected = status === "connected" && !!address;
  const myAddr = (address ?? "").toLowerCase();
  const live = useLiveChainId();
  const onTarget = live.onTarget;

  const snap = useGameSnapshot();
  const hasActive = Boolean((snap as any)?.show) && ((snap as any)?.rem ?? 0n) > 0n;

  const msgId: bigint = (snap as any)?.id ?? 0n;
  const rawAuthor = ((snap as any)?.m?.author ?? (snap as any)?.m?.[1]) as string | undefined;
  const stableAuthor = useStableAuthor(msgId, rawAuthor);
  const authorKnown = looksAddress(stableAuthor || rawAuthor);
  const activeAuthorLc = (stableAuthor || rawAuthor || "").toLowerCase();
  const iAmAuthor = !!myAddr && !!authorKnown && myAddr === activeAuthorLc;

  // Brand the tab
  useTitle("HearMeOwT");

  return (
    <div className="min-h-screen bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(244,63,94,0.12),transparent_70%)] bg-gradient-to-b from-rose-50 to-white dark:from-neutral-950 dark:to-neutral-900 text-neutral-900 dark:text-neutral-100">
      <InstallBanner />
      <WalletEventRefetch />
      <BlockRefresher />

      <header className="py-6">
        <div className="max-w-3xl mx-auto flex flex-col items-center gap-4 px-3">
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-center flex items-center justify-center gap-2">
            HearMeOwT
            <img src="/brand/logo-meowt.png" alt="$MEOWT" className="w-8 h-8 md:w-10 md:h-10 inline-block align-middle" />
          </h1>
          <ConnectBar />
        </div>

        {isConnected && !onTarget ? (
          <div className="mx-auto max-w-3xl px-3">
            <div className="mt-2 rounded-lg border border-rose-300/40 bg-rose-100/70 dark:bg-rose-900/40 text-rose-800 dark:text-rose-50 px-3 py-2 text-sm text-center">
              You’re connected to the wrong network. Please switch to <span className="font-semibold">{live.targetName}</span>.
            </div>
          </div>
        ) : null}
      </header>

      <RewardsDock />

      <Mascots />

      <main className="max-w-3xl mx-auto px-3 pb-14">
        <GameSnapshotProvider>
          <PrefetchRequired />
          <section className="relative z-20 mt-4 flex flex-col gap-6 items-stretch">
            {/* Permanent expiration counter lives above the message box */}
            <PermanentTimerBar />
            <ActiveCard />
            {isConnected && onTarget && hasActive && authorKnown && !iAmAuthor ? <ReplaceBox /> : null}
            {isConnected && onTarget ? <PostBox /> : null}
            {!isConnected ? (
              <div className="text-center text-xs opacity-70 pt-6">
                Connect your wallet to {live.targetName} to post, vote, or replace.
              </div>
            ) : null}
            {isConnected && onTarget && hasActive && authorKnown && iAmAuthor ? (
              <div className="text-center text-xs opacity-70">
                You’re the current author. You can post again once a new message replaces yours or it expires.
              </div>
            ) : null}
          </section>
        </GameSnapshotProvider>
      </main>
    </div>
  );
}

// -------------------- App root --------------------
export default function App() {
  // Ensure the tab title is always correct, even if cached HTML had an old one.
  React.useEffect(() => {
    const desired = "HearMeOwT";
    if (typeof document !== "undefined" && document.title !== desired) {
      document.title = desired;
    }
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <NetworkQuietProvider>
          <W3MDebug />
          <AppInner />
        </NetworkQuietProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}