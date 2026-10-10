// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const root=fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const require=createRequire(root+'/app/package.json');
const asar=require('@electron/asar');
const mode=process.argv[2] || 'sparkle';
const arch=process.argv[3] || 'arm64';
if (!['sparkle', 'fallback'].includes(mode) || !['arm64', 'x64'].includes(arch)) throw new Error('Expected sparkle|fallback and arm64|x64');
const work=await mkdtemp(path.join(os.tmpdir(), `obelisk-update-${mode}-${arch}-`));
const bundleId=`com.obelisk.acceptance.${mode}.${arch}.${path.basename(work).split('-').at(-1).toLowerCase()}`;
const tool=process.argv[5];
if (!tool) throw new Error('Pass a packaged app path and the official sign_update path');
const original=path.resolve(process.argv[4]);
const migrationSource=process.argv[6] && path.resolve(process.argv[6]);
if (migrationSource && (mode !== 'fallback' || arch !== 'x64' || process.arch !== 'arm64')) throw new Error('Migration acceptance requires fallback/x64 on Apple Silicon');
const targetArch=migrationSource ? 'arm64' : arch;
const oldApp=work+'/installed/Obelisk.app';
const newApp=work+'/update/Obelisk.app';
const home=work+'/home';
const launches=work+'/launches.jsonl';
const binary=oldApp+'/Contents/MacOS/Obelisk';
let badSignature=mode==='sparkle';
let fallbackVersion='0.2.2';
const { privateKey, publicKey }=generateKeyPairSync('ed25519');
const publicBytes=publicKey.export({ format:'der', type:'spki' }).subarray(-32);
const exported=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64');
// Fixtures only: disposable test key, never the repository's release secret.
// Each invocation owns a fresh directory and bundle identifier.
await mkdir(work,{recursive:true}); await mkdir(home,{recursive:true});
await writeFile(work+'/test-key',exported,{mode:0o600});
const feed=new Map();
const requests=[];
const server=createServer((req,res)=> {
  const name=req.url.split('?')[0]; requests.push(name);
  const entry=feed.get(name);
  if(!entry) { res.writeHead(404);res.end();return; }
  const bytes=typeof entry==='function'?Buffer.from(entry()):entry;
  res.writeHead(200,{'Content-Type':name.endsWith('.xml')?'application/xml':'application/octet-stream','Content-Length':bytes.length});
  res.end(bytes);
});
await new Promise((resolve,reject)=>{server.on('error',reject);server.listen(0,'127.0.0.1',resolve);});
const feedBase=`http://127.0.0.1:${server.address().port}`;
const portServer=createServer(); await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
const debugPort=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
function run(command,args,options={}) {return execFileSync(command,args,{encoding:'utf8',timeout:120_000,...options});}
async function fixture(target,version,source=original) {
  await mkdir(path.dirname(target),{recursive:true}); run('ditto',[source,target]);
  const info=target+'/Contents/Info.plist';
  for(const [key,value] of Object.entries({CFBundleIdentifier:bundleId,CFBundleVersion:version,CFBundleShortVersionString:version,SUFeedURL:feedBase+`/appcast-${arch}.xml`,SUPublicEDKey:publicBytes.toString('base64')})) run('plutil',['-replace',key,'-string',value,info]);
  const appAsar=target+'/Contents/Resources/app.asar';
  const extracted=work+'/extract-'+version;
  asar.uncache(appAsar);
  asar.extractAll(appAsar,extracted);
  const pkgPath=extracted+'/package.json';const pkg=JSON.parse(await readFile(pkgPath,'utf8'));pkg.version=version;await writeFile(pkgPath,JSON.stringify(pkg));
  await rename(extracted+'/out/main/index.js',extracted+'/out/main/app-main.js');
  // Keep the shipped main/preload/renderer and lifecycle intact. A fixture
  // bootstrap redirects all HOME and userData paths, including on relaunch.
  await writeFile(extracted+'/out/main/index.js',`import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {app} from 'electron';
import fs from 'node:fs/promises';
os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();
app.setPath('userData',${JSON.stringify(work+'/user-data')});
try { await import('./app-main.js'); } catch (error) {
  await fs.writeFile(${JSON.stringify(work+'/startup-error.txt')},error.stack || String(error));
  app.exit(1);
}
app.whenReady().then(async()=> {
await fs.appendFile(${JSON.stringify(launches)},JSON.stringify({version:app.getVersion(),arch:process.arch,pid:process.pid,node:process.versions.node})+'\\n');
});
`);
  run(process.execPath,['--check',extracted+'/out/main/index.js']);
  await asar.createPackageWithOptions(extracted,appAsar,{unpack:'**/*.node'});
  const integrity = {'Resources/app.asar':{algorithm:'SHA256',hash:createHash('sha256').update(asar.getRawHeader(appAsar).headerString).digest('hex')}};
  run('plutil',['-replace','ElectronAsarIntegrity','-json',JSON.stringify(integrity),info]);
  await rm(extracted,{recursive:true,force:true});
  if(mode==='fallback') {
    await rm(target+'/Contents/Resources/app.asar.unpacked/node_modules/electron-sparkle-updater/native/build/Release/sparkle_bridge.node');
    await writeFile(target+'/Contents/Resources/app-update.yml',JSON.stringify({provider:'generic',url:feedBase+'/',updaterCacheDirName:'obelisk-acceptance'}));
  }
  // Ad-hoc fixtures need a stable designated requirement: the default cdhash
  // requirement pins the old bytes and Squirrel correctly rejects new bytes.
  // Production releases retain electron-builder's Developer ID requirement.
  const identifier=bundleId;
  run('codesign',['--force','--deep','--sign','-',target],{stdio:'pipe'});
  run('codesign',['--force','--sign','-','--requirements',`=designated => identifier "${identifier}"`,target],{stdio:'pipe'});
  run('codesign',['--verify','--deep','--strict',target],{stdio:'pipe'});
}
let child, socket;
let id=0;const pending=new Map();
async function cdp(expression) {
  const requestId=++id;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('CDP evaluate timeout'));},5000);
    pending.set(requestId,{resolve:result=>{clearTimeout(timer);resolve(result)},reject:error=>{clearTimeout(timer);reject(error)}});
    socket.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
}
async function until(workFn,description,ms=60_000) {
  const start=Date.now();let last;
  while(Date.now()-start<ms) {
    try {last=await workFn();if(last)return last;} catch {}
    await delay(100);
  }
  throw new Error(`Timed out: ${description}; last=${JSON.stringify(last)}; requests=${JSON.stringify(requests)}`);
}
try {
  await fixture(oldApp,'0.2.3');await fixture(newApp,'0.2.4');
  let intelEntry;
  if (migrationSource) {
    const intelZip=work+'/Obelisk-0.2.4-mac-x64.zip';
    run('ditto',['-c','-k','--keepParent',newApp,intelZip]);
    const intelBytes=await readFile(intelZip);
    intelEntry={url:'Obelisk-0.2.4-mac-x64.zip',sha512:createHash('sha512').update(intelBytes).digest('base64'),size:intelBytes.length};
    feed.set('/'+intelEntry.url,intelBytes);
    await rm(newApp,{recursive:true,force:true});
    await fixture(newApp,'0.2.4',migrationSource);
  }
  const zip=work+`/Obelisk-0.2.4-mac-${targetArch}.zip`;
  run('ditto',['-c','-k','--keepParent',newApp,zip]);
  const bytes=await readFile(zip);const signature=sign(null,bytes,privateKey).toString('base64');
  // Verify independent implementations agree on Sparkle's Ed25519 format.
  run(tool,['--verify','--ed-key-file',work+'/test-key',zip,signature]);
  feed.set(`/Obelisk-0.2.4-mac-${targetArch}.zip`,bytes);
  feed.set(`/appcast-${arch}.xml`,()=>`<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Local fixture</title><item><title>Obelisk 0.2.4</title><description>Local acceptance update</description><enclosure url="${feedBase}/Obelisk-0.2.4-mac-${targetArch}.zip" sparkle:version="0.2.4" sparkle:shortVersionString="0.2.4" sparkle:edSignature="${badSignature?Buffer.alloc(64).toString('base64'):signature}" length="${bytes.length}" type="application/octet-stream" /></item></channel></rss>`);
  feed.set('/latest-mac.yml',()=>JSON.stringify({version:fallbackVersion,files:[...(intelEntry?[intelEntry]:[]),{url:`Obelisk-0.2.4-mac-${targetArch}.zip`,sha512:createHash('sha512').update(bytes).digest('base64'),size:bytes.length}],path:intelEntry?.url || `Obelisk-0.2.4-mac-${targetArch}.zip`,sha512:intelEntry?.sha512 || createHash('sha512').update(bytes).digest('base64'),releaseDate:new Date().toISOString(),releaseNotes:'Local acceptance update'}));
  await mkdir(home+'/.obelisk/recap',{recursive:true});await writeFile(home+'/.obelisk/recap/preserved.txt','keep this recap');
  run(binary,['-e',`const fs=require('node:fs'),p=require('node:path');
const asar=p.join(process.env.FIXTURE_APP,'Contents/Resources/app.asar');
const DB=require(p.join(asar,'node_modules/better-sqlite3'));
fs.mkdirSync(p.join(process.env.HOME,'.obelisk'),{recursive:true});
const db=new DB(p.join(process.env.HOME,'.obelisk/obelisk.sqlite'));
db.exec(fs.readFileSync(p.join(asar,'out/main/schema.sql'),'utf8'));
db.prepare('INSERT INTO memories(id,path,summary,created_at) VALUES (?,?,?,?)').run('update-preserved-memory','fixture.md','Preserve this memory','2026-10-01T00:00:00Z');db.close();`],
    {env:{...process.env,HOME:home,ELECTRON_RUN_AS_NODE:'1',FIXTURE_APP:oldApp}});
  child=spawn(binary,[`--remote-debugging-port=${debugPort}`,'--no-sandbox'],{env:{...process.env,HOME:home},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',chunk=>{log+=chunk;writeFile(work+'/process.log',log).catch(()=>{})});child.stderr.on('data',chunk=>{log+=chunk;writeFile(work+'/process.log',log).catch(()=>{})});
  child.on('exit',()=>writeFile(work+'/process.log',log).catch(()=>{}));
  const page=await until(async()=>{const tabs=await fetch(`http://127.0.0.1:${debugPort}/json`).then(r=>r.json());return tabs.find(item=>item.type==='page'&&item.webSocketDebuggerUrl);},'packaged renderer started',180_000);
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{
    const value=JSON.parse(event.data);const task=pending.get(value.id);if(!task)return;pending.delete(value.id);
    if(value.error||value.result?.exceptionDetails)task.reject(new Error(JSON.stringify(value.error||value.result.exceptionDetails)));else task.resolve(value.result.result.value);
  });
  const state=()=>cdp('window.obelisk.getUpdateState()');
  if(mode==='sparkle') {
    const failed=await until(async()=>{const s=await state();return s.phase==='error'?s:false;},'signature rejection');
    assert.equal(failed.backend,'sparkle');assert.match(failed.error,/sign|verif|valid/i);
    console.log(`PASS ${arch}: a bad Sparkle signature is rejected without falling back`);
    badSignature=false;await cdp('window.obelisk.checkForUpdates()');
  } else {
    const current=await until(async()=>{const s=await state();return s.phase==='current'?s:false;},'older fallback version ignored');
    assert.equal(current.backend,'electron-updater');
    assert.ok(!requests.some(request=>request.endsWith('.zip')), 'older versions must not be downloaded');
    console.log(`PASS ${arch}: electron-updater ignores an older release without downloading`);
    fallbackVersion='0.2.4';await cdp('window.obelisk.checkForUpdates()');
  }
  const ready=await until(async()=>{const s=await state();return s.phase==='ready'?s:false;},`${mode} archive staged`,120_000);
  assert.equal(ready.backend,mode==='sparkle'?'sparkle':'electron-updater');assert.equal(ready.version,'0.2.4');
  const memories=await cdp('window.obelisk.getMemories()');
  assert.ok(memories.some(memory=>memory.id==='update-preserved-memory'));
  console.log(`PASS ${arch}: real ${ready.backend} staged a signed 0.2.4 ZIP`);
  await until(()=>cdp("!!document.querySelector('.update-notice .primary:not(:disabled)')"),'ready action rendered',30_000);
  await cdp("document.querySelector('.update-notice .primary').click(); true");
  const launched=await until(async()=>{const records=(await readFile(launches,'utf8')).trim().split('\n').map(line=>JSON.parse(line));return records.find(record=>record.version==='0.2.4');},'replacement app relaunched',120_000);
  assert.equal(launched.arch,targetArch);
  if (migrationSource) {
    assert.ok(requests.includes('/Obelisk-0.2.4-mac-arm64.zip'));
    assert.ok(!requests.includes('/Obelisk-0.2.4-mac-x64.zip'), 'Apple Silicon prefers ARM64 even when x64 is first in the manifest');
  }assert.ok(launched.node.startsWith('24.'));
  assert.equal(await readFile(home+'/.obelisk/recap/preserved.txt','utf8'),'keep this recap');
  const stored=run(binary,['-e',`const p=require('node:path');const asar=p.join(process.env.FIXTURE_APP,'Contents/Resources/app.asar');const DB=require(p.join(asar,'node_modules/better-sqlite3'));const db=new DB(p.join(process.env.HOME,'.obelisk/obelisk.sqlite'),{readonly:true});const row=db.prepare('SELECT summary FROM memories WHERE id=?').get('update-preserved-memory');db.close();console.log(JSON.stringify(row));`],{env:{...process.env,HOME:home,ELECTRON_RUN_AS_NODE:'1',FIXTURE_APP:oldApp}});
  assert.equal(JSON.parse(stored).summary,'Preserve this memory');
  asar.uncache(oldApp+'/Contents/Resources/app.asar');
  assert.equal(JSON.parse(asar.extractFile(oldApp+'/Contents/Resources/app.asar','package.json').toString()).version,'0.2.4');
  console.log(`PASS ${arch}: Update & restart replaced and relaunched 0.2.4, preserving user data`);
  await writeFile(work+'/result.json',JSON.stringify({mode,arch,ready,launched,requests},null,2));
  try {process.kill(launched.pid,'SIGTERM');}catch {}
  await delay(500);
} finally {
  socket?.close();if(child?.exitCode===null)child.kill('SIGTERM');
  await new Promise(resolve=>server.close(resolve));
  await rm(work+'/test-key',{force:true});
  // Clean up only applications launched from this unique fixture directory.
  const lines=run('ps',['-axo','pid=,args=']).split('\n');
  for(const line of lines)if(line.includes(work+'/')&&!line.includes('ps -axo')){const pid=Number(line.trim().split(/\s+/)[0]);if(pid!==process.pid)try{process.kill(pid,'SIGTERM')}catch {}}
}

console.log(`Packaged ${mode}/${arch}${migrationSource?' → arm64':''} acceptance passed`);
if (process.env.OBELISK_KEEP_UPDATE_FIXTURES !== '1') await rm(work,{recursive:true,force:true});
