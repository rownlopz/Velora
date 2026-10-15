const express = require("express");
const router = express.Router();

const { adminSessionConfig } = require("../../config/session");

const { setAdminLocals } = require("../../middlewares/sessionLocals");

router.use(adminSessionConfig);
router.use(setAdminLocals);

const adminController = require("../../controllers/admin/adminController");
const categoryController = require("../../controllers/admin/categoryController");
const productController = require("../../controllers/admin/productController");
const orderController = require("../../controllers/admin/orderController");
const inventoryController = require("../../controllers/admin/inventoryController");
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

// Order Management Routes
router.get("/orders", adminAuth, orderController.loadOrders);
router.get("/orders/:orderId", adminAuth, orderController.loadOrderDetails);
router.post("/orders/:orderId/status", adminAuth, orderController.updateOrderStatusController);
router.post("/orders/:orderId/payment-status", adminAuth, orderController.updatePaymentStatusController);
router.post("/orders/:orderId/items/:itemId/status", adminAuth, orderController.updateOrderItemStatusController);
router.post("/orders/:orderId/items/:itemId/return-approve", adminAuth, orderController.approveReturnItemController);
router.post("/orders/:orderId/items/:itemId/return-reject", adminAuth, orderController.rejectReturnItemController);
router.post("/orders/:orderId/items/:itemId/restock", adminAuth, orderController.restockReturnItemController);

// Inventory / Stock Management Routes
router.get("/inventory", adminAuth, inventoryController.loadInventory);
router.post("/inventory/:variantId/update", adminAuth, inventoryController.updateStockController);
router.post("/inventory/:variantId/adjust", adminAuth, inventoryController.quickAdjustStockController);

module.exports = router;
