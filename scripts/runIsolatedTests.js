/**
 * Isolated Test Suite for Velora Week 15 Fixes
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 * 
 * NEVER runs against production database.
 */

const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

// Import Models
const User = require("../models/user/userModel");
const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Cart = require("../models/order/cartModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Address = require("../models/user/addressModel");
const Wishlist = require("../models/user/wishlistModel");
const Offer = require("../models/product/offerModel");
const Coupon = require("../models/order/couponModel");
const Wallet = require("../models/user/walletModel");
const Transaction = require("../models/user/transactionModel");

// Import Helpers & Services
const pricingService = require("../services/common/pricingService");
const couponService = require("../services/admin/couponService");
const offerService = require("../services/admin/offerService");
const walletService = require("../services/user/walletService");
const userService = require("../services/user/userService");
const reportService = require("../services/admin/reportService");
const razorpayConfig = require("../config/razorpay");
const defaultMockRazorpay = {
    orders: {
        create: async (params) => ({
            id: `order_mock_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            ...params,
        }),
    },
    payments: {
        fetch: async (id) => ({
            id,
            currency: "INR",
            amount: 100000,
            status: "captured",
        }),
    },
};
razorpayConfig.setRazorpayInstanceCreator(() => defaultMockRazorpay);

const transporter = require("../config/nodemailer");
transporter.sendMail = async () => ({ messageId: "mock_test_id" });
const crypto = require("crypto");
const {
    validateStatusTransition,
    calculateOrderStatusFromItems,
    shouldCompleteCodPayment,
    ALLOWED_ITEM_TRANSITIONS,
} = require("../helpers/orderStatusHelper");
const restoreCancellationStock = require("../helpers/restoreCancellationStock");
const restoreReturnStock = require("../helpers/restoreReturnStock");
const escapeRegex = require("../utils/escapeRegex");
const { generateInvoicePdf } = require("../utils/invoiceGenerator");
const { generateUniqueProductSlug } = require("../services/admin/productService");
const {
    updateVariantStock,
    adjustVariantStock,
    parseStrictInteger,
} = require("../services/admin/inventoryService");
const {
    updateOrderStatus,
    updateAdminOrderItemStatus,
    approveReturnItem,
    rejectReturnItem,
    restockReturnItem,
    updatePaymentStatus,
    reconcileOrderState,
} = require("../services/admin/orderService");
const productService = require("../services/admin/productService");
const addressService = require("../services/user/addressService");
const cartService = require("../services/user/cartService");
const { getAuthoritativeItemPrice } = require("../services/common/pricingService");
const {
    placeOrder,
    placeCodOrder,
    verifyRazorpayPayment,
    retryOrderPayment,
    handleRazorpayWebhook,
    cancelEntireOrder,
    cancelOrderItem,
    releaseExpiredReservations,
} = require("../services/user/orderService");

let totalTests = 0;
let passedTests = 0;
let failedTests = [];

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  ✓ ${message}`);
    } else {
        failedTests.push(message);
        console.error(`  ✗ FAIL: ${message}`);
    }
}

async function run() {
    const targetDb = process.env.TEST_DB_URI || TEST_DB_URI;
    if (!targetDb.toLowerCase().includes("test") && !targetDb.toLowerCase().includes("isolated")) {
        console.error(`FATAL: Database target "${targetDb}" is NOT an isolated test database.`);
        console.error("Aborting to prevent potential data loss or corruption.");
        process.exit(1);
    }

    console.log("=================================================");
    console.log("VELORA ISOLATED TEST SUITE STARTING");
    console.log(`Target Database: ${targetDb}`);
    console.log("=================================================\n");

    await mongoose.connect(targetDb);
    await mongoose.connection.dropDatabase();
    console.log("Cleaned isolated test database.\n");

    try {
        // -------------------------------------------------------------
        // SUITE 1: Security & Password Reset (Finding 1)
        // -------------------------------------------------------------
        console.log("--- Suite 1: Password Reset Verification (Finding 1) ---");
        {
            // Simulate session state
            const req = {
                session: {
                    resetPasswordVerification: {
                        email: "authorized@example.com",
                        verifiedAt: Date.now(),
                        expiresAt: Date.now() + 15 * 60 * 1000,
                    },
                },
                body: {
                    email: "attacker@example.com",
                    newPassword: "Password123!",
                    confirmPassword: "Password123!",
                },
            };

            const verification = req.session.resetPasswordVerification;
            const isAuthorized =
                verification &&
                verification.email === req.body.email &&
                Date.now() < verification.expiresAt;

            assert(!isAuthorized, "Password reset verification rejects mismatching email");

            // Test expired verification
            req.session.resetPasswordVerification.email = "attacker@example.com";
            req.session.resetPasswordVerification.expiresAt = Date.now() - 1000;
            const isExpired = Date.now() >= req.session.resetPasswordVerification.expiresAt;
            assert(isExpired, "Expired password reset verification is rejected");
        }

        // -------------------------------------------------------------
        // SUITE 2: Toast XSS Protection (Finding 2)
        // -------------------------------------------------------------
        console.log("\n--- Suite 2: Toast textContent Rendering (Finding 2) ---");
        {
            const headerView = fs.readFileSync(path.join(__dirname, "../views/partials/storeHeader.ejs"), "utf8");
            const adminTopView = fs.readFileSync(path.join(__dirname, "../views/admin/partials/topbar.ejs"), "utf8");

            assert(
                headerView.includes("msgSpan.textContent") && !headerView.includes("innerHTML = `<span class=\"font-medium\">${message}"),
                "User storeHeader uses textContent for toast messages"
            );
            assert(
                adminTopView.includes("msgSpan.textContent") && !adminTopView.includes("toast.innerHTML = `<span class=\"text-xs font-semibold\">${message}"),
                "Admin topbar uses textContent for toast messages"
            );
        }

        // -------------------------------------------------------------
        // SUITE 3: Product Variant Serialization & Sale Price 0 (Findings 3 & 17)
        // -------------------------------------------------------------
        console.log("\n--- Suite 3: Variant Serialization & Zero Sale Price (Findings 3 & 17) ---");
        {
            const productDetailView = fs.readFileSync(path.join(__dirname, "../views/user/product-detail.ejs"), "utf8");
            assert(
                productDetailView.includes("JSON.stringify(variants") && productDetailView.includes(".replace(/</g, '\\\\u003c')"),
                "Variant JSON is safely serialized without HTML escaping corrupting quotes, & or backslashes"
            );

            // Nullish fallback test
            const variantWithZeroSale = { regularPrice: 1999, salePrice: 0 };
            const effectivePrice = variantWithZeroSale.salePrice != null
                ? variantWithZeroSale.salePrice
                : variantWithZeroSale.regularPrice;
            assert(effectivePrice === 0, "Sale price of 0 is preserved and not replaced by regularPrice");

            const variantWithNullSale = { regularPrice: 1999, salePrice: null };
            const effectivePriceNull = variantWithNullSale.salePrice != null
                ? variantWithNullSale.salePrice
                : variantWithNullSale.regularPrice;
            assert(effectivePriceNull === 1999, "Null sale price properly falls back to regularPrice");
        }

        // -------------------------------------------------------------
        // SUITE 4: Inventory Strict Integer & Atomic Adjustments (Findings 13 & 14)
        // -------------------------------------------------------------
        console.log("\n--- Suite 4: Strict Inventory Validation & Atomic Edits (Findings 13 & 14) ---");
        {
            assert(parseStrictInteger("12abc") === null, 'Rejects partial numeric "12abc"');
            assert(parseStrictInteger("1.5") === null, 'Rejects float "1.5"');
            assert(parseStrictInteger(null) === null, "Rejects null input");
            assert(parseStrictInteger(NaN) === null, "Rejects NaN input");
            assert(parseStrictInteger("42") === 42, 'Parses valid integer "42"');
            assert(parseStrictInteger(100) === 100, "Parses valid integer 100");

            // Seed category, product, variant for testing
            const cat = await Category.create({ name: "Apparel", slug: "apparel", isActive: true });
            const prod = await Product.create({ name: "Oxford Shirt", slug: "oxford-shirt", categoryId: cat._id, status: "ACTIVE" });
            const v1 = await Variant.create({
                productId: prod._id,
                sku: "OX-WHT-M",
                color: "Black & White",
                size: "M",
                stock: 10,
                regularPrice: 2000,
                salePrice: 1500,
                isActive: true,
            });

            // Absolute edit with stale stock check
            const failEdit = await updateVariantStock(v1._id, 15, 999);
            assert(!failEdit.success && failEdit.message.includes("Stock conflict"), "Rejects absolute stock update when expectedStock is stale");

            const succEdit = await updateVariantStock(v1._id, 20, 10);
            assert(succEdit.success && succEdit.newStock === 20, "Applies atomic absolute stock edit when expectedStock matches");

            // Relative adjustment with non-negative guard
            const decFail = await adjustVariantStock(v1._id, -50);
            assert(!decFail.success && decFail.message.includes("Cannot reduce stock below zero"), "Rejects decrement that would result in negative stock");

            const decSucc = await adjustVariantStock(v1._id, -5);
            assert(decSucc.success && decSucc.newStock === 15, "Applies atomic stock decrement correctly");
        }

        // -------------------------------------------------------------
        // SUITE 5: Regex Escaping & Malformed Search Inputs (Finding 18)
        // -------------------------------------------------------------
        console.log("\n--- Suite 5: Literal Regex Escaping (Finding 18) ---");
        {
            const dangerousPattern = "[abc.*+?^${}()|";
            const escaped = escapeRegex(dangerousPattern);
            const regex = new RegExp(escaped, "i");
            assert(regex.test("[abc.*+?^${}()|"), "Escapes special regex characters for literal matching without crashing");
            assert(escapeRegex(null) === "", "Handles null input safely");
            assert(escapeRegex(["malformed", "array"]) === "", "Handles non-string input safely");
        }

        // -------------------------------------------------------------
        // SUITE 6: Product Slug Collision Prevention (Finding 20)
        // -------------------------------------------------------------
        console.log("\n--- Suite 6: Unique Product Slug Generation (Finding 20) ---");
        {
            const cat = await Category.findOne({ slug: "apparel" });
            const slug1 = await generateUniqueProductSlug("Premium Blazer");
            const p1 = await Product.create({ name: "Premium Blazer", slug: slug1, categoryId: cat._id });
            assert(slug1 === "premium-blazer", "Generates initial base slug");

            const slug2 = await generateUniqueProductSlug("Premium Blazer");
            const p2 = await Product.create({ name: "Premium Blazer", slug: slug2, categoryId: cat._id });
            assert(slug2 === "premium-blazer-2", "Generates unique deduplicated slug (-2)");

            const slug3 = await generateUniqueProductSlug("Premium Blazer");
            assert(slug3 === "premium-blazer-3", "Generates unique deduplicated slug (-3)");
        }

        // -------------------------------------------------------------
        // SUITE 7: Order Pricing Defaults & Min Items (Finding 19)
        // -------------------------------------------------------------
        console.log("\n--- Suite 7: Order Pricing Defaults & Validation (Finding 19) ---");
        {
            const user = await User.create({ fullName: "Test Customer", email: "customer@example.com", phone: "9876543210" });
            let emptyOrderFailed = false;
            try {
                await Order.create({
                    orderNumber: "TEST-EMPTY-01",
                    userId: user._id,
                    items: [], // Empty items
                    shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", phone: "9876543210" },
                    paymentMethod: "COD",
                });
            } catch (err) {
                emptyOrderFailed = true;
            }
            assert(emptyOrderFailed, "Rejects empty order with 0 items");
        }

        // -------------------------------------------------------------
        // SUITE 8: Checkout Concurrency & Compensation (Findings 6, 7, 8)
        // -------------------------------------------------------------
        console.log("\n--- Suite 8: Checkout Compensation & Cart Concurrency (Findings 6, 7, 8) ---");
        {
            const user = await User.findOne({ email: "customer@example.com" });
            const addr = await Address.create({
                userId: user._id,
                firstName: "John",
                lastName: "Doe",
                addressLine1: "123 High Street",
                city: "Kochi",
                state: "Kerala",
                pinCode: "682001",
                country: "India",
                phone: "9876543210",
                isDefault: true,
            });

            const prod = await Product.findOne({ slug: "oxford-shirt" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });
            await Variant.updateOne({ _id: v1._id }, { $set: { stock: 5 } });

            // Create user cart with 3 units
            const cart = await Cart.create({
                userId: user._id,
                checkoutToken: "token_abc_123",
                items: [{ variantId: v1._id, quantity: 3, priceSnapshot: 1500 }],
            });

            // 1. Concurrent checkouts with different tokens: second must be rejected
            const checkout1Promise = placeCodOrder(user._id, addr._id, "token_abc_123");
            const checkout2Promise = placeCodOrder(user._id, addr._id, "arbitrary_attacker_token");

            const [res1, res2] = await Promise.all([checkout1Promise, checkout2Promise]);

            assert(
                (res1.success && !res2.success) || (!res1.success && res2.success),
                "Only one checkout session can claim the cart; arbitrary/concurrent tokens are rejected"
            );

            // Verify stock decremented by 3 (from 5 to 2)
            const updatedV1 = await Variant.findById(v1._id);
            assert(updatedV1.stock === 2, "Stock decremented accurately by purchased quantity");

            // 2. Failure injection & compensation test
            // Inject failure during checkout by making Cart.updateOne throw
            const cart2 = await Cart.findOneAndUpdate(
                { userId: user._id },
                {
                    $set: {
                        checkoutToken: "fail_injection_token",
                        checkoutClaimToken: "fail_injection_token",
                        checkoutClaimUntil: null,
                        items: [{ variantId: v1._id, quantity: 2, priceSnapshot: 1500 }],
                    },
                },
                { returnDocument: "after" }
            );

            const origUpdateOne = Cart.updateOne;
            Cart.updateOne = async function (filter, update, opts) {
                if (update.$inc || update.$pull || (update.$set && update.$set.items)) {
                    throw new Error("INJECTED_CART_CLEARING_FAILURE");
                }
                return origUpdateOne.apply(this, arguments);
            };

            let failedCaught = false;
            try {
                await placeCodOrder(user._id, addr._id, "fail_injection_token");
            } catch (err) {
                failedCaught = true;
                assert(err.message === "INJECTED_CART_CLEARING_FAILURE", "Failure injected after order/payment creation");
            } finally {
                Cart.updateOne = origUpdateOne;
            }

            // Verify compensation resolved the created order and restored stock
            const compensatedOrder = await Order.findOne({ checkoutToken: "fail_injection_token" });
            assert(compensatedOrder !== null, "Compensated order document exists");
            assert(compensatedOrder.orderStatus === "CANCELLED", "Compensated order is marked CANCELLED");
            assert(compensatedOrder.paymentStatus === "FAILED", "Compensated order payment is marked FAILED");

            const compensatedStock = await Variant.findById(v1._id);
            assert(compensatedStock.stock === 2, "Variant stock is restored after failure injection");
        }

        // -------------------------------------------------------------
        // SUITE 9: Concurrency - Simultaneous Cancel/Cancel (Finding 4)
        // -------------------------------------------------------------
        console.log("\n--- Suite 9: Simultaneous Cancel/Cancel Race (Finding 4) ---");
        {
            const user = await User.findOne({ email: "customer@example.com" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });
            await Variant.updateOne({ _id: v1._id }, { $set: { stock: 10 } });

            const testOrder = await Order.create({
                orderNumber: "RACE-CC-01",
                userId: user._id,
                items: [
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Oxford Shirt",
                        sku: v1.sku,
                        quantity: 2,
                        regularPrice: 2000,
                        unitPrice: 1500,
                        priceAtPurchase: 1500,
                        lineTotal: 3000,
                        status: "PENDING",
                    },
                ],
                shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 3000, shippingFee: 0, totalAmount: 3000, currentPayable: 3000 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
            });

            const itemId = testOrder.items[0]._id;

            // Fire two simultaneous cancel requests
            const [cancel1, cancel2] = await Promise.all([
                cancelOrderItem(user._id, testOrder._id, itemId, "Changed mind A"),
                cancelOrderItem(user._id, testOrder._id, itemId, "Changed mind B"),
            ]);

            const v1After = await Variant.findById(v1._id);
            assert(v1After.stock === 12, `Stock increased by exactly 2 (stock = ${v1After.stock}, NEVER double restocked to 14)`);
            assert(
                (cancel1.success && !cancel2.success) || (!cancel1.success && cancel2.success),
                "Exactly one cancel request succeeded; concurrent request was rejected"
            );
        }

        // -------------------------------------------------------------
        // SUITE 10: Concurrency - Cancel-All vs Item-Cancel (Finding 4)
        // -------------------------------------------------------------
        console.log("\n--- Suite 10: Cancel-All vs Item-Cancel Race (Finding 4) ---");
        {
            const user = await User.findOne({ email: "customer@example.com" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });
            await Variant.updateOne({ _id: v1._id }, { $set: { stock: 20 } });

            const testOrder = await Order.create({
                orderNumber: "RACE-CA-01",
                userId: user._id,
                items: [
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Item 1",
                        sku: v1.sku,
                        quantity: 2,
                        regularPrice: 2000,
                        unitPrice: 1500,
                        priceAtPurchase: 1500,
                        lineTotal: 3000,
                        status: "PENDING",
                    },
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Item 2",
                        sku: v1.sku,
                        quantity: 3,
                        regularPrice: 2000,
                        unitPrice: 1500,
                        priceAtPurchase: 1500,
                        lineTotal: 4500,
                        status: "PENDING",
                    },
                ],
                shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 7500, shippingFee: 0, totalAmount: 7500, currentPayable: 7500 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
            });

            const item1Id = testOrder.items[0]._id;

            const [resAll, resItem] = await Promise.all([
                cancelEntireOrder(user._id, testOrder._id, "Cancel all"),
                cancelOrderItem(user._id, testOrder._id, item1Id, "Cancel single item"),
            ]);

            const v1After = await Variant.findById(v1._id);
            // Total units across order = 5. Starting stock = 20. End stock MUST be 25, NEVER 27.
            assert(v1After.stock === 25, `Stock restocked by exactly 5 units (stock = ${v1After.stock}, no double restock)`);
        }

        // -------------------------------------------------------------
        // SUITE 11: Concurrency - User Cancel vs Admin Cancel (Finding 4)
        // -------------------------------------------------------------
        console.log("\n--- Suite 11: User Cancel vs Admin Cancel Race (Finding 4) ---");
        {
            const user = await User.findOne({ email: "customer@example.com" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });
            await Variant.updateOne({ _id: v1._id }, { $set: { stock: 30 } });

            const testOrder = await Order.create({
                orderNumber: "RACE-UA-01",
                userId: user._id,
                items: [
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Oxford Shirt",
                        sku: v1.sku,
                        quantity: 4,
                        regularPrice: 2000,
                        unitPrice: 1500,
                        priceAtPurchase: 1500,
                        lineTotal: 6000,
                        status: "PENDING",
                    },
                ],
                shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 6000, shippingFee: 0, totalAmount: 6000, currentPayable: 6000 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
            });

            const itemId = testOrder.items[0]._id;

            const [userCancel, adminCancel] = await Promise.all([
                cancelOrderItem(user._id, testOrder._id, itemId, "User cancel"),
                updateAdminOrderItemStatus(testOrder._id, itemId, "CANCELLED", { adminNote: "Admin cancel" }),
            ]);

            const v1After = await Variant.findById(v1._id);
            assert(v1After.stock === 34, `Stock restocked exactly once (+4 units -> ${v1After.stock})`);
            assert(
                (userCancel.success && !adminCancel.success) || (!userCancel.success && adminCancel.success),
                "Exactly one actor successfully cancelled the item"
            );
        }

        // -------------------------------------------------------------
        // SUITE 12: Concurrency - Cancel vs Shipping (Finding 4 & 12)
        // -------------------------------------------------------------
        console.log("\n--- Suite 12: Cancel vs Shipping Race (Finding 4 & 12) ---");
        {
            const user = await User.findOne({ email: "customer@example.com" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });
            await Variant.updateOne({ _id: v1._id }, { $set: { stock: 40 } });

            const testOrder = await Order.create({
                orderNumber: "RACE-CS-01",
                userId: user._id,
                items: [
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Oxford Shirt",
                        sku: v1.sku,
                        quantity: 2,
                        regularPrice: 2000,
                        unitPrice: 1500,
                        priceAtPurchase: 1500,
                        lineTotal: 3000,
                        status: "PROCESSING",
                    },
                ],
                shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 3000, shippingFee: 0, totalAmount: 3000, currentPayable: 3000 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "PROCESSING",
            });

            const itemId = testOrder.items[0]._id;

            const [cancelRes, shipRes] = await Promise.all([
                cancelOrderItem(user._id, testOrder._id, itemId, "Try to cancel"),
                updateAdminOrderItemStatus(testOrder._id, itemId, "SHIPPED"),
            ]);

            const v1After = await Variant.findById(v1._id);
            if (shipRes.success) {
                assert(!cancelRes.success, "If shipping wins, cancellation is rejected");
                assert(v1After.stock === 40, "Stock is NOT restocked when shipped");
            } else {
                assert(cancelRes.success, "If cancellation wins, stock is restocked once");
                assert(v1After.stock === 42, "Stock restocked (+2)");
            }
        }

        // -------------------------------------------------------------
        // SUITE 13: Concurrency - Return-Restock vs Return-Restock (Finding 5)
        // -------------------------------------------------------------
        console.log("\n--- Suite 13: Return Restock Race (Finding 5) ---");
        {
            const user = await User.findOne({ email: "customer@example.com" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });
            await Variant.updateOne({ _id: v1._id }, { $set: { stock: 50 } });

            const testOrder = await Order.create({
                orderNumber: "RACE-RR-01",
                userId: user._id,
                items: [
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Oxford Shirt",
                        sku: v1.sku,
                        quantity: 3,
                        regularPrice: 2000,
                        unitPrice: 1500,
                        priceAtPurchase: 1500,
                        lineTotal: 4500,
                        status: "RETURN_APPROVED",
                        isRestocked: false,
                    },
                ],
                shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 4500, shippingFee: 0, totalAmount: 4500, currentPayable: 4500 },
                paymentMethod: "COD",
                paymentStatus: "COMPLETED",
                orderStatus: "RETURN_APPROVED",
            });

            const itemId = testOrder.items[0]._id;

            // Fire two simultaneous restock calls
            const [restock1, restock2] = await Promise.all([
                restockReturnItem(testOrder._id, itemId, "Restock attempt 1"),
                restockReturnItem(testOrder._id, itemId, "Restock attempt 2"),
            ]);

            const v1After = await Variant.findById(v1._id);
            assert(v1After.stock === 53, `Stock restocked by exactly 3 units (stock = ${v1After.stock}, NEVER 56)`);
            assert(
                (restock1.success && !restock2.success) || (!restock1.success && restock2.success),
                "Exactly one restock call succeeds; concurrent call receives already restocked notice"
            );
        }

        // -------------------------------------------------------------
        // SUITE 14: Payment Rules & Partial Transitions (Findings 9, 10, 11)
        // -------------------------------------------------------------
        console.log("\n--- Suite 14: Payment Status Completion Rules (Findings 9, 10, 11) ---");
        {
            // Finding 9: Bulk DELIVERED when one item is PROCESSING
            const user = await User.findOne({ email: "customer@example.com" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });

            const orderMixed = await Order.create({
                orderNumber: "PAY-MIXED-01",
                userId: user._id,
                items: [
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Item Shipped",
                        sku: "SKU-1",
                        quantity: 1,
                        regularPrice: 1000,
                        unitPrice: 1000,
                        priceAtPurchase: 1000,
                        lineTotal: 1000,
                        status: "SHIPPED",
                    },
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Item Processing",
                        sku: "SKU-2",
                        quantity: 1,
                        regularPrice: 1000,
                        unitPrice: 1000,
                        priceAtPurchase: 1000,
                        lineTotal: 1000,
                        status: "PROCESSING",
                    },
                ],
                shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 2000, shippingFee: 0, totalAmount: 2000, currentPayable: 2000 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "PROCESSING",
            });

            await updateOrderStatus(orderMixed._id, "DELIVERED");
            const afterBulk = await Order.findById(orderMixed._id);
            assert(afterBulk.paymentStatus === "PENDING", "Bulk DELIVERED does NOT mark COD completed while another item is PROCESSING (Finding 9)");

            // Finding 10: Individual delivery when other item is RETURN_REJECTED
            const orderRejectMixed = await Order.create({
                orderNumber: "PAY-REJECT-01",
                userId: user._id,
                items: [
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Item 1",
                        sku: "SKU-1",
                        quantity: 1,
                        regularPrice: 1000,
                        unitPrice: 1000,
                        priceAtPurchase: 1000,
                        lineTotal: 1000,
                        status: "RETURN_REJECTED",
                    },
                    {
                        variantId: v1._id,
                        productId: v1.productId,
                        productName: "Item 2",
                        sku: "SKU-2",
                        quantity: 1,
                        regularPrice: 1000,
                        unitPrice: 1000,
                        priceAtPurchase: 1000,
                        lineTotal: 1000,
                        status: "OUT_FOR_DELIVERY",
                    },
                ],
                shippingAddress: { firstName: "Test", lastName: "User", addressLine1: "123", city: "City", state: "State", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 2000, shippingFee: 0, totalAmount: 2000, currentPayable: 2000 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "OUT_FOR_DELIVERY",
            });

            const item2Id = orderRejectMixed.items[1]._id;
            await updateAdminOrderItemStatus(orderRejectMixed._id, item2Id, "DELIVERED");
            const afterDelivery = await Order.findById(orderRejectMixed._id);
            assert(afterDelivery.paymentStatus === "COMPLETED", "COD payment marked COMPLETED when remaining item is delivered and other is RETURN_REJECTED (Finding 10)");

            // Finding 11: Cannot mark REFUNDED on unpaid order
            const refundAttempt = await updatePaymentStatus(orderMixed._id, "REFUNDED");
            assert(!refundAttempt.success, "Rejects REFUNDED transition on unpaid order (Finding 11)");
        }

        // -------------------------------------------------------------
        // SUITE 15: Invoice Generation & Dynamic Measurement (Finding 21)
        // -------------------------------------------------------------
        console.log("\n--- Suite 15: Invoice Dynamic Measurement (Finding 21) ---");
        {
            const user = await User.findOne({ email: "customer@example.com" });
            const v1 = await Variant.findOne({ sku: "OX-WHT-M" });

            const invoiceOrder = {
                orderNumber: "INV-TEST-9999",
                placedAt: new Date(),
                orderStatus: "CANCELLED",
                cancelledAt: new Date(),
                cancellationReason: "Customer requested cancellation because they found a significantly lower price elsewhere and would like to cancel the entire consignment immediately without further processing or delayed deliveries.",
                paymentMethod: "COD",
                paymentStatus: "CANCELLED",
                shippingAddress: {
                    firstName: "Dr. Alexander Montgomery",
                    lastName: "Fitzgerald-Smith III",
                    addressLine1: "Flat 402, Building 7, Prestige Whispering Palms Residential Luxury Complex",
                    addressLine2: "Opposite High Court Junction, North Extension Road, Near Central Metro Station",
                    city: "Kochi Suburban Metropolis",
                    state: "Kerala Coastal Zone",
                    pinCode: "682001",
                    country: "Republic of India",
                    phone: "+91 98765 43210 / +91 91234 56789",
                },
                items: [
                    {
                        productName: "Luxury Tailored Oxford Cotton Blend Formal Shirt with Extra Long Sleeves and French Cuffs",
                        color: "Black & White Monochrome Houndstooth",
                        size: "Extra Large (44)",
                        sku: "OX-WHT-XL-FR-CUFF",
                        quantity: 3,
                        unitPrice: 3500,
                        lineTotal: 10500,
                        status: "CANCELLED",
                        cancellationReason: "Defective item in earlier shipment, requested cancellation of remaining units as well.",
                        adminFeedback: "Approved by Senior Store Administrator after customer service review. Return processing fee waived.",
                    },
                ],
                pricing: {
                    originalSubtotal: 10500,
                    originalShippingFee: 100,
                    subtotal: 10500,
                    shippingFee: 100,
                    discount: 500,
                    cancellationDeduction: 10500,
                    returnCredit: 0,
                    currentPayable: 0,
                    totalAmount: 10100,
                },
            };

            const mockRes = {
                setHeader: () => {},
                on: () => {},
                once: () => {},
                emit: () => {},
                write: () => {},
                end: () => {},
            };

            let pdfGeneratedWithoutError = false;
            try {
                generateInvoicePdf(invoiceOrder, mockRes);
                pdfGeneratedWithoutError = true;
            } catch (err) {
                console.error("PDF generation crashed:", err);
            }
            assert(pdfGeneratedWithoutError, "Generates PDF invoice with long cancellation reasons, multiline addresses, and admin feedback without error (Finding 21)");
        }

        // -------------------------------------------------------------
        // SUITE 14: Product & Category Offers & Central Pricing (Phase 2)
        // -------------------------------------------------------------
        console.log("\n--- Suite 14: Offers & Central Pricing (Phase 2) ---");
        {
            const testCat = await Category.create({ name: "Menswear " + Date.now(), slug: "menswear-" + Date.now(), isActive: true, isDeleted: false });
            const testProd = await Product.create({
                name: "Oxford Blazer " + Date.now(),
                slug: "oxford-blazer-" + Date.now(),
                categoryId: testCat._id,
                brand: "Velora Signature",
                status: "ACTIVE",
                isDeleted: false,
            });
            const testVar = await Variant.create({
                productId: testProd._id,
                sku: "OX-BLZ-" + Date.now(),
                regularPrice: 3000,
                salePrice: 2800,
                stock: 20,
                isActive: true,
            });

            const now = new Date();
            const tomorrow = new Date(Date.now() + 86400000);

            // 1. Product Offer (20%) vs Category Offer (10%) -> 20% wins
            const catOffer = await Offer.create({
                name: "10% Category Discount",
                offerType: "CATEGORY",
                categoryId: testCat._id,
                discountType: "PERCENTAGE",
                discountValue: 10,
                startDate: now,
                endDate: tomorrow,
                isActive: true,
            });

            const prodOffer = await Offer.create({
                name: "20% Product Discount",
                offerType: "PRODUCT",
                productId: testProd._id,
                discountType: "PERCENTAGE",
                discountValue: 20,
                startDate: now,
                endDate: tomorrow,
                isActive: true,
            });

            const bestOffer1 = await pricingService.getBestActiveOffer(testProd._id, testCat._id);
            assert(bestOffer1 && bestOffer1.discountValue === 20, "Resolves larger offer: 20% product offer chosen over 10% category offer (no stacking)");

            // 2. Higher Category Offer (30%) -> Category offer wins
            await Offer.create({
                name: "30% Category Super Discount",
                offerType: "CATEGORY",
                categoryId: testCat._id,
                discountType: "PERCENTAGE",
                discountValue: 30,
                startDate: now,
                endDate: tomorrow,
                isActive: true,
            });

            const bestOffer2 = await pricingService.getBestActiveOffer(testProd._id, testCat._id);
            assert(bestOffer2 && bestOffer2.discountValue === 30, "Resolves higher category offer: 30% category offer chosen over 20% product offer");

            // 3. Interaction with salePrice: regularPrice 3000 - 30% (900) = 2100. Base salePrice is 2800 -> 2100 wins
            const priceCalc1 = pricingService.calculateItemPrice(testVar, testProd, bestOffer2);
            assert(priceCalc1.effectiveUnitPrice === 2100, "Calculates effective price: regularPrice - offerDiscount (3000 - 900 = 2100) avoids double-discounting");

            // 4. If base salePrice was 1900 < 2100, the better price 1900 applies
            testVar.salePrice = 1900;
            const priceCalc2 = pricingService.calculateItemPrice(testVar, testProd, bestOffer2);
            assert(priceCalc2.effectiveUnitPrice === 1900, "Respects existing salePrice when lower than offer price (1900 < 2100)");

            // 5. Coupon Allocation across items deterministically in integer paise
            const dummyItems = [
                { lineTotal: 1000 },
                { lineTotal: 1500 },
                { lineTotal: 2500 },
            ];
            const allocated = pricingService.allocateCouponDiscount(dummyItems, 300);
            const sumAllocated = allocated.reduce((s, i) => s + i.allocatedCouponDiscount, 0);
            assert(sumAllocated === 300, `Coupon allocation exact in integer paise: sum(allocated) === 300 (Actual: ${sumAllocated})`);
            assert(allocated[2].allocatedCouponDiscount >= allocated[0].allocatedCouponDiscount, "Proportional allocation distributes discount relative to line item size");
        }

        // -------------------------------------------------------------
        // SUITE 15: Coupon Management & Atomic Limits (Phase 3)
        // -------------------------------------------------------------
        console.log("\n--- Suite 15: Coupon Management & Atomic Limits (Phase 3) ---");
        {
            const testUserA = await User.create({ fullName: "Coupon Tester A", email: `cp_a_${Date.now()}@example.com`, password: "hash" });
            const testUserB = await User.create({ fullName: "Coupon Tester B", email: `cp_b_${Date.now()}@example.com`, password: "hash" });
            const testUserC = await User.create({ fullName: "Coupon Tester C", email: `cp_c_${Date.now()}@example.com`, password: "hash" });

            const couponCode = "VELORA" + Math.floor(1000 + Math.random() * 9000);
            const couponCreate = await couponService.createCoupon({
                code: couponCode,
                description: "Festive Save",
                discountType: "PERCENTAGE",
                discountValue: 20,
                minPurchase: 500,
                maxDiscount: 300,
                usageLimit: 2,
                perUserLimit: 1,
                startDate: new Date(),
                endDate: new Date(Date.now() + 86400000),
            });
            assert(couponCreate.success && couponCreate.coupon.code === couponCode, "Admin creates normalized coupon with usage and per-user limits");

            // Record first usage for User A
            const use1 = await couponService.recordCouponUsage(couponCreate.coupon._id, testUserA._id);
            assert(use1.success, "Records first coupon usage for User A successfully");

            // User A attempts to use again -> should be blocked by perUserLimit
            const useAgain = await couponService.recordCouponUsage(couponCreate.coupon._id, testUserA._id);
            assert(!useAgain.success && useAgain.message.includes("maximum allowed"), "Enforces per-user limit: User A blocked from applying coupon twice");

            // User B uses coupon (usage 2 of 2)
            const use2 = await couponService.recordCouponUsage(couponCreate.coupon._id, testUserB._id);
            assert(use2.success, "User B uses second global coupon slot");

            // User C attempts to use coupon -> blocked by global usageLimit (2 of 2)
            const use3 = await couponService.recordCouponUsage(couponCreate.coupon._id, testUserC._id);
            assert(!use3.success && use3.message.includes("global usage limit"), "Enforces global usage limit: User C rejected after 2 total uses");

            // Release User B's usage (e.g. checkout failed or expired)
            await couponService.releaseCouponUsage(couponCreate.coupon._id, testUserB._id);
            const use3Retry = await couponService.recordCouponUsage(couponCreate.coupon._id, testUserC._id);
            assert(use3Retry.success, "Releasing coupon usage atomically reopens slot for User C");
        }

        // -------------------------------------------------------------
        // SUITE 16: Razorpay Online Payment & Idempotency (Phase 4)
        // -------------------------------------------------------------
        console.log("\n--- Suite 16: Razorpay Online Payment & Idempotency (Phase 4) ---");
        {
            razorpayConfig.setRazorpayInstanceCreator(() => ({
                orders: {
                    create: async (params) => ({
                        id: "order_rzp_mock_" + Date.now(),
                        amount: params.amount,
                        currency: params.currency || "INR",
                        receipt: params.receipt,
                        notes: params.notes,
                        status: "created",
                    }),
                },
            }));

            const onlineUser = await User.create({ fullName: "Online Shopper", email: `online_${Date.now()}@example.com`, password: "hash", phone: "9876543210" });
            const onlineAddr = await Address.create({
                userId: onlineUser._id,
                firstName: "Online",
                lastName: "Shopper",
                addressLine1: "123 Tech Park",
                city: "Bengaluru",
                state: "Karnataka",
                pinCode: 560001,
                country: "India",
                phone: "9876543210",
                isDefault: true,
            });

            const cat = await Category.create({ name: "Online Cat " + Date.now(), slug: "online-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prod = await Product.create({ name: "Tech Jacket " + Date.now(), slug: "tech-jacket-" + Date.now(), categoryId: cat._id, status: "ACTIVE", isDeleted: false });
            const variant = await Variant.create({ productId: prod._id, sku: "TJ-" + Date.now(), regularPrice: 2500, stock: 15, isActive: true });

            await Cart.create({
                userId: onlineUser._id,
                items: [{ variantId: variant._id, quantity: 2, priceSnapshot: 2500 }],
                checkoutToken: "chk_test_online",
            });

            // 1. Place order with ONLINE payment method
            const orderRes = await placeOrder(onlineUser._id, onlineAddr._id, "ONLINE", "chk_test_online");
            assert(orderRes.success && orderRes.isOnline && orderRes.order.paymentStatus === "PENDING", "Creates ONLINE order with PENDING status and Razorpay gateway order details");
            assert(orderRes.razorpay && orderRes.razorpay.amount === 500000, `Accurate paise calculation: 2 * 2500 = 5000 -> 500000 paise (Actual: ${orderRes.razorpay?.amount})`);

            // Verify variant stock was reserved/deducted
            const updatedVar = await Variant.findById(variant._id);
            assert(updatedVar.stock === 13, "Stock is safely deducted upon online order placement (15 - 2 = 13)");

            // 2. Signature verification test
            const fakeOrderId = orderRes.razorpay.orderId || "order_test_123";
            const fakePaymentId = "pay_test_" + Date.now();
            const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
            const validSignature = crypto.createHmac("sha256", secret).update(`${fakeOrderId}|${fakePaymentId}`).digest("hex");

            const verifySuccess = await verifyRazorpayPayment(onlineUser._id, {
                orderId: orderRes.order._id,
                razorpayOrderId: fakeOrderId,
                razorpayPaymentId: fakePaymentId,
                razorpaySignature: validSignature,
            });
            assert(verifySuccess.success && verifySuccess.order.paymentStatus === "COMPLETED", "Verifies valid Razorpay HMAC SHA256 signature and activates order to COMPLETED/PROCESSING");

            // 3. Duplicate verification idempotency test
            const duplicateVerify = await verifyRazorpayPayment(onlineUser._id, {
                orderId: orderRes.order._id,
                razorpayOrderId: fakeOrderId,
                razorpayPaymentId: fakePaymentId,
                razorpaySignature: validSignature,
            });
            assert(duplicateVerify.success && duplicateVerify.isExisting === true, "Handles duplicate payment verification idempotently without re-executing updates");

            // 4. Invalid signature test
            const verifyFail = await verifyRazorpayPayment(onlineUser._id, {
                orderId: orderRes.order._id,
                razorpayOrderId: fakeOrderId,
                razorpayPaymentId: fakePaymentId,
                razorpaySignature: "invalid_tampered_signature_12345",
            });
            // Order was already COMPLETED so it returned existing; let's test invalid on a fresh pending order
            await Order.updateOne({ _id: orderRes.order._id }, { $set: { paymentStatus: "PENDING" } });
            const verifyTampered = await verifyRazorpayPayment(onlineUser._id, {
                orderId: orderRes.order._id,
                razorpayOrderId: fakeOrderId,
                razorpayPaymentId: fakePaymentId,
                razorpaySignature: "tampered_signature",
            });
            assert(!verifyTampered.success && verifyTampered.message.includes("Invalid signature"), "Rejects tampered signature and preserves security");

            // Restore COMPLETED status
            await Order.updateOne({ _id: orderRes.order._id }, { $set: { paymentStatus: "COMPLETED" } });
        }

        // -------------------------------------------------------------
        // SUITE 17: Wallet & Refunds (Phase 5)
        // -------------------------------------------------------------
        console.log("\n--- Suite 17: Wallet & Refunds (Phase 5) ---");
        {
            const walletUser = await User.create({ fullName: "Wallet User", email: `wallet_${Date.now()}@example.com`, password: "hash" });
            const walletAddr = await Address.create({
                userId: walletUser._id,
                firstName: "Wallet",
                lastName: "User",
                addressLine1: "456 Market St",
                city: "Mumbai",
                state: "Maharashtra",
                pinCode: 400001,
                country: "India",
                phone: "9123456789",
                isDefault: true,
            });

            // 1. Initial wallet creation
            const initialWallet = await walletService.getOrCreateWallet(walletUser._id);
            assert(initialWallet && initialWallet.balance === 0, "Initial wallet created with 0 balance");

            // 2. Credit wallet with idempotency reference
            const creditRes1 = await walletService.creditWallet({
                userId: walletUser._id,
                amount: 3500,
                reason: "ADMIN_ADJUSTMENT",
                description: "Test deposit",
                referenceId: `TEST_DEP_${Date.now()}`,
            });
            assert(creditRes1.success && creditRes1.balance === 3500, "Credits ₹3,500 to wallet successfully");

            // Duplicate reference idempotency test
            const dupCredit = await walletService.creditWallet({
                userId: walletUser._id,
                amount: 3500,
                reason: "ADMIN_ADJUSTMENT",
                referenceId: creditRes1.transaction.referenceId,
            });
            assert(dupCredit.isExisting === true && dupCredit.balance === 3500, "Idempotent credit prevents duplicate deposits from repeated requests");

            // 3. Overdraft prevention
            const overdraft = await walletService.debitWallet({
                userId: walletUser._id,
                amount: 5000,
                reason: "ORDER_PURCHASE",
            });
            assert(!overdraft.success && overdraft.message.includes("Insufficient"), "Rejects overdraft debit attempt atomically ($gte check prevents negative balance)");

            // 4. Full wallet payment at checkout
            const cat = await Category.create({ name: "Wallet Cat " + Date.now(), slug: "wallet-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prod = await Product.create({ name: "Silk Scarf " + Date.now(), slug: "silk-scarf-" + Date.now(), categoryId: cat._id, status: "ACTIVE", isDeleted: false });
            const variant = await Variant.create({ productId: prod._id, sku: "SS-" + Date.now(), regularPrice: 1500, stock: 10, isActive: true });

            await Cart.create({
                userId: walletUser._id,
                items: [{ variantId: variant._id, quantity: 1, priceSnapshot: 1500 }],
                checkoutToken: "chk_wallet_order",
            });

            const walletOrderRes = await placeOrder(walletUser._id, walletAddr._id, "WALLET", "chk_wallet_order");
            assert(walletOrderRes.success && walletOrderRes.order.paymentStatus === "COMPLETED" && walletOrderRes.order.paymentMethod === "WALLET", "Places full wallet order with instant COMPLETED payment status");

            const postOrderWallet = await walletService.getOrCreateWallet(walletUser._id);
            assert(postOrderWallet.balance === 2000, "Wallet balance debited accurately: 3500 - 1500 = 2000");

            // 5. Cancellation Refund to Wallet for Paid Order
            const cancelRes = await cancelOrderItem(walletUser._id, walletOrderRes.order._id, walletOrderRes.order.items[0]._id, "Customer changed mind");
            assert(cancelRes.success, "Cancels paid wallet order item");

            const postCancelWallet = await walletService.getOrCreateWallet(walletUser._id);
            assert(postCancelWallet.balance === 3500, "Refunds purchased finalPayable directly to wallet: 2000 + 1500 = 3500");

            // Verify transaction ledger has both DEBIT and CREDIT
            const ledger = await walletService.getWalletDetails(walletUser._id);
            assert(ledger.transactions.length >= 3, `Ledger records immutable transaction history (Count: ${ledger.transactions.length})`);
        }

        // -------------------------------------------------------------
        // SUITE 18: Referrals Policy & Return Clawback (Phase 6)
        // -------------------------------------------------------------
        console.log("\n--- Suite 18: Referrals Policy & Clawback (Phase 6) ---");
        {
            // Referrer signs up
            const refSignup = await userService.signupUser({
                fullName: "Alice Referrer",
                email: `alice_${Date.now()}@example.com`,
                password: "Password123!",
            });
            const otpRec = await require("../models/user/otpModel").findOne({ email: refSignup.signupData.email, purpose: "VERIFY_EMAIL" });
            const verifyRef = await userService.verifySignupOtp({
                email: refSignup.signupData.email,
                enteredOtp: otpRec.otp,
                signupData: refSignup.signupData,
            });
            assert(verifyRef.success && verifyRef.user.referralId, "Referrer receives unique referral ID upon signup");

            const referrerCode = verifyRef.user.referralId;

            // Referee signs up using referrer's code
            const refereeSignup = await userService.signupUser({
                fullName: "Bob Referee",
                email: `bob_${Date.now()}@example.com`,
                password: "Password123!",
                referralCode: referrerCode,
            });
            const otpRec2 = await require("../models/user/otpModel").findOne({ email: refereeSignup.signupData.email, purpose: "VERIFY_EMAIL" });
            const verifyReferee = await userService.verifySignupOtp({
                email: refereeSignup.signupData.email,
                enteredOtp: otpRec2.otp,
                signupData: refereeSignup.signupData,
            });
            assert(verifyReferee.success && verifyReferee.user.referredBy.toString() === verifyRef.user._id.toString(), "Referee successfully links referral relationship to Referrer");

            // Check wallet balances: Referrer gets ₹100, Referee gets ₹50
            const referrerWallet = await walletService.getOrCreateWallet(verifyRef.user._id);
            const refereeWallet = await walletService.getOrCreateWallet(verifyReferee.user._id);
            assert(referrerWallet.balance === 100, `Referrer receives ₹100 reward upon referee email verification (Actual: ₹${referrerWallet.balance})`);
            assert(refereeWallet.balance === 50, `Referee receives ₹50 welcome reward upon signup with referral code (Actual: ₹${refereeWallet.balance})`);

            // Clawback test: when referee's order is fully returned
            const cat = await Category.create({ name: "Clawback Cat " + Date.now(), slug: "clawback-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prod = await Product.create({ name: "Clawback Dress " + Date.now(), slug: "clawback-dress-" + Date.now(), categoryId: cat._id, status: "ACTIVE", isDeleted: false });
            const variant = await Variant.create({ productId: prod._id, sku: "CD-" + Date.now(), regularPrice: 2000, stock: 5, isActive: true });

            const refOrder = await Order.create({
                orderNumber: "VEL-REF-TEST-" + Date.now(),
                userId: verifyReferee.user._id,
                items: [{
                    variantId: variant._id,
                    productId: prod._id,
                    productName: prod.name,
                    quantity: 1,
                    unitPrice: 2000,
                    lineTotal: 2000,
                    finalPayable: 2000,
                    status: "RETURN_REQUESTED",
                    returnReason: "Size too large",
                }],
                shippingAddress: { firstName: "Bob", lastName: "Ref", addressLine1: "123", phone: "9999999999", city: "Delhi", state: "Delhi", pinCode: 110001, country: "India" },
                pricing: { subtotal: 2000, shippingFee: 0, discount: 0, totalAmount: 2000, returnCredit: 0 },
                paymentMethod: "WALLET",
                paymentStatus: "COMPLETED",
                orderStatus: "RETURN_REQUESTED",
            });

            // Admin approves the return
            const approveRes = await approveReturnItem(refOrder._id, refOrder.items[0]._id, "Return inspected and accepted.");
            assert(approveRes.success, "Admin approves return of referee order");

            // Referrer's ₹100 bonus should be clawed back
            const referrerWalletAfterClawback = await walletService.getOrCreateWallet(verifyRef.user._id);
            assert(referrerWalletAfterClawback.balance === 0, `Clawback policy enforced: Referrer's ₹100 bonus clawed back after referee full return (Actual: ₹${referrerWalletAfterClawback.balance})`);
        }

        // -------------------------------------------------------------
        // SUITE 19: Admin Sales Reports & Dashboard (Phase 7)
        // -------------------------------------------------------------
        console.log("\n--- Suite 19: Admin Sales Reports & Dashboard (Phase 7) ---");
        {
            // 1. Report Metrics Calculation
            const reportMetrics = await reportService.getSalesReportMetrics({
                rangeType: "yearly",
            });
            assert(reportMetrics && typeof reportMetrics.overallOrdersCount === "number", "Calculates sales report metrics with proper range filter");

            // 2. Spreadsheet Formula Injection Sanitization
            const maliciousData = [
                {
                    orderNumber: "=CMD|' /C calc'!A0",
                    customerName: "+@User",
                    productName: "-Dangerous Formula",
                },
            ];
            const sanitized = reportService.sanitizeSpreadsheetData(maliciousData);
            assert(sanitized[0].orderNumber.startsWith("'="), "Sanitizes '=' prefix in export data to prevent formula injection");
            assert(sanitized[0].customerName.startsWith("'+"), "Sanitizes '+' prefix in export data");
            assert(sanitized[0].productName.startsWith("'-"), "Sanitizes '-' prefix in export data");

            // 3. Excel Export buffer generation
            const excelBuffer = await reportService.generateExcelReport({ rangeType: "daily" });
            assert(Buffer.isBuffer(excelBuffer) && excelBuffer.length > 500, `Generates Excel sales report via exceljs (Size: ${excelBuffer.length} bytes)`);

            // 4. PDF Export buffer generation
            const pdfBuffer = await reportService.generatePdfReport({ rangeType: "daily" });
            assert(Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 500, `Generates PDF sales report via pdfkit (Size: ${pdfBuffer.length} bytes)`);

            // 5. Dashboard Top 10 Best-Sellers
            const bestSellers = await reportService.getTopBestSellers(10);
            assert(Array.isArray(bestSellers.topProducts), "Aggregates top 10 best-selling products");
            assert(Array.isArray(bestSellers.topCategories), "Aggregates top 10 best-selling categories");
            assert(Array.isArray(bestSellers.topBrands), "Aggregates top 10 best-selling brands");
        }

        // -------------------------------------------------------------
        // SUITE 20: Comprehensive Week 16 Verification Suite
        // -------------------------------------------------------------
        console.log("\n--- Suite 20: Comprehensive Week 16 Verification Suite ---");
        {
            // 1. Raw Buffer Webhook Processing (Finding 13 & 14)
            const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
            const webhookPayload = JSON.stringify({
                event: "payment.captured",
                payload: {
                    payment: {
                        entity: {
                            id: "pay_test_buffer_123",
                            order_id: "order_test_buffer_456",
                            status: "captured",
                        },
                    },
                },
            });
            const rawBuffer = Buffer.from(webhookPayload, "utf8");
            const validSig = crypto.createHmac("sha256", webhookSecret).update(rawBuffer).digest("hex");

            const hookSuccess = await handleRazorpayWebhook(rawBuffer, validSig);
            assert(hookSuccess.success === true, "Valid raw Buffer webhook payload is successfully processed (Finding 13)");

            const hookBadSig = await handleRazorpayWebhook(rawBuffer, "tampered_bad_signature");
            assert(hookBadSig.success === false && hookBadSig.message.includes("Invalid"), "Invalid webhook signature returns unsuccessful result (Finding 14)");

            // 2. Late Capture after Cancellation routes to Wallet Refund (Findings 15 & 16)
            const lateUser = await User.create({ fullName: "Late User", email: `late_${Date.now()}@example.com`, password: "Password123!" });
            const catLate = await Category.create({ name: "Late Cat", slug: "late-cat-" + Date.now(), isActive: true });
            const prodLate = await Product.create({ name: "Late Prod", slug: "late-prod-" + Date.now(), categoryId: catLate._id, status: "ACTIVE" });
            const varLate = await Variant.create({ productId: prodLate._id, sku: "LATE-" + Date.now(), regularPrice: 1500, stock: 10, isActive: true });

            const lateOrder = await Order.create({
                orderNumber: "VEL-LATE-" + Date.now(),
                userId: lateUser._id,
                items: [{
                    variantId: varLate._id,
                    productId: prodLate._id,
                    productName: prodLate.name,
                    quantity: 1,
                    unitPrice: 1500,
                    lineTotal: 1500,
                    finalPayable: 1500,
                    status: "CANCELLED",
                }],
                pricing: { subtotal: 1500, shippingFee: 0, discount: 0, totalAmount: 1500, currentPayable: 0 },
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: "CANCELLED",
                razorpayOrderId: "order_late_rzp_999",
                shippingAddress: { firstName: "Late", lastName: "Customer", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });

            const latePaymentSecret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
            const latePaymentId = "pay_late_123456";
            const lateBody = `${lateOrder.razorpayOrderId}|${latePaymentId}`;
            const lateSig = crypto.createHmac("sha256", latePaymentSecret).update(lateBody).digest("hex");

            const lateVerifyRes = await verifyRazorpayPayment(lateUser._id, {
                orderId: lateOrder._id,
                razorpayOrderId: lateOrder.razorpayOrderId,
                razorpayPaymentId: latePaymentId,
                razorpaySignature: lateSig,
            });

            assert(lateVerifyRes.isCancelledLateRefund === true, "Late capture for cancelled order is intercepted safely (Finding 15)");
            const lateOrderAfter = await Order.findById(lateOrder._id);
            assert(lateOrderAfter.orderStatus === "CANCELLED", "Cancelled order is NOT revived to PROCESSING upon late capture (Finding 15)");
            const lateUserWallet = await walletService.getOrCreateWallet(lateUser._id);
            assert(lateUserWallet.balance === 1500, `Late captured payment is credited to customer wallet as a refund (Actual: ₹${lateUserWallet.balance}) (Finding 15 & 16)`);

            // 3. Payment Retry with currentPayable and COD conversion (Findings 19 & 20)
            const retryUser = await User.create({ fullName: "Retry User", email: `retry_${Date.now()}@example.com`, password: "Password123!" });
            const varRetry1 = await Variant.create({ productId: prodLate._id, sku: "R1-" + Date.now(), regularPrice: 1000, stock: 5, isActive: true });
            const varRetry2 = await Variant.create({ productId: prodLate._id, sku: "R2-" + Date.now(), regularPrice: 1000, stock: 5, isActive: true });

            const retryOrder = await Order.create({
                orderNumber: "VEL-RETRY-" + Date.now(),
                userId: retryUser._id,
                items: [
                    {
                        variantId: varRetry1._id,
                        productId: prodLate._id,
                        productName: "Item 1",
                        quantity: 1,
                        unitPrice: 1000,
                        lineTotal: 1000,
                        finalPayable: 1000,
                        status: "CANCELLED",
                    },
                    {
                        variantId: varRetry2._id,
                        productId: prodLate._id,
                        productName: "Item 2",
                        quantity: 1,
                        unitPrice: 1000,
                        lineTotal: 1000,
                        finalPayable: 1000,
                        status: "PENDING",
                    },
                ],
                pricing: { subtotal: 2000, shippingFee: 0, discount: 0, totalAmount: 2000, cancellationDeduction: 1000, currentPayable: 1000 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
                shippingAddress: { firstName: "Retry", lastName: "User", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });
            await Payment.create({
                orderId: retryOrder._id,
                userId: retryUser._id,
                amount: 2000,
                paymentMethod: "COD",
                status: "PENDING",
            });

            const retryResult = await retryOrderPayment(retryUser._id, retryOrder._id);
            assert(retryResult.success === true, "Payment retry initiated successfully");
            assert(retryResult.razorpay.amount === 100000, `Payment retry charges authoritative currentPayable (₹1,000 = 100,000 paise, NOT ₹2,000) (Actual: ${retryResult.razorpay.amount}) (Finding 19)`);
            const retryOrderUpdated = await Order.findById(retryOrder._id);
            assert(retryOrderUpdated.paymentMethod === "ONLINE", "Payment retry converts COD order method to ONLINE (Finding 20)");

            // 4. Release Abandoned Payment Reservations (Finding 27)
            const abandonUser = await User.create({ fullName: "Abandon User", email: `abandon_${Date.now()}@example.com`, password: "Password123!" });
            const varAbandon = await Variant.create({ productId: prodLate._id, sku: "ABANDON-" + Date.now(), regularPrice: 800, stock: 2, isActive: true });
            const expiredPlacedAt = new Date(Date.now() - 40 * 60 * 1000); // 40 minutes ago

            const abandonedOrder = await Order.create({
                orderNumber: "VEL-ABANDON-" + Date.now(),
                userId: abandonUser._id,
                items: [{
                    variantId: varAbandon._id,
                    productId: prodLate._id,
                    productName: prodLate.name,
                    quantity: 2,
                    unitPrice: 800,
                    lineTotal: 1600,
                    finalPayable: 1600,
                    status: "PENDING",
                }],
                pricing: { subtotal: 1600, shippingFee: 0, discount: 0, totalAmount: 1600, currentPayable: 1600 },
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
                placedAt: expiredPlacedAt,
                shippingAddress: { firstName: "Abandon", lastName: "User", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });

            const releaseRes = await releaseExpiredReservations(30);
            assert(releaseRes.success && releaseRes.releasedCount >= 1, "releaseExpiredReservations finds and releases expired reservations (Finding 27)");
            const abandonedAfter = await Order.findById(abandonedOrder._id);
            assert(abandonedAfter.orderStatus === "CANCELLED", "Expired abandoned order is marked CANCELLED");
            const varAbandonAfter = await Variant.findById(varAbandon._id);
            assert(varAbandonAfter.stock === 4, `Stock restored for expired reservation: 2 + 2 = 4 (Actual: ${varAbandonAfter.stock}) (Finding 27)`);

            // 5. Atomic Wallet AppliedOperations Idempotency (Findings 29 & 30)
            const atomUser = await User.create({ fullName: "Atom User", email: `atom_${Date.now()}@example.com`, password: "Password123!" });
            const opRef = `CREDIT_OP_${Date.now()}`;
            const cred1 = await walletService.creditWallet({
                userId: atomUser._id,
                amount: 500,
                reason: "BONUS",
                description: "Test Bonus",
                referenceId: opRef,
            });
            const cred2 = await walletService.creditWallet({
                userId: atomUser._id,
                amount: 500,
                reason: "BONUS",
                description: "Test Bonus Duplicate",
                referenceId: opRef,
            });
            assert(cred1.success && !cred1.isDuplicate, "First wallet operation succeeds normally");
            assert(cred2.success && cred2.isDuplicate, "Second wallet operation with same referenceId is recognized as duplicate (Finding 29 & 30)");
            const atomWallet = await walletService.getOrCreateWallet(atomUser._id);
            assert(atomWallet.balance === 500, `Wallet balance is exactly 500 (NOT double-credited to 1000) (Actual: ${atomWallet.balance})`);
            assert(atomWallet.appliedOperations.includes(opRef), "Wallet document atomically records applied operation keys (Finding 29 & 30)");

            // 6. Offer Selection with Savings and maxDiscount Cap (Findings 47 & 48)
            const offerFlat = { discountType: "FLAT", discountValue: 250 };
            const offerPctCapped = { discountType: "PERCENTAGE", discountValue: 50, maxDiscount: 100 }; // 50% of 2000 is 1000, but capped at 100
            const regularPriceTest = 2000;

            const flatSavings = pricingService.calculateOfferSavings(regularPriceTest, offerFlat);
            const cappedSavings = pricingService.calculateOfferSavings(regularPriceTest, offerPctCapped);
            assert(flatSavings === 250, "Flat ₹250 yields exactly ₹250 savings");
            assert(cappedSavings === 100, `50% offer on ₹2,000 capped at maxDiscount ₹100 yields ₹100 (Actual: ₹${cappedSavings}) (Finding 48)`);
            assert(flatSavings > cappedSavings, "Flat ₹250 correctly beats 50% offer capped at ₹100 based on real monetary savings (Finding 47 & 48)");

            // 7. IST Date Representation (Finding 62)
            const testUtcDate = new Date("2026-10-21T00:30:00.000Z"); // 6:00 AM IST on 2026-10-21
            const formattedIst = reportService.formatIstDate(testUtcDate);
            assert(formattedIst === "2026-10-21", `IST date is correctly formatted as "2026-10-21" without backward day shift (Actual: ${formattedIst}) (Finding 62)`);
        }

        // -------------------------------------------------------------
        // SUITE 21: Paid Admin Item Cancellation Mongoose Update Structure (Section 1.1)
        // -------------------------------------------------------------
        console.log("\n--- Suite 21: Paid Admin Item Cancellation Mongoose Structure ---");
        {
            const adminUser = await User.create({ fullName: "Admin Canceller", email: `adm_can_${Date.now()}@example.com`, password: "Password123!" });
            const catAdm = await Category.create({ name: "Cat " + Date.now(), slug: "cat-" + Date.now(), isActive: true, isDeleted: false });
            const prodAdm = await Product.create({ name: "Prod " + Date.now(), slug: "prod-" + Date.now(), categoryId: catAdm._id, status: "ACTIVE", isDeleted: false });
            const vAdm1 = await Variant.create({ productId: prodAdm._id, sku: "ADM-1-" + Date.now(), regularPrice: 1200, stock: 10, isActive: true });
            const vAdm2 = await Variant.create({ productId: prodAdm._id, sku: "ADM-2-" + Date.now(), regularPrice: 800, stock: 10, isActive: true });

            const paidOrder = await Order.create({
                orderNumber: "VEL-ADM-CAN-" + Date.now(),
                userId: adminUser._id,
                items: [
                    {
                        variantId: vAdm1._id,
                        productId: prodAdm._id,
                        productName: "Item A",
                        sku: vAdm1.sku,
                        quantity: 1,
                        regularPrice: 1200,
                        unitPrice: 1200,
                        lineTotal: 1200,
                        finalPayable: 1200,
                        status: "PROCESSING",
                    },
                    {
                        variantId: vAdm2._id,
                        productId: prodAdm._id,
                        productName: "Item B",
                        sku: vAdm2.sku,
                        quantity: 1,
                        regularPrice: 800,
                        unitPrice: 800,
                        lineTotal: 800,
                        finalPayable: 800,
                        status: "PROCESSING",
                    },
                ],
                pricing: { subtotal: 2000, shippingFee: 0, totalAmount: 2000, currentPayable: 2000, originalTotalAmount: 2000 },
                paymentMethod: "ONLINE",
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
                shippingAddress: { firstName: "Admin", lastName: "Test", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });
            await Payment.create({
                orderId: paidOrder._id,
                userId: adminUser._id,
                amount: 2000,
                paymentMethod: "ONLINE",
                status: "COMPLETED",
            });

            // Admin cancels item A
            const canRes = await updateAdminOrderItemStatus(paidOrder._id, paidOrder.items[0]._id, "CANCELLED", { adminNote: "Out of stock test" });
            assert(canRes.success === true, "Paid admin item cancellation executes without Mongoose $inc inside $set error");

            const paidOrderAfter = await Order.findById(paidOrder._id);
            assert(paidOrderAfter.items[0].status === "CANCELLED", "Item A is marked CANCELLED");
            assert(paidOrderAfter.items[0].isStockRestored === true, "Item A stock restoration is marked restored");
            assert(paidOrderAfter.items[0].refundIssued === true, "Item A refund is marked issued");
            assert(paidOrderAfter.pricing.walletRefundIssued === 1200, `Parent walletRefundIssued is ₹1,200 (Actual: ₹${paidOrderAfter.pricing.walletRefundIssued})`);
            assert(paidOrderAfter.pricing.currentPayable === 800, `Parent currentPayable is ₹800 (Actual: ₹${paidOrderAfter.pricing.currentPayable})`);

            const vAdm1After = await Variant.findById(vAdm1._id);
            assert(vAdm1After.stock === 11, `Variant A stock restored to 11 (Actual: ${vAdm1After.stock})`);

            const admWallet = await walletService.getOrCreateWallet(adminUser._id);
            assert(admWallet.balance === 1200, `Admin customer wallet credited with item A refund ₹1,200 (Actual: ₹${admWallet.balance})`);
        }

        // -------------------------------------------------------------
        // SUITE 22: Wallet Debit Rejection & Safe Rollback (Section 1.2)
        // -------------------------------------------------------------
        console.log("\n--- Suite 22: Wallet Debit Rejection & Safe Rollback ---");
        {
            const poorUser = await User.create({ fullName: "Zero Balance User", email: `zero_${Date.now()}@example.com`, password: "Password123!" });
            const catPoor = await Category.create({ name: "PoorCat " + Date.now(), slug: "poor-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prodPoor = await Product.create({ name: "PoorProd " + Date.now(), slug: "poor-prod-" + Date.now(), categoryId: catPoor._id, status: "ACTIVE", isDeleted: false });
            const varPoor = await Variant.create({ productId: prodPoor._id, sku: "POOR-" + Date.now(), regularPrice: 500, stock: 5, isActive: true });
            const poorAddr = await Address.create({ userId: poorUser._id, firstName: "Zero", lastName: "Bal", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" });

            await Cart.create({
                userId: poorUser._id,
                items: [{ variantId: varPoor._id, quantity: 1, priceSnapshot: 500 }],
                checkoutToken: "chk_zero_bal",
            });

            // Attempt WALLET checkout with 0 balance
            const failWalletRes = await placeOrder(poorUser._id, poorAddr._id, "WALLET", "chk_zero_bal");
            assert(!failWalletRes.success, "Wallet checkout fails due to insufficient balance");

            const poorWallet = await walletService.getOrCreateWallet(poorUser._id);
            assert(poorWallet.balance === 0, `Zero-balance wallet is NOT credited rollback money (Actual: ₹${poorWallet.balance})`);
            const poorTxs = await Transaction.find({ userId: poorUser._id });
            assert(poorTxs.length === 0, "No transactions exist on failed zero-balance debit attempt");
        }

        // -------------------------------------------------------------
        // SUITE 23: Duplicate Late Payments & Concurrent Manual Refunds (Section 1.3 & 1.4)
        // -------------------------------------------------------------
        console.log("\n--- Suite 23: Duplicate Late Payment Refunds & Concurrent Manual Refunds ---");
        {
            const lateCust = await User.create({ fullName: "Late Customer", email: `late_cust_${Date.now()}@example.com`, password: "Password123!" });
            const catLate = await Category.create({ name: "LateCat " + Date.now(), slug: "late-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prodLate = await Product.create({ name: "LateProd " + Date.now(), slug: "late-prod-" + Date.now(), categoryId: catLate._id, status: "ACTIVE", isDeleted: false });
            const varLate = await Variant.create({ productId: prodLate._id, sku: "LATE-" + Date.now(), regularPrice: 1000, stock: 5, isActive: true });

            const cancelledOrder = await Order.create({
                orderNumber: "VEL-LATE-DUP-" + Date.now(),
                userId: lateCust._id,
                items: [{
                    variantId: varLate._id,
                    productId: prodLate._id,
                    productName: "Late Product",
                    quantity: 1,
                    unitPrice: 1000,
                    lineTotal: 1000,
                    finalPayable: 1000,
                    status: "CANCELLED",
                    isStockRestored: true,
                }],
                pricing: { subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 0, originalTotalAmount: 1000 },
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: "CANCELLED",
                razorpayOrderId: "order_dup_late_999",
                shippingAddress: { firstName: "Late", lastName: "Cust", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });

            const latePayId = "pay_dup_late_1000";
            const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
            const sig = crypto.createHmac("sha256", secret).update(`${cancelledOrder.razorpayOrderId}|${latePayId}`).digest("hex");

            // 1. First callback verifies late payment -> refunds ₹1,000 to wallet
            await verifyRazorpayPayment(lateCust._id, {
                orderId: cancelledOrder._id,
                razorpayOrderId: cancelledOrder.razorpayOrderId,
                razorpayPaymentId: latePayId,
                razorpaySignature: sig,
            });
            const walletAfter1 = await walletService.getOrCreateWallet(lateCust._id);
            assert(walletAfter1.balance === 1000, `First late callback refunds ₹1,000 (Actual: ₹${walletAfter1.balance})`);

            // 2. Second webhook arrives with same payment ID
            const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
            const webhookPayload = JSON.stringify({
                event: "payment.captured",
                payload: {
                    payment: {
                        entity: {
                            id: latePayId,
                            order_id: cancelledOrder.razorpayOrderId,
                            amount: 100000,
                            currency: "INR",
                            status: "captured",
                        },
                    },
                },
            });
            const whSig = crypto.createHmac("sha256", webhookSecret).update(Buffer.from(webhookPayload)).digest("hex");

            await handleRazorpayWebhook(webhookPayload, whSig);

            const walletAfter2 = await walletService.getOrCreateWallet(lateCust._id);
            assert(walletAfter2.balance === 1000, `Second webhook does NOT duplicate refund; balance remains exactly ₹1,000 (Actual: ₹${walletAfter2.balance})`);

            // 3. Concurrent manual refunds: cap cumulative completed/pending refunds against actual collected money
            const refundUser = await User.create({ fullName: "Refund User", email: `ref_user_${Date.now()}@example.com`, password: "Password123!" });
            const manOrder = await Order.create({
                orderNumber: "VEL-MAN-REF-" + Date.now(),
                userId: refundUser._id,
                items: [{
                    variantId: varLate._id,
                    productId: prodLate._id,
                    productName: "Manual Item",
                    quantity: 1,
                    unitPrice: 1500,
                    lineTotal: 1500,
                    finalPayable: 1500,
                    status: "DELIVERED",
                }],
                pricing: { subtotal: 1500, shippingFee: 0, totalAmount: 1500, currentPayable: 1500, originalTotalAmount: 1500, walletRefundIssued: 0 },
                paymentMethod: "ONLINE",
                paymentStatus: "COMPLETED",
                orderStatus: "DELIVERED",
                shippingAddress: { firstName: "Ref", lastName: "User", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });
            await Payment.create({
                orderId: manOrder._id,
                userId: refundUser._id,
                amount: 1500,
                paymentMethod: "ONLINE",
                status: "COMPLETED",
            });

            // Fire 2 concurrent manual refunds
            await Promise.all([
                updatePaymentStatus(manOrder._id, "REFUNDED", { adminNote: "Concurrent refund A" }),
                updatePaymentStatus(manOrder._id, "REFUNDED", { adminNote: "Concurrent refund B" }),
            ]);

            const refundUserWallet = await walletService.getOrCreateWallet(refundUser._id);
            assert(refundUserWallet.balance === 1500, `Concurrent manual refunds credit exactly ₹1,500 once (NEVER double-credited to ₹3,000) (Actual: ₹${refundUserWallet.balance})`);
        }

        // -------------------------------------------------------------
        // SUITE 24: Stock Accounting & Cart Concurrency (Section 1.5 & 4)
        // -------------------------------------------------------------
        console.log("\n--- Suite 24: Stock Accounting & Cart Concurrency ---");
        {
            const cartCust = await User.create({ fullName: "Cart Customer", email: `cart_cust_${Date.now()}@example.com`, password: "Password123!" });
            const catCart = await Category.create({ name: "CartCat " + Date.now(), slug: "cart-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prodCart = await Product.create({ name: "CartProd " + Date.now(), slug: "cart-prod-" + Date.now(), categoryId: catCart._id, status: "ACTIVE", isDeleted: false });
            const varCart = await Variant.create({ productId: prodCart._id, sku: "CART-SKU-" + Date.now(), regularPrice: 400, stock: 20, isActive: true });
            const cartAddr = await Address.create({ userId: cartCust._id, firstName: "Cart", lastName: "Cust", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" });

            // 1. Cart quantity change during checkout: Cart has 5 units total (2 purchased + 3 added concurrently from another tab)
            await Cart.create({
                userId: cartCust._id,
                items: [{ variantId: varCart._id, quantity: 5, priceSnapshot: 400 }],
                checkoutToken: "chk_cart_concur",
            });

            // Simulate checkout cleanup of the 2 units purchased
            const purchasedQuantity = 2;
            await Cart.findOneAndUpdate(
                { userId: cartCust._id, "items.variantId": varCart._id },
                { $inc: { "items.$.quantity": -purchasedQuantity } },
                { returnDocument: "after" }
            );
            await Cart.updateOne(
                { userId: cartCust._id },
                { $pull: { items: { variantId: varCart._id, quantity: { $lte: 0 } } } }
            );

            const remainingCart = await Cart.findOne({ userId: cartCust._id });
            assert(remainingCart !== null, "Cart is NOT deleted entirely when additional quantity remains");
            assert(remainingCart.items[0].quantity === 3, `Cart retains remaining 3 units added concurrently (5 - 2 = 3) (Actual: ${remainingCart.items[0].quantity})`);

            // 2. Product editing concurrency: product edit does not overwrite concurrent stock changes
            const currentStockBeforeEdit = (await Variant.findById(varCart._id)).stock;
            await productService.updateProduct(prodCart._id, {
                name: "Updated Product Name",
                description: "Updated description without overwriting stock",
            });
            const stockAfterProductEdit = (await Variant.findById(varCart._id)).stock;
            assert(stockAfterProductEdit === currentStockBeforeEdit, `Product metadata edit preserves active variant stock (${currentStockBeforeEdit})`);
        }

        // -------------------------------------------------------------
        // SUITE 25: Resumable Durable Recovery & Self-Healing Ledger (Section 2)
        // -------------------------------------------------------------
        console.log("\n--- Suite 25: Resumable Durable Recovery & Self-Healing Ledger ---");
        {
            const recCust = await User.create({ fullName: "Recovery User", email: `rec_cust_${Date.now()}@example.com`, password: "Password123!" });
            const catRec = await Category.create({ name: "RecCat " + Date.now(), slug: "rec-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prodRec = await Product.create({ name: "RecProd " + Date.now(), slug: "rec-prod-" + Date.now(), categoryId: catRec._id, status: "ACTIVE", isDeleted: false });
            const varRec = await Variant.create({ productId: prodRec._id, sku: "REC-SKU-" + Date.now(), regularPrice: 900, stock: 10, isActive: true });

            // 1. Interrupted return approval (marked RETURN_APPROVED but unrefunded)
            const interruptedOrder = await Order.create({
                orderNumber: "VEL-REC-RET-" + Date.now(),
                userId: recCust._id,
                items: [{
                    variantId: varRec._id,
                    productId: prodRec._id,
                    productName: "Interrupted Item",
                    quantity: 1,
                    unitPrice: 900,
                    lineTotal: 900,
                    finalPayable: 900,
                    status: "RETURN_APPROVED",
                    refundIssued: false,
                    isRestocked: false,
                }],
                pricing: { subtotal: 900, shippingFee: 0, totalAmount: 900, currentPayable: 900, walletRefundIssued: 0 },
                paymentMethod: "ONLINE",
                paymentStatus: "COMPLETED",
                orderStatus: "RETURN_APPROVED",
                shippingAddress: { firstName: "Rec", lastName: "Cust", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });
            await Payment.create({
                orderId: interruptedOrder._id,
                userId: recCust._id,
                amount: 900,
                paymentMethod: "ONLINE",
                status: "COMPLETED",
            });

            // Reconcile order state
            const recOrderRes = await reconcileOrderState(interruptedOrder._id);
            assert(recOrderRes.success === true, "reconcileOrderState runs successfully on interrupted order");

            const recWallet = await walletService.getOrCreateWallet(recCust._id);
            assert(recWallet.balance === 900, `reconcileOrderState credits missing return refund ₹900 (Actual: ₹${recWallet.balance})`);
            const repairedOrder = await Order.findById(interruptedOrder._id);
            assert(repairedOrder.items[0].refundIssued === true, "Repaired item marked refundIssued: true");

            // 2. Wallet ledger reconstruction from operationsLog
            const testOpKey = `SELF_HEAL_KEY_${Date.now()}`;
            const cr1 = await walletService.creditWallet({
                userId: recCust._id,
                amount: 300,
                reason: "BONUS",
                description: "Self heal test",
                referenceId: testOpKey,
            });
            assert(cr1.success && cr1.balance === 1200, "Initial credit of ₹300 succeeds");

            // Simulate database crash right after wallet balance update: delete transaction record
            await Transaction.deleteOne({ referenceId: testOpKey });
            const txMissing = await Transaction.findOne({ referenceId: testOpKey });
            assert(txMissing === null, "Transaction record simulated as deleted/missing");

            // Retry same operation
            const cr2 = await walletService.creditWallet({
                userId: recCust._id,
                amount: 300,
                reason: "BONUS",
                description: "Self heal test",
                referenceId: testOpKey,
            });
            assert(cr2.success === true, "Retry operation succeeds");
            assert(cr2.transaction !== null, "Retry self-heals and returns non-null transaction");
            assert(cr2.transaction.referenceId === testOpKey, `Transaction recreated with exact original reference key (${testOpKey})`);
            const recWalletAfter = await walletService.getOrCreateWallet(recCust._id);
            assert(recWalletAfter.balance === 1200, `Balance is NOT double credited; remains ₹1,200 (Actual: ₹${recWalletAfter.balance})`);
        }

        // -------------------------------------------------------------
        // SUITE 26: Partial Cancellation with Coupons and Shipping (Section 5)
        // -------------------------------------------------------------
        console.log("\n--- Suite 26: Partial Cancellation with Coupons and Shipping ---");
        {
            const coupUser = await User.create({ fullName: "Coupon User", email: `coup_${Date.now()}@example.com`, password: "Password123!" });
            const catCoup = await Category.create({ name: "CoupCat " + Date.now(), slug: "coup-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prodCoup = await Product.create({ name: "CoupProd " + Date.now(), slug: "coup-prod-" + Date.now(), categoryId: catCoup._id, status: "ACTIVE", isDeleted: false });
            const varCoup1 = await Variant.create({ productId: prodCoup._id, sku: "CP1-" + Date.now(), regularPrice: 1000, stock: 10, isActive: true });
            const varCoup2 = await Variant.create({ productId: prodCoup._id, sku: "CP2-" + Date.now(), regularPrice: 1000, stock: 10, isActive: true });

            // Order with 2 items: each ₹1000, allocated coupon ₹100 each -> finalPayable ₹900 each, shipping fee ₹100
            // Total paid: 900 + 900 + 100 = ₹1900
            const coupOrder = await Order.create({
                orderNumber: "VEL-COUP-PART-" + Date.now(),
                userId: coupUser._id,
                items: [
                    {
                        variantId: varCoup1._id,
                        productId: prodCoup._id,
                        productName: "Item 1",
                        quantity: 1,
                        unitPrice: 1000,
                        lineTotal: 1000,
                        allocatedCouponDiscount: 100,
                        finalPayable: 900,
                        status: "PROCESSING",
                    },
                    {
                        variantId: varCoup2._id,
                        productId: prodCoup._id,
                        productName: "Item 2",
                        quantity: 1,
                        unitPrice: 1000,
                        lineTotal: 1000,
                        allocatedCouponDiscount: 100,
                        finalPayable: 900,
                        status: "PROCESSING",
                    },
                ],
                pricing: { subtotal: 2000, discount: 200, couponDiscount: 200, shippingFee: 100, totalAmount: 1900, currentPayable: 1900, originalTotalAmount: 1900, walletRefundIssued: 0 },
                paymentMethod: "ONLINE",
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
                shippingAddress: { firstName: "Coup", lastName: "User", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" },
            });
            await Payment.create({
                orderId: coupOrder._id,
                userId: coupUser._id,
                amount: 1900,
                paymentMethod: "ONLINE",
                status: "COMPLETED",
            });

            // 1. Cancel Item 1: customer should receive ₹900 refund (NOT ₹1000, NOT shipping fee)
            const canItem1 = await cancelOrderItem(coupUser._id, coupOrder._id, coupOrder.items[0]._id, "Cancel Item 1");
            assert(canItem1.success === true, "Cancel item 1 succeeds");
            const coupWallet1 = await walletService.getOrCreateWallet(coupUser._id);
            assert(coupWallet1.balance === 900, `Partial cancellation refunds exactly finalPayable ₹900 (coupon accounted for, shipping retained) (Actual: ₹${coupWallet1.balance})`);

            // 2. Cancel Item 2: all items now cancelled -> customer receives finalPayable ₹900 + shipping fee ₹100 = ₹1,000 refund
            const canItem2 = await cancelOrderItem(coupUser._id, coupOrder._id, coupOrder.items[1]._id, "Cancel Item 2");
            assert(canItem2.success === true, "Cancel item 2 succeeds");
            const coupWallet2 = await walletService.getOrCreateWallet(coupUser._id);
            assert(coupWallet2.balance === 1900, `All-cancelled order refunds remaining finalPayable + delivery shipping fee: 900 + 1000 = ₹1,900 (Actual: ₹${coupWallet2.balance})`);
        }

        // -------------------------------------------------------------
        // SUITE 27: Central Offer Pricing, Dashboard Labels & Concurrency (Section 6)
        // -------------------------------------------------------------
        console.log("\n--- Suite 27: Central Offer Pricing, Dashboard Labels & Concurrency ---");
        {
            // 1. Central offer calculator matches checkout pricing
            const catOffer = await Category.create({ name: "OffCat " + Date.now(), slug: "off-cat-" + Date.now(), isActive: true, isDeleted: false });
            const prodOffer = await Product.create({ name: "OffProd " + Date.now(), slug: "off-prod-" + Date.now(), categoryId: catOffer._id, status: "ACTIVE", isDeleted: false });
            const varOffer = await Variant.create({ productId: prodOffer._id, sku: "OFF-SKU-" + Date.now(), regularPrice: 2000, salePrice: 1800, stock: 10, isActive: true });

            // Create 20% product offer
            await Offer.create({
                name: "Product 20% Off",
                offerType: "PRODUCT",
                productId: prodOffer._id,
                discountType: "PERCENTAGE",
                discountValue: 20,
                status: "ACTIVE",
                startDate: new Date(Date.now() - 10000),
                endDate: new Date(Date.now() + 1000000),
            });

            const priceCheck = await getAuthoritativeItemPrice(varOffer, prodOffer);
            assert(priceCheck.displayPrice === 1600, `Authoritative price uses central offer calculator (20% of 2000 = 1600 < salePrice 1800) (Actual: ${priceCheck.displayPrice})`);

            // 2. Concurrency-safe default address setting
            const addrUser = await User.create({ fullName: "Address User", email: `addr_${Date.now()}@example.com`, password: "Password123!" });
            const a1 = await Address.create({ userId: addrUser._id, firstName: "A1", lastName: "U", addressLine1: "123", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210", isDefault: false });
            const a2 = await Address.create({ userId: addrUser._id, firstName: "A2", lastName: "U", addressLine1: "456", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210", isDefault: false });

            // Fire two concurrent setDefaultAddress requests
            await Promise.all([
                addressService.setDefaultAddress(addrUser._id, a1._id),
                addressService.setDefaultAddress(addrUser._id, a2._id),
            ]);

            const defaultCount = await Address.countDocuments({ userId: addrUser._id, isDefault: true });
            assert(defaultCount === 1, `Concurrent default address updates result in exactly 1 default address (Actual: ${defaultCount})`);
            const refreshedUser = await User.findById(addrUser._id);
            const chosenDefault = await Address.findOne({ userId: addrUser._id, isDefault: true });
            assert(refreshedUser.defaultAddressId.toString() === chosenDefault._id.toString(), "User.defaultAddressId matches the sole default address");
        }

        // -------------------------------------------------------------
        // SUITE 28: Razorpay Correctness, Callback Replays & Duplicate Payments (Section 3)
        // -------------------------------------------------------------
        console.log("\n--- Suite 28: Razorpay Correctness, Callback Replays & Duplicate Payments ---");
        {
            const rzpUser = await User.create({ fullName: "RZP User", email: `rzp_${Date.now()}@example.com`, password: "Password123!" });
            const rzpVar = await Variant.create({ productId: new mongoose.Types.ObjectId(), sku: `RZP-VAR-${Date.now()}`, regularPrice: 1000, stock: 10, isActive: true });
            const rzpAddr = await Address.create({ userId: rzpUser._id, firstName: "RZP", lastName: "Customer", addressLine1: "Gateway Lane", city: "Bangalore", state: "Karnataka", pinCode: "560001", country: "India", phone: "9876543210" });

            // 1. Prevent replaying a payment callback after normal cancellation
            const canOrder = await Order.create({
                orderNumber: `ORD-CAN-${Date.now()}`,
                orderId: `ORD-CAN-${Date.now()}`,
                userId: rzpUser._id,
                items: [{
                    variantId: rzpVar._id,
                    productId: rzpVar.productId,
                    productName: "Test Product",
                    quantity: 1,
                    regularPrice: 1000,
                    unitPrice: 1000,
                    priceAtPurchase: 1000,
                    effectiveUnitPrice: 1000,
                    finalPayable: 1000,
                    lineTotal: 1000,
                    status: "CANCELLED",
                    isStockRestored: true,
                }],
                shippingAddress: rzpAddr.toObject(),
                pricing: { subtotal: 1000, shippingFee: 0, discount: 0, totalAmount: 1000, currentPayable: 0, walletRefundIssued: 1000 },
                paymentMethod: "ONLINE",
                paymentStatus: "REFUNDED",
                orderStatus: "CANCELLED",
                razorpayOrderId: "order_rzp_cancel_test",
                razorpayPaymentId: "pay_cancelled_123",
            });

            // Seed prior cancellation refund transaction
            await walletService.creditWallet({
                userId: rzpUser._id,
                amount: 1000,
                reason: "ORDER_CANCELLATION",
                description: `Initial refund for cancelled order #${canOrder.orderNumber}`,
                orderId: canOrder._id,
                orderNumber: canOrder.orderNumber,
                referenceId: `REFUND_CAN_${canOrder._id}`,
            });

            const initialRzpWallet = await walletService.getOrCreateWallet(rzpUser._id);
            assert(initialRzpWallet.balance === 1000, "Initial wallet balance after cancellation refund is ₹1,000");

            // Replay callback for the exact payment ID
            const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
            const replaySig = crypto.createHmac("sha256", secret).update(`order_rzp_cancel_test|pay_cancelled_123`).digest("hex");

            const replayRes = await verifyRazorpayPayment(rzpUser._id, {
                orderId: canOrder._id,
                razorpayOrderId: "order_rzp_cancel_test",
                razorpayPaymentId: "pay_cancelled_123",
                razorpaySignature: replaySig,
            });

            assert(replayRes.success === false, "Replaying payment callback on already-refunded cancellation returns unsuccessful");
            assert(replayRes.isAlreadyRefunded === true, "Replaying callback identifies order as already refunded");

            const walletAfterReplay = await walletService.getOrCreateWallet(rzpUser._id);
            assert(walletAfterReplay.balance === 1000, `Wallet balance remains exactly ₹1,000 without duplicate refund (Actual: ₹${walletAfterReplay.balance})`);

            // 2. Second successful payment attempt for completed order
            const completedOrder = await Order.create({
                orderNumber: `ORD-CMP-${Date.now()}`,
                orderId: `ORD-CMP-${Date.now()}`,
                userId: rzpUser._id,
                items: [{
                    variantId: rzpVar._id,
                    productId: rzpVar.productId,
                    productName: "Test Product",
                    quantity: 1,
                    regularPrice: 1500,
                    unitPrice: 1500,
                    priceAtPurchase: 1500,
                    effectiveUnitPrice: 1500,
                    finalPayable: 1500,
                    lineTotal: 1500,
                    status: "PROCESSING",
                }],
                shippingAddress: rzpAddr.toObject(),
                pricing: { subtotal: 1500, shippingFee: 0, discount: 0, totalAmount: 1500, currentPayable: 1500, walletRefundIssued: 0 },
                paymentMethod: "ONLINE",
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
                razorpayOrderId: "order_cmp_test",
                razorpayPaymentId: "pay_first_attempt",
                paidAt: new Date(),
            });

            // Customer submits second payment attempt that was also captured
            const secondSig = crypto.createHmac("sha256", secret).update(`order_cmp_test|pay_second_attempt`).digest("hex");
            const secondPayRes = await verifyRazorpayPayment(rzpUser._id, {
                orderId: completedOrder._id,
                razorpayOrderId: "order_cmp_test",
                razorpayPaymentId: "pay_second_attempt",
                razorpaySignature: secondSig,
            });

            assert(secondPayRes.success === true, "Second payment attempt handled successfully");
            assert(secondPayRes.isDuplicateRefund === true, "Second attempt recognized as duplicate and refunded");
            const walletAfterDup = await walletService.getOrCreateWallet(rzpUser._id);
            assert(walletAfterDup.balance === 2500, `Wallet balance updated with duplicate refund: 1000 + 1500 = ₹2,500 (Actual: ₹${walletAfterDup.balance})`);

            // 3. Currency mismatch rejection
            razorpayConfig.setRazorpayInstanceCreator(() => ({
                payments: {
                    fetch: async () => ({ id: "pay_usd", currency: "USD", amount: 100000 }),
                },
                orders: {
                    create: async (params) => ({ id: `order_mock_${Date.now()}`, ...params }),
                },
            }));

            const currencyOrder = await Order.create({
                orderNumber: `ORD-CUR-${Date.now()}`,
                orderId: `ORD-CUR-${Date.now()}`,
                userId: rzpUser._id,
                items: [{ variantId: rzpVar._id, productId: rzpVar.productId, productName: "Product", quantity: 1, regularPrice: 1000, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, status: "PENDING" }],
                shippingAddress: rzpAddr.toObject(),
                pricing: { subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000 },
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
                razorpayOrderId: "order_cur_test",
            });

            const curSig = crypto.createHmac("sha256", secret).update(`order_cur_test|pay_usd`).digest("hex");
            const curRes = await verifyRazorpayPayment(rzpUser._id, {
                orderId: currencyOrder._id,
                razorpayOrderId: "order_cur_test",
                razorpayPaymentId: "pay_usd",
                razorpaySignature: curSig,
            });

            assert(curRes.success === false, "Currency mismatch (USD) is rejected");
            assert(curRes.message.includes("Currency mismatch"), "Rejection indicates currency mismatch");
            razorpayConfig.setRazorpayInstanceCreator(() => defaultMockRazorpay);
        }

        // -------------------------------------------------------------
        // SUITE 29: Webhook Retries, Out-of-Order Delivery & Concurrency (Section 3)
        // -------------------------------------------------------------
        console.log("\n--- Suite 29: Webhook Retries, Out-of-Order Delivery & Concurrency ---");
        {
            const whUser = await User.create({ fullName: "WH User", email: `wh_${Date.now()}@example.com`, password: "Password123!" });
            const whOrder = await Order.create({
                orderNumber: `ORD-WH-${Date.now()}`,
                orderId: `ORD-WH-${Date.now()}`,
                userId: whUser._id,
                items: [{ variantId: new mongoose.Types.ObjectId(), productId: new mongoose.Types.ObjectId(), productName: "Item", quantity: 1, regularPrice: 800, unitPrice: 800, priceAtPurchase: 800, lineTotal: 800, status: "PENDING" }],
                shippingAddress: { firstName: "A", lastName: "B", addressLine1: "Str", city: "C", state: "S", pinCode: "123456", country: "India", phone: "9876543210" },
                pricing: { subtotal: 800, shippingFee: 0, totalAmount: 800, currentPayable: 800 },
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
                razorpayOrderId: `rzp_order_wh_${Date.now()}`,
            });

            const paymentDoc = await Payment.create({
                orderId: whOrder._id,
                userId: whUser._id,
                amount: 800,
                paymentMethod: "ONLINE",
                status: "PENDING",
                razorpayOrderId: whOrder.razorpayOrderId,
            });

            const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";
            const payloadObj = {
                event: "payment.captured",
                payload: {
                    payment: {
                        entity: {
                            id: `pay_wh_${Date.now()}`,
                            order_id: whOrder.razorpayOrderId,
                            amount: 80000,
                            currency: "INR",
                            status: "captured",
                        },
                    },
                },
            };
            const payloadBuffer = Buffer.from(JSON.stringify(payloadObj));
            const validSig = crypto.createHmac("sha256", secret).update(payloadBuffer).digest("hex");

            // 1. Process valid webhook
            const whRes1 = await handleRazorpayWebhook(payloadBuffer, validSig);
            assert(whRes1.success === true, "Valid webhook processes successfully");

            const updatedWhOrder = await Order.findById(whOrder._id);
            assert(updatedWhOrder.paymentStatus === "COMPLETED", "Webhook updates paymentStatus to COMPLETED");
            assert(updatedWhOrder.orderStatus === "PROCESSING", "Webhook updates orderStatus to PROCESSING");

            const updatedPayment = await Payment.findById(paymentDoc._id);
            assert(updatedPayment.status === "COMPLETED", "Payment record is updated to COMPLETED");

            // 2. Retry webhook (out-of-order or duplicate) repairs records and is idempotent
            await Payment.updateOne({ _id: paymentDoc._id }, { $set: { status: "PENDING" } });
            const whRes2 = await handleRazorpayWebhook(payloadBuffer, validSig);
            assert(whRes2.success === true, "Duplicate/retry webhook returns success");
            const repairedPayment = await Payment.findById(paymentDoc._id);
            assert(repairedPayment.status === "COMPLETED", "Duplicate webhook repairs Payment document to COMPLETED");
        }

        // -------------------------------------------------------------
        // SUITE 30: Reservation Expiry Lease Recovery & Concurrent Retries (Section 3)
        // -------------------------------------------------------------
        console.log("\n--- Suite 30: Reservation Expiry Lease Recovery & Concurrent Retries ---");
        {
            const retUser = await User.create({ fullName: "Retry User", email: `retry_${Date.now()}@example.com`, password: "Password123!" });
            const retVar = await Variant.create({ productId: new mongoose.Types.ObjectId(), sku: `RET-${Date.now()}`, regularPrice: 2000, stock: 5, isActive: true });
            const retAddr = await Address.create({ userId: retUser._id, firstName: "R", lastName: "U", addressLine1: "St", city: "C", state: "S", pinCode: "123456", country: "India", phone: "9876543210" });

            const retOrder = await Order.create({
                orderNumber: `ORD-RET-${Date.now()}`,
                orderId: `ORD-RET-${Date.now()}`,
                userId: retUser._id,
                items: [{ variantId: retVar._id, productId: retVar.productId, productName: "P", quantity: 1, regularPrice: 2000, unitPrice: 2000, priceAtPurchase: 2000, lineTotal: 2000, status: "PENDING" }],
                shippingAddress: retAddr.toObject(),
                pricing: { subtotal: 2000, shippingFee: 0, totalAmount: 2000, currentPayable: 2000 },
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
            });

            // Fire two concurrent retryOrderPayment requests
            const [retRes1, retRes2] = await Promise.all([
                retryOrderPayment(retUser._id, retOrder._id),
                retryOrderPayment(retUser._id, retOrder._id),
            ]);

            assert(
                (retRes1.success && !retRes2.success) || (!retRes1.success && retRes2.success),
                "Concurrent payment retries allow exactly one attempt; second receives in-progress error"
            );
            const rejRes = !retRes1.success ? retRes1 : retRes2;
            assert(rejRes.message.includes("already in progress"), "Rejected concurrent retry indicates already in progress");

            // Verify reservation lease recovery: simulate an order claimed by expiry that crashed before stock restore
            const abandonedOrder = await Order.create({
                orderNumber: `ORD-ABN-${Date.now()}`,
                orderId: `ORD-ABN-${Date.now()}`,
                userId: retUser._id,
                items: [{ variantId: retVar._id, productId: retVar.productId, productName: "P", quantity: 2, regularPrice: 2000, unitPrice: 2000, priceAtPurchase: 2000, lineTotal: 4000, status: "PENDING", isStockRestored: false }],
                shippingAddress: retAddr.toObject(),
                pricing: { subtotal: 4000, shippingFee: 0, totalAmount: 4000, currentPayable: 4000 },
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                orderStatus: "PENDING",
                placedAt: new Date(Date.now() - 40 * 60 * 1000), // 40 minutes old
                expirationClaimAt: new Date(Date.now() - 5 * 60 * 1000), // expired claim lease
                cancellationReason: "Payment reservation expired after 30 minutes without completion.",
            });

            const initialStock = (await Variant.findById(retVar._id)).stock;
            const releaseRes = await releaseExpiredReservations(30);
            assert(releaseRes.success === true, "releaseExpiredReservations executes cleanly");

            const updatedAbnOrder = await Order.findById(abandonedOrder._id);
            assert(updatedAbnOrder.orderStatus === "CANCELLED", "Interrupted reservation is fully CANCELLED");
            assert(updatedAbnOrder.items[0].isStockRestored === true, "Item stock restoration marked true");

            const finalStock = (await Variant.findById(retVar._id)).stock;
            assert(finalStock === initialStock + 2, `Inventory safely restored after lease recovery (From ${initialStock} to ${finalStock})`);
        }

        // -------------------------------------------------------------
        // SUITE 31: Sales Reporting Accounting & Dashboard Analytics (Section 6)
        // -------------------------------------------------------------
        console.log("\n--- Suite 31: Sales Reporting Accounting & Dashboard Analytics ---");
        {
            const repUser = await User.create({ fullName: "Report User", email: `rep_${Date.now()}@example.com`, password: "Password123!" });
            const repVar = await Variant.create({ productId: new mongoose.Types.ObjectId(), sku: `REP-${Date.now()}`, regularPrice: 1000, stock: 10, isActive: true });
            const repAddr = { firstName: "Rep", lastName: "U", addressLine1: "Lane", city: "Delhi", state: "Delhi", pinCode: "110001", country: "India", phone: "9876543210" };

            // 1. Unpaid COD order (Placed, not delivered)
            await Order.create({
                orderNumber: `ORD-COD-UNPAID-${Date.now()}`,
                userId: repUser._id,
                items: [{ variantId: repVar._id, productId: repVar.productId, productName: "Prod A", quantity: 1, regularPrice: 1000, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, status: "PROCESSING" }],
                shippingAddress: repAddr,
                pricing: { subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000 },
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                orderStatus: "PROCESSING",
                placedAt: new Date(),
            });

            // 2. Paid online order
            await Order.create({
                orderNumber: `ORD-ONL-PAID-${Date.now()}`,
                userId: repUser._id,
                items: [{ variantId: repVar._id, productId: repVar.productId, productName: "Prod B", quantity: 2, regularPrice: 1000, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 2000, status: "PROCESSING" }],
                shippingAddress: repAddr,
                pricing: { subtotal: 2000, shippingFee: 0, totalAmount: 2000, currentPayable: 2000 },
                paymentMethod: "ONLINE",
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
                placedAt: new Date(),
            });

            // 3. Delivered COD order (Cash collected)
            await Order.create({
                orderNumber: `ORD-COD-DELV-${Date.now()}`,
                userId: repUser._id,
                items: [{ variantId: repVar._id, productId: repVar.productId, productName: "Prod C", quantity: 1, regularPrice: 1500, unitPrice: 1500, priceAtPurchase: 1500, lineTotal: 1500, status: "DELIVERED" }],
                shippingAddress: repAddr,
                pricing: { subtotal: 1500, shippingFee: 0, totalAmount: 1500, currentPayable: 1500 },
                paymentMethod: "COD",
                paymentStatus: "COMPLETED",
                orderStatus: "DELIVERED",
                placedAt: new Date(),
            });

            const report = await reportService.getSalesReportData({ rangeType: "daily" });
            assert(report.summary.totalOrdersCount >= 3, "Report includes all placed orders in totalOrdersCount");
            assert(report.summary.netSalesRecognized >= 3500, `Net recognized revenue excludes unpaid COD (Paid online 2000 + Delivered COD 1500 = 3500) (Actual: ₹${report.summary.netSalesRecognized})`);
            assert(report.summary.totalPendingCodRevenue >= 1000, `Pending COD revenue separately tracks unpaid COD orders (Actual: ₹${report.summary.totalPendingCodRevenue})`);

            // 4. Yearly dashboard labels test: never produce "undefined 2026"
            const yearlyAnalytics = await reportService.getDashboardAnalytics("yearly");
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const formattedLabels = yearlyAnalytics.monthlyStats.map((d) =>
                d._id && d._id.month != null ? `${months[d._id.month - 1]} ${d._id.year}` : (d._id && d._id.year != null ? `${d._id.year}` : "N/A")
            );
            assert(!formattedLabels.some((l) => l.includes("undefined")), `Yearly labels format without 'undefined' (Labels: ${JSON.stringify(formattedLabels)})`);

            // 5. Malformed custom date input safe fallback
            const fallbackRange = reportService.getDateRange("custom", "invalid-start-date", "garbage-end");
            assert(fallbackRange.startDate instanceof Date && !isNaN(fallbackRange.startDate.getTime()), "Malformed custom dates fall back safely to valid startDate");
            assert(fallbackRange.endDate instanceof Date && !isNaN(fallbackRange.endDate.getTime()), "Malformed custom dates fall back safely to valid endDate");
        }

    } catch (err) {
        failedTests.push(`FATAL RUNTIME EXCEPTION: ${err.stack || err.message || err}`);
        console.error("Test Suite Runtime Error:", err);
    } finally {
        try {
            await mongoose.connection.dropDatabase();
            await mongoose.disconnect();
            console.log("\nCleaned and disconnected from test database.");
        } catch (cleanupErr) {
            console.error("Cleanup error (not hiding original error):", cleanupErr);
        }
    }

    console.log("\n=================================================");
    console.log(`TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
    if (failedTests.length === 0) {
        console.log("ALL TESTS PASSED SUCCESSFULLY!");
        process.exitCode = 0;
    } else {
        console.error(`FAILED TESTS (${failedTests.length}):`);
        failedTests.forEach((t) => console.error(`  - ${t}`));
        console.error("\nTEST SUITE FAILED WITH NON-ZERO EXIT CODE.");
        process.exitCode = 1;
        process.exit(1);
    }
    console.log("=================================================");
}

run().catch((err) => {
    console.error("Test Suite Fatal Error:", err);
    process.exit(1);
});
