import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory.js';
import { PrincipalStore } from '../src/principals.js';

async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-review-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
test('environment identity stays stable across instances and key rotation', () => temporary(async dir => {
  const first = new PrincipalStore(dir); first.envPrincipals = 'agent:key-a'; first.load();
  const second = new PrincipalStore(dir); second.envPrincipals = 'agent:key-b'; second.load();
  assert.equal(first.principals[0].id, second.principals[0].id);
  assert.notEqual(first.principals[0].keyHash, second.principals[0].keyHash);
}));
test('a long-lived instance observes another instance revoking a principal', () => temporary(async dir => {
  const first = new PrincipalStore(dir).load();
  const member = first.create('member');
  const second = new PrincipalStore(dir).load();
  const req = { headers: { authorization: `Bearer ${member.apiKey}` } };
  assert.equal(second.authenticate(req).id, member.id);
  first.remove(member.id);
  assert.equal(second.authenticate(req), null);
}));
test('two independent stores cannot commit beyond the same owner quota', () => temporary(async dir => {
  const a = new MemoryStore(dir, { maxCountPerPrincipal: 1 });
  const b = new MemoryStore(dir, { maxCountPerPrincipal: 1 });
  await Promise.all([a.init(), b.init()]);
  const results = await Promise.allSettled([a.remember('one', {}, {principal:'p'}), b.remember('two', {}, {principal:'p'})]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const disk = JSON.parse(await fs.readFile(a.sidecarPath, 'utf8'));
  assert.equal(disk.memories.length, 1);
  assert.equal((await fs.stat(a.sidecarPath)).mode & 0o777, 0o600);
}));
test('releasing a replaced lock never unlinks its new owner', () => temporary(async dir => {
  const store = new MemoryStore(dir); await store.init();
  const handle = await store._acquireLock();
  await fs.rename(store.lockPath, `${store.lockPath}.old`);
  await fs.writeFile(store.lockPath, 'replacement');
  await store._releaseLock(handle);
  assert.equal(await fs.readFile(store.lockPath, 'utf8'), 'replacement');
}));
