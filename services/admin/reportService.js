const Order = require("../../models/order/orderModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");
const Payment = require("../../models/order/paymentModel");
const Transaction = require("../../models/user/transactionModel");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");


const getDateRange = (rangeType = "daily", customStart = null, customEnd = null) => {
    const now = new Date();
    // Offset for IST (+5:30)
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);

    let startDate, endDate;

    if (rangeType === "custom" && customStart && customEnd) {
        let s = String(customStart).trim();
        let e = String(customEnd).trim();
        // Handle reversed custom date ranges safely
        if (s > e) {
            [s, e] = [e, s];
        }
        startDate = new Date(s + (s.includes("T") ? "" : "T00:00:00.000+05:30"));
        endDate = new Date(e + (e.includes("T") ? "" : "T23:59:59.999+05:30"));
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            // Safe fallback for malformed date input
            const start = new Date(nowIST);
            start.setUTCHours(0, 0, 0, 0);
            startDate = new Date(start.getTime() - IST_OFFSET);
            const end = new Date(nowIST);
            end.setUTCHours(23, 59, 59, 999);
            endDate = new Date(end.getTime() - IST_OFFSET);
        }
    } else if (rangeType === "weekly") {
        const start = new Date(nowIST);
        start.setUTCDate(start.getUTCDate() - 6);
        start.setUTCHours(0, 0, 0, 0);
        startDate = new Date(start.getTime() - IST_OFFSET);

        const end = new Date(nowIST);
        end.setUTCHours(23, 59, 59, 999);
        endDate = new Date(end.getTime() - IST_OFFSET);
    } else if (rangeType === "yearly") {
        const start = new Date(Date.UTC(nowIST.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
        startDate = new Date(start.getTime() - IST_OFFSET);

        const end = new Date(Date.UTC(nowIST.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
        endDate = new Date(end.getTime() - IST_OFFSET);
    } else {
        // Daily (Today)
        const start = new Date(nowIST);
        start.setUTCHours(0, 0, 0, 0);
        startDate = new Date(start.getTime() - IST_OFFSET);

        const end = new Date(nowIST);
        end.setUTCHours(23, 59, 59, 999);
        endDate = new Date(end.getTime() - IST_OFFSET);
    }

    return { startDate, endDate };
};

const formatIstDate = (date) => {
    if (!date) return "";
    return new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

/**
 * @param {Object} order - Order document (lean)
 * @param {Array} paymentDocs - Array of Payment documents for this order
 * @param {Array} walletDebits - Array of Transaction debit documents for this order
 * @param {Array} walletCredits - Array of Transaction credit documents for this order
 */
const determineOrderCollections = (order, paymentDocs = [], walletDebits = [], walletCredits = []) => {
    let method = (order.paymentMethod || "").toUpperCase();
    if (!method && paymentDocs.length > 0 && paymentDocs[0].paymentMethod) {
        method = (paymentDocs[0].paymentMethod || "").toUpperCase();
    }
    const duplicateRefundTotal = order.pricing?.duplicateRefundTotal || 0;

    let purchaseCollected = 0;
    let duplicateCollected = 0;
    let hasPaymentEvidence = true;
    let paymentEvidenceNote = "";

    if (method === "COD") {
        
        const isDeliveredOrCompleted =
            order.paymentStatus === "COMPLETED" || order.orderStatus === "DELIVERED";

        if (!isDeliveredOrCompleted) {
            return {
                purchaseCollected: 0,
                duplicateCollected: 0,
                hasPaymentEvidence: true,
                paymentEvidenceNote: "",
            };
        }

        // Delivered payable: items not cancelled + shipping
        const deliveredPayable = (order.items || [])
            .filter((i) => i.status !== "CANCELLED")
            .reduce((sum, i) => sum + (i.finalPayable != null ? i.finalPayable : (i.lineTotal || 0)), 0) +
            (order.pricing?.shippingFee || 0);

        purchaseCollected = deliveredPayable;
        return {
            purchaseCollected,
            duplicateCollected: 0,
            hasPaymentEvidence: true,
            paymentEvidenceNote: "",
        };
    }

    if (method === "WALLET") {
        // Authoritative source: Transaction ledger DEBIT records
        const hasRollback = walletCredits.some(
            (tx) => (tx.reason || "").toUpperCase() === "ORDER_PURCHASE_ROLLBACK"
        ) || order.orderStatus === "FAILED" || order.paymentStatus === "FAILED";

        if (hasRollback) {
            return {
                purchaseCollected: 0,
                duplicateCollected: 0,
                hasPaymentEvidence: true,
                paymentEvidenceNote: "Checkout rolled back; debit reversed",
            };
        }

        const totalDebited = walletDebits.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

        if (totalDebited > 0) {
            return {
                purchaseCollected: totalDebited,
                duplicateCollected: 0,
                hasPaymentEvidence: true,
                paymentEvidenceNote: "",
            };
        }

        // If no ledger debit found, check for a completed Payment document with amount > 0
        const completedWalletPayment = paymentDocs.find(
            (p) => (!p.paymentMethod || p.paymentMethod === "WALLET") && (p.status === "COMPLETED" || p.status === "REFUNDED") && p.amount > 0
        );
        if (completedWalletPayment) {
            return {
                purchaseCollected: completedWalletPayment.amount,
                duplicateCollected: 0,
                hasPaymentEvidence: true,
                paymentEvidenceNote: "",
            };
        }

        // If order claims to be COMPLETED/REFUNDED, but has no ledger debit and no payment record:
        const isPaidClaim =
            order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED" || Boolean(order.paidAt);
        if (isPaidClaim) {
            return {
                purchaseCollected: 0,
                duplicateCollected: 0,
                hasPaymentEvidence: false,
                paymentEvidenceNote: `Insufficient payment evidence: Order #${order.orderNumber} is marked ${order.paymentStatus} but lacks a confirmed wallet debit in the transaction ledger.`,
            };
        }

        return {
            purchaseCollected: 0,
            duplicateCollected: 0,
            hasPaymentEvidence: true,
            paymentEvidenceNote: "",
        };
    }

    if (method === "ONLINE") {
        // 1. Authoritative field: order.pricing.collectedAmount (explicitly verified captured amount)
        if (order.paymentStatus !== "FAILED" && order.paymentStatus !== "PENDING" && order.pricing?.collectedAmount != null && order.pricing.collectedAmount > 0) {
            purchaseCollected = order.pricing.collectedAmount;
            if (duplicateRefundTotal > 0) {
                duplicateCollected = duplicateRefundTotal;
            }
            return {
                purchaseCollected,
                duplicateCollected,
                hasPaymentEvidence: true,
                paymentEvidenceNote: "",
            };
        }

        // 2. Authoritative payment attempts stored on order
        const attempts = order.paymentAttempts || [];
        const successfulAttempts = attempts.filter(
            (a) => (a.status === "SUCCESS" || a.status === "CAPTURED") && a.amount > 0
        );
        const duplicateAttempts = attempts.filter(
            (a) => (a.status === "REFUNDED_DUPLICATE" || a.status === "DUPLICATE") && a.amount > 0
        );

        if (successfulAttempts.length > 0) {
            // Count purchase capture from primary successful attempt
            const primaryAttempt = order.razorpayPaymentId
                ? successfulAttempts.find((a) => a.razorpayPaymentId === order.razorpayPaymentId)
                : successfulAttempts[0];

            if (primaryAttempt) {
                purchaseCollected = primaryAttempt.amount;
                const otherAttempts = successfulAttempts.filter((a) => a !== primaryAttempt);
                const extraCaptured = otherAttempts.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
                const dupAttemptSum = duplicateAttempts.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
                duplicateCollected = extraCaptured + dupAttemptSum;
            } else {
                purchaseCollected = successfulAttempts[0].amount;
            }

            if (duplicateRefundTotal > 0 && duplicateCollected === 0) {
                duplicateCollected = duplicateRefundTotal;
            }

            return {
                purchaseCollected,
                duplicateCollected,
                hasPaymentEvidence: true,
                paymentEvidenceNote: "",
            };
        }

        // 3. Authoritative Payment documents
        const completedPayments = paymentDocs.filter(
            (p) =>
                (!p.paymentMethod || p.paymentMethod === "ONLINE" || p.razorpayPaymentId) &&
                ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(p.status) &&
                p.amount > 0
        );

        if (completedPayments.length > 0) {
            const primaryPay = order.razorpayPaymentId
                ? completedPayments.find((p) => p.razorpayPaymentId === order.razorpayPaymentId)
                : completedPayments[0];

            if (primaryPay) {
                purchaseCollected = primaryPay.amount;
                const extraPays = completedPayments.filter((p) => p !== primaryPay);
                duplicateCollected = extraPays.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
            } else {
                purchaseCollected = completedPayments[0].amount;
            }

            if (duplicateRefundTotal > 0 && duplicateCollected === 0) {
                duplicateCollected = duplicateRefundTotal;
            }

            return {
                purchaseCollected,
                duplicateCollected,
                hasPaymentEvidence: true,
                paymentEvidenceNote: "",
            };
        }

        // 4. If marked COMPLETED or REFUNDED, or paidAt exists, but no verified records exist:
        const isPaidClaim =
            order.paymentStatus === "COMPLETED" || order.paymentStatus === "REFUNDED" || Boolean(order.paidAt);

        if (isPaidClaim) {
            // Insufficient payment evidence! Report limitation instead of inventing a collected amount.
            return {
                purchaseCollected: 0,
                duplicateCollected: duplicateRefundTotal,
                hasPaymentEvidence: false,
                paymentEvidenceNote: `Insufficient payment evidence: Order #${order.orderNumber} is marked ${order.paymentStatus} with paidAt=${order.paidAt}, but lacks verified payment capture records.`,
            };
        }

        // Unpaid or unconfirmed order
        return {
            purchaseCollected: 0,
            duplicateCollected: 0,
            hasPaymentEvidence: true,
            paymentEvidenceNote: "",
        };
    }

    return {
        purchaseCollected: 0,
        duplicateCollected: 0,
        hasPaymentEvidence: true,
        paymentEvidenceNote: "",
    };
};

const getSalesReportData = async (options = {}) => {
    const { rangeType = "daily", startDate: customStart, endDate: customEnd, page = 1, limit = 15 } = options;
    let startDate, endDate;
    if (customStart instanceof Date && customEnd instanceof Date) {
        startDate = customStart;
        endDate = customEnd;
    } else {
        const range = getDateRange(rangeType, customStart, customEnd);
        startDate = range.startDate;
        endDate = range.endDate;
    }

    // Retain all non-failed orders placed within date boundaries (Order Placement Cohort)
    const orderFilter = {
        placedAt: { $gte: startDate, $lte: endDate },
        orderStatus: { $ne: "FAILED" },
    };

    const orders = await Order.find(orderFilter)
        .populate("userId", "fullName email")
        .sort({ placedAt: -1 })
        .lean();

    const orderIds = orders.map((o) => o._id);
    const [paymentDocs, walletTxs] = await Promise.all([
        Payment.find({ orderId: { $in: orderIds } }).lean(),
        Transaction.find({
            orderId: { $in: orderIds },
            type: { $in: ["DEBIT", "CREDIT"] },
        }).lean(),
    ]);

    // Group payments and transactions by orderId string to avoid N+1 queries
    const paymentsByOrder = new Map();
    for (const p of paymentDocs) {
        if (!p.orderId) continue;
        const k = p.orderId.toString();
        if (!paymentsByOrder.has(k)) paymentsByOrder.set(k, []);
        paymentsByOrder.get(k).push(p);
    }

    const walletDebitsByOrder = new Map();
    const walletCreditsByOrder = new Map();
    for (const tx of walletTxs) {
        if (!tx.orderId) continue;
        const k = tx.orderId.toString();
        if (tx.type === "DEBIT" && ["ORDER_PURCHASE", "ORDER_PAYMENT"].includes((tx.reason || "").toUpperCase())) {
            if (!walletDebitsByOrder.has(k)) walletDebitsByOrder.set(k, []);
            walletDebitsByOrder.get(k).push(tx);
        } else if (tx.type === "CREDIT") {
            if (!walletCreditsByOrder.has(k)) walletCreditsByOrder.set(k, []);
            walletCreditsByOrder.get(k).push(tx);
        }
    }

    let totalOrdersCount = orders.length;
    let totalGrossAmount = 0;
    let totalMerchandiseSales = 0;
    let totalTax = 0;
    let totalShipping = 0;
    let totalOfferDiscount = 0;
    let totalCouponDiscount = 0;
    let totalRefundsOrCancellations = 0;
    let totalPurchaseRefunds = 0;
    let totalDuplicateRefunds = 0;
    let totalPurchaseCollected = 0;
    let totalDuplicateCollected = 0;
    let netSalesRecognized = 0;
    let totalUnitsSold = 0;
    let totalPendingCodRevenue = 0;
    let insufficientEvidenceCount = 0;

    const reportRows = orders.map((ord) => {
        const orderIdStr = ord._id.toString();
        const ordPayments = paymentsByOrder.get(orderIdStr) || [];
        const ordDebits = walletDebitsByOrder.get(orderIdStr) || [];
        const ordCredits = walletCreditsByOrder.get(orderIdStr) || [];

        const collectionInfo = determineOrderCollections(ord, ordPayments, ordDebits, ordCredits);

        const merchandiseSales = ord.pricing?.originalSubtotal != null ? ord.pricing.originalSubtotal : (ord.pricing?.subtotal || 0);
        const tax = ord.pricing?.taxAmount || 0;
        const shipping = ord.pricing?.originalShippingFee != null ? ord.pricing.originalShippingFee : (ord.pricing?.shippingFee || 0);
        const grossAmount = merchandiseSales + shipping;

        const offerDisc = ord.pricing?.offerDiscount || 0;
        const couponDisc = ord.pricing?.couponDiscount || 0;
        const cancellationDeduction = ord.pricing?.cancellationDeduction || 0;
        const returnCredit = ord.pricing?.returnCredit || 0;
        const deduction = cancellationDeduction + returnCredit;

        // Distinct separation of purchase refunds from duplicate payment refunds
        const duplicateRefund = ord.pricing?.duplicateRefundTotal || 0;
        let purchaseRefund = 0;
        if (ord.pricing?.purchaseRefundTotal != null) {
            purchaseRefund = ord.pricing.purchaseRefundTotal;
        } else if (ord.pricing?.walletRefundIssued != null) {
            purchaseRefund = Math.max(0, ord.pricing.walletRefundIssued - duplicateRefund);
        }

        // Active delivered/processing units (excluding cancelled and returned/return-approved units)
        const activeItems = (ord.items || []).filter((i) => !["CANCELLED", "RETURNED", "RETURN_APPROVED"].includes(i.status));
        const orderUnits = activeItems.reduce((sum, i) => sum + i.quantity, 0);
        const orderNet = ord.pricing?.currentPayable != null
            ? ord.pricing.currentPayable
            : Math.max(0, (ord.pricing?.totalAmount || grossAmount) - deduction);

        const isPaid =
            ord.paymentStatus === "COMPLETED" ||
            ord.paymentStatus === "PARTIALLY_REFUNDED" ||
            (ord.paymentMethod === "COD" && ord.orderStatus === "DELIVERED") ||
            collectionInfo.purchaseCollected > 0;

        const isPendingCod =
            ord.paymentMethod === "COD" &&
            ord.paymentStatus === "PENDING" &&
            ord.orderStatus !== "DELIVERED" &&
            ord.orderStatus !== "CANCELLED";

        totalMerchandiseSales += merchandiseSales;
        totalTax += tax;
        totalShipping += shipping;
        totalGrossAmount += grossAmount;
        totalOfferDiscount += offerDisc;
        totalCouponDiscount += couponDisc;
        totalRefundsOrCancellations += deduction;
        totalPurchaseRefunds += purchaseRefund;
        totalDuplicateRefunds += duplicateRefund;
        totalPurchaseCollected += collectionInfo.purchaseCollected;
        totalDuplicateCollected += collectionInfo.duplicateCollected;

        if (!collectionInfo.hasPaymentEvidence) {
            insufficientEvidenceCount++;
        }

        // Units sold include only verified paid or delivered purchases
        if (isPaid) {
            totalUnitsSold += orderUnits;
            netSalesRecognized += orderNet;
        } else if (isPendingCod) {
            totalPendingCodRevenue += orderNet;
        }

        const netPurchaseReceipts = collectionInfo.purchaseCollected - purchaseRefund;

        return {
            _id: ord._id,
            orderNumber: ord.orderNumber,
            placedAt: ord.placedAt,
            customerName: ord.userId?.fullName || "Customer",
            customerEmail: ord.userId?.email || "N/A",
            paymentMethod: ord.paymentMethod,
            paymentStatus: ord.paymentStatus,
            orderStatus: ord.orderStatus,
            merchandiseSales,
            tax,
            shipping,
            grossAmount,
            offerDiscount: offerDisc,
            couponDiscount: couponDisc,
            refundsOrDeductions: deduction,
            purchaseRefund,
            duplicateRefund,
            netPayable: orderNet,
            unitsCount: orderUnits,
            isCollected: collectionInfo.purchaseCollected > 0,
            purchaseCollected: collectionInfo.purchaseCollected,
            duplicateCollected: collectionInfo.duplicateCollected,
            netPurchaseReceipts,
            pendingCod: isPendingCod ? orderNet : 0,
            hasPaymentEvidence: collectionInfo.hasPaymentEvidence,
            paymentEvidenceNote: collectionInfo.paymentEvidenceNote,
        };
    });

    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 15));
    const totalPages = Math.ceil(reportRows.length / parsedLimit) || 1;
    const parsedPage = Math.max(1, Number(page) || 1);
    const currentPage = Math.min(parsedPage, totalPages);
    const paginatedRows = reportRows.slice((currentPage - 1) * parsedLimit, currentPage * parsedLimit);

    const netPurchaseReceiptsTotal = totalPurchaseCollected - totalPurchaseRefunds;

    return {
        rangeType,
        startDate,
        endDate,
        summary: {
            ordersPlaced: totalOrdersCount,
            totalOrdersCount,
            collectedPayments: totalPurchaseCollected,
            totalCollectedRevenue: totalPurchaseCollected,
            purchaseRefunds: totalPurchaseRefunds,
            totalPurchaseRefunds,
            netPurchaseReceipts: netPurchaseReceiptsTotal,
            pendingCod: totalPendingCodRevenue,
            totalPendingCodRevenue,
            merchandiseSales: totalMerchandiseSales,
            totalMerchandiseSales,
            offerDiscounts: totalOfferDiscount,
            totalOfferDiscount,
            couponDiscounts: totalCouponDiscount,
            totalCouponDiscount,
            tax: totalTax,
            totalTax,
            shipping: totalShipping,
            totalShipping,
            cancellationsAndReturns: totalRefundsOrCancellations,
            totalRefundsOrCancellations,
            duplicateRefunds: totalDuplicateRefunds,
            totalDuplicateRefunds,
            duplicateCollections: totalDuplicateCollected,
            totalDuplicateCollected,
            grossCashCollections: totalPurchaseCollected + totalDuplicateCollected,
            netSalesRecognized,
            totalGrossAmount,
            totalUnitsSold,
            ordersWithInsufficientEvidenceCount: insufficientEvidenceCount,
            cohortBasis: "ORDER_PLACEMENT_COHORT",
            cohortDescription: "Figures reflect historical collections, refunds, and net receipts for orders placed within the selected period.",
        },
        orders: paginatedRows,
        allRows: reportRows,
        currentPage,
        totalPages,
    };
};

/**
 * Escapes strings to prevent spreadsheet formula injection in CSV/Excel.
 */
const sanitizeForSpreadsheet = (val) => {
    if (val == null) return "";
    const str = String(val).trim();
    if (/^[=+@-]/i.test(str)) {
        return "'" + str;
    }
    return str;
};

/**
 * Generates an Excel workbook from the sales report.
 */
const generateSalesExcel = async (reportData) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "VELORA Admin";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Sales Report");

    // Title Block
    sheet.mergeCells("A1:K1");
    const titleCell = sheet.getCell("A1");
    titleCell.value = "VELORA SALES REPORT";
    titleCell.font = { bold: true, size: 16, color: { argb: "FF000000" } };
    titleCell.alignment = { horizontal: "center" };

    // Range metadata in IST
    sheet.getCell("A2").value = `Period: ${formatIstDate(reportData.startDate)} to ${formatIstDate(reportData.endDate)} (IST) | Basis: Order Placement Cohort`;
    sheet.getCell("A2").font = { italic: true, size: 11 };

    // Summary Section
    sheet.addRow([]);
    sheet.addRow(["EXECUTIVE SUMMARY & FINANCIAL RECONCILIATION"]);
    sheet.addRow(["Report Date Basis", reportData.summary.cohortDescription || "Order Placement Cohort (Lifetime Financials)"]);
    sheet.addRow(["Orders Placed", reportData.summary.ordersPlaced || reportData.summary.totalOrdersCount]);
    sheet.addRow(["Purchase Payments Collected (₹)", reportData.summary.collectedPayments || 0]);
    sheet.addRow(["Purchase Refunds (₹)", reportData.summary.purchaseRefunds || 0]);
    sheet.addRow(["Net Purchase Receipts (₹)", reportData.summary.netPurchaseReceipts != null ? reportData.summary.netPurchaseReceipts : ((reportData.summary.collectedPayments || 0) - (reportData.summary.purchaseRefunds || 0))]);
    sheet.addRow(["Pending COD (₹)", reportData.summary.pendingCod || 0]);
    sheet.addRow(["Merchandise Sales (₹)", reportData.summary.merchandiseSales || reportData.summary.totalGrossAmount]);
    sheet.addRow(["Offer Discounts (₹)", reportData.summary.offerDiscounts || reportData.summary.totalOfferDiscount]);
    sheet.addRow(["Coupon Discounts (₹)", reportData.summary.couponDiscounts || reportData.summary.totalCouponDiscount]);
    sheet.addRow(["Tax (5%) (₹)", reportData.summary.tax || 0]);
    sheet.addRow(["Shipping (₹)", reportData.summary.shipping || 0]);
    sheet.addRow(["Cancellations & Returns (₹)", reportData.summary.cancellationsAndReturns || reportData.summary.totalRefundsOrCancellations]);
    sheet.addRow(["Duplicate Payment Refunds (₹)", reportData.summary.duplicateRefunds || 0]);
    sheet.addRow(["Net Recognized Sales (₹)", reportData.summary.netSalesRecognized]);
    sheet.addRow(["Net Units Sold", reportData.summary.totalUnitsSold]);
    if (reportData.summary.ordersWithInsufficientEvidenceCount > 0) {
        sheet.addRow(["Orders With Missing Evidence", reportData.summary.ordersWithInsufficientEvidenceCount]);
    }
    sheet.addRow([]);

    // Table Header
    const headerRow = sheet.addRow([
        "Order Number",
        "Placed Date",
        "Customer",
        "Payment Method",
        "Payment Status",
        "Order Status",
        "Merchandise (₹)",
        "Tax (₹)",
        "Shipping (₹)",
        "Offer Disc (₹)",
        "Coupon Disc (₹)",
        "Deductions (₹)",
        "Net Payable (₹)",
        "Collected (₹)",
        "Purchase Refund (₹)",
        "Net Receipts (₹)",
    ]);
    headerRow.font = { bold: true };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF0F0F0" },
    };

    // Populate rows
    reportData.allRows.forEach((row) => {
        sheet.addRow([
            sanitizeForSpreadsheet(row.orderNumber),
            formatIstDate(row.placedAt),
            sanitizeForSpreadsheet(row.customerName),
            sanitizeForSpreadsheet(row.paymentMethod),
            sanitizeForSpreadsheet(row.paymentStatus),
            sanitizeForSpreadsheet(row.orderStatus),
            row.merchandiseSales !== undefined ? row.merchandiseSales : row.grossAmount,
            row.tax || 0,
            row.shipping || 0,
            row.offerDiscount || 0,
            row.couponDiscount || 0,
            row.refundsOrDeductions || 0,
            row.netPayable,
            row.purchaseCollected != null ? row.purchaseCollected : (row.isCollected ? row.netPayable : 0),
            row.purchaseRefund || 0,
            row.netPurchaseReceipts != null ? row.netPurchaseReceipts : ((row.purchaseCollected || 0) - (row.purchaseRefund || 0)),
        ]);
    });

    // Auto-fit column widths
    sheet.columns.forEach((col) => {
        let maxLen = 12;
        col.eachCell({ includeEmpty: true }, (cell) => {
            const len = cell.value ? String(cell.value).length : 0;
            if (len > maxLen) maxLen = Math.min(30, len);
        });
        col.width = maxLen + 2;
    });

    return workbook;
};


