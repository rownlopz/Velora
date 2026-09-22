const multer = require("multer");
const sharp = require("sharp");
const cloudinary = require("../config/cloudinary");
const streamifier = require("streamifier");

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

const resizeAndSaveProductImages = async (req, res, next) => {
    try {
        if (!req.files || req.files.length === 0) {
            return next();
        }

        for (const file of req.files) {
            const buffer = await sharp(file.buffer)
                .resize(1200, 1600, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();

            const uploadPromise = new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: "velora/products",
                        public_id: `product-${Date.now()}-${Math.round(Math.random() * 1e9)}`
                    },
                    (error, result) => {
                        if (error) return reject(error);
                        resolve(result);
                    }
                );
                streamifier.createReadStream(buffer).pipe(stream);
            });

            const result = await uploadPromise;
            file.savedPath = result.secure_url;
        }

        next();
    } catch (error) {
        next(error);
    }
};

const handleProductImageUpload = (req, res, next) => {
    uploadProductImages.array("images", 8)(req, res, (err) => {
        if (err) {
            const message = err.code === "LIMIT_FILE_SIZE" ? "Each image must be smaller than 5MB."
                : err.code === "LIMIT_FILE_COUNT" ? "You can upload up to 8 images."
                : (err.message || "Image upload failed. Please try again.");
            req.session.productUploadError = message;
            return res.redirect(req.get("Referer") || "/admin/products");
        }
        next();
    });
};

module.exports = { uploadProductImages, handleProductImageUpload, resizeAndSaveProductImages };
