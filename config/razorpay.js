const Razorpay = require("razorpay");

let customInstanceCreator = null;

const getRazorpayInstance = () => {
    if (customInstanceCreator) {
        return customInstanceCreator();
    }
    const key_id = process.env.RAZORPAY_KEY_ID || "rzp_test_placeholderKeyId";
    const key_secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_placeholderSecret";

    return new Razorpay({
        key_id,
        key_secret,
    });
};

const setRazorpayInstanceCreator = (creator) => {
    customInstanceCreator = creator;
};

module.exports = {
    getRazorpayInstance,
    setRazorpayInstanceCreator,
};
