/* I ported this file from Python: https://github.com/mikf/gallery-dl/blob/master/gallery_dl/cookies.py */
/* Chromium based browsers on Windows cookies decryption is not working on newer versions! */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { debugLog, infoLog, warnLog, errorLog } = require('./logging.js');
const { execSync } = require('child_process');
const { whichSync } = require('which');
const Database = require('better-sqlite3');

const SUPPORTED_BROWSERS_CHROMIUM = new Set([
    "brave", "chrome", "chromium", "edge", "opera", "thorium", "vivaldi"
]);
const SUPPORTED_BROWSERS_FIREFOX = new Set([
    "firefox", "librewolf", "zen"
]);
const SUPPORTED_BROWSERS_WEBKIT = new Set([
    "safari", "orion"
]);
const SUPPORTED_BROWSERS = new Set([
    ...SUPPORTED_BROWSERS_CHROMIUM,
    ...SUPPORTED_BROWSERS_FIREFOX,
    ...SUPPORTED_BROWSERS_WEBKIT
]);
const DE_OTHER = "other"
const DE_CINNAMON = "cinnamon"
const DE_GNOME = "gnome"
const DE_KDE = "kde"
const DE_PANTHEON = "pantheon"
const DE_UNITY = "unity"
const DE_XFCE = "xfce"

const KEYRING_KWALLET = "kwallet"
const KEYRING_GNOMEKEYRING = "gnomekeyring"
const KEYRING_BASICTEXT = "basictext"
const SUPPORTED_KEYRINGS = ["kwallet", "gnomekeyring", "basictext"];


const expanduser = text => text.replace(
    /^~([a-z]+|\/)/,
    (_, $1) => $1 === '/' ?
        os.homedir() : `${os.dirname(os.homedir())}/${$1}`
);

class DatabaseConnection {
    constructor(dbPath) {
        this.path = dbPath;
        this.database = null;
        this.directory = null;
    }

