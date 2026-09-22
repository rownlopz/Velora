const setUserLocals = (req, res, next) => {
    res.locals.user = req.session.userId || null;
    next();
};

const setAdminLocals = (req, res, next) => {
    res.locals.admin = req.session.adminId || null;
    next();
};

module.exports = {
    setUserLocals,
    setAdminLocals
};
