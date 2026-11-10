const mongoose = require("mongoose");
const Coupon = require("../../models/order/couponModel");
const escapeRegex = require("../../utils/escapeRegex");

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

const getCoupons = async (options = {}) => {
    const { search = "", status = "ALL", page = 1, limit = 10 } = options;

    const filter = {};

    if (status === "ACTIVE") {
        filter.isActive = true;
    } else if (status === "INACTIVE") {
        filter.isActive = false;
    }

    if (typeof search === "string" && search.trim()) {
        const escaped = escapeRegex(search.trim());
        filter.$or = [
            { code: { $regex: escaped, $options: "i" } },
            { description: { $regex: escaped, $options: "i" } },
        ];
    }

    const parsedPage = Math.max(1, Number(page) || 1);
    const parsedLimit = Math.max(1, Math.min(100, Number(limit) || 10));

    const totalCoupons = await Coupon.countDocuments(filter);
    const totalPages = Math.ceil(totalCoupons / parsedLimit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const skip = (currentPage - 1) * parsedLimit;

    const coupons = await Coupon.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean();

    return {
        success: true,
        coupons,
        totalCoupons,
        totalPages,
        currentPage,
        search,
        status,
    };
};

const createCoupon = async (data) => {
    const {
        code,
        description = "",
        discountType = "PERCENTAGE",
        discountValue,
        minPurchase = 0,
        maxDiscount,
        usageLimit,
        perUserLimit = 1,
        startDate,
        endDate,
    } = data || {};

    if (!code || typeof code !== "string" || !code.trim()) {
        return { success: false, message: "Coupon code is required." };
    }

    const normalizedCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(normalizedCode)) {
        return {
            success: false,
            message: "Coupon code must be 3-20 characters long and contain only uppercase letters, numbers, hyphens, and underscores.",
        };
    }

    const existing = await Coupon.findOne({
        code: { $regex: new RegExp(`^${escapeRegex(normalizedCode)}$`, "i") },
    });
    if (existing) {
        return { success: false, message: `Coupon with code "${normalizedCode}" already exists.` };
    }

    if (!["PERCENTAGE", "FLAT"].includes(discountType)) {
        return { success: false, message: "Invalid discount type. Must be PERCENTAGE or FLAT." };
    }

    const numValue = Number(discountValue);
    if (!Number.isFinite(numValue) || numValue <= 0) {
        return { success: false, message: "Discount value must be a positive number." };
    }

    if (discountType === "PERCENTAGE" && numValue > 100) {
        return { success: false, message: "Percentage discount cannot exceed 100%." };
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

    let numMinPurchase = 0;
    if (minPurchase !== undefined && minPurchase !== null && String(minPurchase).trim() !== "") {
        const parsedMin = Number(minPurchase);
        if (!Number.isFinite(parsedMin) || parsedMin < 0) {
            return { success: false, message: "Minimum purchase amount must be a finite, non-negative number." };
        }
        numMinPurchase = Math.round(parsedMin * 100) / 100;
    }

    let parsedMaxDiscount = null;
    if (discountType === "PERCENTAGE" && maxDiscount !== undefined && maxDiscount !== null && String(maxDiscount).trim() !== "") {
        const numMax = Number(maxDiscount);
        if (!Number.isFinite(numMax) || numMax <= 0) {
            return { success: false, message: "Maximum discount must be a positive number." };
        }
        parsedMaxDiscount = Math.round(numMax * 100) / 100;
    }

    let parsedUsageLimit = null;
    if (usageLimit !== undefined && usageLimit !== null && String(usageLimit).trim() !== "") {
        const numLimit = Number(usageLimit);
        if (!Number.isInteger(numLimit) || numLimit < 1) {
            return { success: false, message: "Usage limit must be a positive integer (at least 1)." };
        }
        parsedUsageLimit = numLimit;
    }

    let parsedPerUser = 1;
    if (perUserLimit !== undefined && perUserLimit !== null && String(perUserLimit).trim() !== "") {
        const numPerUser = Number(perUserLimit);
        if (!Number.isInteger(numPerUser) || numPerUser < 1) {
            return { success: false, message: "Per-user limit must be a positive integer (at least 1)." };
        }
        parsedPerUser = numPerUser;
    }

    try {
        const coupon = await Coupon.create({
            code: normalizedCode,
            description: typeof description === "string" ? description.trim() : "",
            discountType,
            discountValue: Math.round(numValue * 100) / 100,
            minPurchase: numMinPurchase,
            maxDiscount: parsedMaxDiscount,
            usageLimit: parsedUsageLimit,
            perUserLimit: parsedPerUser,
            startDate: start,
            endDate: end,
            isActive: true,
        });

        return { success: true, message: "Coupon created successfully.", coupon };
    } catch (dbErr) {
        if (dbErr.code === 11000) {
            return { success: false, message: `Coupon with code "${normalizedCode}" already exists.` };
        }
        if (dbErr.name === "ValidationError") {
            const errorMessages = Object.values(dbErr.errors).map((e) => e.message).join(" ");
            return { success: false, message: errorMessages || "Database validation failed." };
        }
        throw dbErr;
    }
};

const getCouponById = async (couponId) => {
    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
        return { success: false, message: "Invalid coupon ID." };
    }
    const coupon = await Coupon.findById(couponId).lean();
    if (!coupon) {
        return { success: false, message: "Coupon not found." };
    }
    return { success: true, coupon };
};

