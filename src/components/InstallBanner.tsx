import * as React from "react";

// Minimal event typing for Chrome/Edge PWA install flow
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISS_KEY = "meowt:pwa:dismissedAt";
const DISMISS_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function isStandalone() {
  if (typeof window === "undefined") return false;
  // Chrome/Edge
  const dm = window.matchMedia?.("(display-mode: standalone)")?.matches;
  // iOS Safari
  // @ts-ignore
  const iosStandalone = (navigator as any)?.standalone === true;
  return Boolean(dm || iosStandalone);
}

function recentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_COOLDOWN_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

function rememberDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

function isIOS() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent || "");
}

export default function InstallBanner() {
  const [deferred, setDeferred] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = React.useState(false);
  const [iosHint, setIosHint] = React.useState(false);

  // Show banner only when:
  // - Not already installed
  // - Not recently dismissed
  // - Either we have a deferred prompt, or (on iOS) we show the hint variant
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) return; // Already installed
    if (recentlyDismissed()) return;

    // iOS fallback (no beforeinstallprompt)
    if (isIOS()) {
      setIosHint(true);
      setVisible(true);
      return;
    }

    const onBIP = (e: Event) => {
      // Only act on supported browsers
      const bip = e as BeforeInstallPromptEvent;
      // Prevent the mini-infobar from appearing on mobile
      // (Older docs recommended preventDefault; newer Chrome ignores it,
      // but keeping for wider compat where still honored.)
      if ((bip as any).preventDefault) (bip as any).preventDefault();
      setDeferred(bip);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onBIP as EventListener);
    return () => window.removeEventListener("beforeinstallprompt", onBIP as EventListener);
  }, []);

  // Hide entirely if installed later during the session
  React.useEffect(() => {
    if (!visible) return;
    const media = window.matchMedia?.("(display-mode: standalone)");
    if (!media) return;
    const handler = () => {
      if (media.matches) setVisible(false);
    };
    try {
      media.addEventListener?.("change", handler);
      return () => media.removeEventListener?.("change", handler);
    } catch {
      /* ignore */
    }
  }, [visible]);

  if (!visible) return null;

  async function onInstallClick() {
    try {
      if (iosHint) {
        // No programmatic install on iOS; show a transient helper toast-like tip
        // We’ll auto-dismiss for the cooldown to avoid nagging.
        rememberDismiss();
        setVisible(false);
        alert("On iOS: Tap the share button, then 'Add to Home Screen'.");
        return;
      }
      if (!deferred) return;
      await deferred.prompt();
      const res = await deferred.userChoice;
      // Respect user’s choice; if dismissed, also cooldown
      if (res.outcome === "accepted") {
        setDeferred(null);
        setVisible(false);
      } else {
        rememberDismiss();
        setDeferred(null);
        setVisible(false);
      }
    } catch {
      // If anything goes wrong, just hide for this session
      setVisible(false);
    }
  }

  function onClose() {
    rememberDismiss();
    setVisible(false);
  }

  // Simple, small banner styling; fixed, high z-index; non-intrusive.
  return (
    <div
      className="fixed left-0 right-0 top-0 z-[2000] px-3 py-2"
      role="region"
      aria-label="Install app"
    >
      <div
        className="mx-auto max-w-3xl rounded-md bg-rose-600 text-white shadow-md border border-white/10
                   flex items-center gap-2 pl-3 pr-1 py-1"
      >
        <div className="text-sm font-semibold flex-1">
          {iosHint ? "Install HearMeOwT: Share → Add to Home Screen" : "Install the HearMeOwT app?"}
        </div>
        <button
          onClick={onInstallClick}
          className="px-2 py-1 rounded-md bg-white text-rose-700 font-semibold text-xs hover:bg-rose-50 active:scale-95"
        >
          {iosHint ? "How to" : "Install"}
        </button>
        <button
          onClick={onClose}
          className="px-2 py-1 rounded-md text-white/90 hover:bg-white/10 text-xs"
          aria-label="Close install banner"
          title="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
