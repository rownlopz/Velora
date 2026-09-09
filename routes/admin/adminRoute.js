const express = require("express");
const router = express.Router();

const adminController = require("../../controllers/admin/adminController");
const { adminAuth, isAdminGuest } = require("../../middlewares/authMiddleware");

router.get("/login", isAdminGuest, adminController.loadLogin);
router.get("/dashboard", adminAuth, adminController.loadDashboard);
router.post("/users/:userId/toggle-status", adminAuth, adminController.toggleUserStatusController);

module.exports = router;