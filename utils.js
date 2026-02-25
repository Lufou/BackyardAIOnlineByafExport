async function downloadImageAsFile(url) {
    const path = require("path");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Error while downloading: ${url}`);
    
    const buffer = Buffer.from(await res.arrayBuffer());
    
    const ext = path.extname(url).toLowerCase();
    const mimeTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    };
    const mimeType = mimeTypes[ext] || "application/octet-stream";
    
    const filename = path.basename(url);

    return new File([buffer], filename, { type: mimeType });
}

function replaceStringSpecial(input, configId) {
    let to_replace = `{_cfg&:${configId}:cfg&_}`;
    let replaced = input.replaceAll(to_replace, "{character}");
    return replaced;
}

function parseBrowserString(str) {
  const regex = /^([^:+]+)(?:\+([^:]+))?(?::([^:]+))?(?:::([^:]+))?$/;
  const match = str.match(regex);

  if (!match) {
    throw new Error(`Invalid format: ${str}`);
  }

  const [, browser, keyring, profile, container] = match;

  return [
    browser,
    keyring || null,
    profile || null,
    container || null
  ];
}

function buildCookiesFromString(cookiesString) {
  let cookies = [];

  for (let cookie of cookiesString.split(';')) {
    const cookieParts = cookie.split('=');
    let cookieName = cookieParts[0];
    let cookieValue = cookieParts[1];
    if (cookieName.startsWith(' ')) {
      cookieName = cookieName.replace(' ', '');
    }
    cookies.push({
      name: cookieName,
      value: cookieValue
    })
  }

  return cookies;
}

module.exports = { downloadImageAsFile, replaceStringSpecial, parseBrowserString, buildCookiesFromString };

