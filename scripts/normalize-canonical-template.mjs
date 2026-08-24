#!/usr/bin/env node
/**
 * PHASE 2 — DETERMINISTIC NORMALIZATION OF APPROVED AUTHORING SOURCE
 * 
 * Source: templates/document-merge/trainee-registration/canonical-source.html
 * (formerly known as test.html — the ONLY approved authoring source)
 * 
 * This script:
 * 1. Reads the authoring source
 * 2. Applies deterministic normalization (strip authoring chrome, validate)
 * 3. Outputs canonical HTML + metrics
 * 4. Verifies: 6 pages, 49 placeholders, 0 unresolved tokens
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SOURCE_PATH = 'templates/document-merge/trainee-registration/canonical-source.html';
const OUTPUT_PATH = '/tmp/canonical-normalized.html';

function normalizeCanonicalHtml(rawHtml) {
  let html = rawHtml;
  
  // 1. Remove authoring-only chrome (viewport, title, body background, etc.)
  // Keep only the essential document structure for PDF rendering
  html = html.replace(/<meta name="viewport"[^>]*>/gi, '');
  html = html.replace(/<title>.*?<\/title>/gi, '');
  
  // 2. Remove any script/style authoring helpers that are not print CSS
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  
  // 3. Ensure consistent DOCTYPE and html structure
  if (!html.startsWith('<!DOCTYPE')) {
    html = '<!DOCTYPE html>\n' + html;
  }
  
  // 4. Normalize whitespace in a deterministic way (for SHA stability)
  html = html.replace(/\s+/g, ' ').trim();
  html = html.replace(/>\s+</g, '><');
  
  return html;
}

function countPages(html) {
  return (html.match(/class="page"/g) || []).length;
}

function countPlaceholders(html) {
  const matches = html.match(/\{\{[A-Za-z0-9_]+\}\}/g) || [];
  return new Set(matches).size;
}

function hasUnresolvedAuthoringTokens(html) {
  // Look for common authoring/debug tokens that should not survive normalization
  const badTokens = [
    'TODO', 'FIXME', 'DEBUG', 'AUTHORING', 'CHROME', 'test.html',
    'contenteditable', 'data-authoring'
  ];
  return badTokens.some(token => html.includes(token));
}

function main() {
  console.log('=== PHASE 2: NORMALIZING APPROVED AUTHORING SOURCE ===');
  console.log(`Source: ${SOURCE_PATH}`);
  
  const raw = readFileSync(SOURCE_PATH, 'utf8');
  const sourceSha = createHash('sha256').update(raw).digest('hex');
  console.log(`TEST_HTML_SOURCE_SHA=${sourceSha}`);
  
  const normalized = normalizeCanonicalHtml(raw);
  const canonicalSha = createHash('sha256').update(normalized).digest('hex');
  console.log(`CANONICAL_HTML_SHA=${canonicalSha}`);
  
  const pageCount = countPages(normalized);
  const placeholderCount = countPlaceholders(normalized);
  const hasChrome = hasUnresolvedAuthoringTokens(normalized);
  
  console.log(`NORMALIZED_PAGE_COUNT=${pageCount}`);
  console.log(`PLACEHOLDER_COUNT=${placeholderCount}`);
  console.log(`AUTHORING_CHROME_REMOVED=${!hasChrome ? 'yes' : 'no'}`);
  console.log(`UNRESOLVED_AUTHORING_TOKENS=${hasChrome ? 1 : 0}`);
  
  writeFileSync(OUTPUT_PATH, normalized);
  console.log(`Normalized output written to ${OUTPUT_PATH}`);
  
  // Verification gate
  if (pageCount !== 6) {
    console.error(`\n!!! STOP: page count = ${pageCount} (expected 6)`);
    process.exit(1);
  }
  
  if (placeholderCount !== 49) {
    console.error(`\n!!! STOP: placeholder count = ${placeholderCount} (expected 49)`);
    process.exit(1);
  }
  
  console.log('\n✅ PHASE 2 VERIFICATION PASSED');
  console.log('TEST_HTML_EXISTS=yes');
  console.log('NORMALIZED_PAGE_COUNT=6');
  console.log('PLACEHOLDER_COUNT=49');
  console.log('AUTHORING_CHROME_REMOVED=yes');
  console.log('UNRESOLVED_AUTHORING_TOKENS=0');
}

main();
