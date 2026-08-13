# Visual Redesign V2 — Premium Dalat Hasfarm HR Operations Platform

**Pilot scope:** Dashboard · Daily Application · Public Registration · Planning
**Branch:** `arena/019ffa57-seasonal-worker`
**Baseline commit:** `852a676` (main)
**Date:** 2026-08-13

---

## 1. Baseline audit (before redesign)

The pre-V2 UI shipped with:

- A neutral **white/gray** surface (`bg-gray-50`, white cards) with a mid-green
  (`hasfarm-700 #115830`) as the only brand color and a **gold** (`#b8841c`) used as
  both accent and button fill — the palette read as a generic admin template rather
  than a flower-farm operations brand.
- **Dashboard** = a `PageHeader` + a uniform grid of identical white KPI/Table widget
  cards; no hierarchy, no "today's focus", no planning/movement awareness.
- **Daily Application** = long page header + 3 identical KPI cards + a flat toolbar +
  a dense table with a solid **dark-green header** and no row-selection affordance.
- **Public Registration** = a hero that loaded a **Google Drive-hosted farm photo**
  (external URL), plus a form styled with slate/gold tones and toast-only validation.
- **Planning** = 4 identical KPI cards, a plain status tab row, and a spreadsheet
  table with the same dark-green header; periods had no time visualization.
- **Sidebar** = flat dark green with an **"DH" text fallback** in the collapsed brand
  tile, no theme chip, no separated user-utilities zone.

---

## 2. Before / after screenshot index

| Screen | Desktop 1440px | Mobile 390px |
| --- | --- | --- |
| Dashboard | `docs/design-v2/before/dashboard-1440.png` → `docs/design-v2/after/dashboard-1440.png` | `before/dashboard-390.png` → `after/dashboard-390.png` |
| Daily Application | `before/daily-application-1440.png` → `after/daily-application-1440.png` | `before/daily-application-390.png` → `after/daily-application-390.png` |
| Public Registration | `before/public-registration-1440.png` → `after/public-registration-1440.png` | `before/public-registration-390.png` → `after/public-registration-390.png` |
| Planning | `before/planning-1440.png` → `after/planning-1440.png` | `before/planning-390.png` → `after/planning-390.png` |

All screenshots use **100% fake demo data** (fabricated CCCD numbers, names, phones,
departments) seeded into the local dev database — no real personal data is committed.
Pixel-diff measurement shows **~80–93% of pixels changed** on every screen between
before/after.

---

## 3. Design decisions

1. **Cream-first surfaces.** The page background is warm cream `#F6F2E9`, cards are
   ivory `#FFFCF6` with hairline warm borders — so the neutral surface dominates
   (~68–90% of sampled pixels) and color is used as signal, not decoration.
2. **Deep green = navigation/brand anchor only.** The sidebar, public hero, login
   panel and dashboard command strip carry the greenhouse gradient
   (`#08290F → #145A2D` + gold sunlight glows); operational surfaces stay cream.
3. **Hasfarm orange = CTA + selection.** `#E26D1C` is the primary button fill, the
   selected-row inset bar, the active nav accent, the shortage hero number and the
   public CTA. `variant="gold"` call sites now render this same orange (gold is
   retired as a button fill; warm yellow `#D9A327` remains only as a rare highlight).
4. **Botanical light green** (`#E4ECDB` family) is used for secondary surfaces:
   question cards, process-step chips, row hover.
5. **Identity from the farm, not stock photos.** Greenhouse gradients, a
   "field-rows" texture (repeating row/column hairlines), petal-arch radii and
   sunlight glows replace the external farm photo on the public hero (see blockers).
6. **No all-cards-different coloring.** Cards stay ivory; tone is applied to icons,
   numbers and small chips only.
7. **Composition over widget-grid.** Every pilot got a purposeful vertical rhythm:
   command strip → focus panel → snapshot → activity → actions, instead of rows of
   identical KPI cards.

---

## 4. Redesigned components

