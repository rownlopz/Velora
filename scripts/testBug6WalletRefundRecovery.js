/**
 * Verification Test Suite for Bug #6: Pending Wallet Refunds Recovery Process
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 * 
 * Verifies all required behaviours A through J:
 * A. Initial wallet refund fails before credit: operation remains pending; later recovery credits exactly once.
 * B. Wallet credit succeeds but later bookkeeping fails: recovery repairs bookkeeping without crediting again.
 * C. Recovery itself fails temporarily: operation remains retryable; another run completes it.
 * D. Run recovery three times after success: balance and refund counters remain unchanged.
 * E. Run recovery concurrently: exactly one wallet credit and one accounting effect.
 * F. Duplicate-payment refund: updates duplicateRefundTotal, not purchaseRefundTotal.
 * G. Genuine cancellation/return refund: updates purchaseRefundTotal correctly.
 * H. Unpaid cancelled item: no refund is created or issued.
 * I. Missing wallet transaction record after a completed operation: repair it without changing the balance again.
 * J. Already-restored inventory: refund recovery causes no additional stock increment.
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

const { recoverPendingRefunds, reconcileOrderState } = adminOrderService;

let testUser, testCategory, testProduct, testVariant;

const defaultShippingAddress = {
    firstName: "Bug6",
    lastName: "Tester",
    addressLine1: "123 Recovery Lane",
    addressLine2: "",
    phone: "9876543210",
    city: "Bangalore",
    state: "Karnataka",
    pinCode: 560001,
    country: "India",
};

async function setupTestData() {
    await Order.deleteMany({ orderNumber: { $regex: /^TEST_BUG6_/ } });
    await User.deleteMany({ email: "bug6_recovery_tester@example.com" });
    await Wallet.deleteMany({});
    await Transaction.deleteMany({ description: { $regex: /TEST_BUG6/i } });

    testUser = await User.findOne({ email: "bug6_recovery_tester@example.com" });
    if (!testUser) {
        testUser = await User.create({
            fullName: "Bug6 Suite User",
            firstName: "Bug6",
            lastName: "Tester",
            email: "bug6_recovery_tester@example.com",
            password: "hashed_dummy_password",
            phone: "9876543210",
            role: "USER",
            status: "Active",
            isEmailVerified: true,
        });
    }

    await Wallet.deleteMany({ userId: testUser._id });
    await Transaction.deleteMany({ userId: testUser._id });
    await Wallet.create({ userId: testUser._id, balance: 0, appliedOperations: [], operationsLog: [] });

    testCategory = await Category.findOne({ name: "Bug6 Test Category" });
    if (!testCategory) {
        testCategory = await Category.create({
            name: "Bug6 Test Category",
            slug: "bug6-test-category",
            isActive: true,
        });
    }

    testProduct = await Product.findOne({ name: "Bug6 Test Product" });
    if (!testProduct) {
        testProduct = await Product.create({
            name: "Bug6 Test Product",
            slug: "bug6-test-product",
            categoryId: testCategory._id,
            description: "Bug6 Test Product Description",
            status: "ACTIVE",
        });
    }

    testVariant = await Variant.findOne({ productId: testProduct._id });
    if (!testVariant) {
        testVariant = await Variant.create({
            productId: testProduct._id,
            color: "Silver",
            size: "M",
            sku: "BUG6-SKU-001",
            regularPrice: 500,
            salePrice: 500,
            stock: 100,
            isActive: true,
        });
    } else {
        testVariant.stock = 100;
        await testVariant.save();
    }
}

async function runTestSuite() {
    console.log("================================================================================");
    console.log("BUG #6 VERIFICATION SUITE: RELIABLE RECOVERY FOR PENDING WALLET REFUNDS");
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
    // Test A: Initial wallet refund fails before credit:
    // operation remains pending; later recovery credits exactly once.
    // =========================================================================
    await testCase("A: Initial wallet refund fails before credit: recovery credits exactly once", async () => {
        const orderNumber = `TEST_BUG6_A_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 500;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const itemLineTotal = 1000;
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_A_${Date.now()}`,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 2,
                    unitPrice: 500,
                    lineTotal: itemLineTotal,
                    finalPayable: itemLineTotal,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true,
                    refundIssued: false,
                    refundAmount: itemLineTotal,
                    refundStatus: "REFUND_PENDING", // Initial failure recorded as pending!
                },
            ],
            pricing: {
                subtotal: itemLineTotal,
                shippingFee: 0,
                totalAmount: itemLineTotal,
                originalTotalAmount: itemLineTotal,
                collectedAmount: itemLineTotal,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Run recovery
        const recResult = await recoverPendingRefunds(order._id);
        assert(recResult.success === true, "Recovery should succeed");
        assert(recResult.recoveredOrdersCount === 1, "Should report 1 order recovered");

        // Verify wallet
        const updatedWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(updatedWallet.balance, 1500, "Wallet balance should increase from 500 to 1500 (+1000)");

        // Verify order
        const updatedOrder = await Order.findById(order._id);
        assert.strictEqual(updatedOrder.items[0].refundStatus, "COMPLETED", "Item refundStatus should be COMPLETED");
        assert.strictEqual(updatedOrder.items[0].refundIssued, true, "Item refundIssued should be true");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 1000, "purchaseRefundTotal should be 1000");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 0, "duplicateRefundTotal should be 0");
    });

    // =========================================================================
    // Test B: Wallet credit succeeds but later bookkeeping fails:
    // recovery repairs bookkeeping without crediting again.
    // =========================================================================
    await testCase("B: Wallet credit succeeds but later bookkeeping fails: repairs without crediting again", async () => {
        const orderNumber = `TEST_BUG6_B_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 1000;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const itemRefund = 600;
        const dummyOrderId = new mongoose.Types.ObjectId();
        const dummyItemId = new mongoose.Types.ObjectId();
        const refundRef = `REFUND_CAN_${dummyOrderId}_${dummyItemId}`;

        // Simulate that creditWallet previously executed and credited the wallet
        const credRes = await walletService.creditWallet({
            userId: testUser._id,
            amount: itemRefund,
            reason: "ORDER_CANCELLATION",
            description: `Interrupted refund for ${orderNumber}`,
            orderId: dummyOrderId,
            orderNumber,
            referenceId: refundRef,
        });
        assert(credRes.success === true, "Pre-condition: creditWallet succeeded");

        const balanceAfterCredit = (await Wallet.findById(wallet._id)).balance;
        assert.strictEqual(balanceAfterCredit, 1600, "Wallet balance should now be 1600");

        // But order was NOT updated (bookkeeping failure simulation)
        const order = await Order.create({
            _id: dummyOrderId,
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_B_${Date.now()}`,
            items: [
                {
                    _id: dummyItemId,
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: itemRefund,
                    lineTotal: itemRefund,
                    finalPayable: itemRefund,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true,
                    refundIssued: false, // Broken bookkeeping
                    refundAmount: 0,
                    refundStatus: "REFUND_PENDING", // Still marked pending
                },
            ],
            pricing: {
                subtotal: itemRefund,
                shippingFee: 0,
                totalAmount: itemRefund,
                originalTotalAmount: itemRefund,
                collectedAmount: itemRefund,
                currentPayable: 0,
                purchaseRefundTotal: 0, // Out of sync
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Run recovery
        const recResult = await recoverPendingRefunds(order._id);
        assert(recResult.success === true, "Recovery should succeed");

        // Verify wallet balance did NOT change
        const finalWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(finalWallet.balance, 1600, "Wallet balance must remain 1600 (NO second credit)");

        // Verify order bookkeeping was repaired
        const updatedOrder = await Order.findById(order._id);
        assert.strictEqual(updatedOrder.items[0].refundStatus, "COMPLETED", "Item refundStatus should be COMPLETED");
        assert.strictEqual(updatedOrder.items[0].refundIssued, true, "Item refundIssued should be true");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 600, "purchaseRefundTotal should be repaired to 600");
    });

    // =========================================================================
    // Test C: Recovery itself fails temporarily:
    // operation remains retryable; another run completes it.
    // =========================================================================
    await testCase("C: Recovery fails temporarily: operation remains retryable and completes on next run", async () => {
        const orderNumber = `TEST_BUG6_C_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 500;
        await wallet.save();

        const itemRefund = 400;
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_C_${Date.now()}`,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: itemRefund,
                    lineTotal: itemRefund,
                    finalPayable: itemRefund,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true,
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING",
                },
            ],
            pricing: {
                subtotal: itemRefund,
                shippingFee: 0,
                totalAmount: itemRefund,
                originalTotalAmount: itemRefund,
                collectedAmount: itemRefund,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // 1. First run: Monkey-patch creditWallet to simulate temporary failure
        const originalCreditWallet = walletService.creditWallet;
        walletService.creditWallet = async () => ({ success: false, message: "Temporary gateway timeout" });

        try {
            const firstRun = await recoverPendingRefunds(order._id);
            assert(firstRun.success === false, "First run should report failure");
            assert(firstRun.unresolvedOrdersCount === 1, "Should report 1 unresolved order");

            // Check that order remains in REFUND_PENDING
            const orderAfterFailedRun = await Order.findById(order._id);
            assert.strictEqual(orderAfterFailedRun.items[0].refundStatus, "REFUND_PENDING", "Operation must remain retryable (REFUND_PENDING)");
            assert.strictEqual((await Wallet.findById(wallet._id)).balance, 500, "Wallet balance should remain unchanged");
        } finally {
            // Restore original creditWallet
            walletService.creditWallet = originalCreditWallet;
        }

        // 2. Second run: Real recovery succeeds
        const secondRun = await recoverPendingRefunds(order._id);
        assert(secondRun.success === true, "Second run should succeed");
        assert(secondRun.recoveredOrdersCount === 1, "Second run should recover the order");

        const finalOrder = await Order.findById(order._id);
        assert.strictEqual(finalOrder.items[0].refundStatus, "COMPLETED", "Item refundStatus should be COMPLETED");
        assert.strictEqual((await Wallet.findById(wallet._id)).balance, 900, "Wallet balance should now be 900 (+400)");
    });

    // =========================================================================
    // Test D: Run recovery three times after success:
    // balance and refund counters remain unchanged.
    // =========================================================================
    await testCase("D: Run recovery three times after success: balance and counters remain unchanged", async () => {
        const orderNumber = `TEST_BUG6_D_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 700;
        await wallet.save();

        const itemRefund = 300;
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_D_${Date.now()}`,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: itemRefund,
                    lineTotal: itemRefund,
                    finalPayable: itemRefund,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true,
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING",
                },
            ],
            pricing: {
                subtotal: itemRefund,
                shippingFee: 0,
                totalAmount: itemRefund,
                originalTotalAmount: itemRefund,
                collectedAmount: itemRefund,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Run 1: initial recovery
        await recoverPendingRefunds(order._id);
        const bal1 = (await Wallet.findById(wallet._id)).balance;
        const ord1 = await Order.findById(order._id);
        assert.strictEqual(bal1, 1000, "Balance after run 1 should be 1000");
        assert.strictEqual(ord1.pricing.purchaseRefundTotal, 300, "purchaseRefundTotal should be 300");

        // Run 2: idempotent retry
        await recoverPendingRefunds(order._id);
        const bal2 = (await Wallet.findById(wallet._id)).balance;
        const ord2 = await Order.findById(order._id);
        assert.strictEqual(bal2, 1000, "Balance after run 2 must remain 1000");
        assert.strictEqual(ord2.pricing.purchaseRefundTotal, 300, "purchaseRefundTotal must remain 300");

        // Run 3: idempotent retry
        await recoverPendingRefunds(order._id);
        const bal3 = (await Wallet.findById(wallet._id)).balance;
        const ord3 = await Order.findById(order._id);
        assert.strictEqual(bal3, 1000, "Balance after run 3 must remain 1000");
        assert.strictEqual(ord3.pricing.purchaseRefundTotal, 300, "purchaseRefundTotal must remain 300");
    });

    // =========================================================================
    // Test E: Run recovery concurrently:
    // exactly one wallet credit and one accounting effect.
    // =========================================================================
    await testCase("E: Run recovery concurrently: exactly one wallet credit and one accounting effect", async () => {
        const orderNumber = `TEST_BUG6_E_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 200;
        await wallet.save();

        const itemRefund = 500;
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_E_${Date.now()}`,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: itemRefund,
                    lineTotal: itemRefund,
                    finalPayable: itemRefund,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true,
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING",
                },
            ],
            pricing: {
                subtotal: itemRefund,
                shippingFee: 0,
                totalAmount: itemRefund,
                originalTotalAmount: itemRefund,
                collectedAmount: itemRefund,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Launch 5 concurrent recovery operations simultaneously
        await Promise.all([
            recoverPendingRefunds(order._id),
            recoverPendingRefunds(order._id),
            recoverPendingRefunds(order._id),
            recoverPendingRefunds(order._id),
            recoverPendingRefunds(order._id),
        ]);

        const finalWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(finalWallet.balance, 700, "Wallet balance should be 700 (200 + 500 credited exactly once)");

        const finalOrder = await Order.findById(order._id);
        assert.strictEqual(finalOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal should be exactly 500");

        const txs = await Transaction.find({ orderId: order._id });
        assert.strictEqual(txs.length, 1, "Should have exactly 1 transaction record in DB");
    });

    // =========================================================================
    // Test F: Duplicate-payment refund:
    // updates duplicateRefundTotal, not purchaseRefundTotal.
    // =========================================================================
    await testCase("F: Duplicate-payment refund: updates duplicateRefundTotal, not purchaseRefundTotal", async () => {
        const orderNumber = `TEST_BUG6_F_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 100;
        await wallet.save();

        const primaryPayId = `pay_prim_${Date.now()}`;
        const dupPayId = `pay_dup_${Date.now()}`;
        const orderAmount = 1000;

        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: primaryPayId,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 2,
                    unitPrice: 500,
                    lineTotal: orderAmount,
                    finalPayable: orderAmount,
                    status: "DELIVERED",
                },
            ],
            paymentAttempts: [
                {
                    gateway: "RAZORPAY",
                    attemptId: "att_primary",
                    razorpayPaymentId: primaryPayId,
                    amount: orderAmount,
                    status: "SUCCESS",
                },
                {
                    gateway: "RAZORPAY",
                    attemptId: "att_duplicate",
                    razorpayPaymentId: dupPayId,
                    amount: orderAmount,
                    status: "REFUND_PENDING", // Pending duplicate refund!
                },
            ],
            pricing: {
                subtotal: orderAmount,
                shippingFee: 0,
                totalAmount: orderAmount,
                originalTotalAmount: orderAmount,
                collectedAmount: orderAmount * 2,
                currentPayable: orderAmount,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Run recovery
        await recoverPendingRefunds(order._id);

        const updatedWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(updatedWallet.balance, 1100, "Wallet balance should increase by duplicate amount (+1000)");

        const updatedOrder = await Order.findById(order._id);
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 1000, "duplicateRefundTotal should be 1000");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 0, "purchaseRefundTotal must remain 0");

        const dupAtt = updatedOrder.paymentAttempts.find((a) => a.razorpayPaymentId === dupPayId);
        assert.strictEqual(dupAtt.status, "REFUNDED_DUPLICATE", "Duplicate attempt status should be REFUNDED_DUPLICATE");
    });

    // =========================================================================
    // Test G: Genuine cancellation/return refund:
    // updates purchaseRefundTotal correctly.
    // =========================================================================
    await testCase("G: Genuine cancellation/return refund: updates purchaseRefundTotal correctly", async () => {
        const orderNumber = `TEST_BUG6_G_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 300;
        await wallet.save();

        const returnItemAmount = 500;
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_G_${Date.now()}`,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: returnItemAmount,
                    lineTotal: returnItemAmount,
                    finalPayable: returnItemAmount,
                    status: "RETURN_APPROVED",
                    returnReason: "Size mismatch",
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING",
                },
            ],
            pricing: {
                subtotal: returnItemAmount,
                shippingFee: 0,
                totalAmount: returnItemAmount,
                originalTotalAmount: returnItemAmount,
                collectedAmount: returnItemAmount,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        await recoverPendingRefunds(order._id);

        const updatedWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(updatedWallet.balance, 800, "Wallet balance should increase by 500 to 800");

        const updatedOrder = await Order.findById(order._id);
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal should be 500");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 0, "duplicateRefundTotal must be 0");
        assert.strictEqual(updatedOrder.items[0].refundStatus, "COMPLETED", "Item refundStatus should be COMPLETED");
    });

    // =========================================================================
    // Test H: Unpaid cancelled item:
    // no refund is created or issued.
    // =========================================================================
    await testCase("H: Unpaid cancelled item: no refund is created or issued", async () => {
        const orderNumber = `TEST_BUG6_H_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 500;
        await wallet.save();

        const itemAmount = 800;
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "PENDING", // UNPAID
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: itemAmount,
                    lineTotal: itemAmount,
                    finalPayable: itemAmount,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: true,
                    refundIssued: false,
                    refundStatus: "NONE",
                },
            ],
            pricing: {
                subtotal: itemAmount,
                shippingFee: 0,
                totalAmount: itemAmount,
                originalTotalAmount: itemAmount,
                collectedAmount: 0, // No money collected
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        await recoverPendingRefunds(order._id);

        const finalWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(finalWallet.balance, 500, "Wallet balance must remain 500 (NO refund issued)");

        const finalOrder = await Order.findById(order._id);
        assert.strictEqual(finalOrder.pricing.purchaseRefundTotal, 0, "purchaseRefundTotal must remain 0");
        assert.strictEqual(finalOrder.pricing.walletRefundIssued, 0, "walletRefundIssued must remain 0");
        assert.strictEqual(finalOrder.items[0].refundIssued, false, "Item refundIssued must remain false");
    });

    // =========================================================================
    // Test I: Missing wallet transaction record after a completed operation:
    // repair it without changing the balance again.
    // =========================================================================
    await testCase("I: Missing wallet transaction record after completed operation: repaired without re-crediting", async () => {
        const orderNumber = `TEST_BUG6_I_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 1000;
        wallet.appliedOperations = [];
        wallet.operationsLog = [];
        await wallet.save();

        const itemRefund = 700;
        const dummyOrderId = new mongoose.Types.ObjectId();
        const dummyItemId = new mongoose.Types.ObjectId();
        const refundRef = `REFUND_CAN_${dummyOrderId}_${dummyItemId}`;

        // Perform legitimate credit
        const credRes = await walletService.creditWallet({
            userId: testUser._id,
            amount: itemRefund,
            reason: "ORDER_CANCELLATION",
            description: `Refund for item in ${orderNumber}`,
            orderId: dummyOrderId,
            orderNumber,
            referenceId: refundRef,
        });
        assert(credRes.success === true, "Credit should succeed");

        const balanceAfterCredit = (await Wallet.findById(wallet._id)).balance;
        assert.strictEqual(balanceAfterCredit, 1700, "Wallet balance should be 1700");

        // Now simulate accidental deletion of the Transaction record
        await Transaction.deleteMany({ referenceId: refundRef });
        const txCheckBefore = await Transaction.findOne({ referenceId: refundRef });
        assert.strictEqual(txCheckBefore, null, "Transaction record should be gone");

        // Order has item cancelled
        const order = await Order.create({
            _id: dummyOrderId,
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_I_${Date.now()}`,
            items: [
                {
                    _id: dummyItemId,
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: itemRefund,
                    lineTotal: itemRefund,
                    finalPayable: itemRefund,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true,
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING",
                },
            ],
            pricing: {
                subtotal: itemRefund,
                shippingFee: 0,
                totalAmount: itemRefund,
                originalTotalAmount: itemRefund,
                collectedAmount: itemRefund,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Run recovery
        await recoverPendingRefunds(order._id);

        // Wallet balance must NOT change again!
        const finalWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(finalWallet.balance, 1700, "Wallet balance must remain 1700 (NO re-credit)");

        // Missing transaction record was reconstructed from wallet journal
        const restoredTx = await Transaction.findOne({ referenceId: refundRef });
        assert(restoredTx != null, "Missing Transaction record must be restored");
        assert.strictEqual(restoredTx.amount, itemRefund, "Restored Transaction must have correct amount");
        assert.strictEqual(restoredTx.type, "CREDIT", "Restored Transaction must be CREDIT");

        // Order counters updated
        const finalOrder = await Order.findById(order._id);
        assert.strictEqual(finalOrder.pricing.purchaseRefundTotal, 700, "purchaseRefundTotal should be 700");
    });

    // =========================================================================
    // Test J: Already-restored inventory:
    // refund recovery causes no additional stock increment.
    // =========================================================================
    await testCase("J: Already-restored inventory: refund recovery causes no additional stock increment", async () => {
        const orderNumber = `TEST_BUG6_J_${Date.now()}`;
        const wallet = await walletService.getOrCreateWallet(testUser._id);
        wallet.balance = 500;
        await wallet.save();

        testVariant.stock = 50;
        await testVariant.save();

        const itemRefund = 500;
        const order = await Order.create({
            orderNumber,
            userId: testUser._id,
            shippingAddress: defaultShippingAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_J_${Date.now()}`,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 2,
                    unitPrice: 250,
                    lineTotal: itemRefund,
                    finalPayable: itemRefund,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true, // Already restored!
                    restockedQuantity: 2,
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING",
                },
            ],
            pricing: {
                subtotal: itemRefund,
                shippingFee: 0,
                totalAmount: itemRefund,
                originalTotalAmount: itemRefund,
                collectedAmount: itemRefund,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Stock before recovery
        const stockBefore = (await Variant.findById(testVariant._id)).stock;
        assert.strictEqual(stockBefore, 50, "Initial variant stock is 50");

        // Run recovery
        await recoverPendingRefunds(order._id);

        // Stock after recovery
        const stockAfter = (await Variant.findById(testVariant._id)).stock;
        assert.strictEqual(stockAfter, 50, "Stock must remain 50 (NO duplicate inventory increment)");

        // Refund was issued
        const finalWallet = await Wallet.findById(wallet._id);
        assert.strictEqual(finalWallet.balance, 1000, "Wallet balance should be 1000 (+500)");
    });

    console.log("\n================================================================================");
    console.log(`TEST SUITE COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log("================================================================================");

    await mongoose.disconnect();
    if (failedTests > 0) {
        process.exit(1);
    }
}

runTestSuite().catch((err) => {
    console.error("Test runner crashed:", err);
    process.exit(1);
});
