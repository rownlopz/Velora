const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },

        slug: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
        },

        description: {
            type: String,
            trim: true,
            default: "",
        },

        brand: {
            type: String,
            trim: true,
            default: "",
        },

        categoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Category",
            required: true,
        },

        thumbnail: {
            type: String,
            default: "",
        },

        // Additive to the original schema: the admin edit form (per Figma)
        // has one shared "Product Media" gallery for the whole product
        // (min. 3 images), not per-variant images. `thumbnail` stays as
        // the single representative image used on listing cards; `images`
        // holds the full gallery shown on the product detail page.
        images: {
            type: [String],
            default: [],
        },

        tags: {
            type: [String],
            default: [],
        },

        averageRating: {
            type: Number,
            default: 0,
        },

        totalReviews: {
            type: Number,
            default: 0,
        },

        isFeatured: {
            type: Boolean,
            default: false,
        },

        // ACTIVE = listed/visible to shoppers. INACTIVE = "unlisted" by an admin.
        status: {
            type: String,
            enum: ["ACTIVE", "INACTIVE"],
            default: "ACTIVE",
        },

        isDeleted: {
            type: Boolean,
            default: false,
        },

        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