const generateSalesPdf = async (reportData) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 35, size: "A4" });
            const buffers = [];

            doc.on("data", buffers.push.bind(buffers));
            doc.on("end", () => resolve(Buffer.concat(buffers)));

            // Header
            doc.fontSize(18).font("Helvetica-Bold").text("VELORA", 35, 35);
            doc.fontSize(10).font("Helvetica").text("Official Sales & Revenue Report", 35, 58);
            doc.fontSize(8.5).text(
                `Report Range: ${formatIstDate(reportData.startDate)} to ${formatIstDate(reportData.endDate)} (Asia/Kolkata) | Basis: Order Placement Cohort`,
                35,
                72
            );

            doc.moveTo(35, 90).lineTo(560, 90).strokeColor("#E5E7EB").stroke();

            // Summary Grid
            doc.fontSize(10).font("Helvetica-Bold").text("EXECUTIVE SUMMARY & FINANCIAL RECONCILIATION", 35, 100);
            doc.font("Helvetica").fontSize(8);

            const s = reportData.summary;
            doc.text(`Orders Placed: ${s.ordersPlaced || s.totalOrdersCount}`, 35, 115);
            doc.text(`Units Sold: ${s.totalUnitsSold}`, 160, 115);
            doc.text(`Merchandise: ₹${(s.merchandiseSales || s.totalGrossAmount).toLocaleString("en-IN")}`, 300, 115);
            doc.text(`Tax (5%): ₹${(s.tax || 0).toLocaleString("en-IN")}`, 440, 115);

            doc.text(`Collected: ₹${(s.collectedPayments || 0).toLocaleString("en-IN")}`, 35, 130);
            doc.text(`Purchase Refunds: ₹${(s.purchaseRefunds || 0).toLocaleString("en-IN")}`, 160, 130);
            doc.text(`Net Receipts: ₹${(s.netPurchaseReceipts != null ? s.netPurchaseReceipts : ((s.collectedPayments || 0) - (s.purchaseRefunds || 0))).toLocaleString("en-IN")}`, 300, 130);
            doc.text(`Pending COD: ₹${(s.pendingCod || 0).toLocaleString("en-IN")}`, 440, 130);

            doc.text(`Shipping: ₹${(s.shipping || 0).toLocaleString("en-IN")}`, 35, 145);
            doc.text(`Discounts: ₹${((s.offerDiscounts || 0) + (s.couponDiscounts || 0)).toLocaleString("en-IN")}`, 160, 145);
            doc.text(`Deductions: ₹${(s.cancellationsAndReturns || 0).toLocaleString("en-IN")}`, 300, 145);
            doc.text(`Duplicate Refunds: ₹${(s.duplicateRefunds || 0).toLocaleString("en-IN")}`, 440, 145);

            doc.font("Helvetica-Bold").text(`Net Recognized Sales: ₹${(s.netSalesRecognized || 0).toLocaleString("en-IN")}`, 35, 160);

            doc.moveTo(35, 172).lineTo(560, 172).strokeColor("#E5E7EB").stroke();

            // Table of Orders
            let y = 185;
            doc.fontSize(7.5).font("Helvetica-Bold");
            doc.text("ORDER NO", 35, y);
            doc.text("DATE", 115, y);
            doc.text("CUSTOMER", 175, y);
            doc.text("PAYMENT", 255, y);
            doc.text("GROSS (₹)", 325, y, { align: "right", width: 55 });
            doc.text("DISC (₹)", 385, y, { align: "right", width: 50 });
            doc.text("DEDUCT (₹)", 440, y, { align: "right", width: 55 });
            doc.text("NET (₹)", 500, y, { align: "right", width: 60 });

            y += 14;
            doc.moveTo(35, y).lineTo(560, y).strokeColor("#D1D5DB").stroke();
            y += 6;

            doc.font("Helvetica").fontSize(7.5);
            for (const row of reportData.allRows) {
                if (y > 760) {
                    doc.addPage();
                    y = 35;
                }
                const totalDisc = (row.offerDiscount || 0) + (row.couponDiscount || 0);
                doc.text(row.orderNumber || "", 35, y);
                doc.text(formatIstDate(row.placedAt), 115, y);
                doc.text((row.customerName || "Customer").substring(0, 14), 175, y);
                doc.text(`${row.paymentMethod} (${row.paymentStatus})`, 255, y);
                doc.text(`₹${row.grossAmount.toLocaleString("en-IN")}`, 325, y, { align: "right", width: 55 });
                doc.text(`₹${totalDisc.toLocaleString("en-IN")}`, 385, y, { align: "right", width: 50 });
                doc.text(`₹${row.refundsOrDeductions.toLocaleString("en-IN")}`, 440, y, { align: "right", width: 55 });
                doc.text(`₹${row.netPayable.toLocaleString("en-IN")}`, 500, y, { align: "right", width: 60 });
                y += 16;
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
};


