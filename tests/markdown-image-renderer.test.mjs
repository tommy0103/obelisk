// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionMarked } from '../app/src/renderer/src/markdown-image-renderer.js';

const render = markdown => sessionMarked.parse(markdown, { async: false }).trim();
const paragraph = html => `<p>${html}</p>`;

test('renders an allowed source as the session image element', () => {
  assert.equal(
    render('![Alt text](http://example.test/a.png)'),
    paragraph('<obelisk-session-image src="http://example.test/a.png" alt="Alt text"></obelisk-session-image>'),
  );
  assert.equal(
    render('![](data:image/png;base64,AAAA)'),
    paragraph('<obelisk-session-image src="data:image/png;base64,AAAA" alt=""></obelisk-session-image>'),
  );
});

test('carries the title through when the Markdown has one', () => {
  assert.equal(
    render('![Alt](file:///shots/a.png "A title")'),
    paragraph('<obelisk-session-image src="file:///shots/a.png" alt="Alt" title="A title"></obelisk-session-image>'),
  );
});

test('drops a source the app will not load, keeping one unavailable state', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.test/a.png', '']) {
    assert.equal(
      render(`![Alt text](${href})`),
      paragraph('<obelisk-session-image alt="Alt text"></obelisk-session-image>'),
      `expected ${href || '(empty)'} to render without a src`,
    );
  }
});

test('decodes entity references exactly once, then re-escapes them', () => {
  assert.equal(
    render('![&quot;quoted&quot; &amp; &#39;single&#39;](http://example.test/a.png?x=1&amp;y=2)'),
    paragraph('<obelisk-session-image src="http://example.test/a.png?x=1&amp;y=2"'
      + ' alt="&quot;quoted&quot; &amp; \'single\'"></obelisk-session-image>'),
  );
  // A single decoding pass, so text that was literally `&lt;` in the source
  // does not decay into a real angle bracket.
  assert.equal(
    render('![&amp;lt;script&amp;gt;](http://example.test/a.png)'),
    paragraph('<obelisk-session-image src="http://example.test/a.png"'
      + ' alt="&amp;lt;script&amp;gt;"></obelisk-session-image>'),
  );
});

test('never lets alt text break out of the attribute', () => {
  const html = render('!["><img src=x onerror=alert(1)>](http://example.test/a.png)');
  assert.equal(html.includes('onerror=alert(1)>'), false);
  assert.equal(
    html,
    paragraph('<obelisk-session-image src="http://example.test/a.png"'
      + ' alt="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></obelisk-session-image>'),
  );
});
