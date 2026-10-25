import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { gstChecksum, gstValidationError, normalizeGSTIN } from './gstValidator.js';
test('GSTIN normalizes whitespace/case and validates checksum', () => {
  assert.equal(normalizeGSTIN(' 27aapfu0939f1zv '), '27AAPFU0939F1ZV');
  assert.equal(gstValidationError('27AAPFU0939F1ZV'), ''); assert.equal(gstChecksum('27AAPFU0939F1Z'), 'V');
});
test('GSTIN format, state code and checksum errors are distinct', () => {
  assert.match(gstValidationError('123'), /exactly 15/); assert.match(gstValidationError('00AAPFU0939F1ZV'), /structure/);
  assert.match(gstValidationError('27AAPFU0939F0ZV'), /structure/); assert.match(gstValidationError('27AAPFU0939F1ZA'), /checksum/);
  assert.match(gstValidationError('10ABCDE1234F1Z5'), /checksum/);
});
test('browser and server validators remain identical', () => assert.equal(readFileSync(new URL('../../../tiles-wala-frontend/src/utils/gstValidator.js', import.meta.url),'utf8'), readFileSync(new URL('./gstValidator.js', import.meta.url),'utf8')));
