const reportService = require("../../services/admin/reportService");
const { getSalesReportData, } = require("../../services/admin/reportService");


const loadDashboard = async (req, res) => {
    try {
        const filterType = req.query.filterType || "monthly";
        const targetYear = req.query.year ? parseInt(req.query.year, 10) : null;
        const [analytics] = await Promise.all([
            reportService.getDashboardAnalytics(filterType, targetYear),
        ]);

        res.render("admin/dashboard", {
            title: "Dashboard & Analytics | VELORA Admin",
            active: "dashboard",
            filterType,
            targetYear,
            monthlyStats: analytics.monthlyStats,
            topProducts: analytics.topProducts,
            topCategories: analytics.topCategories,
            topBrands: analytics.topBrands,
        });
    } catch (error) {
        console.error("Load Dashboard Error:", error);
        res.status(500).send("Failed to load dashboard.");
    }
};

const loadSalesReport = async (req, res) => {
    try {
        const { rangeType = "daily", startDate, endDate, page = 1 } = req.query;

        const reportData = await reportService.getSalesReportData({
            rangeType,
            startDate,
            endDate,
            page,
            limit: 15,

        });

        res.render("admin/sales-report", {
            title: "Sales Report | VELORA Admin",
            active: "sales-report",
            rangeType: reportData.rangeType,
            startDate: reportService.formatIstDate(reportData.startDate),
            endDate: reportService.formatIstDate(reportData.endDate),
            summary: reportData.summary,
            orders: reportData.orders,
            currentPage: reportData.currentPage,
            totalPages: reportData.totalPages,

        });
    } catch (error) {
        console.error("Load Sales Report Error:", error);
        res.status(500).send("Failed to load sales report.");
    }
};

const exportSalesExcelController = async (req, res) => {
    try {
        const { rangeType = "daily", startDate, endDate } = req.query;
        const reportData = await reportService.getSalesReportData({ rangeType, startDate, endDate });

        const workbook = await reportService.generateSalesExcel(reportData);

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=velora_sales_report_${rangeType}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Export Excel Error:", error);
        res.status(500).send("Failed to export Excel report.");
    }
};

const exportSalesPdfController = async (req, res) => {
    try {
        const { rangeType = "daily", startDate, endDate } = req.query;
        const reportData = await reportService.getSalesReportData({ rangeType, startDate, endDate });

        const pdfBuffer = await reportService.generateSalesPdf(reportData);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=velora_sales_report_${rangeType}.pdf`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error("Export PDF Error:", error);
        res.status(500).send("Failed to export PDF report.");
    }
};

module.exports = {
    loadDashboard,
    loadSalesReport,
    exportSalesExcelController,
    exportSalesPdfController,
};
