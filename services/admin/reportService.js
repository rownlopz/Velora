const Order = require("../../models/order/orderModel");
const User = require("../../models/user/userModel");
const exportService = require("./reportExportService");

const formatIstDate = (date) => {
    if (!date) return "";
    return new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

const getDateRange = (rangeType = "daily", customStart = null, customEnd = null) => {
    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);
    let startDate = new Date(nowIST), endDate = new Date(nowIST);

    if (rangeType === "custom" && customStart && customEnd) {
        let [s, e] = [String(customStart).trim(), String(customEnd).trim()];
        if (s > e) [s, e] = [e, s];
        return { startDate: new Date(s + "T00:00:00.000+05:30"), endDate: new Date(e + "T23:59:59.999+05:30") };
    } else if (rangeType === "weekly") {
        startDate.setUTCDate(startDate.getUTCDate() - 6);
    } else if (rangeType === "monthly") {
        startDate = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1));
        endDate = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth() + 1, 0, 23, 59, 59, 999));
        return { startDate: new Date(startDate.getTime() - IST_OFFSET), endDate: new Date(endDate.getTime() - IST_OFFSET) };
    } else if (rangeType === "yearly") {
        startDate = new Date(Date.UTC(nowIST.getUTCFullYear(), 0, 1));
        endDate = new Date(Date.UTC(nowIST.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
        return { startDate: new Date(startDate.getTime() - IST_OFFSET), endDate: new Date(endDate.getTime() - IST_OFFSET) };
    }
    startDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCHours(23, 59, 59, 999);
    return { startDate: new Date(startDate.getTime() - IST_OFFSET), endDate: new Date(endDate.getTime() - IST_OFFSET) };
};

const getLastTwoDaysSales = async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const paidMatch = { orderStatus: { $ne: "CANCELLED" }, $or: [{ paymentStatus: "COMPLETED" }, { paymentMethod: "COD", orderStatus: "DELIVERED" }] };

    const [todayAgg, yestAgg] = await Promise.all([
        Order.aggregate([{ $match: { ...paidMatch, placedAt: { $gte: today } } }, { $group: { _id: null, total: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } } } }]),
        Order.aggregate([{ $match: { ...paidMatch, placedAt: { $gte: yesterday, $lt: today } } }, { $group: { _id: null, total: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } } } }])
    ]);
    const todaySales = todayAgg[0]?.total || 0;
    const yesterdaySales = yestAgg[0]?.total || 0;
    return { todaySales, yesterdaySales, totalSales: todaySales + yesterdaySales, lastTwoDaysSales: todaySales + yesterdaySales };
};

