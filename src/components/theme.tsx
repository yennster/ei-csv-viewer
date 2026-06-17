"use client";

// src/components/theme.tsx — theme resolution + a small toggle control.
//
// The theme is driven by (in priority order): an explicit `theme` URL param,
// the persisted store value, or the OS `prefers-color-scheme`. Whatever wins is
// reflected as a `dark` class on <html> so the CSS variables in globals.css (and
// the uPlot chart colors that read them) flip correctly. Embedded mode honours
// the same logic so the iframe matches Studio's theme when passed `?theme=`.

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/store";

/** Apply (or remove) the `dark` class on the document element. */
function applyThemeClass(theme: "light" | "dark") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/**
 * Resolve the initial theme once: explicit param wins, else OS preference.
 * Safe to call on the client only.
 */
export function resolveInitialTheme(
  param: "light" | "dark" | undefined,
): "light" | "dark" {
  if (param) return param;
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

/**
 * Provider that keeps the <html> class in sync with the store theme and, when
 * no explicit theme param is supplied, follows live OS changes.
 */
export function ThemeProvider({
  initialTheme,
  followSystem = false,
  children,
}: {
  initialTheme?: "light" | "dark";
  /** When true, react to OS theme changes (only when no explicit param). */
  followSystem?: boolean;
  children: React.ReactNode;
}) {
  const theme = useEditorStore((s) => s.ui.theme);
  const setTheme = useEditorStore((s) => s.setTheme);

  // Seed the store from the resolved initial theme on first mount.
  React.useEffect(() => {
    if (initialTheme) setTheme(initialTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTheme]);

  // Keep the document class in sync with the store.
  React.useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // Optionally track the OS preference.
  React.useEffect(() => {
    if (!followSystem || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? "dark" : "light");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [followSystem, setTheme]);

  return <>{children}</>;
}

/** A compact light/dark toggle button. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useEditorStore((s) => s.ui.theme);
  const setTheme = useEditorStore((s) => s.setTheme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted",
        "hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        className,
      )}
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </button>
  );
}
