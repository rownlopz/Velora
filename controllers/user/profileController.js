const {
    getProfile,
    updateProfile,
    changePassword,
    requestEmailChange,
    confirmEmailChange,
    resendEmailChangeOtp,
} = require("../../services/user/profileService");

const { getAddresses } = require("../../services/user/addressService");
const { getUserOrders } = require("../../services/user/orderService");
const { validateProfileEdit, validatePasswordChange } = require("../../helpers/validation");

const loadProfile = async (req, res) => {
    try {
        const result = await getProfile(req.session.userId);
        if (!result.success) {
            return res.redirect("/login");
        }

        const addressResult = await getAddresses(req.session.userId);
        const addresses = addressResult.addresses || [];
        const defaultAddress = addresses.find(a => a.isDefault) || addresses[0] || null;

        const orderResult = await getUserOrders(req.session.userId, { limit: 3 });
        const recentOrders = orderResult.orders || [];

        const joinedYear = result.user.createdAt
            ? new Date(result.user.createdAt).getFullYear()
            : new Date().getFullYear();

        res.render("user/profile", {
            title: "My Profile",
            user: result.user,
            defaultAddress,
            recentOrders,
            joinedYear,
            success: req.query.success || null,
        });
    } catch (error) {
        console.error("Load Profile Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadEditProfile = async (req, res) => {
    try {
        const result = await getProfile(req.session.userId);
        if (!result.success) {
            return res.redirect("/login");
        }

        const addressResult = await getAddresses(req.session.userId);

        res.render("user/profile-edit", {
            title: "Edit Profile",
            user: result.user,
            addresses: addressResult.addresses || [],
            errors: req.query.uploadError ? { general: req.query.uploadError } : {},
        });
    } catch (error) {
        console.error("Load Edit Profile Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const updateProfileController = async (req, res) => {
    try {
        const { fullName, phone } = req.body;
        let avatarPath;

        if (req.file) {
            avatarPath = req.file.path;
        }

        const errors = validateProfileEdit({ fullName, phone });
        if (errors) {
            const current = await getProfile(req.session.userId);
            const addressResult = await getAddresses(req.session.userId);
            return res.status(400).render("user/profile-edit", {
                title: "Edit Profile",
                user: current.user,
                addresses: addressResult.addresses || [],
                errors,
            });
        }

        const result = await updateProfile(req.session.userId, {
            fullName,
            phone,
            avatar: avatarPath,
        });

        if (!result.success) {
            const addressResult = await getAddresses(req.session.userId);
            return res.status(400).render("user/profile-edit", {
                title: "Edit Profile",
                user: result.user,
                addresses: addressResult.addresses || [],
                errors: { general: result.message },
            });
        }

        return res.redirect("/profile?success=Profile updated successfully");
    } catch (error) {
        console.error("Update Profile Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const changePasswordController = async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmNewPassword } = req.body;

        const errors = validatePasswordChange({ currentPassword, newPassword, confirmNewPassword });
        if (errors) {
            return res.status(400).render("user/change-password", {
                title: "Change Password",
                errors,
            });
        }

        const result = await changePassword(req.session.userId, { currentPassword, newPassword });

        if (!result.success) {
            return res.status(400).render("user/change-password", {
                title: "Change Password",
                errors: { general: result.message },
            });
        }

        return res.redirect("/profile?success=Password changed successfully");
    } catch (error) {
        console.error("Change Password Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadChangePassword = async (req, res) => {
    const result = await getProfile(req.session.userId);
    if (result.success && result.user.authProvider === "GOOGLE") {
        return res.redirect("/profile/edit");
    }
    res.render("user/change-password", { title: "Change Password", errors: {} });
};

const requestEmailChangeController = async (req, res) => {
    try {
        const { newEmail } = req.body;

        if (!newEmail || !newEmail.trim()) {
            return res.status(400).render("user/change-email", {
                title: "Change Email",
                errors: { newEmail: "Email is required" },
                step: "request",
            });
        }

        const result = await requestEmailChange(req.session.userId, newEmail);

        if (!result.success) {
            return res.status(400).render("user/change-email", {
                title: "Change Email",
                errors: { general: result.message },
                step: "request",
            });
        }

        req.session.pendingEmail = result.email;

        return res.render("user/change-email", {
            title: "Change Email",
            errors: {},
            step: "verify",
            newEmail: result.email,
        });
    } catch (error) {
        console.error("Request Email Change Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const confirmEmailChangeController = async (req, res) => {
    try {
        const { otp } = req.body;
        const newEmail = req.session.pendingEmail;

        if (!newEmail) {
            return res.redirect("/profile/change-email");
        }

        if (!otp || !/^\d{4}$/.test(otp.trim())) {
            return res.status(400).render("user/change-email", {
                title: "Change Email",
                errors: { otp: "Enter the 4-digit code sent to your new email" },
                step: "verify",
                newEmail,
            });
        }

        const result = await confirmEmailChange(req.session.userId, newEmail, otp);

        if (!result.success) {
            return res.status(400).render("user/change-email", {
                title: "Change Email",
                errors: { general: result.message },
                step: "verify",
                newEmail,
            });
        }

        delete req.session.pendingEmail;

        return res.redirect("/profile?success=Email updated successfully");
    } catch (error) {
        console.error("Confirm Email Change Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const loadChangeEmail = async (req, res) => {
    const result = await getProfile(req.session.userId);
    if (result.success && result.user.authProvider === "GOOGLE") {
        return res.redirect("/profile/edit");
    }
    res.render("user/change-email", { title: "Change Email", errors: {}, step: "request" });
};

const resendEmailChangeOtpController = async (req, res) => {
    try {
        const newEmail = req.session.pendingEmail;
        if (!newEmail) {
            return res.status(400).json({ success: false, message: "No pending email change found" });
        }

        const result = await resendEmailChangeOtp(req.session.userId, newEmail);

        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }

        return res.json({ success: true, message: "OTP has been resent" });
    } catch (error) {
        console.error("Resend Email Change OTP Error:", error);
        res.status(500).json({ success: false, message: "Something went wrong" });
    }
};

module.exports = {
    loadProfile,
    loadEditProfile,
    updateProfileController,
    loadChangePassword,
    changePasswordController,
    loadChangeEmail,
    requestEmailChangeController,
    confirmEmailChangeController,
    resendEmailChangeOtpController,
};
