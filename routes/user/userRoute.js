const express = require("express");
const router = express.Router();

const userController = require("../../controllers/user/userController");
const { userAuth, isGuest } = require("../../middlewares/authMiddleware");

// Protected User Routes
router.get("/", userAuth, userController.loadHome);

// Guest Auth Routes
router.get("/signup", isGuest, userController.loadSignup);
router.post("/signup", isGuest, userController.signup);

router.get("/login", isGuest, userController.loadLogin);

router.get("/otp", userController.loadOtp);
router.post("/otp", userController.verifyOtp);
router.post("/resend-otp", userController.resendOtp);

router.get("/forgot-password", isGuest, userController.loadForgotPassword);

router.get("/reset-password", isGuest, userController.loadResetPassword);

module.exports = router;