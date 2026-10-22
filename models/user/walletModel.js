const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },
        balance: {
            type: Number,
            required: true,
            default: 0,
            min: [0, "Wallet balance cannot be negative."],
        },
        currency: {
            type: String,
            default: "INR",
        },
        appliedOperations: {
            type: [String],
            default: [],
            index: true,
        },
        operationsLog: {
            type: [
                {
                    opKey: { type: String, required: true },
                    type: { type: String, enum: ["CREDIT", "DEBIT"], required: true },
                    amount: { type: Number, required: true },
                    balanceAfter: { type: Number, required: true },
                    reason: { type: String, required: true },
                    description: { type: String, default: "" },
                    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
                    orderNumber: { type: String, default: null },
                    createdAt: { type: Date, default: Date.now },
                },
            ],
            default: [],
        },
    },
    {
        timestamps: true,
    }
);

const Wallet = mongoose.model("Wallet", walletSchema);

module.exports = Wallet;
