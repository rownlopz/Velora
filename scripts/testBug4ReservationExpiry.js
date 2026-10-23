require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const User = require("../models/user/userModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Category = require("../models/product/categoryModel");
const Coupon = require("../models/order/couponModel");
const Wallet = require("../models/user/walletModel");
const { releaseExpiredReservations, verifyRazorpayPayment } = require("../services/user/orderService");
const { setRazorpayInstanceCreator } = require("../config/razorpay");

// ISOLATED TEST DATABASE URI (NEVER TOUCHES PRODUCTION / NORMAL PROJECT DB)
const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

let testUser;
let testProduct;
let testVariant;
let testCoupon;
let testWallet;

async function setupTestData() {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.dropDatabase();

    const cat = await Category.create({ name: "Expiry Test Cat", slug: "expiry-test-cat" });
    testProduct = await Product.create({
        name: "Test Expiry Item",
        slug: "test-expiry-item",
        categoryId: cat._id,
        description: "Test Expiry Item Description",
        status: "ACTIVE",
    });
    testVariant = await Variant.create({
        productId: testProduct._id,
        color: "Blue",
        size: "M",
        sku: "EXP-SHOE-M",
        stock: 50,
        regularPrice: 1000,
        salePrice: 1000,
        price: 1000,
    });

    testUser = await User.create({
        fullName: "Expiry Customer",
        email: "expiry_customer@velora.test",
        password: "hashedpassword123",
        role: "USER",
    });

    testWallet = await Wallet.create({
        userId: testUser._id,
        balance: 500,
        currency: "INR",
        appliedOperations: [],
        operationsLog: [],
    });

    testCoupon = await Coupon.create({
        code: "SAVE100",
        discountType: "FLAT",
        discountValue: 100,
        minPurchase: 500,
        usageLimit: 5,
        usedCount: 1,
        usersUsed: [{ userId: testUser._id, usageCount: 1 }],
        startDate: new Date(Date.now() - 86400000),
        endDate: new Date(Date.now() + 86400000),
        isActive: true,
    });
}

function createExpiredOrderData(orderNumber, razorpayOrderId, paymentAttempts = [], coupon = null) {
    const placedPast = new Date(Date.now() - 45 * 60 * 1000); // 45 minutes ago (window is 30 mins)
    return {
        orderNumber,
        userId: testUser._id,
        paymentMethod: "ONLINE",
        paymentStatus: "PENDING",
        orderStatus: "PENDING",
        placedAt: placedPast,
        razorpayOrderId,
        paymentAttempts,
        shippingAddress: {
            firstName: "Expiry",
            lastName: "Tester",
            addressLine1: "123 Reservation Way",
            city: "Test City",
            state: "Test State",
            pinCode: 560001,
            country: "India",
            phone: "9876543210",
        },
        items: [
            {
                productId: testProduct._id,
                variantId: testVariant._id,
                productName: "Test Expiry Item",
                quantity: 2,
                unitPrice: 1000,
                priceAtPurchase: 1000,
                lineTotal: 2000,
                finalPayable: coupon ? 1900 : 2000,
                status: "PENDING",
                isStockRestored: false,
            },
        ],
        pricing: {
            subtotal: 2000,
            shippingFee: 0,
            discount: coupon ? 100 : 0,
            couponDiscount: coupon ? 100 : 0,
            couponCode: coupon ? coupon.code : null,
            couponId: coupon ? coupon._id : null,
            isCouponReleased: false,
            totalAmount: coupon ? 1900 : 2000,
            currentPayable: coupon ? 1900 : 2000,
        },
    };
}

async function resetDbState(orderNumberForCoupon = null) {
    await Order.deleteMany({});
    await Payment.deleteMany({});
    await Variant.updateOne({ _id: testVariant._id }, { $set: { stock: 50 } });
    await Wallet.updateOne({ _id: testWallet._id }, { $set: { balance: 500, appliedOperations: [], operationsLog: [] } });
    await Coupon.updateOne(
        { _id: testCoupon._id },
        {
            $set: {
                usedCount: 1,
                usersUsed: [{ userId: testUser._id, usageCount: 1 }],
                reservedOrders: orderNumberForCoupon ? [orderNumberForCoupon] : [],
            },
        }
    );
}

async function runTests() {
    console.log("==========================================================================");
    console.log("VERIFYING BUG #4 FIX: RESERVATION EXPIRY SAFETY ON UNCHECKED GATEWAY STATUS");
    console.log("Database: ISOLATED TEST DATABASE (", TEST_DB_URI, ")");
    console.log("Gateway: Controlled In-Memory Razorpay Client Mock");
    console.log("==========================================================================\n");

    await setupTestData();

    const results = [];

    function recordResult(caseNumber, testName, expected, actual, passed, details = "") {
        results.push({
            caseNumber,
            testName,
            expected,
            actual,
            passed,
            details,
        });
        const tag = passed ? "[PASS]" : "[FAIL]";
        console.log(`  ${tag} Case ${caseNumber}: ${testName}`);
        if (!passed) {
            console.error(`    Expected: ${expected}`);
            console.error(`    Actual:   ${actual}`);
            if (details) console.error(`    Details:  ${details}`);
        }
    }

    try {
        // -------------------------------------------------------------------------
        // Case 1: Expired unpaid order, Razorpay lookup times out
        // - Order and item statuses remain unchanged
        // - Stock, wallet balance, and coupon usage remain unchanged
        // - The order can be checked again later
        // -------------------------------------------------------------------------
        console.log("--------------------------------------------------------------------------");
        console.log("Case 1: Expired unpaid order, Razorpay lookup times out");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState("ORD-CASE-1");
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (orderId) => {
                        const err = new Error("Gateway timeout connecting to Razorpay");
                        err.code = "ETIMEDOUT";
                        throw err;
                    },
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const initialWallet = (await Wallet.findById(testWallet._id)).balance;
            const initialCoupon = (await Coupon.findById(testCoupon._id)).usedCount;

            const order1 = await Order.create(createExpiredOrderData("ORD-CASE-1", "rzp_order_timeout_1", [], testCoupon));

            await releaseExpiredReservations(30);

            const dbOrder1 = await Order.findById(order1._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;
            const currentWallet = (await Wallet.findById(testWallet._id)).balance;
            const currentCoupon = (await Coupon.findById(testCoupon._id)).usedCount;

            recordResult(
                1,
                "Order status remains unchanged (PENDING)",
                "PENDING",
                dbOrder1.orderStatus,
                dbOrder1.orderStatus === "PENDING"
            );
            recordResult(
                1,
                "Payment status remains unchanged (PENDING)",
                "PENDING",
                dbOrder1.paymentStatus,
                dbOrder1.paymentStatus === "PENDING"
            );
            recordResult(
                1,
                "Item status remains unchanged (PENDING)",
                "PENDING",
                dbOrder1.items[0].status,
                dbOrder1.items[0].status === "PENDING"
            );
            recordResult(
                1,
                "Stock remains unchanged (reserved, not restored)",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
            recordResult(
                1,
                "Wallet balance remains unchanged",
                initialWallet,
                currentWallet,
                currentWallet === initialWallet
            );
            recordResult(
                1,
                "Coupon usage count remains unchanged",
                initialCoupon,
                currentCoupon,
                currentCoupon === initialCoupon
            );
            recordResult(
                1,
                "Order remains discoverable for later runs",
                "isStockRestored: false, orderStatus: PENDING",
                `isStockRestored: ${dbOrder1.items[0].isStockRestored}, orderStatus: ${dbOrder1.orderStatus}`,
                dbOrder1.items[0].isStockRestored === false && dbOrder1.orderStatus === "PENDING"
            );
        }

        // -------------------------------------------------------------------------
        // Case 2: Multiple previous payment attempts:
        // - One lookup confirms no payment, another lookup fails
        // - The order must not expire
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 2: Multiple payment attempts (one unpaid, another fails)");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === "rzp_c2_attempt1") {
                            return { items: [{ id: "pay_c2_fail", status: "failed" }] };
                        }
                        if (gId === "rzp_c2_attempt2_unreachable") {
                            const err = new Error("DNS lookup failure on razorpay.api");
                            err.code = "ENOTFOUND";
                            throw err;
                        }
                        return { items: [] };
                    },
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const order2 = await Order.create(
                createExpiredOrderData("ORD-CASE-2", "rzp_c2_attempt1", [
                    { gateway: "RAZORPAY", attemptId: "att_2a", razorpayOrderId: "rzp_c2_attempt1", status: "FAILED" },
                    { gateway: "RAZORPAY", attemptId: "att_2b", razorpayOrderId: "rzp_c2_attempt2_unreachable", status: "PENDING" },
                ])
            );

            await releaseExpiredReservations(30);

            const dbOrder2 = await Order.findById(order2._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                2,
                "Order remains PENDING when partial lookup fails",
                "PENDING",
                dbOrder2.orderStatus,
                dbOrder2.orderStatus === "PENDING"
            );
            recordResult(
                2,
                "Payment status remains PENDING",
                "PENDING",
                dbOrder2.paymentStatus,
                dbOrder2.paymentStatus === "PENDING"
            );
            recordResult(
                2,
                "Stock is NOT restored",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
        }

        // -------------------------------------------------------------------------
        // Case 3: A captured payment is found:
        // - Recover the payment
        // - Do not cancel the order or restore stock
        // - If recovery fails, still do not expire the order
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 3: Captured payment is found (recovery success and recovery failure)");
        console.log("--------------------------------------------------------------------------");
        {
            // 3A: Captured payment found and recovery succeeds
            await resetDbState();
            const capPayId = "pay_captured_c3a";
            const capOrdId = "rzp_order_c3a";

            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === capOrdId) {
                            return {
                                items: [{ id: capPayId, status: "captured", amount: 200000, currency: "INR" }],
                            };
                        }
                        return { items: [] };
                    },
                },
                payments: {
                    fetch: async (id) => ({
                        id,
                        order_id: capOrdId,
                        status: "captured",
                        amount: 200000,
                        currency: "INR",
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const order3A = await Order.create(createExpiredOrderData("ORD-CASE-3A", capOrdId));

            await releaseExpiredReservations(30);

            const dbOrder3A = await Order.findById(order3A._id);
            const stock3A = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                3,
                "3A: Payment recovered to COMPLETED",
                "COMPLETED",
                dbOrder3A.paymentStatus,
                dbOrder3A.paymentStatus === "COMPLETED"
            );
            recordResult(
                3,
                "3A: Order status moved to PROCESSING (fulfillment active)",
                "PROCESSING",
                dbOrder3A.orderStatus,
                dbOrder3A.orderStatus === "PROCESSING"
            );
            recordResult(
                3,
                "3A: Gateway payment ID recorded on order",
                capPayId,
                dbOrder3A.razorpayPaymentId,
                dbOrder3A.razorpayPaymentId === capPayId
            );
            recordResult(
                3,
                "3A: Stock was NOT restored",
                initialStock,
                stock3A,
                stock3A === initialStock
            );

            // 3B: Captured payment found but recovery fails
            await resetDbState();
            const failCapOrdId = "rzp_order_c3b";
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_bad_c3b", status: "captured", amount: 200000, currency: "INR" }],
                    }),
                },
                payments: {
                    fetch: async (id) => ({
                        id,
                        order_id: failCapOrdId,
                        status: "captured",
                        amount: 200000,
                        currency: "INR",
                    }),
                },
            }));

            // Force recovery verification failure by corrupting totalAmount mismatch
            const order3B = await Order.create(createExpiredOrderData("ORD-CASE-3B", failCapOrdId));
            await Order.updateOne({ _id: order3B._id }, { $set: { "pricing.totalAmount": 999999 } });

            const stockBefore3B = (await Variant.findById(testVariant._id)).stock;
            await releaseExpiredReservations(30);

            const dbOrder3B = await Order.findById(order3B._id);
            const stockAfter3B = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                3,
                "3B: When recovery fails, order is NOT cancelled",
                "not CANCELLED",
                dbOrder3B.orderStatus,
                dbOrder3B.orderStatus !== "CANCELLED"
            );
            recordResult(
                3,
                "3B: When recovery fails, paymentStatus is NOT FAILED",
                "not FAILED",
                dbOrder3B.paymentStatus,
                dbOrder3B.paymentStatus !== "FAILED"
            );
            recordResult(
                3,
                "3B: When recovery fails, stock remains reserved for later recovery",
                stockBefore3B,
                stockAfter3B,
                stockAfter3B === stockBefore3B
            );
        }

        // -------------------------------------------------------------------------
        // Case 4: An authorized/in-progress payment exists:
        // - Verify the implemented safe handling
        // - Do not treat it automatically as an unpaid order
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 4: Authorized/in-progress payment exists");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_auth_c4", status: "authorized", amount: 200000, currency: "INR" }],
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const order4 = await Order.create(createExpiredOrderData("ORD-CASE-4", "rzp_order_c4"));

            await releaseExpiredReservations(30);

            const dbOrder4 = await Order.findById(order4._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                4,
                "Order remains PENDING during bank authorization",
                "PENDING",
                dbOrder4.orderStatus,
                dbOrder4.orderStatus === "PENDING"
            );
            recordResult(
                4,
                "Payment status is NOT set to FAILED",
                "PENDING",
                dbOrder4.paymentStatus,
                dbOrder4.paymentStatus === "PENDING"
            );
            recordResult(
                4,
                "Stock remains reserved (NOT restored)",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
        }

        // -------------------------------------------------------------------------
        // Case 5: All gateway checks succeed and the unpaid reservation is eligible:
        // - Expire it and restore stock exactly once
        // - Release coupon usage exactly once, if applicable
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 5: All gateway checks succeed and unpaid reservation is eligible");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState("ORD-CASE-5");
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_failed_c5", status: "failed" }],
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const initialCoupon = (await Coupon.findById(testCoupon._id)).usedCount;

            const order5 = await Order.create(createExpiredOrderData("ORD-CASE-5", "rzp_order_failed_c5", [], testCoupon));

            const res = await releaseExpiredReservations(30);

            const dbOrder5 = await Order.findById(order5._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;
            const currentCoupon = (await Coupon.findById(testCoupon._id)).usedCount;

            recordResult(
                5,
                "Reservation release confirmed (releasedCount >= 1)",
                true,
                res.releasedCount >= 1,
                res.releasedCount >= 1
            );
            recordResult(
                5,
                "Order status updated to CANCELLED",
                "CANCELLED",
                dbOrder5.orderStatus,
                dbOrder5.orderStatus === "CANCELLED"
            );
            recordResult(
                5,
                "Payment status updated to FAILED",
                "FAILED",
                dbOrder5.paymentStatus,
                dbOrder5.paymentStatus === "FAILED"
            );
            recordResult(
                5,
                "Item status set to CANCELLED and isStockRestored set to true",
                "isStockRestored: true",
                `isStockRestored: ${dbOrder5.items[0].isStockRestored}`,
                dbOrder5.items[0].status === "CANCELLED" && dbOrder5.items[0].isStockRestored === true
            );
            recordResult(
                5,
                "Stock restored exactly once (+2 units)",
                initialStock + 2,
                currentStock,
                currentStock === initialStock + 2
            );
            recordResult(
                5,
                "Coupon usage decremented exactly once (-1 usedCount)",
                initialCoupon - 1,
                currentCoupon,
                currentCoupon === initialCoupon - 1
            );
            recordResult(
                5,
                "Order marked with pricing.isCouponReleased = true",
                true,
                dbOrder5.pricing.isCouponReleased,
                dbOrder5.pricing.isCouponReleased === true
            );
        }

        // -------------------------------------------------------------------------
        // Case 6: Repeat expiry three times:
        // - No additional stock increments, coupon releases, or wallet credits
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 6: Repeat expiry three times (idempotency verification)");
        console.log("--------------------------------------------------------------------------");
        {
            const stockBeforeRepeat = (await Variant.findById(testVariant._id)).stock;
            const couponBeforeRepeat = (await Coupon.findById(testCoupon._id)).usedCount;
            const walletBeforeRepeat = (await Wallet.findById(testWallet._id)).balance;

            // Run expiry 3 times back-to-back
            await releaseExpiredReservations(30);
            await releaseExpiredReservations(30);
            await releaseExpiredReservations(30);

            const stockAfterRepeat = (await Variant.findById(testVariant._id)).stock;
            const couponAfterRepeat = (await Coupon.findById(testCoupon._id)).usedCount;
            const walletAfterRepeat = (await Wallet.findById(testWallet._id)).balance;

            recordResult(
                6,
                "No additional stock increments across 3 repeated runs",
                stockBeforeRepeat,
                stockAfterRepeat,
                stockAfterRepeat === stockBeforeRepeat
            );
            recordResult(
                6,
                "No additional coupon releases across 3 repeated runs",
                couponBeforeRepeat,
                couponAfterRepeat,
                couponAfterRepeat === couponBeforeRepeat
            );
            recordResult(
                6,
                "No wallet credits issued across 3 repeated runs",
                walletBeforeRepeat,
                walletAfterRepeat,
                walletAfterRepeat === walletBeforeRepeat
            );
        }

        // -------------------------------------------------------------------------
        // Case 7: One order's lookup fails:
        // - Other independently verified eligible orders must still be processed
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 7: One order's lookup fails, other eligible orders still processed");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === "rzp_c7_fail_order") {
                            throw new Error("Temporary gateway timeout on Order 7A");
                        }
                        if (gId === "rzp_c7_ok_order") {
                            return { items: [{ id: "pay_failed_c7", status: "failed" }] };
                        }
                        return { items: [] };
                    },
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const order7Fail = await Order.create(createExpiredOrderData("ORD-CASE-7-FAIL", "rzp_c7_fail_order"));
            const order7Ok = await Order.create(createExpiredOrderData("ORD-CASE-7-OK", "rzp_c7_ok_order"));

            await releaseExpiredReservations(30);

            const db7Fail = await Order.findById(order7Fail._id);
            const db7Ok = await Order.findById(order7Ok._id);
            const stockAfter7 = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                7,
                "Failing order remains PENDING",
                "PENDING",
                db7Fail.orderStatus,
                db7Fail.orderStatus === "PENDING"
            );
            recordResult(
                7,
                "Eligible order is successfully CANCELLED",
                "CANCELLED",
                db7Ok.orderStatus,
                db7Ok.orderStatus === "CANCELLED"
            );
            recordResult(
                7,
                "Stock restored ONLY for the eligible order (+2 units)",
                initialStock + 2,
                stockAfter7,
                stockAfter7 === initialStock + 2
            );
        }

        // -------------------------------------------------------------------------
        // Case 8: A lookup fails initially and succeeds on the next run:
        // - The order must be rechecked and handled correctly
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 8: Lookup fails initially, then succeeds on the next run");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            let gatewayDown = true;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => {
                        if (gatewayDown) {
                            throw new Error("Temporary 503 Service Unavailable");
                        }
                        return { items: [{ id: "pay_c8_failed", status: "failed" }] };
                    },
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const order8 = await Order.create(createExpiredOrderData("ORD-CASE-8", "rzp_order_c8"));

            // Run 1: Gateway down
            await releaseExpiredReservations(30);
            const db8Run1 = await Order.findById(order8._id);
            const stockRun1 = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                8,
                "Run 1 (gateway down): Order remains PENDING",
                "PENDING",
                db8Run1.orderStatus,
                db8Run1.orderStatus === "PENDING"
            );
            recordResult(
                8,
                "Run 1 (gateway down): Stock remains unchanged",
                initialStock,
                stockRun1,
                stockRun1 === initialStock
            );

            // Run 2: Gateway recovered
            gatewayDown = false;
            await releaseExpiredReservations(30);
            const db8Run2 = await Order.findById(order8._id);
            const stockRun2 = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                8,
                "Run 2 (gateway up): Order rechecked and CANCELLED",
                "CANCELLED",
                db8Run2.orderStatus,
                db8Run2.orderStatus === "CANCELLED"
            );
            recordResult(
                8,
                "Run 2 (gateway up): Stock restored correctly (+2 units)",
                initialStock + 2,
                stockRun2,
                stockRun2 === initialStock + 2
            );
        }

        // -------------------------------------------------------------------------
        // Case 9 (Concurrency): Payment verification and expiry run concurrently
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Case 9 (Concurrency): Payment verification and expiry run concurrently");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            const ord9Id = "rzp_order_c9";
            const pay9Id = "pay_captured_c9";

            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: pay9Id, status: "captured", amount: 200000, currency: "INR" }],
                    }),
                },
                payments: {
                    fetch: async (id) => ({
                        id,
                        order_id: ord9Id,
                        status: "captured",
                        amount: 200000,
                        currency: "INR",
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const order9 = await Order.create(createExpiredOrderData("ORD-CASE-9", ord9Id));

            const secret = process.env.RAZORPAY_KEY_SECRET;
            const signature = secret
                ? crypto.createHmac("sha256", secret.trim()).update(`${ord9Id}|${pay9Id}`).digest("hex")
                : "";

            // Concurrent execution
            await Promise.all([
                verifyRazorpayPayment(testUser._id, {
                    orderId: order9._id,
                    razorpayOrderId: ord9Id,
                    razorpayPaymentId: pay9Id,
                    razorpaySignature: signature,
                }),
                releaseExpiredReservations(30),
            ]);

            const db9 = await Order.findById(order9._id);
            const stock9 = (await Variant.findById(testVariant._id)).stock;

            const safeState =
                (db9.paymentStatus === "COMPLETED" && db9.orderStatus === "PROCESSING" && db9.items[0].isStockRestored === false && stock9 === initialStock) ||
                (db9.paymentStatus === "REFUNDED" && db9.orderStatus === "CANCELLED");

            recordResult(
                9,
                "Concurrent verification & expiry: Paid order safe, no stock released while active",
                true,
                safeState,
                safeState,
                `orderStatus: ${db9.orderStatus}, paymentStatus: ${db9.paymentStatus}, isStockRestored: ${db9.items[0].isStockRestored}`
            );
        }

        console.log("\n==========================================================================");
        console.log("TEST SUITE EXECUTION SUMMARY:");
        const passedCount = results.filter((r) => r.passed).length;
        const failedCount = results.filter((r) => !r.passed).length;
        console.log(`Total Assertions: ${results.length}`);
        console.log(`Passed:           ${passedCount}`);
        console.log(`Failed:           ${failedCount}`);
        console.log("==========================================================================");

        if (failedCount > 0) {
            process.exit(1);
        }
    } finally {
        setRazorpayInstanceCreator(null);
        await mongoose.disconnect();
    }
}

runTests().catch((err) => {
    console.error("Unhandled test suite error in Bug 4 verification suite:", err);
    process.exit(1);
});
