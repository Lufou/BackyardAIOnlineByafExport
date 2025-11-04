function debugLog(message, condition) {
    if (condition) {
        console.log(message);
    }
}

module.exports = { debugLog };