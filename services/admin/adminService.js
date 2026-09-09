const User = require("../../models/user/userModel");

const getUsers = async ({ search = "", page = 1, limit = 10 }) => {
    const skip = (page - 1) * limit;

    const query = {};

    if (search.trim()) {
        query.$or = [
            { fullName: { $regex: search.trim(), $options: "i" } },
            { email: { $regex: search.trim(), $options: "i" } },
            { phone: { $regex: search.trim(), $options: "i" } }
        ];
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

    user.isActive = !user.isActive;
    await user.save();

    return {
        success: true,
        message: user.isActive
            ? "User unblocked successfully"
            : "User blocked successfully"
    };
};

module.exports = {
    getUsers,
    toggleUserStatus
};