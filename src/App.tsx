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
import { watchAccount, watchChainId, getAccount, reconnect } from "wagmi/actions";

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
      refetchOnMount: true,
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
  delays: number[] = [0, 500]
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

type MaskPersisted = { until: number; messageId?: string };

function readMaskState(key: string): MaskPersisted {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { until: 0 };
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        const until = Number.isFinite(parsed?.until)
          ? Math.max(0, Math.floor(parsed.until))
          : 0;
        const msgId = typeof parsed?.messageId === "string" ? parsed.messageId : undefined;
        return {
          until,
          messageId: msgId && msgId !== "0" ? msgId : undefined,
        };
      } catch {
        /* fall through to numeric parse */
      }
    }
    const parsedNum = Number.parseInt(trimmed, 10);
    const until = Number.isFinite(parsedNum) ? Math.max(0, parsedNum) : 0;
    return { until };
  } catch {
    return { until: 0 };
  }
}

// ---- Window times persistence (refresh resilience) ----
const WINDOW_TIMES_KEY = "meowt:window:times";
type WindowTimes = {
  messageId: string;
  exposureEnd?: number;
  gloryEnd?: number;
  immEnd?: number;
  timestamp: number;
};

function readWindowTimes(messageId: bigint): WindowTimes | null {
  if (!messageId || messageId === 0n) return null;
  try {
    const raw = localStorage.getItem(WINDOW_TIMES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WindowTimes;
    if (parsed.messageId !== String(messageId)) return null;
    if (Date.now() - parsed.timestamp > 5 * 60 * 1000) return null; // TTL 5m
    return parsed;
  } catch { return null; }
}

function writeWindowTimes(
  messageId: bigint,
  exposureEnd: number,
  gloryEnd: number,
  immEnd: number
) {
  if (!messageId || messageId === 0n) return;
  try {
    const payload: WindowTimes = {
      messageId: String(messageId),
      exposureEnd: exposureEnd > 0 ? exposureEnd : undefined,
      gloryEnd: gloryEnd > 0 ? gloryEnd : undefined,
      immEnd: immEnd > 0 ? immEnd : undefined,
      timestamp: Date.now(),
    };
    localStorage.setItem(WINDOW_TIMES_KEY, JSON.stringify(payload));
  } catch {}
}

const MASK_EVENT = "meowt:mask:update";
type MaskEventDetail = { key: string; until: number; messageId?: string | null };

function emitMaskUpdate(key: string, until: number, messageId?: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<MaskEventDetail>(MASK_EVENT, {
        detail: { key, until, messageId: messageId ?? null },
      })
    );
  } catch {
    // Older browsers might not support the generic signature
    window.dispatchEvent(
      new CustomEvent(MASK_EVENT, { detail: { key, until, messageId: messageId ?? null } })
    );
  }
}

type MaskWriteOptions = { messageId?: bigint | number | string | null };

function normalizeMaskMessageId(raw: MaskWriteOptions["messageId"]): string | undefined {
  if (raw === null || typeof raw === "undefined") return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed && trimmed !== "0" ? trimmed : undefined;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return undefined;
    const asInt = Math.floor(raw);
    return asInt > 0 ? String(asInt) : undefined;
  }
  try {
    const asBig = BigInt(raw);
    return asBig > 0n ? asBig.toString() : undefined;
  } catch {
    return undefined;
  }
}

