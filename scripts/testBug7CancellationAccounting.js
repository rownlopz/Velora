/**
 * Verification Test Suite for Bug #7: Cancellation Refund Accounting Across User and Admin Flows
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 * 
 * Verifies all required behaviours A through J:
 * A. Paid online order, user cancels one eligible item:
 *    purchaseRefundTotal increases by exactly the successful refund.
 * B. User cancels all eligible items:
 *    totals match actual completed credits, including shipping where applicable.
 * C. Admin cancels one item and cancels multiple items:
 *    accounting matches equivalent user cancellations.
 * D. Successful WALLET purchase followed by cancellation:
 *    correct refund and counters, exactly once.
 * E. Unpaid ONLINE and unpaid COD cancellations:
 *    no wallet credit and no purchase-refund increment.
 * F. Existing duplicate-payment refund:
 *    cancellation updates purchaseRefundTotal only; duplicateRefundTotal remains unchanged.
 * G. Wallet credit fails, then pending-refund recovery succeeds:
 *    completed counters increase once, only after confirmed credit.
 * H. Credit succeeds but accounting is interrupted:
 *    recovery repairs totals without another wallet credit.
 * I. Repeat and concurrently invoke cancellation/recovery:
 *    no duplicate financial or inventory effects.
 * J. Discounted/taxed item:
 *    refund matches its saved refundable purchase amount.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

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
const adminOrderService = require("../services/admin/orderService");
const userOrderService = require("../services/user/orderService");
const walletService = require("../services/user/walletService");

let testUser, testCategory, testProduct, testVariant1, testVariant2;

const defaultShippingAddress = {
    firstName: "Bug7",
    lastName: "Tester",
    addressLine1: "77 Accounting Way",
    addressLine2: "Suite 7",
    phone: "9876543210",
    city: "Bangalore",
    state: "Karnataka",
    pinCode: 560001,
    country: "India",
};

function makeItem({ product, variant, quantity = 1, price = 1000, finalPayable = null, status = "PROCESSING" }) {
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
    };
}

async function setupTestData() {
    await Order.deleteMany({ orderNumber: { $regex: /^TEST_BUG7_/ } });
    await User.deleteMany({ email: "bug7_tester@example.com" });
    await Wallet.deleteMany({});
    await Transaction.deleteMany({ description: { $regex: /TEST_BUG7/i } });

    testUser = await User.create({
        fullName: "Bug7 Suite User",
        firstName: "Bug7",
        lastName: "Tester",
        email: "bug7_tester@example.com",
        password: "hashed_dummy_password",
        phone: "9876543210",
        role: "USER",
        status: "Active",
        isEmailVerified: true,
    });

    await Wallet.create({ userId: testUser._id, balance: 0, appliedOperations: [], operationsLog: [] });

    testCategory = await Category.findOne({ name: "Bug7 Test Category" });
    if (!testCategory) {
        testCategory = await Category.create({
            name: "Bug7 Test Category",
            slug: "bug7-test-category",
            isActive: true,
        });
    }

    testProduct = await Product.findOne({ name: "Bug7 Test Product" });
    if (!testProduct) {
        testProduct = await Product.create({
            name: "Bug7 Test Product",
            slug: "bug7-test-product",
            categoryId: testCategory._id,
            description: "Bug7 Test Product Description",
            status: "ACTIVE",
        });
    }

    testVariant1 = await Variant.findOne({ sku: "BUG7-SKU-001" });
    if (!testVariant1) {
        testVariant1 = await Variant.create({
            productId: testProduct._id,
            color: "Silver",
            size: "M",
            sku: "BUG7-SKU-001",
            regularPrice: 1000,
            salePrice: 1000,
            stock: 100,
            isActive: true,
        });
    } else {
        testVariant1.stock = 100;
        await testVariant1.save();
    }

    testVariant2 = await Variant.findOne({ sku: "BUG7-SKU-002" });
    if (!testVariant2) {
        testVariant2 = await Variant.create({
            productId: testProduct._id,
            color: "Gold",
            size: "L",
            sku: "BUG7-SKU-002",
            regularPrice: 500,
            salePrice: 500,
            stock: 100,
            isActive: true,
        });
    } else {
        testVariant2.stock = 100;
        await testVariant2.save();
    }
}

async function runTestSuite() {
    console.log("================================================================================");
    console.log("BUG #7 VERIFICATION SUITE: CANCELLATION REFUND ACCOUNTING CONSISTENCY");
    console.log(`Database: ${TEST_DB_URI}`);
    console.log("================================================================================\n");

    await mongoose.connect(TEST_DB_URI);
    await setupTestData();

    let passedTests = 0;
    let failedTests = 0;

    async function testCase(name, fn) {
        process.stdout.write(`Testing ${name}... `);
        try {
            await fn();
            console.log("PASSED ✓");
            passedTests++;
        } catch (err) {
            console.log(`FAILED ✗\n  Error: ${err.message}`);
            console.error(err);
            failedTests++;
        }
    }

    // =========================================================================
    // Test A: Paid online order, user cancels one eligible item:
    // purchaseRefundTotal increases by exactly the successful refund.
    // =========================================================================
    await testCase("A: Paid online order, user cancels one eligible item", async () => {
        const orderNumber = `TEST_BUG7_A_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 1000 }),
                makeItem({ product: testProduct, variant: testVariant2, price: 500 }),
            ],
            pricing: {
                subtotal: 1500,
                shippingFee: 0,
                totalAmount: 1500,
                originalTotalAmount: 1500,
                currentPayable: 1500,
                collectedAmount: 1500,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 1500,
            status: "COMPLETED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: `pay_a_${Date.now()}`,
            refundAmount: 0,
        });

        const itemToCancel = order.items[0];
        const res = await userOrderService.cancelOrderItem(testUser._id, order._id, itemToCancel._id, "Changed mind");
        assert.strictEqual(res.success, true, `Cancellation should succeed: ${res.message}`);

        const updatedOrder = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });
        const payment = await Payment.findOne({ orderId: order._id });

        // Assert purchaseRefundTotal increased by exactly item's refund (1000)
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 1000, "purchaseRefundTotal must be 1000");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 1000, "walletRefundIssued must be 1000");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 0, "duplicateRefundTotal must remain 0");
        assert.strictEqual(updatedWallet.balance, 1000, "User wallet balance must be ₹1000");
        assert.strictEqual(payment.refundAmount, 1000, "Payment refundAmount must be 1000");

        const cancelledItem = updatedOrder.items.id(itemToCancel._id);
        assert.strictEqual(cancelledItem.status, "CANCELLED");
        assert.strictEqual(cancelledItem.refundIssued, true);
        assert.strictEqual(cancelledItem.refundStatus, "COMPLETED");
        assert.strictEqual(cancelledItem.refundAmount, 1000);
    });

    // =========================================================================
    // Test B: User cancels all eligible items:
    // totals match actual completed credits, including shipping where applicable.
    // =========================================================================
    await testCase("B: User cancels all eligible items including shipping", async () => {
        const orderNumber = `TEST_BUG7_B_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 400 }),
                makeItem({ product: testProduct, variant: testVariant2, price: 300 }),
            ],
            pricing: {
                subtotal: 700,
                shippingFee: 100,
                totalAmount: 800,
                originalTotalAmount: 800,
                currentPayable: 800,
                collectedAmount: 800,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 800,
            status: "COMPLETED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: `pay_b_${Date.now()}`,
            refundAmount: 0,
        });

        const res = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Cancel all");
        assert.strictEqual(res.success, true, `Entire cancellation should succeed: ${res.message}`);

        const updatedOrder = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });
        const payment = await Payment.findOne({ orderId: order._id });

        // Total refund: 400 + 300 + 100 (shipping) = 800
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 800, "purchaseRefundTotal must be 800");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 800, "walletRefundIssued must be 800");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 0, "duplicateRefundTotal must be 0");
        assert.strictEqual(updatedOrder.pricing.currentPayable, 0, "currentPayable must be 0");
        assert.strictEqual(updatedOrder.orderStatus, "CANCELLED", "orderStatus must be CANCELLED");
        assert.strictEqual(updatedOrder.paymentStatus, "REFUNDED", "paymentStatus must be REFUNDED");
        assert.strictEqual(updatedWallet.balance, 800, "User wallet balance must be ₹800");
        assert.strictEqual(payment.refundAmount, 800, "Payment refundAmount must be 800");
        assert.strictEqual(payment.status, "REFUNDED", "Payment status must be REFUNDED");
    });

    // =========================================================================
    // Test C: Admin cancels one item and cancels multiple items:
    // accounting matches equivalent user cancellations.
    // =========================================================================
    await testCase("C: Admin cancels one item and cancels multiple items", async () => {
        // Part 1: Admin cancels one item
        const orderNumberC1 = `TEST_BUG7_C1_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const orderC1 = await Order.create({
            orderNumber: orderNumberC1,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 500 }),
                makeItem({ product: testProduct, variant: testVariant2, price: 500 }),
            ],
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                totalAmount: 1000,
                originalTotalAmount: 1000,
                currentPayable: 1000,
                collectedAmount: 1000,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: orderC1._id,
            userId: testUser._id,
            amount: 1000,
            status: "COMPLETED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: `pay_c1_${Date.now()}`,
            refundAmount: 0,
        });

        const resC1 = await adminOrderService.updateAdminOrderItemStatus(orderC1._id, orderC1.items[0]._id, "CANCELLED", { adminNote: "Out of stock" });
        assert.strictEqual(resC1.success, true);

        const updatedC1 = await Order.findById(orderC1._id);
        assert.strictEqual(updatedC1.pricing.purchaseRefundTotal, 500, "C1: purchaseRefundTotal must be 500");
        assert.strictEqual(updatedC1.pricing.walletRefundIssued, 500, "C1: walletRefundIssued must be 500");
        assert.strictEqual(updatedC1.pricing.duplicateRefundTotal, 0, "C1: duplicateRefundTotal must be 0");

        // Part 2: Admin bulk cancels order (all items + shipping)
        const orderNumberC2 = `TEST_BUG7_C2_${Date.now()}`;
        await Wallet.updateOne(
            { userId: testUser._id },
            { $set: { balance: 0, appliedOperations: [], operationsLog: [] } }
        );

        const orderC2 = await Order.create({
            orderNumber: orderNumberC2,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 400 }),
                makeItem({ product: testProduct, variant: testVariant2, price: 300 }),
            ],
            pricing: {
                subtotal: 700,
                shippingFee: 100,
                totalAmount: 800,
                originalTotalAmount: 800,
                currentPayable: 800,
                collectedAmount: 800,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: orderC2._id,
            userId: testUser._id,
            amount: 800,
            status: "COMPLETED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: `pay_c2_${Date.now()}`,
            refundAmount: 0,
        });

        const resC2 = await adminOrderService.updateOrderStatus(orderC2._id, "CANCELLED", { adminNote: "Customer requested admin cancel" });
        assert.strictEqual(resC2.success, true);

        const updatedC2 = await Order.findById(orderC2._id);
        const updatedWalletC2 = await Wallet.findOne({ userId: testUser._id });

        // Exactly matches User cancellation in Test B: 400 + 300 + 100 = 800
        assert.strictEqual(updatedC2.pricing.purchaseRefundTotal, 800, "C2: purchaseRefundTotal must be 800");
        assert.strictEqual(updatedC2.pricing.walletRefundIssued, 800, "C2: walletRefundIssued must be 800");
        assert.strictEqual(updatedC2.pricing.duplicateRefundTotal, 0, "C2: duplicateRefundTotal must be 0");
        assert.strictEqual(updatedC2.orderStatus, "CANCELLED");
        assert.strictEqual(updatedC2.paymentStatus, "REFUNDED");
        assert.strictEqual(updatedWalletC2.balance, 800, "C2: Wallet balance must be 800");
    });

    // =========================================================================
    // Test D: Successful WALLET purchase followed by cancellation:
    // correct refund and counters, exactly once.
    // =========================================================================
    await testCase("D: Successful WALLET purchase followed by cancellation", async () => {
        const orderNumber = `TEST_BUG7_D_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 1000;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "WALLET",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 600 }),
            ],
            pricing: {
                subtotal: 600,
                shippingFee: 0,
                totalAmount: 600,
                originalTotalAmount: 600,
                currentPayable: 600,
                collectedAmount: 600,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        // Record confirmed debit transaction for wallet purchase
        await Transaction.create({
            walletId: wallet._id,
            userId: testUser._id,
            orderId: order._id,
            orderNumber: order.orderNumber,
            type: "DEBIT",
            amount: 600,
            balanceAfter: 400,
            reason: "ORDER_PURCHASE",
            referenceId: `DEBIT_PURCHASE_${order._id}`,
            description: `Payment for Order #${order.orderNumber}`,
        });
        wallet.balance = 400;
        await wallet.save();

        const res = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Cancel wallet order");
        assert.strictEqual(res.success, true);

        const updatedOrder = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 600, "purchaseRefundTotal must be 600");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 600, "walletRefundIssued must be 600");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 0, "duplicateRefundTotal must be 0");
        assert.strictEqual(updatedWallet.balance, 1000, "Wallet balance must be restored to ₹1000");

        // Verify calling again does not refund again
        const resAgain = await userOrderService.cancelEntireOrder(testUser._id, order._id, "Cancel again");
        assert.strictEqual(resAgain.success, false, "Second cancellation attempt must be rejected");
        const walletAfterSecond = await Wallet.findOne({ userId: testUser._id });
        assert.strictEqual(walletAfterSecond.balance, 1000, "Wallet balance must remain 1000");
    });

    // =========================================================================
    // Test E: Unpaid ONLINE and unpaid COD cancellations:
    // no wallet credit and no purchase-refund increment.
    // =========================================================================
    await testCase("E: Unpaid ONLINE and unpaid COD cancellations produce no refund", async () => {
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        // 1. Unpaid ONLINE
        const orderNumberE1 = `TEST_BUG7_E1_${Date.now()}`;
        const orderE1 = await Order.create({
            orderNumber: orderNumberE1,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "PENDING",
            paidAt: null,
            orderStatus: "PENDING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 500, status: "PENDING" }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        const resE1 = await userOrderService.cancelEntireOrder(testUser._id, orderE1._id, "Unpaid online cancellation");
        assert.strictEqual(resE1.success, true);
        const updatedE1 = await Order.findById(orderE1._id);
        const walletE1 = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(updatedE1.pricing.purchaseRefundTotal || 0, 0, "E1: purchaseRefundTotal must be 0");
        assert.strictEqual(updatedE1.pricing.walletRefundIssued || 0, 0, "E1: walletRefundIssued must be 0");
        assert.strictEqual(walletE1.balance, 0, "E1: Wallet balance must remain 0");
        assert.strictEqual(updatedE1.items[0].cancelledBeforePayment, true, "cancelledBeforePayment must be true");

        // 2. Unpaid COD
        const orderNumberE2 = `TEST_BUG7_E2_${Date.now()}`;
        const orderE2 = await Order.create({
            orderNumber: orderNumberE2,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "COD",
            paymentStatus: "PENDING",
            paidAt: null,
            orderStatus: "PLACED",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 700, status: "PLACED" }),
            ],
            pricing: {
                subtotal: 700,
                shippingFee: 0,
                totalAmount: 700,
                originalTotalAmount: 700,
                currentPayable: 700,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        const resE2 = await adminOrderService.updateOrderStatus(orderE2._id, "CANCELLED", { adminNote: "COD cancelled" });
        assert.strictEqual(resE2.success, true);
        const updatedE2 = await Order.findById(orderE2._id);
        const walletE2 = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(updatedE2.pricing.purchaseRefundTotal || 0, 0, "E2: purchaseRefundTotal must be 0");
        assert.strictEqual(updatedE2.pricing.walletRefundIssued || 0, 0, "E2: walletRefundIssued must be 0");
        assert.strictEqual(walletE2.balance, 0, "E2: Wallet balance must remain 0");
        assert.strictEqual(updatedE2.items[0].cancelledBeforePayment, true, "cancelledBeforePayment must be true");
    });

    // =========================================================================
    // Test F: Existing duplicate-payment refund:
    // cancellation updates purchaseRefundTotal only; duplicateRefundTotal remains unchanged.
    // =========================================================================
    await testCase("F: Existing duplicate-payment refund preserved; purchaseRefundTotal updated independently", async () => {
        const orderNumber = `TEST_BUG7_F_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 500; // Received duplicate payment refund previously
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const primaryPayId = `pay_prim_${Date.now()}`;
        const dupPayId = `pay_dup_${Date.now()}`;

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            razorpayPaymentId: primaryPayId,
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 500 }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                collectedAmount: 1000, // 500 primary + 500 duplicate
                walletRefundIssued: 500, // duplicate refund already issued
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 500,
            },
            paymentAttempts: [
                {
                    attemptId: "att_prim",
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

        // Record the existing duplicate refund transaction in the ledger
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

        // Assert: purchaseRefundTotal updated to 500, duplicateRefundTotal UNCHANGED at 500
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal must be 500");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 500, "duplicateRefundTotal must remain 500");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 1000, "walletRefundIssued must be 1000 (500 + 500)");
        assert.strictEqual(updatedWallet.balance, 1000, "Wallet balance must be 1000 (500 previous + 500 purchase refund)");
        assert.strictEqual(primaryPayment.refundAmount, 500, "Primary payment refundAmount must be 500");
        assert.strictEqual(duplicatePayment.refundAmount, 500, "Duplicate payment refundAmount must remain 500");
    });

    // =========================================================================
    // Test G: Wallet credit fails, then pending-refund recovery succeeds:
    // completed counters increase once, only after confirmed credit.
    // =========================================================================
    await testCase("G: Wallet credit fails, pending-refund recovery completes credit and counters", async () => {
        const orderNumber = `TEST_BUG7_G_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 450 }),
            ],
            pricing: {
                subtotal: 450,
                shippingFee: 0,
                totalAmount: 450,
                originalTotalAmount: 450,
                currentPayable: 450,
                collectedAmount: 450,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 450,
            status: "COMPLETED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: `pay_g_${Date.now()}`,
            refundAmount: 0,
        });

        // Intercept wallet credit to simulate temporary failure
        const originalCreditWallet = walletService.creditWallet;
        walletService.creditWallet = async () => {
            return { success: false, message: "Simulated wallet database connection timeout" };
        };

        let res;
        try {
            res = await userOrderService.cancelOrderItem(testUser._id, order._id, order.items[0]._id, "Cancel with wallet failure");
        } finally {
            walletService.creditWallet = originalCreditWallet;
        }

        assert.strictEqual(res.hadRefundFailure, true, "hadRefundFailure must be true");

        const orderAfterFail = await Order.findById(order._id);
        const walletAfterFail = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(orderAfterFail.pricing.purchaseRefundTotal || 0, 0, "purchaseRefundTotal must be 0 while pending");
        assert.strictEqual(orderAfterFail.pricing.walletRefundIssued || 0, 0, "walletRefundIssued must be 0 while pending");
        assert.strictEqual(walletAfterFail.balance, 0, "Wallet balance must be 0 while pending");
        assert.strictEqual(orderAfterFail.items[0].refundStatus, "REFUND_PENDING", "Item refundStatus must be REFUND_PENDING");

        // Now run recovery via recoverPendingRefunds
        const recRes = await adminOrderService.recoverPendingRefunds(order._id);
        assert.strictEqual(recRes.success, true, "Recovery must succeed");

        const orderAfterRec = await Order.findById(order._id);
        const walletAfterRec = await Wallet.findOne({ userId: testUser._id });

        assert.strictEqual(orderAfterRec.pricing.purchaseRefundTotal, 450, "purchaseRefundTotal must be 450 after recovery");
        assert.strictEqual(orderAfterRec.pricing.walletRefundIssued, 450, "walletRefundIssued must be 450 after recovery");
        assert.strictEqual(walletAfterRec.balance, 450, "Wallet balance must be ₹450 after recovery");
        assert.strictEqual(orderAfterRec.items[0].refundStatus, "COMPLETED", "Item refundStatus must be COMPLETED");
        assert.strictEqual(orderAfterRec.items[0].refundIssued, true, "Item refundIssued must be true");
    });

    // =========================================================================
    // Test H: Credit succeeds but accounting is interrupted:
    // recovery repairs totals without another wallet credit.
    // =========================================================================
    await testCase("H: Credit succeeds but accounting is interrupted: recovery repairs without duplicate credit", async () => {
        const orderNumber = `TEST_BUG7_H_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 350, status: "CANCELLED" }),
            ],
            pricing: {
                subtotal: 350,
                shippingFee: 0,
                totalAmount: 350,
                originalTotalAmount: 350,
                currentPayable: 0,
                collectedAmount: 350,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        order.items[0].refundIssued = false;
        order.items[0].refundStatus = "REFUND_PENDING";
        await order.save();

        // Credit succeeded in the ledger
        const refundRef = `REFUND_CAN_${order._id}_${order.items[0]._id}`;
        await walletService.creditWallet({
            userId: testUser._id,
            amount: 350,
            reason: "ORDER_CANCELLATION",
            description: `Refund for cancelled item in Order #${order.orderNumber}`,
            orderId: order._id,
            orderNumber: order.orderNumber,
            referenceId: refundRef,
        });

        const walletBefore = await Wallet.findOne({ userId: testUser._id });
        assert.strictEqual(walletBefore.balance, 350, "Wallet balance should be 350 after credit");

        // Run recovery/reconciliation
        await adminOrderService.recoverPendingRefunds(order._id);

        const orderAfter = await Order.findById(order._id);
        const walletAfter = await Wallet.findOne({ userId: testUser._id });

        // Total repaired to 350, wallet balance remains 350 (NO second credit)
        assert.strictEqual(orderAfter.pricing.purchaseRefundTotal, 350, "purchaseRefundTotal must be repaired to 350");
        assert.strictEqual(orderAfter.pricing.walletRefundIssued, 350, "walletRefundIssued must be repaired to 350");
        assert.strictEqual(walletAfter.balance, 350, "Wallet balance must remain 350 with NO duplicate credit");
        assert.strictEqual(orderAfter.items[0].refundStatus, "COMPLETED");
        assert.strictEqual(orderAfter.items[0].refundIssued, true);
    });

    // =========================================================================
    // Test I: Repeat and concurrently invoke cancellation/recovery:
    // no duplicate financial or inventory effects.
    // =========================================================================
    await testCase("I: Repeat and concurrently invoke cancellation/recovery: idempotent", async () => {
        const orderNumber = `TEST_BUG7_I_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const initialStock = 50;
        testVariant1.stock = initialStock;
        await testVariant1.save();

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, quantity: 2, price: 250 }),
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                collectedAmount: 500,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        // Launch concurrent cancellations
        const [res1, res2] = await Promise.all([
            userOrderService.cancelOrderItem(testUser._id, order._id, order.items[0]._id, "Concurrent 1"),
            userOrderService.cancelOrderItem(testUser._id, order._id, order.items[0]._id, "Concurrent 2"),
        ]);

        // One should claim the transition, the other is rejected gracefully
        assert.ok(res1.success || res2.success);

        // Run recovery multiple times
        await adminOrderService.recoverPendingRefunds(order._id);
        await adminOrderService.recoverPendingRefunds(order._id);

        const finalOrder = await Order.findById(order._id);
        const finalWallet = await Wallet.findOne({ userId: testUser._id });
        const finalVariant = await Variant.findById(testVariant1._id);

        // Assert exactly one financial refund of 500
        assert.strictEqual(finalOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal must be exactly 500");
        assert.strictEqual(finalOrder.pricing.walletRefundIssued, 500, "walletRefundIssued must be exactly 500");
        assert.strictEqual(finalWallet.balance, 500, "Wallet balance must be exactly 500");

        // Assert inventory restored exactly once (+2)
        assert.strictEqual(finalVariant.stock, initialStock + 2, `Stock must be ${initialStock + 2}, got ${finalVariant.stock}`);
    });

    // =========================================================================
    // Test J: Discounted/taxed item:
    // refund matches its saved refundable purchase amount.
    // =========================================================================
    await testCase("J: Discounted/taxed item refunds saved finalPayable purchase amount", async () => {
        const orderNumber = `TEST_BUG7_J_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 0;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        // Catalogue price is 1000, but coupon allocated discount of 200 -> finalPayable is 800
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            orderStatus: "PROCESSING",
            items: [
                makeItem({ product: testProduct, variant: testVariant1, price: 1000, finalPayable: 800 }),
            ],
            pricing: {
                subtotal: 1000,
                couponDiscount: 200,
                shippingFee: 0,
                totalAmount: 800,
                originalTotalAmount: 800,
                currentPayable: 800,
                collectedAmount: 800,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 800,
            status: "COMPLETED",
            paymentMethod: "ONLINE",
            razorpayPaymentId: `pay_j_${Date.now()}`,
            refundAmount: 0,
        });

        const res = await userOrderService.cancelOrderItem(testUser._id, order._id, order.items[0]._id, "Customer cancel discounted item");
        assert.strictEqual(res.success, true);

        const updatedOrder = await Order.findById(order._id);
        const updatedWallet = await Wallet.findOne({ userId: testUser._id });

        // Refund must be 800 (saved finalPayable), NOT 1000 catalogue price
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 800, "purchaseRefundTotal must be 800");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 800, "walletRefundIssued must be 800");
        assert.strictEqual(updatedWallet.balance, 800, "Wallet balance must be 800 (finalPayable)");
        assert.strictEqual(updatedOrder.pricing.cancellationDeduction, 800, "cancellationDeduction must be 800");
        assert.strictEqual(updatedOrder.items[0].refundAmount, 800, "Item refundAmount must be 800");
    });

    console.log("\n================================================================================");
    console.log(`TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED (Total: ${passedTests + failedTests})`);
    console.log("================================================================================\n");

    await mongoose.disconnect();
    if (failedTests > 0) process.exit(1);
}

runTestSuite().catch((err) => {
    console.error("Test suite execution failed:", err);
    process.exit(1);
});
