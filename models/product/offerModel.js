const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, "Offer name is required."],
            trim: true,
        },
        offerType: {
            type: String,
            enum: ["PRODUCT", "CATEGORY"],
            required: [true, "Offer type must be PRODUCT or CATEGORY."],
        },
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            default: null,
            index: true,
        },
        categoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Category",
            default: null,
            index: true,
        },
        discountType: {
            type: String,
            enum: ["PERCENTAGE", "FLAT"],
            default: "PERCENTAGE",
        },
        discountValue: {
            type: Number,
            required: [true, "Discount value is required."],
            min: [1, "Discount value must be at least 1."],
        },
        maxDiscount: {
            type: Number,
            default: null,
            min: [0, "Maximum discount cannot be negative."],
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

offerSchema.index({ offerType: 1, isActive: 1, startDate: 1, endDate: 1 });

const Offer = mongoose.model("Offer", offerSchema);

module.exports = Offer;