    async connect() {
        try {
            let uriPath = this.path.replace(/\?/g, '%3f').replace(/#/g, '%23');
            if (os.platform() === 'win32') {
                uriPath = '/' + path.resolve(uriPath);
            }
            const uri = `file:${uriPath}?mode=ro&immutable=1`;
            this.database = new Database(uri, { readonly: true });
            return this.database;
        } catch (exc) {
            debugLog(`Falling back to temporary database copy (${exc.name}: ${exc.message})`);
        }

        try {
            this.directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backyardaionlineexporter-'));
            const pathCopy = path.join(this.directory, 'copy.sqlite');
            await fs.promises.copyFile(this.path, pathCopy);
            this.database = new Database(pathCopy, { readonly: true });
            return this.database;
        } catch (err) {
            if (this.directory) {
                try {
                    fs.unlink(this.directory);
                } catch (err) {
                    warnLog(`Failed to remove temporary directory '${this.directory}': ${err.message}`);
                }
            }
            throw err;
        }
    }

    close() {
        if (this.database) {
            this.database.close();
        }
        if (this.directory) {
            try {
                fs.unlinkSync(this.directory);
            } catch (err) {
                warnLog(`Failed to remove temporary directory '${this.directory}': ${err.message}`);
            }
        }
    }
}

async function loadCookies(browserSpecification) {
    const [browserName, profile, keyring, container, domain] = _parse_browser_specification(...browserSpecification);

    if (SUPPORTED_BROWSERS_FIREFOX.has(browserName)) {
        return await loadCookiesFirefox(browserName, profile, container, domain);
    } else if (SUPPORTED_BROWSERS_WEBKIT.has(browserName)) {
        return await loadCookiesWebkit(browserName, profile, domain);
    } else if (SUPPORTED_BROWSERS_CHROMIUM.has(browserName)) {
        return await loadCookiesChromium(browserName, profile, keyring, domain);
    } else {
        throw new Error(`unknown browser '${browserName}'`);
    }
}

async function loadCookiesFirefox(browser_name, profile=null, container=null, domain=null) {
            
    const [path, container_id] = await _firefox_cookies_database(browser_name, profile, container)

    let sql = ("SELECT name, value, host, path, expiry, isSecure, isHttpOnly FROM moz_cookies")
    let conditions = []
    let parameters = []

    if(!container_id) {
        conditions.push("NOT INSTR(originAttributes,'userContextId=')")
    } else {
        const uid = `%userContextId=${container_id}`
        conditions.append("originAttributes LIKE ? OR originAttributes LIKE ?")
        parameters += (uid, uid + "&%")
    }

    if (domain) {
        if (domain.startsWith(".")) {
            conditions.push("host == ? OR host LIKE ?");
            parameters.push(domain.slice(1), "%" + domain);
        } else {
            conditions.push("host == ? OR host == ?");
            parameters.push(domain, "." + domain);
        }
    }

    if(conditions) {
        sql = `${sql} WHERE ( ${conditions.join(' ) AND ( ')} )`;
    }

    let db;
    let cookies = [];
    const dbc = new DatabaseConnection(path);
    try {
        db = await dbc.connect();
        const query = db.prepare(sql);
        const rows = query.all(parameters);

        cookies = rows.map(r => ({
            name: r.name,
            value: r.value,
            host: r.host,
            path: r.path,
            expiry: r.expiry,
            isSecure: Boolean(r.isSecure),
            isHttpOnly: Boolean(r.isHttpOnly),
        }));
    } finally {
        if (dbc) dbc.close();
    }
    infoLog(`Extracted ${cookies.length} cookies from ${browser_name.toUpperCase()}`)
    return cookies
}

async function loadCookiesWebkit(browserName, profile = null, domain = null) {
    let data;
    if (browserName === "safari") {
        const fp = await _safari_cookies_database();
        data = await fs.readFile(fp);
    } else if (browserName === "orion") {
        const fp = await _orion_cookies_database();
        data = await fs.readFile(fp);
    } else {
        throw new Error(`unknown webkit browser '${browserName}'`);
    }

    const { pageSizes, bodyStart } = _webkit_parse_cookies_header(data);
    const p = new DataParser(data.subarray(bodyStart));
    const cookies = [];
    for (const pageSize of pageSizes) {
        _webkit_parse_cookies_page(p.readBytes(pageSize), cookies);
    }
    console.info(`Extracted ${cookies.length} cookies from ${browserName.charAt(0).toUpperCase() + browserName.slice(1)}`);
    return cookies;
}

async function loadCookiesChromium(browser_name, profile=null, keyring=null, domain=null) {
    const config = _chromium_browser_settings(browser_name)
    const path = _chromium_cookies_database(profile, config)
    debugLog(`Extracting cookies from ${path}`)

    let condition = "";
    let parameters = []

    if(domain) {
        if (domain.startsWith(".")) {
            condition = " WHERE host_key == ? OR host_key LIKE ?"
            parameters.push(domain.slice(1), "%" + domain)
        } else {
            condition = " WHERE host_key == ? OR host_key == ?"
            parameters.push(domain, "." + domain)
        }
    } else {
        condition = ""
        parameters = []
    }
    return new Promise(async (resolve, reject) => {
        let db;
        const dbc = new DatabaseConnection(path);
        try {
            db = await dbc.connect();

            let meta_version = 0;
            const stmt = db.prepare("SELECT value FROM meta WHERE key = 'version'");

            const row = stmt.get();

            if (row && row.value) {
                meta_version = parseInt(row.value);
            } else {
                warnLog("Failed to get cookie database meta version (no rows returned)");
            }

            try {
                const query = `
                    SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly FROM cookies ${condition}`;
                const rows = db.prepare(query).all(parameters);

                processResults(rows, meta_version, config, keyring, resolve, reject);
            } catch (err) {
                const fallbackQuery = `
                    SELECT host_key, name, value, encrypted_value, path, expires_utc, secure 
                    FROM cookies ${condition}
                `;
                try {
                    const rows = db.prepare(fallbackQuery).all(parameters);
                    processResults(rows, meta_version, config, keyring, resolve, reject);
                } catch (fallbackErr) {
                    return reject(fallbackErr);
                }
            }

            function processResults(rows, meta_version, config, keyring, resolve, reject) {
                let failed_cookies = 0;
                let unencrypted_cookies = 0;
                const decryptor = _chromium_cookie_decryptor(config.directory, config.keyring, keyring, meta_version);
                const cookies = [];

                rows.forEach(row => {
                    let { host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly } = row;
                    if (!value && encrypted_value) {
                        value = decryptor.decrypt(encrypted_value);
                        if (value === null) {
                            failed_cookies++;
                            return;
                        }
                    } else {
                        value = value ? value.toString() : "";
                        unencrypted_cookies++;
                    }

                    let expires = null;
                    if (expires_utc) {
                        expires = Math.floor(expires_utc / 1000000) - 11644473600;
                    }

                    host_key = host_key ? host_key.toString() : "";
                    path = path ? path.toString() : "";
                    name = name ? name.toString() : "";
                    is_secure = is_secure !== undefined ? is_secure : false;

                    cookies.push({
                        name: name,
                        value: value,
                        host: host_key,
                        path: path,
                        expiry: expires,
                        isSecure: Boolean(is_secure),
                        isHttpOnly: Boolean(is_httponly),
                    });
                });

                const failed_message = failed_cookies > 0 ? ` (${failed_cookies} could not be decrypted)` : "";
                infoLog(`Extracted ${cookies.length} cookies from ${config.browser_name.capitalize()}${failed_message}`);
                const counts = decryptor.cookie_counts;
                counts.unencrypted = unencrypted_cookies;
                debugLog("version breakdown: ", counts);

                resolve(cookies);
            }
        } catch (err) {
            reject(err);
        } finally {
            // Fermer la connexion dans tous les cas
            if (dbc) {
                dbc.close();
            }
        }
    });
}

async function _firefox_cookies_database(browserName, profile = null, container = null) {
    let searchRoot;
    if (!profile) {
        searchRoot = _firefox_browser_directory(browserName);
    } else if (_is_path(profile)) {
        searchRoot = profile;
    } else {
        searchRoot = path.join(_firefox_browser_directory(browserName), profile);
    }

    const cookiePath = await _find_most_recently_used_file(searchRoot, "cookies.sqlite");
    if (!cookiePath) {
        throw new Error(`Unable to find ${browserName.charAt(0).toUpperCase() + browserName.slice(1)} cookies database in ${searchRoot}`);
    }

    debugLog(`Extracting cookies from ${cookiePath}`);
    let containerId = null;

    if (!container || container === "none") {
        containerId = false;
        debugLog("Only loading cookies not belonging to any container");
    } else if (container === "all") {
        containerId = null;
    } else {
        const containersPath = path.join(path.dirname(cookiePath), "containers.json");
        try {
            const data = await fs.readFile(containersPath, 'utf-8');
            const { identities } = JSON.parse(data);
            let found = false;
            for (const context of identities) {
                if (
                    container === context.name ||
                    (context.l10nID && context.l10nID.includes(`userContext${container}.label`))
                ) {
                    containerId = context.userContextId;
                    found = true;
                    break;
                }
            }
            if (!found) {
                throw new Error(`Unable to find Firefox container '${container}'`);
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                errorLog(`Unable to read Firefox container database at '${containersPath}'`);
            }
            throw err;
        }
        debugLog(`Only loading cookies from container '${container}' (ID ${containerId})`);
    }

    return [ cookiePath, containerId ];
}

function _firefox_browser_directory(browser_name) {
    const join = path.join;
    const platform = os.platform();

    if (platform == "win32" || platform == "cygwin") {
        const appdata = process.env.APPDATA;
        return {
            "firefox"  : join(appdata, "Mozilla", "Firefox", "Profiles"),
            "librewolf": join(appdata, "librewolf", "Profiles"),
            "zen"      : join(appdata, "zen", "Profiles"),
        }[browser_name]
    } else if (platform == "darwin") {
        const appdata = expanduser("~/Library/Application Support")
        return {
            "firefox"  : join(appdata, "Firefox", "Profiles"),
            "librewolf": join(appdata, "librewolf", "Profiles"),
            "zen"      : join(appdata, "zen", "Profiles"),
        }[browser_name]
    } else {
        const home = expanduser("~")
        return {
            "firefox"  : join(home, ".mozilla", "firefox"),
            "librewolf": join(home, ".librewolf"),
            "zen"      : join(home, ".zen"),
        }[browser_name]
    }
}

/* --------------------------------------------------------------------
// safari/orion/webkit
*/

function _safari_cookies_database() {
    try {
        const path = expanduser("~/Library/Cookies/Cookies.binarycookies")
        const fd = fs.openSync(path, 'r');
        const buffer = Buffer.alloc(1024);

        fs.readSync(fd, buffer, 0, buffer.length, null);
        fs.closeSync(fd);
        return buffer;
    } catch (err) {
        debugLog("Trying secondary cookie location")
        const path = expanduser("~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies")
        const fd = fs.openSync(path, 'r');
        const buffer = Buffer.alloc(1024);

        fs.readSync(fd, buffer, 0, buffer.length, null);
        fs.closeSync(fd);
        return buffer;
    }
}

function _orion_cookies_database() {
    const path = expanduser("~/Library/HTTPStorages/com.kagi.kagimacOS.binarycookies")
    const fd = fs.openSync(path, 'r');
    const buffer = Buffer.alloc(1024);

    fs.readSync(fd, buffer, 0, buffer.length, null);
    fs.closeSync(fd);
    return buffer;
}

function _webkit_parse_cookies_header(data) {
    const p = new DataParser(data);
    p.expectBytes(Buffer.from("cook"), "database signature");
    const numberOfPages = p.readUint(true); // true = bigEndian
    const pageSizes = [];
    for (let i = 0; i < numberOfPages; i++) {
        pageSizes.push(p.readUint(true));
    }
    return { pageSizes, bodyStart: p.cursor };
}

function _webkit_parse_cookies_page(data, cookies, domain=null) {
    const p = DataParser(data)
    p.expect_bytes(Buffer.from("\x00\x00\x01\x00"), "page signature")
    const number_of_cookies = p.read_uint()
    const record_offsets = []
    for (let i = 0; i < number_of_cookies; i++) {
        record_offsets.push(p.read_uint());
    }
    if (number_of_cookies == 0) {
        debugLog("Cookies page of size %s has no cookies", data.length)
        return
    }
        
    p.skip_to(record_offsets[0], "unknown page header field")

    for(let i = 0; i < record_offsets.length; i++) {
        const record_offset = record_offsets[i];
        p.skip_to(record_offset, "space between records")
        const record_length = _webkit_parse_cookies_record(data.slice(record_offset), cookies, domain)
        p.read_bytes(record_length)
    }
    p.skip_to_end("space in between pages")
}


function _webkit_parse_cookies_record(data, cookies, host=null) {
    const p = DataParser(data)
    const record_size = p.read_uint()
    p.skip(4, "unknown record field 1")
    const flags = p.read_uint()
    const is_secure = (flags & 0x0001) ? true : false;
    p.skip(4, "unknown record field 2")
    const domain_offset = p.read_uint()
    const name_offset = p.read_uint()
    const path_offset = p.read_uint()
    const value_offset = p.read_uint()
    p.skip(8, "unknown record field 3")
    const expiration_date = _mac_absolute_time_to_posix(p.read_double())
    const _creation_date = _mac_absolute_time_to_posix(p.read_double())
    let name = "";
    let path = "";
    let value = "";
    let domain = "";

    try {
        p.skip_to(domain_offset)
        domain = p.read_cstring()

        if(host) {
            if (host.startsWith(".")){
                if (host.slice(1) != domain && !domain.endsWith(host)) {
                    return record_size
                }
            } else {
                if (host != domain && ("." + host) != domain) {
                    return record_size
                }
            }
        }

        p.skip_to(name_offset)
        name = p.read_cstring()

        p.skip_to(path_offset)
        path = p.read_cstring()

        p.skip_to(value_offset)
        value = p.read_cstring()
    } catch (err) {
        warnLog("Failed to parse WebKit cookie")
        return record_size
    }

    p.skip_to(record_size, "space at the end of the record")

    cookies.push({
        id: 0,
        name: name,
        value: value,
        httpOnly: false,
        secure: is_secure,
        domain: domain,
        hostOnly: !domain,
        session: !expiration_date,
        path: path || "/",
        sameSite: "lax",
        expiry: expiration_date,
    });

    return record_size
}

/* --------------------------------------------------------------------
# chromium
*/

function _chromium_cookies_database(profile, config) {
    let search_root;
    if (!profile) {
        search_root = config["directory"]
    } else if (_is_path(profile)) {
        search_root = profile
        config["directory"] = config["profiles"] ? path.dirname(profile) : profile;
    } else if(config["profiles"]) {
        search_root = path.join(config["directory"], profile)
    } else {
        warnLog(`${config["browser"]} does not support profiles`)
        search_root = config["directory"]
    }
    const path = _find_most_recently_used_file(search_root, "Cookies")
    if (!path) {
        throw Error(`Unable to find ${config['browser']} cookies database in '${search_root}'`)
    }
    return path
}

function _chromium_browser_settings(browser_name) {
    const join = path.join;
    const platform = os.platform();

    let browser_dir;

    if (platform == "win32" || platform == "cygwin") {
        const appdata_local = process.env.LOCALAPPDATA;
        const appdata_roaming = process.env.APPDATA;
        browser_dir = {
            "brave"   : join(appdata_local,"BraveSoftware", "Brave-Browser", "User Data"),
            "chrome"  : join(appdata_local, "Google", "Chrome", "User Data"),
            "chromium": join(appdata_local, "Chromium" , "User Data"),
            "edge"    : join(appdata_local, "Microsoft", "Edge", "User Data"),
            "opera"   : join(appdata_roaming, "Opera Software" , "Opera Stable"),
            "thorium" : join(appdata_local, "Thorium", "User Data"),
            "vivaldi" : join(appdata_local, "Vivaldi", "User Data"),
        }[browser_name]
    }
    else if(platform == "darwin") {
        const appdata = expanduser("~/Library/Application Support")
        browser_dir = {
            "brave"   : join(appdata, "BraveSoftware/Brave-Browser"),
            "chrome"  : join(appdata, "Google/Chrome"),
            "chromium": join(appdata, "Chromium"),
            "edge"    : join(appdata, "Microsoft Edge"),
            "opera"   : join(appdata, "com.operasoftware.Opera"),
            "thorium" : join(appdata, "Thorium"),
            "vivaldi" : join(appdata, "Vivaldi"),
        }[browser_name]
    } else {
        const config = (process.env.get("XDG_CONFIG_HOME") || expanduser("~/.config"))
        browser_dir = {
            "brave"   : join(config, "BraveSoftware/Brave-Browser"),
            "chrome"  : join(config, "google-chrome"),
            "chromium": join(config, "chromium"),
            "edge"    : join(config, "microsoft-edge"),
            "opera"   : join(config, "opera"),
            "thorium" : join(config, "Thorium"),
            "vivaldi" : join(config, "vivaldi"),
        }[browser_name]
    }
    const keyring_name = {
        "brave"   : "Brave",
        "chrome"  : "Chrome",
        "chromium": "Chromium",
        "edge"    : platform == "darwin" ? "Microsoft Edge" : "Chromium",
        "opera"   : platform == "darwin" ? "Opera" : "Chromium",
        "thorium" : "Thorium",
        "vivaldi" : platform == "darwin" ? "Vivaldi" : "Chrome",
    }[browser_name]

    const browsers_without_profiles = ["opera"]

    return {
        "browser"  : browser_name,
        "directory": browser_dir,
        "keyring"  : keyring_name,
        "profiles" : !browsers_without_profiles.includes(browser_name),
    }
}

function _chromium_cookie_decryptor(browser_root, browser_keyring_name, keyring=null, meta_version=0) {
    if (os.platform() == "win32" || os.platform() == "cygwin") {
        return new WindowsChromiumCookieDecryptor(browser_root, meta_version)
    } else if(os.platform() == "darwin") {
        return new MacChromiumCookieDecryptor(browser_keyring_name, meta_version)
    } else {
        return new LinuxChromiumCookieDecryptor(browser_keyring_name, keyring, meta_version)
    }
}

class ChromiumCookieDecryptor {
    decrypt(encrypted_value) {
        throw Error("Must be implemented by sub classes")
    }

