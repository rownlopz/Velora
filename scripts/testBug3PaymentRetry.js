require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const User = require("../models/user/userModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Category = require("../models/product/categoryModel");
const { retryOrderPayment } = require("../services/user/orderService");
const { setRazorpayInstanceCreator } = require("../config/razorpay");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

let testUser;
let testProduct;
let testVariant;

async function setupTestData() {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.dropDatabase();

    const cat = await Category.create({ name: "Retry Test Cat", slug: "retry-test-cat" });
    testProduct = await Product.create({
        name: "Test Retry Shoe",
        slug: "test-retry-shoe",
        categoryId: cat._id,
        description: "Test Retry Shoe Description",
        status: "ACTIVE",
    });
    testVariant = await Variant.create({
        productId: testProduct._id,
        color: "Black",
        size: "9",
        sku: "RETRY-SHOE-9",
        stock: 50,
        regularPrice: 1000,
        salePrice: 1000,
        price: 1000,
    });

    testUser = await User.create({
        fullName: "Retry Customer",
        email: "retry_customer@velora.test",
        password: "hashedpassword123",
        role: "USER",
    });
}

function createBaseOrderData(orderNumber, razorpayOrderId, paymentAttempts = []) {
    return {
        orderNumber,
        userId: testUser._id,
        paymentMethod: "ONLINE",
        paymentStatus: "PENDING",
        orderStatus: "PENDING",
        razorpayOrderId,
        paymentAttempts,
        shippingAddress: {
            firstName: "Retry",
            lastName: "Tester",
            addressLine1: "123 Retry St",
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
                productName: "Test Retry Shoe",
                quantity: 1,
                unitPrice: 1000,
                priceAtPurchase: 1000,
                lineTotal: 1000,
                status: "PENDING",
            },
        ],
        pricing: {
            subtotal: 1000,
            shippingFee: 0,
            discount: 0,
            totalAmount: 1000,
            currentPayable: 1000,
        },
    };
}

