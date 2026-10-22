const Order = require("../../models/order/orderModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

/**
 * Returns Start and End dates aligned with Asia/Kolkata timezone (UTC+5:30)
 */
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
 * Fetches sales report metrics and order breakdown within date boundaries.
 * Recognizes completed and refunded purchases, preserving sales history.
 */
const getSalesReportData = async (options = {}) => {
    const { rangeType = "daily", startDate: customStart, endDate: customEnd, page = 1, limit = 15 } = options;
    const { startDate, endDate } = getDateRange(rangeType, customStart, customEnd);

    // Retain historical purchases including fully refunded and partially refunded orders
    const orderFilter = {
        placedAt: { $gte: startDate, $lte: endDate },
        orderStatus: { $ne: "FAILED" },
        $or: [
            { paymentStatus: { $in: ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"] } },
            { paymentMethod: "COD", orderStatus: { $nin: ["FAILED"] } },
        ],
    };

    const orders = await Order.find(orderFilter)
        .populate("userId", "fullName email")
        .sort({ placedAt: -1 })
        .lean();

    let totalOrdersCount = orders.length;
    let totalGrossAmount = 0;
    let totalOfferDiscount = 0;
    let totalCouponDiscount = 0;
    let totalRefundsOrCancellations = 0;
    let netSalesRecognized = 0;
    let totalUnitsSold = 0;
    let totalCollectedRevenue = 0;
    let totalPendingCodRevenue = 0;

    const reportRows = orders.map((ord) => {
        // True pre-discount gross order amount
        const grossAmount = (ord.pricing?.originalSubtotal != null ? ord.pricing.originalSubtotal : (ord.pricing?.subtotal || 0))
            + (ord.pricing?.originalShippingFee != null ? ord.pricing.originalShippingFee : (ord.pricing?.shippingFee || 0));

        const offerDisc = ord.pricing?.offerDiscount || 0;
        const couponDisc = ord.pricing?.couponDiscount || 0;
        const cancellationDeduction = ord.pricing?.cancellationDeduction || 0;
        const returnCredit = ord.pricing?.returnCredit || 0;
        const deduction = cancellationDeduction + returnCredit;

        // Active delivered/processing units
        const activeItems = (ord.items || []).filter((i) => !["CANCELLED", "RETURNED"].includes(i.status));
        const orderUnits = activeItems.reduce((sum, i) => sum + i.quantity, 0);
        const orderNet = ord.pricing?.currentPayable != null
            ? ord.pricing.currentPayable
            : Math.max(0, (ord.pricing?.totalAmount || grossAmount) - deduction);

        const isPaid = ord.paymentStatus === "COMPLETED" || (ord.paymentMethod === "COD" && ord.orderStatus === "DELIVERED");
        const isPendingCod = ord.paymentMethod === "COD" && ord.paymentStatus === "PENDING" && ord.orderStatus !== "DELIVERED" && ord.orderStatus !== "CANCELLED";

        totalGrossAmount += grossAmount;
        totalOfferDiscount += offerDisc;
        totalCouponDiscount += couponDisc;
        totalRefundsOrCancellations += deduction;
        totalUnitsSold += orderUnits;

        if (isPaid) {
            netSalesRecognized += orderNet;
            totalCollectedRevenue += orderNet;
        } else if (isPendingCod) {
            totalPendingCodRevenue += orderNet;
        }

        return {
            _id: ord._id,
            orderNumber: ord.orderNumber,
            placedAt: ord.placedAt,
            customerName: ord.userId?.fullName || "Customer",
            customerEmail: ord.userId?.email || "N/A",
            paymentMethod: ord.paymentMethod,
            paymentStatus: ord.paymentStatus,
            orderStatus: ord.orderStatus,
            grossAmount,
            offerDiscount: offerDisc,
            couponDiscount: couponDisc,
            refundsOrDeductions: deduction,
            netPayable: orderNet,
            unitsCount: orderUnits,
            isCollected: isPaid,
        };
    });

    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 15));
    const totalPages = Math.ceil(reportRows.length / parsedLimit) || 1;
    const parsedPage = Math.max(1, Number(page) || 1);
    const currentPage = Math.min(parsedPage, totalPages);
    const paginatedRows = reportRows.slice((currentPage - 1) * parsedLimit, currentPage * parsedLimit);

    return {
        rangeType,
        startDate,
        endDate,
        summary: {
            totalOrdersCount,
            totalGrossAmount,
            totalOfferDiscount,
            totalCouponDiscount,
            totalRefundsOrCancellations,
            netSalesRecognized,
            totalCollectedRevenue,
            totalPendingCodRevenue,
            totalUnitsSold,
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
    sheet.getCell("A2").value = `Period: ${formatIstDate(reportData.startDate)} to ${formatIstDate(reportData.endDate)} (IST)`;
    sheet.getCell("A2").font = { italic: true, size: 11 };

    // Summary Section
    sheet.addRow([]);
    sheet.addRow(["SUMMARY METRICS"]);
    sheet.addRow(["Total Orders Placed", reportData.summary.totalOrdersCount]);
    sheet.addRow(["Net Units Sold", reportData.summary.totalUnitsSold]);
    sheet.addRow(["Gross Order Amount (₹)", reportData.summary.totalGrossAmount]);
    sheet.addRow(["Offer Discounts (₹)", reportData.summary.totalOfferDiscount]);
    sheet.addRow(["Coupon Discounts (₹)", reportData.summary.totalCouponDiscount]);
    sheet.addRow(["Refunds / Cancellations (₹)", reportData.summary.totalRefundsOrCancellations]);
    sheet.addRow(["Net Sales Recognized (₹)", reportData.summary.netSalesRecognized]);
    sheet.addRow([]);

    // Table Header
    const headerRow = sheet.addRow([
        "Order Number",
        "Placed Date",
        "Customer",
        "Payment Method",
        "Payment Status",
        "Order Status",
        "Gross (₹)",
        "Offer Disc (₹)",
        "Coupon Disc (₹)",
        "Deductions (₹)",
        "Net Sales (₹)",
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
            row.grossAmount,
            row.offerDiscount,
            row.couponDiscount,
            row.refundsOrDeductions,
            row.netPayable,
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

/**
 * Generates a clean PDF document for the sales report with deduction breakdown.
 */
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
                `Report Range: ${formatIstDate(reportData.startDate)} to ${formatIstDate(reportData.endDate)} (Asia/Kolkata)`,
                35,
                72
            );

            doc.moveTo(35, 90).lineTo(560, 90).strokeColor("#E5E7EB").stroke();

            // Summary Grid
            doc.fontSize(10).font("Helvetica-Bold").text("EXECUTIVE SUMMARY", 35, 102);
            doc.font("Helvetica").fontSize(8.5);

            const s = reportData.summary;
            doc.text(`Total Orders: ${s.totalOrdersCount}`, 35, 120);
            doc.text(`Units Sold: ${s.totalUnitsSold}`, 160, 120);
            doc.text(`Gross Revenue: ₹${s.totalGrossAmount.toLocaleString("en-IN")}`, 320, 120);

            doc.text(`Offer Discounts: ₹${s.totalOfferDiscount.toLocaleString("en-IN")}`, 35, 138);
            doc.text(`Coupon Discounts: ₹${s.totalCouponDiscount.toLocaleString("en-IN")}`, 160, 138);
            doc.text(`Cancellations/Returns: ₹${s.totalRefundsOrCancellations.toLocaleString("en-IN")}`, 320, 138);

            doc.font("Helvetica-Bold").text(`Net Recognized Sales: ₹${s.netSalesRecognized.toLocaleString("en-IN")}`, 35, 156);

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

/**
 * Fetches dashboard analytics: monthly or yearly revenue, order volume, and top 10 products, categories, brands.
 * Filters out unpaid orders and deducts cancellations/returns.
 */
const getDashboardAnalytics = async (filterType = "monthly", targetYear = null) => {
    const now = new Date();
    const qualifyingSalesMatch = {
        orderStatus: { $nin: ["CANCELLED", "FAILED"] },
        $or: [
            { paymentStatus: "COMPLETED" },
            { paymentMethod: "COD", orderStatus: "DELIVERED" },
        ],
    };

    let timeMatch = {};
    let groupId = {};

    if (filterType === "yearly") {
        const fiveYearsAgo = new Date();
        fiveYearsAgo.setFullYear(now.getFullYear() - 5);
        timeMatch = { placedAt: { $gte: fiveYearsAgo } };
        groupId = { year: { $year: "$placedAt" } };
    } else {
        // Monthly
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        timeMatch = { placedAt: { $gte: oneYearAgo } };
        groupId = {
            year: { $year: "$placedAt" },
            month: { $month: "$placedAt" },
        };
    }

    // Revenue aggregation using currentPayable (deducts cancellations/returns)
    const monthlyStats = await Order.aggregate([
        {
            $match: {
                ...timeMatch,
                ...qualifyingSalesMatch,
            },
        },
        {
            $group: {
                _id: groupId,
                totalRevenue: { $sum: { $ifNull: ["$pricing.currentPayable", "$pricing.totalAmount"] } },
                orderCount: { $sum: 1 },
            },
        },
        { $sort: { "_id.year": 1, ...("_id.month" ? { "_id.month": 1 } : {}) } },
    ]);

    // Top 10 Best Selling Products (by quantity sold in qualifying sales)
    const topProducts = await Order.aggregate([
        {
            $match: qualifyingSalesMatch,
        },
        { $unwind: "$items" },
        {
            $match: {
                "items.status": { $nin: ["CANCELLED", "RETURNED"] },
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
            $match: qualifyingSalesMatch,
        },
        { $unwind: "$items" },
        {
            $match: {
                "items.status": { $nin: ["CANCELLED", "RETURNED"] },
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
            $match: qualifyingSalesMatch,
        },
        { $unwind: "$items" },
        {
            $match: {
                "items.status": { $nin: ["CANCELLED", "RETURNED"] },
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

module.exports = {
    getDateRange,
    formatIstDate,
    getSalesReportData,
    generateSalesExcel,
    generateSalesPdf,
    generateExcelReport,
    generatePdfReport,
    getTopBestSellers,
    getDashboardAnalytics,
    getSalesReportMetrics,
    sanitizeForSpreadsheet,
    sanitizeSpreadsheetData,
};
