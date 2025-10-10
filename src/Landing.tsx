import React from "react";
import { useNavigate } from "react-router-dom";

/* ---- Background (day/night, mobile/desktop) ---- */


function ThemeToggle() {
  const [dark, setDark] = React.useState(() => {
    const pref = localStorage.getItem("theme");
    if (pref) return pref === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  React.useEffect(() => {
    const el = document.documentElement;
    if (dark) {
      el.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      el.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [dark]);

  return (
    <button
      onClick={() => setDark((d) => !d)}
      className="px-3 py-1.5 rounded-lg border border-black/10 dark:border-white/10
                 hover:bg-black/5 dark:hover:bg-white/10 transition"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? "☀️" : "🌙"}
    </button>
  );
}


function useThemeBoot() {
  React.useEffect(() => {
    const pref = localStorage.getItem("theme");
    const isDark = pref ? pref === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const el = document.documentElement;
    isDark ? el.classList.add("dark") : el.classList.remove("dark");
  }, []);
}


function BackgroundArtLanding() {
  const dayDesktop = "/backgrounds/landing-day-desktop.webp";
  const nightDesktop = "/backgrounds/landing-night-desktop.webp";
  const dayMobile = "/backgrounds/landing-day-mobile.webp";
  const nightMobile = "/backgrounds/landing-night-mobile.webp";

  React.useEffect(() => {
    [dayDesktop, nightDesktop, dayMobile, nightMobile].forEach((src) => {
      if (!src) return;
      const img = new Image();
      img.src = src;
    });
  }, []);

  // Mobile & small screens: keep full image (no crop).
  // Laptops/desktops (>= lg): fill the viewport to avoid side blanks.
  // Center the art; change to object-[60%_0%] if you want a slight right bias.
  const fitCls =
    "w-full h-full object-contain lg:object-cover object-center select-none pointer-events-none";

  return (
    <>
      {/* Light mode art */}
      <picture className="absolute inset-0 -z-10 block dark:hidden">
        <source media="(max-aspect-ratio: 3/4)" srcSet={dayMobile} />
        <img src={dayDesktop} alt="" decoding="async" fetchPriority="low" className={`${fitCls} bg-rose-50`} />
      </picture>

      {/* Dark mode art */}
      <picture className="absolute inset-0 -z-10 hidden dark:block">
        <source media="(max-aspect-ratio: 3/4)" srcSet={nightMobile} />
        <img src={nightDesktop} alt="" decoding="async" fetchPriority="low" className={`${fitCls} bg-neutral-950`} />
      </picture>

      {/* Overlays (below content, above images) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(244,63,94,0.12),transparent_70%)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(rgba(244,63,94,0.16)_1px,transparent_1px)] [background-size:14px_14px] opacity-60 dark:opacity-25" />
      <div
  aria-hidden
  className="pointer-events-none absolute inset-0 z-0
             bg-white/45 dark:bg-black/45
             backdrop-blur-[2px]"
/>
    </>
  );
}



export default function Landing() {
  useThemeBoot();
  const navigate = useNavigate();
  const whitepaperUrl =
    (import.meta.env as any).VITE_WHITEPAPER_URL ?? "https://example.com/whitepaper";

  const [dontShow, setDontShow] = React.useState(
    () => localStorage.getItem("skipLanding") === "1"
  );

  React.useEffect(() => {
    if (localStorage.getItem("skipLanding") === "1") {
      navigate("/app", { replace: true });
    }
  }, [navigate]);

  function goToApp() {
    if (dontShow) localStorage.setItem("skipLanding", "1");
    navigate("/app");
  }

  return (
    <div className="min-h-screen relative overflow-hidden text-neutral-900 dark:text-neutral-100">
      <BackgroundArtLanding />

      {/* Content layer above overlays */}
      <div className="relative z-10 flex flex-col items-center justify-between min-h-screen">
        {/* Header */}
        <header className="w-full py-6">
  <div className="max-w-4xl mx-auto px-4 flex items-center justify-center gap-3 flex-wrap">
    <img src="/brand/logo-meowt.png" alt="$MEOWT" className="w-8 h-8 md:w-10 md:h-10" />
    <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">HearMeOwT</h1>
    <ThemeToggle />
  </div>
</header>


        {/* HERO (restored & styled) */}
        <main className="w-full flex-1 flex items-center">
  <div className="max-w-3xl mx-auto px-4">
    <div className="rounded-2xl
                    bg-white/70 dark:bg-black/40
                    backdrop-blur-[2px]
                    ring-1 ring-black/10 dark:ring-white/10
                    p-6 md:p-8 text-center space-y-8">

      {/* Badge */}
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full
                      bg-white/80 dark:bg-white/10 border border-black/10 dark:border-white/10
                      text-xs font-semibold tracking-wide uppercase">
        🐾 Welcome to the rooftop
      </div>

      {/* Headline with subtle shadow for extra pop */}
      <h2 className="text-3xl md:text-4xl font-extrabold leading-tight
                     drop-shadow-[0_2px_2px_rgba(0,0,0,0.35)]">
        <span className="bg-gradient-to-r from-rose-600 to-rose-400 dark:from-rose-300 dark:to-rose-200
                         bg-clip-text text-transparent">
          Say it. Be heard. Meowt it.
        </span>
      </h2>

      {/* Banter paragraph */}
      <p className="text-base md:text-lg leading-relaxed text-neutral-800 dark:text-neutral-200">
        Got something important to say but nobody listens to your <em>rambling</em> anymore?
        You’re in the right place. You finally found the{" "}
        <span className="font-semibold text-rose-700 dark:text-rose-300">crowd</span> you were looking for: ready to cheer you on.
        These old cats won’t let you down… and who knows, you might score a few free treats for your whiskers 🐟✨.
      </p>

      {/* What it is */}
      <p className="text-sm md:text-base leading-relaxed opacity-90">
        Stake to post a <span className="font-semibold text-rose-700 dark:text-rose-300">meowssage</span>,
        replace it with a stronger one, <span className="font-semibold">boost</span> it,
        or vote 😺/😾 to steer the crowd. When the timer hits zero, the current message is crowned..
        until the next challenger appears.
      </p>

      {/* Chips */}
      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        <span className="px-3 py-1 rounded-full text-xs font-medium
                         bg-white/80 dark:bg-white/10 border border-black/10 dark:border-white/10">
          🎤 One message at a time
        </span>
        <span className="px-3 py-1 rounded-full text-xs font-medium
                         bg-white/80 dark:bg-white/10 border border-black/10 dark:border-white/10">
          ⏱️ Live timer
        </span>
        <span className="px-3 py-1 rounded-full text-xs font-medium
                         bg-white/80 dark:bg-white/10 border border-black/10 dark:border-white/10">
          💰 Stake & share
        </span>
        <span className="px-3 py-1 rounded-full text-xs font-medium
                         bg-white/80 dark:bg-white/10 border border-black/10 dark:border-white/10">
          🧶 Replace & vote
        </span>
      </div>

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
        <button
          onClick={goToApp}
          className="px-5 py-2.5 rounded-lg font-semibold
                     bg-rose-600 text-white hover:bg-rose-700
                     dark:bg-rose-400 dark:text-black dark:hover:bg-rose-300
                     transition inline-flex items-center gap-2">
          🚀 Launch dApp
        </button>

        <a
          href={whitepaperUrl}
          target="_blank"
          rel="noreferrer"
          className="px-5 py-2.5 rounded-lg font-semibold
                     border border-black/10 dark:border-white/15
                     hover:bg-black/5 dark:hover:bg-white/10 transition
                     inline-flex items-center gap-2">
          📖 Read the Whitepaper
        </a>
      </div>

      {/* Don’t show again */}
      <label className="flex items-center justify-center gap-2 text-xs opacity-75 pt-1">
        <input
          type="checkbox"
          checked={dontShow}
          onChange={(e) => setDontShow(e.target.checked)}
          className="accent-rose-600"
        />
        Don’t show this page again
      </label>
    </div>
  </div>
</main>


        {/* Footer */}
        <footer className="w-full py-6">
          <div className="max-w-4xl mx-auto px-4 text-center text-xs opacity-80">
            Built on Base · $MEOWT
          </div>
        </footer>
      </div>
    </div>
  );
}
