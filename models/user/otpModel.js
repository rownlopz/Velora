const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },

        otp: {
            type: Number,
            required: true,
        },

        purpose: {
            type: String,
            enum: ["VERIFY_EMAIL", "RESET_PASSWORD"],
            required: true,
        },

        expiresAt: {
            type: Date,
            required: true,
        },

        attempts: {
            type: Number,
            default: 0,
        },

        isUsed: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

otpSchema.index({ email: 1 });

const OTP = mongoose.model("OTP", otpSchema);

module.exports = OTP;