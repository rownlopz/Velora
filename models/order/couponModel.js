const mongoose = require("mongoose");

const couponUserUsageSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        usageCount: {
            type: Number,
            default: 1,
            min: 1,
        },
        lastUsedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { _id: false }
);

const couponSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: [true, "Coupon code is required."],
            unique: true,
            trim: true,
            uppercase: true,
            index: true,
        },
        description: {
            type: String,
            trim: true,
            default: "",
        },
        discountType: {
            type: String,
            enum: ["PERCENTAGE", "FLAT"],
            required: [true, "Discount type must be PERCENTAGE or FLAT."],
            default: "PERCENTAGE",
        },
        discountValue: {
            type: Number,
            required: [true, "Discount value is required."],
            min: [1, "Discount value must be at least 1."],
        },
        minPurchase: {
            type: Number,
            default: 0,
            min: [0, "Minimum purchase amount cannot be negative."],
        },
        maxDiscount: {
            type: Number,
            default: null,
            min: [0, "Maximum discount cannot be negative."],
        },
        usageLimit: {
            type: Number,
            default: null,
            min: [1, "Usage limit must be at least 1."],
        },
        perUserLimit: {
            type: Number,
            default: 1,
            min: [1, "Per-user limit must be at least 1."],
        },
        usedCount: {
            type: Number,
            default: 0,
            min: [0, "Used count cannot be negative."],
        },
        usersUsed: {
            type: [couponUserUsageSchema],
            default: [],
        },
        reservedOrders: {
            type: [String],
            default: [],
        },
        startDate: {
            type: Date,
            required: [true, "Start date is required."],
        },
        endDate: {
            type: Date,
            required: [true, "End date is required."],
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    {
        timestamps: true,
    }
);

couponSchema.index({ code: 1, isActive: 1, startDate: 1, endDate: 1 });

const Coupon = mongoose.model("Coupon", couponSchema);

module.exports = Coupon;