    cookie_counts() {
        throw Error("Must be implemented by sub classes")
    }
}

class LinuxChromiumCookieDecryptor extends ChromiumCookieDecryptor {
    constructor(browser_keyring_name, keyring=null, meta_version=0) {
        super();
        const password = _get_linux_keyring_password(browser_keyring_name, keyring);
        this._empty_key = this.derive_key(Buffer.from(""));
        this._v10_key = this.derive_key(Buffer.from("peanuts"));
        this._v11_key = password === null ? null : this.derive_key(password);
        this._cookie_counts = { "v10": 0, "v11": 0, "other": 0 };
        this._offset = (meta_version >= 24) ? 32 : 0;
    }

    derive_key(password) {
        return crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
    }

    cookie_counts() {
        return this._cookie_counts;
    }

    decrypt(encrypted_value) {
        const version = encrypted_value.slice(0, 3);
        const ciphertext = encrypted_value.slice(3);

        let value = null;

        if (version.equals(Buffer.from("v10"))) {
            this._cookie_counts["v10"] += 1;
            value = _decrypt_aes_cbc(ciphertext, this._v10_key, this._offset);
        } else if (version.equals(Buffer.from("v11"))) {
            this._cookie_counts["v11"] += 1;
            if (this._v11_key === null) {
                warnLog("Unable to decrypt v11 cookies: no key found");
                return null;
            }
            value = _decrypt_aes_cbc(ciphertext, this._v11_key, this._offset);
        } else {
            this._cookie_counts["other"] += 1;
            return null;
        }

        if (value === null) {
            value = _decrypt_aes_cbc(ciphertext, this._empty_key, this._offset);
            if (value === null) {
                warnLog("Failed to decrypt cookie (AES-CBC)");
            }
        }
        return value;
    }
}

class MacChromiumCookieDecryptor extends ChromiumCookieDecryptor {
    constructor(browser_keyring_name, meta_version=0) {
        super();
        const password = _get_mac_keyring_password(browser_keyring_name);
        this._v10_key = password === null ? null : this.derive_key(password);
        this._cookie_counts = { "v10": 0, "other": 0 };
        this._offset = (meta_version >= 24) ? 32 : 0;
    }

