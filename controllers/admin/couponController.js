const couponService = require("../../services/admin/couponService");

const isAjaxRequest = (req) => {
    return Boolean(
        req.xhr ||
        req.headers["x-requested-with"] === "XMLHttpRequest" ||
        req.headers.accept?.includes("application/json") ||
        req.headers.accept?.includes("json")
    );
};

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
            successMessage: req.query.success || null,
            errorMessage: req.query.error || null,
        });
    } catch (error) {
        console.error("Load Coupons Error:", error);
        res.status(500).send("Failed to load coupons.");
    }
};

const createCouponController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const result = await couponService.createCoupon(req.body);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        if (!result.success) {
            return res.redirect(`/admin/coupons?error=${encodeURIComponent(result.message || "Failed to create coupon.")}`);
        }
        res.redirect(`/admin/coupons?success=${encodeURIComponent(result.message || "Coupon created successfully.")}`);
    } catch (error) {
        console.error("Create Coupon Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/coupons?error=${encodeURIComponent("Internal server error.")}`);
    }
};

const toggleCouponStatusController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const { couponId } = req.params;
        const result = await couponService.toggleCouponStatus(couponId);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        const queryParam = result.success ? "success" : "error";
        res.redirect(`/admin/coupons?${queryParam}=${encodeURIComponent(result.message)}`);
    } catch (error) {
        console.error("Toggle Coupon Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/coupons?error=${encodeURIComponent("Internal server error.")}`);
    }
};

const deleteCouponController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const { couponId } = req.params;
        const result = await couponService.deleteCoupon(couponId);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        const queryParam = result.success ? "success" : "error";
        res.redirect(`/admin/coupons?${queryParam}=${encodeURIComponent(result.message)}`);
    } catch (error) {
        console.error("Delete Coupon Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/coupons?error=${encodeURIComponent("Internal server error.")}`);
    }
};

const updateCouponController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const { couponId } = req.params;
        const result = await couponService.updateCoupon(couponId, req.body);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        if (!result.success) {
            return res.redirect(`/admin/coupons?error=${encodeURIComponent(result.message || "Failed to update coupon.")}`);
        }
        res.redirect(`/admin/coupons?success=${encodeURIComponent(result.message || "Coupon updated successfully.")}`);
    } catch (error) {
        console.error("Update Coupon Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/coupons?error=${encodeURIComponent("Internal server error.")}`);
    }
};

const getCouponController = async (req, res) => {
    try {
        const { couponId } = req.params;
        const result = await couponService.getCouponById(couponId);
        return res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
        console.error("Get Coupon Error:", error);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
};

module.exports = {
    loadCoupons,
    createCouponController,
    updateCouponController,
    getCouponController,
    toggleCouponStatusController,
    deleteCouponController,
};
