import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const javascript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

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
