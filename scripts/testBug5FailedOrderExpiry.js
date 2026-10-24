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
const { releaseExpiredReservations, verifyRazorpayPayment, retryOrderPayment } = require("../services/user/orderService");
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

    const cat = await Category.create({ name: "Bug 5 Test Category", slug: "bug-5-test-category" });
    testProduct = await Product.create({
        name: "Bug 5 Test Product",
        slug: "bug-5-test-product",
        categoryId: cat._id,
        description: "Test Product Description",
        status: "ACTIVE",
    });
    testVariant = await Variant.create({
        productId: testProduct._id,
        color: "Black",
        size: "L",
        sku: "BUG5-SHOES-L",
        stock: 50,
        regularPrice: 1000,
        salePrice: 1000,
        price: 1000,
    });

    testUser = await User.create({
        fullName: "Bug 5 Customer",
        email: "bug5_customer@velora.test",
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
        code: "SAVE100B5",
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

function createOrderData({
    orderNumber,
    razorpayOrderId,
    paymentStatus = "FAILED",
    orderStatus = "PENDING",
    ageMinutes = 45,
    isStockRestored = false,
    coupon = null,
    itemsCount = 1,
    cancellationReason = null,
    retryLockUntil = null,
}) {
    const placedTime = new Date(Date.now() - ageMinutes * 60 * 1000);
    const items = [];
    for (let i = 0; i < itemsCount; i++) {
        items.push({
            productId: testProduct._id,
            variantId: testVariant._id,
            productName: `Bug 5 Test Product Item ${i + 1}`,
            quantity: 2,
            unitPrice: 1000,
            priceAtPurchase: 1000,
            lineTotal: 2000,
            finalPayable: coupon ? 1900 : 2000,
            status: orderStatus === "CANCELLED" ? "CANCELLED" : "PENDING",
            isStockRestored: Array.isArray(isStockRestored) ? isStockRestored[i] : isStockRestored,
        });
    }

    return {
        orderNumber,
        userId: testUser._id,
        paymentMethod: "ONLINE",
        paymentStatus,
        orderStatus,
        placedAt: placedTime,
        razorpayOrderId,
        paymentAttempts: [
            {
                gateway: "RAZORPAY",
                attemptId: `att_${Date.now()}`,
                razorpayOrderId,
                amount: 2000,
                status: "FAILED",
                errorReason: "Signature verification failed",
                createdAt: placedTime,
            },
        ],
        cancellationReason,
        retryLockUntil,
        shippingAddress: {
            firstName: "Bug5",
            lastName: "Tester",
            addressLine1: "123 Bug5 Street",
            city: "Test City",
            state: "Test State",
            pinCode: 560001,
            country: "India",
            phone: "9876543210",
        },
        items,
        pricing: {
            subtotal: 2000 * itemsCount,
            shippingFee: 0,
            discount: coupon ? 100 : 0,
            couponDiscount: coupon ? 100 : 0,
            couponCode: coupon ? coupon.code : null,
            couponId: coupon ? coupon._id : null,
            isCouponReleased: false,
            totalAmount: coupon ? 2000 * itemsCount - 100 : 2000 * itemsCount,
            currentPayable: coupon ? 2000 * itemsCount - 100 : 2000 * itemsCount,
        },
    };
}

async function resetDbState(orderNumberForCoupon = null) {
    await Order.deleteMany({});
    await Payment.deleteMany({});
    await Variant.updateOne({ _id: testVariant._id }, { $set: { stock: 50, cancellationRestockKeys: [] } });
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
    console.log("VERIFYING BUG #5 FIX: FAILED ONLINE-PAYMENT ORDER RESERVATION EXPIRY");
    console.log("Database: ISOLATED TEST DATABASE (", TEST_DB_URI, ")");
    console.log("Gateway: Controlled In-Memory Razorpay Client Mock");
    console.log("==========================================================================\n");

    await setupTestData();

    const results = [];

    function recordResult(testCode, testName, expected, actual, passed, details = "") {
        results.push({
            testCode,
            testName,
            expected,
            actual,
            passed,
            details,
        });
        const tag = passed ? "[PASS]" : "[FAIL]";
        console.log(`  ${tag} ${testCode}: ${testName}`);
        if (!passed) {
            console.error(`    Expected: ${expected}`);
            console.error(`    Actual:   ${actual}`);
            if (details) console.error(`    Details:  ${details}`);
        }
    }

    try {
        // -------------------------------------------------------------------------
        // Test A: Expired FAILED online order with reserved stock and safely confirmed unpaid:
        // stock restored once; order cancelled; coupon released once.
        // -------------------------------------------------------------------------
        console.log("--------------------------------------------------------------------------");
        console.log("Test A: Expired FAILED online order (safely confirmed unpaid)");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState("ORD-BUG5-A");
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_failed_a", status: "failed" }],
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const initialCouponUsed = (await Coupon.findById(testCoupon._id)).usedCount;
            const initialWallet = (await Wallet.findById(testWallet._id)).balance;

            const orderA = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-A",
                    razorpayOrderId: "rzp_order_failed_a",
                    paymentStatus: "FAILED",
                    orderStatus: "PENDING",
                    ageMinutes: 45,
                    coupon: testCoupon,
                })
            );

            const res = await releaseExpiredReservations(30);

            const dbOrderA = await Order.findById(orderA._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;
            const currentCouponUsed = (await Coupon.findById(testCoupon._id)).usedCount;
            const currentWallet = (await Wallet.findById(testWallet._id)).balance;

            recordResult(
                "Test A",
                "Expired FAILED reservation is released (releasedCount >= 1)",
                true,
                res.releasedCount >= 1,
                res.releasedCount >= 1
            );
            recordResult(
                "Test A",
                "Order status updated to CANCELLED",
                "CANCELLED",
                dbOrderA.orderStatus,
                dbOrderA.orderStatus === "CANCELLED"
            );
            recordResult(
                "Test A",
                "Payment status remains FAILED",
                "FAILED",
                dbOrderA.paymentStatus,
                dbOrderA.paymentStatus === "FAILED"
            );
            recordResult(
                "Test A",
                "Stock restored once (+2 units)",
                initialStock + 2,
                currentStock,
                currentStock === initialStock + 2
            );
            recordResult(
                "Test A",
                "Coupon usage decremented once (-1 count)",
                initialCouponUsed - 1,
                currentCouponUsed,
                currentCouponUsed === initialCouponUsed - 1
            );
            recordResult(
                "Test A",
                "No wallet refund issued for unpaid order",
                initialWallet,
                currentWallet,
                currentWallet === initialWallet
            );
        }

        // -------------------------------------------------------------------------
        // Test B: Recent FAILED online order:
        // reservation remains until its deadline.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test B: Recent FAILED online order (reservation remains until deadline)");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_failed_b", status: "failed" }],
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            // Order placed 5 minutes ago (deadline is 30 mins)
            const orderB = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-B",
                    razorpayOrderId: "rzp_order_b",
                    paymentStatus: "FAILED",
                    orderStatus: "PENDING",
                    ageMinutes: 5,
                })
            );

            await releaseExpiredReservations(30);

            const dbOrderB = await Order.findById(orderB._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                "Test B",
                "Recent FAILED order remains PENDING (not cancelled prematurely)",
                "PENDING",
                dbOrderB.orderStatus,
                dbOrderB.orderStatus === "PENDING"
            );
            recordResult(
                "Test B",
                "Recent reservation stock is NOT restored (remains reserved for retry)",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
            recordResult(
                "Test B",
                "Item isStockRestored remains false",
                false,
                dbOrderB.items[0].isStockRestored,
                dbOrderB.items[0].isStockRestored === false
            );
        }

        // -------------------------------------------------------------------------
        // Test C: FAILED local status but a captured payment exists:
        // recover payment; no stock release.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test C: FAILED local status but captured payment exists on gateway");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            const capPayId = "pay_captured_c";
            const capOrdId = "rzp_order_c";

            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === capOrdId) {
                            return { items: [{ id: capPayId, status: "captured", amount: 200000, currency: "INR" }] };
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
            const orderC = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-C",
                    razorpayOrderId: capOrdId,
                    paymentStatus: "FAILED",
                    orderStatus: "PENDING",
                    ageMinutes: 45,
                })
            );

            await releaseExpiredReservations(30);

            const dbOrderC = await Order.findById(orderC._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                "Test C",
                "Payment recovered: paymentStatus updated to COMPLETED",
                "COMPLETED",
                dbOrderC.paymentStatus,
                dbOrderC.paymentStatus === "COMPLETED"
            );
            recordResult(
                "Test C",
                "Order status updated to PROCESSING (fulfillment active)",
                "PROCESSING",
                dbOrderC.orderStatus,
                dbOrderC.orderStatus === "PROCESSING"
            );
            recordResult(
                "Test C",
                "Captured payment ID recorded",
                capPayId,
                dbOrderC.razorpayPaymentId,
                dbOrderC.razorpayPaymentId === capPayId
            );
            recordResult(
                "Test C",
                "Stock was NOT restored (fulfillment preserved)",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
        }

        // -------------------------------------------------------------------------
        // Test D: FAILED local status with an authorized payment:
        // retain reservation under the existing safe policy.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test D: FAILED local status with authorized/in-progress payment");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_auth_d", status: "authorized", amount: 200000, currency: "INR" }],
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const orderD = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-D",
                    razorpayOrderId: "rzp_order_d",
                    paymentStatus: "FAILED",
                    orderStatus: "PENDING",
                    ageMinutes: 45,
                })
            );

            await releaseExpiredReservations(30);

            const dbOrderD = await Order.findById(orderD._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;

            recordResult(
                "Test D",
                "Order remains PENDING during bank authorization",
                "PENDING",
                dbOrderD.orderStatus,
                dbOrderD.orderStatus === "PENDING"
            );
            recordResult(
                "Test D",
                "Stock remains reserved (NOT restored)",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
        }

        // -------------------------------------------------------------------------
        // Test E: Gateway lookup fails:
        // no cancellation, stock restoration, coupon release, or refund.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test E: Gateway lookup fails on FAILED order");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState("ORD-BUG5-E");
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => {
                        const err = new Error("Gateway timeout connecting to Razorpay");
                        err.code = "ETIMEDOUT";
                        throw err;
                    },
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const initialCouponUsed = (await Coupon.findById(testCoupon._id)).usedCount;
            const initialWallet = (await Wallet.findById(testWallet._id)).balance;

            const orderE = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-E",
                    razorpayOrderId: "rzp_order_e",
                    paymentStatus: "FAILED",
                    orderStatus: "PENDING",
                    ageMinutes: 45,
                    coupon: testCoupon,
                })
            );

            await releaseExpiredReservations(30);

            const dbOrderE = await Order.findById(orderE._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;
            const currentCouponUsed = (await Coupon.findById(testCoupon._id)).usedCount;
            const currentWallet = (await Wallet.findById(testWallet._id)).balance;

            recordResult(
                "Test E",
                "Order status remains PENDING on lookup failure",
                "PENDING",
                dbOrderE.orderStatus,
                dbOrderE.orderStatus === "PENDING"
            );
            recordResult(
                "Test E",
                "Stock remains unchanged (reserved)",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
            recordResult(
                "Test E",
                "Coupon usage remains unreleased",
                initialCouponUsed,
                currentCouponUsed,
                currentCouponUsed === initialCouponUsed
            );
            recordResult(
                "Test E",
                "Wallet balance remains unchanged (no refund)",
                initialWallet,
                currentWallet,
                currentWallet === initialWallet
            );
        }

        // -------------------------------------------------------------------------
        // Test F: FAILED order whose stock was already restored:
        // no additional increment.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test F: FAILED order whose stock was already restored");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState();
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_failed_f", status: "failed" }],
                    }),
                },
            }));

            // Create already restored order
            const initialStock = (await Variant.findById(testVariant._id)).stock;
            await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-F",
                    razorpayOrderId: "rzp_order_f",
                    paymentStatus: "FAILED",
                    orderStatus: "CANCELLED",
                    ageMinutes: 45,
                    isStockRestored: true, // already restored
                })
            );

            await releaseExpiredReservations(30);

            const currentStock = (await Variant.findById(testVariant._id)).stock;
            recordResult(
                "Test F",
                "Already restored order does NOT receive additional stock increments",
                initialStock,
                currentStock,
                currentStock === initialStock
            );
        }

        // -------------------------------------------------------------------------
        // Test G: Interrupted restoration:
        // recover only outstanding stock and coupon operations.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test G: Interrupted restoration (recover only outstanding operations)");
        console.log("--------------------------------------------------------------------------");
        {
            await resetDbState("ORD-BUG5-G");
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_failed_g", status: "failed" }],
                    }),
                },
            }));

            const initialStock = (await Variant.findById(testVariant._id)).stock;
            const initialCouponUsed = (await Coupon.findById(testCoupon._id)).usedCount;

            // Order with 2 items: item 0 was restored in previous run, item 1 was NOT restored
            const orderG = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-G",
                    razorpayOrderId: "rzp_order_g",
                    paymentStatus: "FAILED",
                    orderStatus: "CANCELLED",
                    ageMinutes: 45,
                    isStockRestored: [true, false], // item 0 restored, item 1 pending
                    itemsCount: 2,
                    cancellationReason: "Payment reservation expired after 30 minutes without completion.",
                    coupon: testCoupon,
                })
            );

            await releaseExpiredReservations(30);

            const dbOrderG = await Order.findById(orderG._id);
            const currentStock = (await Variant.findById(testVariant._id)).stock;
            const currentCouponUsed = (await Coupon.findById(testCoupon._id)).usedCount;

            recordResult(
                "Test G",
                "Item 1 restored successfully",
                true,
                dbOrderG.items[1].isStockRestored,
                dbOrderG.items[1].isStockRestored === true
            );
            recordResult(
                "Test G",
                "Stock incremented ONLY by outstanding item quantity (+2 units, NOT +4)",
                initialStock + 2,
                currentStock,
                currentStock === initialStock + 2
            );
            recordResult(
                "Test G",
                "Coupon usage released successfully",
                initialCouponUsed - 1,
                currentCouponUsed,
                currentCouponUsed === initialCouponUsed - 1
            );
            recordResult(
                "Test G",
                "pricing.isCouponReleased set to true",
                true,
                dbOrderG.pricing.isCouponReleased,
                dbOrderG.pricing.isCouponReleased === true
            );
        }

        // -------------------------------------------------------------------------
        // Test H: Repeat cleanup three times:
        // no duplicate effects.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test H: Repeat cleanup three times (idempotency verification)");
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
                "Test H",
                "Zero additional stock increments across 3 runs",
                stockBeforeRepeat,
                stockAfterRepeat,
                stockAfterRepeat === stockBeforeRepeat
            );
            recordResult(
                "Test H",
                "Zero additional coupon releases across 3 runs",
                couponBeforeRepeat,
                couponAfterRepeat,
                couponAfterRepeat === couponBeforeRepeat
            );
            recordResult(
                "Test H",
                "Zero wallet credits issued across 3 runs",
                walletBeforeRepeat,
                walletAfterRepeat,
                walletAfterRepeat === walletBeforeRepeat
            );
        }

        // -------------------------------------------------------------------------
        // Test I: Payment retry/verification and expiry overlap:
        // no active paid order with released stock, and no new retry attempt after expiry claimed.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test I: Payment retry/verification and expiry overlap");
        console.log("--------------------------------------------------------------------------");
        {
            // Part 1: While an order is claimed as cancelled by expiry, retryOrderPayment is blocked
            await resetDbState();
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({
                        items: [{ id: "pay_failed_i1", status: "failed" }],
                    }),
                    create: async () => {
                        throw new Error("Should not be called!");
                    },
                },
            }));

            const orderI1 = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-I1",
                    razorpayOrderId: "rzp_order_i1",
                    paymentStatus: "FAILED",
                    orderStatus: "PENDING",
                    ageMinutes: 45,
                })
            );

            // Run expiry: order is cancelled
            await releaseExpiredReservations(30);

            // Attempt retryOrderPayment on expired/cancelled order
            const retryRes = await retryOrderPayment(testUser._id, orderI1._id);
            recordResult(
                "Test I",
                "Retry payment rejected on expired/claimed order",
                false,
                retryRes.success,
                retryRes.success === false
            );
            recordResult(
                "Test I",
                "Retry indicates order cancelled",
                true,
                /cancelled/.test(retryRes.message || ""),
                /cancelled/.test(retryRes.message || "")
            );

            // Part 2: If payment retry currently holds active lock, expiry does NOT claim order
            await resetDbState();
            const orderI2 = await Order.create(
                createOrderData({
                    orderNumber: "ORD-BUG5-I2",
                    razorpayOrderId: "rzp_order_i2",
                    paymentStatus: "FAILED",
                    orderStatus: "PENDING",
                    ageMinutes: 45,
                    retryLockUntil: new Date(Date.now() + 60000), // active lock for 60s
                })
            );

            await releaseExpiredReservations(30);

            const dbOrderI2 = await Order.findById(orderI2._id);
            recordResult(
                "Test I",
                "Order with active retry lock is NOT claimed or cancelled by expiry",
                "PENDING",
                dbOrderI2.orderStatus,
                dbOrderI2.orderStatus === "PENDING"
            );
            recordResult(
                "Test I",
                "Stock remains reserved while retry lock is active",
                false,
                dbOrderI2.items[0].isStockRestored,
                dbOrderI2.items[0].isStockRestored === false
            );
        }

        // -------------------------------------------------------------------------
        // Test J: Re-run scripts/testBug4ReservationExpiry.js:
        // all existing bug #4 tests must continue passing.
        // -------------------------------------------------------------------------
        console.log("\n--------------------------------------------------------------------------");
        console.log("Test J: Re-run existing Bug #4 test suite");
        console.log("--------------------------------------------------------------------------");
        {
            const { execSync } = require("child_process");
            let bug4Output = "";
            let bug4Passed = false;
            try {
                bug4Output = execSync("node scripts/testBug4ReservationExpiry.js", {
                    encoding: "utf8",
                    cwd: process.cwd(),
                });
                bug4Passed = bug4Output.includes("Passed:           38") && bug4Output.includes("Failed:           0");
            } catch (err) {
                bug4Passed = false;
                bug4Output = err.stdout || err.message;
            }

            recordResult(
                "Test J",
                "Re-running testBug4ReservationExpiry.js passes all 38 existing assertions",
                true,
                bug4Passed,
                bug4Passed,
                bug4Passed ? "All 38 Bug 4 tests passed" : bug4Output
            );
        }

        console.log("\n==========================================================================");
        console.log("BUG #5 TEST SUITE EXECUTION SUMMARY:");
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
    console.error("Unhandled test suite error in Bug 5 verification suite:", err);
    process.exit(1);
});