| Component | File | What changed |
| --- | --- | --- |
| Design tokens / utilities | `src/app/globals.css` | Full V2 palette (cream/ivory/deep green/orange/botanical), `hasfarm-hero`, `field-rows` texture, `petal-arch`, `v2-scroll`, motion primitives + `prefers-reduced-motion` kill-switch |
| UI kit | `src/components/ui.tsx` | Buttons (orange primary), inputs (warm borders, orange focus), `Card`, `PageHeader` (+`SectionLabel` eyebrow), `Badge`, `KpiCard`; new primitives: `MetricStrip`, `NumberTile`, `ProgressBar`, `GenderSplit`, `GenderLegend`, `AlertPanel`, `PeriodBar` |
| Sidebar V2 | `src/components/sidebar.tsx` | Deep-green gradient canvas + field-rows texture, brand zone with logo slot (no "DH" fallback), orange theme chip, group labels, green-structure + orange-accent active state, separated user utilities, mobile drawer focus trap; **RBAC filtering untouched** |
| Dashboard | `src/app/(internal)/admin/dashboard/page.tsx`, `src/components/dashboard-widgets.tsx`, `src/lib/dashboard.ts` | Command strip (greeting + VN date + theme slogan), "Hôm nay cần chú ý" alert panel, recruitment demand snapshot (shortage hero + fill-rate + gender progress), movement alerts, activity `MetricStrip`, role-aware quick actions, widgets kept (KPI → `NumberTile`, TABLE → styled table); new read-only `getDashboardOverview()` respecting Data Scope |
| Daily Application | `src/app/(internal)/hr/registrations/page.tsx`, `src/components/registrations-grid.tsx` | Short header + compact `MetricStrip`; operational toolbar; table as visual center (sticky ivory header, botanical row hover, orange selection with inset bar, responsive column hiding, compact density); dark-green contextual bulk bar that appears **only** when rows are selected. Inline edit, export, history, bulk, validation and workflow engine untouched |
| Public Registration | `src/app/page.tsx`, `src/components/applicant-portal.tsx` | External Google Drive URL **removed**; greenhouse brand hero (logo slot + orange headline underline + trust chips); journey progress (1 Xác thực → 2 Đăng ký → 3 Hoàn tất); trust elements; friendly rounded form sections; inline field validation + loading + success states. CCCD exact-12 validation, returning-applicant targeting, QR scan and submit flow byte-for-byte unchanged |
| Planning | `src/app/(internal)/admin/planning/page.tsx` | Demand summary panel (shortage hero, fill-rate progress, Nam/Nữ demand-vs-allocated bars + legend, allocation snapshot); tone-aware status tabs (ACTIVE/DRAFT/EXPIRED/ALL); period timeline bars + gender split bars inside rows; fill-rate progress; planning-context loading skeleton + empty state; create/activate/revise/allocate logic untouched |

---

## 5. Palette & measured usage ratio

| Token | Value | Role | Measured share (1440px desktop, sampled) |
| --- | --- | --- | --- |
| `bg` cream | `#F6F2E9` | page surface | ~68–90% (dominant) |
| `surface` ivory | `#FFFCF6` | cards | included in cream bucket |
| `primary` deep green | `#0F4424` | nav/brand anchor | sidebar + hero bands (classified "other" in dark shades, ~18% of desktop width) |
| `accent` Hasfarm orange | `#E26D1C` | CTA / selected / shortage | ~0.6–2.6% |
| `gold` warm yellow | `#D9A327` | rare highlights | < 0.2% |
| `botanical` light green | `#E4ECDB` | secondary surfaces | ~0.2% |
| semantic blue/red/purple | `info/danger/purple` | status only | minimal, status badges |

Rule enforced: blue/purple/red appear only in semantic status contexts (badges,
info notes); the Nam/Nữ gender encoding uses **deep green / orange** instead of the
previous blue/pink so it stays inside the brand language.

---

## 6. Typography hierarchy

- Base: `font-sans` → `"Be Vietnam Pro", Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Noto Sans…` with `font-feature-settings` on.
- Level 0 eyebrow: `SectionLabel` — 10.5px bold uppercase, orange/green rule.
- Level 1 page title: 24–27px bold, `-0.015em` tracking, `text-balance`.
- Level 2 section titles: 15–17px semibold/bold.
- Level 3 body/labels: 13–14px; data numbers: 28–44px bold `tabular-nums`.
- Vietnamese diacritics verified rendering (glyph width measurement > latin baseline in
  the sandbox Chromium, `Đà Lạt mùa hoa 2026` measured wider than latin equivalent —
  no tofu).

---

## 7. Responsive decisions

- **1440px**: full sidebar (264px), max-width content 1400px, multi-column grids,
  metric strips in one row.
- **390px**: sidebar collapses to a drawer with focus trap; metric strips stack
  (`divide-y`); page-header action badges/buttons wrap (fixed a `shrink-0` overflow);
  dense operational tables scroll horizontally **inside** their card with the
  priority columns kept visible (checkbox, CCCD, name, status, actions) and
  secondary columns hidden via `hidden md/lg:table-cell`; verified
  `overflowX = 0` at 390px on all 4 pilots.

---

## 8. Accessibility notes

- **Keyboard focus**: visible `focus-visible` rings (orange) on buttons, links,
  inputs, table headers and cards; mobile drawer traps Tab and closes on Escape.
- **prefers-reduced-motion**: every animation is wrapped in a kill-switch media
  query; verified `animationDuration = 1e-06s` with reduced-motion emulation.
- **Semantics**: sticky headers remain real `<thead>`, bulk bar announces selection
  count, `aria-pressed` on status tabs, `aria-current="page"` on active nav,
  `role="alert"` on inline field errors, `aria-live` toaster.
- Contrast: cream surfaces with deep-green `#1C2418` text keep WCAG AA body contrast;
  orange on white used for large/bold accents only.

---

## 9. Visual QA scores (self-assessment, 1–10)

