const express = require("express");
const dotenv = require("dotenv");
dotenv.config();

const path = require("path");

const connectDB = require("./config/db");

const adminRoute = require("./routes/admin/adminRoute");
const userRoute = require("./routes/user/userRoute");

const passport = require("./config/passport");

const app = express();
//Connect Database
connectDB();
//Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true}));
app.use(passport.initialize());

// Session middleware (and the res.locals.user / res.locals.admin it
// populates) now lives inside userRoute.js and adminRoute.js instead of
// here, so the user side and admin side each get their own session
// cookie and can never see or interfere with each other's session.

// Prevent the browser's back/forward cache (bfcache) from showing stale
// login/dashboard pages after login or logout. Without this, pressing
// "back" can display a cached authenticated (or cached login) page instead
// of re-checking the session.
app.use((req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    next();
});

//ViewEngine
app.set("view engine", "ejs");
//Static Folder
app.use(express.static(path.join(__dirname,"public")));
//Routes
// /admin must be mounted BEFORE "/" — Express matches "/" against every
// path, including /admin/*, so if userRoute were registered first, its
// session middleware would run on admin requests too and collide with
// adminRoute's own session middleware (verified with a real test: this
// exact ordering bug caused admin login to silently set the wrong
// session cookie).
app.use("/admin", adminRoute);
app.use("/", userRoute);

app.listen(process.env.PORT || 3000, () =>{
    console.log(`Server running on http://localhost:${ process.env.PORT || 3000}`);
})