const updateCoupon = async (couponId, data = {}) => {
    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
        return { success: false, message: "Invalid coupon ID." };
    }

    const coupon = await Coupon.findById(couponId);
    if (!coupon) {
        return { success: false, message: "Coupon not found." };
    }

    const {
        code,
        description,
        discountType,
        discountValue,
        minPurchase,
        maxDiscount,
        usageLimit,
        perUserLimit,
        startDate,
        endDate,
    } = data;

    let normalizedCode = coupon.code;
    if (code !== undefined) {
        if (!code || typeof code !== "string" || !code.trim()) {
            return { success: false, message: "Coupon code is required." };
        }
        normalizedCode = code.trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,20}$/.test(normalizedCode)) {
            return {
                success: false,
                message: "Coupon code must be 3-20 characters long and contain only uppercase letters, numbers, hyphens, and underscores.",
            };
        }

        const existing = await Coupon.findOne({
            _id: { $ne: couponId },
            code: { $regex: new RegExp(`^${escapeRegex(normalizedCode)}$`, "i") },
        });
        if (existing) {
            return { success: false, message: `Coupon with code "${normalizedCode}" already exists.` };
        }
    }

    const newDiscountType = discountType !== undefined ? discountType : coupon.discountType;
    if (!["PERCENTAGE", "FLAT"].includes(newDiscountType)) {
        return { success: false, message: "Invalid discount type. Must be PERCENTAGE or FLAT." };
    }

    const valToValidate = discountValue !== undefined ? discountValue : coupon.discountValue;
    const numValue = Number(valToValidate);
    if (!Number.isFinite(numValue) || numValue <= 0) {
        return { success: false, message: "Discount value must be a positive number." };
    }
    if (newDiscountType === "PERCENTAGE" && numValue > 100) {
        return { success: false, message: "Percentage discount cannot exceed 100%." };
    }

    let numMinPurchase = coupon.minPurchase;
    if (minPurchase !== undefined) {
        const parsedMin = Number(minPurchase);
        if (!Number.isFinite(parsedMin) || parsedMin < 0) {
            return { success: false, message: "Minimum purchase amount must be a finite, non-negative number." };
        }
        numMinPurchase = Math.round(parsedMin * 100) / 100;
    }

    let parsedMaxDiscount = coupon.maxDiscount;
    if (newDiscountType === "FLAT") {
        parsedMaxDiscount = null;
    } else if (maxDiscount !== undefined) {
        if (maxDiscount !== null && String(maxDiscount).trim() !== "") {
            const numMax = Number(maxDiscount);
            if (!Number.isFinite(numMax) || numMax <= 0) {
                return { success: false, message: "Maximum discount must be a positive number." };
            }
            parsedMaxDiscount = Math.round(numMax * 100) / 100;
        } else {
            parsedMaxDiscount = null;
        }
    }

    let parsedUsageLimit = coupon.usageLimit;
    if (usageLimit !== undefined) {
        if (usageLimit !== null && String(usageLimit).trim() !== "") {
            const numLimit = Number(usageLimit);
            if (!Number.isInteger(numLimit) || numLimit < 1) {
                return { success: false, message: "Usage limit must be a positive integer (at least 1)." };
            }
            parsedUsageLimit = numLimit;
        } else {
            parsedUsageLimit = null;
        }
    }

    let parsedPerUser = coupon.perUserLimit;
    if (perUserLimit !== undefined) {
        if (perUserLimit !== null && String(perUserLimit).trim() !== "") {
            const numPerUser = Number(perUserLimit);
            if (!Number.isInteger(numPerUser) || numPerUser < 1) {
                return { success: false, message: "Per-user limit must be a positive integer (at least 1)." };
            }
            parsedPerUser = numPerUser;
        } else {
            parsedPerUser = 1;
        }
    }

    const start = startDate ? parseDateBoundary(startDate, false) : coupon.startDate;
    const end = endDate ? parseDateBoundary(endDate, true) : coupon.endDate;

    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
        return { success: false, message: "Invalid date format." };
    }
    if (start > end) {
        return { success: false, message: "Start date must be on or before end date." };
    }

    try {
        coupon.code = normalizedCode;
        if (description !== undefined) {
            coupon.description = typeof description === "string" ? description.trim() : "";
        }
        coupon.discountType = newDiscountType;
        coupon.discountValue = Math.round(numValue * 100) / 100;
        coupon.minPurchase = numMinPurchase;
        coupon.maxDiscount = parsedMaxDiscount;
        coupon.usageLimit = parsedUsageLimit;
        coupon.perUserLimit = parsedPerUser;
        coupon.startDate = start;
        coupon.endDate = end;

        await coupon.save();

        return { success: true, message: "Coupon updated successfully.", coupon };
    } catch (dbErr) {
        if (dbErr.code === 11000) {
            return { success: false, message: `Coupon with code "${normalizedCode}" already exists.` };
        }
        if (dbErr.name === "ValidationError") {
            const errorMessages = Object.values(dbErr.errors).map((e) => e.message).join(" ");
            return { success: false, message: errorMessages || "Database validation failed." };
        }
        throw dbErr;
    }
};

