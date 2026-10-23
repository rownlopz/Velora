const Razorpay = require("razorpay");

let customInstanceCreator = null;

const isRazorpayConfigured = () => {
    if (customInstanceCreator) return true;
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    return !!(
        key_id &&
        key_secret &&
        key_id.trim() &&
        key_secret.trim() &&
        !key_id.toLowerCase().includes("placeholder") &&
        !key_secret.toLowerCase().includes("placeholder")
    );
};

const getRazorpayInstance = () => {
    if (customInstanceCreator) {
        return customInstanceCreator();
    }
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;

    if (!key_id || !key_secret || key_id.toLowerCase().includes("placeholder") || key_secret.toLowerCase().includes("placeholder")) {
        return null;
    }

    return new Razorpay({
        key_id,
        key_secret,
    });
};

const setRazorpayInstanceCreator = (creator) => {
    customInstanceCreator = creator;
};

module.exports = {
    isRazorpayConfigured,
    getRazorpayInstance,
    setRazorpayInstanceCreator,
};
