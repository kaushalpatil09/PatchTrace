import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const javascript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('every UI element selector exists in static HTML or a generated template', () => {
  const selectors = [...javascript.matchAll(/\$\(\s*'#([^']+)'\s*\)/g)].map((match) => match[1]);
  const staticIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const dynamicIds = new Set([...javascript.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  assert.ok(selectors.length > 0);
  for (const selector of selectors) {
    assert.ok(staticIds.has(selector) || dynamicIds.has(selector), `missing element #${selector}`);
  }
});

test('the UI has no inline scripts or inline event handlers under the CSP', () => {
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
});

test('the UI uses the local API and exposes bundle import and report download', () => {
  for (const route of ['/api/health', '/api/sample', '/api/analyze', '/api/report', '/api/verify']) {
    assert.ok(javascript.includes(route), `missing API route ${route}`);
  }
  assert.match(html, /id="bundle-file"/);
  assert.match(html, /id="download-analysis"/);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('the UI renders evidence source references and bounded why-not details safely', () => {
  assert.match(javascript, /item\.source/);
  assert.match(javascript, /source ref:/);
  assert.match(javascript, /suspect\.whyNot/);
  assert.match(javascript, /WHY NOT THE TOP SUSPECT/);
  assert.match(javascript, /escapeHtml\(item\.source/);
  assert.match(javascript, /escapeHtml\(reason\)/);
});

test('the UI exposes landmarks, labels, live regions, and keyboard-safe controls', () => {
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /<header[^>]*aria-label="PatchTrace"/);
  assert.match(html, /<main id="main-content"[^>]*tabindex="-1"/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="bundle-file"[^>]*aria-label="Choose a JSON incident bundle"/);
  assert.match(html, /aria-labelledby="incident-heading"/);
  assert.match(html, /aria-labelledby="suspects-heading"/);
  assert.match(html, /aria-label="Verification results"/);
  assert.match(javascript, /aria-pressed/);
  assert.match(javascript, /role="listitem"/);
  assert.match(javascript, /focus\(\{ preventScroll: true \}\)/);
  assert.match(javascript, /candidate\.dataset\.sha === state\.selectedSha/);
});

test('the UI keeps zoom, reduced-motion, contrast, and visible-focus semantics', () => {
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /scroll-behavior: smooth/);
});
