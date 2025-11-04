function debugLog(message) {
    const { DEBUG } = require("./main.js");
    if (DEBUG) {
        console.log(message);
    }
}

module.exports = { debugLog };