import * as React from "react";

type QuietAPI = {
  quiet: boolean;
  /** Legacy toggle – still supported. */
  setQuiet: (b: boolean) => void;
  /** Immediately clear quiet (ignores nesting). Safe to call anytime. */
  forceOff: () => void;
  /**
   * Begin a quiet window that auto-expires after `ttlMs` (default 7000ms).
   * Returns a function you should call to end it early.
   */
  begin: (ttlMs?: number) => () => void;
};

const QuietCtx = React.createContext<QuietAPI | null>(null);

export function NetworkQuietProvider({ children }: { children: React.ReactNode }) {
  // Internal refcount so nested quiet sections don't fight each other.
  const countRef = React.useRef(0);
  const lastOnRef = React.useRef(0);
  const [quiet, setQuietState] = React.useState(false);

  const setQuiet = React.useCallback((b: boolean) => {
    if (b) {
      countRef.current = Math.max(1, countRef.current + 1);
      lastOnRef.current = Date.now();
      if (!quiet) setQuietState(true);
    } else {
      countRef.current = Math.max(0, countRef.current - 1);
      if (countRef.current === 0) setQuietState(false);
    }
  }, [quiet]);

  const forceOff = React.useCallback(() => {
    countRef.current = 0;
    setQuietState(false);
  }, []);

  const begin = React.useCallback((ttlMs = 7000) => {
    setQuiet(true);
    lastOnRef.current = Date.now();
    let ended = false;
    const timer = window.setTimeout(() => {
      if (!ended) forceOff();
    }, Math.max(500, ttlMs));
    return () => {
      if (ended) return;
      ended = true;
      window.clearTimeout(timer);
      setQuiet(false);
    };
  }, [setQuiet, forceOff]);

  // Safety fuse in case a caller forgets to end quiet or a promise stalls.
  React.useEffect(() => {
    if (!quiet) return;
    const iv = window.setInterval(() => {
      if (!quiet) return;
      const age = Date.now() - lastOnRef.current;
      if (age > 7000) forceOff();
    }, 400);
    return () => window.clearInterval(iv);
  }, [quiet, forceOff]);

  const value = React.useMemo<QuietAPI>(
    () => ({ quiet, setQuiet, forceOff, begin }),
    [quiet, setQuiet, forceOff, begin]
  );

  return <QuietCtx.Provider value={value}>{children}</QuietCtx.Provider>;
}

export function useQuiet() {
  const ctx = React.useContext(QuietCtx);
  if (!ctx) throw new Error("useQuiet must be used inside NetworkQuietProvider");
  return ctx;
}

/** Back-compat helper. Prefer `const end = begin(); try { ... } finally { end(); }` */
export async function runQuietly<T>(
  setQuiet: (b: boolean) => void,
  fn: () => Promise<T>
): Promise<T> {
  setQuiet(true);
  try {
    return await fn();
  } finally {
    setQuiet(false);
  }
}
