/**
 * Validates signup form data.
 * Returns an object with field-level error messages or null if all fields are valid.
 */
const validateSignup = (data) => {
    const errors = {};
    const { fullName, email, phone, password, confirmPassword } = data;

    // Full Name validation
    if (!fullName || !fullName.trim()) {
        errors.fullName = "Full name is required";
    } else if (fullName.trim().length < 2) {
        errors.fullName = "Full name must be at least 2 characters";
    } else if (!/^[a-zA-Z\s]+$/.test(fullName.trim())) {
        errors.fullName = "Full name can only contain letters and spaces";
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !email.trim()) {
        errors.email = "Email address is required";
    } else if (!emailRegex.test(email.trim())) {
        errors.email = "Please enter a valid email address";
    }

    // Phone validation (10 digits)
    const phoneRegex = /^[0-9]{10}$/;
    if (!phone || !phone.trim()) {
        errors.phone = "Phone number is required";
    } else if (!phoneRegex.test(phone.trim())) {
        errors.phone = "Please enter a valid 10-digit phone number";
    }

    // Password validation
    if (!password) {
        errors.password = "Password is required";
    } else if (password.length < 8) {
        errors.password = "Password must be at least 8 characters";
    } else if (!/(?=.*[A-Za-z])(?=.*\d)/.test(password)) {
        errors.password = "Password must contain at least one letter and one number";
    }

    // Confirm Password validation
    if (!confirmPassword) {
        errors.confirmPassword = "Please confirm your password";
    } else if (password !== confirmPassword) {
        errors.confirmPassword = "Passwords do not match";
    }

    return Object.keys(errors).length > 0 ? errors : null;
};

/**
 * Reusable field-level validators, extracted using the SAME rules as
 * validateSignup above, so validation stays consistent everywhere a
 * name, phone, or password is collected (profile edit, change password,
 * reset password). validateSignup itself is left untouched.
 */
const validateFullName = (fullName) => {
    if (!fullName || !fullName.trim()) return "Full name is required";
    if (fullName.trim().length < 2) return "Full name must be at least 2 characters";
    if (!/^[a-zA-Z\s]+$/.test(fullName.trim())) return "Full name can only contain letters and spaces";
    return null;
};

const validatePhone = (phone, { required = true } = {}) => {
    const phoneRegex = /^[0-9]{10}$/;
    if (!phone || !phone.trim()) {
        return required ? "Phone number is required" : null;
    }
    if (!phoneRegex.test(phone.trim())) return "Please enter a valid 10-digit phone number";
    return null;
};

const validatePassword = (password) => {
    if (!password) return "Password is required";
    if (password.length < 8) return "Password must be at least 8 characters";
    if (!/(?=.*[A-Za-z])(?=.*\d)/.test(password)) return "Password must contain at least one letter and one number";
    return null;
};

/**
 * Validates the "Edit Profile" form (full name required, phone optional
 * but must be a valid 10-digit number if provided).
 */
const validateProfileEdit = ({ fullName, phone }) => {
    const errors = {};

    const fullNameError = validateFullName(fullName);
    if (fullNameError) errors.fullName = fullNameError;

    const phoneError = validatePhone(phone, { required: false });
    if (phoneError) errors.phone = phoneError;

    return Object.keys(errors).length > 0 ? errors : null;
};

/**
 * Validates the "Change Password" form. Same password-strength rule as
 * signup. Does NOT verify the current password against the DB — that
 * check happens in the service layer, against the hashed password.
 */
const validatePasswordChange = ({ currentPassword, newPassword, confirmNewPassword }) => {
    const errors = {};

    if (!currentPassword) errors.currentPassword = "Current password is required";

    const newPasswordError = validatePassword(newPassword);
    if (newPasswordError) errors.newPassword = newPasswordError;

    if (!confirmNewPassword) {
        errors.confirmNewPassword = "Please confirm your new password";
    } else if (newPassword !== confirmNewPassword) {
        errors.confirmNewPassword = "Passwords do not match";
    }

    return Object.keys(errors).length > 0 ? errors : null;
};

/**
 * Validates the "Reset Password" form (forgot-password flow). Same
 * password-strength rule as signup, for consistency.
 */
const validateResetPassword = ({ password, confirmPassword }) => {
    const errors = {};

    const passwordError = validatePassword(password);
    if (passwordError) errors.password = passwordError;

    if (!confirmPassword) {
        errors.confirmPassword = "Please confirm your password";
    } else if (password !== confirmPassword) {
        errors.confirmPassword = "Passwords do not match";
    }

    return Object.keys(errors).length > 0 ? errors : null;
};

module.exports = {
    validateSignup,
    validateFullName,
    validatePhone,
    validatePassword,
    validateProfileEdit,
    validatePasswordChange,
    validateResetPassword,
};