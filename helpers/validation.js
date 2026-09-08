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

module.exports = {
    validateSignup,
};