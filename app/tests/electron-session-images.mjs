import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';

// A real PNG. The fixture writes it in full and then holds the response open,
// so Blink sizes and lays the image out from the buffered bytes while the load
// event waits for the response to complete. An SVG served in one shot lays out
// and fires load together, which hides that gap entirely.
function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function buildPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const scanlines = Buffer.alloc(height * (width + 1), 0x40);
  for (let row = 0; row < height; row++) scanlines[row * (width + 1)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'session-image-test';
const channels = [
  'db:getSessions',
  'db:getSessionMetadata',
  'db:getSessionCatalogue',
  'db:getSessionMessages',
  'db:getSessionToolCalls',
  'db:getSessionToolResults',
  'db:getSessionSubagents',
  'db:getSessionWorkflows',
  'db:getSessionSummaries',
  'db:getMemories',
  'db:getProjects',
  'db:getStats',
  'settings:get',
];

let failures = 0;
let messages = [];
const FILLER_COUNT = 40;

function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function waitFor(webContents, expression, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

// Renderer-side probes resolve from event handlers that a regression can keep
// from ever firing. Racing every one of them against a deadline keeps a broken
// build reporting a failure instead of hanging the run.
async function withDeadline(promise, message, timeoutMs = 10_000) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${message}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startImageServer() {
  const wideSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1176" height="768" viewBox="0 0 1176 768"><rect width="1176" height="768" fill="#7c3aed"/></svg>';
  const smallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#22c55e"/></svg>';
  // Held until the test releases them, so an above-viewport image can be made
  // to finish loading at a moment the test controls.
  const heldSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><rect width="900" height="1200" fill="#0ea5e9"/></svg>';
  const heldPaths = ['/held-rest.svg', '/held-scroll.svg'];
  const heldResponses = new Map(heldPaths.map(path => [path, []]));
  const releasedPaths = new Set();
  // The bytes go out in one write and the response stays open, so the row grows
  // from the decoded header while the load event waits for completion.
  const progressivePng = buildPng(900, 1200);
  let progressiveResponses = [];
  const sendSvg = (response, svg) => {
    response.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
    });
    response.end(svg);
  };
  const server = createServer((request, response) => {
    if (request.url === '/held-progressive.png') {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
      progressiveResponses.push(response);
      return;
    }
    if (heldResponses.has(request.url)) {
      if (releasedPaths.has(request.url)) sendSvg(response, heldSvg);
      else heldResponses.get(request.url).push(response);
      return;
    }
    const svg = request.url === '/wide.svg'
      ? wideSvg
      : request.url === '/small.svg'
        ? smallSvg
        : null;
    if (!svg) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/wide.svg') setTimeout(() => sendSvg(response, wideSvg), 300);
    else sendSvg(response, smallSvg);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        heldRequestCount: path => heldResponses.get(path)?.length ?? 0,
        releaseHeldImage(path) {
          releasedPaths.add(path);
          const pending = heldResponses.get(path) ?? [];
          heldResponses.set(path, []);
          for (const response of pending) sendSvg(response, heldSvg);
        },
        progressiveRequestCount: () => progressiveResponses.length,
        // Delivers the whole image now and completes the response completeMs
        // later, reproducing the gap a real image opens between the row growing
        // and the load event firing.
        releaseProgressiveImage(completeMs) {
          const pending = progressiveResponses;
          progressiveResponses = [];
          for (const response of pending) {
            response.write(progressivePng);
            setTimeout(() => response.end(), completeMs);
          }
        },
      });
    });
  });
}

function sessionSummary() {
  return {
    id: sessionId,
    title: 'Session image rendering',
    project: 'image-fixture',
    project_path: '/tmp/image-fixture',
    source: 'codex',
    started_at: '2026-07-30T00:00:00.000Z',
    ended_at: '2026-07-30T00:05:00.000Z',
    message_count: messages.length,
    git_branch: 'main',
  };
}