const getDashboardAnalytics = async (filterType = "monthly", targetYear = null) => {
    const now = new Date();
    const qualifyingSalesMatch = {
        orderStatus: { $nin: ["CANCELLED", "FAILED"] },
        $or: [
            { paymentStatus: "COMPLETED" },
            { paymentMethod: "COD", orderStatus: "DELIVERED" },
        ],
    };

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);

    let timeMatch = {};
    let timeline = [];

    const yearNum = targetYear ? parseInt(targetYear, 10) : null;

    if (yearNum && Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100) {
        // Specific target year in Asia/Kolkata (+05:30)
        const startOfYear = new Date(`${yearNum}-01-01T00:00:00+05:30`);
        const endOfYear = new Date(`${yearNum}-12-31T23:59:59.999+05:30`);
        timeMatch = { placedAt: { $gte: startOfYear, $lte: endOfYear } };

        for (let m = 1; m <= 12; m++) {
            timeline.push({
                _id: { year: yearNum, month: m },
                year: yearNum,
                month: m,
                label: `${months[m - 1]} ${yearNum}`,
                totalRevenue: 0,
                orderCount: 0,
            });
        }

        const stats = await Order.aggregate([
            { $match: { ...timeMatch, ...qualifyingSalesMatch } },
            {
                $group: {
                    _id: {
                        year: { $year: { date: "$placedAt", timezone: "Asia/Kolkata" } },
                        month: { $month: { date: "$placedAt", timezone: "Asia/Kolkata" } },
                    },
                    totalRevenue: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } },
                    orderCount: { $sum: 1 },
                },
            },
        ]);

        for (const s of stats) {
            const slot = timeline.find((t) => t.month === s._id.month);
            if (slot) {
                slot.totalRevenue = s.totalRevenue;
                slot.orderCount = s.orderCount;
            }
        }
    } else if (filterType === "daily") {
        // Daily: trailing 30 days
        for (let i = 29; i >= 0; i--) {
            const d = new Date(nowIST.getTime() - i * 24 * 60 * 60 * 1000);
            const y = d.getUTCFullYear();
            const m = d.getUTCMonth() + 1;
            const day = d.getUTCDate();
            timeline.push({
                _id: { year: y, month: m, day },
                year: y,
                month: m,
                day,
                label: `${day} ${months[m - 1]}`,
                totalRevenue: 0,
                orderCount: 0,
            });
        }

        const startDaily = new Date(nowIST.getTime() - 29 * 24 * 60 * 60 * 1000);
        startDaily.setUTCHours(0, 0, 0, 0);
        const startDailyUTC = new Date(startDaily.getTime() - IST_OFFSET);
        timeMatch = { placedAt: { $gte: startDailyUTC } };

        const stats = await Order.aggregate([
            { $match: { ...timeMatch, ...qualifyingSalesMatch } },
            {
                $group: {
                    _id: {
                        year: { $year: { date: "$placedAt", timezone: "Asia/Kolkata" } },
                        month: { $month: { date: "$placedAt", timezone: "Asia/Kolkata" } },
                        day: { $dayOfMonth: { date: "$placedAt", timezone: "Asia/Kolkata" } },
                    },
                    totalRevenue: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } },
                    orderCount: { $sum: 1 },
                },
            },
        ]);

        for (const s of stats) {
            const slot = timeline.find(
                (t) => t.year === s._id.year && t.month === s._id.month && t.day === s._id.day
            );
            if (slot) {
                slot.totalRevenue = s.totalRevenue;
                slot.orderCount = s.orderCount;
            }
        }
    } else if (filterType === "weekly") {
        // Weekly: trailing 12 weeks
        for (let i = 11; i >= 0; i--) {
            const end = new Date(nowIST.getTime() - i * 7 * 24 * 60 * 60 * 1000);
            const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
            const startUTC = new Date(start.getTime() - IST_OFFSET);
            const endUTC = new Date(end.getTime() - IST_OFFSET);
            timeline.push({
                weekIndex: 11 - i,
                startUTC,
                endUTC,
                label: `${start.getUTCDate()} ${months[start.getUTCMonth()]} - ${end.getUTCDate()} ${months[end.getUTCMonth()]}`,
                totalRevenue: 0,
                orderCount: 0,
            });
        }

        const startWeeklyUTC = timeline[0].startUTC;
        timeMatch = { placedAt: { $gte: startWeeklyUTC } };

        const qualifyingOrders = await Order.find({
            ...timeMatch,
            ...qualifyingSalesMatch,
        }).lean();

        for (const ord of qualifyingOrders) {
            const placed = new Date(ord.placedAt);
            const rev =
                ord.pricing?.currentPayable != null
                    ? ord.pricing.currentPayable
                    : ord.pricing?.totalAmount || 0;
            for (const slot of timeline) {
                if (placed >= slot.startUTC && placed <= slot.endUTC) {
                    slot.totalRevenue += rev;
                    slot.orderCount += 1;
                    break;
                }
            }
        }
    } else if (filterType === "yearly") {
        // Yearly: trailing 5 years
        const currentYear = nowIST.getUTCFullYear();
        for (let i = 4; i >= 0; i--) {
            const y = currentYear - i;
            timeline.push({
                _id: { year: y },
                year: y,
                label: String(y),
                totalRevenue: 0,
                orderCount: 0,
            });
        }

        const startFiveYears = new Date(Date.UTC(currentYear - 4, 0, 1) - IST_OFFSET);
        timeMatch = { placedAt: { $gte: startFiveYears } };

        const stats = await Order.aggregate([
            { $match: { ...timeMatch, ...qualifyingSalesMatch } },
            {
                $group: {
                    _id: { year: { $year: { date: "$placedAt", timezone: "Asia/Kolkata" } } },
                    totalRevenue: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } },
                    orderCount: { $sum: 1 },
                },
            },
        ]);

        for (const s of stats) {
            const slot = timeline.find((t) => t.year === s._id.year);
            if (slot) {
                slot.totalRevenue = s.totalRevenue;
                slot.orderCount = s.orderCount;
            }
        }
    } else {
        // Monthly: trailing 12 months (default)
        for (let i = 11; i >= 0; i--) {
            const d = new Date(nowIST.getUTCFullYear(), nowIST.getUTCMonth() - i, 1);
            const y = d.getFullYear();
            const m = d.getMonth() + 1;
            timeline.push({
                _id: { year: y, month: m },
                year: y,
                month: m,
                label: `${months[m - 1]} ${y}`,
                totalRevenue: 0,
                orderCount: 0,
            });
        }

        const oneYearAgo = new Date(nowIST.getUTCFullYear(), nowIST.getUTCMonth() - 11, 1);
        const startMonthlyUTC = new Date(oneYearAgo.getTime() - IST_OFFSET);
        timeMatch = { placedAt: { $gte: startMonthlyUTC } };

        const stats = await Order.aggregate([
            { $match: { ...timeMatch, ...qualifyingSalesMatch } },
            {
                $group: {
                    _id: {
                        year: { $year: { date: "$placedAt", timezone: "Asia/Kolkata" } },
                        month: { $month: { date: "$placedAt", timezone: "Asia/Kolkata" } },
                    },
                    totalRevenue: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } },
                    orderCount: { $sum: 1 },
                },
            },
        ]);

        for (const s of stats) {
            const slot = timeline.find((t) => t.year === s._id.year && t.month === s._id.month);
            if (slot) {
                slot.totalRevenue = s.totalRevenue;
                slot.orderCount = s.orderCount;
            }
        }
    }

    const monthlyStats = timeline;

    // Top 10 Best Selling Products (by quantity sold in qualifying sales within selected period)
    const topProducts = await Order.aggregate([
        {
            $match: {
                ...timeMatch,
                ...qualifyingSalesMatch,
            },
        },
        { $unwind: "$items" },
        {
            $match: {
                "items.status": { $nin: ["CANCELLED", "RETURNED", "RETURN_APPROVED"] },
            },
        },
        {
            $group: {
                _id: "$items.productId",
                productName: { $first: "$items.productName" },
                productSlug: { $first: "$items.productSlug" },
                thumbnail: { $first: "$items.thumbnail" },
                totalUnitsSold: { $sum: "$items.quantity" },
                totalRevenue: { $sum: { $ifNull: ["$items.finalPayable", "$items.lineTotal"] } },
            },
        },
        { $sort: { totalUnitsSold: -1 } },
        { $limit: 10 },
    ]);

    // Top 10 Best Selling Categories (using item purchase snapshot when available)
    const topCategories = await Order.aggregate([
        {
            $match: {
                ...timeMatch,
                ...qualifyingSalesMatch,
            },
        },
        { $unwind: "$items" },
        {
            $match: {
                "items.status": { $nin: ["CANCELLED", "RETURNED", "RETURN_APPROVED"] },
            },
        },
        {
            $lookup: {
                from: "products",
                localField: "items.productId",
                foreignField: "_id",
                as: "product",
            },
        },
        {
            $unwind: { path: "$product", preserveNullAndEmptyArrays: true },
        },
        {
            $lookup: {
                from: "categories",
                localField: "product.categoryId",
                foreignField: "_id",
                as: "category",
            },
        },
        {
            $unwind: { path: "$category", preserveNullAndEmptyArrays: true },
        },
        {
            $group: {
                _id: {
                    $cond: [
                        { $and: [{ $ne: ["$items.categoryId", null] }, { $ne: ["$items.categoryId", ""] }] },
                        "$items.categoryId",
                        "$category._id"
                    ]
                },
                categoryName: {
                    $first: {
                        $cond: [
                            { $and: [{ $ne: ["$items.categoryName", null] }, { $ne: ["$items.categoryName", ""] }] },
                            "$items.categoryName",
                            "$category.name"
                        ]
                    }
                },
                totalUnitsSold: { $sum: "$items.quantity" },
                totalRevenue: { $sum: { $ifNull: ["$items.finalPayable", "$items.lineTotal"] } },
            },
        },
        {
            $match: {
                _id: { $nin: ["", null] },
            },
        },
        { $sort: { totalUnitsSold: -1 } },
        { $limit: 10 },
    ]);

    // Top 10 Best Selling Brands (using item brand snapshot when available, excluding blank/null)
    const topBrands = await Order.aggregate([
        {
            $match: {
                ...timeMatch,
                ...qualifyingSalesMatch,
            },
        },
        { $unwind: "$items" },
        {
            $match: {
                "items.status": { $nin: ["CANCELLED", "RETURNED", "RETURN_APPROVED"] },
            },
        },
        {
            $lookup: {
                from: "products",
                localField: "items.productId",
                foreignField: "_id",
                as: "product",
            },
        },
        {
            $unwind: { path: "$product", preserveNullAndEmptyArrays: true },
        },
        {
            $group: {
                _id: {
                    $cond: [
                        { $and: [{ $ne: ["$items.brand", null] }, { $ne: ["$items.brand", ""] }] },
                        "$items.brand",
                        "$product.brand"
                    ]
                },
                brandName: {
                    $first: {
                        $cond: [
                            { $and: [{ $ne: ["$items.brand", null] }, { $ne: ["$items.brand", ""] }] },
                            "$items.brand",
                            "$product.brand"
                        ]
                    }
                },
                totalUnitsSold: { $sum: "$items.quantity" },
                totalRevenue: { $sum: { $ifNull: ["$items.finalPayable", "$items.lineTotal"] } },
            },
        },
        {
            $match: {
                _id: { $nin: ["", null] },
            },
        },
        { $sort: { totalUnitsSold: -1 } },
        { $limit: 10 },
    ]);

    return {
        filterType,
        monthlyStats,
        topProducts,
        topCategories,
        topBrands,
    };
};

