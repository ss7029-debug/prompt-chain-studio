export const THEME_STORAGE_KEY = "prompt-chain-studio:theme";
export const THEME_CHANGE_EVENT = "prompt-chain-studio:theme-change";
export type ThemePreference = "light" | "dark" | "system";

export function parseTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

// A fixed, trusted inline script runs in <head> before the first paint. System
// resolution stays in CSS, so OS changes work immediately without a JS listener.
export const themeBootstrap = `(function(){var t="system";try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==="light"||s==="dark")t=s}catch{}document.documentElement.dataset.theme=t})()`;

export function getThemeSnapshot(): ThemePreference {
  return parseTheme(document.documentElement.dataset.theme);
}

export function getServerThemeSnapshot(): ThemePreference {
  // Must agree with the server-rendered selector during hydration.
  return "system";
}

export function setThemePreference(value: ThemePreference) {
  const theme = parseTheme(value);
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {
    // The current tab still works when browser storage is blocked or full.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function restoreThemePreference() {
  // Also reapplies the preference after React's development Strict Mode remount.
  try {
    document.documentElement.dataset.theme = parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    document.documentElement.dataset.theme = getThemeSnapshot();
  }
}

export function subscribeToTheme(onChange: () => void) {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      restoreThemePreference();
      onChange();
    }
  };
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", storageChanged);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", storageChanged);
  };
}
