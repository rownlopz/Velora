const User = require("../../models/user/userModel");
const OTP = require("../../models/user/otpModel");
const bcrypt = require("bcrypt");

const generateOtp = require("../../utils/generateOtp");
const sendOtpEmail = require("../../utils/sendOtpEmail");

const getProfile = async (userId) => {
    const user = await User.findById(userId).select("-password");
    if (!user) {
        return { success: false, message: "User not found" };
    }
    return { success: true, user };
};

const updateProfile = async (userId, { fullName, phone, avatar }) => {
    const updates = {};

    if (fullName) updates.fullName = fullName.trim();
    if (phone) updates.phone = phone.trim();
    if (avatar) updates.avatar = avatar;

    const user = await User.findByIdAndUpdate(userId, updates, { new: true }).select("-password");

    if (!user) {
        return { success: false, message: "User not found" };
    }

    return { success: true, user };
};

const changePassword = async (userId, { currentPassword, newPassword }) => {
    const user = await User.findById(userId);

    if (!user) {
        return { success: false, message: "User not found" };
    }

    if (!user.password) {
        return { success: false, message: "This account uses Google Sign-In and has no password set" };
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
        return { success: false, message: "Current password is incorrect" };
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return { success: true };
};

// Step 1: user requests to change their email -> OTP sent to the NEW email
const requestEmailChange = async (userId, newEmail) => {
    const currentUser = await User.findById(userId);
    if (!currentUser) {
        return { success: false, message: "User not found" };
    }

    if (currentUser.authProvider === "GOOGLE") {
        return { success: false, message: "This account uses Google Sign-In. Email is managed by Google and cannot be changed here." };
    }

    const normalizedEmail = newEmail.toLowerCase().trim();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
        return { success: false, message: "This email is already in use" };
    }

    const otp = generateOtp();

    await OTP.deleteMany({ email: normalizedEmail, purpose: "CHANGE_EMAIL" });

    await OTP.create({
        email: normalizedEmail,
        otp,
        purpose: "CHANGE_EMAIL",
        expiresAt: new Date(Date.now() + 60 * 1000),
    });

    await sendOtpEmail(normalizedEmail, otp);

    return { success: true, email: normalizedEmail };
};

// Step 2: user submits the OTP sent to their new email -> email gets updated
const confirmEmailChange = async (userId, newEmail, enteredOtp) => {
    const normalizedEmail = newEmail.toLowerCase().trim();

    const otpRecord = await OTP.findOne({
        email: normalizedEmail,
        purpose: "CHANGE_EMAIL",
        isUsed: false,
    });

    if (!otpRecord) {
        return { success: false, message: "OTP not found or already used" };
    }

    if (otpRecord.expiresAt < new Date()) {
        return { success: false, message: "OTP has expired" };
    }

    if (otpRecord.attempts >= 5) {
        return { success: false, message: "Too many incorrect attempts" };
    }

    if (Number(enteredOtp) !== otpRecord.otp) {
        otpRecord.attempts += 1;
        await otpRecord.save();
        return { success: false, message: "Invalid OTP" };
    }

    otpRecord.isUsed = true;
    await otpRecord.save();

    const user = await User.findByIdAndUpdate(
        userId,
        { email: normalizedEmail, isEmailVerified: true },
        { new: true }
    ).select("-password");

    return { success: true, user };
};

module.exports = {
    getProfile,
    updateProfile,
    changePassword,
    requestEmailChange,
    confirmEmailChange,
};
