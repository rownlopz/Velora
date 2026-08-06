const loadLogin = (req,res)=>{
    res.render("admin/login");
};

const loadDashboard = (req,res)=>{
    res.render("admin/dashboard"); 
};

module.exports = {
    loadLogin,
    loadDashboard
};