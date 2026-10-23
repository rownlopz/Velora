const offerService = require("../../services/admin/offerService");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");

const isAjaxRequest = (req) => {
    return Boolean(
        req.xhr ||
        (req.headers.accept && req.headers.accept.includes("application/json")) ||
        req.headers["x-requested-with"] === "XMLHttpRequest" ||
        req.is("json")
    );
};

const loadOffers = async (req, res) => {
    try {
        const { search = "", offerType = "ALL", status = "ALL", page = 1 } = req.query;
        const successMessage = req.query.success || null;
        const errorMessage = req.query.error || null;

        const [offersResult, products, categories] = await Promise.all([
            offerService.getOffers({ search, offerType, status, page, limit: 10 }),
            Product.find({ isDeleted: false, status: "ACTIVE" }).select("name brand").lean(),
            Category.find({ isDeleted: false, isActive: true }).select("name").lean(),
        ]);

        res.render("admin/offers", {
            title: "Offer Management | VELORA Admin",
            active: "offers",
            offers: offersResult.offers,
            totalOffers: offersResult.totalOffers,
            totalPages: offersResult.totalPages,
            currentPage: offersResult.currentPage,
            search: offersResult.search,
            offerType: offersResult.offerType,
            status: offersResult.status,
            products,
            categories,
            successMessage,
            errorMessage,
        });
    } catch (error) {
        console.error("Load Offers Error:", error);
        res.status(500).send("Failed to load offers.");
    }
};

const createOfferController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const result = await offerService.createOffer(req.body);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        const queryParam = result.success ? "success" : "error";
        res.redirect(`/admin/offers?${queryParam}=${encodeURIComponent(result.message || (result.success ? "Offer created successfully." : "Failed to create offer."))}`);
    } catch (error) {
        console.error("Create Offer Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/offers?error=${encodeURIComponent("Internal server error.")}`);
    }
};

const updateOfferController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const { offerId } = req.params;
        const result = await offerService.updateOffer(offerId, req.body);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        const queryParam = result.success ? "success" : "error";
        res.redirect(`/admin/offers?${queryParam}=${encodeURIComponent(result.message || (result.success ? "Offer updated successfully." : "Failed to update offer."))}`);
    } catch (error) {
        console.error("Update Offer Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/offers?error=${encodeURIComponent("Internal server error.")}`);
    }
};

const getOfferController = async (req, res) => {
    try {
        const { offerId } = req.params;
        const result = await offerService.getOfferById(offerId);
        return res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
        console.error("Get Offer Error:", error);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
};

const toggleOfferStatusController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const { offerId } = req.params;
        const result = await offerService.toggleOfferStatus(offerId);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        const queryParam = result.success ? "success" : "error";
        res.redirect(`/admin/offers?${queryParam}=${encodeURIComponent(result.message || "Offer status updated.")}`);
    } catch (error) {
        console.error("Toggle Offer Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/offers?error=${encodeURIComponent("Internal server error.")}`);
    }
};

const deleteOfferController = async (req, res) => {
    const isAjax = isAjaxRequest(req);
    try {
        const { offerId } = req.params;
        const result = await offerService.deleteOffer(offerId);
        if (isAjax) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        const queryParam = result.success ? "success" : "error";
        res.redirect(`/admin/offers?${queryParam}=${encodeURIComponent(result.message || "Offer deleted successfully.")}`);
    } catch (error) {
        console.error("Delete Offer Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error." });
        }
        res.redirect(`/admin/offers?error=${encodeURIComponent("Internal server error.")}`);
    }
};

module.exports = {
    loadOffers,
    createOfferController,
    updateOfferController,
    getOfferController,
    toggleOfferStatusController,
    deleteOfferController,
};
