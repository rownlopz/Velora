const passport = require("passport");


const googleCallback = (req, res, next) => {
    passport.authenticate("google", { session: false }, (err, user, info) => {
        if (err) {
            console.error("Google Auth Error:", err);
            return res.status(500).render("user/login", {
                title: "Login",
                errors: { general: "Something went wrong during Google sign-in. Please try again." },
                formData: {},
            });
        }

        if (!user) {
            return res.status(400).render("user/login", {
                title: "Login",
                errors: { general: (info && info.message) || "Google sign-in failed." },
                formData: {},
            });
        }

     
        req.session.userId = user._id;
        req.session.save(() => res.redirect("/"));
    })(req, res, next);
};

module.exports = { googleCallback };