    derive_key(password) {
        return crypto.pbkdf2Sync(password, "saltysalt",
                           1003, 16)
    }

    cookie_counts() {
        return this._cookie_counts;
    }

    decrypt(encrypted_value) {
        const version = encrypted_value.slice(0, 3);
        const ciphertext = encrypted_value.slice(3);

        if (version.equals(Buffer.from("v10"))) {
            this._cookie_counts["v10"] += 1;
            if (this._v10_key === null) {
                warnLog("Unable to decrypt v10 cookies: no key found");
                return null;
            }
            return _decrypt_aes_cbc(ciphertext, this._v10_key, this._offset);
        } else {
            this._cookie_counts["other"] += 1;
            return encrypted_value;
        }
    }
}

class WindowsChromiumCookieDecryptor extends ChromiumCookieDecryptor {
    constructor(browser_root, meta_version=0) {
        super();
        this._v10_key = _get_windows_v10_key(browser_root);
        this._cookie_counts = { "v10": 0, "other": 0 };
        this._offset = (meta_version >= 24) ? 32 : 0;
    }

    cookie_counts() {
        return this._cookie_counts;
    }

    decrypt(encrypted_value) {
        const version = encrypted_value.slice(0, 3);
        let ciphertext = encrypted_value.slice(3);

        if (version.equals(Buffer.from("v10"))) {
            this._cookie_counts["v10"] += 1;
            if (this._v10_key === null) {
                warnLog("Unable to decrypt v10 cookies: no key found");
                return null;
            }
            const nonce_length = 96 / 8;
            const authentication_tag_length = 16;
            const raw_ciphertext = ciphertext;
            const nonce = raw_ciphertext.slice(0, nonce_length);
            ciphertext = raw_ciphertext.slice(nonce_length, raw_ciphertext.length - authentication_tag_length);
            const authentication_tag = raw_ciphertext.slice(-authentication_tag_length);

            return _decrypt_aes_gcm(ciphertext, this._v10_key, nonce, authentication_tag, this._offset);
        } else {
            this._cookie_counts["other"] += 1;
            return _decrypt_windows_dpapi(encrypted_value).toString();
        }
    }
}

/* --------------------------------------------------------------------
# keyring
*/

function _choose_linux_keyring() {
    const desktop_environment = _get_linux_desktop_environment(process.env)
    debugLog(`Detected desktop environment: ${desktop_environment}`)
    if (desktop_environment == DE_KDE) return KEYRING_KWALLET
    if (desktop_environment == DE_OTHER) return KEYRING_BASICTEXT
    return KEYRING_GNOMEKEYRING
}

function _get_kwallet_network_wallet() {
    const default_wallet = "kdewallet"
    try {
        const stdout = execSync("dbus-send --session --print-reply=literal --dest=org.kde.kwalletd5 /modules/kwalletd5 org.kde.KWallet.networkWallet", { encoding: 'utf-8' });
        const networkWallet = stdout.trim();
        debugLog(`NetworkWallet = '${networkWallet}'`);
        return networkWallet;
    } catch (err) {
        warnLog(`Error while obtaining NetworkWallet (${err.constructor.name}: ${err})`)
        return default_wallet
    }
}

function _get_kwallet_password(browser_keyring_name) {
    debugLog("Using kwallet-query to obtain password from kwallet")
    try {
        whichSync("kwallet-query");
    } catch (err) {
        errorLog(
            "kwallet-query command not found. KWallet and kwallet-query "
            + "must be installed to read from KWallet. kwallet-query should be "
            + "included in the kwallet package for your distribution"
        );
        return Buffer.from("");
    }

    const network_wallet = _get_kwallet_network_wallet();
    try {
        const stdout = execSync(
            `kwallet-query --read-password "${browser_keyring_name} Safe Storage" --folder "${browser_keyring_name} Keys" "${network_wallet}"`,
            { encoding: 'buffer' }
        );

        if (stdout.toString().toLowerCase().startsWith("failed to read")) {
            debugLog("Failed to read password from kwallet. Using empty string instead");
            return Buffer.from("");
        } else {
            if (stdout[stdout.length - 1] === 0x0A) {
                return stdout.slice(0, -1);
            }
            return stdout;
        }
    } catch (err) {
        if (err.status !== undefined) {
            errorLog(`kwallet-query failed with return code ${err.status}. Please consult the kwallet-query man page for details`);
        } else {
            warnLog(`Error when running kwallet-query (${err.name}: ${err.message})`);
        }
        return Buffer.from("");
    }
}

function _get_gnome_keyring_password(browser_keyring_name) {
    const label = `${browser_keyring_name} Safe Storage`;
    try {
        const cmd = `secret-tool search label "${label}"`;
        const result = execSync(cmd, { encoding: 'utf-8' }).trim();

        if (!result) {
            errorLog(`Failed to read from GNOME keyring (label "${label}")`);
            return Buffer.from("");
        }

        const secretCmd = `secret-tool lookup label "${label}"`;
        const secret = execSync(secretCmd, { encoding: 'utf-8' }).trim();

        if (!secret) {
            errorLog(`No secret found for label "${label}"`);
            return Buffer.from("");
        }

        return Buffer.from(secret);
    } catch (err) {
        if (err.code === "ENOENT") {
            errorLog("'secret-tool' not available — install with 'sudo apt install libsecret-tools'");
        } else {
            errorLog("Error accessing GNOME Keyring:", err.message);
        }
        return Buffer.from("");
    }
}

function _get_linux_keyring_password(browser_keyring_name, keyring) {
    if (!keyring) {
        keyring = _choose_linux_keyring();
    }
    debugLog(`Chosen keyring: ${keyring}`);

    if (keyring == KEYRING_KWALLET) {
        return _get_kwallet_password(browser_keyring_name);
    } else if (keyring == KEYRING_GNOMEKEYRING) {
        return _get_gnome_keyring_password(browser_keyring_name);
    } else if (keyring == KEYRING_BASICTEXT) {
        return null;
    }
    throw Error("Unknown keyring " + keyring);
}

function _get_mac_keyring_password(browser_keyring_name) {
    debugLog("Using find-generic-password to obtain password from OSX keychain");
    try {
        const stdout = execSync("security find-generic-password -w -a " + browser_keyring_name + " -s " + browser_keyring_name + " Safe Storage", { encoding: 'buffer' });

        if (stdout[stdout.length - 1] === 0x0A) {
            stdout.slice(0, -1);
        }
        return stdout;
    } catch (err) {
        warnLog(`Error when using find-generic-password (${err.constructor.name}: ${err})`);
        return null;
    }
}

function _get_windows_v10_key(browser_root) {
    const path = _find_most_recently_used_file(browser_root, "Local State")
    if (path === null) {
        errorLog("Unable to find Local State file");
        return null;
    }
    debugLog(`Found Local State file at '${path}'`);
    const data = JSON.parse(fs.readFileSync(path, { encoding: "utf-8" }));
    let base64_key;
    try {
        base64_key = data["os_crypt"]["encrypted_key"];
    } catch (err) {
        errorLog("Unable to find encrypted key in Local State");
        return null;
    }
    const encrypted_key = Buffer.from(base64_key, 'base64');
    const prefix = Buffer.from("DPAPI");
    if (!encrypted_key.slice(0, prefix.length).equals(prefix)) {
        errorLog("Invalid Local State key");
        return null;
    }
    return _decrypt_windows_dpapi(encrypted_key.slice(prefix.length));
}

/* --------------------------------------------------------------------
# utility
*/

class ParserError extends Error {
    constructor(message) {
        super(message);
        this.name = "ParserError";
    }
}

class DataParser {
    constructor(data) {
        this.cursor = 0;
        this._data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    }

