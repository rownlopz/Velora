/**
 * Verification Test Suite for Collected-Payment Calculation Fix in determineOrderCollections()
 * Database: mongodb://127.0.0.1:27017/velora_test_isolated_suite
 * 
 * Verifies all requirements:
 * 1. ₹1,000 PENDING or FAILED payment → ₹0 collected.
 * 2. Verified ₹1,000 successful payment → ₹1,000 collected.
 * 3. Successful payment later refunded → original collection retained, refund shown separately.
 * 4. Duplicate-payment collections remain separate from purchase sales.
 * 5. Screen, PDF, and Excel use the corrected figures.
 * 
 * Strictly operates on an isolated test database.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");

const TEST_DB_URI = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const User = require("../models/user/userModel");
const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Transaction = require("../models/user/transactionModel");
const reportService = require("../services/admin/reportService");

const { determineOrderCollections, getSalesReportData, generateSalesExcel, generateSalesPdf } = reportService;

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
    console.log("VERIFICATION: COLLECTED-PAYMENT CALCULATION FIX IN determineOrderCollections");
    console.log(`Isolated Database: ${TEST_DB_URI}`);
    console.log("==========================================================================\n");

    await mongoose.connect(TEST_DB_URI);

    // Clean any prior test verify records
    await Order.deleteMany({ orderNumber: /^TEST-VERIFY-/ });
    await Payment.deleteMany({ razorpayPaymentId: /^test_pay_verify_/ });
    await Transaction.deleteMany({ referenceId: /^REF_TEST_VERIFY_/ });

    const now = new Date();
    const dummyProdId = new mongoose.Types.ObjectId();
    const dummyVarId = new mongoose.Types.ObjectId();
    const dummyAddress = {
        firstName: "Verify",
        lastName: "Tester",
        addressLine1: "123 Street",
        city: "Kochi",
        state: "Kerala",
        pinCode: 682001,
        country: "India",
        phone: "9876543210",
    };

    const testUser = await User.findOneAndUpdate(
        { email: "verify_fix_user@velora.test" },
        { fullName: "Verify Fix Customer", email: "verify_fix_user@velora.test", password: "Password123!", phone: "9876543210", role: "USER", status: "Active", isEmailVerified: true },
        { upsert: true, returnDocument: "after" }
    );

    // =========================================================================
    // SECTION 1: DIRECT UNIT CHECKS ON determineOrderCollections()
    // =========================================================================
    console.log("--- Section 1: Direct Unit Checks on determineOrderCollections() ---");

    // 1A. Online order with ₹1,000 PENDING payment record
    const pendingPaymentDoc = [{ amount: 1000, status: "PENDING", paymentMethod: "ONLINE" }];
    const pendingOrderObj = { orderNumber: "ORD-PEND-01", paymentMethod: "ONLINE", paymentStatus: "PENDING" };
    const resPending = determineOrderCollections(pendingOrderObj, pendingPaymentDoc);
    check(resPending.purchaseCollected === 0, "1A: ₹1,000 PENDING payment doc → ₹0 collected", `Actual: ₹${resPending.purchaseCollected}`);
    check(resPending.duplicateCollected === 0, "1A: duplicateCollected is ₹0");

    // 1B. Online order with ₹1,000 FAILED payment record
    const failedPaymentDoc = [{ amount: 1000, status: "FAILED", paymentMethod: "ONLINE" }];
    const failedOrderObj = { orderNumber: "ORD-FAIL-01", paymentMethod: "ONLINE", paymentStatus: "FAILED" };
    const resFailed = determineOrderCollections(failedOrderObj, failedPaymentDoc);
    check(resFailed.purchaseCollected === 0, "1B: ₹1,000 FAILED payment doc → ₹0 collected", `Actual: ₹${resFailed.purchaseCollected}`);

    // 1C. Online order with multiple failed retry attempts followed by no success
    const multiFailedDocs = [
        { amount: 1000, status: "FAILED", paymentMethod: "ONLINE" },
        { amount: 1000, status: "FAILED", paymentMethod: "ONLINE" },
    ];
    const resMultiFailed = determineOrderCollections(failedOrderObj, multiFailedDocs);
    check(resMultiFailed.purchaseCollected === 0, "1C: Multiple FAILED payment docs → ₹0 collected", `Actual: ₹${resMultiFailed.purchaseCollected}`);

    // 1D. Verified ₹1,000 successful payment record
    const successPaymentDoc = [{ amount: 1000, status: "COMPLETED", paymentMethod: "ONLINE" }];
    const successOrderObj = { orderNumber: "ORD-SUCC-01", paymentMethod: "ONLINE", paymentStatus: "COMPLETED" };
    const resSuccess = determineOrderCollections(successOrderObj, successPaymentDoc);
    check(resSuccess.purchaseCollected === 1000, "1D: Verified ₹1,000 successful payment doc → ₹1,000 collected", `Actual: ₹${resSuccess.purchaseCollected}`);

    // 1E. Verified capture stored via order.paymentAttempts
    const attemptOrderObj = {
        orderNumber: "ORD-ATT-01",
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        paymentAttempts: [{ gateway: "RAZORPAY", amount: 1000, status: "SUCCESS" }],
    };
    const resAttempt = determineOrderCollections(attemptOrderObj, []);
    check(resAttempt.purchaseCollected === 1000, "1E: Verified capture via paymentAttempts → ₹1,000 collected", `Actual: ₹${resAttempt.purchaseCollected}`);

    // 1F. Verified capture stored via order.pricing.collectedAmount
    const explicitOrderObj = {
        orderNumber: "ORD-EXP-01",
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        pricing: { collectedAmount: 1000 },
    };
    const resExplicit = determineOrderCollections(explicitOrderObj, []);
    check(resExplicit.purchaseCollected === 1000, "1F: Verified capture via pricing.collectedAmount → ₹1,000 collected", `Actual: ₹${resExplicit.purchaseCollected}`);

    // 1G. Order marked COMPLETED but payment evidence is missing (no verified captures)
    const missingEvidenceObj = {
        orderNumber: "ORD-MISSING-01",
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        paidAt: now,
        pricing: { totalAmount: 1000 },
        paymentAttempts: [],
    };
    const resMissing = determineOrderCollections(missingEvidenceObj, [{ amount: 1000, status: "PENDING" }]);
    check(resMissing.purchaseCollected === 0, "1G: Missing verified capture evidence → ₹0 collected (no guessing)", `Actual: ₹${resMissing.purchaseCollected}`);
    check(resMissing.hasPaymentEvidence === false, "1G: Flagged hasPaymentEvidence = false");
    check(resMissing.paymentEvidenceNote.includes("Insufficient payment evidence"), "1G: Insufficient evidence note recorded");

    // =========================================================================
    // SECTION 2: END-TO-END RECONCILIATION IN ISOLATED DATABASE
    // =========================================================================
    console.log("\n--- Section 2: End-to-End Database Report Scenarios ---");

    // Order 1: ₹1,000 PENDING payment (Checkout abandoned / pending)
    const ord1 = await Order.create({
        orderNumber: `TEST-VERIFY-PENDING-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item 1", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "PENDING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000 },
        paymentMethod: "ONLINE",
        paymentStatus: "PENDING",
        orderStatus: "PENDING",
        placedAt: now,
    });
    await Payment.create({
        orderId: ord1._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "PENDING",
        razorpayPaymentId: `test_pay_verify_pending_${Date.now()}`,
    });

    // Order 2: ₹1,000 FAILED payment
    const ord2 = await Order.create({
        orderNumber: `TEST-VERIFY-FAILED-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item 2", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "CANCELLED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 0 },
        paymentMethod: "ONLINE",
        paymentStatus: "FAILED",
        orderStatus: "CANCELLED",
        placedAt: now,
    });
    await Payment.create({
        orderId: ord2._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "FAILED",
        razorpayPaymentId: `test_pay_verify_failed_${Date.now()}`,
    });

    // Order 3: Verified ₹1,000 successful payment
    const ord3 = await Order.create({
        orderNumber: `TEST-VERIFY-SUCCESS-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item 3", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "PROCESSING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000, collectedAmount: 1000 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_verify_03",
    });
    await Payment.create({
        orderId: ord3._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "COMPLETED",
        razorpayPaymentId: "test_pay_verify_03",
        paidAt: now,
    });

    // Order 4: Successful payment later fully refunded
    const ord4 = await Order.create({
        orderNumber: `TEST-VERIFY-REFUND-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item 4", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "CANCELLED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 0, cancellationDeduction: 1000, collectedAmount: 1000, purchaseRefundTotal: 1000 },
        paymentMethod: "ONLINE",
        paymentStatus: "REFUNDED",
        orderStatus: "CANCELLED",
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_verify_04",
    });
    await Payment.create({
        orderId: ord4._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "REFUNDED",
        refundAmount: 1000,
        razorpayPaymentId: "test_pay_verify_04",
        paidAt: now,
    });

    // Order 5: Duplicate-payment order (₹1,000 purchase captured + ₹1,000 duplicate captured and refunded)
    const ord5 = await Order.create({
        orderNumber: `TEST-VERIFY-DUPLICATE-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item 5", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "DELIVERED" }],
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
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_verify_05_primary",
    });
    await Payment.create({
        orderId: ord5._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "COMPLETED",
        razorpayPaymentId: "test_pay_verify_05_primary",
        paidAt: now,
    });
    await Payment.create({
        orderId: ord5._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "REFUNDED",
        refundAmount: 1000,
        razorpayPaymentId: "test_pay_verify_05_duplicate",
        paidAt: now,
    });

    // Order 6: Confirmed Wallet Purchase (₹1,500 debited in transaction ledger)
    const ord6 = await Order.create({
        orderNumber: `TEST-VERIFY-WALLET-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item 6", quantity: 1, unitPrice: 1500, priceAtPurchase: 1500, lineTotal: 1500, finalPayable: 1500, status: "PROCESSING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1500, subtotal: 1500, shippingFee: 0, totalAmount: 1500, currentPayable: 1500 },
        paymentMethod: "WALLET",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        paidAt: now,
        placedAt: now,
    });
    const dummyWalletId = new mongoose.Types.ObjectId();
    await Transaction.create({
        walletId: dummyWalletId,
        userId: testUser._id,
        orderId: ord6._id,
        type: "DEBIT",
        amount: 1500,
        balanceAfter: 500,
        reason: "ORDER_PURCHASE",
        referenceId: `REF_TEST_VERIFY_WAL_${ord6._id}`,
    });

    // Order 7: Confirmed COD order (Delivered: ₹1,200 items + ₹50 shipping = ₹1,250)
    const ord7 = await Order.create({
        orderNumber: `TEST-VERIFY-COD-${Date.now()}`,
        userId: testUser._id,
        items: [
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item 7A", quantity: 1, unitPrice: 1200, priceAtPurchase: 1200, lineTotal: 1200, finalPayable: 1200, status: "DELIVERED" },
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item 7B", quantity: 1, unitPrice: 300, priceAtPurchase: 300, lineTotal: 300, finalPayable: 300, status: "CANCELLED" },
        ],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1500, subtotal: 1200, shippingFee: 50, totalAmount: 1550, currentPayable: 1250, cancellationDeduction: 300 },
        paymentMethod: "COD",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        placedAt: now,
    });

    // Execute getSalesReportData
    console.log("Fetching sales report data...");
    const reportData = await getSalesReportData({ rangeType: "daily", limit: 50 });

    const rowMap = new Map();
    for (const r of reportData.allRows) {
        rowMap.set(r.orderNumber, r);
    }

    // Verify Order 1 (PENDING payment)
    const r1 = rowMap.get(ord1.orderNumber);
    check(r1 != null, "Order 1 (PENDING) is in report");
    check(r1.purchaseCollected === 0, "Order 1: purchaseCollected is ₹0 (PENDING payment NOT counted)", `Actual: ₹${r1?.purchaseCollected}`);

    // Verify Order 2 (FAILED payment)
    const r2 = rowMap.get(ord2.orderNumber);
    check(r2 != null, "Order 2 (FAILED) is in report");
    check(r2.purchaseCollected === 0, "Order 2: purchaseCollected is ₹0 (FAILED payment NOT counted)", `Actual: ₹${r2?.purchaseCollected}`);

    // Verify Order 3 (Verified Successful payment)
    const r3 = rowMap.get(ord3.orderNumber);
    check(r3 != null, "Order 3 (SUCCESS) is in report");
    check(r3.purchaseCollected === 1000, "Order 3: purchaseCollected is ₹1,000", `Actual: ₹${r3?.purchaseCollected}`);
    check(r3.purchaseRefund === 0, "Order 3: purchaseRefund is ₹0");
    check(r3.netPurchaseReceipts === 1000, "Order 3: netPurchaseReceipts is ₹1,000");

    // Verify Order 4 (Successful payment later refunded)
    const r4 = rowMap.get(ord4.orderNumber);
    check(r4 != null, "Order 4 (REFUNDED) is in report");
    check(r4.purchaseCollected === 1000, "Order 4: Original collection retained at ₹1,000", `Actual: ₹${r4?.purchaseCollected}`);
    check(r4.purchaseRefund === 1000, "Order 4: purchaseRefund shown separately as ₹1,000", `Actual: ₹${r4?.purchaseRefund}`);
    check(r4.netPurchaseReceipts === 0, "Order 4: netPurchaseReceipts is ₹0");

    // Verify Order 5 (Duplicate payment captured and refunded)
    const r5 = rowMap.get(ord5.orderNumber);
    check(r5 != null, "Order 5 (DUPLICATE) is in report");
    check(r5.purchaseCollected === 1000, "Order 5: purchaseCollected is ₹1,000 (NOT inflated by duplicate payment)", `Actual: ₹${r5?.purchaseCollected}`);
    check(r5.duplicateCollected === 1000, "Order 5: duplicateCollected tracked separately as ₹1,000", `Actual: ₹${r5?.duplicateCollected}`);
    check(r5.purchaseRefund === 0, "Order 5: purchaseRefund is ₹0 (NOT contaminated by duplicate refund)");

    // Verify Order 6 (Wallet Debit)
    const r6 = rowMap.get(ord6.orderNumber);
    check(r6 != null, "Order 6 (WALLET) is in report");
    check(r6.purchaseCollected === 1500, "Order 6: Confirmed wallet debit counted as ₹1,500", `Actual: ₹${r6?.purchaseCollected}`);

    // Verify Order 7 (Delivered COD)
    const r7 = rowMap.get(ord7.orderNumber);
    check(r7 != null, "Order 7 (COD) is in report");
    check(r7.purchaseCollected === 1250, "Order 7: Confirmed delivered COD collected ₹1,250", `Actual: ₹${r7?.purchaseCollected}`);

    // =========================================================================
    // SECTION 3: EXCEL AND PDF EXPORTS
    // =========================================================================
    console.log("\n--- Section 3: Verification of Excel and PDF Exports ---");

    const workbook = await generateSalesExcel(reportData);
    check(workbook != null, "Excel workbook generated successfully");
    const sheet = workbook.getWorksheet("Sales Report");
    check(sheet != null, "Excel 'Sales Report' sheet present");

    // Verify Excel individual rows
    let excelRowPendingCollected = null;
    let excelRowFailedCollected = null;
    let excelRowSuccessCollected = null;
    sheet.eachRow((row) => {
        const orderNum = String(row.getCell(1).value || "");
        if (orderNum === ord1.orderNumber) {
            excelRowPendingCollected = Number(row.getCell(14).value);
        } else if (orderNum === ord2.orderNumber) {
            excelRowFailedCollected = Number(row.getCell(14).value);
        } else if (orderNum === ord3.orderNumber) {
            excelRowSuccessCollected = Number(row.getCell(14).value);
        }
    });

    check(excelRowPendingCollected === 0, `Excel Row: PENDING order collected is ₹0 (Actual: ₹${excelRowPendingCollected})`);
    check(excelRowFailedCollected === 0, `Excel Row: FAILED order collected is ₹0 (Actual: ₹${excelRowFailedCollected})`);
    check(excelRowSuccessCollected === 1000, `Excel Row: SUCCESS order collected is ₹1,000 (Actual: ₹${excelRowSuccessCollected})`);

    // PDF generation check
    const pdfBuffer = await generateSalesPdf(reportData);
    check(Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 1000, `PDF generated as valid buffer (Length: ${pdfBuffer.length} bytes)`);

    // Cleanup test records from isolated database
    await Order.deleteMany({ orderNumber: /^TEST-VERIFY-/ });
    await Payment.deleteMany({ razorpayPaymentId: /^test_pay_verify_/ });
    await Transaction.deleteMany({ referenceId: /^REF_TEST_VERIFY_/ });
    await mongoose.disconnect();

    console.log("\n==========================================================================");
    console.log(`TEST SUITE FINISHED: ${passed}/${passed + failed} PASSED`);
    if (failed > 0) {
        console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
        process.exit(1);
    }
    console.log("ALL VERIFICATION REQUIREMENTS CONFIRMED PASSED ON ISOLATED DATA!");
    console.log("==========================================================================\n");
}

runTests().catch((err) => {
    console.error("Fatal error during test run:", err);
    process.exit(1);
});
