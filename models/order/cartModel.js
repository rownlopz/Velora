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
        // A snapshot of the price at the moment it was added, per the
        // original schema. Display always re-checks the live variant
        // price too — this snapshot is informational, never trusted as
        // the source of truth for what gets charged.
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
    },
    {
        timestamps: true,
    }
);

const Cart = mongoose.model("Cart", cartSchema);

module.exports = Cart;
