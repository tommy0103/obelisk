// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMarkdownImageToken,
  renderSessionMarkdownImage,
} from '../app/src/renderer/src/markdown-image-renderer.js';

// marked <= 14 calls renderer.image(href, title, text); marked >= 15 passes the
// token. Getting this wrong degrades silently: every session image turns into
// fallback text because the href is no longer a string.
test('accepts the positional renderer signature', () => {
  assert.deepEqual(
    normalizeMarkdownImageToken('http://example.test/a.png', 'A title', 'Alt text'),
    { href: 'http://example.test/a.png', title: 'A title', text: 'Alt text' },
  );
});

test('accepts the token renderer signature', () => {
  assert.deepEqual(
    normalizeMarkdownImageToken({
      type: 'image',
      href: 'http://example.test/a.png',
      title: 'A title',
      text: 'Alt text',
    }),
    { href: 'http://example.test/a.png', title: 'A title', text: 'Alt text' },
  );
});

test('fills in the fields marked leaves null', () => {
  assert.deepEqual(
    normalizeMarkdownImageToken({ href: 'http://example.test/a.png', title: null, text: '' }),
    { href: 'http://example.test/a.png', title: '', text: '' },
  );
  assert.deepEqual(
    normalizeMarkdownImageToken('http://example.test/a.png', null, null),
    { href: 'http://example.test/a.png', title: '', text: '' },
  );
});

test('renders an allowed source as the session image element', () => {
  assert.equal(
    renderSessionMarkdownImage('http://example.test/a.png', '', 'Alt text'),
    '<obelisk-session-image src="http://example.test/a.png" alt="Alt text"></obelisk-session-image>',
  );
  assert.equal(
    renderSessionMarkdownImage('data:image/png;base64,AAAA', '', ''),
    '<obelisk-session-image src="data:image/png;base64,AAAA" alt=""></obelisk-session-image>',
  );
});

test('carries the title through when marked supplies one', () => {
  assert.equal(
    renderSessionMarkdownImage('file:///shots/a.png', 'A title', 'Alt'),
    '<obelisk-session-image src="file:///shots/a.png" alt="Alt" title="A title"></obelisk-session-image>',
  );
});

test('drops a source the app will not load, keeping one unavailable state', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.test/a.png', '']) {
    assert.equal(
      renderSessionMarkdownImage(href, '', 'Alt text'),
      '<obelisk-session-image alt="Alt text"></obelisk-session-image>',
      `expected ${href || '(empty)'} to render without a src`,
    );
  }
});

test('decodes what marked escaped exactly once, then re-escapes it', () => {
  assert.equal(
    renderSessionMarkdownImage('http://example.test/a.png?x=1&amp;y=2', '', '&quot;quoted&quot; &amp; &#39;single&#39;'),
    '<obelisk-session-image src="http://example.test/a.png?x=1&amp;y=2"'
      + ' alt="&quot;quoted&quot; &amp; \'single\'"></obelisk-session-image>',
  );
  // A single decoding pass, so text that was literally `&lt;` in the source
  // does not decay into a real angle bracket.
  assert.equal(
    renderSessionMarkdownImage('http://example.test/a.png', '', '&amp;lt;script&amp;gt;'),
    '<obelisk-session-image src="http://example.test/a.png"'
      + ' alt="&amp;lt;script&amp;gt;"></obelisk-session-image>',
  );
});

test('never lets alt text break out of the attribute', () => {
  const html = renderSessionMarkdownImage('http://example.test/a.png', '', '"><img src=x onerror=alert(1)>');
  assert.equal(html.includes('onerror=alert(1)>'), false);
  assert.equal(
    html,
    '<obelisk-session-image src="http://example.test/a.png"'
      + ' alt="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></obelisk-session-image>',
  );
});
