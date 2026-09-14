// Links in a story — the caption, and the text of a text-only story.
//
// The ask: a URL typed into a story's caption (or into the text of a text-only
// story, which IS the story) has to read as a link and, where it can, preview.
// Those two surfaces are NOT chat: the text is typed prose with no markdown and
// its exact whitespace matters, and the reader is looking at a full-bleed
// picture, so a story takes the cheap end of the embed set (a click-to-play
// YouTube facade, direct media) and a generic unfurl card for everything else —
// never chat's iframes (Spotify, X, a Twitch player) on top of somebody's photo.
//
// This runs the REAL linkifyHTML / storyLinkEmbedsHTML / linkEmbedsHTML out of
// public/embeds.js, offline (no database, no browser). Plus the static wiring
// that ties them to the three surfaces: the story viewer's caption + markup, the
// view-once caption + markup, and the bottom bar the preview card lands in.
//
// Usage: node scripts/test-story-links.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

// embeds.js calls the app's global esc() at call time (it is a classic script,
// loaded before the js/ modules and after nothing). Stand it up verbatim.
global.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const embeds = require(path.join(ROOT, 'public/embeds.js'));
const { linkifyHTML, storyLinkEmbedsHTML, linkEmbedsHTML, cleanEmbedUrl, setLinkPreviews, __cardCache } = embeds;

console.log('\n[1] a URL in typed prose becomes a real link — and nothing else moves');
{
  const out = linkifyHTML('see https://example.com/x now');
  check(out === 'see <a href="https://example.com/x" target="_blank" rel="noopener nofollow ugc">https://example.com/x</a> now',
    'the URL is the anchor text and the punctuation around it is untouched', out);
  check(/^<a /.test(linkifyHTML('https://example.com')), 'a URL at the start linkifies', linkifyHTML('https://example.com'));
  check(/<\/a>$/.test(linkifyHTML('go to https://example.com')), 'a URL at the end linkifies', linkifyHTML('go to https://example.com'));
  check(linkifyHTML('no links here') === 'no links here', 'plain prose is returned unchanged', linkifyHTML('no links here'));
  check(linkifyHTML('') === '' && linkifyHTML(null) === '' && linkifyHTML(undefined) === '',
    'empty input is an empty string, never a throw', null);
}
{
  // Prose, not markup: no markdown, emoji shortcodes or mentions are touched,
  // and every whitespace character survives (the caption renders pre-wrap).
  const prose = 'line one\n**not bold** :fire: @someone\n\nline two';
  check(linkifyHTML(prose) === prose.replace(/\n/g, '\n'), 'markdown/emoji/mentions are left exactly as typed', linkifyHTML(prose));
  const nl = linkifyHTML('a\n\nb');
  check(nl === 'a\n\nb', 'blank lines and indentation survive', JSON.stringify(nl));
}
{
  // Punctuation next to a pasted link is almost never part of it — the caption
  // is prose, so "read https://x.dev/a." must not swallow the full stop.
  const dot = linkifyHTML('read https://example.com/x.');
  check(dot.includes('href="https://example.com/x"') && !dot.includes('href="https://example.com/x."'),
    'a trailing full stop is not part of the URL', dot);
  check(dot.endsWith('>https://example.com/x</a>.'), 'the full stop stays in the text, outside the link', dot);
  const paren = linkifyHTML('(see https://en.wikipedia.org/wiki/Foo_(bar))');
  check(paren.includes('href="https://en.wikipedia.org/wiki/Foo_(bar)"'), 'a balanced closer stays in the URL', paren);
  const comma = linkifyHTML('a, https://example.com/x, b');
  check(comma.includes('>https://example.com/x</a>, b'), 'a comma after a link is left in the sentence', comma);
}
{
  // Captions are typed by other people and rendered with innerHTML now.
  const evil = linkifyHTML('<img src=x onerror=alert(1)>');
  check(!evil.includes('<img') && evil.includes('&lt;img'), 'raw HTML is escaped', evil);
  const q = linkifyHTML('"https://example.com/?a=1&b=2"');
  check(q.includes('href="https://example.com/?a=1&amp;b=2"'), 'ampersands are escaped in the href', q);
  check(!/<a [^>]*href="[^"]*javascript:/i.test(linkifyHTML('javascript:alert(1)')), 'a javascript: URL is not linkified', linkifyHTML('javascript:alert(1)'));
  check(!/<a /i.test(linkifyHTML('ftp://example.com/x')), 'a non-http scheme is not linkified', linkifyHTML('ftp://example.com/x'));
}
{
  // The same anchors have to be safe inside the scaled/rotated markup box too.
  const cap = fs.readFileSync(path.join(ROOT, 'public/js/story-edit.js'), 'utf8');
  check(/opts\.links && typeof linkifyHTML === 'function'\) el\.innerHTML = linkifyHTML\(txt\)/.test(cap),
    'the markup renderer linkifies text only when the caller opts in', null);
  check(/else el\.textContent = txt;/.test(cap), 'and otherwise paints it as inert text', null);
}

