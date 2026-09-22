const mongoose = require("mongoose");

const variantSchema = new mongoose.Schema(
    {
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
        },

        sku: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },

        color: {
            type: String,
            trim: true,
            default: "",
        },

        size: {
            type: String,
            trim: true,
            default: "",
        },

        stock: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },

        regularPrice: {
            type: Number,
            required: true,
            min: 0,
        },

        salePrice: {
            type: Number,
            default: null,
            min: 0,
        },

        // Kept per the original schema for a possible future per-variant
        // gallery override. Not populated by this week's admin form —
        // Figma's product form has one shared gallery for the product.
        images: {
            type: [String],
            default: [],
        },

        isActive: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

const Variant = mongoose.model("Variant", variantSchema);

module.exports = Variant;
