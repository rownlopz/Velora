/**
 * Verification Script for: Manual-Refund Calculation Fix in services/admin/orderService.js -> updatePaymentStatus()
 * Isolated Test Database: mongodb://127.0.0.1:27017/velora_test_isolated_manual_refund
 * 
 * Verifies:
 * 1. User's exact example: Original purchase ₹1,000 paid + Extra duplicate payment ₹1,000 already refunded.
 *    Admin refunds original purchase -> Another ₹1,000 reaches the wallet, purchaseRefundTotal = 1,000,
 *    duplicateRefundTotal remains 1,000, walletRefundIssued = 2,000, and paymentStatus becomes REFUNDED.
 * 2. Ordinary refund: ₹800 paid, no prior refunds -> Exactly ₹800 credited, payment becomes REFUNDED.
 * 3. Partially refunded purchase: ₹1,000 paid, ₹400 refunded previously -> Only remaining ₹600 credited.
 * 4. Repeated requests: Repeated calls to updatePaymentStatus(orderId, "REFUNDED") do NOT issue duplicate credits.
 * 5. Failed wallet credit: Does not mark payment REFUNDED and remains fully recoverable on retry.
 * 6. Unpaid order: Cannot be marked REFUNDED and credits ₹0.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const assert = require("assert");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_manual_refund";

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

const { updatePaymentStatus } = adminOrderService;

let testUser, testVariant, testProduct;

const defaultAddress = {
    firstName: "Manual",
    lastName: "Tester",
    addressLine1: "100 Refund Avenue",
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
        fullName: "Manual Refund Tester",
        email: "manual_refund@example.com",
        password: "hashed_dummy_password",
        phone: "9876543210",
        role: "USER",
        status: "Active",
        isEmailVerified: true,
    });
    await walletService.getOrCreateWallet(testUser._id);

    const category = await Category.create({
        name: "Apparel",
        slug: "apparel-manual",
        isActive: true,
    });

    testProduct = await Product.create({
        name: "Test Oxford Shirt",
        slug: "test-oxford-shirt",
        categoryId: category._id,
        description: "Test oxford shirt",
        status: "ACTIVE",
    });

    testVariant = await Variant.create({
        productId: testProduct._id,
        color: "Blue",
        size: "M",
        sku: "OXF-BLU-M",
        regularPrice: 1000,
        salePrice: 1000,
        stock: 50,
        isActive: true,
    });
}

async function runTests() {
    console.log("================================================================================");
    console.log("VERIFYING MANUAL-REFUND CALCULATION FIX IN updatePaymentStatus()");
    console.log(`Database: ${TEST_DB_URI}`);
    console.log("================================================================================\n");

    await setup();
    const originalCreditWallet = walletService.creditWallet;

    // -------------------------------------------------------------
    // Test 1: User's Exact Example
    // Original purchase paid: ₹1,000.
    // Extra payment already refunded: ₹1,000.
    // Admin refunds the original purchase.
    // Expected: another ₹1,000 reaches the wallet.
    // Duplicate-payment refund remains separate.
    // -------------------------------------------------------------
    console.log("--- Test 1: User's Example (Extra Duplicate Payment ₹1,000 Refunded, Now Refund Purchase ₹1,000) ---");
    {
        const orderNum = `ORD-DUP-EX-${Date.now()}`;
        const primaryPayId = `pay_primary_${Date.now()}`;
        const dupPayId = `pay_dup_${Date.now()}`;

        const userWallet = await walletService.getOrCreateWallet(testUser._id);
        const initialWalletBalance = userWallet.balance;

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
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: "Test Oxford Shirt M",
                    variantAttributes: { color: "Blue", size: "M" },
                    sku: "OXF-BLU-M",
                    price: 1000,
                    unitPrice: 1000,
                    priceAtPurchase: 1000,
                    quantity: 1,
                    lineTotal: 1000,
                    finalPayable: 1000,
                    status: "PROCESSING",
                    refundIssued: false,
                },
            ],
            paymentAttempts: [
                {
                    razorpayPaymentId: primaryPayId,
                    amount: 1000,
                    status: "SUCCESS",
                },
                {
                    razorpayPaymentId: dupPayId,
                    amount: 1000,
                    status: "REFUNDED_DUPLICATE",
                },
            ],
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                totalAmount: 1000,
                collectedAmount: 2000, // Total collected was 2000 (1000 purchase + 1000 duplicate)
                originalTotalAmount: 1000,
                currentPayable: 1000,
                walletRefundIssued: 1000,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 1000,
            },
        });

        // Seed prior duplicate refund in durable ledger
        await Transaction.create({
            walletId: userWallet._id,
            userId: testUser._id,
            type: "CREDIT",
            amount: 1000,
            balanceAfter: initialWalletBalance + 1000,
            reason: "DUPLICATE_PAYMENT",
            orderId: order._id,
            orderNumber: order.orderNumber,
            referenceId: `REFUND_DUP_${order._id}_${dupPayId}`,
            description: `Duplicate refund for ${dupPayId}`,
        });
        await Wallet.updateOne({ _id: userWallet._id }, { $inc: { balance: 1000 } });

        const primaryPayment = await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 1000,
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

        const walletBefore = (await Wallet.findById(userWallet._id)).balance;

        // Admin performs manual refund
        const refundRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(refundRes.success, true, "Manual refund succeeded");

        const walletAfter = (await Wallet.findById(userWallet._id)).balance;
        const creditedAmount = walletAfter - walletBefore;

        assert.strictEqual(creditedAmount, 1000, `Expected exactly ₹1,000 credited to wallet, got ₹${creditedAmount}`);

        const updatedOrder = await Order.findById(order._id);
        const updatedPrimaryPayment = await Payment.findById(primaryPayment._id);
        const updatedDupPayment = await Payment.findById(duplicatePayment._id);

        assert.strictEqual(updatedOrder.paymentStatus, "REFUNDED", "Order paymentStatus is REFUNDED");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 1000, "purchaseRefundTotal correctly updated to 1000");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 1000, "duplicateRefundTotal preserved at 1000");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 2000, "walletRefundIssued equals 2000 (1000 purchase + 1000 duplicate)");
        assert.strictEqual(updatedPrimaryPayment.refundAmount, 1000, "Primary payment refundAmount updated to 1000");
        assert.strictEqual(updatedPrimaryPayment.status, "REFUNDED", "Primary payment status is REFUNDED");
        assert.strictEqual(updatedDupPayment.refundAmount, 1000, "Duplicate payment refundAmount remains 1000");

        console.log("✓ PASS: User's example verified: another ₹1,000 reached wallet, purchase and duplicate refunds kept strictly separate.\n");
    }

    // -------------------------------------------------------------
    // Test 2: Ordinary Refund (No Prior Refunds)
    // -------------------------------------------------------------
    console.log("--- Test 2: Ordinary Refund (₹800 Paid, No Prior Refunds) ---");
    {
        const orderNum = `ORD-ORD-${Date.now()}`;
        const payId = `pay_ord_${Date.now()}`;

        const userWallet = await walletService.getOrCreateWallet(testUser._id);
        const walletBefore = userWallet.balance;

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: payId,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: "Test Oxford Shirt M",
                    variantAttributes: { color: "Blue", size: "M" },
                    sku: "OXF-BLU-M",
                    price: 800,
                    unitPrice: 800,
                    priceAtPurchase: 800,
                    quantity: 1,
                    lineTotal: 800,
                    finalPayable: 800,
                    status: "PROCESSING",
                    refundIssued: false,
                },
            ],
            paymentAttempts: [
                {
                    razorpayPaymentId: payId,
                    amount: 800,
                    status: "SUCCESS",
                },
            ],
            pricing: {
                subtotal: 800,
                shippingFee: 0,
                totalAmount: 800,
                collectedAmount: 800,
                originalTotalAmount: 800,
                currentPayable: 800,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 800,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayPaymentId: payId,
            refundAmount: 0,
        });

        const refundRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(refundRes.success, true, "Ordinary refund succeeded");

        const walletAfter = (await Wallet.findById(userWallet._id)).balance;
        assert.strictEqual(walletAfter - walletBefore, 800, "Exactly ₹800 credited to wallet");

        const updatedOrder = await Order.findById(order._id);
        assert.strictEqual(updatedOrder.paymentStatus, "REFUNDED", "Order paymentStatus is REFUNDED");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 800, "purchaseRefundTotal is 800");
        assert.strictEqual(updatedOrder.pricing.duplicateRefundTotal, 0, "duplicateRefundTotal is 0");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 800, "walletRefundIssued is 800");

        console.log("✓ PASS: Ordinary refund correctly credited ₹800.\n");
    }

    // -------------------------------------------------------------
    // Test 3: Partially Refunded Purchase
    // Original paid: ₹1,000. Prior partial refund: ₹400.
    // Admin marks payment as REFUNDED.
    // Expected: remaining ₹600 credited to wallet.
    // -------------------------------------------------------------
    console.log("--- Test 3: Partially Refunded Purchase (₹1,000 Paid, ₹400 Already Refunded) ---");
    {
        const orderNum = `ORD-PART-${Date.now()}`;
        const payId = `pay_part_${Date.now()}`;

        const userWallet = await walletService.getOrCreateWallet(testUser._id);
        const walletBefore = userWallet.balance;

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: payId,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: "Item 1",
                    sku: "ITEM-1",
                    price: 400,
                    unitPrice: 400,
                    priceAtPurchase: 400,
                    quantity: 1,
                    lineTotal: 400,
                    finalPayable: 400,
                    status: "CANCELLED",
                    refundIssued: true,
                    refundAmount: 400,
                    refundStatus: "COMPLETED",
                },
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: "Item 2",
                    sku: "ITEM-2",
                    price: 600,
                    unitPrice: 600,
                    priceAtPurchase: 600,
                    quantity: 1,
                    lineTotal: 600,
                    finalPayable: 600,
                    status: "PROCESSING",
                    refundIssued: false,
                },
            ],
            paymentAttempts: [
                {
                    razorpayPaymentId: payId,
                    amount: 1000,
                    status: "SUCCESS",
                },
            ],
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                totalAmount: 1000,
                collectedAmount: 1000,
                originalTotalAmount: 1000,
                currentPayable: 600,
                walletRefundIssued: 400,
                purchaseRefundTotal: 400,
                duplicateRefundTotal: 0,
            },
        });

        // Seed prior partial refund in durable ledger
        await Transaction.create({
            walletId: userWallet._id,
            userId: testUser._id,
            type: "CREDIT",
            amount: 400,
            balanceAfter: walletBefore + 400,
            reason: "ORDER_CANCELLATION",
            orderId: order._id,
            orderNumber: order.orderNumber,
            referenceId: `REFUND_CAN_${order._id}_item1`,
            description: `Cancellation refund for item 1`,
        });
        await Wallet.updateOne({ _id: userWallet._id }, { $inc: { balance: 400 } });
        const walletBeforeManualRefund = (await Wallet.findById(userWallet._id)).balance;

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 1000,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayPaymentId: payId,
            refundAmount: 400,
        });

        const refundRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(refundRes.success, true, "Partially refunded order manual refund succeeded");

        const walletAfter = (await Wallet.findById(userWallet._id)).balance;
        const deltaCredited = walletAfter - walletBeforeManualRefund;
        assert.strictEqual(deltaCredited, 600, `Expected remaining ₹600 credited, got ₹${deltaCredited}`);

        const updatedOrder = await Order.findById(order._id);
        assert.strictEqual(updatedOrder.paymentStatus, "REFUNDED", "Order paymentStatus is REFUNDED");
        assert.strictEqual(updatedOrder.pricing.purchaseRefundTotal, 1000, "purchaseRefundTotal updated to 1000");
        assert.strictEqual(updatedOrder.pricing.walletRefundIssued, 1000, "walletRefundIssued updated to 1000");

        console.log("✓ PASS: Partially refunded purchase correctly received remaining ₹600.\n");
    }

    // -------------------------------------------------------------
    // Test 4: Repeated Requests (Idempotency Guard)
    // -------------------------------------------------------------
    console.log("--- Test 4: Repeated Requests (No Duplicate Wallet Credits) ---");
    {
        const orderNum = `ORD-REPEAT-${Date.now()}`;
        const payId = `pay_repeat_${Date.now()}`;

        const userWallet = await walletService.getOrCreateWallet(testUser._id);

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: payId,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: "Test Item",
                    sku: "ITEM-REP",
                    price: 500,
                    unitPrice: 500,
                    priceAtPurchase: 500,
                    quantity: 1,
                    lineTotal: 500,
                    finalPayable: 500,
                    status: "PROCESSING",
                    refundIssued: false,
                },
            ],
            paymentAttempts: [
                {
                    razorpayPaymentId: payId,
                    amount: 500,
                    status: "SUCCESS",
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
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 500,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayPaymentId: payId,
            refundAmount: 0,
        });

        // First call
        const firstRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(firstRes.success, true, "First refund succeeded");

        const walletAfterFirst = (await Wallet.findById(userWallet._id)).balance;
        const txCountAfterFirst = await Transaction.countDocuments({ orderId: order._id });

        // Second call (repeated request)
        const secondRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(secondRes.success, true, "Second refund succeeded idempotently");

        const walletAfterSecond = (await Wallet.findById(userWallet._id)).balance;
        const txCountAfterSecond = await Transaction.countDocuments({ orderId: order._id });

        assert.strictEqual(walletAfterSecond, walletAfterFirst, "Wallet balance strictly unchanged on repeated request");
        assert.strictEqual(txCountAfterSecond, txCountAfterFirst, "No duplicate transaction created on repeated request");

        // Third call
        const thirdRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(thirdRes.success, true, "Third refund succeeded idempotently");

        const walletAfterThird = (await Wallet.findById(userWallet._id)).balance;
        assert.strictEqual(walletAfterThird, walletAfterFirst, "Wallet balance strictly unchanged on third request");

        console.log("✓ PASS: Repeated requests are strictly idempotent with 0 duplicate credits.\n");
    }

    // -------------------------------------------------------------
    // Test 5: Failed Wallet Credit Does Not Mark REFUNDED & Remains Recoverable
    // -------------------------------------------------------------
    console.log("--- Test 5: Failed Wallet Credit Handling & Recovery ---");
    {
        const orderNum = `ORD-FAIL-${Date.now()}`;
        const payId = `pay_fail_${Date.now()}`;

        const userWallet = await walletService.getOrCreateWallet(testUser._id);
        const walletBefore = userWallet.balance;

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PROCESSING",
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: payId,
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: "Test Item",
                    sku: "ITEM-FAIL",
                    price: 750,
                    unitPrice: 750,
                    priceAtPurchase: 750,
                    quantity: 1,
                    lineTotal: 750,
                    finalPayable: 750,
                    status: "PROCESSING",
                    refundIssued: false,
                },
            ],
            paymentAttempts: [
                {
                    razorpayPaymentId: payId,
                    amount: 750,
                    status: "SUCCESS",
                },
            ],
            pricing: {
                subtotal: 750,
                shippingFee: 0,
                totalAmount: 750,
                collectedAmount: 750,
                originalTotalAmount: 750,
                currentPayable: 750,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        await Payment.create({
            orderId: order._id,
            userId: testUser._id,
            amount: 750,
            currency: "INR",
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            razorpayPaymentId: payId,
            refundAmount: 0,
        });

        // Simulate wallet service failure
        walletService.creditWallet = async () => ({
            success: false,
            message: "Simulated wallet ledger outage",
        });

        const failedRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(failedRes.success, false, "Failed refund returned failure");

        const unrefundedOrder = await Order.findById(order._id);
        assert.strictEqual(unrefundedOrder.paymentStatus, "COMPLETED", "paymentStatus was NOT marked REFUNDED on credit failure");
        assert.strictEqual(unrefundedOrder.pricing.purchaseRefundTotal, 0, "purchaseRefundTotal remained 0");

        // Restore wallet service
        walletService.creditWallet = originalCreditWallet;

        // Retry manual refund
        const retryRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(retryRes.success, true, "Retry succeeded after wallet recovered");

        const walletAfter = (await Wallet.findById(userWallet._id)).balance;
        assert.strictEqual(walletAfter - walletBefore, 750, "Customer received full ₹750 refund on retry");

        const completedOrder = await Order.findById(order._id);
        assert.strictEqual(completedOrder.paymentStatus, "REFUNDED", "paymentStatus is now REFUNDED");
        assert.strictEqual(completedOrder.pricing.purchaseRefundTotal, 750, "purchaseRefundTotal is now 750");

        console.log("✓ PASS: Failed credit did not mark payment REFUNDED and was cleanly recovered on retry.\n");
    }

    // -------------------------------------------------------------
    // Test 6: Unpaid Order Protection
    // -------------------------------------------------------------
    console.log("--- Test 6: Unpaid Order Protection ---");
    {
        const orderNum = `ORD-UNPAID-${Date.now()}`;

        const order = await Order.create({
            orderNumber: orderNum,
            userId: testUser._id,
            shippingAddress: defaultAddress,
            orderStatus: "PENDING",
            paymentMethod: "ONLINE",
            paymentStatus: "PENDING",
            items: [
                {
                    variantId: testVariant._id,
                    productId: testProduct._id,
                    productName: "Test Item",
                    sku: "ITEM-UNP",
                    price: 500,
                    unitPrice: 500,
                    priceAtPurchase: 500,
                    quantity: 1,
                    lineTotal: 500,
                    finalPayable: 500,
                    status: "PENDING",
                    refundIssued: false,
                },
            ],
            pricing: {
                subtotal: 500,
                shippingFee: 0,
                totalAmount: 500,
                collectedAmount: 0,
                originalTotalAmount: 500,
                currentPayable: 500,
                walletRefundIssued: 0,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
            },
        });

        const unpaidRes = await updatePaymentStatus(order._id, "REFUNDED");
        assert.strictEqual(unpaidRes.success, false, "Unpaid order cannot be marked REFUNDED");

        const orderAfter = await Order.findById(order._id);
        assert.strictEqual(orderAfter.paymentStatus, "PENDING", "paymentStatus remains PENDING");
        assert.strictEqual(orderAfter.pricing.purchaseRefundTotal, 0, "purchaseRefundTotal remains 0");

        console.log("✓ PASS: Unpaid order cannot be marked REFUNDED.\n");
    }

    console.log("================================================================================");
    console.log("ALL 6 MANUAL-REFUND CALCULATION TESTS PASSED SUCCESSFULLY!");
    console.log("================================================================================\n");

    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
}

runTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
