# Embedded font — license audit

## DejaVu Sans 2.37 (`DejaVuSans.ttf`)

- **Source:** DejaVu Fonts project (https://dejavu-fonts.github.io/), release
  `version_2_37`, republished on npm as `dejavu-fonts-ttf@2.37.3`.
- **License:** Bitstream Vera (see `LICENSE-DejaVu.txt`, included verbatim).
  Redistribution of the font files is permitted provided the copyright and
  license notice are included. DejaVu modifications are public domain.
- **Vietnamese coverage:** verified with `@pdf-lib/fontkit` — all precomposed
  Vietnamese characters (ă â đ ê ô ơ ư + tone marks), uppercase variants, and the
  combining diacritics U+0300–U+0309 / U+0303 / U+0323 are present (0 missing).
- **Usage:** embedded via `pdf-lib` + `@pdf-lib/fontkit`, subset per document.
  The PDF overlay engine never relies on Standard-14 fonts (no Vietnamese glyphs).

This font was chosen because its license is unambiguous and it ships as a single
static TTF with full Vietnamese coverage. Any future replacement must pass the
same audit (clear redistribution license + `VIETNAMESE_COVERAGE_CORPUS` coverage
via `listMissingGlyphs`).
