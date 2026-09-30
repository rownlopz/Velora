const multer = require("multer");
const path = require("path");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");


const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif"];
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif"];

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: "velora/avatars",
        allowed_formats: ["jpg", "jpeg", "png", "gif"],
        public_id: (req, file) => `${req.session.userId}-${Date.now()}`
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

const handleAvatarUpload = (req, res, next) => {
    uploadAvatar.single("avatar")(req, res, (err) => {
        if (err) {
            const message = err.code === "LIMIT_FILE_SIZE"
                ? "Image must be smaller than 2MB."
                : (err.message || "Image upload failed. Please try a different file.");
            return res.redirect(`/profile/edit?uploadError=${encodeURIComponent(message)}`);
        }
        next();
    });
};

module.exports = {
    uploadAvatar,
    handleAvatarUpload
};
