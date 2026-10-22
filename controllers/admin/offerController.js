const offerService = require("../../services/admin/offerService");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");

const loadOffers = async (req, res) => {
    try {
        const { search = "", offerType = "ALL", status = "ALL", page = 1 } = req.query;

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
        });
    } catch (error) {
        console.error("Load Offers Error:", error);
        res.status(500).send("Failed to load offers.");
    }
};

const createOfferController = async (req, res) => {
    try {
        const result = await offerService.createOffer(req.body);
        if (req.xhr || req.headers.accept?.includes("json")) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        res.redirect("/admin/offers");
    } catch (error) {
        console.error("Create Offer Error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
};

const updateOfferController = async (req, res) => {
    try {
        const { offerId } = req.params;
        const result = await offerService.updateOffer(offerId, req.body);
        if (req.xhr || req.headers.accept?.includes("json")) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        res.redirect("/admin/offers");
    } catch (error) {
        console.error("Update Offer Error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
};

const toggleOfferStatusController = async (req, res) => {
    try {
        const { offerId } = req.params;
        const result = await offerService.toggleOfferStatus(offerId);
        if (req.xhr || req.headers.accept?.includes("json")) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        res.redirect("/admin/offers");
    } catch (error) {
        console.error("Toggle Offer Error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
};

const deleteOfferController = async (req, res) => {
    try {
        const { offerId } = req.params;
        const result = await offerService.deleteOffer(offerId);
        if (req.xhr || req.headers.accept?.includes("json")) {
            return res.status(result.success ? 200 : 400).json(result);
        }
        res.redirect("/admin/offers");
    } catch (error) {
        console.error("Delete Offer Error:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
};

module.exports = {
    loadOffers,
    createOfferController,
    updateOfferController,
    toggleOfferStatusController,
    deleteOfferController,
};
