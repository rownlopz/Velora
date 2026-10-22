const couponService = require("../../services/admin/couponService");

const loadCoupons = async (req, res) => {
    try {
        const { search = "", status = "ALL", page = 1 } = req.query;

        const result = await couponService.getCoupons({ search, status, page, limit: 10 });

        res.render("admin/coupons", {
            title: "Coupon Management | VELORA Admin",
            active: "coupons",
            coupons: result.coupons,
            totalCoupons: result.totalCoupons,
            totalPages: result.totalPages,
            currentPage: result.currentPage,
            search: result.search,
            status: result.status,
        });
    } catch (error) {
        console.error("Load Coupons Error:", error);
        res.status(500).send("Failed to load coupons.");
    }
};

const createCouponController = async (req, res) => {
    try {
        const result = await couponService.createCoupon(req.body);
        if (req.xhr || req.headers.accept?.includes("json")) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        res.redirect("/admin/coupons");
    } catch (error) {
        console.error("Create Coupon Error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
};

const toggleCouponStatusController = async (req, res) => {
    try {
        const { couponId } = req.params;
        const result = await couponService.toggleCouponStatus(couponId);
        if (req.xhr || req.headers.accept?.includes("json")) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        res.redirect("/admin/coupons");
    } catch (error) {
        console.error("Toggle Coupon Error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
};

const deleteCouponController = async (req, res) => {
    try {
        const { couponId } = req.params;
        const result = await couponService.deleteCoupon(couponId);
        if (req.xhr || req.headers.accept?.includes("json")) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        res.redirect("/admin/coupons");
    } catch (error) {
        console.error("Delete Coupon Error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
};

module.exports = {
    loadCoupons,
    createCouponController,
    toggleCouponStatusController,
    deleteCouponController,
};
