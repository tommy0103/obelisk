// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { assembleRelease, assembleDebianRelease, verifyArchive, validateKeyPair } from '../app/scripts/update-release.mjs';

async function artifacts(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'obelisk-update-feed-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trustedPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const version = '0.2.4';
  for (const arch of ['arm64', 'x64']) {
    const file = `Obelisk-${version}-mac-${arch}.zip`, bytes = Buffer.from(`${arch} immutable archive fixture`);
    await writeFile(path.join(directory, file), bytes);
    await writeFile(path.join(directory, file.replace('.zip', '.dmg')), `${arch} dmg`);
    await writeFile(path.join(directory, `sparkle-${arch}.json`), JSON.stringify({ arch, version, file,
      size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64'),
      signature: sign(null, bytes, privateKey).toString('base64'), minimumSystemVersion: '12.0' }));
  }
  return { directory, version, tag: `v${version}`, trustedPublicKey, notes: '# Fixed & improved\n\n<unsafe>' };
}
test('a release exposes separate signed Sparkle feeds and one fallback manifest containing both architectures', async t => {
  const options = await artifacts(t); await assembleRelease(options);
  const fallback = JSON.parse(await readFile(path.join(options.directory, 'latest-mac.yml'), 'utf8'));
  assert.equal(fallback.version, '0.2.4'); assert.equal(fallback.files.length, 2);
  assert.deepEqual(fallback.files.map(file => file.url), ['Obelisk-0.2.4-mac-arm64.zip', 'Obelisk-0.2.4-mac-x64.zip']);
  for (const arch of ['arm64', 'x64']) {
    const feed = await readFile(path.join(options.directory, `appcast-${arch}.xml`), 'utf8');
    assert.equal((feed.match(/<enclosure /g) || []).length, 1);
    assert.match(feed, new RegExp(`/releases/download/v0.2.4/Obelisk-0.2.4-mac-${arch}\\.zip`));
    assert.ok(!feed.includes(arch === 'arm64' ? '-x64.zip' : '-arm64.zip'));
    assert.ok(feed.includes('&amp; improved') && feed.includes('&lt;unsafe&gt;'));
    const signature = feed.match(/sparkle:edSignature="([^"]+)"/)[1];
    verifyArchive(await readFile(path.join(options.directory, fallback.files.find(file => file.url.endsWith(`-${arch}.zip`)).url)), signature, options.trustedPublicKey);
  }
});
test('an archive changed after signing prevents release assembly', async t => {
  const options = await artifacts(t); await writeFile(path.join(options.directory, 'Obelisk-0.2.4-mac-arm64.zip'), 'tampered');
  await assert.rejects(assembleRelease(options), /signature does not match/);
});
test('release assembly rejects missing architectures and another trusted public key', async t => {
  const options = await artifacts(t);
  await rm(path.join(options.directory, 'Obelisk-0.2.4-mac-x64.dmg'));
  await assert.rejects(assembleRelease(options), /Missing x64 DMG/);
  const { publicKey } = generateKeyPairSync('ed25519');
  await assert.rejects(assembleRelease({ ...options, trustedPublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }), /signature does not match/);
});
test('update metadata cannot advertise an archive under the wrong version, architecture or repository', async t => {
  const options = await artifacts(t);
  await assert.rejects(assembleRelease({ ...options, repository: 'somewhere/else' }), /configured repository/);
  const file = path.join(options.directory, 'sparkle-arm64.json');
  const info = JSON.parse(await readFile(file, 'utf8')); await writeFile(file, JSON.stringify({ ...info, arch: 'x64' }));
  await assert.rejects(assembleRelease(options), /Mismatched Sparkle/);
});

test('Sparkle keys use the official 32-byte seed format and must match the baked public key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  assert.doesNotThrow(() => validateKeyPair(pub, secret));
  assert.throws(() => validateKeyPair(pub, Buffer.alloc(64).toString('base64')), /private key format/);
  assert.throws(() => validateKeyPair(pub, Buffer.alloc(32).toString('base64')), /do not match/);
});

test('Debian update metadata carries the verified amd64 installer and the same release notes', async t => {
  const options = await artifacts(t);
  const file = 'Obelisk-0.2.4-linux-amd64.deb';
  const bytes = Buffer.from('immutable Debian archive fixture');
  const metadata = { file, version: options.version, arch: 'x64', size: bytes.length,
    sha512: createHash('sha512').update(bytes).digest('base64') };
  await writeFile(path.join(options.directory, file), bytes);
  const manifestPath = path.join(options.directory, 'debian-amd64.json');
  await writeFile(manifestPath, JSON.stringify(metadata));
  await assembleDebianRelease(options);
  const feed = JSON.parse(await readFile(path.join(options.directory, 'latest-linux.yml'), 'utf8'));
  assert.equal(feed.version, options.version);
  assert.equal(feed.releaseNotes, options.notes);
  assert.deepEqual(feed.files, [{ url: file, size: bytes.length, sha512: metadata.sha512 }]);
  await writeFile(manifestPath, JSON.stringify({ ...metadata, arch: 'arm64' }));
  await assert.rejects(assembleDebianRelease(options), /Mismatched Debian/);
  await writeFile(manifestPath, JSON.stringify(metadata));
  await writeFile(path.join(options.directory, file), 'tampered Debian archive');
  await assert.rejects(assembleDebianRelease(options), /changed after verification/);
});