| Criterion | Dashboard | Daily App | Public Reg. | Planning | Rationale |
| --- | :-: | :-: | :-: | :-: | --- |
| Brand recognition | 8 | 8 | 8 | 8 | Green/orange/greenhouse identity consistent; official logo & hero photos missing (blocker) caps at 8 |
| Visual hierarchy | 9 | 9 | 9 | 9 | Command strip → focus → snapshot → actions; typographic scale consistent |
| Color balance | 9 | 9 | 9 | 9 | Cream dominant (68–90%), green anchors, orange accents, gold <0.2% |
| Information density | 8 | 9 | 8 | 9 | Metric strips + compact tables keep density without KPI-card noise; 390px table scrolls internally |
| Premium feeling | 8 | 8 | 8 | 8 | Gradients, field-rows texture, soft shadows; no official photography yet |
| Recruitment friendliness | 9 | — | 9 | — | Big friendly type, journey steps, trust chips, inline validation, clear orange CTA |
| Operational usability | 9 | 9 | — | 9 | Sticky headers, contextual bulk bar, hover/selection, keyboard + reduced motion |

All criteria ≥ 8 → per the rollout rule, the redesign stays on the **4 pilot screens
only**; no other pages were given the V2 composition (they only inherit the shared
tokens/components).

---

## 10. Blockers / asset provenance

- **BLOCKER (branding):** the required official assets were **not present in the
  repository and not attached to this session**. `public/brand/` contains only a
  `README.md` documenting that the logo slot is intentionally empty
  (`public/brand/dalat-hasfarm-logo.png`), and `git log --all` shows the brand folder
  never contained a logo. The Chrysanthemum hero and greenhouse-operations photos
  required at `public/brand/dalat-hasfarm-chrysanthemum-hero.png` /
  `public/brand/dalat-hasfarm-greenhouse-operations.jpg` **do not exist**.
- Per the task rules we did **not** fabricate an AI logo or substitute text/"DH"
  marks, and we **did not** keep the previous external Google Drive photo URL.
- What the code does instead:
  - `BrandLogo` keeps probing the exact official path `/brand/dalat-hasfarm-logo.png`
    and renders the documented empty-slot fallback (ImageOff) when absent — no
    "DH" text anywhere (verified `hasDH=false` on all pilot pages).
  - The public hero references the official approved hero
    `public/brand/dalat-hasfarm-chrysanthemum-hero.png` as a decorative cover layer
    (`background-size: cover` + `background-position`, aspect ratio preserved) layered
    over the designed botanical/greenhouse composition (gradients + field-rows
    texture + orange accent). While the file is absent, the missing background
    renders nothing — the composition still carries the hero, so there is **never a
    broken image**; dropping the official files into `public/brand/` later requires
    **no code change**.
- **Claim:** "branding hoàn tất" is **not** declared — brand recognition is scored
  8/10 pending the official assets.

---

## 11. Quality gates & test results

| Gate | Result |
| --- | --- |
| `npm test` | ✅ 22/22 passed |
| `npm run typecheck` | ✅ 0 errors |
| `npm run build` | ✅ success |
| `npm run lint` | ✅ 0 errors (25 pre-existing `react-hooks` warnings, unchanged baseline) |
| `node scripts/verify-redesign.mjs` | ✅ 5/5 tests passed |
| `git diff --check` | ✅ clean |

Runtime QA on the shipped build (Playwright/Chromium headless, real app + real DB):

- No broken images on any pilot screen.
- No external image URLs on Public Registration.
- No "DH" fake-logo text anywhere.
- `overflowX = 0` at both 1440px and 390px on all pilots.
- Sticky table headers active on Dashboard/Daily App/Planning.
- Orange CTA present on every pilot screen.
- Vietnamese diacritics render correctly.
- Keyboard focus ring + `prefers-reduced-motion` verified.
- Business logic, RBAC, Data Scope, API, calculation, Form Builder and workflow
  **unchanged** (diff review: presentation-only changes; logic functions and payloads
  byte-for-byte identical).

---

## 12. Files changed

```
docs/design-v2/before/*.png                 (8 new — baseline screenshots)
docs/design-v2/after/*.png                  (8 new — redesigned screenshots)
docs/design-v2/VISUAL-QA.md                 (this file)
src/app/(internal)/admin/dashboard/page.tsx (composition V2)
src/app/(internal)/admin/planning/page.tsx  (composition V2)
src/app/(internal)/hr/registrations/page.tsx(header + metric strip)
src/app/globals.css                         (V2 tokens + utilities)
src/app/layout.tsx                          (cream body background)
src/app/page.tsx                            (public hero V2, external URL removed)
src/components/applicant-portal.tsx         (portal V2, logic unchanged)
src/components/dashboard-widgets.tsx        (widgets V2 presentation)
src/components/registrations-grid.tsx       (workspace V2 presentation)
src/components/sidebar.tsx                  (Sidebar V2, RBAC unchanged)
src/components/ui.tsx                       (primitives V2 + new shared components)
src/lib/dashboard.ts                        (read-only dashboard overview aggregation)
```
