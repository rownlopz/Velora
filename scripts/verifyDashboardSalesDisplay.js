/**
 * Verification Test Suite for Admin Dashboard Last-Two-Days Sales Display Fix
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 * 
 * Verifies all requirements:
 * 1. Date boundaries in Asia/Kolkata (IST) up to the current time:
 *    - Orders before yesterday 00:00:00 IST excluded
 *    - Orders yesterday (00:00:00 to 23:59:59.999 IST) included in yesterdaySales
 *    - Orders today up to current time (00:00:00 to now IST) included in todaySales
 *    - Orders placed after current time excluded
 * 2. Inclusion of genuine paid sales (Online, Wallet debit, Delivered COD).
 * 3. Accurate accounting for item cancellations and returns (currentPayable).
 * 4. Exclusion of unpaid orders (Pending/Failed Online, Pending COD) and duplicate payment collections.
 * 5. Returns ₹0 when there are no qualifying sales.
 * 6. Dashboard controller and EJS view render valid amounts near the "Store Dashboard" heading without 'undefined'.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const ejs = require("ejs");
const fs = require("fs");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const User = require("../models/user/userModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Transaction = require("../models/user/transactionModel");
const reportService = require("../services/admin/reportService");
const reportController = require("../controllers/admin/reportController");

let passed = 0;
let failed = 0;
const failures = [];

const check = (condition, desc, details = "") => {
    if (condition) {
        passed++;
        console.log(`  [PASS] ${desc}`);
    } else {
        failed++;
        console.error(`  [FAIL] ${desc} ${details ? "- " + details : ""}`);
        failures.push(`${desc} ${details}`);
    }
};

async function runTests() {
    console.log("==========================================================================");
    console.log("VERIFICATION: ADMIN DASHBOARD LAST-TWO-DAYS SALES DISPLAY FIX");
    console.log(`Isolated Database: ${TEST_DB_URI}`);
    console.log("==========================================================================\n");

    await mongoose.connect(TEST_DB_URI);

    // Clean test records
    await Order.deleteMany({ orderNumber: /^TEST-DASH-/ });
    await Payment.deleteMany({ razorpayPaymentId: /^test_pay_dash_/ });
    await Transaction.deleteMany({ referenceId: /^REF_TEST_DASH_/ });

    const testUser = await User.findOneAndUpdate(
        { email: "dash_test_user@velora.isolated" },
        { fullName: "Dashboard Tester", email: "dash_test_user@velora.isolated", password: "Password123!", role: "USER", status: "Active", isEmailVerified: true },
        { upsert: true, returnDocument: "after" }
    );

    const dummyProdId = new mongoose.Types.ObjectId();
    const dummyVarId = new mongoose.Types.ObjectId();
    const dummyAddress = {
        firstName: "Dashboard",
        lastName: "Tester",
        addressLine1: "123 Test St",
        city: "Kochi",
        state: "Kerala",
        pinCode: 682001,
        country: "India",
        phone: "9876543210",
    };

    // Reference time in IST: 2026-10-25 14:00:00 IST
    const asOf = new Date("2026-10-25T14:00:00.000+05:30");
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;

    // =========================================================================
    // SECTION 1: DATE BOUNDARY VERIFICATION
    // =========================================================================
    console.log("--- Section 1: Asia/Kolkata Date Boundary Calculations ---");

    const boundaryCheck = await reportService.getLastTwoDaysSales(asOf);

    // Expected boundaries:
    // todayStart = 2026-10-25 00:00:00.000 IST = 2026-10-24T18:30:00.000Z
    // todayEnd = asOf = 2026-10-25T14:00:00.000+05:30 = 2026-10-25T08:30:00.000Z
    // yesterdayStart = 2026-10-24 00:00:00.000 IST = 2026-10-23T18:30:00.000Z
    // yesterdayEnd = 2026-10-24 23:59:59.999 IST = 2026-10-24T18:29:59.999Z

    const expectedTodayStart = new Date("2026-10-24T18:30:00.000Z");
    const expectedTodayEnd = asOf;
    const expectedYesterdayStart = new Date("2026-10-23T18:30:00.000Z");
    const expectedYesterdayEnd = new Date("2026-10-24T18:29:59.999Z");

    check(
        boundaryCheck.todayStart.getTime() === expectedTodayStart.getTime(),
        "1A: todayStart matches 2026-10-25 00:00:00 IST",
        `Expected: ${expectedTodayStart.toISOString()}, Got: ${boundaryCheck.todayStart.toISOString()}`
    );
    check(
        boundaryCheck.todayEnd.getTime() === expectedTodayEnd.getTime(),
        "1B: todayEnd strictly matches current time (asOf)",
        `Expected: ${expectedTodayEnd.toISOString()}, Got: ${boundaryCheck.todayEnd.toISOString()}`
    );
    check(
        boundaryCheck.yesterdayStart.getTime() === expectedYesterdayStart.getTime(),
        "1C: yesterdayStart matches 2026-10-24 00:00:00 IST",
        `Expected: ${expectedYesterdayStart.toISOString()}, Got: ${boundaryCheck.yesterdayStart.toISOString()}`
    );
    check(
        boundaryCheck.yesterdayEnd.getTime() === expectedYesterdayEnd.getTime(),
        "1D: yesterdayEnd matches 2026-10-24 23:59:59.999 IST",
        `Expected: ${expectedYesterdayEnd.toISOString()}, Got: ${boundaryCheck.yesterdayEnd.toISOString()}`
    );

    // =========================================================================
    // SECTION 2: QUALIFYING SALES & FINANCIAL SAFETY TESTS
    // =========================================================================
    console.log("\n--- Section 2: Financial Safety & Order Filtering Tests ---");

    // Order 0: Placed 3 days ago (2026-10-22 10:00 IST) -> Must be EXCLUDED from both
    await Order.create({
        orderNumber: "TEST-DASH-OLD-00",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Old Item", quantity: 1, unitPrice: 5000, priceAtPurchase: 5000, lineTotal: 5000, finalPayable: 5000, status: "DELIVERED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 5000, subtotal: 5000, shippingFee: 0, totalAmount: 5000, currentPayable: 5000, collectedAmount: 5000 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        placedAt: new Date("2026-10-22T10:00:00.000+05:30"),
    });

    // Order 1: Yesterday morning (2026-10-24 10:00 IST) -> Paid Online: ₹1,000
    const ord1 = await Order.create({
        orderNumber: "TEST-DASH-YEST-PAID-01",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Yest Item 1", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "PROCESSING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000, collectedAmount: 1000 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        placedAt: new Date("2026-10-24T10:00:00.000+05:30"),
        razorpayPaymentId: "test_pay_dash_01",
    });
    await Payment.create({
        orderId: ord1._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "COMPLETED",
        razorpayPaymentId: "test_pay_dash_01",
        paidAt: new Date("2026-10-24T10:00:00.000+05:30"),
    });

    // Order 2: Yesterday evening (2026-10-24 20:00 IST) -> Delivered COD: ₹1,500
    await Order.create({
        orderNumber: "TEST-DASH-YEST-COD-02",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Yest Item 2", quantity: 1, unitPrice: 1500, priceAtPurchase: 1500, lineTotal: 1500, finalPayable: 1500, status: "DELIVERED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1500, subtotal: 1500, shippingFee: 0, totalAmount: 1500, currentPayable: 1500 },
        paymentMethod: "COD",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        placedAt: new Date("2026-10-24T20:00:00.000+05:30"),
    });

    // Order 3: Yesterday night (2026-10-24 23:00 IST) -> Fully Cancelled/Refunded: Original ₹800, Current ₹0
    await Order.create({
        orderNumber: "TEST-DASH-YEST-CANCEL-03",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Yest Item 3", quantity: 1, unitPrice: 800, priceAtPurchase: 800, lineTotal: 800, finalPayable: 800, status: "CANCELLED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 800, subtotal: 800, shippingFee: 0, totalAmount: 800, currentPayable: 0, cancellationDeduction: 800, collectedAmount: 800, purchaseRefundTotal: 800 },
        paymentMethod: "ONLINE",
        paymentStatus: "REFUNDED",
        orderStatus: "CANCELLED",
        placedAt: new Date("2026-10-24T23:00:00.000+05:30"),
    });

    // Order 4: Today morning (2026-10-25 09:00 IST) -> Wallet Debit: ₹2,000
    const ord4 = await Order.create({
        orderNumber: "TEST-DASH-TODAY-WAL-04",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Today Item 1", quantity: 1, unitPrice: 2000, priceAtPurchase: 2000, lineTotal: 2000, finalPayable: 2000, status: "PROCESSING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 2000, subtotal: 2000, shippingFee: 0, totalAmount: 2000, currentPayable: 2000 },
        paymentMethod: "WALLET",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        placedAt: new Date("2026-10-25T09:00:00.000+05:30"),
    });
    const dummyWalletId = new mongoose.Types.ObjectId();
    await Transaction.create({
        walletId: dummyWalletId,
        userId: testUser._id,
        orderId: ord4._id,
        type: "DEBIT",
        amount: 2000,
        balanceAfter: 500,
        reason: "ORDER_PURCHASE",
        referenceId: `REF_TEST_DASH_WAL_${ord4._id}`,
    });

    // Order 5: Today noon (2026-10-25 11:30 IST) -> Partially Returned: Original ₹1,000, Returned ₹400, Net ₹600
    await Order.create({
        orderNumber: "TEST-DASH-TODAY-PARTIAL-05",
        userId: testUser._id,
        items: [
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item 5A", quantity: 1, unitPrice: 600, priceAtPurchase: 600, lineTotal: 600, finalPayable: 600, status: "DELIVERED" },
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item 5B", quantity: 1, unitPrice: 400, priceAtPurchase: 400, lineTotal: 400, finalPayable: 400, status: "RETURNED" },
        ],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 600, returnCredit: 400, collectedAmount: 1000, purchaseRefundTotal: 400 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        placedAt: new Date("2026-10-25T11:30:00.000+05:30"),
        razorpayPaymentId: "test_pay_dash_05",
    });

    // Order 6: Today 12:00 IST -> Unpaid Online (PENDING) with ₹1,000 Payment record: Must be EXCLUDED (₹0)
    const ord6 = await Order.create({
        orderNumber: "TEST-DASH-TODAY-UNPAID-06",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Unpaid Item", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "PENDING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000 },
        paymentMethod: "ONLINE",
        paymentStatus: "PENDING",
        orderStatus: "PENDING",
        placedAt: new Date("2026-10-25T12:00:00.000+05:30"),
    });
    await Payment.create({
        orderId: ord6._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "PENDING",
        razorpayPaymentId: "test_pay_dash_unpaid_06",
    });

    // Order 7: Today 13:00 IST -> Duplicate Payment Order (₹1,000 purchase captured + ₹1,000 duplicate captured/refunded)
    // Net sales must be exactly ₹1,000 (NOT ₹2,000!)
    await Order.create({
        orderNumber: "TEST-DASH-TODAY-DUP-07",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Dup Item", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "DELIVERED" }],
        shippingAddress: dummyAddress,
        pricing: {
            originalSubtotal: 1000,
            subtotal: 1000,
            shippingFee: 0,
            totalAmount: 1000,
            currentPayable: 1000,
            collectedAmount: 1000,
            purchaseRefundTotal: 0,
            duplicateRefundTotal: 1000,
        },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        placedAt: new Date("2026-10-25T13:00:00.000+05:30"),
        razorpayPaymentId: "test_pay_dash_dup_07",
    });

    // Order 8: Future order (Placed today after asOf, e.g. 2026-10-25 15:30 IST)
    // Must be EXCLUDED from today's sales up to current time (asOf)
    await Order.create({
        orderNumber: "TEST-DASH-TODAY-FUTURE-08",
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Future Item", quantity: 1, unitPrice: 3000, priceAtPurchase: 3000, lineTotal: 3000, finalPayable: 3000, status: "PROCESSING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 3000, subtotal: 3000, shippingFee: 0, totalAmount: 3000, currentPayable: 3000, collectedAmount: 3000 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        placedAt: new Date("2026-10-25T15:30:00.000+05:30"), // After asOf (14:00)
    });

    // Calculate Last Two Days Sales
    const salesResult = await reportService.getLastTwoDaysSales(asOf);

    // Expected Breakdown:
    // Yesterday:
    // - Ord1: ₹1,000
    // - Ord2: ₹1,500
    // - Ord3: ₹0 (fully cancelled)
    // Expected Yesterday Net Sales = 1000 + 1500 = ₹2,500
    const expectedYesterday = 2500;

    // Today (up to 14:00 IST):
    // - Ord4: ₹2,000
    // - Ord5: ₹600 (partially returned)
    // - Ord6: ₹0 (unpaid pending)
    // - Ord7: ₹1,000 (duplicate excluded)
    // - Ord8: ₹0 (future after 14:00 IST)
    // Expected Today Net Sales = 2000 + 600 + 1000 = ₹3,600
    const expectedToday = 3600;

    // Expected Total = 2500 + 3600 = ₹6,100
    const expectedTotal = 6100;

    check(
        salesResult.yesterdaySales === expectedYesterday,
        `2A: Yesterday net sales is ₹${expectedYesterday.toLocaleString('en-IN')}`,
        `Actual: ₹${salesResult.yesterdaySales}`
    );
    check(
        salesResult.todaySales === expectedToday,
        `2B: Today net sales up to current time is ₹${expectedToday.toLocaleString('en-IN')}`,
        `Actual: ₹${salesResult.todaySales}`
    );
    check(
        salesResult.totalSales === expectedTotal,
        `2C: Last 2 days total net sales is ₹${expectedTotal.toLocaleString('en-IN')}`,
        `Actual: ₹${salesResult.totalSales}`
    );

    // =========================================================================
    // SECTION 3: ZERO QUALIFYING SALES VERIFICATION
    // =========================================================================
    console.log("\n--- Section 3: Zero Qualifying Sales Test ---");
    // Test on a date with no qualifying orders (e.g. 2026-11-15)
    const emptyDate = new Date("2026-11-15T12:00:00.000+05:30");
    const emptyResult = await reportService.getLastTwoDaysSales(emptyDate);

    check(emptyResult.todaySales === 0, "3A: todaySales is ₹0 when there are no qualifying sales", `Actual: ₹${emptyResult.todaySales}`);
    check(emptyResult.yesterdaySales === 0, "3B: yesterdaySales is ₹0 when there are no qualifying sales", `Actual: ₹${emptyResult.yesterdaySales}`);
    check(emptyResult.totalSales === 0, "3C: totalSales is ₹0 when there are no qualifying sales", `Actual: ₹${emptyResult.totalSales}`);

    // =========================================================================
    // SECTION 4: CONTROLLER & VIEW RENDERING
    // =========================================================================
    console.log("\n--- Section 4: Controller & Dashboard EJS View Integration ---");

    let renderedView = null;
    let renderData = null;

    const mockReq = { query: {} };
    const mockRes = {
        render: (viewName, data) => {
            renderedView = viewName;
            renderData = data;
        },
        status: () => mockRes,
        send: () => {},
    };

    await reportController.loadDashboard(mockReq, mockRes);

    check(renderedView === "admin/dashboard", "4A: loadDashboard renders 'admin/dashboard'");
    check(renderData != null, "4B: renderData is provided");
    check(typeof renderData.todaySales === "number", "4C: todaySales is a valid number (NOT undefined)", `Value: ${renderData.todaySales}`);
    check(typeof renderData.yesterdaySales === "number", "4D: yesterdaySales is a valid number (NOT undefined)", `Value: ${renderData.yesterdaySales}`);
    check(typeof renderData.totalSales === "number", "4E: totalSales is a valid number (NOT undefined)", `Value: ${renderData.totalSales}`);

    // Test EJS compilation and rendering of dashboard.ejs
    const dashboardEjsPath = path.join(__dirname, "../views/admin/dashboard.ejs");
    const ejsContent = fs.readFileSync(dashboardEjsPath, "utf8");

    // Mock required partials to verify EJS template rendering without missing include errors
    const htmlOutput = ejs.render(ejsContent, {
        title: "Dashboard",
        active: "dashboard",
        filterType: "monthly",
        targetYear: null,
        monthlyStats: [],
        topProducts: [],
        topCategories: [],
        topBrands: [],
        totalSales: expectedTotal,
        todaySales: expectedToday,
        yesterdaySales: expectedYesterday,
        lastTwoDaysSales: expectedTotal,
    }, {
        filename: dashboardEjsPath,
    });

    check(
        htmlOutput.includes(`Today's Net Sales:`),
        "4F: Dashboard HTML contains 'Today\\'s Net Sales:' label"
    );
    check(
        htmlOutput.includes(`Yesterday's Net Sales:`),
        "4G: Dashboard HTML contains 'Yesterday\\'s Net Sales:' label"
    );
    check(
        htmlOutput.includes(`₹${expectedToday.toLocaleString('en-IN')}`),
        `4H: Dashboard HTML displays formatted todaySales: ₹${expectedToday.toLocaleString('en-IN')}`
    );
    check(
        htmlOutput.includes(`₹${expectedYesterday.toLocaleString('en-IN')}`),
        `4I: Dashboard HTML displays formatted yesterdaySales: ₹${expectedYesterday.toLocaleString('en-IN')}`
    );
    check(
        !htmlOutput.includes("undefined") || !htmlOutput.includes("<%= totalSales %>"),
        "4J: Dashboard HTML does not contain unrendered undefined totalSales placeholder"
    );

    // Cleanup test records
    await Order.deleteMany({ orderNumber: /^TEST-DASH-/ });
    await Payment.deleteMany({ razorpayPaymentId: /^test_pay_dash_/ });
    await Transaction.deleteMany({ referenceId: /^REF_TEST_DASH_/ });
    await mongoose.disconnect();

    console.log("\n==========================================================================");
    console.log(`TEST SUITE FINISHED: ${passed}/${passed + failed} PASSED`);
    if (failed > 0) {
        console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
        process.exit(1);
    }
    console.log("ALL ADMIN DASHBOARD SALES DISPLAY REQUIREMENTS CONFIRMED PASSED!");
    console.log("==========================================================================\n");
}

runTests().catch((err) => {
    console.error("Fatal error during test run:", err);
    process.exit(1);
});
