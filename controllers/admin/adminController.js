const {
    getUsers,
    toggleUserStatus,
    adminLogin
} = require("../../services/admin/adminService");

const loadLogin = (req, res) => {
    res.render("admin/login", {
        title: "Admin Login",
        error: null
    });
};

const loginController = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).render("admin/login", {
                title: "Admin Login",
                error: "Email and password are required"
            });
        }

        const result = await adminLogin({ email, password });

        if (!result.success) {
            return res.status(400).render("admin/login", {
                title: "Admin Login",
                error: result.message
            });
        }

        req.session.adminId = result.admin._id;

        return req.session.save(() => {
            res.redirect("/admin/dashboard");
        });
    } catch (error) {
        console.error("Admin Login Error:", error);
        return res.status(500).render("admin/login", {
            title: "Admin Login",
            error: "Something went wrong. Please try again."
        });
    }
};

const logoutController = (req, res) => {
    req.session.destroy(() => {
        res.redirect("/admin/login");
    });
};

const loadDashboard = async (req, res) => {
    try {
        const search = req.query.search || "";
        const status = req.query.status || "all";
        const page = Number(req.query.page) || 1;

        const result = await getUsers({
            search,
            status,
            page,
            limit: 10
        });

        res.render("admin/dashboard", {
            users: result.users,
            search,
            status,
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
        const { search = "", status = "all", page = 1 } = req.body;

        const result = await toggleUserStatus(userId);

        if (!result.success) {
            return res.status(404).send(result.message);
        }

        const params = new URLSearchParams({ search, status, page });
        res.redirect(`/admin/dashboard?${params.toString()}`);
    } catch (error) {
        console.error("Toggle User Error:", error);
        res.status(500).send("Something went wrong");
    }
};

module.exports = {
    loadLogin,
    loginController,
    logoutController,
    loadDashboard,
    toggleUserStatusController
};
