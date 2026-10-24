const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const Order = require("../models/order/orderModel");
const Payment = require("../models/order/paymentModel");
const Transaction = require("../models/user/transactionModel");
const User = require("../models/user/userModel");
const reportService = require("../services/admin/reportService");

const ISOLATED_TEST_DB = "mongodb://127.0.0.1:27017/velora_test_isolated_suite";

const run = async () => {
    console.log("==========================================================================");
    console.log("RUNNING ISOLATED DATABASE TESTS FOR BUG #10: SALES REPORT COLLECTIONS");
    console.log(`Database: ${ISOLATED_TEST_DB}`);
    console.log("==========================================================================\n");

    await mongoose.connect(ISOLATED_TEST_DB);

    let passed = 0;
    let failed = 0;
    const failures = [];

    const assert = (condition, desc, details = "") => {
        if (condition) {
            passed++;
            console.log(`  [PASS] ${desc}`);
        } else {
            failed++;
            console.error(`  [FAIL] ${desc} ${details ? "- " + details : ""}`);
            failures.push(`${desc} ${details}`);
        }
    };

    // Clean test collections before running
    await Order.deleteMany({ orderNumber: /^TEST-BUG10-/ });
    await Payment.deleteMany({ razorpayPaymentId: /^test_pay_bug10_/ });
    await Transaction.deleteMany({ referenceId: /^TEST_REF_BUG10_/ });

    const testUser = await User.findOneAndUpdate(
        { email: "bug10_test@example.com" },
        { fullName: "Bug10 Test User", email: "bug10_test@example.com", password: "Password123!" },
        { upsert: true, returnDocument: "after" }
    );

    const now = new Date();
    const dummyProdId = new mongoose.Types.ObjectId();
    const dummyVarId = new mongoose.Types.ObjectId();
    const dummyAddress = { firstName: "Bug10", lastName: "Tester", addressLine1: "123 Street", city: "Kochi", state: "Kerala", pinCode: "682001", country: "India", phone: "9876543210" };

    // -------------------------------------------------------------------------
    // Case A: ₹1,000 collected, no refund
    // Expected: collected 1000, purchase refunds 0, net purchase receipts 1000.
    // -------------------------------------------------------------------------
    console.log("Running Case A: ₹1,000 collected, no refund...");
    const orderA = await Order.create({
        orderNumber: `TEST-BUG10-A-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item A", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "DELIVERED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 1000, collectedAmount: 1000, purchaseRefundTotal: 0 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_bug10_A",
    });
    await Payment.create({
        orderId: orderA._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "COMPLETED",
        razorpayPaymentId: "test_pay_bug10_A",
        paidAt: now,
    });

    // -------------------------------------------------------------------------
    // Case B: ₹1,000 collected, ₹400 purchase refund
    // Expected: collected 1000, purchase refunds 400, net purchase receipts 600.
    // (Notice: currentPayable is 600, but collected is 1000, NOT 600!)
    // -------------------------------------------------------------------------
    console.log("Running Case B: ₹1,000 collected, ₹400 purchase refund...");
    const orderB = await Order.create({
        orderNumber: `TEST-BUG10-B-${Date.now()}`,
        userId: testUser._id,
        items: [
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item B1", quantity: 1, unitPrice: 600, priceAtPurchase: 600, lineTotal: 600, finalPayable: 600, status: "DELIVERED" },
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item B2", quantity: 1, unitPrice: 400, priceAtPurchase: 400, lineTotal: 400, finalPayable: 400, status: "RETURNED" },
        ],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 600, returnCredit: 400, collectedAmount: 1000, purchaseRefundTotal: 400 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_bug10_B",
    });
    await Payment.create({
        orderId: orderB._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "COMPLETED",
        refundAmount: 400,
        razorpayPaymentId: "test_pay_bug10_B",
        paidAt: now,
    });

    // -------------------------------------------------------------------------
    // Case C: ₹1,000 collected, fully refunded
    // Expected: collected 1000, purchase refunds 1000, net purchase receipts 0.
    // (Notice: currentPayable is 0, but collected is 1000, NOT 0!)
    // -------------------------------------------------------------------------
    console.log("Running Case C: ₹1,000 collected, fully refunded...");
    const orderC = await Order.create({
        orderNumber: `TEST-BUG10-C-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item C", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "CANCELLED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 0, cancellationDeduction: 1000, collectedAmount: 1000, purchaseRefundTotal: 1000 },
        paymentMethod: "ONLINE",
        paymentStatus: "REFUNDED",
        orderStatus: "CANCELLED",
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_bug10_C",
    });
    await Payment.create({
        orderId: orderC._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "REFUNDED",
        refundAmount: 1000,
        razorpayPaymentId: "test_pay_bug10_C",
        paidAt: now,
    });

    // -------------------------------------------------------------------------
    // Case D: Cancel ₹400 before payment and collect only ₹600
    // Expected: collected 600, purchase refunds 0, net purchase receipts 600.
    // (Do not report original 1000 as collected!)
    // -------------------------------------------------------------------------
    console.log("Running Case D: Cancel ₹400 before payment and collect only ₹600...");
    const orderD = await Order.create({
        orderNumber: `TEST-BUG10-D-${Date.now()}`,
        userId: testUser._id,
        items: [
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item D1", quantity: 1, unitPrice: 600, priceAtPurchase: 600, lineTotal: 600, finalPayable: 600, status: "PROCESSING" },
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item D2", quantity: 1, unitPrice: 400, priceAtPurchase: 400, lineTotal: 400, finalPayable: 400, status: "CANCELLED", cancelledBeforePayment: true },
        ],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1000, subtotal: 1000, shippingFee: 0, totalAmount: 1000, currentPayable: 600, cancellationDeduction: 400, collectedAmount: 600, purchaseRefundTotal: 0 },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "PROCESSING",
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_bug10_D",
    });
    await Payment.create({
        orderId: orderD._id,
        userId: testUser._id,
        amount: 600,
        paymentMethod: "ONLINE",
        status: "COMPLETED",
        razorpayPaymentId: "test_pay_bug10_D",
        paidAt: now,
    });

    // -------------------------------------------------------------------------
    // Case E: Unpaid online order
    // Expected: collected 0.
    // -------------------------------------------------------------------------
    console.log("Running Case E: Unpaid online order...");
    const orderE = await Order.create({
        orderNumber: `TEST-BUG10-E-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item E", quantity: 1, unitPrice: 800, priceAtPurchase: 800, lineTotal: 800, finalPayable: 800, status: "PENDING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 800, subtotal: 800, shippingFee: 0, totalAmount: 800, currentPayable: 800 },
        paymentMethod: "ONLINE",
        paymentStatus: "PENDING",
        orderStatus: "PENDING",
        placedAt: now,
    });

    // -------------------------------------------------------------------------
    // Case F: Unpaid COD order
    // Expected: collected 0; eligible pending COD shown separately.
    // -------------------------------------------------------------------------
    console.log("Running Case F: Unpaid COD order...");
    const orderF = await Order.create({
        orderNumber: `TEST-BUG10-F-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item F", quantity: 1, unitPrice: 750, priceAtPurchase: 750, lineTotal: 750, finalPayable: 750, status: "PROCESSING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 750, subtotal: 750, shippingFee: 0, totalAmount: 750, currentPayable: 750 },
        paymentMethod: "COD",
        paymentStatus: "PENDING",
        orderStatus: "PROCESSING",
        placedAt: now,
    });

    // -------------------------------------------------------------------------
    // Case G: Confirmed collected COD
    // Expected: amount recorded exactly once.
    // -------------------------------------------------------------------------
    console.log("Running Case G: Confirmed collected COD...");
    const orderG = await Order.create({
        orderNumber: `TEST-BUG10-G-${Date.now()}`,
        userId: testUser._id,
        items: [
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item G1", quantity: 1, unitPrice: 1200, priceAtPurchase: 1200, lineTotal: 1200, finalPayable: 1200, status: "DELIVERED" },
            { productId: dummyProdId, variantId: dummyVarId, productName: "Item G2", quantity: 1, unitPrice: 300, priceAtPurchase: 300, lineTotal: 300, finalPayable: 300, status: "CANCELLED" },
        ],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1500, subtotal: 1200, shippingFee: 50, totalAmount: 1550, currentPayable: 1250, cancellationDeduction: 300 },
        paymentMethod: "COD",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        placedAt: now,
    });

    // -------------------------------------------------------------------------
    // Case H: Successful WALLET order & failed/rolled-back checkout
    // Expected: confirmed debit counted once; failed/rolled-back checkout handled correctly.
    // -------------------------------------------------------------------------
    console.log("Running Case H: Successful WALLET order & rollback handling...");
    const orderH1 = await Order.create({
        orderNumber: `TEST-BUG10-H1-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item H1", quantity: 1, unitPrice: 1100, priceAtPurchase: 1100, lineTotal: 1100, finalPayable: 1100, status: "PROCESSING" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 1100, subtotal: 1100, shippingFee: 0, totalAmount: 1100, currentPayable: 1100 },
        paymentMethod: "WALLET",
        paymentStatus: "COMPLETED",
        orderStatus: "PLACED",
        paidAt: now,
        placedAt: now,
    });
    const dummyWalletId = new mongoose.Types.ObjectId();
    await Transaction.create({
        walletId: dummyWalletId,
        userId: testUser._id,
        orderId: orderH1._id,
        type: "DEBIT",
        amount: 1100,
        balanceAfter: 900,
        reason: "ORDER_PURCHASE",
        description: "Payment for order",
        referenceId: `TEST_REF_BUG10_WAL_${orderH1._id}`,
    });

    // Subcase H2: Rolled-back wallet order
    const orderH2 = await Order.create({
        orderNumber: `TEST-BUG10-H2-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item H2", quantity: 1, unitPrice: 500, priceAtPurchase: 500, lineTotal: 500, finalPayable: 500, status: "CANCELLED" }],
        shippingAddress: dummyAddress,
        pricing: { originalSubtotal: 500, subtotal: 500, shippingFee: 0, totalAmount: 500, currentPayable: 0, cancellationDeduction: 500 },
        paymentMethod: "WALLET",
        paymentStatus: "FAILED",
        orderStatus: "CANCELLED",
        placedAt: now,
    });
    await Transaction.create({
        walletId: dummyWalletId,
        userId: testUser._id,
        orderId: orderH2._id,
        type: "DEBIT",
        amount: 500,
        balanceAfter: 500,
        reason: "ORDER_PURCHASE",
        referenceId: `TEST_REF_BUG10_WAL_${orderH2._id}`,
    });
    await Transaction.create({
        walletId: dummyWalletId,
        userId: testUser._id,
        orderId: orderH2._id,
        type: "CREDIT",
        amount: 500,
        balanceAfter: 1000,
        reason: "ORDER_PURCHASE_ROLLBACK",
        referenceId: `TEST_REF_BUG10_ROLLBACK_${orderH2._id}`,
    });

    // -------------------------------------------------------------------------
    // Case I: Additional payment collected and refunded
    // Expected: no inflated purchase sales and no contamination of purchase refunds.
    // -------------------------------------------------------------------------
    console.log("Running Case I: Additional payment collected and refunded...");
    const orderI = await Order.create({
        orderNumber: `TEST-BUG10-I-${Date.now()}`,
        userId: testUser._id,
        items: [{ productId: dummyProdId, variantId: dummyVarId, productName: "Item I", quantity: 1, unitPrice: 1000, priceAtPurchase: 1000, lineTotal: 1000, finalPayable: 1000, status: "DELIVERED" }],
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
            walletRefundIssued: 1000,
        },
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        orderStatus: "DELIVERED",
        paidAt: now,
        placedAt: now,
        razorpayPaymentId: "test_pay_bug10_I_primary",
        paymentAttempts: [
            {
                gateway: "RAZORPAY",
                attemptId: "att_primary",
                razorpayPaymentId: "test_pay_bug10_I_primary",
                amount: 1000,
                status: "SUCCESS",
            },
            {
                gateway: "RAZORPAY",
                attemptId: "att_dup",
                razorpayPaymentId: "test_pay_bug10_I_dup",
                amount: 1000,
                status: "REFUNDED_DUPLICATE",
            },
        ],
    });
    await Payment.create({
        orderId: orderI._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "COMPLETED",
        razorpayPaymentId: "test_pay_bug10_I_primary",
        paidAt: now,
    });
    await Payment.create({
        orderId: orderI._id,
        userId: testUser._id,
        amount: 1000,
        paymentMethod: "ONLINE",
        status: "REFUNDED",
        refundAmount: 1000,
        razorpayPaymentId: "test_pay_bug10_I_dup",
        paidAt: now,
    });

    // -------------------------------------------------------------------------
    // Execution: Fetch Sales Report Data for Daily Range
    // -------------------------------------------------------------------------
    console.log("\nExecuting getSalesReportData for daily range...");
    const reportData = await reportService.getSalesReportData({ rangeType: "daily", limit: 50 });

    const rowMap = new Map();
    for (const r of reportData.allRows) {
        rowMap.set(r.orderNumber, r);
    }

    // Verify Case A
    const rowA = rowMap.get(orderA.orderNumber);
    assert(rowA != null, "Case A row is included in report");
    assert(rowA.purchaseCollected === 1000, `Case A: purchaseCollected is ₹1,000 (Actual: ₹${rowA?.purchaseCollected})`);
    assert(rowA.purchaseRefund === 0, `Case A: purchaseRefund is ₹0 (Actual: ₹${rowA?.purchaseRefund})`);
    assert(rowA.netPurchaseReceipts === 1000, `Case A: netPurchaseReceipts is ₹1,000 (Actual: ₹${rowA?.netPurchaseReceipts})`);

    // Verify Case B
    const rowB = rowMap.get(orderB.orderNumber);
    assert(rowB != null, "Case B row is included in report");
    assert(rowB.purchaseCollected === 1000, `Case B: purchaseCollected is ₹1,000, NOT currentPayable ₹600 (Actual: ₹${rowB?.purchaseCollected})`);
    assert(rowB.purchaseRefund === 400, `Case B: purchaseRefund is ₹400 (Actual: ₹${rowB?.purchaseRefund})`);
    assert(rowB.netPurchaseReceipts === 600, `Case B: netPurchaseReceipts is ₹600 (Actual: ₹${rowB?.netPurchaseReceipts})`);

    // Verify Case C
    const rowC = rowMap.get(orderC.orderNumber);
    assert(rowC != null, "Case C row is included in report");
    assert(rowC.purchaseCollected === 1000, `Case C: Fully refunded purchase retains historical collected ₹1,000, NOT currentPayable ₹0 (Actual: ₹${rowC?.purchaseCollected})`);
    assert(rowC.purchaseRefund === 1000, `Case C: purchaseRefund is ₹1,000 (Actual: ₹${rowC?.purchaseRefund})`);
    assert(rowC.netPurchaseReceipts === 0, `Case C: netPurchaseReceipts is ₹0 (Actual: ₹${rowC?.netPurchaseReceipts})`);

    // Verify Case D
    const rowD = rowMap.get(orderD.orderNumber);
    assert(rowD != null, "Case D row is included in report");
    assert(rowD.purchaseCollected === 600, `Case D: purchaseCollected is ₹600, NOT original ₹1,000 (Actual: ₹${rowD?.purchaseCollected})`);
    assert(rowD.purchaseRefund === 0, `Case D: Pre-payment cancellation produces ₹0 purchase refund (Actual: ₹${rowD?.purchaseRefund})`);
    assert(rowD.netPurchaseReceipts === 600, `Case D: netPurchaseReceipts is ₹600 (Actual: ₹${rowD?.netPurchaseReceipts})`);

    // Verify Case E
    const rowE = rowMap.get(orderE.orderNumber);
    assert(rowE != null, "Case E row is included in report");
    assert(rowE.purchaseCollected === 0, `Case E: Unpaid online order has collected ₹0 (Actual: ₹${rowE?.purchaseCollected})`);
    assert(rowE.isCollected === false, "Case E: isCollected is false");

    // Verify Case F
    const rowF = rowMap.get(orderF.orderNumber);
    assert(rowF != null, "Case F row is included in report");
    assert(rowF.purchaseCollected === 0, `Case F: Unpaid COD order has collected ₹0 (Actual: ₹${rowF?.purchaseCollected})`);
    assert(rowF.pendingCod === 750, `Case F: Pending COD tracks ₹750 payable separately (Actual: ₹${rowF?.pendingCod})`);

    // Verify Case G
    const rowG = rowMap.get(orderG.orderNumber);
    assert(rowG != null, "Case G row is included in report");
    assert(rowG.purchaseCollected === 1250, `Case G: Confirmed COD collects delivered items + shipping = ₹1,250 (Actual: ₹${rowG?.purchaseCollected})`);
    assert(rowG.pendingCod === 0, `Case G: Delivered COD has pendingCod ₹0 (Actual: ₹${rowG?.pendingCod})`);

    // Verify Case H
    const rowH1 = rowMap.get(orderH1.orderNumber);
    assert(rowH1 != null, "Case H1 row is included in report");
    assert(rowH1.purchaseCollected === 1100, `Case H1: Confirmed wallet debit counted once = ₹1,100 (Actual: ₹${rowH1?.purchaseCollected})`);

    const rowH2 = rowMap.get(orderH2.orderNumber);
    assert(rowH2 != null, "Case H2 row is included in report");
    assert(rowH2.purchaseCollected === 0, `Case H2: Rolled-back wallet checkout has collected ₹0 (Actual: ₹${rowH2?.purchaseCollected})`);

    // Verify Case I
    const rowI = rowMap.get(orderI.orderNumber);
    assert(rowI != null, "Case I row is included in report");
    assert(rowI.purchaseCollected === 1000, `Case I: purchaseCollected is ₹1,000 (NOT inflated to ₹2,000 by duplicate payment) (Actual: ₹${rowI?.purchaseCollected})`);
    assert(rowI.purchaseRefund === 0, `Case I: purchaseRefund is ₹0 (NOT contaminated by ₹1,000 duplicate refund) (Actual: ₹${rowI?.purchaseRefund})`);
    assert(rowI.duplicateRefund === 1000, `Case I: duplicateRefund is tracked distinctly as ₹1,000 (Actual: ₹${rowI?.duplicateRefund})`);
    assert(rowI.netPurchaseReceipts === 1000, `Case I: netPurchaseReceipts is ₹1,000 (Actual: ₹${rowI?.netPurchaseReceipts})`);

    // -------------------------------------------------------------------------
    // Case J: Multiple orders and pagination consistency
    // Expected: summary equals correctly calculated full-report rows, independent of page size.
    // -------------------------------------------------------------------------
    console.log("\nRunning Case J: Multiple orders and pagination consistency...");
    const paginatedReport1 = await reportService.getSalesReportData({ rangeType: "daily", limit: 2, page: 1 });
    const paginatedReport2 = await reportService.getSalesReportData({ rangeType: "daily", limit: 10, page: 1 });

    assert(
        paginatedReport1.summary.totalOrdersCount === paginatedReport2.summary.totalOrdersCount,
        `Case J: totalOrdersCount matches across page sizes (${paginatedReport1.summary.totalOrdersCount} === ${paginatedReport2.summary.totalOrdersCount})`
    );
    assert(
        paginatedReport1.summary.collectedPayments === paginatedReport2.summary.collectedPayments,
        `Case J: collectedPayments matches across page sizes (${paginatedReport1.summary.collectedPayments} === ${paginatedReport2.summary.collectedPayments})`
    );
    assert(
        paginatedReport1.summary.purchaseRefunds === paginatedReport2.summary.purchaseRefunds,
        `Case J: purchaseRefunds matches across page sizes (${paginatedReport1.summary.purchaseRefunds} === ${paginatedReport2.summary.purchaseRefunds})`
    );
    assert(
        paginatedReport1.summary.netPurchaseReceipts === paginatedReport2.summary.netPurchaseReceipts,
        `Case J: netPurchaseReceipts matches across page sizes (${paginatedReport1.summary.netPurchaseReceipts} === ${paginatedReport2.summary.netPurchaseReceipts})`
    );

    // Sum of all rows must equal summary exactly
    const sumCollectedFromRows = reportData.allRows.reduce((sum, r) => sum + (r.purchaseCollected || 0), 0);
    const sumPurchaseRefundsFromRows = reportData.allRows.reduce((sum, r) => sum + (r.purchaseRefund || 0), 0);
    const sumNetReceiptsFromRows = reportData.allRows.reduce((sum, r) => sum + (r.netPurchaseReceipts || 0), 0);

    assert(
        reportData.summary.collectedPayments === sumCollectedFromRows,
        `Case J: summary.collectedPayments equals sum of all rows (${reportData.summary.collectedPayments} === ${sumCollectedFromRows})`
    );
    assert(
        reportData.summary.purchaseRefunds === sumPurchaseRefundsFromRows,
        `Case J: summary.purchaseRefunds equals sum of all rows (${reportData.summary.purchaseRefunds} === ${sumPurchaseRefundsFromRows})`
    );
    assert(
        reportData.summary.netPurchaseReceipts === sumNetReceiptsFromRows,
        `Case J: summary.netPurchaseReceipts equals sum of all rows (${reportData.summary.netPurchaseReceipts} === ${sumNetReceiptsFromRows})`
    );

    // -------------------------------------------------------------------------
    // Case K: PDF and Excel figures match report service
    // -------------------------------------------------------------------------
    console.log("\nRunning Case K: PDF and Excel export matching...");
    const excelWorkbook = await reportService.generateSalesExcel(reportData);
    assert(excelWorkbook != null, "Case K: Excel workbook generated successfully");

    const sheet = excelWorkbook.getWorksheet("Sales Report");
    assert(sheet != null, "Case K: Sales Report sheet found in workbook");

    // Extract summary values from Excel sheet
    let excelCollected = null;
    let excelRefunds = null;
    let excelNet = null;
    sheet.eachRow((row) => {
        const title = String(row.getCell(1).value || "");
        if (title.includes("Purchase Payments Collected")) {
            excelCollected = Number(row.getCell(2).value);
        } else if (title.includes("Purchase Refunds")) {
            excelRefunds = Number(row.getCell(2).value);
        } else if (title.includes("Net Purchase Receipts")) {
            excelNet = Number(row.getCell(2).value);
        }
    });

    assert(
        excelCollected === reportData.summary.collectedPayments,
        `Case K (Excel): Collected payments in Excel (${excelCollected}) matches service (${reportData.summary.collectedPayments})`
    );
    assert(
        excelRefunds === reportData.summary.purchaseRefunds,
        `Case K (Excel): Purchase refunds in Excel (${excelRefunds}) matches service (${reportData.summary.purchaseRefunds})`
    );
    assert(
        excelNet === reportData.summary.netPurchaseReceipts,
        `Case K (Excel): Net purchase receipts in Excel (${excelNet}) matches service (${reportData.summary.netPurchaseReceipts})`
    );

    // Generate PDF buffer
    const pdfBuffer = await reportService.generateSalesPdf(reportData);
    assert(Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 1000, `Case K (PDF): PDF generated as valid buffer (Length: ${pdfBuffer.length} bytes)`);

    // -------------------------------------------------------------------------
    // Case L: Historical order with insufficient payment evidence
    // Expected: Report limitation instead of inventing a collected amount.
    // -------------------------------------------------------------------------
    console.log("\nRunning Case L: Insufficient payment evidence handling...");
    const ambiguousOrder = {
        orderNumber: "TEST-LEGACY-NO-EVIDENCE",
        paymentMethod: "ONLINE",
        paymentStatus: "COMPLETED",
        paidAt: now,
        pricing: { originalSubtotal: 2000, totalAmount: 2000, currentPayable: 2000 },
        paymentAttempts: [],
    };
    const collectionResult = reportService.determineOrderCollections(ambiguousOrder, [], [], []);
    assert(
        collectionResult.hasPaymentEvidence === false,
        "Case L: Order claiming COMPLETED online without capture records is flagged hasPaymentEvidence=false"
    );
    assert(
        collectionResult.purchaseCollected === 0,
        `Case L: No collected amount is invented (Actual: ₹${collectionResult.purchaseCollected})`
    );
    assert(
        collectionResult.paymentEvidenceNote.includes("Insufficient payment evidence"),
        "Case L: Limitation note is clearly reported"
    );

    // Cleanup test records
    await Order.deleteMany({ orderNumber: /^TEST-BUG10-/ });
    await Payment.deleteMany({ razorpayPaymentId: /^test_pay_bug10_/ });
    await Transaction.deleteMany({ referenceId: /^TEST_REF_BUG10_/ });
    await mongoose.disconnect();

    console.log("\n==========================================================================");
    console.log(`BUG #10 TEST SUITE COMPLETE: ${passed}/${passed + failed} PASSED`);
    if (failed > 0) {
        console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
        process.exit(1);
    }
    console.log("ALL BUG #10 VERIFICATION REQUIREMENTS (CASES A - K) PASSED!");
    console.log("==========================================================================\n");
};

run().catch((err) => {
    console.error("Fatal test error:", err);
    process.exit(1);
});