async function runTests() {
    console.log("==========================================================================");
    console.log("RUNNING ISOLATED DATABASE TESTS FOR BUG #3: PAYMENT RETRY SAFETY");
    console.log("Database:", TEST_DB_URI);
    console.log("==========================================================================");

    await setupTestData();

    let passed = 0;
    let failed = 0;

    function assert(condition, message) {
        if (!condition) {
            console.error(`  [FAIL] ${message}`);
            failed++;
            throw new Error(message);
        } else {
            console.log(`  [PASS] ${message}`);
            passed++;
        }
    }

    try {
        // -------------------------------------------------------------------------
        // Test A: Gateway lookup times out -> no new Razorpay order
        // -------------------------------------------------------------------------
        console.log("Running Test A: Gateway lookup times out -> no new Razorpay order...");
        {
            let createCalled = 0;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (orderId) => {
                        const err = new Error("Gateway timeout fetching payments");
                        err.code = "ETIMEDOUT";
                        throw err;
                    },
                    create: async () => {
                        createCalled++;
                        return { id: "rzp_order_should_not_exist" };
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-TEST-A", "order_timeout_123"));
            const result = await retryOrderPayment(testUser._id, order._id);

            assert(result.success === false, "Test A: Result success is false when lookup times out");
            assert(
                result.message === "We couldn’t confirm your previous payment. Please wait a moment and try again.",
                "Test A: Returns exact retryable user message"
            );
            assert(createCalled === 0, "Test A: razorpay orders.create was NEVER called");

            const dbOrder = await Order.findById(order._id);
            assert(dbOrder.orderStatus === "PENDING", "Test A: Order was NOT cancelled");
            assert(dbOrder.paymentStatus === "PENDING", "Test A: Payment status was NOT marked as failed");
            assert(dbOrder.paymentAttempts.length === 0, "Test A: No new payment attempt recorded");
        }

        // -------------------------------------------------------------------------
        // Test B: Gateway lookup returns an error -> no new Razorpay order
        // -------------------------------------------------------------------------
        console.log("Running Test B: Gateway lookup returns an error -> no new Razorpay order...");
        {
            let createCalled = 0;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => {
                        throw new Error("500 Internal Server Error from Razorpay API");
                    },
                    create: async () => {
                        createCalled++;
                        return { id: "rzp_order_should_not_exist" };
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-TEST-B", "order_err_500"));
            const result = await retryOrderPayment(testUser._id, order._id);

            assert(result.success === false, "Test B: Result success is false when gateway errors");
            assert(
                result.message === "We couldn’t confirm your previous payment. Please wait a moment and try again.",
                "Test B: Returns clear retryable message"
            );
            assert(createCalled === 0, "Test B: No new Razorpay order created on error");
        }

        // -------------------------------------------------------------------------
        // Test C: One previous attempt is unpaid but another lookup fails -> no new Razorpay order
        // -------------------------------------------------------------------------
        console.log("Running Test C: One previous attempt unpaid, another lookup fails -> no new Razorpay order...");
        {
            let createCalled = 0;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === "order_attempt_1_failed") {
                            return { items: [{ id: "pay_failed_1", status: "failed" }] };
                        }
                        if (gId === "order_attempt_2_unreachable") {
                            throw new Error("DNS resolution failure for Razorpay endpoint");
                        }
                        return { items: [] };
                    },
                    create: async () => {
                        createCalled++;
                        return { id: "rzp_order_should_not_exist" };
                    },
                },
            }));

            const order = await Order.create(
                createBaseOrderData("ORD-TEST-C", "order_attempt_1_failed", [
                    {
                        gateway: "RAZORPAY",
                        attemptId: "att_1",
                        razorpayOrderId: "order_attempt_1_failed",
                        status: "FAILED",
                    },
                    {
                        gateway: "RAZORPAY",
                        attemptId: "att_2",
                        razorpayOrderId: "order_attempt_2_unreachable",
                        status: "RETRY_INITIATED",
                    },
                ])
            );

            const result = await retryOrderPayment(testUser._id, order._id);

            assert(result.success === false, "Test C: Success is false when one of multiple lookups fails");
            assert(
                result.message === "We couldn’t confirm your previous payment. Please wait a moment and try again.",
                "Test C: Returns retryable message without proceeding"
            );
            assert(createCalled === 0, "Test C: No new Razorpay order created");
        }

        // -------------------------------------------------------------------------
        // Test D: A previous payment is captured -> recover it; no new Razorpay order
        // -------------------------------------------------------------------------
        console.log("Running Test D: A previous payment is captured -> recover it; no new Razorpay order...");
        {
            let createCalled = 0;
            const capturedPaymentId = "pay_captured_xyz_789";
            const capturedOrderId = "order_rzp_captured_456";

            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === capturedOrderId) {
                            return {
                                items: [
                                    { id: capturedPaymentId, status: "captured", amount: 100000, currency: "INR" },
                                ],
                            };
                        }
                        return { items: [] };
                    },
                    create: async () => {
                        createCalled++;
                        return { id: "rzp_order_should_not_exist" };
                    },
                },
                payments: {
                    fetch: async (payId) => ({
                        id: payId,
                        order_id: capturedOrderId,
                        status: "captured",
                        amount: 100000,
                        currency: "INR",
                    }),
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-TEST-D", capturedOrderId));
            // Add a Payment record matching the order
            await Payment.create({
                orderId: order._id,
                userId: testUser._id,
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                amount: 1000,
                razorpayOrderId: capturedOrderId,
            });

            const result = await retryOrderPayment(testUser._id, order._id);

            assert(result.success === true, "Test D: Success is true when captured payment is recovered");
            assert(result.isAlreadyPaid === true, "Test D: isAlreadyPaid flag is true");
            assert(createCalled === 0, "Test D: No new Razorpay order created");

            const dbOrder = await Order.findById(order._id);
            assert(dbOrder.paymentStatus === "COMPLETED", "Test D: Order marked as COMPLETED");
            assert(dbOrder.razorpayPaymentId === capturedPaymentId, "Test D: Razorpay payment ID recorded on order");
        }

        // -------------------------------------------------------------------------
        // Test E: Captured-payment recovery fails -> no new Razorpay order
        // -------------------------------------------------------------------------
        console.log("Running Test E: Captured-payment recovery fails -> no new Razorpay order...");
        {
            let createCalled = 0;
            const capOrderId = "order_rzp_cap_fail_val";
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        return {
                            items: [{ id: "pay_bad_cap", status: "captured", amount: 100000 }],
                        };
                    },
                    create: async () => {
                        createCalled++;
                        return { id: "rzp_order_should_not_exist" };
                    },
                },
            }));

            // Create order with invalid state that makes verifyRazorpayPayment fail verification
            const order = await Order.create(createBaseOrderData("ORD-TEST-E", capOrderId));
            // Force wrong key secret for signature verification failure or simulate verification error
            const originalSecret = process.env.RAZORPAY_KEY_SECRET;
            process.env.RAZORPAY_KEY_SECRET = "dummy_secret_for_recovery";

            // Intentionally corrupt order to cause verify failure
            await Order.updateOne({ _id: order._id }, { $set: { "pricing.totalAmount": 99999 } });

            const result = await retryOrderPayment(testUser._id, order._id);

            process.env.RAZORPAY_KEY_SECRET = originalSecret;

            assert(result.success === false, "Test E: Returns success: false when recovery verification fails");
            assert(createCalled === 0, "Test E: Did NOT fall through to create a new payment attempt");
        }

        // -------------------------------------------------------------------------
        // Test F: Authorized/in-progress payment exists -> safe policy without collecting again
        // -------------------------------------------------------------------------
        console.log("Running Test F: Authorized/in-progress payment exists -> safe policy without collecting again...");
        {
            let createCalled = 0;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => {
                        return {
                            items: [{ id: "pay_auth_under_review", status: "authorized", amount: 100000 }],
                        };
                    },
                    create: async () => {
                        createCalled++;
                        return { id: "rzp_order_should_not_exist" };
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-TEST-F", "order_rzp_auth_123"));
            const result = await retryOrderPayment(testUser._id, order._id);

            assert(result.success === false, "Test F: Returns success: false when payment is authorized/in-progress");
            assert(
                result.message.includes("currently being processed by the bank"),
                "Test F: Explains payment is being processed by the bank"
            );
            assert(createCalled === 0, "Test F: No new Razorpay order created while authorization is pending");
        }

        // -------------------------------------------------------------------------
        // Test G: All previous attempts successfully checked and retryable -> create exactly one new attempt
        // -------------------------------------------------------------------------
        console.log("Running Test G: All previous attempts checked & retryable -> create exactly one new attempt...");
        {
            let createCalled = 0;
            const newOrderId = "rzp_order_legit_new_777";
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        return {
                            items: [{ id: "pay_failed_terminal", status: "failed" }],
                        };
                    },
                    create: async (opts) => {
                        createCalled++;
                        return { id: newOrderId, amount: opts.amount };
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-TEST-G", "order_prev_clean_failed"));
            const result = await retryOrderPayment(testUser._id, order._id);

            assert(result.success === true, "Test G: Payment retry initiated successfully");
            assert(result.razorpay && result.razorpay.orderId === newOrderId, "Test G: Returned new Razorpay order details");
            assert(createCalled === 1, "Test G: Razorpay orders.create was called exactly ONCE");

            const dbOrder = await Order.findById(order._id);
            assert(dbOrder.razorpayOrderId === newOrderId, "Test G: Order updated with new razorpayOrderId");
            assert(dbOrder.paymentAttempts.length === 1, "Test G: Exactly one new payment attempt recorded");
            assert(dbOrder.paymentAttempts[0].status === "RETRY_INITIATED", "Test G: Attempt status is RETRY_INITIATED");
        }

        // -------------------------------------------------------------------------
        // Test H: Concurrent retry requests -> no duplicate new attempts
        // -------------------------------------------------------------------------
        console.log("Running Test H: Concurrent retry requests -> no duplicate new attempts...");
        {
            let createCalled = 0;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({ items: [{ id: "pay_failed_prev", status: "failed" }] }),
                    create: async () => {
                        createCalled++;
                        await new Promise((r) => setTimeout(r, 60)); // Simulate gateway latency
                        return { id: `rzp_order_concurrent_${createCalled}` };
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-TEST-H", "order_concurrent_prev"));

            // Launch two concurrent retry requests simultaneously
            const [res1, res2] = await Promise.all([
                retryOrderPayment(testUser._id, order._id),
                retryOrderPayment(testUser._id, order._id),
            ]);

            const successes = [res1, res2].filter((r) => r.success);
            const inProgressBlocks = [res1, res2].filter(
                (r) => !r.success && r.message === "A payment retry is already in progress. Please wait a moment."
            );

            assert(successes.length === 1, "Test H: Exactly one concurrent retry succeeded");
            assert(inProgressBlocks.length === 1, "Test H: Second concurrent retry was blocked by lock");
            assert(createCalled === 1, "Test H: Gateway create called exactly once; no duplicate orders");
        }

        // -------------------------------------------------------------------------
        // Test I: After a temporary lookup failure, a later valid retry works and is not blocked by stale lock
        // -------------------------------------------------------------------------
        console.log("Running Test I: Later valid retry works and is not blocked by stale lock...");
        {
            let createCalled = 0;
            let networkDown = true;

            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => {
                        if (networkDown) {
                            throw new Error("Temporary network glitch");
                        }
                        return { items: [{ id: "pay_failed_terminal", status: "failed" }] };
                    },
                    create: async () => {
                        createCalled++;
                        return { id: "rzp_order_recovered_success" };
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-TEST-I", "order_temp_fail_prev"));

            // Step 1: Retry fails due to temporary network glitch
            const resFail = await retryOrderPayment(testUser._id, order._id);
            assert(resFail.success === false, "Test I: First retry failed due to network glitch");
            assert(
                resFail.message === "We couldn’t confirm your previous payment. Please wait a moment and try again.",
                "Test I: First retry returned retryable confirmation message"
            );

            // Verify lock was released immediately
            const orderAfterFail = await Order.findById(order._id);
            assert(orderAfterFail.retryLockUntil === null, "Test I: Retry lock was released on exit");
            assert(orderAfterFail.retryLockToken === null, "Test I: Retry lock token was cleared");

            // Step 2: Network restores, user clicks retry again
            networkDown = false;
            const resSuccess = await retryOrderPayment(testUser._id, order._id);
            assert(resSuccess.success === true, "Test I: Second retry succeeded without being blocked by stale lock");
            assert(resSuccess.razorpay.orderId === "rzp_order_recovered_success", "Test I: New Razorpay order created");
            assert(createCalled === 1, "Test I: Exactly one new order created in total");
        }

        console.log("\n==========================================================================");
        console.log("TEST SUMMARY FOR BUG #3 FIX:");
        console.log(`Passed: ${passed}/${passed + failed}`);
        console.log(`Failed: ${failed}/${passed + failed}`);
        console.log("==========================================================================");

        if (failed > 0) {
            process.exit(1);
        }
    } finally {
        setRazorpayInstanceCreator(null);
        await mongoose.disconnect();
    }
}

runTests().catch((err) => {
    console.error("Unhandled test suite error:", err);
    process.exit(1);
});
