const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const formatIstDate = (date) => {
    if (!date) return "";
    return new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

const sanitizeForSpreadsheet = (val) => {
    if (val == null) return "";
    const str = String(val).trim();
    if (/^[=+@-]/i.test(str)) {
        return "'" + str;
    }
    return str;
};

const generateSalesExcel = async (reportData) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "VELORA Admin";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Sales Report");

    sheet.mergeCells("A1:K1");
    const titleCell = sheet.getCell("A1");
    titleCell.value = "VELORA SALES REPORT";
    titleCell.font = { bold: true, size: 16, color: { argb: "FF000000" } };
    titleCell.alignment = { horizontal: "center" };

    sheet.getCell("A2").value = `Period: ${formatIstDate(reportData.startDate)} to ${formatIstDate(reportData.endDate)} (IST) | Basis: Order Placement Cohort`;
    sheet.getCell("A2").font = { italic: true, size: 11 };

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

            doc.fontSize(18).font("Helvetica-Bold").text("VELORA", 35, 35);
            doc.fontSize(10).font("Helvetica").text("Official Sales & Revenue Report", 35, 58);
            doc.fontSize(8.5).text(
                `Report Range: ${formatIstDate(reportData.startDate)} to ${formatIstDate(reportData.endDate)} (Asia/Kolkata) | Basis: Order Placement Cohort`,
                35,
                72
            );

            doc.moveTo(35, 90).lineTo(560, 90).strokeColor("#E5E7EB").stroke();

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

const generateExcelReport = async (options = {}) => {
    const { getSalesReportData } = require("./reportService");
    const data = await getSalesReportData(options);
    const wb = await generateSalesExcel(data);
    return wb.xlsx.writeBuffer();
};

const generatePdfReport = async (options = {}) => {
    const { getSalesReportData } = require("./reportService");
    const data = await getSalesReportData(options);
    return generateSalesPdf(data);
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
    sanitizeForSpreadsheet,
    generateSalesExcel,
    generateSalesPdf,
    generateExcelReport,
    generatePdfReport,
    sanitizeSpreadsheetData,
};
