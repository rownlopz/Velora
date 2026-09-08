const User = require("../models/user/userModel");

/**
 * Middleware to protect user routes.
 * Ensures user is authenticated and account is active.
 */
const userAuth = async (req, res, next) => {
    try {
        if (!req.session || !req.session.userId) {
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

/**
 * Middleware to protect admin routes.
 * Ensures admin is authenticated, holds ADMIN role, and account is active.
 */
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

/**
 * Middleware to restrict access to guest-only routes (e.g. login, signup) for authenticated users.
 */
const isGuest = (req, res, next) => {
    if (req.session && req.session.userId) {
        return res.redirect("/");
    }
    next();
};

/**
 * Middleware to restrict access to guest-only admin routes (e.g. admin login) for authenticated admins.
 */
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
