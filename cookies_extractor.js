const fs = require("fs");
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");

const platform = os.platform();

function getCookiesForDomain(domain, browser = null) {
  const { exec } = require("child_process");
  if (browser === null) {
    if (platform === "win32") {
      exec('reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId', (err, stdout) => {
        if (err) return console.error(err);
        const match = stdout.match(/ProgId\s+REG_SZ\s+(.+)/);
        if (match) {
          browser = match[1];
        }
      });
    } else if (platform === "darwin") {
      exec('defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers -array', (err, stdout) => {
        if (err) return console.error(err);
        browser = stdout;
      });
    } else {
      exec('xdg-settings get default-web-browser', (err, stdout) => {
        if (err) return console.error(err);
        browser = stdout;
      });
    }
  }

  browser = browser.toLowerCase();
  if (browser.includes("firefox")) {
    return firefoxCookiesProcess(domain);
  } else if (browser.includes("chrome")) {
    return chromeCookiesProcess(domain);
  } else if (browser.includes("edge")) {
    return edgeCookiesProcess(domain);
  } else if (browser.includes("brave")) {
    return braveCookiesProcess(domain);
  } else if (browser.includes("safari")) {
    return safariCookiesProcess(domain);
  } else if (browser.includes("opera")) {
    return chromeCookiesProcess(domain);
  } else {
    console.error(`Unsupported browser for cookie extraction: ${browser}`);
    return null;
  }
}

function braveCookiesProcess(domain) {
  // TODO
  return [];
}

function edgeCookiesProcess(domain) {
  // TODO
  return [];
}

function safariCookiesProcess(domain) {
  // TODO
  return [];
}

function chromeCookiesProcess(domain) {
  // TODO
  return [];
}

function firefoxCookiesProcess(domain) {
  const profileDir = findFirefoxProfileDir();
  const cookiesDbPath = path.join(profileDir, "cookies.sqlite");
  if (!fs.existsSync(cookiesDbPath)) {
    throw new Error(`cookies.sqlite not found in the profile: ${cookiesDbPath}`);
  }

  const db = new Database(cookiesDbPath, { readonly: true, fileMustExist: true });
  const stmt = db.prepare(`
    SELECT name, value, host, path, expiry, isSecure, isHttpOnly
    FROM moz_cookies
    WHERE host LIKE ?
  `);
  const rows = stmt.all(`%${domain}%`);
  db.close();

  return rows.map(r => ({
    name: r.name,
    value: r.value,
    host: r.host,
    path: r.path,
    expiry: r.expiry,
    isSecure: Boolean(r.isSecure),
    isHttpOnly: Boolean(r.isHttpOnly),
  }));
}

function getFirefoxProfilesBaseDir() {
  if (platform === "win32") {
    return path.join(process.env.APPDATA || "", "Mozilla", "Firefox", "Profiles");
  } else if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles");
  } else {
    // linux / other unix
    return path.join(os.homedir(), ".mozilla", "firefox");
  }
}

function findFirefoxProfileDir() {
  const base = getFirefoxProfilesBaseDir();
  if (!fs.existsSync(base)) {
    throw new Error(`Firefox profile folder not found: ${base}`);
  }

  const entries = fs.readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  // prefer folders ending with .default-release
  const prefer = entries.find(name => name.endsWith(".default-release"));
  if (prefer) return path.join(base, prefer);

  // fallback: first folder that contains cookies.sqlite
  for (const name of entries) {
    const candidate = path.join(base, name);
    if (fs.existsSync(path.join(candidate, "cookies.sqlite"))) return candidate;
  }

  // fallback: if no folder has cookies.sqlite, but there are folders, return first
  if (entries.length > 0) return path.join(base, entries[0]);

  throw new Error(`No Firefox profile found in ${base}`);
}

module.exports = { getCookiesForDomain };
