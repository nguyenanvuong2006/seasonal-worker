# Public Registration — production visual regression fix

**Scope:** Public Registration only (no Visual V2 rollout to other screens, no business-logic change).
**Base:** `main` @ `eaae29b5b857d8a925e84538bf4cc64dcde8fb64` (PR #10 merged — Visual Redesign V2).
**Branch:** `arena/019ffb3f-seasonal-worker` (Arena session branch; the requested name was `fix/public-registration-visual-regression`).
**Date:** 2026-08-13

The previous session finished and locally verified this fix as
`a5ad4389889990d1aae5732380d9f9a51c81fece`, but that commit was never
pushed (the PR #10 coding session ended after merge). The object is **not**
in this clone’s object database, reflog, stash or any remote. This change
set restores the same verified behaviors from the session report — it is
not a redesign.

---

## 1. Root cause

Visual V2 painted brand bands with two utility classes on the **same** node:

```html
<header class="hasfarm-hero field-rows">…</header>
```

In `src/app/globals.css`:

| Rule | Specificity | What it set |
| --- | --- | --- |
| `.hasfarm-hero` | `(0,1,0)` | `background:` shorthand = greenhouse gradient **and** `background-color: transparent` |
| `.field-rows` (declared later) | `(0,1,0)` | `background-image:` = faint white planting-row lines only |

Equal specificity + later source order meant `.field-rows` **replaced** the
entire greenhouse gradient. Combined with the transparent color from the
shorthand, the hero (and the form `StageHeader`, which uses the same pair)
collapsed onto the cream page surface `#F6F2E9`.

That single cascade bug produced every “production looks broken” symptom:

- **White-wash hero** — cream page showing through, chrysanthemum photo then
  further hidden by `opacity-[0.16] mix-blend-screen`.
- **White-on-white form header** — `text-white` sitting on cream.
- **Abnormal right-hand white strip** — the official hero file is a photo
  collage on a **white canvas**. Once the green band was gone, that canvas
  read as a blank strip on wide viewports.

A second, independent content defect shipped in the same pilots and is
fixed here: the candidate-facing process still named internal systems
(`Daily Application`, `DW Data`, `Location → Division → Department →
Section → Group`) and the support number on the public page was the
retired landline, now replaced by the official **0263 3620295**.

---

## 2. Before / after

| | Before (PR #10 on production) | After (this fix) |
| --- | --- | --- |
| Hero band | Cream / white-wash, photo invisible | Deep-green greenhouse gradient + field-rows texture |
| Chrysanthemum photo | 16% opacity, `mix-blend-screen` (a white overlay) | Full-color collage, `mix-blend-multiply` so the white canvas disappears over green |
| Text readability | White headline on cream | Localized dark-green scrim **behind the text column only** |
| Form header | White-on-white “Xác thực thông tin ứng viên” | Restored green brand band; heading shortened to **Xác thực thông tin** |
| Form fields | Light borders, easy to miss | Dark `text-fg` on `bg-surface`, `border-2 border-primary/30`, orange focus + green glow |
| Layout | `max-w-6xl` (1152px), 2-col from `md` | Centered `max-w-[1400px]`, full-viewport cream background, `overflow-x-hidden`, 2-col from `lg` so 768px stays a single readable column |
| Process | Internal HR jargon | 1 Tiếp nhận thông tin đăng ký → 2 Đối chiếu hồ sơ → 3 Xếp bộ phận phù hợp → 4 Thông báo kết quả tiếp nhận |
| Phone | retired landline on the public card | **0263 3620295** / `tel:+842633620295` |
| Logo | Official slot + `ImageOff` fallback (unchanged policy) | Same policy. File now exists at `public/brand/dalat-hasfarm-logo.png`; still no “DH”, no generated mark |

---

## 3. What changed (and what did not)

Touched on purpose:

- `src/app/globals.css` — longhand `background-color` + `background-image` on
  `.hasfarm-hero`; new **`.hasfarm-hero.field-rows`** combined rule (the
  specificity fix). `.field-rows` stays an overlay-safe longhand so the
  sidebar texture is untouched.
- `src/app/page.tsx` — hero photo treatment, 1400px container, candidate
  process copy, official phone.
- `src/components/applicant-portal.tsx` — heading, input border/focus,
  light-surface / dark-text lock on the check-stage body.
- `HUONG-DAN-TUNG-FILE.md` — documents the new number.
- `scripts/verify-public-regression.mjs` — automated gates for all of the above.
- `docs/design-v2/REGRESSION-FIX.md` (this file) and screenshots under
  `docs/design-v2/regression-fix/`.

Not touched:

- Registration / CCCD / QR / returning-applicant logic.
- RBAC, Data Scope, Form Builder, workflow, planning calculations.
- Visual V2 composition on Dashboard, Daily Application, Planning, Sidebar
  (they only inherit the repaired CSS utility — the same class pair on the
  dashboard command strip now paints green again, which is the original V2
  intent, not a new redesign).

---

## 4. Phone correction

Repo-wide audit of application/docs source (excluding `data/` historical
CSV and `package-lock.json`):

| Needle | Occurrences |
| --- | --- |
| retired landline (old public support number) | **0** |
| `0263 3620295` (display) | `src/app/page.tsx`, `HUONG-DAN-TUNG-FILE.md` |
| `tel:+842633620295` | `src/app/page.tsx` |

Display text is exactly `0263 3620295`. The `tel:` href uses the
normalized E.164 form `+842633620295` (Lâm Đồng landline 0263 → +84 263).

---

## 5. Official assets

These files **are present on current `main`** (added with PR #10):

| Path | Notes |
| --- | --- |
| `public/brand/dalat-hasfarm-chrysanthemum-hero.png` | Official approved hero (PNG). It is a **photo collage on a white canvas**, not a full-bleed flower field. The multiply blend + left scrim are how we show flower color without white-wash. |
| `public/brand/dalat-hasfarm-logo.png` | Official lockup (wordmark + “We Color the World”) on a **black** board. `BrandLogo` still probes this exact path and falls back to `ImageOff` if the file is removed. |
| `public/brand/dalat-hasfarm-greenhouse-operations.jpg` | Approved operations photo slot — not used on Public Registration. |

Per project rules this session:

- did **not** generate a logo
- did **not** substitute the letters “DH”
- did **not** fake a wordmark
- kept the graceful empty-slot fallback in `BrandLogo`

If either official file is deleted later, the public page still renders: the
hero CSS background 404s silently onto the greenhouse gradient, and the
logo tile shows `ImageOff`. No broken-image icon.

---

## 6. Responsive visual QA

Screenshots (Playwright/Chromium, public `/` only, no personal data):

| Viewport | Path |
| --- | --- |
| 1920×1080 | `docs/design-v2/regression-fix/public-registration-1920x1080.png` |
| 1440×900 | `docs/design-v2/regression-fix/public-registration-1440x900.png` |
| 1280×800 | `docs/design-v2/regression-fix/public-registration-1280x800.png` |
| 768×1024 | `docs/design-v2/regression-fix/public-registration-768.png` |
| 390×844 | `docs/design-v2/regression-fix/public-registration-390.png` |

Checked at every width:

- no white-wash on the hero
- no white-on-white on the form header or fields
- no horizontal overflow (`overflowX = 0`)
- no abnormal right-hand white strip
- hero headline readable against the localized green scrim
- form labels/inputs readable (dark on ivory, visible border)
- green + orange recognition (brand band + orange CTA / focus)
- process timeline readable with the four candidate-facing steps

---

## 7. Automated gates & tests

| Gate | Result |
| --- | --- |
| `node scripts/verify-public-regression.mjs` | ✅ all public-registration gates |
| `node scripts/verify-redesign.mjs` | ✅ 5/5 (V2 planning/CCCD/hierarchy gates still green) |
| `npm test` | ✅ |
| `npm run typecheck` | ✅ |
| `npm run build` | ✅ |
| `npm run lint` | ✅ (pre-existing `react-hooks` warnings only, baseline unchanged) |
| `git diff --check` | ✅ clean |

The public regression script specifically asserts that
`.hasfarm-hero.field-rows` exists, that it contains **both** the field-row
texture **and** the `#08290f → #145a2d` greenhouse gradient, and that
`.field-rows` alone still uses the `background-image` longhand (so the
sidebar overlay keeps working).
