/**
 * Verification Script for: False REFUNDED Status During Admin Cancellation Fix
 * Isolated Test Database: mongodb://127.0.0.1:27017/velora_test_isolated_admin_cancel
 * 
 * Verifies:
 * 1. Failed wallet credit does not mark payment REFUNDED.
 * 2. Partial refund success keeps the remaining amount pending.
 * 3. Recovery completes the outstanding refund exactly once.
 * 4. Successful full refund updates the status correctly.
 * 5. Admin item cancellation path handles failed/pending refund correctly.
 * 6. Repeated cancellation/recovery does not duplicate refunds or stock.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_admin_cancel";

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
    firstName: "AdminCancel",
    lastName: "Tester",
    addressLine1: "100 Admin Street",
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
        fullName: "Test Customer",
        email: "customer@example.com",
        password: "hashed_dummy_password",
        phone: "9876543210",
        role: "USER",
        status: "Active",
        isEmailVerified: true,
    });
    await walletService.getOrCreateWallet(testUser._id);

    const category = await Category.create({
        name: "Test Clothing",
        slug: "test-clothing",
        isActive: true,
    });

    testProduct = await Product.create({
        name: "Admin Test Jacket",
        slug: "admin-test-jacket",
        categoryId: category._id,
        description: "Admin test jacket description",
        status: "ACTIVE",
    });

    testVariant1 = await Variant.create({
        productId: testProduct._id,
        color: "Black",
        size: "M",
        sku: "JKT-BLK-M",
        regularPrice: 500,
        salePrice: 500,
        stock: 50,
        isActive: true,
    });

    testVariant2 = await Variant.create({
        productId: testProduct._id,
        color: "Black",
        size: "L",
        sku: "JKT-BLK-L",
        regularPrice: 400,
        salePrice: 400,
        stock: 50,
        isActive: true,
    });
}

async function runTests() {
    console.log("=== Starting Admin Cancellation Refund Verification Tests ===\n");
    await setup();

    const originalCreditWallet = walletService.creditWallet;

    // -------------------------------------------------------------
    // Test 1: Failed wallet credit does NOT mark payment REFUNDED
    // -------------------------------------------------------------
    console.log("--- Test 1: Failed wallet credit does not mark payment REFUNDED ---");
    {
        const stockBefore = (await Variant.findById(testVariant1._id)).stock;
        const initialWallet = await walletService.getOrCreateWallet(testUser._id);
        const walletBalBefore = initialWallet.balance;

        const order = await Order.create({
            orderNumber: "ORD-ADM-FAIL-01",
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
                    productName: "Admin Test Jacket M",
                    variantAttributes: { color: "Black", size: "M" },
                    sku: "JKT-BLK-M",
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
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                collectedAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
            },
        });

        const payment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 500,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            refundAmount: 0,
        });

        // Simulate creditWallet failure
        walletService.creditWallet = async () => ({
            success: false,
            message: "Simulated Wallet Service Failure",
        });

        const cancelRes = await updateOrderStatus(order._id, "CANCELLED", {
            adminNote: "Item damaged in warehouse",
        });

        assert.strictEqual(cancelRes.success, true, "Admin cancel operation succeeded");
        assert.strictEqual(cancelRes.hadRefundFailure, true, "Refund failure flagged");

        const updatedOrder = await Order.findById(order._id);
        const updatedPayment = await Payment.findById(payment._id);
        const stockAfter = (await Variant.findById(testVariant1._id)).stock;
        const walletBalAfter = (await walletService.getOrCreateWallet(testUser._id)).balance;

        assert.strictEqual(updatedOrder.orderStatus, "CANCELLED", "Order status is CANCELLED");
        assert.strictEqual(updatedOrder.paymentStatus, "COMPLETED", "Order paymentStatus MUST remain COMPLETED (NOT false REFUNDED)");
        assert.strictEqual(updatedPayment.status, "COMPLETED", "Payment status MUST remain COMPLETED (NOT false REFUNDED)");
        assert.strictEqual(updatedOrder.items[0].refundStatus, "REFUND_PENDING", "Item refundStatus is REFUND_PENDING");
        assert.strictEqual(updatedOrder.items[0].refundIssued, false, "Item refundIssued is false");
        assert.strictEqual(walletBalAfter, walletBalBefore, "Wallet balance did not increase when credit failed");
        assert.strictEqual(stockAfter, stockBefore + 1, "Stock was restored once");

        console.log("✔ Test 1 PASSED: Failed wallet credit preserves COMPLETED payment status and sets REFUND_PENDING without false refund.\n");
    }

    // -------------------------------------------------------------
    // Test 2: Partial refund success keeps remaining amount pending
    // -------------------------------------------------------------
    console.log("--- Test 2: Partial refund success keeps remaining amount pending ---");
    let partialOrder, partialPayment;
    {
        const stock1Before = (await Variant.findById(testVariant1._id)).stock;
        const stock2Before = (await Variant.findById(testVariant2._id)).stock;
        const walletBalBefore = (await walletService.getOrCreateWallet(testUser._id)).balance;

        partialOrder = await Order.create({
            orderNumber: "ORD-ADM-PARTIAL-02",
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
                    productName: "Admin Test Jacket M",
                    variantAttributes: { color: "Black", size: "M" },
                    sku: "JKT-BLK-M",
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
                    productName: "Admin Test Jacket L",
                    variantAttributes: { color: "Black", size: "L" },
                    sku: "JKT-BLK-L",
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
            },
        });

        partialPayment = await Payment.create({
            orderId: partialOrder._id,
            userId: testUser._id,
            amount: 900,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            refundAmount: 0,
        });

        // First item (500) succeeds, second item (400) fails
        walletService.creditWallet = async (params) => {
            if (params.amount === 500) {
                return originalCreditWallet(params);
            }
            return { success: false, message: "Simulated item 2 credit failure" };
        };

        const cancelRes = await updateOrderStatus(partialOrder._id, "CANCELLED", {
            adminNote: "Admin bulk cancel partial failure test",
        });

        assert.strictEqual(cancelRes.success, true, "Admin cancel operation succeeded");
        assert.strictEqual(cancelRes.hadRefundFailure, true, "Refund failure was flagged");

        const updatedOrder = await Order.findById(partialOrder._id);
        const updatedPayment = await Payment.findById(partialPayment._id);
        const stock1After = (await Variant.findById(testVariant1._id)).stock;
        const stock2After = (await Variant.findById(testVariant2._id)).stock;
        const walletBalAfter = (await walletService.getOrCreateWallet(testUser._id)).balance;

        assert.strictEqual(updatedOrder.orderStatus, "CANCELLED", "Order status is CANCELLED");
        assert.strictEqual(updatedOrder.paymentStatus, "COMPLETED", "Order paymentStatus MUST remain COMPLETED (NOT false REFUNDED)");
        assert.strictEqual(updatedPayment.status, "COMPLETED", "Payment status MUST remain COMPLETED (NOT false REFUNDED)");
        assert.strictEqual(updatedOrder.items[0].refundStatus, "COMPLETED", "Item 1 refundStatus is COMPLETED");
        assert.strictEqual(updatedOrder.items[0].refundIssued, true, "Item 1 refundIssued is true");
        assert.strictEqual(updatedOrder.items[1].refundStatus, "REFUND_PENDING", "Item 2 refundStatus is REFUND_PENDING");
        assert.strictEqual(updatedOrder.items[1].refundIssued, false, "Item 2 refundIssued is false");

        assert.strictEqual(walletBalAfter, walletBalBefore + 500, "Wallet received only successful ₹500");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 500, "purchaseRefundTotal is ₹500");
        assert.strictEqual(updatedPayment.refundAmount, 500, "Payment refundAmount is ₹500");
        assert.strictEqual(stock1After, stock1Before + 1, "Stock 1 restored");
        assert.strictEqual(stock2After, stock2Before + 1, "Stock 2 restored");

        console.log("✔ Test 2 PASSED: Partial refund credited successful amount (₹500), kept remaining (₹400) pending, and avoided false REFUNDED status.\n");
    }

    // -------------------------------------------------------------
    // Test 3: Recovery completes outstanding refund exactly once
    // -------------------------------------------------------------
    console.log("--- Test 3: Recovery completes outstanding refund exactly once ---");
    {
        // Restore real creditWallet implementation
        walletService.creditWallet = originalCreditWallet;

        const walletBalBefore = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const stock1Before = (await Variant.findById(testVariant1._id)).stock;
        const stock2Before = (await Variant.findById(testVariant2._id)).stock;

        // Run recovery
        const recoveryRes = await recoverPendingRefunds(partialOrder._id);
        assert.strictEqual(recoveryRes.success, true, "Recovery completed successfully");

        const recoveredOrder = await Order.findById(partialOrder._id);
        const recoveredPayment = await Payment.findById(partialPayment._id);
        const walletBalAfter = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const stock1After = (await Variant.findById(testVariant1._id)).stock;
        const stock2After = (await Variant.findById(testVariant2._id)).stock;

        assert.strictEqual(walletBalAfter, walletBalBefore + 400, "Wallet balance received outstanding ₹400");
        assert.strictEqual(recoveredOrder.paymentStatus, "REFUNDED", "Order paymentStatus updated to REFUNDED now that all items are refunded");
        assert.strictEqual(recoveredPayment.status, "REFUNDED", "Payment status updated to REFUNDED");
        assert.strictEqual(recoveredOrder.pricing.purchaseRefundTotal, 900, "Order purchaseRefundTotal is 900");
        assert.strictEqual(recoveredPayment.refundAmount, 900, "Payment refundAmount is 900");
        assert.strictEqual(recoveredOrder.items[1].refundStatus, "COMPLETED", "Item 2 refundStatus is COMPLETED");
        assert.strictEqual(recoveredOrder.items[1].refundIssued, true, "Item 2 refundIssued is true");
        assert.strictEqual(stock1After, stock1Before, "Stock 1 not duplicated during recovery");
        assert.strictEqual(stock2After, stock2Before, "Stock 2 not duplicated during recovery");

        // Run recovery AGAIN - verify exact idempotency
        await recoverPendingRefunds(partialOrder._id);
        const walletBalFinal = (await walletService.getOrCreateWallet(testUser._id)).balance;
        assert.strictEqual(walletBalFinal, walletBalAfter, "Second recovery did NOT duplicate refund");

        console.log("✔ Test 3 PASSED: Recovery completed outstanding refund (₹400), updated status to REFUNDED, and repeated recovery did not duplicate.\n");
    }

    // -------------------------------------------------------------
    // Test 4: Successful full refund updates status correctly
    // -------------------------------------------------------------
    console.log("--- Test 4: Successful full refund updates status correctly ---");
    {
        walletService.creditWallet = originalCreditWallet;

        const walletBalBefore = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const stockBefore = (await Variant.findById(testVariant1._id)).stock;

        const order = await Order.create({
            orderNumber: "ORD-ADM-SUCCESS-03",
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
                    productName: "Admin Test Jacket M",
                    variantAttributes: { color: "Black", size: "M" },
                    sku: "JKT-BLK-M",
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
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                collectedAmount: 500,
                originalTotalAmount: 500,
                currentPayable: 500,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
            },
        });

        const payment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 500,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            refundAmount: 0,
        });

        const cancelRes = await updateOrderStatus(order._id, "CANCELLED", {
            adminNote: "Customer requested cancellation via admin",
        });

        assert.strictEqual(cancelRes.success, true, "Admin cancel succeeded");
        assert.strictEqual(cancelRes.hadRefundFailure, false, "No refund failure flagged");

        const updatedOrder = await Order.findById(order._id);
        const updatedPayment = await Payment.findById(payment._id);
        const walletBalAfter = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const stockAfter = (await Variant.findById(testVariant1._id)).stock;

        assert.strictEqual(updatedOrder.orderStatus, "CANCELLED", "Order status is CANCELLED");
        assert.strictEqual(updatedOrder.paymentStatus, "REFUNDED", "Order paymentStatus is REFUNDED on full success");
        assert.strictEqual(updatedPayment.status, "REFUNDED", "Payment status is REFUNDED on full success");
        assert.strictEqual(updatedOrder.items[0].refundStatus, "COMPLETED", "Item refundStatus is COMPLETED");
        assert.strictEqual(updatedOrder.items[0].refundIssued, true, "Item refundIssued is true");
        assert.strictEqual(walletBalAfter, walletBalBefore + 500, "Wallet received full ₹500");
        assert.strictEqual(stockAfter, stockBefore + 1, "Stock restored once");

        console.log("✔ Test 4 PASSED: Successful full refund properly sets status to REFUNDED and restores stock.\n");
    }

    // -------------------------------------------------------------
    // Test 5: Admin item cancellation path handles failed/pending refund
    // -------------------------------------------------------------
    console.log("--- Test 5: Admin item cancellation path handles failed/pending refund ---");
    {
        const stock1Before = (await Variant.findById(testVariant1._id)).stock;
        const stock2Before = (await Variant.findById(testVariant2._id)).stock;

        const order = await Order.create({
            orderNumber: "ORD-ADM-ITEMCAN-04",
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
                    productName: "Admin Test Jacket M",
                    variantAttributes: { color: "Black", size: "M" },
                    sku: "JKT-BLK-M",
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
                    productName: "Admin Test Jacket L",
                    variantAttributes: { color: "Black", size: "L" },
                    sku: "JKT-BLK-L",
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
            },
        });

        const payment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 900,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            refundAmount: 0,
        });

        const item1Id = order.items[0]._id;
        const item2Id = order.items[1]._id;

        // Step A: Cancel item 1 with credit failure
        walletService.creditWallet = async () => ({
            success: false,
            message: "Simulated item credit error",
        });

        const item1CancelRes = await updateAdminOrderItemStatus(order._id, item1Id, "CANCELLED", {
            adminNote: "Item 1 damaged",
        });

        assert.strictEqual(item1CancelRes.success, true, "Item 1 cancel succeeded");
        assert.strictEqual(item1CancelRes.hadRefundFailure, true, "Refund failure was flagged");

        let ordCheck = await Order.findById(order._id);
        let payCheck = await Payment.findById(payment._id);

        assert.strictEqual(ordCheck.paymentStatus, "COMPLETED", "Order paymentStatus remains COMPLETED");
        assert.strictEqual(payCheck.status, "COMPLETED", "Payment status remains COMPLETED");
        assert.strictEqual(ordCheck.items.id(item1Id).refundStatus, "REFUND_PENDING", "Item 1 refundStatus is REFUND_PENDING");
        assert.strictEqual(ordCheck.items.id(item1Id).refundIssued, false, "Item 1 refundIssued is false");
        assert.strictEqual((await Variant.findById(testVariant1._id)).stock, stock1Before + 1, "Item 1 stock restored");

        // Step B: Recover Item 1 refund
        walletService.creditWallet = originalCreditWallet;
        await recoverPendingRefunds(order._id);

        ordCheck = await Order.findById(order._id);
        assert.strictEqual(ordCheck.items.id(item1Id).refundStatus, "COMPLETED", "Item 1 recovered to COMPLETED");
        assert.strictEqual(ordCheck.items.id(item1Id).refundIssued, true, "Item 1 refundIssued is true");
        assert.strictEqual(ordCheck.paymentStatus, "COMPLETED", "Order paymentStatus still COMPLETED because Item 2 is still active");

        // Step C: Now cancel Item 2 (last remaining item) with successful refund
        const item2CancelRes = await updateAdminOrderItemStatus(order._id, item2Id, "CANCELLED", {
            adminNote: "Item 2 cancelled by admin",
        });

        assert.strictEqual(item2CancelRes.success, true, "Item 2 cancel succeeded");

        ordCheck = await Order.findById(order._id);
        payCheck = await Payment.findById(payment._id);

        assert.strictEqual(ordCheck.orderStatus, "CANCELLED", "Order status is now CANCELLED");
        assert.strictEqual(ordCheck.paymentStatus, "REFUNDED", "Order paymentStatus is REFUNDED now that all items are cancelled and refunded");
        assert.strictEqual(payCheck.status, "REFUNDED", "Payment status is REFUNDED");
        assert.strictEqual(ordCheck.pricing.purchaseRefundTotal, 900, "purchaseRefundTotal is 900");
        assert.strictEqual(payCheck.refundAmount, 900, "Payment refundAmount is 900");
        assert.strictEqual((await Variant.findById(testVariant2._id)).stock, stock2Before + 1, "Item 2 stock restored once");

        console.log("✔ Test 5 PASSED: Admin item cancellation path prevents false REFUNDED status, handles recovery, and updates to REFUNDED when all items are cancelled.\n");
    }

    // -------------------------------------------------------------
    // Test 6: Repeated cancellation does not duplicate refunds or stock
    // -------------------------------------------------------------
    console.log("--- Test 6: Repeated cancellation/recovery does not duplicate refunds or stock ---");
    {
        walletService.creditWallet = originalCreditWallet;

        const order = await Order.findOne({ orderNumber: "ORD-ADM-SUCCESS-03" });
        const walletBalBefore = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const stockBefore = (await Variant.findById(testVariant1._id)).stock;
        const txCountBefore = await Transaction.countDocuments({ orderId: order._id });

        // Repeated cancellation call
        const repeatRes = await updateOrderStatus(order._id, "CANCELLED", {
            adminNote: "Second cancellation attempt",
        });

        // Repeated recovery call
        await recoverPendingRefunds(order._id);

        const walletBalAfter = (await walletService.getOrCreateWallet(testUser._id)).balance;
        const stockAfter = (await Variant.findById(testVariant1._id)).stock;
        const txCountAfter = await Transaction.countDocuments({ orderId: order._id });

        assert.strictEqual(walletBalAfter, walletBalBefore, "Wallet balance did not change on repeated cancel/recovery");
        assert.strictEqual(stockAfter, stockBefore, "Stock was not restocked twice");
        assert.strictEqual(txCountAfter, txCountBefore, "No new duplicate transactions created");

        console.log("✔ Test 6 PASSED: Repeated cancellation and recovery are fully idempotent (no duplicate refunds or stock).\n");
    }

    console.log("==================================================================");
    console.log("ALL 6 ADMIN CANCELLATION REFUND FIX TESTS PASSED SUCCESSFULLY! 🎉");
    console.log("==================================================================");
    await mongoose.connection.close();
}

runTests().catch((err) => {
    console.error("Test failed with error:", err);
    process.exit(1);
});
