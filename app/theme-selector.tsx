"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  getServerThemeSnapshot, getThemeSnapshot, parseTheme, restoreThemePreference,
  setThemePreference, subscribeToTheme,
} from "@/lib/theme";

export default function ThemeSelector() {
  const preference = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getServerThemeSnapshot);
  useLayoutEffect(restoreThemePreference, []);

  return (
    <header className="border-b border-line bg-page px-5 py-3 text-ink">
      <div className="mx-auto flex max-w-5xl items-center justify-end gap-3">
        <label htmlFor="theme-preference" className="text-sm font-semibold">Theme</label>
        <select
          id="theme-preference"
          value={preference}
          onChange={(event) => setThemePreference(parseTheme(event.target.value))}
          className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
      </div>
    </header>
  );
}
