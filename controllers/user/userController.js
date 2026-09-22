const { validateSignup, validateResetPassword } = require("../../helpers/validation");
const { signupUser, verifySignupOtp, resendSignupOtp, loginUser, forgotPassword, verifyResetOtp, resetPassword } = require("../../services/user/userService");

const { listProducts } = require("../../services/user/productListService");

const loadHome = async (req, res) => {
    try {
        const { products } = await listProducts(
            { search: "", categorySlug: "", minPrice: undefined, maxPrice: undefined, sort: "newest", page: 1 },
            4
        );
        res.render("user/home", { newProducts: products });
    } catch (error) {
        console.error("Load Home Error:", error);
        res.render("user/home", { newProducts: [] });
    }
};

const loadSignup = (req, res) => {
    res.render("user/signup", {
        title: "Create Account",
        errors: {},
        formData: {}
    });
};

const loadLogin = (req, res) => {
    res.render("user/login", {
        title: "Login",
        errors: {},
        formData: {}
    });
};

const loadOtp = (req, res) => {
    const flow = req.session.otpFlow;

    const email =
        flow === "SIGNUP" ? req.session.signupData?.email :
        flow === "RESET_PASSWORD" ? req.session.resetPasswordEmail :
        null;

    if (!email) {
        return res.redirect("/signup");
    }

    res.render("user/otp", {
        title: "OTP Verification",
        email,
        error: null
    });
};

const loadForgotPassword = (req, res) => {
    res.render("user/forgot-password", {
        title: "Forgot Password",
        errors: {},
        formData: {}
    });
};

const loadResetPassword = (req, res) => {
    res.render("user/reset-password", {
        title: "Reset Password",
        errors: {}
    });
};

const signup = async (req, res) => {
    try {
        const { fullName, email, phone, password, confirmPassword } = req.body;
        const formData = { fullName, email, phone };

        // Validate signup form
        const errors = validateSignup(req.body);

        if (errors) {
            return res.status(400).render("user/signup", {
                title: "Create Account",
                errors,
                formData
            });
        }

        // Business logic handled by service
        const result = await signupUser({
            fullName,
            email,
            phone,
            password
        });

        if (!result.success) {
            return res.status(400).render("user/signup", {
                title: "Create Account",
                errors: result.errors || { general: result.message },
                formData
            });
        }

        // Store temporary signup data in session
        req.session.signupData = result.signupData;

        // Explicit flow marker so /otp and /resend-otp know exactly which
        // flow is active, rather than inferring it from which session
        // keys happen to be set — that inference breaks if a user
        // abandons one flow mid-way and starts the other, leaving stale
        // data behind.
        req.session.otpFlow = "SIGNUP";
        delete req.session.resetPasswordEmail;
        delete req.session.resetPasswordVerified;

        // Move user to OTP page
        return res.redirect("/otp");

    } catch (error) {
        console.error("Signup Controller Error:", error);
        return res.status(500).render("user/signup", {
            title: "Create Account",
            errors: { general: "Something went wrong. Please try again." },
            formData: {
                fullName: req.body ? req.body.fullName : "",
                email: req.body ? req.body.email : "",
                phone: req.body ? req.body.phone : ""
            }
        });
    }
};

const verifyOtp = async (req, res) => {
    try {
        const { otp } = req.body;
        const flow = req.session.otpFlow;

        // Password reset OTP
        if (flow === "RESET_PASSWORD") {
            const email = req.session.resetPasswordEmail;

            if (!email) {
                return res.redirect("/forgot-password");
            }

            const result = await verifyResetOtp({
                email,
                enteredOtp: otp
            });

            if (!result.success) {
                return res.status(400).render("user/otp", {
                    title: "OTP Verification",
                    email,
                    error: result.message
                });
            }

            req.session.resetPasswordVerified = true;
            delete req.session.otpFlow;

            return res.redirect("/reset-password");
        }

        // Signup OTP
        if (flow === "SIGNUP") {
            const signupData = req.session.signupData;

            if (!signupData) {
                return res.redirect("/signup");
            }

            const result = await verifySignupOtp({
                email: signupData.email,
                enteredOtp: otp.trim(),
                signupData
            });

            if (!result.success) {
                return res.status(400).render("user/otp", {
                    title: "OTP Verification",
                    email: signupData.email,
                    error: result.message
                });
            }

            // Own session cookie now (velora.user.sid) — no longer
            // shares storage with the admin session.
            req.session.userId = result.user._id;
            delete req.session.signupData;
            delete req.session.otpFlow;

            return req.session.save(() => res.redirect("/"));
        }

        // No active flow (expired/stale session, or /otp hit directly)
        return res.redirect("/signup");

    } catch (error) {
        console.error("OTP Verification Error:", error);
        return res.status(500).send("Something went wrong");
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).render("user/login", {
                title: "Login",
                errors: {
                    general: "Email and password are required"
                },
                formData: { email }
            });
        }

        const result = await loginUser({
            email,
            password
        });

        if (!result.success) {
            return res.status(400).render("user/login", {
                title: "Login",
                errors: {
                    general: result.message
                },
                formData: { email }
            });
        }

        // Own session cookie now (velora.user.sid) — no longer shares
        // storage with the admin session.
        req.session.userId = result.user._id;

        return req.session.save(() => {
            res.redirect("/");
        });

    } catch (error) {
        console.error("Login Controller Error:", error);

        return res.status(500).render("user/login", {
            title: "Login",
            errors: {
                general: "Something went wrong. Please try again."
            },
            formData: {
                email: req.body.email
            }
        });
    }
};

