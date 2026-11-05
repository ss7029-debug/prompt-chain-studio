import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../lib/theme.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function environment(saved, blocked = false) {
  const storage = new Map(saved === undefined ? [] : [["prompt-chain-studio:theme", saved]]);
  const document = { documentElement: { dataset: {} } };
  const window = new EventTarget();
  const localStorage = {
    getItem: (key) => { if (blocked) throw new Error("Storage blocked"); return storage.get(key) ?? null; },
    setItem: (key, value) => { if (blocked) throw new Error("Storage blocked"); storage.set(key, value); },
  };
  const exports = {};
  const context = vm.createContext({ exports, window, document, localStorage, Event });
  vm.runInContext(source, context);
  return { ...exports, context, storage, document, window };
}

test("server snapshot is stable and does not depend on browser globals", () => {
  const exports = {};
  vm.runInNewContext(source, { exports });
  assert.equal(exports.getServerThemeSnapshot(), "system");
});

test("bootstrap applies only valid saved preferences before hydration", () => {
  for (const [saved, expected] of [[undefined, "system"], ["system", "system"], ["light", "light"], ["dark", "dark"], ["invalid", "system"], ["</script>", "system"]]) {
    const env = environment(saved);
    vm.runInContext(env.themeBootstrap, env.context);
    assert.equal(env.document.documentElement.dataset.theme, expected);
    assert.equal(env.getThemeSnapshot(), expected);
  }
});

test("theme selection persists and broadcasts, including when storage is blocked", () => {
  for (const blocked of [false, true]) {
    const env = environment(undefined, blocked);
    let notifications = 0;
    const unsubscribe = env.subscribeToTheme(() => notifications++);
    env.setThemePreference("dark");
    assert.equal(env.getThemeSnapshot(), "dark");
    assert.equal(notifications, 1);
    if (!blocked) assert.equal(env.storage.get(env.THEME_STORAGE_KEY), "dark");
    unsubscribe();
    env.setThemePreference("light");
    assert.equal(notifications, 1);
  }
});

test("refresh restores the preference and blocked storage safely falls back", () => {
  const env = environment("dark");
  env.restoreThemePreference();
  assert.equal(env.getThemeSnapshot(), "dark");
  env.document.documentElement.dataset.theme = "system";
  env.restoreThemePreference();
  assert.equal(env.getThemeSnapshot(), "dark");
  const blocked = environment("dark", true);
  vm.runInContext(blocked.themeBootstrap, blocked.context);
  assert.equal(blocked.getThemeSnapshot(), "system");
  blocked.setThemePreference("dark");
  blocked.restoreThemePreference();
  assert.equal(blocked.getThemeSnapshot(), "dark");
});

test("other tabs synchronize changes and storage clearing without unrelated events", () => {
  const env = environment("light");
  let notifications = 0;
  const unsubscribe = env.subscribeToTheme(() => notifications++);
  function dispatch(key) {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: key });
    env.window.dispatchEvent(event);
  }
  env.storage.set(env.THEME_STORAGE_KEY, "dark");
  dispatch(env.THEME_STORAGE_KEY);
  assert.equal(env.getThemeSnapshot(), "dark");
  dispatch("unrelated");
  assert.equal(notifications, 1);
  env.storage.clear();
  dispatch(null);
  assert.equal(env.getThemeSnapshot(), "system");
  assert.equal(notifications, 2);
  unsubscribe();
});

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const declarations = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]]));
const light = declarations(css.match(/:root\s*\{([^}]+)\}/)[1]);
const dark = declarations(css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)[1]);
const luminance = (hex) => {
  const rgb = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test("system dark uses the same palette and explicit light overrides OS dark", () => {
  const system = declarations(css.match(/:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{([^}]+)\}/)[1]);
  assert.deepEqual(system, dark);
  assert.equal(light.background.toUpperCase(), "#F5D5DF");
  assert.equal(light.surface.toUpperCase(), "#FFF8EE");
  assert.equal(light.foreground.toUpperCase(), "#593B32");
  assert.ok(css.includes("@media (prefers-color-scheme: dark)"));
});

test("all text and button palettes meet readable contrast in both themes", () => {
  for (const [name, palette] of [["light", light], ["dark", dark]]) {
    for (const foreground of ["foreground", "muted", "subtle", "accent", "danger"]) {
      for (const background of ["background", "surface", "field"]) {
        assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${name} ${foreground} on ${background}: ${contrast(palette[foreground], palette[background]).toFixed(2)}`);
      }
    }
    for (const background of ["primary", "primary-hover"]) {
      assert.ok(contrast(palette["on-primary"], palette[background]) >= 4.5, `${name} button contrast`);
    }
  }
});
