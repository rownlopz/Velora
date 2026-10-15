const express = require("express");
const router = express.Router();
const passport = require("passport");

const { userSessionConfig } = require("../../config/session");

const { setUserLocals } = require("../../middlewares/sessionLocals");

router.use(userSessionConfig);
router.use(setUserLocals);

// Clean up any accidentally quoted or encoded URLs (e.g. /%22/checkout%22 -> /checkout)
router.use((req, res, next) => {
    if (req.url.includes('%22') || req.url.includes('"')) {
        const cleanUrl = '/' + req.url.replace(/%22|"/g, '').replace(/^\/+/, '');
        return res.redirect(cleanUrl || '/');
    }
    next();
});

const userController = require("../../controllers/user/userController");
const profileController = require("../../controllers/user/profileController");
const addressController = require("../../controllers/user/addressController");
const googleAuthController = require("../../controllers/user/googleAuthController");

const { userAuth, isGuest } = require("../../middlewares/authMiddleware");
const { handleAvatarUpload } = require("../../middlewares/upload");

const productController = require("../../controllers/user/productController");
const cartController = require("../../controllers/user/cartController");
const wishlistController = require("../../controllers/user/wishlistController");
const orderController = require("../../controllers/user/orderController");

// Protected User Routes
router.get("/", userAuth, userController.loadHome);
router.get("/products", productController.loadProducts);
router.get("/products/:slug", productController.loadProductDetail);
router.get("/categories", productController.loadCategories);

router.get("/cart", userAuth, cartController.loadCart);
router.post("/cart/add", userAuth, cartController.addToCartController);
router.post("/cart/:variantId/increment", userAuth, cartController.incrementController);
router.post("/cart/:variantId/decrement", userAuth, cartController.decrementController);
router.post("/cart/:variantId/remove", userAuth, cartController.removeController);

// Checkout & Orders
router.get("/checkout", userAuth, orderController.loadCheckout);
router.get("/check-out", (req, res) => res.redirect("/checkout"));
router.get("/cart/checkout", (req, res) => res.redirect("/checkout"));
router.get(['/%22/checkout%22', '/"checkout"', '/"/checkout"'], (req, res) => res.redirect("/checkout"));
router.post("/checkout/place-order", userAuth, orderController.placeOrderController);

// Order Management Routes
router.get("/orders", userAuth, orderController.loadOrderList);
router.get("/orders/:orderId/success", userAuth, orderController.loadOrderSuccess);
router.get("/orders/:orderId/invoice", userAuth, orderController.downloadInvoiceController);
router.get("/orders/:orderId", userAuth, orderController.loadOrderDetails);

// Order & Item Cancellation
router.post("/orders/:orderId/cancel", userAuth, orderController.cancelOrderController);
router.post("/orders/:orderId/items/:itemId/cancel", userAuth, orderController.cancelOrderItemController);

// Order & Item Returns (delivered only)
router.post("/orders/:orderId/return", userAuth, orderController.returnOrderController);
router.post("/orders/:orderId/items/:itemId/return", userAuth, orderController.returnOrderItemController);

router.get("/wishlist", userAuth, wishlistController.loadWishlist);
router.post("/wishlist/add", userAuth, wishlistController.addToWishlistController);
router.post("/wishlist/:variantId/remove", userAuth, wishlistController.removeFromWishlistController);

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

router.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

// Google SSO
router.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));
router.get("/auth/google/callback", googleAuthController.googleCallback);

// Profile
router.get("/profile", userAuth, profileController.loadProfile);
router.get("/profile/edit", userAuth, profileController.loadEditProfile);
router.post("/profile/edit", userAuth, handleAvatarUpload, profileController.updateProfileController);

router.get("/profile/change-password", userAuth, profileController.loadChangePassword);
router.post("/profile/change-password", userAuth, profileController.changePasswordController);

router.get("/profile/change-email", userAuth, profileController.loadChangeEmail);
router.post("/profile/change-email", userAuth, profileController.requestEmailChangeController);
router.post("/profile/change-email/verify", userAuth, profileController.confirmEmailChangeController);
router.post("/profile/change-email/resend-otp", userAuth, profileController.resendEmailChangeOtpController);

// Address Management
router.get("/addresses", userAuth, addressController.loadAddresses);
router.get("/addresses/add", userAuth, addressController.loadAddAddress);
router.post("/addresses/add", userAuth, addressController.addAddressController);
router.get("/addresses/:addressId/edit", userAuth, addressController.loadEditAddress);
router.post("/addresses/:addressId/edit", userAuth, addressController.updateAddressController);
router.post("/addresses/:addressId/delete", userAuth, addressController.deleteAddressController);
router.post("/addresses/:addressId/set-default", userAuth, addressController.setDefaultAddressController);

module.exports = router;
