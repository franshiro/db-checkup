import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasGlobalProcess } from '../src/adapters/mysql.js';

test('hasGlobalProcess only counts global grants', () => {
  assert.equal(hasGlobalProcess(['GRANT PROCESS ON *.* TO `a`@`%`']), true);
  assert.equal(hasGlobalProcess(['GRANT ALL PRIVILEGES ON *.* TO `a`@`%` WITH GRANT OPTION']), true);
  assert.equal(hasGlobalProcess(['GRANT ALL PRIVILEGES ON `shop`.* TO `a`@`%`']), false);
  assert.equal(hasGlobalProcess(['GRANT SELECT, PROCESS ON *.* TO `a`@`%`']), true);
  assert.equal(hasGlobalProcess(['GRANT SELECT ON *.* TO `a`@`%`']), false);
});
