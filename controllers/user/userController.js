const User = require("../../models/user/userModel");
const OTP = require("../../models/user/otpModel");

const generateOtp = require("../../utils/generateOtp");
const sendOtpEmail = require("../../utils/sendOtpEmail");

const { validateSignup } = require("../../helpers/validation");

const loadHome = (req, res)=>{
    res.render("user/home");
}

const loadSignup = (req,res)=>{
    res.render("user/signup");
}

const loadLogin = (req, res)=>{
    res.render("user/login",{
        title:"Login",
    });
};

const loadOtp = (req,res) => {
    res.render("user/otp",{
        title:"OTP Verification"
    });
}

const loadForgotPassword = (req,res) =>{
    res.render("user/forgot-password", {
        title:"Forget Password"
    });
}

const loadResetPassword = (req,res) =>{
    res.render("user/reset-password",{
        title:"Reset Password"
    });
}

const signup = async (req, res) => {
   

    try {
        const error = validateSignup(req.body);
        if (error) {
            return res.send(error);
        }

        const {
            fullName,
            email,
            phone,
            password
        } = req.body;

        const existingUser = await User.findOne({
            email: email.toLowerCase(),
        });

        if (existingUser) {
            return res.send("Email already registered");
        }

        const otp = generateOtp();

        await OTP.deleteMany({
            email,
            purpose: "VERIFY_EMAIL",
        });

        await OTP.create({

            email,
            otp,
            purpose: "VERIFY_EMAIL",
            expiresAt: new Date(Date.now() + 60 * 1000),
        });
        await sendOtpEmail(email, otp);

        req.session.signupData = {
            fullName,
            email,
            phone,
            password,

        };
        return res.redirect("/otp");

    } catch (error) {

        console.log(error);
        res.send("Something went wrong");
    }
};

module.exports = {
    loadHome,
    loadSignup,
    loadLogin,
    loadOtp,
    loadForgotPassword,
    loadResetPassword,
    signup
};
