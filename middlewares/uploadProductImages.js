const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const PRODUCT_IMAGE_DIR = path.join(__dirname, "..", "public", "uploads", "products");

if (!fs.existsSync(PRODUCT_IMAGE_DIR)) {
    fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });
}

// Kept in sync with the accept attribute in the product form and with
// middlewares/upload.js (avatar uploads), so allowed formats are
// consistent across the whole app.
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per image (matches the Figma hint text)
const MAX_IMAGES = 8;

// Images are held in memory first (not written straight to disk) so
// sharp can resize them before the final file is ever saved. This is the
// server-side guarantee that every stored product image has a
// predictable, storage-friendly size — the client-side crop step is a
// UX convenience, not something the server trusts blindly.
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("Only JPG, PNG, GIF, or WEBP images are allowed"));
    }
};

const uploadProductImages = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_IMAGES },
});

/**
 * Resizes every buffered image in req.files down to a max of 1200x1600
 * (matches the Figma "Recommended size: 1200 x 1600px" note), converts
 * to JPEG for consistent, predictable storage, and writes each one to
 * disk. Adds `path` (the public URL) onto each file object so the
 * controller can read it the same way it reads req.file.filename for
 * avatars.
 */
const resizeAndSaveProductImages = async (req, res, next) => {
    try {
        if (!req.files || req.files.length === 0) {
            return next();
        }

        for (const file of req.files) {
            const filename = `product-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
            const outputPath = path.join(PRODUCT_IMAGE_DIR, filename);

            await sharp(file.buffer)
                .resize(1200, 1600, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toFile(outputPath);

            file.savedPath = `/uploads/products/${filename}`;
        }

        next();
    } catch (error) {
        next(error);
    }
};

module.exports = { uploadProductImages, resizeAndSaveProductImages };
