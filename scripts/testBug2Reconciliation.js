/**
 * Verification Test Suite for Bug #2: Reconciliation Separates Duplicate-Payment Refunds from Purchase Refunds
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 * 
 * Tests strictly against isolated test database.
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
    firstName: "Bug2",
    lastName: "Tester",
    addressLine1: "123 Isolated Test Way",
    addressLine2: "",
    phone: "9876543210",
    city: "Bangalore",
    state: "Karnataka",
    pinCode: 560001,
    country: "India",
};

async function setupTestData() {
    await Order.deleteMany({ orderNumber: { $regex: /^TEST_BUG2_/ } });
    
    testUser = await User.findOne({ email: "test_bug2_suite@velora.test" });
    if (!testUser) {
        testUser = await User.create({
            fullName: "Bug2 Suite User",
            firstName: "Bug2",
            lastName: "Tester",
            email: "test_bug2_suite@velora.test",
            password: "hashed_dummy_password",
            role: "USER",
            status: "Active",
            isEmailVerified: true,
        });
    }

    await Wallet.deleteMany({ userId: testUser._id });
    await Transaction.deleteMany({ userId: testUser._id });
    await Wallet.create({ userId: testUser._id, balance: 0, appliedOperations: [], operationsLog: [] });

    testCategory = await Category.findOne({ name: "Bug2 Test Category" });
    if (!testCategory) {
        testCategory = await Category.create({
            name: "Bug2 Test Category",
            slug: "bug2-test-category",
            isActive: true,
        });
    }

    testProduct = await Product.findOne({ name: "Bug2 Test Product" });
    if (!testProduct) {
        testProduct = await Product.create({
            name: "Bug2 Test Product",
            slug: "bug2-test-product",
            categoryId: testCategory._id,
            description: "Bug2 Test Product Description",
            status: "ACTIVE",
        });
    }

    await Variant.deleteMany({ productId: testProduct._id });
    variantA = await Variant.create({
        productId: testProduct._id,
        color: "Red",
        size: "M",
        sku: "BUG2-A",
        regularPrice: 600,
        salePrice: 600,
        stock: 50,
        isActive: true,
    });

    variantB = await Variant.create({
        productId: testProduct._id,
        color: "Blue",
        size: "L",
        sku: "BUG2-B",
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
            status: "PROCESSING",
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
            status: "PROCESSING",
            refundIssued: false,
            isStockRestored: false,
        },
    ];
}

async function runTests() {
    console.log("==========================================================================");
    console.log("RUNNING ISOLATED DATABASE TESTS FOR BUG #2: DUPLICATE VS PURCHASE REFUNDS");
    console.log("Database:", TEST_DB_URI);
    console.log("==========================================================================\n");

    await mongoose.connect(TEST_DB_URI);
    await setupTestData();

    const results = [];
    const getBalance = async () => {
        const w = await Wallet.findOne({ userId: testUser._id });
        return w ? w.balance : 0;
    };

    let sharedOrder;

    // -------------------------------------------------------------------------
    // Test A: Original payment ₹1,000, duplicate payment refunded ₹1,000
    // Expected: purchaseRefundTotal = 0, duplicateRefundTotal = 1000
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test A: Original payment ₹1,000, duplicate payment refunded ₹1,000...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const paidAt = new Date();
        sharedOrder = await Order.create({
            orderNumber: `TEST_BUG2_ORD_${Date.now()}`,
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
            razorpayPaymentId: "pay_primary_orig_1000",
            paidAt,
            paymentAttempts: [
                {
                    gateway: "RAZORPAY",
                    attemptId: `att_orig_${Date.now()}`,
                    razorpayOrderId: "order_rzp_mock",
                    razorpayPaymentId: "pay_primary_orig_1000",
                    amount: 1000,
                    status: "SUCCESS",
                    createdAt: paidAt,
                },
                {
                    gateway: "RAZORPAY",
                    attemptId: `att_dup_${Date.now()}`,
                    razorpayOrderId: "order_rzp_mock",
                    razorpayPaymentId: "pay_dup_extra_1000",
                    amount: 1000,
                    status: "REFUNDED_DUPLICATE",
                    createdAt: new Date(paidAt.getTime() + 1000),
                },
            ],
        });

        // Primary Payment document
        await Payment.create({
            orderId: sharedOrder._id,
            userId: testUser._id,
            amount: 1000,
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            paidAt,
            razorpayPaymentId: "pay_primary_orig_1000",
            refundAmount: 0,
        });

        // Duplicate Payment document
        await Payment.create({
            orderId: sharedOrder._id,
            userId: testUser._id,
            amount: 1000,
            paymentMethod: "ONLINE",
            status: "REFUNDED",
            paidAt: new Date(paidAt.getTime() + 1000),
            refundedAt: new Date(paidAt.getTime() + 2000),
            razorpayPaymentId: "pay_dup_extra_1000",
            refundAmount: 1000,
        });

        // Duplicate payment refunded to wallet (using reason: "ORDER_REFUND" with duplicate reference/payment ID)
        await walletService.creditWallet({
            userId: testUser._id,
            amount: 1000,
            reason: "ORDER_REFUND",
            description: "Refund for duplicate payment attempt on Order #" + sharedOrder.orderNumber,
            orderId: sharedOrder._id,
            orderNumber: sharedOrder.orderNumber,
            referenceId: `REFUND_${sharedOrder._id}_pay_dup_extra_1000`,
        });

        // Run reconciliation
        const reconRes = await adminOrderService.reconcileOrderState(sharedOrder._id);
        if (!reconRes.success) throw new Error("Reconciliation failed: " + reconRes.message);

        const orderAfterRecon = await Order.findById(sharedOrder._id);
        const primaryPaymentAfter = await Payment.findOne({ orderId: sharedOrder._id, razorpayPaymentId: "pay_primary_orig_1000" });

        if (orderAfterRecon.pricing.purchaseRefundTotal !== 0) {
            throw new Error(`Expected purchaseRefundTotal = 0, got ${orderAfterRecon.pricing.purchaseRefundTotal}`);
        }
        if (orderAfterRecon.pricing.duplicateRefundTotal !== 1000) {
            throw new Error(`Expected duplicateRefundTotal = 1000, got ${orderAfterRecon.pricing.duplicateRefundTotal}`);
        }
        if (orderAfterRecon.pricing.walletRefundIssued !== 1000) {
            throw new Error(`Expected walletRefundIssued = 1000, got ${orderAfterRecon.pricing.walletRefundIssued}`);
        }
        if (primaryPaymentAfter.refundAmount !== 0) {
            throw new Error(`Expected primary payment refundAmount = 0, got ${primaryPaymentAfter.refundAmount}`);
        }

        console.log("  [PASS] Test A: purchaseRefundTotal=0, duplicateRefundTotal=1000, primary payment refundAmount=0.");
        results.push({ test: "Test A: Duplicate payment separated from purchase refunds", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test A:", err.message);
        results.push({ test: "Test A", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Test B: Legitimate refund of ₹400 from original purchase
    // Expected: purchaseRefundTotal = 400, duplicateRefundTotal = 1000
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test B: Legitimate refund of ₹400 from original purchase...");
        const balanceBefore = await getBalance(); // 1000 from duplicate refund

        // Cancel Item B (₹400) post-payment
        const cancelRes = await userOrderService.cancelOrderItem(
            testUser._id,
            sharedOrder._id,
            sharedOrder.items[1]._id,
            "Customer cancelled Item B"
        );
        if (!cancelRes.success) throw new Error("Cancellation failed: " + cancelRes.message);

        // Run reconciliation
        const reconRes = await adminOrderService.reconcileOrderState(sharedOrder._id);
        if (!reconRes.success) throw new Error("Reconciliation failed: " + reconRes.message);

        const orderAfterB = await Order.findById(sharedOrder._id);
        const balanceAfterB = await getBalance();
        const primaryPaymentAfter = await Payment.findOne({ orderId: sharedOrder._id, razorpayPaymentId: "pay_primary_orig_1000" });

        if (balanceAfterB !== balanceBefore + 400) {
            throw new Error(`Expected wallet balance to increase by ₹400, got ${balanceAfterB - balanceBefore}`);
        }
        if (orderAfterB.pricing.purchaseRefundTotal !== 400) {
            throw new Error(`Expected purchaseRefundTotal = 400, got ${orderAfterB.pricing.purchaseRefundTotal}`);
        }
        if (orderAfterB.pricing.duplicateRefundTotal !== 1000) {
            throw new Error(`Expected duplicateRefundTotal = 1000, got ${orderAfterB.pricing.duplicateRefundTotal}`);
        }
        if (orderAfterB.pricing.walletRefundIssued !== 1400) {
            throw new Error(`Expected walletRefundIssued = 1400, got ${orderAfterB.pricing.walletRefundIssued}`);
        }
        if (primaryPaymentAfter.refundAmount !== 400) {
            throw new Error(`Expected primary payment refundAmount = 400, got ${primaryPaymentAfter.refundAmount}`);
        }

        console.log("  [PASS] Test B: purchaseRefundTotal=400, duplicateRefundTotal=1000, walletRefundIssued=1400.");
        results.push({ test: "Test B: Legitimate purchase refund tracked accurately", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test B:", err.message);
        results.push({ test: "Test B", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Test C: Remaining ₹600 of original purchase remains refundable when eligible
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test C: Remaining ₹600 of original purchase remains refundable...");
        const balanceBefore = await getBalance(); // Currently 1400

        // Mark remaining Item A (₹600) as delivered and return requested
        await Order.updateOne(
            { _id: sharedOrder._id, "items._id": sharedOrder.items[0]._id },
            {
                $set: {
                    "items.$.status": "RETURN_REQUESTED",
                    "items.$.returnReason": "Defective item",
                },
            }
        );

        // Approve return of Item A
        const approveRes = await adminOrderService.approveReturnItem(
            sharedOrder._id,
            sharedOrder.items[0]._id,
            "Return approved after inspection"
        );
        if (!approveRes.success) throw new Error("Return approval failed: " + approveRes.message);

        // Run reconciliation
        const reconRes = await adminOrderService.reconcileOrderState(sharedOrder._id);
        if (!reconRes.success) throw new Error("Reconciliation failed: " + reconRes.message);

        const orderAfterC = await Order.findById(sharedOrder._id);
        const balanceAfterC = await getBalance();
        const primaryPaymentAfter = await Payment.findOne({ orderId: sharedOrder._id, razorpayPaymentId: "pay_primary_orig_1000" });

        if (balanceAfterC !== balanceBefore + 600) {
            throw new Error(`Expected wallet balance to increase by ₹600, got delta ₹${balanceAfterC - balanceBefore}`);
        }
        if (orderAfterC.pricing.purchaseRefundTotal !== 1000) {
            throw new Error(`Expected purchaseRefundTotal = 1000, got ${orderAfterC.pricing.purchaseRefundTotal}`);
        }
        if (orderAfterC.pricing.duplicateRefundTotal !== 1000) {
            throw new Error(`Expected duplicateRefundTotal = 1000, got ${orderAfterC.pricing.duplicateRefundTotal}`);
        }
        if (orderAfterC.pricing.walletRefundIssued !== 2000) {
            throw new Error(`Expected walletRefundIssued = 2000, got ${orderAfterC.pricing.walletRefundIssued}`);
        }
        if (primaryPaymentAfter.refundAmount !== 1000 || primaryPaymentAfter.status !== "REFUNDED") {
            throw new Error(`Expected primary payment fully refunded (refundAmount=1000, status=REFUNDED), got amount=${primaryPaymentAfter.refundAmount}, status=${primaryPaymentAfter.status}`);
        }

        console.log("  [PASS] Test C: Remaining ₹600 successfully refunded without being blocked by duplicate refund.");
        results.push({ test: "Test C: Remaining original balance remains refundable", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test C:", err.message);
        results.push({ test: "Test C", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Test D: Reconcile repeatedly -> no additional wallet credits & no changing totals
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test D: Reconcile repeatedly -> idempotent, zero extra credits...");
        const balanceBefore = await getBalance();

        // Run reconciliation 3 consecutive times
        await adminOrderService.reconcileOrderState(sharedOrder._id);
        await adminOrderService.reconcileOrderState(sharedOrder._id);
        const reconRes = await adminOrderService.reconcileOrderState(sharedOrder._id);
        if (!reconRes.success) throw new Error("Repeated reconciliation failed: " + reconRes.message);

        const balanceAfter = await getBalance();
        const orderAfterD = await Order.findById(sharedOrder._id);

        if (balanceAfter !== balanceBefore) {
            throw new Error(`Wallet balance changed from ${balanceBefore} to ${balanceAfter} on repeated reconciliation`);
        }
        if (orderAfterD.pricing.purchaseRefundTotal !== 1000) {
            throw new Error(`purchaseRefundTotal changed to ${orderAfterD.pricing.purchaseRefundTotal}`);
        }
        if (orderAfterD.pricing.duplicateRefundTotal !== 1000) {
            throw new Error(`duplicateRefundTotal changed to ${orderAfterD.pricing.duplicateRefundTotal}`);
        }
        if (orderAfterD.pricing.walletRefundIssued !== 2000) {
            throw new Error(`walletRefundIssued changed to ${orderAfterD.pricing.walletRefundIssued}`);
        }

        console.log("  [PASS] Test D: Repeated reconciliation leaves balances and totals 100% unchanged.");
        results.push({ test: "Test D: Repeated reconciliation idempotency", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test D:", err.message);
        results.push({ test: "Test D", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Test E: Ordinary purchase refund without duplicate payment
    // Expected: correct purchase total, duplicate total remains zero
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test E: Ordinary purchase refund without duplicate payment...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const orderE = await Order.create({
            orderNumber: `TEST_BUG2_E_${Date.now()}`,
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
            razorpayPaymentId: "pay_ord_e_1000",
            paidAt: new Date(),
        });

        await Payment.create({
            orderId: orderE._id,
            userId: testUser._id,
            amount: 1000,
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: "pay_ord_e_1000",
        });

        // Customer cancels Item B (₹400)
        await userOrderService.cancelOrderItem(testUser._id, orderE._id, orderE.items[1]._id, "Cancel Item B");
        await adminOrderService.reconcileOrderState(orderE._id);

        const orderAfterE = await Order.findById(orderE._id);
        const balance = await getBalance();

        if (balance !== 400) {
            throw new Error(`Expected wallet balance ₹400, got ${balance}`);
        }
        if (orderAfterE.pricing.purchaseRefundTotal !== 400) {
            throw new Error(`Expected purchaseRefundTotal = 400, got ${orderAfterE.pricing.purchaseRefundTotal}`);
        }
        if (orderAfterE.pricing.duplicateRefundTotal !== 0) {
            throw new Error(`Expected duplicateRefundTotal = 0, got ${orderAfterE.pricing.duplicateRefundTotal}`);
        }
        if (orderAfterE.pricing.walletRefundIssued !== 400) {
            throw new Error(`Expected walletRefundIssued = 400, got ${orderAfterE.pricing.walletRefundIssued}`);
        }

        console.log("  [PASS] Test E: Ordinary purchase refund has correct purchase total and duplicate total = 0.");
        results.push({ test: "Test E: Ordinary purchase refund without duplicate payment", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test E:", err.message);
        results.push({ test: "Test E", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Test F: Interrupted operation recovered without counting or crediting twice
    // Part 1: Interrupted duplicate payment refund
    // Part 2: Interrupted purchase cancellation refund
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test F: Interrupted operations recovered without double counting...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const orderF = await Order.create({
            orderNumber: `TEST_BUG2_F_${Date.now()}`,
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
            razorpayPaymentId: "pay_f_orig_1000",
            paidAt: new Date(),
            paymentAttempts: [
                {
                    gateway: "RAZORPAY",
                    attemptId: `att_f_orig`,
                    razorpayOrderId: "order_rzp_f",
                    razorpayPaymentId: "pay_f_orig_1000",
                    amount: 1000,
                    status: "SUCCESS",
                    createdAt: new Date(),
                },
                {
                    gateway: "RAZORPAY",
                    attemptId: `att_f_dup`,
                    razorpayOrderId: "order_rzp_f",
                    razorpayPaymentId: "pay_f_dup_1000",
                    amount: 1000,
                    status: "REFUND_PENDING", // Interrupted duplicate refund!
                    createdAt: new Date(),
                },
            ],
        });

        await Payment.create({
            orderId: orderF._id,
            userId: testUser._id,
            amount: 1000,
            paymentMethod: "ONLINE",
            status: "COMPLETED",
            paidAt: new Date(),
            razorpayPaymentId: "pay_f_orig_1000",
        });

        // Also simulate an interrupted item cancellation (Item B cancelled post-payment, refundIssued: false)
        await Order.updateOne(
            { _id: orderF._id, "items._id": orderF.items[1]._id },
            {
                $set: {
                    "items.$.status": "CANCELLED",
                    "items.$.refundIssued": false,
                    "items.$.cancelledBeforePayment": false,
                },
            }
        );

        // 1st Reconciliation run: recovers both interrupted refunds
        const recon1 = await adminOrderService.reconcileOrderState(orderF._id);
        const balance1 = await getBalance();
        const orderAfterF1 = await Order.findById(orderF._id);

        // Expected balance: 1000 (duplicate refund) + 400 (purchase cancellation) = 1400
        if (balance1 !== 1400) {
            throw new Error(`Expected wallet balance ₹1400 after 1st recovery, got ${balance1}`);
        }
        if (orderAfterF1.pricing.duplicateRefundTotal !== 1000) {
            throw new Error(`Expected duplicateRefundTotal = 1000, got ${orderAfterF1.pricing.duplicateRefundTotal}`);
        }
        if (orderAfterF1.pricing.purchaseRefundTotal !== 400) {
            throw new Error(`Expected purchaseRefundTotal = 400, got ${orderAfterF1.pricing.purchaseRefundTotal}`);
        }

        // 2nd Reconciliation run: must NOT double credit or change totals
        const recon2 = await adminOrderService.reconcileOrderState(orderF._id);
        const balance2 = await getBalance();
        const orderAfterF2 = await Order.findById(orderF._id);

        if (balance2 !== 1400) {
            throw new Error(`Wallet balance changed to ${balance2} on repeat reconciliation! Double credited!`);
        }
        if (orderAfterF2.pricing.duplicateRefundTotal !== 1000 || orderAfterF2.pricing.purchaseRefundTotal !== 400) {
            throw new Error(`Totals changed on second reconciliation!`);
        }

        console.log("  [PASS] Test F: Interrupted duplicate and purchase refunds recovered once without double credit.");
        results.push({ test: "Test F: Interrupted operations recovered without double counting", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test F:", err.message);
        results.push({ test: "Test F", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Test G: Bug #1 regression test
    // Pre-payment cancellation of ₹400, collect only ₹600 -> no ₹400 wallet refund
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test G: Bug #1 regression (Pre-payment cancellation of ₹400, collect ₹600)...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const orderG = await Order.create({
            orderNumber: `TEST_BUG2_G_${Date.now()}`,
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

        // Cancel Item B before payment
        const itemB = orderG.items[1];
        await userOrderService.cancelOrderItem(testUser._id, orderG._id, itemB._id, "Cancel before payment");

        // Customer pays only ₹600 for Item A
        const paidAt = new Date();
        await Order.updateOne(
            { _id: orderG._id },
            {
                $set: {
                    paymentStatus: "COMPLETED",
                    orderStatus: "PROCESSING",
                    paidAt,
                    razorpayPaymentId: "pay_g_partial_600",
                    "pricing.collectedAmount": 600,
                    "items.$[elem].status": "PROCESSING",
                },
            },
            { arrayFilters: [{ "elem.status": { $ne: "CANCELLED" } }] }
        );
        await Payment.create({
            orderId: orderG._id,
            userId: testUser._id,
            method: "ONLINE",
            status: "COMPLETED",
            amount: 600,
            paidAt,
            razorpayPaymentId: "pay_g_partial_600",
        });

        const balanceBefore = await getBalance();
        const reconRes = await adminOrderService.reconcileOrderState(orderG._id);
        const balanceAfter = await getBalance();
        const finalOrderG = await Order.findById(orderG._id);

        if (!reconRes.success) throw new Error("Reconciliation failed: " + reconRes.message);
        if (balanceAfter !== balanceBefore) {
            throw new Error(`Expected ₹0 wallet credit, but got ₹${balanceAfter - balanceBefore}`);
        }
        if (finalOrderG.pricing.purchaseRefundTotal !== 0) {
            throw new Error(`Expected purchaseRefundTotal = 0, got ${finalOrderG.pricing.purchaseRefundTotal}`);
        }
        if (finalOrderG.pricing.walletRefundIssued !== 0) {
            throw new Error(`Expected walletRefundIssued = 0, got ${finalOrderG.pricing.walletRefundIssued}`);
        }

        console.log("  [PASS] Test G: Bug #1 fix preserved: zero wallet credit for pre-payment cancellation.");
        results.push({ test: "Test G: Bug #1 regression preserved", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test G:", err.message);
        results.push({ test: "Test G", status: "FAIL", error: err.message });
    }

    // -------------------------------------------------------------------------
    // Test H: Ambiguous refund record reports unresolved rather than guessing
    // -------------------------------------------------------------------------
    try {
        console.log("Running Test H: Ambiguous refund record reports unresolved rather than guessing...");
        await Wallet.updateOne({ userId: testUser._id }, { $set: { balance: 0 } });
        await Transaction.deleteMany({ userId: testUser._id });

        const orderH = await Order.create({
            orderNumber: `TEST_BUG2_H_${Date.now()}`,
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
            },
            paymentMethod: "ONLINE",
            paymentStatus: "COMPLETED",
            orderStatus: "PROCESSING",
            razorpayPaymentId: "pay_h_primary",
            paidAt: new Date(),
        });

        // Insert ambiguous credit transaction with reason ORDER_REFUND but no clear metadata
        const wallet = await Wallet.findOne({ userId: testUser._id });
        await Transaction.create({
            walletId: wallet._id,
            userId: testUser._id,
            type: "CREDIT",
            amount: 500,
            balanceAfter: 500,
            reason: "ORDER_REFUND",
            description: "Generic credit",
            orderId: orderH._id,
            orderNumber: orderH.orderNumber,
            referenceId: "TX_AMBIGUOUS_UNKNOWN",
        });

        const reconRes = await adminOrderService.reconcileOrderState(orderH._id);
        const finalOrderH = await Order.findById(orderH._id);

        if (!reconRes.unresolved || !reconRes.errors || reconRes.errors.length === 0) {
            throw new Error("Expected reconciliation to flag unresolved status for ambiguous transaction");
        }
        if (finalOrderH.pricing.purchaseRefundTotal !== 0) {
            throw new Error(`Ambiguous transaction wrongly added to purchaseRefundTotal: ${finalOrderH.pricing.purchaseRefundTotal}`);
        }
        if (finalOrderH.pricing.duplicateRefundTotal !== 0) {
            throw new Error(`Ambiguous transaction wrongly added to duplicateRefundTotal: ${finalOrderH.pricing.duplicateRefundTotal}`);
        }

        console.log("  [PASS] Test H: Ambiguous transaction reported as unresolved without guessing.");
        results.push({ test: "Test H: Ambiguous transaction safety", status: "PASS" });
    } catch (err) {
        console.error("  [FAIL] Test H:", err.message);
        results.push({ test: "Test H", status: "FAIL", error: err.message });
    }

    console.log("\n==========================================================================");
    console.log("TEST SUMMARY FOR BUG #2 FIX:");
    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}`);
    console.log("==========================================================================");

    await mongoose.disconnect();
    if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
});