    read_bytes(num_bytes) {
        if (num_bytes < 0) {
            throw new ParserError(`invalid read of ${num_bytes} bytes`);
        }
        const end = this.cursor + num_bytes;
        if (end > this._data.length) {
            throw new ParserError("reached end of input");
        }
        const data = this._data.subarray(this.cursor, end);
        this.cursor = end;
        return data;
    }

    expect_bytes(expected_value, message) {
        const value = this.read_bytes(expected_value.length);
        if (!value.equals(expected_value)) {
            throw new ParserError(`unexpected value: ${value} != ${expected_value} (${message})`);
        }
    }

    read_uint(big_endian = false) {
        const data = this.read_bytes(4);
        return big_endian ? data.readUInt32BE(0) : data.readUInt32LE(0);
    }

    read_double(big_endian = false) {
        const data = this.read_bytes(8);
        return big_endian ? data.readDoubleBE(0) : data.readDoubleLE(0);
    }

    read_cstring() {
        const buffer = [];
        while (true) {
            const c = this.read_bytes(1);
            if (c[0] === 0x00) {
                return Buffer.concat(buffer).toString('utf8');
            } else {
                buffer.push(c);
            }
        }
    }

    skip(num_bytes, description = "unknown") {
        if (num_bytes > 0) {
            debugLog(`Skipping ${num_bytes} bytes (${description}): ${this.read_bytes(num_bytes)}`);
        } else if (num_bytes < 0) {
            throw new ParserError(`Invalid skip of ${num_bytes} bytes`);
        }
    }

