const fs = require("fs");
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");

const platform = os.platform();

function getCookiesForDomain(domain, browser = null) {
  const { exec } = require("child_process");
  const { debugLog } = require("./logging.js");
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
    if (browser) {
      debugLog(`Detected default browser: ${browser}`);
    }
  }

  if (!browser) {
    console.warn("Could not determine default browser. Please specify the browser manually.");
    return null;
  }

  browser = browser.toLowerCase();
  let cookies = null;
  if (browser.includes("firefox")) {
    cookies = firefoxCookiesProcess(domain);
  } else if (browser.includes("chrome")) {
    cookies = chromeCookiesProcess(domain);
  } else if (browser.includes("edge")) {
    cookies = chromeCookiesProcess(domain, getEdgeCookiesPath());
  } else if (browser.includes("brave")) {
    cookies = chromeCookiesProcess(domain, getBraveCookiesPath());
  } else if (browser.includes("safari")) {
    cookies = safariCookiesProcess(domain);
  } else if (browser.includes("opera")) {
    cookies = chromeCookiesProcess(domain);
  } else {
    console.error(`Unsupported browser for cookie extraction: ${browser}`);
  }
  if (cookies) {
    cookies = cookies.map(r => ({
      name: r.name,
      value: r.value,
      host: r.host,
      path: r.path,
      expiry: r.expiry,
      isSecure: Boolean(r.isSecure),
      isHttpOnly: Boolean(r.isHttpOnly),
    }));
  }
  return cookies;
}

function safariCookiesProcess(domain) {
  if (platform !== "darwin") return [];

  const dbPath = path.join(os.homedir(), "Library", "Cookies", "Cookies.binarycookies");
  if (!fs.existsSync(dbPath)) return [];

  // Parsing Safari binary cookies is non-trivial; using a simple placeholder
  console.error("Safari cookie extraction not fully implemented. Returning empty array.");
  return [];
}

function chromeCookiesProcess(domain, overridePath = null) {
  const dbPath = overridePath ? overridePath : getChromeCookiesPath();
  if (!dbPath || !fs.existsSync(dbPath)) return [];

  try {
    const db = new Database(dbPath, { readonly: true });
    const stmt = db.prepare(`
      SELECT name, value, host_key AS host, path, expires_utc AS expiry, is_secure AS isSecure, is_httponly AS isHttpOnly
      FROM cookies
      WHERE host_key LIKE ?
    `);
    const rows = stmt.all(`%${domain}%`);
    db.close();

    return rows;
  } catch (err) {
    console.error("Error reading Chrome cookies:", err);
    return [];
  }
}

function firefoxCookiesProcess(domain) {
  try {
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

    return rows;
  } catch (err) {
    console.error("Error reading Firefox cookies:", err);
    return [];
  }
}

function getChromeCookiesPath() {
  if (platform === "win32") return path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data", "Default", "Cookies");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "Default", "Cookies");
  return path.join(os.homedir(), ".config", "google-chrome", "Default", "Cookies");
}

function getBraveCookiesPath() {
  if (platform === "win32") return path.join(process.env.LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data", "Default", "Cookies");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser", "Default", "Cookies");
  return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser", "Default", "Cookies");
}

function getEdgeCookiesPath() {
  if (platform === "win32") return path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data", "Default", "Cookies");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Microsoft Edge", "Default", "Cookies");
  return path.join(os.homedir(), ".config", "microsoft-edge", "Default", "Cookies");
}

function getFirefoxProfilesBaseDir() {
  if (platform === "win32") return path.join(process.env.APPDATA || "", "Mozilla", "Firefox", "Profiles");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles");
  return path.join(os.homedir(), ".mozilla", "firefox");
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
