const mongoose = require("mongoose");
const Offer = require("../../models/product/offerModel");
const Product = require("../../models/product/productModel");
const Category = require("../../models/product/categoryModel");
const escapeRegex = require("../../utils/escapeRegex");

/**
 * Normalizes input date strings to Asia/Kolkata timezone boundaries.
 * Date-only strings ("YYYY-MM-DD") are set to 00:00:00.000+05:30 for start and 23:59:59.999+05:30 for end (Finding 56).
 */
const parseDateBoundary = (dateStr, isEndOfDay = false) => {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;
    const trimmed = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return new Date(`${trimmed}T${isEndOfDay ? "23:59:59.999" : "00:00:00.000"}+05:30`);
    }
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : parsed;
};

const getOffers = async (options = {}) => {
    const { search = "", offerType = "ALL", status = "ALL", page = 1, limit = 10 } = options;

    const filter = {};

    if (offerType && offerType !== "ALL") {
        filter.offerType = offerType;
    }

    if (status === "ACTIVE") {
        filter.isActive = true;
    } else if (status === "INACTIVE") {
        filter.isActive = false;
    }

    if (typeof search === "string" && search.trim()) {
        const escaped = escapeRegex(search.trim());
        filter.name = { $regex: escaped, $options: "i" };
    }

    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 10));

    const totalOffers = await Offer.countDocuments(filter);
    const totalPages = Math.ceil(totalOffers / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const skip = (currentPage - 1) * parsedLimit;

    const offers = await Offer.find(filter)
        .populate("productId", "name thumbnail brand")
        .populate("productIds", "name thumbnail brand")
        .populate("categoryId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean();

    return {
        success: true,
        offers,
        totalOffers,
        totalPages,
        currentPage,
        search,
        offerType,
        status,
    };
};

const createOffer = async (data) => {
    const {
        name,
        offerType,
        productId,
        categoryId,
        discountType = "PERCENTAGE",
        discountValue,
        maxDiscount,
        startDate,
        endDate,
    } = data;

    if (!name || typeof name !== "string" || !name.trim()) {
        return { success: false, message: "Offer title is required." };
    }

    if (!["PRODUCT", "CATEGORY"].includes(offerType)) {
        return { success: false, message: "Invalid offer type. Must be PRODUCT or CATEGORY." };
    }

    if (offerType === "PRODUCT") {
        let validProductIds = [];
        if (Array.isArray(data.productIds) && data.productIds.length > 0) {
            validProductIds = data.productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        } else if (typeof data.productIds === "string" && data.productIds.trim()) {
            validProductIds = data.productIds.split(",").map((s) => s.trim()).filter((id) => mongoose.Types.ObjectId.isValid(id));
        } else if (productId && mongoose.Types.ObjectId.isValid(productId)) {
            validProductIds = [productId];
        }

        if (validProductIds.length === 0) {
            return { success: false, message: "Please select at least one valid product." };
        }
        const existingCount = await Product.countDocuments({ _id: { $in: validProductIds }, isDeleted: false });
        if (existingCount !== validProductIds.length) {
            return { success: false, message: "One or more selected products do not exist or are deleted." };
        }
        data.parsedProductIds = validProductIds;
    }

    if (offerType === "CATEGORY") {
        if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
            return { success: false, message: "Please select a valid category." };
        }
        const exists = await Category.exists({ _id: categoryId, isDeleted: false });
        if (!exists) return { success: false, message: "Selected category does not exist." };
    }

    if (!["PERCENTAGE", "FLAT"].includes(discountType)) {
        return { success: false, message: "Invalid discount type. Must be PERCENTAGE or FLAT." };
    }

    const numValue = Number(discountValue);
    if (!Number.isFinite(numValue) || numValue <= 0) {
        return { success: false, message: "Discount value must be a positive number." };
    }

    if (discountType === "PERCENTAGE" && numValue > 90) {
        return { success: false, message: "Percentage discount cannot exceed 90%." };
    }

    if (!startDate || !endDate) {
        return { success: false, message: "Both start and end dates are required." };
    }

    const start = parseDateBoundary(startDate, false);
    const end = parseDateBoundary(endDate, true);
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
        return { success: false, message: "Invalid date format." };
    }

    if (start > end) {
        return { success: false, message: "Start date must be on or before end date." };
    }

    let parsedMaxDiscount = null;
    if (maxDiscount !== undefined && maxDiscount !== null && String(maxDiscount).trim() !== "") {
        const numMax = Number(maxDiscount);
        if (!Number.isFinite(numMax) || numMax <= 0) {
            return { success: false, message: "Maximum discount must be a positive number." };
        }
        parsedMaxDiscount = numMax;
    }

    const offer = await Offer.create({
        name: name.trim(),
        offerType,
        productId: offerType === "PRODUCT" ? (data.parsedProductIds ? data.parsedProductIds[0] : productId) : null,
        productIds: offerType === "PRODUCT" ? (data.parsedProductIds || [productId]) : [],
        categoryId: offerType === "CATEGORY" ? categoryId : null,
        discountType,
        discountValue: numValue,
        maxDiscount: parsedMaxDiscount,
        startDate: start,
        endDate: end,
        isActive: true,
    });

    return { success: true, message: "Offer created successfully.", offer };
};

