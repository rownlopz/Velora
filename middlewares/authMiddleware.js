const User = require("../models/user/userModel");


const userAuth = async (req, res, next) => {
    try {
        if (!req.session || !req.session.userId) {
            const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
            if (isAjax) {
                return res.status(401).json({ success: false, message: "Please login to continue", requireLogin: true, redirectUrl: "/login" });
            }
            return res.redirect("/login");
        }

        const user = await User.findById(req.session.userId);

        if (!user) {
            req.session.destroy(() => {
                return res.redirect("/login");
            });
            return;
        }

        if (!user.isActive) {
            req.session.destroy(() => {
                return res.render("user/login", {
                    title: "Login",
                    error: "Your account has been blocked by admin. Please contact support."
                });
            });
            return;
        }

        req.user = user;
        res.locals.user = user;
        next();
    } catch (error) {
        console.error("User Auth Middleware Error:", error);
        res.status(500).send("Internal Server Error");
    }
};


const adminAuth = async (req, res, next) => {
    try {
        if (!req.session || !req.session.adminId) {
            return res.redirect("/admin/login");
        }

        const admin = await User.findById(req.session.adminId);

        if (!admin || admin.role !== "ADMIN") {
            req.session.destroy(() => {
                return res.redirect("/admin/login");
            });
            return;
        }

        if (!admin.isActive) {
            req.session.destroy(() => {
                return res.render("admin/login", {
                    title: "Admin Login",
                    error: "Your admin account is disabled."
                });
            });
            return;
        }

        req.admin = admin;
        res.locals.admin = admin;
        next();
    } catch (error) {
        console.error("Admin Auth Middleware Error:", error);
        res.status(500).send("Internal Server Error");
    }
};


const isGuest = (req, res, next) => {
    if (req.session && req.session.userId) {
        return res.redirect("/");
    }
    next();
};


const isAdminGuest = (req, res, next) => {
    if (req.session && req.session.adminId) {
        return res.redirect("/admin/dashboard");
    }
    next();
};

module.exports = {
    userAuth,
    adminAuth,
    isGuest,
    isAdminGuest
};
