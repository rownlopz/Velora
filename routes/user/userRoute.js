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
router.post("/login", isGuest, userController.login);

router.get("/otp", userController.loadOtp);
router.post("/otp", userController.verifyOtp);
router.post("/resend-otp", userController.resendOtp);

router.get("/forgot-password", isGuest, userController.loadForgotPassword);
router.post("/forgot-password", isGuest, userController.forgotPasswordController);

router.get("/reset-password", userController.loadResetPassword);
router.post("/reset-password", userController.resetPasswordController);

module.exports = router;