function writeMaskUntil(key: string, until: number, opts?: MaskWriteOptions) {
  const normalizedUntil = Number.isFinite(until) ? Math.max(0, Math.floor(until)) : 0;
  const messageId = normalizeMaskMessageId(opts?.messageId);
  try {
    if (normalizedUntil > 0) {
      const payload: MaskPersisted = { until: normalizedUntil };
      if (messageId) payload.messageId = messageId;
      localStorage.setItem(key, JSON.stringify(payload));
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
  emitMaskUpdate(key, normalizedUntil, messageId);
}

function parseMaskMessageId(raw?: string | null): bigint {
  if (!raw) return 0n;
  try {
    const big = BigInt(raw);
    return big > 0n ? big : 0n;
  } catch {
    return 0n;
  }
}

// Persisted immunity end (seconds) keyed by message id
const IMMUNITY_KEY = "meowt:imm:end";




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
  const secs = Math.max(0, Math.floor(secondsLeft));
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
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <img
            src={imgUrl}
            alt=""
            className="max-w-full max-h-full w-full h-full object-contain pointer-events-none select-none"
            draggable={false}
          />
        </div>
      )}
      <div
        className="absolute left-0 right-0 flex justify-center"
        style={{ top: "calc(16px + env(safe-area-inset-top, 0px))" }}
      >
        <div className="px-3 py-1.5 rounded-full text-sm font-semibold bg-black/85 text-white shadow-md">
          {message} {secs}s
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
  boostedRem = 0,
  timerOverride,
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
  boostedRem?: number;
  timerOverride?: number;
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
  React.useEffect(() => { setTick(0); }, [lockKind, boostedRem, timerOverride]);
  React.useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const left = Math.max(0, Math.floor((lockLeft ?? 0) - tick));
  const boostSeconds = Math.max(0, Math.floor((boostedRem ?? 0) - tick));
  const isBoost = boostSeconds > 0;
  const isGlory = lockKind === "glory" && left > 0;
  const locked = lockKind !== "none" && left > 0;
  // If a boost is active, the badge should reflect the boost time even during immunity.
  const timerLeft = Number.isFinite(timerOverride) && (timerOverride ?? 0) > 0
    ? Math.max(0, Math.floor((timerOverride as number) - tick))
    : (isBoost ? boostSeconds : (left > 0 ? left : 0));

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

      {timerLeft > 0 && (
        <div className={`absolute top-2 right-2 z-20 px-2 py-0.5 rounded-md text-xs font-semibold ${
          isGlory ? "bg-amber-500 text-black" : "bg-red-600 text-white"
        } shadow flex items-center gap-1.5`}>
          <span>⏳</span><span>{fmtClock(timerLeft)}</span>
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
  const INIT_HOLD_MS = 400;
  const ID_CHANGE_HOLD_MS = 700;
  const OPTIMISTIC_SHOW_MS = 1100;
  const ID_PENDING_MAX_HOLD_MS = 1800;
  const SHOW_CUSHION = 1;
  const PRE_GLORY_GUARD_SECS = 3;
  const { quiet } = useQuiet();

  // Detect BroadcastChannel support (gate leader mode)
  const bcSupported =
    typeof window !== "undefined" && typeof (window as any).BroadcastChannel === "function";
  // Simple lease-based leader election using localStorage (10s lease).
  function usePollLeadership(active: boolean) {
    const [isLeader, setIsLeader] = React.useState(true);
    React.useEffect(() => {
      if (!active) { setIsLeader(true); return; } // fail-open: all poll if BC unsupported
      const key = "meowt:poll-leader";
      const leaseMs = 10_000;

      const tick = () => {
        const now = Date.now();
        try {
          const raw = localStorage.getItem(key);
          const until = raw ? parseInt(raw, 10) : 0;
          if (!until || now > until) {
            localStorage.setItem(key, String(now + leaseMs));
            setIsLeader(true);
            return;
          }
          const amLeader = now + 3000 < until;
          if (amLeader) {
            // Renew our lease
            localStorage.setItem(key, String(now + leaseMs));
          }
          setIsLeader(amLeader);
        } catch {
          setIsLeader(true); // fail-open
        }
      };

      tick();
      const iv = setInterval(tick, 4000);
      const onVis = () => document.visibilityState === "visible" && tick();
      document.addEventListener("visibilitychange", onVis);
      window.addEventListener("focus", tick, true);
      return () => {
        clearInterval(iv);
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("focus", tick, true);
      };
    }, [active]);
    return isLeader;
  }
  const isLeader = usePollLeadership(bcSupported);

  // -------- Boot anti-ghost settings --------
  const BOOT_MODE_MS = 2500;
  const APP_BOOT_TS = React.useRef(Date.now()).current;
  const booting = Date.now() - APP_BOOT_TS < BOOT_MODE_MS;

  // --- Active id (stable via placeholderData) + zero-id boot grace ---
  const ZERO_ID_GRACE_MS = 700;
  const zeroIdGraceUntilRef = React.useRef<number>(0);
  const idPendingSinceRef = React.useRef<number>(0);

  const {
    data: id,
    error: idError,
    isPending: idPending,
    isFetching: idFetching,
  } = useReadContract({
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

  // --- Refresh/ID discovery latches (prevents "waiting" flash on reload) ---
  const [idKnown, setIdKnown] = React.useState(false);
  const [refreshGate, setRefreshGate] = React.useState<boolean>(() => {
    try {
      const navs = (performance as any)?.getEntriesByType?.("navigation");
      if (navs && navs[0] && typeof navs[0].type === "string") return navs[0].type === "reload";
      const legacy = (performance as any)?.navigation?.type;
      return legacy === 1; // 1 === TYPE_RELOAD (legacy)
    } catch { return false; }
  });
  React.useEffect(() => {
    if (!idKnown && (typeof id === "bigint" || !!idError)) {
      setIdKnown(true);
      setRefreshGate(false);
    }
  }, [id, idError, idKnown]);

  // Reset zero-id grace when we get a non-zero ID
  React.useEffect(() => {
    if (!zeroIdGraceUntilRef.current) {
      zeroIdGraceUntilRef.current = Date.now() + ZERO_ID_GRACE_MS;
    }
    if (id && id !== 0n) {
      zeroIdGraceUntilRef.current = 0;
    }
  }, [id, ZERO_ID_GRACE_MS]);

  const nowMs = Date.now();
  
  // Track pending state, but clear it once we have ANY data (including 0n)
  React.useEffect(() => {
    if (idPending && !idError && typeof id === 'undefined') {
      // Truly pending - no data yet
      if (!idPendingSinceRef.current) {
        idPendingSinceRef.current = nowMs;
      }
    } else {
      // We have data (even if it's 0n) or an error - not pending anymore
      idPendingSinceRef.current = 0;
    }
  }, [idPending, idError, id, nowMs]);

  const idPendingHoldActive =
    idPending &&
    !idError &&
    typeof id === 'undefined' &&
    idPendingSinceRef.current > 0 &&
    nowMs - idPendingSinceRef.current < ID_PENDING_MAX_HOLD_MS;

  const zeroIdGraceActive =
    id === 0n && 
    zeroIdGraceUntilRef.current > 0 && 
    nowMs < zeroIdGraceUntilRef.current &&
    !idFetching; // Don't apply grace if actively fetching

  const waitingForId = idPendingHoldActive || zeroIdGraceActive;
  const hasId = typeof id === "bigint" && id !== 0n;
  const idBig = hasId ? (id as bigint) : 0n;

  // -------- Batched reads --------
  const { data: raw, isFetching: rawFetching } = useReadContracts({
    allowFailure: true,
    contracts: hasId
      ? [
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "messages", args: [idBig] },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "endTime", args: [idBig] },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "requiredStakeToReplace" },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "voteFeeLike" },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "voteFeeDislike" },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "boostedRemaining" },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "boostCooldownRemaining" },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "isReplaceBlocked" },
          { address: GAME as `0x${string}`, abi: GAME_ABI, functionName: "windows" },
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
      enabled: hasId && !quiet && isLeader,
      staleTime: 0,
      // IMPORTANT: on focus, fetch immediately so the tab "catches up"
      refetchOnWindowFocus: true,
      refetchInterval: 2500,
    },
  });

  const { data: gloryRemChainBN } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "gloryRemaining",
    query: {
      enabled: hasId && !quiet && isLeader,
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchInterval: 2500,
    },
  });

  // Live chain signal that glory is truly active
  const gRemLive = Number(gloryRemChainBN ?? 0n) > 0;

  // Live boost/cooldown windows (1s polling, focus re-sync)
  const { data: boostedRemLiveBN } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "boostedRemaining",
    query: {
      enabled: hasId && !quiet && isLeader,
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchInterval: 2500,
      placeholderData: (p) => p,
    },
  });

  const { data: boostCooldownLiveBN } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "boostCooldownRemaining",
    query: {
      enabled: hasId && !quiet && isLeader,
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchInterval: 2500,
      placeholderData: (p) => p,
    },
  });

  // Live boost cost latch
  const { data: boostCostLive } = useReadContract({
    address: GAME as `0x${string}`,
    abi: GAME_ABI,
    functionName: "boostCost",
    query: { 
      staleTime: 0, 
      refetchOnWindowFocus: false, 
      placeholderData: (prev) => prev, 
      enabled: !quiet 
    },
  });

  const take = (arr: any[] | undefined, i: number) =>
    arr?.[i] && typeof arr[i] === "object" && "result" in (arr[i] as any)
      ? (arr[i] as any).result
      : undefined;

  const m = hasId ? (take(raw as any[], 0) ?? null) : null;
  const endTsBN = hasId ? ((take(raw as any[], 1) ?? 0n) as bigint) : 0n;
  const feeLike = hasId ? (take(raw as any[], 3) as bigint | undefined) : undefined;
  const feeDislike = hasId ? (take(raw as any[], 4) as bigint | undefined) : undefined;
  const boostedRemBN = hasId ? ((take(raw as any[], 5) ?? 0n) as bigint) : 0n;
  const boostCooldownBN = hasId ? ((take(raw as any[], 6) ?? 0n) as bigint) : 0n;
  const replaceBlocked = hasId ? Boolean(take(raw as any[], 7)) : false;
  const winsTuple = hasId
    ? (take(raw as any[], 8) as readonly [bigint, bigint, bigint] | undefined)
    : undefined;

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

  // Refs and latches
  const lastIdRef = React.useRef<bigint>(0n);
  const exposureEndRef = React.useRef<number>(0);
  const gloryEndRef = React.useRef<number>(0);
  const boostEndRef = React.useRef<number>(0);
  const cooldownEndRef = React.useRef<number>(0);
  const immEndRef = React.useRef<number>(0);
  const showUntilRef = React.useRef<number>(0);
  const idHoldUntilRef = React.useRef<number>(0);
  const lastStartRef = React.useRef<number>(0);
  const lastContentKeyRef = React.useRef<string>("");
  const gloryGuardUntilRef = React.useRef<number>(0); // stores chain *seconds*
  const gloryEntryLatchRef = React.useRef<boolean>(false);
  (globalThis as any).__meowtGloryEntryLatchRef = gloryEntryLatchRef;

  // Do not anchor from gloryRemaining while the *current* message is still in exposure,
  // or while our post-guard is active. This prevents early jumps into glory at post time.
  function suppressGloryAnchorNow(): boolean {
    if (!idBig || idBig === 0n) return true; // nothing meaningful to anchor
    const idMatches = lastIdRef.current === idBig;
    // Exposure is "anchored" once we know exposureEnd for this id
    const exposureAnchoredNow = idMatches && exposureEndRef.current > 0;
    const gloryPreOkNow = idMatches && gloryEntryLatchRef.current;
    const chainNowS = computeChainNow();
    const exposureLeftNow = exposureAnchoredNow
      ? Math.max(0, exposureEndRef.current - chainNowS)
      : 0;
    const guardActiveNow = chainNowS < gloryGuardUntilRef.current; // seconds vs seconds
    // NEW: do not anchor from gloryRemaining until we *know* exposureEnd for this id,
    // and only after exposure has actually reached 0.
    if (!exposureAnchoredNow) return true;
    if (!gloryPreOkNow) return true;
    return guardActiveNow || exposureLeftNow > 0;
  }

  // We need qc/publicClient and nowSec earlier for sync hooks below
  const qc = useQueryClient();
  const publicClient = usePublicClient();
  const [nowSec, setNowSec] = React.useState(() => computeChainNow());
  React.useEffect(() => {
    const iv = setInterval(
      () => setNowSec((prev) => Math.max(prev, computeChainNow())),
      500
    );
    return () => clearInterval(iv);
  }, [computeChainNow]);

  // -------- Cross-tab sync (BroadcastChannel) --------
  const bcRef = React.useRef<BroadcastChannel | null>(null);

  const lastAnchorFromPeer = React.useRef<number>(0);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      bcRef.current = new BroadcastChannel("meowt-sync-v1");
    } catch {
      bcRef.current = null;
    }
    const onMsg = (evt: MessageEvent) => {
      const data: any = evt?.data;
      if (!data || typeof data !== "object") return;
      if (data.t === "anchor" && Number.isFinite(data.epoch) && Number.isFinite(data.at)) {
        const at = Number(data.at);
        if (at > lastAnchorFromPeer.current) {
          lastAnchorFromPeer.current = at;
          chainNowRef.current = { epoch: Number(data.epoch), fetchedAt: at };
          setNowSec((prev) => Math.max(prev, computeChainNow()));
          nudgeQueries(qc, [0, 500]);
        }
      } else if (data.t === "nudge") {
        nudgeQueries(qc, [0, 500]);
      } else if (data.t === "boostEnd" && Number.isFinite(data.end)) {
        const end = Number(data.end);
        if (end > boostEndRef.current) {
          boostEndRef.current = end;
          if (idBig && idBig !== 0n) writeBoostEndLS(idBig, end);
        }
        nudgeQueries(qc, [0, 300]);
      } else if (data.t === "cooldownEnd" && Number.isFinite(data.end)) {
        cooldownEndRef.current = Math.max(cooldownEndRef.current, Number(data.end));
        nudgeQueries(qc, [0, 300]);
      } else if (data.t === "immEnd" && Number.isFinite(data.end)) {
        // only ever extend, never shrink
        immEndRef.current = Math.max(immEndRef.current, Number(data.end));
        nudgeQueries(qc, [0, 200]);
      }
    };
    bcRef.current?.addEventListener("message", onMsg as any);
    return () => {
      bcRef.current?.removeEventListener("message", onMsg as any);
      bcRef.current?.close();
      bcRef.current = null;
    };
  }, [computeChainNow, qc, idBig]);

  function broadcastAnchor(epoch: number) {
    try {
      bcRef.current?.postMessage({ t: "anchor", epoch, at: Date.now() });
    } catch {}
  }
  function broadcastNudge() {
    try {
      bcRef.current?.postMessage({ t: "nudge" });
    } catch {}
  }
  function broadcastBoostEnd(end: number) {
    try {
      bcRef.current?.postMessage({ t: "boostEnd", end, at: Date.now() });
    } catch {}
  }
  function broadcastCooldownEnd(end: number) {
    try {
      bcRef.current?.postMessage({ t: "cooldownEnd", end, at: Date.now() });
    } catch {}
  }
  function broadcastImmEnd(end: number) {
    try {
      bcRef.current?.postMessage({ t: "immEnd", end, at: Date.now() });
    } catch {}
  }

  function boostKey(id: bigint | number | string) {
    return `meowt:boostEnd:${String(id)}`;
  }
  function readBoostEndLS(id: bigint): number {
    try {
      const v = localStorage.getItem(boostKey(id));
      const n = v ? Number(v) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  function writeBoostEndLS(id: bigint, endEpochSec: number) {
    if (!id || id === 0n || !Number.isFinite(endEpochSec)) return;
    try {
      localStorage.setItem(boostKey(id), String(Math.max(0, Math.floor(endEpochSec))));
    } catch {}
  }

  // Explicit rehydration gate (prevents UI flashing before persisted state loads)
  const [rehydrationComplete, setRehydrationComplete] = React.useState(true);
  const rehydrationStartedRef = React.useRef(false);
  const lastRehydratedIdRef = React.useRef<bigint>(0n);

  React.useEffect(() => {
    const currentId = hasId ? idBig : 0n;

    if (rehydrationStartedRef.current) return;
    if (lastRehydratedIdRef.current === currentId && rehydrationComplete) return;

    if (!hasId || !currentId) {
      lastRehydratedIdRef.current = currentId;
      if (!rehydrationComplete) setRehydrationComplete(true);
      return;
    }

    rehydrationStartedRef.current = true;
    setRehydrationComplete(false);

    let cancelled = false;
    (async () => {
      try {
        const nowS = Math.floor(Date.now() / 1000);

        const persisted = readWindowTimes(currentId);
        if (persisted) {
          if (persisted.exposureEnd)
            exposureEndRef.current = Math.max(exposureEndRef.current, persisted.exposureEnd);
          if (persisted.gloryEnd)
            gloryEndRef.current = Math.max(gloryEndRef.current, persisted.gloryEnd);
          if (persisted.immEnd)
            immEndRef.current = Math.max(immEndRef.current, persisted.immEnd);
        }

        const persistedBoost = readBoostEndLS(currentId);
        if (persistedBoost > nowS) {
          boostEndRef.current = Math.max(boostEndRef.current, persistedBoost);
        }

        const persistedImm = readMaskState(IMMUNITY_KEY);
        const immId = parseMaskMessageId(persistedImm?.messageId);
        if (immId === currentId && Number.isFinite(persistedImm?.until) && persistedImm!.until > nowS) {
          immEndRef.current = Math.max(immEndRef.current, persistedImm!.until);
        }

        if (!cancelled) {
          lastRehydratedIdRef.current = currentId;
          setRehydrationComplete(true);
        }
      } catch (err) {
        console.error("Rehydration failed:", err);
        if (!cancelled) {
          lastRehydratedIdRef.current = currentId;
          setRehydrationComplete(true);
        }
      } finally {
        rehydrationStartedRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasId, idBig, rehydrationComplete]);

  // Fast prime of window ends via chain reads (refresh resilience)
  React.useEffect(() => {
    if (!hasId || !publicClient || !idBig) return;
    let cancelled = false;

    (async () => {
      try {
        const [endBn, wins, gloryRemBn] = await Promise.all([
          publicClient
            .readContract({
              address: GAME as `0x${string}`,
              abi: GAME_ABI,
              functionName: "endTime",
              args: [idBig],
            })
            .catch(() => 0n),
          publicClient
            .readContract({
              address: GAME as `0x${string}`,
              abi: GAME_ABI,
              functionName: "windows",
            })
            .catch(() => null),
          publicClient
            .readContract({
              address: GAME as `0x${string}`,
              abi: GAME_ABI,
              functionName: "gloryRemaining",
            })
            .catch(() => 0n),
        ]);
        if (cancelled) return;

        const eNum = Number(endBn ?? 0n);
        const gWin = Number((wins as any)?.[1] ?? 0n);
        const gloryRem = Number(gloryRemBn ?? 0n);

        if (eNum > 0) {
          exposureEndRef.current = Math.max(exposureEndRef.current, eNum);
          if (gWin > 0) {
            const predictedGloryEnd = eNum + gWin;
            gloryEndRef.current = Math.max(gloryEndRef.current, predictedGloryEnd);
            showUntilRef.current = Math.max(showUntilRef.current, predictedGloryEnd);
            if (gloryRem > 0) {
              const gloryAnchorEpoch = predictedGloryEnd - gloryRem;
              chainNowRef.current = { epoch: gloryAnchorEpoch, fetchedAt: Date.now() };
              setNowSec((prev) => Math.max(prev, computeChainNow()));
              broadcastAnchor(gloryAnchorEpoch);
            }
          }
        }
        if (idBig && exposureEndRef.current > 0) {
          writeWindowTimes(idBig, exposureEndRef.current, gloryEndRef.current, immEndRef.current);
        }
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [hasId, idBig, publicClient, computeChainNow]);

  // Rehydrate persisted immunity end for this message id (instant UI on refresh)
  React.useEffect(() => {
    if (!hasId || !idBig) return;
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const persisted = readMaskState(IMMUNITY_KEY);
      const pid = parseMaskMessageId(persisted?.messageId);
      if (pid === idBig && Number.isFinite(persisted?.until) && persisted!.until > nowS) {
        immEndRef.current = Math.max(immEndRef.current, persisted!.until);
      }
    } catch {}
  }, [hasId, idBig]);

  // Boot & id-change holds
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
      lastStartRef.current = 0;
      lastContentKeyRef.current = "";
      gloryEntryLatchRef.current = false;

      if (!booting) {
        showUntilRef.current = Math.max(
          showUntilRef.current,
          Math.floor(Date.now() / 1000) + Math.ceil(OPTIMISTIC_SHOW_MS / 1000),
        );
      }

      idHoldUntilRef.current = Date.now() + ID_CHANGE_HOLD_MS; // (hold stays in ms)

      // Hydrate boost end from LS to avoid "reset to max duration" after refresh.
      const persisted = readBoostEndLS(idBig);
      const nowS = computeChainNow();
      if (persisted > nowS) {
        boostEndRef.current = Math.max(boostEndRef.current, persisted);
      }
    }
  }, [hasId, idBig, booting, OPTIMISTIC_SHOW_MS, ID_CHANGE_HOLD_MS, computeChainNow]);

  React.useEffect(() => {
    if (!hasId || !idBig) return;
    const persisted = readWindowTimes(idBig);
    if (persisted) {
      if (persisted.exposureEnd)
        exposureEndRef.current = Math.max(exposureEndRef.current, persisted.exposureEnd);
      if (persisted.gloryEnd)
        gloryEndRef.current = Math.max(gloryEndRef.current, persisted.gloryEnd);
      if (persisted.immEnd)
        immEndRef.current = Math.max(immEndRef.current, persisted.immEnd);
    }
  }, [hasId, idBig]);

  React.useEffect(() => {
    if (hasId) return;
    lastIdRef.current = 0n;
    exposureEndRef.current = 0;
    gloryEndRef.current = 0;
    boostEndRef.current = 0;
    cooldownEndRef.current = 0;
    immEndRef.current = 0;
    showUntilRef.current = 0;
    lastStartRef.current = 0;
    lastContentKeyRef.current = "";
    gloryGuardUntilRef.current = 0;
    gloryEntryLatchRef.current = false;
  }, [hasId]);

  React.useEffect(() => {
    if (!hasId) return;
    if (startTime <= 0) return;
    // Track content (not used as a guard anymore, but still useful to keep current)
    const rawContentHash = (m?.contentHash ?? m?.[6] ?? "0x") as string;
    const rawUri = (m?.uri ?? m?.[5] ?? "") as string;
    const rawAuthor = (m?.author ?? m?.[1]) as string | undefined;
    const msgContentKey = `${rawContentHash || "0x"}|${rawUri || ""}|${rawAuthor || ""}`;
    lastContentKeyRef.current = msgContentKey;

    if (lastStartRef.current === startTime) return;
    const seenBefore = lastStartRef.current > 0;
    lastStartRef.current = startTime;
    if (!seenBefore) return; // first hydrate, not a replacement transition

    // --- Replacement detected (same id, new start) ---
    const nowEpoch = Math.floor(Date.now() / 1000);
    const predictedExposureEnd = startTime && B0secs ? startTime + B0secs : 0;
    const predictedGloryEnd = predictedExposureEnd > 0 && winGlory
      ? predictedExposureEnd + winGlory
      : 0;
    const predictedImmEnd = startTime && winPostImm ? startTime + winPostImm : 0;

    // Reset dynamic windows and seed fresh ends so all devices agree instantly.
    gloryEntryLatchRef.current = false;
    exposureEndRef.current = predictedExposureEnd || 0;
    gloryEndRef.current = predictedGloryEnd || 0;
    boostEndRef.current = 0;
    cooldownEndRef.current = 0;
    if (predictedImmEnd > 0) {
      immEndRef.current = Math.max(immEndRef.current, predictedImmEnd);
      // Latch the post/replace guard so we cannot enter glory during the new immunity.
      gloryGuardUntilRef.current = Math.max(gloryGuardUntilRef.current, predictedImmEnd);
      try { writeMaskUntil(IMMUNITY_KEY, predictedImmEnd, { messageId: idBig }); } catch {}
      broadcastImmEnd(predictedImmEnd);
    } else {
      immEndRef.current = 0;
    }

    // Clear previous anchors and force immediate re-anchor from exposure end
    chainNowRef.current = { epoch: 0, fetchedAt: 0 };
    // Set a temporary anchor to startTime so nowSec matches chain time during immunity window
    if (startTime && startTime > 0) {
      const tempAnchorEpoch = startTime - 1; // just under new exposure start
      chainNowRef.current = { epoch: tempAnchorEpoch, fetchedAt: Date.now() };
    }
    setNowSec(nowEpoch);
    broadcastNudge();
    nudgeQueries(qc, [0, 150, 400]);

    // Visual hold to avoid any flicker while reads settle
    if (!booting) {
      showUntilRef.current = Math.max(
        showUntilRef.current,
        nowEpoch + Math.ceil(OPTIMISTIC_SHOW_MS / 1000),
      );
    }
    idHoldUntilRef.current = Date.now() + ID_CHANGE_HOLD_MS;

    // Persist new window ends so refresh immediately restores the correct state.
    if (idBig && idBig !== 0n) {
      writeWindowTimes(idBig, exposureEndRef.current, gloryEndRef.current, immEndRef.current);
    }
  }, [hasId, idBig, startTime, B0secs, winGlory, winPostImm, booting, OPTIMISTIC_SHOW_MS, ID_CHANGE_HOLD_MS, qc]);

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
    setNowSec((prev) => Math.max(prev, computeChainNow()));
    broadcastAnchor(anchorEpoch);
  }, [remChainBN, endTsNum, startTime, B0secs, computeChainNow]);

  // NEW: anchor chain "now" during glory so all tabs/devices stay in lockstep
  React.useEffect(() => {
    const gRem = Number(gloryRemChainBN ?? 0n);
    if (!Number.isFinite(gRem) || gRem <= 0) return;

    // Predicted end of glory from message data (authoritative & same everywhere)
    const predEnd =
      startTime && B0secs && winGlory ? startTime + B0secs + winGlory : 0;
    if (predEnd <= 0) return;

    // IMPORTANT: do not anchor from glory while still in exposure or guard
    if (suppressGloryAnchorNow()) return;

    // If gloryRemaining == gRem, then chain "now" ≈ predEnd - gRem
    const anchorEpoch = predEnd - gRem;
    chainNowRef.current = { epoch: anchorEpoch, fetchedAt: Date.now() };
    setNowSec((prev) => Math.max(prev, computeChainNow()));
    broadcastAnchor(anchorEpoch); // keep other tabs/devices synced
  }, [gloryRemChainBN, startTime, B0secs, winGlory, computeChainNow]);

  // Glory window
  React.useEffect(() => {
    const predicted = startTime && B0secs && winGlory ? startTime + B0secs + winGlory : 0;
    if (predicted > 0) gloryEndRef.current = Math.max(gloryEndRef.current, predicted);
  }, [startTime, B0secs, winGlory]);

  React.useEffect(() => {
    const chainGlory = Number(gloryRemChainBN ?? 0n);
    if (chainGlory > 0) {
      const predEnd =
        startTime && B0secs && winGlory
          ? startTime + B0secs + winGlory
          : nowSec + chainGlory; // fallback if metadata missing
      gloryEndRef.current = Math.max(gloryEndRef.current, predEnd);
    }
  }, [gloryRemChainBN, startTime, B0secs, winGlory, nowSec]);

  React.useEffect(() => {
    const exp = exposureEndRef.current;
    if (exp > 0 && winGlory > 0) {
      const hardEnd = exp + winGlory;
      if (gloryEndRef.current > hardEnd) gloryEndRef.current = hardEnd;
    }
  }, [endTsNum, startTime, B0secs, winGlory]);

  // Live: anchor boost end from chain-anchored "now", then broadcast
  React.useEffect(() => {
    const live = Number(boostedRemLiveBN ?? 0n);
    if (!Number.isFinite(live) || live <= 0) return;
    const end = computeChainNow() + live;
    if (end > boostEndRef.current) {
      boostEndRef.current = end;
      broadcastBoostEnd(end);
      if (idBig && idBig !== 0n) writeBoostEndLS(idBig, end);
    }
  }, [boostedRemLiveBN, computeChainNow, idBig]);

  // Live: anchor cooldown end from chain-anchored "now", then broadcast
  React.useEffect(() => {
    const live = Number(boostCooldownLiveBN ?? 0n);
    if (!Number.isFinite(live) || live <= 0) return;
    const end = computeChainNow() + live;
    if (end > cooldownEndRef.current) {
      cooldownEndRef.current = end;
      broadcastCooldownEnd(end);
    }
  }, [boostCooldownLiveBN, computeChainNow]);

  // Boost & cooldown latches
  React.useEffect(() => {
    const boostedRem = Number(boostedRemBN ?? 0n);
    if (!Number.isFinite(boostedRem) || boostedRem <= 0) return;
    const end = computeChainNow() + boostedRem;
    if (end > boostEndRef.current) {
      boostEndRef.current = end;
      if (idBig && idBig !== 0n) writeBoostEndLS(idBig, end);
    }
  }, [boostedRemBN, computeChainNow, idBig]);

  React.useEffect(() => {
    const cooldownRem = Number(boostCooldownBN ?? 0n);
    if (!Number.isFinite(cooldownRem) || cooldownRem <= 0) return;
    const end = computeChainNow() + cooldownRem;
    if (end > cooldownEndRef.current) {
      cooldownEndRef.current = end;
    }
  }, [boostCooldownBN, computeChainNow]);

  // Immunity window
  React.useEffect(() => {
    if (!hasId || !idBig) return;
    if (startTime && winPostImm) {
      const e = startTime + winPostImm;
      if (e > 0) {
        immEndRef.current = Math.max(immEndRef.current, e);
        // Apply the same guard on post *and* on replacement (same ID, new startTime):
        // treat the early window as immunity and suppress glory anchoring.
        if (lastIdRef.current === idBig) {
          if (e > gloryGuardUntilRef.current) {
            gloryGuardUntilRef.current = e;
          }
        }
        if (lastIdRef.current === idBig) {
          try {
            writeMaskUntil(IMMUNITY_KEY, e, { messageId: idBig });
          } catch {}
          broadcastImmEnd(e);
        }
      }
    }
  }, [startTime, winPostImm, idBig, hasId]);

  React.useEffect(() => {
    if (hasId && lastIdRef.current !== idBig) {
      gloryGuardUntilRef.current = 0;
    }
  }, [hasId, idBig]);

  React.useEffect(() => {
    if (hasId && idBig && (exposureEndRef.current > 0 || gloryEndRef.current > 0 || immEndRef.current > 0)) {
      writeWindowTimes(idBig, exposureEndRef.current, gloryEndRef.current, immEndRef.current);
    }
  }, [hasId, idBig, endTsNum, startTime, B0secs, winGlory, winPostImm]);

  // "Show" gate base window
  React.useEffect(() => {
    const until = Math.max(exposureEndRef.current, gloryEndRef.current);
    if (until > 0) showUntilRef.current = Math.max(showUntilRef.current, until);
  }, [endTsNum, startTime, B0secs, winGlory, gloryRemChainBN]);

  // Derived clocks (guard all ref-based ends to the current id to avoid stale carryover)
  const idMatchesRefs = lastIdRef.current === idBig;
  const exposureEnd = idMatchesRefs ? exposureEndRef.current : 0;
  const gloryEnd = idMatchesRefs ? gloryEndRef.current : 0;
  const boostEnd = idMatchesRefs ? boostEndRef.current : 0;
  const cooldownEnd = idMatchesRefs ? cooldownEndRef.current : 0;
  const immEnd = idMatchesRefs ? immEndRef.current : 0;
  const gloryGuardUntil = idMatchesRefs ? gloryGuardUntilRef.current : 0; // seconds
  const gloryPreOk = idMatchesRefs ? gloryEntryLatchRef.current : false;

  const exposureLeft = Math.max(0, exposureEnd - nowSec);
  const immLeft = Math.max(0, immEnd - nowSec);
  const boostLeft = Math.max(0, boostEnd - nowSec);
  const cooldownLeft = Math.max(0, cooldownEnd - nowSec);
  const gloryGuardActive = nowSec < gloryGuardUntil; // compare seconds to seconds
  const exposureAnchored = idMatchesRefs && exposureEndRef.current > 0;

  // If we refresh while already inside the anchored glory window, relatch the gate
  // so glory persists through the reload without waiting for the pre-exposure window.
  React.useEffect(() => {
    if (!hasId || !idMatchesRefs) return;
    if (!exposureAnchored) return;
    if (gloryEntryLatchRef.current) return;

    const pastExposure = exposureEnd > 0 && nowSec >= exposureEnd;
    const insideGloryWindow =
      pastExposure &&
      gloryEnd > nowSec &&
      !gloryGuardActive &&
      (immLeft <= 0);

    if (insideGloryWindow) {
      gloryEntryLatchRef.current = true;
    }
  }, [
    hasId,
    idMatchesRefs,
    exposureAnchored,
    exposureEnd,
    gloryEnd,
    nowSec,
    gloryGuardActive,
    immLeft,
  ]);

  // While immunity/guard is actually active, we cannot be in glory → keep the gate down.
  React.useEffect(() => {
    if (!hasId || !idMatchesRefs) return;
    if (immLeft > 0 || gloryGuardActive) {
      if (gloryEntryLatchRef.current) gloryEntryLatchRef.current = false;
    }
  }, [hasId, idMatchesRefs, immLeft, gloryGuardActive]);

  // Disarm pre-glory latch whenever we are idle (no active message).
  React.useEffect(() => {
    const remNow = Number(remChainBN ?? 0n);
    const gRemNow = Number(gloryRemChainBN ?? 0n);
    const chainIdle = remNow <= 0 && gRemNow <= 0;
    // Also consider our anchored windows: both exposure & glory ended.
    const windowsOver =
      (exposureEndRef.current > 0 ? nowSec >= exposureEndRef.current : true) &&
      (gloryEndRef.current > 0 ? nowSec >= gloryEndRef.current : true);
    const noActive = !hasId || (chainIdle && windowsOver);
    if (noActive && gloryEntryLatchRef.current) {
      gloryEntryLatchRef.current = false;
    }
  }, [hasId, remChainBN, gloryRemChainBN, nowSec]);

  // Arm glory only in the final window before exposure ends (conservative)
  // and not while post-immunity guard is active.
  React.useEffect(() => {
    if (!hasId || !idMatchesRefs) return;
    if (!exposureAnchored) return;
    if (gloryEntryLatchRef.current) return;
    if (exposureEnd <= 0) return;

    const exposureRemaining = Math.max(0, exposureEnd - nowSec);
    if (exposureRemaining > 0 && exposureRemaining <= PRE_GLORY_GUARD_SECS && !gloryGuardActive) {
      gloryEntryLatchRef.current = true;
    }
  }, [
    hasId,
    idMatchesRefs,
    exposureAnchored,
    exposureEnd,
    nowSec,
    PRE_GLORY_GUARD_SECS,
    gloryGuardActive,
  ]);

  // Only consider glory for the *current* message once exposure end is anchored and passed.
  // This makes “entering glory” equivalent to the exposure countdown reaching zero.
  const inGlory =
    gRemLive &&
    exposureLeft === 0 &&
    gloryEnd > nowSec &&
    exposureAnchored &&
    !gloryGuardActive &&
    (immLeft <= 0) &&
    gloryPreOk;

  React.useEffect(() => {
    if (!hasId || !idMatchesRefs) return;
    if (!gloryEntryLatchRef.current) return;
    if (gloryEnd <= 0 || nowSec >= gloryEnd) {
      gloryEntryLatchRef.current = false;
    }
  }, [hasId, idMatchesRefs, gloryEnd, nowSec]);

  // Anchored glory time left for the UI (no fallback to global gloryRemaining).
  const gloryLeftUi =
    gloryEndRef.current > nowSec ? gloryEndRef.current - nowSec : 0;

  // Hint used for visibility decisions, kept strictly anchored as well.
  const gloryActiveHint =
    exposureEndRef.current > 0 &&
    nowSec >= exposureEndRef.current &&
    gloryEndRef.current > nowSec;

  const hasValidAnchor =
    chainNowRef.current.epoch > 0 && chainNowRef.current.fetchedAt > 0;
  const readyToShowLocks = rehydrationComplete && (hasValidAnchor || !hasId);

  // Prefer glory while active; otherwise boost can override immunity/guard.
  let lockKind: "boost" | "glory" | "immunity" | "none" = "none";
  let lockLeft = 0;
  if (readyToShowLocks) {
    // Glory takes precedence whenever the current message is in glory.
    if (inGlory && gRemLive && gloryLeftUi > 0) {
      // Enter glory ONLY after exposure for this id is anchored and passed.
      lockKind = "glory";
      lockLeft = gloryLeftUi;
    } else if (boostLeft > 0) {
      // Boost takes priority when recently fired, unless glory is active.
      lockKind = "boost";
      lockLeft = boostLeft;
    } else if (gloryGuardActive) {
      // During guard, treat as immunity to avoid UI “jump to glory” and to hide the postbox.
      lockKind = "immunity";
      const guardLeft = Math.max(0, gloryGuardUntil - nowSec);
      lockLeft = Math.max(immLeft, exposureLeft, guardLeft);
    } else if (exposureLeft > 0 && immLeft > 0) {
      lockKind = "immunity";
      lockLeft = immLeft;
    }
  }

  // If there’s no active message id, never report any lock state.
  // This prevents the PostBox from being hidden during idle/no-id.
  if (!hasId) {
    lockKind = "none";
    lockLeft = 0;
  }

  const remFallback = Math.max(0, Number(remChainBN ?? 0n));
  const remSec = endTsNum > 0 || exposureEnd > 0 ? exposureLeft : remFallback;

  const resolvedFlag = Boolean((m as any)?.resolved ?? (m as any)?.[10]);
  const nukedFlag = Boolean((m as any)?.nuked ?? (m as any)?.[11]);

  const replaceLocked = Boolean(replaceBlocked) || lockLeft > 0;

  // Proof-of-life and definitely-over guards
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

  const liveProof = Number(remChainBN ?? 0n) > 0 || Number(gloryRemChainBN ?? 0n) > 0;
  const mLoaded = !!m && startTime > 0 && B0secs > 0;
  const hardOverAt =
    startTime && B0secs ? startTime + B0secs + (winGlory || 0) + (winFreeze || 0) : 0;
  const definitelyOver = !!mLoaded && hardOverAt > 0 && nowSec >= hardOverAt;

  const bootConfirmed = idConfirmOk === idBig || liveProof || (mLoaded && !definitelyOver);

  React.useEffect(() => {
    // Re-anchor clocks when the tab becomes active again (focus/pageshow/visibility)
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let cancelled = false;
    const reanchor = async () => {
      if (cancelled) return;
      try {
        setNowSec((prev) => Math.max(prev, computeChainNow()));
        if (hasId && publicClient) {
          // Read both windows so we can anchor correctly during glory, too.
          const [remRaw, gloryRemRaw, boostedRemRaw, cooldownRemRaw] = await Promise.all([
            publicClient
              .readContract({
                address: GAME as `0x${string}`,
                abi: GAME_ABI,
                functionName: "remainingSeconds",
                // keep args in sync with useReadContract above
                args: [idBig],
              })
              .catch(() => 0n),
            publicClient
              .readContract({
                address: GAME as `0x${string}`,
                abi: GAME_ABI,
                functionName: "gloryRemaining",
              })
              .catch(() => 0n),
            publicClient
              .readContract({
                address: GAME as `0x${string}`,
                abi: GAME_ABI,
                functionName: "boostedRemaining",
              })
              .catch(() => 0n),
            publicClient
              .readContract({
                address: GAME as `0x${string}`,
                abi: GAME_ABI,
                functionName: "boostCooldownRemaining",
              })
              .catch(() => 0n),
          ]);

          const rem = Number(remRaw ?? 0n);
          const gRem = Number(gloryRemRaw ?? 0n);
          const boostedRem = Number(boostedRemRaw ?? 0n);
          const cooldownRem = Number(cooldownRemRaw ?? 0n);
          if (cancelled) return;

          const fallbackEnd =
            exposureEndRef.current > 0
              ? exposureEndRef.current
              : startTime && B0secs
              ? startTime + B0secs
              : 0;
          const gloryEndPred =
            startTime && B0secs && winGlory ? startTime + B0secs + winGlory : 0;

          const candidates: number[] = [];
          if (fallbackEnd > 0 && Number.isFinite(rem) && rem >= 0) {
            candidates.push(fallbackEnd - rem);
          }
          if (
            gloryEndPred > 0 &&
            Number.isFinite(gRem) &&
            gRem > 0 &&
            !suppressGloryAnchorNow()
          ) {
            candidates.push(gloryEndPred - gRem);
          }

          const bestEpoch = candidates.length ? Math.max(...candidates) : 0;
          if (bestEpoch > 0 && Number.isFinite(bestEpoch)) {
            chainNowRef.current = { epoch: bestEpoch, fetchedAt: Date.now() };
            setNowSec((prev) => Math.max(prev, computeChainNow()));
            broadcastAnchor(bestEpoch);
          }

          // If we're in glory on resume, persist a fresh mask end so other tabs rehydrate.
          if (gRem > 0) {
            // Absolute end = predicted glory end; mask extends by winFreeze seconds.
            const predictedMaskEnd =
              (gloryEndPred > 0 ? gloryEndPred : Math.floor(Date.now() / 1000) + gRem) +
              Math.max(0, winFreeze || 0);
            try {
              writeMaskUntil(GLORY_MASK_KEY, predictedMaskEnd, { messageId: idBig });
            } catch {}
          }
          // ---- FAST-PATH: snap boost/glory/cooldown right away on focus ----
          // This updates the end refs immediately so the UI feels instant,
          // without waiting for TanStack refetch to complete.
          const nowEpoch = Math.floor(Date.now() / 1000);
          if (gRem > 0) {
            const predictedGloryEnd =
              startTime && B0secs && winGlory ? startTime + B0secs + winGlory : nowEpoch + gRem;
            gloryEndRef.current = Math.max(gloryEndRef.current, predictedGloryEnd);
            showUntilRef.current = Math.max(showUntilRef.current, predictedGloryEnd);
          }
          if (boostedRem > 0) {
            const end = nowEpoch + boostedRem;
            if (end > boostEndRef.current) {
              boostEndRef.current = end;
              if (idBig && idBig !== 0n) writeBoostEndLS(idBig, end);
            }
          }
          if (cooldownRem > 0) {
            cooldownEndRef.current = Math.max(cooldownEndRef.current, nowEpoch + cooldownRem);
          }
        }
      } catch {
        /* ignore network hiccups; we'll still nudge queries below */
      }
      try {
        const persisted = readMaskState(IMMUNITY_KEY);
        const pid = parseMaskMessageId(persisted?.messageId);
        const nowS = Math.floor(Date.now() / 1000);
        if (pid === idBig && Number.isFinite(persisted?.until) && persisted!.until > nowS) {
          immEndRef.current = Math.max(immEndRef.current, persisted!.until);
        }
      } catch {}
      nudgeQueries(qc, [0, 120, 600, 1400]);
      broadcastNudge();
    };
    const onVis = () => document.visibilityState === "visible" && reanchor();
    window.addEventListener("focus", reanchor, true);
    window.addEventListener("pageshow", reanchor);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", reanchor, true);
      window.removeEventListener("pageshow", reanchor);
      document.removeEventListener("visibilitychange", onVis);
    };
    // include timing parameters to avoid stale predicted ends
  }, [
    qc,
    publicClient,
    hasId,
    idBig,
    computeChainNow,
    startTime,
    B0secs,
    winGlory,
    winFreeze,
  ]);

  // Final "show" decision
  const untilShow = Math.max(
    showUntilRef.current,
    Math.max(exposureEnd, gloryEnd),
  );
  const liveProofNow =
    Number(remChainBN ?? 0n) > 0 || Number(gloryRemChainBN ?? 0n) > 0;
  // If we have live proof, allow showing even before batched `raw` settles.
  const baseShow =
    hasId &&
    (
      nowSec < untilShow + SHOW_CUSHION ||
      liveProofNow ||
      gloryActiveHint // glory predicted/confirmed keeps the card visible
    );
  const rawReadyEnough = Boolean(raw) || liveProofNow;
  const effectiveShow =
    baseShow &&
    !definitelyOver &&
    (!booting ? true : bootConfirmed) &&
    !bootHold &&
    !idChangeHold &&
    !waitingForId &&
    rawReadyEnough &&
    readyToShowLocks;

  // Clear optimistic show once resolved
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
  }, [hasId, resolvedFlag, nukedFlag, remChainBN, gloryRemChainBN, nowSec, SHOW_CUSHION]);

  // Non-zero latch for boostCost
  const boostCostRef = React.useRef<bigint>(0n);
  React.useEffect(() => {
    const v = (boostCostLive ?? 0n) as bigint;
    if (v > 0n) boostCostRef.current = v;
  }, [boostCostLive]);

  // FIXED: More precise loading state
  const rawReady =
    !hasId ||
    (Array.isArray(raw) &&
      raw.length > 0 &&
      raw.every((entry) =>
        entry && typeof entry === "object" && ("result" in entry || "error" in entry),
      ));
  const stillFetchingActive = hasId && (!rawReady || (rawFetching && !rawReady));

  // If we have NO active message, never report loading → prevents “stuck waiting”
  // On a hard refresh, hold the UI in "Loading…" until we *know* whether an ID exists.
  const loadingState = (!idKnown || refreshGate)
    ? true
    : (hasId
        ? Boolean(bootHold || idChangeHold || waitingForId || stillFetchingActive || !rehydrationComplete)
        : false);

  return {
    id: idBig,
    show: effectiveShow,
    m,
    rem: BigInt(remSec),
    gloryRem: inGlory ? gloryLeftUi : 0,
    feeLike,
    feeDislike,
    boostCost: boostCostRef.current,
    boostedRem: Math.max(0, boostEndRef.current - nowSec),
    boostCooldownRem: cooldownLeft,
    winPostImm,
    winGlory,
    winFreeze,
    replaceLocked,
    lockKind,
    lockLeft,
    loading: loadingState,
    gloryPredictedEnd: Math.max(0, gloryEndRef.current),
    nowSec,
    immLeft,
    rehydrationComplete,
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
  if (!snap.rehydrationComplete) return null;

  // Don’t render the post box while snapshot is still loading to avoid the idle flash.
  if (snap.loading) return null;

  // If no message is being shown at all, we are idle by definition → show Post UI.
  // This bypasses any stale latch/guard that might linger when the card itself is hidden.
  const showing = Boolean(snap.show);
  if (!showing) {
    return isConnected ? <PostBoxInner /> : null;
  }

  const msgId = snap.id;
  const hasActive = snap.rem > 0n;
  // When there’s no active id, treat as fully unlocked/idle to avoid stale latches.
  const glorySec = msgId && msgId !== 0n ? Number(snap.gloryRem ?? 0) : 0;
  const lockKind = snap.lockKind ?? "none";
  const anyLock = msgId && msgId !== 0n ? (lockKind !== "none") : false;

  // If there's NO active message and NO locks and NOT crowning, show post box immediately,
  // regardless of transient loading flags.
  if (!hasActive && glorySec <= 0 && !anyLock) {
    return isConnected ? <PostBoxInner /> : null;
  }
  return null;
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

        nudgeQueries(qc, [0, 500, 1500]);
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

        nudgeQueries(qc, [0, 500, 1500]);
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

let modMaskLatchedIdsRefGlobal: React.MutableRefObject<Set<bigint>> | null = null;
let maskSuppressionUntil = 0;
let suppressedMaskTypes = new Set<string>();
function suppressMasksFor(seconds: number, types: string[] = []) {
  const next = Math.floor(Date.now() / 1000) + Math.max(0, seconds);
  maskSuppressionUntil = Math.max(maskSuppressionUntil, next);
  const touchesModMask = types.length === 0 || types.includes(MOD_MASK_KEY);
  if (types.length === 0) {
    suppressedMaskTypes.add("*");
  } else {
    types.forEach((t) => suppressedMaskTypes.add(t));
  }
  if (touchesModMask) {
    modMaskLatchedIdsRefGlobal?.current.clear();
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

function MaskStorageSync() {
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const KEYS = [GLORY_MASK_KEY, NUKE_MASK_KEY, MOD_MASK_KEY];
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !KEYS.includes(e.key)) return;
      try {
        const payload = e.newValue ? JSON.parse(e.newValue) : { until: 0 };
        const until = Number(payload?.until) || 0;
        const messageId =
          payload?.messageId === null || typeof payload?.messageId === "undefined"
            ? undefined
            : String(payload.messageId);
        emitMaskUpdate(e.key, until, messageId);
      } catch {
        emitMaskUpdate(e.key, 0);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return null;
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
  const rehydrated = snap.rehydrationComplete;

  const lk = (snap as any)?.lockKind as "boost" | "glory" | "immunity" | "none";
  const timerOverride =
    lk === "immunity" ? Number((snap as any)?.immLeft ?? 0) :
    lk === "glory"    ? Number((snap as any)?.gloryRem ?? 0) :
    lk === "boost"    ? Number((snap as any)?.boostedRem ?? 0) :
    0;

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

  const { data: modFlaggedLive, fetchStatus: modFlaggedFetchStatus } = useReadContract({
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

  const computeNow = React.useCallback(() => {
    const snapNow = Number((snap as any)?.nowSec ?? 0);
    if (Number.isFinite(snapNow) && snapNow > 0) return Math.floor(snapNow);
    return Math.floor(Date.now() / 1000);
  }, [snap]);
  const [now, setNow] = React.useState(() => computeNow());
  const rehydrateMasksOnResumeDeps = [glorySec, MASK_SECS]; // only for eslint happiness
  // For cross-tab clamping: visible glory mask should never exceed freeze + pad
  const GLORY_MASK_MAX_SPAN = Math.max(0, MASK_SECS + GLORY_MASK_LATCH_PAD);
  const maskSecsRef = React.useRef(MASK_SECS);
  const gloryMaskSpanRef = React.useRef(GLORY_MASK_MAX_SPAN);
  React.useEffect(() => {
    maskSecsRef.current = MASK_SECS;
    gloryMaskSpanRef.current = GLORY_MASK_MAX_SPAN;
  }, [MASK_SECS, GLORY_MASK_MAX_SPAN]);
  React.useEffect(() => {
    const tick = () => setNow(computeNow());
    tick();
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, [computeNow]);
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setNow(computeNow());
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [computeNow]);

  // ========= POST-GLORY FREEZE MASK (clamped & de-flickered) =========
  // IMPORTANT: clamp persisted glory mask strictly to what we actually show:
  // last 2s of glory (latch pad) + freeze, never more.
  const GLORY_MAX_SPAN = GLORY_MASK_MAX_SPAN;

  const gloryUntilRef = React.useRef(0);
  const gloryMaskMessageIdRef = React.useRef<bigint>(0n);
  const rehydrationStartedRef = React.useRef(false); // gate during rehydration

  // Clamp any persisted "until" so it can't be wildly in the future
  React.useEffect(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const persisted = readMaskState(GLORY_MASK_KEY);
    // MIGRATION: if no messageId was saved, drop legacy entry to avoid false latching
    if (persisted.until > 0 && !persisted.messageId) {
      writeMaskUntil(GLORY_MASK_KEY, 0);
      gloryUntilRef.current = 0;
    } else if (persisted.until > 0 && rehydrated) {
      // Only restore persisted glory mask after rehydration completes
      const clipped = Math.min(persisted.until, nowSec + GLORY_MAX_SPAN);
      gloryUntilRef.current = clipped > nowSec ? clipped : 0;
    }
    if (rehydrated && persisted.messageId) {
      const storedId = parseMaskMessageId(persisted.messageId);
      if (storedId > 0n) {
        gloryMaskMessageIdRef.current = storedId;
      }
    }
    rehydrationStartedRef.current = rehydrated;
  }, [rehydrated, GLORY_MAX_SPAN]);

  // Persist once when we ENTER the latch window (last 2s of glory)
  const predictedGloryEnd = Number((snap as any)?.gloryPredictedEnd ?? 0);
  const predictedMaskEnd =
    predictedGloryEnd > 0 ? predictedGloryEnd + MASK_SECS : 0;
  const gloryPersistWroteEndRef = React.useRef<number>(0);
  const gloryPersistWroteIdRef = React.useRef<bigint>(0n);
  const [gloryMaskLatched, setGloryMaskLatched] = React.useState(false);
  const clearGloryMaskState = React.useCallback(() => {
    const globalLatchRef = (globalThis as any).__meowtGloryEntryLatchRef as
      | React.MutableRefObject<boolean>
      | undefined;
    if (globalLatchRef) {
      globalLatchRef.current = false;
    }
    gloryUntilRef.current = 0;
    gloryMaskMessageIdRef.current = 0n;
    gloryPersistWroteEndRef.current = 0;
    gloryPersistWroteIdRef.current = 0n;
    setGloryMaskLatched(false);
    try {
      writeMaskUntil(GLORY_MASK_KEY, 0);
    } catch {}
  }, []);
  React.useEffect(() => {
    if (!msgId || msgId === 0n || predictedMaskEnd === 0) {
      gloryPersistWroteEndRef.current = 0;
      gloryPersistWroteIdRef.current = 0n;
      return;
    }
    const latchStart =
      predictedMaskEnd > 0
        ? Math.max(0, predictedMaskEnd - (MASK_SECS + GLORY_MASK_LATCH_PAD))
        : 0;
    const inLatchWindow =
      latchStart > 0 && now >= latchStart && now < predictedMaskEnd;
    if (!inLatchWindow) return;
    if (
      gloryPersistWroteEndRef.current !== predictedMaskEnd ||
      gloryPersistWroteIdRef.current !== msgId
    ) {
      gloryUntilRef.current = predictedMaskEnd;
      gloryMaskMessageIdRef.current = msgId;
      gloryPersistWroteEndRef.current = predictedMaskEnd;
      gloryPersistWroteIdRef.current = msgId;
      writeMaskUntil(GLORY_MASK_KEY, predictedMaskEnd, { messageId: msgId });
    }
  }, [now, msgId, predictedMaskEnd, MASK_SECS]);

  // Natural end or message switch → clear persisted mask
  React.useEffect(() => {
    if (gloryUntilRef.current > 0 && now >= gloryUntilRef.current) {
      gloryUntilRef.current = 0;
      gloryMaskMessageIdRef.current = 0n;
      writeMaskUntil(GLORY_MASK_KEY, 0);
    }
    if (
      gloryMaskMessageIdRef.current &&
      msgId &&
      msgId !== 0n &&
      gloryMaskMessageIdRef.current !== msgId
    ) {
      gloryUntilRef.current = 0;
      gloryMaskMessageIdRef.current = 0n;
      writeMaskUntil(GLORY_MASK_KEY, 0);
    }
  }, [now, msgId]);

  // Authoritative mask end = min(predicted end, persisted end for this message)
  const persistedEnd =
    gloryMaskMessageIdRef.current &&
    msgId &&
    msgId !== 0n &&
    gloryMaskMessageIdRef.current === msgId
      ? gloryUntilRef.current
      : 0;
  const maskEndCandidates = [predictedMaskEnd, persistedEnd].filter(
    (n) => Number.isFinite(n) && n > 0,
  ) as number[];
  const maskEnd = maskEndCandidates.length
    ? Math.min(...maskEndCandidates)
    : 0;
  const latchPadStart =
    maskEnd > 0 ? Math.max(0, maskEnd - (MASK_SECS + GLORY_MASK_LATCH_PAD)) : 0;
  // Prevent mask from appearing too early on refresh: require we be in the latch pad
  // (last few seconds of glory) or already in the freeze window.
  const allowGloryMaskEarly = glorySec > 0 && glorySec <= GLORY_MASK_LATCH_PAD;
  const allowGloryMaskAfter =
    glorySec <= 0 && (predictedGloryEnd <= 0 || now >= predictedGloryEnd);
  const gloryMaskEligible =
    rehydrated &&
    maskEnd > 0 &&
    now >= latchPadStart &&
    now < maskEnd &&
    (allowGloryMaskAfter || allowGloryMaskEarly);
  const rawLeft = maskEnd > 0 ? maskEnd - now : 0;
  React.useEffect(() => {
    if (gloryMaskEligible) {
      setGloryMaskLatched((prev) => (prev ? prev : true));
      return;
    }
    setGloryMaskLatched((prev) => {
      if (!prev) return prev;
      if (maskEnd > 0 && now < maskEnd) return prev;
      if (maskEnd <= 0) return false;
      return now >= maskEnd ? false : prev;
    });
  }, [gloryMaskEligible, maskEnd, now]);
  const showGloryMask = gloryMaskLatched;
  const gloryMaskLeft = showGloryMask
    ? Math.max(0, Math.min(rawLeft, MASK_SECS + GLORY_MASK_LATCH_PAD))
    : 0;

  // ========= MOD / NUKE MASKS =========
  const NUKE_MASK_SECS = MASK_SECS;
  const MOD_RETRIGGER_DEBOUNCE_SECS = 30;
  const nukeMaskUntilRef = React.useRef(0);
  const nukeMaskMessageIdRef = React.useRef<bigint>(0n);
  const modMaskUntilRef = React.useRef(0);
  const modMaskMessageIdRef = React.useRef<bigint>(0n);
  const modMaskLatchedIdsRef = React.useRef<Set<bigint>>(new Set());
  modMaskLatchedIdsRefGlobal = modMaskLatchedIdsRef;
  React.useEffect(() => {
    return () => {
      if (modMaskLatchedIdsRefGlobal === modMaskLatchedIdsRef) {
        modMaskLatchedIdsRefGlobal = null;
      }
    };
  }, []);

  // Latch the moderation mask once per message id until it's cleared.
  // - Never extend an already-active mask for the same id.
  // - Clamp to at most MASK_SECS from "now" to avoid drifting.
  function latchModMaskOnce(id: bigint, desiredUntil: number): boolean {
    const nowS = Math.floor(Date.now() / 1000);
    if (!id || id === 0n) return false;

    // If we've ever latched this id (until cleared), do nothing.
    if (modMaskLatchedIdsRef.current.has(id)) {
      return false;
    }

    // Never let the visible mask exceed "freeze from now".
    const cap = nowS + maskSecsRef.current;
    const until = Math.min(desiredUntil, cap);

    modMaskUntilRef.current = until;
    modMaskMessageIdRef.current = id;
    modMaskLatchedIdsRef.current.add(id);
    try {
      writeMaskUntil(MOD_MASK_KEY, until, { messageId: id });
    } catch {}
    return true;
  }
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const rehydrate = () => {
      const nowS = Math.floor(Date.now() / 1000);
      try {
        const g = readMaskState(GLORY_MASK_KEY);
        if (g?.until > 0) {
          const clipped = Math.min(g.until, nowS + GLORY_MASK_MAX_SPAN);
          gloryUntilRef.current = clipped > nowS ? clipped : 0;
        }
        if (g?.messageId) {
          const id = parseMaskMessageId(g.messageId);
          if (id > 0n) gloryMaskMessageIdRef.current = id;
        }
      } catch {}
      try {
        const m = readMaskState(MOD_MASK_KEY);
        const until = m?.until > 0 ? Math.min(m.until, nowS + MASK_SECS) : 0;
        modMaskUntilRef.current = until;
        if (m?.messageId) {
          const id = parseMaskMessageId(m.messageId);
          if (id > 0n) {
            modMaskMessageIdRef.current = id;
            if (until > nowS) {
              modMaskLatchedIdsRef.current.add(id);
            }
          }
        }
        if (until <= nowS) {
          modMaskLatchedIdsRef.current.clear();
        }
      } catch {}
      try {
        const n = readMaskState(NUKE_MASK_KEY);
        nukeMaskUntilRef.current = n?.until > 0 ? Math.min(n.until, nowS + MASK_SECS) : 0;
        if (n?.messageId) {
          const id = parseMaskMessageId(n.messageId);
          if (id > 0n) nukeMaskMessageIdRef.current = id;
        }
      } catch {}
    };
    const onVis = () => document.visibilityState === "visible" && rehydrate();
    window.addEventListener("pageshow", rehydrate);
    window.addEventListener("focus", rehydrate);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pageshow", rehydrate);
      window.removeEventListener("focus", rehydrate);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, rehydrateMasksOnResumeDeps);
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
    const persistedNuke = readMaskState(NUKE_MASK_KEY);
    if (persistedNuke.until > nukeMaskUntilRef.current) {
      nukeMaskUntilRef.current = persistedNuke.until;
    }
    if (persistedNuke.messageId) {
      const stored = parseMaskMessageId(persistedNuke.messageId);
      if (stored > 0n) {
        nukeMaskMessageIdRef.current = stored;
      }
    }
    const nowS = Math.floor(Date.now() / 1000);
    const persistedMod = readMaskState(MOD_MASK_KEY);
    if (persistedMod.until > modMaskUntilRef.current) {
      const capped = Math.min(persistedMod.until, nowS + MASK_SECS);
      modMaskUntilRef.current = capped;
      if (capped <= nowS) {
        modMaskLatchedIdsRef.current.clear();
      }
    }
    if (persistedMod.messageId) {
      const stored = parseMaskMessageId(persistedMod.messageId);
      if (stored > 0n) {
        modMaskMessageIdRef.current = stored;
        if (modMaskUntilRef.current > nowS) {
          modMaskLatchedIdsRef.current.add(stored);
        }
      }
    }
  }, []);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<MaskEventDetail>).detail;
      if (!detail || typeof detail.until !== "number") return;
      const normalized = Number.isFinite(detail.until) ? Math.floor(detail.until) : 0;
      const evtId = parseMaskMessageId(detail.messageId ?? undefined);
      if (detail.key === MOD_MASK_KEY) {
        if (normalized > 0) {
          // clamp to at most freeze seconds from "now"
          const nowS = Math.floor(Date.now() / 1000);
          const cap = nowS + maskSecsRef.current;
          const capped = Math.min(normalized, cap);
          modMaskUntilRef.current = capped;
          if (evtId > 0n) {
            modMaskMessageIdRef.current = evtId;
            if (capped > nowS) {
              modMaskLatchedIdsRef.current.add(evtId);
            }
          }
          if (capped <= nowS) {
            modMaskLatchedIdsRef.current.clear();
          }
        } else {
          const prevId = modMaskMessageIdRef.current;
          if (prevId && prevId !== 0n) {
            // Always disarm so the next post won't echo the MOD mask.
            disarmModFor(prevId, MOD_RETRIGGER_DEBOUNCE_SECS);
          }
          modMaskMessageIdRef.current = 0n;
          setModFrozenMessage(null);
          modMaskUntilRef.current = 0;
          modMaskLatchedIdsRef.current.clear();
        }
      } else if (detail.key === NUKE_MASK_KEY) {
        if (normalized > 0) {
          // clamp to at most freeze seconds from "now"
          const cap = Math.floor(Date.now() / 1000) + maskSecsRef.current;
          const capped = Math.min(normalized, cap);
          nukeMaskUntilRef.current = capped;
          if (evtId > 0n) {
            nukeMaskMessageIdRef.current = evtId;
          }
        } else {
          nukeMaskMessageIdRef.current = 0n;
          nukeMaskUntilRef.current = 0;
        }
      } else if (detail.key === GLORY_MASK_KEY) {
        if (normalized > 0) {
          // clamp to at most (freeze + latchPad) seconds from "now"
          const cap = Math.floor(Date.now() / 1000) + gloryMaskSpanRef.current;
          const capped = Math.min(normalized, cap);
          gloryUntilRef.current = capped;
          if (evtId > 0n) {
            gloryMaskMessageIdRef.current = evtId;
          }
        } else {
          gloryMaskMessageIdRef.current = 0n;
          gloryUntilRef.current = 0;
        }
      }
    };
    window.addEventListener(MASK_EVENT, handler as EventListener);
    const onStorage = (ev: StorageEvent) => {
      if (!ev || typeof ev.key !== "string") return;
      if (ev.key !== MOD_MASK_KEY && ev.key !== NUKE_MASK_KEY && ev.key !== GLORY_MASK_KEY)
        return;
      try {
        const nowS = Math.floor(Date.now() / 1000);
        const parsed = ev.newValue ? JSON.parse(ev.newValue) : null;
        const until = Math.floor(Number(parsed?.until ?? 0));
        const msg = typeof parsed?.messageId === "string" ? parsed.messageId : undefined;
        const id = parseMaskMessageId(msg);
        if (ev.key === MOD_MASK_KEY) {
          const capped = until > 0 ? Math.min(until, nowS + maskSecsRef.current) : 0;
          modMaskUntilRef.current = capped;
          if (id > 0n) {
            modMaskMessageIdRef.current = id;
            if (capped > nowS) {
              modMaskLatchedIdsRef.current.add(id);
            }
          }
          if (capped <= nowS) {
            modMaskLatchedIdsRef.current.clear();
          }
        } else if (ev.key === NUKE_MASK_KEY) {
          nukeMaskUntilRef.current =
            until > 0 ? Math.min(until, nowS + maskSecsRef.current) : 0;
          if (id > 0n) nukeMaskMessageIdRef.current = id;
        } else if (ev.key === GLORY_MASK_KEY) {
          gloryUntilRef.current =
            until > 0 ? Math.min(until, nowS + gloryMaskSpanRef.current) : 0;
          if (id > 0n) gloryMaskMessageIdRef.current = id;
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MASK_EVENT, handler as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  React.useEffect(() => {
    if (modMaskUntilRef.current > 0 && now >= modMaskUntilRef.current) {
      const prevId = modMaskMessageIdRef.current;
      if (prevId && prevId !== 0n) {
        // Always disarm on timer-based clear as well.
        disarmModFor(prevId, MOD_RETRIGGER_DEBOUNCE_SECS);
      }
      modMaskLatchedIdsRef.current.clear();
      modMaskUntilRef.current = 0;
      modMaskMessageIdRef.current = 0n;
      writeMaskUntil(MOD_MASK_KEY, 0);
      clearGloryMaskState();
    }
    if (nukeMaskUntilRef.current > 0 && now >= nukeMaskUntilRef.current) {
      nukeMaskUntilRef.current = 0;
      nukeMaskMessageIdRef.current = 0n;
      writeMaskUntil(NUKE_MASK_KEY, 0);
    }
  }, [now, hasActive, clearGloryMaskState]);

  React.useEffect(() => {
    isActiveRef.current = hasActive;
  }, [hasActive]);
  React.useEffect(() => {
    if (hasActive && msgId && msgId !== 0n && currentMessage) {
      lastActiveMessageRef.current = { id: msgId, message: { ...currentMessage } };
    }
  }, [hasActive, msgId, currentMessage]);

  React.useEffect(() => {
    if (modFlaggedFetchStatus === "fetching") return;
    if (!modFlaggedLive) return;
    if (!latchedModId || latchedModId === 0n) return;
    if (masksSuppressed(MOD_MASK_KEY)) return;
    // Respect disarm regardless of active/inactive state.
    if (isModDisarmed(latchedModId)) return;

    const nowS = Math.floor(Date.now() / 1000);
    const latched = latchModMaskOnce(latchedModId, nowS + NUKE_MASK_SECS);
    if (latched) {
      // Only capture the frozen message the first time we actually latch.
      let latchedMsg = lastActiveMessageRef.current;
      if (hasActive && msgId && msgId !== 0n && currentMessage && msgId === latchedModId) {
        latchedMsg = { id: msgId, message: { ...(currentMessage as any) } };
      }
      if (latchedMsg) {
        setModFrozenMessage({ id: latchedMsg.id, message: { ...latchedMsg.message } });
      }
      clearGloryMaskState();
    }
  }, [
    hasActive,
    currentMessage,
    latchedModId,
    modFlaggedFetchStatus,
    modFlaggedLive,
    msgId,
    NUKE_MASK_SECS,
    clearGloryMaskState,
  ]);
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

      const nowS = Math.floor(Date.now() / 1000);
      const untilBase = nowS + NUKE_MASK_SECS;
      if (flagged) {
        const latched = latchModMaskOnce(msgId, nowS + NUKE_MASK_SECS);
        if (latched) {
          const latchedMsg =
            lastActiveMessageRef.current || {
              id: msgId,
              message: { ...(currentMessage as any) },
            };
          setModFrozenMessage({ id: latchedMsg.id, message: { ...latchedMsg.message } });
          clearGloryMaskState();
        }
      } else {
        const capped = Math.min(untilBase, nowS + MASK_SECS);
        if (capped > nukeMaskUntilRef.current) {
          nukeMaskUntilRef.current = capped;
          nukeMaskMessageIdRef.current = msgId ?? 0n;
          writeMaskUntil(NUKE_MASK_KEY, capped, { messageId: msgId });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasActive, currentMessage, msgId, publicClient, NUKE_MASK_SECS, clearGloryMaskState]);

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
      const nowS = Math.floor(Date.now() / 1000);
      const untilBase = nowS + NUKE_MASK_SECS;

      if (flagged) {
        // Respect disarm even if a new post is already active.
        if (isModDisarmed(idToCheck)) return;
        if (masksSuppressed(MOD_MASK_KEY)) return;
        const latched = latchModMaskOnce(idToCheck, nowS + NUKE_MASK_SECS);
        if (latched) {
          let latchedMsg = lastActiveMessageRef.current;
          if (!latchedMsg || latchedMsg.id !== idToCheck) {
            if (mFinal) latchedMsg = { id: idToCheck, message: { ...mFinal } };
          }
          if (latchedMsg) {
            setModFrozenMessage({ id: latchedMsg.id, message: { ...latchedMsg.message } });
          }
          clearGloryMaskState();
        }
        return;
      }

      if (!nuked) return;

      if (masksSuppressed(NUKE_MASK_KEY)) return;
      // never extend beyond freeze seconds from *now*
      const capped = Math.min(untilBase, nowS + MASK_SECS);
      if (capped > nukeMaskUntilRef.current) {
        nukeMaskUntilRef.current = capped;
        nukeMaskMessageIdRef.current = idToCheck ?? 0n;
        writeMaskUntil(NUKE_MASK_KEY, capped, { messageId: idToCheck });
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
    if (modFlaggedFetchStatus === "fetching") return;
    if (modFlaggedLive && latchedModId === msgId) {
      modMaskMessageIdRef.current = msgId;
      return;
    }
    if (modMaskMessageIdRef.current && modMaskMessageIdRef.current !== msgId) {
      modMaskUntilRef.current = 0;
      modMaskMessageIdRef.current = 0n;
      modMaskLatchedIdsRef.current.clear();
      writeMaskUntil(MOD_MASK_KEY, 0);
      setModFrozenMessage(null);
      clearGloryMaskState();
    }
  }, [
    hasActive,
    latchedModId,
    modFlaggedFetchStatus,
    modFlaggedLive,
    msgId,
    clearGloryMaskState,
  ]);

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
  const modMaskLeft = showModMask
    ? Math.max(0, Math.floor(modMaskUntilRef.current - now))
    : 0;
  const nukeMaskLeft = showNukeMask ? nukeMaskUntilRef.current - now : 0;
  React.useEffect(() => {
    if (!showModMask) setModFrozenMessage(null);
  }, [showModMask]);

  const showingModeratedFreeze = Boolean(!hasActive && showModMask && modFrozenMessage);
  const displayMsgId = showingModeratedFreeze ? (modFrozenMessage!.id ?? 0n) : msgId;
  const messageForUi = showingModeratedFreeze ? modFrozenMessage!.message : currentMessage;

  async function confirmThenRefresh(hash?: `0x${string}`) {
    let ok = false;
    try {
      if (hash && publicClient) {
        const r = await withRetry(
          () => publicClient!.waitForTransactionReceipt({ hash }),
          3,
          300
        );
        if (r.status !== "success") throw new Error("Transaction reverted");
        ok = true;
      }
    } finally {
      nudgeQueries(qc, ok ? [0, 500, 1500] : [0, 500]);
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

  const renderActive = (hasActive || showingModeratedFreeze) && rehydrated;

  return (
    <div className="flex flex-col gap-3 items-stretch">
      {/* overlays */}
      {showModMask && rehydrated && (
        <FinalizingMask
          secondsLeft={modMaskLeft}
          imgUrl="/overlays/moderated.png"
          message="The message has been canceled for violation of our policies"
        />
      )}
      {!showModMask && showNukeMask && rehydrated && (
        <FinalizingMask
          secondsLeft={nukeMaskLeft}
          imgUrl="/overlays/nuked.png"
          message="Too many dislikes! The message has been nuked"
        />
      )}
      {!showModMask && !showNukeMask && showGloryMask && rehydrated && (
        <FinalizingMask secondsLeft={gloryMaskLeft} imgUrl="/overlays/finalizing.png" />
      )}

      {snap.loading ? (
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
              boostedRem={Number((snap as any)?.boostedRem ?? 0)}
              timerOverride={timerOverride}
            />
          ) : (
            <PreviewSkeleton />
          )}

          {isConnected && lk !== "glory" && (
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

  React.useEffect(() => {
    if (!busy) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let cancelled = false;
    const reset = () => {
      if (cancelled) return;
      setBusy(false);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        reset();
      }
    };

    const onFocus = () => {
      reset();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [busy]);
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

function resetWagmiConnectionState(): void {
  wagmiConfig.setState((state) => {
    if (
      state.connections.size === 0 &&
      state.current === null &&
      state.status === "disconnected"
    ) {
      return state;
    }

    return {
      ...state,
      connections: new Map(),
      current: null,
      status: "disconnected",
    };
  });

  void wagmiConfig.storage?.removeItem?.("recentConnectorId");
}

function extractErrorMessage(error: unknown): string {
  if (!error) return "Please try again.";
  const candidate =
    (error as any)?.shortMessage || (error as any)?.message || String(error);
  return candidate || "Please try again.";
}

function ConnectControls() {
  const { status, address, connector: activeConnector } = useAccount();
  const { disconnect, disconnectAsync } = useDisconnect();
  const { connectAsync, connectors } = useConnect();
  const [connecting, setConnecting] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState(false);
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

  const cleanupConnector = React.useCallback(async (connector: any) => {
    if (!connector) return;

    const label = connector?.name || connector?.id || "unknown";

    try {
      await connector.disconnect?.();
    } catch (error) {
      console.warn(`[disconnect] Failed to call disconnect on ${label}:`, error);
    }

    if (isWalletConnectConnector(connector)) {
      try {
        const provider = await connector.getProvider?.();
        await provider?.disconnect?.();
      } catch (error) {
        console.warn(`[disconnect] WalletConnect provider cleanup failed for ${label}:`, error);
      }
    }

    try {
      connector.resetState?.();
    } catch (error) {
      console.warn(`[disconnect] Failed to reset state for ${label}:`, error);
    }
  }, []);

  const cleanupAllConnectors = React.useCallback(async () => {
    const seen = new Set<any>();
    const candidates = [activeConnector, ...connectors];
    for (const connector of candidates) {
      if (!connector || seen.has(connector)) continue;
      seen.add(connector);
      await cleanupConnector(connector);
    }

    resetWagmiConnectionState();
  }, [activeConnector, connectors, cleanupConnector]);

  const prevStatusRef = React.useRef(status);

  React.useEffect(() => {
    if (status !== "connecting") {
      setConnecting(false);
    }
    if (status === "connected") {
      setShowPicker(false);
    }
    if (prevStatusRef.current === "connected" && status === "disconnected") {
      void cleanupAllConnectors();
      setShowPicker(false);
    }
    if (status !== "connected") {
      setDisconnecting(false);
    }
    prevStatusRef.current = status;
  }, [cleanupAllConnectors, status]);

  React.useEffect(() => {
    const unsubscribe = watchAccount(wagmiConfig, {
      onChange(account) {
        if (account.status === "connected") {
          setConnecting(false);
          setShowPicker(false);
        } else if (account.status !== "connecting") {
          setConnecting(false);
        }
      },
    });

    return () => {
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    if (!connecting) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let cancelled = false;
    let lastReconnectAt = 0;

    const maybeReconnect = () => {
      const now = Date.now();
      if (now - lastReconnectAt < 900) return;
      lastReconnectAt = now;
      reconnect(wagmiConfig).catch((error) => {
        console.warn("[connect] Reconnect probe failed:", error);
      });
    };

    const syncAccount = () => {
      if (cancelled) return;
      const { status: accountStatus } = getAccount(wagmiConfig);

      switch (accountStatus) {
        case "connected":
          setConnecting(false);
          setShowPicker(false);
          return;
        case "connecting":
        case "reconnecting":
          maybeReconnect();
          return;
        case "disconnected":
        default:
          setConnecting(false);
          return;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      syncAccount();
    };

    const onFocus = () => {
      syncAccount();
    };

    syncAccount();
    const interval = window.setInterval(syncAccount, 1200);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [connecting]);

  const handleDisconnect = React.useCallback(async () => {
    if (disconnecting) return;

    setDisconnecting(true);
    setConnecting(false);
    setShowPicker(false);

    try {
      if (disconnectAsync) {
        await disconnectAsync();
      } else {
        disconnect();
      }
    } catch (error) {
      console.warn("[disconnect] wagmi disconnect failed:", error);
    }

    try {
      await cleanupAllConnectors();
    } catch (error) {
      console.warn("[disconnect] Connector cleanup failed:", error);
    }

    setDisconnecting(false);
  }, [cleanupAllConnectors, disconnect, disconnectAsync, disconnecting]);

  const handleConnect = React.useCallback(
    async (connector: any) => {
      if (!connector || connecting) return;

      const snapshot = wagmiConfig.state;
      if (
        snapshot.status !== "connected" &&
        snapshot.connections.size > 0
      ) {
        resetWagmiConnectionState();
      }

      setConnecting(true);
      let rejectedRetries = 0;
      let resetRetries = 0;
      try {
        console.log('[connect] Connecting with:', connector.name);
        const params = { connector, chainId: TARGET_CHAIN.id } as const;

        const attempt = async (): Promise<void> => {
          const startedAt = Date.now();
          try {
            await connectAsync(params);
          } catch (error) {
            const message = extractErrorMessage(error);
            const elapsedMs = Date.now() - startedAt;

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
              isWalletConnectConnector(connector) &&
              /user rejected/i.test(message) &&
              elapsedMs < 1_200 &&
              rejectedRetries < 1
            ) {
              rejectedRetries += 1;
              console.warn('[connect] WalletConnect phantom rejection detected, retrying');
              try {
                await connector.disconnect?.();
              } catch (phantomError) {
                console.warn('[connect] WalletConnect phantom cleanup failed:', phantomError);
              }
              await sleep(400);
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
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-3 py-1.5 rounded-md font-medium bg-rose-600 text-white hover:bg-rose-700 border border-transparent disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
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
  const { quiet } = useQuiet();
  const qc = useQueryClient();
  const { data: blockNumber } = useBlockNumber({
    watch: !quiet,
    query: {
      staleTime: 0,
      refetchOnWindowFocus: false,
    } as any,
  });

  const lastBlockRef = React.useRef<bigint | null>(null);
  React.useEffect(() => {
    if (quiet || blockNumber === undefined || blockNumber === null) return;
    if (lastBlockRef.current === blockNumber) return;
    lastBlockRef.current = blockNumber;
    nudgeQueries(qc, [0, 500]);
  }, [blockNumber, qc, quiet]);

  return null;
}

function HeartbeatRefresher() {
  const { quiet } = useQuiet();
  const qc = useQueryClient();
  React.useEffect(() => {
    if (quiet) return;
    let stopped = false;
    const iv = window.setInterval(() => {
      if (!stopped) nudgeQueries(qc, [0]);
    }, 4000);
    return () => {
      stopped = true;
      window.clearInterval(iv);
    };
  }, [qc, quiet]);
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
      <HeartbeatRefresher />

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
        <MaskStorageSync />
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