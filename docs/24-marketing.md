# 24 — Marketing Site Reference

The public marketing/landing site is a separate Astro app (`marketing/`), styled to match the product's visual language but independent of it.

## 24.1 Stack & config

- **Astro** (build `format: 'file'`), `@astrojs/react` islands, Tailwind v4 (`@tailwindcss/vite`).
- **i18n**: Astro built-in — `defaultLocale: 'en'` (no prefix), locales `en, id, es, pt-BR`.
- Scripts: `dev`, `build` (`astro build` → 28 pages), `preview`.
- `astro.config.mjs`: `noExternal: ['react-icons']` (SSR requirement), `__APP_VERSION__` define.

## 24.2 Pages (7 content + 7 `[lang]` wrappers)

| Page | Purpose |
|---|---|
| `index.astro` | Landing: hero (floating neumorphic cards + aurora), why, comparison, EncryptedFlow, SignupComparison, StatStrip, BlindRelay, features, how-it-works, testimonials, FAQ, CTA |
| `help.astro` | Help center: topics sidebar + 5 categories + FAQ accordion |
| `commercial.astro` | AGPL vs commercial license comparison + FAQ |
| `privacy.astro` | Privacy policy / terms / cookies / AI / security (scroll-spy TOC) |
| `refund.astro` | Crypto-only refund policy (NOWPayments) |
| `security.astro` | Security architecture: 12 sections with animated visualizations |
| `hall-of-fame.astro` | Security researchers registry |

Each has a `pages/[lang]/*.astro` wrapper (`getStaticPaths` for `id`/`es`/`pt-BR`) that re-renders the base page with a `lang` prop.

## 24.3 Components (10)

- `SEO.astro`, `Footer.astro`, `LanguageSwitcher.tsx` (Radix dropdown), `ThemeToggle.tsx` (light/dark, `localStorage.nyx_theme`, `data-theme`).
- Animated islands (framer-motion, scroll-trigger once, reduced-motion safe): `EncryptedFlow`, `BlindRelay`, `BurnerFlow`, `PqKeyExchange`, `SignupComparison`, `StatStrip`.

## 24.4 i18n (52 files)

`src/locales/{en,id,es,pt-BR}/` × 12 namespaces: `auth, commercial, common, errors, hall-of-fame, help, landing, modals, privacy, refund, security, settings`.
- `utils/i18n.ts`: `import.meta.glob('../locales/**/*.json', {eager})` → `useTranslations(lang)` returning `t('landing:hero.description')` with `{{var}}` interpolation.

## 24.5 Design tokens (`src/index.css`)

- Tailwind v4 `@theme` + `@custom-variant dark ([data-theme='dark'] &)`.
- **Soft neumorphism** (light/dark via `data-theme`): `--shadow-neu-flat/pressed/icon/icon-pressed/float`.
- **Aurora gradient** teal→indigo (`--grad-start/--grad-end`) + `.text-gradient-aurora`.
- Fonts: **Fraunces** (display serif) + **Inter** (body) loaded in `MainLayout.astro`.
- Utilities: `btn`, `btn-primary/secondary`, `card-neumorphic(-flat)`, `icon-well`, `toggle-neumorphic`, `aurora-blob`.
- Default theme is **light**; toggle persists to `localStorage`.

## 24.6 Layout

`MainLayout.astro` sets `<html data-theme>` + theme init inline script (pre-first-paint) + Google Fonts + `SEO`.

## 24.7 Notes

- Screenshots/assets in `src/assets/` (`noise.png`, `mobile-dark.png`, `mobile-light.png`).
- The marketing build also `@source`s `web/src/components` and `web/src/pages`, so shared class names remain consistent.
