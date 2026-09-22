const multer = require("multer");
const path = require("path");
const fs = require("fs");

const AVATAR_DIR = path.join(__dirname, "..", "public", "uploads", "avatars");

// Defensive: empty directories are not reliably preserved by git/zip tools,
// so make sure this exists at startup rather than assuming it's on disk.
if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

// Kept in sync with the file input's `accept` attribute in profile-edit.ejs
// ("JPG, GIF or PNG") so the browser and the server never disagree about
// which formats are allowed.
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif"];
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif"];

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, AVATAR_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${req.session.userId}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`;
        cb(null, uniqueName);
    },
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const validExt = ALLOWED_EXTENSIONS.includes(ext);
    const validMime = ALLOWED_MIME_TYPES.includes(file.mimetype);

    if (validExt && validMime) {
        cb(null, true);
    } else {
        cb(new Error("Only JPG, PNG, or GIF images are allowed"));
    }
};

const uploadAvatar = multer({
    storage,
    fileFilter,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB, matches the "Max size of 2MB" text in the UI
});

module.exports = uploadAvatar;
