const express = require("express");
const router = express.Router();

const userController = require("../../controllers/user/userController");

router.get("/", userController.loadHome);

router.get("/signup", userController.loadSignup);

router.get("/login", userController.loadLogin)

router.get("/otp" , userController.loadOtp);

router.get("/forgot-password" , userController.loadForgotPassword);

router.get("/reset-password" , userController.loadResetPassword);

module.exports = router;