const getDashboardAnalytics = async (filterType = "monthly", targetYear = null) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const qualifyingSalesMatch = { orderStatus: { $nin: ["CANCELLED", "FAILED"] }, $or: [{ paymentStatus: "COMPLETED" }, { paymentMethod: "COD", orderStatus: "DELIVERED" }] };

    let timeline = [], timeMatch = {};
    if (filterType === "daily") {
        const start = new Date(); start.setDate(start.getDate() - 29); start.setHours(0, 0, 0, 0);
        timeMatch = { placedAt: { $gte: start } };
        for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); timeline.push({ label: `${d.getDate()} ${months[d.getMonth()]}`, day: d.getDate(), month: d.getMonth() + 1, totalRevenue: 0, orderCount: 0 }); }
    } else if (filterType === "yearly") {
        const currentYear = new Date().getFullYear();
        timeMatch = { placedAt: { $gte: new Date(`${currentYear - 4}-01-01`) } };
        for (let y = currentYear - 4; y <= currentYear; y++) timeline.push({ label: String(y), year: y, totalRevenue: 0, orderCount: 0 });
    } else {
        const yr = targetYear ? parseInt(targetYear, 10) : new Date().getFullYear();
        if (targetYear) {
            timeMatch = { placedAt: { $gte: new Date(`${yr}-01-01`), $lte: new Date(`${yr}-12-31T23:59:59.999`) } };
            for (let m = 0; m < 12; m++) timeline.push({ label: `${months[m]} ${yr}`, month: m + 1, totalRevenue: 0, orderCount: 0 });
        } else {
            const start = new Date(); start.setMonth(start.getMonth() - 11); start.setDate(1); start.setHours(0, 0, 0, 0);
            timeMatch = { placedAt: { $gte: start } };
            for (let i = 11; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); timeline.push({ label: `${months[d.getMonth()]} ${d.getFullYear()}`, month: d.getMonth() + 1, year: d.getFullYear(), totalRevenue: 0, orderCount: 0 }); }
        }
    }

    const stats = await Order.aggregate([
        { $match: { ...timeMatch, ...qualifyingSalesMatch } },
        {
            $group: {
                _id: { year: { $year: { date: "$placedAt", timezone: "Asia/Kolkata" } }, month: { $month: { date: "$placedAt", timezone: "Asia/Kolkata" } }, day: { $dayOfMonth: { date: "$placedAt", timezone: "Asia/Kolkata" } } },
                totalRevenue: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } },
                orderCount: { $sum: 1 }
            }
        }
    ]);

    for (const s of stats) {
        const slot = filterType === "daily" ? timeline.find(t => t.day === s._id.day && t.month === s._id.month)
            : filterType === "yearly" ? timeline.find(t => t.year === s._id.year)
            : timeline.find(t => t.month === s._id.month && (!t.year || t.year === s._id.year));
        if (slot) { slot.totalRevenue += s.totalRevenue; slot.orderCount += s.orderCount; }
    }

    const [topProducts, topCategories, topBrands] = await Promise.all([
        Order.aggregate([
            { $match: qualifyingSalesMatch }, { $unwind: "$items" }, { $match: { "items.status": { $nin: ["CANCELLED", "RETURNED"] } } },
            { $group: { _id: "$items.productId", productName: { $first: "$items.productName" }, thumbnail: { $first: "$items.thumbnail" }, totalUnitsSold: { $sum: "$items.quantity" }, totalRevenue: { $sum: { $ifNull: ["$items.finalPayable", "$items.lineTotal"] } } } },
            { $sort: { totalUnitsSold: -1 } }, { $limit: 10 }
        ]),
        Order.aggregate([
            { $match: qualifyingSalesMatch }, { $unwind: "$items" }, { $match: { "items.status": { $nin: ["CANCELLED", "RETURNED"] } } },
            { $group: { _id: "$items.categoryId", categoryName: { $first: "$items.categoryName" }, totalUnitsSold: { $sum: "$items.quantity" }, totalRevenue: { $sum: { $ifNull: ["$items.finalPayable", "$items.lineTotal"] } } } },
            { $match: { categoryName: { $nin: [null, ""] } } }, { $sort: { totalUnitsSold: -1 } }, { $limit: 10 }
        ]),
        Order.aggregate([
            { $match: qualifyingSalesMatch }, { $unwind: "$items" }, { $match: { "items.status": { $nin: ["CANCELLED", "RETURNED"] } } },
            { $group: { _id: "$items.brand", brandName: { $first: "$items.brand" }, totalUnitsSold: { $sum: "$items.quantity" }, totalRevenue: { $sum: { $ifNull: ["$items.finalPayable", "$items.lineTotal"] } } } },
            { $match: { _id: { $nin: [null, ""] } } }, { $sort: { totalUnitsSold: -1 } }, { $limit: 10 }
        ])
    ]);

    return { filterType, targetYear, monthlyStats: timeline, topProducts, topCategories, topBrands };
};

