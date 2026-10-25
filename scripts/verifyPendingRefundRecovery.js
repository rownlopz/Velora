/**
 * Specific Verification Script for: Missing Pending-Refund Recovery Fix
 * Isolated Test Database: mongodb://127.0.0.1:27017/velora_test_isolated_pending_recovery
 * 
 * Verifies all requirements:
 * 1. A failed refund is discovered and retried.
 * 2. The correct amount reaches the correct user's wallet.
 * 3. Repeated recovery credits the refund only once, using the same operation reference.
 * 4. Purchase refunds and duplicate-payment refunds remain separate.
 * 5. Recovery does not restore stock twice.
 * 6. The background job runs without missing-function errors.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_pending_recovery";

const User = require("../models/user/userModel");
const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Wallet = require("../models/user/walletModel");
const Transaction = require("../models/user/transactionModel");

const adminOrderService = require("../services/admin/orderService");
const userOrderService = require("../services/user/orderService");
const walletService = require("../services/user/walletService");

const { recoverPendingRefunds } = adminOrderService;

let userA, userB, testVariant, testProduct;

const defaultAddress = {
    firstName: "Pending",
    lastName: "Tester",
    addressLine1: "456 Recovery Blvd",
    addressLine2: "",
    phone: "9876543210",
    city: "Bangalore",
    state: "Karnataka",
    pinCode: 560001,
    country: "India",
};

async function setup() {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.dropDatabase();

    userA = await User.create({
        fullName: "User A",
        email: "usera@example.com",
        password: "hashed_dummy_password",
        phone: "9876543211",
        role: "USER",
        status: "Active",
        isEmailVerified: true,
    });
    await walletService.getOrCreateWallet(userA._id);

    userB = await User.create({
        fullName: "User B",
        email: "userb@example.com",
        password: "hashed_dummy_password",
        phone: "9876543212",
        role: "USER",
        status: "Active",
        isEmailVerified: true,
    });
    await walletService.getOrCreateWallet(userB._id);

    const category = await Category.create({
        name: "Test Cat",
        slug: "test-cat",
        isActive: true,
    });

    testProduct = await Product.create({
        name: "Test Recovery Shoes",
        slug: "test-recovery-shoes",
        categoryId: category._id,
        description: "Test description",
        status: "ACTIVE",
    });

    testVariant = await Variant.create({
        productId: testProduct._id,
        color: "Blue",
        size: "9",
        sku: "REC-SHOES-001",
        regularPrice: 800,
        salePrice: 800,
        stock: 50,
        isActive: true,
    });
}

async function run() {
    console.log("================================================================================");
    console.log("VERIFYING PENDING REFUND RECOVERY FIX");
    console.log(`Database: ${TEST_DB_URI}`);
    console.log("================================================================================\n");

    await setup();

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        process.stdout.write(`Testing ${name}... `);
        try {
            await fn();
            console.log("PASSED ✓");
            passed++;
        } catch (e) {
            console.log(`FAILED ✗\n  Error: ${e.message}`);
            console.error(e);
            failed++;
        }
    }

    // 1. A failed refund is discovered and retried
    let order1;
    await test("1. Failed refund is discovered and retried automatically by global scanner", async () => {
        const itemAmount = 800;
        order1 = await Order.create({
            orderNumber: `ORD_FAIL_${Date.now()}`,
            userId: userA._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_rec_${Date.now()}`,
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
                    cancelledBeforePayment: false,
                    isStockRestored: true,
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING", // Failed refund in pending state
                },
            ],
            pricing: {
                subtotal: itemAmount,
                shippingFee: 0,
                totalAmount: itemAmount,
                originalTotalAmount: itemAmount,
                collectedAmount: itemAmount,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        // Run recovery without targetOrderId (simulate background scanner)
        const scanResult = await recoverPendingRefunds();
        assert(scanResult.success === true, "Scanner should report success");
        assert(scanResult.totalOrdersScanned >= 1, "Should find at least 1 pending order");
        assert(scanResult.recoveredOrdersCount >= 1, "Should recover at least 1 order");

        const updatedOrder = await Order.findById(order1._id);
        assert.strictEqual(updatedOrder.items[0].refundStatus, "COMPLETED", "Item refundStatus should be COMPLETED");
        assert.strictEqual(updatedOrder.items[0].refundIssued, true, "Item refundIssued should be true");
    });

    // 2. The correct amount reaches the correct user's wallet
    await test("2. The correct amount reaches the correct user's wallet", async () => {
        const walletA = await Wallet.findOne({ userId: userA._id });
        const walletB = await Wallet.findOne({ userId: userB._id });

        assert.strictEqual(walletA.balance, 800, "User A wallet balance should be 800 (+800 refund)");
        assert.strictEqual(walletB.balance, 0, "User B wallet balance must remain 0");

        const tx = await Transaction.findOne({ orderId: order1._id });
        assert(tx != null, "A transaction record must exist for order1");
        assert.strictEqual(tx.userId.toString(), userA._id.toString(), "Transaction must belong to User A");
        assert.strictEqual(tx.amount, 800, "Transaction amount must be 800");
        assert.strictEqual(tx.type, "CREDIT", "Transaction type must be CREDIT");
    });

    // 3. Repeated recovery credits the refund only once, using the same operation reference
    await test("3. Repeated recovery credits the refund only once, using the same operation reference", async () => {
        const expectedRef = `REFUND_CAN_${order1._id}_${order1.items[0]._id}`;

        // Run recovery 3 more times
        await recoverPendingRefunds(order1._id);
        await recoverPendingRefunds(order1._id);
        await recoverPendingRefunds();

        const walletA = await Wallet.findOne({ userId: userA._id });
        assert.strictEqual(walletA.balance, 800, "User A wallet balance must remain 800 (NO duplicate credit)");

        const txs = await Transaction.find({ orderId: order1._id });
        assert.strictEqual(txs.length, 1, "There must be exactly 1 transaction record");
        assert.strictEqual(txs[0].referenceId, expectedRef, "Operation reference must match expected stable key");

        const updatedOrder = await Order.findById(order1._id);
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 800, "purchaseRefundTotal must remain 800");
    });

    // 4. Purchase refunds and duplicate-payment refunds remain separate
    await test("4. Purchase refunds and duplicate-payment refunds remain separate", async () => {
        const primaryPay = `pay_prim_${Date.now()}`;
        const dupPay = `pay_dup_${Date.now()}`;
        const orderAmount = 1200;

        const orderDup = await Order.create({
            orderNumber: `ORD_DUP_${Date.now()}`,
            userId: userB._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: primaryPay,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 1,
                    unitPrice: orderAmount,
                    lineTotal: orderAmount,
                    finalPayable: orderAmount,
                    status: "DELIVERED",
                },
            ],
            paymentAttempts: [
                {
                    gateway: "RAZORPAY",
                    attemptId: "att_1",
                    razorpayPaymentId: primaryPay,
                    amount: orderAmount,
                    status: "SUCCESS",
                },
                {
                    gateway: "RAZORPAY",
                    attemptId: "att_2",
                    razorpayPaymentId: dupPay,
                    amount: orderAmount,
                    status: "REFUND_PENDING", // Duplicate payment pending recovery!
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
        await recoverPendingRefunds(orderDup._id);

        const walletB = await Wallet.findOne({ userId: userB._id });
        assert.strictEqual(walletB.balance, 1200, "User B wallet should receive 1200 duplicate refund");

        const refreshedOrder = await Order.findById(orderDup._id);
        assert.strictEqual(refreshedOrder.pricing.duplicateRefundTotal, 1200, "duplicateRefundTotal must be 1200");
        assert.strictEqual(refreshedOrder.pricing.purchaseRefundTotal, 0, "purchaseRefundTotal must remain 0");

        const dupTx = await Transaction.findOne({ referenceId: `REFUND_DUP_${orderDup._id}_${dupPay}` });
        assert(dupTx != null, "Duplicate refund transaction must exist with stable REFUND_DUP_ reference");
        assert.strictEqual(dupTx.reason, "DUPLICATE_PAYMENT", "Reason must be DUPLICATE_PAYMENT");
    });

    // 5. Recovery does not restore stock twice
    await test("5. Recovery does not restore stock twice", async () => {
        testVariant.stock = 50;
        await testVariant.save();

        const orderStock = await Order.create({
            orderNumber: `ORD_STOCK_${Date.now()}`,
            userId: userA._id,
            shippingAddress: defaultAddress,
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: `pay_stk_${Date.now()}`,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: testProduct.name,
                    quantity: 3,
                    unitPrice: 800,
                    lineTotal: 2400,
                    finalPayable: 2400,
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBeforePayment: false,
                    isStockRestored: true, // Already restored previously!
                    restockedQuantity: 3,
                    refundIssued: false,
                    refundStatus: "REFUND_PENDING",
                },
            ],
            pricing: {
                subtotal: 2400,
                shippingFee: 0,
                totalAmount: 2400,
                originalTotalAmount: 2400,
                collectedAmount: 2400,
                currentPayable: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
        });

        const stockBefore = (await Variant.findById(testVariant._id)).stock;
        assert.strictEqual(stockBefore, 50, "Initial stock should be 50");

        await recoverPendingRefunds(orderStock._id);

        const stockAfter = (await Variant.findById(testVariant._id)).stock;
        assert.strictEqual(stockAfter, 50, "Stock must remain 50 after recovery (no second restoration)");

        // Run recovery again to confirm double idempotency
        await recoverPendingRefunds(orderStock._id);
        const stockAfter2 = (await Variant.findById(testVariant._id)).stock;
        assert.strictEqual(stockAfter2, 50, "Stock must still remain 50 after second recovery");
    });

    // 6. The background job runs without missing-function errors
    await test("6. Background job runs without missing-function errors", async () => {
        // Test user/orderService exported recoverPendingRefunds wrapper
        assert(typeof userOrderService.recoverPendingRefunds === "function", "userOrderService must export recoverPendingRefunds");
        const directRes = await userOrderService.recoverPendingRefunds();
        assert(directRes && typeof directRes === "object", "Direct call should return result object");

        // Test startReservationExpiryCron invocation
        let cronErrorCaught = null;
        try {
            // Start cron with short interval, immediately trigger recovery logic, then stop
            const cronId = userOrderService.startReservationExpiryCron(60000);
            assert(cronId != null, "startReservationExpiryCron should return interval ID");
            userOrderService.stopReservationExpiryCron();
        } catch (err) {
            cronErrorCaught = err;
        }
        assert.strictEqual(cronErrorCaught, null, "startReservationExpiryCron should not throw any error");
    });

    console.log("\n================================================================================");
    console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("================================================================================\n");

    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();

    if (failed > 0) process.exit(1);
}

run().catch((e) => {
    console.error("Test execution fatal error:", e);
    process.exit(1);
});
