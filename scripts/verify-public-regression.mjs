/**
 * Automated regression gates for the Public Registration production fix.
 *
 * These checks lock the behaviors that shipped in the Visual V2 pilots and
 * then broke in production:
 *   1. `.field-rows` must not wipe the `.hasfarm-hero` greenhouse gradient
 *   2. Hero uses the official chrysanthemum asset without a white-wash overlay
 *   3. Public copy stays candidate-friendly (no internal HR terms)
 *   4. Official support phone is 0263 3620295
 *   5. Form heading / contrast / focus treatment stay readable
 *   6. No fake "DH" logo mark
 *
 * Run: node scripts/verify-public-regression.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "data",
  "coverage",
  "dist",
  "build",
  "out",
]);
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".md",
  ".json",
  ".sql",
  ".html",
  ".txt",
  ".yml",
  ".yaml",
]);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (TEXT_EXT.has(extname(name)) && name !== "package-lock.json") acc.push(full);
  }
  return acc;
}

function block(source, selector) {
  const re = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const match = source.match(re);
  assert.ok(match, `Expected CSS rule ${selector}`);
  return match[1];
}

console.log("==================================================");
console.log("PUBLIC REGISTRATION REGRESSION GATES");
console.log("==================================================\n");

// --- 1. CSS specificity root cause -----------------------------------------
console.log("TEST 1: .hasfarm-hero.field-rows specificity fix...");
const css = read("src/app/globals.css");

assert.match(css, /\.hasfarm-hero\.field-rows\s*\{/, "Combined selector .hasfarm-hero.field-rows must exist");

const hero = block(css, "\\.hasfarm-hero");
assert.match(hero, /background-color\s*:\s*#0f4424/, ".hasfarm-hero must set a solid green fallback color");
assert.match(hero, /background-image\s*:/, ".hasfarm-hero must use background-image longhand, not only the shorthand");
assert.doesNotMatch(hero, /(?:^|\n)\s*background\s*:/, ".hasfarm-hero must not use the background shorthand (it resets background-color)");
assert.match(hero, /linear-gradient\(150deg,\s*#08290f/, ".hasfarm-hero must keep the greenhouse gradient");

const fieldRows = block(css, "\\.field-rows");
assert.match(fieldRows, /background-image\s*:/, ".field-rows must use background-image longhand");
assert.doesNotMatch(fieldRows, /(?:^|\n)\s*background\s*:/, ".field-rows must not use the background shorthand");
assert.match(fieldRows, /repeating-linear-gradient/, ".field-rows must keep the planting-row texture");

const combined = block(css, "\\.hasfarm-hero\\.field-rows");
assert.match(combined, /background-color\s*:\s*#0f4424/, "Combined rule must keep the solid green fallback");
assert.match(combined, /repeating-linear-gradient/, "Combined rule must include the field-rows texture");
assert.match(combined, /linear-gradient\(150deg,\s*#08290f/, "Combined rule must include the greenhouse gradient");
assert.match(combined, /radial-gradient/, "Combined rule must include the sunlight/botanical glows");
assert.ok(
  combined.indexOf("repeating-linear-gradient") < combined.indexOf("linear-gradient(150deg"),
  "Texture layers must be painted above the greenhouse gradient",
);
console.log("✓ TEST 1 PASSED: field-rows can no longer override the hero background.\n");

// --- 2. Hero photo treatment ------------------------------------------------
console.log("TEST 2: Public hero photo treatment...");
const page = read("src/app/page.tsx");
assert.match(page, /dalat-hasfarm-chrysanthemum-hero\.png/, "Hero must reference the official PNG path");
assert.match(page, /mix-blend-multiply/, "Hero photo must multiply over the greenhouse gradient (white canvas of the collage disappears)");
assert.doesNotMatch(page, /mix-blend-screen/, "Hero must not use mix-blend-screen (that was the white-wash overlay)");
assert.doesNotMatch(page, /opacity-\[0\.16\]/, "Hero must not hide the photograph at 16% opacity");
assert.match(page, /rgba\(8,\s*41,\s*15/, "Hero must use a localized dark-green scrim behind the text");
assert.match(page, /max-w-\[760px\]|md:w-\[60%\]/, "Scrim must stay localized to the text column, not cover the whole photo in solid white");
assert.match(page, /max-w-\[1400px\]/, "Public layout container must be capped around 1400px");
assert.match(page, /lg:grid-cols-\[1\.15fr_0\.85fr\]/, "Two-column layout must start at lg so 768px stays a single readable column");
assert.match(page, /min-h-screen/, "Page must fill the viewport");
assert.match(page, /overflow-x-hidden/, "Page must clip accidental horizontal overflow");
assert.doesNotMatch(page, /max-w-6xl/, "Public page must not keep the narrower max-w-6xl container that left an empty right strip");
assert.doesNotMatch(page, /drive\.google\.com|lh3\.googleusercontent/, "External Google Drive hero URL must stay removed");
console.log("✓ TEST 2 PASSED: hero photo is official, colored, and not white-washed.\n");

// --- 3. Candidate-facing process copy --------------------------------------
console.log("TEST 3: Candidate-friendly process copy...");
for (const step of [
  "Tiếp nhận thông tin đăng ký",
  "Đối chiếu hồ sơ",
  "Xếp bộ phận phù hợp",
  "Thông báo kết quả tiếp nhận",
]) {
  assert.match(page, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Public process must include: ${step}`);
}
assert.doesNotMatch(page, /Daily Application/, "Public page must not expose the internal term Daily Application");
assert.doesNotMatch(page, /DW Data/, "Public page must not expose the internal term DW Data");
assert.doesNotMatch(page, /Location\s*→\s*Division/, "Public page must not expose the internal org path");
assert.doesNotMatch(page, /Division\s*→\s*Department\s*→\s*Section\s*→\s*Group/, "Public page must not expose Location → Division → Department → Section → Group");
console.log("✓ TEST 3 PASSED: public process copy is candidate-friendly.\n");

// --- 4. Official phone number ----------------------------------------------
console.log("TEST 4: Official support phone 0263 3620295...");
assert.match(page, /0263 3620295/, "Displayed phone text must be 0263 3620295");
assert.match(page, /tel:\+842633620295/, "tel: link must be the normalized +84 form of 0263 3620295");

// Construct the retired number so this file itself is not a hit.
const retiredDisplay = ["0263", "3842777"].join(" ");
const retiredTel = `0263${"3842777"}`;
assert.equal(page.includes(retiredDisplay), false, "Old support number must be gone from the public page");
assert.equal(page.includes(retiredTel), false, "Old tel: number must be gone from the public page");

const phoneHits = [];
const oldPhoneHits = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  if (text.includes(retiredDisplay) || text.includes(retiredTel)) oldPhoneHits.push(rel);
  if (text.includes("0263 3620295") || text.includes("02633620295") || text.includes("+842633620295")) {
    phoneHits.push(rel);
  }
}
assert.deepEqual(oldPhoneHits, [], `Retired support number must have 0 occurrences (found in: ${oldPhoneHits.join(", ") || "—"})`);
assert.ok(phoneHits.includes("src/app/page.tsx"), "Public page must publish 0263 3620295");
assert.ok(phoneHits.includes("HUONG-DAN-TUNG-FILE.md"), "File guide must document 0263 3620295");
console.log(`✓ TEST 4 PASSED: retired landline = 0 hits; 0263 3620295 used in ${phoneHits.join(", ")}.\n`);

// --- 5. Form contrast + heading --------------------------------------------
console.log("TEST 5: Form heading, contrast, and focus...");
const portal = read("src/components/applicant-portal.tsx");
assert.match(portal, /title=\"Xác thực thông tin\"/, 'Check-stage heading must be exactly "Xác thực thông tin"');
assert.doesNotMatch(portal, /Xác thực thông tin ứng viên/, "Old longer heading must be gone");
assert.match(portal, /text-fg/, "Form must lock dark readable text");
assert.match(portal, /bg-surface/, "Form body must sit on a light surface");
assert.match(portal, /border-2 border-primary\/30/, "Inputs must have a clearly visible green-tinted border");
assert.match(portal, /focus:border-accent/, "Inputs must use Hasfarm orange on focus");
assert.match(portal, /rgba\(15,68,36,0\.12\)/, "Focus ring must also carry a green recognition glow");
assert.match(portal, /hasfarm-hero field-rows/, "Stage header must keep the brand band (now repaired by the CSS specificity fix)");
console.log("✓ TEST 5 PASSED: form heading and contrast treatment are locked.\n");

// --- 6. No fake logo --------------------------------------------------------
console.log("TEST 6: No fake logo / DH mark...");
const logo = read("src/components/brand-logo.tsx");
assert.match(logo, /\/brand\/dalat-hasfarm-logo\.png/, "BrandLogo must keep the official asset slot");
assert.match(logo, /ImageOff/, "BrandLogo must keep a graceful empty-slot fallback");
assert.doesNotMatch(logo, /[\"'`]DH[\"'`]/, "BrandLogo must not render a fake DH mark");
assert.doesNotMatch(page, /[\"'`]DH[\"'`]/, "Public page must not render a fake DH mark");
console.log("✓ TEST 6 PASSED: official logo slot + graceful fallback, no DH.\n");

// --- 7. Official asset slots still wired ------------------------------------
console.log("TEST 7: Official brand asset slots...");
assert.ok(existsSync(join(ROOT, "public/brand/README.md")), "public/brand/README.md must remain");
const heroExists = existsSync(join(ROOT, "public/brand/dalat-hasfarm-chrysanthemum-hero.png"));
const logoExists = existsSync(join(ROOT, "public/brand/dalat-hasfarm-logo.png"));
console.log(`   chrysanthemum hero present: ${heroExists ? "yes" : "NO — code still falls back to greenhouse gradient"}`);
console.log(`   official logo present:      ${logoExists ? "yes" : "NO — BrandLogo still shows ImageOff fallback"}`);
console.log("✓ TEST 7 PASSED: asset slots stay wired; missing files degrade gracefully.\n");

console.log("==================================================");
console.log("ALL PUBLIC REGISTRATION REGRESSION GATES PASSED");
console.log("==================================================");
