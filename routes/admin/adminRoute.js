const express = require("express");
const router = express.Router();

const { adminSessionConfig } = require("../../config/session");

const { setAdminLocals } = require("../../middlewares/sessionLocals");

// Own session cookie for the admin side (velora.admin.sid) — see
// userRoute.js for the matching setup on that side.
router.use(adminSessionConfig);
router.use(setAdminLocals);

const adminController = require("../../controllers/admin/adminController");
const categoryController = require("../../controllers/admin/categoryController");
const productController = require("../../controllers/admin/productController");
const { adminAuth, isAdminGuest } = require("../../middlewares/authMiddleware");
const { handleProductImageUpload, resizeAndSaveProductImages } = require("../../middlewares/uploadProductImages");

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


router.get("/products", adminAuth, productController.loadProducts);
router.get("/products/add", adminAuth, productController.loadAddProduct);
router.post("/products/add", adminAuth, handleProductImageUpload, resizeAndSaveProductImages, productController.addProductController);
router.get("/products/:productId/edit", adminAuth, productController.loadEditProduct);
router.post("/products/:productId/edit", adminAuth, handleProductImageUpload, resizeAndSaveProductImages, productController.updateProductController);
router.post("/products/:productId/toggle-status", adminAuth, productController.toggleProductStatusController);
router.post("/products/:productId/delete", adminAuth, productController.deleteProductController);

module.exports = router;