function registerHandlers() {
  ipcMain.handle('db:getSessionMetadata', (_event, id) => sessionSummary());
  ipcMain.handle('db:getSessionCatalogue', () => ({ sessions: [sessionSummary()], total: [sessionSummary()].length }));
  ipcMain.handle('db:getSessions', () => [sessionSummary()]);
  ipcMain.handle('db:getSessionMessages', () => messages);
  ipcMain.handle('db:getSessionToolCalls', () => []);
  ipcMain.handle('db:getSessionToolResults', () => []);
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => [{ project: 'image-fixture', count: 1 }]);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({}));
}

async function run() {
  const {
    server, baseUrl, heldRequestCount, releaseHeldImage,
    progressiveRequestCount, releaseProgressiveImage,
  } = await startImageServer();
  let win = null;
  try {
    messages = [
      {
        uuid: 'message-0',
        type: 'user',
        timestamp: '2026-07-30T00:00:00.000Z',
        text: 'Image rendering fixtures',
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-1',
        type: 'assistant',
        timestamp: '2026-07-30T00:01:00.000Z',
        text: `Wide image\n\n![Wide timeline fixture](${baseUrl}/wide.svg "Wide fixture")`,
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-2',
        type: 'assistant',
        timestamp: '2026-07-30T00:02:00.000Z',
        text: `Small image\n\n![Small timeline fixture](${baseUrl}/small.svg)`,
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-3',
        type: 'assistant',
        timestamp: '2026-07-30T00:03:00.000Z',
        text: 'Broken image\n\n![Missing timeline fixture](file:///obelisk-fixtures/missing-session-image.png)',
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-4',
        type: 'user',
        timestamp: '2026-07-30T00:04:00.000Z',
        text: 'Following message',
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-5',
        type: 'assistant',
        timestamp: '2026-07-30T00:05:00.000Z',
        text: `Held image (at rest)\n\n![Held rest fixture](${baseUrl}/held-rest.svg)`,
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-6',
        type: 'assistant',
        timestamp: '2026-07-30T00:06:00.000Z',
        text: `Held image (during scroll)\n\n![Held scroll fixture](${baseUrl}/held-scroll.svg)`,
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-7',
        type: 'assistant',
        timestamp: '2026-07-30T00:07:00.000Z',
        text: `Progressive image\n\n![Progressive fixture](${baseUrl}/held-progressive.png)`,
        content_type: 'text',
        is_meta: 0,
      },
      ...Array.from({ length: FILLER_COUNT }, (_, offset) => ({
        uuid: `message-${8 + offset}`,
        type: offset % 2 === 0 ? 'user' : 'assistant',
        timestamp: new Date(Date.UTC(2026, 6, 30, 1, offset)).toISOString(),
        text: `Filler ${offset}. ${'Timeline body copy that gives the row a realistic height. '.repeat(6)}`,
        content_type: 'text',
        is_meta: 0,
      })),
    ];
    registerHandlers();
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        preload: join(appRoot, 'out', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), {
      hash: '/sessions',
    });
    await waitFor(
      win.webContents,
      `document.body.textContent.includes('Session image rendering')`,
      'session list',
    );
    await win.webContents.executeJavaScript(`(() => {
      window.__wideImageLayout = new Promise((resolve, reject) => {
        const fail = reason => {
          observer.disconnect();
          reject(new Error(reason));
        };
        const timer = setTimeout(() => fail('wide image never reported a layout'), 8000);
        const settle = value => {
          clearTimeout(timer);
          resolve(value);
        };
        const observer = new MutationObserver(() => {
          const message = document.querySelector('[data-uuid="message-1"]');
          const host = message?.querySelector('obelisk-session-image');
          const image = host?.shadowRoot?.querySelector('img');
          const row = message?.closest('.virtual-timeline-row');
          if (!image || !row) return;
          observer.disconnect();
          const before = row.getBoundingClientRect().height;
          image.addEventListener('error', () => fail('wide image failed to load'), { once: true });
          image.addEventListener('load', () => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              settle({
                before,
                after: row.getBoundingClientRect().height,
              });
            }));
          }, { once: true });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      window.location.hash = ${JSON.stringify(`/sessions/${sessionId}`)};
    })()`, true);

    await waitFor(
      win.webContents,
      `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messages.length}'`,
      'image fixture timeline',
    );
    const resize = await withDeadline(
      win.webContents.executeJavaScript('window.__wideImageLayout', true),
      'wide image row remeasurement',
    );
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-2"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loaded')`,
      'small image load',
    );
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-3"] obelisk-session-image')?.shadowRoot?.querySelector('.is-error')`,
      'failed image state',
    );
    await delay(100);

    const layout = await win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.detail-wrap');
      const wideMessage = document.querySelector('[data-uuid="message-1"]');
      const wideRow = wideMessage.closest('.virtual-timeline-row');
      const nextRow = document.querySelector('[data-uuid="message-2"]').closest('.virtual-timeline-row');
      const wideHost = wideMessage.querySelector('obelisk-session-image');
      const wideImage = wideHost.shadowRoot.querySelector('img');
      const smallHost = document.querySelector('[data-uuid="message-2"] obelisk-session-image');
      const smallImage = smallHost.shadowRoot.querySelector('img');
      const brokenHost = document.querySelector('[data-uuid="message-3"] obelisk-session-image');
      const wideHostRect = wideHost.getBoundingClientRect();
      const wideImageRect = wideImage.getBoundingClientRect();
      const smallImageRect = smallImage.getBoundingClientRect();
      const wideRowRect = wideRow.getBoundingClientRect();
      const nextRowRect = nextRow.getBoundingClientRect();
      // Row spacing is applied by the virtualizer, not by CSS on the row, so
      // calibrate against the spacing the rest of this timeline is using rather
      // than hard-coding the current value.
      const mountedRows = [...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => ({ index: Number(row.dataset.index), rect: row.getBoundingClientRect() }))
        .sort((left, right) => left.index - right.index);
      const gaps = mountedRows
        .slice(1)
        .map((row, offset) => row.rect.top - mountedRows[offset].rect.bottom)
        .sort((left, right) => left - right);
      return {
        wrapClientWidth: wrap.clientWidth,
        wrapScrollWidth: wrap.scrollWidth,
        wideHostWidth: wideHostRect.width,
        wideImageWidth: wideImageRect.width,
        wideImageHeight: wideImageRect.height,
        wideNaturalWidth: wideImage.naturalWidth,
        wideNaturalHeight: wideImage.naturalHeight,
        smallImageWidth: smallImageRect.width,
        smallNaturalWidth: smallImage.naturalWidth,
        rowHeight: wideRowRect.height,
        rowGap: nextRowRect.top - wideRowRect.bottom,
        typicalRowGap: gaps[Math.floor(gaps.length / 2)] ?? null,
        brokenText: brokenHost.shadowRoot.querySelector('figcaption')?.textContent || '',
      };
    })()`, true);

    assert(
      resize.after > resize.before + 100,
      `image load grows and remeasures its virtual row (${JSON.stringify(resize)})`,
    );
    assert(
      layout.wrapScrollWidth <= layout.wrapClientWidth + 1,
      `wide images do not add session-level horizontal overflow (${JSON.stringify(layout)})`,
    );
    assert(
      layout.wideImageWidth <= layout.wideHostWidth + 1
        && Math.abs(
          layout.wideImageWidth / layout.wideImageHeight
          - layout.wideNaturalWidth / layout.wideNaturalHeight
        ) < 0.01,
      `wide images fit their host and preserve aspect ratio (${JSON.stringify(layout)})`,
    );
    assert(
      layout.smallImageWidth <= layout.smallNaturalWidth + 1,
      `small images keep their intrinsic width (${JSON.stringify(layout)})`,
    );
    assert(
      layout.rowHeight > layout.wideImageHeight
        && layout.typicalRowGap !== null
        && Math.abs(layout.rowGap - layout.typicalRowGap) <= 1,
      `measured image rows do not overlap the following row (${JSON.stringify(layout)})`,
    );
    assert(
      layout.brokenText.includes('Image unavailable')
        && layout.brokenText.includes('Missing timeline fixture'),
      `failed images remain contained with fallback text (${JSON.stringify(layout)})`,
    );

    // --- Reader position must survive an above-viewport image finishing. ---
    // Both fixtures sit above the viewport for the rest of the run, so this also
    // confirms a mounted row fetches its image without being on screen.
    assert(
      heldRequestCount('/held-rest.svg') > 0 && heldRequestCount('/held-scroll.svg') > 0,
      'mounted rows request their images while off screen'
        + ` (${heldRequestCount('/held-rest.svg')}, ${heldRequestCount('/held-scroll.svg')})`,
    );

    const parkAbove = (uuid, distance) => win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.detail-wrap');
      const wrapRect = wrap.getBoundingClientRect();
      const row = document.querySelector('[data-uuid="${uuid}"]').closest('.virtual-timeline-row');
      const rowRect = row.getBoundingClientRect();
      wrap.scrollTop += (rowRect.bottom - wrapRect.top) + ${distance};
      return wrap.scrollTop;
    })()`, true);

    // Scrolls backward and reports the largest movement of a visible row that
    // scroll input does not account for. A row growing above the viewport
    // without compensation shows up here as a residual the size of the growth;
    // a compensated one leaves the residual at zero.
    const backwardScrollProbe = ({ durationMs = 1_500, stepPx = 12 } = {}) =>
      win.webContents.executeJavaScript(`new Promise(resolve => {
      const wrap = document.querySelector('.detail-wrap');
      const blockAutomaticScrollEnd = event => event.stopImmediatePropagation();
      wrap.addEventListener('scrollend', blockAutomaticScrollEnd, true);
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -70, bubbles: true }));
      let previous = null;
      let maxResidual = 0;
      let example = null;
      const startedAt = performance.now();
      function frame(now) {
        wrap.scrollTop -= ${stepPx};
        const wrapRect = wrap.getBoundingClientRect();
        const scrollTop = wrap.scrollTop;
        const rows = new Map([...document.querySelectorAll('.virtual-timeline-row')]
          .map(row => [
            row.querySelector('[data-uuid]')?.getAttribute('data-uuid'),
            row.getBoundingClientRect().top - wrapRect.top,
          ])
          .filter(([uuid, top]) => uuid && top > -200 && top < wrapRect.height));
        if (previous) {
          for (const [uuid, top] of rows) {
            if (!previous.rows.has(uuid)) continue;
            const residual = (top - previous.rows.get(uuid)) + (scrollTop - previous.scrollTop);
            if (Math.abs(residual) > Math.abs(maxResidual)) {
              maxResidual = residual;
              example = { uuid, residual, scrollTop };
            }
          }
        }
        previous = { rows, scrollTop };
        if (now - startedAt < ${durationMs}) {
          requestAnimationFrame(frame);
          return;
        }
        wrap.removeEventListener('scrollend', blockAutomaticScrollEnd, true);
        wrap.dispatchEvent(new Event('scrollend'));
        resolve({ maxResidual, example });
      }
      requestAnimationFrame(frame);
    })`, true);

    const captureGeometry = () => win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.detail-wrap');
      const wrapRect = wrap.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => ({
          uuid: row.querySelector('[data-uuid]')?.getAttribute('data-uuid'),
          rect: row.getBoundingClientRect(),
        }))
        .filter(row => row.uuid && row.rect.bottom > wrapRect.top && row.rect.top < wrapRect.bottom)
        .sort((left, right) => left.rect.top - right.rect.top);
      return {
        scrollTop: wrap.scrollTop,
        firstVisible: rows[0]?.uuid || null,
        tops: Object.fromEntries(rows.map(row => [row.uuid, row.rect.top - wrapRect.top])),
      };
    })()`, true);

    await parkAbove('message-6', 420);
    // Longer than isScrollingResetDelay so the virtualizer is genuinely at rest.
    await delay(700);
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-5"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loading')`,
      'held rest image still pending above the viewport',
    );
    const restBefore = await captureGeometry();
    releaseHeldImage('/held-rest.svg');
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-5"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loaded')`,
      'held rest image load',
    );
    await delay(250);
    const restAfter = await captureGeometry();
    const restAnchor = restBefore.firstVisible;
    const restDrift = restAnchor !== null && restAfter.tops[restAnchor] !== undefined
      ? restAfter.tops[restAnchor] - restBefore.tops[restAnchor]
      : Number.NaN;
    assert(
      Math.abs(restDrift) <= 1,
      'an image loading above the viewport does not move the reader position'
        + ` (${JSON.stringify({ anchor: restAnchor, drift: restDrift, scrollTop: [restBefore.scrollTop, restAfter.scrollTop] })})`,
    );

    // Same guarantee mid-gesture: scrolling back through history is when rows
    // above the viewport are most likely to still be settling their media.
    await parkAbove('message-6', 2_000);
    await delay(700);
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-6"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loading')`,
      'held scroll image still pending above the viewport',
    );
    const scrollProbe = backwardScrollProbe();
    await delay(500);
    releaseHeldImage('/held-scroll.svg');
    const scrolling = await withDeadline(scrollProbe, 'backward scroll residual probe');
    assert(
      Math.abs(scrolling.maxResidual) <= 2,
      'an image loading above the viewport does not move visible rows mid-scroll'
        + ` (${JSON.stringify(scrolling)})`,
    );

    // A progressively decoded image lays out from its header, so the row grows
    // long before the load event. Waiting for load to mark the row would leave
    // that first, largest growth uncompensated.
    await parkAbove('message-7', 2_000);
    await delay(700);
    assert(
      progressiveRequestCount() > 0,
      `the progressive fixture was requested (${progressiveRequestCount()})`,
    );
    await win.webContents.executeJavaScript(`(() => {
      const host = document.querySelector('[data-uuid="message-7"] obelisk-session-image');
      const row = host.closest('.virtual-timeline-row');
      const image = host.shadowRoot.querySelector('img');
      const timing = {
        start: performance.now(),
        placeholderHeight: row.getBoundingClientRect().height,
        grewAt: null,
        loadedAt: null,
        height: 0,
      };
      // ResizeObserver reports the current size straight away; only a later,
      // larger measurement is the image arriving.
      timing.height = timing.placeholderHeight;
      const since = () => Math.round(performance.now() - timing.start);
      new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.contentRect.height <= timing.height + 100) continue;
          timing.height = entry.contentRect.height;
          if (timing.grewAt === null) timing.grewAt = since();
        }
      }).observe(row);
      image.addEventListener('load', () => { timing.loadedAt = since(); }, { once: true });
      window.__progressiveTiming = timing;
    })()`, true);
    const progressiveProbe = backwardScrollProbe({ durationMs: 3_400, stepPx: 6 });
    await delay(400);
    // Blink holds partial image data back for about a second before flushing it
    // to the decoder, so the response has to stay open well past that for the
    // row to grow before the load event.
    releaseProgressiveImage(2_000);
    const progressive = await withDeadline(
      progressiveProbe,
      'progressive scroll residual probe',
      15_000,
    );
    const timing = await win.webContents.executeJavaScript('window.__progressiveTiming', true);
    assert(
      timing.grewAt !== null && timing.loadedAt !== null && timing.grewAt < timing.loadedAt - 100,
      `the fixture grows its row before the load event, as a chunked image does (${JSON.stringify(timing)})`,
    );
    assert(
      Math.abs(progressive.maxResidual) <= 2,
      'a progressively decoded image does not move visible rows before it finishes'
        + ` (${JSON.stringify(progressive)})`,
    );
  } finally {
    win?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

app.whenReady()
  .then(() => withDeadline(run(), 'the session image suite to finish', 180_000))
  .catch(error => {
    failures++;
    console.error(error.stack || error);
  })
  .finally(() => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    app.exit(failures ? 1 : 0);
  });
