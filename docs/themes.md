# Light, Dark, and System themes

Use the **Theme** selector at the top of any page, including Login and Access
Restricted. **Light** preserves the pink page, cream cards, and brown text and
buttons. **Dark** uses plum/deep brown surfaces, muted pink buttons, and light
text. **System** follows the operating system's appearance and updates when it
changes, without a reload. The default is System.

The preference is stored under `prompt-chain-studio:theme` in localStorage and
synchronizes across tabs on the same origin. It survives refreshes, navigation,
and authentication redirects. With blocked browser storage, themes still work
in the current tab, but persistence across refreshes is unavailable.

A fixed inline script in the document head restores the preference before first
paint. CSS handles System mode, including when JavaScript is unavailable. The
root hydration warning suppression is limited to the HTML element whose theme
attribute the script changes. The selector uses a stable server snapshot and
restores the attribute before paint after development Strict Mode remounts.

All page colors, form fields, errors, buttons, and generated outputs use shared
semantic CSS tokens in `app/globals.css`. Text and button combinations meet at
least 4.5:1 contrast in both palettes. The existing Tailwind loader also processes
the global stylesheet in Webpack builds so fallback builds include utility CSS.
No new theme dependency, database change, or authentication change is needed.

## Manual verification

1. Start the app and choose Light on the login page. Confirm the original palette.
2. Choose Dark. Verify the selector, login panel and button use the dark palette.
3. Refresh and visit Access Restricted (`/unauthorized`). Dark should persist.
4. Sign in and check the dashboard, chain create/edit/delete forms, chain details,
   step forms, Run Chain input, intermediate/final outputs, and Generated Results.
   All should use the same palette. Switching the theme does not submit forms or
   change an active AI run.
5. Choose System, then change the OS between light/dark (or use Chrome DevTools
   Rendering > Emulate CSS media feature prefers-color-scheme). Colors should
   update immediately. Explicit Light/Dark should override OS changes.
6. Open another tab on the same origin and change the selection in either tab.
   Both should synchronize. Use a hard refresh with slow network throttling to
   check saved Dark appears before hydration, with no light-page flash.
7. Check the browser console for hydration warnings and test keyboard access to
   the labeled native select. No theme-related hydration warnings are expected.

## Automated verification

Run builds and TypeScript sequentially because Next.js regenerates `.next/types`
during builds:

```sh
npm run lint
npm run build -- --webpack
npx tsc --noEmit
node --test tests/theme.test.mjs tests/ai-execution.test.mjs tests/chain-runs.test.mjs tests/step-management.test.mjs
node --test tests/theme-browser.test.mjs
```

SQL regression tests require local PostgreSQL tools and use disposable clusters,
never Supabase. AI tests use mocked providers and never make paid requests.
Browser tests require an existing production build and Google Chrome (on macOS
by default, or set `CHROME_BINARY` to its executable). They launch a temporary
local server and fresh headless profile, and only visit public pages. They test
real CSS, persistence, live OS changes, cross-tab updates, blocked storage,
pre-hydration dark styling, and hydration errors. The suite skips if Chrome is
not installed. No extra browser/test dependency is installed.