console.log('\n[2] a story takes the compact card, never chat\'s players');
{
  // The point of the split: a provider that gets an iframe or a 16:9 facade in
  // chat gets a compact unfurl card on a story, because a story is a picture
  // first and its bar has to stay a strip on a short (landscape) stage.
  const sp = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
  const inChat = linkEmbedsHTML(sp);
  const inStory = storyLinkEmbedsHTML(sp);
  check(inChat.includes('<iframe') && inChat.includes('embed-frame spotify'), 'chat still plays the Spotify iframe', inChat.slice(0, 80));
  check(!inStory.includes('<iframe'), 'a story does not', inStory);
  check(inStory.includes('embed-link compact') && inStory.includes('data-unfurl="' + sp + '"'), 'it gets the compact card instead', inStory);

  const yt = storyLinkEmbedsHTML('watch this https://youtu.be/dQw4w9WgXcQ it is good');
  check(!yt.includes('yt-facade') && yt.includes('embed-link compact'), 'and a YouTube link gets the card too, not a 16:9 facade', yt);
  check(!storyLinkEmbedsHTML('https://www.youtube.com/watch?v=dQw4w9WgXcQ').includes('<iframe'),
    'the /watch form as well', null);
  const img = storyLinkEmbedsHTML('https://cdn.example.com/pic.png');
  check(!img.includes('embed-img') && img.includes('embed-link compact'),
    'even a direct image is the card, not a full-size picture over the story', img);
  const vid = storyLinkEmbedsHTML('https://cdn.example.com/clip.mp4');
  check(!vid.includes('embed-vid') && vid.includes('embed-link compact'), 'and a direct video', vid);
  for (const u of ['https://x.com/jack/status/20', 'https://www.twitch.tv/somebody', 'https://vimeo.com/123456789']) {
    const out = storyLinkEmbedsHTML(u);
    check(!out.includes('<iframe') && !out.includes('embed-frame'), 'no player for ' + u, out);
  }
}
{
  const two = storyLinkEmbedsHTML('a https://example.com/a and https://example.com/b');
  check((two.match(/data-unfurl=/g) || []).length === 1, 'one card, even with two links', two);
  const one = storyLinkEmbedsHTML('a https://example.com/a b https://example.com/a');
  check((one.match(/data-unfurl=/g) || []).length === 1, 'a repeated link is one card', one);
  check(/^<div class="embeds">/.test(one) && /<\/div>$/.test(one), 'the card rides in the embeds wrapper', one);
}
{
  // A story's card is the embed, so it must not vanish when the unfurl has
  // nothing for the page: chat drops the empty stub, a story keeps the little
  // card with the site on it (and `keep` is also what survives a re-render
  // after the negative answer is cached).
  const bare = 'https://nothing-here.example/page';
  __cardCache.set(bare, null);
  const story = storyLinkEmbedsHTML(bare);
  check(story.includes('data-keep="1"') && story.includes('data-unfurl="' + bare + '"'),
    'a story keeps its card when the server had nothing for the page', story);
  check(story.includes('nothing-here.example'), 'and the card still names the site', story);
  check(!linkEmbedsHTML(bare).includes(bare), 'chat still drops a card nothing was found for', linkEmbedsHTML(bare));
}
{
  // A sticker is display text at 8.5% of the picture's height: a raw URL there
  // wraps into a ladder of characters, so it renders as a chip instead — in the
  // composer too, where it is dead (the drag owns the sticker).
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const edit = fs.readFileSync(path.join(ROOT, 'public/js/story-edit.js'), 'utf8');
  const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
  check(/\.ov-item\{[^}]*width:max-content[^}]*max-width:96%/.test(css),
    'a sticker can use the picture\'s full width (no half-width ladder)', null);
  check(/\.ov-layer \.ov-item a\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/.test(css),
    'the URL on a sticker is a one-line chip', null);
  check(/\.ov-editable \.ov-item a\{pointer-events:none\}/.test(css),
    'and the composer\'s chip is dead so the drag still owns the sticker', null);
  check(/if \(opts\.links && typeof linkifyHTML === 'function'\) el\.innerHTML = linkifyHTML\(txt\);\s*else el\.textContent = txt;/.test(edit),
    'the markup renderer linkifies on the caller\'s opt-in (composer AND viewer)', null);
  check(/ovPaintLayer\(layer, sc\.ovs, \{ editable: true, selected: sc\.draw \? null : sc\.sel, links: true \}\)/.test(stories),
    'the composer asks for it, so the preview shows what gets posted', null);
}
{
  check(storyLinkEmbedsHTML('no links at all') === '', 'a story with no link paints nothing', null);
  check(storyLinkEmbedsHTML('') === '' && storyLinkEmbedsHTML(null) === '', 'empty input is empty output', null);
  check(storyLinkEmbedsHTML('||https://example.com/hidden||') === '',
    'a spoilered link is not previewed (a thumb would leak it)', null);
  check(storyLinkEmbedsHTML('`https://example.com/code`').includes('data-unfurl=') === false,
    'a code-quoted link is not previewed', null);
  setLinkPreviews(false);
  check(storyLinkEmbedsHTML('https://example.com/a') === '', 'UNFURL=0 turns story cards off too', null);
  setLinkPreviews(true);
}

