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

module.exports = { downloadImageAsFile, replaceStringSpecial };

