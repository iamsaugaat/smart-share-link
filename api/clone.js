// api/clone.js
// Minimal Smart Share Link → clone a public page you own into a ZIP.
// Requires deps: jszip, jsdom, node-fetch@2 (CommonJS)

const JSZip = require('jszip');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36';

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function toAbs(u, base) {
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

async function fetchText(u) {
  const r = await fetch(u, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
  return await r.text();
}

async function fetchBuf(u) {
  const r = await fetch(u, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// Rewrites url(...) in CSS, and schedules those assets for download
function rewriteCssUrls(cssText, baseHref, scheduleAsset) {
  return cssText.replace(/url\((['"]?)(.*?)\1\)/g, (m, _q, u) => {
    const abs = toAbs(u, baseHref);
    if (!abs || abs.startsWith('data:')) return m;
    const ext =
      abs.split('?')[0].split('#')[0].match(/\.[a-z0-9]+$/i)?.[0] || '';
    const filename = scheduleAsset(abs, ext);
    return `url(${filename})`;
  });
}

async function clonePage(targetUrl) {
  // 1) Load HTML
  const htmlSrc = await fetchText(targetUrl);
  const dom = new JSDOM(htmlSrc);
  const { document } = dom.window;

  // Remove scripts (keep layout safe & static)
  document.querySelectorAll('script').forEach((s) => s.remove());

  // 2) Asset management
  // Map absUrl -> { filename, promise(Buffer) }
  const assetMap = new Map();
  function scheduleAsset(absUrl, extGuess = '') {
    if (!absUrl) return null;
    if (assetMap.has(absUrl)) return assetMap.get(absUrl).filename;
    const ext =
      extGuess ||
      absUrl.split('?')[0].split('#')[0].match(/\.[a-z0-9]+$/i)?.[0] ||
      '';
    const filename = `assets/${hash(absUrl)}${ext}`;
    const promise = fetchBuf(absUrl).catch(() => Buffer.from(''));
    assetMap.set(absUrl, { filename, promise });
    return filename;
  }

  // 3) Inline external stylesheets and rewrite their URLs
  const links = Array.from(
    document.querySelectorAll('link[rel="stylesheet"][href]')
  );
  for (const link of links) {
    try {
      const abs = toAbs(link.getAttribute('href'), targetUrl);
      let css = await fetchText(abs);
      css = rewriteCssUrls(css, abs, scheduleAsset);
      const style = document.createElement('style');
      style.textContent = css;
      link.replaceWith(style);
    } catch {
      // ignore bad CSS
    }
  }

  // 4) Images (src + srcset)
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (src) {
      const abs = toAbs(src, targetUrl);
      const fn = scheduleAsset(abs);
      if (fn) img.setAttribute('src', fn);
    }
    if (img.hasAttribute('srcset')) {
      const parts = img
        .getAttribute('srcset')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          const [u, w] = entry.split(/\s+/);
          const abs = toAbs(u, targetUrl);
          const fn = scheduleAsset(abs);
          return fn ? `${fn}${w ? ' ' + w : ''}` : entry;
        });
      img.setAttribute('srcset', parts.join(', '));
    }
  }

  // 5) Inline style background-image URLs
  for (const el of Array.from(document.querySelectorAll('[style]'))) {
    const styleVal = el.getAttribute('style');
    if (!/url\(/i.test(styleVal)) continue;
    const newVal = styleVal.replace(
      /url\((['"]?)(.*?)\1\)/g,
      (m, _q, u) => {
        const abs = toAbs(u, targetUrl);
        if (!abs || abs.startsWith('data:')) return m;
        const ext =
          abs.split('?')[0].split('#')[0].match(/\.[a-z0-9]+$/i)?.[0] || '';
        const fn = scheduleAsset(abs, ext);
        return `url(${fn})`;
      }
    );
    el.setAttribute('style', newVal);
  }

  // 6) Replace any <form> with a marker for easy CF embed
  for (const f of Array.from(document.querySelectorAll('form'))) {
    const marker = document.createComment(' CF_FORM_HERE ');
    f.replaceWith(marker);
  }

  // 7) Serialize HTML
  const htmlOut = '<!doctype html>\n' + document.documentElement.outerHTML;
  return { htmlOut, assetMap };
}

async function buildZip({ htmlOut, assetMap }) {
  const zip = new JSZip();
  zip.file('index.html', htmlOut);

  // Add all scheduled assets
  for (const [, { filename, promise }] of assetMap.entries()) {
    const buf = await promise; // Buffer (may be empty if failed)
    if (buf && buf.length) {
      zip.file(filename, buf);
    }
  }
  return await zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = async (req, res) => {
  try {
    const targetUrl = (req.query.url || '').trim();
    if (!targetUrl) {
      res.status(400).json({ ok: false, error: 'Missing ?url=' });
      return;
    }
    if (!/^https?:\/\//i.test(targetUrl)) {
      res.status(400).json({ ok: false, error: 'Invalid URL' });
      return;
    }

    const { htmlOut, assetMap } = await clonePage(targetUrl);
    const zipBuf = await buildZip({ htmlOut, assetMap });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="clone.zip"'
    );
    res.status(200).send(zipBuf);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