console.log('\n[3] the three surfaces are wired to it');
{
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
  const vo = fs.readFileSync(path.join(ROOT, 'public/js/viewonce.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');

  check(/<div class="sv-below">\s*<div class="sv-cap hidden" id="sv-cap"><\/div>\s*<div class="sv-links hidden" id="sv-links"><\/div>/.test(html),
    'the viewer\'s bottom bar holds the caption and the card slot', null);
  check(/const cap = \$\('#sv-cap'\);\s*const capText = String\(it\.caption \|\| ''\);\s*cap\.innerHTML = capText && typeof linkifyHTML === 'function' \? linkifyHTML\(capText\) : esc\(capText\);/.test(js.replace(/\n\s*/g, '\n  ')),
    'the viewer linkifies its caption', null);
  check(/svPaintLinks\(it\);/.test(js), 'and asks for the preview card in the same breath', null);
  check(/function svPaintLinks\(it\) \{/.test(js) && /for \(const o of ovParse\(it && it\.overlays\)\) if \(o && o\.t === 'text'\) text \+= '\\n' \+ String\(o\.text == null \? '' : o\.text\);/.test(js),
    'svPaintLinks gathers the caption AND the text-only story\'s text', null);
  check(/box\.innerHTML = html;/.test(js) && /box\.classList\.toggle\('hidden', !html\);/.test(js), 'it paints the cards and hides the slot when there are none', null);
  check(/ovPaintLayer\(layer, ovs, \{ editable: false, links: true \}\);/.test(js), 'the viewer\'s markup layer opts into links', null);

  check(/ovPaintLayer\(layer, ovs, \{ editable: false, links: true \}\);/.test(vo), 'the view-once player does too', null);
  check(/cap\.innerHTML = capText && typeof linkifyHTML === 'function' \? linkifyHTML\(capText\) : esc\(capText\);/.test(vo), 'and linkifies its own caption', null);
  check(/\$\('#vo-stage'\)\.onclick = \(e\) => \{ if \(e\.target\.closest && e\.target\.closest\('a\[href\]'\)\) return; closeViewOnce\(\); \};/.test(vo),
    'a tap on a link does not consume the one-shot view', null);

  // The bar is pointer-transparent so the prev/next zones keep stepping the
  // story; only the links and the card opt back in.
  check(/\.sv-below\{[^}]*pointer-events:none/.test(css), 'the bottom bar does not eat taps meant for the story', null);
  check(/\.sv-cap\{[^}]*white-space:pre-wrap/.test(css), 'the caption still renders pre-wrap', null);
  check(!/\.sv-cap\{[^}]*position:absolute/.test(css), 'the caption is laid out by the bar, not pinned on its own', null);
  check(/\.sv-cap a,\.vo-cap a,\.ov-view a\{[^}]*pointer-events:auto/.test(css), 'the anchors opt back in (caption, view-once caption, markup)', null);
  check(/\.sv-cap a,\.vo-cap a,\.ov-view a\{[^}]*color:#b9c2ff/.test(css), 'and are a readable link colour on the always-dark scrim', null);
  check(/\.sv-links \.embeds\{[^}]*pointer-events:auto/.test(css), 'the card slot is tappable', null);
  check(/\.ov-layer\.ov-view\{z-index:2\}/.test(css) && /\.sv-zone\{[^}]*z-index:1/.test(css),
    'a link in the markup is painted above the prev/next zones', null);
  check(/\.sv-links \.embed\{[^}]*background:rgba\(8,11,20,\.86\)/.test(css),
    'the card wears the story scrim, not the theme panel (light theme included)', null);
  check(sw.includes("'/embeds.js'"), 'embeds.js is still in the app-shell cache', null);
  check(/const CACHE = 'campfire-v\d+';/.test(sw), 'the service worker still names a cache version', null);
}
{
  // A text-only story has no caption field at all (the composer hides it), so
  // the link always lives in the markup text: the card has to come from there.
  const js = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
  check(/if \(edit\) edit\.classList\.toggle\('hidden', !!sc\.draw \|\| !!sc\.textOnly\);/.test(js),
    'the composer still hides the caption field for a text-only story', null);
}

console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' — ' + passed + ' checks passed');
if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
