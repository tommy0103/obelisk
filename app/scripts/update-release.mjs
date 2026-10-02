// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, createPrivateKey, verify } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const keyPath = fileURLToPath(new URL('../build/sparkle-public-key.txt', import.meta.url));
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
export function publicKey(encoded) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || Buffer.from(encoded, 'base64').length !== 32) throw new Error('Invalid Sparkle public key');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(encoded, 'base64')]), format: 'der', type: 'spki' });
}
export function validateKeyPair(encodedPublic, encodedPrivate) {
  publicKey(encodedPublic);
  const secret = String(encodedPrivate).trim();
  const bytes = Buffer.from(secret, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret) || ![32, 96].includes(bytes.length) || bytes.toString('base64') !== secret) {
    throw new Error('Invalid Sparkle private key format (expected an exported seed or legacy key)');
  }
  const derived = bytes.length === 32
    ? createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32)
    : bytes.subarray(64);
  if (!derived.equals(Buffer.from(encodedPublic, 'base64'))) throw new Error('Sparkle public and private keys do not match');
}
export function verifyArchive(bytes, signature, key) {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, bytes, publicKey(key), Buffer.from(signature, 'base64'))) {
    throw new Error('Sparkle archive signature does not match the trusted public key');
  }
}
export async function signArchive({ directory, version, arch, tool, privateKeyFile, minimumSystemVersion }) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Invalid update architecture');
  const file = `Obelisk-${version}-mac-${arch}.zip`;
  const bytes = await readFile(path.join(directory, file));
  const secret = (await readFile(privateKeyFile, 'utf8')).trim();
  // Validate before invoking Sparkle: malformed-key diagnostics may echo input.
  const key = (await readFile(keyPath, 'utf8')).trim();
  validateKeyPair(key, secret);
  const { stdout } = await exec(tool, ['--ed-key-file', privateKeyFile, path.join(directory, file)]);
  const signature = stdout.match(/sparkle:edSignature="([A-Za-z0-9+/=]+)"/)?.[1];
  if (!signature) throw new Error('Sparkle did not return an archive signature');
  verifyArchive(bytes, signature, key);
  const metadata = { file, version, arch, signature, size: bytes.length,
    sha512: createHash('sha512').update(bytes).digest('base64'), minimumSystemVersion };
  await writeFile(path.join(directory, `sparkle-${arch}.json`), JSON.stringify(metadata, null, 2)+'\n');
}
export async function assembleRelease({ directory, version, tag, notes, repository = 'tommy0103/obelisk', trustedPublicKey }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version) || tag !== `v${version}`) throw new Error('Invalid desktop release version');
  if (repository !== 'tommy0103/obelisk') throw new Error('Desktop update feeds must use the configured repository');
  const names = await readdir(directory);
  const key = trustedPublicKey ?? (await readFile(keyPath, 'utf8')).trim();
  const date = new Date();
  const files = [];
  for (const arch of ['arm64', 'x64']) {
    const info = JSON.parse(await readFile(path.join(directory, `sparkle-${arch}.json`), 'utf8'));
    const expected = `Obelisk-${version}-mac-${arch}.zip`;
    if (info.file !== expected || info.version !== version || info.arch !== arch || !/^\d+(?:\.\d+){0,2}$/.test(info.minimumSystemVersion)) throw new Error('Mismatched Sparkle artifact metadata');
    if (!names.includes(`Obelisk-${version}-mac-${arch}.dmg`)) throw new Error(`Missing ${arch} DMG`);
    const bytes = await readFile(path.join(directory, expected));
    verifyArchive(bytes, info.signature, key);
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    if (sha512 !== info.sha512 || bytes.length !== info.size) throw new Error('Update artifact changed after signing');
    files.push({ url: expected, sha512, size: bytes.length });
    const url = `https://github.com/${repository}/releases/download/${tag}/${expected}`;
    const feed = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>Obelisk updates (${arch})</title><item><title>Obelisk ${xml(version)}</title>
<pubDate>${date.toUTCString()}</pubDate><description>${xml(notes)}</description>
<sparkle:minimumSystemVersion>${xml(info.minimumSystemVersion)}</sparkle:minimumSystemVersion>
<enclosure url="${xml(url)}" sparkle:version="${xml(version)}" sparkle:shortVersionString="${xml(version)}" sparkle:edSignature="${info.signature}" length="${bytes.length}" type="application/octet-stream" />
</item></channel></rss>\n`;
    await writeFile(path.join(directory, `appcast-${arch}.xml`), feed);
  }
  // JSON is valid YAML. Generate ONE file after collecting both architectures;
  // merging two builder-generated latest-mac.yml files would silently lose one.
  const legacy = files.find(file => file.url.endsWith('-x64.zip'));
  await writeFile(path.join(directory, 'latest-mac.yml'), JSON.stringify({ version, files,
    path: legacy.url, sha512: legacy.sha512, releaseDate: date.toISOString(), releaseNotes: notes }, null, 2)+'\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'sign') await signArchive({ directory, version: process.env.APP_VERSION, arch: process.env.MAC_ARCH,
    tool: process.env.SPARKLE_SIGN_TOOL, privateKeyFile: process.env.SPARKLE_KEY_FILE, minimumSystemVersion: process.env.MIN_MAC_OS });
  else if (mode === 'assemble') await assembleRelease({ directory, version: process.env.APP_VERSION,
    tag: process.env.RELEASE_TAG, notes: await readFile(process.env.RELEASE_NOTES_FILE, 'utf8') });
  else throw new Error('Expected sign or assemble');
}