    skip_to(offset, description = "unknown") {
        this.skip(offset - this.cursor, description);
    }

    skip_to_end(description = "unknown") {
        this.skip_to(this._data.length, description);
    }
}

function _get_linux_desktop_environment(env) {
    let xdg_current_desktop = env["XDG_CURRENT_DESKTOP"];
    const desktop_session = env["DESKTOP_SESSION"];

    if (xdg_current_desktop) {
        xdg_current_desktop = xdg_current_desktop.split(":")[0].trim().toLowerCase();

        if (xdg_current_desktop == "unity") {
            if (desktop_session && desktop_session.includes("gnome-fallback")) {
                return DE_GNOME;
            } else {
                return DE_UNITY;
            }
        } else if (xdg_current_desktop == "gnome") {
            return DE_GNOME;
        } else if (xdg_current_desktop == "x-cinnamon") {
            return DE_CINNAMON;
        } else if (xdg_current_desktop == "kde") {
            return DE_KDE;
        } else if (xdg_current_desktop == "pantheon") {
            return DE_PANTHEON;
        } else if (xdg_current_desktop == "xfce") {
            return DE_XFCE;
        }
    }

    if (desktop_session) {
        if (desktop_session == "mate" || desktop_session == "gnome") {
            return DE_GNOME;
        }
        if (desktop_session.includes("kde")) {
            return DE_KDE;
        }
        if (desktop_session.includes("xfce")) {
            return DE_XFCE;
        }
    }

    if ("GNOME_DESKTOP_SESSION_ID" in env) {
        return DE_GNOME;
    }
    if ("KDE_FULL_SESSION" in env) {
        return DE_KDE;
    }
    return DE_OTHER;
}

function _mac_absolute_time_to_posix(timestamp) {
    return 978307200 + parseInt(timestamp)
}

function _decrypt_aes_cbc(ciphertext, key, offset=0, initialization_vector=Buffer.from(" ") .repeat(16)) {
    try {
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, initialization_vector);
        let plaintext = decipher.udpate(ciphertext);
        plaintext = Buffer.concat([plaintext, decipher.final()]);
        const padLength = plaintext[plaintext.length - 1];
        plaintext = plaintext.subarray(0, plaintext.length - padLength);
        if (offset > 0) {
            plaintext = plaintext.subarray(offset);
        }
        return plaintext.toString('utf8');
    } catch (err) {
        return null
    }
}

