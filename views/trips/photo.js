// Turns a File from the camera or gallery into what gets uploaded: a JPEG at
// most 2048px on its long edge, plus what the file knew about where and when
// it was taken (read before the re-encode throws the EXIF away).
//
// One photo at a time, and every bitmap and canvas released as soon as it is
// drawn: iOS gives a page very little canvas memory, and a batch of 12MP
// decodes held at once is how a tab dies.

import { readExif, fitWithin, nextJpegQuality } from './logic.js';

const FIRST_QUALITY = 0.82;

export class PhotoError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * @param {File} file
 * @param {{maxBytes: number}} opts  the server's real upload limit
 * @returns {Promise<{blob: Blob, exif: object|null, width: number, height: number}>}
 */
export async function preparePhoto(file, { maxBytes }) {
    let exif = null;
    try {
        exif = readExif(await file.slice(0, 131072).arrayBuffer());
    } catch { /* unreadable header: no EXIF, carry on */ }

    const source = await decode(file);
    const { width, height } = fitWithin(source.width, source.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source.image, 0, 0, width, height);
    source.release();

    // Leave room for the multipart envelope around the file.
    const budget = Math.max(64 * 1024, maxBytes - 64 * 1024);
    let q = FIRST_QUALITY;
    let blob = await toJpeg(canvas, q);
    while (blob.size > budget) {
        q = nextJpegQuality(q);
        if (q === null) break;
        blob = await toJpeg(canvas, q);
    }
    canvas.width = 0;
    canvas.height = 0;
    if (blob.size > budget) {
        throw new PhotoError('too_large', 'This photo is too large to send even after shrinking it.');
    }
    return { blob, exif, width, height };
}

/**
 * Decode with the browser, which applies the EXIF orientation itself; turning
 * the pixels again by hand would rotate a portrait photo twice.
 */
async function decode(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
            return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
        } catch { /* fall through to <img>, which some formats only decode there */ }
    }
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        return { image: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch {
        URL.revokeObjectURL(url);
        throw new PhotoError('unreadable', 'This browser cannot open that photo. HEIC files from an iPhone open in Safari; elsewhere, share it as a JPEG.');
    }
}

function toJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new PhotoError('encode', 'Could not encode the photo.'))), 'image/jpeg', quality);
    });
}
