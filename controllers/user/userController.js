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

module.exports = {
    loadHome,
    loadSignup,
    loadLogin
};
