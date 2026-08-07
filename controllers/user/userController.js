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

module.exports = {
    loadHome,
    loadSignup,
    loadLogin,
    loadOtp,
    loadForgotPassword,
    loadResetPassword
};
