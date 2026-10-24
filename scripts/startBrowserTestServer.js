/**
 * scripts/startBrowserTestServer.js
 * Runs Express server against the isolated test database on port 3001
 * for end-to-end browser verification.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const express = require("express");
const mongoose = require("mongoose");
const passport = require("../config/passport");
const userRoute = require("../routes/user/userRoute");
const adminRoute = require("../routes/admin/adminRoute");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const User = require("../models/user/userModel");
const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Address = require("../models/user/addressModel");
const Cart = require("../models/order/cartModel");
const Wishlist = require("../models/user/wishlistModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const bcrypt = require("bcrypt");

async function seedData() {
    await mongoose.connection.dropDatabase();

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash("Password123!", salt);

    // Create user & admin
    const testUser = await User.create({
        fullName: "Test Customer",
        email: "shopper@velora.test",
        password: hash,
        phone: "9876543210",
        isBlocked: false,
    });

    const testAdmin = await User.create({
        fullName: "Admin Manager",
        email: "admin@velora.test",
        password: hash,
        role: "ADMIN",
        isBlocked: false,
    });

    const addr = await Address.create({
        userId: testUser._id,
        firstName: "Test",
        lastName: "Customer",
        addressLine1: "100 MG Road",
        city: "Bengaluru",
        state: "Karnataka",
        pinCode: "560001",
        country: "India",
        phone: "9876543210",
        isDefault: true,
    });

    // Categories & Products
    const cat = await Category.create({
        name: "Casual Wear",
        slug: "casual-wear",
        isActive: true,
        isDeleted: false,
    });

    // Product 1: Single Variant (direct add)
    const prod1 = await Product.create({
        name: "Classic Crew T-Shirt",
        slug: "classic-crew-tshirt",
        categoryId: cat._id,
        description: "100% premium combed cotton t-shirt.",
        images: ["https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=500"],
        status: "ACTIVE",
        isDeleted: false,
    });
    const vSingle = await Variant.create({
        productId: prod1._id,
        sku: "CCT-STD",
        size: "M",
        color: "Black",
        regularPrice: 799,
        salePrice: 699,
        stock: 25,
        isActive: true,
        images: ["https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=500"],
    });

    // Product 2: Multiple Variants (variant modal test)
    const prod2 = await Product.create({
        name: "Vintage Denim Jacket",
        slug: "vintage-denim-jacket",
        categoryId: cat._id,
        description: "Classic rugged denim jacket with washed texture.",
        images: ["https://images.unsplash.com/photo-1576995853123-5a10305d93c0?w=500"],
        status: "ACTIVE",
        isDeleted: false,
    });
    const vMulti1 = await Variant.create({
        productId: prod2._id,
        sku: "VDJ-MED-BLUE",
        size: "M",
        color: "Blue",
        regularPrice: 2499,
        salePrice: 1999,
        stock: 12,
        isActive: true,
        images: ["https://images.unsplash.com/photo-1576995853123-5a10305d93c0?w=500"],
    });
    const vMulti2 = await Variant.create({
        productId: prod2._id,
        sku: "VDJ-LRG-BLACK",
        size: "L",
        color: "Black",
        regularPrice: 2699,
        salePrice: 2199,
        stock: 8,
        isActive: true,
        images: ["https://images.unsplash.com/photo-1576995853123-5a10305d93c0?w=500"],
    });

    // Seed Wishlist with vMulti1
    await Wishlist.create({
        userId: testUser._id,
        items: [{ productId: prod2._id, variantId: vMulti1._id }],
    });

    // Seed Cart with 1 single variant
    await Cart.create({
        userId: testUser._id,
        items: [{ variantId: vSingle._id, quantity: 1, priceSnapshot: 699 }],
        checkoutToken: "chk_test_browser_token",
    });

    // Seed Orders with 5% tax
    // Merchandise: 1999, tax: 99.95 -> 100, total: 2099
    const completedOrder = await Order.create({
        orderNumber: "VEL-TEST-COMPLETED-101",
        orderId: "VEL-TEST-COMPLETED-101",
        userId: testUser._id,
        items: [{
            variantId: vMulti1._id,
            productId: prod2._id,
            productName: prod2.name,
            quantity: 1,
            regularPrice: 2499,
            unitPrice: 1999,
            priceAtPurchase: 1999,
            effectiveUnitPrice: 1999,
            allocatedTax: 100,
            allocatedCouponDiscount: 0,
            finalPayable: 2099,
            lineTotal: 1999,
            status: "PROCESSING",
        }],
        shippingAddress: addr.toObject(),
        pricing: {
            subtotal: 1999,
            shippingFee: 0,
            discount: 0,
            taxRate: 0.05,
            taxableAmount: 1999,
            taxAmount: 100,
            totalAmount: 2099,
            currentPayable: 2099,
        },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        razorpayOrderId: "order_rzp_browser_success",
        razorpayPaymentId: "pay_rzp_browser_success",
        paidAt: new Date(),
    });

    const failedOrder = await Order.create({
        orderNumber: "VEL-TEST-FAILED-102",
        orderId: "VEL-TEST-FAILED-102",
        userId: testUser._id,
        items: [{
            variantId: vSingle._id,
            productId: prod1._id,
            productName: prod1.name,
            quantity: 1,
            regularPrice: 799,
            unitPrice: 699,
            priceAtPurchase: 699,
            effectiveUnitPrice: 699,
            allocatedTax: 35,
            allocatedCouponDiscount: 0,
            finalPayable: 734,
            lineTotal: 699,
            status: "PENDING",
        }],
        shippingAddress: addr.toObject(),
        pricing: {
            subtotal: 699,
            shippingFee: 0,
            discount: 0,
            taxRate: 0.05,
            taxableAmount: 699,
            taxAmount: 35,
            totalAmount: 734,
            currentPayable: 734,
        },
        paymentMethod: "ONLINE",
        paymentStatus: "FAILED",
        orderStatus: "PENDING",
        razorpayOrderId: "order_rzp_browser_failed",
    });

    console.log("Seeded test database successfully.");
    return { testUser, testAdmin, completedOrder, failedOrder };
}

async function startServer() {
    await mongoose.connect(TEST_DB_URI);
    const { testUser, testAdmin, completedOrder, failedOrder } = await seedData();

    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use(express.urlencoded({ extended: true }));
    app.use(passport.initialize());

    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "../views"));
    app.use(express.static(path.join(__dirname, "../public")));

    const { userSessionConfig, adminSessionConfig } = require("../config/session");

    // Helper login bypass route for headless browser tests
    app.get("/test-auth/login-as-shopper", userSessionConfig, (req, res) => {
        req.session.userId = testUser._id.toString();
        req.session.user = { id: testUser._id.toString(), fullName: testUser.fullName, email: testUser.email, role: "USER" };
        req.session.save((err) => {
            if (err) return res.status(500).send("Session save failed: " + err.message);
            res.redirect("/products");
        });
    });

    app.get("/test-auth/login-as-admin", adminSessionConfig, (req, res) => {
        req.session.adminId = testAdmin._id.toString();
        req.session.admin = { id: testAdmin._id.toString(), fullName: testAdmin.fullName, email: testAdmin.email, role: "ADMIN" };
        req.session.save((err) => {
            if (err) return res.status(500).send("Session save failed: " + err.message);
            res.redirect("/admin/dashboard");
        });
    });

    app.use("/admin", adminRoute);
    app.use("/", userRoute);

    const PORT = 3001;
    const server = app.listen(PORT, () => {
        console.log(`BROWSER_TEST_SERVER_READY: http://localhost:${PORT}`);
        console.log(`COMPLETED_ORDER_ID: ${completedOrder._id}`);
        console.log(`FAILED_ORDER_ID: ${failedOrder._id}`);
    });
}

startServer().catch(err => {
    console.error("Failed to start browser test server:", err);
    process.exit(1);
});
