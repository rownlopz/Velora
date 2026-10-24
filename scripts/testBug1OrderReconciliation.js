/**
 * Verification Test Suite for Bug #1: Order Reconciliation Financial Safety
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 * 
 * Tests strictly against the isolated test database.
 * Never connects to or modifies production data.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");

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

let testUser, testCategory, testProduct, variantA, variantB;

const defaultShippingAddress = {
    firstName: "Bug1",
    lastName: "Tester",
    addressLine1: "123 Test Street",
    addressLine2: "",
    phone: "9876543210",
    city: "Bangalore",
    state: "Karnataka",
    pinCode: 560001,
    country: "India",
};

async function setupTestData() {
    // Clean up test collections in isolated db
    await Order.deleteMany({ orderNumber: { $regex: /^TEST_BUG1_/ } });
    await Payment.deleteMany({});
    
    // Create test user if not exists
    testUser = await User.findOne({ email: "test_bug1_user@velora.test" });
    if (!testUser) {
        testUser = await User.create({
            fullName: "Bug1 Tester",
            firstName: "Bug1",
            lastName: "Tester",
            email: "test_bug1_user@velora.test",
            password: "hashed_dummy_password",
            role: "USER",
            status: "Active",
            isEmailVerified: true,
        });
    }

    // Reset wallet
    await Wallet.deleteMany({ userId: testUser._id });
    await Transaction.deleteMany({ userId: testUser._id });
    await Wallet.create({ userId: testUser._id, balance: 0, appliedOperations: [], operationsLog: [] });

    // Category
    testCategory = await Category.findOne({ name: "Bug1 Test Category" });
    if (!testCategory) {
        testCategory = await Category.create({
            name: "Bug1 Test Category",
            slug: "bug1-test-category",
            isActive: true,
        });
    }

    // Product
    testProduct = await Product.findOne({ name: "Bug1 Test Product" });
    if (!testProduct) {
        testProduct = await Product.create({
            name: "Bug1 Test Product",
            slug: "bug1-test-product",
            categoryId: testCategory._id,
            description: "Bug1 Test Product Description",
            status: "ACTIVE",
        });
    }

    // Variants A and B
    await Variant.deleteMany({ productId: testProduct._id });
    variantA = await Variant.create({
        productId: testProduct._id,
        color: "Red",
        size: "M",
        sku: "BUG1-A",
        regularPrice: 600,
        salePrice: 600,
        stock: 50,
        isActive: true,
    });

    variantB = await Variant.create({
        productId: testProduct._id,
        color: "Blue",
        size: "L",
        sku: "BUG1-B",
        regularPrice: 400,
        salePrice: 400,
        stock: 50,
        isActive: true,
    });
}

function createOrderItems() {
    return [
        {
            variantId: variantA._id,
            productId: testProduct._id,
            productName: "Item A (₹600)",
            quantity: 1,
            unitPrice: 600,
            regularPrice: 600,
            lineTotal: 600,
            finalPayable: 600,
            status: "PENDING",
            refundIssued: false,
            isStockRestored: false,
        },
        {
            variantId: variantB._id,
            productId: testProduct._id,
            productName: "Item B (₹400)",
            quantity: 1,
            unitPrice: 400,
            regularPrice: 400,
            lineTotal: 400,
            finalPayable: 400,
            status: "PENDING",
            refundIssued: false,
            isStockRestored: false,
        },
    ];
}

async function runTests() {
    console.log("===============================================================");
    console.log("RUNNING ISOLATED DATABASE TESTS FOR BUG #1: ORDER RECONCILIATION");
    console.log("Database:", TEST_DB_URI);
    console.log("===============================================================\n");

    await mongoose.connect(TEST_DB_URI);
    await setupTestData();

    const results = [];

    // Helper to get wallet balance
    const getBalance = async () => {
        const w = await Wallet.findOne({ userId: testUser._id });
        return w ? w.balance : 0;
    };

    let orderB;

    // -------------------------------------------------------------------------
    // Case A: Cancel ₹400 before payment, collect ₹600 -> reconciliation credits ₹0
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case A: Cancel ₹400 before payment, collect ₹600 -> reconciliation credits ₹0...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const orderA = await Order.create({
            orderNumber: `TEST_BUG1_A_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
                collectedAmount: 0,
            },
            paymentMethod: "ONLINE",
            paymentStatus: "PENDING",
            orderStatus: "PENDING",
        });

        // 1. Cancel Item B before payment
        const itemB = orderA.items[1];
        const cancelRes = await userOrderService.cancelOrderItem(testUser._id, orderA._id, itemB._id, "Cancel before payment");
        if (!cancelRes.success) throw new Error("Failed to cancel Item B: " + cancelRes.message);

        // Verify cancelledBeforePayment is true
        const afterCancelOrder = await Order.findById(orderA._id);
        const cancelledItemB = afterCancelOrder.items.id(itemB._id);
        if (!cancelledItemB.cancelledBeforePayment) {
            throw new Error("Item B cancelledBeforePayment is not true");
        }

        // 2. Customer collects exactly ₹600 for remaining Item A
        const paidAt = new Date();
        await Order.updateOne(
            { _id: orderA._id },
            {
                $set: {
                    paymentStatus: "COMPLETED",
                    orderStatus: "PROCESSING",
                    paidAt,
                    "pricing.collectedAmount": 600,
                    "items.$[elem].status": "PROCESSING",
                },
                $push: {
                    paymentAttempts: {
                        gateway: "RAZORPAY",
                        attemptId: `att_test_${Date.now()}`,
                        razorpayOrderId: "order_mock_caseA",
                        razorpayPaymentId: "pay_mock_caseA",
                        amount: 600,
                        status: "SUCCESS",
                        createdAt: paidAt,
                    },
                },
            },
            { arrayFilters: [{ "elem.status": { $ne: "CANCELLED" } }] }
        );
        await Payment.create({
            orderId: orderA._id,
            userId: testUser._id,
            method: "ONLINE",
            status: "COMPLETED",
            amount: 600,
            paidAt,
            razorpayPaymentId: "pay_mock_caseA",
        });

        // 3. Run reconciliation
        const balanceBefore = await getBalance();
        const reconRes = await adminOrderService.reconcileOrderState(orderA._id);
        const balanceAfter = await getBalance();
        const finalOrder = await Order.findById(orderA._id);

        if (!reconRes.success) throw new Error("Reconciliation failed: " + reconRes.message);
        if (balanceAfter !== balanceBefore) {
            throw new Error(`Expected ₹0 wallet credit, but received ₹${balanceAfter - balanceBefore}`);
        }
        if (finalOrder.pricing.walletRefundIssued !== 0) {
            throw new Error(`Expected walletRefundIssued = 0, got ${finalOrder.pricing.walletRefundIssued}`);
        }

        console.log("  [PASS] Case A: Zero wallet credit issued for pre-payment cancellation. Collected ₹600 covers active Item A.");
        results.push({ test: "Case A: Pre-payment cancellation + partial collection", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case A:", err.message);
        results.push({ test: "Case A", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Case B: Collect ₹1,000, then cancel ₹400 -> total cancellation refund is exactly ₹400
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case B: Collect ₹1,000, then cancel ₹400 -> total refund exactly ₹400...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const paidAt = new Date(Date.now() - 3600000); // 1 hour ago
        orderB = await Order.create({
            orderNumber: `TEST_BUG1_B_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
                collectedAmount: 1000,
            },
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            orderStatus: "PROCESSING",
            paidAt,
            paymentAttempts: [
                {
                    gateway: "RAZORPAY",
                    attemptId: `att_test_${Date.now()}`,
                    razorpayOrderId: "order_mock_caseB",
                    razorpayPaymentId: "pay_mock_caseB",
                    amount: 1000,
                    status: "SUCCESS",
                    createdAt: paidAt,
                },
            ],
        });
        await Payment.create({
            orderId: orderB._id,
            userId: testUser._id,
            method: "ONLINE",
            status: "COMPLETED",
            amount: 1000,
            paidAt,
        });

        // Cancel Item B after payment
        const itemB = orderB.items[1];
        const cancelRes = await userOrderService.cancelOrderItem(testUser._id, orderB._id, itemB._id, "Cancel after payment");
        if (!cancelRes.success) throw new Error("Failed to cancel Item B: " + cancelRes.message);

        // Run reconciliation
        const reconRes = await adminOrderService.reconcileOrderState(orderB._id);
        const finalOrder = await Order.findById(orderB._id);
        const balance = await getBalance();

        if (balance !== 400) {
            throw new Error(`Expected total wallet refund of ₹400, got ₹${balance}`);
        }
        if (finalOrder.pricing.purchaseRefundTotal !== 400) {
            throw new Error(`Expected purchaseRefundTotal = 400, got ${finalOrder.pricing.purchaseRefundTotal}`);
        }

        console.log("  [PASS] Case B: Post-payment cancellation correctly refunded exactly ₹400.");
        results.push({ test: "Case B: Post-payment cancellation refund", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case B:", err.message);
        results.push({ test: "Case B", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Case C: Repeat reconciliation -> no additional credit
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case C: Repeat reconciliation -> no additional credit...");
        const balanceBefore = await getBalance(); // Currently 400 from Case B

        // Run reconciliation 3 times in a row
        await adminOrderService.reconcileOrderState(orderB._id);
        await adminOrderService.reconcileOrderState(orderB._id);
        const reconRes = await adminOrderService.reconcileOrderState(orderB._id);

        const balanceAfter = await getBalance();
        if (balanceAfter !== balanceBefore) {
            throw new Error(`Wallet balance changed from ${balanceBefore} to ${balanceAfter} on repeated reconciliation`);
        }

        console.log("  [PASS] Case C: Repeat reconciliation is completely idempotent with 0 additional credit.");
        results.push({ test: "Case C: Repeat reconciliation idempotency", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case C:", err.message);
        results.push({ test: "Case C", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Case D: Unpaid online cancellation -> no wallet credit
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case D: Unpaid online cancellation -> no wallet credit...");
        const balanceBefore = await getBalance();

        const orderD = await Order.create({
            orderNumber: `TEST_BUG1_D_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
                collectedAmount: 0,
            },
            paymentMethod: "ONLINE",
            paymentStatus: "PENDING",
            orderStatus: "PENDING",
        });

        // Cancel whole order
        await userOrderService.cancelEntireOrder(testUser._id, orderD._id, "Unpaid online cancel");
        await adminOrderService.reconcileOrderState(orderD._id);

        const balanceAfter = await getBalance();
        if (balanceAfter !== balanceBefore) {
            throw new Error(`Unpaid online cancellation resulted in wallet credit delta ₹${balanceAfter - balanceBefore}`);
        }

        console.log("  [PASS] Case D: Unpaid online cancellation resulted in zero wallet credit.");
        results.push({ test: "Case D: Unpaid online cancellation", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case D:", err.message);
        results.push({ test: "Case D", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Case E: Unpaid COD cancellation -> stock restored, no wallet credit
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case E: Unpaid COD cancellation -> stock restored, no wallet credit...");
        const balanceBefore = await getBalance();

        const stockBefore = (await Variant.findById(variantB._id)).stock;

        const orderE = await Order.create({
            orderNumber: `TEST_BUG1_E_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
            },
            paymentMethod: "COD",
            paymentStatus: "PENDING",
            orderStatus: "PLACED",
        });

        // Deduct 1 stock to simulate checkout placement
        await Variant.updateOne({ _id: variantB._id }, { $inc: { stock: -1 } });
        const stockAfterPlacement = (await Variant.findById(variantB._id)).stock;

        // Simulate interrupted cancellation where item was marked CANCELLED but stock was NOT restored yet
        await Order.updateOne(
            { _id: orderE._id, "items._id": orderE.items[1]._id },
            {
                $set: {
                    "items.$.status": "CANCELLED",
                    "items.$.isStockRestored": false,
                    "items.$.cancelledBeforePayment": true,
                },
            }
        );

        // Run reconciliation
        const reconRes = await adminOrderService.reconcileOrderState(orderE._id);
        const balanceAfter = await getBalance();
        const stockRestored = (await Variant.findById(variantB._id)).stock;

        if (balanceAfter !== balanceBefore) {
            throw new Error(`Unpaid COD cancellation credited wallet by ₹${balanceAfter - balanceBefore}`);
        }
        if (stockRestored !== stockAfterPlacement + 1) {
            throw new Error(`Stock was not restored: expected ${stockAfterPlacement + 1}, got ${stockRestored}`);
        }

        console.log("  [PASS] Case E: Unpaid COD cancellation restored stock and issued ₹0 wallet credit.");
        results.push({ test: "Case E: Unpaid COD stock restoration without wallet credit", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case E:", err.message);
        results.push({ test: "Case E", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Case F: Successful wallet payment followed by cancellation -> correct refund exactly once
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case F: Successful wallet payment followed by cancellation -> correct refund once...");
        // Set user wallet balance to 1500
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 1500 } });

        const orderF = await Order.create({
            orderNumber: `TEST_BUG1_F_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
                collectedAmount: 1000,
            },
            paymentMethod: "WALLET",
            paymentStatus: "COMPLETED",
            orderStatus: "PROCESSING",
            paidAt: new Date(),
        });

        // Record legitimate wallet debit transaction
        await Transaction.create({
            walletId: (await Wallet.findOne({ userId: testUser._id }))._id,
            userId: testUser._id,
            type: "DEBIT",
            amount: 1000,
            balanceAfter: 500,
            reason: "ORDER_PURCHASE",
            description: `Payment for Order #${orderF.orderNumber}`,
            orderId: orderF._id,
            orderNumber: orderF.orderNumber,
            referenceId: `DEBIT_${orderF._id}`,
        });
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 500 } });

        // Simulate cancellation of Item B (₹400) where refund crashed before execution
        await Order.updateOne(
            { _id: orderF._id, "items._id": orderF.items[1]._id },
            {
                $set: {
                    "items.$.status": "CANCELLED",
                    "items.$.cancelledAt": new Date(),
                    "items.$.cancelledBeforePayment": false,
                    "items.$.refundIssued": false,
                },
            }
        );

        // Run reconciliation
        const reconRes1 = await adminOrderService.reconcileOrderState(orderF._id);
        const balanceAfterRecon1 = await getBalance();
        if (balanceAfterRecon1 !== 900) {
            throw new Error(`Expected wallet balance 500 + 400 = 900, got ${balanceAfterRecon1}`);
        }

        // Run reconciliation second time
        const reconRes2 = await adminOrderService.reconcileOrderState(orderF._id);
        const balanceAfterRecon2 = await getBalance();
        if (balanceAfterRecon2 !== 900) {
            throw new Error(`Expected wallet balance to remain 900 on repeat, got ${balanceAfterRecon2}`);
        }

        console.log("  [PASS] Case F: Wallet payment verified via ledger debit, cancellation refunded exactly once.");
        results.push({ test: "Case F: Wallet payment cancellation refund", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case F:", err.message);
        results.push({ test: "Case F", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Case G: Interrupted legitimate refund -> reconciliation completes it exactly once
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case G: Interrupted legitimate refund -> completed exactly once...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const paidAt = new Date(Date.now() - 60000);
        const orderG = await Order.create({
            orderNumber: `TEST_BUG1_G_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
                collectedAmount: 1000,
            },
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            orderStatus: "PROCESSING",
            paidAt,
            paymentAttempts: [
                {
                    gateway: "RAZORPAY",
                    attemptId: `att_g_${Date.now()}`,
                    razorpayOrderId: "order_mock_g",
                    razorpayPaymentId: "pay_mock_g",
                    amount: 1000,
                    status: "SUCCESS",
                    createdAt: paidAt,
                },
            ],
        });
        await Payment.create({
            orderId: orderG._id,
            userId: testUser._id,
            method: "ONLINE",
            status: "COMPLETED",
            amount: 1000,
            paidAt,
        });

        // Mark item cancelled post-payment, but refundIssued: false (simulating server crash before refund)
        await Order.updateOne(
            { _id: orderG._id, "items._id": orderG.items[1]._id },
            {
                $set: {
                    "items.$.status": "CANCELLED",
                    "items.$.cancelledAt": new Date(),
                    "items.$.cancelledBeforePayment": false,
                    "items.$.refundIssued": false,
                },
            }
        );

        // Run reconciliation
        const reconRes = await adminOrderService.reconcileOrderState(orderG._id);
        const balance = await getBalance();
        const finalOrder = await Order.findById(orderG._id);
        const itemB = finalOrder.items.id(orderG.items[1]._id);

        if (balance !== 400) {
            throw new Error(`Expected wallet balance ₹400, got ₹${balance}`);
        }
        if (!itemB.refundIssued) {
            throw new Error("Item B refundIssued should be true");
        }

        // Run reconciliation again
        await adminOrderService.reconcileOrderState(orderG._id);
        const balanceSecond = await getBalance();
        if (balanceSecond !== 400) {
            throw new Error(`Balance changed on second run: ${balanceSecond}`);
        }

        console.log("  [PASS] Case G: Interrupted legitimate refund detected and completed exactly once.");
        results.push({ test: "Case G: Interrupted legitimate refund completed once", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case G:", err.message);
        results.push({ test: "Case G", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Case H: Duplicate-payment refunds remain separate from purchase refunds
    // -------------------------------------------------------------------------
    try {
        console.log("Running Case H: Duplicate-payment refunds remain separate from purchase refunds...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const orderH = await Order.create({
            orderNumber: `TEST_BUG1_H_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
                collectedAmount: 1000,
                purchaseRefundTotal: 0,
                duplicateRefundTotal: 0,
                walletRefundIssued: 0,
            },
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            orderStatus: "PROCESSING",
            paidAt: new Date(),
        });

        const wallet = await Wallet.findOne({ userId: testUser._id });

        // Record a legitimate purchase refund transaction (₹400)
        await Transaction.create({
            walletId: wallet._id,
            userId: testUser._id,
            type: "CREDIT",
            amount: 400,
            balanceAfter: 400,
            reason: "ORDER_CANCELLATION",
            description: `Refund for cancelled item`,
            orderId: orderH._id,
            orderNumber: orderH.orderNumber,
            referenceId: `REFUND_CAN_${orderH._id}_${orderH.items[1]._id}`,
        });

        // Record a duplicate gateway payment refund transaction (₹600)
        await Transaction.create({
            walletId: wallet._id,
            userId: testUser._id,
            type: "CREDIT",
            amount: 600,
            balanceAfter: 1000,
            reason: "DUPLICATE_PAYMENT",
            description: `Refund for duplicate payment`,
            orderId: orderH._id,
            orderNumber: orderH.orderNumber,
            referenceId: `REFUND_DUP_${orderH._id}_pay_dup_123`,
        });

        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 1000 } });

        // Run reconciliation
        const reconRes = await adminOrderService.reconcileOrderState(orderH._id);
        const finalOrder = await Order.findById(orderH._id);

        if (finalOrder.pricing.purchaseRefundTotal !== 400) {
            throw new Error(`Expected purchaseRefundTotal = 400, got ${finalOrder.pricing.purchaseRefundTotal}`);
        }
        if (finalOrder.pricing.duplicateRefundTotal !== 600) {
            throw new Error(`Expected duplicateRefundTotal = 600, got ${finalOrder.pricing.duplicateRefundTotal}`);
        }
        if (finalOrder.pricing.walletRefundIssued !== 1000) {
            throw new Error(`Expected walletRefundIssued = 1000, got ${finalOrder.pricing.walletRefundIssued}`);
        }

        console.log("  [PASS] Case H: Duplicate refunds remain strictly isolated from purchase refunds.");
        results.push({ test: "Case H: Duplicate-payment refunds separated from purchase refunds", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Case H:", err.message);
        results.push({ test: "Case H", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Additional Safety Test: Ambiguous payment history returns unresolved, issues ₹0
    // -------------------------------------------------------------------------
    try {
        console.log("Running Ambiguity Test: Order claims COMPLETED wallet payment but ledger has no debit...");
        const balanceBefore = await getBalance();

        const orderAmbiguous = await Order.create({
            orderNumber: `TEST_BUG1_AMB_${Date.now()}`,
            userId: testUser._id,
            items: createOrderItems(),
            shippingAddress: defaultShippingAddress,
            pricing: {
                subtotal: 1000,
                shippingFee: 0,
                discount: 0,
                totalAmount: 1000,
                currentPayable: 1000,
            },
            paymentMethod: "WALLET",
            paymentStatus: "COMPLETED", // Claims completed!
            orderStatus: "PROCESSING",
            paidAt: new Date(),
            // But NO Transaction debit exists in DB!
        });

        // Mark item cancelled
        await Order.updateOne(
            { _id: orderAmbiguous._id, "items._id": orderAmbiguous.items[1]._id },
            { $set: { "items.$.status": "CANCELLED", "items.$.refundIssued": false } }
        );

        const reconRes = await adminOrderService.reconcileOrderState(orderAmbiguous._id);
        const balanceAfter = await getBalance();

        if (balanceAfter !== balanceBefore) {
            throw new Error(`Ambiguous payment incorrectly credited wallet by ₹${balanceAfter - balanceBefore}`);
        }
        if (!reconRes.unresolved || reconRes.errors.length === 0) {
            throw new Error("Expected reconciliation to flag unresolved state with errors");
        }

        console.log("  [PASS] Ambiguity Test: Flagged unresolved state and refused to issue money without verified debits.");
        results.push({ test: "Ambiguity Test: Refuses to guess or issue unverified money", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Ambiguity Test:", err.message);
        results.push({ test: "Ambiguity Test", status: "FAIL", error: err.message });
    }

    console.log("\n===============================================================");
    console.log("TEST SUMMARY FOR BUG #1 FIX:");
    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}`);
    console.log("===============================================================");

    await mongoose.disconnect();
    if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
});