const forgotPasswordController = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !email.trim()) {
            return res.status(400).render("user/forgot-password", {
                title: "Forgot Password",
                errors: { email: "Email address is required" },
                formData: { email }
            });
        }

        const result = await forgotPassword({
            email: email.trim()
        });

        if (!result.success) {
            return res.status(400).render("user/forgot-password", {
                title: "Forgot Password",
                errors: { general: result.message },
                formData: { email }
            });
        }

        req.session.resetPasswordEmail = result.email;

        // Same explicit flow marker as signup — see comment there.
        req.session.otpFlow = "RESET_PASSWORD";
        delete req.session.signupData;

        return res.redirect("/otp");
    } catch (error) {
        console.error("Forgot Password Error:", error);
        return res.status(500).send("Something went wrong");
    }
};

const resetPasswordController = async (req, res) => {
    try {
        const email = req.session.resetPasswordEmail;
        const verified = req.session.resetPasswordVerified;
        const { password, confirmPassword } = req.body;

        if (!email || !verified) {
            return res.redirect("/forgot-password");
        }

        const errors = validateResetPassword({ password, confirmPassword });
        if (errors) {
            return res.status(400).render("user/reset-password", {
                title: "Reset Password",
                errors,
            });
        }

        const result = await resetPassword({
            email,
            password
        });

        if (!result.success) {
            return res.status(400).render("user/reset-password", {
                title: "Reset Password",
                errors: { general: result.message }
            });
        }

        delete req.session.resetPasswordEmail;
        delete req.session.resetPasswordVerified;

        return res.redirect("/login");
    } catch (error) {
        console.error("Reset Password Error:", error);
        return res.status(500).send("Something went wrong");
    }
};

const resendOtp = async (req, res) => {
    try {
        const flow = req.session.otpFlow;

        // Previously this only supported the signup flow — clicking
        // "Resend" during forgot-password OTP verification always failed
        // with a signup-specific message and never actually resent
        // anything. Both flows are now handled explicitly.
        if (flow === "RESET_PASSWORD") {
            const email = req.session.resetPasswordEmail;

            if (!email) {
                return res.status(400).json({
                    success: false,
                    message: "Password reset session expired. Please start again."
                });
            }

            const result = await forgotPassword({ email });

            if (!result.success) {
                return res.status(400).json({
                    success: false,
                    message: result.message
                });
            }

            return res.status(200).json({
                success: true,
                message: "A new verification code has been sent to your email."
            });
        }

        if (flow === "SIGNUP") {
            const signupData = req.session.signupData;

            if (!signupData) {
                return res.status(400).json({
                    success: false,
                    message: "Signup session expired. Please sign up again."
                });
            }

            const result = await resendSignupOtp({
                email: signupData.email
            });

            if (!result.success) {
                return res.status(400).json({
                    success: false,
                    message: result.message
                });
            }

            return res.status(200).json({
                success: true,
                message: "A new verification code has been sent to your email."
            });
        }

        return res.status(400).json({
            success: false,
            message: "Session expired. Please start again."
        });

    } catch (error) {
        console.error("Resend OTP Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to resend code. Please try again."
        });
    }
};

module.exports = {
    loadHome,
    loadSignup,
    loadLogin,
    loadOtp,
    loadForgotPassword,
    loadResetPassword,
    forgotPasswordController,
    resetPasswordController,
    signup,
    login,
    verifyOtp,
    resendOtp
};