const User = require("../../models/user/userModel");
const OTP = require("../../models/user/otpModel");
const bcrypt = require("bcrypt");

const generateOtp = require("../../utils/generateOtp");
const sendOtpEmail = require("../../utils/sendOtpEmail");

const { creditWallet, getOrCreateWallet } = require("./walletService");

const signupUser = async ({
    fullName,
    email,
    phone,
    password,
    referralCode,
}) => {
    const normalizedEmail = email.toLowerCase().trim();
    const trimmedPhone = phone ? phone.trim() : "";

    const existingEmail = await User.findOne({
        email: normalizedEmail
    });

    if (existingEmail) {
        return {
            success: false,
            errors: { email: "Email is already registered" }
        };
    }

    if (trimmedPhone) {
        const existingPhone = await User.findOne({
            phone: trimmedPhone
        });

        if (existingPhone) {
            return {
                success: false,
                errors: { phone: "Phone number is already registered" }
            };
        }
    }

    const otp = generateOtp();

    await OTP.deleteMany({
        email: normalizedEmail,
        purpose: "VERIFY_EMAIL"
    });

    await OTP.create({
        email: normalizedEmail,
        otp,
        purpose: "VERIFY_EMAIL",
        expiresAt: new Date(Date.now() + 60 * 1000)
    });

    await sendOtpEmail(normalizedEmail, otp, "VERIFY_EMAIL");

    return {
        success: true,
        signupData: {
            fullName,
            email: normalizedEmail,
            phone,
            password,
            referralCode: referralCode || null,
        }
    };
};

