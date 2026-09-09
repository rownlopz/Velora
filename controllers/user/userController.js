const { validateSignup } = require("../../helpers/validation");
const { signupUser, verifySignupOtp, resendSignupOtp, loginUser, forgotPassword, verifyResetOtp, resetPassword } = require("../../services/user/userService");

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
    const email =
        req.session.signupData?.email ||
        req.session.resetPasswordEmail;

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

        // Password reset OTP
        if (req.session.resetPasswordEmail) {
            const result = await verifyResetOtp({
                email: req.session.resetPasswordEmail,
                enteredOtp: otp
            });

            if (!result.success) {
                return res.status(400).render("user/otp", {
                    title: "OTP Verification",
                    email: req.session.resetPasswordEmail,
                    error: result.message
                });
            }

            req.session.resetPasswordVerified = true;

            return res.redirect("/reset-password");
        }

        // Signup OTP
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

        req.session.userId = result.user._id;
        delete req.session.signupData;

        return req.session.save(() => res.redirect("/"));

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

        return res.redirect("/otp");
    } catch (error) {
        console.error("Forgot Password Error:", error);
        return res.status(500).send("Something went wrong");
    }
};

const verifyResetOtpController = async (req, res) => {
    try {
        const email = req.session.resetPasswordEmail;
        const { otp } = req.body;

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

        return res.redirect("/reset-password");
    } catch (error) {
        console.error("Reset OTP Error:", error);
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

        if (!password || password.length < 8) {
            return res.status(400).render("user/reset-password", {
                title: "Reset Password",
                errors: {
                    password: "Password must be at least 8 characters"
                }
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).render("user/reset-password", {
                title: "Reset Password",
                errors: {
                    confirmPassword: "Passwords do not match"
                }
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
    forgotPasswordController,
    verifyResetOtpController,
    resetPasswordController,
    signup,
    login,
    verifyOtp,
    resendOtp
};