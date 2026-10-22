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
        brand: {
            type: String,
            default: "",
            trim: true,
        },
        categoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Category",
            default: null,
        },
        categoryName: {
            type: String,
            default: "",
            trim: true,
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
        originalUnitPrice: {
            type: Number,
            default: function () {
                return this.regularPrice || this.unitPrice;
            },
            min: 0,
        },
        effectiveUnitPrice: {
            type: Number,
            default: function () {
                return this.unitPrice;
            },
            min: 0,
        },
        offerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Offer",
            default: null,
        },
        offerName: {
            type: String,
            default: "",
            trim: true,
        },
        offerDiscount: {
            type: Number,
            default: 0,
            min: 0,
        },
        totalOfferDiscount: {
            type: Number,
            default: 0,
            min: 0,
        },
        allocatedDiscount: {
            type: Number,
            default: 0,
            min: 0,
        },
        allocatedCouponDiscount: {
            type: Number,
            default: 0,
            min: 0,
        },
        finalPayable: {
            type: Number,
            default: function () {
                return Math.max(0, this.lineTotal - (this.allocatedCouponDiscount || 0));
            },
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
        isStockRestored: {
            type: Boolean,
            default: false,
        },
        restockedQuantity: {
            type: Number,
            default: 0,
        },
        refundIssued: {
            type: Boolean,
            default: false,
        },
        refundAmount: {
            type: Number,
            default: 0,
        },
        restockedAt: {
            type: Date,
            default: null,
        },
        restockedBy: {
            type: String,
            default: null,
        },
        restockClaimAt: {
            type: Date,
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

const orderPricingSchema = new mongoose.Schema(
    {
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
        offerDiscount: {
            type: Number,
            default: 0,
            min: 0,
        },
        couponDiscount: {
            type: Number,
            default: 0,
            min: 0,
        },
        couponCode: {
            type: String,
            default: null,
            trim: true,
        },
        couponId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coupon",
            default: null,
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
        walletRefundIssued: {
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
            required: [true, "Order items are required."],
            validate: {
                validator: function (val) {
                    return Array.isArray(val) && val.length > 0;
                },
                message: "Order must contain at least one item.",
            },
        },
        shippingAddress: {
            type: shippingAddressSchema,
            required: true,
        },
        pricing: {
            type: orderPricingSchema,
            required: true,
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
        razorpayOrderId: {
            type: String,
            default: null,
            index: true,
        },
        razorpayPaymentId: {
            type: String,
            default: null,
            index: true,
        },
        razorpaySignature: {
            type: String,
            default: null,
        },
        paymentAttempts: {
            type: [
                {
                    gateway: { type: String, default: "RAZORPAY" },
                    attemptId: { type: String, default: null },
                    razorpayOrderId: { type: String, default: null },
                    razorpayPaymentId: { type: String, default: null },
                    amount: { type: Number, default: 0 },
                    status: { type: String, default: "PENDING" },
                    errorReason: { type: String, default: null },
                    createdAt: { type: Date, default: Date.now },
                },
            ],
            default: [],
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
        referralClawbackApplied: {
            type: Boolean,
            default: false,
        },
        referralClawbackPending: {
            type: Boolean,
            default: false,
        },
        isWalletDebited: {
            type: Boolean,
            default: false,
        },
        retryLockUntil: {
            type: Date,
            default: null,
        },
        expirationClaimAt: {
            type: Date,
            default: null,
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
    if (this.pricing) {
        if (this.pricing.originalSubtotal == null && this.pricing.subtotal != null) {
            this.pricing.originalSubtotal = this.pricing.subtotal;
        }
        if (this.pricing.originalShippingFee == null && this.pricing.shippingFee != null) {
            this.pricing.originalShippingFee = this.pricing.shippingFee;
        }
        if (this.pricing.originalDiscount == null && this.pricing.discount != null) {
            this.pricing.originalDiscount = this.pricing.discount;
        }
        if (this.pricing.originalTotalAmount == null && this.pricing.totalAmount != null) {
            this.pricing.originalTotalAmount = this.pricing.totalAmount;
        }
        if (this.pricing.currentPayable == null && this.pricing.totalAmount != null) {
            this.pricing.currentPayable = this.pricing.totalAmount;
        }
    }
});

orderSchema.virtual("orderID").get(function () {
    return this.orderNumber || this.orderId;
});

const Order = mongoose.model("Order", orderSchema);

module.exports = Order;