const toggleCouponStatus = async (couponId) => {
    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
        return { success: false, message: "Invalid coupon ID." };
    }

    const coupon = await Coupon.findById(couponId);
    if (!coupon) {
        return { success: false, message: "Coupon not found." };
    }

    coupon.isActive = !coupon.isActive;
    await coupon.save();

    return {
        success: true,
        message: `Coupon ${coupon.isActive ? "activated" : "deactivated"} successfully.`,
        isActive: coupon.isActive,
    };
};

const deleteCoupon = async (couponId) => {
    if (!couponId || !mongoose.Types.ObjectId.isValid(couponId)) {
        return { success: false, message: "Invalid coupon ID." };
    }

    await Coupon.findByIdAndDelete(couponId);
    return { success: true, message: "Coupon deleted successfully." };
};

const recordCouponUsage = async (couponId, userId, reservationKey = null) => {
    if (!couponId || !userId) return { success: false, message: "Coupon ID and User ID required." };
    const coupon = await Coupon.findById(couponId);
    if (!coupon || !coupon.isActive) {
        return { success: false, message: "Coupon is inactive or not found." };
    }

    const keyStr = reservationKey ? String(reservationKey).trim() : null;
    if (keyStr && Array.isArray(coupon.reservedOrders) && coupon.reservedOrders.includes(keyStr)) {
        return { success: true, isDuplicate: true };
    }

    const now = new Date();
    if (now < new Date(coupon.startDate) || now > new Date(coupon.endDate)) {
        return { success: false, message: "Coupon is expired or not yet active." };
    }
    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
        return { success: false, message: "Coupon global usage limit has been reached." };
    }

    const perUserLimit = coupon.perUserLimit || 1;

    const userUsage = (coupon.usersUsed || []).find((u) => u.userId.toString() === userId.toString());
    if (userUsage && userUsage.usageCount >= perUserLimit) {
        return { success: false, message: `You have reached the maximum allowed usage limit (${perUserLimit}) for this coupon.` };
    }

    if (userUsage) {

        const query = {
            _id: couponId,
            isActive: true,
            usersUsed: {
                $elemMatch: {
                    userId: userId,
                    usageCount: { $lt: perUserLimit },
                },
            },
        };
        if (coupon.usageLimit != null) {
            query.usedCount = { $lt: coupon.usageLimit };
        }
        if (keyStr) {
            query.reservedOrders = { $ne: keyStr };
        }
        const res = await Coupon.updateOne(query, {
            $inc: { usedCount: 1, "usersUsed.$.usageCount": 1 },
            $set: { "usersUsed.$.lastUsedAt": now },
            ...(keyStr ? { $addToSet: { reservedOrders: keyStr } } : {}),
        });
        if (res.modifiedCount === 0) {
            return { success: false, message: "Coupon usage limit reached or concurrently used." };
        }
    } else {
        const query = {
            _id: couponId,
            isActive: true,
            "usersUsed.userId": { $ne: userId },
        };
        if (coupon.usageLimit != null) {
            query.usedCount = { $lt: coupon.usageLimit };
        }
        if (keyStr) {
            query.reservedOrders = { $ne: keyStr };
        }
        const res = await Coupon.updateOne(query, {
            $inc: { usedCount: 1 },
            $push: { usersUsed: { userId, usageCount: 1, lastUsedAt: now } },
            ...(keyStr ? { $addToSet: { reservedOrders: keyStr } } : {}),
        });
        if (res.modifiedCount === 0) {
            return { success: false, message: "Coupon usage limit reached or concurrently used." };
        }
    }

    return { success: true };
};

const releaseCouponUsage = async (couponId, userId, reservationKey = null) => {
    if (!couponId || !userId) {
        return { success: false, message: "Coupon ID and User ID are required." };
    }
    const keyStr = reservationKey ? String(reservationKey).trim() : null;
    const query = {
        _id: couponId,
        "usersUsed.userId": userId,
        usedCount: { $gt: 0 },
        "usersUsed.usageCount": { $gt: 0 },
        ...(keyStr ? { reservedOrders: keyStr } : {}),
    };
    const updateOps = {
        $inc: { usedCount: -1, "usersUsed.$.usageCount": -1 },
        ...(keyStr ? { $pull: { reservedOrders: keyStr } } : {}),
    };

    const res = await Coupon.updateOne(query, updateOps);
    if (res.modifiedCount > 0) {
        await Coupon.updateOne(
            { _id: couponId, usedCount: { $lt: 0 } },
            { $set: { usedCount: 0 } }
        );
    }
    return { success: true, released: res.modifiedCount > 0 };
};

module.exports = {
    parseDateBoundary,
    getCoupons,
    getCouponById,
    createCoupon,
    updateCoupon,
    toggleCouponStatus,
    deleteCoupon,
    recordCouponUsage,
    releaseCouponUsage,
};