function _decrypt_aes_gcm(ciphertext, key, nonce, authentication_tag, offset = 0) {
    try {
        const decipher = crypto.createDecipheriv('aes-128-gcm', key, {
            iv: nonce,
            authTagLength: authentication_tag.length
        });
        decipher.setAuthTag(authentication_tag);
        let plaintext = decipher.update(ciphertext);
        plaintext = Buffer.concat([plaintext, decipher.final()]);
        if (offset > 0) {
            plaintext = plaintext.subarray(offset);
        }
        return plaintext.toString('utf8');
    } catch (e) {
        if (e.message.includes('auth tag')) {
            warnLog("Failed to decrypt cookie (AES-GCM MAC)");
        } else {
            warnLog("Failed to decrypt cookie (AES-GCM Unicode)");
        }
        return null;
    }
}

function _find_most_recently_used_file(root, filename) {
    const first_choice = path.join(root, filename);
    if (fs.existsSync(first_choice)) {
        return first_choice;
    }

    let paths = [];
    function walk(curr_root) {
        const entries = fs.readdirSync(curr_root, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(curr_root, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && entry.name === filename) {
                paths.push(fullPath);
            }
        }
    }
    walk(root);

    if (paths.length === 0) {
        return null;
    }

    return paths.reduce((prev, current) =>
        fs.statSync(prev).mtimeMs > fs.statSync(current).mtimeMs ? prev : current
    );
}

function _is_path(value) {
    return path.sep === '\\'
        ? value.includes(path.sep)
        : value.includes(path.sep) || value.startsWith('./') || value.startsWith('../');
}

function _parse_browser_specification(browser, profile = null, keyring = null, container = null, domain = null) {
    browser = browser.toLowerCase();
    if (!SUPPORTED_BROWSERS.has(browser)) {
        throw new Error(`Unsupported browser '${browser}'`);
    }
    if (keyring && !SUPPORTED_KEYRINGS.has(keyring)) {
        throw new Error(`Unsupported keyring '${keyring}'`);
    }
    if (profile && _is_path(profile)) {
        profile = path.resolve(profile);
    }
    return [ browser, profile, keyring, container, domain ];
}

function _decrypt_windows_dpapi(ciphertext) {
    try {
        const { Dpapi } = require('@primno/dpapi')
        return Dpapi.unprotectData(ciphertext, null, 'CurrentUser');
    } catch (err) {
        errorLog("Failed to decrypt cookie (DPAPI):", err.message);
        return null;
    }
}

module.exports = { SUPPORTED_BROWSERS, loadCookies }