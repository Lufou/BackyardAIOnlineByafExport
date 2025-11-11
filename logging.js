function debugLog(message) {
    const { DEBUG } = require("./main.js");
    if (DEBUG) {
        console.debug("[DEBUG] " + message);
    }
}

function infoLog(message) {
    console.log("\x1b[0;34m[INFO] " + message + "\x1b[0m")
}

function errorLog(message) {
    console.error("\x1b[0;31m[ERROR] " + message + "\x1b[0m")
}

function warnLog(message) {
    console.warn("\x1b[0;33m[WARN] " + message + "\x1b[0m")
}

module.exports = { debugLog, infoLog, errorLog, warnLog };