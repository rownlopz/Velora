require("dotenv").config();
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const mongoose = require("mongoose");
const crypto = require("crypto");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const User = require("../models/user/userModel");
const Wallet = require("../models/user/walletModel");
const Transaction = require("../models/user/transactionModel");
const Product = require("../models/product/productModel");
const Variant = require("../models/product/variantModel");
const Category = require("../models/product/categoryModel");
const { retryOrderPayment } = require("../services/user/orderService");
const { retryPaymentController, loadPaymentFailed, loadPaymentSuccess } = require("../controllers/user/orderController");
const { setRazorpayInstanceCreator } = require("../config/razorpay");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  [PASS] ${message}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${message}`);
        failed++;
    }
}

let testUser;
let otherUser;
let testProduct;
let testVariant;

async function setupTestData() {
    await mongoose.connect(TEST_DB_URI);
    await mongoose.connection.dropDatabase();

    const cat = await Category.create({ name: "Bug8 Cat", slug: "bug8-cat" });
    testProduct = await Product.create({
        name: "Test Bug8 Item",
        slug: "test-bug8-item",
        categoryId: cat._id,
        description: "Test Bug8 Item Description",
        status: "ACTIVE",
    });
    testVariant = await Variant.create({
        productId: testProduct._id,
        color: "Black",
        size: "M",
        sku: "BUG8-ITEM-M",
        stock: 50,
        regularPrice: 1500,
        salePrice: 1500,
        price: 1500,
    });

    testUser = await User.create({
        fullName: "Bug Eight User",
        email: "bug8_user@velora.test",
        password: "hashedpassword123",
        role: "USER",
    });

    otherUser = await User.create({
        fullName: "Other Bug User",
        email: "other_user@velora.test",
        password: "hashedpassword123",
        role: "USER",
    });

    await Wallet.create({
        userId: testUser._id,
        balance: 0,
        currency: "INR",
        isActive: true,
    });
}

function createBaseOrderData(orderNumber, razorpayOrderId, paymentAttempts = [], custom = {}) {
    return {
        orderNumber,
        userId: testUser._id,
        paymentMethod: "ONLINE",
        paymentStatus: "PENDING",
        orderStatus: "PENDING",
        razorpayOrderId,
        paymentAttempts,
        shippingAddress: {
            firstName: "Bug",
            lastName: "Eight",
            phone: "9876543210",
            addressLine1: "123 Test St",
            city: "Test City",
            state: "Test State",
            pinCode: 560001,
            country: "India",
        },
        items: [
            {
                productId: testProduct._id,
                variantId: testVariant._id,
                productName: testProduct.name,
                color: testVariant.color,
                size: testVariant.size,
                sku: testVariant.sku,
                quantity: 1,
                unitPrice: 1500,
                lineTotal: 1500,
                status: "PENDING",
            },
        ],
        pricing: {
            subtotal: 1500,
            shippingFee: 0,
            couponDiscount: 0,
            totalAmount: 1500,
            currentPayable: 1500,
            purchaseRefundTotal: 0,
            duplicateRefundTotal: 0,
            walletRefundIssued: 0,
        },
        ...custom,
    };
}

/**
 * Helper to run the frontend script from views/user/payment-failed.ejs in a simulated browser context
 */
function createFrontendEnvironment(orderId, fetchMock) {
    const alertCalls = [];
    const windowLocation = { href: "" };
    const razorpayInstances = [];
    let openCalls = 0;

    const mockBtn = {
        disabled: false,
        innerHTML: "<span>Retry Payment</span>",
        listeners: {},
        addEventListener(evt, fn) {
            this.listeners[evt] = fn;
        },
        click() {
            if (this.listeners["click"]) {
                return this.listeners["click"]({ preventDefault() {} });
            }
        },
    };

    const mockDocument = {
        getElementById(id) {
            if (id === "retryPaymentBtn") return mockBtn;
            return null;
        },
    };

    function MockRazorpay(opts) {
        this.opts = opts;
        this.events = {};
        this.open = () => {
            openCalls++;
        };
        this.on = (evt, fn) => {
            this.events[evt] = fn;
        };
        razorpayInstances.push(this);
    }

    // Read the script from views/user/payment-failed.ejs and render order._id template placeholder
    const templateContent = fs.readFileSync(path.join(__dirname, "../views/user/payment-failed.ejs"), "utf8");
    const scriptMatch = templateContent.match(/<script>([\s\S]*?)<\/script>/);
    if (!scriptMatch) throw new Error("Could not find <script> in payment-failed.ejs");

    let scriptCode = scriptMatch[1];
    scriptCode = scriptCode.replace(/<%= order\._id %>/g, orderId.toString());

    const context = {
        document: mockDocument,
        window: {
            location: windowLocation,
        },
        alert: (msg) => {
            alertCalls.push(msg);
        },
        fetch: fetchMock,
        Razorpay: MockRazorpay,
        console,
        setTimeout,
        clearTimeout,
    };

    vm.createContext(context);
    vm.runInContext(scriptCode, context);

    return {
        mockBtn,
        alertCalls,
        windowLocation,
        razorpayInstances,
        getOpenCalls: () => openCalls,
    };
}

async function runTests() {
    try {
        console.log("==========================================================================");
        console.log("RUNNING ISOLATED DATABASE TESTS FOR BUG #8: PAYMENT RETRY OUTCOME HANDLING");
        console.log("Database:", TEST_DB_URI);
        console.log("==========================================================================");

        await setupTestData();

        // -------------------------------------------------------------------------
        // Case A: Previous captured payment is successfully recovered
        // -------------------------------------------------------------------------
        console.log("\nRunning Case A: Previous captured payment is successfully recovered...");
        {
            const capPaymentId = "pay_captured_bug8_A";
            const capOrderId = "order_rzp_bug8_A";

            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === capOrderId) {
                            return {
                                items: [{ id: capPaymentId, status: "captured", amount: 150000, currency: "INR" }],
                            };
                        }
                        return { items: [] };
                    },
                    create: async () => {
                        throw new Error("create should not be called when recovering payment");
                    },
                },
                payments: {
                    fetch: async (payId) => ({
                        id: payId,
                        order_id: capOrderId,
                        status: "captured",
                        amount: 150000,
                        currency: "INR",
                    }),
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-BUG8-A", capOrderId));
            await Payment.create({
                orderId: order._id,
                userId: testUser._id,
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                amount: 1500,
                razorpayOrderId: capOrderId,
            });

            // 1. Service Test
            const serviceResult = await retryOrderPayment(testUser._id, order._id);
            assert(serviceResult.success === true, "Case A (Service): Returns success: true");
            assert(serviceResult.isAlreadyPaid === true, "Case A (Service): Returns isAlreadyPaid: true");
            assert(serviceResult.order.paymentStatus === "COMPLETED", "Case A (Service): Order marked COMPLETED");

            // 2. Controller Test
            let jsonSent = null;
            let statusSent = 200;
            const req = { session: { userId: testUser._id }, params: { orderId: order._id.toString() } };
            const res = {
                status(code) { statusSent = code; return this; },
                json(payload) { jsonSent = payload; return this; },
            };
            await retryPaymentController(req, res);

            assert(statusSent === 200, "Case A (Controller): Returns HTTP 200");
            assert(jsonSent && jsonSent.success === true, "Case A (Controller): Payload success is true");
            assert(jsonSent && jsonSent.isAlreadyPaid === true, "Case A (Controller): Payload isAlreadyPaid is true");
            assert(jsonSent && jsonSent.redirectUrl === `/orders/${order._id}/payment-success`, "Case A (Controller): redirectUrl points to payment-success");
            assert(!jsonSent.razorpay, "Case A (Controller): No Razorpay checkout config included");

            // 3. Frontend Test
            const fetchMock = async (url) => ({
                ok: true,
                status: 200,
                json: async () => jsonSent,
            });
            const fe = createFrontendEnvironment(order._id, fetchMock);
            await fe.mockBtn.click();

            assert(fe.windowLocation.href === `/orders/${order._id}/payment-success`, "Case A (Frontend): Redirects to payment-success route");
            assert(fe.getOpenCalls() === 0, "Case A (Frontend): Razorpay popup was NOT opened");
            assert(fe.razorpayInstances.length === 0, "Case A (Frontend): No Razorpay instance created");
            assert(fe.alertCalls.length === 0, "Case A (Frontend): No error alert displayed");
        }

        // -------------------------------------------------------------------------
        // Case B: Order is already paid
        // -------------------------------------------------------------------------
        console.log("\nRunning Case B: Order is already paid...");
        {
            let createCalled = 0;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    create: async () => {
                        createCalled++;
                        return { id: "should_not_be_created" };
                    },
                },
            }));

            const paidOrder = await Order.create(createBaseOrderData("ORD-BUG8-B", "order_already_paid", [], {
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
                paidAt: new Date(),
                razorpayPaymentId: "pay_prev_complete_123",
            }));

            // 1. Service Test
            const serviceResult = await retryOrderPayment(testUser._id, paidOrder._id);
            assert(serviceResult.success === true, "Case B (Service): Returns success: true");
            assert(serviceResult.isAlreadyPaid === true, "Case B (Service): Returns isAlreadyPaid: true");
            assert(createCalled === 0, "Case B (Service): No new gateway order created");

            // 2. Controller Test
            let jsonSent = null;
            let statusSent = 200;
            const req = { session: { userId: testUser._id }, params: { orderId: paidOrder._id.toString() } };
            const res = {
                status(code) { statusSent = code; return this; },
                json(payload) { jsonSent = payload; return this; },
            };
            await retryPaymentController(req, res);

            assert(statusSent === 200, "Case B (Controller): Returns HTTP 200");
            assert(jsonSent.redirectUrl === `/orders/${paidOrder._id}/payment-success`, "Case B (Controller): Points to payment-success destination");

            // 3. Frontend Test
            const fetchMock = async () => ({
                ok: true,
                status: 200,
                json: async () => jsonSent,
            });
            const fe = createFrontendEnvironment(paidOrder._id, fetchMock);
            await fe.mockBtn.click();

            assert(fe.windowLocation.href === `/orders/${paidOrder._id}/payment-success`, "Case B (Frontend): Redirects to payment-success destination");
            assert(fe.getOpenCalls() === 0, "Case B (Frontend): No Razorpay popup opened");
        }

        // -------------------------------------------------------------------------
        // Case C: Previous payment is safely retryable
        // -------------------------------------------------------------------------
        console.log("\nRunning Case C: Previous payment is safely retryable...");
        {
            let createCalled = 0;
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => ({ items: [] }),
                    create: async (params) => {
                        createCalled++;
                        return { id: "rzp_order_retry_C" };
                    },
                },
            }));

            const retryableOrder = await Order.create(createBaseOrderData("ORD-BUG8-C", "order_unpaid_prev"));

            // 1. Service Test
            const serviceResult = await retryOrderPayment(testUser._id, retryableOrder._id);
            assert(serviceResult.success === true, "Case C (Service): Returns success: true");
            assert(serviceResult.razorpay && serviceResult.razorpay.orderId === "rzp_order_retry_C", "Case C (Service): Returns new Razorpay config");
            assert(!serviceResult.isAlreadyPaid, "Case C (Service): isAlreadyPaid is falsy");

            // 2. Controller Test
            let jsonSent = null;
            let statusSent = 200;
            const req = { session: { userId: testUser._id }, params: { orderId: retryableOrder._id.toString() } };
            const res = {
                status(code) { statusSent = code; return this; },
                json(payload) { jsonSent = payload; return this; },
            };
            await retryPaymentController(req, res);

            assert(statusSent === 200, "Case C (Controller): Returns HTTP 200");
            assert(jsonSent.razorpay && jsonSent.razorpay.orderId === "rzp_order_retry_C", "Case C (Controller): Includes Razorpay order ID");

            // 3. Frontend Test
            const fetchMock = async () => ({
                ok: true,
                status: 200,
                json: async () => jsonSent,
            });
            const fe = createFrontendEnvironment(retryableOrder._id, fetchMock);
            await fe.mockBtn.click();

            assert(fe.getOpenCalls() === 1, "Case C (Frontend): Exactly one Razorpay popup opened");
            assert(fe.razorpayInstances[0].opts.order_id === "rzp_order_retry_C", "Case C (Frontend): Razorpay initialized with returned order ID");
            assert(fe.windowLocation.href === "", "Case C (Frontend): Did NOT prematurely redirect before gateway checkout");
        }

        // -------------------------------------------------------------------------
        // Case D: Gateway lookup fails (Preserve bug #3)
        // -------------------------------------------------------------------------
        console.log("\nRunning Case D: Gateway lookup fails...");
        {
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async () => {
                        const err = new Error("Gateway lookup timeout");
                        err.code = "ETIMEDOUT";
                        throw err;
                    },
                    create: async () => {
                        throw new Error("create should not be called when lookup fails");
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-BUG8-D", "order_timeout_D"));

            // 1. Service Test
            const serviceResult = await retryOrderPayment(testUser._id, order._id);
            assert(serviceResult.success === false, "Case D (Service): Returns success: false");
            assert(serviceResult.retryable === true, "Case D (Service): Returns retryable: true");
            assert(serviceResult.message.includes("couldn’t confirm your previous payment"), "Case D (Service): Clear retryable message");

            // 2. Controller Test
            let jsonSent = null;
            let statusSent = 200;
            const req = { session: { userId: testUser._id }, params: { orderId: order._id.toString() } };
            const res = {
                status(code) { statusSent = code; return this; },
                json(payload) { jsonSent = payload; return this; },
            };
            await retryPaymentController(req, res);

            assert(statusSent === 400, "Case D (Controller): Returns HTTP 400 for lookup error");
            assert(jsonSent.retryable === true, "Case D (Controller): Payload preserves retryable flag");

            // 3. Frontend Test
            const fetchMock = async () => ({
                ok: false,
                status: 400,
                json: async () => jsonSent,
            });
            const fe = createFrontendEnvironment(order._id, fetchMock);
            await fe.mockBtn.click();

            assert(fe.getOpenCalls() === 0, "Case D (Frontend): Razorpay popup was NOT opened");
            assert(fe.windowLocation.href === "", "Case D (Frontend): Did not redirect to success");
            assert(fe.alertCalls.length === 1, "Case D (Frontend): Displayed alert message");
            assert(fe.alertCalls[0].includes("couldn’t confirm your previous payment"), "Case D (Frontend): Alert content explains confirmation delay");
            assert(fe.mockBtn.disabled === false, "Case D (Frontend): Button is re-enabled for future attempts");
            assert(fe.mockBtn.innerHTML === "<span>Retry Payment</span>", "Case D (Frontend): Button text restored");
        }

        // -------------------------------------------------------------------------
        // Case E: Recovery fails -> no false success redirect and no new collection
        // -------------------------------------------------------------------------
        console.log("\nRunning Case E: Recovery fails -> no false success redirect and no new collection...");
        {
            let createCalled = 0;
            const badCapOrderId = "order_bad_cap_E";
            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => ({
                        items: [{ id: "pay_bad_cap_E", status: "captured", amount: 150000 }],
                    }),
                    create: async () => {
                        createCalled++;
                        return { id: "should_not_exist" };
                    },
                },
                payments: {
                    fetch: async () => {
                        throw new Error("Unable to fetch payment entity from gateway");
                    },
                },
            }));

            const order = await Order.create(createBaseOrderData("ORD-BUG8-E", badCapOrderId));

            // 1. Service Test
            const serviceResult = await retryOrderPayment(testUser._id, order._id);
            assert(serviceResult.success === false, "Case E (Service): Returns success: false when recovery verification fails");
            assert(createCalled === 0, "Case E (Service): No new collection initiated");

            // 2. Controller Test
            let jsonSent = null;
            let statusSent = 200;
            const req = { session: { userId: testUser._id }, params: { orderId: order._id.toString() } };
            const res = {
                status(code) { statusSent = code; return this; },
                json(payload) { jsonSent = payload; return this; },
            };
            await retryPaymentController(req, res);

            assert(statusSent === 400, "Case E (Controller): Returns HTTP 400");
            assert(jsonSent.success === false, "Case E (Controller): success is false");
            assert(!jsonSent.redirectUrl, "Case E (Controller): No success redirectUrl provided");

            // 3. Frontend Test
            const fetchMock = async () => ({
                ok: false,
                status: 400,
                json: async () => jsonSent,
            });
            const fe = createFrontendEnvironment(order._id, fetchMock);
            await fe.mockBtn.click();

            assert(fe.windowLocation.href === "", "Case E (Frontend): No false success redirect occurred");
            assert(fe.getOpenCalls() === 0, "Case E (Frontend): No Razorpay checkout popup opened");
            assert(fe.mockBtn.disabled === false, "Case E (Frontend): Button re-enabled");
        }

        // -------------------------------------------------------------------------
        // Case F: Late payment belongs to a cancelled order and is refunded
        // -------------------------------------------------------------------------
        console.log("\nRunning Case F: Late payment belongs to a cancelled order and is refunded...");
        {
            const lateCapOrderId = "order_late_cap_F";
            const latePayId = "pay_late_cap_F";

            setRazorpayInstanceCreator(() => ({
                orders: {
                    fetchPayments: async (gId) => {
                        if (gId === lateCapOrderId) {
                            return { items: [{ id: latePayId, status: "captured", amount: 150000, currency: "INR" }] };
                        }
                        return { items: [] };
                    },
                    create: async () => {
                        throw new Error("create must not be called for cancelled order");
                    },
                },
                payments: {
                    fetch: async (payId) => ({
                        id: payId,
                        order_id: lateCapOrderId,
                        status: "captured",
                        amount: 150000,
                        currency: "INR",
                    }),
                },
            }));

            const cancelledOrder = await Order.create(createBaseOrderData("ORD-BUG8-F", lateCapOrderId, [], {
                orderStatus: "CANCELLED",
                paymentStatus: "FAILED",
            }));

            // 1. Service Test
            const serviceResult = await retryOrderPayment(testUser._id, cancelledOrder._id);
            assert(serviceResult.success === false, "Case F (Service): Returns success: false (purchase not active)");
            assert(serviceResult.isCancelledLateRefund === true, "Case F (Service): Identifies cancelled late refund");

            const dbOrder = await Order.findById(cancelledOrder._id);
            assert(dbOrder.paymentStatus === "REFUNDED", "Case F (Service): Order paymentStatus is REFUNDED");

            const wallet = await Wallet.findOne({ userId: testUser._id });
            assert(wallet.balance === 1500, "Case F (Service): Wallet credited with late payment refund");

            // 2. Controller Test
            let jsonSent = null;
            let statusSent = 200;
            const req = { session: { userId: testUser._id }, params: { orderId: cancelledOrder._id.toString() } };
            const res = {
                status(code) { statusSent = code; return this; },
                json(payload) { jsonSent = payload; return this; },
            };
            await retryPaymentController(req, res);

            assert(statusSent === 200, "Case F (Controller): Returns HTTP 200 for resolved refund");
            assert(jsonSent.isCancelledLateRefund === true, "Case F (Controller): Payload confirms late refund");
            assert(jsonSent.redirectUrl.startsWith(`/orders/${cancelledOrder._id}?notice=`), "Case F (Controller): redirectUrl routes to order details with notice");
            assert(!jsonSent.redirectUrl.includes("payment-success"), "Case F (Controller): Does NOT route to payment-success");

            // 3. Frontend Test
            const fetchMock = async () => ({
                ok: true,
                status: 200,
                json: async () => jsonSent,
            });
            const fe = createFrontendEnvironment(cancelledOrder._id, fetchMock);
            await fe.mockBtn.click();

            assert(fe.windowLocation.href.startsWith(`/orders/${cancelledOrder._id}?notice=`), "Case F (Frontend): Redirects to order details with notice query");
            assert(!fe.windowLocation.href.includes("payment-success"), "Case F (Frontend): Never redirects to payment success");
            assert(fe.getOpenCalls() === 0, "Case F (Frontend): No Razorpay checkout opened");
        }

        // -------------------------------------------------------------------------
        // Case G: Rapid repeated clicks
        // -------------------------------------------------------------------------
        console.log("\nRunning Case G: Rapid repeated clicks -> no duplicate checkout popups or new attempts...");
        {
            let fetchCallCount = 0;
            let resolveFetch;
            const fetchPromise = new Promise((resolve) => {
                resolveFetch = resolve;
            });

            const fetchMock = async () => {
                fetchCallCount++;
                return fetchPromise;
            };

            const fe = createFrontendEnvironment("60c72b2f9b1d8b2bad000001", fetchMock);

            // Click 1: in-flight started
            fe.mockBtn.click();
            assert(fe.mockBtn.disabled === true, "Case G: Button disabled immediately on first click");
            assert(fe.mockBtn.innerHTML.includes("Initiating Gateway"), "Case G: Button shows in-flight text");

            // Click 2 & 3: rapid subsequent clicks while in-flight
            fe.mockBtn.click();
            fe.mockBtn.click();
            assert(fetchCallCount === 1, "Case G: Exactly one fetch initiated despite repeated clicks");

            // Resolve fetch
            resolveFetch({
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    razorpay: { keyId: "rzp_test_key", orderId: "rzp_single_click_order", amount: 150000, currency: "INR" },
                }),
            });

            // Wait for microtasks
            await new Promise((r) => setImmediate(r));
            assert(fe.getOpenCalls() === 1, "Case G: Exactly one Razorpay popup opened");
        }

        // -------------------------------------------------------------------------
        // Case H: Invalid response or network error
        // -------------------------------------------------------------------------
        console.log("\nRunning Case H: Invalid response or network error...");
        {
            // Part 1: Network error (fetch rejects)
            const networkErrorFetch = async () => {
                throw new Error("Failed to fetch");
            };
            const feNet = createFrontendEnvironment("60c72b2f9b1d8b2bad000002", networkErrorFetch);
            await feNet.mockBtn.click();

            assert(feNet.alertCalls.length === 1, "Case H (Network): Displays network error alert");
            assert(feNet.alertCalls[0].includes("check your network"), "Case H (Network): Explains network issue");
            assert(feNet.mockBtn.disabled === false, "Case H (Network): Button restored to enabled state");
            assert(feNet.mockBtn.innerHTML === "<span>Retry Payment</span>", "Case H (Network): Button text restored");

            // Part 2: Invalid non-JSON response
            const invalidJsonFetch = async () => ({
                ok: true,
                status: 502,
                json: async () => {
                    throw new SyntaxError("Unexpected token < in JSON at position 0");
                },
            });
            const feJson = createFrontendEnvironment("60c72b2f9b1d8b2bad000003", invalidJsonFetch);
            await feJson.mockBtn.click();

            assert(feJson.alertCalls.length === 1, "Case H (JSON): Displays invalid response alert");
            assert(feJson.alertCalls[0].includes("Invalid response"), "Case H (JSON): Explains invalid response");
            assert(feJson.mockBtn.disabled === false, "Case H (JSON): Button restored to enabled state");
        }

        // -------------------------------------------------------------------------
        // Case I: Destination page ownership & security checks
        // -------------------------------------------------------------------------
        console.log("\nRunning Case I: Destination page security and routing contracts...");
        {
            const testOrder = await Order.create(createBaseOrderData("ORD-BUG8-SEC", "order_sec_123", [], {
                paymentStatus: "COMPLETED",
                orderStatus: "PROCESSING",
            }));

            // Test 1: User B cannot access User A's payment-success
            let redirectUrlB = null;
            const reqB = { session: { userId: otherUser._id }, params: { orderId: testOrder._id.toString() } };
            const resB = {
                redirect(url) { redirectUrlB = url; },
                render() {},
            };
            await loadPaymentSuccess(reqB, resB);
            assert(redirectUrlB && redirectUrlB.includes("/products?notice="), "Case I: Other user cannot access payment-success page");

            // Test 2: User A on loadPaymentFailed for already completed order redirects to payment-success
            let redirectUrlFailed = null;
            const reqFailed = { session: { userId: testUser._id }, params: { orderId: testOrder._id.toString() }, query: {} };
            const resFailed = {
                redirect(url) { redirectUrlFailed = url; },
                render() {},
            };
            await loadPaymentFailed(reqFailed, resFailed);
            assert(redirectUrlFailed === `/orders/${testOrder._id}/payment-success`, "Case I: Completed order redirects from payment-failed to payment-success");

            // Test 3: Unpaid order on loadPaymentSuccess redirects to payment-failed
            const unpaidOrder = await Order.create(createBaseOrderData("ORD-BUG8-UNPAID", "order_unpaid_sec"));
            let redirectUnpaidSuccess = null;
            const reqUnpaid = { session: { userId: testUser._id }, params: { orderId: unpaidOrder._id.toString() } };
            const resUnpaid = {
                redirect(url) { redirectUnpaidSuccess = url; },
                render() {},
            };
            await loadPaymentSuccess(reqUnpaid, resUnpaid);
            assert(redirectUnpaidSuccess.includes(`/orders/${unpaidOrder._id}/payment-failed`), "Case I: Unpaid order redirects from payment-success to payment-failed");
        }

        console.log("\n==========================================================================");
        console.log("TEST SUMMARY FOR BUG #8 FIX:");
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
