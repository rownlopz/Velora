const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
    {
        variantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Variant",
            required: true,
        },
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
        },
        productName: {
            type: String,
            required: true,
            trim: true,
        },
        productSlug: {
            type: String,
            trim: true,
            default: "",
        },
        thumbnail: {
            type: String,
            default: "",
        },
        color: {
            type: String,
            default: "",
        },
        size: {
            type: String,
            default: "",
        },
        sku: {
            type: String,
            default: "",
        },
        quantity: {
            type: Number,
            required: true,
            min: 1,
        },
        unitPrice: {
            type: Number,
            required: true,
            min: 0,
        },
        priceAtPurchase: {
            type: Number,
            required: true,
            min: 0,
            default: function () {
                return this.unitPrice;
            },
        },
        lineTotal: {
            type: Number,
            required: true,
            min: 0,
        },
        status: {
            type: String,
            enum: [
                "PENDING",
                "PLACED",
                "PROCESSING",
                "SHIPPED",
                "OUT_FOR_DELIVERY",
                "DELIVERED",
                "CANCELLED",
                "RETURN_REQUESTED",
                "RETURN_APPROVED",
                "RETURN_REJECTED",
                "RETURNED",
                "ACTIVE",
            ],
            default: "PENDING",
        },
        regularPrice: {
            type: Number,
            default: 0,
            min: 0,
        },
        allocatedDiscount: {
            type: Number,
            default: 0,
            min: 0,
        },
        cancellationReason: {
            type: String,
            default: "",
            trim: true,
        },
        cancelledAt: {
            type: Date,
            default: null,
        },
        cancelledBy: {
            type: String,
            default: null,
        },
        returnReason: {
            type: String,
            default: "",
            trim: true,
        },
        returnRequestedAt: {
            type: Date,
            default: null,
        },
        adminFeedback: {
            type: String,
            default: "",
            trim: true,
        },
        adminFeedbackAt: {
            type: Date,
            default: null,
        },
        isRestocked: {
            type: Boolean,
            default: false,
        },
        restockedAt: {
            type: Date,
            default: null,
        },
        restockedBy: {
            type: String,
            default: null,
        },
    },
    { _id: true }
);

const shippingAddressSchema = new mongoose.Schema(
    {
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        addressLine1: { type: String, required: true },
        addressLine2: { type: String, default: "" },
        phone: { type: String, required: true },
        city: { type: String, required: true },
        state: { type: String, required: true },
        pinCode: { type: Number, required: true },
        country: { type: String, required: true },
    },
    { _id: false }
);

const orderSchema = new mongoose.Schema(
    {
        orderNumber: {
            type: String,
            required: true,
            unique: true,
            uppercase: true,
            index: true,
        },
        orderId: {
            type: String,
            unique: true,
            uppercase: true,
            index: true,
            default: function () {
                return this.orderNumber;
            },
        },
        checkoutToken: {
            type: String,
            unique: true,
            sparse: true,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        items: {
            type: [orderItemSchema],
            required: true,
        },
        shippingAddress: {
            type: shippingAddressSchema,
            required: true,
        },
        pricing: {
            subtotal: {
                type: Number,
                required: true,
                min: 0,
            },
            shippingFee: {
                type: Number,
                default: 0,
                min: 0,
            },
            discount: {
                type: Number,
                default: 0,
                min: 0,
            },
            totalAmount: {
                type: Number,
                required: true,
                min: 0,
            },
            originalSubtotal: {
                type: Number,
                default: function () {
                    return this.subtotal;
                },
            },
            originalShippingFee: {
                type: Number,
                default: function () {
                    return this.shippingFee;
                },
            },
            originalDiscount: {
                type: Number,
                default: function () {
                    return this.discount;
                },
            },
            originalTotalAmount: {
                type: Number,
                default: function () {
                    return this.totalAmount;
                },
            },
            cancellationDeduction: {
                type: Number,
                default: 0,
                min: 0,
            },
            returnCredit: {
                type: Number,
                default: 0,
                min: 0,
            },
            currentPayable: {
                type: Number,
                default: function () {
                    return this.totalAmount;
                },
            },
        },
        paymentMethod: {
            type: String,
            enum: ["COD", "ONLINE", "WALLET"],
            default: "COD",
        },
        paymentStatus: {
            type: String,
            enum: ["PENDING", "COMPLETED", "FAILED", "REFUNDED", "CANCELLED"],
            default: "PENDING",
        },
        paidAt: {
            type: Date,
            default: null,
        },
        orderStatus: {
            type: String,
            enum: [
                "PENDING",
                "PLACED",
                "PROCESSING",
                "SHIPPED",
                "OUT_FOR_DELIVERY",
                "DELIVERED",
                "CANCELLED",
                "RETURN_REQUESTED",
                "RETURN_APPROVED",
                "RETURN_REJECTED",
                "RETURNED",
            ],
            default: "PENDING",
        },
        placedAt: {
            type: Date,
            default: Date.now,
        },
        cancellationReason: {
            type: String,
            default: "",
            trim: true,
        },
        cancelledAt: {
            type: Date,
            default: null,
        },
        cancelledBy: {
            type: String,
            default: null,
        },
        returnReason: {
            type: String,
            default: "",
            trim: true,
        },
        returnRequestedAt: {
            type: Date,
            default: null,
        },
        adminFeedback: {
            type: String,
            default: "",
            trim: true,
        },
        adminFeedbackAt: {
            type: Date,
            default: null,
        },
        deliveredAt: {
            type: Date,
            default: null,
        },
        deliveryNotes: {
            type: String,
            default: "",
        },
    },
    {
        timestamps: true,
    }
);

orderSchema.pre("validate", function () {
    if (!this.orderId && this.orderNumber) {
        this.orderId = this.orderNumber;
    }
    if (!this.orderNumber && this.orderId) {
        this.orderNumber = this.orderId;
    }
    if (!this.checkoutToken) {
        this.checkoutToken = "chk_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 10);
    }
});

orderSchema.virtual("orderID").get(function () {
    return this.orderNumber || this.orderId;
});

const Order = mongoose.model("Order", orderSchema);

module.exports = Order;
