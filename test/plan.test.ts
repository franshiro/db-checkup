import test from 'node:test';
import assert from 'node:assert/strict';
import { pgScans, mysqlScans } from '../src/plan.js';

test('pg nested seq scan', () =>
  assert.deepEqual(pgScans([{ Plan: { 'Node Type': 'Nested Loop', Plans: [
    { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'public', Alias: 'o' },
    { 'Node Type': 'Index Scan', 'Relation Name': 'customers', Schema: 'public' }] } }]), [{ table: 'public.orders' }]));
test('mysql nested loop ALL', () =>
  assert.deepEqual(mysqlScans({ query_block: { nested_loop: [
    { table: { table_name: 'o', access_type: 'ALL' } }, { table: { table_name: 'c', access_type: 'eq_ref' } }] } }), [{ table: 'o' }]));
test('mysql under ordering_operation, derived ignored', () =>
  assert.deepEqual(mysqlScans({ query_block: { ordering_operation: { nested_loop: [
    { table: { table_name: 'orders', access_type: 'ALL' } }, { table: { table_name: '<derived2>', access_type: 'ALL' } }] } } }), [{ table: 'orders' }]));
