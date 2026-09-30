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
app.use("/admin", adminRoute);
app.use("/", userRoute);

app.listen(process.env.PORT || 3000, () =>{
    console.log(`Server running on http://localhost:${ process.env.PORT || 3000}`);
})