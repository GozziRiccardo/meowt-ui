import * as React from "react";
import { useBlockNumber, usePublicClient } from "wagmi";

export type ChainTimeContextValue = {
  nowSec: number;
  nowMs: number;
  sync: (epochSeconds: number) => void;
};

const ChainTimeContext = React.createContext<ChainTimeContextValue | null>(null);

type Anchor = { epochSec: number; fetchedAtMs: number };

let latestNowSec = Math.floor(Date.now() / 1000);
let latestNowMs = Date.now();

function computeFromAnchor(anchor: Anchor): { nowSec: number; nowMs: number } {
  if (anchor.epochSec > 0 && anchor.fetchedAtMs > 0) {
    const elapsedMs = Math.max(0, Date.now() - anchor.fetchedAtMs);
    const nowSec = anchor.epochSec + Math.floor(elapsedMs / 1000);
    const nowMs = anchor.epochSec * 1000 + elapsedMs;
    return { nowSec, nowMs };
  }
  const nowMs = Date.now();
  return { nowSec: Math.floor(nowMs / 1000), nowMs };
}

export function ChainTimeProvider({ children }: { children: React.ReactNode }) {
  const anchorRef = React.useRef<Anchor>({ epochSec: 0, fetchedAtMs: 0 });
  const [clock, setClock] = React.useState(() => computeFromAnchor(anchorRef.current));

  const pushClock = React.useCallback((next: { nowSec: number; nowMs: number }) => {
    latestNowSec = next.nowSec;
    latestNowMs = next.nowMs;
    setClock((prev) => {
      if (prev.nowSec === next.nowSec && Math.abs(prev.nowMs - next.nowMs) < 400) return prev;
      return next;
    });
  }, []);

  const sync = React.useCallback(
    (epochSeconds: number) => {
      if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return;
      const normalized = Math.floor(epochSeconds);
      const nextAnchor: Anchor = { epochSec: normalized, fetchedAtMs: Date.now() };
      anchorRef.current = nextAnchor;
      pushClock(computeFromAnchor(nextAnchor));
    },
    [pushClock],
  );

  const tick = React.useCallback(() => {
    pushClock(computeFromAnchor(anchorRef.current));
  }, [pushClock]);

  React.useEffect(() => {
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [tick]);

  const publicClient = usePublicClient();
  const { data: blockNumber } = useBlockNumber({
    watch: true,
    query: { staleTime: 0, refetchOnWindowFocus: false } as any,
  });

  React.useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const block = await publicClient.getBlock({ blockTag: "latest" });
        if (!cancelled && block?.timestamp) {
          sync(Number(block.timestamp));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, sync]);

  React.useEffect(() => {
    if (!publicClient || blockNumber == null) return;
    let cancelled = false;
    (async () => {
      try {
        const block = await publicClient.getBlock({ blockNumber });
        if (!cancelled && block?.timestamp) {
          sync(Number(block.timestamp));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, blockNumber, sync]);

  const value = React.useMemo(
    () => ({ nowSec: clock.nowSec, nowMs: clock.nowMs, sync }),
    [clock.nowSec, clock.nowMs, sync],
  );

  return <ChainTimeContext.Provider value={value}>{children}</ChainTimeContext.Provider>;
}

export function useChainTime(): ChainTimeContextValue {
  const ctx = React.useContext(ChainTimeContext);
  if (!ctx) throw new Error("useChainTime must be used inside ChainTimeProvider");
  return ctx;
}

export function readChainNow(): number {
  return latestNowSec;
}

export function readChainNowMs(): number {
  return latestNowMs;
}
