const { validateSignup } = require("../../helpers/validation");
const { signupUser, verifySignupOtp, resendSignupOtp } = require("../../services/user/userService");

const loadHome = (req, res) => {
    res.render("user/home");
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
    if (!req.session.signupData) {
        return res.redirect("/signup");
    }

    res.render("user/otp", {
        title: "OTP Verification",
        email: req.session.signupData.email,
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
        const signupData = req.session.signupData;

        if (!signupData) {
            return res.redirect("/signup");
        }

        if (!otp || !otp.trim()) {
            return res.status(400).render("user/otp", {
                title: "OTP Verification",
                email: signupData.email,
                error: "Please enter the verification code"
            });
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

        req.session.userId = result.user._id;
        delete req.session.signupData;

        return req.session.save((err) => {
            if (err) {
                console.error("Session save error:", err);
            }
            return res.redirect("/");
        });

    } catch (error) {
        console.error("OTP Verification Error:", error);
        return res.status(500).render("user/otp", {
            title: "OTP Verification",
            email: req.session.signupData ? req.session.signupData.email : "",
            error: "Something went wrong. Please try again."
        });
    }
};

const resendOtp = async (req, res) => {
    try {
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
    signup,
    verifyOtp,
    resendOtp
};