const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
    {
        firstName: {
            type: String,
            required: true,
            trim: true,
        },

        lastName: {
            type: String,
            required: true,
            trim: true,
        },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },

        password: {
            type: String,
            default: null,
        },

        phone: {
            type: String,
            default: null,
        },

        authProvider: {
            type: String,
            enum: ["LOCAL", "GOOGLE"],
            default: "LOCAL",
        },

        googleId: {
            type: String,
            default: null,
        },

        isEmailVerified: {
            type: Boolean,
            default: false,
        },

        avatar: {
            type: String,
            default: "",
        },

        role: {
            type: String,
            enum: ["USER", "ADMIN"],
            default: "USER",
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        referredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        referralId: {
            type: String,
            unique: true,
        },

        lastLogin: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

userSchema.index({ email: 1 });

userSchema.index({ referralId: 1 });

const User = mongoose.model("User", userSchema);

module.exports = User;