const getSalesReportMetrics = async (options = {}) => {
    const data = await getSalesReportData(options);
    return {
        overallOrdersCount: data.summary.totalOrdersCount,
        overallAmount: data.summary.totalGrossAmount,
        overallDiscount: data.summary.totalCouponDiscount + data.summary.totalOfferDiscount,
        netSales: data.summary.netSalesRecognized,
        summary: data.summary,
    };
};

const generateExcelReport = async (options = {}) => {
    const data = await getSalesReportData(options);
    const wb = await generateSalesExcel(data);
    return wb.xlsx.writeBuffer();
};

const generatePdfReport = async (options = {}) => {
    const data = await getSalesReportData(options);
    return generateSalesPdf(data);
};

const getTopBestSellers = async (limit = 10) => {
    const analytics = await getDashboardAnalytics();
    return {
        topProducts: analytics.topProducts.slice(0, limit),
        topCategories: analytics.topCategories.slice(0, limit),
        topBrands: analytics.topBrands.slice(0, limit),
    };
};

const sanitizeSpreadsheetData = (data) => {
    if (Array.isArray(data)) {
        return data.map((item) => {
            if (typeof item === "object" && item !== null) {
                const sanitizedItem = {};
                for (const [key, val] of Object.entries(item)) {
                    sanitizedItem[key] = sanitizeForSpreadsheet(val);
                }
                return sanitizedItem;
            }
            return sanitizeForSpreadsheet(item);
        });
    }
    return data;
};

