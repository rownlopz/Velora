/**
 * Verification Script for: Inconsistent Refund Accounting During Admin Cancellation Fix
 * Isolated Test Database: mongodb://127.0.0.1:27017/velora_test_isolated_refund_accounting
 * 
 * Verifies:
 * 1. Successful cancellation refunds update purchaseRefundTotal correctly.
 * 2. duplicateRefundTotal remains unchanged.
 * 3. Failed or pending refunds are not counted as completed.
 * 4. Repeated cancellation or recovery does not duplicate credits or totals.
 * 5. Bulk and individual cancellation produce consistent accounting.
 * 6. Related payment refund records match the actual completed refunds.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_refund_accounting";

const User = require("../models/user/userModel");
const Category = require("../models/product/categoryModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Wallet = require("../models/user/walletModel");
const Transaction = require("../models/user/transactionModel");

const adminOrderService = require("../services/admin/orderService");
const walletService = require("../services/user/walletService");

const { updateOrderStatus, updateAdminOrderItemStatus, recoverPendingRefunds } = adminOrderService;

let testUser, testVariant1, testVariant2, testProduct;

const defaultAddress = {
    firstName: "Accounting",
    lastName: "Tester",
    addressLine1: "200 Ledger Way",
    city: "Bangalore",
    state: "Karnataka",
    pinCode: 560001,
    country: "India",
    phone: "9876543210",
};

async function setup() {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.dropDatabase();

    testUser = await User.create({
        fullName: "Accounting User",
        email: "accounting_user@example.com",
        password: "hashed_dummy_password",
        phone: "9876543210",
        role: "USER",
        status: "Active",
        isEmailVerified: true,
    });
    await walletService.getOrCreateWallet(testUser._id);

    const category = await Category.create({
        name: "Apparel",
        slug: "apparel",
        isActive: true,
    });

    testProduct = await Product.create({
        name: "Test Wool Sweater",
        slug: "test-wool-sweater",
        categoryId: category._id,
        description: "Test wool sweater",
        status: "ACTIVE",
    });

    testVariant1 = await Variant.create({
        productId: testProduct._id,
        color: "Navy",
        size: "M",
        sku: "SWT-NVY-M",
        regularPrice: 500,
        salePrice: 500,
        stock: 50,
        isActive: true,
    });

    testVariant2 = await Variant.create({
        productId: testProduct._id,
        color: "Navy",
        size: "L",
        sku: "SWT-NVY-L",
        regularPrice: 400,
        salePrice: 400,
        stock: 50,
        isActive: true,
    });
}

async function runTests() {
    console.log("================================================================================");
    console.log("VERIFYING INCONSISTENT REFUND ACCOUNTING FIX DURING ADMIN CANCELLATION");
    console.log(`Database: ${TEST_DB_URI}`);
    console.log("================================================================================\n");

    await setup();
    const originalCreditWallet = walletService.creditWallet;

    // -------------------------------------------------------------
    // Test 1 & 2: Bulk cancellation updates purchaseRefundTotal and preserves duplicateRefundTotal
    // -------------------------------------------------------------
    console.log("--- Test 1 & 2: Bulk cancellation updates purchaseRefundTotal and preserves duplicateRefundTotal ---");
    {
        const orderNum = `ORD-BULK-DUP-${Date.now()}`;
        const primaryPayId = `pay_primary_${Date.now()}`;
        const dupPayId = `pay_dup_${Date.now()}`;

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: primaryPaymentId = primaryPayId,
            items: [
                {
                    variantId: testVariant1._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater M",
                    variantAttributes: { color: "Navy", size: "M" },
                    sku: "SWT-NVY-M",
                    price: 500,
                    unitPrice: 500,
                    priceAtPurchase: 500,
                    quantity: 1,
                    lineTotal: 500,
                    finalPayable: 500,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
            ],
            paymentAttempts: [
                {
                    razorpayPaymentId: primaryPayId,
                    amount: 500,
                    status: "SUCCESS",
                },
                {
                    razorpayPaymentId: dupPayId,
                    amount: 1000,
                    status: "REFUNDED_DUPLICATE",
                },
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                collectedAmount: 1500,
                originalTotalAmount: 500,
                currentPayable: 500,
                walletRefundIssued: 1000,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 1000,
            },
        });

        const userWallet = await walletService.getOrCreateWallet(testUser._id);
        // Seed prior duplicate payment transaction in durable ledger
        await Transaction.create({
            walletId: userWallet._id,
            userId: testUser._id,
            type: "CREDIT",
            amount: 1000,
            balanceAfter: 1000,
            reason: "DUPLICATE_PAYMENT",
            orderId: order._id,
            orderNumber: order.orderNumber,
            referenceId: `REFUND_DUP_${order._id}_${dupPayId}`,
            description: `Duplicate refund for ${dupPayId}`,
        });

        const primaryPayment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 500,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayPaymentId: primaryPayId,
            refundAmount: 0,
        });

        const duplicatePayment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 1000,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "REFUNDED",
            razorpayPaymentId: dupPayId,
            refundAmount: 1000,
        });

        // Admin cancels the order
        const cancelRes = await updateOrderStatus(order._id, "CANCELLED", {
            adminNote: "Customer cancelled bulk order",
        });
        assert.strictEqual(cancelRes.success, true, "Bulk cancellation succeeded");

        const updatedOrder = await Order.findById(order._id);
        const updatedPrimaryPayment = await Payment.findById(primaryPayment._id);
        const updatedDupPayment = await Payment.findById(duplicatePayment._id);

        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal correctly updated to 500");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 1000, "duplicateRefundTotal remains strictly unchanged at 1000");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 1500, "walletRefundIssued correctly equals 500 + 1000 = 1500");
        assert.strictEqual(updatedPrimaryPayment.refundAmount, 500, "Primary payment refundAmount is 500 (not contaminated by duplicate refund)");
        assert.strictEqual(updatedPrimaryPayment.status, "REFUNDED", "Primary payment marked REFUNDED");
        assert.strictEqual(updatedDupPayment.refundAmount, 1000, "Duplicate payment refundAmount remains 1000");
        assert.strictEqual(updatedDupPayment.status, "REFUNDED", "Duplicate payment remains REFUNDED");

        console.log("✔ Test 1 & 2 PASSED: Bulk cancellation correctly updated purchaseRefundTotal to 500, preserved duplicateRefundTotal at 1000, and kept payment records distinct.\n");
    }

    // -------------------------------------------------------------
    // Test 3: Individual cancellation updates purchaseRefundTotal and preserves duplicateRefundTotal
    // -------------------------------------------------------------
    console.log("--- Test 3: Individual cancellation updates purchaseRefundTotal and preserves duplicateRefundTotal ---");
    {
        const orderNum = `ORD-INDIV-DUP-${Date.now()}`;
        const primaryPayId = `pay_primary_indiv_${Date.now()}`;
        const dupPayId = `pay_dup_indiv_${Date.now()}`;

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: primaryPayId,
            items: [
                {
                    variantId: testVariant1._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater M",
                    variantAttributes: { color: "Navy", size: "M" },
                    sku: "SWT-NVY-M",
                    price: 500,
                    unitPrice: 500,
                    priceAtPurchase: 500,
                    quantity: 1,
                    lineTotal: 500,
                    finalPayable: 500,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
                {
                    variantId: testVariant2._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater L",
                    variantAttributes: { color: "Navy", size: "L" },
                    sku: "SWT-NVY-L",
                    price: 400,
                    unitPrice: 400,
                    priceAtPurchase: 400,
                    quantity: 1,
                    lineTotal: 400,
                    finalPayable: 400,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
            ],
            paymentAttempts: [
                {
                    razorpayPaymentId: primaryPayId,
                    amount: 900,
                    status: "SUCCESS",
                },
                {
                    razorpayPaymentId: dupPayId,
                    amount: 900,
                    status: "REFUNDED_DUPLICATE",
                },
            ],
            pricing: {
                subtotal: 900,
                shippingFee: 0,
                totalAmount: 900,
                collectedAmount: 1800,
                originalTotalAmount: 900,
                currentPayable: 900,
                walletRefundIssued: 900,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 900,
            },
        });

        const userWallet2 = await walletService.getOrCreateWallet(testUser._id);
        await Transaction.create({
            walletId: userWallet2._id,
            userId: testUser._id,
            type: "CREDIT",
            amount: 900,
            balanceAfter: 1900,
            reason: "DUPLICATE_PAYMENT",
            orderId: order._id,
            orderNumber: order.orderNumber,
            referenceId: `REFUND_DUP_${order._id}_${dupPayId}`,
            description: `Duplicate refund for ${dupPayId}`,
        });

        const primaryPayment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 900,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayPaymentId: primaryPayId,
            refundAmount: 0,
        });

        const duplicatePayment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 900,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "REFUNDED",
            razorpayPaymentId: dupPayId,
            refundAmount: 900,
        });

        const item1Id = order.items[0]._id;
        const item2Id = order.items[1]._id;

        // Cancel Item 1 (500)
        const can1 = await updateAdminOrderItemStatus(order._id, item1Id, "CANCELLED", {
            adminNote: "Cancel item 1",
        });
        assert.strictEqual(can1.success, true);

        let ordState = await Order.findById(order._id);
        let primPayState = await Payment.findById(primaryPayment._id);
        let dupPayState = await Payment.findById(duplicatePayment._id);

        assert.strictEqual(ordState.pricing.purchaseRefundTotal, 500, "Step 1: purchaseRefundTotal is 500");
        assert.strictEqual(ordState.pricing.duplicateRefundTotal, 900, "Step 1: duplicateRefundTotal is 900");
        assert.strictEqual(ordState.pricing.walletRefundIssued, 1400, "Step 1: walletRefundIssued is 1400");
        assert.strictEqual(primPayState.refundAmount, 500, "Step 1: primary payment refundAmount is 500");
        assert.strictEqual(primPayState.status, "COMPLETED", "Step 1: primary payment remains COMPLETED (item 2 active)");
        assert.strictEqual(dupPayState.refundAmount, 900, "Step 1: duplicate payment refundAmount remains 900");

        // Cancel Item 2 (400)
        const can2 = await updateAdminOrderItemStatus(order._id, item2Id, "CANCELLED", {
            adminNote: "Cancel item 2",
        });
        assert.strictEqual(can2.success, true);

        ordState = await Order.findById(order._id);
        primPayState = await Payment.findById(primaryPayment._id);
        dupPayState = await Payment.findById(duplicatePayment._id);

        assert.strictEqual(ordState.pricing.purchaseRefundTotal, 900, "Step 2: purchaseRefundTotal is 900");
        assert.strictEqual(ordState.pricing.duplicateRefundTotal, 900, "Step 2: duplicateRefundTotal is 900");
        assert.strictEqual(ordState.pricing.walletRefundIssued, 1800, "Step 2: walletRefundIssued is 1800");
        assert.strictEqual(primPayState.refundAmount, 900, "Step 2: primary payment refundAmount is 900");
        assert.strictEqual(primPayState.status, "REFUNDED", "Step 2: primary payment marked REFUNDED");
        assert.strictEqual(dupPayState.refundAmount, 900, "Step 2: duplicate payment refundAmount remains 900");

        console.log("✔ Test 3 PASSED: Individual cancellation incrementally updated purchaseRefundTotal to 500 then 900 without altering duplicateRefundTotal.\n");
    }

    // -------------------------------------------------------------
    // Test 4: Failed or pending refunds are NOT counted in purchaseRefundTotal
    // -------------------------------------------------------------
    console.log("--- Test 4: Failed or pending refunds are not counted as completed ---");
    {
        const orderNum = `ORD-FAIL-COUNT-${Date.now()}`;
        const primaryPayId = `pay_primary_fail_${Date.now()}`;

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: primaryPayId,
            items: [
                {
                    variantId: testVariant1._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater M",
                    variantAttributes: { color: "Navy", size: "M" },
                    sku: "SWT-NVY-M",
                    price: 500,
                    unitPrice: 500,
                    priceAtPurchase: 500,
                    quantity: 1,
                    lineTotal: 500,
                    finalPayable: 500,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
                {
                    variantId: testVariant2._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater L",
                    variantAttributes: { color: "Navy", size: "L" },
                    sku: "SWT-NVY-L",
                    price: 400,
                    unitPrice: 400,
                    priceAtPurchase: 400,
                    quantity: 1,
                    lineTotal: 400,
                    finalPayable: 400,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
            ],
            pricing: {
                subtotal: 900,
                shippingFee: 0,
                totalAmount: 900,
                collectedAmount: 900,
                originalTotalAmount: 900,
                currentPayable: 900,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        const payment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 900,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayPaymentId: primaryPayId,
            refundAmount: 0,
        });

        // Item 1 succeeds (500), Item 2 fails (400)
        walletService.creditWallet = async (params) => {
            if (params.amount === 500) {
                return originalCreditWallet(params);
            }
            return { success: false, message: "Simulated failure for Item 2" };
        };

        const cancelRes = await updateOrderStatus(order._id, "CANCELLED", {
            adminNote: "Cancel with partial failure",
        });

        assert.strictEqual(cancelRes.success, true);
        assert.strictEqual(cancelRes.hadRefundFailure, true);

        let ordCheck = await Order.findById(order._id);
        let payCheck = await Payment.findById(payment._id);

        assert.strictEqual(ordCheck.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal ONLY counts the successful 500 (NOT pending 400)");
        assert.strictEqual(ordCheck.pricing.walletRefundIssued, 500, "walletRefundIssued ONLY counts 500");
        assert.strictEqual(payCheck.refundAmount, 500, "Payment refundAmount ONLY reflects the successful 500");
        assert.strictEqual(payCheck.status, "COMPLETED", "Payment status remains COMPLETED due to pending item");

        // Now recover with normal creditWallet
        walletService.creditWallet = originalCreditWallet;
        await recoverPendingRefunds(order._id);

        ordCheck = await Order.findById(order._id);
        payCheck = await Payment.findById(payment._id);

        assert.strictEqual(ordCheck.pricing.purchaseRefundTotal, 900, "After recovery: purchaseRefundTotal is full 900");
        assert.strictEqual(ordCheck.pricing.walletRefundIssued, 900, "After recovery: walletRefundIssued is full 900");
        assert.strictEqual(payCheck.refundAmount, 900, "After recovery: Payment refundAmount is full 900");
        assert.strictEqual(payCheck.status, "REFUNDED", "After recovery: Payment status is REFUNDED");

        console.log("✔ Test 4 PASSED: Pending refunds are not counted as completed, and recovery updates purchaseRefundTotal exactly once.\n");
    }

    // -------------------------------------------------------------
    // Test 5: Bulk and individual cancellation produce consistent accounting
    // -------------------------------------------------------------
    console.log("--- Test 5: Bulk and individual cancellation produce consistent accounting ---");
    {
        walletService.creditWallet = originalCreditWallet;

        // Create Order 1 for Bulk Cancellation
        const orderBulk = await Order.create({
            orderNumber: `ORD-CONSIST-BULK-${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            items: [
                {
                    variantId: testVariant1._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater M",
                    variantAttributes: { color: "Navy", size: "M" },
                    sku: "SWT-NVY-M",
                    price: 500,
                    unitPrice: 500,
                    priceAtPurchase: 500,
                    quantity: 1,
                    lineTotal: 500,
                    finalPayable: 500,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
                {
                    variantId: testVariant2._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater L",
                    variantAttributes: { color: "Navy", size: "L" },
                    sku: "SWT-NVY-L",
                    price: 400,
                    unitPrice: 400,
                    priceAtPurchase: 400,
                    quantity: 1,
                    lineTotal: 400,
                    finalPayable: 400,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
            ],
            pricing: {
                subtotal: 900,
                shippingFee: 0,
                totalAmount: 900,
                collectedAmount: 900,
                originalTotalAmount: 900,
                currentPayable: 900,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: orderBulk._id,
            userId: testUser._id,
            amount: 900,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            refundAmount: 0,
        });

        // Create Order 2 for Individual Cancellation
        const orderIndiv = await Order.create({
            orderNumber: `ORD-CONSIST-INDIV-${Date.now()}`,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            items: [
                {
                    variantId: testVariant1._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater M",
                    variantAttributes: { color: "Navy", size: "M" },
                    sku: "SWT-NVY-M",
                    price: 500,
                    unitPrice: 500,
                    priceAtPurchase: 500,
                    quantity: 1,
                    lineTotal: 500,
                    finalPayable: 500,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
                {
                    variantId: testVariant2._id,
                    productId: testProduct._id,
                    productName: "Test Wool Sweater L",
                    variantAttributes: { color: "Navy", size: "L" },
                    sku: "SWT-NVY-L",
                    price: 400,
                    unitPrice: 400,
                    priceAtPurchase: 400,
                    quantity: 1,
                    lineTotal: 400,
                    finalPayable: 400,
                    status: "PROCESSING",
                    refundIssued: false,
                    isStockRestored: false,
                },
            ],
            pricing: {
                subtotal: 900,
                shippingFee: 0,
                totalAmount: 900,
                collectedAmount: 900,
                originalTotalAmount: 900,
                currentPayable: 900,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: orderIndiv._id,
            userId: testUser._id,
            amount: 900,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            refundAmount: 0,
        });

        // Perform bulk cancellation on Order 1
        await updateOrderStatus(orderBulk._id, "CANCELLED");

        // Perform individual item cancellations on Order 2
        await updateAdminOrderItemStatus(orderIndiv._id, orderIndiv.items[0]._id, "CANCELLED");
        await updateAdminOrderItemStatus(orderIndiv._id, orderIndiv.items[1]._id, "CANCELLED");

        const finalBulk = await Order.findById(orderBulk._id);
        const finalIndiv = await Order.findById(orderIndiv._id);

        assert.strictEqual(finalBulk.orderStatus, finalIndiv.orderStatus, "Order statuses match ('CANCELLED')");
        assert.strictEqual(finalBulk.paymentStatus, finalIndiv.paymentStatus, "Payment statuses match ('REFUNDED')");
        assert.strictEqual(finalBulk.pricing.purchaseRefundTotal, finalIndiv.pricing.purchaseRefundTotal, "purchaseRefundTotal match (900)");
        assert.strictEqual(finalBulk.pricing.duplicateRefundTotal, finalIndiv.pricing.duplicateRefundTotal, "duplicateRefundTotal match (0)");
        assert.strictEqual(finalBulk.pricing.walletRefundIssued, finalIndiv.pricing.walletRefundIssued, "walletRefundIssued match (900)");
        assert.strictEqual(finalBulk.pricing.currentPayable, finalIndiv.pricing.currentPayable, "currentPayable match (0)");

        console.log("✔ Test 5 PASSED: Bulk and individual cancellations produce perfectly identical and consistent accounting.\n");
    }

    // -------------------------------------------------------------
    // Test 6: Repeated cancellation or recovery does not duplicate credits or totals
    // -------------------------------------------------------------
    console.log("--- Test 6: Repeated cancellation or recovery does not duplicate credits or totals ---");
    {
        walletService.creditWallet = originalCreditWallet;

        const order = await Order.findOne({ orderNumber: { $regex: "ORD-CONSIST-BULK" } });
        const walletBalBefore = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const txCountBefore = await Transaction.countDocuments({ orderId: order._id });

        // Repeated bulk cancel attempt
        await updateOrderStatus(order._id, "CANCELLED", { adminNote: "Repeat cancel" });

        // Repeated recovery
        await recoverPendingRefunds(order._id);

        const walletBalAfter = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const txCountAfter = await Transaction.countDocuments({ orderId: order._id });
        const refreshedOrder = await Order.findById(order._id);

        assert.strictEqual(walletBalAfter, walletBalBefore, "Wallet balance did not increase on repetition");
        assert.strictEqual(txCountAfter, txCountBefore, "Transaction count did not increase");
        assert.strictEqual(refreshedOrder.pricing.purchaseRefundTotal, 900, "purchaseRefundTotal did not duplicate");
        assert.strictEqual(refreshedOrder.pricing.walletRefundIssued, 900, "walletRefundIssued did not duplicate");

        console.log("✔ Test 6 PASSED: Repeated operations are strictly idempotent with no duplicated credits or totals.\n");
    }

    console.log("================================================================================");
    console.log("ALL 6 REFUND ACCOUNTING TESTS PASSED SUCCESSFULLY! 🎉");
    console.log("================================================================================");
    await mongoose.connection.close();
}

runTests().catch((err) => {
    console.error("Test failed with error:", err);
    process.exit(1);
});