const updateOffer = async (offerId, data) => {
    if (!offerId || !mongoose.Types.ObjectId.isValid(offerId)) {
        return { success: false, message: "Invalid offer ID." };
    }

    const offer = await Offer.findById(offerId);
    if (!offer) {
        return { success: false, message: "Offer not found." };
    }

    const {
        name,
        offerType,
        productId,
        categoryId,
        discountType,
        discountValue,
        maxDiscount,
        startDate,
        endDate,
    } = data;

    // Finding 55: Validate all fields on update
    if (name !== undefined) {
        if (!name || typeof name !== "string" || !name.trim()) {
            return { success: false, message: "Offer title cannot be empty." };
        }
        offer.name = name.trim();
    }

    const newOfferType = offerType || offer.offerType;
    if (!["PRODUCT", "CATEGORY"].includes(newOfferType)) {
        return { success: false, message: "Invalid offer type. Must be PRODUCT or CATEGORY." };
    }
    offer.offerType = newOfferType;

    if (newOfferType === "PRODUCT") {
        let validProductIds = [];
        if (Array.isArray(data.productIds) && data.productIds.length > 0) {
            validProductIds = data.productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        } else if (typeof data.productIds === "string" && data.productIds.trim()) {
            validProductIds = data.productIds.split(",").map((s) => s.trim()).filter((id) => mongoose.Types.ObjectId.isValid(id));
        } else if (productId && mongoose.Types.ObjectId.isValid(productId)) {
            validProductIds = [productId];
        } else if (offer.productIds && offer.productIds.length > 0) {
            validProductIds = offer.productIds.map(String).filter((id) => mongoose.Types.ObjectId.isValid(id));
        } else if (offer.productId) {
            validProductIds = [offer.productId];
        }

        if (validProductIds.length === 0) {
            return { success: false, message: "Please select at least one valid product." };
        }
        const existingCount = await Product.countDocuments({ _id: { $in: validProductIds }, isDeleted: false });
        if (existingCount !== validProductIds.length) {
            return { success: false, message: "One or more selected products do not exist or are deleted." };
        }
        offer.productId = validProductIds[0];
        offer.productIds = validProductIds;
        offer.categoryId = null;
    } else if (newOfferType === "CATEGORY") {
        const cId = categoryId || offer.categoryId;
        if (!cId || !mongoose.Types.ObjectId.isValid(cId)) {
            return { success: false, message: "Please select a valid category." };
        }
        const exists = await Category.exists({ _id: cId, isDeleted: false });
        if (!exists) return { success: false, message: "Selected category does not exist." };
        offer.categoryId = cId;
        offer.productId = null;
    }

    const newDiscountType = discountType || offer.discountType;
    if (!["PERCENTAGE", "FLAT"].includes(newDiscountType)) {
        return { success: false, message: "Invalid discount type. Must be PERCENTAGE or FLAT." };
    }
    offer.discountType = newDiscountType;

    const valToValidate = discountValue !== undefined ? discountValue : offer.discountValue;
    const numValue = Number(valToValidate);
    if (!Number.isFinite(numValue) || numValue <= 0) {
        return { success: false, message: "Discount value must be a positive number." };
    }
    if (newDiscountType === "PERCENTAGE" && numValue > 90) {
        return { success: false, message: "Percentage discount cannot exceed 90%." };
    }
    offer.discountValue = numValue;

    if (maxDiscount !== undefined) {
        if (maxDiscount !== null && String(maxDiscount).trim() !== "") {
            const numMax = Number(maxDiscount);
            if (!Number.isFinite(numMax) || numMax <= 0) {
                return { success: false, message: "Maximum discount must be a positive number." };
            }
            offer.maxDiscount = numMax;
        } else {
            offer.maxDiscount = null;
        }
    }

    const newStart = startDate ? parseDateBoundary(startDate, false) : offer.startDate;
    const newEnd = endDate ? parseDateBoundary(endDate, true) : offer.endDate;

    if (!newStart || !newEnd || isNaN(newStart.getTime()) || isNaN(newEnd.getTime())) {
        return { success: false, message: "Invalid date format." };
    }
    if (newStart > newEnd) {
        return { success: false, message: "Start date must be on or before end date." };
    }
    offer.startDate = newStart;
    offer.endDate = newEnd;

    await offer.save();
    return { success: true, message: "Offer updated successfully.", offer };
};

const toggleOfferStatus = async (offerId) => {
    if (!offerId || !mongoose.Types.ObjectId.isValid(offerId)) {
        return { success: false, message: "Invalid offer ID." };
    }

    const offer = await Offer.findById(offerId);
    if (!offer) {
        return { success: false, message: "Offer not found." };
    }

    offer.isActive = !offer.isActive;
    await offer.save();

    return {
        success: true,
        message: `Offer ${offer.isActive ? "activated" : "deactivated"} successfully.`,
        isActive: offer.isActive,
    };
};

const getOfferById = async (offerId) => {
    if (!offerId || !mongoose.Types.ObjectId.isValid(offerId)) {
        return { success: false, message: "Invalid offer ID." };
    }
    const offer = await Offer.findById(offerId).populate("productId", "name brand").populate("categoryId", "name").lean();
    if (!offer) {
        return { success: false, message: "Offer not found." };
    }
    return { success: true, offer };
};

const deleteOffer = async (offerId) => {
    if (!offerId || !mongoose.Types.ObjectId.isValid(offerId)) {
        return { success: false, message: "Invalid offer ID." };
    }

    await Offer.findByIdAndDelete(offerId);
    return { success: true, message: "Offer deleted successfully." };
};

module.exports = {
    parseDateBoundary,
    getOffers,
    getOfferById,
    createOffer,
    updateOffer,
    toggleOfferStatus,
    deleteOffer,
};