const getSalesReportData = async (options = {}) => {
    const { rangeType = "daily", startDate: customStart, endDate: customEnd, page = 1, limit = 15 } = options;
    const { startDate, endDate } = (customStart instanceof Date && customEnd instanceof Date)
        ? { startDate: customStart, endDate: customEnd }
        : getDateRange(rangeType, customStart, customEnd);

    const orders = await Order.find({ orderStatus: { $ne: "FAILED" }, $or: [{ placedAt: { $gte: startDate, $lte: endDate } }, { placedAt: null, createdAt: { $gte: startDate, $lte: endDate } }] })
        .populate("userId", "fullName email")
        .sort({ placedAt: -1, createdAt: -1 })
        .lean();

    let totalGrossAmount = 0, totalOfferDiscount = 0, totalCouponDiscount = 0, totalCollectedRevenue = 0, totalPurchaseRefunds = 0, netSalesRecognized = 0, totalUnitsSold = 0, totalTaxCollected = 0, totalShippingCollected = 0, totalPendingCod = 0;

    const reportRows = orders.map((ord) => {
        const gross = ord.pricing?.subtotal || (ord.items || []).reduce((s, i) => s + (i.lineTotal || 0), 0);
        const offerDisc = ord.pricing?.offerDiscount || 0, couponDisc = ord.pricing?.couponDiscount || 0;
        const tax = ord.pricing?.taxAmount || 0, shipping = ord.pricing?.shippingFee || 0;
        const netPayable = ord.pricing?.currentPayable != null ? ord.pricing.currentPayable : (ord.pricing?.totalAmount || 0);
        const refund = ord.pricing?.walletRefundIssued || ord.pricing?.refundAmount || 0;
        const isDelivered = ord.orderStatus === "DELIVERED";
        const isPaid = ord.paymentStatus === "COMPLETED" || (ord.paymentMethod === "COD" && isDelivered);
        const collected = isPaid ? (ord.pricing?.collectedAmount || netPayable) : 0;
        const pendingCod = (!isDelivered && ord.paymentMethod === "COD") ? netPayable : 0;
        const activeUnits = (ord.items || []).reduce((s, i) => s + (i.status !== "CANCELLED" ? i.quantity : 0), 0);

        totalGrossAmount += gross; totalOfferDiscount += offerDisc; totalCouponDiscount += couponDisc; totalTaxCollected += tax;
        totalShippingCollected += shipping; totalCollectedRevenue += collected; totalPurchaseRefunds += refund; totalPendingCod += pendingCod;
        if (isPaid) netSalesRecognized += Math.max(0, collected - refund);
        totalUnitsSold += activeUnits;

        return {
            _id: ord._id, orderNumber: ord.orderNumber, placedAt: ord.placedAt || ord.createdAt,
            customerName: ord.userId?.fullName || (ord.shippingAddress?.firstName ? `${ord.shippingAddress.firstName} ${ord.shippingAddress.lastName || ""}`.trim() : "Guest"),
            customerEmail: ord.userId?.email || "", paymentMethod: ord.paymentMethod, paymentStatus: ord.paymentStatus, orderStatus: ord.orderStatus,
            grossAmount: gross, offerDiscount: offerDisc, couponDiscount: couponDisc, tax, shipping, refundsOrDeductions: refund,
            netPayable, purchaseCollected: collected, purchaseRefund: refund, netPurchaseReceipts: Math.max(0, collected - refund), pendingCod
        };
    });

    const parsedPage = Math.max(1, parseInt(page, 10) || 1), parsedLimit = Math.max(1, parseInt(limit, 10) || 15);
    const totalPages = Math.ceil(reportRows.length / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const paginatedRows = reportRows.slice((currentPage - 1) * parsedLimit, (currentPage - 1) * parsedLimit + parsedLimit);

    return {
        startDate, endDate, rangeType,
        summary: {
            ordersPlaced: orders.length, totalOrdersCount: orders.length, totalGrossAmount, merchandiseSales: totalGrossAmount,
            totalOfferDiscount, offerDiscounts: totalOfferDiscount, totalCouponDiscount, couponDiscounts: totalCouponDiscount,
            totalDiscounts: totalOfferDiscount + totalCouponDiscount, tax: totalTaxCollected, shipping: totalShippingCollected,
            collectedPayments: totalCollectedRevenue, totalCollectedRevenue, purchaseRefunds: totalPurchaseRefunds, totalPurchaseRefunds,
            netPurchaseReceipts: Math.max(0, totalCollectedRevenue - totalPurchaseRefunds), pendingCod: totalPendingCod, totalPendingCodRevenue: totalPendingCod,
            cancellationsAndReturns: totalPurchaseRefunds, totalRefundsOrCancellations: totalPurchaseRefunds, netSalesRecognized, totalUnitsSold,
            ordersWithInsufficientEvidenceCount: 0, cohortBasis: "ORDER_PLACEMENT"
        },
        orders: paginatedRows, allRows: reportRows, currentPage, totalPages
    };
};

module.exports = {
    getDateRange, formatIstDate, getLastTwoDaysSales, getDashboardAnalytics, getSalesReportData,
    generateSalesExcel: exportService.generateSalesExcel, generateSalesPdf: exportService.generateSalesPdf,
    generateExcelReport: exportService.generateExcelReport, generatePdfReport: exportService.generatePdfReport,
    sanitizeForSpreadsheet: exportService.sanitizeForSpreadsheet, sanitizeSpreadsheetData: exportService.sanitizeSpreadsheetData,
};
