const {
    getUsers,
    toggleUserStatus
} = require("../../services/admin/adminService");

const loadLogin = (req, res) => {
    res.render("admin/login");
};

const loadDashboard = async (req, res) => {
    try {
        const search = req.query.search || "";
        const page = Number(req.query.page) || 1;

        const result = await getUsers({
            search,
            page,
            limit: 10
        });

        res.render("admin/dashboard", {
            users: result.users,
            search,
            currentPage: result.currentPage,
            totalPages: result.totalPages,
            totalUsers: result.totalUsers
        });
    } catch (error) {
        console.error("Load Users Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const toggleUserStatusController = async (req, res) => {
    try {
        const { userId } = req.params;

        const result = await toggleUserStatus(userId);

        if (!result.success) {
            return res.status(404).send(result.message);
        }

        res.redirect("/admin/dashboard");
    } catch (error) {
        console.error("Toggle User Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = {
    loadLogin,
    loadDashboard,
    toggleUserStatusController
};