const express = require("express");
const router = express.Router();

const { adminSessionConfig } = require("../../config/session");

// Own session cookie for the admin side (velora.admin.sid) — see
// userRoute.js for the matching setup on that side.
router.use(adminSessionConfig);
router.use((req, res, next) => {
    res.locals.admin = req.session.adminId || null;
    next();
});

const adminController = require("../../controllers/admin/adminController");
const categoryController = require("../../controllers/admin/categoryController");
const productController = require("../../controllers/admin/productController");
const { adminAuth, isAdminGuest } = require("../../middlewares/authMiddleware");
const { uploadProductImages, resizeAndSaveProductImages } = require("../../middlewares/uploadProductImages");

router.get("/login", isAdminGuest, adminController.loadLogin);
router.post("/login", isAdminGuest, adminController.loginController);
router.get("/logout", adminController.logoutController);

router.get("/dashboard", adminAuth, adminController.loadDashboard);
router.post("/users/:userId/toggle-status", adminAuth, adminController.toggleUserStatusController);

router.get("/categories", adminAuth, categoryController.loadCategories);
router.post("/categories", adminAuth, categoryController.addCategoryController);
router.post("/categories/:categoryId/edit", adminAuth, categoryController.updateCategoryController);
router.post("/categories/:categoryId/toggle-status", adminAuth, categoryController.toggleCategoryStatusController);
router.post("/categories/:categoryId/delete", adminAuth, categoryController.deleteCategoryController);

// Catches multer errors (too many files, wrong type, oversized file)
// cleanly instead of letting them crash the request — same fix applied
// to avatar upload in Week 13.
const handleProductImageUpload = (req, res, next) => {
    uploadProductImages.array("images", 8)(req, res, (err) => {
        if (err) {
            const message = err.code === "LIMIT_FILE_SIZE" ? "Each image must be smaller than 5MB."
                : err.code === "LIMIT_FILE_COUNT" ? "You can upload up to 8 images."
                : (err.message || "Image upload failed. Please try again.");
            req.session.productUploadError = message;
            // Express 5 removed res.redirect("back") — fall back to the
            // Referer header manually, with a safe default if it's missing.
            return res.redirect(req.get("Referer") || "/admin/products");
        }
        next();
    });
};

router.get("/products", adminAuth, productController.loadProducts);
router.get("/products/add", adminAuth, productController.loadAddProduct);
router.post("/products/add", adminAuth, handleProductImageUpload, resizeAndSaveProductImages, productController.addProductController);
router.get("/products/:productId/edit", adminAuth, productController.loadEditProduct);
router.post("/products/:productId/edit", adminAuth, handleProductImageUpload, resizeAndSaveProductImages, productController.updateProductController);
router.post("/products/:productId/toggle-status", adminAuth, productController.toggleProductStatusController);
router.post("/products/:productId/delete", adminAuth, productController.deleteProductController);

module.exports = router;
