const express = require("express");
const router = express.Router();

const userController = require("../../controllers/userController");

router.get("/", userController.loadHome);

router.get("/signup", userController.loadSignup);

router.get("/login", userController.loadLogin)

module.exports = router;