const verifySignupOtp = async ({
    email,
    enteredOtp,
    signupData
}) => {
    const otpRecord = await OTP.findOne({
        email: email.toLowerCase().trim(),
        purpose: "VERIFY_EMAIL",
        isUsed: false
    });

    if (!otpRecord) {
        return {
            success: false,
            message: "OTP not found or already used"
        };
    }

    if (otpRecord.expiresAt < new Date()) {
        return {
            success: false,
            message: "OTP has expired"
        };
    }

    if (otpRecord.attempts >= 5) {
        return {
            success: false,
            message: "Too many incorrect attempts"
        };
    }

    if (Number(enteredOtp) !== otpRecord.otp) {
        otpRecord.attempts += 1;
        await otpRecord.save();

        return {
            success: false,
            message: "Invalid OTP"
        };
    }

    const existingUser = await User.findOne({
        email: email.toLowerCase().trim()
    });

    if (existingUser) {
        return {
            success: false,
            message: "Email already registered"
        };
    }

    const hashedPassword = await bcrypt.hash(
        signupData.password,
        10
    );

    let candidateRef = "VEL" + Math.random().toString(36).substring(2, 8).toUpperCase();
    while (await User.exists({ referralId: candidateRef })) {
        candidateRef = "VEL" + Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    let referrer = null;
    if (signupData.referralCode && typeof signupData.referralCode === "string") {
        const cleanRef = signupData.referralCode.trim().toUpperCase();
        referrer = await User.findOne({ referralId: cleanRef, isActive: true });
    }

    const user = await User.create({
        fullName: signupData.fullName,
        email: signupData.email,
        phone: signupData.phone,
        password: hashedPassword,
        authProvider: "LOCAL",
        isEmailVerified: true,
        role: "USER",
        isActive: true,
        referralId: candidateRef,
        referredBy: referrer ? referrer._id : null,
    });

    await getOrCreateWallet(user._id);

    if (referrer && referrer._id.toString() !== user._id.toString()) {
        await creditWallet({
            userId: referrer._id,
            amount: 100,
            reason: "REFERRAL_REWARD",
            description: `Referral bonus for inviting ${user.fullName}`,
            referenceId: `REF_SIGNUP_REFERRER:${user._id}`,
        });

        await creditWallet({
            userId: user._id,
            amount: 50,
            reason: "REFERRAL_REWARD",
            description: "Welcome bonus for signing up via referral",
            referenceId: `REF_SIGNUP_REFEREE:${user._id}`,
        });
    }

    otpRecord.isUsed = true;
    await otpRecord.save();

    return {
        success: true,
        user
    };
};

const resendSignupOtp = async ({ email }) => {
    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({
        email: normalizedEmail
    });

    if (existingUser) {
        return {
            success: false,
            message: "Email already registered"
        };
    }

    const otp = generateOtp();

    await OTP.deleteMany({
        email: normalizedEmail,
        purpose: "VERIFY_EMAIL"
    });

    await OTP.create({
        email: normalizedEmail,
        otp,
        purpose: "VERIFY_EMAIL",
        expiresAt: new Date(Date.now() + 60 * 1000)
    });

    await sendOtpEmail(normalizedEmail, otp, "VERIFY_EMAIL");

    return {
        success: true,
        message: "OTP resent successfully"
    };
};

const loginUser = async ({ email, password }) => {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({
        email: normalizedEmail
    });

    if (!user) {
        return {
            success: false,
            message: "Invalid email or password"
        };
    }

    if (user.role !== "USER") {
        return {
            success: false,
            message: "This account cannot sign in from the user portal."
        };
    }

    if (!user.isActive) {
        return {
            success: false,
            message: "Your account has been blocked"
        };
    }

    if (!user.password) {
        return {
            success: false,
            message: "Please use your Google account to login"
        };
    }

    const isPasswordValid = await bcrypt.compare(
        password,
        user.password
    );

    if (!isPasswordValid) {
        return {
            success: false,
            message: "Invalid email or password"
        };
    }

    user.lastLogin = new Date();
    await user.save();

    return {
        success: true,
        user
    };
};

const forgotPassword = async ({ email }) => {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({
        email: normalizedEmail,
        authProvider: "LOCAL"
    });

    if (!user) {
        return {
            success: false,
            message: "No account found with this email"
        };
    }

    const otp = generateOtp();

    await OTP.deleteMany({
        email: normalizedEmail,
        purpose: "RESET_PASSWORD"
    });

    await OTP.create({
        email: normalizedEmail,
        otp,
        purpose: "RESET_PASSWORD",
        expiresAt: new Date(Date.now() + 60 * 1000)
    });

    await sendOtpEmail(normalizedEmail, otp, "RESET_PASSWORD");

    return {
        success: true,
        email: normalizedEmail
    };
};

const verifyResetOtp = async ({ email, enteredOtp }) => {
    const normalizedEmail = email.toLowerCase().trim();

    const otpRecord = await OTP.findOne({
        email: normalizedEmail,
        purpose: "RESET_PASSWORD",
        isUsed: false
    });

    if (!otpRecord) {
        return {
            success: false,
            message: "OTP not found or already used"
        };
    }

    if (otpRecord.expiresAt < new Date()) {
        return {
            success: false,
            message: "OTP has expired"
        };
    }

    if (otpRecord.attempts >= 5) {
        return {
            success: false,
            message: "Too many incorrect attempts"
        };
    }

    if (Number(enteredOtp) !== otpRecord.otp) {
        otpRecord.attempts += 1;
        await otpRecord.save();

        return {
            success: false,
            message: "Invalid OTP"
        };
    }

    otpRecord.isUsed = true;
    await otpRecord.save();

    return {
        success: true
    };
};

const resetPassword = async ({ email, password }) => {
    const normalizedEmail = email.toLowerCase().trim();

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.findOneAndUpdate(
        { email: normalizedEmail },
        { password: hashedPassword },
        { new: true }
    );

    if (!user) {
        return {
            success: false,
            message: "User not found"
        };
    }

    return {
        success: true
    };
};

module.exports = {
    signupUser,
    verifySignupOtp,
    resendSignupOtp,
    loginUser,
    forgotPassword,
    verifyResetOtp,
    resetPassword
};
