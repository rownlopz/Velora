const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema(
    {
        variantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Variant",
            required: true,
        },
        quantity: {
            type: Number,
            required: true,
            min: 1,
        },

        priceSnapshot: {
            type: Number,
            required: true,
        },
        addedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { _id: false }
);

const cartSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
        },
        items: {
            type: [cartItemSchema],
            default: [],
        },
        checkoutToken: {
            type: String,
            default: null,
        },
        checkoutTokenCreatedAt: {
            type: Date,
            default: null,
        },
        checkoutClaimToken: {
            type: String,
            default: null,
        },
        checkoutClaimUntil: {
            type: Date,
            default: null,
        },
        appliedCoupon: {
            couponId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Coupon",
                default: null,
            },
            code: {
                type: String,
                default: null,
                trim: true,
            },
            discountType: {
                type: String,
                default: null,
            },
            discountValue: {
                type: Number,
                default: 0,
            },
            discountAmount: {
                type: Number,
                default: 0,
            },
            appliedAt: {
                type: Date,
                default: null,
            },
        },
    },
    {
        timestamps: true,
    }
);

const Cart = mongoose.model("Cart", cartSchema);

module.exports = Cart;
