const User = require("../../models/user/userModel");
const bcrypt = require("bcrypt");

const getUsers = async ({ search = "", status = "all", page = 1, limit = 10 }) => {
    const skip = (page - 1) * limit;

    const query = { role: "USER" };

    if (search.trim()) {
        query.$or = [
            { fullName: { $regex: search.trim(), $options: "i" } },
            { email: { $regex: search.trim(), $options: "i" } },
            { phone: { $regex: search.trim(), $options: "i" } }
        ];
    }

    if (status === "active") {
        query.isActive = true;
    } else if (status === "blocked") {
        query.isActive = false;
    }

    const [users, totalUsers] = await Promise.all([
        User.find(query)
            .select("-password")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),

        User.countDocuments(query)
    ]);

    return {
        users,
        totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        currentPage: page
    };
};

const toggleUserStatus = async (userId) => {
    const user = await User.findById(userId);

    if (!user) {
        return {
            success: false,
            message: "User not found"
        };
    }

    // This endpoint is for managing customer accounts only — never allow
    // it to be used to block/unblock another admin, even if the request
    // is crafted directly (the dashboard list already excludes admins,
    // but the service itself must enforce this too).
    if (user.role !== "USER") {
        return {
            success: false,
            message: "Admin accounts cannot be blocked or unblocked from user management"
        };
    }

    user.isActive = !user.isActive;
    await user.save();

    return {
        success: true,
        message: user.isActive
            ? "User unblocked successfully"
            : "User blocked successfully"
    };
};

const adminLogin = async ({ email, password }) => {
    const normalizedEmail = email.toLowerCase().trim();

    const admin = await User.findOne({ email: normalizedEmail, role: "ADMIN" });

    if (!admin) {
        return { success: false, message: "Invalid admin credentials" };
    }

    if (!admin.isActive) {
        return { success: false, message: "This admin account is disabled" };
    }

    if (!admin.password) {
        return { success: false, message: "Invalid admin credentials" };
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
        return { success: false, message: "Invalid admin credentials" };
    }

    return { success: true, admin };
};

module.exports = {
    getUsers,
    toggleUserStatus,
    adminLogin
};
