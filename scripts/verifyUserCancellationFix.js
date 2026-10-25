/**
 * Verification Test Suite for User Cancellation Fix
 * Database: mongodb://127.0.0.1:27017/velora_test_user_cancellation_verification
 * 
 * Tests strictly against isolated database without touching production database.
 * Verifies:
 * 1. User can cancel one eligible item and an entire eligible order.
 * 2. Unpaid orders receive no wallet refund (ONLINE & COD).
 * 3. Paid orders receive the correct refund once (idempotent).
 * 4. Stock restores once.
 * 5. Purchase refunds remain separate from duplicate-payment refunds.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_user_cancellation_verification";

// Import Models
const User = require("../models/user/userModel");
const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Wallet = require("../models/user/walletModel");
const Transaction = require("../models/user/transactionModel");

// Import Services
const userOrderService = require("../services/user/orderService");
const adminOrderService = require("../services/admin/orderService");
const walletService = require("../services/user/walletService");

let testUser, testProduct, testVariant1, testVariant2;

const defaultAddress = {
    firstName: "Test",
    lastName: "User",
    addressLine1: "123 Test Street",
    city: "Bangalore",
    state: "Karnataka",
    pinCode: 560001,
    country: "India",
    phone: "9876543210",
};

function createItem({ product, variant, quantity = 1, price = 500, finalPayable = null, status = "PROCESSING" }) {
    const total = price * quantity;
    return {
        productId: product._id,
        variantId: variant._id,
        productName: product.name,
        quantity,
        price,
        unitPrice: price,
        priceAtPurchase: price,
        lineTotal: total,
        finalPayable: finalPayable !== null ? finalPayable : total,
        status,
        refundIssued: false,
        isStockRestored: false,
    };
}

async function runTests() {
    console.log("=".repeat(80));
    console.log("USER CANCELLATION VERIFICATION TEST SUITE");
    console.log(`Using Isolated Database: ${TEST_DB_URI}`);
    console.log("=".repeat(80));

    // Connect strictly to test DB
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.dropDatabase();

    // Create seed data
    testUser = await User.create({
        fullName: "Test User",
        email: `tester_${Date.now()}@example.com`,
        password: "hashedPassword123",
        role: "USER",
        isActive: true,
    });

    const category = await Category.create({
        name: `Apparel_${Date.now()}`,
        slug: `apparel-${Date.now()}`,
        isActive: true,
    });

    testProduct = await Product.create({
        name: "Classic Tee",
        slug: `classic-tee-${Date.now()}`,
        categoryId: category._id,
        description: "Bug7 Test Product Description",
        status: "ACTIVE",
    });

    testVariant1 = await Variant.create({
        productId: testProduct._id,
        color: "Black",
        size: "M",
        sku: `SKU-B-${Date.now()}`,
        regularPrice: 500,
        salePrice: 500,
        stock: 20,
        cancellationRestockKeys: [],
    });

    testVariant2 = await Variant.create({
        productId: testProduct._id,
        color: "White",
        size: "L",
        sku: `SKU-W-${Date.now()}`,
        regularPrice: 700,
        salePrice: 700,
        stock: 15,
        cancellationRestockKeys: [],
    });

    let passedCount = 0;
    let failedCount = 0;

    async function testCase(name, fn) {
        process.stdout.write(`Testing: ${name}... `);
        try {
            await fn();
            console.log("PASSED \u2713");
            passedCount++;
        } catch (err) {
            console.log("FAILED \u2717");
            console.error(`  Error: ${err.message}`);
            if (err.stack) console.error(err.stack);
            failedCount++;
        }
    }

    // =========================================================================
    // Test 1: User can cancel one eligible item and an entire eligible order
    // =========================================================================
    await testCase("1.1 User can cancel one eligible item in a multi-item order", async () => {
        const order = await Order.create({
            orderNumber: `ORD_TEST_1A_${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                createItem({ product: testProduct, variant: testVariant1, price: 500, status: "PROCESSING" }),
                createItem({ product: testProduct, variant: testVariant2, price: 700, status: "PROCESSING" }),
            ],
            pricing: {
                subtotal: 1200,
                shippingFee: 0,
                totalAmount: 1200,
                originalTotalAmount: 1200,
                currentPayable: 1200,
                collectedAmount: 1200,
                purchaseRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        const cancelItem = order.items[0];
        const res = await userOrderService.cancelOrderItem(testUser._id, order._id, cancelItem._id, "Changed mind");
        assert.strictEqual(res.success, true, "Item cancellation should succeed");

        const updated = await Order.findById(order._id);
        const item1 = updated.items.id(cancelItem._id);
        const item2 = updated.items[1];

        assert.strictEqual(item1.status, "CANCELLED", "Item 1 status must be CANCELLED");
        assert.strictEqual(item2.status, "PROCESSING", "Item 2 status must remain PROCESSING");
        assert.strictEqual(updated.orderStatus, "PROCESSING", "Overall order status must remain PROCESSING");
        assert.strictEqual(updated.pricing.cancellationDeduction, 500, "cancellationDeduction should be 500");
        assert.strictEqual(updated.pricing.currentPayable, 700, "currentPayable should be 700");
    });

    await testCase("1.2 User can cancel an entire eligible order", async () => {
        const order = await Order.create({
            orderNumber: `ORD_TEST_1B_${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                createItem({ product: testProduct, variant: testVariant1, price: 500, status: "PROCESSING" }),
                createItem({ product: testProduct, variant: testVariant2, price: 700, status: "PROCESSING" }),
            ],
            pricing: {
                subtotal: 1200,
                shippingFee: 100,
                totalAmount: 1300,
                originalTotalAmount: 1300,
                currentPayable: 1300,
                collectedAmount: 1300,
                purchaseRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        const res = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Cancel whole order");
        assert.strictEqual(res.success, true, "Order cancellation should succeed");

        const updated = await Order.findById(order._id);
        assert.strictEqual(updated.orderStatus, "CANCELLED", "Overall order status must be CANCELLED");
        assert.strictEqual(updated.items.every((i) => i.status === "CANCELLED"), true, "All items must be CANCELLED");
        assert.strictEqual(updated.pricing.currentPayable, 0, "currentPayable must be 0");
    });

    // =========================================================================
    // Test 2: Unpaid orders receive no wallet refund (ONLINE & COD)
    // =========================================================================
    await testCase("2.1 Unpaid ONLINE orders receive no wallet refund", async () => {
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        await wallet.save();

        const order = await Order.create({
            orderNumber: `ORD_UNPAID_ONLINE_${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "PENDING",
            paidAt: null,
            orderStatus: "PENDING",
            items: [
                createItem({ product: testProduct, variant: testVariant1, price: 500, status: "PENDING" }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                purchaseRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        const res = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Customer abandoned");
        assert.strictEqual(res.success, true);

        const updated = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(updatedWallet.balance, 0, "Wallet balance must remain 0 for unpaid online order");
        assert.strictEqual(updated.pricing.purchaseRefundTotal || 0, 0, "purchaseRefundTotal must remain 0");
        assert.strictEqual(updated.pricing.walletRefundIssued || 0, 0, "walletRefundIssued must remain 0");
        assert.strictEqual(updated.items[0].cancelledBeforePayment, true, "Item must be marked cancelledBeforePayment: true");
    });

    await testCase("2.2 Unpaid COD orders receive no wallet refund", async () => {
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        await wallet.save();

        const order = await Order.create({
            orderNumber: `ORD_UNPAID_COD_${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "COD",
            paymentStatus: "PENDING",
            paidAt: null,
            orderStatus: "PLACED",
            items: [
                createItem({ product: testProduct, variant: testVariant1, price: 500, status: "PLACED" }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                purchaseRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        const res = await userOrderService.cancelEntireOrder(testUser._id, order._id, "No cash available");
        assert.strictEqual(res.success, true);

        const updated = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(updatedWallet.balance, 0, "Wallet balance must remain 0 for unpaid COD order");
        assert.strictEqual(updated.pricing.purchaseRefundTotal || 0, 0, "purchaseRefundTotal must remain 0");
        assert.strictEqual(updated.pricing.walletRefundIssued || 0, 0, "walletRefundIssued must remain 0");
        assert.strictEqual(updated.paymentStatus, "CANCELLED", "COD paymentStatus should be CANCELLED");
    });

    // =========================================================================
    // Test 3: Paid orders receive the correct refund once (idempotent)
    // =========================================================================
    await testCase("3.1 Paid ONLINE order receives correct refund exactly once", async () => {
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        await wallet.save();

        const order = await Order.create({
            orderNumber: `ORD_PAID_ONLINE_${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                createItem({ product: testProduct, variant: testVariant1, price: 500, status: "PROCESSING" }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 100,
                totalAmount: 600,
                originalTotalAmount: 600,
                currentPayable: 600,
                collectedAmount: 600,
                purchaseRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // First cancellation
        const res1 = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Customer cancel");
        assert.strictEqual(res1.success, true);

        const updatedOrder1 = await Order.findById(order._id);
        const updatedWallet1 = await Wallet.findOne({ userId: testUser._id });

        // Item 500 + shipping 100 = 600 refunded
        assert.strictEqual(updatedWallet1.balance, 600, "Wallet should be credited exactly 600");
        assert.strictEqual(updatedOrder1.pricing.purchaseRefundTotal, 600, "purchaseRefundTotal should be 600");
        assert.strictEqual(updatedOrder1.paymentStatus, "REFUNDED", "paymentStatus should be REFUNDED");

        // Count credit transactions
        const txCount1 = await Transaction.countDocuments({
            userId: testUser._id,
            orderId: order._id,
            type: "CREDIT",
        });
        assert.strictEqual(txCount1, 2, "2 transactions: 1 for item + 1 for shipping");

        // Attempting to cancel again must NOT duplicate refund
        const res2 = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Cancel again");
        assert.strictEqual(res2.success, false, "Second cancellation attempt on already cancelled order must fail");

        const updatedWallet2 = await Wallet.findOne({ userId: testUser._id });
        assert.strictEqual(updatedWallet2.balance, 600, "Wallet balance must remain 600, not double-refunded");

        const txCount2 = await Transaction.countDocuments({
            userId: testUser._id,
            orderId: order._id,
            type: "CREDIT",
        });
        assert.strictEqual(txCount2, 2, "Transaction count must remain 2");
    });

    await testCase("3.2 Paid WALLET order receives correct refund exactly once", async () => {
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 1000;
        await wallet.save();

        const orderId = new mongoose.Types.ObjectId();
        const orderNumber = `ORD_WALLET_PAID_${Date.now()}`;

        // Record the debit transaction simulating initial wallet purchase
        await Transaction.create({
            walletId: wallet._id,
            userId: testUser._id,
            orderId,
            orderNumber,
            type: "DEBIT",
            amount: 500,
            balanceAfter: 500,
            reason: "ORDER_PURCHASE",
            description: `Payment for Order #${orderNumber}`,
        });
        wallet.balance = 500;
        await wallet.save();

        const order = await Order.create({
            _id: orderId,
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "WALLET",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                createItem({ product: testProduct, variant: testVariant1, price: 500, status: "PROCESSING" }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                collectedAmount: 500,
                purchaseRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        const res = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Customer cancel wallet order");
        assert.strictEqual(res.success, true);

        const updatedOrder = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(updatedWallet.balance, 1000, "Wallet balance must be restored from 500 to 1000");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal must be 500");
        assert.strictEqual(updatedOrder.paymentStatus, "REFUNDED", "paymentStatus must be REFUNDED");
    });

    // =========================================================================
    // Test 4: Stock restores once
    // =========================================================================
    await testCase("4.1 Stock restores once and is idempotent", async () => {
        // Reset variant stock to 10
        await Variant.updateOne(
            { _id: testVariant1._id },
            { $set: { stock: 10, cancellationRestockKeys: [] } }
        );

        // Place order for quantity 3 (stock would be 7)
        await Variant.updateOne({ _id: testVariant1._id }, { $set: { stock: 7 } });

        const order = await Order.create({
            orderNumber: `ORD_STOCK_${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "PENDING",
            paidAt: null,
            orderStatus: "PROCESSING",
            items: [
                createItem({ product: testProduct, variant: testVariant1, quantity: 3, price: 500, status: "PROCESSING" }),
            ],
            pricing: {
                subtotal: 1500,
                shippingFee: 0,
                totalAmount: 1500,
                originalTotalAmount: 1500,
                currentPayable: 1500,
                purchaseRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        const cancelItem = order.items[0];
        const res = await userOrderService.cancelOrderItem(testUser._id, order._id, cancelItem._id, "Cancel item");
        assert.strictEqual(res.success, true);

        const varAfter1 = await Variant.findById(testVariant1._id);
        assert.strictEqual(varAfter1.stock, 10, "Stock should be restored from 7 to 10 (+3)");

        // Try repeating cancellation or restock helper
        const restoreCancellationStock = require("../helpers/restoreCancellationStock");
        await restoreCancellationStock(order._id, cancelItem); // Should be a no-op due to unique key

        const varAfter2 = await Variant.findById(testVariant1._id);
        assert.strictEqual(varAfter2.stock, 10, "Stock must remain 10 and not be restored twice");
    });

    // =========================================================================
    // Test 5: Purchase refunds remain separate from duplicate-payment refunds
    // =========================================================================
    await testCase("5.1 Purchase refunds remain strictly separate from duplicate refunds", async () => {
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 500; // Prior duplicate refund was 500
        await wallet.save();

        const primaryPayId = `pay_primary_${Date.now()}`;
        const dupPayId = `pay_dup_${Date.now()}`;
        const orderNumber = `ORD_DUP_SEP_${Date.now()}`;

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            razorpayPaymentId: primaryPayId,
            items: [
                createItem({ product: testProduct, variant: testVariant1, price: 500, status: "PROCESSING" }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                collectedAmount: 1000,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 500,
                walletRefundIssued: 500,
            },
            paymentAttempts: [
                {
                    attemptId: "att_primary",
                    razorpayPaymentId: primaryPayId,
                    status: "SUCCESS",
                    amount: 500,
                },
                {
                    attemptId: "att_dup",
                    razorpayPaymentId: dupPayId,
                    status: "REFUNDED_DUPLICATE",
                    amount: 500,
                },
            ],
        });

        // Record the pre-existing duplicate payment transaction in the ledger
        await Transaction.create({
            walletId: wallet._id,
            userId: testUser._id,
            orderId: order._id,
            orderNumber: order.orderNumber,
            type: "CREDIT",
            amount: 500,
            balanceAfter: 500,
            reason: "DUPLICATE_PAYMENT",
            referenceId: `REFUND_DUP_${order._id}_${dupPayId}`,
            description: `Refund for duplicate payment ${dupPayId} in Order #${order.orderNumber}`,
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 500,
            status: "COMPLETED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: primaryPayId,
            refundAmount: 0,
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 500,
            status: "REFUNDED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: dupPayId,
            refundAmount: 500,
        });

        // Customer cancels the purchased item
        const res = await userOrderService.cancelOrderItem(testUser._id, order._id, order.items[0]._id, "Customer cancel");
        assert.strictEqual(res.success, true);

        const updatedOrder = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });
        const primaryPayment = await Payment.findOne({ orderId: order._id, razorpayPaymentId: primaryPayId });
        const duplicatePayment = await Payment.findOne({ orderId: order._id, razorpayPaymentId: dupPayId });

        // Verifications:
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal must be 500");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 500, "duplicateRefundTotal must remain 500");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 1000, "walletRefundIssued must be 1000 (500 purchase + 500 duplicate)");
        assert.strictEqual(updatedWallet.balance, 1000, "Wallet balance should be 1000 (500 prior duplicate + 500 purchase refund)");
        assert.strictEqual(primaryPayment.refundAmount, 500, "Primary payment refundAmount must be 500");
        assert.strictEqual(primaryPayment.status, "REFUNDED", "Primary payment status must be REFUNDED");
        assert.strictEqual(duplicatePayment.refundAmount, 500, "Duplicate payment refundAmount must remain 500");
        assert.strictEqual(duplicatePayment.status, "REFUNDED", "Duplicate payment status must remain REFUNDED");
    });

    console.log("=".repeat(80));
    console.log(`FINAL RESULT: ${passedCount} PASSED, ${failedCount} FAILED (Total: ${passedCount + failedCount})`);
    console.log("=".repeat(80));

    // Clean up test DB
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();

    if (failedCount > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test runner crashed:", err);
    process.exit(1);
});
