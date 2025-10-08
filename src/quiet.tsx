import * as React from "react";

const QuietCtx = React.createContext<
  { quiet: boolean; setQuiet: (b: boolean) => void } | null
>(null);

export function NetworkQuietProvider({ children }: { children: React.ReactNode }) {
  const [quiet, setQuiet] = React.useState(false);
  const value = React.useMemo(() => ({ quiet, setQuiet }), [quiet]);
  return <QuietCtx.Provider value={value}>{children}</QuietCtx.Provider>;
}

export function useQuiet() {
  const ctx = React.useContext(QuietCtx);
  if (!ctx) throw new Error("useQuiet must be used inside NetworkQuietProvider");
  return ctx;
}

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