/**
 * Calculates net sales for today and yesterday in Asia/Kolkata up to the current time.
 * Reuses getSalesReportData to ensure exact accounting for cancellations/returns,
 * inclusion of genuine paid sales, and exclusion of unpaid/duplicate-payment records.
 *
 * @param {Date} [asOf=new Date()] - Reference timestamp (defaults to now)
 * @returns {Promise<{todaySales: number, yesterdaySales: number, totalSales: number, todayNetSales: number, yesterdayNetSales: number, lastTwoDaysSales: number, todayStart: Date, todayEnd: Date, yesterdayStart: Date, yesterdayEnd: Date}>}
 */
const getLastTwoDaysSales = async (asOf = new Date()) => {
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(asOf.getTime() + IST_OFFSET);

    const year = nowIST.getUTCFullYear();
    const month = nowIST.getUTCMonth();
    const date = nowIST.getUTCDate();

    // Start of Today in Asia/Kolkata (00:00:00.000 IST)
    const todayStart = new Date(Date.UTC(year, month, date, 0, 0, 0, 0) - IST_OFFSET);
    // End of Today: strictly up to the current time
    const todayEnd = asOf;

    // Start of Yesterday in Asia/Kolkata (00:00:00.000 IST)
    const yesterdayStart = new Date(Date.UTC(year, month, date - 1, 0, 0, 0, 0) - IST_OFFSET);
    // End of Yesterday in Asia/Kolkata (23:59:59.999 IST)
    const yesterdayEnd = new Date(todayStart.getTime() - 1);

    const [todayReport, yesterdayReport] = await Promise.all([
        getSalesReportData({ startDate: todayStart, endDate: todayEnd, limit: 1 }),
        getSalesReportData({ startDate: yesterdayStart, endDate: yesterdayEnd, limit: 1 }),
    ]);

    const todayNetSales = Math.max(0, todayReport?.summary?.netSalesRecognized || 0);
    const yesterdayNetSales = Math.max(0, yesterdayReport?.summary?.netSalesRecognized || 0);
    const totalSales = todayNetSales + yesterdayNetSales;

    return {
        todaySales: todayNetSales,
        yesterdaySales: yesterdayNetSales,
        totalSales,
        todayNetSales,
        yesterdayNetSales,
        lastTwoDaysSales: totalSales,
        todayStart,
        todayEnd,
        yesterdayStart,
        yesterdayEnd,
    };
};

module.exports = {
    getDateRange,
    formatIstDate,
    determineOrderCollections,
    getSalesReportData,
    generateSalesExcel,
    generateSalesPdf,
    generateExcelReport,
    generatePdfReport,
    getTopBestSellers,
    getDashboardAnalytics,
    getSalesReportMetrics,
    getLastTwoDaysSales,
    sanitizeForSpreadsheet,
    sanitizeSpreadsheetData,
};
